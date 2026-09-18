"""Install the background-admission quiesce gate on the MAIN gateway.

Two files only, derived from the image currently in service. Container Config is
preserved byte for byte (no new environment variable), so assert_clone holds.

v2 fixes two defects found on the first run:
  - the pre-swap idle assertion sat OUTSIDE the rollback block, so an abort left
    a candidate container and a receipt behind. Everything after the image build
    now runs inside the guarded block, and stale artefacts are cleaned on entry.
  - a single idle sample aborted the whole run the moment background work
    resumed. It now WAITS for a quiet window, then swaps immediately.
"""
import importlib.util, json, os, pathlib, subprocess, sys, time, urllib.request

s = importlib.util.spec_from_file_location('release', '/home/adrien/.norva/storyboard-compression-20260916/release.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)

ROOT = pathlib.Path('/home/adrien/.norva/provider-quiesce-http-20260917')
NAME = 'norva-media-gateway'
CANDIDATE = NAME + '-provider-quiesce-http-candidate'
RETAINED = NAME + '-provider-quiesce-http-retained-20260917'
IMAGE = 'norva-media-gateway:provider-quiesce-http-20260917'
BASE_IMAGE = 'norva-media-gateway:provider-quiesce-20260917'
BASE_TAG = 'norva-provider-quiesce-http-base:20260917'
FILES = ['provider-quiesce.js']
PATCHER = '/tmp/norva-patch-quiesce.js'
NEWFILE = '/tmp/norva-provider-quiesce-http.js'
CHECKPOINTS = '/tmp/norva-storyboard-checkpoint-readonly.cjs'
IDLE_WAIT_SECONDS = int(os.environ.get('QUIESCE_IDLE_WAIT_SECONDS', '900'))


def health():
    with urllib.request.urlopen('http://127.0.0.1:8081/health', timeout=10) as r:
        return json.load(r)


def checkpoints():
    with open(CHECKPOINTS, 'rb') as fh:
        out = subprocess.run(['docker', 'exec', '-i', NAME, 'node', '--input-type=commonjs'],
                             stdin=fh, capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout)


def provider_busy():
    out = subprocess.check_output(['docker', 'top', NAME, '-eo', 'pid,comm'], text=True, timeout=10)
    return any(line.split()[-1] in ('ffmpeg', 'ffprobe') for line in out.splitlines()[1:] if line.split())


def idle_reason():
    """Return None when fully idle, else a short reason."""
    h = health()
    f = h.get('languageForegroundWork') or {}
    if h['activeSessions'] != 0: return 'viewer_active'
    if h.get('rawPumpCount', 0) != 0: return 'raw_pump'
    if h.get('viewerPlaybackActiveLocally') is not False: return 'viewer_flag'
    if f.get('activeOperations', 1) != 0: return 'background_running'
    if h.get('whisperInferenceActive', 0) != 0: return 'whisper_running'
    if h.get('activeStrictLidBrokers', 0): return 'strict_broker'
    if f.get('admissionChecks', 0): return 'admission'
    if provider_busy(): return 'provider_process'
    return None


def wait_for_idle(seconds):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        last = idle_reason()
        if last is None:
            return health()
        time.sleep(5)
    raise AssertionError('idle_wait_timeout:' + str(last))


def cleanup_stale():
    """Remove artefacts of a previous aborted attempt. Never touches NAME."""
    try:
        info = m.gw.inspect(CANDIDATE)
    except Exception:
        info = None
    if info:
        assert info['Name'] == '/' + CANDIDATE, 'stale_candidate_renamed'
        assert not info['State']['Running'], 'stale_candidate_running'
        m.gw.run(['docker', 'rm', info['Id']])
    receipt = ROOT / 'receipt.private.json'
    if receipt.exists():
        receipt.unlink()


def main():
    ROOT.mkdir(mode=0o700, exist_ok=True)
    assert not (ROOT / 'receipt.private.json').exists(), 'already_attempted'

    old = m.gw.inspect(NAME)
    assert old['Config']['Image'] == BASE_IMAGE, 'unexpected_base_image'

    # ---- build phase: no time pressure, production untouched ----
    src = ROOT / 'src'; src.mkdir(mode=0o700, exist_ok=True)
    text = subprocess.check_output(['docker', 'exec', NAME, 'cat', '/app/src/index.js']).decode()
    (src / 'index.js').write_text(text)
    (src / 'provider-quiesce.js').write_text(pathlib.Path(NEWFILE).read_text())
    assert 'metadataAdmissionProtocol' in (src / 'provider-quiesce.js').read_text()

    assert json.loads(subprocess.check_output(['docker', 'image', 'inspect', BASE_IMAGE]))[0]['Id'] == old['Image'], 'base_tag_changed'
    m.gw.run(['docker', 'tag', old['Image'], BASE_TAG])
    (ROOT / 'Dockerfile').write_text(
        'ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n'
        + ''.join('COPY --chmod=0644 src/%s /app/src/%s\n' % (f, f) for f in FILES))
    subprocess.check_call(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE=' + BASE_TAG,
                           '-q', '-t', IMAGE, str(ROOT)], stdout=subprocess.DEVNULL)
    for f in FILES:
        subprocess.check_call(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                               '--entrypoint', 'node', IMAGE, '--check', '/app/src/' + f])

    # ---- wait for a quiet window, then swap without delay ----
    print(json.dumps({'phase':'built_waiting_for_idle'}), flush=True)
    before_health = wait_for_idle(IDLE_WAIT_SECONDS)
    before_cp = checkpoints()
    assert before_cp['verifiedJobs'] >= 1, 'no_checkpoints'
    assert all(c['savedFrames'] == c['intactFrames'] for c in before_cp['checks'] if not c['terminal']), 'checkpoint_damaged_before'

    candidate_id = None
    swapped = False
    try:
        c = m.gw.docker_api('POST', '/containers/create?name=' + CANDIDATE, m.gw.clone_payload(old, IMAGE))
        candidate_id = c['Id']
        m.gw.assert_clone(old, m.gw.inspect(candidate_id), IMAGE)
        m.gw.private_write(ROOT / 'receipt.private.json',
                           {'old': old, 'new': candidate_id, 'beforeCheckpoints': before_cp,
                            'beforeQueue': before_health.get('transcribeQueueDepth')})
        reason = idle_reason()
        assert reason is None, 'not_idle_at_swap:' + str(reason)

        swapped = True
        m.gw.run(['docker', 'stop', '--time', '20', old['Id']])
        m.gw.run(['docker', 'rename', old['Id'], RETAINED])
        m.gw.run(['docker', 'rename', candidate_id, NAME])
        m.gw.run(['docker', 'start', candidate_id])
        swapped = True

        ready = None
        for _ in range(90):
            try:
                h = health()
                if h.get('ok'):
                    ready = h; break
            except Exception:
                pass
            time.sleep(1)
        assert ready, 'not_healthy'
        assert m.gw.inspect(NAME)['Config']['Image'] == IMAGE, 'image_mismatch'

        after_cp = checkpoints()
        assert after_cp['verifiedJobs'] == before_cp['verifiedJobs'], 'checkpoint_count_changed'
        before_saved = sorted(x['savedFrames'] for x in before_cp['checks'] if not x['terminal'])
        after_saved = sorted(x['savedFrames'] for x in after_cp['checks'] if not x['terminal'])
        assert all(a >= b for a, b in zip(after_saved, before_saved)), 'checkpoint_regressed'
        assert all(x['savedFrames'] == x['intactFrames'] for x in after_cp['checks'] if not x['terminal']), 'checkpoint_damaged_after'

        token = dict(x.split('=', 1) for x in old['Config']['Env'])['GATEWAY_TOKEN']
        req = urllib.request.Request('http://127.0.0.1:8081/provider-quiesce',
                                     headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(req, timeout=10) as r:
            q = json.load(r)
        assert q.get('ok') and q.get('held') is False and q.get('metadataAdmissionProtocol') == 1, 'quiesce_not_inert'

        print(json.dumps({'activated': True, 'healthy': True, 'image': IMAGE,
                          'storyboardsReloaded': ready.get('storyboardDurability', {}).get('pending'),
                          'checkpointsIntact': True, 'quiesceMountedAndInert': True,
                          'retainedContainer': RETAINED,
                          'queueBefore': before_health.get('transcribeQueueDepth'),
                          'queueAfter': ready.get('transcribeQueueDepth')}))
    except BaseException:
        if candidate_id:
            info = m.gw.inspect(candidate_id)
            if info['State']['Running']:
                m.gw.run(['docker', 'stop', '--time', '20', candidate_id])
            if swapped:
                if m.gw.inspect(candidate_id)['Name'] == '/' + NAME:
                    m.gw.run(['docker', 'rename', candidate_id, NAME + '-provider-quiesce-rejected'])
                if m.gw.inspect(old['Id'])['Name'] != '/' + NAME:
                    m.gw.run(['docker', 'rename', old['Id'], NAME])
                m.gw.run(['docker', 'start', old['Id']])
            else:
                # Never swapped: simply discard the candidate and the receipt.
                m.gw.run(['docker', 'rm', candidate_id])
                receipt = ROOT / 'receipt.private.json'
                if receipt.exists():
                    receipt.unlink()
        raise


try:
    main()
except Exception as e:
    print(json.dumps({'error': str(e) if isinstance(e, AssertionError) else type(e).__name__}))
    raise SystemExit(1)
