"""Networkless SQL proof; copies only schema and installed function definitions."""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import time

ROOT=pathlib.Path('/home/adrien/.norva/scoped-capture-jobs-proof-20260913')
HELPER=ROOT.parent/'automatic-vod-language-fleet-20260911/deploy-automatic-vod-language-fleet-20260911.py'
spec=importlib.util.spec_from_file_location('scoped_capture_sql_helpers',HELPER)
fleet=importlib.util.module_from_spec(spec);spec.loader.exec_module(fleet)
fleet.ROOT=ROOT
fleet.PROOF='norva-scoped-capture-jobs-proof-20260913'
fleet.TARGETS=('norva_credential_require_service_role','catalog_language_capture_pipeline_enabled','checkpoint_catalog_file_audio_capture')
fleet.HELPERS=()
TABLES=('catalog_file_audio_validation_jobs','catalog_file_audio_captures','admin_feature_flags','admin_internal_accounts',
    'cloud_sources','provider_file_probe_leases','provider_exact_file_probe_leases','provider_account_language_validation_leases')
MIGRATION='20260913053000_scoped_language_capture_jobs.sql'
LABEL='scoped-capture-jobs-proof-20260913'


def schema(definitions):
    names=','.join(fleet.literal(name) for name in TABLES)
    cols=json.loads(fleet.sql("SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),"
        "'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid "
        "JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum "
        "WHERE n.nspname='public' AND c.relname IN ("+names+") AND a.attnum>0 AND NOT a.attisdropped;"))
    auth_jwt=fleet.sql("SELECT pg_get_functiondef('auth.jwt()'::regprocedure);")
    statements=["CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA extensions;",
        "CREATE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS 'SELECT pg_catalog.gen_random_uuid()';",
        "CREATE TABLE auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);",auth_jwt+';']
    for table in TABLES:
        fields=['"'+c['name']+'" '+c['type']+(' DEFAULT '+c['default'] if c['default'] else '') for c in cols if c['table']==table]
        fleet.require(bool(fields),'fixture_schema_missing')
        statements.append('CREATE TABLE public.'+table+'('+','.join(fields)+');')
    statements += [
        'ALTER TABLE public.catalog_file_audio_validation_jobs ADD PRIMARY KEY(id);',
        'ALTER TABLE public.catalog_file_audio_captures ADD PRIMARY KEY(job_id,stream_index,window_ordinal);',
        'ALTER TABLE public.admin_feature_flags ADD PRIMARY KEY(key);',
        'ALTER TABLE public.admin_internal_accounts ADD PRIMARY KEY(user_id);',
        'ALTER TABLE public.cloud_sources ADD PRIMARY KEY(id);']
    for name in fleet.TARGETS:
        rows=[row for row in definitions if row['name']==name]
        fleet.require(len(rows)==1,'fixture_definition_ambiguous')
        statements.append(rows[0]['definition']+';')
    return '\n'.join(statements)


def main():
    require,run,sql=fleet.require,fleet.gw.run,fleet.sql
    require(ROOT.is_dir() and not ROOT.is_symlink(),'proof_path_invalid')
    require(not (ROOT/'proof.private.json').exists(),'proof_already_recorded')
    require(fleet.PROOF not in run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines(),'proof_exists')
    require(os.getloadavg()[0]<(os.cpu_count() or 1)*0.7,'host_capacity_busy')
    fleet.gw.assert_idle(fleet.gw.health())
    before=fleet.definitions();created=None;proof=None
    try:
        created=run(['docker','run','-d','--name',fleet.PROOF,'--label','norva.purpose='+LABEL,
            '--network','none','--memory','512m','--cpus','0.5','--pids-limit','128',
            '--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777','--user','postgres','--entrypoint','/bin/sh',
            'supabase/postgres:17.6.1.136','-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"]).decode().strip()
        for attempt in range(25):
            if subprocess.run(['docker','exec',fleet.PROOF,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
            if attempt==24:raise RuntimeError('fixture_start_timeout')
            time.sleep(1)
        fleet.gw.assert_idle(fleet.gw.health())
        sql(schema(before),True)
        sql(fleet.artifact(MIGRATION),True)
        sql(fleet.artifact('scoped-language-capture-jobs.sql'),True)
        fleet.gw.assert_idle(fleet.gw.health())
        def approve(n):
            job='20000000-0000-4000-8000-'+str(n).zfill(12)
            return sql("SET request.jwt.claim.role='service_role'; SELECT public.authorize_catalog_language_capture_job('"+job+
                "',repeat('a',64),(SELECT expiry FROM public.scoped_capture_race));",True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(approve,range(2,42)))
        require(results.count('t')==20 and results.count('f')==20,'approval_race_exceeded_ceiling')
        sql("SELECT public.scoped_capture_assert((SELECT count(*)=20 FROM public.catalog_language_capture_job_pilots),'concurrent_twenty_job_ceiling');",True)
        checks=json.loads(sql('SELECT jsonb_agg(label ORDER BY label) FROM public.scoped_capture_checks;',True))
        after=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid))) "
            "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN "
            "('catalog_language_capture_pipeline_enabled_for_job','authorize_catalog_language_capture_job','revoke_catalog_language_capture_job','checkpoint_catalog_file_audio_capture');",True))
        require(fleet.definitions()==before,'production_definitions_changed')
        proof={'passed':True,'checks':checks,'before':before,'after':after,
            'migrationSha256':hashlib.sha256(fleet.artifact(MIGRATION).encode()).hexdigest(),
            'providerRequests':0,'productionWrites':0,'network':'none','concurrentApprovals':{'accepted':20,'refused':20},
            'limitations':['synthetic data','existing table constraints and production triggers not copied; new migration constraints exercised']}
    finally:
        if created:
            c=fleet.gw.inspect(fleet.PROOF)
            require(c['Id']==created and c['HostConfig']['NetworkMode']=='none'
                and c['Config']['Labels']['norva.purpose']==LABEL and not c['HostConfig'].get('Binds'),'proof_identity_changed')
            run(['docker','stop','--time','20',created]);run(['docker','rm',created])
    if proof:
        proof['fixtureRemoved']=True;fleet.save('proof.private.json',proof)
        print(json.dumps({key:value for key,value in proof.items() if key not in ('before','after','checks')}
            |{'checks':len(proof['checks'])}))


if __name__=='__main__':
    os.umask(0o077)
    try:main()
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code)
            else 'scoped_capture_proof_failed'}));raise SystemExit(1)
