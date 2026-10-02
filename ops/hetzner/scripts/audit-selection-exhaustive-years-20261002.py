"""Complete year-qualified discovery for every eligible capped identity.

Only raw manifest years may narrow a search. All compatible years and three
locales are queried. Short/empty stubs require media proof, not a forced match.
This writes public audit receipts only, never the database.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import time

spec = spec_from_file_location('full_year_audit', Path(__file__).with_name('audit-selection-exhaustive-20261002.py'))
full = module_from_spec(spec); spec.loader.exec_module(full)
audit = full.audit; ROOT = full.ROOT


def allowed_years(row):
    source, error = full.units.supported_units(row)
    if not source or error:
        return set(), source
    years = set(range(1900, 2100))
    for unit in source:
        year = unit['provider_year']; years &= {year-1, year, year+1}
    return years, source


def work(api, row):
    old = json.loads((ROOT / 'qualified' / full.receipt(row)).read_text())
    result = dict(old); result['yearSearchVersion'] = 1
    years, source = allowed_years(row)
    if not years:
        result['reason'] = 'conflicting_source_variant_years'; return result
    candidates = {}; truncated = False
    for query in dict.fromkeys(v for _, v in full.deep.previous.source_hints(row)):
        for year in sorted(years):
            for locale in ['pt-BR', 'en-US', 'fr-FR']:
                for page in range(1, 11):
                    payload = api.get('search/movie', query=audit.clean_title(query), year=year,
                                      language=locale, include_adult='false', page=page)
                    assert isinstance(payload.get('results'), list)
                    candidates.update({str(d['id']): d for d in payload['results']})
                    if page >= payload.get('total_pages', 1):
                        break
                    if page == 10:
                        truncated = True
    relevant = [i for i, d in candidates.items() if full.deep.discovery_score(row['title'], d) >= 0.68]
    if len(relevant) > 100:
        truncated = True
    details = [api.details('movie', i) for i in relevant[:100]]
    chosen, reason, _ = full.independent_assessment(row, details, full.deep.previous.source_hints(row), truncated)
    result.update({'candidateIds': relevant, 'searchYears': sorted(years), 'reason': reason})
    if truncated:
        result['reason'] = 'truncated_year_candidates'; return result
    if not chosen:
        return result
    d = chosen['details']; proof = chosen['unitProof']
    if row['provider_tmdb_id'] != str(d['id']) and (not isinstance(d.get('runtime'), (int, float)) or d['runtime'] < 30):
        result.update({'reason': 'short_or_empty_candidate_requires_independent_media_proof',
                       'unconfirmedCandidateId': str(d['id'])}); return result
    d = dict(d); lang, plot = full.deep.previous.synopsis(d)
    if not d.get('overview') and plot:
        d['overview'] = plot; result['fallbackLanguage'] = lang
    result.update({'status': 'verified_existing' if str(d['id']) == row['provider_tmdb_id'] else 'matched',
                   'tmdbId': str(d['id']), 'details': d, 'unitProof': proof, 'evidence': 'source_media_year_alias', 'reason': None})
    result['metadataCheck'] = full.metadata_checks(row, d)
    if str(d['id']) in ((row['metadata'].get('tmdbSearchReview') or {}).get('rejectedTmdbIds') or []):
        result['protectedPreviousRejection'] = True
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--follow', action='store_true'); args = parser.parse_args()
    rows = json.loads((ROOT / 'inputs.json').read_text()); done = set(); tasks = []
    api = audit.Tmdb(); began = time.time(); output = ROOT / 'year-review'; output.mkdir(mode=0o700, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        while len(done) < len(rows):
            ready = []
            for row in rows:
                key = full.receipt(row); file = ROOT / 'qualified' / key
                if key in done or not file.exists():
                    continue
                r = json.loads(file.read_text())
                if r.get('sourceProofVersion') != 4:
                    continue
                done.add(key)
                if row['item_type'] == 'movie' and r['status'] == 'unresolved' and r.get('reason') == 'truncated_candidates':
                    years, source = allowed_years(row)
                    if source:
                        tasks.append(key)
                        if not (output / key).exists() or json.loads((output / key).read_text()).get('sourceProofVersion') != 4:
                            ready.append(row)
            futures = {pool.submit(work, api, row): row for row in ready}
            for f in as_completed(futures):
                row = futures[f]
                try:
                    r = f.result()
                except Exception as e:
                    r = {'title': row['title'], 'itemType': row['item_type'], 'identityKey': row['identity_key'],
                         'inputHash': audit.digest(row), 'sourceProofVersion': 4, 'status': 'request_error', 'reason': type(e).__name__}
                full.save(output / full.receipt(row), r)
            print(json.dumps({'rowsExamined': len(done), 'total': len(rows), 'eligibleCappedTitles': len(tasks), 'requests': api.requests}), flush=True)
            if not args.follow:
                break
            assert time.time()-began < 7200, 'Full identity audit did not complete; receipts preserved'
            if len(done) < len(rows):
                time.sleep(15)
    results = [json.loads(f.read_text()) for f in output.glob('*.json')]
    full.save(ROOT / 'years.safe.json', {'allRowsExamined': len(done) == len(rows), 'rows': len(done),
      'eligibleTasks': len(tasks), 'completedTasks': len(results), 'requests': api.requests,
      'confirmed': [{'title': r['title'], 'tmdbId': r.get('tmdbId')} for r in results if r['status'] in ['matched', 'verified_existing']],
      'at': time.time()})


if __name__ == '__main__':
    main()
