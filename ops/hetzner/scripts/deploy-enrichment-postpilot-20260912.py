"""Authorized diagnostic Edge release and next-pilot operator, without new I/O.

The completed cohort, failed jobs and quarantine stay immutable. Only the Edge
function mount changes; Gateway/model/proxy/flags and all other modules remain.
The next-pilot runner is installed separately, never over the completed pilot.
"""
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/enrichment-postpilot-20260912')
PARENT = ROOT.parent/'enrichment-pilot20-independent-20260912'
APP_COMMIT = '750a747ea816d1db3e6d23b5d3f10787cd16dfa3'
BASE_SHA = 'b0a058c7f5ae798f9a2327fc5146ad35dab139b7f947fd001993ab7fd173290f'
EDGE_SHA = 'f6052c3e7416a4740db990d0517f8229e72ddbb211a72a34bf4e504386bb1d49'
RUNNER_SHA = '467492cf0d3f348fa23a281bdf21f28aaffa271f6123f0f27e9fe32ce606aff9'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


previous = module('postpilot_previous', PARENT/'deploy-independent-pilot20-20260912.py')
r = module('postpilot_rolling_edge', ROOT.parent/'language-enrichment-access-20260911/deploy-language-enrichment-access-20260911.py')
r.ROOT = ROOT
r.BASE_SHA = BASE_SHA
r.CANDIDATE_SHA = EDGE_SHA
r.gw.MODULES = previous.gw.MODULES
gw, lib, edge, require = r.gw, r.lib, r.edge, r.require
original_invariants = r.verify_invariants


def proof_paths():
    return [PARENT/name for name in ('plan.private.json', 'closed.private.json',
        'pilot/plan.private.json', 'pilot/state.private.json', 'final-closure-verification.private.json')]


def invariant(plan):
    original_invariants(plan)
    previous.invariant(previous.saved('plan.private.json'))
    protection = r.saved('protection.private.json')
    require(lib.digest((ROOT/'run-enrichment-pilot20-20260911.py').read_bytes()) == RUNNER_SHA,
        'next_operator_changed')
    for path, digest in protection['files'].items():
        require(gw.sha(pathlib.Path(path).read_bytes()) == digest, 'release_evidence_changed')
    previous.d.verify_service(previous.d.SERVICES[3], previous.saved('plan.private.json')['parentPlan'])


def verify_service(name, plan, candidate=True):
    original, active = plan['containers'][name], gw.inspect(name)
    expected = lib.edge_expected(original, ROOT/'functions') if candidate else original
    gw.assert_clone(expected, active, original['Config']['Image'])
    require(active['Image'] == original['Image'], 'edge_image_changed')
    require(edge.hashes(lib.edge_root(active)) == plan['after' if candidate else 'before'], 'edge_tree_changed')
    lib.edge_health(active)  # Real authenticated health plus OPTIONS/import.
    require(active['State']['Running'] and active['RestartCount'] == 0
        and not active['State']['OOMKilled'], 'edge_runtime_unhealthy')


def activate(name, plan):
    original = plan['containers'][name]
    require(gw.inspect(name)['Id'] == original['Id'], 'edge_container_changed')
    verify_service(name, plan, False)
    lib.edge_health(gw.inspect(next(n for n in r.SERVICES if n != name)))
    previous.d.idle()
    receipt_name = name+'-receipt.private.json'
    require(not (ROOT/receipt_name).exists(), 'edge_activation_already_attempted')
    expected = lib.edge_expected(original, ROOT/'functions')
    candidate_name = name+'-enrichment-postpilot-candidate-20260912'
    created = gw.docker_api('POST', '/containers/create?name='+candidate_name,
        gw.clone_payload(expected, original['Config']['Image']))
    receipt = {'candidateContainer': created['Id'], 'candidateName': candidate_name}
    gw.private_write(ROOT/receipt_name, receipt)
    gw.assert_clone(expected, gw.inspect(created['Id']), original['Config']['Image'])
    previous.d.idle()
    try:
        gw.run(['docker', 'stop', '--time', '20', original['Id']])
        gw.run(['docker', 'rename', original['Id'], name+'-enrichment-postpilot-retained-20260912'])
        gw.run(['docker', 'rename', created['Id'], name])
        gw.run(['docker', 'start', created['Id']])
        for attempt in range(25):
            try:
                verify_service(name, plan)
                return
            except Exception:
                if attempt == 24:
                    raise
                time.sleep(1)
    except Exception:
        edge.restore(name, plan, receipt)
        verify_service(name, plan, False)
        raise RuntimeError('candidate_failed_original_restored') from None


r.verify_service = verify_service
r.verify_invariants = invariant
r.activate = activate
r.idle = previous.d.idle


def stage():
    previous.r.verify(False)
    require(previous.saved('closed.private.json')['runtimeStatus'] == 'finished', 'previous_pilot_not_finished')
    require(not previous.r.process_active('operator', 'run')
        and not previous.r.process_active('watchdog', 'watch'), 'previous_operator_alive')
    require(lib.digest((ROOT/'run-enrichment-pilot20-20260911.py').read_bytes()) == RUNNER_SHA,
        'next_operator_not_tested')
    compile((ROOT/'run-enrichment-pilot20-20260911.py').read_text(), 'next-pilot-runner', 'exec')
    r.stage(APP_COMMIT)
    files = proof_paths()+[pathlib.Path(__file__), pathlib.Path(r.__file__)]
    gw.private_write(ROOT/'protection.private.json', {'files': {str(p): gw.sha(p.read_bytes()) for p in files}})
    invariant(r.saved('plan.private.json'))


def recover():
    """Do not guess a replacement after interruption. Inspect exact receipts."""
    plan = r.saved('plan.private.json')
    invariant(plan)
    candidate_ids = {name: r.saved(name+'-receipt.private.json')['candidateContainer']
        for name in r.SERVICES if (ROOT/(name+'-receipt.private.json')).exists()}
    inventory = gw.docker_api('GET', '/containers/json?all=true')
    current = {}
    for name in r.SERVICES:
        matches = [c['Id'] for c in inventory if '/'+name in c.get('Names', [])]
        require(len(matches) <= 1, 'recovery_alias_ambiguous')
        current[name] = matches[0] if matches else None
        require(current[name] is not None or name in candidate_ids, 'recovery_alias_missing_without_receipt')
    require(all(current[n] in (plan['containers'][n]['Id'], candidate_ids.get(n), None) for n in r.SERVICES),
        'recovery_container_not_owned')
    if len(candidate_ids) == 2 and current == candidate_ids:
        try:
            for name in r.SERVICES:
                verify_service(name, plan)
        except Exception:
            pass
        else:
            r.resume(True)
            return True
    previous.d.idle()
    for name in reversed(r.SERVICES):
        if current[name] != plan['containers'][name]['Id']:
            edge.restore(name, plan, r.saved(name+'-receipt.private.json'))
    r.resume(False)
    return False


def process_alive(marker):
    path = ROOT/(marker+'.private.json')
    if not path.exists():
        return False
    item = r.saved(path.name)
    proc = pathlib.Path('/proc')/str(item['pid'])
    try:
        args = (proc/'cmdline').read_bytes().split(b'\0')
        return str(pathlib.Path(__file__).resolve()).encode() in args and marker.encode() in args \
            and (proc/'stat').read_text().rsplit(')', 1)[1].split()[19] == item['startTicks']
    except (FileNotFoundError, ProcessLookupError):
        return False


def spawn(phase):
    with (ROOT/(phase+'.log')).open('x') as output:
        child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).resolve()), phase],
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL, start_new_session=True)
    ticks = (pathlib.Path('/proc')/str(child.pid)/'stat').read_text().rsplit(')', 1)[1].split()[19]
    gw.private_write(ROOT/(phase+'.private.json'), {'pid': child.pid, 'startTicks': ticks})


def launch():
    invariant(r.saved('plan.private.json'))
    gw.private_write(ROOT/'begin.private.json', {'deadline': time.time()+900, 'createdAt': time.time()})
    spawn('watch')
    require(process_alive('watch'), 'cron_guard_missing')
    spawn('run')
    print(json.dumps({'launched': True, 'cronRecoveryGuard': True, 'newProviderRequests': False}))


def close(success):
    require(r.crons() == r.saved('plan.private.json')['crons'], 'cron_restore_missing')
    gw.private_write(ROOT/'closed.private.json', {'productionUpdated': success,
        'cronsRestored': True, 'oldPilotUnchanged': True, 'at': time.time()})


def run():
    success = False
    try:
        r.pause()
        deadline = r.saved('begin.private.json')['deadline']
        while time.time() < deadline:
            try:
                previous.d.idle()
                break
            except Exception:
                time.sleep(5)
        else:
            raise RuntimeError('existing_work_drain_deadline')
        r.deploy()
        success = True
    finally:
        if r.crons() != r.saved('plan.private.json')['crons']:
            success = recover()
        close(success)


def watch():
    begin = r.saved('begin.private.json')
    # Recovery never races a live operator or terminates a viewer/analysis.
    while time.time() < begin['deadline']+900:
        if (ROOT/'closed.private.json').exists():
            return
        if time.time() > begin['createdAt']+15 and not process_alive('run'):
            try:
                close(recover())
                return
            except Exception:
                pass
        time.sleep(5)
    print(json.dumps({'requiresReview': True, 'code': 'postpilot_recovery_deadline'}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        phase = sys.argv[1]
        if phase in ('stage', 'launch', 'run', 'watch', 'recover'):
            globals()[phase]()
        elif phase == 'verify':
            r.verify()
        else:
            raise RuntimeError('invalid_phase')
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', code)
            else 'postpilot_operation_failed'}), flush=True)
        sys.exit(1)
