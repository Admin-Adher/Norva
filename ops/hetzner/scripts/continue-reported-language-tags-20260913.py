"""Continue only untouched files after reconciling the first fresh header.

The original probe succeeded. Its attempted enqueue was rejected because all
audio tracks were tagged (the automatic RPC only accepts untagged tracks).
Never retry that file or erase its failure receipt. Keep rare fresh tags, use
the usual validator only for genuinely untagged tracks, and retain every
admission, lease, exact-file and quarantine guard from the published operator.
"""
import fcntl, hashlib, importlib.util, json, os, pathlib, re, sys

ROOT = pathlib.Path('/home/adrien/.norva/reported-language-tags-continuation-20260913')
PREVIOUS = ROOT.parent / 'reported-language-tags-20260913/recheck-reported-language-tags-20260913.py'


def load_previous():
    spec = importlib.util.spec_from_file_location('reported_previous', PREVIOUS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.configure()


def configure():
    operator = load_previous()
    operator.ROOT = ROOT
    # The cohort code selector is not evidence that a fresh tag is incorrect.
    # The original step still queues any genuinely untagged track.
    operator.is_suspect = lambda tracks: False
    return operator


def reconciled_probe(probe, after, current, track_unknown):
    return isinstance(probe, dict) and type(probe.get('attempted')) is int and probe['attempted'] == 1 \
        and type(probe.get('persisted')) is int and probe['persisted'] == 1 \
        and bool(after.get('tracks')) and not any(track_unknown(t) for t in after['tracks']) \
        and bool(after.get('observedFingerprint')) and current is not None and not current.get('job') \
        and all(current.get(k) == after.get(k) for k in ('tracks', 'profile', 'observedFingerprint', 'observedAt'))


def prepare():
    old = load_previous()
    require = old.require
    require(not (ROOT / 'plan.private.json').exists(), 'continuation_already_prepared')
    with (old.ROOT / 'operator.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = old.guard()
        require(len(plan['rows']) == 14, 'prior_cohort_changed')
        require(sorted(p.name for p in old.ROOT.glob('*-intent.private.json')) ==
                ['01-enqueue-intent.private.json', '01-intent.private.json'], 'other_prior_intent')
        require(sorted(p.name for p in old.ROOT.glob('*-failed.private.json')) ==
                ['01-failed.private.json'], 'other_uncertain_operation')
        require(not (old.ROOT / '01-enqueue.private.json').exists(), 'enqueue_receipt_changed')
        require(not (old.ROOT / '01-closed.private.json').exists(), 'prior_receipt_changed')
        after = old.saved('01-after.private.json')
        current = old.pilot.current(plan['rows'][0])
        require(reconciled_probe(old.saved('01-probe.private.json'), after, current, old.pilot.track_unknown),
                'first_probe_not_reconciled')
        require(old.pilot.profile_ready(current), 'first_profile_not_bound')
        # Read-only confirmation of the rejecting gate, before any job writes.
        definition = old.pilot.query("SELECT to_jsonb(pg_get_functiondef('public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure));")
        gate = "raise exception 'Automatic language validation requires an untagged audio track'"
        require(gate in definition and definition.index(gate) < definition.index('insert into public.catalog_file_audio_validation_jobs'),
                'automatic_untagged_guard_changed')
        rows = [{**row, 'originalSample': row['sample'], 'sample': index}
                for index, row in enumerate(plan['rows'][1:], 1)]
        files = [pathlib.Path(__file__), old.ROOT / 'plan.private.json', *old.ROOT.glob('01-*.private.json')]
        protected = {**plan['protected'], **{str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
        operator = configure()
        operator.save('plan.private.json', {**plan, 'rows': rows, 'protected': protected,
            'continuationOf': 'untouched-samples-2-through-14', 'excludedFreshFile': 1,
            'firstFileResult': 'fresh_tagged_metadata_preserved_no_job'})
        print(json.dumps({'prepared': True, 'files': len(rows), 'excludedFreshFiles': 1,
                          'providerRequests': 0, 'priorReceiptsPreserved': True}))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        operator = configure()
        operator.require(ROOT.is_dir() and not ROOT.is_symlink(), 'continuation_root_missing')
        with (ROOT / 'operator.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            action = sys.argv[1]
            operator.require(action in ('prepare', 'step', 'status'), 'invalid_action')
            if action == 'prepare': prepare()
            elif action == 'step': operator.step(int(sys.argv[2]))
            else: operator.status()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,100}', code) else 'continuation_failed'}))
        sys.exit(1)
