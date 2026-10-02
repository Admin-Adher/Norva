"""Bounded synthetic WAL regression proof in a disposable, networkless cluster."""
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path('/home/adrien/.norva/wal-audit-20261002')
NAME = 'norva-owner-noop-wal-proof-20261002'


def cmd(args, data=None):
    r = subprocess.run(args, input=data, text=True, capture_output=True, timeout=120)
    if r.returncode:
        (ROOT / 'proof-error.txt').write_text(r.stderr)
        raise RuntimeError(r.stderr[-1200:])
    return r.stdout


def sql(query):
    return cmd(['docker', 'exec', '-i', NAME, 'psql', '-h', '/tmp', '-U', 'postgres',
                '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], query).strip()


def benchmark():
    sql('checkpoint;')
    before = sql('select pg_current_wal_insert_lsn();')
    started = time.monotonic()
    sql("""do $$begin for i in 1..300 loop
      perform public.norva_sync_catalog_background_owner_title(
       '20000000-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000001');
      end loop; end$$;""")
    return {'calls': 300, 'seconds': round(time.monotonic() - started, 3),
            'wal_bytes': int(sql("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'" + before + "')::bigint;"))}


def main():
    assert NAME not in cmd(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
    cmd(['docker', 'run', '-d', '--name', NAME, '--label', 'norva.purpose=owner-noop-wal-proof',
         '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
         '--tmpfs', '/tmp:rw,nosuid,size=384m,mode=1777', '--user', 'postgres',
         '--entrypoint', '/bin/sh', 'supabase/postgres:17.6.1.136', '-c',
         "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB -c wal_compression=zstd"])
    for _ in range(30):
        if subprocess.run(['docker', 'exec', NAME, 'pg_isready', '-h', '/tmp'], capture_output=True).returncode == 0:
            break
        time.sleep(1)
    old = cmd(['docker', 'exec', 'norva-db', 'psql', '-X', '-qAt', '-U', 'supabase_admin',
               '-d', 'postgres', '-c', "select pg_get_functiondef('public.norva_sync_catalog_background_owner_title(uuid,uuid)'::regprocedure);"])
    (ROOT / 'owner-sync-production-before.sql').write_text(old)
    sql((ROOT / 'catalog-owner-noop-writes.fixture.sql').read_text())
    sql((ROOT / '20260825050000_catalog_background_owner_row_count.sql').read_text())
    sql(old)
    sql('select public.norva_sync_catalog_background_owner_title(user_id,id) from public.cloud_titles;')
    baseline = benchmark()
    sql((ROOT / '20261002083000_catalog_owner_noop_writes.sql').read_text())
    improved = benchmark()
    assert improved['wal_bytes'] < baseline['wal_bytes'] * 0.2, (baseline, improved)
    assertions = sql((ROOT / 'catalog-owner-noop-writes.assertions.sql').read_text())
    assert 'OWNER_NOOP_ASSERTIONS_OK' in assertions
    result = {'before': baseline, 'after': improved, 'assertions': 'passed',
              'production_rows_copied': 0, 'production_writes': 0}
    (ROOT / 'proof-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
    state = json.loads(cmd(['docker', 'inspect', NAME]))[0]
    assert state['HostConfig']['NetworkMode'] == 'none'
    assert state['Config']['Labels']['norva.purpose'] == 'owner-noop-wal-proof'
    cmd(['docker', 'rm', '-f', NAME])


if __name__ == '__main__':
    main()
