"""Read-only follow-up of the published Selection editorial gaps.

Discovery may use the provider's image filename. Confirmation keeps sequel
numbers, uses the official aliases, rejects conflicting source years and records
the exact hint. Short names and remakes require independent media evidence.
Existing receipts and source snapshots are never overwritten by another pass.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.parse


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


audit = module('remainder_audit', 'audit-selection-tmdb-20261002.py')
rescue = module('remainder_rescue', 'rescue-selection-tmdb-20261002.py')
ROOT = audit.ROOT / 'remainder'
RESULTS = ROOT / 'review-v2'
probe = module('remainder_duration', 'probe-selection-editorial-identities-20261002.py')


def image_label(url):
    parsed = urllib.parse.urlsplit(url or '')
    if parsed.hostname == 'image.tmdb.org':
        return None  # Opaque TMDB paths are not independent title evidence.
    name = urllib.parse.unquote(parsed.path.rsplit('/', 1)[-1])
    if not re.search(r'\.(jpg|jpeg|png|webp)$', name, re.I):
        return None
    name = re.sub(r'\.(jpg|jpeg|png|webp)$', '', name, flags=re.I)
    name = name.replace('-', ' ').replace('_', ' ').replace('.', ' ')
    name = re.sub(r'\s+Poster$', '', name, flags=re.I)
    return name.strip() if len(name.strip()) >= 3 and name.strip().lower() not in ['poster', 'cover', 'image'] else None


def short_name(value):
    name = audit.normalized(value)
    return len(name.split()) <= 2 and len(name.replace(' ', '')) < 14


def supported_alias(value, details, year):
    return rescue.extended_match(value, details, year)


def prefix_alias(value, details):
    """Discovery for shortened subtitles; insufficient without media duration."""
    source = audit.normalized(value).split()
    if len(source) < 3 or len(''.join(source)) < 12:
        return False
    for alias in audit.aliases(details):
        words = audit.normalized(alias).split()
        if len(words) <= len(source):
            continue
        if words[:len(source)] == source:
            # A later sequel number is meaningful and must not be dropped.
            if [w for w in words if w.isdigit()] == [w for w in source if w.isdigit()]:
                return True
    return False


def valid_image(path):
    return isinstance(path, str) and bool(re.fullmatch(r'/[A-Za-z0-9._-]+\.(jpg|png|webp)', path, re.I))


def synopsis(details):
    """Keep every official language; fallback is not a translated synopsis."""
    values = {}
    for t in (details.get('translations') or {}).get('translations', []):
        value = (t.get('data') or {}).get('overview')
        if isinstance(value, str) and value.strip():
            values[t.get('iso_639_1')] = value.strip()
    original = details.get('original_language')
    for lang in ['en', 'fr', original, 'pt', 'es', 'hi', 'tr', 'bn', 'ar', 'id', 'tl']:
        if values.get(lang):
            return lang, values[lang]
    # An official translation outside Norva's interface languages is still
    # useful as an honestly labelled fallback, never as an invented locale.
    return next(iter(sorted(values.items())), (None, None))


def source_hints(row):
    hints = [('provider_title', row['title'])]
    for url in row.get('file_urls') or []:
        value = rescue.file_title(url)
        if value:
            hints.append(('media_filename', value))
    value = image_label(row.get('manifest_poster'))
    if value:
        hints.append(('image_filename', value))
    return list(dict.fromkeys(hints))[:5]


def assess(row, candidates, hints):
    years = {audit.title_year(value) for _, value in hints if audit.title_year(value)}
    if len(years) > 1:
        return None, 'conflicting_source_years', []
    year = next(iter(years), None)
    matches = {}
    for kind, value in hints:
        for d in candidates:
            if d.get('id') and supported_alias(value, d, year):
                matches.setdefault(str(d['id']), []).append((kind, value))
    # A complete public filename identifies the media more precisely than a
    # shortened catalogue label. Require all meaningful provider words and all
    # other informative filenames to support that same identity.
    provider_words = set(audit.normalized(row['title']).split()) - {'o', 'a', 'os', 'as', 'de', 'do', 'da'}
    informative = [(kind, value) for kind, value in hints if kind == 'media_filename'
      and len(audit.normalized(value)) >= 14
      and provider_words.issubset(set(audit.normalized(value).split()))
      and len(audit.normalized(value).split()) > len(audit.normalized(row['title']).split())]
    if informative:
        complete_ids = {str(d['id']) for d in candidates if d.get('id')
          and all(supported_alias(value, d, year) for _, value in informative)}
        if len(complete_ids) == 1:
            ident = next(iter(complete_ids))
            matches = {ident: informative}
    if len(matches) != 1:
        return None, 'ambiguous' if matches else 'no_official_alias', list(matches)
    ident, proof = next(iter(matches.items()))
    if not year and all(short_name(value) for _, value in proof):
        return None, 'needs_independent_media_identity', [ident]
    # Image labels can fix a truncated title, but a different labelled film
    # cannot silently override the provider's identity.
    if all(kind == 'image_filename' for kind, _ in proof):
        provider = audit.normalized(row['title']).replace(' ', '')
        image = audit.normalized(proof[0][1]).replace(' ', '')
        if len(provider) < 8 or not (image.startswith(provider) or provider == image):
            return None, 'image_title_conflict', [ident]
        evidence = 'source_image_filename_exact_alias'
    elif any(kind == 'media_filename' for kind, _ in proof):
        evidence = 'unique_source_filename_alias'
    elif audit.exact_match(row['title'], next(d for d in candidates if str(d.get('id')) == ident), year):
        evidence = 'unique_exact_title_year' if year else 'unique_exact_title'
    else:
        evidence = 'unique_spacing_or_portuguese_alias'
    return (ident, evidence, proof, year), None, list(matches)


def audit_row(api, row):
    hints = source_hints(row)
    prior_path = audit.ROOT / 'results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
    prior = json.loads(prior_path.read_text()) if prior_path.exists() else {}
    ids = list(dict.fromkeys([row['provider_tmdb_id']] + prior.get('candidateIds', []) + [prior.get('tmdbId')]))
    details = {str(d['id']): d for ident in ids if ident
               for d in [api.details(row['item_type'], ident)] if d.get('id')}
    queries = [value for _, value in hints]
    queries = list(dict.fromkeys(queries))
    years = {audit.title_year(value) for _, value in hints if audit.title_year(value)}
    source_year = next(iter(years), None) if len(years) == 1 else None
    truncated = False
    # The first pass already searched the provider name. Repeat only when an
    # existing association needs a homonym check, or a different hint exists.
    for query in queries:
        if query == row['title'] and not row['provider_tmdb_id'] and prior.get('candidateIds') is not None:
            continue
        candidates, cap = api.search(row['item_type'], query, source_year or audit.title_year(query))
        truncated = truncated or cap
        details.update({str(d['id']): d for d in candidates if d.get('id')})
    chosen, reason, matching = assess(row, list(details.values()), hints)
    result = {'title': row['title'], 'itemType': row['item_type'], 'identityKey': row['identity_key'],
              'inputHash': audit.digest(row), 'hints': hints, 'candidateIds': list(details),
              'matchingIds': matching, 'status': 'unresolved', 'reason': reason}
    if not chosen or truncated:
        if truncated:
            result['reason'] = 'truncated_candidates'
        result['candidateSummaries'] = [{'id': d['id'], 'title': d.get('title') or d.get('name'),
          'year': (d.get('release_date') or d.get('first_air_date') or '')[:4],
          'runtime': d.get('runtime'), 'aliases': audit.aliases(d)} for d in details.values()]
        return result
    ident, evidence, proof, year = chosen
    d = dict(details[ident])
    result.update({'status': 'verified_existing' if ident == row['provider_tmdb_id'] else 'matched',
                   'tmdbId': ident, 'evidence': evidence, 'aliasProof': proof, 'sourceYear': year})
    if not d.get('poster_path') and not row['poster_url']:
        images = api.get(('tv' if row['item_type'] == 'series' else 'movie') + '/' + ident + '/images')
        posters = [x for x in images.get('posters', []) if valid_image(x.get('file_path'))
                   and 0.5 <= x.get('aspect_ratio', 0) <= 0.8]
        posters.sort(key=lambda x: (x.get('iso_639_1') in [d.get('original_language'), 'en', 'pt', 'fr'],
                                   x.get('vote_count', 0), x.get('height', 0)), reverse=True)
        if posters:
            d['poster_path'] = posters[0]['file_path']
            result['imageProof'] = {'endpoint': ('tv' if row['item_type'] == 'series' else 'movie') + '/' + ident + '/images',
                                    'filePath': d['poster_path'], 'language': posters[0].get('iso_639_1')}
    lang, overview = synopsis(d)
    if not d.get('overview') and overview:
        d['overview'] = overview
        result['fallbackLanguage'] = lang
    result['details'] = d
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', action='store_true')
    args = parser.parse_args()
    rows = json.loads((ROOT / 'inputs.json').read_text())
    RESULTS.mkdir(mode=0o700, exist_ok=True)
    output = RESULTS / 'results'; output.mkdir(mode=0o700, exist_ok=True)
    api = audit.Tmdb(); statuses = {}; results = []
    if args.duration:
        duration_pass(api, rows, output)
        return
    def work(row):
        file = output / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        if file.exists():
            existing = json.loads(file.read_text())
            assert existing['inputHash'] == audit.digest(row), 'Input drift'
            if existing['status'] != 'request_error':
                return existing
        try:
            result = audit_row(api, row)
        except Exception as e:
            result = {'inputHash': audit.digest(row), 'status': 'request_error',
                      'title': row['title'], 'reason': str(e)[:160] if isinstance(e, RuntimeError) else type(e).__name__}
        file.write_text(json.dumps(result, ensure_ascii=False)); file.chmod(0o600)
        return result
    print(json.dumps({'readOnly': True, 'input': len(rows), 'inputSha256': audit.digest(rows)}), flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for f in as_completed([pool.submit(work, row) for row in rows]):
            result = f.result(); results.append(result)
            statuses[result['status']] = statuses.get(result['status'], 0) + 1
            if len(results) % 50 == 0 or len(results) == len(rows):
                print(json.dumps({'done': len(results), 'statuses': statuses, 'requests': api.requests}), flush=True)
    summary = {'rows': len(rows), 'statuses': statuses, 'requests': api.requests,
               'inputSha256': audit.digest(rows), 'resultsSha256': audit.digest(sorted(results, key=lambda x: (x['title'], x.get('identityKey', ''))))}
    (RESULTS / 'audit.safe.json').write_text(json.dumps(summary, indent=2))


def duration_pass(api, rows, output):
    proof_root = RESULTS / 'duration'; proof_root.mkdir(mode=0o700, exist_ok=True)
    tasks = []
    for row in rows:
        r = json.loads((output / (audit.digest([row['item_type'], row['identity_key']]) + '.json')).read_text())
        if row['item_type'] != 'movie' or r['status'] != 'unresolved':
            continue
        urls = [u for u in row.get('file_urls') or [] if urllib.parse.urlsplit(u or '').path.lower().endswith(('.mp4', '.mkv', '.m4v', '.avi'))]
        if not urls:
            continue
        candidates = [api.details('movie', ident) for ident in r['candidateIds']]
        compatible = [d for d in candidates if d.get('id') and any(
          supported_alias(value, d, audit.title_year(value)) or prefix_alias(value, d)
          for kind, value in r['hints'] if kind != 'image_filename')]
        if compatible and all(isinstance(d.get('runtime'), (int, float)) and d['runtime'] > 0 for d in compatible):
            tasks.append((row, r, urls[0], compatible))
    assert len(tasks) <= 150, 'Bounded public media proof required'
    print(json.dumps({'durationTasks': len(tasks), 'readOnly': True, 'workers': 2}), flush=True)
    def work(task):
        row, result, url, compatible = task
        file = proof_root / (audit.digest([row['identity_key'], url]) + '.json')
        if file.exists():
            return json.loads(file.read_text())
        prior = audit.ROOT / 'duration-proofs' / file.name
        proof = json.loads(prior.read_text()) if prior.exists() else {}
        if not proof.get('ok'):
            began = time.monotonic()
            try:
                p = subprocess.run(['docker', 'exec', 'norva-media-lab-gateway', 'ffprobe', '-v', 'error',
                  '-rw_timeout', '10000000', '-probesize', '131072', '-analyzeduration', '1000000',
                  '-show_entries', 'format=duration', '-of', 'json', url], text=True, capture_output=True, timeout=25)
                seconds = float(json.loads(p.stdout).get('format', {}).get('duration', 0)) if p.returncode == 0 else 0
                proof = {'ok': seconds > 0, 'seconds': seconds, 'elapsedMs': round((time.monotonic()-began)*1000)}
            except (subprocess.TimeoutExpired, ValueError):
                proof = {'ok': False, 'seconds': 0}
        hit = probe.duration_match(proof.get('seconds', 0), compatible)
        receipt = {'title': row['title'], 'inputHash': audit.digest(row), 'targetSha256': audit.digest(url),
                   'proof': proof, 'resolved': bool(hit)}
        if hit:
            exact = any(supported_alias(value, hit, audit.title_year(value)) for kind, value in result['hints'] if kind != 'image_filename')
            receipt['result'] = {**result, 'status': 'matched' if str(hit['id']) != row['provider_tmdb_id'] else 'verified_existing',
              'tmdbId': str(hit['id']), 'details': hit,
              'evidence': 'exact_title_unique_file_duration' if exact else 'source_title_prefix_file_duration',
              'durationProof': proof, 'expectedTargetUrl': url}
        file.write_text(json.dumps(receipt, ensure_ascii=False)); file.chmod(0o600)
        return receipt
    receipts = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for f in as_completed([pool.submit(work, t) for t in tasks]):
            receipts.append(f.result())
            if len(receipts) % 10 == 0 or len(receipts) == len(tasks):
                print(json.dumps({'done': len(receipts), 'resolved': sum(r['resolved'] for r in receipts),
                                  'probeOk': sum(r['proof']['ok'] for r in receipts)}), flush=True)
    (RESULTS / 'duration.safe.json').write_text(json.dumps({'tasks': len(tasks), 'resolved': sum(r['resolved'] for r in receipts)}, indent=2))


if __name__ == '__main__':
    main()
