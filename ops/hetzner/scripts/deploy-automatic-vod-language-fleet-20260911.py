"""Proof, staged SQL, rolling Edge and explicit fleet activation.

No model/container-image/credential/threshold changes. Existing function trees
and containers remain recoverable. The proof copies schema/function definitions
only, never accounts, provider credentials, tracks or audio from production.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import time

ROOT=pathlib.Path('/home/adrien/.norva/automatic-vod-language-fleet-20260911')
spec=importlib.util.spec_from_file_location('edge_helpers',pathlib.Path(__file__).with_name('deploy-codec-profile-presence-20260911.py'))
edge=importlib.util.module_from_spec(spec);spec.loader.exec_module(edge)
lib=edge.lib;gw=lib.gw
SERVICES=('norva-edge-functions','norva-edge-functions-2')
FILES=('norva-playback/index.ts','norva-source-sync/index.ts','_shared/automatic-vod-language-fleet.mjs')
MIGRATION='20260911113013_automatic_vod_language_fleet.sql'
TARGETS=('start_automatic_catalog_file_audio_validation_job','finalize_catalog_file_audio_validation_job','observe_catalog_file_profile')
HELPERS=('vod_language_profile_audio_indices','vod_language_profile_file_size_bytes','vod_language_profile_snapshot','catalog_audio_track_indexes',
         'norva_canonical_language_code','cloud_file_track_languages','recompute_cloud_title_file_languages',
         'merge_cloud_title_file_languages','mark_cloud_title_file_audio_verification',
         'norva_fanout_file_tracks_to_users_fenced','catalog_episode_file_coordinate_is_registered',
         'upsert_catalog_file_validated_tracks','record_catalog_file_audio_verification')
TABLES=('cloud_sources','cloud_source_catalog_heads','cloud_title_variants','catalog_source_provider_identities',
        'catalog_file_tracks','catalog_file_audio_validation_jobs','admin_feature_flags','catalog_series_episode_memberships',
        'cloud_source_lifecycle','cloud_user_catalog_visibility_epochs','cloud_titles','cloud_title_file_language_observations',
        'cloud_catalog_facet_summary')
PROOF='norva-automatic-language-proof-20260911'
LABEL='automatic-language-proof-20260911'
require=gw.require
literal=lambda s:"'"+s.replace("'","''")+"'"
sha=lambda b:hashlib.sha256(b.encode() if isinstance(b,str) else b).hexdigest()

def artifact(name):return gw.safe_file(ROOT,name).read_text().replace('\r\n','\n')
def saved(name):return json.loads(artifact(name))
def save(name,value):gw.private_write(ROOT/name,value)

def sql(text,fixture=False,write=False):
    args=['docker','exec','-i','-e','PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=3000'+
          ('' if fixture or write else ' -c default_transaction_read_only=on'),PROOF if fixture else 'norva-db',
          'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','supabase_admin' if write and not fixture else 'postgres','-d','postgres']
    if fixture:args+=['-h','/tmp']
    r=subprocess.run(args,input=text.encode(),capture_output=True,timeout=45)
    if r.returncode:
        # Private diagnostic only. Public output never prints provider data.
        (ROOT/'sql-error.private.txt').write_bytes(r.stderr)
        raise RuntimeError('fleet_sql_failed')
    return r.stdout.decode().strip()

def definitions(fixture=False):
    names=','.join(literal(x) for x in TARGETS+HELPERS)
    return json.loads(sql("SELECT jsonb_agg(jsonb_build_object('name',p.proname,'signature',p.oid::regprocedure::text,"+
        "'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl)) FROM pg_proc p "+
        "JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ("+names+");",fixture))

def controls():
    return json.loads(sql("SELECT jsonb_build_object('flags',(SELECT jsonb_object_agg(key,enabled) FROM public.admin_feature_flags "+
      "WHERE key<>'automatic_vod_language_fleet_enabled'),'quarantine',(SELECT md5(to_jsonb(j)::text) FROM public.catalog_file_audio_validation_jobs j "+
      "WHERE id='5df2bccb-cae4-47fb-97f1-95c1efdc95b3' AND quarantined_at IS NOT NULL),"+
      "'activePlayback',(SELECT count(*) FROM public.cloud_playback_sessions WHERE status IN ('pending','ready') AND expires_at>now()));"))

def fixture_schema():
    names=','.join(literal(x) for x in TABLES)
    cols=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),"+
       "'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid "+
       "JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum "+
       "WHERE n.nspname='public' AND c.relname IN ("+names+") AND a.attnum>0 AND NOT a.attisdropped;"))
    result=["CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE SCHEMA extensions;",
      "CREATE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS 'SELECT pg_catalog.gen_random_uuid()';",
      "CREATE TABLE auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);"]
    for table in TABLES:
        fields=[f'"{c["name"]}" {c["type"]}'+(' DEFAULT '+c['default'] if c['default'] else '') for c in cols if c['table']==table]
        result.append('CREATE TABLE public.'+table+'('+','.join(fields)+');')
    result += [
      'ALTER TABLE public.cloud_sources ADD PRIMARY KEY(id), ADD UNIQUE(user_id,id);',
      'ALTER TABLE public.cloud_title_variants ADD PRIMARY KEY(id);',
      'ALTER TABLE public.admin_feature_flags ADD PRIMARY KEY(key);',
      'ALTER TABLE public.catalog_file_tracks ADD PRIMARY KEY(server_host,item_type,external_id);',
      'ALTER TABLE public.cloud_title_file_language_observations ADD UNIQUE(user_id,variant_id,file_external_id);',
      'CREATE VIEW public.cloud_catalog_visible_title_variants AS SELECT * FROM public.cloud_title_variants;',
      "CREATE FUNCTION public.norva_source_catalog_visible_internal(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM public.cloud_sources WHERE id=$1 AND user_id=$2 AND enabled AND deleted_at IS NULL AND sync_status='ready')$$;",
    ]
    defs=definitions()
    for name in HELPERS+TARGETS:
        for item in defs:
            if item['name']==name:
                result.append(item['definition']+';')
                if name in TARGETS:result.append('REVOKE ALL ON FUNCTION '+item['signature']+' FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION '+item['signature']+' TO service_role;')
    return '\n'.join(result)

def proof():
    require(PROOF not in gw.run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines(),'proof_container_exists')
    before=definitions();created=False
    try:
        gw.run(['docker','run','-d','--name',PROOF,'--label','norva.purpose='+LABEL,'--network','none',
          '--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777',
          '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
          "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
        created=True
        for _ in range(25):
            if subprocess.run(['docker','exec',PROOF,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
            time.sleep(1)
        sql(fixture_schema(),True)
        sql(artifact(MIGRATION),True)
        sql(artifact('automatic-vod-language-intake.sql'),True)
        sql(artifact('automatic-vod-language-source-scope.sql'),True)
        checks=json.loads(sql('SELECT jsonb_agg(label ORDER BY label) FROM public.fleet_proof_checks;',True))
        after=definitions(True)
        require(definitions()==before,'production_changed_during_proof')
        result={'passed':True,'checks':checks,'migrationSha256':sha(artifact(MIGRATION)),
          'before':before,'after':after,'providerRequests':0,'productionWrites':0,'downstreamFanoutStubbed':False,
          'fixtureLimitations':['synthetic rows','visibility wrapper','production row triggers not copied']}
        if (ROOT/'proof.private.json').exists():
            require(not (ROOT/'plan.private.json').exists(),'cannot_replace_staged_proof')
            (ROOT/'proof.private.json').rename(ROOT/('proof-history-'+str(time.time_ns())+'.private.json'))
        save('proof.private.json',result)
    finally:
        if created:
            c=gw.inspect(PROOF);require(c['HostConfig']['NetworkMode']=='none' and c['Config']['Labels']['norva.purpose']==LABEL,'proof_container_scope_changed')
            gw.run(['docker','rm','-f',c['Id']])
    print(json.dumps({'passed':True,'checks':len(checks),'providerRequests':0,'productionWrites':0,'isolatedContainerRemoved':True,'downstreamFanoutStubbed':False}))

def stage(commit):
    require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'invalid_commit')
    proof=saved('proof.private.json');require(proof['passed'] and proof['migrationSha256']==sha(artifact(MIGRATION)),'proof_mismatch')
    require(definitions()==proof['before'],'production_function_drift')
    originals={name:gw.inspect(name) for name in SERVICES};roots=[lib.edge_root(c) for c in originals.values()]
    require(len(set(roots))==1,'replica_trees_differ');old=roots[0]
    for file in FILES[:2]:require(lib.reviewed_edge_baseline((old/file).read_bytes(),(ROOT/'base'/file).read_bytes()),'edge_baseline_drift')
    before=edge.hashes(old);target=ROOT/'functions';shutil.copytree(old,target)
    for file in FILES:
        path=target/file;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(artifact('candidate/'+file));path.chmod(0o644)
    after=edge.hashes(target)
    require(all(after.get(k)==v for k,v in before.items() if k not in FILES),'unrelated_edge_changed')
    require(set(after)-set(before)=={FILES[2]},'unexpected_new_modules')
    for c in originals.values():lib.edge_health(c)
    plan={'commit':commit,'containers':originals,'before':before,'after':after,
      'runtime':gw.runtime_snapshot(gw.health()),'gatewaySources':gw.source_snapshot(),'controls':controls()}
    require(plan['controls']['quarantine'] is not None,'quarantine_baseline_missing')
    save('plan.private.json',plan)
    print(json.dumps({'staged':True,'commit':commit,'changedFiles':list(FILES),'productionUnchanged':True}))

def unpack():
    require(not (ROOT/'plan.private.json').exists(),'already_staged')
    for kind,files in (('base',FILES[:2]),('candidate',FILES)):
        expected={kind+'/'+name for name in files}
        with tarfile.open(ROOT/(kind+'.tar'),'r:') as archive:
            members=[m for m in archive.getmembers() if not m.isdir()]
            require({m.name for m in members}==expected and len(members)==len(expected),'archive_file_set_changed')
            for member in members:
                require(member.isfile() and member.size<4000000,'unsafe_archive_entry')
                target=ROOT/member.name
                require(not target.exists() and not target.is_symlink(),'archive_target_exists')
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(archive.extractfile(member).read());target.chmod(0o600)
    print(json.dumps({'artifactsUnpacked':True,'files':5,'productionUnchanged':True}))

def deploy_sql():
    proof=saved('proof.private.json');require(definitions()==proof['before'],'function_drift')
    require(sha(artifact(MIGRATION))==proof['migrationSha256'],'migration_drift')
    guards=[]
    for item in proof['before']:
        guards.append("IF md5(pg_get_functiondef("+literal(item['signature'])+"::regprocedure))<>"+
          literal(hashlib.md5(item['definition'].encode()).hexdigest())+" THEN RAISE EXCEPTION 'function drift'; END IF;")
    guarded=artifact(MIGRATION).replace("set local statement_timeout='30s';","set local statement_timeout='30s';\nDO $guard$ BEGIN "+''.join(guards)+" END $guard$;",1)
    sql(guarded,write=True)
    after=definitions()
    expected={r['name']:r['definition'] for r in proof['after']}
    require(all(r['definition']==expected[r['name']] for r in after),'deployed_function_mismatch')
    require(all(r['acl']==next(v['acl'] for v in proof['before'] if v['name']==r['name']) for r in after),'existing_acl_drift')
    save('sql.private.json',{'deployed':True,'migrationSha256':proof['migrationSha256'],'after':after})
    print(json.dumps({'sqlDeployed':True,'automaticIntakeEnabled':False,'existingAclsPreserved':True}))

def verify(name,candidate=True):
    plan=saved('plan.private.json');original=plan['containers'][name];active=gw.inspect(name)
    expected=lib.edge_expected(original,ROOT/'functions') if candidate else original
    gw.assert_clone(expected,active,original['Config']['Image'])
    require(active['Image']==original['Image'],'edge_image_changed')
    require(edge.hashes(lib.edge_root(active))==plan['after' if candidate else 'before'],'edge_tree_changed')
    lib.edge_health(active)
    if candidate:
        env=dict(value.split('=',1) for value in active['Config']['Env'] if '=' in value)
        ip=active['NetworkSettings']['Networks']['norva_default']['IPAddress']
        request=lib.urllib.request.Request('http://'+ip+':9000/norva-playback/health',
          headers={'Authorization':'Bearer '+env.get('NORVA_BACKFILL_TOKEN','')})
        with lib.urllib.request.urlopen(request,timeout=20) as response:
            require(json.load(response).get('automaticVodLanguageIntakeProtocol')==1,'intake_protocol_missing')

def activate(name):
    plan=saved('plan.private.json');original=plan['containers'][name]
    require((ROOT/'sql.private.json').is_file(),'sql_not_deployed');verify(name,False)
    require(gw.source_snapshot()==plan['gatewaySources'],'gateway_changed');gw.assert_runtime(gw.health(),plan['runtime']);gw.assert_idle(gw.health())
    other=SERVICES[1] if name==SERVICES[0] else SERVICES[0];lib.edge_health(gw.inspect(other))
    expected=lib.edge_expected(original,ROOT/'functions');candidate_name=name+'-automatic-language-candidate-20260911'
    created=gw.docker_api('POST','/containers/create?name='+candidate_name,gw.clone_payload(expected,original['Config']['Image']))
    receipt={'candidateContainer':created['Id'],'candidateName':candidate_name};save(name+'-receipt.private.json',receipt)
    gw.assert_clone(expected,gw.inspect(created['Id']),original['Config']['Image']);gw.assert_idle(gw.health())
    try:
        gw.run(['docker','stop','--time','20',original['Id']]);gw.run(['docker','rename',original['Id'],name+'-automatic-language-rollback-20260911'])
        gw.run(['docker','rename',created['Id'],name]);gw.run(['docker','start',created['Id']])
        ready=False
        for _ in range(25):
            try:verify(name);ready=True;break
            except Exception:time.sleep(1)
        require(ready,'candidate_not_ready')
    except Exception:
        edge.restore(name,plan,receipt);verify(name,False)
        raise RuntimeError('candidate_failed_original_restored') from None
    print(json.dumps({'service':name,'healthy':True,'originalRetained':True,'gatewayUnchanged':True}))

def enable():
    plan=saved('plan.private.json')
    for name in SERVICES:verify(name)
    current=controls();require(current['flags']==plan['controls']['flags'] and current['quarantine']==plan['controls']['quarantine'],'control_drift')
    require(gw.source_snapshot()==plan['gatewaySources'],'gateway_changed')
    sql("BEGIN; UPDATE public.admin_feature_flags SET enabled=true,updated_at=now() WHERE key='automatic_vod_language_fleet_enabled'; "+
        "UPDATE public.catalog_enrichment_source_schedule q SET next_run_at=least(q.next_run_at,now()) FROM public.cloud_sources s "+
        "WHERE s.id=q.source_id AND s.user_id=q.user_id AND s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'; COMMIT;",write=True)
    save('activation.private.json',{'enabled':True,'commit':plan['commit']})
    print(json.dumps({'enabled':True,'existingFleetReused':True,'thresholdsAndQuarantinesPreserved':True,'commit':plan['commit']}))

if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        if phase=='proof':proof()
        elif phase=='unpack':unpack()
        elif phase=='stage':stage(sys.argv[2])
        elif phase=='sql':deploy_sql()
        elif phase in ('edge1','edge2'):activate(SERVICES[int(phase[-1])-1])
        elif phase=='enable':enable()
        elif phase=='verify':
            for name in SERVICES:verify(name)
            print(json.dumps({'bothReplicasVerified':True}))
        else:raise RuntimeError('invalid_phase')
    except Exception as error:
        message=str(error)
        print(json.dumps({'ok':False,'error':message if re.fullmatch('[a-z0-9_:-]{1,120}',message) else 'fleet_operator_failed'}))
        sys.exit(1)
