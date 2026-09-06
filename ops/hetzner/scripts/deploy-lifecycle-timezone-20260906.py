"""Apply only the reviewed dormant timezone migration after both Cloud replicas.

Run with the migration copied next to this file on the existing release host.
Refuses changed code, changed SQL or a repeated/ambiguous installation.
"""
import hashlib
import json
import os
import pathlib
import subprocess

os.umask(0o077)
root = pathlib.Path('/home/adrien/.norva/lifecycle-context-20260906-r1')
expected_cloud = 'f524d4687f40e8f1ff1815a9e38e89606ab5959e82e55acc0fec185d0b2de36f'
expected_sql = '8695b3f72227334b295fc4cd7327910be44a1aab69698cacee4585c45a8eecde'

def run(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace')[-1800:])
    return result.stdout

def sql(query):
    return run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-U',
                'supabase_admin', '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'],
               query.encode()).decode()

payload = (root / 'timezone.sql').read_bytes().replace(b'\r\n', b'\n')
assert hashlib.sha256(payload).hexdigest() == expected_sql, 'Migration drift'
assert not (root / 'timezone-functions.before.sql').exists(), 'Inspect previous attempt before retry'
for name in ['norva-edge-functions', 'norva-edge-functions-2']:
    metadata = json.loads(run(['docker', 'inspect', name]))[0]
    assert metadata['State']['Running'], 'Replica not running'
    data = run(['docker', 'exec', name, 'cat', '/home/deno/functions/norva-cloud/index.ts'])
    assert hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest() == expected_cloud, 'Cloud protocol not deployed'
before = sql("""
BEGIN READ ONLY;
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
  AND table_name='behavioral_lifecycle_user_state' AND column_name='timezone_source') THEN
  RAISE EXCEPTION 'Already installed: inspect instead of retry'; END IF;
END $guard$;
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE oid IN (
 'public.norva_register_push_token(uuid,text,text,text,text,text,text)'::regprocedure,
 'public.norva_seed_behavioral_lifecycle_jobs(integer)'::regprocedure,
 'public.norva_behavioral_delivery_eligible(uuid,timestamptz)'::regprocedure);
ROLLBACK;
""")
# psql -q excludes transaction status lines from the rollback artifact.
definitions = '\n'.join(line for line in before.splitlines() if line not in ('BEGIN','DO','ROLLBACK'))
with (root / 'timezone-functions.before.sql').open('x') as backup:
    backup.write('BEGIN;\n' + definitions + '\nCOMMIT;\n')
result = sql(payload.decode())
assert 'COMMIT' in result.splitlines(), 'Commit acknowledgement missing: inspect before retry'
sql("NOTIFY pgrst, 'reload schema';")
print(json.dumps({'timezoneMigrationCommitted': True, 'sqlSha256': expected_sql,
                  'rollbackFunctions': str(root / 'timezone-functions.before.sql'),
                  'marketingActivated': False, 'operatorEmailSent': False}))
