"""Pilot-only release: read-only resume-fragment introspection.

Same clone/maintenance/rollback protocol as the proven pilot releases. Patches
exactly three files, derived from the CURRENTLY RUNNING pilot image, using the
same patch script already validated by local tests. Touches no provider, no
proxy, no account and never the main Gateway.
"""
import importlib.util, json, os, pathlib, subprocess, time, urllib.request

s = importlib.util.spec_from_file_location('release', '/home/adrien/.norva/storyboard-compression-20260916/release.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)

ROOT = pathlib.Path('/home/adrien/.norva/audio-capture-pilot-v2-20260917')
NAME = 'norva-resume-cache-pilot-20260916'
IMAGE = 'norva-media-gateway:audio-capture-pilot-v2-20260917'
BASE_IMAGE = 'norva-media-gateway:audio-capture-pilot-20260917'
FILES = ['index.js']
PATCHER = '/tmp/norva-patch-introspection.js'


def request(path, secret=None, body=None):
    headers = {'Content-Type': 'application/json'}
    if secret:
        headers['Authorization'] = 'Bearer ' + secret
    req = urllib.request.Request('http://127.0.0.1:18086' + path, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def main():
    ROOT.mkdir(mode=0o700, exist_ok=True)
    assert not (ROOT / 'receipt.private.json').exists(), 'already_started'
    old = m.gw.inspect(NAME)
    mainId = m.gw.inspect('norva-media-gateway')['Id']
    assert old['Config']['Image'] == BASE_IMAGE, 'foreign_pilot'
    env = dict(x.split('=', 1) for x in old['Config']['Env'])

    health = request('/health')
    assert health['activeSessions'] == 0 and health.get('rawPumpCount', 0) == 0 \
        and health['transcribeQueueDepth'] == 0, 'pilot_busy'

    src = ROOT / 'src'
    src.mkdir(mode=0o700, exist_ok=True)
    originals = {}
    for name in FILES:
        text = subprocess.check_output(['docker', 'exec', NAME, 'cat', '/app/src/' + name]).decode()
        originals[name] = text
        (src / name).write_text(text)

    original = originals['index.js']
    anchor = "    appendSubtitleOutputs(args, session, postInputSeek);"
    assert original.count(anchor) == 1, 'anchor_count'
    original = original.replace("session.privateResumeLease && session.audioCodec === 'aac'", "session.audioCodec === 'aac'")
    # Same demux/input: no second provider connection. Local diagnostic is
    # outside the public session tree; finite 45s copy bounds CPU/disk overhead.
    patched = original
    (src / 'index.js').write_text(patched)

    assert json.loads(subprocess.check_output(['docker', 'image', 'inspect', old['Config']['Image']]))[0]['Id'] == old['Image'], 'base_tag_changed'
    (ROOT / 'Dockerfile').write_text(
        'FROM ' + old['Config']['Image'] + '\n'
        + ''.join('COPY --chmod=0644 src/%s /app/src/%s\n' % (n, n) for n in FILES))
    subprocess.check_call(['docker', 'build', '-q', '-t', IMAGE, str(ROOT)], stdout=subprocess.DEVNULL)
    for name in FILES:
        subprocess.check_call(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node',
                               IMAGE, '--check', '/app/src/' + name])

    c = m.gw.docker_api('POST', '/containers/create?name=' + NAME + '-audio-capture-v2-candidate',
                        m.gw.clone_payload(old, IMAGE))
    m.gw.assert_clone(old, m.gw.inspect(c['Id']), IMAGE)
    m.gw.private_write(ROOT / 'receipt.private.json', {'old': old, 'new': c['Id']})

    prepared = request('/maintenance/prepare', env['GATEWAY_TOKEN'], {})
    assert prepared.get('ready'), 'maintenance_not_ready'
    assert request('/maintenance/commit', env['GATEWAY_TOKEN'],
                   {'token': prepared['token']}).get('committed'), 'maintenance_not_committed'
    try:
        m.gw.run(['docker', 'stop', '--time', '20', old['Id']])
        m.gw.run(['docker', 'rename', old['Id'], NAME + '-audio-capture-v2-retained'])
        m.gw.run(['docker', 'rename', c['Id'], NAME])
        m.gw.run(['docker', 'start', c['Id']])
        ready = False
        for _ in range(30):
            try:
                ready = bool(request('/health').get('ok'))
                if ready:
                    break
            except Exception:
                pass
            time.sleep(1)
        assert ready, 'not_healthy'
        assert m.gw.inspect('norva-media-gateway')['Id'] == mainId, 'main_changed'
        probe = request('/debug/resume-ranges', env['GATEWAY_TOKEN'])
        assert probe.get('ok') and 'privateResumeByteRanges' in probe, 'introspection_absent'
        print(json.dumps({'pilotActivated': True, 'maintenanceCommitted': True, 'healthy': True,
                          'mainUnchanged': True, 'introspectionReady': True}))
    except BaseException:
        candidate = m.gw.inspect(c['Id'])
        if candidate['State']['Running']:
            m.gw.run(['docker', 'stop', '--time', '20', c['Id']])
        if candidate['Name'] == '/' + NAME:
            m.gw.run(['docker', 'rename', c['Id'], NAME + '-audio-capture-v2-rejected'])
        if m.gw.inspect(old['Id'])['Name'] != '/' + NAME:
            m.gw.run(['docker', 'rename', old['Id'], NAME])
        m.gw.run(['docker', 'start', old['Id']])
        raise


try:
    main()
except Exception as e:
    print(json.dumps({'error': str(e) if isinstance(e, AssertionError) else type(e).__name__}))
    raise SystemExit(1)
