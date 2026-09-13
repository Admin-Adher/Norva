"""Finite fresh-header audit of the second user-reported legacy cohort.

Codes are support selectors, not a blacklist: genuine observed/verified audio
is never replaced by a provider hint. Uses the original guarded operator and
isolates this cohort's immutable receipts, without resetting any existing job.
"""
import fcntl, hashlib, importlib.util, json, os, pathlib, re, sys, time

ROOT = pathlib.Path('/home/adrien/.norva/reported-language-tags-20260913')
ORIGINAL = ROOT.parent / 'legacy-language-tags-20260913/recheck-legacy-language-tags-20260913.py'
CODES = ('hz', 'rn', 'ab', 'or', 'ch', 'na')


def reported_track(tracks):
    return isinstance(tracks, list) and any(isinstance(t, dict) and t.get('lang') in CODES for t in tracks)


def configure():
    spec = importlib.util.spec_from_file_location('legacy_original', ORIGINAL)
    operator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(operator)
    operator.ROOT = ROOT
    operator.is_suspect = reported_track
    return operator


def prepare(operator):
    require = operator.require
    require(not (ROOT / 'plan.private.json').exists(), 'cohort_already_prepared')
    require(operator.release.saved('closed.private.json').get('updated') is True, 'release_not_complete')
    # Same exact source/active generation/internal account gates as the original
    # audit. An existing job of ANY state or any preserved speech evidence wins.
    rows = operator.pilot.query("""WITH suspects AS MATERIALIZED (
 SELECT c.* FROM public.catalog_file_tracks c WHERE c.item_type='movie'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.audio_tracks) t
   WHERE t->>'lang' IN ('hz','rn','ab','or','ch','na'))
 AND c.audio_lang_verified_at IS NULL AND c.observed_profile_fingerprint IS NULL
 AND coalesce(c.audio_lang_verification,'{}'::jsonb)='{}'::jsonb
 AND coalesce(c.audio_whisper_verification,'{}'::jsonb)='{}'::jsonb
 AND c.audio_probed_at<'2026-09-13 00:00:00+00'::timestamptz
 AND (c.audio_lang_retry_at IS NULL OR c.audio_lang_retry_at<=now())
), eligible AS (
 SELECT DISTINCT ON(c.server_host,c.external_id) v.user_id,v.source_id,v.id AS variant_id,
 c.server_host AS identity_key,c.external_id,c.audio_tracks AS original_tracks,c.audio_probed_at AS original_probed_at
 FROM suspects c JOIN public.catalog_source_provider_identities i ON i.identity_id::text=c.server_host
 JOIN public.cloud_sources s ON s.id=i.source_id AND s.user_id=i.user_id AND s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'
 JOIN public.admin_internal_accounts a ON a.user_id=s.user_id
 JOIN auth.users u ON u.id=s.user_id AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
 JOIN public.cloud_source_catalog_heads h ON h.source_id=s.id AND h.user_id=s.user_id
 JOIN public.cloud_title_variants v ON v.source_id=s.id AND v.user_id=s.user_id AND v.generation_id=h.active_generation_id
  AND v.item_type='movie' AND v.external_id=c.external_id
 WHERE NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs j WHERE j.identity_key=c.server_host AND j.item_type='movie' AND j.external_id=c.external_id)
 ORDER BY c.server_host,c.external_id,v.id
)
SELECT coalesce(jsonb_agg(e),'[]'::jsonb) FROM eligible e;""")
    require(0 < len(rows) <= 15, 'audited_cohort_size_changed')
    for sample, row in enumerate(rows, 1):
        require(all(operator.pilot.UUID.fullmatch(row[k]) for k in ('user_id','source_id','variant_id','identity_key')), 'invalid_identity')
        require(reported_track(row['original_tracks']), 'reported_code_missing')
        row['sample'] = sample
    files = [pathlib.Path(__file__), ORIGINAL, operator.RELEASE, operator.PILOT,
             operator.PILOT.with_name('check-strict-lid-adaptive-evidence-batch-20260910.py')]
    operator.save('plan.private.json', {'rows': rows, 'preparedAt': time.time(), 'expiresAt': time.time()+3600,
        'releaseCommit': operator.release.saved('plan.private.json')['commit'],
        'protected': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}})
    print(json.dumps({'prepared': True, 'files': len(rows), 'providers': len({r['identity_key'] for r in rows}), 'providerRequests': 0}))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        operator = configure()
        operator.require(ROOT.is_dir() and not ROOT.is_symlink(), 'root_missing')
        with (ROOT / 'operator.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            action = sys.argv[1]
            operator.require(action in ('prepare','step','status'), 'invalid_action')
            if action == 'prepare': prepare(operator)
            elif action == 'step': operator.step(int(sys.argv[2]))
            else: operator.status()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,100}', code) else 'reported_recheck_failed'}))
        sys.exit(1)
