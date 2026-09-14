"""Schema-only production copy -> new networkless PostgreSQL, synthetic tests.

Never reads user rows, opens provider connections or writes the production DB.
Artifacts/errors stay private. The proof container is retained for inspection.
"""
import json, os, pathlib, subprocess, sys, time

ROOT = pathlib.Path('/home/adrien/.norva/unknown-first-language-pipeline-20260914')
NAME = 'norva-unknown-first-language-proof-20260914'
MIGRATIONS = ['20260914133000_unknown_first_language_intake.sql', '20260914134000_owned_provider_stream_languages.sql', '20260914135000_unknown_series_metadata_refresh.sql']

def run(args, data=None, timeout=90):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        (ROOT/'proof-error.private.txt').write_bytes(result.stderr)
        raise RuntimeError('proof_command_failed')
    return result.stdout

def sql(text):
    return run(['docker','exec','-i',NAME,'psql','-h','/tmp','-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],text.encode()).decode()

def main():
    os.umask(0o077)
    assert ROOT.is_dir() and not ROOT.is_symlink()
    mode=sys.argv[1] if len(sys.argv)>1 else ''
    if mode=='create':
        assert NAME not in run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
        roles=run(['docker','exec','norva-db','psql','-X','-qAt','-U','postgres','-c',
            "SELECT 'CREATE ROLE '||quote_ident(rolname)||';' FROM pg_roles WHERE rolname<>'postgres' AND rolname NOT LIKE 'pg_%'"])
        schema=run(['docker','exec','norva-db','pg_dump','-U','postgres','-d','postgres','--schema-only','--no-owner','--no-privileges'],timeout=120)
        (ROOT/'schema.private.sql').write_bytes(schema)
        run(['docker','run','-d','--name',NAME,'--label','norva.purpose=unknown-first-language-proof-20260914',
            '--network','none','--memory','768m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=512m,mode=1777',
            '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB -c shared_preload_libraries=pg_cron,pg_net,pg_stat_statements"])
        for _ in range(30):
            if subprocess.run(['docker','exec',NAME,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
            time.sleep(1)
        sql(roles.decode())
        sql(schema.decode())
        print(json.dumps({'schemaCopied':True,'productionRowsCopied':0,'network':'none'}))
    elif mode in ('test','query','reset'):
        state=json.loads(run(['docker','inspect',NAME]))[0]
        assert state['HostConfig']['NetworkMode']=='none' and state['Config']['Labels']['norva.purpose']=='unknown-first-language-proof-20260914'
        if mode=='reset':
            # Fixed, synthetic DB only; never the production container/database.
            run(['docker','exec',NAME,'dropdb','-h','/tmp','-U','postgres','--maintenance-db=template1','--force','postgres'])
            run(['docker','exec',NAME,'createdb','-h','/tmp','-U','postgres','postgres'])
            sql((ROOT/'schema.private.sql').read_text())
            print(json.dumps({'syntheticDatabaseReset':True,'productionWrites':0}))
        elif mode=='test':
            for file in MIGRATIONS:sql((ROOT/file).read_text())
            result=sql((ROOT/'unknown-first-language-pipeline.sql').read_text())
            print(result)
        else:
            print(sql((ROOT/'proof-query.sql').read_text()))
    else:raise RuntimeError('mode_required')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'passed':False,'error':str(error) if isinstance(error,RuntimeError) else type(error).__name__}));sys.exit(1)
