"""Scoped TS accurate-resume release, preserving the deployed Edge/browser policy.

Two Gateway modules only. No provider requests, model/route changes, quarantine
resets or enrichment activation. Existing work drains; retained image rollback
and the recorded cron state are supervised by the proven scoped operator.
"""
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/ts-aligned-resume-20260912')
CURRENT = ROOT.parent/'ts-first-frame-20260912'
NATIVE = ROOT.parent/'finite-ts-policy-native-20260912-r5/native-proof.json'
APP_COMMIT = '15d3cd5e4f48b3d3135caf5976b9ae6a3de276f1'
FILES = ('index.js', 'finite-ts-startup.js')
IMAGE = 'norva-media-gateway:ts-aligned-resume-20260912'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


live = load('ts_resume_live_parent', CURRENT/'deploy-ts-first-frame-20260912.py')
op = load('ts_resume_supervisor', ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT, op.NATIVE, op.APP_COMMIT, op.FILES, op.IMAGE = ROOT, NATIVE, APP_COMMIT, FILES, IMAGE
op.PREFIX = op.SERVICE+'-ts-aligned-resume-20260912'
op.__file__ = __file__
gw, require = op.gw, op.require
source_snapshot = live.source_snapshot


def invariant(plan):
    # The parent verifies its current Edge containers and immutable historic
    # evidence, but deliberately does not attest this new Gateway as its own.
    live.invariant(live.op.saved('plan.private.json'))
    require(op.base.r.controls() == plan['controls'], 'flags_or_quarantine_changed')
    for name, digest in plan['protectedFiles'].items():
        require(gw.sha(pathlib.Path(name).read_bytes()) == digest, 'protected_evidence_changed')
    for name, identity in plan['otherContainers'].items():
        require(gw.inspect(name)['Id'] == identity, 'unrelated_container_changed')


def verify_gateway(plan, candidate):
    active = gw.inspect(op.SERVICE)
    expected = op.saved('receipt.private.json')['candidateContainer'] if candidate else plan['original']['Id']
    require(active['Id'] == expected, 'gateway_container_not_owned')
    gw.assert_clone(plan['original'], active, IMAGE if candidate else plan['original']['Config']['Image'])
    gw.assert_container_image(active, plan['imageIdentity' if candidate else 'originalImageIdentity'])
    require(source_snapshot() == plan['after' if candidate else 'before'], 'gateway_source_changed')
    require(gw.binary_snapshot() == plan['binaries'], 'runtime_binary_changed')
    health = gw.health(); gw.assert_runtime(health, plan['runtime'])
    fence = health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode') == 'disabled' and fence.get('files') == 0
        and fence.get('passiveSources') == 0, 'dormant_admission_changed')
    require(active['State']['Running'] and active['RestartCount'] == 0 and not active['State']['OOMKilled'], 'gateway_unhealthy')


def verify_parent():
    plan = live.op.saved('plan.private.json')
    live.invariant(plan); live.verify_gateway(plan, True)
    require(live.op.saved('closed.private.json').get('productionUpdated') is True, 'parent_not_closed')
    require(op.base.r.crons() == plan['crons'], 'parent_cron_drift')


def stage():
    require(re.fullmatch('[a-f0-9]{40}', APP_COMMIT) is not None, 'commit_missing')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(), 'stage_not_fresh')
    verify_parent()
    current = gw.inspect(op.SERVICE); gw.assert_image_backed_runtime(current)
    proof = json.loads(NATIVE.read_text())
    require(proof.get('exitCode') == 0 and proof.get('counts') == {'tests':16,'pass':16,'fail':0,'skipped':0}
        and proof.get('networkDisabled') is True and proof.get('newProviderRequests') == 0
        and proof.get('image') == current['Image'], 'native_proof_mismatch')
    env = dict(v.split('=',1) for v in current['Config']['Env'] if '=' in v)
    require(env.get('FINITE_TS_FAST_START_ENABLED') != 'false', 'finite_ts_disabled')
    require(env.get('LANGUAGE_ENRICHMENT_ACTIVATION_MODE') == 'disabled'
        and all(env.get(k) == '0' for k in ('LANGUAGE_PASSIVE_CAPTURE_ENABLED',
            'LANGUAGE_CAPTURE_PIPELINE_ENABLED','LANGUAGE_METADATA_LANE_ENABLED')), 'enrichment_not_dormant')
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
    before = source_snapshot(); after = {**before,**{name:gw.sha((context/name).read_bytes()) for name in FILES}}
    base_tag = 'norva-ts-aligned-resume-base:20260912'
    gw.run(['docker','tag',current['Image'],base_tag])
    require(gw.image_identity(base_tag)['index'] == current['Image'],'build_base_drift')
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in FILES))
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base_tag,'-t',IMAGE,str(context)])
    for name in FILES:
        gw.run(['docker','run','--rm','--network','none','--read-only','--cpus','1','--memory','512m','--entrypoint','node',IMAGE,'--check','/app/src/'+name])
    verify_parent()
    parent = live.op.saved('plan.private.json')
    paths = [pathlib.Path(n) for n in parent['protectedFiles']]
    paths += [CURRENT/n for n in ('plan.private.json','receipt.private.json','closed.private.json','deploy-ts-first-frame-20260912.py')]
    paths += [CURRENT/(name+'-receipt.private.json') for name in live.EDGES]
    paths += [NATIVE,pathlib.Path(__file__),ROOT/'source.tar']
    plan = {'commit':APP_COMMIT,'original':current,'before':before,'after':after,
        'originalImageIdentity':gw.image_identity(current['Image']),'imageIdentity':gw.image_identity(IMAGE),
        'binaries':gw.binary_snapshot(),'runtime':gw.runtime_snapshot(gw.health()),
        'crons':op.base.r.crons(),'controls':op.base.r.controls(),
        'otherContainers':{name:gw.inspect(name)['Id'] for name in (*live.EDGES,op.base.previous.d.SERVICES[3])},
        'protectedFiles':{str(p):gw.sha(p.read_bytes()) for p in paths},'stagedAt':time.time()}
    op.save('plan.private.json',plan); invariant(plan); verify_gateway(plan,False)
    print(json.dumps({'staged':True,'productionUnchanged':True,'gatewayModules':2,'edgeFiles':0,
        'newProviderRequests':0,'passiveEnabled':False}))


op.invariant, op.verify_gateway = invariant, verify_gateway

if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('stage','launch','run','watch','recover','verify'),'invalid_phase')
        stage() if phase == 'stage' else getattr(op,phase)()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'ts_resume_release_failed'}),flush=True)
        sys.exit(1)
