"""One Gateway module, after actual work drains; no feature activation.

Reuses the retained-container/cron recovery supervisor. No Edge, model, proxy,
quarantine, certification-threshold or provider-access change.
"""
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-admission-20260913-retry1')
PREVIOUS_ATTEMPT = ROOT.parent/'enrichment-admission-20260913'
CURRENT = ROOT.parent/'initial-playback-topology-20260912'
NATIVE = ROOT.parent/'enrichment-admission-native-20260913-r2/native-proof.json'
IMAGE = 'norva-media-gateway:enrichment-admission-20260913-retry1'
FILES = ('index.js',)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


live = load('enrichment_admission_current', CURRENT/'deploy-initial-playback-topology-20260912.py')
op = load('enrichment_admission_supervisor', ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT, op.NATIVE, op.FILES, op.IMAGE = ROOT, NATIVE, FILES, IMAGE
op.PREFIX, op.__file__ = op.SERVICE+'-'+ROOT.name, __file__
gw, require = op.gw, op.require


def invariant(plan):
    live.invariant(live.op.saved('plan.private.json'))
    require(op.base.r.controls() == plan['controls'], 'flags_or_quarantine_changed')
    for name, digest in plan['protectedFiles'].items():
        require(gw.sha(pathlib.Path(name).read_bytes()) == digest, 'protected_evidence_changed')
    for name, identity in plan['otherContainers'].items():
        require(gw.inspect(name)['Id'] == identity, 'unrelated_container_changed')


def verify_gateway(plan, candidate):
    current = gw.inspect(op.SERVICE)
    expected = op.saved('receipt.private.json')['candidateContainer'] if candidate else plan['original']['Id']
    require(current['Id'] == expected, 'gateway_container_not_owned')
    gw.assert_clone(plan['original'], current, IMAGE if candidate else plan['original']['Config']['Image'])
    gw.assert_container_image(current, plan['imageIdentity' if candidate else 'originalImageIdentity'])
    require(live.source_snapshot() == plan['after' if candidate else 'before'], 'gateway_source_changed')
    require(gw.binary_snapshot() == plan['binaries'], 'runtime_binary_changed')
    health = gw.health(); gw.assert_runtime(health, plan['runtime'])
    fence = health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode') == 'disabled' and fence.get('files') == 0
        and fence.get('passiveSources') == 0, 'dormant_admission_changed')
    if candidate:
        work = health.get('languageForegroundWork') or {}
        names = {'activeOperations', 'admissionChecks', 'pendingPriorityJobs', 'deferredBackgroundJobs'}
        require(set(work) == names | {'protocol', 'busy'} and work.get('protocol') == 1
            and all(type(work.get(name)) is int and work[name] >= 0 for name in names)
            and type(work.get('busy')) is bool
            and work['busy'] == (work['activeOperations'] + work['admissionChecks'] + work['pendingPriorityJobs'] > 0),
            'foreground_activity_diagnostic_invalid')
    require(current['State']['Running'] and current['RestartCount'] == 0 and not current['State']['OOMKilled'],
        'gateway_unhealthy')


def stage():
    commit = sys.argv[2]
    require(re.fullmatch('[a-f0-9]{40}', commit) is not None, 'commit_missing')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(), 'stage_not_fresh')
    live.verify()
    current = gw.inspect(op.SERVICE); gw.assert_image_backed_runtime(current)
    proof = json.loads(NATIVE.read_text())
    require(proof.get('exitCode') == 0 and proof.get('counts') == {'tests':32, 'pass':32, 'fail':0, 'skipped':0}
        and proof.get('networkDisabled') is True and proof.get('newProviderRequests') == 0
        and proof.get('mediaOperations') == 0 and proof.get('abortedReason') is None
        and proof.get('image') == current['Image'], 'native_proof_mismatch')
    context = ROOT/'context'; context.mkdir(mode=0o700)
    name = 'services/media-gateway/src/index.js'
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [entry for entry in archive.getmembers() if not entry.isdir()]
        require(len(entries) == 1 and entries[0].name == name, 'archive_scope')
        entry = entries[0]
        require(entry.isfile() and 0 < entry.size < 2000000, 'archive_entry')
        data = archive.extractfile(entry).read().replace(b'\r\n', b'\n')
        require(gw.sha(data) == proof['sourceHashes'][name], 'native_source_drift')
        (context/'index.js').write_bytes(data); (context/'index.js').chmod(0o600)
    before = live.source_snapshot()
    after = {**before, 'index.js':gw.sha(data)}
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY --chmod=0644 index.js /app/src/index.js\n')
    # A terminal observation window is not retried in place. Preserve the
    # previous attempt and ensure its controller/guard really exited.
    closed = json.loads(gw.safe_file(PREVIOUS_ATTEMPT, 'closed.private.json').read_text())
    require(closed.get('productionUpdated') is False and closed.get('cronsRestored') is True
        and not previous_process_alive('run') and not previous_process_alive('watch'),
        'previous_attempt_not_safely_closed')
    base_tag = 'norva-enrichment-admission-base:20260913-retry1'
    gw.run(['docker', 'tag', current['Image'], base_tag])
    require(gw.image_identity(base_tag)['index'] == current['Image'], 'build_base_drift')
    gw.run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE='+base_tag, '-t', IMAGE, str(context)])
    gw.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cpus', '.5', '--memory', '256m',
        '--entrypoint', 'node', IMAGE, '--check', '/app/src/index.js'])
    live.verify()
    parent = live.op.saved('plan.private.json')
    paths = [pathlib.Path(name) for name in parent['protectedFiles']]
    paths += [CURRENT/name for name in ('plan.private.json', 'receipt.private.json', 'closed.private.json',
        'deploy-initial-playback-topology-20260912.py')]
    paths += [NATIVE, pathlib.Path(__file__), ROOT/'source.tar']
    paths += [PREVIOUS_ATTEMPT/name for name in ('plan.private.json', 'closed.private.json',
        'begin.private.json', 'run.private.json', 'watch.private.json',
        'deploy-enrichment-admission-20260913.py', 'source.tar')]
    others = (*op.base.r.SERVICES, op.base.previous.d.SERVICES[3])
    plan = {'commit':commit, 'original':current, 'before':before, 'after':after,
        'originalImageIdentity':gw.image_identity(current['Image']), 'imageIdentity':gw.image_identity(IMAGE),
        'binaries':gw.binary_snapshot(), 'runtime':gw.runtime_snapshot(gw.health()),
        'crons':op.base.r.crons(), 'controls':op.base.r.controls(),
        'otherContainers':{name:gw.inspect(name)['Id'] for name in others},
        'protectedFiles':{str(path):gw.sha(path.read_bytes()) for path in paths}, 'stagedAt':time.time()}
    op.save('plan.private.json', plan); invariant(plan); verify_gateway(plan, False)
    print(json.dumps({'staged':True, 'productionUnchanged':True, 'gatewayModules':1, 'newProviderRequests':0}))


def verify():
    plan = op.saved('plan.private.json')
    require(op.saved('closed.private.json').get('productionUpdated') is True, 'deployment_not_complete')
    invariant(plan); verify_gateway(plan, True)
    require(op.base.r.crons() == plan['crons'], 'cron_restore_missing')
    print(json.dumps({'verified':True, 'commit':plan['commit'], 'image':plan['imageIdentity']['index'],
        'sourceHash':plan['after']['index.js'], 'productionUpdated':True, 'gatewayModules':1,
        'cronsRestored':True, 'flagsAndQuarantinesPreserved':True, 'newProviderRequests':0}))


def previous_process_alive(phase):
    require(phase in ('run', 'watch'), 'previous_process_phase_invalid')
    marker = json.loads(gw.safe_file(PREVIOUS_ATTEMPT, phase+'.private.json').read_text())
    require(type(marker.get('pid')) is int and marker['pid'] > 0
        and str(marker.get('startTicks', '')).isdigit(), 'previous_process_marker_invalid')
    proc = pathlib.Path('/proc')/str(marker['pid'])
    try:
        args = (proc/'cmdline').read_bytes().split(b'\0')
        return str(PREVIOUS_ATTEMPT/'deploy-enrichment-admission-20260913.py').encode() in args \
            and phase.encode() in args \
            and (proc/'stat').read_text().rsplit(')', 1)[1].split()[19] == str(marker['startTicks'])
    except (FileNotFoundError, ProcessLookupError):
        return False


op.invariant, op.verify_gateway = invariant, verify_gateway
if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('stage', 'launch', 'run', 'watch', 'recover', 'verify'), 'invalid_phase')
        own = {'stage':stage, 'verify':verify}
        own[phase]() if phase in own else getattr(op, phase)()
    except Exception as error:
        message = str(error)
        print(json.dumps({'ok':False, 'code':message if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', message)
            else 'enrichment_admission_release_failed'}), flush=True)
        sys.exit(1)
