"""Bounded PostgreSQL proof, run by the operator over SSH stdin.

PAYLOAD is base64 JSON {migration, fixture}. The only production calls read the
procedure definition and column types. The real procedure runs exclusively in
a new networkless database with synthetic rows; no provider request is made.
FK/trigger authority is not reimplemented: exact body equality proves the
migration changes only the import guard, while SQL checks its branch behavior.
"""
import base64
import hashlib
import json
import re
import subprocess
import time

payload = json.loads(base64.b64decode(PAYLOAD))
name = 'norva-source-reaper-enabled-proof-20260930'
image = 'supabase/postgres:17.6.1.136'
database = 'norva_source_reaper_proof'


def run(args, content=None, check=True, timeout=45):
    result = subprocess.run(args, input=content, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result


def production_read(sql):
    return run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At',
                '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
               "begin read only; set local statement_timeout='10s';\n" + sql + '\nrollback;').stdout.strip()


def proof_sql(sql, check=True):
    return run(['docker', 'exec', '-i', name, 'psql', '-X', '-q', '-At', '-h', '/tmp',
                '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], sql, check)


definition_query = "select pg_get_functiondef('public.reap_deleted_sources()'::regprocedure);"
live_definition = production_read(definition_query).replace('\r\n', '\n')
old_guard = """  if exists (
    select 1 from public.cloud_sources
    where sync_status = 'syncing' and deleted_at is null
  ) then
    return;
  end if;"""
new_guard = old_guard.replace('deleted_at is null', 'deleted_at is null and enabled')
if live_definition.count(old_guard) == 1 and new_guard not in live_definition:
    original = live_definition
elif live_definition.count(new_guard) == 1 and old_guard not in live_definition:
    # Reconstruct only the previous guard inside the disposable database so
    # this same regression proof remains runnable after production deployment.
    original = live_definition.replace(new_guard, old_guard)
else:
    raise AssertionError('Unknown live reaper guard; refusing fixture reconstruction')
expected = original.replace(old_guard, new_guard)

# Copy types only for relations referenced by the actual reaper. Tables have no
# rows, defaults, triggers or workers, and all SQL is isolated by database name.
names = sorted(set(re.findall(r'public\.([a-z_]+)', original)))
assert all(re.fullmatch('[a-z_]+', value) for value in names)
name_sql = ','.join("'" + value + "'" for value in names)
schema = production_read("""
select string_agg(ddl,E'\n' order by relation_name) from (
  select c.relname relation_name,'create table public.'||quote_ident(c.relname)||' ('||
    string_agg(quote_ident(a.attname)||' '||format_type(a.atttypid,a.atttypmod),',' order by a.attnum)||');' ddl
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  where n.nspname='public' and c.relkind in ('r','p') and c.relname in (""" + name_sql + """)
  group by c.relname
) definitions;""")
assert schema.startswith('create table public.') and 'cloud_sources' in schema
assert name not in run(['docker', 'ps', '-a', '--format', '{{.Names}}']).stdout.splitlines()
run(['docker', 'image', 'inspect', image])
created = False
try:
    run(['docker', 'run', '-d', '--name', name,
         '--label', 'norva.purpose=source-reaper-enabled-synthetic-proof',
         '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
         '--tmpfs', '/tmp:rw,nosuid,size=384m,mode=1777', '--user', 'postgres',
         '--entrypoint', '/bin/sh', image, '-c',
         "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && "
         "exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
    created = True
    for attempt in range(25):
        if run(['docker', 'exec', name, 'pg_isready', '-h', '/tmp', '-U', 'postgres'], check=False).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Disposable PostgreSQL not ready')
    run(['docker', 'exec', name, 'createdb', '-h', '/tmp', '-U', 'postgres', database])
    proof_sql(schema + """
create function public.norva_recover_source_delete_cleanups(integer) returns integer
language sql as 'select 0';
create function public.norva_run_replacement_cleanup_batch(text,integer) returns jsonb
language sql as 'select jsonb_build_object(''claimed'',false)';
""" + original)
    fixture = payload['fixture'].replace('\r\n', '\n')
    prefix = "set norva.disposable_reaper_proof='on';\n"
    baseline = proof_sql(prefix + "set norva.reaper_expected_legacy='on';\n" + fixture)
    assert 'PASS legacy disabled syncing source prevents cleanup' in baseline.stderr
    print(json.dumps({'proof': 'legacy-reproduction', 'passed': True}), flush=True)

    migration = payload['migration'].replace('\r\n', '\n')
    proof_sql(migration)
    actual = proof_sql(definition_query).stdout.strip()
    assert actual == expected, 'Migration changed more than the import guard'
    proof_sql(migration)
    assert proof_sql(definition_query).stdout.strip() == expected, 'Second application changed the procedure'
    print(json.dumps({'proof': 'exact-body-change-and-idempotence', 'passed': True,
                      'before_sha256': hashlib.sha256(original.encode()).hexdigest(),
                      'after_sha256': hashlib.sha256(expected.encode()).hexdigest()}), flush=True)
    result = proof_sql(prefix + fixture)
    passed = re.findall(r'NOTICE:\s+(PASS .*)', result.stderr)
    assert len(passed) == 10, (len(passed), result.stderr)
    print(json.dumps({'proof': 'runtime-scenarios', 'passed': passed}), flush=True)

    for case, drifted in [
        ('missing-guard', original.replace(old_guard, old_guard.replace("= 'syncing'", "in ('syncing','error')"))),
        ('duplicate-guard', original.replace(old_guard, old_guard+'\n'+old_guard)),
        ('mixed-old-new-guard', original.replace(old_guard, old_guard+'\n'+new_guard)),
    ]:
        proof_sql(drifted)
        before = proof_sql(definition_query).stdout.strip()
        failed = proof_sql(migration, check=False)
        assert failed.returncode != 0 and 'enabled-import guard precondition drifted' in failed.stderr
        assert proof_sql(definition_query).stdout.strip() == before
        print(json.dumps({'proof': case+'-refused-without-change', 'passed': True}), flush=True)
    proof_sql(expected)
    assert production_read(definition_query).replace('\r\n', '\n') == live_definition
    print(json.dumps({'productionProcedureUnchanged': True, 'productionRowsModified': False}), flush=True)
finally:
    if created:
        metadata = json.loads(run(['docker', 'inspect', name]).stdout)[0]
        assert metadata['Config']['Labels']['norva.purpose'] == 'source-reaper-enabled-synthetic-proof'
        assert metadata['HostConfig']['NetworkMode'] == 'none'
        run(['docker', 'rm', '-f', name])
        print(json.dumps({'disposableContainerRemoved': name}), flush=True)
