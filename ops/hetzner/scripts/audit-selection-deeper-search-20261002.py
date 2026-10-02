"""Read-only wider discovery, with the unchanged strict identity assessment.

Do not treat a search rank, a punctuation resemblance or an API miss as proof.
Keep a new immutable input snapshot and receipts separate from completed passes.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher
import json
import re
import time

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


def module(name, file):
    spec = spec_from_file_location(name, Path(__file__).with_name(file))
    result = module_from_spec(spec); spec.loader.exec_module(result)
    return result


previous = module('deep_previous', 'audit-selection-remainder-20261002.py')
audit = previous.audit
ROOT = audit.ROOT / 'deeper-search'
RESULTS = ROOT / 'audit'


def compact(value):
    return audit.normalized(value).replace(' ', '')


def discovery_score(query, candidate):
    """Candidate discovery only; never used as identity confidence."""
    return max((SequenceMatcher(None, compact(query), compact(v)).ratio()
                for v in [candidate.get('title'), candidate.get('name'),
                          candidate.get('original_title'), candidate.get('original_name')] if v), default=0)


def query_variants(value):
    variants = [audit.clean_title(value)]
    # A provider may join initials (Pi Meena / P.I. Meena), digits or words.
    initials = re.sub(r'^([A-Za-z]{2}) (?=\w)', lambda m: ' '.join(m[1]) + ' ', variants[0])
    if initials != variants[0]:
        variants.append(initials)
    words = re.sub(r'(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])', ' ', value)
    if audit.clean_title(words) not in variants:
        variants.append(audit.clean_title(words))
    return [v for v in variants if v][:3]


class WiderTmdb(audit.Tmdb):
    def search(self, kind, title, year):
        results = {}; truncated = False
        locales = ['pt-BR', 'en-US', 'fr-FR']
        for label, locale in [('Tamil', 'ta-IN'), ('Telugu', 'te-IN'), ('Hindi', 'hi-IN'),
                              ('Malayalam', 'ml-IN'), ('Kannada', 'kn-IN')]:
            if re.search(r'\b' + label + r'\b', title, re.I):
                locales.insert(0, locale)
        for query in query_variants(title):
            for locale in dict.fromkeys(locales):
                for page in range(1, 4):
                    payload = self.get('search/' + ('tv' if kind == 'series' else 'movie'),
                      query=query, language=locale, include_adult='false', page=page)
                    assert isinstance(payload.get('results'), list), 'Invalid TMDB search'
                    for result in payload['results']:
                        results.setdefault(result['id'], []).append(result)
                    if page >= payload.get('total_pages', 1):
                        break
                    if page == 3:
                        truncated = True  # Do not select from an incomplete homonym set.
        ranked = sorted(results, key=lambda ident: (
          max(discovery_score(title, x) for x in results[ident]), -list(results).index(ident)), reverse=True)
        relevant = [ident for ident in ranked if any(discovery_score(title, x) >= 0.68 for x in results[ident])]
        ids = list(dict.fromkeys(relevant + ranked[:6]))
        truncated = truncated or len(ids) > 24
        return [self.details(kind, ident) for ident in ids[:24]], truncated


def snapshot():
    """Capture the common published release only; no private inventories."""
    scope = """select t.* from selection_shared_titles t where t.release_id=(
      select id from selection_shared_releases where published_at is not null order by published_at desc limit 1)
      and t.item_type in ('movie','series') and (t.provider_tmdb_id is null
      or nullif(t.poster_url,'') is null or """ + audit.SYNOPSIS + ' is null)'
    rows = json.loads(audit.sql("""with scope as materialized(""" + scope + """)
      select jsonb_agg(x) from(select t.release_id,r.manifest_sha256,t.item_type,t.identity_key,
       t.title,t.provider_tmdb_id,t.poster_url,t.metadata,
       (select v.poster_url from selection_shared_variants v where v.release_id=t.release_id
        and v.item_type=t.item_type and v.identity_key=t.identity_key and v.poster_url is not null
        order by external_id limit 1) manifest_poster,
       (select jsonb_agg(u) from(select distinct v.playback_hint->>'targetUrl' u from selection_shared_variants v
        where v.release_id=t.release_id and v.item_type=t.item_type and v.identity_key=t.identity_key
         and v.playback_hint->>'targetUrl' ~ '^https?://' order by u limit 3)s) file_urls
       from scope t join selection_shared_releases r on r.id=t.release_id order by t.item_type,t.title)x;""")) or []
    raw_units = json.loads(audit.sql("""with scope as materialized(""" + scope + """),
      v as materialized(select v.* from selection_shared_variants v join scope t
        on t.release_id=v.release_id and t.item_type=v.item_type and t.identity_key=v.identity_key),
      units as(select v.item_type,v.identity_key,m.external_id,m.title,m.metadata->'year' provider_year,
        m.metadata->>'selectionVodGroup' provider_group,m.metadata->'selectionUnit' source_unit,
        m.metadata->>'selectionParentId' parent_id from v join selection_shared_media m
        on m.release_id=v.release_id and m.external_id=v.external_id
        union select v.item_type,v.identity_key,m.external_id,m.title,m.metadata->'year',
        m.metadata->>'selectionVodGroup',m.metadata->'selectionUnit',m.metadata->>'selectionParentId'
        from v join selection_shared_media m on m.release_id=v.release_id
         and m.metadata->>'selectionParentId'=v.external_id where v.item_type='series')
      select jsonb_agg(x) from(select item_type,identity_key,
       jsonb_agg(to_jsonb(u)-'item_type'-'identity_key' order by external_id) provider_units
       from units u group by item_type,identity_key)x;""")) or []
    by_key = {(u['item_type'], u['identity_key']): u['provider_units'] for u in raw_units}
    ROOT.mkdir(mode=0o700, exist_ok=True)
    expanded = [{**r, 'provider_units': by_key.get((r['item_type'], r['identity_key'])) or []} for r in rows]
    for name, data in [('inputs.json', rows), ('source-units-inputs.json', expanded)]:
        f = ROOT / name
        if f.exists():
            assert audit.digest(json.loads(f.read_text())) == audit.digest(data), 'Source changed; use a fresh receipt directory'
        else:
            f.write_text(json.dumps(data, ensure_ascii=False)); f.chmod(0o600)
    print(json.dumps({'snapshot': len(rows), 'inputSha256': audit.digest(rows), 'sourceUnitsSha256': audit.digest(expanded)}))


def audit_row(api, row):
    hints = previous.source_hints(row)
    details = {}
    if row['provider_tmdb_id']:
        d = api.details(row['item_type'], row['provider_tmdb_id'])
        if d.get('id'):
            details[str(d['id'])] = d
    years = {audit.title_year(value) for _, value in hints if audit.title_year(value)}
    year = next(iter(years), None) if len(years) == 1 else None
    truncated = False
    for query in dict.fromkeys(v for _, v in hints):
        candidates, cap = api.search(row['item_type'], query, year or audit.title_year(query))
        details.update({str(d['id']): d for d in candidates if d.get('id')})
        truncated |= cap
    chosen, reason, matching = previous.assess(row, list(details.values()), hints)
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
    ident, evidence, proof, source_year = chosen
    d = dict(details[ident])
    result.update({'status': 'verified_existing' if ident == row['provider_tmdb_id'] else 'matched',
      'tmdbId': ident, 'evidence': evidence, 'aliasProof': proof, 'sourceYear': source_year})
    if not d.get('poster_path') and not row['poster_url']:
        images = api.get(('tv' if row['item_type'] == 'series' else 'movie') + '/' + ident + '/images')
        posters = [x for x in images.get('posters', []) if previous.valid_image(x.get('file_path'))
                   and 0.5 <= x.get('aspect_ratio', 0) <= 0.8]
        posters.sort(key=lambda x: (x.get('iso_639_1') in [d.get('original_language'), 'en', 'pt', 'fr'],
                                   x.get('vote_count', 0), x.get('height', 0)), reverse=True)
        if posters:
            d['poster_path'] = posters[0]['file_path']
            result['imageProof'] = {'endpoint': ('tv' if row['item_type'] == 'series' else 'movie') + '/' + ident + '/images',
                                    'filePath': d['poster_path'], 'language': posters[0].get('iso_639_1')}
    lang, overview = previous.synopsis(d)
    if not d.get('overview') and overview:
        d['overview'] = overview; result['fallbackLanguage'] = lang
    result['details'] = d
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--duration', action='store_true')
    parser.add_argument('--snapshot', action='store_true')
    args = parser.parse_args()
    if args.snapshot:
        snapshot(); return
    rows = json.loads((ROOT / 'inputs.json').read_text())
    RESULTS.mkdir(mode=0o700, exist_ok=True)
    output = RESULTS / 'results'; output.mkdir(mode=0o700, exist_ok=True)
    api = WiderTmdb()
    if args.duration:
        previous.RESULTS = RESULTS
        previous.duration_pass(api, rows, output)
        return
    def work(row):
        file = output / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        if file.exists():
            old = json.loads(file.read_text())
            assert old['inputHash'] == audit.digest(row), 'Input drift'
            if old['status'] != 'request_error':
                return old
        try:
            result = audit_row(api, row)
        except Exception as e:
            result = {'inputHash': audit.digest(row), 'status': 'request_error', 'title': row['title'],
                      'reason': str(e)[:160] if isinstance(e, RuntimeError) else type(e).__name__}
        file.write_text(json.dumps(result, ensure_ascii=False)); file.chmod(0o600)
        return result
    results = []; stats = {}
    print(json.dumps({'readOnly': True, 'inputs': len(rows), 'inputSha256': audit.digest(rows)}), flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for f in as_completed([pool.submit(work, r) for r in rows]):
            result = f.result(); results.append(result)
            stats[result['status']] = stats.get(result['status'], 0) + 1
            if len(results) % 25 == 0 or len(results) == len(rows):
                print(json.dumps({'done': len(results), 'statuses': stats, 'requests': api.requests}), flush=True)
    summary = {'at': time.time(), 'inputs': len(rows), 'statuses': stats, 'requests': api.requests,
      'inputSha256': audit.digest(rows), 'resultsSha256': audit.digest(sorted(results, key=lambda x: x['title']))}
    (RESULTS / 'audit.safe.json').write_text(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
