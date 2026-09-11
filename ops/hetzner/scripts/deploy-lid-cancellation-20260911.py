"""Gateway-only cancellation release. No schema, Edge, model, queue or flag changes.

stage builds and tests an isolated image; deploy is an explicit separate action.
The original stopped container is retained for rollback. Only aggregate evidence
and public source hashes are printed; Docker configuration remains private.
"""
import importlib.util
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/lid-cancellation-20260911/candidate-1')
spec = importlib.util.spec_from_file_location('release_helpers',
    pathlib.Path(__file__).with_name('deploy-strict-lid-adaptive-evidence-20260910.py'))
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)
gw.MODULES = ('index.js', 'whisper-lid.js')
BASE = {'index.js': '04645c1c6a2e408284d0fa36d21e27e734da9a645aaddc7fe05666e1b3e71a52',
        'whisper-lid.js': 'b5c631015a3760a1eee14dc8be04189b772c67de1ec6ecfcda4df10d4aba93b3'}
BASE_IMAGE = 'norva-media-gateway:lid-cache-audio-20260911-candidate-1'
IMAGE = 'norva-media-gateway:lid-cancellation-20260911-candidate-1'
TESTS = ('media-gateway-benchmark-cancellation.test.js', 'media-gateway-lid-process-cancellation.test.js')


def read(name):
    return json.loads(gw.safe_file(ROOT, name).read_text())


def tree(container='norva-media-gateway'):
    code = """const fs=require('fs'),p=require('path'),c=require('crypto'),out={};
function walk(d){for(const x of fs.readdirSync(d,{withFileTypes:true})){
const f=p.join(d,x.name);if(x.isDirectory())walk(f);else if(x.isFile())out[f.slice(9)]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}}
walk('/app/src');process.stdout.write(JSON.stringify(out));"""
    return json.loads(gw.run(['docker', 'exec', container, 'node', '-e', code]))


def stage(commit):
    gw.require(re.fullmatch('[a-f0-9]{40}', commit or '') is not None, 'invalid_commit')
    gw.require(not (ROOT / 'plan.private.json').exists(), 'plan_already_exists')
    original = gw.inspect()
    gw.require(original['Config']['Image'] == BASE_IMAGE, 'unexpected_image')
    gw.require(gw.source_snapshot() == BASE, 'unexpected_baseline')
    gw.assert_image_backed_runtime(original)
    health = gw.health(original)
    gw.require(health.get('version') == 167, 'unexpected_version')
    runtime = gw.runtime_snapshot(health)
    gw.assert_runtime(health, runtime, health['languageDetectEngine']['speechSamplerBinarySha256'])
    before_tree, binaries = tree(), gw.binary_snapshot()
    identity = gw.image_identity(BASE_IMAGE)
    gw.assert_container_image(original, identity)
    context = ROOT / 'context'
    context.mkdir(mode=0o700)
    (context / 'src').mkdir(mode=0o700)
    expected = dict(before_tree)
    for name in gw.MODULES:
        content = gw.safe_file(ROOT, 'src/' + name).read_bytes().replace(b'\r\n', b'\n')
        (context / 'src' / name).write_bytes(content)
        expected[name] = gw.sha(content)
    (context / 'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n' + ''.join(
        'COPY --chmod=0644 src/' + name + ' /app/src/' + name + '\n' for name in gw.MODULES))
    alias = 'norva-lid-cancellation-base:20260911-candidate-1'
    gw.run(['docker', 'tag', identity['index'], alias])
    gw.run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE=' + alias,
            '-t', IMAGE, str(context)])
    # Execute real OS process cancellation and route fixtures against /app/src
    # from the exact candidate image, with no network and no credentials.
    os.chmod(ROOT / 'tests', 0o755)
    for name in TESTS:
        os.chmod(gw.safe_file(ROOT, 'tests/' + name), 0o644)
    acceptance = """const fs=require('fs'),cp=require('child_process');
const root='/tmp/acceptance';fs.mkdirSync(root+'/services/media-gateway/src',{recursive:true});fs.mkdirSync(root+'/tests');
for(const n of ['index.js','whisper-lid.js'])fs.copyFileSync('/app/src/'+n,root+'/services/media-gateway/src/'+n);
const names=JSON.parse(process.argv[1]);for(const n of names)fs.copyFileSync('/fixtures/'+n,root+'/tests/'+n);
const r=cp.spawnSync(process.execPath,['--test',...names.map(n=>root+'/tests/'+n)],{encoding:'utf8',timeout:30000});
if(r.status!==0)process.exit(2);console.log('candidate_cancellation_acceptance_passed');"""
    proof = gw.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cpus', '1',
        '--memory', '512m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
        '--mount', 'type=bind,src=' + str(ROOT / 'tests') + ',dst=/fixtures,readonly',
        '--entrypoint', 'node', IMAGE, '-e', acceptance, json.dumps(TESTS)], timeout=60)
    gw.require(proof.strip() == b'candidate_cancellation_acceptance_passed', 'acceptance_failed')
    gw.private_write(ROOT / 'original.private.json', original)
    plan = {'protocol': 1, 'commit': commit, 'oldContainer': original['Id'], 'oldImage': BASE_IMAGE,
        'image': IMAGE, 'oldImageIdentity': identity, 'imageIdentity': gw.image_identity(IMAGE),
        'beforeTree': before_tree, 'afterTree': expected, 'beforeBinaries': binaries, 'runtime': runtime,
        'vadSha': health['languageDetectEngine']['speechSamplerBinarySha256'],
        'candidateName': 'norva-media-gateway-lid-cancellation-candidate-1',
        'rollbackName': 'norva-media-gateway-lid-cancellation-rollback-1', 'acceptancePassed': True}
    gw.private_write(ROOT / 'plan.private.json', plan)
    print(json.dumps({'staged': True, 'commit': commit, 'acceptanceTests': 11,
        'acceptancePassed': True, 'networkDisabled': True, 'protectedSourceFiles': len(before_tree)-2}))


def verify(plan, original, candidate=True):
    active = gw.inspect()
    gw.assert_clone(original, active, IMAGE if candidate else BASE_IMAGE)
    gw.assert_container_image(active, plan['imageIdentity' if candidate else 'oldImageIdentity'])
    gw.require(tree() == plan['afterTree' if candidate else 'beforeTree'], 'source_tree_changed')
    gw.require(gw.binary_snapshot() == plan['beforeBinaries'], 'binaries_changed')
    for attempt in range(25):
        try:
            health = gw.health()
            gw.require(health.get('ok') is True and health.get('version') == 167, 'not_ready')
            gw.assert_runtime(health, plan['runtime'], plan['vadSha'])
            return health
        except Exception:
            if attempt == 24:
                raise
            time.sleep(1)


def deploy():
    plan, original = read('plan.private.json'), read('original.private.json')
    gw.require(plan['acceptancePassed'] is True, 'acceptance_required')
    gw.require(not (ROOT / 'deployment.private.json').exists(), 'deployment_already_started')
    gw.require(gw.inspect()['Id'] == plan['oldContainer'], 'active_container_changed')
    verify(plan, original, False)
    gw.require(gw.image_identity(IMAGE) == plan['imageIdentity'], 'candidate_tag_changed')
    gw.assert_image_backed_runtime(gw.inspect())
    gw.assert_idle(gw.health())
    candidate = gw.docker_api('POST', '/containers/create?name=' + plan['candidateName'],
        gw.clone_payload(original, IMAGE))
    receipt = {'candidateContainer': candidate['Id'], 'oldContainer': original['Id']}
    gw.private_write(ROOT / 'deployment.private.json', receipt)
    gw.assert_clone(original, gw.inspect(candidate['Id']), IMAGE)
    gw.assert_idle(gw.health())
    try:
        gw.run(['docker', 'stop', '--time', '20', original['Id']])
        gw.run(['docker', 'rename', original['Id'], plan['rollbackName']])
        gw.run(['docker', 'rename', candidate['Id'], gw.SERVICE])
        gw.run(['docker', 'start', candidate['Id']])
        verify(plan, original)
    except Exception:
        gw.restore_original(plan, receipt)
        verify(plan, original, False)
        raise RuntimeError('candidate_failed_original_restored') from None
    print(json.dumps({'deployed': True, 'healthy': True, 'commit': plan['commit'],
        'sourceTreeVerified': True, 'runtimeModelsAndConfigurationPreserved': True,
        'rollbackContainerRetained': True, 'schemaFlagsAndQueuesUnchanged': True}))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if sys.argv[1] == 'stage':
            stage(sys.argv[2])
        elif sys.argv[1] == 'deploy':
            deploy()
        elif sys.argv[1] == 'verify':
            p, original = read('plan.private.json'), read('original.private.json')
            h = verify(p, original)
            print(json.dumps({'verified': True, 'commit': p['commit'], 'healthOk': h['ok'],
                'activeSessions': h['activeSessions'], 'activeStrictLidBrokers': h['activeStrictLidBrokers'],
                'indexSha256': gw.source_snapshot()['index.js']}))
        else:
            raise RuntimeError('invalid_phase')
    except Exception as error:
        message = str(error)
        print(json.dumps({'ok': False, 'error': message if re.fullmatch('[a-z0-9_:-]{1,120}', message)
            else 'release_operation_failed'}))
        sys.exit(1)
