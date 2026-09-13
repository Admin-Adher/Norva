"""Retry only the two proven-before-I/O deferrals of the reported cohort.

Private immutable receipts and the original expiry remain intact. The first
fresh tagged file (in the earlier cohort) is never part of this retry. Ordinary
production acquisition, playback priority, exact-file and quarantine guards
are still enforced by the unchanged published operator on every step.
"""
import fcntl, hashlib, importlib.util, json, os, pathlib, re, sys

ROOT = pathlib.Path('/home/adrien/.norva/reported-language-tags-retry-20260913')
PREVIOUS = ROOT.parent / 'reported-language-tags-continuation-20260913/continue-reported-language-tags-20260913.py'


def configure(previous=False):
    spec = importlib.util.spec_from_file_location('reported_continuation', PREVIOUS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    operator = module.configure()
    if not previous: operator.ROOT = ROOT
    return operator


def safe_before_io(receipt):
    if not isinstance(receipt, dict) or receipt.get('result') != 'deferred': return False
    data = receipt.get('diagnostic')
    return isinstance(data, dict) and type(data.get('attempted')) is int and data['attempted'] == 0 \
        and type(data.get('persisted')) is int and data['persisted'] == 0 \
        and data.get('deferredBeforeIO') is True and data.get('reason') == 'provider-account-busy'


def prepare():
    old = configure(True)
    require = old.require
    require(not (ROOT / 'plan.private.json').exists(), 'retry_already_prepared')
    with (old.ROOT / 'operator.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = old.guard()
        require(len(plan['rows']) == 13, 'original_cohort_changed')
        require(not any(old.ROOT.glob('*-failed.private.json')), 'uncertain_operation_protected')
        rows, receipts = [], [old.ROOT / 'plan.private.json', pathlib.Path(__file__)]
        for sample in (1, 2):
            name = str(sample).zfill(2)
            require(safe_before_io(old.saved(name+'-closed.private.json')), 'not_before_io_deferral')
            require(not (old.ROOT / (name+'-enqueue-intent.private.json')).exists(), 'enqueue_intent_protected')
            row = plan['rows'][sample-1]
            require(row['sample'] == sample, 'sample_changed')
            rows.append(row)
            receipts.extend(old.ROOT.glob(name+'-*.private.json'))
        protected = {**plan['protected'], **{str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in receipts}}
        configure().save('plan.private.json', {**plan, 'rows': rows, 'protected': protected,
            'retryOf': 'continuation-samples-1-and-2-before-io'})
        print(json.dumps({'prepared': True, 'files': len(rows), 'providerRequests': 0, 'expiryExtended': False}))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        operator = configure()
        operator.require(ROOT.is_dir() and not ROOT.is_symlink(), 'retry_root_missing')
        with (ROOT / 'operator.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            action = sys.argv[1]
            operator.require(action in ('prepare', 'step', 'status'), 'invalid_action')
            if action == 'prepare': prepare()
            elif action == 'step': operator.step(int(sys.argv[2]))
            else: operator.status()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,100}', code) else 'reported_retry_failed'}))
        sys.exit(1)
