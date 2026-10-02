"""Exhaustive public Selection ledger, including already enriched titles.

No row limit, no database writes. Snapshot, identity receipts, artwork receipts
and full coverage checks are separate and resumable. A timeout is unknown,
never evidence that an identity or an artwork is invalid.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import socket
import threading
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
    temporary = file.with_name(file.name + '.' + str(os.getpid()) + '.' + str(threading.get_ident()) + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False)); temporary.chmod(0o600)
    temporary.replace(file)


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
    supported, conflict = units.supported_units(row)
    def dates_agree(d):
        if row['item_type'] == 'movie':
            return all(audit.year_ok(u['provider_year'], d) for u in supported)
        seasons = {s.get('season_number'): s.get('air_date') or '' for s in d.get('seasons') or []}
        return all(len(seasons.get(n, '')) >= 4 and abs(int(seasons[n][:4])-u['provider_year']) <= 1
                   for u in supported for n in u['source_unit']['seasons'])
    eligible = [d for d in candidates if not supported or dates_agree(d)]
    chosen, reason, matching = deep.previous.assess(row, eligible, hints)
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
        if supported:
            # The complete source filename/logo alias may be more precise
            # than its shortened provider label. Its date must still agree.
            return {'tmdbId': ident, 'evidence': 'source_series_season_alias'
                    if row['item_type'] == 'series' else 'source_media_year_alias',
                    'unitProof': supported, 'aliasProof': proof, 'details': d}, None, matching
        return {'tmdbId': ident, 'evidence': evidence, 'aliasProof': proof,
                'sourceYear': year, 'details': d}, None, matching
    return None, reason or unit_reason or 'unresolved', matching


def metadata_checks(row, details):
    md = row['metadata'] or {}; tmdb = md.get('tmdb') or {}
    issues = []
    if tmdb.get('id') and str(tmdb['id']) != str(row['provider_tmdb_id']):
        issues.append('metadata_id_disagrees')
    overview = tmdb.get('overview') or md.get('overview') or md.get('plot')
    texts = [overview, md.get('overview'), md.get('plot')]
    texts += [(md.get('i18n') or {}).get(lang, {}).get('overview') for lang in LANGUAGES]
    if any(isinstance(text, str) and any(x in text.lower() for x in ['github.com/', 'http://', 'https://']) for text in texts):
        issues.append('synopsis_contains_link_requires_review')
    official = {}
    if details:
        official = {lang: data.get('overview') for lang, data in audit.official_translations(details).items()}
    stored = {lang: isinstance((md.get('i18n') or {}).get(lang, {}).get('overview'), str)
      and bool((md.get('i18n') or {}).get(lang, {}).get('overview').strip()) for lang in LANGUAGES}
    missing_available = [lang for lang in LANGUAGES if not stored[lang] and official.get(lang)]
    return {'issues': issues, 'storedSynopsisLanguages': [l for l in LANGUAGES if stored[l]],
            'officialSynopsisLanguages': [l for l in LANGUAGES if official.get(l)],
            'missingAvailableTranslations': missing_available,
            'hasFallbackSynopsis': bool((isinstance(overview, str) and overview.strip()) or any(stored.values()))}


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
    # Include later maintenance changes without replacing the immutable input.
    current = json.loads(audit.sql("select jsonb_agg(x) from(select poster_url from selection_shared_titles "
      "where release_id='" + rows[0]['release_id'] + "' and item_type in ('movie','series'))x;"))
    urls = sorted({r['poster_url'] for r in rows + current if r['poster_url']})
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


def final_receipt(row):
    result = json.loads((ROOT / 'qualified' / receipt(row)).read_text())
    narrowed = ROOT / 'year-review' / receipt(row)
    if narrowed.exists():
        result = json.loads(narrowed.read_text())
    assert result['inputHash'] == audit.digest(row), 'Stale full inventory receipt'
    assert result.get('sourceProofVersion') == 4, 'Incomplete source review'
    return result


def includes(stored, expected):
    if isinstance(expected, dict):
        return isinstance(stored, dict) and all(includes(stored.get(k), v) for k, v in expected.items())
    return stored == expected


def ledger():
    rows = json.loads((ROOT / 'inputs.json').read_text()); output = []
    for name in ['qualified', 'years']:
        summary = json.loads((ROOT / (name + '.safe.json')).read_text())
        assert summary['allRowsExamined'] and summary['rows'] == len(rows)
    changes = json.loads((ROOT / 'reviewed-plan.json').read_text())
    applied = json.loads((ROOT / 'applied.safe.json').read_text())
    assert applied['planSha256'] == audit.digest(changes)
    current = json.loads(audit.sql("select jsonb_agg(x) from(select item_type,identity_key,title,provider_tmdb_id,poster_url,metadata "
      "from selection_shared_titles where release_id='" + rows[0]['release_id'] + "' and item_type in ('movie','series') "
      "order by item_type,identity_key)x;"))
    by_key = {(r['item_type'], r['identity_key']): r for r in current}
    assert set(by_key) == {(r['item_type'], r['identity_key']) for r in rows}, 'Inventory changed during audit'
    repairs = {(c['itemType'], c['identityKey']): c for c in changes}
    translations = ROOT / 'translations' / 'reviewed-plan.json'
    translation_changes = json.loads(translations.read_text()) if translations.exists() else []
    if translation_changes:
        receipt = json.loads((ROOT / 'translations' / 'applied.safe.json').read_text())
        assert receipt['planSha256'] == audit.digest(translation_changes)
        repairs.update({(c['itemType'], c['identityKey']): c for c in translation_changes})
    artwork_plan = ROOT / 'live-artwork' / 'reviewed-plan.json'
    artwork_changes = json.loads(artwork_plan.read_text()) if artwork_plan.exists() else []
    if artwork_changes:
        artwork_receipt = json.loads((ROOT / 'live-artwork' / 'applied.safe.json').read_text())
        assert artwork_receipt['planSha256'] == audit.digest(artwork_changes)
    restored = {(c['item_type'], c['identity_key']): c for c in artwork_changes}
    for row in rows:
        r = final_receipt(row)
        actual = by_key[(row['item_type'], row['identity_key'])]
        change = repairs.get((row['item_type'], row['identity_key']))
        artwork = restored.get((row['item_type'], row['identity_key']))
        if artwork:
            assert actual['provider_tmdb_id'] == artwork['expected_id'], 'Restored artwork identity changed'
            assert actual['poster_url'] == artwork['poster'], 'Restored artwork drift'
        if change:
            assert actual['provider_tmdb_id'] == change['tmdbId'], 'Applied identity drift'
            assert actual['poster_url'] == change['poster'], 'Applied artwork drift'
            for field in ['tmdb', 'i18n']:
                expected = change['editorial'].get(field) or {}
                stored = actual['metadata'].get(field) or {}
                assert includes(stored, expected), 'Applied editorial drift'
        poster = {'status': 'absent'}
        if actual['poster_url']:
            f = ROOT / 'artwork' / (audit.digest(actual['poster_url']) + '.json')
            if not f.exists():
                # Qualified maintenance can select a new official locale image
                # after the bulk HTTP pass. Examine the exact snapshot URL too.
                save(f, check_artwork(actual['poster_url']))
            poster = json.loads(f.read_text())
        metadata = metadata_checks(actual, r.get('details'))
        md = actual['metadata']
        output.append({'providerTitle': row['title'], 'type': row['item_type'], 'identityKey': row['identity_key'],
          'previousId': row['provider_tmdb_id'], 'currentId': actual['provider_tmdb_id'],
          'changed': bool(change or artwork), 'artworkMaintenanceRestored': bool(artwork),
          'identityStatus': r['status'], 'reason': r.get('reason'),
          'candidateIds': r.get('candidateIds'), 'confirmedId': r.get('tmdbId'), 'evidence': r.get('evidence'),
          'posterStatus': poster['status'], 'posterHttpStatus': poster.get('httpStatus'),
          'hasPoster': bool(actual['poster_url']), 'hasFallbackSynopsis': metadata['hasFallbackSynopsis'],
          'hasGenres': bool((md.get('tmdb') or {}).get('genres')), 'metadata': metadata,
          'storedSynopsisLanguages': metadata['storedSynopsisLanguages'],
          'officialSynopsisLanguages': metadata['officialSynopsisLanguages'],
          'protectedPreviousRejection': r.get('protectedPreviousRejection', False)})
    assert len(output) == len(rows) and len({(r['type'], r['identityKey']) for r in output}) == len(rows)
    save(ROOT / 'ledger.public.json', output)
    summary = {'rows': len(rows), 'allRowsExamined': True, 'byType': dict(Counter(r['type'] for r in output)),
      'identities': dict(Counter(r['identityStatus'] for r in output)), 'posters': dict(Counter(r['posterStatus'] for r in output)),
      'reasons': dict(Counter(r['reason'] for r in output if r['reason'])),
      'changed': sum(r['changed'] for r in output),
      'missing': {kind: {'poster': sum(not r['hasPoster'] for r in output if r['type'] == kind),
                         'fallbackSynopsis': sum(not r['hasFallbackSynopsis'] for r in output if r['type'] == kind),
                         'tmdbId': sum(not r['currentId'] for r in output if r['type'] == kind)} for kind in ['movie', 'series']},
      'languageCoverage': {lang: sum(lang in r['storedSynopsisLanguages'] for r in output) for lang in LANGUAGES},
      'finalDataSha256': audit.digest(current), 'planSha256': audit.digest(changes),
      'translationPlanSha256': audit.digest(translation_changes) if translation_changes else None,
      'artworkPlanSha256': audit.digest(artwork_changes) if artwork_changes else None,
      'inputSha256': audit.digest(rows), 'ledgerSha256': audit.digest(output), 'at': time.time()}
    save(ROOT / 'final-data.private.json', current)
    save(ROOT / 'ledger.safe.json', summary); print(json.dumps(summary), flush=True)


def verify_owners():
    assert json.loads((ROOT / 'ledger.safe.json').read_text())['allRowsExamined']
    owners = module('full_owner_verification', 'refresh-selection-owned-editorial-20261002.py')
    sources = json.loads(owners.sql('select jsonb_agg(s order by s.id) from (' + owners.SOURCE_SCOPE + ')s;'))
    assert sources
    def bindings():
        return json.loads(owners.sql("""with scoped as (""" + owners.SOURCE_SCOPE + """),
         m as(select v.id,v.user_id,v.source_id,v.generation_id,v.item_type,v.external_id,
           v.parent_external_id,v.playback_hint->>'targetUrl' target_url from cloud_media_items v join scoped s
           on v.user_id=s.user_id and v.source_id=s.id and v.generation_id=s.generation_id),
         v as(select v.id,v.user_id,v.source_id,v.generation_id,v.item_type,v.external_id,
           v.playback_hint->>'targetUrl' target_url from cloud_title_variants v join scoped s
           on v.user_id=s.user_id and v.source_id=s.id and v.generation_id=s.generation_id)
         select jsonb_build_object('media',md5((select string_agg(md5(to_jsonb(m)::text),'' order by user_id,id) from m)),
           'variants',md5((select string_agg(md5(to_jsonb(v)::text),'' order by user_id,id) from v)));"""))
    before = owners.immutable(); bound_before = bindings(); receipts = []; visible = []; hidden = []
    save(ROOT / 'owner-coverage-start.private.json', {'sources': sources, 'immutable': before,
      'bindingHashes': bound_before, 'verification': 'repeatable_rpc_full_rows_v1', 'at': time.time()})
    for source in sources:
        query = "set request.jwt.claim.role='service_role';select norva_get_catalog_write_snapshot('" + source['id'] + "','" + source['user_id'] + "');"
        snapshot = json.loads(owners.sql(query))
        assert snapshot.get('generationId') == source['generation_id'], 'Owner generation changed'
        (visible if snapshot.get('isCatalogVisible') is True else hidden).append(source)
    def hidden_titles_hash():
        if not hidden:
            return None
        ids = ','.join("'" + source['id'] + "'" for source in hidden)
        return owners.sql("select md5(string_agg(md5(to_jsonb(t)::text),'' order by t.user_id,t.id)) from cloud_titles t "
          "where exists(select 1 from cloud_title_variants v where v.user_id=t.user_id and v.title_id=t.id and v.source_id in (" + ids + ")); ")
    hidden_before = hidden_titles_hash()
    for source in visible:
        zeros = 0; attempts = 0
        while zeros < 2:
            # Compare full rows around each RPC in the same repeatable snapshot.
            # A fleet-wide full-row hash can change due to concurrent probes.
            def scoped_hash(table):
                return "select md5(string_agg(md5(to_jsonb(x)::text),'' order by x.id)) from " + table + " x where x.user_id='" + source['user_id'] + "' and x.source_id='" + source['id'] + "' and x.generation_id='" + source['generation_id'] + "'"
            mh = scoped_hash('cloud_media_items'); vh = scoped_hash('cloud_title_variants')
            query = "begin isolation level repeatable read;set local request.jwt.claim.role='service_role';do $verify$ declare m text;v text;r jsonb;begin "
            query += mh.replace(' from ', ' into m from ', 1) + ';' + vh.replace(' from ', ' into v from ', 1) + ';'
            query += "r:=norva_refresh_selection_owned_editorial('" + source['user_id'] + "','" + source['id'] + "','" + source['generation_id'] + "',100);"
            query += "if m is distinct from (" + mh + ") or v is distinct from (" + vh + ") then raise exception 'Owner RPC changed media or variants';end if;"
            query += "perform set_config('norva.selection_owner_audit',(r||jsonb_build_object('fullMediaAndVariantsPreserved',true))::text,true);end $verify$;select current_setting('norva.selection_owner_audit')::jsonb;commit;"
            result = json.loads(owners.sql(query))
            assert result['fullMediaAndVariantsPreserved'] is True
            attempts += 1
            receipts.append({'sourceId': source['id'], 'replay': attempts, **result})
            save(ROOT / 'owner-coverage.private.json', receipts)
            assert attempts <= 20, 'Owner reconciliation did not stabilize'
            zeros = zeros + 1 if result['updatedTitles'] == 0 else 0
    after_sources = json.loads(owners.sql('select jsonb_agg(s order by s.id) from (' + owners.SOURCE_SCOPE + ')s;'))
    after = owners.immutable()
    bound_after = bindings()
    save(ROOT / 'owner-coverage-end.private.json', {'sources': after_sources, 'immutable': after,
      'bindingHashes': bound_after, 'at': time.time()})
    assert sources == after_sources and bound_before == bound_after, 'Owner file URLs or scope changed'
    assert before['mediaCount'] == after['mediaCount'] and before['variantCount'] == after['variantCount'], 'Owner inventory count changed'
    assert hidden_before == hidden_titles_hash(), 'Hidden owner fiches changed'
    save(ROOT / 'owner-coverage.private.json', receipts)
    summary = {'sourcesWithHeads': len(sources), 'visibleSources': len(visible), 'hiddenSourcesExcluded': len(hidden),
               'zeroWriteVisits': sum(r['updatedTitles'] == 0 for r in receipts),
               'additionalReconciledTitles': sum(r['updatedTitles'] for r in receipts),
               'eachVisibleSourceReplayedTwice': True,
               'allVisibleHeadsCovered': True, 'hiddenTitlesUnchanged': True,
               'hiddenTitlesHash': hidden_before, 'immutable': before, 'immutableAfter': after,
               'fleetFullRowsUnchanged': before == after, 'playbackBindingsUnchanged': True,
               'eachTransactionPreservedFullMediaAndVariants': True,
               'bindingHashes': bound_before, 'at': time.time()}
    save(ROOT / 'owner-coverage.safe.json', summary); print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('stage', choices=['snapshot', 'sources', 'identities', 'posters', 'ledger', 'owners'])
    args = parser.parse_args()
    {'snapshot': snapshot, 'sources': source_snapshot, 'identities': identities, 'posters': posters, 'ledger': ledger, 'owners': verify_owners}[args.stage]()
