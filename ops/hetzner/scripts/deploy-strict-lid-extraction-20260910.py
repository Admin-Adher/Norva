"""Scoped gateway overlay; no queue, schema, flags or Edge changes. Host secrets stay local."""
import hashlib
import http.client
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request

os.umask(0o077)
root = pathlib.Path('/home/adrien/.norva/strict-lid-extraction-20260910')

def run(args, data=None):
    p = subprocess.run(args, input=data, capture_output=True, timeout=120)
    if p.returncode:
        raise RuntimeError('command_failed:' + args[0] + ':' + str(p.returncode))
    return p.stdout

def inspect(name='norva-media-gateway'):
    return json.loads(run(['docker', 'inspect', name]))[0]

class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect('/var/run/docker.sock')

def docker_api(method, route, data=None):
    connection = DockerConnection('localhost', timeout=30)
    try:
        payload = json.dumps(data).encode() if data is not None else None
        connection.request(method, '/v1.47' + route, body=payload, headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        body = response.read()
        assert 200 <= response.status < 300, 'Docker API failed: ' + str(response.status)
        return json.loads(body) if body else {}
    finally:
        connection.close()

def health():
    c = inspect()
    env = dict(v.split('=', 1) for v in c['Config']['Env'] if '=' in v)
    ip = c['NetworkSettings']['Networks']['norva_default']['IPAddress']
    return json.load(urllib.request.urlopen('http://' + ip + ':' + env.get('PORT', '8080') + '/health', timeout=10))

def compose(c):
    labels = c['Config']['Labels']
    args = ['docker', 'compose', '-p', labels['com.docker.compose.project']]
    for f in labels.get('com.docker.compose.project.environment_file', '').split(','):
        if f: args += ['--env-file', f]
    for f in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', f]
    return args

def sha(raw):
    return hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest()

def assert_idle():
    h = health()
    for field in ['activeSessions', 'activeStrictLidBrokers', 'whisperInferenceActive',
                  'backgroundCpuProcessCount', 'rawPumpCount', 'viewerStartupReservations',
                  'viewerSessionStartupAdmissions', 'transcribeQueueDepth', 'ocrQueueDepth', 'translateQueueDepth']:
        assert h.get(field) == 0, 'Active work or absent health field: ' + field
    assert h.get('languageWavExtraction', {}).get('active') == 0, 'Active WAV extraction'
    for field in ['transcribeBusy', 'ocrBusy', 'translateBusy', 'lidBenchmarkBusy', 'viewerPlaybackActiveLocally']:
        assert h.get(field) is False, 'Active work or absent health field: ' + field

def assert_preserved(before, after):
    assert sorted(before['Config']['Env']) == sorted(after['Config']['Env']), 'Environment drift'
    for key in ['Binds', 'PortBindings', 'Memory', 'NanoCpus', 'Devices', 'GroupAdd', 'SecurityOpt', 'CapDrop']:
        a, b = before['HostConfig'].get(key), after['HostConfig'].get(key)
        if isinstance(a, list) and isinstance(b, list):
            a = sorted(a, key=lambda x: json.dumps(x, sort_keys=True))
            b = sorted(b, key=lambda x: json.dumps(x, sort_keys=True))
        assert a == b, 'Host configuration drift: ' + key

def assert_clone(before, after, image):
    a, b = dict(before['Config']), dict(after['Config'])
    a['Image'] = image
    assert a == b, 'Container configuration differs outside image'
    a, b = dict(before['HostConfig']), dict(after['HostConfig'])
    # Engine normalizes the default nullable OOM switch to false at Create.
    for host in [a, b]:
        if host.get('OomKillDisable') is None: host['OomKillDisable'] = False
    assert a == b, 'Host configuration changed'
    for name, endpoint in before['NetworkSettings']['Networks'].items():
        actual = after['NetworkSettings']['Networks'][name]
        for field in ['Aliases', 'IPAMConfig', 'Links', 'DriverOpts']:
            assert endpoint.get(field) == actual.get(field), 'Network configuration changed: ' + field

def readiness():
    for _ in range(25):
        try:
            h = health()
            if h.get('ok') is True and h.get('languageDetectEngine', {}).get('runtimeVerified') is True:
                return h
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('readiness_failed')

phase, revision = sys.argv[1:3]
assert revision in ['diagnostic', 'diagnostic2', 'fix', 'fix2', 'fix3'], 'Unknown bounded revision'
stage = root / revision
plan_path = stage / 'plan.json'
if phase == 'stage':
    assert not plan_path.exists(), 'Existing plan: do not overwrite'
    c = inspect()
    live = run(['docker', 'exec', 'norva-media-gateway', 'cat', '/app/src/index.js'])
    base = (stage / 'base.js').read_bytes()
    candidate = (stage / 'index.js').read_bytes()
    assert sha(live) == sha(base), 'Live source differs from reviewed base'
    assert sha(candidate) != sha(base), 'Empty overlay'
    image = 'norva-media-gateway:strict-lid-extraction-20260910-' + revision
    base_image = 'norva-strict-lid-extraction-base:20260910-' + revision
    # Engine 29's containerd store exposes the config digest in Container.Image,
    # but tags images by the OCI index digest. Bind the configured tag to the
    # running platform manifest before pinning that immutable index for Build.
    image_info = json.loads(run(['docker', 'image', 'inspect', c['Config']['Image']]))[0]
    if c.get('ImageManifestDescriptor'):
        platform_info = json.loads(run(['docker', 'image', 'inspect', '--platform', 'linux/amd64', c['Config']['Image']]))[0]
        assert platform_info['Id'] == c['ImageManifestDescriptor']['digest'], 'Base image tag moved'
    else:
        assert image_info['Id'] == c['Image'], 'Base image tag moved'
    run(['docker', 'tag', image_info['Id'], base_image])
    (stage / 'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nCOPY --chmod=0644 index.js /app/src/index.js\n')
    run(['docker', 'build', '--build-arg', 'BASE_IMAGE=' + base_image, '-t', image, str(stage)])
    run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '--check', '/app/src/index.js'])
    # The running deployment's original Compose/env files were garbage-collected.
    # Preserve the entire observed Config, HostConfig and network settings through
    # Engine Create instead of reconstructing credentials or guessed defaults.
    # Never start the clone before the idle original is stopped. Retain that exact
    # original container for rollback; no container or user data is deleted here.
    (stage / 'original-inspect.private.json').write_text(json.dumps(c))
    payload = dict(c['Config'])
    payload['Image'] = image
    payload['HostConfig'] = c['HostConfig']
    payload['NetworkingConfig'] = {'EndpointsConfig': {
        name: {key: endpoint[key] for key in ['IPAMConfig', 'Links', 'Aliases', 'DriverOpts'] if endpoint.get(key) is not None}
        for name, endpoint in c['NetworkSettings']['Networks'].items()
    }}
    candidate_name = 'norva-media-gateway-lid-candidate-' + revision
    existing = subprocess.run(['docker', 'inspect', candidate_name], capture_output=True)
    if existing.returncode == 0:
        old_candidate = json.loads(existing.stdout)[0]
        assert old_candidate['State']['Status'] == 'created', 'Existing candidate was already used'
        created = {'Id': old_candidate['Id']}
    else:
        created = docker_api('POST', '/containers/create?name=' + candidate_name, payload)
    assert_clone(c, inspect(created['Id']), image)
    plan = {'oldContainer': c['Id'], 'oldImage': c['Image'], 'image': image,
            'candidateContainer': created['Id'], 'candidateName': candidate_name,
            'rollbackName': 'norva-media-gateway-lid-rollback-' + revision,
            'beforeSha256': sha(base), 'candidateSha256': sha(candidate),
            'configPreserved': True}
    plan_path.write_text(json.dumps(plan))
    print(json.dumps({'staged': revision, 'beforeSha256': sha(base), 'candidateSha256': sha(candidate),
                      'onlyChange': 'gateway JavaScript overlay', 'rollbackPrepared': True}))
elif phase in ['deploy', 'rollback']:
    plan = json.loads(plan_path.read_text())
    before = inspect()
    if phase == 'deploy':
        assert before['Id'] == plan['oldContainer'], 'Container changed after preflight'
    else:
        assert before['Id'] == plan['candidateContainer'], 'Only this active revision can be rolled back'
    assert_idle()
    def rollback():
        candidate = inspect(plan['candidateContainer'])
        if candidate['State']['Running']:
            run(['docker', 'stop', '--time', '20', plan['candidateContainer']])
        if candidate['Name'] == '/norva-media-gateway':
            run(['docker', 'rename', plan['candidateContainer'], plan['candidateName']])
        original = inspect(plan['oldContainer'])
        if original['Name'] != '/norva-media-gateway':
            run(['docker', 'rename', plan['oldContainer'], 'norva-media-gateway'])
        run(['docker', 'start', plan['oldContainer']])
    try:
        if phase == 'deploy':
            assert_clone(before, inspect(plan['candidateContainer']), plan['image'])
            run(['docker', 'stop', '--time', '20', plan['oldContainer']])
            run(['docker', 'rename', plan['oldContainer'], plan['rollbackName']])
            run(['docker', 'rename', plan['candidateContainer'], 'norva-media-gateway'])
            run(['docker', 'start', plan['candidateContainer']])
        else:
            rollback()
        h = readiness()
        assert_preserved(before, inspect())
        actual = sha(run(['docker', 'exec', 'norva-media-gateway', 'cat', '/app/src/index.js']))
        assert actual == plan['candidateSha256' if phase == 'deploy' else 'beforeSha256'], 'Source mismatch'
    except Exception:
        if phase == 'deploy':
            rollback()
            readiness()
        raise
    print(json.dumps({'phase': phase, 'revision': revision, 'healthy': True, 'sourceSha256': actual,
                      'version': h.get('version'), 'environmentPreserved': True,
                      'queuesAndFlagsUnchanged': True}))
else:
    raise RuntimeError('Unknown phase')
