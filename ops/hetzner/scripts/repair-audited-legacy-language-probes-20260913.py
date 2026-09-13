"""Two-file, one-attempt header refresh following the September 13 language audit.

Operator steps (run only after reviewing the new release and obtaining authority):
  1. Install this script in ROOT below, a new private directory (mode 0700).
  2. Run ``python3 SCRIPT prepare``. This only reads production and saves a new
     immutable local plan. Review the two titles and returned planSha256.
  3. Run ``python3 SCRIPT apply 1 --plan-sha256 SHA
       --confirm-two-file-header-probes``. Inspect ``status`` before continuing.
  4. Only after sample 1 is refreshed, run the same apply command for sample 2.

The plan expires in one hour. A deployment, evidence change, provider circuit,
retry, job (including completed/failed/quarantined), or verified/bound profile
stops execution. Every intent is permanent, even a zero-I/O deferral: there is
no automatic retry, override, deletion, requeue or direct production SQL write.
An uncertain call stops the entire plan; inspect saved receipts and live state.
Do not edit a plan or remove receipts to bypass a stop.

Only the ordinary authenticated codec-profile-backfill route may observe the
current file. Its established version-fenced RPC may update other visible
owners of that exact provider identity/movie/external id; sibling versions and
other titles are not selected. A fresh DE result stays DE, irrespective of NL.
The three already bound 'kik' profiles are deliberately outside this cohort.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path('/home/adrien/.norva/audited-legacy-language-probes-20260913')
HELPER = ROOT.parent / 'provider-tag-evidence-r2-20260913/repair-reported-provider-tags-20260913.py'
USER_ID = '1af1dfa9-56aa-4cfd-b090-19c3c9f3dacb'
SOURCE_ID = '5dccf153-5bcc-453e-96b8-5af224e56203'
TARGETS = (
    {'variant_id': 'dfbb60ee-b243-49a7-9c96-da4c8274d577', 'external_id': '1069415',
     'title': 'Land of Mine', 'raw_title': 'NL ▎ Land of Mine', 'category': 'NL ▎VIAPLAY', 'old_language': 'de'},
    {'variant_id': 'cc537892-90f5-4cb2-88a9-2605e8272dfd', 'external_id': '1305857',
     'title': 'House of Paper', 'raw_title': 'IR ▎ House of Paper', 'category': 'IRAN', 'old_language': 'en'},
)


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True).encode()).hexdigest()


def write_once(name, value):
    path = ROOT / name
    require(path.parent == ROOT and not path.is_symlink(), 'receipt_path_invalid')
    with path.open('x', encoding='utf-8') as file:
        json.dump(value, file, sort_keys=True, ensure_ascii=True)
        file.flush()
        os.fsync(file.fileno())


def read(name):
    path = ROOT / name
    require(path.is_file() and not path.is_symlink(), 'receipt_missing_or_unsafe')
    return json.loads(path.read_text(encoding='utf-8'))


def operator():
    spec = importlib.util.spec_from_file_location('audited_legacy_helper', HELPER)
    helper = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = helper
    spec.loader.exec_module(helper)
    release, pilot = helper.operator()
    return helper, release, pilot


def code_fingerprints():
    # Freeze every loaded local operator dependency, not just this wrapper.
    paths = {pathlib.Path(__file__).resolve(), HELPER.resolve()}
    for module in list(sys.modules.values()):
        name = getattr(module, '__file__', None)
        if name:
            path = pathlib.Path(name).resolve()
            if path.is_relative_to(ROOT.parent) and path.suffix == '.py':
                paths.add(path)
    return {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(paths)}


def runtime_fingerprint(release, pilot):
    services = (*release.base.SERVICES, 'norva-media-gateway')
    containers = {name: release.gw.inspect(name) for name in services}
    for name in release.base.SERVICES:
        release.base.lib.edge_health(containers[name])
    value = {
        'containers': {name: [row['Id'], row['Image']] for name, row in containers.items()},
        'edge': {name: release.base.edge.hashes(release.base.lib.edge_root(containers[name]))
                 for name in release.base.SERVICES},
        'gatewaySources': release.base.parent.source_snapshot(),
        'controls': release.base.core.base.r.controls(),
        'crons': release.base.core.base.r.crons(),
        'profileFunctions': pilot.query("""SELECT jsonb_build_object('names',count(DISTINCT p.proname),
          'shaInputMd5',md5(string_agg(pg_get_functiondef(p.oid), E'\n' ORDER BY p.oid)))
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN
          ('observe_catalog_file_profile','guard_catalog_observed_profile_certificate',
           'guard_catalog_validation_observed_profile','norva_fanout_file_tracks_to_users_fenced');"""),
    }
    require(isinstance(value['profileFunctions'], dict) and value['profileFunctions'].get('names') == 4,
            'profile_guards_missing')
    require(pilot.controls(), 'runtime_controls_not_ready')
    return digest(value)


def read_target(pilot, sample):
    require(type(sample) is int and 1 <= sample <= len(TARGETS), 'sample_invalid')
    target = TARGETS[sample - 1]
    lit = pilot.lib.literal
    sql = """SELECT coalesce((SELECT jsonb_build_object(
      'user_id',v.user_id,'source_id',v.source_id,'variant_id',v.id,
      'identity_key',i.identity_id::text,'external_id',v.external_id,
      'title',t.title,'raw_title',v.raw_title,'category',v.metadata->>'categoryName',
      'original_tracks',c.audio_tracks,'original_probed_at',c.audio_probed_at,
      'cache_digest',md5(to_jsonb(c)::text),'variant_digest',md5(to_jsonb(v)::text),
      'verification',c.audio_lang_verification,'whisper_verification',c.audio_whisper_verification,
      'before_audit',c.audio_probed_at<'2026-09-13 00:00:00+00'::timestamptz,
      'identity_verified',i.verified_at IS NOT NULL)
      FROM public.cloud_catalog_visible_title_variants v
      JOIN public.cloud_titles t ON t.id=v.title_id AND t.user_id=v.user_id AND t.item_type=v.item_type
      JOIN public.admin_internal_accounts internal ON internal.user_id=v.user_id
      JOIN public.catalog_source_provider_identities i ON i.source_id=v.source_id AND i.user_id=v.user_id
      JOIN public.catalog_file_tracks c ON c.server_host=i.identity_id::text
        AND c.item_type=v.item_type AND c.external_id=v.external_id
      WHERE v.user_id={user}::uuid AND v.source_id={source}::uuid
        AND v.id={variant}::uuid AND v.item_type='movie' AND v.external_id={external}), 'null'::jsonb);"""
    return pilot.query(sql.format(user=lit(USER_ID), source=lit(SOURCE_ID),
                                  variant=lit(target['variant_id']), external=lit(target['external_id'])))


def eligible(row, value, target, safe_legacy):
    if not isinstance(row, dict) or not safe_legacy(value):
        return False
    if row.get('user_id') != USER_ID or row.get('source_id') != SOURCE_ID:
        return False
    if any(row.get(key) != target[key] for key in ('variant_id', 'external_id', 'title', 'raw_title', 'category')):
        return False
    if not row.get('identity_verified') or row.get('before_audit') is not True:
        return False
    if row.get('verification') not in (None, {}) or row.get('whisper_verification') not in (None, {}):
        return False
    expected = [{'index': 1, 'lang': target['old_language']}]
    return row.get('original_tracks') == expected and value.get('tracks') == expected


def prepare(helper, release, pilot):
    require(not (ROOT / 'plan.private.json').exists(), 'plan_already_exists')
    require(not any(ROOT.glob('*-intent.private.json')), 'prior_intent_protected')
    runtime = runtime_fingerprint(release, pilot)
    entries = []
    for sample, target in enumerate(TARGETS, 1):
        row = read_target(pilot, sample)
        value = pilot.current(row) if row else None
        require(eligible(row, value, target, helper.safe_legacy), 'target_no_longer_eligible')
        entries.append({'sample': sample, 'row': row, 'stateDigest': digest(value)})
    require(runtime_fingerprint(release, pilot) == runtime, 'runtime_changed_during_prepare')
    plan = {'protocol': 1, 'entries': entries, 'preparedAt': time.time(), 'expiresAt': time.time() + 3600,
            'codeFingerprints': code_fingerprints(), 'runtimeFingerprint': runtime}
    write_once('plan.private.json', plan)
    print(json.dumps({'prepared': True, 'files': 2, 'providerRequests': 0,
                      'titles': [t['title'] for t in TARGETS], 'planSha256': digest(plan)}))


def apply(helper, release, pilot, sample, plan_sha256, confirmed):
    require(confirmed is True, 'explicit_header_confirmation_required')
    require(type(sample) is int and 1 <= sample <= len(TARGETS), 'sample_invalid')
    plan = read('plan.private.json')
    require(re.fullmatch('[a-f0-9]{64}', plan_sha256 or '') is not None
            and digest(plan) == plan_sha256, 'plan_fingerprint_mismatch')
    require(time.time() < plan['expiresAt'], 'plan_expired')
    require(code_fingerprints() == plan['codeFingerprints'], 'operator_dependency_changed')
    require(not any(ROOT.glob('*-uncertain.private.json')), 'uncertain_call_protected')
    prefix = f'{sample:02d}'
    require(not (ROOT / (prefix + '-intent.private.json')).exists(), 'prior_intent_protected')
    if sample > 1:
        require(read(f'{sample - 1:02d}-closed.private.json').get('outcome') == 'refreshed', 'prior_sample_not_refreshed')
    require(runtime_fingerprint(release, pilot) == plan['runtimeFingerprint'], 'runtime_changed')
    entry = plan['entries'][sample - 1]
    require(entry['sample'] == sample, 'plan_sample_changed')
    row = read_target(pilot, sample)
    value = pilot.current(row) if row else None
    require(row == entry['row'] and digest(value) == entry['stateDigest'], 'file_evidence_changed')
    require(eligible(row, value, TARGETS[sample - 1], helper.safe_legacy), 'protected_file_state')
    write_once(prefix + '-before.private.json', value)
    write_once(prefix + '-intent.private.json', {'at': time.time(), 'operation': 'ordinary_fresh_header_probe',
                                               'planSha256': plan_sha256, 'sample': sample})
    try:
        result = pilot.header_probe(row)
        write_once(prefix + '-probe.private.json', result)
        after = pilot.current(row)
        write_once(prefix + '-after.private.json', after)
        require(isinstance(after, dict) and not after.get('job'), 'unexpected_file_job')
        refreshed = (result.get('attempted') == 1 and result.get('persisted') == 1
                     and isinstance(after.get('observedFingerprint'), str)
                     and re.fullmatch('[a-f0-9]{64}', after['observedFingerprint']) is not None
                     and bool(after.get('observedAt')) and pilot.profile_ready(after))
        deferred = result.get('attempted') == 0 and result.get('persisted') == 0 and result.get('deferredBeforeIO') is True
        require(refreshed or deferred, 'refresh_not_proven')
        receipt = {'at': time.time(), 'sample': sample, 'outcome': 'refreshed' if refreshed else 'deferred_no_retry',
                   'probe': result, 'boundProfile': bool(after.get('observedFingerprint')),
                   'tracks': after.get('tracks'), 'speechJobsCreated': 0}
        write_once(prefix + '-closed.private.json', receipt)
        print(json.dumps(receipt))
    except Exception:
        write_once(prefix + '-uncertain.private.json', {'at': time.time(), 'code': 'failed_or_uncertain_no_retry'})
        raise RuntimeError('failed_or_uncertain_no_retry') from None


def status(helper, release, pilot):
    result = []
    for sample, target in enumerate(TARGETS, 1):
        row = read_target(pilot, sample)
        value = pilot.current(row) if row else None
        prefix = f'{sample:02d}'
        closed = ROOT / (prefix + '-closed.private.json')
        result.append({'sample': sample, 'title': target['title'], 'present': row is not None,
                       'hasJob': bool((value or {}).get('job')), 'boundProfile': bool((value or {}).get('observedFingerprint')),
                       'intentExists': (ROOT / (prefix + '-intent.private.json')).exists(),
                       'outcome': read(closed.name).get('outcome') if closed.exists() else None,
                       'tracks': (value or {}).get('tracks')})
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('prepare', help='Read-only production checks; create a new local private plan.')
    commands.add_parser('status', help='Read current exact-file state without provider I/O.')
    command = commands.add_parser('apply', help='One guarded header attempt for one exact planned file.')
    command.add_argument('sample', type=int, choices=(1, 2))
    command.add_argument('--plan-sha256', required=True)
    command.add_argument('--confirm-two-file-header-probes', action='store_true', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    require(ROOT.is_dir() and not ROOT.is_symlink() and ROOT.resolve() == ROOT, 'root_missing_or_unsafe')
    require(ROOT.stat().st_mode & 0o077 == 0, 'root_not_private')
    require(not (ROOT / 'operator.lock').is_symlink(), 'lock_path_unsafe')
    with (ROOT / 'operator.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        helper, release, pilot = operator()
        if args.action == 'apply':
            apply(helper, release, pilot, args.sample, args.plan_sha256, args.confirm_two_file_header_probes)
        else:
            globals()[args.action](helper, release, pilot)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'ok': False, 'code': code if re.fullmatch('[a-zA-Z0-9_:.-]{1,120}', code)
                          else 'audited_legacy_refresh_failed'}))
        sys.exit(1)
