"""Disambiguate official aliases using immutable provider year/season units.

The year comes from the raw media and must agree with its original feed group.
A later series season is compared with that season's date, never the first-air
date. Search resemblance alone is insufficient; exact compact aliases retain
all sequel characters. No private owner data or database writes are performed.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import re
import time

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


spec = spec_from_file_location('unit_discovery', Path(__file__).with_name('audit-selection-deeper-search-20261002.py'))
deep = module_from_spec(spec); spec.loader.exec_module(deep)
audit = deep.audit
ROOT = deep.ROOT


def supported_units(row):
    units = []
    for unit in row.get('provider_units') or []:
        year = unit.get('provider_year')
        group_year = re.search(r'/\s*((?:19|20)\d{2})\s*$', unit.get('provider_group') or '')
        if year is None:
            continue
        if not isinstance(year, int) or not group_year or int(group_year[1]) != year:
            return [], 'conflicting_or_unverified_provider_year'
        raw = unit.get('source_unit') or {}
        base = raw.get('baseTitle') if row['item_type'] == 'series' else unit.get('title')
        if deep.compact(base) != deep.compact(row['title']):
            return [], 'source_unit_title_conflict'
        title_year = audit.title_year(unit.get('title'))
        if title_year and abs(title_year - year) > 1:
            return [], 'source_unit_year_conflict'
        seasons = raw.get('seasons') or []
        if row['item_type'] == 'series' and (not seasons or any(
          not isinstance(s, int) or s <= 0 for s in seasons)):
            return [], 'unverified_source_season'
        units.append(unit)
    return units, None


def unit_match(row, details, units):
    if not units or not details.get('id'):
        return False
    name = deep.compact(row['title'])
    if len(name) < 3 or name not in {deep.compact(a) for a in audit.aliases(details)}:
        return False
    if row['item_type'] == 'movie':
        return all(audit.year_ok(u['provider_year'], details) for u in units)
    seasons = {s.get('season_number'): s.get('air_date') or '' for s in details.get('seasons') or []}
    return all(len(seasons.get(number, '')) >= 4
               and abs(int(seasons[number][:4]) - u['provider_year']) <= 1
               for u in units for number in u['source_unit']['seasons'])


def assess(row, candidates):
    units, reason = supported_units(row)
    if not units:
        return None, reason or 'no_verified_source_year'
    hits = [d for d in candidates if unit_match(row, d, units)]
    if len({d['id'] for d in hits}) != 1:
        return None, 'ambiguous_source_units' if hits else 'no_unit_alias_match'
    return (hits[0], units), None


def main():
    rows = json.loads((ROOT / 'source-units-inputs.json').read_text())
    output = ROOT / 'unit-results'; output.mkdir(mode=0o700, exist_ok=True)
    api = audit.Tmdb()
    def work(row):
        receipt_file = output / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        if receipt_file.exists():
            old = json.loads(receipt_file.read_text())
            assert old['inputHash'] == audit.digest(row), 'Source unit input drift'
            if old['status'] != 'request_error':
                return old
        previous = json.loads((deep.RESULTS / 'results' / receipt_file.name).read_text())
        result = {**previous, 'inputHash': audit.digest(row)}
        if previous['status'] not in ['matched', 'verified_existing'] and previous.get('reason') != 'truncated_candidates':
            try:
                candidates = [api.details(row['item_type'], ident) for ident in previous.get('candidateIds') or []]
                chosen, reason = assess(row, candidates)
                result['reason'] = reason
                if chosen:
                    d, units = chosen
                    lang, overview = deep.previous.synopsis(d)
                    if not d.get('overview') and overview:
                        d = {**d, 'overview': overview}; result['fallbackLanguage'] = lang
                    result.update({'status': 'verified_existing' if str(d['id']) == row['provider_tmdb_id'] else 'matched',
                      'tmdbId': str(d['id']), 'details': d, 'unitProof': units,
                      'evidence': 'source_series_season_alias' if row['item_type'] == 'series' else 'source_media_year_alias'})
            except Exception as e:
                result.update({'status': 'request_error', 'reason': type(e).__name__})
        receipt_file.write_text(json.dumps(result, ensure_ascii=False)); receipt_file.chmod(0o600)
        return result
    results = []; stats = {}; unit_matched = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for f in as_completed([pool.submit(work, row) for row in rows]):
            r = f.result(); results.append(r)
            stats[r['status']] = stats.get(r['status'], 0) + 1
            if r.get('unitProof'):
                unit_matched.append({'title': r['title'], 'tmdbId': r['tmdbId'], 'itemType': r['itemType']})
    summary = {'at': time.time(), 'inputs': len(rows), 'statuses': stats, 'requests': api.requests,
               'unitMatched': unit_matched, 'inputSha256': audit.digest(rows),
               'resultsSha256': audit.digest(sorted(results, key=lambda x: x['title']))}
    (ROOT / 'units.safe.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
