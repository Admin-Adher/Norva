"""Explicit, scoped signup welcome worker rollout. No SQL, customer sends or gateway changes."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.request

os.umask(0o077)
root = pathlib.Path('/home/adrien/.norva/signup-welcome-20260905-r1')
expected = {
    'norva-lifecycle/index.ts': '41e4714a246ce9a3d77b80f32c347cfb9854242d491affb33e422def882fc394',
}
names = ['norva-edge-functions', 'norva-edge-functions-2']
def run(args):
    p = subprocess.run(args, capture_output=True)
    if p.returncode: raise RuntimeError('command failed: ' + args[0])
    return p.stdout
def inspect(name): return json.loads(run(['docker', 'inspect', name]))[0]
def digest(path): return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
def command(c):
    labels = c['Config']['Labels']
    args = ['docker', 'compose', '-p', labels['com.docker.compose.project']]
    for f in labels.get('com.docker.compose.project.environment_file', '').split(','):
        if f: args += ['--env-file', f]
    for f in labels['com.docker.compose.project.config_files'].split(','): args += ['-f', f]
    return args
def health(name):
    c = inspect(name)
    env = dict(s.split('=', 1) for s in c['Config']['Env'] if '=' in s)
    ip = c['NetworkSettings']['Networks']['norva_default']['IPAddress']
    req = urllib.request.Request('http://' + ip + ':9000/norva-playback/health', headers={'Authorization': 'Bearer ' + env.get('NORVA_BACKFILL_TOKEN', '')})
    return json.load(urllib.request.urlopen(req, timeout=10)).get('ok') is True

phase = sys.argv[1]
if phase == 'stage':
    assert not (root / 'plan.json').exists(), 'Plan exists; inspect before proceeding'
    containers = [inspect(n) for n in names]
    previous = [next(m['Source'] for m in c['Mounts'] if m['Destination'] == '/home/deno/functions') for c in containers]
    assert previous[0] == previous[1], 'Replica source drift'
    source = pathlib.Path(previous[0])
    for rel, sha in expected.items(): assert digest(source / rel) == sha, 'Source drift: ' + rel
    assert all(health(n) for n in names), 'Unhealthy baseline'
    shutil.copytree(source, root / 'functions')
    for rel in expected:
        target = root / 'functions' / rel
        target.write_bytes((root / 'candidate' / rel).read_bytes().replace(b'\r\n', b'\n'))
        target.chmod(0o644)
    # Prove every unrelated file is identical to the running release.
    for p in source.rglob('*'):
        if p.is_file() and str(p.relative_to(source)) not in expected:
            assert digest(p) == digest(root / 'functions' / p.relative_to(source))
    override = root / 'override.json'
    override.write_text(json.dumps({'services': {s: {'volumes': [str(root / 'functions') + ':/home/deno/functions:ro']} for s in ['functions', 'functions2']}}))
    base = command(containers[0])
    before = json.loads(run(base + ['config', '--format', 'json']))
    after = json.loads(run(base + ['-f', str(override), 'config', '--format', 'json']))
    for s, a in before['services'].items():
        b = after['services'][s]
        if s not in ['functions', 'functions2']: assert a == b
        else:
            assert {k:v for k,v in a.items() if k != 'volumes'} == {k:v for k,v in b.items() if k != 'volumes'}
            assert [v for v in a['volumes'] if v['target'] != '/home/deno/functions'] == [v for v in b['volumes'] if v['target'] != '/home/deno/functions']
    plan = {'base': base, 'next': base + ['-f', str(override)], 'old': previous[0], 'ids': {c['Name'].lstrip('/'): c['Id'] for c in containers}, 'hashes': {r: digest(root / 'functions' / r) for r in expected}}
    (root / 'plan.json').write_text(json.dumps(plan))
    print(json.dumps({'staged': True, 'unrelatedFilesPreserved': True, 'hashes': plan['hashes']}))
elif phase in ['functions', 'functions2']:
    plan = json.loads((root / 'plan.json').read_text())
    name = names[0 if phase == 'functions' else 1]
    other = names[1 if phase == 'functions' else 0]
    before = inspect(name)
    assert before['Id'] == plan['ids'][name], 'Container drift'
    assert health(other), 'Other replica unavailable'
    for rel, sha in plan['hashes'].items(): assert digest(root / 'functions' / rel) == sha
    try:
        run(plan['next'] + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', phase])
        after = inspect(name)
        assert after['Image'] == before['Image']
        assert sorted(after['Config']['Env']) == sorted(before['Config']['Env'])
        ok = False
        for attempt in range(15):
            try: ok = health(name)
            except Exception: pass
            if ok: break
            time.sleep(1)
        assert ok, 'Readiness failed'
        for rel, sha in plan['hashes'].items():
            raw = run(['docker', 'exec', name, 'cat', '/home/deno/functions/' + rel])
            assert hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest() == sha
        print(json.dumps({'deployed': name, 'healthy': True, 'hashesVerified': True}))
    except Exception:
        run(plan['base'] + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', phase])
        raise RuntimeError('Rollout failed; original compose restored; verify readiness') from None
else: raise RuntimeError('Unknown phase')
