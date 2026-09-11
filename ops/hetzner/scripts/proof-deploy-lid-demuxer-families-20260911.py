"""Networkless SQL proof, then hash-bound one-function migration. No job reset."""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT=pathlib.Path('/home/adrien/.norva/strict-lid-container-families-20260911')
MIGRATION='20260911094000_strict_lid_demuxer_families.sql'
TARGET='public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'
OLD="'mkv', 'matroska', 'matroskawebm', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'ts'"
NEW="'mkv', 'matroska', 'matroskawebm', 'webm', 'mp4', 'mov', 'movmp4m4a3gp3g2mj2', 'avi', 'ogg', 'flv', 'mpg', 'mpeg', 'ts', 'mpegts'"
NAME='norva-lid-demuxer-proof-20260911'
LABEL='lid-demuxer-proof-20260911'
spec=importlib.util.spec_from_file_location('pilot',pathlib.Path('/home/adrien/.norva/unknown-vod-pilot-20260911/run-unknown-vod-pilot-20260911.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)


def run(args,data=None):
    return p.lib.run(args,data,timeout=45).decode().strip()


def sql(statement,target=NAME,write=False):
    args=['docker','exec','-i']
    if target=='norva-db' and not write:args+=['-e','PGOPTIONS=-c default_transaction_read_only=on']
    args += [target,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',
             'supabase_admin' if target=='norva-db' and write else 'postgres','-d','postgres']
    if target==NAME:args+=['-h','/tmp']
    result=subprocess.run(args,input=statement.encode(),capture_output=True,timeout=45)
    if result.returncode:
        message=result.stderr.decode(errors='replace')
        reason=next((label for marker,label in (
            ('function changed','definition_drift'),('permission denied','permission_denied'),
            ('must be owner','not_function_owner'),('does not exist','missing_database_object'),
            ('duplicate key','existing_migration'),('Strict LID container guard drifted','guard_drift'))
            if marker in message),'sql_operation_failed')
        raise RuntimeError(reason)
    return result.stdout.decode().strip()


def sha(value):return hashlib.sha256(value.encode() if isinstance(value,str) else value).hexdigest()


def definition(target='norva-db'):
    return sql('SELECT pg_get_functiondef('+p.lib.literal(TARGET)+'::regprocedure);',target)


def acl(target):
    return json.loads(sql("SELECT jsonb_build_object('anon',has_function_privilege('anon',"+p.lib.literal(TARGET)+
        ",'EXECUTE'),'authenticated',has_function_privilege('authenticated',"+p.lib.literal(TARGET)+
        ",'EXECUTE'),'service',has_function_privilege('service_role',"+p.lib.literal(TARGET)+
        ",'EXECUTE'),'definer',prosecdef,'config',proconfig) FROM pg_proc WHERE oid="+p.lib.literal(TARGET)+'::regprocedure;',target))


def fixture_schema():
    names=('cloud_title_variants','cloud_sources','cloud_source_catalog_heads',
           'catalog_source_provider_identities','catalog_file_audio_validation_jobs')
    query="SELECT string_agg(format('CREATE TABLE public.%I (%s);',relname,cols),E'\\n') FROM ("
    query+="SELECT c.relname,string_agg(format('%I %s',a.attname,format_type(a.atttypid,a.atttypmod)),',' ORDER BY a.attnum) cols "
    query+="FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid "
    query+="WHERE n.nspname='public' AND c.relname IN ("+','.join(p.lib.literal(n) for n in names)+") "
    query+="AND a.attnum>0 AND NOT a.attisdropped GROUP BY c.relname) definitions;"
    # Only column types and function definitions, no production rows or secrets.
    columns=sql(query,'norva-db')
    functions=('public.catalog_audio_track_indexes(jsonb)',
        'public.vod_language_profile_audio_indices(jsonb)',
        'public.vod_language_profile_file_size_bytes(jsonb)',
        'public.vod_language_profile_snapshot(jsonb)',TARGET)
    definitions=[sql('SELECT pg_get_functiondef('+p.lib.literal(f)+'::regprocedure);','norva-db') for f in functions]
    roles='CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'
    return roles+columns+'\n'+';\n'.join(definitions)+';\nREVOKE ALL ON FUNCTION '+TARGET+' FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION '+TARGET+' TO service_role;'


def cases(aliases_accepted):
    tests=[]
    for container in ('mkv','mp4','movmp4m4a3gp3g2mj2','webm','mpeg','mpegts','hls','dash','mp4hls','mpegtslive'):
        valid=container in ('mkv','mp4') or (aliases_accepted and container in ('movmp4m4a3gp3g2mj2','webm','mpeg','mpegts'))
        expected='PT409' if valid else '22023'
        profile={'container':container,'probeSource':'gatewayprobe','probedAt':'2026-09-11T10:00:00Z',
            'durationSeconds':5653.709,'fileSizeBytes':1507505980,
            'audioTracks':[{'index':1,'codec':'aac','channels':2,'default':True}]}
        args=["'10000000-0000-4000-8000-000000000001'::uuid","'20000000-0000-4000-8000-000000000002'::uuid",
            "'30000000-0000-4000-8000-000000000003'::uuid","'40000000-0000-4000-8000-000000000004'","'movie'","'fixture'",
            'ARRAY[1]',p.lib.literal(json.dumps(profile))+'::jsonb',"repeat('a',64)","'2026-09-11T10:00:00Z'::timestamptz",
            '1507505980',"'[ {\"index\":1,\"lang\":\"und\"} ]'::jsonb",'false']
        tests.append("DO $test$ DECLARE observed text; BEGIN BEGIN PERFORM "+TARGET.split('(')[0]+'('+','.join(args)+
            "); EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS observed=RETURNED_SQLSTATE; END; "
            "IF observed IS DISTINCT FROM '"+expected+"' THEN RAISE EXCEPTION 'container test failed: %',observed; END IF; END $test$;")
    sql('\n'.join(tests))
    return len(tests)


def proof():
    p.require(not (ROOT/'proof.private.json').exists())
    before=definition();p.require(before.count(OLD)==1)
    migration=(ROOT/MIGRATION).read_text().replace('\r\n','\n')
    schema=fixture_schema()
    p.require(NAME not in run(['docker','ps','-a','--format','{{.Names}}']).splitlines())
    created=False
    try:
        run(['docker','run','-d','--name',NAME,'--label','norva.purpose='+LABEL,'--network','none',
             '--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777',
             '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
             "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
        created=True
        for _ in range(25):
            result=subprocess.run(['docker','exec',NAME,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True)
            if result.returncode==0:break
            time.sleep(1)
        sql(schema)
        fixture_before=definition(NAME);before_acl=acl(NAME)
        old_cases=cases(False)
        sql(migration)
        after=definition(NAME);p.require(after==fixture_before.replace(OLD,NEW))
        p.require(acl(NAME)==before_acl and not before_acl['anon'] and not before_acl['authenticated'] and before_acl['service'])
        new_cases=cases(True)
        sql(migration);p.require(definition(NAME)==after)
        p.require(sql('SELECT count(*) FROM public.catalog_file_audio_validation_jobs;')=='0')
        p.require(definition()==before)
        proof={'passed':True,'beforeSha256':sha(before),'afterSha256':sha(before.replace(OLD,NEW)),
            'migrationSha256':sha(migration),'oldCases':old_cases,'newCases':new_cases,
            'onlyAllowlistChanged':True,'aclPreserved':True,'idempotent':True,'jobsCreated':0,'providerRequests':0}
        p.save(ROOT/'proof.private.json',proof,True)
    finally:
        if created:
            container=json.loads(run(['docker','inspect',NAME]))[0]
            p.require(container['HostConfig']['NetworkMode']=='none' and container['Config']['Labels']['norva.purpose']==LABEL)
            run(['docker','rm','-f',container['Id']])
    print(json.dumps({**proof,'isolatedContainerRemoved':True}))


def deploy(commit):
    p.require(re.fullmatch('[a-f0-9]{40}',commit) is not None)
    evidence=p.private(ROOT/'proof.private.json');p.require(evidence['passed'])
    before=definition();p.require(sha(before)==evidence['beforeSha256'])
    migration=(ROOT/MIGRATION).read_text().replace('\r\n','\n')
    p.require(sha(migration)==evidence['migrationSha256'])
    previous_acl=acl('norva-db')
    rollback={'definition':before,'acl':previous_acl,'commit':commit}
    if (ROOT/'rollback.private.json').exists():
        saved=p.private(ROOT/'rollback.private.json')
        p.require(saved['definition']==before and saved['acl']==previous_acl)
    else:
        p.save(ROOT/'rollback.private.json',rollback,True)
    # This self-hosted installation records scoped releases as private receipts
    # and function hashes, as the preceding deployment does. Do not invent a
    # hosted Supabase migration registry or create an unrelated schema.
    guard="DO $guard$ BEGIN IF md5(rtrim(pg_get_functiondef("+p.lib.literal(TARGET)+"::regprocedure),E'\\n')) <> "+p.lib.literal(hashlib.md5(before.encode()).hexdigest())+" THEN RAISE EXCEPTION 'function changed'; END IF; END $guard$;"
    # Compare the same definition without its formatting-only trailing newline.
    body=migration.replace("SET LOCAL statement_timeout = '20s';","SET LOCAL statement_timeout = '20s';\n"+guard)
    p.require(body.endswith('COMMIT;\n'))
    sql(body,'norva-db',write=True)
    p.require(sha(definition())==evidence['afterSha256'])
    p.require(acl('norva-db')==previous_acl)
    receipt={'deployed':True,'commit':commit,'functionSha256':evidence['afterSha256'],
        'migration':'20260911094000','onlyAllowlistChanged':True,'aclPreserved':True,'snapshotsAndJobsUnchangedByMigration':True}
    p.save(ROOT/'deployed.private.json',receipt,True);print(json.dumps(receipt))


if __name__=='__main__':
    os.umask(0o077)
    try:
        if sys.argv[1]=='proof':proof()
        elif sys.argv[1]=='deploy':deploy(sys.argv[2])
        elif sys.argv[1]=='status':
            print(json.dumps({'functionSha256':sha(definition()),'acl':acl('norva-db'),
                'migrationRegistryPresent':sql("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL;",'norva-db')=='t',
                'receiptPresent':(ROOT/'deployed.private.json').exists()}))
        else:raise RuntimeError('invalid_phase')
    except Exception as error:
        reason=str(error)
        print(json.dumps({'ok':False,'error':reason if re.fullmatch('[a-z_]{1,60}',reason) else 'bounded_demuxer_operation_failed'}));sys.exit(1)
