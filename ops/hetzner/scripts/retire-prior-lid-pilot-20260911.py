"""Retire the six pre-pilot jobs and old lab audio, never restart them.

All database reads and output are bounded. Receipts, row backups and retired
audio stay private. The immutable current 100-file pilot is never edited.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/lid-clean-pilot-20260911')
LAB = pathlib.Path('/home/adrien/.norva/lid-comparative-lab-20260910')
PILOT = pathlib.Path('/home/adrien/.norva/unknown-vod-pilot-20260911')
MIGRATION = '20260911102129_strict_lid_completed_inconclusive_releases_queue.sql'
TARGET = 'public.fail_catalog_file_audio_validation_job(uuid,text,text,boolean,timestamptz)'
CANCEL = 'public.cancel_catalog_file_audio_validation_job(uuid,uuid,text)'
PROOF = 'norva-lid-completed-outcome-proof-20260911'
LABEL = 'lid-completed-outcome-proof-20260911'
OLD = 'LANGUAGE_VALIDATION_STRICT_CONSENSUS_PENDING'
NEW = 'LANGUAGE_VALIDATION_STRICT_CONSENSUS_INCONCLUSIVE'
RETIRED = 'LANGUAGE_VALIDATION_SUPERSEDED_BY_CURRENT_PILOT'
AUDIO = re.compile(r'^(audio/V[123]-[A-F]\.wav|derived/V[123]-[A-F]-vad20\.wav|independent-vod-20260911/audio/N[23]-[A-C]\.wav)$')
spec = importlib.util.spec_from_file_location('current_pilot', PILOT/'run-unknown-vod-pilot-20260911.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def require(value, reason='retirement_guard_declined'):
    if not value:
        raise RuntimeError(reason)


def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def private(name, value=None):
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = ROOT/name
    require(not path.is_symlink())
    if value is None:
        return json.loads(path.read_text())
    with path.open('x', encoding='utf8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    return value


def sql(statement, container='norva-db', write=False):
    args = ['docker', 'exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=3000' +
            (' -c default_transaction_read_only=on' if container == 'norva-db' and not write else ''),
            container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U',
            'supabase_admin' if container == 'norva-db' and write else 'postgres', '-d', 'postgres']
    if container == PROOF:
        args += ['-h', '/tmp']
    result = subprocess.run(args, input=statement.encode(), capture_output=True, timeout=45)
    if result.returncode:
        # No raw SQL/row/credential output; a fixture test number is safe.
        err = result.stderr.decode(errors='replace')
        test = re.search(r'outcome_fixture_[a-z0-9_]+', err)
        raise RuntimeError(test[0] if test else 'bounded_retirement_sql_failed')
    return result.stdout.decode().strip()


def definition(target=TARGET, container='norva-db'):
    return sql('SELECT pg_get_functiondef('+p.lib.literal(target)+'::regprocedure);', container)


def acl(container='norva-db'):
    return json.loads(sql("SELECT jsonb_build_object('acl',proacl,'owner',pg_get_userbyid(proowner),"
        "'definer',prosecdef,'config',proconfig,'anon',has_function_privilege('anon',oid,'EXECUTE'),"
        "'authenticated',has_function_privilege('authenticated',oid,'EXECUTE'),"
        "'service',has_function_privilege('service_role',oid,'EXECUTE')) FROM pg_proc WHERE oid="+
        p.lib.literal(TARGET)+'::regprocedure;', container))


def safe_audio(root, relative):
    require(AUDIO.fullmatch(relative) is not None, 'unrecognized_audio_file')
    base = root.resolve()
    candidate = root/relative
    require(candidate.is_file() and not candidate.is_symlink(), 'audio_file_missing')
    require(candidate.resolve().is_relative_to(base), 'audio_path_escape')
    require(all(not parent.is_symlink() for parent in candidate.parents if parent != base and parent.is_relative_to(base)), 'audio_symlink')
    return candidate


def prepare():
    plan = p.private(PILOT/'plan.private.json')
    p.validate(plan)
    cutoff = p.lib.literal(plan['preparedAt']) if 'preparedAt' in plan else 'to_timestamp('+str(plan['preparedEpoch'])+')'
    rows = json.loads(sql("SELECT coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(j),'rowMd5',md5(to_jsonb(j)::text),"
        "'cache',to_jsonb(c),'cacheMd5',md5(to_jsonb(c)::text)) ORDER BY j.requested_by,j.identity_key,j.external_id),'[]'::jsonb) "
        "FROM public.catalog_file_audio_validation_jobs j LEFT JOIN public.catalog_file_tracks c ON "
        "c.server_host=j.identity_key AND c.item_type=j.item_type AND c.external_id=j.external_id "
        "WHERE j.state='retry_wait' AND j.error_code="+p.lib.literal(OLD)+
        " AND j.created_at < "+cutoff+" AND j.updated_at < "+cutoff+";"))
    require(len(rows) == 6, 'expected_six_prior_jobs')
    selected = {(r['identity_key'], r['external_id']) for r in plan['rows']}
    for item in rows:
        row, cache = item['row'], item['cache']
        require(row['item_type'] == 'movie' and row['quarantined_at'] is None and row['verified_at'] is None)
        require(row['lease_owner'] is None and row['lease_expires_at'] is None)
        require(row['strict_lid_window_position'] == row['strict_lid_window_count'] == 6)
        require((row['identity_key'], row['external_id']) not in selected, 'prior_job_overlaps_current_pilot')
        require(cache and cache['audio_lang_verified_at'] is None and cache['audio_lang_verification']['reason'] == OLD.lower())
    audio = []
    for file in sorted(LAB.rglob('*.wav')):
        relative = file.relative_to(LAB).as_posix()
        exact = safe_audio(LAB, relative)
        audio.append({'relative': relative, 'bytes': exact.stat().st_size, 'sha256': sha(exact.read_bytes())})
    require(len(audio) == 23, 'expected_twenty_three_audio_files')
    record = {'preparedAt': p.now(), 'rows': rows, 'audio': audio,
        'pilotSha256': sha((PILOT/'plan.private.json').read_bytes()),
        'functionBefore': definition(), 'functionAcl': acl(), 'cancelSha256': sha(definition(CANCEL))}
    private('retirement-plan.private.json', record)
    print(json.dumps({'prepared': True, 'oldJobs': len(rows), 'oldAudioFiles': len(audio),
        'audioBytes': sum(f['bytes'] for f in audio), 'currentPilotOverlap': 0, 'productionUnchanged': True}))


def archive():
    plan = private('retirement-plan.private.json')
    destination = ROOT/'retired-audio'
    require(not destination.exists(), 'audio_archive_exists')
    for item in plan['audio']:
        file = safe_audio(LAB, item['relative'])
        require(sha(file.read_bytes()) == item['sha256'], 'audio_changed')
    destination.mkdir(mode=0o700)
    for item in plan['audio']:
        source = safe_audio(LAB, item['relative'])
        target = destination/item['relative']
        require(target.absolute().is_relative_to(destination.absolute()))
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(not target.exists())
        os.rename(source, target)
        require(sha(safe_audio(destination, item['relative']).read_bytes()) == item['sha256'])
    receipt = {'archived': len(plan['audio']), 'recoverable': True, 'activeLabAudioRemaining': len(list(LAB.rglob('*.wav')))}
    require(receipt['activeLabAudioRemaining'] == 0)
    private('audio-archived.private.json', receipt)
    print(json.dumps(receipt))


def fixture_schema():
    columns = sql("SELECT string_agg(format('%I %s',attname,format_type(atttypid,atttypmod)),',' ORDER BY attnum) "
                  "FROM pg_attribute WHERE attrelid='public.catalog_file_audio_validation_jobs'::regclass "
                  "AND attnum>0 AND NOT attisdropped;")
    return ('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;'
        'CREATE TABLE public.catalog_file_audio_validation_jobs ('+columns+');'
        "CREATE TABLE public.fixture_provenance(provenance jsonb);"
        "CREATE FUNCTION public.record_catalog_file_audio_verification(text,text,text,boolean,timestamptz,timestamptz,jsonb) "
        "RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.fixture_provenance VALUES ($7); RETURN true; END $$;"+
        definition('public.strict_lid_window_tokens_are_valid(jsonb)')+';'+definition()+';'
        'REVOKE ALL ON FUNCTION '+TARGET+' FROM PUBLIC,anon,authenticated;'
        'GRANT EXECUTE ON FUNCTION '+TARGET+' TO service_role;')


def fixture_cases(patched):
    tests = [
        ('six_complete', 'running', 6, 6, OLD, False, False, 'owner', 'movie', 'failed' if patched else 'retry_wait'),
        ('four_complete', 'finalizing', 4, 4, OLD, False, False, 'owner', 'episode', 'failed' if patched else 'retry_wait'),
        ('unfinished', 'running', 3, 6, OLD, False, False, 'owner', 'movie', 'retry_wait'),
        ('transport_retry', 'running', 6, 6, 'LANGUAGE_VALIDATION_GATEWAY_ERROR', False, False, 'owner', 'movie', 'retry_wait'),
        ('explicit_terminal', 'running', 6, 6, 'PROFILE_CHANGED', True, False, 'owner', 'movie', 'failed'),
        ('stale_owner', 'running', 6, 6, OLD, False, False, 'different-owner', 'movie', 'running'),
        ('quarantine_untouched', 'failed', 6, 6, 'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED', False, True, 'owner', 'movie', 'failed'),
    ]
    for name, state, position, count, code, terminal, quarantined, owner, kind, expected in tests:
        unchanged = name in ('stale_owner', 'quarantine_untouched')
        expected_code = NEW if patched and name in ('six_complete','four_complete') else (code if not unchanged else 'original')
        expected_status = 'failed' if patched and expected == 'failed' else 'pending'
        statement = """TRUNCATE public.catalog_file_audio_validation_jobs,public.fixture_provenance;
INSERT INTO public.catalog_file_audio_validation_jobs(id,identity_key,item_type,external_id,state,
 lease_owner,lease_expires_at,verified_at,quarantined_at,error_code,next_track_position,expected_audio_indices,
 strict_lid_window_position,strict_lid_window_count,strict_lid_window_protocol,strict_lid_window_tokens)
SELECT '10000000-0000-4000-8000-000000000001','fixture',%s,'file',%s,'owner',now()+interval '10 minutes',null,%s,
 'original',0,ARRAY[1],%s,%s,1,coalesce((SELECT jsonb_agg('v1.0123456789abcdef.abcdefghijklmnop.'||repeat('a',15)||g::text||'.abcdefghijklmnopqrstuv') FROM generate_series(1,%s) g),'[]'::jsonb);
DO $test$ DECLARE result boolean; original_tokens jsonb; BEGIN
SELECT strict_lid_window_tokens INTO original_tokens FROM public.catalog_file_audio_validation_jobs;
result:=public.fail_catalog_file_audio_validation_job('10000000-0000-4000-8000-000000000001',%s,%s,%s,now()+interval '1 day');
IF result IS DISTINCT FROM %s OR NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs WHERE state=%s AND error_code=%s AND strict_lid_window_tokens=original_tokens AND verified_at IS NULL)
 THEN RAISE EXCEPTION 'outcome_fixture_%s'; END IF;
%s
END $test$;
""" % (p.lib.literal(kind),p.lib.literal(state),'now()' if quarantined else 'null',position,count,position,
         p.lib.literal(owner),p.lib.literal(code),str(terminal).lower(),str(not unchanged).lower(),p.lib.literal(expected),
         p.lib.literal(expected_code),name,
         ("IF NOT EXISTS(SELECT 1 FROM public.fixture_provenance WHERE provenance->>'status'="+p.lib.literal(expected_status)+
          ") THEN RAISE EXCEPTION 'outcome_fixture_provenance_"+name+"'; END IF;") if not unchanged else
         "IF EXISTS(SELECT 1 FROM public.fixture_provenance) THEN RAISE EXCEPTION 'outcome_fixture_no_write'; END IF;")
        sql(statement, PROOF)
    return len(tests)


def proof():
    before = definition()
    migration = (ROOT/MIGRATION).read_text().replace('\r\n','\n')
    require(PROOF not in p.lib.run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines())
    created = False
    try:
        p.lib.run(['docker','run','-d','--name',PROOF,'--label','norva.purpose='+LABEL,'--network','none',
            '--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777',
            '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
        created=True
        for _ in range(25):
            if subprocess.run(['docker','exec',PROOF,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:
                break
            time.sleep(1)
        sql(fixture_schema(),PROOF)
        before_acl=acl(PROOF)
        old_cases=fixture_cases(False)
        sql(migration,PROOF)
        after=definition(container=PROOF)
        new_cases=fixture_cases(True)
        require(acl(PROOF)==before_acl and not before_acl['anon'] and not before_acl['authenticated'] and before_acl['service'])
        sql(migration,PROOF)
        require(definition(container=PROOF)==after, 'migration_not_idempotent')
        require(definition()==before, 'production_changed_during_proof')
        evidence={'passed':True,'beforeSha256':sha(before),'afterSha256':sha(after),'migrationSha256':sha(migration),
            'beforeCases':old_cases,'afterCases':new_cases,'aclPreserved':True,'idempotent':True,
            'productionWrites':0,'providerRequests':0,'cachePersistenceStubbedInFixture':True}
        private('proof.private.json',evidence)
    finally:
        if created:
            item=json.loads(p.lib.run(['docker','inspect',PROOF]))[0]
            require(item['HostConfig']['NetworkMode']=='none' and item['Config']['Labels']['norva.purpose']==LABEL)
            p.lib.run(['docker','rm','-f',item['Id']])
    print(json.dumps({**evidence,'isolatedContainerRemoved':True}))


def deploy(commit):
    require(re.fullmatch('[a-f0-9]{40}',commit) is not None)
    evidence=private('proof.private.json');plan=private('retirement-plan.private.json')
    require(evidence['passed'] and sha(definition())==evidence['beforeSha256'])
    migration=(ROOT/MIGRATION).read_text().replace('\r\n','\n')
    require(sha(migration)==evidence['migrationSha256'])
    require(acl()==plan['functionAcl'])
    guard="DO $guard$ BEGIN IF md5(rtrim(pg_get_functiondef("+p.lib.literal(TARGET)+"::regprocedure),E'\\n')) <> "+p.lib.literal(hashlib.md5(definition().encode()).hexdigest())+" THEN RAISE EXCEPTION 'definition drift'; END IF; END $guard$;"
    sql(migration.replace("SET LOCAL statement_timeout = '20s';","SET LOCAL statement_timeout = '20s';\n"+guard),write=True)
    require(sha(definition())==evidence['afterSha256'] and acl()==plan['functionAcl'])
    result={'deployed':True,'commit':commit,'functionSha256':evidence['afterSha256'],'quotasAndThresholdsUnchanged':True}
    private('deployed.private.json',result);print(json.dumps(result))


def retirement_sql(plan):
    statements=["BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';"]
    # Serialize tenant admissions before any canonical-file lock, same as start/cancel.
    for user in sorted({item['row']['requested_by'] for item in plan['rows']}):
        statements.append("SELECT pg_advisory_xact_lock(hashtextextended('catalog-file-audio-validation-user:'||"+p.lib.literal(user)+",0));")
    for item in plan['rows']:
        row=item['row'];job=p.lib.literal(row['id'])+'::uuid'
        statements.append("DO $retire$ DECLARE j public.catalog_file_audio_validation_jobs%rowtype; BEGIN "
            "PERFORM pg_advisory_xact_lock(hashtextextended("+p.lib.literal('catalog-file-audio-validation:'+row['identity_key']+':movie:'+row['external_id'])+",0)); "
            "SELECT * INTO j FROM public.catalog_file_audio_validation_jobs WHERE id="+job+" FOR UPDATE; "
            "IF md5(to_jsonb(j)::text) IS DISTINCT FROM "+p.lib.literal(item['rowMd5'])+
            " OR j.quarantined_at IS NOT NULL OR j.verified_at IS NOT NULL OR j.lease_owner IS NOT NULL OR j.state<>'retry_wait' "
            "THEN RAISE EXCEPTION 'retirement row drift'; END IF; "
            "IF NOT public.cancel_catalog_file_audio_validation_job(j.id,j.requested_by,"+p.lib.literal(RETIRED)+") "
            "THEN RAISE EXCEPTION 'retirement refused'; END IF; "
            "UPDATE public.catalog_file_tracks c SET audio_lang_verification=c.audio_lang_verification||jsonb_build_object("
            "'status','failed','reason',lower("+p.lib.literal(RETIRED)+"),'jobId',j.id,'supersededAt',now()),updated_at=now() "
            "WHERE c.server_host=j.identity_key AND c.item_type=j.item_type AND c.external_id=j.external_id "
            "AND c.audio_lang_verified_at IS NULL AND md5(to_jsonb(c)::text)="+p.lib.literal(item['cacheMd5'])+"; "
            "END $retire$;")
    statements.append('COMMIT;')
    return '\n'.join(statements)


def proof_retirement():
    require(PROOF not in p.lib.run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines())
    created=False
    try:
        p.lib.run(['docker','run','-d','--name',PROOF,'--label','norva.purpose='+LABEL,'--network','none',
            '--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777',
            '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
        created=True
        for _ in range(25):
            if subprocess.run(['docker','exec',PROOF,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
            time.sleep(1)
        columns=sql("SELECT string_agg(format('%I %s',attname,format_type(atttypid,atttypmod)),',' ORDER BY attnum) FROM pg_attribute "
                    "WHERE attrelid='public.catalog_file_tracks'::regclass AND attnum>0 AND NOT attisdropped;")
        sql(fixture_schema()+'CREATE TABLE public.catalog_file_tracks ('+columns+');'+definition(CANCEL)+';',PROOF)
        fixture_cases(False)  # Leaves one quarantined fixture in place.
        sql("""INSERT INTO public.catalog_file_audio_validation_jobs(id,requested_by,identity_key,item_type,external_id,
 state,error_code,strict_lid_window_position,strict_lid_window_count,strict_lid_window_tokens)
 SELECT ('20000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'40000000-0000-4000-8000-000000000001',
 'old-fixture-provider','movie','old-fixture-'||g,'retry_wait','LANGUAGE_VALIDATION_STRICT_CONSENSUS_PENDING',6,6,
 (SELECT jsonb_agg('receipt-'||n) FROM generate_series(1,6) n) FROM generate_series(1,6) g;
 INSERT INTO public.catalog_file_tracks(server_host,item_type,external_id,audio_lang_verification)
 SELECT identity_key,item_type,external_id,'{"status":"pending","reason":"language_validation_strict_consensus_pending"}'::jsonb
 FROM public.catalog_file_audio_validation_jobs WHERE external_id LIKE 'old-fixture-%';
 INSERT INTO public.catalog_file_audio_validation_jobs(id,item_type,external_id,state)
 VALUES ('30000000-0000-4000-8000-000000000001','movie','current-pilot-fixture','running');
 """,PROOF)
        plan={'rows':json.loads(sql("SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(j),'rowMd5',md5(to_jsonb(j)::text),"
            "'cacheMd5',md5(to_jsonb(c)::text)) ORDER BY j.id) FROM public.catalog_file_audio_validation_jobs j "
            "JOIN public.catalog_file_tracks c ON c.server_host=j.identity_key AND c.item_type=j.item_type AND c.external_id=j.external_id;",PROOF))}
        snapshot="SELECT md5(jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM public.catalog_file_audio_validation_jobs j),'cache',(SELECT jsonb_agg(to_jsonb(c) ORDER BY external_id) FROM public.catalog_file_tracks c))::text);"
        before=sql(snapshot,PROOF)
        drifted=json.loads(json.dumps(plan));drifted['rows'][-1]['rowMd5']='0'*32
        try:
            sql(retirement_sql(drifted),PROOF)
            raise RuntimeError('outcome_fixture_drift_not_rejected')
        except RuntimeError as error:
            require(str(error)=='bounded_retirement_sql_failed','outcome_fixture_drift_not_rejected')
        require(sql(snapshot,PROOF)==before,'outcome_fixture_partial_retirement_not_rolled_back')
        sql(retirement_sql(plan),PROOF)
        result=json.loads(sql("SELECT jsonb_build_object('retired',count(*) FILTER(WHERE state='cancelled' AND error_code="+
            p.lib.literal(RETIRED)+"),'receiptsPreserved',count(*) FILTER(WHERE state='cancelled' AND jsonb_array_length(strict_lid_window_tokens)=6),"
            "'currentPilotUntouched',count(*) FILTER(WHERE external_id='current-pilot-fixture' AND state='running'),"
            "'quarantineUntouched',count(*) FILTER(WHERE quarantined_at IS NOT NULL AND state='failed')) FROM public.catalog_file_audio_validation_jobs;",PROOF))
        require(result=={'retired':6,'receiptsPreserved':6,'currentPilotUntouched':1,'quarantineUntouched':1},'outcome_fixture_retirement_counts')
        require(sql("SELECT count(*) FROM public.catalog_file_tracks WHERE audio_lang_verification->>'reason'="+p.lib.literal(RETIRED.lower())+';',PROOF)=='6','outcome_fixture_retired_cache_status')
        evidence={'passed':True,'atomicRollbackOnDrift':True,**result,'productionWrites':0,'providerRequests':0}
        private('retirement-proof.private.json',evidence)
    finally:
        if created:
            item=json.loads(p.lib.run(['docker','inspect',PROOF]))[0]
            require(item['HostConfig']['NetworkMode']=='none' and item['Config']['Labels']['norva.purpose']==LABEL)
            p.lib.run(['docker','rm','-f',item['Id']])
    print(json.dumps({**evidence,'isolatedContainerRemoved':True}))


def retire():
    plan=private('retirement-plan.private.json');evidence=private('deployed.private.json')
    require(private('retirement-proof.private.json')['passed'])
    require(sha(definition())==evidence['functionSha256'])
    require(sha(definition(CANCEL))==plan['cancelSha256'])
    require(sha((PILOT/'plan.private.json').read_bytes())==plan['pilotSha256'])
    require(private('audio-archived.private.json')['activeLabAudioRemaining']==0)
    sql(retirement_sql(plan),write=True)
    ids=','.join(p.lib.literal(item['row']['id'])+'::uuid' for item in plan['rows'])
    counts=json.loads(sql("SELECT jsonb_build_object('cancelled',count(*) FILTER(WHERE state='cancelled' AND error_code="+
        p.lib.literal(RETIRED)+"),'retainedReceiptSets',count(*) FILTER(WHERE jsonb_array_length(strict_lid_window_tokens)=6),"
        "'verified',count(verified_at)) FROM public.catalog_file_audio_validation_jobs WHERE id IN ("+ids+");"))
    require(counts=={'cancelled':6,'retainedReceiptSets':6,'verified':0})
    result={**counts,'oldJobsRestarted':0,'currentPilotPlanUnchanged':sha((PILOT/'plan.private.json').read_bytes())==plan['pilotSha256']}
    private('retired.private.json',result);print(json.dumps(result))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        if phase=='prepare':prepare()
        elif phase=='archive':archive()
        elif phase=='proof':proof()
        elif phase=='proof-retirement':proof_retirement()
        elif phase=='deploy':deploy(sys.argv[2])
        elif phase=='retire':retire()
        else:raise RuntimeError('unknown_phase')
    except Exception as error:
        reason=str(error)
        print(json.dumps({'ok':False,'error':reason if re.fullmatch('[a-z0-9_]{1,100}',reason) else 'bounded_retirement_failed'}))
        sys.exit(1)
