"""Explicit, scoped gateway release operator. Stage builds only; deploy/rollback are separate.

Input under ROOT/REVISION: base/<three existing modules>, src/<six allowed modules>,
bin/whisper-vad-speech-segments and bin/vad-bin.sha256. No audio, provider data or secrets
are accepted into the rebuilt Docker context. The VAD binary must have been independently
built and tested; stage requires its expected SHA-256 as a separate command argument.
"""
import argparse
import copy
import hashlib
import http.client
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/strict-lid-adaptive-evidence-20260910')
SERVICE = 'norva-media-gateway'
EXPECTED_BASE_IMAGE = 'norva-media-gateway:strict-lid-extraction-20260910-fix3'
EXPECTED_BASE_INDEX_SHA = 'ef0f9652b91adfecddfc070ab04731e021adeb407342a8f22a7e37ef56a055f5'
EXISTING_MODULES = ('index.js', 'strict-lid-inference.js', 'strict-lid-window-checkpoint.js')
NEW_MODULES = ('strict-lid-audio-evidence.js', 'strict-lid-speech-window.js', 'strict-lid-speech-sampler.js')
MODULES = EXISTING_MODULES + NEW_MODULES
VAD_BINARY = '/usr/local/bin/whisper-vad-speech-segments'
VAD_DIGEST = '/opt/whisper/vad-bin.sha256'
RUNTIME_FIELDS = ('family', 'model', 'commit', 'binarySha256', 'modelSha256',
                  'runtimeVerified', 'accelerator', 'vadEnabled', 'vadModelSha256',
                  'vadRuntimeVerified', 'detectOnlyProductionAvailable')
IDLE_COUNTS = ('activeSessions', 'activeStrictLidBrokers', 'whisperInferenceActive',
               'backgroundCpuProcessCount', 'rawPumpCount', 'viewerStartupReservations',
               'viewerSessionStartupAdmissions', 'transcribeQueueDepth', 'ocrQueueDepth',
               'translateQueueDepth')
IDLE_FLAGS = ('transcribeBusy', 'ocrBusy', 'translateBusy', 'lidBenchmarkBusy',
              'viewerPlaybackActiveLocally')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args, data=None, timeout=120):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    require(result.returncode == 0, 'command_failed:' + args[0] + ':' + str(result.returncode))
    return result.stdout


def inspect(name=SERVICE):
    return json.loads(run(['docker', 'inspect', name]))[0]


def sha(raw, javascript=False):
    return hashlib.sha256(raw.replace(b'\r\n', b'\n') if javascript else raw).hexdigest()


def private_write(path, value):
    # Never overwrite a plan, proof or saved configuration from an earlier attempt.
    with path.open('x', encoding='utf-8') as handle:
        os.chmod(path, 0o600)
        handle.write(json.dumps(value, sort_keys=True))


def safe_file(parent, relative):
    candidate = parent / relative
    require(candidate.is_file() and not candidate.is_symlink(), 'missing_or_nonregular_artifact')
    require(parent.resolve() in candidate.resolve().parents, 'artifact_outside_stage')
    for ancestor in candidate.parents:
        if ancestor == parent:
            break
        require(not ancestor.is_symlink(), 'symlink_artifact_parent')
    return candidate


def revision_directory(revision):
    require(bool(re.fullmatch(r'candidate-[1-9][0-9]?', revision)), 'invalid_revision')
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'missing_or_symlink_root')
    stage = ROOT / revision
    require(stage.is_dir() and not stage.is_symlink(), 'missing_or_symlink_stage')
    require(stage.resolve().parent == ROOT.resolve(), 'stage_outside_root')
    return stage


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect('/var/run/docker.sock')


def docker_api(method, route, data=None):
    connection = DockerConnection('localhost', timeout=30)
    try:
        payload = json.dumps(data).encode() if data is not None else None
        connection.request(method, '/v1.47' + route, body=payload,
                           headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        body = response.read()
        require(200 <= response.status < 300, 'docker_api_failed:' + str(response.status))
        return json.loads(body) if body else {}
    finally:
        connection.close()


def health(container=None):
    current = container or inspect()
    env = dict(value.split('=', 1) for value in current['Config']['Env'] if '=' in value)
    ip = current['NetworkSettings']['Networks']['norva_default']['IPAddress']
    endpoint = 'http://' + ip + ':' + env.get('PORT', '8080') + '/health'
    with urllib.request.urlopen(endpoint, timeout=10) as response:
        return json.load(response)


def assert_idle(value):
    require(value.get('ok') is True, 'unhealthy_gateway')
    for key in IDLE_COUNTS:
        require(type(value.get(key)) is int and value[key] == 0, 'active_or_absent:' + key)
    require(value.get('languageWavExtraction', {}).get('active') == 0, 'active_wav_extraction')
    for key in IDLE_FLAGS:
        require(value.get(key) is False, 'active_or_absent:' + key)


def runtime_snapshot(value):
    engine = value.get('languageDetectEngine', {})
    require(engine.get('runtimeVerified') is True, 'whisper_runtime_unverified')
    require(engine.get('vadRuntimeVerified') is True, 'vad_runtime_unverified')
    for key in ('binarySha256', 'modelSha256', 'vadModelSha256'):
        require(bool(re.fullmatch(r'[a-f0-9]{64}', str(engine.get(key, '')))), 'runtime_digest_missing:' + key)
    return {key: engine.get(key) for key in RUNTIME_FIELDS}


def assert_runtime(value, expected, vad_sha=None):
    require(runtime_snapshot(value) == expected, 'existing_whisper_runtime_changed')
    if vad_sha is not None:
        engine = value['languageDetectEngine']
        require(engine.get('speechSamplerRuntimeVerified') is True, 'speech_sampler_unverified')
        require(engine.get('speechSamplerBinarySha256') == vad_sha, 'speech_sampler_health_digest_mismatch')
        require(engine.get('strictLidSpeechSelectionProtocol') == 1, 'speech_selection_protocol_missing')


def source_snapshot(container=SERVICE):
    # Only hashes are returned; no source, transcript, model or environment is printed.
    script = """const fs=require('fs'),crypto=require('crypto');
const names=JSON.parse(process.argv[1]);const out={};
for(const name of names){const p='/app/src/'+name;
if(!fs.existsSync(p)){out[name]=null;continue;}
out[name]=crypto.createHash('sha256').update(fs.readFileSync(p).toString('utf8').replace(/\\r\\n/g,'\\n')).digest('hex');}
process.stdout.write(JSON.stringify(out));"""
    return json.loads(run(['docker', 'exec', container, 'node', '-e', script, json.dumps(MODULES)]))


def binary_snapshot(container=SERVICE):
    script = """const fs=require('fs'),crypto=require('crypto');const paths=JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify(Object.fromEntries(paths.map(p=>[p,fs.existsSync(p)?
crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null]))));"""
    return json.loads(run(['docker', 'exec', container, 'node', '-e', script,
                          json.dumps([VAD_BINARY, VAD_DIGEST])]))


def assert_image_backed_runtime(container):
    # FROM the live image must not silently discard writable-layer code/runtime patches.
    differences = run(['docker', 'diff', container['Id']]).decode().splitlines()
    for entry in differences:
        location = entry[2:]
        require(not any(location == prefix or location.startswith(prefix + '/')
                        for prefix in ('/app/src', '/usr/local/bin', '/opt/whisper')),
                'runtime_has_writable_layer_changes')
    targets = ['/app/src/' + name for name in MODULES] + [VAD_BINARY, VAD_DIGEST]
    for mount in container.get('Mounts', []):
        destination = mount['Destination'].rstrip('/') or '/'
        require(not any(target == destination or target.startswith(destination + '/')
                        or destination == '/' for target in targets), 'runtime_overlay_hidden_by_mount')


def image_identity(image):
    info = json.loads(run(['docker', 'image', 'inspect', image]))[0]
    platform = json.loads(run(['docker', 'image', 'inspect', '--platform', 'linux/amd64', image]))[0]
    return {'index': info['Id'], 'manifest': platform['Id']}


def assert_container_image(container, identity):
    manifest = container.get('ImageManifestDescriptor', {}).get('digest')
    require(manifest == identity['manifest'] if manifest else container['Image'] == identity['index'],
            'container_image_identity_mismatch')


def clone_payload(original, image):
    payload = copy.deepcopy(original['Config'])
    payload['Image'] = image
    payload['HostConfig'] = copy.deepcopy(original['HostConfig'])
    payload['NetworkingConfig'] = {'EndpointsConfig': {
        name: {key: copy.deepcopy(endpoint[key]) for key in ('IPAMConfig', 'Links', 'Aliases', 'DriverOpts')
               if endpoint.get(key) is not None}
        for name, endpoint in original['NetworkSettings']['Networks'].items()
    }}
    return payload


def assert_clone(original, candidate, image):
    expected = copy.deepcopy(original['Config'])
    expected['Image'] = image
    require(expected == candidate['Config'], 'container_configuration_changed')
    left, right = copy.deepcopy(original['HostConfig']), copy.deepcopy(candidate['HostConfig'])
    for config in (left, right):
        if config.get('OomKillDisable') is None:
            config['OomKillDisable'] = False
    require(left == right, 'host_configuration_changed')
    require(set(original['NetworkSettings']['Networks']) == set(candidate['NetworkSettings']['Networks']),
            'network_set_changed')
    for name, endpoint in original['NetworkSettings']['Networks'].items():
        actual = candidate['NetworkSettings']['Networks'][name]
        for key in ('Aliases', 'IPAMConfig', 'Links', 'DriverOpts'):
            require(endpoint.get(key) == actual.get(key), 'network_configuration_changed:' + key)
    mount_keys = ('Type', 'Name', 'Source', 'Destination', 'Driver', 'Mode', 'RW', 'Propagation')
    normalized = lambda container: sorted(
        [{key: mount.get(key) for key in mount_keys} for mount in container.get('Mounts', [])],
        key=lambda item: json.dumps(item, sort_keys=True))
    require(normalized(original) == normalized(candidate), 'mounted_data_changed')


def prepare_context(stage, vad_sha):
    require(bool(re.fullmatch(r'[a-f0-9]{64}', vad_sha)), 'invalid_expected_vad_sha256')
    source = {name: safe_file(stage, 'src/' + name).read_bytes() for name in MODULES}
    base = {name: safe_file(stage, 'base/' + name).read_bytes() for name in EXISTING_MODULES}
    binary = safe_file(stage, 'bin/whisper-vad-speech-segments').read_bytes()
    digest = safe_file(stage, 'bin/vad-bin.sha256').read_bytes()
    require(binary.startswith(b'\x7fELF'), 'vad_binary_not_elf')
    require(sha(binary) == vad_sha, 'vad_binary_digest_mismatch')
    require(digest.decode('ascii').strip() == vad_sha, 'vad_build_digest_mismatch')
    require(sha(base['index.js'], True) == EXPECTED_BASE_INDEX_SHA, 'wrong_reviewed_base')
    context = stage / 'build-context'
    require(not context.exists(), 'build_context_already_exists')
    context.mkdir(mode=0o700)
    (context / 'src').mkdir(mode=0o700)
    for name, contents in source.items():
        (context / 'src' / name).write_bytes(contents)
    (context / 'whisper-vad-speech-segments').write_bytes(binary)
    (context / 'vad-bin.sha256').write_bytes(digest)
    dockerfile = 'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'
    dockerfile += ''.join('COPY --chmod=0644 src/' + name + ' /app/src/' + name + '\n' for name in MODULES)
    dockerfile += 'COPY --chmod=0755 whisper-vad-speech-segments ' + VAD_BINARY + '\n'
    dockerfile += 'COPY --chmod=0644 vad-bin.sha256 ' + VAD_DIGEST + '\n'
    (context / 'Dockerfile').write_text(dockerfile, encoding='utf-8')
    return context, {name: sha(value, True) for name, value in source.items()}, \
        {name: sha(value, True) for name, value in base.items()}, sha(digest)


def stage_release(stage, revision, vad_sha):
    require(not (stage / 'plan.private.json').exists(), 'existing_plan_do_not_overwrite')
    original = inspect()
    require(original['State']['Running'] is True, 'original_not_running')
    require(original['Config']['Image'] == EXPECTED_BASE_IMAGE, 'unexpected_live_image')
    current_health = health(original)
    require(current_health.get('version') == 166, 'unexpected_live_version')
    runtime = runtime_snapshot(current_health)
    assert_image_backed_runtime(original)
    actual_sources = source_snapshot()
    require(actual_sources['index.js'] == EXPECTED_BASE_INDEX_SHA, 'unexpected_live_source')
    require(all(actual_sources[name] is None for name in NEW_MODULES), 'new_module_already_exists')
    before_binaries = binary_snapshot()
    require(all(value is None for value in before_binaries.values()), 'speech_sampler_already_installed')
    identity = image_identity(EXPECTED_BASE_IMAGE)
    assert_container_image(original, identity)
    context, source_hashes, base_hashes, digest_sha = prepare_context(stage, vad_sha)
    require(all(actual_sources[name] == base_hashes[name] for name in EXISTING_MODULES), 'reviewed_base_drift')
    image = 'norva-media-gateway:strict-lid-adaptive-evidence-20260910-' + revision
    base_image = 'norva-strict-lid-adaptive-base:20260910-' + revision
    run(['docker', 'tag', identity['index'], base_image])
    run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE=' + base_image,
         '-t', image, str(context)])
    check = """const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const expected=JSON.parse(process.argv[1]);for(const [name,digest] of Object.entries(expected)){
const p='/app/src/'+name;cp.execFileSync(process.execPath,['--check',p],{stdio:'pipe'});
if(crypto.createHash('sha256').update(fs.readFileSync(p).toString('utf8').replace(/\\r\\n/g,'\\n')).digest('hex')!==digest)process.exit(2);}
const binary=process.argv[2],expectedBinary=process.argv[3];
if(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')!==expectedBinary)process.exit(3);
if(fs.readFileSync('/opt/whisper/vad-bin.sha256','utf8').trim()!==expectedBinary)process.exit(4);
cp.execFileSync(binary,['--help'],{stdio:'pipe',timeout:10000});"""
    run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cpus', '1', '--memory', '512m',
         '--entrypoint', 'node', image, '-e', check, json.dumps(source_hashes), VAD_BINARY, vad_sha])
    candidate_identity = image_identity(image)
    private_write(stage / 'original-inspect.private.json', original)
    plan = {'protocol': 1, 'revision': revision, 'oldContainer': original['Id'], 'oldImage': EXPECTED_BASE_IMAGE,
            'oldImageIdentity': identity, 'image': image, 'imageIdentity': candidate_identity,
            'beforeSources': actual_sources, 'candidateSources': source_hashes,
            'beforeBinaries': before_binaries, 'vadSha256': vad_sha, 'vadDigestSha256': digest_sha,
            'runtime': runtime, 'candidateName': SERVICE + '-adaptive-' + revision,
            'rollbackName': SERVICE + '-adaptive-rollback-' + revision}
    private_write(stage / 'plan.private.json', plan)
    print(json.dumps({'staged': revision, 'builtOnly': True, 'candidateImage': image,
                      'moduleCount': len(MODULES), 'vadSha256': vad_sha, 'networkDisabledForBuildAndChecks': True,
                      'privateInputsExcludedFromBuildContext': True}))


def readiness(plan, candidate):
    last_failure = 'readiness_failed'
    for _ in range(30):
        try:
            value = health()
            require(value.get('ok') is True, 'gateway_unhealthy')
            require(value.get('version') == (167 if candidate else 166), 'gateway_version_changed')
            assert_runtime(value, plan['runtime'], plan['vadSha256'] if candidate else None)
            return value
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(last_failure)


def assert_vad_validation(stage, plan):
    proof = json.loads(safe_file(stage, 'vad-validation.private.json').read_text())
    require(proof.get('protocol') == 1, 'vad_validation_protocol_missing')
    require(proof.get('candidateImageIdentity') == plan['imageIdentity'], 'vad_validation_image_mismatch')
    require(proof.get('vadSha256') == plan['vadSha256'], 'vad_validation_binary_mismatch')
    for key in ('networkDisabled', 'speechCasePassed', 'silenceCasePassed', 'shortCasePassed'):
        require(proof.get(key) is True, 'vad_validation_missing:' + key)


def verify_active(plan, original, candidate):
    active = inspect()
    assert_clone(original, active, plan['image'] if candidate else original['Config']['Image'])
    assert_container_image(active, plan['imageIdentity'] if candidate else plan['oldImageIdentity'])
    require(source_snapshot() == plan['candidateSources' if candidate else 'beforeSources'], 'active_source_mismatch')
    binaries = {VAD_BINARY: plan['vadSha256'], VAD_DIGEST: plan['vadDigestSha256']} if candidate else plan['beforeBinaries']
    require(binary_snapshot() == binaries, 'active_binary_mismatch')
    readiness(plan, candidate)


def restore_original(plan, deployment):
    candidate = inspect(deployment['candidateContainer'])
    if candidate['State']['Running']:
        run(['docker', 'stop', '--time', '20', candidate['Id']])
    if candidate['Name'] == '/' + SERVICE:
        run(['docker', 'rename', candidate['Id'], plan['candidateName']])
    original = inspect(plan['oldContainer'])
    if original['Name'] != '/' + SERVICE:
        run(['docker', 'rename', original['Id'], SERVICE])
    if not original['State']['Running']:
        run(['docker', 'start', original['Id']])


def deploy_release(stage, phase):
    plan = json.loads(safe_file(stage, 'plan.private.json').read_text())
    original = json.loads(safe_file(stage, 'original-inspect.private.json').read_text())
    require(plan.get('protocol') == 1 and plan.get('oldContainer') == original['Id'], 'invalid_plan')
    deployment_path = stage / 'deployment.private.json'
    if phase == 'rollback':
        deployment = json.loads(safe_file(stage, 'deployment.private.json').read_text())
        require(inspect()['Id'] == deployment['candidateContainer'], 'another_revision_is_active')
        assert_idle(health())
        restore_original(plan, deployment)
        verify_active(plan, original, False)
        print(json.dumps({'phase': phase, 'revision': plan['revision'], 'healthy': True, 'originalRestored': True}))
        return
    require(not deployment_path.exists(), 'existing_deployment_do_not_replay')
    # Independently produced only after real fixture tests in the exact candidate image;
    # a successful ELF --help invocation is insufficient evidence for activation.
    assert_vad_validation(stage, plan)
    current = inspect()
    require(current['Id'] == plan['oldContainer'], 'container_changed_since_stage')
    assert_clone(original, current, original['Config']['Image'])
    assert_image_backed_runtime(current)
    require(source_snapshot() == plan['beforeSources'], 'source_changed_since_stage')
    require(image_identity(plan['image']) == plan['imageIdentity'], 'candidate_image_tag_moved')
    require(binary_snapshot() == plan['beforeBinaries'], 'binary_changed_since_stage')
    assert_runtime(health(), plan['runtime'])
    assert_idle(health())
    # Only this explicit deploy command may create a credential-bearing stopped clone.
    # No Config/Env is ever written into the image or passed to a build argument.
    created = docker_api('POST', '/containers/create?name=' + plan['candidateName'], clone_payload(current, plan['image']))
    deployment = {'candidateContainer': created['Id'], 'oldContainer': current['Id']}
    private_write(deployment_path, deployment)
    assert_clone(original, inspect(created['Id']), plan['image'])
    assert_idle(health())  # Final gate immediately before stopping the original service.
    try:
        run(['docker', 'stop', '--time', '20', current['Id']])
        run(['docker', 'rename', current['Id'], plan['rollbackName']])
        run(['docker', 'rename', created['Id'], SERVICE])
        run(['docker', 'start', created['Id']])
        verify_active(plan, original, True)
    except Exception:
        restore_original(plan, deployment)
        verify_active(plan, original, False)
        raise RuntimeError('candidate_failed_original_restored') from None
    print(json.dumps({'phase': phase, 'revision': plan['revision'], 'healthy': True,
                      'moduleHashesVerified': True, 'speechSamplerRuntimeVerified': True,
                      'environmentConfigMountsPreserved': True, 'existingWhisperRuntimePreserved': True,
                      'originalContainerRetainedForRollback': True, 'queuesFlagsAndSchemaUnchanged': True}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('stage', 'deploy', 'rollback'))
    parser.add_argument('revision')
    parser.add_argument('--vad-sha256')
    args = parser.parse_args()
    stage = revision_directory(args.revision)
    if args.phase == 'stage':
        require(args.vad_sha256 is not None, 'expected_vad_sha256_required')
        stage_release(stage, args.revision, args.vad_sha256)
    else:
        require(args.vad_sha256 is None, 'unexpected_vad_sha256_argument')
        deploy_release(stage, args.phase)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exception bodies (HTTP, subprocess, Docker or filesystem) may contain secrets.
        # Emit only our closed snake-case operator code, otherwise a generic failure.
        message = str(error)
        safe = message if re.fullmatch(r'[a-z0-9_:-]{1,120}', message) else 'operator_failed'
        print(json.dumps({'ok': False, 'error': safe}), file=sys.stderr)
        sys.exit(1)
