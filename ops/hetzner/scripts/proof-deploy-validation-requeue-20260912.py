"""Reproduce a poisoned manual requeue without network or production rows."""
import hashlib,importlib.util,json,os,pathlib,re,subprocess,sys,time
ROOT=pathlib.Path('/home/adrien/.norva/manual-validation-requeue-20260912-r2')
MIGRATION='20260912160500_manual_validation_stale_requeue.sql'
TARGET='public.start_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,integer[],text,timestamptz,bigint,jsonb)'
NAME='norva-manual-requeue-proof-20260912-r2'
LABEL='manual-validation-requeue-20260912'
path=ROOT.parent/'exact-profile-parity-20260912/proof-deploy-exact-profile-parity-20260912.py'
spec=importlib.util.spec_from_file_location('manual_requeue_base',path);p=importlib.util.module_from_spec(spec);sys.modules[spec.name]=p;spec.loader.exec_module(p)
migration=(ROOT/MIGRATION).read_text().replace('\r\n','\n')
OLD=re.search(r'\$old\$([\s\S]*?)\$old\$',migration).group(1)
NEW=re.search(r'\$new\$([\s\S]*?)\$new\$',migration).group(1)
p.ROOT,p.MIGRATION,p.TARGET,p.OLD,p.NEW,p.NAME,p.LABEL=ROOT,MIGRATION,TARGET,OLD,NEW,NAME,LABEL
p.base.ROOT,p.base.MIGRATION,p.base.TARGET,p.base.OLD,p.base.NEW,p.base.NAME,p.base.LABEL=ROOT,MIGRATION,TARGET,OLD,NEW,NAME,LABEL
sql,require,sha=p.sql,p.require,p.sha
OWNER='10000000-0000-4000-8000-000000000001'

def schema():
    # Schema and scalar/trigger definitions only: no production rows or URLs.
    text='''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.catalog_file_tracks(server_host text,item_type text,external_id text,
observed_profile_fingerprint text,observed_profile_probed_at timestamptz,observed_profile_snapshot jsonb);
CREATE TABLE public.catalog_file_audio_validation_jobs(id int primary key,requested_by uuid,request_origin text,
identity_key text,item_type text,external_id text,state text,lease_owner text,lease_expires_at timestamptz,
queue_expires_at timestamptz,retry_at timestamptz,error_code text,updated_at timestamptz,purge_after timestamptz,
profile_fingerprint text,profile_probed_at timestamptz,profile_snapshot jsonb,file_size_bytes bigint);
'''
    for fn in ('public.vod_language_profile_file_size_bytes(jsonb)','public.guard_catalog_validation_observed_profile()'):
        text+=sql('SELECT pg_get_functiondef('+p.base.p.lib.literal(fn)+'::regprocedure);','norva-db')+';\n'
    text+='''CREATE TRIGGER exact_observed_profile BEFORE INSERT OR UPDATE OF state ON public.catalog_file_audio_validation_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_catalog_validation_observed_profile();'''
    return text

def install_fragment(definition):
    start=definition.index('  perform pg_advisory_xact_lock(')
    end=definition.index('  -- A queued track has no worker lease.',start)
    fragment=definition[start:end]
    sql("CREATE OR REPLACE FUNCTION public.fixture_requeue(p_requested_by uuid) RETURNS void LANGUAGE plpgsql AS $fixture$ DECLARE v_now timestamptz:=clock_timestamp(); BEGIN\n"+fragment+'\nEND $fixture$;')

def fixtures():
    # Retry rows can legitimately become obsolete when a newer file profile is observed.
    sql("""INSERT INTO public.catalog_file_audio_validation_jobs
SELECT i,'"""+OWNER+"""'::uuid,CASE WHEN i=5 THEN 'automatic' ELSE 'manual' END,'panel','movie',i::text,
CASE WHEN i=6 THEN 'running' WHEN i=7 THEN 'failed' ELSE 'retry_wait' END,
CASE WHEN i=6 THEN 'active-worker' ELSE null END,
CASE WHEN i=6 THEN clock_timestamp()+interval '1 hour' ELSE null END,null,
clock_timestamp()-interval '1 minute',CASE WHEN i=7 THEN 'PROVIDER_QUARANTINE' ELSE null END,
clock_timestamp(),null,
CASE WHEN i=1 OR i=5 OR i=6 THEN 'old' ELSE 'new' END,
CASE WHEN i=2 THEN '2026-09-11T12:00:00Z'::timestamptz ELSE '2026-09-12T12:00:00Z'::timestamptz END,
CASE WHEN i=3 THEN '{"fileSizeBytes":100,"old":true}'::jsonb ELSE '{"fileSizeBytes":100}'::jsonb END,
CASE WHEN i=4 THEN 99 ELSE 100 END FROM generate_series(1,8) i;
INSERT INTO public.catalog_file_tracks SELECT 'panel','movie',i::text,'new','2026-09-12T12:00:00Z','{"fileSizeBytes":100}'::jsonb FROM generate_series(1,8) i;
""")

def snapshot():
    return json.loads(sql("SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM public.catalog_file_audio_validation_jobs j;"))

def proof():
    require(not (ROOT/'proof.private.json').exists())
    before=p.base.definition();require(before.count(OLD)==1 and NEW not in before)
    expected=before.replace(OLD,NEW)
    require(NAME not in p.base.run(['docker','ps','-a','--format','{{.Names}}']).splitlines())
    created=False
    try:
        p.base.run(['docker','run','-d','--name',NAME,'--label','norva.purpose='+LABEL,'--network','none',
            '--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777',
            '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
        created=True
        for _ in range(25):
            if subprocess.run(['docker','exec',NAME,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
            time.sleep(1)
        sql(schema());fixtures();original=snapshot();install_fragment(before)
        sql(before+'; REVOKE ALL ON FUNCTION '+TARGET+' FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION '+TARGET+' TO service_role;')
        acl_before=p.base.acl(NAME)
        sql("DO $test$ DECLARE observed text; BEGIN BEGIN PERFORM public.fixture_requeue('"+OWNER+"'); EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS observed=RETURNED_SQLSTATE; END; IF observed IS DISTINCT FROM 'PT409' THEN RAISE EXCEPTION 'old requeue did not reproduce'; END IF; END $test$;")
        require(snapshot()==original,'old_requeue_rollback_failed')
        sql(migration)
        require(p.base.definition(NAME)==expected and p.base.acl(NAME)==acl_before,'migration_definition_or_acl_drift')
        sql(migration)
        require(p.base.definition(NAME)==expected,'migration_not_idempotent')
        install_fragment(expected)
        sql("SELECT public.fixture_requeue('"+OWNER+"');")
        after=snapshot()
        for item in after:
            i=item['id']
            if i<=4:
                require(item['state']=='failed' and item['error_code']=='PROFILE_CHANGED','obsolete_job_not_terminal')
                for key in ('profile_fingerprint','profile_probed_at','profile_snapshot','file_size_bytes'):
                    require(item[key]==original[i-1][key],'evidence_changed')
            elif i in (5,6,7):require(item==original[i-1],'protected_job_changed')
            else:require(item['state']=='queued','valid_job_not_requeued')
        sql("SELECT public.fixture_requeue('"+OWNER+"');")
        require(snapshot()==after,'requeue_not_idempotent')
        require(p.base.definition()==before,'production_changed')
        evidence={'passed':True,'beforeSha256':sha(before),'afterSha256':sha(expected),
            'migrationSha256':sha(migration),'networkDisabled':True,'providerRequests':0,'jobsCreated':0,
            'oldFailureReproduced':'PT409','obsoleteProfilesRetained':4,'protectedJobsUnchanged':3,
            'validJobRequeued':True,'idempotent':True,'aclPreserved':True,'fullMigrationApplied':True,'requeueFragmentExecuted':True}
        p.base.p.save(ROOT/'proof.private.json',evidence,True)
    finally:
        if created:
            c=json.loads(p.base.run(['docker','inspect',NAME]))[0]
            require(c['HostConfig']['NetworkMode']=='none' and c['Config']['Labels']['norva.purpose']==LABEL)
            p.base.run(['docker','rm','-f',c['Id']])
    print(json.dumps({**evidence,'isolatedContainerRemoved':True}))

def deploy(commit):
    require(re.fullmatch('[a-f0-9]{40}',commit) is not None)
    evidence=p.base.p.private(ROOT/'proof.private.json')
    require(evidence['passed'] and evidence['fullMigrationApplied'] and evidence['networkDisabled'])
    before=p.base.definition();previous_acl=p.base.acl('norva-db')
    require(sha(before)==evidence['beforeSha256'] and sha(migration)==evidence['migrationSha256'])
    rollback={'definition':before,'acl':previous_acl,'commit':commit}
    if (ROOT/'rollback.private.json').exists():require(p.base.p.private(ROOT/'rollback.private.json')==rollback)
    else:p.base.p.save(ROOT/'rollback.private.json',rollback,True)
    guard="DO $guard$ BEGIN IF md5(rtrim(pg_get_functiondef("+p.base.p.lib.literal(TARGET)+"::regprocedure),E'\\n')) <> "+p.base.p.lib.literal(hashlib.md5(before.encode()).hexdigest())+" THEN RAISE EXCEPTION 'function changed'; END IF; END $guard$;"
    body=migration.replace("SET LOCAL statement_timeout = '20s';","SET LOCAL statement_timeout = '20s';\n"+guard)
    require(body.endswith('COMMIT;\n') and body.count(guard)==1)
    p.live.verify();p.live.op.base.previous.d.idle()
    sql(body,'norva-db',write=True)
    require(sha(p.base.definition())==evidence['afterSha256'] and p.base.acl('norva-db')==previous_acl)
    receipt={'deployed':True,'commit':commit,'functionSha256':evidence['afterSha256'],
        'migration':MIGRATION,'onlyManualRequeueDefinitionChanged':True,'aclPreserved':True,
        'migrationChangedNoJobsOrCache':True}
    p.base.p.save(ROOT/'deployed.private.json',receipt,True);print(json.dumps(receipt))

if __name__=='__main__':
    os.umask(0o077)
    try:
        if sys.argv[1]=='proof':proof()
        elif sys.argv[1]=='deploy':deploy(sys.argv[2])
        elif sys.argv[1]=='status':print(json.dumps({'functionSha256':sha(p.base.definition()),'receiptPresent':(ROOT/'deployed.private.json').exists()}))
        else:raise RuntimeError('invalid_phase')
    except Exception as error:
        reason=str(error);print(json.dumps({'ok':False,'errorType':type(error).__name__,'error':reason if re.fullmatch('[a-z_0-9]{1,80}',reason) else 'manual_requeue_operation_failed'}));sys.exit(1)
