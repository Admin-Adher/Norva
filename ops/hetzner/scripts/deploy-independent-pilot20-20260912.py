"""A separately authorized cohort, never a restart or replacement of old samples.

Reuse the audited capture operator and release guards, but bind them to a new
private namespace, a fresh immutable 24-hour plan and a distinct rollback pair.
Preparation reads metadata only. Failed jobs, quarantines, provider circuits and
the previous cohorts are never reset. Passive playback capture remains disabled.
"""
import copy
import datetime
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-pilot20-independent-20260912')
PARENT = ROOT.parent/'enrichment-pilot20-20260911'
BASELINE_ROOT = PARENT/'resume9-normalized-20260912'
BASELINE_SCRIPT = BASELINE_ROOT/'resume-enrichment-pilot9-20260912.py'
IMAGE = 'norva-media-gateway:enrichment-independent20-20260912'
CONTAINER_PREFIX = 'norva-media-gateway-independent20-20260912'
FILES = ('index.js', 'passive-lid-capture.js')
MAX_FILES = 20
MAX_SECONDS = 24*3600


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


# Keep a genuinely separate, unmodified verifier for the current live baseline.
# The mutable release adapter must not change that verifier's ROOT or globals.
baseline = module('independent20_baseline', BASELINE_SCRIPT)
r = module('independent20_release', BASELINE_SCRIPT)
r.ROOT = ROOT
r.__file__ = __file__
r.IMAGE = IMAGE
r.pilot.ROOT = ROOT/'pilot'
r.pilot.MAX_FILES = MAX_FILES
r.pilot.MAX_SECONDS = MAX_SECONDS
gw, d, pilot, prior, sql = r.gw, r.d, r.pilot, r.prior, r.sql
require, sha, stamp, saved, save = r.require, r.sha, r.stamp, r.saved, r.save


def file_key(row):
    return sha(json.dumps(['provider', row['identity_key'], 'movie', row['external_id']],
        separators=(',', ':')))


def candidate_reason(row, value, excluded_keys, checked_epoch):
    """Read-only eligibility; live admission still rechecks before every I/O."""
    if file_key(row) in excluded_keys:
        return 'prior_cohort'
    if not value:
        return 'source_unavailable'
    if value.get('job'):
        return 'existing_job_protected'
    if pilot.cache_result(value) not in ('incomplete_tracks', 'no_audio_inventory'):
        return 'already_identified'
    for name in ('probeCircuitRetryAt', 'retryAt'):
        if value.get(name):
            try:
                until = datetime.datetime.fromisoformat(value[name].replace('Z', '+00:00'))
                if until.tzinfo is None:
                    return 'invalid_retry_time'
                if until.timestamp() > checked_epoch:
                    return 'provider_cooldown' if name == 'probeCircuitRetryAt' else 'file_cooldown'
            except (AttributeError, TypeError, ValueError):
                return 'invalid_retry_time'
    return None


def select_cohort(rows, values, excluded_keys, checked_epoch):
    rejected = {}
    eligible = []
    for row in rows:
        reason = candidate_reason(row, values.get(row['variant_id']), excluded_keys, checked_epoch)
        if reason:
            rejected[reason] = rejected.get(reason, 0)+1
        else:
            eligible.append(row)
    known_inventory = pilot.choose([x for x in eligible if x['has_track_map']], 10)
    selected_keys = {file_key(x) for x in known_inventory}
    rest = pilot.choose([x for x in eligible if file_key(x) not in selected_keys],
        MAX_FILES-len(known_inventory))
    selected = known_inventory+rest
    require(len(selected) == MAX_FILES, 'insufficient_distinct_eligible_files')
    selected = [dict(copy.deepcopy(row), sample=n, fileKey=file_key(row))
        for n, row in enumerate(selected, 1)]
    require(len({x['fileKey'] for x in selected}) == MAX_FILES, 'duplicate_cohort')
    require(not ({x['fileKey'] for x in selected} & excluded_keys), 'prior_cohort_reused')
    return selected, rejected


def evidence_files():
    names = ['plan.private.json', 'pilot/plan.private.json', 'pilot/state.private.json',
        'pilot-closed.private.json', 'cohort-revision.private.json', 'sample-bound-revision.private.json']
    paths = [PARENT/n for n in names]
    paths += [BASELINE_SCRIPT, BASELINE_ROOT/'plan.private.json', BASELINE_ROOT/'closed.private.json',
        BASELINE_ROOT/'pilot/plan.private.json', BASELINE_ROOT/'pilot/state.private.json']
    old_hundred = ROOT.parent/'unknown-vod-pilot-20260911/plan.private.json'
    if old_hundred.exists():
        paths.append(old_hundred)
    return paths


def invariant(plan):
    baseline.invariant(plan['baselinePlan'])
    for path, digest in plan['priorEvidence'].items():
        require(sha(pathlib.Path(path).read_bytes()) == digest, 'prior_evidence_changed')
    require(r.protected_rows(list(plan['protectedJobs'])) == plan['protectedJobs'],
        'old_terminal_job_changed')
    require(sha((pilot.ROOT/'plan.private.json').read_bytes()) == plan['pilotPlanSha256'],
        'independent_plan_changed')
    require(sha((ROOT/'run-enrichment-pilot20-20260911.py').read_bytes()) == plan['runnerSha256'],
        'independent_operator_changed')
    require(sha(pathlib.Path(__file__).read_bytes()) == plan['entrypointSha256'], 'independent_release_changed')


def stage(commit):
    require(re.fullmatch('[a-f0-9]{40}', commit) is not None, 'commit_invalid')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(),
        'independent_pilot_already_staged')
    baseline.verify(False)
    current_plan = baseline.saved('plan.private.json')
    require(baseline.saved('closed.private.json').get('newLogicPromotedToFleet') is False,
        'previous_pilot_not_closed')
    require(not baseline.process_active('operator', 'run') and not baseline.process_active('watchdog', 'watch'),
        'previous_pilot_process_alive')
    require(prior.crons() == current_plan['crons'], 'baseline_crons_changed')
    controls = d.controls()
    require(all(controls['flags'].get(k) is False for k in d.FLAGS), 'new_flags_not_dormant')

    original = pilot.private(PARENT/'pilot/plan.private.json')
    excluded_keys = {file_key(row) for row in original['rows']}
    old_hundred = ROOT.parent/'unknown-vod-pilot-20260911/plan.private.json'
    if old_hundred.exists():
        excluded_keys.update(file_key(row) for row in pilot.private(old_hundred)['rows'])
    protected = set(current_plan['protectedJobs'])
    for row in original['rows']:
        value = pilot.current(row) or {}
        job = value.get('job') or {}
        if job and (job.get('quarantined') or job.get('state') in r.TERMINAL):
            protected.add(job['id'])

    # Select a balanced, finite shortlist before reading individual profiles.
    # The SQL already rejects all existing validation jobs and future file retries.
    pool = [x for x in d.unknown_candidates() if file_key(x) not in excluded_keys]
    circuits = set(json.loads(sql("SELECT coalesce(jsonb_agg(identity_key),'[]'::jsonb) "
        "FROM public.provider_probe_circuit WHERE open_until>now();")))
    pool = [x for x in pool if x['identity_key'] not in circuits]
    unique = {}
    for row in pool:
        unique.setdefault(file_key(row), row)
    shortlist = []
    available = list(unique.values())
    # Up to four balanced blocks; the twenty-file acquisition cap does not
    # prohibit a few additional read-only eligibility checks.
    for _ in range(4):
        if not available:
            break
        block = pilot.choose(available, MAX_FILES)
        shortlist.extend(block)
        used = {file_key(x) for x in block}
        available = [x for x in available if file_key(x) not in used]
    values = {row['variant_id']: pilot.current(row) for row in shortlist}
    rows, rejected = select_cohort(shortlist, values, excluded_keys, time.time())

    context = ROOT/'context'
    context.mkdir(mode=0o700)
    allowed = {'services/media-gateway/src/'+n: n for n in FILES}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [x for x in archive.getmembers() if not x.isdir()]
        require(len(entries) == len(FILES) and {x.name for x in entries} == set(allowed), 'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0 < entry.size < (1500000 if allowed[entry.name] == 'index.js' else 180000),
                'archive_entry')
            target = context/allowed[entry.name]
            target.write_bytes(r.canonical_source(archive.extractfile(entry).read()))
            target.chmod(0o600)
    current = gw.inspect(d.SERVICES[0])
    require(current['Image'] == current_plan['imageIdentity']['index'], 'baseline_image_changed')
    after = {**current_plan['sourceAfter'], **{n: sha((context/n).read_bytes()) for n in FILES}}
    require('passive-lid-capture.js' in gw.MODULES, 'passive_module_not_attested')
    base_image = 'norva-independent20-base:20260912'
    gw.run(['docker', 'tag', current['Image'], base_image])
    require(gw.image_identity(base_image)['index'] == current['Image'], 'build_base_drift')
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+
        ''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in FILES))
    gw.run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE='+base_image, '-t', IMAGE, str(context)])
    for name in FILES:
        gw.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--memory', '512m', '--cpus', '0.5',
            '--entrypoint', 'node', IMAGE, '--check', '/app/src/'+name])
    baseline.verify(False)

    prepared = time.time()
    expires = prepared+MAX_SECONDS
    gate = {'protocol': 1, 'createdAt': stamp(), 'expiresAt':
        datetime.datetime.fromtimestamp(expires, datetime.timezone.utc).isoformat(),
        'fileKeys': [row['fileKey'] for row in rows]}
    env = {**current_plan['gatewayEnv'], 'LANGUAGE_ENRICHMENT_ACTIVATION_MODE': 'pilot',
        'LANGUAGE_ENRICHMENT_PILOT_JSON': json.dumps(gate, separators=(',', ':')),
        'LANGUAGE_METADATA_LANE_ENABLED': '1', 'LANGUAGE_CAPTURE_PIPELINE_ENABLED': '1',
        'LANGUAGE_HOST_ADAPTIVE_ADMISSION_ENABLED': '1', 'LANGUAGE_PASSIVE_CAPTURE_ENABLED': '0',
        'SELECTION_ENRICHMENT_POLICY_JSON': ''}
    uid = int(gw.run(['docker', 'exec', current['Id'], 'id', '-u']).decode())
    require(uid == os.getuid(), 'private_volume_owner_changed')
    (ROOT/'audio-private').mkdir(mode=0o700)
    pilot.ROOT.mkdir(mode=0o700)
    sample = {'protocol': 1, 'preparedAt': stamp(), 'preparedEpoch': prepared, 'expiresEpoch': expires,
        'gatewaySha256': after['index.js'], 'rows': rows}
    pilot.validate(sample)
    pilot.save(pilot.ROOT/'plan.private.json', sample, True)
    sample_sha = sha((pilot.ROOT/'plan.private.json').read_bytes())
    pilot.save(pilot.ROOT/'state.private.json', {'planSha256': sample_sha, 'runtimeStatus': 'prepared',
        'rows': {str(row['sample']): {'state': 'planned', 'probeAttempts': 0} for row in rows}, 'updatedAt': stamp()}, True)
    plan = {'commit': commit, 'createdAt': stamp(), 'rows': rows, 'parentPlan': current_plan['parentPlan'],
        'baselinePlan': current_plan, 'priorEvidence': {str(p): sha(p.read_bytes()) for p in evidence_files()},
        'protectedJobs': r.protected_rows(sorted(protected)), 'pilotPlanSha256': sample_sha,
        'runnerSha256': sha((ROOT/'run-enrichment-pilot20-20260911.py').read_bytes()),
        'entrypointSha256': sha(pathlib.Path(__file__).read_bytes()),
        'gatewayBefore': current, 'gatewayEnv': env, 'sourceAfter': after, 'imageIdentity': gw.image_identity(IMAGE),
        'runtime': gw.runtime_snapshot(gw.health()), 'binaries': gw.binary_snapshot(), 'crons': prior.crons(),
        'expiresEpoch': expires, 'controls': controls, 'excludedPriorFiles': len(excluded_keys),
        'rejectedEligibility': rejected, 'selectionIncluded': 0, 'passiveEnabled': False}
    save('plan.private.json', plan)
    invariant(plan)
    print(json.dumps({'staged': True, 'commit': commit, 'files': len(rows),
        'providers': len({x['identity_key'] for x in rows}), 'sourceAccounts': len({x['source_id'] for x in rows}),
        'inventoriedUnknown': sum(x['has_track_map'] for x in rows), 'excludedPriorFiles': len(excluded_keys),
        'coolingProvidersExcluded': len(circuits), 'expiresAt': gate['expiresAt'], 'maxHours': 24,
        'providerRequests': 0, 'passiveEnabled': False, 'productionUnchanged': True}))


def replace_gateway(plan, active, label):
    require(label in ('before-resume', 'completed'), 'gateway_phase_invalid')
    d.idle()
    original = gw.inspect(d.SERVICES[0])
    expected = r.environment(plan, active)
    name = CONTAINER_PREFIX+'-'+label
    if (ROOT/(label+'-intent.private.json')).exists():
        intent = saved(label+'-intent.private.json')
        require(original['Id'] == intent['receipt']['candidateContainer'], 'gateway_phase_requires_review')
        # A crash after the successful rename/verification must not create a
        # second candidate or strand the watchdog behind an existing receipt.
        r.verify(active)
        return
    created = gw.docker_api('POST', '/containers/create?name='+name+'-candidate', gw.clone_payload(expected, IMAGE))
    receipt = {'candidateContainer': created['Id'], 'candidateName': name+'-candidate'}
    save(label+'-intent.private.json', {'originalContainer': original, 'receipt': receipt, 'at': stamp()})
    gw.assert_clone(expected, gw.inspect(created['Id']), IMAGE)
    d.idle()
    try:
        gw.run(['docker', 'stop', '--time', '20', original['Id']])
        gw.run(['docker', 'rename', original['Id'], name+'-retained'])
        gw.run(['docker', 'rename', created['Id'], d.SERVICES[0]])
        gw.run(['docker', 'start', created['Id']])
        ready = False
        for _ in range(25):
            try:
                r.verify(active)
                ready = True
                break
            except Exception:
                time.sleep(1)
        require(ready, 'independent_gateway_unhealthy')
    except Exception:
        d.edge.restore(d.SERVICES[0], {'containers': {d.SERVICES[0]: original}}, receipt)
        raise RuntimeError('independent_gateway_restored') from None


def finish():
    plan = saved('plan.private.json')
    invariant(plan)
    if (ROOT/'closed.private.json').exists():
        return True
    state = pilot.private(pilot.ROOT/'state.private.json')
    expired = time.time() >= plan['expiresEpoch']
    launch_failed = not (ROOT/'operator.private.json').exists() and time.time() >= saved('begin.private.json')['launchDeadline']
    stopped = state.get('runtimeStatus') in ('finished', 'stopped', 'expired')
    missing = (ROOT/'operator.private.json').exists() and not r.process_active('operator', 'run')
    if not (expired or stopped or missing or launch_failed):
        return False
    require(not r.process_active('operator', 'run'), 'waiting_for_independent_operator_exit')
    installed = (ROOT/'deployed.private.json').exists()
    if not installed and (ROOT/'before-resume-intent.private.json').exists():
        intent = saved('before-resume-intent.private.json')
        installed = gw.inspect(d.SERVICES[0])['Id'] == intent['receipt']['candidateContainer']
    if installed:
        d.idle()
        buffer = gw.health().get('languageCaptureBuffer') or {}
        if buffer.get('ready') is True:
            require(all(buffer.get(k) == 0 for k in ('entries', 'bytes', 'reservations', 'computations')),
                'waiting_for_private_audio_expiry')
        else:
            # Only a previously verified dormant replacement may omit buffer
            # counters; never treat a missing active buffer as empty.
            require((ROOT/'completed-intent.private.json').exists(), 'private_buffer_state_missing')
            r.verify(False)
        require({p.name for p in (ROOT/'audio-private').iterdir()} <= {'owner.lock'}, 'private_audio_cleanup_incomplete')
        replace_gateway(plan, False, 'completed')
    else:
        baseline.verify(False)
    sql('UPDATE public.admin_feature_flags SET enabled=false WHERE key IN ('+
        ','.join(r.fleet.literal(k) for k in d.FLAGS)+');', write=True)
    prior.alter_crons(plan, False)
    invariant(plan)
    save('closed.private.json', {'at': stamp(), 'newLogicPromotedToFleet': False, 'audioBytes': 0,
        'independentDenominator': MAX_FILES, 'runtimeStatus': state.get('runtimeStatus'),
        'stoppedReason': state.get('stoppedReason'), 'oldJobsReset': False})
    print(json.dumps({'closed': True, 'oldIntakeCronsRestored': True, 'audioBytes': 0,
        'oldJobsAndQuarantinesPreserved': True}), flush=True)
    return True


def status():
    runner = r.configure_runner()
    plan, state = runner.plans()
    print(json.dumps({**runner.summary(plan, state), 'cohort': 'independent-20260912',
        'operatorAlive': r.process_active('operator', 'run'), 'watchdogAlive': r.process_active('watchdog', 'watch'),
        'closed': (ROOT/'closed.private.json').exists()}, ensure_ascii=False))


r.invariant = invariant
r.replace_gateway = replace_gateway
r.finish = finish

if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        if phase == 'stage':
            stage(sys.argv[2])
        elif phase == 'status':
            status()
        elif phase in ('begin', 'deploy', 'launch', 'watch', 'finish'):
            getattr(r, phase)()
        elif phase == 'run':
            r.configure_runner().run()
        else:
            raise RuntimeError('unknown_phase')
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', code)
            else 'independent_operation_failed'}), flush=True)
        sys.exit(1)
