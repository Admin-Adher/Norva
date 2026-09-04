"""Internal-only LID inference check. No provider access or catalogue writes.

Run on the Docker host with Python 3. Tokens stay in memory; only sanitized
results are printed. The speech fixture is pinned to the deployed Whisper
revision. This checks routing, not multilingual accuracy or playback latency.
"""
import hashlib
import io
import json
import subprocess
import time
import urllib.request
import wave


def main():
    container = json.loads(subprocess.check_output([
        'docker', 'inspect', 'norva-lid-lid-worker-1',
    ]))[0]
    env = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
    ip = container['NetworkSettings']['Networks']['norva_default']['IPAddress']
    base = 'http://' + ip + ':8091'

    def health():
        with urllib.request.urlopen(base + '/readyz', timeout=10) as response:
            result = json.load(response)
        assert result['ok'] is True
        assert result['protocolVersion'] == 2
        assert result['policyVersion'] == 'lid-cascade-v1'
        assert result['calibration']['fastEligible'] is True
        assert result['queue']['active'] is False and result['queue']['depth'] == 0
        return result

    print(json.dumps({'before': health()}), flush=True)
    fixture = ('https://raw.githubusercontent.com/ggml-org/whisper.cpp/'
               '080bbbe85230f624f0b52127f1ae1218247989f9/samples/jfk.wav')
    with urllib.request.urlopen(fixture, timeout=20) as response:
        speech = response.read(1572865)
    assert len(speech) <= 1572864
    assert hashlib.sha256(speech).hexdigest() == '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'
    with wave.open(io.BytesIO(speech)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
        assert wav.getnframes() / wav.getframerate() <= 35
    silence_buffer = io.BytesIO()
    with wave.open(silence_buffer, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b'\x00' * (16000 * 2 * 10))

    for label, body, mode in [
        ('jfk-canary', speech, 'canary'),
        ('silence-canary', silence_buffer.getvalue(), 'canary'),
        ('jfk-shadow-baseline', speech, 'shadow'),
    ]:
        health()
        digest = hashlib.sha256(body).hexdigest()
        req = urllib.request.Request(base + '/v1/classify', data=body, headers={
            'Authorization': 'Bearer ' + env['LID_WORKER_TOKEN'],
            'Content-Type': 'audio/wav',
            'X-Norva-Lid-Attempt': 'operator-smoke-' + label + '-' + str(time.time_ns()),
            'X-Norva-Lid-Policy': 'lid-cascade-v1',
            'X-Norva-Lid-Mode': mode,
            'X-Norva-Lid-Protocol': '2',
            'X-Norva-Sample-Sha256': digest,
        })
        start = time.monotonic()
        with urllib.request.urlopen(req, timeout=110) as response:
            result = json.load(response)
        print(json.dumps({
            'test': label, 'elapsedMs': round((time.monotonic() - start) * 1000),
            'fixtureSha256': digest,
            **{key: result.get(key) for key in [
                'ok', 'route', 'language', 'verified', 'persisted', 'timings',
            ]},
        }), flush=True)
        assert result['ok'] is True
        assert result.get('persisted') is not True and result.get('verified') is not True
        if label.startswith('silence'):
            assert result['route'] == 'pending-no-speech' and result['language'] is None
        else:
            assert result['language'] == 'en'
    print(json.dumps({'after': health()}), flush=True)


if __name__ == '__main__':
    main()
