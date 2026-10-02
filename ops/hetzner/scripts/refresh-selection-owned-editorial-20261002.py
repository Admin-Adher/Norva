"""Deploy the bounded legacy Selection refresh and reconcile existing owners.

Run on the DB host after the rollback SQL proof. Public catalogue receipts stay
separate from the owner backup (mode 0600). No imports, media or variants change.
The default invocation is read-only; --apply installs the reviewed migration,
backfills until two complete zero-write passes, then enables bounded maintenance.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path('/home/adrien/.norva/selection-tmdb-audit-20261002')
MIGRATION = '20261002173000_selection_owned_editorial_refresh.sql'
SOURCE_SCOPE = """select s.id,s.user_id,h.active_generation_id generation_id
 from public.cloud_sources s join public.cloud_source_catalog_heads h
 on h.source_id=s.id and h.user_id=s.user_id
 where s.enabled and s.source_type='m3u' and h.active_generation_id is not null
 and public.norva_selection_source_identity_valid(s.id,s.user_id)"""


def sql(query, timeout=60):
    p = subprocess.run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
                        '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
                       input="set statement_timeout='45s';set lock_timeout='3s';" + query,
                       text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stderr[-1800:])
    return p.stdout.strip()


def immutable():
    return json.loads(sql("""with scoped as (""" + SOURCE_SCOPE + """), m as (
     select distinct v.* from scoped s join public.cloud_media_items v
      on v.user_id=s.user_id and v.source_id=s.id and v.generation_id=s.generation_id
    ), v as (select distinct v.* from scoped s join public.cloud_title_variants v
      on v.user_id=s.user_id and v.source_id=s.id and v.generation_id=s.generation_id)
    select jsonb_build_object('mediaCount',(select count(*) from m),
      'mediaHash',(select md5(string_agg(md5(to_jsonb(m)::text),'' order by user_id,id)) from m),
      'variantCount',(select count(*) from v),
      'variantHash',(select md5(string_agg(md5(to_jsonb(v)::text),'' order by user_id,id)) from v));"""))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    total = int(sql('select count(*) from (' + SOURCE_SCOPE + ') s;'))
    migration = (ROOT / MIGRATION).read_text(encoding='utf-8-sig')
    installed = sql("select to_regprocedure('public.norva_refresh_selection_owned_editorial_all(int,int)') is not null;") == 't'
    summary = {'apply': args.apply, 'canonicalActiveHeads': total, 'alreadyInstalled': installed,
               'migrationSha256': hashlib.sha256(migration.encode()).hexdigest()}
    print(json.dumps(summary), flush=True)
    if not args.apply:
        return
    assert total <= 100, 'One proof pass must cover every eligible source'
    assert not (ROOT / 'owned-refresh.safe.json').exists(), 'Completed receipt exists'
    backup = ROOT / 'before-owned-refresh'; backup.mkdir(mode=0o700, exist_ok=False)
    rows = sql('select to_jsonb(t) from public.cloud_titles t where exists(select 1 from ('
               + SOURCE_SCOPE + ') s join public.cloud_title_variants v on v.user_id=s.user_id '
               'and v.source_id=s.id and v.generation_id=s.generation_id where v.user_id=t.user_id '
               'and v.title_id=t.id) order by t.user_id,t.id;')
    (backup / 'owned-titles.private.jsonl').write_text(rows + '\n')
    (backup / 'owned-titles.private.jsonl').chmod(0o600)
    mirror = sql("select pg_get_functiondef('public.cloud_titles_mirror_to_catalog()'::regprocedure);")
    (backup / 'mirror.sql').write_text(mirror)
    before = immutable()
    if not installed:
        sql(migration)
    receipts, zeros = [], 0
    for iteration in range(40):
        began = time.monotonic()
        receipt = json.loads(sql("set request.jwt.claim.role='service_role';select public.norva_refresh_selection_owned_editorial_all(100,100);"))
        assert not receipt.get('busy'), 'A running maintenance pass needs review'
        receipt['seconds'] = round(time.monotonic() - began, 3)
        receipts.append(receipt)
        (ROOT / 'owned-refresh-progress.safe.json').write_text(json.dumps(receipts, indent=2))
        print(json.dumps({'pass': iteration + 1, **receipt}), flush=True)
        zeros = zeros + 1 if receipt['updatedTitles'] == 0 else 0
        if zeros == 2:
            break
    assert zeros == 2, 'Still pending; maintenance not enabled'
    after = immutable()
    assert after == before, 'Owner media/variants changed during refresh'
    assert sql("select count(*) from cron.job where jobname='norva-selection-owned-editorial-refresh';") == '0', 'Existing job needs review'
    # Role claim is explicit, matching the service-only RPC. Round-robin cursors
    # let 20-source bounded jobs eventually visit every owner without starvation.
    job = int(sql("""select cron.schedule('norva-selection-owned-editorial-refresh','7-59/15 * * * *',
      $$set statement_timeout='30s';set lock_timeout='3s';set request.jwt.claim.role='service_role';
      select public.norva_refresh_selection_owned_editorial_all(100,20);$$);"""))
    summary.update({'finishedAt': time.time(), 'receipts': receipts,
                    'updatedTitles': sum(r['updatedTitles'] for r in receipts),
                    'unchangedReplay': True, 'immutable': after, 'cronJobId': job})
    (ROOT / 'owned-refresh.safe.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != 'receipts'}), flush=True)


if __name__ == '__main__':
    main()
