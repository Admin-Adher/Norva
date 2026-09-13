"""One explicitly approved two-job interruption, with retained-container recovery.

The read-only receipt predates approval. Never replace its identities with the
current queue. Completed jobs, partial VTT, language jobs and quarantines survive.
No permanent busy-work bypass is installed in the application.
"""
import copy
import datetime
import importlib.util
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-admission-20260913-retry1')
SCOPE = ROOT.parent/'passive-readiness-20260913/subtitle-scope-1789263958247573154.private.json'
REASON = 'Traitement interrompu pour maintenance planifiee ; resultat partiel conserve.'
UUID = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')
spec = importlib.util.spec_from_file_location('maintenance_admission_release', ROOT/'deploy-enrichment-admission-20260913.py')
release = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = release
spec.loader.exec_module(release)
op, gw, require = release.op, release.gw, release.require
sql = op.lib.sql
ordinary_recover = op.recover
op.__file__ = __file__


def literal(value):
    return "'"+str(value).replace("'", "''")+"'"


def scope_receipt():
    source = json.loads(gw.safe_file(SCOPE.parent, SCOPE.name).read_text())
    rows = source.get('rows', [])
    require(len(rows) == 2 and len({row.get('jobId') for row in rows}) == 2
        and all(UUID.fullmatch(row.get('jobId', '')) and row.get('kind') == 'transcript' for row in rows),
        'approved_subtitle_receipt_invalid')
    return rows


def subtitle_rows(ids):
    require(len(ids) == 2 and len(set(ids)) == 2 and all(UUID.fullmatch(x) for x in ids), 'subtitle_identifier_invalid')
    return json.loads(sql("SELECT coalesce(jsonb_agg(x ORDER BY created_at),'[]'::jsonb) FROM ("
        "SELECT job_id::text,created_at,status,stage,kind,"
        "md5(jsonb_build_array(provider_key,item_type,external_id,kind,lang,job_id,created_at)::text) identity_hash,"
        "md5(to_jsonb(s)::text) row_hash,md5(vtt) vtt_hash,length(vtt) vtt_chars,segments,audio_sec,source_lang "
        "FROM public.catalog_generated_subtitles s WHERE status='processing' OR job_id IN ("+
        ','.join(literal(x)+'::uuid' for x in ids)+"))x;"))


def approved_subset(rows, approved):
    expected = {row['job_id']:row for row in approved}
    require(len(approved) == len(expected) == 2 and len(rows) == 2
        and {row['job_id'] for row in rows} == set(expected), 'unapproved_subtitle_job_present')
    for row in rows:
        require(row['kind'] == 'transcript' and row['identity_hash'] == expected[row['job_id']]['identity_hash']
            and row['created_at'] == expected[row['job_id']]['created_at'], 'subtitle_identity_changed')
        require(row['status'] in ('processing', 'ready', 'failed'), 'subtitle_state_changed')
    return [row for row in rows if row['status'] == 'processing']


def bind_scope(rows, receipt):
    expected = {row['jobId']:row for row in receipt}
    require(len(expected) == 2 and len(rows) == 2 and {row['job_id'] for row in rows} == set(expected),
        'unapproved_subtitle_job_present')
    for row in rows:
        created = lambda value: datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(row['kind'] == expected[row['job_id']]['kind'] == 'transcript'
            and created(row['created_at']) == created(expected[row['job_id']]['createdAt']), 'subtitle_identity_changed')
    approved_subset(rows, rows)
    return rows


def guard_health(health, processing):
    # Identical bounded exception to the independently tested Sept 12 procedure.
    busy, queue = health.get('transcribeBusy'), health.get('transcribeQueueDepth')
    inference, background = health.get('whisperInferenceActive'), health.get('backgroundWhisperInferenceActive')
    require(type(busy) is bool and type(queue) is int and queue >= 0 and type(inference) is int
        and inference in (0, 1) and type(background) is int and background == inference
        and (inference == 0 or busy), 'non_subtitle_inference_present')
    require(len(processing) <= 2 and queue <= len(processing) and 0 <= len(processing)-queue <= int(busy)
        and inference <= len(processing)-queue and (not busy or len(processing) > 0), 'subtitle_queue_scope_changed')
    admitted = copy.deepcopy(health)
    admitted.update(transcribeBusy=False, transcribeQueueDepth=0, whisperInferenceActive=0)
    gw.assert_idle(admitted)
    for key in ('activeViewerSubtitleOperations', 'pendingViewerSubtitleOperations', 'argosInferenceActive'):
        require(type(health.get(key)) is int and health[key] == 0, 'other_foreground_work_active')


def maintenance_idle(approval):
    rows = subtitle_rows([row['job_id'] for row in approval['jobs']])
    guard_health(gw.health(), approved_subset(rows, approval['jobs']))
    counts = json.loads(sql("SELECT jsonb_build_object('playback',"
        "(SELECT count(*) FROM public.cloud_playback_sessions WHERE status IN ('pending','ready') AND expires_at>now()),"
        "'jobs',(SELECT count(*) FROM public.catalog_file_audio_validation_jobs WHERE state IN ('running','finalizing') AND lease_expires_at>now()),"
        "'intake',(SELECT count(*) FROM public.catalog_vod_language_intake WHERE state='leased' AND lease_until>now()),"
        "'selection',(SELECT count(*) FROM public.catalog_selection_audio_jobs WHERE state='running' AND lease_until>now()),"
        "'account',(SELECT count(*) FROM public.provider_account_language_validation_leases WHERE expires_at>now()),"
        "'exactFile',(SELECT count(*) FROM public.provider_exact_file_probe_leases WHERE expires_at>now()),"
        "'storyboards',(SELECT count(*) FROM public.catalog_storyboards WHERE status='processing' AND updated_at>now()-interval '24 hours'));"))
    require(set(counts) == {'playback','jobs','intake','selection','account','exactFile','storyboards'}
        and all(type(value) is int and value == 0 for value in counts.values()), 'other_work_active')
    return rows


def audit():
    receipt = scope_receipt()
    rows = bind_scope(subtitle_rows([row['jobId'] for row in receipt]), receipt)
    maintenance_idle({'jobs':rows})
    print(json.dumps({'matchedApprovedJobs':2, 'stillProcessing':len(approved_subset(rows, rows)),
        'stages':[row['stage'] for row in rows], 'partialSegments':[row['segments'] for row in rows],
        'otherWorkActive':False, 'productionUnchanged':True}))


def freeze():
    require(not (ROOT/'subtitle-authorization.private.json').exists(), 'subtitle_authorization_already_frozen')
    plan = op.saved('plan.private.json')
    release.invariant(plan); release.verify_gateway(plan, False)
    receipt = scope_receipt()
    rows = bind_scope(subtitle_rows([row['jobId'] for row in receipt]), receipt)
    approval = {'jobs':rows, 'gatewayId':plan['original']['Id'], 'userAuthorized':True, 'at':time.time(),
        'scope':'only_the_two_previously_recorded_jobs', 'partialVttMustBePreserved':True,
        'scopeSha256':gw.sha(SCOPE.read_bytes()), 'operatorSha256':gw.sha(pathlib.Path(__file__).read_bytes()),
        'planSha256':gw.sha((ROOT/'plan.private.json').read_bytes())}
    maintenance_idle(approval)
    op.save('subtitle-authorization.private.json', approval)
    print(json.dumps({'approvedJobsBound':2, 'productionUnchanged':True}))


def invariant(plan):
    release.invariant(plan)
    approval = op.saved('subtitle-authorization.private.json')
    require(approval.get('userAuthorized') is True and approval['gatewayId'] == plan['original']['Id']
        and approval['scopeSha256'] == gw.sha(SCOPE.read_bytes())
        and approval['operatorSha256'] == gw.sha(pathlib.Path(__file__).read_bytes())
        and approval['planSha256'] == gw.sha((ROOT/'plan.private.json').read_bytes()), 'maintenance_evidence_changed')


def cancellation_sql(rows):
    require(len(rows) == 2, 'subtitle_cancel_count_invalid')
    statements = ["BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s';"]
    for row in rows:
        if row['status'] != 'processing':
            continue
        require(UUID.fullmatch(row['job_id']) and re.fullmatch('[a-f0-9]{32}', row['row_hash']),
            'subtitle_cancel_receipt_invalid')
        where = 'job_id='+literal(row['job_id'])+"::uuid AND status='processing'"
        statements.append("DO $guard$ BEGIN PERFORM 1 FROM public.catalog_generated_subtitles s WHERE "+where+
            " AND md5(to_jsonb(s)::text)='"+row['row_hash']+"' FOR UPDATE; "
            "IF NOT FOUND THEN RAISE EXCEPTION 'subtitle changed after stop'; END IF; END $guard$;")
        statements.append("UPDATE public.catalog_generated_subtitles SET status='failed',stage=NULL,error="+
            literal(REASON)+",updated_at=now() WHERE "+where+";")
    return '\n'.join(statements+['COMMIT;'])


def cancel_stopped(approval):
    require(gw.inspect(approval['gatewayId'])['State']['Running'] is False, 'subtitle_coordinator_still_running')
    if (ROOT/'subtitle-cancelled.private.json').exists():
        return
    rows = subtitle_rows([row['job_id'] for row in approval['jobs']])
    approved_subset(rows, approval['jobs'])
    # Unique snapshots remain recoverable even if a previous SQL call timed out.
    op.save('subtitle-before-cancel-'+str(time.time_ns())+'.private.json', {'jobs':rows, 'at':time.time()})
    sql(cancellation_sql(rows), write=True)
    after = subtitle_rows([row['job_id'] for row in rows])
    approved_subset(after, approval['jobs'])
    previous = {row['job_id']:row for row in rows}
    for row in after:
        before = previous[row['job_id']]
        require(all(row[key] == before[key] for key in
            ('identity_hash','vtt_hash','vtt_chars','segments','audio_sec','source_lang')), 'subtitle_partial_result_changed')
        require(row['status'] == ('failed' if before['status'] == 'processing' else before['status']),
            'subtitle_cancel_not_persisted')
        if before['status'] != 'processing':
            require(row == before, 'completed_subtitle_changed')
    op.save('subtitle-cancelled.private.json', {'jobs':after, 'at':time.time(),
        'interrupted':sum(row['status'] == 'processing' for row in rows), 'partialResultsPreserved':True})


def deploy(plan):
    invariant(plan); release.verify_gateway(plan, False)
    require(op.base.r.crons() == [{**job,'active':False} for job in plan['crons']], 'crons_not_paused')
    approval = op.saved('subtitle-authorization.private.json')
    maintenance_idle(approval)
    require(not (ROOT/'receipt.private.json').exists(), 'activation_already_attempted')
    created = gw.docker_api('POST', '/containers/create?name='+op.PREFIX+'-candidate', gw.clone_payload(plan['original'], release.IMAGE))
    op.save('receipt.private.json', {'candidateContainer':created['Id'], 'candidateName':op.PREFIX+'-candidate'})
    gw.assert_clone(plan['original'], gw.inspect(created['Id']), release.IMAGE)
    maintenance_idle(approval)
    # Kill neither a guessed PID nor a single chunk. Only the coordinator whose
    # entire live work was just proved to be this approved two-job subset.
    gw.run(['docker','stop','--time','20',plan['original']['Id']])
    cancel_stopped(approval)
    gw.run(['docker','rename',plan['original']['Id'],op.PREFIX+'-retained'])
    gw.run(['docker','rename',created['Id'],op.SERVICE])
    gw.run(['docker','start',created['Id']])
    for attempt in range(25):
        try:
            release.verify_gateway(plan, True); invariant(plan)
            return
        except Exception:
            if attempt == 24:
                raise
            time.sleep(1)


def recover():
    plan = op.saved('plan.private.json'); invariant(plan)
    receipt = op.saved('receipt.private.json') if (ROOT/'receipt.private.json').exists() else None
    if receipt:
        original, candidate = gw.inspect(plan['original']['Id']), gw.inspect(receipt['candidateContainer'])
        # Core recovery already covers candidate verification and any alias gap.
        # Also handle interruption just after stopping the original, before its
        # alias moved. A failed cancellation must not strand this owned service.
        if not original['State']['Running'] and not candidate['State']['Running']:
            inventory = gw.docker_api('GET', '/containers/json?all=true')
            aliases = [item['Id'] for item in inventory if '/'+op.SERVICE in item.get('Names', [])]
            require(len(aliases) <= 1 and all(value in (original['Id'], candidate['Id']) for value in aliases),
                'recovery_container_not_owned')
            try:
                cancel_stopped(op.saved('subtitle-authorization.private.json'))
            finally:
                op.edge.restore(op.SERVICE, {'containers':{op.SERVICE:plan['original']}}, receipt)
    return ordinary_recover()


def run():
    plan = op.saved('plan.private.json')
    try:
        invariant(plan); release.verify_gateway(plan, False)
        require(op.base.r.crons() == plan['crons'], 'cron_state_drift')
        op.base.r.alter_crons(plan, True)
        while time.time() < op.saved('begin.private.json')['deadline']:
            try:
                maintenance_idle(op.saved('subtitle-authorization.private.json'))
                break
            except Exception:
                time.sleep(5)
        else:
            raise RuntimeError('other_work_drain_deadline')
        deploy(plan)
    finally:
        op.close(recover())


def status():
    plan = op.saved('plan.private.json'); invariant(plan)
    receipt = op.saved('receipt.private.json') if (ROOT/'receipt.private.json').exists() else None
    current = gw.inspect(op.SERVICE)
    candidate = bool(receipt and current['Id'] == receipt['candidateContainer'])
    release.verify_gateway(plan, candidate)
    cancellation = op.saved('subtitle-cancelled.private.json') if (ROOT/'subtitle-cancelled.private.json').exists() else None
    print(json.dumps({'checkedAt':time.time(), 'commit':plan['commit'], 'productionCandidateActive':candidate,
        'sourceHash':plan['after' if candidate else 'before']['index.js'],
        'closed':op.saved('closed.private.json') if (ROOT/'closed.private.json').exists() else None,
        'runnerAlive':op.process_alive('run'), 'guardAlive':op.process_alive('watch'),
        'cronsRestored':op.base.r.crons() == plan['crons'],
        'interruptedJobs':cancellation['interrupted'] if cancellation else 0,
        'partialResultsPreserved':cancellation['partialResultsPreserved'] if cancellation else None}))


op.invariant, op.run, op.recover = invariant, run, recover
if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('audit','stage','freeze','launch','run','watch','recover','verify','status'), 'invalid_phase')
        own = {'audit':audit,'stage':release.stage,'freeze':freeze,'run':run,'recover':recover,
            'verify':release.verify,'status':status}
        own[phase]() if phase in own else getattr(op, phase)()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok':False, 'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code)
            else 'subtitle_maintenance_failed'}), flush=True)
        sys.exit(1)
