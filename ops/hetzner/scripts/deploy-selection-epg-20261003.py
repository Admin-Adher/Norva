"""Guarded two-replica guide rollout; retain previous runtime for rollback."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path('/home/adrien/.norva/selection-epg-20261003')
STACK = Path('/home/adrien/norva/ops/hetzner')
FILES = ['norva-cloud/index.ts', '_shared/selection-epg.mjs']
EXPECTED = '54d0ddf3bfe8c88e254303be030b76e9d7965f1ab731cf5184de07d213d3117d'


def run(command):
    result = subprocess.run(command, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr[-1000:])
    return result.stdout


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def health(name):
    info = inspect(name)
    ip = next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
    with urllib.request.urlopen('http://' + ip + ':9000/norva-playback/health', timeout=8) as response:
        data = json.load(response)
    assert data.get('ok') and data.get('version') == 85, 'Edge health failed'


def sha(path):
    return hashlib.sha256(path.read_text().encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    names = ['norva-edge-functions', 'norva-edge-functions-2']
    before = {name: inspect(name) for name in names}
    mounts = [next(m['Source'] for m in before[n]['Mounts'] if m['Destination'] == '/home/deno/functions') for n in names]
    assert mounts[0] == mounts[1], 'Runtime parity drift'
    runtime = Path(mounts[0])
    assert sha(runtime / FILES[0]) == EXPECTED, 'Live cloud source changed'
    assert sha(runtime / '_shared/selection-curated-channels.mjs') == '4004062f6c3ac9794ab6d819a4fe2bbd79ba352ea5289f748f6565350edf3c0f'
    for name in names:
        health(name)
    hashes = {file: sha(ROOT / 'staged' / file) for file in FILES}
    print(json.dumps({'apply': args.apply, 'beforeCloudSha256': EXPECTED, 'afterSha256': hashes}), flush=True)
    if not args.apply:
        return
    env_path = STACK / '.env'
    original = env_path.read_text()
    lines = original.splitlines()
    assert sum(line.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') for line in lines) == 1
    backup = ROOT / 'before'; backup.mkdir(mode=0o700, exist_ok=False)
    (backup / 'stack.env').write_text(original); (backup / 'stack.env').chmod(0o600)
    target = ROOT / 'runtime-functions'; shutil.copytree(runtime, target)
    for file in FILES:
        (target / file).write_text((ROOT / 'staged' / file).read_text())
    compose = ['docker', 'compose', '--env-file', str(env_path), '-f', str(STACK / 'docker-compose.supabase.yml')]
    env_path.write_text('\n'.join('NORVA_EDGE_FUNCTIONS_ROOT=' + str(target) if line.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') else line for line in lines) + '\n')
    changed = []
    try:
        configured = json.loads(run(compose + ['config', '--format', 'json']))
        for name, service in zip(names, ['functions', 'functions2']):
            conf = configured['services'][service]
            assert any(v.get('source') == str(target) and v.get('target') == '/home/deno/functions' for v in conf['volumes'])
            old_env = dict(v.split('=', 1) for v in before[name]['Config']['Env'])
            assert all(str(v or '') == old_env.get(k, '') for k, v in conf['environment'].items()), 'Unexpected environment change'
            changed.append(service)
            run(compose + ['up', '-d', '--no-deps', '--force-recreate', service])
            for attempt in range(12):
                try:
                    health(name); break
                except Exception:
                    if attempt == 11:
                        raise
                    time.sleep(2)
            assert inspect(name)['Image'] == before[name]['Image']
            print(name + ' healthy', flush=True)
    except Exception:
        env_path.write_text(original)
        for service in changed:
            run(compose + ['up', '-d', '--no-deps', '--force-recreate', service])
        raise
    (ROOT / 'deployment.safe.json').write_text(json.dumps({'at': time.time(), 'replicas': 2,
        'runtime': str(target), 'sha256': hashes}, indent=2))


if __name__ == '__main__':
    main()
