"""Refresh only the six unbound legacy files in the user's five screenshots.

The codes select this finite support cohort; they are not invalid ISO codes.
Use the normal guarded header route. Never override a language, reset a job,
alter a quarantine, or enqueue speech analysis. Immutable before/intent/after
receipts prevent an uncertain provider call from being repeated.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/provider-tag-evidence-r2-20260913')
RELEASE = ROOT.parent / 'unidentified-audio-release-r2-20260913/deploy-unidentified-audio-20260913.py'
PILOT = ROOT.parent / 'unknown-vod-pilot-20260911/run-unknown-vod-pilot-20260911.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def safe_legacy(value):
    if not isinstance(value, dict):
        return False
    return not any(value.get(key) for key in (
        'verified', 'job', 'retryAt', 'probeCircuitRetryAt',
        'observedFingerprint', 'observedAt', 'observedProfile',
    )) and bool(value.get('tracks'))


def operator():
    release = load('reported_tags_release', RELEASE)
    pilot = load('reported_tags_pilot', PILOT)
    return release, pilot


def prepare(release, pilot):
    require = release.require
    require(not (ROOT / 'plan.private.json').exists(), 'plan_already_exists')
    require(release.saved('closed.private.json').get('updated') is True, 'filter_not_deployed')
    rows = pilot.query("""SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (
 SELECT DISTINCT ON (i.identity_id,v.external_id)
   v.user_id,v.source_id,v.id AS variant_id,i.identity_id::text AS identity_key,v.external_id,
   t.title,v.raw_title,c.audio_tracks AS original_tracks,c.audio_probed_at AS original_probed_at
 FROM public.cloud_catalog_visible_title_variants v
 JOIN public.cloud_titles t ON t.id=v.title_id AND t.user_id=v.user_id AND t.item_type=v.item_type
 JOIN public.admin_internal_accounts internal ON internal.user_id=v.user_id
 JOIN public.catalog_source_provider_identities i ON i.source_id=v.source_id AND i.user_id=v.user_id
 JOIN public.catalog_file_tracks c ON c.server_host=i.identity_id::text AND c.item_type=v.item_type AND c.external_id=v.external_id
 WHERE v.item_type='movie'
 AND (t.title IN ('Band on the Run','Man on the Run','Bring Her Back','Stranger in a Cab') OR t.title LIKE 'Cha Cha Real Smooth%')
 AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.audio_tracks) tr WHERE tr->>'lang' IN ('rn','ch','hz','na'))
 AND c.audio_lang_verified_at IS NULL AND c.observed_profile_fingerprint IS NULL
 AND coalesce(c.audio_lang_verification,'{}'::jsonb)='{}'::jsonb
 AND coalesce(c.audio_whisper_verification,'{}'::jsonb)='{}'::jsonb
 AND c.audio_probed_at<'2026-09-13 00:00:00+00'::timestamptz
 ORDER BY i.identity_id,v.external_id,t.title,v.id
) x;""")
    require(len(rows) == 6, 'reported_file_set_changed')
    for sample, row in enumerate(rows, 1):
        require(all(pilot.UUID.fullmatch(row[key]) for key in ('user_id','source_id','variant_id','identity_key')), 'invalid_identity')
        require(safe_legacy(pilot.current(row)), 'protected_file_state')
        row['sample'] = sample
    proof = {'rows': rows, 'preparedAt': time.time(), 'expiresAt': time.time() + 3600,
             'operatorSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
    release.gw.private_write(ROOT / 'plan.private.json', proof)
    print(json.dumps({'prepared': True, 'files': len(rows), 'providerRequests': 0}))


def step(release, pilot, sample):
    require = release.require
    plan = json.loads((ROOT / 'plan.private.json').read_text())
    require(time.time() < plan['expiresAt'], 'plan_expired')
    require(hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest() == plan['operatorSha256'], 'operator_changed')
    require(1 <= sample <= len(plan['rows']), 'invalid_sample')
    row = plan['rows'][sample - 1]
    require(row['sample'] == sample, 'sample_changed')
    prefix = str(sample).zfill(2)
    require(not (ROOT / (prefix + '-intent.private.json')).exists(), 'prior_intent_protected')
    require(not any(ROOT.glob('*-uncertain.private.json')), 'uncertain_call_protected')
    release.base.invariant(release.saved('plan.private.json'))
    release.verify_sql()
    for service in release.base.SERVICES:
        release.base.verify_edge(release.saved('plan.private.json'), service, True)
    require(release.base.core.base.r.crons() == release.saved('plan.private.json')['crons'], 'cron_drift')
    require(pilot.controls(), 'runtime_controls')
    value = pilot.current(row)
    require(safe_legacy(value) and value['tracks'] == row['original_tracks'], 'protected_file_state')
    # The ordinary metadata endpoint owns provider admission and defers before I/O.
    # Do not require unrelated Gateway jobs to stop just to ask that guarded route.
    save = lambda suffix, data: release.gw.private_write(ROOT / (prefix + suffix + '.private.json'), data)
    save('-before', value)
    save('-intent', {'at': time.time(), 'operation': 'ordinary_fresh_header_probe'})
    try:
        result = pilot.header_probe(row)
        save('-probe', result)
        after = pilot.current(row)
        save('-after', after)
        require(not (after or {}).get('job'), 'unexpected_job')
        closed = {'at': time.time(), 'sample': sample, 'probe': result,
                  'tracks': (after or {}).get('tracks'), 'boundProfile': pilot.profile_ready(after or {}),
                  'speechJobsCreated': 0}
        save('-closed', closed)
        print(json.dumps(closed))
    except Exception:
        save('-uncertain', {'at': time.time(), 'code': 'failed_or_uncertain_no_retry'})
        raise RuntimeError('failed_or_uncertain_no_retry') from None


def status(release, pilot):
    rows = json.loads((ROOT / 'plan.private.json').read_text())['rows']
    output = []
    for row in rows:
        value = pilot.current(row) or {}
        receipt = ROOT / (str(row['sample']).zfill(2) + '-closed.private.json')
        output.append({'sample': row['sample'], 'title': row['title'], 'providerTitle': row['raw_title'],
                       'tracks': value.get('tracks'), 'boundProfile': pilot.profile_ready(value),
                       'completed': receipt.exists(), 'hasJob': bool(value.get('job'))})
    print(json.dumps(output))


if __name__ == '__main__':
    os.umask(0o077)
    release, pilot = operator()
    try:
        release.require(ROOT.is_dir() and not ROOT.is_symlink(), 'root_missing')
        with (ROOT / 'operator.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            action = sys.argv[1]
            release.require(action in ('prepare','step','status'), 'invalid_action')
            if action == 'step':
                step(release, pilot, int(sys.argv[2]))
            else:
                globals()[action](release, pilot)
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', code) else 'reported_tag_repair_failed'}))
        sys.exit(1)
