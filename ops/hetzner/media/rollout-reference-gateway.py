"""Replace an idle Gateway with the reviewed complete image; keep rollback.

Run on the existing host. No secrets are printed: the private receipt directory
contains the original Docker configuration and must remain owned/mode 0700.
Default is a read-only plan. --apply performs the reviewed replacement.
"""
import argparse
import copy
import datetime
import hashlib
import http.client
import json
import os
import pathlib
import socket
import subprocess
import time
import urllib.parse
import urllib.request

BASE = 'sha256:6ab34980137d60f028d5ddbde6869987867178182f8a9f066cc0e7fd88c787e2'
IMAGE = 'sha256:dbfaaea9a69b41d58543f00086427963a3d75e7bafd1e8e7718a27547ab67118'
REVISION = 'cfc5115c9e8631c06c95a2267e4463e646109405'
NODES = {'norva-media-gateway': 8081, 'norva-resume-cache-pilot-20260916': 18086}
DATA = pathlib.Path('/home/adrien/.norva/gateway-data/resume-cache-pilot')
ENDPOINT_FIELDS = ('IPAMConfig', 'Links', 'Aliases', 'DriverOpts', 'GwPriority')


class DockerConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=40)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def docker(method, route, body=None):
    connection = DockerConnection()
    try:
        connection.request(method, route, None if body is None else json.dumps(body),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read()
        if response.status >= 400:
            raise RuntimeError('docker_api_' + str(response.status))
        return json.loads(raw) if raw else None
    finally:
        connection.close()


def inspect(name):
    return docker('GET', '/containers/' + name + '/json')


def clone(original):
    result = copy.deepcopy(original['Config'])
    result.pop('Hostname', None)
    result['HostConfig'] = copy.deepcopy(original['HostConfig'])
    result['NetworkingConfig'] = {'EndpointsConfig': {
        name: {key: value[key] for key in ENDPOINT_FIELDS if value.get(key) is not None}
        for name, value in original['NetworkSettings']['Networks'].items()}}
    return result


def contract(config):
    result = copy.deepcopy(config)
    for key in ('Hostname', 'Image', 'Labels'):
        result.pop(key, None)
    result['HostConfig']['OomKillDisable'] = bool(result['HostConfig'].get('OomKillDisable'))
    return hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()


def env(container):
    return dict(value.split('=', 1) for value in container['Config']['Env'])


def health(name, original, debug=False):
    route = '/debug/sessions' if debug else '/health'
    request = urllib.request.Request('http://127.0.0.1:' + str(NODES[name]) + route)
    if debug:
        request.add_header('Authorization', 'Bearer ' + env(original)['GATEWAY_TOKEN'])
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def idle(name, original):
    current = inspect(name)
    assert current['Id'] == original['Id'], 'container_identity_changed'
    assert contract(clone(current)) == contract(clone(original)), 'configuration_changed'
    h = health(name, original)
    assert h.get('ok') is True and h.get('version') == 167, 'unexpected_health'
    debug = health(name, original, True)
    assert isinstance(debug.get('sessions'), list) and len(debug['sessions']) == 0, 'viewer_sessions_active_or_unknown'
    for key in ('activeSessions', 'rawPumpCount',
                'viewerSessionStartupAdmissions', 'viewerStartupReservations',
                'viewerSessionStartupWaiters', 'viewerSessionStartupLockCount',
                'backgroundCpuProcessCount', 'whisperInferenceActive',
                'argosInferenceActive', 'activeStrictLidBrokers'):
        assert type(h.get(key)) is int and h[key] == 0, 'gateway_busy_or_unknown_' + key
    for key in ('transcribeBusy', 'ocrBusy', 'translateBusy', 'lidBenchmarkBusy'):
        assert h.get(key) is False, 'gateway_busy_or_unknown_' + key
    assert h.get('videoEncoderCapacity', {}).get('active') == 0, 'encoder_active_or_unknown'
    # The native client can still hold an unexpired grant even between requests.
    sql = "select count(*) from cloud_playback_sessions where status='active' and expires_at>now() and playback_hint->>'__norvaNativeMp4SessionV1'='true';"
    count = subprocess.check_output(['docker', 'exec', 'norva-db', 'psql', '-X', '-q', '-At',
                                     '-U', 'postgres', '-d', 'postgres', '-c', sql], text=True).strip()
    assert count == '0', 'native_cloud_session_active'
    return h


def verify(name, original, expected):
    for _ in range(30):
        current = inspect(name)
        assert current['Image'] == IMAGE, 'unexpected_image'
        assert contract(clone(current)) == contract(expected), 'configuration_changed'
        try:
            h = health(name, original)
            assert h.get('ok') and h.get('version') == 167
            assert h['videoEncoder']['ready'] and h['videoEncoder']['backend'] == 'vaapi'
            assert h['playbackStartupWindows']['scope'] == 'all-authenticated-owners'
            assert h['privateResumeHlsCache']['enabled'] and not h['privateResumeHlsCache']['ownerScoped']
            assert h['boundedHlsOutput']['admissionProtocol'] == 1
            assert h['sharedVideoEncoderCapacity']['limit'] == 8
            return h
        except (OSError, ValueError, KeyError, AssertionError):
            time.sleep(1)
    raise RuntimeError('candidate_health_failed')


class UncertainAction(RuntimeError):
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('node', choices=NODES)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    original = inspect(args.node)
    assert original['Image'] == BASE, 'baseline_image_changed'
    candidate = docker('GET', '/images/' + IMAGE + '/json')
    assert candidate['Config']['Labels']['org.opencontainers.image.revision'] == REVISION
    prepared = clone(original)
    prepared['Image'] = IMAGE
    prepared['Labels'] = dict(prepared.get('Labels') or {})
    prepared['Labels']['org.opencontainers.image.revision'] = REVISION
    prepared['Labels']['norva.runtime.source-layout'] = 'complete-repository-src'
    prepared['Labels'].pop('norva.bundle.sha256', None)
    persist = args.node == 'norva-resume-cache-pilot-20260916'
    if persist:
        assert env(original)['OUTPUT_DIR'] == '/tmp/resume-pilot'
        assert not any(m['Destination'] == '/tmp/resume-pilot' for m in original['Mounts'])
        assert not DATA.exists(), 'persistent_destination_already_exists'
        prepared['HostConfig']['Binds'] = list(prepared['HostConfig'].get('Binds') or [])
        prepared['HostConfig']['Binds'].append(str(DATA) + ':/tmp/resume-pilot:rw')
    idle(args.node, original)
    summary = {'node': args.node, 'image': IMAGE, 'sourceRevision': REVISION,
               'environmentChanges': False, 'persistentOutputAdded': persist,
               'configurationSha256': contract(prepared), 'applied': False}
    if not args.apply:
        print(json.dumps(summary))
        return

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    receipt = pathlib.Path('/home/adrien/.norva/gateway-reference-rollout') / stamp
    receipt.mkdir(parents=True, mode=0o700)
    (receipt / 'original-private.json').write_text(json.dumps(original))
    (receipt / 'replacement-private.json').write_text(json.dumps(prepared))
    backup = args.node + '-before-reference-' + stamp
    summary.update({'originalId': original['Id'], 'backup': backup, 'receipt': str(receipt), 'actions': []})

    def save():
        (receipt / 'result.json').write_text(json.dumps(summary, indent=2))

    def action(label, method, route, observed, body=None):
        entry = {'action': label, 'state': 'sent'}
        summary['actions'].append(entry)
        save()
        try:
            result = docker(method, route, body)
            if not observed():
                raise UncertainAction('acknowledged_state_missing')
            entry['state'] = 'verified'
            save()
            return result
        except Exception:
            # Reconcile an ambiguous response; never repeat a mutation blindly.
            for _ in range(3):
                try:
                    if observed():
                        entry['state'] = 'verified_after_response_failure'
                        save()
                        return None
                except Exception:
                    pass
                time.sleep(1)
            entry['state'] = 'unknown_no_retry'
            summary['reconciliationRequired'] = True
            save()
            raise UncertainAction(label) from None

    replacement = None
    stopped = renamed = False
    try:
        # Gate immediately before stopping. Existing runtime has no atomic
        # viewer drain mode: a residual admission race is recorded, not hidden.
        idle(args.node, original)
        action('stop-original', 'POST', '/containers/' + original['Id'] + '/stop?t=25',
               lambda: not inspect(original['Id'])['State']['Running'])
        stopped = True
        if persist:
            assert not DATA.exists(), 'persistent_destination_already_exists'
            DATA.mkdir(parents=True, mode=0o700)
            assert DATA.resolve() == DATA and DATA.stat().st_uid == os.getuid()
            subprocess.run(['docker', 'cp', original['Id'] + ':/tmp/resume-pilot/.', str(DATA)], check=True)
            summary['outputCopiedWhileStopped'] = True
            save()
        action('rename-original', 'POST', '/containers/' + original['Id'] + '/rename?name=' + backup,
               lambda: inspect(original['Id'])['Name'] == '/' + backup)
        renamed = True
        prepared['Labels']['norva.deployment'] = 'reference-' + stamp

        def created():
            current = inspect(args.node)
            return current['Image'] == IMAGE and current['Config']['Labels'].get('norva.deployment') == 'reference-' + stamp and contract(clone(current)) == contract(prepared)

        action('create-replacement', 'POST', '/containers/create?name=' + args.node, created, prepared)
        replacement = inspect(args.node)['Id']
        summary['replacementId'] = replacement
        action('start-replacement', 'POST', '/containers/' + replacement + '/start',
               lambda: inspect(replacement)['State']['Running'])
        verify(args.node, original, prepared)
        summary.update({'applied': True, 'healthy': True})
    except UncertainAction:
        summary['rollbackDeferred'] = True
        raise
    except Exception as error:
        summary['failureType'] = type(error).__name__
        if replacement:
            current = inspect(replacement)
            if current['State']['Running']:
                # Never remove a candidate already serving a new viewer.
                idle(args.node, current)
            action('remove-replacement', 'DELETE', '/containers/' + replacement + '?force=true',
                   lambda: not any(c['Id'] == replacement for c in docker('GET', '/containers/json?all=true')))
        if renamed:
            action('restore-name', 'POST', '/containers/' + original['Id'] + '/rename?name=' + args.node,
                   lambda: inspect(original['Id'])['Name'] == '/' + args.node)
        if stopped:
            action('restart-original', 'POST', '/containers/' + original['Id'] + '/start',
                   lambda: inspect(original['Id'])['State']['Running'])
            summary['rolledBack'] = True
        raise
    finally:
        save()
        print(json.dumps(summary))


if __name__ == '__main__':
    main()
