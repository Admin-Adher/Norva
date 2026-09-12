"""Three Gateway modules, dormant. No provider I/O or pilot/job/flag reset.

Build from the exact tested live image; retain the original container and all
previous release evidence. A separate guard restores only this release's
container alias and the two recorded cron active bits after an interruption.
"""
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/scoped-passive-dormant-20260912')
PARENT = ROOT.parent/'enrichment-postpilot-20260912'
NATIVE = ROOT.parent/'scoped-passive-native-20260912/native-proof.json'
APP_COMMIT = '73913e4fe5a443f9afcb3e6024b6ca0658804575'
IMAGE = 'norva-media-gateway:scoped-passive-dormant-20260912'
SERVICE = 'norva-media-gateway'
FILES = ('index.js', 'enrichment-pilot-admission.js', 'passive-lid-capture.js')
PREFIX = SERVICE+'-scoped-passive-20260912'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


base = module('scoped_passive_postpilot', PARENT/'deploy-enrichment-postpilot-20260912.py')
gw, lib, edge, require = base.gw, base.lib, base.edge, base.require


def saved(name):
    return json.loads(gw.safe_file(ROOT, name).read_text())


def save(name, value):
    gw.private_write(ROOT/name, value)


def invariant(plan):
    # Historical immutable evidence/terminal rows remain protected, without
    # pretending their old Gateway image attestation covers this new release.
    base.previous.invariant(base.previous.saved('plan.private.json'))
    require(base.r.controls() == plan['controls'], 'flags_or_quarantine_changed')
    for path, digest in plan['protectedFiles'].items():
        require(gw.sha(pathlib.Path(path).read_bytes()) == digest, 'protected_release_changed')
    parent_plan = base.r.saved('plan.private.json')
    for name in base.r.SERVICES:
        require(gw.inspect(name)['Id'] == plan['otherContainers'][name], 'edge_container_changed')
        base.verify_service(name, parent_plan)
    selection = base.previous.d.SERVICES[3]
    require(gw.inspect(selection)['Id'] == plan['otherContainers'][selection], 'selection_container_changed')
    base.previous.d.verify_service(selection, base.previous.saved('plan.private.json')['parentPlan'])


def verify_gateway(plan, candidate):
    current = gw.inspect(SERVICE)
    image = IMAGE if candidate else plan['original']['Config']['Image']
    expected_id = saved('receipt.private.json')['candidateContainer'] if candidate else plan['original']['Id']
    require(current['Id'] == expected_id, 'gateway_container_not_owned')
    gw.assert_clone(plan['original'], current, image)
    gw.assert_container_image(current, plan['imageIdentity'] if candidate else plan['originalImageIdentity'])
    require(gw.source_snapshot() == plan['after' if candidate else 'before'], 'gateway_source_changed')
    require(gw.binary_snapshot() == plan['binaries'], 'runtime_binary_changed')
    health = gw.health()
    gw.assert_runtime(health, plan['runtime'])
    fence = health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode') == 'disabled' and fence.get('files') == 0,
        'dormant_admission_changed')
    if candidate:
        require(fence.get('passiveSources') == 0, 'passive_grant_unexpected')
    require(current['State']['Running'] and current['RestartCount'] == 0
        and not current['State']['OOMKilled'], 'gateway_unhealthy')


def stage():
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(), 'stage_not_fresh')
    base.r.verify()
    current = gw.inspect(SERVICE)
    gw.assert_image_backed_runtime(current)
    native = json.loads(NATIVE.read_text())
    require(native.get('exitCode') == 0 and native.get('counts') == {'tests': 16, 'pass': 16, 'fail': 0, 'skipped': 0}
        and native.get('networkDisabled') is True and native.get('newProviderRequests') == 0
        and native.get('image') == current['Image'], 'native_proof_not_matching')
    env = dict(v.split('=', 1) for v in current['Config']['Env'] if '=' in v)
    require(env.get('LANGUAGE_ENRICHMENT_ACTIVATION_MODE') == 'disabled'
        and env.get('LANGUAGE_PASSIVE_CAPTURE_ENABLED') == '0'
        and env.get('LANGUAGE_CAPTURE_PIPELINE_ENABLED') == '0'
        and env.get('LANGUAGE_METADATA_LANE_ENABLED') == '0', 'release_not_dormant')
    context = ROOT/'context'
    context.mkdir(mode=0o700)
    allowed = {'services/media-gateway/src/'+n: n for n in FILES}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [e for e in archive.getmembers() if not e.isdir()]
        require(len(entries) == len(FILES) and {e.name for e in entries} == set(allowed), 'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0 < entry.size < (1500000 if allowed[entry.name] == 'index.js' else 180000), 'archive_entry')
            content = archive.extractfile(entry).read().replace(b'\r\n', b'\n')
            require(gw.sha(content) == native['sourceHashes'][entry.name], 'native_source_drift')
            (context/allowed[entry.name]).write_bytes(content)
            (context/allowed[entry.name]).chmod(0o600)
    before = gw.source_snapshot()
    after = {**before, **{n: gw.sha((context/n).read_bytes()) for n in FILES}}
    base_tag = 'norva-scoped-passive-base:20260912'
    gw.run(['docker', 'tag', current['Image'], base_tag])
    require(gw.image_identity(base_tag)['index'] == current['Image'], 'build_base_drift')
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+
        ''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in FILES))
    gw.run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE='+base_tag, '-t', IMAGE, str(context)])
    for name in FILES:
        gw.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--memory', '512m', '--cpus', '1',
            '--entrypoint', 'node', IMAGE, '--check', '/app/src/'+name])
    base.r.verify()
    paths = [PARENT/n for n in ('plan.private.json', 'protection.private.json', 'closed.private.json',
        'run-enrichment-pilot20-20260911.py', 'deploy-enrichment-postpilot-20260912.py')]
    paths += [NATIVE, pathlib.Path(__file__), ROOT/'source.tar']
    plan = {'commit': APP_COMMIT, 'original': current, 'before': before, 'after': after,
        'originalImageIdentity': gw.image_identity(current['Image']), 'imageIdentity': gw.image_identity(IMAGE),
        'binaries': gw.binary_snapshot(), 'runtime': gw.runtime_snapshot(gw.health()),
        'crons': base.r.crons(), 'controls': base.r.controls(),
        'otherContainers': {n: gw.inspect(n)['Id'] for n in (*base.r.SERVICES, base.previous.d.SERVICES[3])},
        'protectedFiles': {str(p): gw.sha(p.read_bytes()) for p in paths}, 'stagedAt': time.time()}
    save('plan.private.json', plan)
    invariant(plan)
    verify_gateway(plan, False)
    print(json.dumps({'staged': True, 'commit': APP_COMMIT, 'modules': len(FILES),
        'newProviderRequests': 0, 'passiveEnabled': False, 'productionUnchanged': True}))


def restore_crons(plan):
    base.r.alter_crons(plan, False)
    require(base.r.crons() == plan['crons'], 'cron_restore_missing')


def recovery_idle(plan, receipt):
    # Also works in the interruption window where the service alias is absent.
    for identity in (plan['original']['Id'], receipt['candidateContainer']):
        current = gw.inspect(identity)
        if current['State']['Running']:
            gw.assert_idle(gw.health(current))
    counts = json.loads(lib.sql("SELECT jsonb_build_object('playback',"
        "(SELECT count(*) FROM public.cloud_playback_sessions WHERE status IN ('pending','ready') AND expires_at>now()),"
        "'jobs',(SELECT count(*) FROM public.catalog_file_audio_validation_jobs WHERE state IN ('running','finalizing') AND lease_expires_at>now()),"
        "'intake',(SELECT count(*) FROM public.catalog_vod_language_intake WHERE state='leased' AND lease_until>now()),"
        "'selection',(SELECT count(*) FROM public.catalog_selection_audio_jobs WHERE state='running' AND lease_until>now()),"
        "'account',(SELECT count(*) FROM public.provider_account_language_validation_leases WHERE expires_at>now()));"))
    require(set(counts) == {'playback', 'jobs', 'intake', 'selection', 'account'} and
        all(type(n) is int and n == 0 for n in counts.values()), 'recovery_work_active')


def recover():
    plan = saved('plan.private.json')
    invariant(plan)
    receipt = saved('receipt.private.json') if (ROOT/'receipt.private.json').exists() else None
    inventory = gw.docker_api('GET', '/containers/json?all=true')
    matches = [c['Id'] for c in inventory if '/'+SERVICE in c.get('Names', [])]
    require(len(matches) <= 1, 'recovery_alias_ambiguous')
    current = matches[0] if matches else None
    require(current is not None or receipt is not None, 'recovery_alias_missing_without_receipt')
    require(current in (plan['original']['Id'], receipt['candidateContainer'] if receipt else None, None), 'recovery_container_not_owned')
    if receipt and current == receipt['candidateContainer']:
        try:
            verify_gateway(plan, True)
        except Exception:
            pass
        else:
            restore_crons(plan)
            return True
    if current != plan['original']['Id']:
        recovery_idle(plan, receipt)
        edge.restore(SERVICE, {'containers': {SERVICE: plan['original']}}, receipt)
    verify_gateway(plan, False)
    restore_crons(plan)
    return False


def deploy(plan):
    invariant(plan)
    verify_gateway(plan, False)
    require(base.r.crons() == [{**j, 'active': False} for j in plan['crons']], 'crons_not_paused')
    base.previous.d.idle()
    require(not (ROOT/'receipt.private.json').exists(), 'activation_already_attempted')
    created = gw.docker_api('POST', '/containers/create?name='+PREFIX+'-candidate', gw.clone_payload(plan['original'], IMAGE))
    receipt = {'candidateContainer': created['Id'], 'candidateName': PREFIX+'-candidate'}
    save('receipt.private.json', receipt)
    gw.assert_clone(plan['original'], gw.inspect(created['Id']), IMAGE)
    time.sleep(2)
    base.previous.d.idle()
    gw.run(['docker', 'stop', '--time', '20', plan['original']['Id']])
    gw.run(['docker', 'rename', plan['original']['Id'], PREFIX+'-retained'])
    gw.run(['docker', 'rename', created['Id'], SERVICE])
    gw.run(['docker', 'start', created['Id']])
    for attempt in range(25):
        try:
            verify_gateway(plan, True)
            invariant(plan)
            return
        except Exception:
            if attempt == 24:
                raise
            time.sleep(1)


def process_alive(marker):
    path = ROOT/(marker+'.private.json')
    if not path.exists():
        return False
    item = saved(path.name)
    proc = pathlib.Path('/proc')/str(item['pid'])
    try:
        args = (proc/'cmdline').read_bytes().split(b'\0')
        return str(pathlib.Path(__file__).resolve()).encode() in args and marker.encode() in args and \
            (proc/'stat').read_text().rsplit(')', 1)[1].split()[19] == item['startTicks']
    except (FileNotFoundError, ProcessLookupError):
        return False


def spawn(phase):
    with (ROOT/(phase+'.log')).open('x') as output:
        child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), phase],
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL, start_new_session=True)
    ticks = (pathlib.Path('/proc')/str(child.pid)/'stat').read_text().rsplit(')', 1)[1].split()[19]
    save(phase+'.private.json', {'pid': child.pid, 'startTicks': ticks})


def launch():
    plan = saved('plan.private.json')
    invariant(plan)
    verify_gateway(plan, False)
    require(base.r.crons() == plan['crons'], 'cron_state_drift')
    save('begin.private.json', {'createdAt': time.time(), 'deadline': time.time()+900})
    spawn('watch')
    require(process_alive('watch'), 'recovery_guard_missing')
    spawn('run')
    print(json.dumps({'launched': True, 'recoveryGuard': True, 'newProviderRequests': 0, 'passiveEnabled': False}))


def close(success):
    plan = saved('plan.private.json')
    invariant(plan)
    verify_gateway(plan, success)
    require(base.r.crons() == plan['crons'], 'cron_restore_missing')
    save('closed.private.json', {'at': time.time(), 'productionUpdated': success, 'cronsRestored': True, 'passiveEnabled': False})


def run():
    plan = saved('plan.private.json')
    try:
        invariant(plan)
        verify_gateway(plan, False)
        require(base.r.crons() == plan['crons'], 'cron_state_drift')
        base.r.alter_crons(plan, True)
        while time.time() < saved('begin.private.json')['deadline']:
            try:
                base.previous.d.idle()
                break
            except Exception:
                time.sleep(5)
        else:
            raise RuntimeError('existing_work_drain_deadline')
        deploy(plan)
    finally:
        close(recover())


def watch():
    begin = saved('begin.private.json')
    while time.time() < begin['deadline']+900:
        if (ROOT/'closed.private.json').exists():
            return
        if time.time() > begin['createdAt']+15 and not process_alive('run'):
            try:
                close(recover())
                return
            except Exception:
                pass
        time.sleep(5)
    print(json.dumps({'requiresReview': True, 'code': 'scoped_passive_recovery_deadline'}), flush=True)


def verify():
    plan = saved('plan.private.json')
    require(saved('closed.private.json').get('productionUpdated') is True, 'release_not_complete')
    invariant(plan)
    verify_gateway(plan, True)
    require(base.r.crons() == plan['crons'], 'cron_restore_missing')
    proof = {'productionVerified': True, 'commit': plan['commit'], 'image': plan['imageIdentity']['index'],
        'sourceHashes': plan['after'], 'changedModules': len(FILES), 'cronsRestored': True,
        'runtimeModelsProxyUnchanged': True, 'oldJobsEvidenceAndFlagsPreserved': True,
        'passiveEnabled': False, 'newProviderRequests': 0, 'checkedAt': time.time()}
    save('production-proof-'+str(time.time_ns())+'.json', proof)
    print(json.dumps(proof))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('stage', 'launch', 'run', 'watch', 'recover', 'verify'), 'invalid_phase')
        globals()[phase]()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', code)
            else 'scoped_passive_release_failed'}), flush=True)
        sys.exit(1)
