"""Apply only reviewed, useful follow-up changes through the existing CAS RPC.

The plan is the default. --apply requires the isolated SQL proof, creates fresh
private backups, installs the bounded evidence migration and preserves file and
release hashes. Media evidence and full audit receipts remain on the DB host.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import time


def module(name, filename):
    s = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    return m


audit = module('remainder_apply_audit', 'audit-selection-tmdb-20261002.py')
repair = module('remainder_apply_repair', 'repair-selection-editorial-20261002.py')
ROOT = audit.ROOT / 'remainder'
RESULTS = ROOT / 'review-v2'
MIGRATION = '20261002183000_selection_image_filename_evidence.sql'


def plan():
    rows = json.loads((ROOT / 'inputs.json').read_text())
    durations = {x['inputHash']: x['result'] for f in (RESULTS / 'duration').glob('*.json')
                 for x in [json.loads(f.read_text())] if x['resolved']}
    changes, skips = [], {}
    for row in rows:
        result = json.loads((RESULTS / 'results' / (audit.digest([row['item_type'], row['identity_key']]) + '.json')).read_text())
        result = durations.get(audit.digest(row), result)
        assert result['inputHash'] == audit.digest(row), 'Stale receipt'
        if result['status'] not in ['matched', 'verified_existing']:
            skips[result.get('reason', 'unresolved')] = skips.get(result.get('reason', 'unresolved'), 0) + 1
            continue
        rejected = (row['metadata'].get('tmdbSearchReview') or {}).get('rejectedTmdbIds') or []
        if result['tmdbId'] in rejected:
            skips['requires_separate_rejected_id_review'] = skips.get('requires_separate_rejected_id_review', 0) + 1
            continue
        change = repair.build_change(row, result)
        old_plot = (row['metadata'].get('tmdb') or {}).get('overview') or row['metadata'].get('overview') or row['metadata'].get('plot')
        useful = row['provider_tmdb_id'] != change['tmdbId'] or (not row['poster_url'] and change['poster']) \
          or (not old_plot and change['editorial']['tmdb'].get('overview'))
        if not useful:
            skips['official_metadata_still_absent'] = skips.get('official_metadata_still_absent', 0) + 1
            continue
        if change['evidence'] == 'source_image_filename_exact_alias':
            change.update({'expectedManifestPoster': row['manifest_poster'],
              'sourceImageLabel': next(v for k, v in result['aliasProof'] if k == 'image_filename')})
        if change['evidence'] == 'source_title_prefix_file_duration':
            change.update({'expectedTargetUrl': result['expectedTargetUrl'],
              'fileDurationSeconds': result['durationProof']['seconds'], 'sourceTitleLabel': row['title']})
        change['releaseId'] = row['release_id']; change['manifestSha256'] = row['manifest_sha256']
        changes.append(change)
    assert len(changes) <= 100, 'Bounded reviewed pass required'
    summary = {'changes': len(changes), 'newOrCorrectedIds': sum(x['expectedId'] != x['tmdbId'] for x in changes),
      'newPosters': sum(not x['expectedPoster'] and bool(x['poster']) for x in changes),
      'skips': skips, 'planSha256': audit.digest(changes), 'inputSha256': audit.digest(rows)}
    return changes, summary


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true')
    parser.add_argument('--refresh-owners', action='store_true'); args = parser.parse_args()
    if args.refresh_owners:
        refresh_owners()
        return
    changes, summary = plan()
    print(json.dumps(summary), flush=True)
    plan_file = ROOT / 'reviewed-plan.json'
    if plan_file.exists():
        assert audit.digest(json.loads(plan_file.read_text())) == audit.digest(changes), 'Reviewed plan changed'
    else:
        plan_file.write_text(json.dumps(changes, ensure_ascii=False)); plan_file.chmod(0o600)
    (ROOT / 'plan.safe.json').write_text(json.dumps(summary, indent=2))
    if not args.apply:
        return
    assert changes and json.loads((ROOT / 'sql-proof.safe.json').read_text())['passed']
    assert not (ROOT / 'applied.safe.json').exists(), 'Already applied'
    backup = ROOT / 'before-reviewed-apply'; backup.mkdir(mode=0o700, exist_ok=False)
    before = repair.immutable()
    for name, query in [
      ('public-titles.jsonl', 'select to_jsonb(t) from selection_shared_titles t order by release_id,item_type,identity_key;'),
      ('catalog-titles.jsonl', "select to_jsonb(t) from catalog_titles t where provider_tmdb_id in (" + ','.join("'" + x['tmdbId'] + "'" for x in changes) + ');'),
      ('writer.sql', "select pg_get_functiondef('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)'::regprocedure);")]:
        f = backup / name; f.write_text(audit.sql(query) + '\n'); f.chmod(0o600)
    migration = (ROOT / MIGRATION).read_text(encoding='utf-8-sig')
    audit.sql(migration)
    receipts = []
    for offset in range(0, len(changes), 25):
        batch = changes[offset:offset + 25]
        assert len({x['releaseId'] for x in batch}) == 1 and len({x['manifestSha256'] for x in batch}) == 1
        payload = json.dumps(batch, ensure_ascii=False).replace("'", "''")
        receipt = json.loads(audit.sql("set request.jwt.claim.role='service_role';set lock_timeout='3s';select public.norva_apply_selection_editorial_audit('"
          + batch[0]['releaseId'] + "','" + batch[0]['manifestSha256'] + "','" + payload + "'::jsonb);"))
        receipts.append(receipt)
        (ROOT / 'apply-progress.safe.json').write_text(json.dumps(receipts, indent=2))
        print(json.dumps({'offset': offset, **receipt}), flush=True)
    assert before == repair.immutable(), 'File variants or release changed during editorial apply'
    summary.update({'receipts': receipts, 'immutable': before, 'at': time.time()})
    (ROOT / 'applied.safe.json').write_text(json.dumps(summary, indent=2))


def refresh_owners():
    assert (ROOT / 'applied.safe.json').exists(), 'Apply public corrections first'
    assert not (ROOT / 'owners.safe.json').exists(), 'Use completed owner receipt'
    owners = module('remainder_owners', 'refresh-selection-owned-editorial-20261002.py')
    count = int(owners.sql('select count(*) from (' + owners.SOURCE_SCOPE + ')s;'))
    assert count <= 100, 'Bounded owner pass required'
    backup = ROOT / 'before-owner-refresh.jsonl'; assert not backup.exists(), 'Interrupted owner pass needs review'
    q = 'select to_jsonb(t) from cloud_titles t where exists(select 1 from (' + owners.SOURCE_SCOPE + ')s join cloud_title_variants v on v.user_id=s.user_id and v.source_id=s.id and v.generation_id=s.generation_id where v.user_id=t.user_id and v.title_id=t.id) order by t.user_id,t.id;'
    backup.write_text(owners.sql(q) + '\n'); backup.chmod(0o600)
    before = owners.immutable(); receipts = []; zeros = 0
    for i in range(200):
        r = json.loads(owners.sql("set request.jwt.claim.role='service_role';select public.norva_refresh_selection_owned_editorial_all(100,10);"))
        assert not r.get('busy'), 'Another maintenance pass is active'
        receipts.append(r)
        (ROOT / 'owners-progress.safe.json').write_text(json.dumps(receipts, indent=2))
        print(json.dumps({'pass': i+1, **r}), flush=True)
        zeros = zeros + r['sources'] + r['hiddenOrChanged'] if r['updatedTitles'] == 0 else 0
        if zeros >= 2 * count:
            break
    assert zeros >= 2 * count, 'Owner refresh still pending'
    after = owners.immutable(); assert before == after, 'Owner files or variants changed during refresh'
    summary = {'sources': count, 'updatedTitles': sum(r['updatedTitles'] for r in receipts),
               'zeroWriteCoverage': zeros, 'immutable': after, 'receipts': receipts, 'at': time.time()}
    (ROOT / 'owners.safe.json').write_text(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
