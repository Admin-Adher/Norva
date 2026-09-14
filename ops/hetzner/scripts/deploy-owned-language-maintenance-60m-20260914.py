"""One explicitly authorized 60-minute retry, with unchanged activation gates.

Uses the six-file payload from the safely closed attempt, not newer unrelated
main changes. Does not cancel work, enable metadata, mutate SQL or reset queues.
The original watchdog, idle checks and retained-container recovery are retained.
"""
import hashlib, importlib.util, json, os, pathlib, re, sys, time

ROOT = pathlib.Path('/home/adrien/.norva/owned-language-maintenance-60m-20260914')
PREVIOUS = ROOT.parent/'unknown-first-language-edge-20260914'
ADAPTER = PREVIOUS/'deploy-unknown-first-language-edge.py'
ADAPTER_SHA = '0b6c11ae7b8b32832450045040800e5df183c62ead6d9d565718a9de137eaef9'
SOURCE_COMMIT = 'd7dacab268c7ad1b10f349811dadb6a38b766efa'
PAUSE_SECONDS = 3600
ACK = 'pause-planned-jobs-at-most-60m-no-cancellation'
PHASES = ('prepare', 'bind-sql', 'stage', 'launch', 'run', 'watch', 'recover', 'status')

def require(ok, code):
    if not ok: raise RuntimeError(code)

def sha(value): return hashlib.sha256(value).hexdigest()

def private_file(root, name):
    path = root/name
    require(path.is_file() and not path.is_symlink(), 'bound_artifact_missing')
    return path

def read(root, name): return json.loads(private_file(root, name).read_text())

def save(name, value):
    with (ROOT/name).open('x') as file: json.dump(value, file, indent=2)

def validate_binding(binding):
    require(binding.get('sourceCommit') == SOURCE_COMMIT, 'reviewed_payload_required')
    require(re.fullmatch('[a-f0-9]{40}', str(binding.get('operatorCommit', ''))), 'operator_commit_required')
    require(binding.get('maxPauseSeconds') == PAUSE_SECONDS and binding.get('authorization') == ACK,
            'maintenance_authorization_scope')
    require(binding.get('operatorSha256') == sha(pathlib.Path(__file__).read_bytes()), 'operator_hash_drift')

def previous_binding():
    require(sha(private_file(PREVIOUS, ADAPTER.name).read_bytes()) == ADAPTER_SHA, 'reviewed_adapter_drift')
    cfg = read(PREVIOUS, 'release-config.private.json')
    require(cfg.get('commit') == SOURCE_COMMIT and cfg.get('operatorSha256') == ADAPTER_SHA, 'previous_binding_drift')
    closed = read(PREVIOUS, 'closed.private.json')
    require(closed.get('commit') == SOURCE_COMMIT and closed.get('updated') is False
            and all(closed.get(key) is True for key in ('edgeNeverActivated','oldEdgeRestored','cronsRestored')),
            'previous_attempt_not_safely_closed')
    return cfg

def prepare(binding, previous):
    require(set(path.name for path in ROOT.iterdir()) == {pathlib.Path(__file__).name, 'maintenance-binding.private.json'},
            'retry_directory_not_fresh')
    # Copy only the two already reviewed archives. stage verifies every member's
    # exact Git hash and live baseline before any driver can be paused.
    for name in ('base.tar','candidate.tar'):
        source = private_file(PREVIOUS, name)
        require(0 < source.stat().st_size <= 2*1024*1024, 'archive_size')
        with (ROOT/name).open('xb') as target: target.write(source.read_bytes())
    save('release-config.private.json', {**previous,
        'operatorSha256': binding['operatorSha256'], 'operatorCommit': binding['operatorCommit'],
        'maxPauseSeconds': PAUSE_SECONDS, 'authorization': ACK})

def install_bounded_launch(base):
    def launch():
        plan = base.saved('plan.private.json')
        base.invariant(plan)
        now = time.time()
        require(0 <= now-plan['stagedAt'] < 300 and base.core.base.r.crons() == plan['crons'],
                'stage_expired_or_cron_drift')
        require(not (ROOT/'begin.private.json').exists(), 'prior_launch_no_retry')
        # The unchanged run loop reserves its final 120 seconds for activation
        # or recovery; the authorization is never extended after launch.
        base.save('begin.private.json', {'at':now, 'deadline':now+PAUSE_SECONDS,
            'maxPauseSeconds':PAUSE_SECONDS, 'authorization':ACK})
        base.spawn('watch')
        require(base.process_alive('watch'), 'guard_missing')
        base.spawn('run')
        print(json.dumps({'launched':True, 'guardAlive':True, 'maxPauseSeconds':PAUSE_SECONDS,
            'deadline':now+PAUSE_SECONDS, 'jobCancellation':False}))
    base.launch = launch

def configure_adapter(adapter):
    original_adapt = adapter.adapt
    def adapt(controller, cfg, sql, closer=None):
        result = original_adapt(controller, cfg, sql, closer)
        result.ACK = ACK
        original_initialize = result.initialize
        def initialize():
            original_initialize()
            install_bounded_launch(result.base)
        result.initialize = initialize
        return result
    adapter.adapt = adapt
    adapter.ROOT = ROOT
    adapter.__file__ = str(pathlib.Path(__file__).resolve())
    adapter.HELPERS = {**adapter.HELPERS, ADAPTER:ADAPTER_SHA,
        **{PREVIOUS/name:sha(private_file(PREVIOUS, name).read_bytes())
           for name in ('release-config.private.json','closed.private.json')},
        ROOT/'maintenance-binding.private.json':sha(private_file(ROOT,'maintenance-binding.private.json').read_bytes())}

def main():
    os.umask(0o077)
    sys.dont_write_bytecode = True
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.stat().st_mode&0o077 == 0, 'private_root_required')
    require(pathlib.Path(__file__).resolve().parent == ROOT.resolve(), 'operator_location_mismatch')
    require(len(sys.argv)>=2 and sys.argv[1] in PHASES, 'invalid_phase')
    binding = read(ROOT, 'maintenance-binding.private.json')
    validate_binding(binding)
    previous = previous_binding()
    if sys.argv[1] == 'prepare':
        require(len(sys.argv)==2, 'invalid_prepare_arguments')
        prepare(binding, previous)
        print(json.dumps({'prepared':True, 'sourceCommit':SOURCE_COMMIT, 'operatorCommit':binding['operatorCommit'],
            'maxPauseSeconds':PAUSE_SECONDS, 'productionWrites':0}))
        return
    current = read(ROOT,'release-config.private.json')
    require(current == {**previous, 'operatorSha256':binding['operatorSha256'],
        'operatorCommit':binding['operatorCommit'], 'maxPauseSeconds':PAUSE_SECONDS, 'authorization':ACK},
        'retry_binding_drift')
    spec = importlib.util.spec_from_file_location('bound_owned_language_adapter', ADAPTER)
    adapter = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = adapter
    spec.loader.exec_module(adapter)
    configure_adapter(adapter)
    adapter.main()

if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok':False,'code':code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}',code) else type(error).__name__}))
        sys.exit(1)
