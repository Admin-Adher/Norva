"""Bounded public duration proofs for compact aliases and one-character typos.

Completed HLS playlists can supply duration without fetching video segments.
Unknown or overlapping official runtimes veto association. Query similarity
never supplies identity; numeric and Roman sequel markers must be preserved.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import re
import subprocess
import time
import urllib.parse
import urllib.request

spec = spec_from_file_location('duration_deep', Path(__file__).with_name('prove-selection-source-units-20261002.py'))
units = module_from_spec(spec); spec.loader.exec_module(units)
deep = units.deep; audit = deep.audit; ROOT = deep.ROOT


def edit_one(a, b):
    if abs(len(a) - len(b)) > 1:
        return False
    if a == b:
        return True
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    small, large = (a, b) if len(a) < len(b) else (b, a)
    for i, (x, y) in enumerate(zip(small, large)):
        if x != y:
            return small[i:] == large[i + 1:]
    return True


def duration_alias(value, details):
    source = audit.normalized(value)
    compact = deep.compact(source)
    markers = re.findall(r'\d+|\b[ivx]+\b', source)
    for alias in audit.aliases(details):
        other = audit.normalized(alias)
        if compact == deep.compact(other) and len(compact) >= 3:
            return 'compact'
        if len(compact) >= 14 and markers == re.findall(r'\d+|\b[ivx]+\b', other) \
          and edit_one(compact, deep.compact(other)):
            return 'single_character_typo'
        if markers == re.findall(r'\d+|\b[ivx]+\b', other) and deep.previous.prefix_alias(value, {'title': alias}):
            return 'subtitle_prefix'
    return None


def playlist_duration(url, depth=0):
    if depth > 2 or urllib.parse.urlsplit(url).scheme not in ['http', 'https']:
        raise ValueError('Invalid public playlist')
    request = urllib.request.Request(url, headers={'User-Agent': 'Norva-public-editorial-audit/1'})
    with urllib.request.urlopen(request, timeout=10) as response:
        raw = response.read(262145)
        final = response.url
    if len(raw) > 262144:
        raise ValueError('Oversized playlist')
    value = raw.decode('utf-8-sig')
    lines = [line.strip() for line in value.split('\n') if line.strip()]
    if not lines or lines[0] != '#EXTM3U':
        raise ValueError('Non-HLS response')
    if any(line.startswith('#EXT-X-STREAM-INF:') for line in lines):
        for i, line in enumerate(lines[:-1]):
            if line.startswith('#EXT-X-STREAM-INF:') and not lines[i + 1].startswith('#'):
                return playlist_duration(urllib.parse.urljoin(final, lines[i + 1]), depth + 1)
        raise ValueError('No master variant')
    if '#EXT-X-ENDLIST' not in lines:
        raise ValueError('Nonterminal playlist cannot prove full duration')
    durations = [float(line.split(':', 1)[1].split(',', 1)[0]) for line in lines if line.startswith('#EXTINF:')]
    if not durations or any(n <= 0 for n in durations):
        raise ValueError('Invalid segment durations')
    return sum(durations)


def main():
    rows = json.loads((ROOT / 'source-units-inputs.json').read_text())
    output = ROOT / 'media-duration'; output.mkdir(mode=0o700, exist_ok=True)
    api = audit.Tmdb(); tasks = []
    for row in rows:
        file = ROOT / 'unit-results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        result = json.loads(file.read_text())
        if row['item_type'] != 'movie' or result['status'] != 'unresolved' or result.get('reason') == 'truncated_candidates':
            continue
        hints = [(k, v) for k, v in result['hints'] if k != 'image_filename']
        candidates = [api.details('movie', ident) for ident in result.get('candidateIds') or []]
        years = {audit.title_year(v) for _, v in hints if audit.title_year(v)}
        source_units, error = units.supported_units(row)
        if error:
            continue
        years |= {u['provider_year'] for u in source_units}
        compatible = [d for d in candidates if d.get('id') and all(audit.year_ok(y, d) for y in years)
                      and any(duration_alias(v, d) for _, v in hints)]
        if not compatible or any(not isinstance(d.get('runtime'), (int, float)) or d['runtime'] <= 0 for d in compatible):
            continue
        urls = [u for u in row.get('file_urls') or [] if urllib.parse.urlsplit(u).path.lower().endswith(('.mp4', '.mkv', '.avi', '.m4v', '.m3u8'))]
        if urls:
            tasks.append((row, result, urls[0], compatible))
    assert len(tasks) <= 120, 'Bounded provider-header proof required'
    print(json.dumps({'readOnly': True, 'durationTasks': len(tasks), 'workers': 2}), flush=True)
    def work(task):
        row, result, url, candidates = task
        file = output / (audit.digest([row['identity_key'], url]) + '.json')
        if file.exists():
            existing = json.loads(file.read_text()); assert existing['inputHash'] == audit.digest(row)
            return existing
        began = time.monotonic(); method = 'ffprobe_header'
        prior_paths = [audit.ROOT / 'duration-proofs' / file.name,
          audit.ROOT / 'remainder/review-v2/duration' / file.name]
        prior = next((json.loads(p.read_text()) for p in prior_paths if p.exists()), {})
        proof = prior.get('proof') or prior
        if not proof.get('ok'):
            try:
                if urllib.parse.urlsplit(url).path.lower().endswith('.m3u8'):
                    seconds = playlist_duration(url); method = 'terminal_hls_playlist_no_segments'
                else:
                    p = subprocess.run(['docker', 'exec', 'norva-media-lab-gateway', 'ffprobe', '-v', 'error',
                      '-rw_timeout', '10000000', '-probesize', '131072', '-analyzeduration', '1000000',
                      '-show_entries', 'format=duration', '-of', 'json', url], capture_output=True, text=True, timeout=25)
                    seconds = float(json.loads(p.stdout).get('format', {}).get('duration', 0)) if p.returncode == 0 else 0
                proof = {'ok': seconds > 0, 'seconds': seconds}
            except (OSError, ValueError, UnicodeDecodeError, subprocess.TimeoutExpired):
                proof = {'ok': False, 'seconds': 0}
        hit = deep.previous.probe.duration_match(proof.get('seconds', 0), candidates)
        receipt = {'title': row['title'], 'inputHash': audit.digest(row), 'targetSha256': audit.digest(url),
                   'proof': proof, 'method': method, 'elapsedMs': round((time.monotonic()-began)*1000), 'resolved': bool(hit)}
        if hit:
            d = dict(hit); lang, overview = deep.previous.synopsis(d)
            if not d.get('overview') and overview:
                d['overview'] = overview
            receipt['result'] = {**result, 'status': 'matched' if str(d['id']) != row['provider_tmdb_id'] else 'verified_existing',
              'tmdbId': str(d['id']), 'details': d, 'evidence': 'source_alias_file_duration',
              'durationProof': proof, 'expectedTargetUrl': url}
        file.write_text(json.dumps(receipt, ensure_ascii=False)); file.chmod(0o600)
        return receipt
    results = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for f in as_completed([pool.submit(work, t) for t in tasks]):
            results.append(f.result())
            if len(results) % 10 == 0 or len(results) == len(tasks):
                print(json.dumps({'done': len(results), 'resolved': sum(x['resolved'] for x in results)}), flush=True)
    summary = {'at': time.time(), 'tasks': len(tasks), 'resolved': sum(x['resolved'] for x in results),
      'matched': [{'title': x['title'], 'tmdbId': x['result']['tmdbId'], 'seconds': x['proof']['seconds']} for x in results if x['resolved']]}
    (ROOT / 'duration.safe.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
