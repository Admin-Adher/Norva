"""One-shot two-template overlay; no SQL writes, queue claims, sends or gate changes."""
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/email-destinations-20260906-r1')
BASE_ROOT = pathlib.Path('/home/adrien/.norva/selection-live-additions-20260906-r2/functions')
EXPECTED = {
    '_shared/import-email.ts': '63d0832c73292cdd4bb1a5427e77e35bd634fbe237edde1c92f7b2672e0e10b6',
    '_shared/lifecycle-email.ts': '39a199724e9150f243857585d0357d53015e79472c57643709b59403daf91294',
}
NAMES = ['norva-edge-functions', 'norva-edge-functions-2']
SERVICES = ['functions', 'functions2']
os.umask(0o077)


def require(value, message):
    if not value:
        raise RuntimeError(message)


def run(args, data=None):
    p = subprocess.run(args, input=data, capture_output=True, timeout=90)
    require(p.returncode == 0, 'Command failed; private output withheld: ' + args[0])
    return p.stdout


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def digest(path):
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def tree(root):
    paths = list(root.rglob('*'))
    require(not any(p.is_symlink() for p in paths), 'Unexpected runtime symlink')
    return {p.relative_to(root).as_posix(): digest(p) for p in paths if p.is_file()}


def source(c):
    return pathlib.Path(next(m['Source'] for m in c['Mounts'] if m['Destination'] == '/home/deno/functions'))


def command(c):
    labels = c['Config']['Labels']
    args = ['docker', 'compose', '-p', labels['com.docker.compose.project']]
    for f in labels.get('com.docker.compose.project.environment_file', '').split(','):
        if f:
            args += ['--env-file', f]
    for f in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', f]
    return args


def request(c, route, expected_status=200):
    env = dict(s.split('=', 1) for s in c['Config']['Env'] if '=' in s)
    ip = c['NetworkSettings']['Networks']['norva_default']['IPAddress']
    req = urllib.request.Request('http://' + ip + ':9000/' + route,
        headers={'Authorization': 'Bearer ' + env.get('NORVA_BACKFILL_TOKEN', '')})
    try:
        with urllib.request.urlopen(req, timeout=12) as res:
            require(res.status == expected_status, 'Unexpected probe response')
            return json.load(res).get('ok') is True
    except urllib.error.HTTPError as error:
        return error.code == expected_status


def healthy(name):
    return request(inspect(name), 'norva-playback/health')


def gates():
    query = b"""begin read only;
select json_build_object(
 'emergency_stop', exists(select 1 from public.behavioral_lifecycle_runtime where emergency_stop and audience_mode='internal_test'),
 'drafts_only', (select count(*)=4 and bool_and(status='draft' and rollout_percent=0 and activated_at is null) from public.behavioral_lifecycle_journeys),
 'welcome_disabled', (select count(*)=1 and bool_and(not enabled) from public.lifecycle_signup_welcome_runtime),
 'outbox_empty', not exists(select 1 from public.behavioral_lifecycle_outbox)
); rollback;"""
    state = json.loads(run(['docker', 'exec', '-i', 'norva-db', 'psql', '-X', '-At', '-q',
        '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'], query))
    require(all(v is True for v in state.values()) and len(state) == 4, 'Lifecycle safety baseline changed')
    return state


def save(path, value):
    with path.open('x', encoding='utf8') as file:
        json.dump(value, file, indent=2)


def stage():
    require(not (ROOT/'plan.json').exists() and not (ROOT/'functions').exists(), 'Existing stage; inspect instead of overwriting')
    containers = [inspect(n) for n in NAMES]
    require(all(source(c) == BASE_ROOT for c in containers), 'Live root changed')
    before_tree = tree(BASE_ROOT)
    require(len(before_tree) == 140, 'Unexpected runtime file count')
    require(all(before_tree.get(f) == sha for f, sha in EXPECTED.items()), 'Template baseline changed')
    require(all(healthy(n) for n in NAMES), 'Unhealthy baseline')
    gate_state = gates()
    shutil.copytree(BASE_ROOT, ROOT/'functions')
    for f in EXPECTED:
        target = ROOT/'functions'/f
        target.write_bytes((ROOT/'candidate'/f).read_bytes().replace(b'\r\n', b'\n'))
        target.chmod(0o644)
    after_tree = tree(ROOT/'functions')
    require(before_tree.keys() == after_tree.keys(), 'Runtime inventory changed')
    require({f for f in before_tree if before_tree[f] != after_tree[f]} == set(EXPECTED), 'Unrelated runtime changes')
    override = ROOT/'override.json'
    save(override, {'services': {s: {'volumes': [str(ROOT/'functions') + ':/home/deno/functions:ro']} for s in SERVICES}})
    base = command(containers[0])
    require(command(containers[1]) == base, 'Replica compose drift')
    next_command = base + ['-f', str(override)]
    before = json.loads(run(base + ['config', '--format', 'json']))
    after = json.loads(run(next_command + ['config', '--format', 'json']))
    comparison = json.loads(json.dumps(after))
    for s in SERVICES:
        old_volumes = before['services'][s]['volumes']
        new_volumes = after['services'][s]['volumes']
        require([v for v in old_volumes if v['target'] != '/home/deno/functions'] ==
                [v for v in new_volumes if v['target'] != '/home/deno/functions'], 'Other mounts changed')
        changed_mount = [v for v in new_volumes if v['target'] == '/home/deno/functions']
        require(len(changed_mount) == 1 and changed_mount[0]['source'] == str(ROOT/'functions') and changed_mount[0].get('read_only') is True, 'Invalid function mount')
        comparison['services'][s]['volumes'] = old_volumes
    require(before == comparison, 'Compose changes outside function mount')
    plan = {'base': base, 'next': next_command, 'beforeCompose': before, 'afterCompose': after,
        'ids': {n: c['Id'] for n, c in zip(NAMES, containers)}, 'beforeTree': before_tree,
        'afterTree': after_tree, 'gates': gate_state}
    save(ROOT/'plan.json', plan)
    return {'staged': True, 'files': len(after_tree), 'changed': list(EXPECTED), 'gates': gate_state}


def deploy(service):
    plan = json.loads((ROOT/'plan.json').read_text())
    require(not (ROOT/(service + '.done.json')).exists(), 'Already deployed; verify instead')
    ix = SERVICES.index(service)
    name, other = NAMES[ix], NAMES[1-ix]
    before = inspect(name)
    require(before['Id'] == plan['ids'][name] and source(before) == BASE_ROOT, 'Container drift')
    require(source(inspect(other)) in [BASE_ROOT, ROOT/'functions'] and healthy(other), 'Other replica not ready')
    require(tree(BASE_ROOT) == plan['beforeTree'] and tree(ROOT/'functions') == plan['afterTree'], 'Runtime tree drift')
    require(json.loads(run(plan['base'] + ['config', '--format', 'json'])) == plan['beforeCompose'], 'Base compose drift')
    require(json.loads(run(plan['next'] + ['config', '--format', 'json'])) == plan['afterCompose'], 'Candidate compose drift')
    gates()
    try:
        run(plan['next'] + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', service])
        after = inspect(name)
        require(after['Image'] == before['Image'] and sorted(after['Config']['Env']) == sorted(before['Config']['Env']), 'Process image/environment drift')
        ready = False
        for _ in range(15):
            try:
                ready = healthy(name)
            except Exception:
                pass
            if ready:
                break
            time.sleep(1)
        require(ready and source(after) == ROOT/'functions', 'Readiness failed')
        require(request(after, 'norva-lifecycle/health'), 'Lifecycle module cold start failed')
        require(request(after, 'norva-import-notify', 405), 'Import module cold start failed')
        for f in EXPECTED:
            data = run(['docker', 'exec', name, 'cat', '/home/deno/functions/' + f])
            require(hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest() == plan['afterTree'][f], 'Runtime hash mismatch')
        proof = {'deployed': name, 'healthy': True, 'moduleProbes': [200, 405], 'gates': gates(),
            'atUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'hashes': {f: plan['afterTree'][f] for f in EXPECTED}}
        save(ROOT/(service + '.done.json'), proof)
        return proof
    except Exception:
        run(plan['base'] + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', service])
        require(healthy(name), 'Rollback issued but readiness unconfirmed; operator check required')
        raise RuntimeError('Rollout failed; original compose restored and readiness verified') from None


if __name__ == '__main__':
    try:
        phase = sys.argv[1] if len(sys.argv) == 2 else ''
        require(phase in ['stage', *SERVICES], 'Expected stage/functions/functions2')
        print(json.dumps(stage() if phase == 'stage' else deploy(phase)))
    except Exception as error:
        print(json.dumps({'refused': True, 'reason': str(error)}))
        raise SystemExit(1)
