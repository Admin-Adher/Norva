"""Exhaustive public Selection ledger, including already enriched titles.

No row limit, no database writes. Snapshot, identity receipts, artwork receipts
and full coverage checks are separate and resumable. A timeout is unknown,
never evidence that an identity or an artwork is invalid.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from importlib.util import module_from_spec, spec_from_file_location


def module(name, file):
    spec = spec_from_file_location(name, Path(__file__).with_name(file))
    result = module_from_spec(spec); spec.loader.exec_module(result)
    return result


deep = module('exhaustive_deep', 'audit-selection-deeper-search-20261002.py')
units = module('exhaustive_units', 'prove-selection-source-units-20261002.py')
audit = deep.audit
ROOT = audit.ROOT / 'exhaustive'
LANGUAGES = ['fr', 'en', 'pt', 'es', 'hi', 'tr', 'bn', 'ar', 'id', 'tl']


def save(file, value):
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False)); file.chmod(0o600)


def receipt(row):
    return audit.digest([row['item_type'], row['identity_key']]) + '.json'


def snapshot():
    scope = """select t.* from selection_shared_titles t where t.release_id=(
      select id from selection_shared_releases where published_at is not null
      order by published_at desc limit 1) and t.item_type in ('movie','series')"""
    rows = json.loads(audit.sql("""with scope as materialized(""" + scope + """),
      v as materialized(select v.* from selection_shared_variants v join scope t
       on t.release_id=v.release_id and t.item_type=v.item_type and t.identity_key=v.identity_key),
      hints as(select item_type,identity_key,
       min(poster_url) filter(where poster_url is not null) manifest_poster,
       jsonb_agg(distinct playback_hint->>'targetUrl') filter(where playback_hint->>'targetUrl' ~ '^https?://') file_urls
       from v group by item_type,identity_key)
      select jsonb_agg(x) from(select t.release_id,r.manifest_sha256,t.item_type,t.identity_key,
       t.title,t.provider_tmdb_id,t.poster_url,t.metadata,h.manifest_poster,h.file_urls
       from scope t join selection_shared_releases r on r.id=t.release_id
       left join hints h on h.item_type=t.item_type and h.identity_key=t.identity_key
       order by t.item_type,t.identity_key)x;""")) or []
    raw_units = json.loads(audit.sql("""with scope as materialized(""" + scope + """),
      v as materialized(select v.* from selection_shared_variants v join scope t
        on t.release_id=v.release_id and t.item_type=v.item_type and t.identity_key=v.identity_key),
      u as(select v.item_type,v.identity_key,m.external_id,m.title,m.metadata->'year' provider_year,
        m.metadata->>'selectionVodGroup' provider_group,m.metadata->'selectionUnit' source_unit,
        m.metadata->>'selectionParentId' parent_id from v join selection_shared_media m
        on m.release_id=v.release_id and m.external_id=v.external_id
        union select v.item_type,v.identity_key,m.external_id,m.title,m.metadata->'year',
        m.metadata->>'selectionVodGroup',m.metadata->'selectionUnit',m.metadata->>'selectionParentId'
        from v join selection_shared_media m on m.release_id=v.release_id
         and m.metadata->>'selectionParentId'=v.external_id where v.item_type='series')
      select jsonb_agg(x) from(select item_type,identity_key,
       jsonb_agg(to_jsonb(u)-'item_type'-'identity_key' order by external_id) provider_units
       from u group by item_type,identity_key)x;""")) or []
    by_key = {(u['item_type'], u['identity_key']): u['provider_units'] for u in raw_units}
    rows = [{**r, 'provider_units': by_key.get((r['item_type'], r['identity_key'])) or []} for r in rows]
    assert rows and len({receipt(r) for r in rows}) == len(rows), 'Inventory must be unique and nonempty'
    file = ROOT / 'inputs.json'
    if file.exists():
        assert audit.digest(json.loads(file.read_text())) == audit.digest(rows), 'Immutable snapshot changed'
    else:
        save(file, rows)
    summary = {'rows': len(rows), 'byType': dict(Counter(r['item_type'] for r in rows)),
               'inputSha256': audit.digest(rows), 'snapshotAt': time.time()}
    save(ROOT / 'snapshot.safe.json', summary); print(json.dumps(summary), flush=True)


def source_snapshot():
    rows = json.loads((ROOT / 'inputs.json').read_text())
    release = rows[0]['release_id']
    data = json.loads(audit.sql("""with v as materialized(select * from selection_shared_variants
      where release_id='""" + release + """'), u as(
      select v.item_type,v.identity_key,m.external_id,m.title,m.poster_url,m.metadata,m.playback_hint
       from v join selection_shared_media m on m.release_id=v.release_id and m.external_id=v.external_id
      union select v.item_type,v.identity_key,m.external_id,m.title,m.poster_url,m.metadata,m.playback_hint
       from v join selection_shared_media m on m.release_id=v.release_id
       and m.metadata->>'selectionParentId'=v.external_id where v.item_type='series')
      select jsonb_agg(x) from(select item_type,identity_key,jsonb_agg(to_jsonb(u)-'item_type'-'identity_key'
       order by external_id) raw_media from u group by item_type,identity_key)x;""")) or []
    assert len(data) == len(rows)
    file = ROOT / 'raw-source-evidence.json'
    if file.exists():
        assert audit.digest(json.loads(file.read_text())) == audit.digest(data), 'Raw source evidence changed'
    else:
        save(file, data)
    print(json.dumps({'rawTitleCoverage': len(data), 'rawEvidenceSha256': audit.digest(data)}), flush=True)


def independent_assessment(row, candidates, hints, truncated):
    """Raw dates/seasons resolve homonyms, but never conceal source conflicts."""
    chosen, reason, matching = deep.previous.assess(row, candidates, hints)
    supported, conflict = units.supported_units(row)
    if conflict:
        return None, conflict, matching
    if truncated:
        return None, 'truncated_candidates', matching
    unit_chosen, unit_reason = units.assess(row, candidates)
    if unit_chosen:
        d, proof = unit_chosen
        ident = str(d['id'])
        # Independent filename evidence and raw media units must agree.
        if chosen and chosen[0] != ident:
            return None, 'source_filename_and_units_disagree', matching
        return {'tmdbId': ident, 'evidence': 'source_series_season_alias'
                if row['item_type'] == 'series' else 'source_media_year_alias',
                'unitProof': proof, 'details': d}, None, [ident]
    if chosen:
        ident, evidence, proof, year = chosen
        d = next(d for d in candidates if str(d.get('id')) == ident)
        if supported and not units.unit_match(row, d, supported):
            return None, 'official_identity_conflicts_with_raw_units', matching
        return {'tmdbId': ident, 'evidence': evidence, 'aliasProof': proof,
                'sourceYear': year, 'details': d}, None, matching
    return None, reason or unit_reason or 'unresolved', matching


def metadata_checks(row, details):
    md = row['metadata'] or {}; tmdb = md.get('tmdb') or {}
    issues = []
    if tmdb.get('id') and str(tmdb['id']) != str(row['provider_tmdb_id']):
        issues.append('metadata_id_disagrees')
    overview = tmdb.get('overview') or md.get('overview') or md.get('plot')
    if isinstance(overview, str) and any(x in overview.lower() for x in ['github.com/', 'http://', 'https://']):
        issues.append('synopsis_contains_link_requires_review')
    official = {}
    if details:
        official = {t.get('iso_639_1'): (t.get('data') or {}).get('overview')
                    for t in (details.get('translations') or {}).get('translations', [])}
    stored = {lang: bool((md.get('i18n') or {}).get(lang, {}).get('overview')) for lang in LANGUAGES}
    missing_available = [lang for lang in LANGUAGES if not stored[lang] and official.get(lang)]
    return {'issues': issues, 'storedSynopsisLanguages': [l for l in LANGUAGES if stored[l]],
            'officialSynopsisLanguages': [l for l in LANGUAGES if official.get(l)],
            'missingAvailableTranslations': missing_available,
            'hasFallbackSynopsis': bool(overview or stored['fr'] or stored['en'])}


def audit_row(api, row):
    hints = deep.previous.source_hints(row)
    candidates = {}
    if row['provider_tmdb_id']:
        old = api.details(row['item_type'], row['provider_tmdb_id'])
        if old.get('id'):
            candidates[str(old['id'])] = old
    truncated = False
    for query in dict.fromkeys(v for _, v in hints):
        found, cap = api.search(row['item_type'], query, audit.title_year(query))
        truncated |= cap
        candidates.update({str(d['id']): d for d in found if d.get('id')})
    chosen, reason, matching = independent_assessment(row, list(candidates.values()), hints, truncated)
    result = {'title': row['title'], 'itemType': row['item_type'], 'identityKey': row['identity_key'],
              'inputHash': audit.digest(row), 'candidateIds': list(candidates), 'matchingIds': matching,
              'hints': hints, 'status': 'unresolved', 'reason': reason}
    if chosen:
        d = dict(chosen['details']); ident = chosen['tmdbId']
        result.update(chosen)
        result['status'] = 'verified_existing' if ident == row['provider_tmdb_id'] else 'matched'
        path = audit.poster_path(row['poster_url'])
        if not d.get('poster_path') or (path and path != d.get('poster_path')):
            images = api.get(('tv' if row['item_type'] == 'series' else 'movie') + '/' + ident + '/images')
            posters = [p for p in images.get('posters') or [] if deep.previous.valid_image(p.get('file_path'))]
            result['posterIdentity'] = 'confirmed_official_image' if path and any(p['file_path'] == path for p in posters) else 'not_confirmed'
            if not d.get('poster_path'):
                eligible = [p for p in posters if 0.5 <= p.get('aspect_ratio', 0) <= 0.8]
                eligible.sort(key=lambda p: (p.get('iso_639_1') in [d.get('original_language'), 'en', 'pt', 'fr'],
                                             p.get('vote_count', 0), p.get('height', 0)), reverse=True)
                if eligible:
                    d['poster_path'] = eligible[0]['file_path']
                    result['imageProof'] = {'filePath': d['poster_path'], 'endpoint': ident + '/images'}
        elif path:
            result['posterIdentity'] = 'confirmed_primary_image'
        else:
            result['posterIdentity'] = 'provider_or_missing'
        lang, plot = deep.previous.synopsis(d)
        if not d.get('overview') and plot:
            d['overview'] = plot; result['fallbackLanguage'] = lang
        result['details'] = d
        if ident in ((row['metadata'].get('tmdbSearchReview') or {}).get('rejectedTmdbIds') or []):
            result['protectedPreviousRejection'] = True
    else:
        result['candidateSummaries'] = [{'id': str(d['id']), 'title': d.get('title') or d.get('name'),
          'year': (d.get('release_date') or d.get('first_air_date') or '')[:4],
          'runtime': d.get('runtime'), 'aliases': audit.aliases(d)} for d in candidates.values()]
    result['metadataCheck'] = metadata_checks(row, result.get('details'))
    return result


def identities():
    rows = json.loads((ROOT / 'inputs.json').read_text()); api = deep.WiderTmdb()
    api.request_interval = 1 / 24
    results = []; statuses = Counter(); began = time.time()
    def work(row):
        file = ROOT / 'identity' / receipt(row)
        if file.exists():
            r = json.loads(file.read_text()); assert r['inputHash'] == audit.digest(row)
            if r['status'] != 'request_error':
                return r
        try:
            r = audit_row(api, row)
        except Exception as e:
            r = {'title': row['title'], 'itemType': row['item_type'], 'identityKey': row['identity_key'],
                 'inputHash': audit.digest(row), 'status': 'request_error', 'reason': type(e).__name__}
        save(file, r); return r
    with ThreadPoolExecutor(max_workers=16) as pool:
        for f in as_completed([pool.submit(work, row) for row in rows]):
            r = f.result(); results.append(r); statuses[r['status']] += 1
            if len(results) % 100 == 0 or len(results) == len(rows):
                progress = {'done': len(results), 'total': len(rows), 'statuses': dict(statuses),
                            'requests': api.requests, 'elapsed': round(time.time()-began, 1)}
                save(ROOT / 'progress.safe.json', progress); print(json.dumps(progress), flush=True)
    assert len(results) == len(rows), 'Every title needs a receipt'
    save(ROOT / 'identity.safe.json', {'rows': len(rows), 'statuses': dict(statuses), 'requests': api.requests,
         'inputSha256': audit.digest(rows), 'resultsSha256': audit.digest(sorted(results, key=lambda r: r['identityKey']))})


def check_artwork(url):
    parsed = urllib.parse.urlsplit(url)
    assert parsed.scheme in ['http', 'https'] and parsed.hostname
    status = 'request_error'; code = None; content_type = None
    for attempt in range(2):
        try:
            request = urllib.request.Request(url, method='GET', headers={'Range': 'bytes=0-1023', 'User-Agent': 'Norva-artwork-audit/1'})
            with urllib.request.urlopen(request, timeout=12) as response:
                code = response.status; content_type = response.headers.get('Content-Type', '').split(';')[0]
                prefix = response.read(1024)
                image_magic = prefix.startswith((b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n', b'GIF8')) or (prefix[:4] == b'RIFF' and prefix[8:12] == b'WEBP')
                status = 'ok' if code in [200, 206] and content_type.startswith('image/') and image_magic else 'not_image'
            break
        except urllib.error.HTTPError as e:
            code = e.code
            status = 'missing' if code in [404, 410] else 'access_error'
            if code in [404, 410]:
                break
        except (ValueError, TimeoutError, OSError):
            pass
    return {'urlHash': audit.digest(url), 'status': status, 'httpStatus': code, 'contentType': content_type, 'at': time.time()}


def posters():
    resolve = socket.getaddrinfo
    socket.getaddrinfo = lambda host, port, family=0, type=0, proto=0, flags=0: resolve(
        host, port, socket.AF_INET, type, proto, flags)
    rows = json.loads((ROOT / 'inputs.json').read_text())
    urls = sorted({r['poster_url'] for r in rows if r['poster_url']})
    results = []; stats = Counter()
    def work(url):
        file = ROOT / 'artwork' / (audit.digest(url) + '.json')
        if file.exists():
            r = json.loads(file.read_text())
            if r['status'] in ['ok', 'missing', 'not_image']:
                return r
        r = check_artwork(url); save(file, r); return r
    with ThreadPoolExecutor(max_workers=8) as pool:
        for f in as_completed([pool.submit(work, url) for url in urls]):
            r = f.result(); results.append(r); stats[r['status']] += 1
            if len(results) % 100 == 0 or len(results) == len(urls):
                print(json.dumps({'postersDone': len(results), 'uniquePosters': len(urls), 'statuses': dict(stats)}), flush=True)
    save(ROOT / 'artwork.safe.json', {'rows': len(rows), 'uniqueUrls': len(urls), 'statuses': dict(stats),
                                    'resultsSha256': audit.digest(sorted(results, key=lambda r: r['urlHash']))})


def ledger():
    rows = json.loads((ROOT / 'inputs.json').read_text()); output = []
    for row in rows:
        f = ROOT / 'identity' / receipt(row); assert f.exists(), 'Unexamined title'
        r = json.loads(f.read_text()); assert r['inputHash'] == audit.digest(row)
        poster = {'status': 'absent'}
        if row['poster_url']:
            f = ROOT / 'artwork' / (audit.digest(row['poster_url']) + '.json')
            assert f.exists(), 'Unexamined artwork'; poster = json.loads(f.read_text())
        output.append({'providerTitle': row['title'], 'type': row['item_type'], 'identityKey': row['identity_key'],
          'currentId': row['provider_tmdb_id'], 'identityStatus': r['status'], 'reason': r.get('reason'),
          'candidateIds': r.get('candidateIds'), 'confirmedId': r.get('tmdbId'), 'evidence': r.get('evidence'),
          'posterStatus': poster['status'], 'posterIdentity': r.get('posterIdentity'),
          'metadata': r.get('metadataCheck'), 'protectedPreviousRejection': r.get('protectedPreviousRejection', False)})
    assert len(output) == len(rows) and len({(r['type'], r['identityKey']) for r in output}) == len(rows)
    save(ROOT / 'ledger.public.json', output)
    summary = {'rows': len(rows), 'allRowsExamined': True, 'byType': dict(Counter(r['type'] for r in output)),
      'identities': dict(Counter(r['identityStatus'] for r in output)), 'posters': dict(Counter(r['posterStatus'] for r in output)),
      'reasons': dict(Counter(r['reason'] for r in output if r['reason'])),
      'inputSha256': audit.digest(rows), 'ledgerSha256': audit.digest(output), 'at': time.time()}
    save(ROOT / 'ledger.safe.json', summary); print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('stage', choices=['snapshot', 'sources', 'identities', 'posters', 'ledger'])
    args = parser.parse_args()
    {'snapshot': snapshot, 'sources': source_snapshot, 'identities': identities, 'posters': posters, 'ledger': ledger}[args.stage]()
