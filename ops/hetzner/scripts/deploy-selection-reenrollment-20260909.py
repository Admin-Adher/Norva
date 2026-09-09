"""Scoped Selection repair: preserve live overlays, migrate, then roll Edge replicas."""
import difflib
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

os.umask(0o077)
ROOT = pathlib.Path(__file__).resolve().parent
assert ROOT == pathlib.Path('/home/adrien/.norva/selection-reenrollment-20260909')
NAMES = {'functions': 'norva-edge-functions', 'functions2': 'norva-edge-functions-2'}
VERSION = '20260909095957'
MIGRATION = 'selection_reenrollment_identity'
HYDRATION = 'public.hydrate_selection_episode_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])'


def run(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError('Deployment command failed: ' + args[0])
    return result.stdout


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def environment(container):
    return dict(value.split('=', 1) for value in container['Config']['Env'] if '=' in value)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sql(query):
    return run(['docker', 'exec', '-i', 'norva-db', 'psql', '-U', 'postgres', '-d', 'postgres',
                '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], query.encode()).decode().strip()


def compose(container):
    labels = container['Config']['Labels']
    args = ['docker', 'compose', '-p', labels['com.docker.compose.project']]
    for path in labels.get('com.docker.compose.project.environment_file', '').split(','):
        if path:
            args += ['--env-file', path]
    for path in labels['com.docker.compose.project.config_files'].split(','):
        args += ['-f', path]
    return args


def healthy(service):
    container = inspect(NAMES[service])
    ip = container['NetworkSettings']['Networks']['norva_default']['IPAddress']
    for route in ['norva-lifecycle', 'norva-playback']:
        request = urllib.request.Request('http://' + ip + ':9000/' + route + '/health',
            headers={'Authorization': 'Bearer ' + environment(container).get('NORVA_BACKFILL_TOKEN', '')})
        if json.load(urllib.request.urlopen(request, timeout=15)).get('ok') is not True:
            return False
    # Import and boot all changed entry points; this must not reach a user mutation.
    for route in ['norva-cloud', 'norva-catalog', 'norva-playback']:
        request = urllib.request.Request('http://' + ip + ':9000/' + route, method='OPTIONS',
                                         headers={'Origin': 'https://norva.tv'})
        if urllib.request.urlopen(request, timeout=20).status not in (200, 204):
            return False
    return True


phase = sys.argv[1]
if phase == 'stage':
    assert not (ROOT / 'deployment-plan.json').exists(), 'Stage already exists'
    containers = {service: inspect(name) for service, name in NAMES.items()}
    assert all(healthy(service) for service in NAMES), 'Unhealthy baseline'
    sources = {service: next(m['Source'] for m in container['Mounts']
                            if m['Destination'] == '/home/deno/functions')
               for service, container in containers.items()}
    assert len(set(sources.values())) == 1, 'Replica source drift'
    source = pathlib.Path(sources['functions']).resolve()
    assert source.is_relative_to('/home/adrien/.norva') and source.is_dir()
    shutil.copytree(source, ROOT / 'functions')
    manifest = json.loads((ROOT / 'candidate/manifest.json').read_text())
    changed = set(manifest['files'])
    for relative, metadata in manifest['files'].items():
        assert not pathlib.PurePosixPath(relative).is_absolute() and '..' not in pathlib.PurePosixPath(relative).parts
        target = ROOT / 'functions' / relative
        next_path = ROOT / 'candidate/next' / relative
        assert digest(next_path) == metadata['next_sha256']
        next_lines = next_path.read_text().splitlines(keepends=True)
        if metadata['base_sha256'] is None:
            assert not target.exists(), 'New helper already exists'
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(''.join(next_lines))
            continue
        base_path = ROOT / 'candidate/base' / relative
        assert digest(base_path) == metadata['base_sha256']
        base_lines = base_path.read_text().splitlines(keepends=True)
        candidate = target.read_text()
        groups = list(difflib.SequenceMatcher(None, base_lines, next_lines, autojunk=False).get_grouped_opcodes(3))
        for group in reversed(groups):
            old = ''.join(base_lines[group[0][1]:group[-1][2]])
            new = ''.join(next_lines[group[0][3]:group[-1][4]])
            assert candidate.count(old) == 1, 'Live patch anchor drift: ' + relative
            candidate = candidate.replace(old, new, 1)
        target.write_text(candidate)
    for path in (ROOT / 'functions').rglob('*'):
        if path.is_file():
            path.chmod(0o644)
    for path in source.rglob('*'):
        if path.is_file() and path.relative_to(source).as_posix() not in changed:
            assert digest(path) == digest(ROOT / 'functions' / path.relative_to(source)), 'Unrelated file drift'
    plan = {'commit': manifest['commit'], 'source': str(source),
            'hashes': {relative: digest(ROOT / 'functions' / relative) for relative in changed}, 'services': {}}
    for service, container in containers.items():
        base_command = compose(container)
        before = json.loads(run(base_command + ['config', '--format', 'json']))
        assert all(str(value) == environment(container).get(key)
                   for key, value in before['services'][service].get('environment', {}).items()), 'Environment drift'
        override = ROOT / (service + '-override.json')
        override.write_text(json.dumps({'services': {service: {'volumes': [str(ROOT / 'functions') + ':/home/deno/functions:ro']}}}))
        next_command = base_command + ['-f', str(override)]
        after = json.loads(run(next_command + ['config', '--format', 'json']))
        for key, value in before['services'].items():
            if key != service:
                assert value == after['services'][key], 'Unrelated service drift'
            else:
                assert {k: v for k, v in value.items() if k != 'volumes'} == {
                    k: v for k, v in after['services'][key].items() if k != 'volumes'}
        plan['services'][service] = {'base': base_command, 'next': next_command,
                                     'id': container['Id'], 'image': container['Image']}
    (ROOT / 'deployment-plan.json').write_text(json.dumps(plan))
    print(json.dumps({'staged': True, 'unrelated_files_preserved': True, 'hashes': plan['hashes']}))
elif phase == 'database':
    assert (ROOT / 'deployment-plan.json').exists()
    assert not (ROOT / 'database-applied.json').exists(), 'Migration already applied'
    migration = (ROOT / 'candidate' / (VERSION + '_' + MIGRATION + '.sql')).read_text()
    assert migration.startswith('begin;\n') and migration.endswith('commit;\n')
    previous = sql("select pg_get_functiondef('" + HYDRATION + "'::regprocedure);").replace('\r', '')
    (ROOT / 'hydration-before.sql').write_text(previous)
    assert 'selection_reenrollment_identity_v1' not in previous, 'Identity guard already changed'
    old = migration.split('v_old text := $old$', 1)[1].split('$old$;', 1)[0]
    assert previous.count(old) == 1, 'Hydration guard drift'
    expected = previous.replace(old, '  -- selection_reenrollment_identity_v1\n  if not public.norva_selection_source_identity_valid(p_source_id,p_user_id) then\n', 1)
    # The migration and its ledger entry commit together. No other pending migration runs.
    sql('begin;\n' + migration[len('begin;\n'):-len('commit;\n')]
        + "\ninsert into supabase_migrations.schema_migrations(version,name,statements) values ('"
        + VERSION + "','" + MIGRATION + "',ARRAY[$migration$" + migration + '$migration$]);\ncommit;')
    current = sql("select pg_get_functiondef('" + HYDRATION + "'::regprocedure);").replace('\r', '')
    assert current == expected, 'Unrelated hydration definition changed'
    checks = json.loads(sql("select json_build_object('security_invoker',not p.prosecdef,"
        "'service_role',has_function_privilege('service_role',p.oid,'execute'),"
        "'anon_denied',not has_function_privilege('anon',p.oid,'execute'),"
        "'authenticated_denied',not has_function_privilege('authenticated',p.oid,'execute')) "
        "from pg_proc p where p.oid='public.norva_selection_source_identity_valid(uuid,uuid)'::regprocedure;"))
    assert all(checks.values()), 'Identity helper privileges differ'
    result = {'passed': True, 'version': VERSION, 'sha256': hashlib.sha256(migration.encode()).hexdigest(),
              'unrelated_hydration_guards_preserved': True, **checks}
    (ROOT / 'database-applied.json').write_text(json.dumps(result))
    print(json.dumps(result))
elif phase in NAMES:
    plan = json.loads((ROOT / 'deployment-plan.json').read_text())
    step = plan['services'][phase]
    assert json.loads((ROOT / 'database-applied.json').read_text())['passed']
    before = inspect(NAMES[phase])
    assert before['Id'] == step['id'], 'Container changed since stage'
    assert healthy('functions2' if phase == 'functions' else 'functions'), 'Other replica unavailable'
    for relative, sha in plan['hashes'].items():
        assert digest(ROOT / 'functions' / relative) == sha
    try:
        run(step['next'] + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', phase])
        after = inspect(NAMES[phase])
        assert after['Image'] == step['image'], 'Image drift'
        assert environment(after) == environment(before), 'Environment drift'
        ready = False
        for _ in range(15):
            try:
                ready = healthy(phase)
            except Exception:
                pass
            if ready:
                break
            time.sleep(1)
        assert ready, 'Readiness failed'
        result = {'service': phase, 'healthy': True, 'image_preserved': True,
                  'environment_preserved': True, 'commit': plan['commit'], 'timestamp': time.time()}
        (ROOT / (phase + '-deployed.json')).write_text(json.dumps(result))
        print(json.dumps(result))
    except Exception:
        run(step['base'] + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', phase])
        raise RuntimeError('Deployment failed; original service configuration restored. Inspect readiness.') from None
else:
    raise RuntimeError('Unknown phase')
