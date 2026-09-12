"""One authorized maintenance interruption, not a general busy-gateway bypass.

Bind the two previously observed subtitle jobs before stopping their coordinator.
Preserve their partial VTT and all terminal language jobs. The subset operator,
deadlines, playback protection, private audio limits and closure stay unchanged.
All job identities/configuration receipts remain private on the server.
"""
import copy
import importlib.util
import json
import os
import pathlib
import re
import sys
import time

PARENT=pathlib.Path('/home/adrien/.norva/enrichment-pilot20-20260911')
PREVIOUS=PARENT/'resume9-20260912'
ROOT=PARENT/'resume9-maintenance-20260912'
OBSERVED_CREATED={'2026-09-12T00:30:04.243216+00:00','2026-09-12T00:30:04.315305+00:00'}
REASON='Traitement interrompu pour maintenance planifiee ; resultat partiel conserve.'
spec=importlib.util.spec_from_file_location('maintenance_subset',ROOT/'resume-enrichment-pilot9-20260912.py')
r=importlib.util.module_from_spec(spec);sys.modules[spec.name]=r;spec.loader.exec_module(r)
r.ROOT=ROOT;r.pilot.ROOT=ROOT/'pilot';r.__file__=__file__
gw,sql,require=r.gw,r.sql,r.require
ordinary_replace=r.replace_gateway


def subtitle_rows(ids=()):
    require(all(r.pilot.UUID.fullmatch(x) for x in ids),'subtitle_identifier_invalid')
    extra=' OR job_id IN ('+','.join(r.fleet.literal(x)+'::uuid' for x in ids)+')' if ids else ''
    return json.loads(sql("SELECT coalesce(jsonb_agg(x ORDER BY created_at),'[]'::jsonb) FROM (SELECT job_id::text,"
        "created_at,status,stage,kind,md5(jsonb_build_array(provider_key,item_type,external_id,kind,lang,job_id,created_at)::text) AS identity_hash,"
        "md5(to_jsonb(s)::text) AS row_hash,md5(vtt) AS vtt_hash,length(vtt) AS vtt_chars,segments,audio_sec,source_lang "
        "FROM public.catalog_generated_subtitles s WHERE status='processing'"+extra+")x;"))


def approved_subset(rows,approved):
    expected={v['job_id']:v for v in approved}
    require(len(expected)==2 and {v['created_at'] for v in approved}==OBSERVED_CREATED,
        'approved_subtitle_scope_changed')
    require(len(rows)==2 and {v['job_id'] for v in rows}==set(expected),'unapproved_subtitle_job_present')
    for row in rows:
        require(row['kind']=='transcript' and row['identity_hash']==expected[row['job_id']]['identity_hash'],
            'subtitle_identity_changed')
        require(row['status'] in ('processing','ready','failed'),'subtitle_state_changed')
    return [v for v in rows if v['status']=='processing']


def guard_health(health,processing):
    """Only the exact approved background ASR/queue counters may be nonzero."""
    busy=health.get('transcribeBusy');queue=health.get('transcribeQueueDepth')
    inference=health.get('whisperInferenceActive');background=health.get('backgroundWhisperInferenceActive')
    require(type(busy) is bool and type(queue) is int and queue>=0 and
        type(inference) is int and inference in (0,1) and type(background) is int and
        background==inference and (inference==0 or busy),'non_subtitle_inference_present')
    require(queue+int(busy)==len(processing) and len(processing)<=2,'subtitle_queue_scope_changed')
    admitted=copy.deepcopy(health)
    admitted.update(transcribeBusy=False,transcribeQueueDepth=0,whisperInferenceActive=0)
    # All original viewer, acquisition, OCR, translation, CPU and runtime checks.
    gw.assert_idle(admitted)


def maintenance_idle(approval):
    rows=subtitle_rows([v['job_id'] for v in approval['jobs']])
    guard_health(gw.health(),approved_subset(rows,approval['jobs']))
    state=json.loads(sql("SELECT jsonb_build_object('playback',"
        "(SELECT count(*) FROM public.cloud_playback_sessions WHERE status IN ('pending','ready') AND expires_at>now()),"
        "'jobs',(SELECT count(*) FROM public.catalog_file_audio_validation_jobs WHERE state IN ('running','finalizing') AND lease_expires_at>now()),"
        "'intake',(SELECT count(*) FROM public.catalog_vod_language_intake WHERE state='leased' AND lease_until>now()),"
        "'selection',(SELECT count(*) FROM public.catalog_selection_audio_jobs WHERE state='running' AND lease_until>now()),"
        "'account',(SELECT count(*) FROM public.provider_account_language_validation_leases WHERE expires_at>now()),"
        "'exactFile',(SELECT count(*) FROM public.provider_exact_file_probe_leases WHERE expires_at>now()),"
        "'storyboards',(SELECT count(*) FROM public.catalog_storyboards WHERE status='processing'));"))
    require(set(state)=={'playback','jobs','intake','selection','account','exactFile','storyboards'} and
        all(type(v) is int and v==0 for v in state.values()),'other_work_active')
    return rows


def freeze():
    require(not (ROOT/'subtitle-authorization.private.json').exists(),'subtitle_authorization_already_frozen')
    plan=r.saved('plan.private.json');r.invariant(plan)
    rows=subtitle_rows();approved_subset(rows,rows)
    approval={'at':r.stamp(),'jobs':rows,'gatewayId':plan['gatewayBefore']['Id'],
        'scope':'interrupt_only_two_previously_observed_subtitle_jobs','partialVttMustBePreserved':True,
        'planSha256':r.sha((ROOT/'plan.private.json').read_bytes()),
        'previousClosureSha256':r.sha((PREVIOUS/'closed.private.json').read_bytes())}
    maintenance_idle(approval);r.save('subtitle-authorization.private.json',approval)
    print(json.dumps({'authorizedJobsBound':len(rows),'partialSegments':[v['segments'] for v in rows],
        'productionUnchanged':True,'providerRequests':0}))


def cancellation_sql(rows):
    processing=[v for v in rows if v['status']=='processing']
    require(len(rows)==2 and len(processing)<=2,'subtitle_cancel_count_invalid')
    statements=["BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';"]
    for row in processing:
        require(r.pilot.UUID.fullmatch(row['job_id']) and re.fullmatch('[a-f0-9]{32}',row['row_hash']),
            'subtitle_cancel_receipt_invalid')
        where='job_id='+r.fleet.literal(row['job_id'])+"::uuid AND status='processing'"
        statements.append("DO $guard$ BEGIN PERFORM 1 FROM public.catalog_generated_subtitles s WHERE "+where+
            " AND md5(to_jsonb(s)::text)='"+row['row_hash']+"' FOR UPDATE; "
            "IF NOT FOUND THEN RAISE EXCEPTION 'subtitle changed after stop'; END IF; END $guard$;")
        statements.append("UPDATE public.catalog_generated_subtitles SET status='failed',stage=NULL,error="+
            r.fleet.literal(REASON)+",updated_at=now() WHERE "+where+";")
    statements.append('COMMIT;')
    return '\n'.join(statements)


def cancel_stopped(approval):
    require(gw.inspect(approval['gatewayId'])['State']['Running'] is False,'subtitle_coordinator_still_running')
    rows=subtitle_rows([v['job_id'] for v in approval['jobs']]);approved_subset(rows,approval['jobs'])
    r.save('subtitle-before-cancel.private.json',{'at':r.stamp(),'jobs':rows})
    sql(cancellation_sql(rows),write=True)
    after=subtitle_rows([v['job_id'] for v in rows]);approved_subset(after,approval['jobs'])
    previous={v['job_id']:v for v in rows}
    for row in after:
        before=previous[row['job_id']]
        require(all(row[k]==before[k] for k in ('identity_hash','vtt_hash','vtt_chars','segments','audio_sec','source_lang')),
            'subtitle_partial_result_changed')
        require(row['status']==('failed' if before['status']=='processing' else before['status']),
            'subtitle_cancel_not_persisted')
        if before['status']!='processing':require(row==before,'completed_subtitle_changed')
    r.save('subtitle-cancelled.private.json',{'at':r.stamp(),'jobs':after,
        'interrupted':sum(v['status']=='processing' for v in rows),'partialResultsPreserved':True})


def replace_gateway(plan,active,label):
    if not active:return ordinary_replace(plan,active,label)
    require(label=='before-resume' and not (ROOT/'before-resume-intent.private.json').exists(),
        'maintenance_already_attempted')
    approval=r.saved('subtitle-authorization.private.json')
    require(approval['planSha256']==r.sha((ROOT/'plan.private.json').read_bytes()) and
        approval['previousClosureSha256']==r.sha((PREVIOUS/'closed.private.json').read_bytes()),'maintenance_evidence_changed')
    original=gw.inspect(r.d.SERVICES[0])
    require(original['Id']==approval['gatewayId']==plan['gatewayBefore']['Id'],'maintenance_gateway_changed')
    for service in r.d.SERVICES:r.d.verify_service(service,plan['parentPlan'])
    require(gw.image_identity(r.IMAGE)==plan['imageIdentity'],'maintenance_image_changed')
    maintenance_idle(approval)
    expected=r.environment(plan,True);name='norva-media-gateway-maintenance-20260912'
    created=gw.docker_api('POST','/containers/create?name='+name+'-candidate',gw.clone_payload(expected,r.IMAGE))
    receipt={'candidateContainer':created['Id'],'candidateName':name+'-candidate'}
    r.save('before-resume-intent.private.json',{'originalContainer':original,'receipt':receipt,'at':r.stamp()})
    gw.assert_clone(expected,gw.inspect(created['Id']),r.IMAGE)
    try:
        maintenance_idle(approval)
        # Stop the coordinator, not just Whisper: otherwise it advances chunks.
        gw.run(['docker','stop','--time','20',original['Id']])
        cancel_stopped(approval)
        gw.run(['docker','rename',original['Id'],name+'-retained'])
        gw.run(['docker','rename',created['Id'],r.d.SERVICES[0]])
        gw.run(['docker','start',created['Id']])
        ready=False
        for _ in range(25):
            try:r.verify(True);ready=True;break
            except Exception:time.sleep(1)
        require(ready,'maintenance_candidate_unhealthy')
        r.d.idle()
    except Exception:
        r.d.edge.restore(r.d.SERVICES[0],{'containers':{r.d.SERVICES[0]:original}},receipt)
        raise RuntimeError('maintenance_gateway_restored') from None


r.replace_gateway=replace_gateway

if __name__=='__main__':
    os.umask(0o077)
    try:
        phase=sys.argv[1]
        if phase=='stage':r.stage(sys.argv[2])
        elif phase=='freeze':freeze()
        elif phase in ('begin','deploy','launch','watch','status','finish','abort_before_deploy'):getattr(r,phase)()
        elif phase=='run':r.configure_runner().run()
        else:raise RuntimeError('unknown_phase')
    except Exception as error:
        code=str(error);print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else
            'maintenance_operation_failed'}),flush=True);sys.exit(1)
