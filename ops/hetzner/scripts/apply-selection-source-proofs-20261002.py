"""Plan reviewed source proofs; apply through the exact public CAS writer.

Proof receipts and input hashes are immutable. The installed evidence contract
must pass isolated SQL tests first. Owner refresh reuses the existing bounded
maintenance, without modifying files, access rights, sources or private fields.
"""
import argparse
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import json
import time


def module(name, file):
    spec = spec_from_file_location(name, Path(__file__).with_name(file))
    m = module_from_spec(spec); spec.loader.exec_module(m)
    return m


units = module('source_apply_units', 'prove-selection-source-units-20261002.py')
audit = units.audit; ROOT = units.ROOT
repair = module('source_apply_repair', 'repair-selection-editorial-20261002.py')
previous = module('source_apply_previous', 'apply-selection-remainder-20261002.py')


def plan():
    rows = json.loads((ROOT / 'source-units-inputs.json').read_text())
    duration = {r['inputHash']: r['result'] for f in (ROOT / 'media-duration').glob('*.json')
                for r in [json.loads(f.read_text())] if r['resolved']}
    changes = []; skips = {}
    for row in rows:
        r = json.loads((ROOT / 'unit-results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')).read_text())
        r = duration.get(audit.digest(row), r)
        assert r['inputHash'] == audit.digest(row), 'Stale source proof'
        if r['status'] not in ['matched', 'verified_existing']:
            reason = r.get('reason') or 'unresolved'; skips[reason] = skips.get(reason, 0) + 1
            continue
        if r['tmdbId'] in ((row['metadata'].get('tmdbSearchReview') or {}).get('rejectedTmdbIds') or []):
            skips['previously_rejected_needs_separate_review'] = skips.get('previously_rejected_needs_separate_review', 0) + 1
            continue
        change = repair.build_change(row, r)
        md = row['metadata']; old_plot = (md.get('tmdb') or {}).get('overview') or md.get('overview') or md.get('plot')
        if not (row['provider_tmdb_id'] != change['tmdbId'] or not row['poster_url'] and change['poster']
                or not old_plot and change['editorial']['tmdb'].get('overview')):
            skips['verified_but_official_metadata_absent'] = skips.get('verified_but_official_metadata_absent', 0) + 1
            continue
        if change['evidence'] in ['source_media_year_alias', 'source_series_season_alias']:
            change['sourceUnits'] = r['unitProof']
            if change['evidence'] == 'source_series_season_alias':
                change['officialSeasons'] = [{'season_number': s['season_number'], 'air_date': s.get('air_date')}
                                            for s in r['details'].get('seasons') or []]
        if change['evidence'] == 'source_alias_file_duration':
            change.update({'sourceTitleLabel': row['title'], 'expectedTargetUrl': r['expectedTargetUrl'],
                           'fileDurationSeconds': r['durationProof']['seconds']})
        if change['evidence'] == 'source_image_filename_exact_alias':
            change.update({'expectedManifestPoster': row['manifest_poster'],
                           'sourceImageLabel': next(v for k, v in r['aliasProof'] if k == 'image_filename')})
        change.update({'releaseId': row['release_id'], 'manifestSha256': row['manifest_sha256']})
        changes.append(change)
    assert len(changes) <= 100, 'Bounded source proof apply required'
    summary = {'changes': len(changes), 'newOrCorrectedIds': sum(c['tmdbId'] != c['expectedId'] for c in changes),
               'newPosters': sum(not c['expectedPoster'] and bool(c['poster']) for c in changes), 'skips': skips,
               'inputSha256': audit.digest(rows), 'planSha256': audit.digest(changes)}
    return changes, summary


def main():
    global ROOT
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true')
    parser.add_argument('--refresh-owners', action='store_true')
    parser.add_argument('--year-narrow', action='store_true'); args = parser.parse_args()
    if args.year_narrow:
        ROOT = ROOT / 'year-narrow'
    if args.refresh_owners:
        refresh_owners(); return
    changes, summary = plan(); print(json.dumps(summary), flush=True)
    f = ROOT / 'reviewed-plan.json'
    if f.exists():
        assert audit.digest(json.loads(f.read_text())) == audit.digest(changes), 'Reviewed plan changed'
    else:
        f.write_text(json.dumps(changes, ensure_ascii=False)); f.chmod(0o600)
    (ROOT / 'plan.safe.json').write_text(json.dumps(summary, indent=2))
    if not args.apply:
        return
    assert changes and json.loads((ROOT / 'sql-proof.safe.json').read_text())['passed']
    assert not (ROOT / 'applied.safe.json').exists(), 'Already applied'
    assert 'source_series_season_alias' in audit.sql("select pg_get_functiondef('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)'::regprocedure);")
    backup = ROOT / 'before-apply'; backup.mkdir(mode=0o700, exist_ok=False)
    before = repair.immutable()
    for name, q in [
      ('public-titles.jsonl', 'select to_jsonb(t) from selection_shared_titles t order by release_id,item_type,identity_key;'),
      ('catalog-titles.jsonl', "select to_jsonb(t) from catalog_titles t where provider_tmdb_id in (" + ','.join("'" + x['tmdbId'] + "'" for x in changes) + ');'),
      ('writer.sql', "select pg_get_functiondef('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)'::regprocedure);")]:
        f = backup / name; f.write_text(audit.sql(q) + '\n'); f.chmod(0o600)
    receipts = []
    for offset in range(0, len(changes), 25):
        batch = changes[offset:offset + 25]
        assert len({c['releaseId'] for c in batch}) == len({c['manifestSha256'] for c in batch}) == 1
        payload = json.dumps(batch, ensure_ascii=False).replace("'", "''")
        r = json.loads(audit.sql("set request.jwt.claim.role='service_role';set lock_timeout='3s';select public.norva_apply_selection_editorial_audit('"
          + batch[0]['releaseId'] + "','" + batch[0]['manifestSha256'] + "','" + payload + "'::jsonb);"))
        receipts.append(r); (ROOT / 'apply-progress.safe.json').write_text(json.dumps(receipts, indent=2))
        print(json.dumps({'offset': offset, **r}), flush=True)
    assert before == repair.immutable(), 'Shared files, variants or release changed'
    summary.update({'receipts': receipts, 'immutable': before, 'at': time.time()})
    (ROOT / 'applied.safe.json').write_text(json.dumps(summary, indent=2))


def refresh_owners():
    assert (ROOT / 'applied.safe.json').exists(), 'Apply public corrections first'
    assert not (ROOT / 'owners.safe.json').exists(), 'Use completed owner receipt'
    owners = module('source_owners', 'refresh-selection-owned-editorial-20261002.py')
    count = int(owners.sql('select count(*) from (' + owners.SOURCE_SCOPE + ')s;'))
    assert 0 < count <= 100, 'Bounded owner pass required'
    backup = ROOT / 'before-owner-refresh.jsonl'
    before_file = ROOT / 'before-owner-immutable.json'
    if not backup.exists():
        q = 'select to_jsonb(t) from cloud_titles t where exists(select 1 from (' + owners.SOURCE_SCOPE + ')s join cloud_title_variants v on v.user_id=s.user_id and v.source_id=s.id and v.generation_id=s.generation_id where v.user_id=t.user_id and v.title_id=t.id) order by t.user_id,t.id;'
        backup.write_text(owners.sql(q) + '\n'); backup.chmod(0o600)
    if not before_file.exists():
        before_file.write_text(json.dumps(owners.immutable())); before_file.chmod(0o600)
    before = json.loads(before_file.read_text())
    progress = ROOT / 'owners-progress.safe.json'
    receipts = json.loads(progress.read_text()) if progress.exists() else []
    zeros = 0
    for r in receipts:
        zeros = zeros + r['sources'] if r['updatedTitles'] == 0 else 0
    busy = 0
    for i in range(200):
        r = json.loads(owners.sql("set request.jwt.claim.role='service_role';select public.norva_refresh_selection_owned_editorial_all(100,10);"))
        if r.get('busy'):
            busy += 1; assert busy <= 10, 'Maintenance remains busy; resume this operator later'
            time.sleep(2); continue
        busy = 0; receipts.append(r)
        progress.write_text(json.dumps(receipts, indent=2))
        print(json.dumps({'pass': len(receipts), **r}), flush=True)
        # Hidden/skipped heads are not successful coverage of an active owner.
        zeros = zeros + r['sources'] if r['updatedTitles'] == 0 else 0
        if zeros >= 2 * count:
            break
    assert zeros >= 2 * count, 'Owner refresh still pending; resume from cursor and receipts'
    after = owners.immutable(); assert before == after, 'Owner files or variants changed during refresh'
    summary = {'sources': count, 'updatedTitles': sum(r['updatedTitles'] for r in receipts),
               'zeroWriteCoverage': zeros, 'immutable': after, 'receipts': receipts, 'at': time.time()}
    (ROOT / 'owners.safe.json').write_text(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
