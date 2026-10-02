"""Guarded two-replica Edge rollout of the catalogue artwork repair.

Existing image, secrets and compose configuration are preserved. Prior runtime
and the private env backup permit immediate rollback if either health check fails.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path('/home/adrien/.norva/selection-tmdb-audit-20261002')
STACK = Path('/home/adrien/norva/ops/hetzner')
FILE = 'norva-catalog/index.ts'
EXPECTED = 'e099d726d99e13c4552a725b5ad5513fc417c91a34bd009c584a6076c666380f'


def run(command):
    p = subprocess.run(command, text=True, capture_output=True, timeout=90)
    if p.returncode:
        raise RuntimeError(p.stderr[-1200:])
    return p.stdout


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def health(name):
    info = inspect(name)
    ip = next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
    with urllib.request.urlopen('http://' + ip + ':9000/norva-playback/health', timeout=8) as r:
        data = json.load(r)
    assert data.get('ok') and data.get('version') == 85, 'Edge health failed'


def main():
    p = argparse.ArgumentParser(); p.add_argument('--apply', action='store_true')
    p.add_argument('--expected-sha256', default=EXPECTED)
    p.add_argument('--revision', type=int, choices=[1, 2], default=1)
    args = p.parse_args()
    names = ['norva-edge-functions', 'norva-edge-functions-2']
    before = {name: inspect(name) for name in names}
    mounts = [next(m['Source'] for m in before[n]['Mounts'] if m['Destination'] == '/home/deno/functions') for n in names]
    assert mounts[0] == mounts[1], 'Runtime parity drift'
    runtime = Path(mounts[0])
    assert hashlib.sha256((runtime / FILE).read_text().encode()).hexdigest() == args.expected_sha256
    for name in names:
        health(name)
    staged = ROOT / 'catalog-artwork-index.ts'
    after = hashlib.sha256(staged.read_text().encode()).hexdigest()
    print(json.dumps({'apply': args.apply, 'beforeSha256': args.expected_sha256, 'afterSha256': after}), flush=True)
    if not args.apply:
        return
    env_path = STACK / '.env'; original = env_path.read_text(); lines = original.splitlines()
    assert sum(v.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') for v in lines) == 1
    suffix = '' if args.revision == 1 else '-v2'
    backup = ROOT / ('before-artwork-deployment' + suffix); backup.mkdir(mode=0o700, exist_ok=False)
    (backup / 'stack.env').write_text(original); (backup / 'stack.env').chmod(0o600)
    target = ROOT / ('runtime-artwork-functions' + suffix); shutil.copytree(runtime, target)
    (target / FILE).write_text(staged.read_text())
    compose = ['docker', 'compose', '--env-file', str(env_path), '-f', str(STACK / 'docker-compose.supabase.yml')]
    env_path.write_text('\n'.join('NORVA_EDGE_FUNCTIONS_ROOT=' + str(target) if l.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') else l for l in lines) + '\n')
    changed = []
    try:
        configured = json.loads(run(compose + ['config', '--format', 'json']))
        for name, service in zip(names, ['functions', 'functions2']):
            c = configured['services'][service]
            assert any(v.get('source') == str(target) and v.get('target') == '/home/deno/functions' for v in c['volumes'])
            old_env = dict(v.split('=', 1) for v in before[name]['Config']['Env'])
            assert all(str(v or '') == old_env.get(k, '') for k, v in c['environment'].items()), 'Unexpected environment change'
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
    (ROOT / 'artwork-deployment.safe.json').write_text(json.dumps({'at': time.time(),
        'replicas': 2, 'runtime': str(target), 'sourceSha256': after}, indent=2))


if __name__ == '__main__':
    main()
