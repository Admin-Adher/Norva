"""One separately journaled retry of sample 1, only after zero provider I/O.

The original immutable plan/receipts are preserved. All production admission,
exact-file, queue, quarantine and positive drain guards are still run by the
published recheck operator. Never retry an uncertain or attempted operation.
"""
import fcntl, hashlib, importlib.util, json, os, pathlib, re, sys

ROOT = pathlib.Path('/home/adrien/.norva/legacy-language-tags-retry-20260913')
ORIGINAL = ROOT.parent / 'legacy-language-tags-20260913/recheck-legacy-language-tags-20260913.py'


def safe_before_io(receipt):
    if not isinstance(receipt, dict) or receipt.get('result') != 'deferred':
        return False
    data = receipt.get('diagnostic')
    return isinstance(data, dict) and type(data.get('attempted')) is int and data['attempted'] == 0 \
        and type(data.get('persisted')) is int and data['persisted'] == 0 and data.get('deferredBeforeIO') is True \
        and data.get('reason') == 'provider-account-busy'


def run():
    spec = importlib.util.spec_from_file_location('legacy_original', ORIGINAL)
    operator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(operator)
    require = operator.require
    require(ROOT.is_dir() and not ROOT.is_symlink(), 'retry_root_missing')
    require(not (ROOT / 'plan.private.json').exists(), 'retry_already_journaled')
    with (operator.ROOT / 'operator.lock').open('a') as original_lock, (ROOT / 'operator.lock').open('a') as retry_lock:
        fcntl.flock(original_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(retry_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = operator.guard()
        require(not any(operator.ROOT.glob('*-failed.private.json')), 'uncertain_original_operation')
        receipt = operator.saved('01-closed.private.json')
        require(safe_before_io(receipt), 'not_a_safe_before_io_retry')
        row = plan['rows'][0]
        require(row['sample'] == 1, 'retry_sample_changed')
        # Add this wrapper to the existing protected operators without replacing
        # any of their digests. The original expiry is never extended.
        plan = {**plan, 'rows': [row], 'retryOf': 'original-sample-1-before-io',
            'protected': {**plan['protected'], str(pathlib.Path(__file__)):
                hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}}
        operator.ROOT = ROOT
        operator.save('plan.private.json', plan)
        operator.step(1)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        run()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,100}', code) else 'retry_failed_or_uncertain'}))
        sys.exit(1)
