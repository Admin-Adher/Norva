"""Queue regression tests in the exact production image, without networking.

No media extraction/inference, production mutation, provider I/O or secrets.
One half CPU, 256 MiB and a 30-second limit; viewer activity aborts the test.
"""
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import time

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-admission-native-20260913-r2')
PARENT = ROOT.parent/'initial-playback-topology-20260912/deploy-initial-playback-topology-20260912.py'
# The complete application suite also executes the metadata Edge TypeScript
# fixtures with Node 24. Gateway's Node 20 has no stripTypeScriptTypes API;
# this native proof targets all 32 Gateway queue/QoS/latency cases, without
# patching its runtime or silently skipping individual tests.
TESTS = ('enrichment-deferred-media-work.test.js',
    'media-gateway-viewer-qos.test.js', 'ai-subtitle-latency-contract.test.js')
FILES = {'tests/'+name for name in TESTS} | {
    'services/media-gateway/src/index.js',
    'services/media-gateway/src/language-background-capacity.js',
    'supabase/functions/norva-playback/index.ts',
    'supabase/migrations/20260830075932_generated_subtitle_latency_stages_v1.sql',
    'public/js/pages/WatchPage.js',
}


def main():
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location('enrichment_admission_native_parent', PARENT)
    live = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = live
    spec.loader.exec_module(live)
    live.verify()
    gw, require = live.gw, live.require
    def viewer_idle():
        h = gw.health()
        require(h.get('ok') is True and all(h.get(k) == 0 for k in
            ('activeSessions', 'activeViewerSubtitleOperations', 'pendingViewerSubtitleOperations')),
            'native_viewer_active_or_unknown')
    viewer_idle()
    memory = dict(line.split(':', 1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
    require(int(memory['MemAvailable'].split()[0]) >= 2*1024*1024, 'native_memory_pressure')
    require(os.getloadavg()[0] < (os.cpu_count() or 1)*.7, 'native_cpu_pressure')
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'native_root_unsafe')
    payload = ROOT/'payload'
    require(not payload.exists() and not (ROOT/'native-tests.log').exists(), 'native_not_fresh')
    payload.mkdir(mode=0o700)
    hashes = {}
    with tarfile.open(ROOT/'source.tar') as archive:
        entries = [item for item in archive.getmembers() if not item.isdir()]
        require(len(entries) == len(FILES) and {item.name for item in entries} == FILES, 'native_archive_scope')
        for item in entries:
            require(item.isfile() and 0 < item.size < 2000000, 'native_archive_entry')
            target = payload/item.name
            require(target.resolve().is_relative_to(payload.resolve()), 'native_archive_escape')
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            data = archive.extractfile(item).read().replace(b'\r\n', b'\n')
            target.write_bytes(data); target.chmod(0o644); hashes[item.name] = gw.sha(data)
    image = gw.inspect()['Image']
    name = 'norva-enrichment-admission-native-20260913'
    reason = None
    with (ROOT/'native-tests.log').open('x') as output:
        process = subprocess.Popen(['docker', 'run', '--name', name, '--rm', '--network', 'none',
            '--cpus', '.5', '--memory', '256m', '--pids-limit', '64', '--read-only',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '-v', str(payload)+':/test:ro',
            '--entrypoint', 'node', image, '--test', '--test-concurrency=1', '--test-reporter=tap',
            *['/test/tests/'+test for test in TESTS]], stdout=output, stderr=output)
        started = time.monotonic()
        try:
            while process.poll() is None:
                time.sleep(.5)
                try:
                    viewer_idle()
                except Exception:
                    reason = 'viewer_started_or_health_unavailable'
                if time.monotonic()-started > 30:
                    reason = 'native_deadline'
                if reason:
                    break
        finally:
            if process.poll() is None:
                subprocess.run(['docker', 'stop', '--time', '1', name], capture_output=True, timeout=10)
            code = process.wait(timeout=15)
    log = (ROOT/'native-tests.log').read_text()
    counts = {key: int(match.group(1)) if (match := re.search(r'^# '+key+r' (\d+)$', log, re.M)) else None
        for key in ('tests', 'pass', 'fail', 'skipped')}
    proof = {'exitCode': code, 'abortedReason': reason, 'image': image, 'counts': counts,
        'sourceHashes': hashes, 'networkDisabled': True, 'newProviderRequests': 0,
        'productionUnchanged': True, 'mediaOperations': 0, 'testCpuLimit': .5, 'testMemoryMiB': 256}
    gw.private_write(ROOT/'native-proof.json', proof)
    live.verify()
    print(json.dumps(proof))
    require(code == 0 and reason is None and counts == {'tests':32, 'pass':32, 'fail':0, 'skipped':0},
        'native_tests_failed')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(json.dumps({'ok':False, 'code': message if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', message)
            else 'native_admission_proof_failed'}))
        sys.exit(1)
