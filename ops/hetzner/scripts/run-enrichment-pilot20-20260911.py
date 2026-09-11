"""Only the immutable 20-file cohort; no old job reset or replacement sample.

Uses production admission/leases for every network request. Authenticated worker
dispatch is limited to named cohort jobs (two per call), not the general queue.
Private crash-safe intents are inherited from the existing pilot operator.
"""
import collections
import importlib.util
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time
import urllib.request

ROOT=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911')
spec=importlib.util.spec_from_file_location('release',ROOT/'deploy-enrichment-pilot20-20260911.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)
pilot=release.pilot
dispatch_healthy_at=0


def scoped_controls():
    value=pilot.query("SELECT jsonb_build_object('runtime',public.strict_lid_runtime_health(),"
        "'paused',coalesce((SELECT enabled FROM public.admin_feature_flags WHERE key='enrichment_paused'),true));")
    runtime=value.get('runtime') or {}
    # The ordinary worker health is intentionally false while its cron is
    # paused. Replace ONLY this operator's liveness criterion with a fresh
    # successful authenticated scoped dispatch, never SQL admission/security.
    crons=release.saved('plan.private.json')['crons']
    return value.get('paused') is False and runtime.get('audioEnabled') is True and runtime.get('legacyEnabled') is False \
        and time.time()-dispatch_healthy_at<60 and release.prior.crons()==[{**j,'active':False} for j in crons]


pilot.controls=scoped_controls


def plans():
    p=pilot.private(pilot.ROOT/'plan.private.json');s=pilot.private(pilot.ROOT/'state.private.json')
    pilot.validate(p)
    release.require(len(p['rows'])==20 and release.sha((pilot.ROOT/'plan.private.json').read_bytes())==s['planSha256'],'pilot_plan_drift')
    return p,s


def collect(plan,state):
    jobs=[];languages=collections.Counter()
    for row in plan['rows']:
        receipt=state['rows'][str(row['sample'])];value=pilot.current(row)
        receipt['cacheResult']=pilot.cache_result(value)
        if not value:continue
        for track in value.get('tracks') or []:
            if not pilot.track_unknown(track):languages[str(track.get('lang') or track.get('language'))]+=1
        job=value.get('job')
        if job and receipt.get('startIntentAt') and job.get('owned'):
            receipt.update(jobState=job['state'],windowsDone=job.get('window'),providerAttempts=job.get('providerAttempts'),errorCode=job.get('errorCode'))
            if job.get('quarantined'):
                receipt['state']='quarantined';state['stoppedReason']='cohort_quarantine_requires_review'
            elif job['state'] in ('completed','verified','failed','expired','cancelled'):
                receipt['state']='verified' if job.get('verified') and value.get('verified') else 'validation_'+job['state']
            elif job['state'] in ('queued','retry_wait'):
                jobs.append(job['id'])
            if re.search('PROVIDER_(BUSY|COOLDOWN|CONNECTION|REJECT)|HTTP_(401|403|429|458)',job.get('errorCode') or ''):
                state['stoppedReason']='provider_refusal_requires_review'
    state['observedTrackLanguages']=dict(languages);state['cacheObservedAt']=release.stamp()
    if not jobs:return []
    release.require(all(pilot.UUID.fullmatch(x) for x in jobs),'cohort_job_identifier_invalid')
    # A cooling first sample must not starve the other 19. Respect the stored
    # due time instead of repeatedly waking the same not-yet-due two jobs.
    return json.loads(release.sql("SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM (SELECT id FROM public.catalog_file_audio_validation_jobs"
        " WHERE id IN ("+','.join(release.fleet.literal(j)+'::uuid' for j in jobs)+") AND quarantined_at IS NULL"
        " AND (state='queued' OR (state='retry_wait' AND (retry_at IS NULL OR retry_at<=now())))"
        " ORDER BY coalesce(retry_at,created_at),id LIMIT 2)x;"))


def dispatch(ids):
    global dispatch_healthy_at
    release.require(len(ids)<=2 and len(set(ids))==len(ids) and all(pilot.UUID.fullmatch(x) for x in ids),'dispatch_scope')
    # The cron secret stays inside the private process and request header.
    secret=release.sql("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='norva_cron_shared_secret';")
    release.require(bool(secret),'cron_secret_missing')
    request=urllib.request.Request('https://api.norva.tv/functions/v1/norva-playback/language-validation-worker',
        data=json.dumps({'jobIds':ids}).encode(),headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=20) as response:
        value=json.loads(response.read(16384))
    release.require(value.get('ok') is True and value.get('due')==len(ids) and 0<=value.get('scheduled',-1)<=len(ids),'dispatch_contract')
    dispatch_healthy_at=time.time()
    return value['scheduled']


def snapshot(state):
    h=release.gw.health();gate=h.get('languageEnrichmentPilot') or {};buffer=h.get('languageCaptureBuffer') or {}
    release.require(gate.get('mode')=='pilot' and gate.get('files')==20 and not gate.get('expired'),'pilot_gateway_fence_changed')
    release.require(buffer.get('ready') is True and buffer.get('maxBytes')==32*1024*1024 and buffer.get('ttlMs')==1800000,'pilot_buffer_changed')
    stats=json.loads(release.sql("SELECT jsonb_build_object('activeAccountLeases',(SELECT count(*) FROM public.provider_account_language_validation_leases WHERE expires_at>now()),"
        "'exactFileLeases',(SELECT count(*) FROM public.provider_exact_file_probe_leases WHERE expires_at>now()),"
        "'maxLeasesPerAccount',coalesce((SELECT max(n) FROM (SELECT count(*) n FROM public.provider_exact_file_probe_leases WHERE expires_at>now() GROUP BY provider_account_hash)x),0));"))
    release.require(stats['maxLeasesPerAccount']<=1,'mono_account_ceiling_violation')
    observed={'at':release.stamp(),'buffer':buffer,'accountLeases':stats,'brokers':h.get('activeStrictLidBrokers'),
        'inference':h.get('whisperInferenceActive'),'hostAdmission':h.get('languageSelectionAdmission'),
        'rangeReuse':h.get('languageRangeReuse'),'viewerActive':h.get('viewerPlaybackActiveLocally')}
    state['runtimeObservation']=observed
    state['peakBrokers']=max(state.get('peakBrokers',0),observed['brokers'] or 0)
    state['peakEncryptedBytes']=max(state.get('peakEncryptedBytes',0),buffer.get('bytes',0))
    release.require(state['peakBrokers']<=2 and buffer['bytes']<=32*1024*1024,'pilot_resource_ceiling_violation')
    return observed


def summary(plan,state):
    return {**pilot.summary(plan,state),'languages':state.get('observedTrackLanguages'),
        'peakBrokers':state.get('peakBrokers'),'peakEncryptedBytes':state.get('peakEncryptedBytes'),
        'observation':state.get('runtimeObservation'),'dispatches':state.get('dispatches',0)}


def run(once=False):
    with pilot.lock(wait=True):
        plan,state=plans()
        while time.time()<plan['expiresEpoch']:
            try:
                release.invariant(release.saved('plan.private.json'))
                observation=snapshot(state)
                jobs=collect(plan,state)
                if not state.get('stoppedReason'):
                    dispatch([])
                    # One short metadata operation per step. Capture jobs can
                    # overlap local inference, but all I/O uses the same gates.
                    if not observation['viewerActive']:pilot.step(plan,state)
                    jobs=collect(plan,state)
                    if jobs and not state.get('stoppedReason'):
                        state['dispatches']=state.get('dispatches',0)+dispatch(jobs)
                state['lastSuccessfulTickAt']=release.stamp();state['consecutiveFailures']=0
                state['lastErrorCode']=None
            except Exception as error:
                state['lastErrorCode']=pilot.failure_code(error);state['consecutiveFailures']=state.get('consecutiveFailures',0)+1
                if state['consecutiveFailures']>=3:state['stoppedReason']='pilot_operator_requires_review'
            state['heartbeatAt']=state['updatedAt']=release.stamp()
            pending=any(r['state'] in pilot.PENDING for r in state['rows'].values())
            state['runtimeStatus']='stopped' if state.get('stoppedReason') else 'running' if pending else 'finished'
            pilot.save(pilot.ROOT/'state.private.json',state)
            print(json.dumps(summary(plan,state)),flush=True)
            if once or not pending or state.get('stoppedReason'):return
            time.sleep(min(15,max(0,plan['expiresEpoch']-time.time())))
        state.update(stoppedReason='pilot_deadline_reached',runtimeStatus='expired',updatedAt=release.stamp())
        pilot.save(pilot.ROOT/'state.private.json',state)


def launch(resume=False):
    with pilot.lock():
        plan,state=plans();release.require(time.time()<plan['expiresEpoch'],'pilot_expired')
        marker=pilot.ROOT/'process20.private.json'
        suffix=''
        if resume:
            previous=pilot.private(marker);proc=pathlib.Path('/proc')/str(previous['pid'])
            if proc.exists():
                ticks=(proc/'stat').read_text().rsplit(')',1)[1].split()[19]
                release.require(ticks!=previous['startTicks'],'pilot_process_still_alive')
            suffix='-resume-'+str(time.time_ns())
            marker.rename(pilot.ROOT/('process20'+suffix+'.private.json'))
        else:release.require(not marker.exists(),'pilot_already_launched')
        with (pilot.ROOT/('runner20'+suffix+'.log')).open('x') as output:
            process=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).resolve()),'run'],stdin=subprocess.DEVNULL,
                stdout=output,stderr=subprocess.DEVNULL,start_new_session=True)
        ticks=(pathlib.Path('/proc')/str(process.pid)/'stat').read_text().rsplit(')',1)[1].split()[19]
        pilot.save(marker,{'pid':process.pid,'startTicks':ticks,'startedAt':release.stamp()},True)
        print(json.dumps({'launched':True,'files':20,'maxAcquisitions':2,'monoAccountMaximum':1}))


def stop_sleeping_operator():
    # Only our exact idle Python process, never FFmpeg, Gateway, a viewer or an
    # Edge-owned capture. Refuse while a metadata request/SQL intent is active.
    marker=pilot.private(pilot.ROOT/'process20.private.json');proc=pathlib.Path('/proc')/str(marker['pid'])
    args=(proc/'cmdline').read_bytes().split(b'\0')
    release.require(str(pathlib.Path(__file__).resolve()).encode() in args and b'run' in args,'operator_identity_changed')
    release.require((proc/'stat').read_text().rsplit(')',1)[1].split()[19]==marker['startTicks'],'operator_pid_reused')
    release.require('nanosleep' in (proc/'wchan').read_text(),'operator_not_sleeping')
    os.kill(marker['pid'],signal.SIGSTOP)
    try:
        _,state=plans()
        release.require(not any(r['state'] in ('probe_intent','start_intent') for r in state['rows'].values()),'operator_io_intent_active')
        os.kill(marker['pid'],signal.SIGTERM)
    finally:os.kill(marker['pid'],signal.SIGCONT)
    print(json.dumps({'onlyIdleOperatorStopped':True,'inflightEdgeWorkUntouched':True,'sampleAndRetriesPreserved':True}))


if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        if phase in ('launch','resume'):launch(phase=='resume')
        elif phase=='stop_sleeping_operator':stop_sleeping_operator()
        elif phase in ('run','step'):run(phase=='step')
        elif phase=='status':
            p,s=plans();print(json.dumps(summary(p,s)))
        else:raise RuntimeError('unknown_phase')
    except Exception:
        print(json.dumps({'ok':False,'code':'pilot20_operator_failed'}));sys.exit(1)
