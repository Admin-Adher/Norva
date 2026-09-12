"""Explicit post-closure subset, never a replacement cohort or quarantine reset.

Private immutable plans bind the original twenty, the nine authorized remaining
samples, current eligibility, unchanged attempts and the original deadline.
Only the still-admissible subset reaches the Gateway's exact-file fence.
"""
import copy
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import time

PARENT=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911')
ROOT=PARENT/'resume9-20260912'
if pathlib.Path(__file__).resolve().parent==PARENT/'resume9-normalized-20260912':
    ROOT=PARENT/'resume9-normalized-20260912'
spec=importlib.util.spec_from_file_location('parent_release',PARENT/'deploy-enrichment-pilot20-20260911.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
gw,prior,sql,fleet,require,sha=d.gw,d.prior,d.sql,d.fleet,d.require,d.sha
pilot=d.pilot;pilot.ROOT=ROOT/'pilot'
FILES=('index.js','strict-lid-capture-pipeline.js','strict-lid-multi-extract.js','enrichment-pilot-admission.js')
TERMINAL={'completed','verified','failed','expired','cancelled'}
IMAGE='norva-media-gateway:enrichment-pilot9-proxy-diagnostic-20260912'


def stamp():return d.stamp()
def saved(name):return pilot.private(ROOT/name)
def save(name,value):gw.private_write(ROOT/name,value)


def canonical_source(raw):
    # The live source attestation normalizes CRLF. Normalize the build input,
    # too, so the immutable plan and the dispatch guard attest identical bytes.
    return raw.replace(b'\r\n',b'\n')


def select_remaining(original,old_state,values):
    authorized=[r for r in original['rows'] if old_state['rows'][str(r['sample'])]['state'] in pilot.PENDING]
    require(len(authorized)==9 and len(original['rows'])==20,'authorized_parent_scope_changed')
    selected=[];excluded=[]
    for row in authorized:
        value=values.get(row['sample']) or {};job=value.get('job') or {}
        receipt=old_state['rows'][str(row['sample'])]
        reason=('source_unavailable' if not value else 'quarantined' if job.get('quarantined') else
            'already_identified' if pilot.cache_result(value) in ('verified','identified_from_tracks') else
            'terminal_job' if job.get('state') in TERMINAL else
            'external_job' if job and (not job.get('owned') or not receipt.get('startIntentAt')) else
            'uncertain_prior_intent' if not job and receipt['state'] in ('probe_intent','start_intent') else None)
        if reason:excluded.append({'originalSample':row['sample'],'reason':reason});continue
        selected.append({**copy.deepcopy(row),'originalSample':row['sample'],'sample':len(selected)+1})
    require(len({r['fileKey'] for r in selected})==len(selected),'subset_duplicate')
    return selected,excluded


def protected_rows(job_ids):
    if not job_ids:return {}
    require(all(pilot.UUID.fullmatch(j) for j in job_ids),'protected_job_identifier_invalid')
    return json.loads(sql("SELECT coalesce(jsonb_object_agg(id,md5(to_jsonb(j)::text)),'{}'::jsonb) "
        "FROM public.catalog_file_audio_validation_jobs j WHERE id IN ("+
        ','.join(fleet.literal(j)+'::uuid' for j in job_ids)+");"))


def invariant(plan):
    for name,digest in plan['parentHashes'].items():
        require(sha((PARENT/name).read_bytes())==digest,'parent_evidence_changed')
    d.invariant(plan['parentPlan'])
    require(protected_rows(list(plan['protectedJobs']))==plan['protectedJobs'],'excluded_terminal_job_changed')


def environment(plan,active):
    values=copy.deepcopy(plan['gatewayEnv'])
    if not active:values.update(LANGUAGE_ENRICHMENT_ACTIVATION_MODE='disabled',LANGUAGE_ENRICHMENT_PILOT_JSON='',
        LANGUAGE_METADATA_LANE_ENABLED='0',LANGUAGE_CAPTURE_PIPELINE_ENABLED='0',LANGUAGE_HOST_ADAPTIVE_ADMISSION_ENABLED='0')
    expected=d.environment(plan['gatewayBefore'],values)
    return d.mount_replace(expected,ROOT/'audio-private','/var/lib/norva-lid-private')


def verify(active):
    plan=saved('plan.private.json');invariant(plan)
    current=gw.inspect(d.SERVICES[0]);gw.assert_clone(environment(plan,active),current,IMAGE)
    gw.assert_container_image(current,plan['imageIdentity'])
    require(gw.source_snapshot()==plan['sourceAfter'],'resumed_source_drift')
    require(gw.binary_snapshot()==plan['binaries'],'resumed_binary_drift')
    h=gw.health();gw.assert_runtime(h,plan['runtime'])
    fence=h.get('languageEnrichmentPilot') or {};buffer=h.get('languageCaptureBuffer') or {}
    require(fence.get('mode')==('pilot' if active else 'disabled') and
        fence.get('files')==(len(plan['rows']) if active else 0),'subset_fence_changed')
    if active:require(not fence.get('expired') and buffer.get('ready') is True and
        buffer.get('maxBytes')==32*1024*1024 and buffer.get('ttlMs')==1800000,'subset_buffer_changed')
    require(current['State']['Running'] and not current['State']['OOMKilled'] and current['RestartCount']==0,'resumed_gateway_unhealthy')
    for name in d.SERVICES[1:]:d.verify_service(name,plan['parentPlan'])
    return h


def stage(commit):
    require(re.fullmatch('[a-f0-9]{40}',commit) is not None,'commit_invalid')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),'resume_already_staged')
    parent=d.saved('plan.private.json');closed=d.saved('pilot-closed.private.json')
    require(closed.get('newLogicPromotedToFleet') is False,'parent_not_closed')
    for name in d.SERVICES:d.verify_service(name,parent)
    original=pilot.private(PARENT/'pilot/plan.private.json');old_state=pilot.private(PARENT/'pilot/state.private.json')
    require(old_state.get('runtimeStatus')=='stopped' and old_state.get('stoppedReason')=='cohort_quarantine_requires_review','parent_stop_changed')
    values={r['sample']:pilot.current(r) for r in original['rows']}
    rows,excluded=select_remaining(original,old_state,values)
    require(1<=len(rows)<=9,'no_remaining_admissible_file')
    require(time.time()<original['expiresEpoch'],'original_deadline_expired')
    require(prior.crons()==parent['crons'],'original_crons_changed')
    context=ROOT/'context';context.mkdir(mode=0o700)
    allowed={'services/media-gateway/src/'+n:n for n in FILES}
    with tarfile.open(ROOT/'resume-source.tar') as archive:
        entries=[m for m in archive.getmembers() if not m.isdir()]
        require(len(entries)==len(FILES) and {m.name for m in entries}==set(allowed),'resume_archive_scope')
        for entry in entries:
            require(entry.isfile() and 0<entry.size<(1500000 if allowed[entry.name]=='index.js' else 180000),'resume_archive_entry')
            target=context/allowed[entry.name];target.write_bytes(canonical_source(archive.extractfile(entry).read()));target.chmod(0o600)
    after={**parent['sourceAfter'],**{n:sha((context/n).read_bytes()) for n in FILES}}
    current=gw.inspect(d.SERVICES[0]);base='norva-enrichment-pilot9-proxy-base:20260912'
    gw.run(['docker','tag',current['Image'],base]);require(gw.image_identity(base)['index']==current['Image'],'resume_base_drift')
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in FILES))
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base,'-t',IMAGE,str(context)])
    for n in FILES:gw.run(['docker','run','--rm','--network','none','--read-only','--memory','512m','--cpus','1','--entrypoint','node',IMAGE,'--check','/app/src/'+n])
    gate={'protocol':1,'createdAt':parent['gate']['createdAt'] if parent.get('gate') else
        d.datetime.datetime.fromtimestamp(original['preparedEpoch'],d.datetime.timezone.utc).isoformat(),
        'expiresAt':d.datetime.datetime.fromtimestamp(original['expiresEpoch'],d.datetime.timezone.utc).isoformat(),
        'fileKeys':[r['fileKey'] for r in rows]}
    env={**parent['gatewayEnv'],'LANGUAGE_ENRICHMENT_ACTIVATION_MODE':'pilot',
        'LANGUAGE_ENRICHMENT_PILOT_JSON':json.dumps(gate,separators=(',',':')),
        'LANGUAGE_METADATA_LANE_ENABLED':'1','LANGUAGE_CAPTURE_PIPELINE_ENABLED':'1','LANGUAGE_HOST_ADAPTIVE_ADMISSION_ENABLED':'1'}
    protected=[v['job']['id'] for v in values.values() if v and v.get('job') and
        (v['job'].get('quarantined') or v['job'].get('state') in TERMINAL)]
    names=('plan.private.json','cohort-revision.private.json','sample-bound-revision.private.json',
        'pilot-closed.private.json','pilot/plan.private.json','pilot/state.private.json')
    plan={'commit':commit,'createdAt':stamp(),'parentPlan':parent,'parentHashes':{n:sha((PARENT/n).read_bytes()) for n in names},
        'protectedJobs':protected_rows(protected),'rows':rows,'excluded':excluded,'authorizedOriginalSamples':
        [r['sample'] for r in original['rows'] if old_state['rows'][str(r['sample'])]['state'] in pilot.PENDING],
        'gatewayBefore':current,'gatewayEnv':env,'sourceAfter':after,'imageIdentity':gw.image_identity(IMAGE),
        'runtime':gw.runtime_snapshot(gw.health()),'binaries':gw.binary_snapshot(),'crons':prior.crons(),
        'expiresEpoch':original['expiresEpoch'],'controls':d.controls()}
    require(all(plan['controls']['flags'].get(k) is False for k in d.FLAGS),'new_flags_not_dormant')
    uid=int(gw.run(['docker','exec',current['Id'],'id','-u']).decode());require(uid==os.getuid(),'private_uid_changed')
    (ROOT/'audio-private').mkdir(mode=0o700);pilot.ROOT.mkdir(mode=0o700)
    sample={**original,'gatewaySha256':after['index.js'],'rows':rows,'resumedAt':stamp(),
        'originalPlanSha256':sha((PARENT/'pilot/plan.private.json').read_bytes())}
    pilot.validate(sample);pilot.save(pilot.ROOT/'plan.private.json',sample,True)
    state={k:copy.deepcopy(old_state[k]) for k in ('userCooldowns','providerCooldowns') if k in old_state}
    state.update(planSha256=sha((pilot.ROOT/'plan.private.json').read_bytes()),runtimeStatus='prepared',
        rows={str(r['sample']):copy.deepcopy(old_state['rows'][str(r['originalSample'])]) for r in rows},updatedAt=stamp())
    pilot.save(pilot.ROOT/'state.private.json',state,True);save('plan.private.json',plan);invariant(plan)
    print(json.dumps({'staged':True,'authorizedRemaining':9,'admissible':len(rows),'excluded':excluded,
        'originalDenominator':20,'originalDeadlinePreserved':True,'providerRequests':0,'commit':commit}))


def process_active(name,phase):
    path=ROOT/(name+'.private.json')
    if not path.exists():return False
    marker=saved(path.name);proc=pathlib.Path('/proc')/str(marker['pid'])
    try:
        args=(proc/'cmdline').read_bytes().split(b'\0')
        return (str(pathlib.Path(__file__).resolve()).encode() in args and phase.encode() in args and
            (proc/'stat').read_text().rsplit(')',1)[1].split()[19]==marker['startTicks'])
    except FileNotFoundError:return False


def spawn(name,phase):
    require(not (ROOT/(name+'.private.json')).exists(),'process_already_started')
    with (ROOT/(name+'.log')).open('x') as output:
        child=subprocess.Popen([sys.executable,'-B',str(pathlib.Path(__file__).resolve()),phase],stdin=subprocess.DEVNULL,
            stdout=output,stderr=subprocess.DEVNULL,start_new_session=True)
    save(name+'.private.json',{'pid':child.pid,'startTicks':(pathlib.Path('/proc')/str(child.pid)/'stat').read_text().rsplit(')',1)[1].split()[19],'startedAt':stamp()})


def begin():
    plan=saved('plan.private.json');invariant(plan)
    require(not (ROOT/'begin.private.json').exists(),'resume_already_begun')
    save('begin.private.json',{'at':stamp(),'launchDeadline':min(time.time()+900,plan['expiresEpoch'])})
    spawn('watchdog','watch');require(process_active('watchdog','watch'),'watchdog_not_alive')
    prior.alter_crons(plan,True)
    print(json.dumps({'originalIntakePaused':True,'watchdogAlive':True,'providerRequests':0}))


def replace_gateway(plan,active,label):
    d.idle()
    original=gw.inspect(d.SERVICES[0]);expected=environment(plan,active)
    name='norva-media-gateway-pilot9-'+label
    require(not (ROOT/(label+'-intent.private.json')).exists(),'gateway_phase_already_started')
    created=gw.docker_api('POST','/containers/create?name='+name+'-candidate',gw.clone_payload(expected,IMAGE))
    receipt={'candidateContainer':created['Id'],'candidateName':name+'-candidate'}
    save(label+'-intent.private.json',{'originalContainer':original,'receipt':receipt,'at':stamp()})
    gw.assert_clone(expected,gw.inspect(created['Id']),IMAGE);d.idle()
    try:
        gw.run(['docker','stop','--time','20',original['Id']]);gw.run(['docker','rename',original['Id'],name+'-retained'])
        gw.run(['docker','rename',created['Id'],d.SERVICES[0]]);gw.run(['docker','start',created['Id']])
        ready=False
        for _ in range(25):
            try:verify(active);ready=True;break
            except Exception:time.sleep(1)
        require(ready,'subset_gateway_unhealthy')
    except Exception:
        d.edge.restore(d.SERVICES[0],{'containers':{d.SERVICES[0]:original}},receipt)
        raise RuntimeError('subset_gateway_restored') from None


def deploy():
    plan=saved('plan.private.json');invariant(plan)
    require(process_active('watchdog','watch') and not (ROOT/'closed.private.json').exists(),'resume_watchdog_missing')
    require(prior.crons()==[{**j,'active':False} for j in plan['crons']],'resume_crons_not_paused')
    require(gw.inspect(d.SERVICES[0])['Id']==plan['gatewayBefore']['Id'],'gateway_before_changed')
    replace_gateway(plan,True,'before-resume')
    save('deployed.private.json',{'at':stamp(),'commit':plan['commit'],'imageIdentity':plan['imageIdentity']})
    print(json.dumps({'deployed':True,'commit':plan['commit'],'allowedFiles':len(plan['rows']),'databaseFlagsStillDisabled':True}))


def configure_runner():
    spec=importlib.util.spec_from_file_location('subset_runner',ROOT/'run-enrichment-pilot20-20260911.py')
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    runner.configure(sys.modules[__name__],len(saved('plan.private.json')['rows']))
    return runner


def launch():
    plan=saved('plan.private.json');verify(True);invariant(plan)
    require(process_active('watchdog','watch') and (ROOT/'deployed.private.json').exists(),'launch_guard_missing')
    require(not (ROOT/'closed.private.json').exists() and not (ROOT/'operator.private.json').exists(),'subset_already_launched')
    require(time.time()<saved('begin.private.json')['launchDeadline'],'launch_deadline_expired')
    sql("UPDATE public.admin_feature_flags SET enabled=true WHERE key IN "
        "('language_metadata_lane_enabled','language_capture_pipeline_enabled','language_exact_file_admission_enabled');",write=True)
    spawn('operator','run')
    print(json.dumps({'started':True,'files':len(plan['rows']),'maxAcquisitions':2,'monoAccountMaximum':1,
        'privateWorkingBytes':64*1024*1024,'ttlSeconds':1800,'oldJobsReset':False}))


def finish():
    plan=saved('plan.private.json');invariant(plan)
    if (ROOT/'closed.private.json').exists():return True
    state=pilot.private(pilot.ROOT/'state.private.json')
    expired=time.time()>=plan['expiresEpoch']
    launch_failed=not (ROOT/'operator.private.json').exists() and time.time()>=saved('begin.private.json')['launchDeadline']
    stopped=state.get('runtimeStatus') in ('finished','stopped','expired')
    missing=(ROOT/'operator.private.json').exists() and not process_active('operator','run')
    if not (expired or stopped or missing or launch_failed):return False
    require(not process_active('operator','run'),'waiting_for_subset_operator_exit')
    if (ROOT/'deployed.private.json').exists():
        d.idle()
        buffer=gw.health().get('languageCaptureBuffer') or {}
        require(all(buffer.get(k)==0 for k in ('entries','bytes','reservations','computations')),'waiting_for_private_audio_expiry')
        require({p.name for p in (ROOT/'audio-private').iterdir()}<={'owner.lock'},'private_audio_cleanup_incomplete')
        replace_gateway(plan,False,'completed')
    else:d.verify_service(d.SERVICES[0],plan['parentPlan'])
    sql("UPDATE public.admin_feature_flags SET enabled=false WHERE key IN ("+','.join(fleet.literal(k) for k in d.FLAGS)+");",write=True)
    prior.alter_crons(plan,False);invariant(plan)
    save('closed.private.json',{'at':stamp(),'newLogicPromotedToFleet':False,'audioBytes':0,'originalDenominator':20,
        'processedSubset':len(plan['rows']),'runtimeStatus':state.get('runtimeStatus'),'stoppedReason':state.get('stoppedReason')})
    print(json.dumps({'closed':True,'oldIntakeCronsRestored':True,'audioBytes':0,'quarantinesPreserved':True}),flush=True)
    return True


def abort_before_deploy():
    """Restore our scheduling pause without interrupting unrelated transcription."""
    plan=saved('plan.private.json');invariant(plan)
    require(not (ROOT/'deployed.private.json').exists() and
        not (ROOT/'before-resume-intent.private.json').exists(),'deployment_already_started')
    require(not (ROOT/'operator.private.json').exists(),'subset_operator_already_started')
    require(gw.inspect(d.SERVICES[0])['Id']==plan['gatewayBefore']['Id'],'gateway_before_changed')
    d.verify_service(d.SERVICES[0],plan['parentPlan'])
    state=pilot.private(pilot.ROOT/'state.private.json')
    state.update(runtimeStatus='stopped',stoppedReason='preexisting_transcription_requires_maintenance_window',updatedAt=stamp())
    pilot.save(pilot.ROOT/'state.private.json',state)
    save('predeployment-abort.private.json',{'at':stamp(),'providerRequests':0,'existingTranscriptionUntouched':True})
    finish()


def watch():
    deadline=saved('plan.private.json')['expiresEpoch']+3600
    while time.time()<deadline:
        try:
            if finish():return
        except Exception as error:
            code=str(error)
            print(json.dumps({'at':stamp(),'closurePending':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,100}',code) else 'operator_attention_required'}),flush=True)
        time.sleep(15)


def status():
    runner=configure_runner();p,s=runner.plans()
    print(json.dumps({**runner.summary(p,s),'originalDenominator':20,'authorizedOriginalRemaining':9,
        'operatorAlive':process_active('operator','run'),'watchdogAlive':process_active('watchdog','watch'),
        'closed':(ROOT/'closed.private.json').exists()},ensure_ascii=False))


if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        if phase=='stage':stage(sys.argv[2])
        elif phase in ('begin','deploy','launch','watch','status','finish','abort_before_deploy'):globals()[phase]()
        elif phase=='run':configure_runner().run()
        else:raise RuntimeError('unknown_phase')
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'subset_operation_failed'}),flush=True)
        sys.exit(1)
