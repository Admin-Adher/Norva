"""Resolve search caps using verified raw years, never a TMDB-inherited year.

Only the capped movie subset is eligible. All three permitted release years
are queried in all locales. Later TV seasons cannot use a first-air-year filter.
This remains read-only and creates a separate input and evidence directory.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import time

spec = spec_from_file_location('narrow_units', Path(__file__).with_name('prove-selection-source-units-20261002.py'))
units = module_from_spec(spec); spec.loader.exec_module(units)
audit = units.audit; ROOT = units.ROOT / 'year-narrow'


def main():
    rows = json.loads((units.ROOT / 'source-units-inputs.json').read_text())
    tasks = []
    for row in rows:
        r = json.loads((units.ROOT / 'unit-results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')).read_text())
        valid, error = units.supported_units(row)
        if row['item_type'] == 'movie' and r.get('reason') == 'truncated_candidates' and valid and not error:
            tasks.append(row)
    assert len(tasks) <= 40
    ROOT.mkdir(mode=0o700, exist_ok=True)
    f = ROOT / 'source-units-inputs.json'
    if f.exists():
        assert audit.digest(json.loads(f.read_text())) == audit.digest(tasks), 'Narrow input drift'
    else:
        f.write_text(json.dumps(tasks, ensure_ascii=False)); f.chmod(0o600)
    output = ROOT / 'unit-results'; output.mkdir(mode=0o700, exist_ok=True)
    api = audit.Tmdb()
    def work(row):
        file = output / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        if file.exists():
            r = json.loads(file.read_text()); assert r['inputHash'] == audit.digest(row)
            if r['status'] != 'request_error':
                return r
        result = {'title': row['title'], 'identityKey': row['identity_key'], 'itemType': 'movie',
                  'inputHash': audit.digest(row), 'status': 'unresolved'}
        try:
            source, _ = units.supported_units(row)
            years = sorted({u['provider_year'] + offset for u in source for offset in [-1, 0, 1]})
            assert len(years) <= 5, 'Conflicting raw years need separate review'
            candidates = {}; truncated = False
            queries = list(dict.fromkeys(v for _, v in units.deep.previous.source_hints(row)))
            for query in queries:
                for year in years:
                    for locale in ['pt-BR', 'en-US', 'fr-FR']:
                        for page in range(1, 4):
                            payload = api.get('search/movie', query=audit.clean_title(query), year=year,
                                              language=locale, include_adult='false', page=page)
                            assert isinstance(payload.get('results'), list), 'Invalid year search'
                            candidates.update({str(d['id']): d for d in payload['results']})
                            if page >= payload.get('total_pages', 1):
                                break
                            if page == 3:
                                truncated = True
            relevant = [ident for ident, d in candidates.items() if units.deep.discovery_score(row['title'], d) >= 0.68]
            if len(relevant) > 40:
                truncated = True
            details = [api.details('movie', ident) for ident in relevant[:40]]
            hit, reason = units.assess(row, details)
            result.update({'reason': 'truncated_year_candidates' if truncated else reason,
                           'candidateIds': relevant, 'searchYears': years})
            if hit and not truncated:
                d, source = hit; lang, overview = units.deep.previous.synopsis(d)
                if not d.get('overview') and overview:
                    d = {**d, 'overview': overview}; result['fallbackLanguage'] = lang
                result.update({'status': 'verified_existing' if str(d['id']) == row['provider_tmdb_id'] else 'matched',
                               'tmdbId': str(d['id']), 'details': d, 'unitProof': source, 'evidence': 'source_media_year_alias'})
        except Exception as e:
            result.update({'status': 'request_error', 'reason': type(e).__name__})
        file.write_text(json.dumps(result, ensure_ascii=False)); file.chmod(0o600)
        return result
    print(json.dumps({'readOnly': True, 'tasks': len(tasks)}), flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for f in as_completed([pool.submit(work, r) for r in tasks]):
            results.append(f.result())
            print(json.dumps({'done': len(results), 'matched': sum(r['status'] in ['matched', 'verified_existing'] for r in results),
                              'requests': api.requests}), flush=True)
    summary = {'at': time.time(), 'tasks': len(tasks), 'requests': api.requests, 'inputSha256': audit.digest(tasks),
               'matched': [{'title': r['title'], 'tmdbId': r['tmdbId']} for r in results if r['status'] in ['matched', 'verified_existing']],
               'resultsSha256': audit.digest(sorted(results, key=lambda r: r['title']))}
    (ROOT / 'audit.safe.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
