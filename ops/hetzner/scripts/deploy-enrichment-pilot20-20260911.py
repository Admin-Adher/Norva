"""Explicit, recoverable 20-file release. Private receipts, never provider credentials.

preflight/prepare/stage do not contact providers. Every live mutation is a named
phase. Old containers, function trees, failed jobs and quarantines are retained.
The Gateway's signed-file admission fence is authoritative, not this operator.
"""
import copy
import datetime
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
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911')


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


fleet = module('pilot20_fleet', ROOT.parent/'automatic-vod-language-fleet-20260911/deploy-automatic-vod-language-fleet-20260911.py')
fleet.ROOT = ROOT
gw, lib, edge, sql = fleet.gw, fleet.lib, fleet.edge, fleet.sql
require, sha = gw.require, fleet.sha
prior = module('pilot20_prior', ROOT.parent/'language-enrichment-access-20260911/deploy-language-enrichment-access-20260911.py')
pilot = module('pilot20_existing_operator', ROOT.parent/'unknown-vod-pilot-20260911/run-unknown-vod-pilot-20260911.py')
pilot.ROOT = ROOT/'pilot'; pilot.MAX_FILES = 20; pilot.MAX_SECONDS = 24*3600
SERVICES = ('norva-media-gateway', 'norva-edge-functions', 'norva-edge-functions-2', 'norva-selection-audio-worker')
GATEWAY = ('index.js','language-background-capacity.js','enrichment-network-admission.js',
    'selection-enrichment-policy.js','enrichment-pilot-admission.js','strict-lid-capture-store.js',
    'strict-lid-capture-pipeline.js','strict-lid-multi-extract.js','strict-lid-range-reuse.js','passive-lid-capture.js')
gw.MODULES = tuple(dict.fromkeys(gw.MODULES+GATEWAY))
EDGE_FILES = ('norva-playback/index.ts','_shared/automatic-vod-language-fleet.mjs','_shared/selection-audio-gateway.mjs')
MIGRATIONS = ('20260911182400_enrichment_metadata_lane.sql','20260911191032_strict_lid_capture_handoff.sql',
    '20260911200200_selection_audio_capture_handoff.sql','20260911204152_selection_parallel_capture_admission.sql',
    '20260911204928_exact_file_account_enrichment_admission.sql')
FLAGS = ('language_metadata_lane_enabled','language_capture_pipeline_enabled','selection_capture_pipeline_enabled',
    'selection_parallel_capture_enabled','language_exact_file_admission_enabled')


def saved(name): return json.loads(gw.safe_file(ROOT,name).read_text())
def save(name,value): gw.private_write(ROOT/name,value)
def artifact(name): return gw.safe_file(ROOT,name).read_bytes().replace(b'\r\n',b'\n')
def stamp(): return datetime.datetime.now(datetime.timezone.utc).isoformat()


def controls():
    return json.loads(sql("SELECT jsonb_build_object('flags',(SELECT jsonb_object_agg(key,enabled) FROM public.admin_feature_flags),"
        "'quarantine',(SELECT md5(to_jsonb(j)::text) FROM public.catalog_file_audio_validation_jobs j "
        "WHERE id='5df2bccb-cae4-47fb-97f1-95c1efdc95b3' AND quarantined_at IS NOT NULL));"))


def invariant(plan):
    value=controls()
    require(value['quarantine']==plan['controls']['quarantine'],'quarantine_changed')
    require({k:v for k,v in value['flags'].items() if k not in FLAGS} ==
        {k:v for k,v in plan['controls']['flags'].items() if k not in FLAGS},'unrelated_flags_changed')


def preflight():
    h=gw.health()
    selection=json.loads(sql("SELECT coalesce(jsonb_agg(x),'[]') FROM (SELECT state,count(*) FROM public.catalog_selection_audio_jobs GROUP BY state)x;"))
    print(json.dumps({'checkedAt':stamp(),'health':{k:h.get(k) for k in ('ok','activeSessions','activeStrictLidBrokers',
        'whisperInferenceActive','languageBackgroundCapacity')},'crons':prior.crons(), 'selectionQueue':selection,
        'protectedQuarantinePresent':controls()['quarantine'] is not None,'oldPilotProcessActive':pilot.process_active()}))


def prepare():
    require(not (ROOT/'cohort.private.json').exists(),'cohort_already_prepared')
    rows=pilot.filter_provider_labels(pilot.query(pilot.candidate_sql()))
    # Prefer a mixture of already inventoried unknown tracks and unprobed files.
    # Never select an existing terminal/failed/quarantined validation job.
    ready=pilot.choose([r for r in rows if r['has_track_map']],10)
    chosen=ready+pilot.choose([r for r in rows if (r['identity_key'],r['external_id']) not in
        {(x['identity_key'],x['external_id']) for x in ready}],20-len(ready))
    require(len(chosen)==20,'insufficient_eligible_new_files')
    for n,row in enumerate(chosen,1):
        row['sample']=n
        row['fileKey']=sha(json.dumps(['provider',row['identity_key'],'movie',row['external_id']],separators=(',',':')))
    require(len({r['fileKey'] for r in chosen})==20,'duplicate_cohort')
    save('cohort.private.json',{'protocol':1,'preparedAt':stamp(),'rows':chosen})
    print(json.dumps({'prepared':20,'providers':len({r['identity_key'] for r in chosen}),
        'sourceAccounts':len({r['source_id'] for r in chosen}),'withTrackMap':len(ready),
        'selectionIncluded':0,'selectionReason':'no_nonterminal_jobs_available','providerRequests':0}))


def unpack():
    require(not (ROOT/'candidate').exists(),'already_unpacked')
    with tarfile.open(ROOT/'release.tar.gz') as archive:
        members=archive.getmembers()
        require(len(members)<150 and sum(m.size for m in members)<30000000,'archive_size')
        names=set()
        for m in members:
            require(m.isfile() and 0<m.size<5000000 and m.name not in names,'archive_member')
            names.add(m.name)
            require(m.name=='release-manifest.json' or m.name.startswith(('base/','candidate/','selection/')),'archive_scope')
            target=ROOT/m.name
            require(target.resolve().is_relative_to(ROOT.resolve()) and not target.exists(),'archive_path')
        for m in members:
            target=ROOT/m.name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            target.write_bytes(archive.extractfile(m).read());target.chmod(0o600)
    manifest=saved('release-manifest.json')
    require(set(manifest['files'])==names-{'release-manifest.json'},'manifest_scope')
    for name,digest in manifest['files'].items(): require(sha(artifact(name))==digest,'artifact_hash_mismatch')
    print(json.dumps({'unpacked':True,'files':len(names)-1,'providerRequests':0}))


def mount_replace(original,destination,target):
    result=copy.deepcopy(original); found=0
    binds=[]
    for bind in result['HostConfig'].get('Binds') or []:
        parts=bind.split(':')
        if parts[1]==target: parts[0]=str(destination);found+=1
        binds.append(':'.join(parts))
    require(found==1,'mount_missing_or_ambiguous')
    result['HostConfig']['Binds']=binds
    for item in result['Mounts']:
        if item['Destination']==target:item['Source']=str(destination)
    return result


def environment(original,values):
    result=copy.deepcopy(original)
    old=[v for v in result['Config']['Env'] if v.split('=',1)[0] not in values]
    result['Config']['Env']=old+[k+'='+str(v) for k,v in values.items()]
    return result


def expected_container(plan,name):
    original=plan['containers'][name]
    if name==SERVICES[0]:
        expected=environment(original,plan['gatewayEnv'])
        private=str(ROOT/'audio-private')
        expected['HostConfig']['Binds']=(expected['HostConfig'].get('Binds') or [])+[private+':/var/lib/norva-lid-private:rw']
        expected['Mounts'].append({'Type':'bind','Source':private,'Destination':'/var/lib/norva-lid-private','Mode':'rw','RW':True,'Propagation':'rprivate'})
        return expected
    if name in SERVICES[1:3]:return lib.edge_expected(original,ROOT/'functions')
    # Keep the dormant Selection worker on the verified new import graph. There
    # are no eligible Selection jobs in this pilot; no old failed jobs are reset.
    expected=environment(original,{'SELECTION_CAPTURE_PIPELINE_ENABLED':'0','SELECTION_AUDIO_CONCURRENCY':'1'})
    for target,subdir in plan['selectionMounts'].items():expected=mount_replace(expected,ROOT/subdir,target)
    return expected


def stage():
    manifest=saved('release-manifest.json');cohort=saved('cohort.private.json')
    require(re.fullmatch('[a-f0-9]{40}',manifest['commit']) is not None,'commit_invalid')
    require(not (ROOT/'plan.private.json').exists(),'already_staged')
    receipts=sorted((ROOT.parent/'enrichment-pipeline-proof-20260911').glob('proof-*.json'),key=lambda p:p.stat().st_mtime)
    require(bool(receipts) and time.time()-receipts[-1].stat().st_mtime<3600,'fresh_sql_proof_required')
    proof=json.loads(receipts[-1].read_text())
    require(proof.get('passed') is True and len(proof.get('checks',[]))>=171 and proof.get('productionWrites')==0,'sql_proof_invalid')
    proof_keys=('migrationSha256','captureMigrationSha256','selectionCaptureMigrationSha256','selectionParallelMigrationSha256','exactFileAdmissionMigrationSha256')
    for name,key in zip(MIGRATIONS,proof_keys):require(proof.get(key)==sha(artifact('candidate/supabase/migrations/'+name)),'sql_proof_artifact_mismatch')
    for name,digest in manifest['files'].items():require(sha(artifact(name))==digest,'stage_artifact_drift')
    originals={n:gw.inspect(n) for n in SERVICES};gateway=originals[SERVICES[0]]
    gw.assert_image_backed_runtime(gateway)
    baseline=gw.source_snapshot()
    for name in GATEWAY:
        path='base/services/media-gateway/src/'+name
        require(baseline[name]==(sha(artifact(path)) if path in manifest['files'] else None),'gateway_source_drift:'+name)
    old=lib.edge_root(originals[SERVICES[1]])
    require(lib.edge_root(originals[SERVICES[2]])==old,'edge_trees_differ')
    for name in EDGE_FILES:
        require(lib.reviewed_edge_baseline((old/name).read_bytes(),artifact('base/supabase/functions/'+name)), 'edge_source_drift')
    before=edge.hashes(old);shutil.copytree(old,ROOT/'functions')
    for name in EDGE_FILES:
        target=ROOT/'functions'/name;target.write_bytes(artifact('candidate/supabase/functions/'+name));target.chmod(0o644)
    after=edge.hashes(ROOT/'functions')
    require(set(before)==set(after) and all(after[k]==v for k,v in before.items() if k not in EDGE_FILES),'unrelated_edge_changed')
    selection=originals[SERVICES[3]];selection_mounts={}
    # Preserve the existing worker's bind layout. Its private input trees are
    # copied in full and only manifest-scoped JS modules are replaced.
    for mount in selection['Mounts']:
        target=mount['Destination']
        if target in ('/worker/ops/hetzner/services','/worker/supabase/functions'):
            subdir='selection-live-'+('runner' if target.endswith('/services') else 'functions')
            source=pathlib.Path(mount['Source'])
            require(source.is_dir() and not source.is_symlink() and source.resolve().is_relative_to(ROOT.parent),'selection_mount_scope')
            shutil.copytree(source,ROOT/subdir);selection_mounts[target]=subdir
    require(len(selection_mounts)==2,'selection_layout_changed')
    package=saved('selection/manifest.json')
    for entry in package['files']:
        layout,relative=entry['target'].split('/',1)
        target=ROOT/('selection-live-'+layout)/relative
        if target.exists():
            require('base/'+entry['source'] in manifest['files'] and lib.reviewed_edge_baseline(
                target.read_bytes(),artifact('base/'+entry['source'])),'selection_source_drift')
        else:require(entry['source']=='ops/hetzner/services/selection-audio-task-pool.mjs','selection_existing_module_missing')
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(artifact('selection/'+entry['target']));target.chmod(0o644)
    context=ROOT/'build-context';context.mkdir(mode=0o700)
    for name in GATEWAY:(context/name).write_bytes(artifact('candidate/services/media-gateway/src/'+name))
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in GATEWAY))
    old_identity=gw.image_identity(gateway['Config']['Image']);gw.assert_container_image(gateway,old_identity)
    base='norva-enrichment-pilot20-base:20260911';image='norva-media-gateway:enrichment-pilot20-20260911'
    gw.run(['docker','tag',old_identity['index'],base])
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base,'-t',image,str(context)])
    for name in GATEWAY:gw.run(['docker','run','--rm','--network','none','--read-only','--cpus','1','--memory','512m','--entrypoint','node',image,'--check','/app/src/'+name])
    uid=int(gw.run(['docker','exec',gateway['Id'],'id','-u']).decode().strip())
    gid=int(gw.run(['docker','exec',gateway['Id'],'id','-g']).decode().strip())
    private=ROOT/'audio-private';private.mkdir(mode=0o700)
    require(uid==os.getuid() and gid==os.getgid(),'private_volume_owner_mismatch')
    created=time.time();expires=created+24*3600
    gate={'protocol':1,'createdAt':datetime.datetime.fromtimestamp(created,datetime.timezone.utc).isoformat(),
        'expiresAt':datetime.datetime.fromtimestamp(expires,datetime.timezone.utc).isoformat(),'fileKeys':[r['fileKey'] for r in cohort['rows']]}
    env={'LANGUAGE_ENRICHMENT_ACTIVATION_MODE':'pilot','LANGUAGE_ENRICHMENT_PILOT_JSON':json.dumps(gate,separators=(',',':')),
        'LANGUAGE_METADATA_LANE_ENABLED':'1','LANGUAGE_CAPTURE_PIPELINE_ENABLED':'1','LANGUAGE_CAPTURE_PRIVATE_DIR':'/var/lib/norva-lid-private',
        'LANGUAGE_PASSIVE_CAPTURE_ENABLED':'0','LANGUAGE_HOST_ADAPTIVE_ADMISSION_ENABLED':'1','SELECTION_ENRICHMENT_POLICY_JSON':''}
    plan={'commit':manifest['commit'],'containers':originals,'controls':controls(),'crons':prior.crons(),
        'edgeBefore':before,'edgeAfter':after,'selectionMounts':selection_mounts,
        'selectionAfter':{target:edge.hashes(ROOT/subdir) for target,subdir in selection_mounts.items()},
        'sourceBefore':baseline,'sourceAfter':{**baseline,**{n:sha(artifact('candidate/services/media-gateway/src/'+n)) for n in GATEWAY}},
        'runtime':gw.runtime_snapshot(gw.health()),'binaries':gw.binary_snapshot(),'image':image,
        'imageIdentity':gw.image_identity(image),'oldImageIdentity':old_identity,'gatewayEnv':env,'gate':gate,
        'migrations':{n:sha(artifact('candidate/supabase/migrations/'+n)) for n in MIGRATIONS}}
    require(plan['controls']['quarantine'] is not None,'quarantine_absent');save('plan.private.json',plan)
    pilot.ROOT.mkdir(mode=0o700)
    sample={'protocol':1,'preparedAt':stamp(),'preparedEpoch':created,'expiresEpoch':expires,
        'gatewaySha256':plan['sourceAfter']['index.js'],'rows':cohort['rows']}
    pilot.validate(sample);pilot.save(pilot.ROOT/'plan.private.json',sample,True)
    pilot.save(pilot.ROOT/'state.private.json',{'planSha256':sha((pilot.ROOT/'plan.private.json').read_bytes()),
        'rows':{str(r['sample']):{'state':'planned','probeAttempts':0} for r in sample['rows']},'updatedAt':stamp()},True)
    print(json.dumps({'staged':True,'commit':plan['commit'],'pilotFiles':20,'privateBytes':64*1024*1024,
        'encryptedLimitBytes':32*1024*1024,'ttlSeconds':1800,'productionUnchanged':True}))


def pause():
    plan=saved('plan.private.json');invariant(plan)
    prior.alter_crons(plan,True)
    print(json.dumps({'twoIntakeCronsPaused':True,'waitingForOwnedWorkToDrain':True}))


def idle():
    prior.idle()
    require(json.loads(sql("SELECT jsonb_build_object('selection',(SELECT count(*) FROM public.catalog_selection_audio_jobs WHERE state='running' AND lease_until>now()),"
        "'account',(SELECT count(*) FROM public.provider_account_language_validation_leases WHERE expires_at>now()));"))=={'selection':0,'account':0},'provider_leases_active')


def database():
    plan=saved('plan.private.json');invariant(plan);idle()
    require(prior.crons()==[{**j,'active':False} for j in plan['crons']],'crons_not_paused')
    for name in MIGRATIONS:
        receipt='migration-'+name+'.json'
        if (ROOT/receipt).exists():continue
        body=artifact('candidate/supabase/migrations/'+name)
        require(sha(body)==plan['migrations'][name],'migration_drift')
        sql(body.decode(),write=True);save(receipt,{'sha256':sha(body),'appliedAt':stamp()})
    invariant(plan)
    flags=controls()['flags'];require(all(flags.get(k) is False for k in FLAGS),'new_flags_not_disabled')
    save('database-applied.json',{'applied':True,'migrations':plan['migrations']})
    print(json.dumps({'migrationsApplied':5,'newFlagsDisabled':True,'quarantinePreserved':True}))


def verify_service(name,plan,candidate=True):
    current=gw.inspect(name);original=plan['containers'][name]
    expected=expected_container(plan,name) if candidate else original
    image=plan['image'] if candidate and name==SERVICES[0] else original['Config']['Image']
    gw.assert_clone(expected,current,image)
    if name==SERVICES[0]:
        gw.assert_container_image(current,plan['imageIdentity'] if candidate else plan['oldImageIdentity'])
        require(gw.source_snapshot()==plan['sourceAfter' if candidate else 'sourceBefore'],'gateway_hash_mismatch')
        require(gw.binary_snapshot()==plan['binaries'],'runtime_binary_changed');gw.assert_runtime(gw.health(),plan['runtime'])
        if candidate:
            h=gw.health();p=h.get('languageEnrichmentPilot',{})
            require(p.get('mode')=='pilot' and p.get('files')==20 and not p.get('expired'),'pilot_fence_missing')
    elif name in SERVICES[1:3]:
        require(edge.hashes(lib.edge_root(current))==plan['edgeAfter' if candidate else 'edgeBefore'],'edge_hash_mismatch')
        lib.edge_health(current)
    else:
        require(current['Image']==original['Image'],'selection_image_changed')
        if candidate:
            for target,subdir in plan['selectionMounts'].items():require(edge.hashes(ROOT/subdir)==plan['selectionAfter'][target],'selection_hash_mismatch')
    require(current['State']['Running'] and current['RestartCount']==0 and not current['State']['OOMKilled'],'container_not_healthy')


def deploy(name):
    plan=saved('plan.private.json');require(saved('database-applied.json')['applied'],'database_missing');invariant(plan);idle()
    receipt_name=name+'-receipt.private.json';require(not (ROOT/receipt_name).exists(),'already_deployed')
    original=plan['containers'][name];require(gw.inspect(name)['Id']==original['Id'],'container_drift')
    verify_service(name,plan,False)
    expected=expected_container(plan,name);image=plan['image'] if name==SERVICES[0] else original['Config']['Image']
    created=gw.docker_api('POST','/containers/create?name='+name+'-pilot20-candidate',gw.clone_payload(expected,image))
    receipt={'candidateContainer':created['Id'],'candidateName':name+'-pilot20-candidate'};save(receipt_name,receipt)
    gw.assert_clone(expected,gw.inspect(created['Id']),image);idle()
    try:
        gw.run(['docker','stop','--time','20',original['Id']]);gw.run(['docker','rename',original['Id'],name+'-pilot20-rollback'])
        gw.run(['docker','rename',created['Id'],name]);gw.run(['docker','start',created['Id']])
        ready=False
        for _ in range(25):
            try:verify_service(name,plan);ready=True;break
            except Exception:time.sleep(1)
        require(ready,'candidate_unhealthy')
    except Exception:
        edge.restore(name,{'containers':plan['containers']},receipt)
        verify_service(name,plan,False)
        raise RuntimeError('candidate_failed_original_restored') from None
    print(json.dumps({'service':name,'healthy':True,'originalRetained':True,'commit':plan['commit']}))


def verify(enable=False):
    plan=saved('plan.private.json');invariant(plan)
    for name in SERVICES:verify_service(name,plan)
    if enable:
        # Selection remains dormant: all its current unknown jobs are terminal.
        sql("UPDATE public.admin_feature_flags SET enabled=true WHERE key IN ('language_metadata_lane_enabled','language_capture_pipeline_enabled','language_exact_file_admission_enabled');",write=True)
    h=gw.health();invariant(plan)
    result={'checkedAt':stamp(),'commit':plan['commit'],'allServicesVerified':True,
        'pilot':h.get('languageEnrichmentPilot'),'network':h.get('languageSelectionAdmission'),
        'buffer':h.get('languageCaptureBuffer'),'quarantinePreserved':True}
    save('verify-'+str(time.time_ns())+'.json',result);print(json.dumps(result))


if __name__=='__main__':
    os.umask(0o077)
    try:
        require(ROOT.is_dir() and not ROOT.is_symlink(),'release_root_missing')
        phase=sys.argv[1]
        if phase in ('preflight','prepare','unpack','stage','pause','database','idle'):globals()[phase]()
        elif phase in ('gateway','edge1','edge2','selection'):deploy(SERVICES[('gateway','edge1','edge2','selection').index(phase)])
        elif phase in ('verify','enable'):verify(phase=='enable')
        else:raise RuntimeError('unknown_phase')
    except Exception as error:
        code=str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'pilot20_release_failed'}))
        sys.exit(1)
