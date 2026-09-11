"""Private synthetic audio tests in a networkless copy of the runtime image.

Never starts the application, copies production mounts/env, or contacts a provider.
"""
import json
import pathlib
import subprocess
import tarfile
import tempfile

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-pipeline-proof-20260911')
NAME = 'norva-capture-runtime-proof-20260911'
LABEL = 'capture-runtime-proof-20260911'
FILES = ['services/media-gateway/src/' + name + '.js' for name in (
    'strict-lid-capture-store', 'strict-lid-capture-pipeline', 'strict-lid-window-checkpoint',
    'strict-lid-speech-window', 'strict-lid-batch', 'strict-lid-audio-evidence')]
FILES.append('tests/strict-lid-capture-store.test.js')


def run(args):
    p = subprocess.run(args, capture_output=True, timeout=120)
    if p.returncode:
        raise RuntimeError('isolated_test_command_failed: ' + p.stdout.decode()[-12000:] + p.stderr.decode()[-4000:])
    return p.stdout.decode()


def main():
    assert ROOT.is_dir() and not ROOT.is_symlink()
    assert NAME not in run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
    proof = pathlib.Path(tempfile.mkdtemp(prefix='capture-runtime-', dir=ROOT))
    with tarfile.open(ROOT / 'capture-runtime.tar.gz') as archive:
        members = archive.getmembers()
        assert sorted(m.name for m in members) == sorted(FILES)
        for member in members:
            assert member.isfile() and 0 < member.size < 100000
            target = proof / member.name
            assert target.resolve().is_relative_to(proof.resolve())
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
    image = run(['docker', 'inspect', '--format', '{{.Image}}', 'norva-media-gateway']).strip()
    assert image.startswith('sha256:') and len(image) == 71
    created = None
    try:
        created = run(['docker', 'create', '--name', NAME, '--label', 'norva.purpose=' + LABEL,
            '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
            '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
            '--mount', 'type=bind,src=' + str(proof) + ',dst=/proof,readonly',
            '--entrypoint', 'node', image, '--test', '/proof/tests/strict-lid-capture-store.test.js']).strip()
        output = run(['docker', 'start', '-a', NAME])
        state = json.loads(run(['docker', 'inspect', NAME]))[0]
        assert state['State']['ExitCode'] == 0
        print(output)
        print(json.dumps({'passed': True, 'network': 'none', 'providerRequests': 0,
            'productionWrites': 0, 'runtimeImage': image, 'nativeLinuxLock': 'tested'}))
    finally:
        if created:
            state = json.loads(run(['docker', 'inspect', NAME]))[0]
            assert state['Id'] == created and state['HostConfig']['NetworkMode'] == 'none'
            assert state['Config']['Labels']['norva.purpose'] == LABEL
            run(['docker', 'rm', '-f', created])


if __name__ == '__main__':
    main()
