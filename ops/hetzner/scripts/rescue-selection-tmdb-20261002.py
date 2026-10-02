"""Second, read-only pass using public filenames and confirmed TMDB aliases.

Never drops lexical content or sequel numbers. Portuguese article omission is
limited to two function words and requires TMDB's actual Portuguese translation.
All candidate IDs must agree; an ambiguous remake stays unresolved.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import importlib.util
import json
from pathlib import Path
import re
import urllib.parse

spec = importlib.util.spec_from_file_location('selection_audit', Path(__file__).with_name('audit-selection-tmdb-20261002.py'))
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)


def omission(left, right):
    a, b = audit.normalized(left).split(), audit.normalized(right).split()
    if len(a) > len(b):
        a, b = b, a
    if len(a) < 3 or len(b) - len(a) not in [1, 2]:
        return False
    stop = {'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'no', 'na', 'sob'}
    if sum(word not in stop for word in a) < 2:
        return False
    index, skipped = 0, []
    for token in b:
        if index < len(a) and a[index] == token:
            index += 1
        else:
            skipped.append(token)
    return index == len(a) and all(t in stop for t in skipped)


def extended_match(title, details, year):
    if not audit.year_ok(year, details):
        return False
    if audit.exact_match(title, details, year):
        return True
    compact = audit.normalized(title).replace(' ', '')
    if len(compact) >= 12 and any(compact == audit.normalized(alias).replace(' ', '') for alias in audit.aliases(details)):
        return True
    translations = (details.get('translations') or {}).get('translations', [])
    return any(t.get('iso_639_1') == 'pt' and omission(title, (t.get('data') or {}).get('title')) for t in translations)


def file_title(url):
    raw = urllib.parse.unquote(urllib.parse.urlsplit(url or '').path.split('/')[-1])
    if not re.search(r'\.(?:mp4|mkv|avi|ts|m4v)$', raw, re.I):
        return None
    raw = re.sub(r'\.(?:mp4|mkv|avi|ts|m4v)$', '', raw, flags=re.I)
    raw = raw.replace('.', ' ').replace('_', ' ')
    raw = re.sub(r'\s*[- ]+BY\s+SANDRO\s+STORE.*$', '', raw, flags=re.I)
    raw = re.sub(r'\s+', ' ', raw).strip(' -')
    return raw if len(raw) >= 3 else None


def main():
    root = audit.ROOT
    rows = json.loads((root / 'inputs.json').read_text())
    files = json.loads(audit.sql("""select jsonb_object_agg(identity_key,urls) from (
      select v.identity_key,jsonb_agg(distinct m.playback_hint->>'targetUrl') urls
      from selection_shared_variants v join selection_shared_media m on m.release_id=v.release_id
       and m.item_type=v.item_type and m.external_id=v.external_id where v.item_type='movie'
      group by v.identity_key)x;"""))
    api = audit.Tmdb()
    results = []
    def worker(row):
        path = root / 'results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')
        old = json.loads(path.read_text())
        if old['status'] != 'unresolved':
            return old['status']
        title, year = row['title'], audit.title_year(row['title'])
        candidate_details = [api.details(row['item_type'], ident) for ident in old.get('candidateIds', [])]
        matches = {str(d['id']): (d, 'unique_spacing_or_portuguese_alias') for d in candidate_details
                   if d.get('id') and extended_match(title, d, year)}
        if len(matches) > 1:
            return 'unresolved'
        queries = list(dict.fromkeys(file_title(u) for u in files.get(row['identity_key'], []) if file_title(u)))[:3]
        for query in queries:
            if audit.normalized(query) == audit.normalized(title):
                continue
            details, truncated = api.search(row['item_type'], query, audit.title_year(query))
            if truncated:
                continue
            for d in details:
                if d.get('id') and extended_match(query, d, audit.title_year(query)):
                    matches[str(d['id'])] = (d, 'unique_source_filename_alias')
        if len(matches) == 1:
            ident, (details, evidence) = next(iter(matches.items()))
            if row['provider_tmdb_id'] != ident:
                old.update({'status': 'matched', 'tmdbId': ident, 'details': details, 'evidence': evidence})
            else:
                old.update({'status': 'verified_existing', 'tmdbId': ident, 'details': details, 'evidence': evidence})
            old['rescueQueries'] = queries
            path.write_text(json.dumps(old, ensure_ascii=False)); path.chmod(0o600)
            return 'rescued'
        return 'unresolved'
    print(json.dumps({'readOnlyRescue': True, 'input': len(rows)}), flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in as_completed([pool.submit(worker, row) for row in rows]):
            try:
                results.append(future.result())
            except Exception as e:
                results.append('request_error')
            if len(results) % 100 == 0 or len(results) == len(rows):
                print(json.dumps({'done': len(results), 'rescued': results.count('rescued'),
                                  'errors': results.count('request_error'), 'requests': api.requests}), flush=True)
    (root / 'rescue.safe.json').write_text(json.dumps({'rescued': results.count('rescued'), 'errors': results.count('request_error'), 'requests': api.requests}))


if __name__ == '__main__':
    main()
