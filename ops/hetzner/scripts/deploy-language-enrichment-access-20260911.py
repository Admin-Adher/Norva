"""Single-module rolling Edge release, with a recoverable background cron drain.

No migration, model/Gateway replacement, entitlement mutation or job reset.
Only the two named cron active bits are temporarily changed, then restored.
Existing function trees and containers are retained, never overwritten/deleted.
"""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import time
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/language-enrichment-access-20260911')
HELPERS = ROOT.parent / 'lid-adaptive-quota-20260911/deploy-lid-adaptive-quota-20260911.py'
spec = importlib.util.spec_from_file_location('previous_release', HELPERS)
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
gw, lib, edge = previous.gw, previous.lib, previous.fleet.edge
require = gw.require
SERVICES = ('norva-edge-functions', 'norva-edge-functions-2')
FILE = 'norva-playback/index.ts'
BASE_SHA = '1ea3672a4e297000de9295c0c9c290f0bfb550f427ea2ce88c6dbfb8baa6fdd3'
CANDIDATE_SHA = '3b14c4af5a949c77c33a2fa41959391b3cd6960e2faf03efd7c01f629569e85d'
CRONS = ('norva-dynamic-enrichment-fleet', 'norva-playback-language-validation-worker')


def saved(name):
    return json.loads(gw.safe_file(ROOT, name).read_text())


def controls():
    return json.loads(lib.sql("SELECT jsonb_build_object('flags',"
        "(SELECT jsonb_object_agg(key,enabled) FROM public.admin_feature_flags),"
        "'quarantine',(SELECT md5(to_jsonb(j)::text) FROM public.catalog_file_audio_validation_jobs j "
        "WHERE id='5df2bccb-cae4-47fb-97f1-95c1efdc95b3' AND quarantined_at IS NOT NULL));"))


def crons():
    return json.loads(lib.sql("SELECT jsonb_agg(jsonb_build_object('id',jobid,'name',jobname,"
        "'active',active,'spec',md5((to_jsonb(j)-'active')::text)) ORDER BY jobid) FROM cron.job j "
        "WHERE jobname IN ('norva-dynamic-enrichment-fleet','norva-playback-language-validation-worker');"))


def alter_crons(plan, pause):
    current = crons()
    require(len(current) == 2 and {j['name'] for j in current} == set(CRONS), 'cron_set_changed')
    require(all(any(j['id'] == old['id'] and j['spec'] == old['spec'] for old in plan['crons']) for j in current), 'cron_spec_changed')
    statements = ['BEGIN; SET LOCAL lock_timeout=\'3s\'; SET LOCAL statement_timeout=\'20s\';']
    for job in plan['crons']:
        require(type(job['id']) is int and re.fullmatch('[a-f0-9]{32}', job['spec']), 'invalid_cron_receipt')
        active = 'false' if pause else ('true' if job['active'] else 'false')
        statements.append("DO $guard$ BEGIN PERFORM 1 FROM cron.job j WHERE jobid=" + str(job['id']) +
            " AND md5((to_jsonb(j)-'active')::text)='" + job['spec'] + "' FOR UPDATE; "
            "IF NOT FOUND THEN RAISE EXCEPTION 'cron drift'; END IF; END $guard$;")
        statements.append('SELECT cron.alter_job(' + str(job['id']) + ',active:=' + active + ');')
    statements.append('COMMIT;')
    lib.sql('\n'.join(statements), write=True)
    expected = [{**j, 'active': False} for j in plan['crons']] if pause else plan['crons']
    require(crons() == expected, 'cron_state_mismatch')


def idle():
    gw.assert_idle(gw.health())
    state = json.loads(lib.sql("SELECT jsonb_build_object('playback',"
        "(SELECT count(*) FROM public.cloud_playback_sessions WHERE status IN ('pending','ready') AND expires_at>now()),"
        "'jobs',(SELECT count(*) FROM public.catalog_file_audio_validation_jobs WHERE state IN ('running','finalizing') AND lease_expires_at>now()),"
        "'intake',(SELECT count(*) FROM public.catalog_vod_language_intake WHERE state='leased' AND lease_until>now()));"))
    require(set(state) == {'playback', 'jobs', 'intake'} and
        all(type(v) is int and v == 0 for v in state.values()), 'background_or_playback_active')


def stage(commit):
    require(re.fullmatch('[a-f0-9]{40}', commit) is not None, 'invalid_commit')
    require(not (ROOT / 'plan.private.json').exists(), 'plan_exists')
    candidate = gw.safe_file(ROOT, 'candidate.ts').read_bytes().replace(b'\r\n', b'\n')
    require(lib.digest(candidate) == CANDIDATE_SHA, 'candidate_hash_mismatch')
    originals = {name: gw.inspect(name) for name in SERVICES}
    roots = [lib.edge_root(c) for c in originals.values()]
    require(len(set(roots)) == 1, 'edge_roots_diverged')
    old = roots[0]
    require(lib.digest((old / FILE).read_bytes()) == BASE_SHA, 'live_baseline_drift')
    for container in originals.values():
        lib.edge_health(container)
    before = edge.hashes(old)
    target = ROOT / 'functions'
    shutil.copytree(old, target)
    (target / FILE).write_bytes(candidate)
    (target / FILE).chmod(0o644)
    after = edge.hashes(target)
    require(set(before) == set(after) and all(v == after[k] for k, v in before.items() if k != FILE), 'unrelated_edge_changed')
    plan = {'commit': commit, 'containers': originals, 'before': before, 'after': after,
        'runtime': gw.runtime_snapshot(gw.health()), 'gatewaySources': gw.source_snapshot(),
        'gatewayId': gw.inspect()['Id'], 'controls': controls(), 'crons': crons(), 'stagedAt': time.time()}
    require(plan['controls']['quarantine'] is not None, 'protected_quarantine_missing')
    require(len(plan['crons']) == 2 and {j['name'] for j in plan['crons']} == set(CRONS), 'cron_set_changed')
    gw.private_write(ROOT / 'plan.private.json', plan)
    print(json.dumps({'staged': True, 'commit': commit, 'edgeSha256': CANDIDATE_SHA,
        'unrelatedFilesPreserved': len(before) - 1, 'productionUnchanged': True}))


def verify_service(name, plan, candidate=True):
    original, active = plan['containers'][name], gw.inspect(name)
    expected = lib.edge_expected(original, ROOT / 'functions') if candidate else original
    gw.assert_clone(expected, active, original['Config']['Image'])
    require(active['Image'] == original['Image'], 'edge_image_changed')
    require(edge.hashes(lib.edge_root(active)) == plan['after' if candidate else 'before'], 'edge_tree_changed')
    lib.edge_health(active)
    require(active['RestartCount'] == 0 and not active['State']['OOMKilled'], 'restart_or_oom')
    env = dict(v.split('=', 1) for v in active['Config']['Env'] if '=' in v)
    ip = active['NetworkSettings']['Networks']['norva_default']['IPAddress']
    request = urllib.request.Request('http://' + ip + ':9000/norva-playback/health',
        headers={'Authorization': 'Bearer ' + env.get('NORVA_BACKFILL_TOKEN', '')})
    with urllib.request.urlopen(request, timeout=20) as response:
        health = json.load(response)
    require(health.get('languageAdaptiveAdmissionProtocol') == 1, 'capacity_protocol_missing')
    require((health.get('languageEnrichmentAccessProtocol') == 1) == candidate, 'access_protocol_mismatch')


def verify_invariants(plan):
    require(gw.inspect()['Id'] == plan['gatewayId'], 'gateway_container_changed')
    require(gw.source_snapshot() == plan['gatewaySources'], 'gateway_sources_changed')
    gw.assert_runtime(gw.health(), plan['runtime'])
    require(controls() == plan['controls'], 'controls_or_quarantine_changed')


def activate(name, plan):
    original = plan['containers'][name]
    require(gw.inspect(name)['Id'] == original['Id'], 'container_drift')
    verify_service(name, plan, False)
    other = SERVICES[1] if name == SERVICES[0] else SERVICES[0]
    lib.edge_health(gw.inspect(other))
    idle()
    expected = lib.edge_expected(original, ROOT / 'functions')
    receipt_file = name + '-receipt.private.json'
    if (ROOT / receipt_file).exists():
        receipt = saved(receipt_file)
        require(not gw.inspect(receipt['candidateContainer'])['State']['Running'], 'candidate_already_running')
    else:
        candidate_name = name + '-enrichment-access-candidate-20260911'
        created = gw.docker_api('POST', '/containers/create?name=' + candidate_name,
            gw.clone_payload(expected, original['Config']['Image']))
        receipt = {'candidateContainer': created['Id'], 'candidateName': candidate_name}
        gw.private_write(ROOT / receipt_file, receipt)
    gw.assert_clone(expected, gw.inspect(receipt['candidateContainer']), original['Config']['Image'])
    idle()
    try:
        gw.run(['docker', 'stop', '--time', '20', original['Id']])
        gw.run(['docker', 'rename', original['Id'], name + '-enrichment-access-rollback-20260911'])
        gw.run(['docker', 'rename', receipt['candidateContainer'], name])
        gw.run(['docker', 'start', receipt['candidateContainer']])
        ready = False
        for _ in range(25):
            try:
                verify_service(name, plan)
                ready = True
                break
            except Exception:
                time.sleep(1)
        require(ready, 'candidate_unhealthy')
    except Exception:
        edge.restore(name, plan, receipt)
        verify_service(name, plan, False)
        raise RuntimeError('candidate_failed_original_restored') from None


def pause():
    plan = saved('plan.private.json')
    for name in SERVICES:
        verify_service(name, plan, False)
    verify_invariants(plan)
    require(crons() == plan['crons'], 'cron_state_drift')
    alter_crons(plan, True)
    print(json.dumps({'backgroundCronsPaused': len(CRONS), 'existingWorkNotCancelled': True}))


def deploy():
    plan = saved('plan.private.json')
    require(crons() == [{**j, 'active': False} for j in plan['crons']], 'crons_not_paused')
    idle()
    time.sleep(2)
    idle()
    verify_invariants(plan)
    changed = []
    try:
        for name in SERVICES:
            activate(name, plan)
            changed.append(name)
        for name in SERVICES:
            verify_service(name, plan)
        verify_invariants(plan)
    except Exception:
        for name in reversed(changed):
            edge.restore(name, plan, saved(name + '-receipt.private.json'))
        for name in SERVICES:
            verify_service(name, plan, False)
        alter_crons(plan, False)
        raise RuntimeError('release_failed_originals_and_crons_restored') from None
    alter_crons(plan, False)
    verify()


def verify():
    plan = saved('plan.private.json')
    for name in SERVICES:
        verify_service(name, plan)
    verify_invariants(plan)
    require(crons() == plan['crons'], 'cron_restore_missing')
    result = {'productionVerified': True, 'commit': plan['commit'], 'edgeSha256': CANDIDATE_SHA,
        'bothReplicasHealthy': True, 'accessProtocol': 1, 'cronsRestored': True,
        'gatewayRuntimeAndModelsPreserved': True, 'flagsAndQuarantinePreserved': True,
        'unrelatedEdgeFilesPreserved': len(plan['before']) - 1, 'checkedAt': time.time()}
    gw.private_write(ROOT / ('production-proof-' + str(time.time_ns()) + '.json'), result)
    print(json.dumps(result))


def resume(candidate=True):
    """Recover a cron-resume interruption only after both replicas agree."""
    plan = saved('plan.private.json')
    for name in SERVICES:
        verify_service(name, plan, candidate)
    verify_invariants(plan)
    alter_crons(plan, False)
    if candidate:
        verify()
    else:
        print(json.dumps({'originalsHealthy': True, 'cronsRestored': True}))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        require(ROOT.is_dir() and not ROOT.is_symlink(), 'release_directory_missing')
        phase = sys.argv[1]
        if phase == 'stage': stage(sys.argv[2])
        elif phase == 'pause': pause()
        elif phase == 'idle': idle(); print(json.dumps({'idle': True}))
        elif phase == 'deploy': deploy()
        elif phase == 'verify': verify()
        elif phase == 'resume': resume()
        elif phase == 'resume-original': resume(False)
        else: raise RuntimeError('invalid_phase')
    except Exception as error:
        message = str(error)
        print(json.dumps({'ok': False, 'error': message if re.fullmatch('[a-z0-9_:-]{1,120}', message) else 'enrichment_release_failed'}))
        sys.exit(1)
