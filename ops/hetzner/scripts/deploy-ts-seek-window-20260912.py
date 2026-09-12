"""One Gateway file: bounded TS backward seek reuse. Retained rollback, no Edge/SQL changes.

No provider I/O is initiated by deployment. The existing drain/recovery
supervisor keeps viewer priority, restores the two recorded cron active bits,
and refuses to replace a running playback or language acquisition.
"""
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/ts-seek-window-20260912')
CURRENT = ROOT.parent/'startup-subtitle-20260912'
NATIVE = ROOT.parent/'ts-seek-window-native-20260912-r2/native-proof.json'
IMAGE = 'norva-media-gateway:ts-seek-window-20260912'
FILES = ('index.js',)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


live = load('ts_window_current_release', CURRENT/'deploy-startup-subtitle-20260912.py')
op = load('ts_window_supervisor', ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT, op.NATIVE, op.FILES, op.IMAGE = ROOT, NATIVE, FILES, IMAGE
op.PREFIX = op.SERVICE+'-ts-seek-window-20260912'
op.__file__ = __file__
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
    require(current['State']['Running'] and current['RestartCount'] == 0 and not current['State']['OOMKilled'], 'gateway_unhealthy')


def stage():
    commit = sys.argv[2]
    require(re.fullmatch('[a-f0-9]{40}', commit) is not None, 'commit_missing')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(), 'stage_not_fresh')
    live.verify()
    current = gw.inspect(op.SERVICE); gw.assert_image_backed_runtime(current)
    proof = json.loads(NATIVE.read_text())
    require(proof.get('exitCode') == 0 and proof.get('counts') == {'tests':67,'pass':1,'fail':0,'skipped':66}
        and proof.get('networkDisabled') is True and proof.get('newProviderRequests') == 0
        and proof.get('image') == current['Image'], 'native_proof_mismatch')
    context = ROOT/'context'; context.mkdir(mode=0o700)
    allowed = {'services/media-gateway/src/'+name:name for name in FILES}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [entry for entry in archive.getmembers() if not entry.isdir()]
        require(len(entries) == len(allowed) and {e.name for e in entries} == set(allowed), 'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0 < entry.size < 2000000, 'archive_entry')
            data = archive.extractfile(entry).read().replace(b'\r\n',b'\n')
            require(gw.sha(data) == proof['sourceHashes'][entry.name], 'native_source_drift')
            target = context/allowed[entry.name]; target.write_bytes(data); target.chmod(0o600)
    before = live.source_snapshot(); after = {**before,**{name:gw.sha((context/name).read_bytes()) for name in FILES}}
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in FILES))
    base_tag = 'norva-ts-seek-window-base:20260912'
    gw.run(['docker','tag',current['Image'],base_tag])
    require(gw.image_identity(base_tag)['index'] == current['Image'],'build_base_drift')
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base_tag,'-t',IMAGE,str(context)])
    for name in FILES:
        gw.run(['docker','run','--rm','--network','none','--read-only','--cpus','1','--memory','512m','--entrypoint','node',IMAGE,'--check','/app/src/'+name])
    live.verify()
    parent = live.op.saved('plan.private.json')
    paths = [pathlib.Path(n) for n in parent['protectedFiles']]
    paths += [CURRENT/n for n in ('plan.private.json','receipt.private.json','closed.private.json','deploy-startup-subtitle-20260912.py')]
    paths += [NATIVE,pathlib.Path(__file__),ROOT/'source.tar']
    others = (*op.base.r.SERVICES, op.base.previous.d.SERVICES[3])
    plan = {'commit':commit,'original':current,'before':before,'after':after,
        'originalImageIdentity':gw.image_identity(current['Image']),'imageIdentity':gw.image_identity(IMAGE),
        'binaries':gw.binary_snapshot(),'runtime':gw.runtime_snapshot(gw.health()),
        'crons':op.base.r.crons(),'controls':op.base.r.controls(),
        'otherContainers':{name:gw.inspect(name)['Id'] for name in others},
        'protectedFiles':{str(p):gw.sha(p.read_bytes()) for p in paths},'stagedAt':time.time()}
    op.save('plan.private.json',plan); invariant(plan); verify_gateway(plan,False)
    print(json.dumps({'staged':True,'productionUnchanged':True,'gatewayModules':1,'edgeFiles':0,'newProviderRequests':0}))


def verify():
    plan = op.saved('plan.private.json'); closed = op.saved('closed.private.json')
    require(closed.get('productionUpdated') is True, 'deployment_not_complete')
    invariant(plan); verify_gateway(plan,True)
    require(op.base.r.crons() == plan['crons'], 'cron_restore_missing')
    print(json.dumps({'verified':True,'commit':plan['commit'],'image':plan['imageIdentity']['index'],
        'productionUpdated':True,'gatewayModules':1,'edgeFiles':0,'cronsRestored':True,'newProviderRequests':0}))


op.invariant, op.verify_gateway = invariant, verify_gateway
if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('stage','launch','run','watch','recover','verify'), 'invalid_phase')
        stage() if phase == 'stage' else verify() if phase == 'verify' else getattr(op,phase)()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'ts_window_release_failed'}),flush=True)
        sys.exit(1)
