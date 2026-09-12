"""Measured TS startup: two Gateway files and one Edge file, with retained rollback.

Reuses the existing idle/drain supervisor; no probe, playback, model, proxy,
quarantine or enrichment activation is initiated by this operator.
"""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/ts-first-frame-20260912')
CURRENT = ROOT.parent/'subtitle-master-20260912'
NATIVE = ROOT.parent/'finite-ts-policy-native-20260912-r3/native-proof.json'
APP_COMMIT = '0952c07fa7fd400e6fd06b3acc90da750655909a'
FILES = ('index.js', 'finite-ts-startup.js')
EDGE_FILE = 'norva-playback/index.ts'
BASE_EDGE_SHA = 'f6052c3e7416a4740db990d0517f8229e72ddbb211a72a34bf4e504386bb1d49'
IMAGE = 'norva-media-gateway:ts-first-frame-20260912'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


live = load('ts_first_frame_current', CURRENT/'deploy-subtitle-master-20260912.py')
op = load('ts_first_frame_supervisor', ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT, op.NATIVE, op.APP_COMMIT, op.FILES, op.IMAGE = ROOT, NATIVE, APP_COMMIT, FILES, IMAGE
op.PREFIX = op.SERVICE+'-ts-first-frame-20260912'
op.__file__ = __file__
gw, lib, edge, require = op.gw, op.lib, op.edge, op.require
EDGES = op.base.r.SERVICES
source_snapshot = live.source_snapshot
gateway_deploy = op.deploy


def verify_edge(name, plan, candidate):
    original = plan['edges'][name]
    active = gw.inspect(name)
    expected_id = op.saved(name+'-receipt.private.json')['candidateContainer'] if candidate else original['Id']
    require(active['Id'] == expected_id, 'edge_container_not_owned')
    expected = lib.edge_expected(original, ROOT/'functions') if candidate else original
    gw.assert_clone(expected, active, original['Config']['Image'])
    require(active['Image'] == original['Image'], 'edge_image_changed')
    require(edge.hashes(lib.edge_root(active)) == plan['edgeAfter' if candidate else 'edgeBefore'], 'edge_source_changed')
    lib.edge_health(active)
    require(active['State']['Running'] and active['RestartCount'] == 0 and not active['State']['OOMKilled'], 'edge_unhealthy')


def invariant(plan):
    op.base.previous.invariant(op.base.previous.saved('plan.private.json'))
    require(op.base.r.controls() == plan['controls'], 'flags_or_quarantine_changed')
    for name, digest in plan['protectedFiles'].items():
        require(gw.sha(pathlib.Path(name).read_bytes()) == digest, 'protected_evidence_changed')
    for name in EDGES:
        current = gw.inspect(name)
        verify_edge(name, plan, current['Id'] != plan['edges'][name]['Id'])
    selection = op.base.previous.d.SERVICES[3]
    require(gw.inspect(selection)['Id'] == plan['selectionId'], 'selection_container_changed')
    op.base.previous.d.verify_service(selection, op.base.previous.saved('plan.private.json')['parentPlan'])


def verify_gateway(plan, candidate):
    active = gw.inspect(op.SERVICE)
    expected_id = op.saved('receipt.private.json')['candidateContainer'] if candidate else plan['original']['Id']
    require(active['Id'] == expected_id, 'gateway_container_not_owned')
    gw.assert_clone(plan['original'], active, IMAGE if candidate else plan['original']['Config']['Image'])
    gw.assert_container_image(active, plan['imageIdentity' if candidate else 'originalImageIdentity'])
    require(source_snapshot() == plan['after' if candidate else 'before'], 'gateway_source_changed')
    require(gw.binary_snapshot() == plan['binaries'], 'runtime_binary_changed')
    health = gw.health(); gw.assert_runtime(health, plan['runtime'])
    fence = health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode') == 'disabled' and fence.get('files') == 0
        and fence.get('passiveSources') == 0, 'dormant_admission_changed')
    require(active['State']['Running'] and active['RestartCount'] == 0 and not active['State']['OOMKilled'], 'gateway_unhealthy')


def stage():
    require(re.fullmatch('[a-f0-9]{40}', APP_COMMIT) is not None, 'commit_missing')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(), 'stage_not_fresh')
    parent_plan = live.op.saved('plan.private.json')
    live.op.invariant(parent_plan); live.op.verify_gateway(parent_plan, True)
    require(live.op.saved('closed.private.json').get('productionUpdated') is True, 'parent_not_closed')
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
    allowed['supabase/functions/'+EDGE_FILE] = 'candidate.ts'
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [entry for entry in archive.getmembers() if not entry.isdir()]
        require(len(entries) == len(allowed) and {e.name for e in entries} == set(allowed), 'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0 < entry.size < 2000000, 'archive_entry')
            data = archive.extractfile(entry).read().replace(b'\r\n',b'\n')
            require(gw.sha(data) == proof['sourceHashes'][entry.name], 'native_source_drift')
            target = context/allowed[entry.name]; target.write_bytes(data); target.chmod(0o600)
    edges = {name:gw.inspect(name) for name in EDGES}
    roots = {lib.edge_root(container) for container in edges.values()}
    require(len(roots) == 1, 'edge_roots_diverged')
    old = roots.pop(); before_edge = edge.hashes(old)
    require(before_edge.get(EDGE_FILE) == BASE_EDGE_SHA, 'edge_baseline_changed')
    shutil.copytree(old, ROOT/'functions')
    (ROOT/'functions'/EDGE_FILE).write_bytes((context/'candidate.ts').read_bytes())
    after_edge = edge.hashes(ROOT/'functions')
    require(set(before_edge) == set(after_edge) and all(after_edge[k] == v for k,v in before_edge.items() if k != EDGE_FILE), 'unrelated_edge_changed')
    before = source_snapshot(); after = {**before,**{name:gw.sha((context/name).read_bytes()) for name in FILES}}
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'+''.join('COPY --chmod=0644 '+n+' /app/src/'+n+'\n' for n in FILES))
    base_tag = 'norva-ts-first-frame-base:20260912'
    gw.run(['docker','tag',current['Image'],base_tag])
    require(gw.image_identity(base_tag)['index'] == current['Image'],'build_base_drift')
    gw.run(['docker','build','--network','none','--build-arg','BASE_IMAGE='+base_tag,'-t',IMAGE,str(context)])
    for name in FILES:
        gw.run(['docker','run','--rm','--network','none','--read-only','--cpus','1','--memory','512m','--entrypoint','node',IMAGE,'--check','/app/src/'+name])
    live.op.invariant(parent_plan); live.op.verify_gateway(parent_plan, True)
    paths = [pathlib.Path(n) for n in parent_plan['protectedFiles']]
    paths += [CURRENT/n for n in ('plan.private.json','receipt.private.json','closed.private.json','deploy-subtitle-master-20260912.py')]
    paths += [NATIVE,pathlib.Path(__file__),ROOT/'source.tar']
    plan = {'commit':APP_COMMIT,'original':current,'before':before,'after':after,
        'originalImageIdentity':gw.image_identity(current['Image']),'imageIdentity':gw.image_identity(IMAGE),
        'binaries':gw.binary_snapshot(),'runtime':gw.runtime_snapshot(gw.health()),'edges':edges,
        'edgeBefore':before_edge,'edgeAfter':after_edge,'crons':op.base.r.crons(),'controls':op.base.r.controls(),
        'selectionId':gw.inspect(op.base.previous.d.SERVICES[3])['Id'],
        'protectedFiles':{str(p):gw.sha(p.read_bytes()) for p in paths},'stagedAt':time.time()}
    op.save('plan.private.json',plan); invariant(plan); verify_gateway(plan,False)
    print(json.dumps({'staged':True,'productionUnchanged':True,'gatewayModules':2,'edgeFiles':1,
        'otherEdgeFilesPreserved':len(before_edge)-1,'newProviderRequests':0}))


def activate_edge(name, plan):
    invariant(plan); verify_gateway(plan,True); verify_edge(name,plan,False)
    op.base.previous.d.idle()
    original = plan['edges'][name]
    require(not (ROOT/(name+'-receipt.private.json')).exists(),'edge_activation_already_attempted')
    expected = lib.edge_expected(original,ROOT/'functions')
    candidate_name = name+'-ts-first-frame-20260912-candidate'
    created = gw.docker_api('POST','/containers/create?name='+candidate_name,gw.clone_payload(expected,original['Config']['Image']))
    receipt = {'candidateContainer':created['Id'],'candidateName':candidate_name}
    op.save(name+'-receipt.private.json',receipt)
    gw.assert_clone(expected,gw.inspect(created['Id']),original['Config']['Image'])
    op.base.previous.d.idle()
    gw.run(['docker','stop','--time','20',original['Id']])
    gw.run(['docker','rename',original['Id'],name+'-ts-first-frame-20260912-retained'])
    gw.run(['docker','rename',created['Id'],name]); gw.run(['docker','start',created['Id']])
    for attempt in range(25):
        try:
            verify_edge(name,plan,True); return
        except Exception:
            if attempt == 24: raise
            time.sleep(1)


def deploy(plan):
    gateway_deploy(plan)
    for name in EDGES: activate_edge(name,plan)


def recover():
    plan = op.saved('plan.private.json')
    # An alias can be absent between rename operations: ownership is resolved
    # from exact durable receipts before any restoration, never from a tag.
    receipts = {name:op.saved(name+'-receipt.private.json') for name in EDGES if (ROOT/(name+'-receipt.private.json')).exists()}
    if (ROOT/'receipt.private.json').exists(): receipts[op.SERVICE] = op.saved('receipt.private.json')
    originals = {**plan['edges'],op.SERVICE:plan['original']}
    inventory = gw.docker_api('GET','/containers/json?all=true')
    current = {}
    for name,original in originals.items():
        matches = [c['Id'] for c in inventory if '/'+name in c.get('Names',[])]
        require(len(matches) <= 1,'recovery_alias_ambiguous')
        current[name] = matches[0] if matches else None
        require(current[name] is not None or name in receipts,'recovery_receipt_missing')
        require(current[name] in (original['Id'],receipts.get(name,{}).get('candidateContainer'),None),'recovery_container_not_owned')
    if len(receipts) == 3 and all(current[n] == receipts[n]['candidateContainer'] for n in originals):
        try:
            invariant(plan); verify_gateway(plan,True)
            for name in EDGES: verify_edge(name,plan,True)
        except Exception: pass
        else:
            op.restore_crons(plan); return True
    # No cancellation of user playback or queued jobs is allowed for rollback.
    if any(current[n] != originals[n]['Id'] for n in originals):
        if current[op.SERVICE] is not None: op.base.previous.d.idle()
        elif op.SERVICE in receipts: op.recovery_idle(plan,receipts[op.SERVICE])
    for name in reversed([op.SERVICE,*EDGES]):
        if current[name] != originals[name]['Id']:
            edge.restore(name,{'containers':originals},receipts[name])
    invariant(plan); verify_gateway(plan,False)
    for name in EDGES: verify_edge(name,plan,False)
    op.restore_crons(plan); return False


def close(success):
    plan = op.saved('plan.private.json'); invariant(plan); verify_gateway(plan,success)
    for name in EDGES: verify_edge(name,plan,success)
    require(op.base.r.crons() == plan['crons'],'cron_restore_missing')
    op.save('closed.private.json',{'at':time.time(),'productionUpdated':success,'cronsRestored':True,'passiveEnabled':False})


def verify():
    plan = op.saved('plan.private.json'); success = op.saved('closed.private.json')['productionUpdated']
    invariant(plan); verify_gateway(plan,success)
    for name in EDGES: verify_edge(name,plan,success)
    require(op.base.r.crons() == plan['crons'],'cron_restore_missing')
    print(json.dumps({'verified':True,'productionUpdated':success,'commit':APP_COMMIT,'newProviderRequests':0,
        'cronsRestored':True,'passiveEnabled':False,'gatewayModules':2,'edgeFiles':1}))


op.invariant,op.verify_gateway,op.deploy,op.recover,op.close = invariant,verify_gateway,deploy,recover,close

if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('stage','launch','run','watch','recover','verify'),'invalid_phase')
        stage() if phase == 'stage' else verify() if phase == 'verify' else getattr(op,phase)()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else 'ts_first_frame_release_failed'}),flush=True)
        sys.exit(1)
