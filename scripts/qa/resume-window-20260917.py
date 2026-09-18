"""Bounded remote pilot trace. Credentials never leave the host or enter output."""
import importlib.util
import json
import pathlib
import signal
import subprocess
import time
import urllib.request

s = importlib.util.spec_from_file_location('old', '/tmp/norva-window.py')
w = importlib.util.module_from_spec(s)
s.loader.exec_module(w)
PILOT = 'norva-resume-cache-pilot-20260916'
ROOT = pathlib.Path('/home/adrien/.norva/resume-recheck-20260917')
ROOT.mkdir(mode=0o700, exist_ok=True)
STOP = ROOT / 'stop'
READY = ROOT / 'ready'

def inspect(n):
    return json.loads(subprocess.check_output(['docker', 'inspect', n]))[0]

def api(port, path, body=None, method=None):
    r = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path),
        headers={'Authorization': 'Bearer ' + w.token(), 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode(), method=method)
    with urllib.request.urlopen(r, timeout=10) as f:
        data = f.read()
        return json.loads(data) if data else None

def checkpoints():
    return json.loads(subprocess.check_output(['docker', 'exec', '-i', w.MAIN, 'node'],
        input=pathlib.Path('/tmp/norva-storyboard-checkpoint-readonly.cjs').read_bytes()))

def cleanup():
    # The pilot must be empty at admission, so new sessions belong to this test.
    for row in api(18086, '/debug/sessions')['sessions']:
        api(18086, '/sessions/' + row['id'], method='DELETE')
    remaining = api(18086, '/debug/sessions')['sessions']
    if remaining:
        affinities = list({r['providerProxy']['affinitySha256'] for r in remaining})
        drained = api(18086, '/sessions/stop-provider-affinities', {'affinityHashes': affinities})
        assert drained['providerDrained'], 'pilot_not_drained'
    assert not api(18086, '/debug/sessions')['sessions'], 'pilot_sessions_remaining'

def media_processes():
    # comm is the executable name, not free text from command-line arguments.
    # A diagnostic containing the word ffmpeg must never count as a decoder.
    output = subprocess.check_output(['docker', 'top', w.MAIN, '-eo', 'pid,comm'], text=True, timeout=10)
    return [line.split() for line in output.splitlines()[1:]
        if line.split() and line.split()[-1] in ('ffmpeg', 'ffprobe')]

w.provider_busy = lambda: bool(media_processes())

def interrupted(*_):
    raise KeyboardInterrupt()

def emergency_restore(names):
    try:
        cleanup()
    finally:
        for n in names:
            subprocess.run(['docker', 'unpause', n], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=15)

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    admission = api(8081, '/provider-quiesce')
    assert admission.get('metadataAdmissionProtocol') == 1, 'metadata_gate_missing'
    assert not admission['held'], 'foreign_lease'
    assert not api(18086, '/debug/sessions')['sessions'], 'pilot_busy'
    names = [w.SECONDARY[-1]] + w.SECONDARY[:-1]
    baseline = {n: inspect(n) for n in [w.MAIN] + names}
    for n in names:
        assert baseline[n]['State']['Running'] and not baseline[n]['State']['Paused']
        js = "fetch('http://127.0.0.1:'+process.env.PORT+'/health',{headers:{Authorization:'Bearer '+(process.env.MEDIA_LAB_RUNNER_TOKEN||'')}}).then(r=>r.json()).then(h=>console.log(JSON.stringify(h)))"
        h = json.loads(subprocess.check_output(['docker', 'exec', n, 'node', '-e', js], timeout=15))
        assert not any(h.get(k, False) for k in ['busy', 'activeSessions', 'rawPumpCount', 'transcribeBusy', 'ocrBusy', 'whisperInferenceActive', 'activeStrictLidBrokers']), 'secondary_busy'
    before = checkpoints()
    STOP.unlink(missing_ok=True)
    READY.unlink(missing_ok=True)
    lease = None
    paused = []
    # Independent recovery also survives SIGKILL and SSH loss.
    watchdog_code = "import runpy,time;time.sleep(930);w=runpy.run_path('/tmp/resume-window-20260917.py');w['emergency_restore'](%r)" % names
    watchdog = subprocess.Popen(['python3', '-c', watchdog_code], start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for n in names:
            subprocess.run(['docker', 'pause', n], check=True, stdout=subprocess.DEVNULL, timeout=10)
            paused.append(n)
        lease = api(8081, '/provider-quiesce/begin', {'reason': 'authorized exact resume trace'})['token']
        started = time.monotonic()
        with (ROOT / 'trace.jsonl').open('w') as out:
            while time.monotonic() - started < 900 and not STOP.exists():
                api(8081, '/provider-quiesce/renew', {'token': lease})
                reason = w.idle_reason()
                admission = api(8081, '/provider-quiesce')
                h = w.health()
                if not admission['held']:
                    raise RuntimeError('lease_lost')
                if reason is None and admission['activeMetadataRequests']:
                    reason = 'metadata_request'
                if reason is None and h.get('activeStrictLidBrokers', 0):
                    reason = 'strict_broker'
                if reason is None and h.get('languageForegroundWork', {}).get('admissionChecks', 0):
                    reason = 'admission_check'
                if reason == 'viewer_active':
                    raise RuntimeError('viewer_priority')
                if not READY.exists() and reason is None:
                    READY.touch()
                    print('WINDOW_READY', flush=True)
                if READY.exists() and reason is not None:
                    h = w.health()
                    print(json.dumps({'abortReason': reason, 'processes': media_processes(), 'main': {k: h.get(k) for k in ['languageForegroundWork', 'whisperInferenceActive', 'rawPumpCount', 'activeSessions', 'activeStrictLidBrokers', 'backgroundCpuProcessCount']}}), flush=True)
                    raise RuntimeError('main_not_idle:' + reason)
                rows = api(18086, '/debug/sessions')['sessions']
                safe = [{k: r.get(k) for k in ['id', 'status', 'mode', 'requestedSeekOffset', 'actualStartOffset', 'startupTimings', 'finiteMkvSeekBroker']} for r in rows]
                out.write(json.dumps({'at': time.time(), 'sessions': safe, 'ranges': api(18086, '/debug/resume-ranges')}) + '\n')
                out.flush()
                time.sleep(5)
    finally:
        READY.unlink(missing_ok=True)
        cleanup_error = None
        try:
            cleanup()
        except Exception as e:
            cleanup_error = type(e).__name__
        if lease:
            try:
                api(8081, '/provider-quiesce/cancel', {'token': lease})
            except Exception:
                pass
        for n in reversed(paused):
            try:
                subprocess.run(['docker', 'unpause', n], stdout=subprocess.DEVNULL, timeout=10)
            except Exception:
                pass
        after = checkpoints()
        restored = all(inspect(n)['State']['Running'] and not inspect(n)['State']['Paused'] and inspect(n)['RestartCount'] == d['RestartCount'] for n, d in baseline.items())
        result = {'restored': restored, 'checkpointsEqual': before == after, 'leaseHeld': api(8081, '/provider-quiesce')['held'], 'cleanupError': cleanup_error}
        (ROOT / 'restoration.json').write_text(json.dumps(result))
        print(json.dumps(result), flush=True)
        if restored and not cleanup_error:
            watchdog.terminate()
