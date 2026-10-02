"""Bounded independent media-duration proof for short titles and remakes.

Uses only exact URLs already in the published public manifest. No provider
credentials, account reads or database writes. No full video download.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import importlib.util
import json
from pathlib import Path
import subprocess
import time
import urllib.parse

spec = importlib.util.spec_from_file_location('selection_audit', Path(__file__).with_name('audit-selection-tmdb-20261002.py'))
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)


def duration_match(seconds, details):
    if not 60 <= seconds <= 8 * 3600 or not details:
        return None
    # An unknown competing runtime is still ambiguity, not a false exclusion.
    if any(not isinstance(d.get('runtime'), (int, float)) or d['runtime'] <= 0 for d in details):
        return None
    matches = [d for d in details if abs(d['runtime'] * 60 - seconds) <= 90]
    return matches[0] if len({d['id'] for d in matches}) == 1 else None


def main():
    root = audit.ROOT
    rows = json.loads((root / 'inputs.json').read_text())
    media = json.loads(audit.sql("""select jsonb_object_agg(identity_key,urls) from (
      select v.identity_key,jsonb_agg(distinct m.playback_hint->>'targetUrl') urls
      from selection_shared_variants v join selection_shared_media m on m.release_id=v.release_id
       and m.item_type=v.item_type and m.external_id=v.external_id where v.item_type='movie'
      group by v.identity_key)x;"""))
    api = audit.Tmdb()
    tasks, deferred = [], 0
    for row in rows:
        path = root / 'results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        result = json.loads(path.read_text())
        if row['item_type'] != 'movie':
            continue
        short_new = result['status'] == 'matched' and result['evidence'] == 'unique_exact_title' \
            and not audit.title_year(row['title']) and (len(audit.normalized(row['title']).split()) <= 2 \
            and len(audit.normalized(row['title'])) < 14)
        ambiguous = result['status'] == 'unresolved' and result.get('reason') in [
            'ambiguous', 'short_title_needs_independent_identity']
        if not short_new and not ambiguous:
            continue
        urls = [u for u in media.get(row['identity_key'], []) if urllib.parse.urlsplit(u or '').scheme in ['http', 'https']
                and urllib.parse.urlsplit(u).path.lower().endswith(('.mp4', '.mkv', '.avi', '.m4v'))]
        if short_new:
            result.update({'status': 'unresolved', 'reason': 'short_title_needs_independent_identity',
                           'candidateIds': [result['tmdbId']]})
            if row['provider_tmdb_id']:
                old = api.details('movie', row['provider_tmdb_id'])
                result['oldRejected'] = not audit.exact_match(row['title'], old)
            path.write_text(json.dumps(result, ensure_ascii=False))
            deferred += 1
        if urls:
            tasks.append((row, path, urls[0]))
    priorities = ['A Baleia', 'A Bailarina', 'A Hora do Pesadelo']
    tasks.sort(key=lambda x: (0 if x[0]['title'] in priorities else 1, x[0]['title']))
    print(json.dumps({'shortAssociationsDeferred': deferred, 'durationProbes': len(tasks), 'bounded': 200}), flush=True)
    proofs = root / 'duration-proofs'; proofs.mkdir(mode=0o700, exist_ok=True)
    def worker(task):
        row, path, url = task
        file = proofs / (audit.digest([row['identity_key'], url]) + '.json')
        if file.exists():
            proof = json.loads(file.read_text())
        else:
            started = time.monotonic()
            try:
                process = subprocess.run(['docker', 'exec', 'norva-media-lab-gateway', 'ffprobe', '-v', 'error',
                    '-rw_timeout', '10000000', '-probesize', '131072', '-analyzeduration', '1000000',
                    '-show_entries', 'format=duration', '-of', 'json', url], text=True, capture_output=True, timeout=25)
                duration = float(json.loads(process.stdout).get('format', {}).get('duration', 0)) if process.returncode == 0 else 0
                proof = {'identityKey': row['identity_key'], 'targetSha256': audit.digest(url), 'seconds': duration,
                         'elapsedMs': int((time.monotonic() - started) * 1000), 'ok': duration > 0}
            except (subprocess.TimeoutExpired, ValueError):
                proof = {'identityKey': row['identity_key'], 'targetSha256': audit.digest(url), 'ok': False, 'seconds': 0}
            file.write_text(json.dumps(proof)); file.chmod(0o600)
        result = json.loads(path.read_text())
        details, truncated = api.search('movie', row['title'], audit.title_year(row['title']))
        exact = [d for d in details if d.get('id') and audit.exact_match(row['title'], d, audit.title_year(row['title']))]
        match = duration_match(proof['seconds'], exact) if proof['ok'] and not truncated else None
        if match:
            result.update({'status': 'matched' if str(match['id']) != row['provider_tmdb_id'] else 'verified_existing',
                           'tmdbId': str(match['id']), 'details': match, 'evidence': 'exact_title_unique_file_duration',
                           'durationProof': proof})
            path.write_text(json.dumps(result, ensure_ascii=False)); path.chmod(0o600)
        return {'title': row['title'], 'probeOk': proof['ok'], 'resolved': bool(match), 'seconds': proof['seconds']}
    receipts = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        for future in as_completed([pool.submit(worker, t) for t in tasks[:200]]):
            receipts.append(future.result())
            if len(receipts) % 10 == 0 or len(receipts) == min(len(tasks), 200):
                print(json.dumps({'done': len(receipts), 'resolved': sum(r['resolved'] for r in receipts),
                                  'probeOk': sum(r['probeOk'] for r in receipts)}), flush=True)
    (root / 'duration.safe.json').write_text(json.dumps(receipts, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
