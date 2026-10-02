"""Guarded schema + rolling Edge rollout; source artifacts staged under ROOT.

No catalog data is edited here. Run the separately reviewed repair operator
after deployment. The prior runtime and private stack configuration are saved.
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
FILE = '_shared/vod-title-projection.ts'
EXPECTED = '7a3bb6fcd23484b959a3ceae5816b7dd6b088d71a71b1e59ecbd47929156c383'
MIGRATION = '20261002170000_selection_editorial_audit_apply.sql'


def run(command, text=None):
    result = subprocess.run(command, input=text, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr[-1000:])
    return result.stdout


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def health(name):
    info = inspect(name)
    ip = next(iter(info['NetworkSettings']['Networks'].values()))['IPAddress']
    with urllib.request.urlopen('http://' + ip + ':9000/norva-playback/health', timeout=8) as r:
        data = json.load(r)
    assert data.get('ok') and data.get('version') == 84, 'Edge health failed'


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--apply', action='store_true'); args = parser.parse_args()
    names = ['norva-edge-functions', 'norva-edge-functions-2']
    before = {name: inspect(name) for name in names}
    mounts = [next(m['Source'] for m in before[n]['Mounts'] if m['Destination'] == '/home/deno/functions') for n in names]
    assert mounts[0] == mounts[1], 'Edge runtime parity changed'
    runtime = Path(mounts[0])
    assert hashlib.sha256((runtime / FILE).read_text().encode()).hexdigest() == EXPECTED, 'Source contract drift'
    for n in names:
        health(n)
    staged = ROOT / 'vod-title-projection.ts'
    assert staged.exists() and (ROOT / MIGRATION).exists()
    after_sha = hashlib.sha256(staged.read_text().encode()).hexdigest()
    env_path = STACK / '.env'; original_env = env_path.read_text()
    lines = original_env.splitlines()
    assert sum(l.startswith('NORVA_EDGE_FUNCTIONS_ROOT=') for l in lines) == 1
    compose = ['docker', 'compose', '--env-file', str(env_path), '-f', str(STACK / 'docker-compose.supabase.yml')]
    db = ['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres']
    assert run(db, "select to_regprocedure('public.norva_apply_selection_editorial_audit(uuid,text,jsonb)') is null;").strip() == 't', 'Already installed'
    print(json.dumps({'apply': args.apply, 'beforeSha256': EXPECTED, 'afterSha256': after_sha, 'healthyReplicas': 2}), flush=True)
    if not args.apply:
        return
    backup = ROOT / 'before-deployment'; backup.mkdir(mode=0o700, exist_ok=False)
    (backup / 'stack.env').write_text(original_env); (backup / 'stack.env').chmod(0o600)
    definition = run(db, "select pg_get_functiondef('public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid)'::regprocedure);")
    (backup / 'editorial-writer.sql').write_text(definition); (backup / 'editorial-writer.sql').chmod(0o600)
    target = ROOT / 'runtime-functions'
    shutil.copytree(runtime, target)
    (target / FILE).write_text(staged.read_text())
    run(db, (ROOT / MIGRATION).read_text(encoding='utf-8-sig'))
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
            current = inspect(name)
            assert current['Image'] == before[name]['Image'], 'Image changed unexpectedly'
            assert next(m['Source'] for m in current['Mounts'] if m['Destination'] == '/home/deno/functions') == str(target)
            print(name + ' healthy with reviewed source', flush=True)
    except Exception:
        env_path.write_text(original_env)
        for service in changed:
            run(compose + ['up', '-d', '--no-deps', '--force-recreate', service])
        raise
    (ROOT / 'deployment.safe.json').write_text(json.dumps({'at': time.time(), 'replicas': 2,
        'runtime': str(target), 'sourceSha256': after_sha, 'migrationSha256': hashlib.sha256((ROOT / MIGRATION).read_text(encoding='utf-8-sig').encode()).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
