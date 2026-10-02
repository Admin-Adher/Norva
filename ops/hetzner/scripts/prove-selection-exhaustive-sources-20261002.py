"""Reconcile every identity with the original public manifest evidence.

Measured durations are reused only when the saved sampling receipt's URL hash
matches the exact manifest file. All variants must agree. A mixed group or an
unknown runtime remains unresolved; missing content never proves identity.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import math
import time

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

spec = spec_from_file_location('qualified_exhaustive', Path(__file__).with_name('audit-selection-exhaustive-20261002.py'))
exhaustive = module_from_spec(spec); spec.loader.exec_module(exhaustive)
audit = exhaustive.audit; ROOT = exhaustive.ROOT
duration = exhaustive.module('qualified_duration', 'prove-selection-media-duration-20261002.py')


def qualified_duration(media):
    md = media.get('metadata') or {}; proof = md.get('selectionPlaybackValidation') or {}
    url = (media.get('playback_hint') or {}).get('targetUrl')
    seconds = md.get('duration')
    if not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 60 <= seconds <= 28800:
        return None
    if not isinstance(url, str) or not url.startswith(('https://', 'http://')):
        return None
    if proof.get('urlSha256') != hashlib.sha256(url.encode()).hexdigest():
        return None
    if proof.get('method') != 'server-sampling-and-file-access' or proof.get('fileHttpStatus') not in [200, 206]:
        return None
    if not proof.get('sourceCommit') or not proof.get('containerMetadataCheckedAt'):
        return None
    return {'externalId': media['external_id'], 'seconds': seconds, 'targetUrl': url,
            'sampledAt': proof['containerMetadataCheckedAt'], 'sourceCommit': proof['sourceCommit']}


def durations_identity(row, candidates, media):
    if row['item_type'] != 'movie':
        return None, None, []
    compatible = [d for d in candidates if d.get('id') and duration.duration_alias(row['title'], d)]
    if not compatible:
        return None, None, []
    proofs = []; hits = []
    for source in media:
        p = qualified_duration(source)
        if not p:
            return None, 'unverified_variant_duration', proofs
        proofs.append(p)
        hit = duration.deep.previous.probe.duration_match(p['seconds'], compatible)
        if not hit:
            return None, 'overlapping_or_unknown_official_runtimes', proofs
        hits.append(hit)
    if not hits:
        return None, None, proofs
    if len({d['id'] for d in hits}) != 1:
        return None, 'ambiguous_source_versions', proofs
    return hits[0], None, proofs


def source_id(row, candidates, media):
    ids = [(m.get('metadata') or {}).get('providerTmdbId') for m in media]
    if not ids or any(not v for v in ids) or len({str(v) for v in ids}) != 1:
        return None
    ident = str(ids[0])
    d = next((d for d in candidates if str(d.get('id')) == ident), None)
    if d and exhaustive.deep.previous.supported_alias(row['title'], d, None):
        return d
    return None


def work(api, row, media):
    base = json.loads((ROOT / 'identity' / exhaustive.receipt(row)).read_text())
    assert base['inputHash'] == audit.digest(row)
    result = dict(base); result['rawSourceHash'] = audit.digest(media); result['sourceProofVersion'] = 4
    if base['status'] == 'request_error':
        return result
    candidates = [api.details(row['item_type'], i) for i in base.get('candidateIds') or []]
    if base['status'] == 'unresolved' and base.get('reason') != 'truncated_candidates':
        chosen, reason, matching = exhaustive.independent_assessment(row, candidates, base.get('hints') or [], False)
        if chosen:
            result.update(chosen)
            result.update({'status': 'verified_existing' if chosen['tmdbId'] == row['provider_tmdb_id'] else 'matched',
                           'reason': None, 'matchingIds': matching})
    original_id = source_id(row, candidates, media)
    # A runtime cannot rule out a homonym omitted by an incomplete search.
    d, problem, proofs = (None, 'incomplete_candidate_set', []) if base.get('reason') == 'truncated_candidates' else durations_identity(row, candidates, media)
    if problem == 'ambiguous_source_versions':
        result.update({'status': 'unresolved', 'reason': problem, 'qualifiedDurationProofs': proofs})
        result.pop('details', None); result.pop('tmdbId', None)
        return result
    if original_id:
        d = original_id; evidence = 'source_original_provider_id'
        result['originalIdUnits'] = [{'externalId': m['external_id'], 'providerId': str(d['id'])} for m in media]
    elif d:
        evidence = 'source_alias_file_duration'
        result.update({'durationProof': {'ok': True, 'seconds': proofs[0]['seconds']},
                       'expectedTargetUrl': proofs[0]['targetUrl'], 'qualifiedDurationProofs': proofs})
    else:
        d = None; evidence = None
    # Original raw logos are independent of the title recipe's enriched poster.
    if not d and result['status'] not in ['matched', 'verified_existing'] and base.get('reason') != 'truncated_candidates' and media:
        paths = [audit.poster_path(m.get('poster_url')) for m in media]
        if all(paths) and len(set(paths)) == 1:
            path = paths[0]
            hits = [c for c in candidates if c.get('poster_path') == path]
            if len({c['id'] for c in hits}) == 1:
                proposed = hits[0]
                if exhaustive.deep.previous.supported_alias(row['title'], proposed, None):
                    d = proposed; evidence = 'source_poster_confirmed'
                    result['originalPosterUnits'] = [{'externalId': m['external_id'], 'poster': m['poster_url']} for m in media]
    if d:
        if result['status'] in ['matched', 'verified_existing'] and str(d['id']) != result.get('tmdbId'):
            result.update({'status': 'unresolved', 'reason': 'original_source_and_search_disagree'})
            result.pop('details', None); result.pop('tmdbId', None)
            return result
        d = dict(d); ident = str(d['id']); lang, plot = exhaustive.deep.previous.synopsis(d)
        if not d.get('overview') and plot:
            d['overview'] = plot; result['fallbackLanguage'] = lang
        result.update({'status': 'verified_existing' if ident == row['provider_tmdb_id'] else 'matched',
                       'tmdbId': ident, 'evidence': evidence, 'details': d, 'reason': None})
        if ident in ((row['metadata'].get('tmdbSearchReview') or {}).get('rejectedTmdbIds') or []):
            result['protectedPreviousRejection'] = True
        result['metadataCheck'] = exhaustive.metadata_checks(row, d)
    elif result['status'] == 'unresolved':
        result['durationReviewReason'] = problem
    result['metadataCheck'] = exhaustive.metadata_checks(row, result.get('details'))
    if result.get('tmdbId') in ((row['metadata'].get('tmdbSearchReview') or {}).get('rejectedTmdbIds') or []):
        result['protectedPreviousRejection'] = True
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--follow', action='store_true'); args = parser.parse_args()
    rows = json.loads((ROOT / 'inputs.json').read_text())
    raw = json.loads((ROOT / 'raw-source-evidence.json').read_text())
    by_key = {(r['item_type'], r['identity_key']): r['raw_media'] for r in raw}
    api = audit.Tmdb(); done = set(); began = time.time()
    output = ROOT / 'qualified'; output.mkdir(mode=0o700, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        while len(done) < len(rows):
            pending = [r for r in rows if exhaustive.receipt(r) not in done
                       and (ROOT / 'identity' / exhaustive.receipt(r)).exists()]
            futures = {}
            for row in pending:
                f = output / exhaustive.receipt(row)
                if f.exists():
                    old = json.loads(f.read_text())
                    assert old['inputHash'] == audit.digest(row)
                    if old['status'] != 'request_error' and old.get('sourceProofVersion') == 4:
                        done.add(f.name); continue
                futures[pool.submit(work, api, row, by_key[(row['item_type'], row['identity_key'])])] = row
            for future in as_completed(futures):
                row = futures[future]
                try:
                    r = future.result()
                except Exception as e:
                    r = {'title': row['title'], 'itemType': row['item_type'], 'identityKey': row['identity_key'],
                         'inputHash': audit.digest(row), 'status': 'request_error', 'reason': type(e).__name__}
                exhaustive.save(output / exhaustive.receipt(row), r); done.add(exhaustive.receipt(row))
            print(json.dumps({'qualifiedDone': len(done), 'total': len(rows), 'newRequests': api.requests}), flush=True)
            if not args.follow:
                break
            assert time.time()-began < 7200, 'Identity audit incomplete after two hours; receipts preserved'
            if len(done) < len(rows):
                time.sleep(10)
    results = [json.loads(f.read_text()) for f in output.glob('*.json')]
    exhaustive.save(ROOT / 'qualified.safe.json', {'rows': len(results), 'total': len(rows),
      'allRowsExamined': len(results) == len(rows), 'statuses': dict(Counter(r['status'] for r in results)),
      'reasons': dict(Counter(r.get('reason') for r in results if r.get('reason'))),
      'rawSourceSha256': audit.digest(raw), 'at': time.time()})


if __name__ == '__main__':
    main()
