"""Scoped LID/cache release: stage, atomic SQL, Gateway, then rolling Edge replicas.

No provider capture, job/flag edits, model replacement or broad checkout mutation.
Original containers and private plans are retained. All input hashes are bound to
the independently executed physical-file proof. Never print Docker Env or SQL rows.
"""
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/lid-cache-release-20260911/candidate-1')
SOURCE = pathlib.Path(__file__).with_name('deploy-strict-lid-adaptive-evidence-20260910.py')
spec = importlib.util.spec_from_file_location('gateway_release_helpers', SOURCE)
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)
gw.MODULES = ('index.js', 'strict-lid-batch.js')
SERVICES = ('norva-media-gateway', 'norva-edge-functions', 'norva-edge-functions-2')
EDGE_FILE = 'norva-playback/index.ts'
MIGRATION = 'supabase/migrations/20260910235557_observed_file_profile_invalidation_v1.sql'
BASE_GATEWAY_SHA = 'fa92a6c95557ac753131396d98af79396f03c9dcbeac9a1b9a76c76bb461c812'
require, run, inspect, private_write = gw.require, gw.run, gw.inspect, gw.private_write


def digest(value):
    return hashlib.sha256(value.replace(b'\r\n', b'\n')).hexdigest()


def read(relative):
    return gw.safe_file(ROOT, relative).read_bytes().replace(b'\r\n', b'\n')


def document(relative):
    return json.loads(read(relative))


def reviewed_edge_baseline(live, expected):
    live = live.replace(b'\r\n', b'\n')
    expected = expected.replace(b'\r\n', b'\n')
    if live == expected:
        return True
    # Historical mail overlay prepended this exact static import. The current
    # Git version places the same import after the Selection imports. Inspection
    # proved every other byte equal. Allow ONLY this reviewed ordering difference;
    # never discard another live modification while copying the tested candidate.
    line = b"import { requestEmailProvider } from '../_shared/email-provider-request.mjs';\n"
    return live.startswith(line) and live.count(line) == expected.count(line) == 1 \
        and live[len(line):] == expected.replace(line, b'', 1)


def sql(query, write=False):
    args = ['docker', 'exec', '-i', '-e',
            'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=3000' +
            ('' if write else ' -c default_transaction_read_only=on'),
            'norva-db', 'psql', '-X', '-qAt', '-U',
            'supabase_admin' if write else 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
    return run(args, query.encode()).decode().strip()


def controls():
    # Only settings and aggregate state, never provider/account identifiers.
    return json.loads(sql("select json_build_object('benchmark',"
        "(select enabled from public.admin_feature_flags where key='lid_benchmark_enabled'),"
        "'observedColumns',(select count(*) from pg_attribute where attrelid='public.catalog_file_tracks'::regclass "
        "and attname in ('observed_profile_fingerprint','observed_profile_probed_at','observed_profile_snapshot') and not attisdropped),"
        "'quarantinePreserved',exists(select 1 from public.catalog_file_audio_validation_jobs "
        "where id='5df2bccb-cae4-47fb-97f1-95c1efdc95b3'::uuid "
        "and state='failed' and error_code='LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'));"))


def edge_root(container):
    mounts = [m for m in container['Mounts'] if m['Destination'] == '/home/deno/functions']
    require(len(mounts) == 1 and mounts[0]['RW'] is False, 'edge_mount_not_unique_readonly')
    path = pathlib.Path(mounts[0]['Source'])
    require(path.is_dir() and not path.is_symlink() and path.resolve().is_relative_to('/home/adrien/.norva'),
            'edge_source_outside_private_release_root')
    return path


def edge_health(container):
    env = dict(v.split('=', 1) for v in container['Config']['Env'] if '=' in v)
    ip = container['NetworkSettings']['Networks']['norva_default']['IPAddress']
    request = urllib.request.Request('http://' + ip + ':9000/norva-playback/health',
        headers={'Authorization': 'Bearer ' + env.get('NORVA_BACKFILL_TOKEN', '')})
    with urllib.request.urlopen(request, timeout=20) as response:
        value = json.load(response)
    require(value.get('ok') is True, 'edge_health_failed')
    request = urllib.request.Request('http://' + ip + ':9000/norva-playback', method='OPTIONS',
                                    headers={'Origin': 'https://norva.tv'})
    with urllib.request.urlopen(request, timeout=20) as response:
        require(response.status in (200, 204), 'edge_import_failed')
    return True


def edge_expected(original, destination):
    """Only the read-only functions source may change, not Env, volumes or limits."""
    result = copy.deepcopy(original)
    old = str(edge_root(original))
    binds = result['HostConfig'].get('Binds') or []
    matched = [i for i, bind in enumerate(binds) if bind == old + ':/home/deno/functions:ro']
    require(len(matched) == 1, 'edge_bind_format_drift')
    binds[matched[0]] = str(destination) + ':/home/deno/functions:ro'
    for mount in result['Mounts']:
        if mount['Destination'] == '/home/deno/functions':
            mount['Source'] = str(destination)
    return result


def assert_fixture_binding(candidate):
    proof = document('physical-file-proof.json')
    require(proof.get('acceptancePassed') is True and proof.get('physicalFileCase') is True
            and proof.get('removedOwnContainers') is True, 'physical_proof_incomplete')
    require(proof.get('cacheHitsProviderRequests') == 0 and proof.get('cacheHitsGatewayRequests') == 0
            and len(proof.get('cacheHits', [])) == 2 and proof.get('replacementDetected') is True,
            'physical_cache_invariants_failed')
    require(proof.get('edgeIndexSha256') == candidate['edge'], 'edge_not_physically_tested')
    require(proof.get('candidateMigrationSha256') == candidate['migration'], 'migration_not_physically_tested')
    require(proof.get('gatewayCandidateFiles') == candidate['gateway'], 'gateway_not_physically_tested')


def stage():
    require(not (ROOT / 'plan.private.json').exists(), 'stage_already_exists')
    release = document('release.json')
    require(bool(re.fullmatch('[a-f0-9]{40}', release.get('commit', ''))), 'release_commit_missing')
    containers = {name: inspect(name) for name in SERVICES}
    require(all(c['State']['Running'] for c in containers.values()), 'baseline_service_not_running')
    current = containers[SERVICES[0]]
    gw.assert_image_backed_runtime(current)
    runtime = gw.runtime_snapshot(gw.health(current))
    binaries = gw.binary_snapshot()
    before = gw.source_snapshot()
    require(before['index.js'] == BASE_GATEWAY_SHA, 'gateway_baseline_drift')
    for name in gw.MODULES:
        require(before[name] == digest(read('base/services/media-gateway/src/' + name)), 'gateway_base_not_reviewed')
    for name in SERVICES[1:]:
        edge_health(containers[name])
    sources = [edge_root(containers[name]) for name in SERVICES[1:]]
    require(len(set(sources)) == 1, 'edge_replica_source_drift')
    live_edge = (sources[0] / EDGE_FILE).read_bytes()
    base_edge = read('base/supabase/functions/' + EDGE_FILE)
    require(reviewed_edge_baseline(live_edge, base_edge), 'edge_baseline_drift')
    candidate = {'gateway': {name: digest(read('candidate/services/media-gateway/src/' + name)) for name in gw.MODULES},
                 'edge': digest(read('candidate/supabase/functions/' + EDGE_FILE)),
                 'migration': digest(read('candidate/' + MIGRATION))}
    assert_fixture_binding(candidate)
    state = controls()
    require(state['benchmark'] is False and state['observedColumns'] == 0 and state['quarantinePreserved'], 'database_baseline_drift')
    destination = ROOT / 'functions'
    shutil.copytree(sources[0], destination)
    (destination / EDGE_FILE).write_bytes(read('candidate/supabase/functions/' + EDGE_FILE))
    for path in destination.rglob('*'):
        if path.is_file():
            path.chmod(0o644)
    unchanged = 0
    for path in sources[0].rglob('*'):
        if path.is_file() and path.relative_to(sources[0]).as_posix() != EDGE_FILE:
            require(path.read_bytes() == (destination / path.relative_to(sources[0])).read_bytes(), 'unrelated_edge_file_drift')
            unchanged += 1
    context = ROOT / 'build-context'
    context.mkdir(mode=0o700)
    for name in gw.MODULES:
        (context / name).write_bytes(read('candidate/services/media-gateway/src/' + name))
    (context / 'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n' + ''.join(
        'COPY --chmod=0644 ' + name + ' /app/src/' + name + '\n' for name in gw.MODULES))
    base_identity = gw.image_identity(current['Config']['Image'])
    gw.assert_container_image(current, base_identity)
    require(document('physical-file-proof.json').get('gatewayImageId') == base_identity['index'],
            'gateway_base_image_not_physically_tested')
    image = 'norva-media-gateway:lid-cache-20260911-candidate-1'
    # Bind the verified local OCI index to a unique build alias. BuildKit must
    # not interpret a bare sha256:... ID as a remote repository/tag to pull.
    base_alias = 'norva-lid-cache-base:20260911-candidate-1'
    run(['docker', 'tag', base_identity['index'], base_alias])
    run(['docker', 'build', '--network', 'none', '--build-arg', 'BASE_IMAGE=' + base_alias,
         '-t', image, str(context)])
    for name in gw.MODULES:
        run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cpus', '1', '--memory', '512m',
             '--entrypoint', 'node', image, '--check', '/app/src/' + name])
    definitions = sql("select pg_get_functiondef(oid) from pg_proc where oid in "
        "('public.upsert_catalog_file_tracks(text,text,text,jsonb,jsonb,boolean,boolean)'::regprocedure,"
        "'public.upsert_catalog_file_detected_tracks(text,text,text,jsonb,jsonb,boolean,boolean)'::regprocedure) order by oid::regprocedure::text;")
    private_write(ROOT / 'database-before.private.json', {'unversionedWriters': definitions})
    plan = {'protocol': 1, 'commit': release['commit'], 'containers': containers, 'sourcesBefore': before,
            'edgeBefore': digest(live_edge), 'candidate': candidate, 'runtime': runtime, 'binaries': binaries,
            'image': image, 'imageIdentity': gw.image_identity(image), 'oldImageIdentity': base_identity,
            'edgeSource': str(sources[0]), 'controlsBefore': state, 'unrelatedEdgeFilesPreserved': unchanged,
            'reviewedEmailImportOrderOnly': digest(live_edge) != digest(base_edge)}
    private_write(ROOT / 'plan.private.json', plan)
    print(json.dumps({'staged': True, 'commit': release['commit'], 'builtOnly': True,
        'unrelatedEdgeFilesPreserved': unchanged, 'hashes': candidate, 'productionUnchanged': True}), flush=True)


def database_checks():
    return json.loads(sql("select json_build_object('protectedHelpers',count(*)=3 and "
        "bool_and(pg_get_userbyid(proowner)='postgres') and "
        "bool_and(not has_function_privilege('anon',oid,'execute')) and "
        "bool_and(not has_function_privilege('authenticated',oid,'execute')),"
        "'serviceCanObserve',has_function_privilege('service_role',"
        "'public.observe_catalog_file_profile(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,boolean,boolean)','execute')) "
        "from pg_proc where oid in ('public.guard_catalog_observed_profile_certificate()'::regprocedure,"
        "'public.guard_catalog_validation_observed_profile()'::regprocedure,"
        "'public.observe_catalog_file_profile(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,boolean,boolean)'::regprocedure);"))


def database():
    plan = document('plan.private.json')
    require(not (ROOT / 'database-applied.json').exists(), 'database_already_recorded')
    require(controls() == plan['controlsBefore'], 'database_changed_after_stage')
    gw.assert_idle(gw.health())
    migration = read('candidate/' + MIGRATION)
    require(digest(migration) == plan['candidate']['migration'], 'migration_input_changed')
    # Existing self-hosted installation has no CLI migration ledger. Preserve it;
    # record exact DDL and verified effective state, not a second invented ledger.
    sql(migration.decode(), write=True)
    checks = database_checks()
    require(all(checks.values()), 'database_permissions_failed')
    state = controls()
    require(state['observedColumns'] == 3 and state['benchmark'] is False and state['quarantinePreserved'], 'database_postcheck_failed')
    result = {'applied': True, 'migrationSha256': digest(migration), 'checks': checks, 'controls': state}
    private_write(ROOT / 'database-applied.json', result)
    print(json.dumps(result), flush=True)


def verify_service(name, plan, candidate=True):
    current = inspect(name)
    original = plan['containers'][name]
    if name == SERVICES[0]:
        gw.assert_clone(original, current, plan['image'] if candidate else original['Config']['Image'])
        gw.assert_container_image(current, plan['imageIdentity'] if candidate else plan['oldImageIdentity'])
        require(gw.source_snapshot() == (plan['candidate']['gateway'] if candidate else plan['sourcesBefore']), 'gateway_source_mismatch')
        require(gw.binary_snapshot() == plan['binaries'], 'gateway_binary_changed')
        value = gw.health()
        require(value.get('ok') is True, 'gateway_unhealthy')
        gw.assert_runtime(value, plan['runtime'])
        if candidate:
            require(value.get('codecProfileRefreshProtocol') == 1, 'fresh_probe_protocol_absent')
    else:
        expected = edge_expected(original, ROOT / 'functions') if candidate else original
        gw.assert_clone(expected, current, original['Config']['Image'])
        require(current['Image'] == original['Image'], 'edge_image_changed')
        observed = run(['docker', 'exec', name, 'cat', '/home/deno/functions/' + EDGE_FILE])
        require(digest(observed) == (plan['candidate']['edge'] if candidate else plan['edgeBefore']), 'edge_source_mismatch')
        edge_health(current)
    require(current['RestartCount'] == 0 and current['State']['OOMKilled'] is False, 'service_restart_or_oom')
    return True


def restore(name, plan, deployment):
    candidate = inspect(deployment['candidateContainer'])
    if candidate['State']['Running']:
        run(['docker', 'stop', '--time', '20', candidate['Id']])
    if candidate['Name'] == '/' + name:
        run(['docker', 'rename', candidate['Id'], deployment['candidateName']])
    old = inspect(plan['containers'][name]['Id'])
    if old['Name'] != '/' + name:
        run(['docker', 'rename', old['Id'], name])
    if not old['State']['Running']:
        run(['docker', 'start', old['Id']])


def activate(name):
    plan = document('plan.private.json')
    require(document('database-applied.json').get('applied') is True, 'database_not_applied')
    require(not (ROOT / (name + '-deployment.private.json')).exists(), 'service_deployment_exists')
    original = plan['containers'][name]
    current = inspect(name)
    require(current['Id'] == original['Id'], 'active_container_changed')
    verify_service(name, plan, False)
    if name != SERVICES[0]:
        require(document(SERVICES[0] + '-deployed.json').get('healthy') is True, 'gateway_not_deployed')
        verify_service(SERVICES[0], plan)
        other = SERVICES[2] if name == SERVICES[1] else SERVICES[1]
        edge_health(inspect(other))
    gw.assert_idle(gw.health())
    expected = original if name == SERVICES[0] else edge_expected(original, ROOT / 'functions')
    image = plan['image'] if name == SERVICES[0] else original['Config']['Image']
    candidate_name = name + '-lid-cache-candidate-20260911-1'
    rollback_name = name + '-lid-cache-rollback-20260911-1'
    created = gw.docker_api('POST', '/containers/create?name=' + candidate_name, gw.clone_payload(expected, image))
    deployment = {'candidateContainer': created['Id'], 'candidateName': candidate_name}
    private_write(ROOT / (name + '-deployment.private.json'), deployment)
    gw.assert_clone(expected, inspect(created['Id']), image)
    gw.assert_idle(gw.health())
    try:
        run(['docker', 'stop', '--time', '20', original['Id']])
        run(['docker', 'rename', original['Id'], rollback_name])
        run(['docker', 'rename', created['Id'], name])
        run(['docker', 'start', created['Id']])
        ready = False
        for _ in range(30):
            try:
                ready = verify_service(name, plan)
            except Exception:
                time.sleep(1)
            if ready:
                break
        require(ready, 'candidate_readiness_failed')
    except Exception:
        restore(name, plan, deployment)
        verify_service(name, plan, False)
        raise RuntimeError('candidate_failed_original_restored') from None
    result = {'service': name, 'healthy': True, 'commit': plan['commit'],
              'environmentAndLimitsPreserved': True, 'originalContainerRetained': True}
    private_write(ROOT / (name + '-deployed.json'), result)
    print(json.dumps(result), flush=True)


def verify():
    plan = document('plan.private.json')
    checks = {name: verify_service(name, plan) for name in SERVICES}
    db = database_checks()
    state = controls()
    require(all(db.values()) and state['benchmark'] is False and state['quarantinePreserved'], 'final_database_check_failed')
    result = {'productionVerified': True, 'commit': plan['commit'], 'services': checks,
              'hashes': plan['candidate'], 'database': db, 'controls': state,
              'whisperRuntimePreserved': True, 'noProviderTestStarted': True,
              'humanValidationStillPending': True, 'checkedAt': time.time()}
    private_write(ROOT / 'production-proof.json', result)
    print(json.dumps(result), flush=True)


def main():
    os.umask(0o077)
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'release_directory_missing')
    phase = sys.argv[1] if len(sys.argv) == 2 else ''
    if phase == 'stage': stage()
    elif phase == 'database': database()
    elif phase == 'gateway': activate(SERVICES[0])
    elif phase == 'edge1': activate(SERVICES[1])
    elif phase == 'edge2': activate(SERVICES[2])
    elif phase == 'verify': verify()
    else: raise RuntimeError('invalid_phase')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        safe = message if re.fullmatch('[a-z0-9_:-]{1,120}', message) else type(error).__name__
        print(json.dumps({'ok': False, 'error': safe}), file=sys.stderr, flush=True)
        raise SystemExit(1)
