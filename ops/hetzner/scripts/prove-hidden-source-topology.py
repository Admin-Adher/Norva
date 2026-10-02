"""Exercise the real topology trigger on synthetic rows in a networkless clone."""
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path('/home/adrien/.norva/wal-audit-20261002')
NAME = 'norva-hidden-source-topology-proof-20261002'


def cmd(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=120)
    if result.returncode:
        (ROOT / 'hidden-source-proof-error.txt').write_text(result.stderr)
        raise RuntimeError(result.stderr[-1800:])
    return result.stdout


def sql(query):
    return cmd(['docker', 'exec', '-i', NAME, 'psql', '-h', '/tmp', '-U', 'postgres',
                '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], query).strip()


def housekeeping():
    sql("select public.test_reset_source('purge_pending','hidden',true,null);")
    sql("""update public.cloud_source_lifecycle set lifecycle_state='purged'
       where source_id='10000000-0000-0000-0000-000000000001';
       update public.cloud_sources set enabled=false
       where id='10000000-0000-0000-0000-000000000001';""")
    return json.loads(sql("""select json_build_object('invalidations',(select count(*) from public.test_stale_events),
      'snapshot_state',(select state from public.test_owner_snapshots where user_id='20000000-0000-0000-0000-000000000001'),
      'other_owner_revision',(select revision from public.test_owner_snapshots where user_id='20000000-0000-0000-0000-000000000002'));"""))


def main():
    assert NAME not in cmd(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
    cmd(['docker', 'run', '-d', '--name', NAME, '--label', 'norva.purpose=hidden-source-topology-proof',
         '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
         '--tmpfs', '/tmp:rw,nosuid,size=384m,mode=1777', '--user', 'postgres',
         '--entrypoint', '/bin/sh', 'supabase/postgres:17.6.1.136', '-c',
         "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB -c wal_compression=zstd"])
    for _ in range(30):
        if subprocess.run(['docker', 'exec', NAME, 'pg_isready', '-h', '/tmp'], capture_output=True).returncode == 0:
            break
        time.sleep(1)
    baseline_source = (ROOT / '20260823182730_catalog_background_owner_snapshot_sync.sql').read_text()
    start = baseline_source.index('create or replace function public.norva_catalog_background_owner_topology_guard(')
    end = baseline_source.index('$function$;', start) + len('$function$;')
    baseline = baseline_source[start:end]
    sql(baseline)
    sql((ROOT / 'catalog-hidden-source-topology.fixture.sql').read_text())
    before = housekeeping()
    sql((ROOT / '20261002120000_catalog_hidden_source_topology_noop.sql').read_text())
    after = housekeeping()
    assert before['invalidations'] == 2 and before['snapshot_state'] == 'stale'
    assert after['invalidations'] == 0 and after['snapshot_state'] == 'active'
    sql((ROOT / 'catalog-hidden-source-topology.assertions.sql').read_text())
    result = {'before': before, 'after': after, 'matrix_cases': 96,
              'checks': ['owner_isolation', 'credential_cutover_fence', 'provider_access', 'insert_delete'],
              'production_rows_copied': 0, 'production_writes': 0}
    (ROOT / 'hidden-source-proof-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    state = json.loads(cmd(['docker', 'inspect', NAME]))[0]
    assert state['HostConfig']['NetworkMode'] == 'none'
    assert state['Config']['Labels']['norva.purpose'] == 'hidden-source-topology-proof'
    cmd(['docker', 'rm', '-f', NAME])


if __name__ == '__main__':
    main()
