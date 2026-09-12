"""One-function format parity: networkless SQL proof, guarded deploy, no new jobs."""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/exact-profile-parity-20260912')
MIGRATION = '20260912154000_exact_vod_profile_container_parity.sql'
TARGET = 'public.vod_language_profile_is_exact(jsonb)'
OLD = "'mkv', 'matroska', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg'"
NEW = OLD + ", 'm4v', 'movmp4m4a3gp3g2mj2', 'ts', 'mpegts'"
NAME = 'norva-exact-profile-proof-20260912'
LABEL = 'exact-profile-parity-20260912'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


base = load('profile_parity_base', ROOT.parent/'strict-lid-container-families-20260911/proof-deploy-lid-demuxer-families-20260911.py')
live = load('profile_parity_live', ROOT.parent/'startup-subtitle-20260912/deploy-startup-subtitle-20260912.py')
base.ROOT, base.MIGRATION, base.TARGET, base.OLD, base.NEW = ROOT, MIGRATION, TARGET, OLD, NEW
base.NAME, base.LABEL = NAME, LABEL
sha = base.sha


def require(condition, reason='profile_parity_assertion_failed'):
    if not condition:
        raise RuntimeError(reason)


def sql(statement, target=None, write=False):
    return base.sql(statement, target or NAME, write)


def cases(aliases_accepted):
    profile = {'container': 'mkv', 'probeSource': 'gateway_probe', 'probedAt': '2026-09-12T12:00:00Z',
        'videoCodec': 'h264', 'audioCodec': 'aac', 'durationSeconds': 5471.833334,
        'fileSizeBytes': 951409344, 'audioTracks': [{'index': 1, 'codec': 'aac'}], 'subtitles': []}
    checks = []
    for container in ('mkv', 'matroska,webm', 'webm', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg',
                      'm4v', 'mov,mp4,m4a,3gp,3g2,mj2', 'ts', 'mpegts', 'hls', 'dash', 'mp4hls', 'mpegtslive'):
        accepted = container in ('mkv', 'matroska,webm', 'webm', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg')
        accepted = accepted or (aliases_accepted and container in ('m4v', 'mov,mp4,m4a,3gp,3g2,mj2', 'ts', 'mpegts'))
        checks.append(({**profile, 'container': container}, accepted))
    negative = [
        {'fileSizeBytes': 0}, {'fileSizeBytes': None}, {'durationSeconds': 0},
        {'audioTracks': []}, {'audioTracks': [{'index': 1}, {'index': 1}]},
        {'videoCodec': ''}, {'audioCodec': ''}, {'subtitles': None}, {'probedAt': ''},
        {'probeSource': 'provider_label'}, {'probeSource': 'gateway_inband', 'metadataComplete': False},
    ]
    for change in negative:
        checks.append(({**profile, **change}, False))
        if aliases_accepted:
            checks.append(({**profile, 'container': 'mpegts', **change}, False))
    checks.append(({**profile, 'probeSource': 'gateway_inband', 'metadataComplete': True}, True))
    for number, (value, expected) in enumerate(checks):
        result = sql('SELECT ' + TARGET.split('(')[0] + '(' + base.p.lib.literal(json.dumps(value)) + '::jsonb);')
        require(result == ('t' if expected else 'f'), 'profile_case_failed_' + str(number))
    return {'total': len(checks), 'negativeCases': sum(not expected for _, expected in checks)}


def proof():
    require(not (ROOT/'proof.private.json').exists())
    before = base.definition()
    require(before.count(OLD) == 1 and NEW not in before)
    migration = (ROOT/MIGRATION).read_text().replace('\r\n', '\n')
    functions = ('public.catalog_audio_track_indexes(jsonb)', 'public.vod_language_profile_audio_indices(jsonb)',
        'public.vod_language_profile_file_size_bytes(jsonb)', TARGET)
    schema = 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;\n'
    schema += ';\n'.join(sql('SELECT pg_get_functiondef(' + base.p.lib.literal(f) + '::regprocedure);', 'norva-db') for f in functions)
    schema += ';\nREVOKE ALL ON FUNCTION ' + TARGET + ' FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION ' + TARGET + ' TO service_role;'
    require(NAME not in base.run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines())
    created = False
    try:
        base.run(['docker', 'run', '-d', '--name', NAME, '--label', 'norva.purpose=' + LABEL,
            '--network', 'none', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
            '--tmpfs', '/tmp:rw,nosuid,size=384m,mode=1777', '--user', 'postgres', '--entrypoint', '/bin/sh',
            'supabase/postgres:17.6.1.136', '-c',
            "initdb -D /tmp/proof -U postgres --auth=trust >/tmp/init.log 2>&1 && exec postgres -D /tmp/proof -k /tmp -c listen_addresses='' -c shared_buffers=32MB"])
        created = True
        for _ in range(25):
            ready = subprocess.run(['docker', 'exec', NAME, 'pg_isready', '-h', '/tmp', '-U', 'postgres'], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(1)
        sql(schema)
        fixture_before, acl_before = base.definition(NAME), base.acl(NAME)
        old_cases = cases(False)
        sql(migration)
        after = base.definition(NAME)
        require(after == fixture_before.replace(OLD, NEW))
        require(base.acl(NAME) == acl_before and not acl_before['anon'] and not acl_before['authenticated'] and acl_before['service'])
        new_cases = cases(True)
        sql(migration)
        require(base.definition(NAME) == after and base.definition() == before)
        evidence = {'passed': True, 'beforeSha256': sha(before), 'afterSha256': sha(before.replace(OLD, NEW)),
            'migrationSha256': sha(migration), 'oldCases': old_cases, 'newCases': new_cases,
            'onlyAllowlistChanged': True, 'aclPreserved': True, 'idempotent': True,
            'jobsCreated': 0, 'providerRequests': 0, 'networkDisabled': True}
        base.p.save(ROOT/'proof.private.json', evidence, True)
    finally:
        if created:
            container = json.loads(base.run(['docker', 'inspect', NAME]))[0]
            require(container['HostConfig']['NetworkMode'] == 'none' and container['Config']['Labels']['norva.purpose'] == LABEL)
            base.run(['docker', 'rm', '-f', container['Id']])
    print(json.dumps({**evidence, 'isolatedContainerRemoved': True}))


def deploy(commit):
    require(re.fullmatch('[a-f0-9]{40}', commit) is not None)
    evidence = base.p.private(ROOT/'proof.private.json')
    require(evidence['passed'] and evidence['networkDisabled'] and evidence['providerRequests'] == 0)
    before = base.definition()
    require(sha(before) == evidence['beforeSha256'])
    migration = (ROOT/MIGRATION).read_text().replace('\r\n', '\n')
    require(sha(migration) == evidence['migrationSha256'])
    previous_acl = base.acl('norva-db')
    rollback = {'definition': before, 'acl': previous_acl, 'commit': commit}
    if (ROOT/'rollback.private.json').exists():
        require(base.p.private(ROOT/'rollback.private.json') == rollback)
    else:
        base.p.save(ROOT/'rollback.private.json', rollback, True)
    guard = "DO $guard$ BEGIN IF md5(rtrim(pg_get_functiondef(" + base.p.lib.literal(TARGET) + "::regprocedure),E'\\n')) <> " + base.p.lib.literal(hashlib.md5(before.encode()).hexdigest()) + " THEN RAISE EXCEPTION 'function changed'; END IF; END $guard$;"
    body = migration.replace("SET LOCAL statement_timeout = '20s';", "SET LOCAL statement_timeout = '20s';\n" + guard)
    require(body.endswith('COMMIT;\n') and body.count(guard) == 1)
    live.verify()
    live.op.base.previous.d.idle()
    sql(body, 'norva-db', write=True)
    require(sha(base.definition()) == evidence['afterSha256'] and base.acl('norva-db') == previous_acl)
    receipt = {'deployed': True, 'commit': commit, 'functionSha256': evidence['afterSha256'],
        'migration': MIGRATION, 'onlyAllowlistChanged': True, 'aclPreserved': True,
        'snapshotsAndJobsUnchangedByMigration': True}
    base.p.save(ROOT/'deployed.private.json', receipt, True)
    print(json.dumps(receipt))


base.proof = proof
if __name__ == '__main__':
    os.umask(0o077)
    try:
        if sys.argv[1] == 'proof':
            proof()
        elif sys.argv[1] == 'deploy':
            deploy(sys.argv[2])
        elif sys.argv[1] == 'status':
            print(json.dumps({'functionSha256': sha(base.definition()), 'acl': base.acl('norva-db'),
                'receiptPresent': (ROOT/'deployed.private.json').exists()}))
        else:
            raise RuntimeError('invalid_phase')
    except Exception as error:
        reason = str(error)
        print(json.dumps({'ok': False, 'errorType': type(error).__name__, 'error': reason if re.fullmatch('[a-z_0-9]{1,80}', reason) else 'profile_parity_operation_failed'}))
        sys.exit(1)
