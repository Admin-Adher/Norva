"""Scoped resume broker release, with retained rollback and the existing idle supervisor.

No Edge/SQL migration, provider test or background-enrichment activation.
Native media proof must match every changed Gateway module, byte for byte.
"""
import importlib.util
import json
import os
import pathlib
import re
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/resume-reuse-20260912')
CURRENT = ROOT.parent/'ts-seek-drain-20260912'
NATIVE = ROOT.parent/'resume-reuse-native-20260912-r3/native-proof.json'
IMAGE = 'norva-media-gateway:resume-reuse-20260912'
FILES = ('index.js', 'strict-lid-range-reuse.js', 'finitePlaybackRangeReuse.js')


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


live = load('resume_reuse_current', CURRENT/'deploy-ts-seek-drain-20260912.py')
op = load('resume_reuse_supervisor', ROOT.parent/'scoped-passive-dormant-20260912/deploy-scoped-passive-dormant-20260912.py')
op.ROOT, op.NATIVE, op.FILES, op.IMAGE = ROOT, NATIVE, FILES, IMAGE
op.PREFIX = op.SERVICE+'-resume-reuse-20260912'
op.__file__ = __file__
gw, require = op.gw, op.require


def source_snapshot(container=None):
    container = container or op.SERVICE
    result = live.live.live.source_snapshot(container)
    script = """const fs=require('fs'),c=require('crypto'),out={};
for(const name of JSON.parse(process.argv[1])){
const p='/app/src/'+name;out[name]=fs.existsSync(p)?c.createHash('sha256')
.update(fs.readFileSync(p).toString('utf8').replace(/\\r\\n/g,'\\n')).digest('hex'):null;
}process.stdout.write(JSON.stringify(out));"""
    result.update(json.loads(gw.run(['docker', 'exec', container, 'node', '-e', script, json.dumps(FILES)])))
    return result


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
    require(source_snapshot() == plan['after' if candidate else 'before'], 'gateway_source_changed')
    require(gw.binary_snapshot() == plan['binaries'], 'runtime_binary_changed')
    health = gw.health(); gw.assert_runtime(health, plan['runtime'])
    fence = health.get('languageEnrichmentPilot') or {}
    require(health.get('ok') is True and fence.get('mode') == 'disabled' and fence.get('files') == 0
        and fence.get('passiveSources') == 0, 'dormant_admission_changed')
    if candidate:
        cache = health.get('finitePlaybackRangeReuse') or {}
        require(cache.get('maxBytes') == 64*1024*1024 and cache.get('ttlMs') == 30*60_000
            and cache.get('scope') == 'process-private-owner-exact-source', 'resume_cache_limits_changed')
        require((health.get('finiteMkvSeekBroker') or {}).get('protocol') == 10, 'resume_broker_protocol_missing')
    require(current['State']['Running'] and current['RestartCount'] == 0 and not current['State']['OOMKilled'], 'gateway_unhealthy')


def stage():
    commit = sys.argv[2]
    require(re.fullmatch('[a-f0-9]{40}', commit) is not None, 'commit_missing')
    require(ROOT.is_dir() and not ROOT.is_symlink() and not (ROOT/'plan.private.json').exists(), 'stage_not_fresh')
    live.verify()
    current = gw.inspect(op.SERVICE); gw.assert_image_backed_runtime(current)
    proof = json.loads(NATIVE.read_text())
    require(proof.get('exitCode') == 0 and proof.get('counts') == {'tests':83, 'pass':1, 'fail':0, 'skipped':82}
        and proof.get('networkDisabled') is True and proof.get('newProviderRequests') == 0
        and proof.get('abortedReason') is None and proof.get('image') == current['Image'], 'native_proof_mismatch')
    context = ROOT/'context'; context.mkdir(mode=0o700)
    allowed = {'services/media-gateway/src/'+name:name for name in FILES}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [entry for entry in archive.getmembers() if not entry.isdir()]
        require(len(entries) == len(allowed) and {entry.name for entry in entries} == set(allowed), 'archive_scope')
        for entry in entries:
            require(entry.isfile() and 0 < entry.size < 2000000, 'archive_entry')
            data = archive.extractfile(entry).read().replace(b'\r\n', b'\n')
            require(gw.sha(data) == proof['sourceHashes'][entry.name], 'native_source_drift')
            target = context/allowed[entry.name]; target.write_bytes(data); target.chmod(0o600)
    before = source_snapshot()
    after = {**before, **{name:gw.sha((context/name).read_bytes()) for name in FILES}}
    (context/'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'
        + ''.join('COPY --chmod=0644 '+name+' /app/src/'+name+'\n' for name in FILES))
    base_tag = 'norva-resume-reuse-base:20260912'
    gw.run(['docker', 'tag', current['Image'], base_tag])
    require(gw.image_identity(base_tag)['index'] == current['Image'], 'build_base_drift')
    gw.run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE='+base_tag, '-t', IMAGE, str(context)])
    for name in FILES:
        gw.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cpus', '1', '--memory', '512m',
            '--entrypoint', 'node', IMAGE, '--check', '/app/src/'+name])
    live.verify()
    parent = live.op.saved('plan.private.json')
    paths = [pathlib.Path(name) for name in parent['protectedFiles']]
    paths += [CURRENT/name for name in ('plan.private.json', 'receipt.private.json', 'closed.private.json', 'deploy-ts-seek-drain-20260912.py')]
    paths += [NATIVE, pathlib.Path(__file__), ROOT/'source.tar']
    others = (*op.base.r.SERVICES, op.base.previous.d.SERVICES[3])
    plan = {'commit':commit, 'original':current, 'before':before, 'after':after,
        'originalImageIdentity':gw.image_identity(current['Image']), 'imageIdentity':gw.image_identity(IMAGE),
        'binaries':gw.binary_snapshot(), 'runtime':gw.runtime_snapshot(gw.health()),
        'crons':op.base.r.crons(), 'controls':op.base.r.controls(),
        'otherContainers':{name:gw.inspect(name)['Id'] for name in others},
        'protectedFiles':{str(path):gw.sha(path.read_bytes()) for path in paths}, 'stagedAt':time.time()}
    op.save('plan.private.json', plan); invariant(plan); verify_gateway(plan, False)
    print(json.dumps({'staged':True, 'productionUnchanged':True, 'gatewayModules':len(FILES), 'edgeFiles':0, 'newProviderRequests':0}))


def verify():
    plan = op.saved('plan.private.json')
    require(op.saved('closed.private.json').get('productionUpdated') is True, 'deployment_not_complete')
    invariant(plan); verify_gateway(plan, True)
    require(op.base.r.crons() == plan['crons'], 'cron_restore_missing')
    print(json.dumps({'verified':True, 'commit':plan['commit'], 'image':plan['imageIdentity']['index'],
        'productionUpdated':True, 'gatewayModules':len(FILES), 'edgeFiles':0, 'cronsRestored':True, 'newProviderRequests':0}))


op.invariant, op.verify_gateway = invariant, verify_gateway
if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        require(phase in ('stage', 'launch', 'run', 'watch', 'recover', 'verify'), 'invalid_phase')
        stage() if phase == 'stage' else verify() if phase == 'verify' else getattr(op, phase)()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok':False, 'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', code) else 'resume_reuse_release_failed'}), flush=True)
        sys.exit(1)
