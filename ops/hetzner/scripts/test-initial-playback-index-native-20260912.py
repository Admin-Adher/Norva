"""Bounded, network-isolated native proof. No production changes or provider I/O."""
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/initial-playback-index-native-20260912-r9')
PARENT = ROOT.parent/'initial-playback-idr-retry-20260912/retry-idr-deploy.py'
FILES = {'services/media-gateway/src/'+name for name in
    ('index.js', 'finite-ts-startup.js', 'strict-lid-range-reuse.js', 'finitePlaybackRangeReuse.js', 'finite-ts-seek-index.js', 'finite-ts-landmarks.js', 'video-encoder.js')}
FILES.update({'tests/media-gateway-strict-lid-broker.test.js', 'tests/finite-ts-seek-index.test.js', 'tests/finite-ts-seek-index-native.test.js', 'tests/fixtures/finite-ts-index-broker.js'})


def main():
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location('resume_reuse_native_parent', PARENT)
    live = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = live
    spec.loader.exec_module(live)
    live = live.m
    live.verify()
    gw = live.gw
    health = gw.health()
    for key in ('activeSessions', 'whisperInferenceActive', 'backgroundWhisperInferenceActive', 'activeViewerSubtitleOperations'):
        assert health.get(key) == 0, 'native_work_active:' + key
    def cpu():
        return [int(n) for n in pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    a = cpu(); time.sleep(1); b = cpu(); delta = [y-x for x, y in zip(a, b)]
    idle = (os.cpu_count() or 1)*delta[3]/max(1, sum(delta))
    assert idle >= 4 and delta[4]/max(1, sum(delta)) < .05, 'native_cpu_headroom'
    mem = dict(x.split(':', 1) for x in pathlib.Path('/proc/meminfo').read_text().splitlines())
    assert int(mem['MemAvailable'].split()[0]) >= 4*1024*1024, 'native_memory_headroom'
    payload = ROOT/'payload'
    assert not payload.exists() and not (ROOT/'native-tests.log').exists(), 'native_not_fresh'
    payload.mkdir(mode=0o700)
    hashes = {}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [x for x in archive.getmembers() if not x.isdir()]
        assert len(entries) == len(FILES) and {x.name for x in entries} == FILES
        for item in entries:
            assert item.isfile() and 0 < item.size < 2000000
            target = payload/item.name
            assert target.resolve().is_relative_to(payload.resolve())
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            data = archive.extractfile(item).read().replace(b'\r\n', b'\n')
            target.write_bytes(data); target.chmod(0o644); hashes[item.name] = gw.sha(data)
    image = gw.inspect()['Image']
    name = 'norva-initial-playback-index-native-20260912'
    log = ROOT/'native-tests.log'
    reason = None
    with log.open('x') as output:
        process = subprocess.Popen(['docker', 'run', '--name', name, '--rm', '--network', 'none',
            '--device', '/dev/dri/renderD128:/dev/dri/renderD128', '-e', 'NORVA_TS_INDEX_VAAPI=1',
            '--cpus', '1', '--memory', '768m', '--pids-limit', '128', '--read-only',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '-v', str(payload)+':/test:ro',
            '-e', 'NODE_PATH=/app/node_modules', '-e', 'NORVA_TS_BROKER_NATIVE=1', '-e', 'NORVA_TS_INDEX_NATIVE=1', '--entrypoint', 'node', image,
            '--test', '--test-reporter=tap', '/test/tests/media-gateway-strict-lid-broker.test.js',
            '/test/tests/finite-ts-seek-index.test.js', '/test/tests/finite-ts-seek-index-native.test.js'], stdout=output, stderr=output)
        at = time.monotonic()
        while process.poll() is None:
            time.sleep(2)
            try:
                current = gw.health()
                if current.get('activeSessions', 0) > 0 or current.get('activeViewerSubtitleOperations', 0) > 0:
                    reason = 'viewer_started'
            except Exception:
                reason = 'health_unavailable'
            if time.monotonic()-at > 200:
                reason = 'native_deadline'
            if reason:
                subprocess.run(['docker', 'stop', '--time', '1', name], capture_output=True, timeout=10)
                break
        code = process.wait(timeout=15)
    text = log.read_text()
    counts = {key: int(match.group(1)) if (match := re.search(r'^# '+key+r' (\d+)$', text, re.M)) else None
        for key in ('tests', 'pass', 'fail', 'skipped')}
    proof = {'exitCode': code, 'abortedReason': reason, 'image': image, 'counts': counts,
        'sourceHashes': hashes, 'networkDisabled': True, 'newProviderRequests': 0,
        'productionUnchanged': True, 'measuredIdleCpuCores': round(idle, 2), 'testCpuLimit': 1}
    index_rows = [line.split('native initial index metrics ', 1)[1] for line in text.splitlines()
        if 'native initial index metrics ' in line]
    proof['indexMetrics'] = json.loads(index_rows[0]) if len(index_rows) == 1 else []
    gw.private_write(ROOT/'native-proof.json', proof)
    live.verify()
    print(json.dumps(proof))
    print('\n'.join(line for line in text.splitlines() if 'native TS broker metrics' in line or 'native initial index metrics' in line))
    if code:
        print(text[-6000:])
    sys.exit(code)


if __name__ == '__main__':
    main()
