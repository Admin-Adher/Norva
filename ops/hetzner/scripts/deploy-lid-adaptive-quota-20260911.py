"""Scoped quota/capacity release: isolated SQL proof, staged build, rolling release.

Uses existing audited container-clone helpers. Never modifies the live checkout,
provider credentials, old audio, model binaries, thresholds or quarantines.
"""
import concurrent.futures
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

ROOT=pathlib.Path('/home/adrien/.norva/lid-adaptive-quota-20260911')
spec=importlib.util.spec_from_file_location('fleet',ROOT.parent/'automatic-vod-language-fleet-20260911/deploy-automatic-vod-language-fleet-20260911.py')
fleet=importlib.util.module_from_spec(spec);spec.loader.exec_module(fleet)
fleet.ROOT=ROOT
gw=fleet.gw;lib=fleet.lib;require=gw.require;sha=fleet.sha;sql=fleet.sql
MIGRATION='20260911123735_lid_adaptive_quota.sql'
fleet.PROOF='norva-lid-quota-proof-20260911';fleet.LABEL='lid-quota-proof-20260911'
fleet.TABLES+=('catalog_vod_language_sweeps','catalog_vod_language_intake')
fleet.HELPERS+=('vod_language_profile_is_exact',)
fleet.TARGETS+=('start_catalog_file_audio_validation_job','claim_catalog_file_audio_validation_job',
    'list_due_catalog_file_audio_validation_jobs','claim_catalog_vod_language_file','finish_catalog_vod_language_file')
gw.MODULES+=('language-background-capacity.js','codec-probe-diagnostic.js')
SERVICES=('norva-media-gateway','norva-edge-functions','norva-edge-functions-2')
EDGE='supabase/functions/norva-playback/index.ts'
GATEWAY=('index.js','language-background-capacity.js','codec-probe-diagnostic.js')
FILES=(EDGE,)+tuple('services/media-gateway/src/'+name for name in GATEWAY)
artifact=fleet.artifact;save=fleet.save;saved=fleet.saved


def save_snapshot(name,value):
    # Repeated verification is read-only in production. Keep the previous local
    # receipt instead of failing after the live verification/activation succeeds.
    if (ROOT/name).exists():
        gw.safe_file(ROOT,name).rename(ROOT/(name+'.history-'+str(time.time_ns())))
    save(name,value)


def controls():
    return json.loads(sql("SELECT jsonb_build_object('flags',(SELECT jsonb_object_agg(key,enabled) FROM public.admin_feature_flags WHERE key<>'adaptive_language_admission_enabled'),"
      "'quarantine',(SELECT md5((to_jsonb(j)-'request_origin')::text) FROM public.catalog_file_audio_validation_jobs j WHERE id='5df2bccb-cae4-47fb-97f1-95c1efdc95b3' AND quarantined_at IS NOT NULL));"))


def proof():
    require(not (ROOT/'plan.private.json').exists(),'already_staged')
    before=fleet.definitions();created=False
    require(fleet.PROOF not in gw.run(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines(),'fixture_exists')
    try:
        gw.run(['docker','run','-d','--name',fleet.PROOF,'--label','norva.purpose='+fleet.LABEL,'--network','none',
          '--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,nosuid,size=384m,mode=1777',
          '--user','postgres','--entrypoint','/bin/sh','supabase/postgres:17.6.1.136','-c',
          "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
        created=True
        for _ in range(25):
            if subprocess.run(['docker','exec',fleet.PROOF,'pg_isready','-h','/tmp','-U','postgres'],capture_output=True).returncode==0:break
            time.sleep(1)
        sql(fleet.fixture_schema()+'''
ALTER TABLE public.catalog_file_audio_validation_jobs ADD PRIMARY KEY(id);
CREATE UNIQUE INDEX quota_fixture_active_file ON public.catalog_file_audio_validation_jobs(identity_key,item_type,external_id)
WHERE state IN ('queued','running','retry_wait','finalizing');
ALTER TABLE public.catalog_vod_language_sweeps ADD PRIMARY KEY(source_id);
ALTER TABLE public.catalog_vod_language_intake ADD PRIMARY KEY(variant_id);
''',True)
        sql(artifact(MIGRATION),True)
        sql(artifact('language-adaptive-admission.sql'),True)
        # Four independent SQL connections contend for two shared execution
        # slots. No mock replaces the actual worker claim body or its locks.
        sql("SELECT public.report_catalog_language_capacity(2,'capacity-available',clock_timestamp());",True)
        def claim(n):
            return sql("SELECT public.claim_catalog_file_audio_validation_job(id,'parallel-"+str(n)+"',300) IS NOT NULL FROM public.catalog_file_audio_validation_jobs WHERE external_id='"+str(n)+"';",True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            result=list(pool.map(claim,[55,56,57,59]))
        require(result.count('t')==2 and result.count('f')==2,'concurrent_admission_exceeded_capacity')
        sql("SELECT public.quota_assert((SELECT count(*)=2 FROM public.catalog_file_audio_validation_jobs WHERE state='running'),'concurrent_execution_exact_ceiling');",True)
        checks=json.loads(sql('SELECT jsonb_agg(label ORDER BY label) FROM public.quota_proof_checks;',True))
        after=fleet.definitions(True)
        require(fleet.definitions()==before,'production_drift_during_proof')
        if (ROOT/'proof.private.json').exists():
            gw.safe_file(ROOT,'proof.private.json').rename(ROOT/('proof-history-'+str(time.time_ns())+'.private.json'))
        save('proof.private.json',{'passed':True,'checks':checks,'before':before,'after':after,
          'migrationSha256':sha(artifact(MIGRATION)),'fixtureLimitations':['synthetic data','visibility wrapper','row triggers not copied']})
    finally:
        if created:
            c=gw.inspect(fleet.PROOF);require(c['HostConfig']['NetworkMode']=='none' and c['Config']['Labels']['norva.purpose']==fleet.LABEL,'fixture_scope_changed')
            gw.run(['docker','rm','-f',c['Id']])
    print(json.dumps({'passed':True,'checks':len(checks),'providerRequests':0,'productionWrites':0,'fixtureRemoved':True}))


def unpack():
    require(not (ROOT/'plan.private.json').exists(),'already_staged')
    for kind,expected in [('base',{EDGE,'services/media-gateway/src/index.js'}),('candidate',set(FILES))]:
        with tarfile.open(ROOT/(kind+'.tar'),'r:') as archive:
            members=[m for m in archive.getmembers() if not m.isdir()]
            require({m.name for m in members}==expected and len(members)==len(expected),'archive_scope_changed')
            for m in members:
                require(m.isfile() and m.size<4000000,'unsafe_archive_member')
                target=ROOT/kind/m.name
                require(not target.exists() and not target.is_symlink(),'unpack_target_exists')
                target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(m).read());target.chmod(0o600)
    print(json.dumps({'unpacked':True,'productionUnchanged':True}))


def stage(commit):
    require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'invalid_commit')
    require(not (ROOT/'plan.private.json').exists(),'already_staged')
    proof=saved('proof.private.json');require(proof['passed'] and proof['migrationSha256']==sha(artifact(MIGRATION)),'proof_mismatch')
    require(fleet.definitions()==proof['before'],'function_drift')
    originals={name:gw.inspect(name) for name in SERVICES};gateway=originals[SERVICES[0]]
    gw.assert_image_backed_runtime(gateway)
    baseline=gw.source_snapshot();require(baseline['index.js']==sha(artifact('base/services/media-gateway/src/index.js')),'gateway_source_drift')
    require(all(baseline[name] is None for name in GATEWAY[1:]),'new_module_already_exists')
    old=lib.edge_root(originals[SERVICES[1]])
    require(lib.edge_root(originals[SERVICES[2]])==old,'edge_trees_differ')
    require(lib.reviewed_edge_baseline((old/'norva-playback/index.ts').read_bytes(),(ROOT/'base'/EDGE).read_bytes()),'edge_source_drift')
    before=fleet.edge.hashes(old);shutil.copytree(old,ROOT/'functions')
    target=ROOT/'functions/norva-playback/index.ts';target.write_text(artifact('candidate/'+EDGE));target.chmod(0o644)
    after=fleet.edge.hashes(ROOT/'functions')
    require(set(before)==set(after) and all(after[k]==v for k,v in before.items() if k!='norva-playback/index.ts'),'unrelated_edge_changed')
    context=ROOT/'build-context';context.mkdir(mode=0o700)
    for name in GATEWAY:(context/name).write_text(artifact('candidate/services/media-gateway/src/'+name))
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in GATEWAY))
    identity=gw.image_identity(gateway['Config']['Image']);gw.assert_container_image(gateway,identity)
    base='norva-lid-adaptive-quota-base:20260911';image='norva-media-gateway:lid-adaptive-quota-20260911'
    gw.run(['docker','tag',identity['index'],base])
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base,'-t',image,str(context)])
    for name in GATEWAY:gw.run(['docker','run','--rm','--network','none','--read-only','--cpus','1','--memory','512m','--entrypoint','node',image,'--check','/app/src/'+name])
    expected=dict(baseline);expected.update({name:sha(artifact('candidate/services/media-gateway/src/'+name)) for name in GATEWAY})
    plan={'commit':commit,'containers':originals,'edgeBefore':before,'edgeAfter':after,'sourceBefore':baseline,'sourceAfter':expected,
      'runtime':gw.runtime_snapshot(gw.health()),'binaries':gw.binary_snapshot(),'controls':controls(),
      'image':image,'imageIdentity':gw.image_identity(image),'oldImageIdentity':identity,'migrationSha256':proof['migrationSha256']}
    require(plan['controls']['quarantine'] is not None,'quarantine_absent')
    save('plan.private.json',plan)
    print(json.dumps({'staged':True,'commit':commit,'productionUnchanged':True}))


def verified_database(proof):
    current={item['signature']:item for item in fleet.definitions()}
    expected={item['signature']:item for item in proof['after']}
    baseline={item['signature']:item for item in proof['before']}
    require(set(current)==set(expected)==set(baseline),'database_function_set_changed')
    # The networkless fixture is owned by postgres. Production keeps its own
    # original owners/ACLs; only function bodies should match the fixture.
    for signature,item in current.items():
        require(item['definition']==expected[signature]['definition'],'migration_function_mismatch')
        require(all(item[key]==baseline[signature][key] for key in ('owner','acl')),'production_function_privileges_changed')
    safe=sql("SELECT (SELECT count(*)=3 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('report_catalog_language_capacity','catalog_language_execution_available','catalog_language_queue_available') AND p.prosecdef AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')) AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.catalog_language_capacity'::regclass) AND NOT has_table_privilege('authenticated','public.catalog_language_capacity','SELECT');")
    require(safe=='t','capacity_permissions_failed')


def database(resume=False):
    plan=saved('plan.private.json');proof=saved('proof.private.json')
    if not resume:require(fleet.definitions()==proof['before'],'function_drift')
    require(controls()==plan['controls'],'controls_drift')
    require(sha(artifact(MIGRATION))==plan['migrationSha256'],'migration_drift')
    if not resume:sql(artifact(MIGRATION),write=True)
    verified_database(proof)
    require(controls()==plan['controls'],'controls_changed')
    save('database-applied.json',{'applied':True,'migrationSha256':plan['migrationSha256']})
    print(json.dumps({'migrationApplied':True,'automaticAdmissionStillPaused':True,'quarantinePreserved':True}))


def verify_service(name,plan,candidate=True):
    current=gw.inspect(name);original=plan['containers'][name]
    if name==SERVICES[0]:
        gw.assert_clone(original,current,plan['image'] if candidate else original['Config']['Image'])
        gw.assert_container_image(current,plan['imageIdentity'] if candidate else plan['oldImageIdentity'])
        require(gw.source_snapshot()==plan['sourceAfter' if candidate else 'sourceBefore'],'gateway_source_mismatch')
        require(gw.binary_snapshot()==plan['binaries'],'model_binary_changed')
        health=gw.health();gw.assert_runtime(health,plan['runtime'])
        if candidate:require(health.get('languageBackgroundCapacity',{}).get('protocol')==1,'capacity_protocol_missing')
    else:
        expected=lib.edge_expected(original,ROOT/'functions') if candidate else original
        gw.assert_clone(expected,current,original['Config']['Image'])
        require(current['Image']==original['Image'],'edge_image_changed')
        require(fleet.edge.hashes(lib.edge_root(current))==plan['edgeAfter' if candidate else 'edgeBefore'],'edge_tree_changed')
        lib.edge_health(current)
    require(current['RestartCount']==0 and not current['State']['OOMKilled'],'restart_or_oom')
    return True


def activate(name):
    plan=saved('plan.private.json');require(saved('database-applied.json')['applied'],'database_not_applied')
    receipt_name=name+'-receipt.private.json';require(not (ROOT/receipt_name).exists(),'already_deployed')
    original=plan['containers'][name];require(gw.inspect(name)['Id']==original['Id'],'container_drift')
    verify_service(name,plan,False);gw.assert_idle(gw.health())
    if name!=SERVICES[0]:
        verify_service(SERVICES[0],plan)
        lib.edge_health(gw.inspect(SERVICES[2] if name==SERVICES[1] else SERVICES[1]))
    expected=original if name==SERVICES[0] else lib.edge_expected(original,ROOT/'functions')
    image=plan['image'] if name==SERVICES[0] else original['Config']['Image']
    candidate_name=name+'-quota-candidate-20260911'
    created=gw.docker_api('POST','/containers/create?name='+candidate_name,gw.clone_payload(expected,image))
    receipt={'candidateContainer':created['Id'],'candidateName':candidate_name};save(receipt_name,receipt)
    gw.assert_clone(expected,gw.inspect(created['Id']),image);gw.assert_idle(gw.health())
    try:
        gw.run(['docker','stop','--time','20',original['Id']]);gw.run(['docker','rename',original['Id'],name+'-quota-rollback-20260911'])
        gw.run(['docker','rename',created['Id'],name]);gw.run(['docker','start',created['Id']])
        ready=False
        for _ in range(25):
            try:verify_service(name,plan);ready=True;break
            except Exception:time.sleep(1)
        require(ready,'candidate_unhealthy')
    except Exception:
        fleet.edge.restore(name,{'containers':plan['containers']},receipt)
        verify_service(name,plan,False)
        raise RuntimeError('candidate_failed_original_restored') from None
    print(json.dumps({'service':name,'healthy':True,'commit':plan['commit'],'limitsAndEnvironmentPreserved':True,'originalRetained':True}))


def verify(enable=False):
    plan=saved('plan.private.json')
    for name in SERVICES:verify_service(name,plan)
    verified_database(saved('proof.private.json'))
    require(controls()==plan['controls'],'controls_drift')
    health=gw.health();require(health['languageBackgroundCapacity']['reason']!='capacity-unavailable','telemetry_not_ready')
    if enable:
        sql("UPDATE public.admin_feature_flags SET enabled=true WHERE key='adaptive_language_admission_enabled' AND NOT enabled;",write=True)
    status=json.loads(sql("SELECT jsonb_build_object('enabled',(SELECT enabled FROM public.admin_feature_flags WHERE key='adaptive_language_admission_enabled'),"
      "'jobs',(SELECT jsonb_agg(t) FROM (SELECT request_origin,state,count(*) FROM public.catalog_file_audio_validation_jobs GROUP BY request_origin,state)t),"
      "'capacity',(SELECT to_jsonb(c) FROM public.catalog_language_capacity c));"))
    result={'productionVerified':True,'commit':plan['commit'],'services':list(SERVICES),'capacity':health['languageBackgroundCapacity'],
      'status':status,'runtimeAndThresholdsPreserved':True,'checkedAt':time.time()}
    save_snapshot('production-proof.json',result);print(json.dumps(result))


if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        if phase=='proof':proof()
        elif phase=='unpack':unpack()
        elif phase=='stage':stage(sys.argv[2])
        elif phase=='database':database()
        elif phase=='database-verify':database(True)
        elif phase=='gateway':activate(SERVICES[0])
        elif phase=='edge1':activate(SERVICES[1])
        elif phase=='edge2':activate(SERVICES[2])
        elif phase=='enable':verify(True)
        elif phase=='verify':verify()
        else:raise RuntimeError('invalid_phase')
    except Exception as error:
        message=str(error)
        print(json.dumps({'ok':False,'error':message if re.fullmatch('[a-z0-9_:-]{1,120}',message) else 'quota_release_failed'}))
        sys.exit(1)
