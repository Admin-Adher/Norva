"""One authorized, immutable 100-file pilot, including unprobed unknown VOD.

Provider traffic uses the existing exact codec-profile-backfill endpoint, once
per file at most. Untagged tracks then use the ordinary strict production job
and its existing worker, quotas, idle gates and quarantine. Never guess a language,
change flags/thresholds, reset old jobs, or replace unsuccessful sample files.
Plans/receipts stay private on this host. Public output is aggregate only.
"""
import argparse
import base64
import contextlib
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/unknown-vod-pilot-20260911')
MAX_FILES = 100
MAX_SECONDS = 96 * 3600
UNKNOWN = {'', 'und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown'}
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
spec = importlib.util.spec_from_file_location('pilot_helpers',
    pathlib.Path(__file__).with_name('check-strict-lid-adaptive-evidence-batch-20260910.py'))
lib = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lib)


class ProbeFailure(Exception):
    def __init__(self, code, status=None):
        self.code, self.status = code, status
        super().__init__(code)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def require(value):
    if not value:
        raise RuntimeError('pilot_guard_declined')


def query(value):
    return lib.read_query(value)


def save(path, value, exclusive=False):
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if exclusive:
        with path.open('x', encoding='utf8') as f:
            json.dump(value, f); f.flush(); os.fsync(f.fileno())
        return
    temporary = path.with_suffix('.next')
    with temporary.open('w', encoding='utf8') as f:
        json.dump(value, f); f.flush(); os.fsync(f.fileno())
    os.replace(temporary, path)


def private(path):
    require(path.is_file() and not path.is_symlink())
    return json.loads(path.read_text(encoding='utf8'))


@contextlib.contextmanager
def lock(wait=False):
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT / 'operator.lock').open('a') as f:
        fcntl.flock(f, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def validate(plan):
    rows = plan.get('rows', [])
    require(plan.get('protocol') == 1 and 1 <= len(rows) <= MAX_FILES)
    require(re.fullmatch('[a-f0-9]{64}', plan.get('gatewaySha256', '')) is not None)
    require([r.get('sample') for r in rows] == list(range(1, len(rows)+1)))
    require(len({(r['identity_key'], r['external_id']) for r in rows}) == len(rows))
    for r in rows:
        require(all(UUID.fullmatch(r[k]) for k in ('user_id', 'source_id', 'variant_id', 'identity_key')))
        require(isinstance(r['external_id'], str) and 0 < len(r['external_id']) <= 200)
    require(0 < plan['expiresEpoch'] - plan['preparedEpoch'] <= MAX_SECONDS)
    return rows


def candidate_sql():
    # The SQL pool includes absent/empty profiles and missing exact cache rows.
    # The active client/server provider-label parser is applied next, so recognized
    # provider indications are not counted as UI-unknown examples.
    return """WITH candidates AS MATERIALIZED (
SELECT v.user_id,v.source_id,v.id variant_id,i.identity_id::text identity_key,v.external_id,
 v.raw_title,v.metadata->>'categoryName' category_name,v.updated_at,
 (c.audio_probed_at IS NOT NULL AND jsonb_array_length(CASE WHEN jsonb_typeof(c.audio_tracks)='array'
 THEN c.audio_tracks ELSE '[]'::jsonb END)>0) has_track_map,
 (v.raw_title ILIKE '%Khorshide%Nime%Shab%') requested_example
FROM public.cloud_title_variants v
JOIN public.admin_internal_accounts internal ON internal.user_id=v.user_id
JOIN auth.users a ON a.id=v.user_id AND a.deleted_at IS NULL AND (a.banned_until IS NULL OR a.banned_until<=now())
JOIN public.cloud_sources s ON s.id=v.source_id AND s.user_id=v.user_id
 AND s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'
JOIN public.cloud_source_catalog_heads h ON h.source_id=v.source_id AND h.user_id=v.user_id
 AND h.active_generation_id=v.generation_id
JOIN public.cloud_titles t ON t.id=v.title_id AND t.user_id=v.user_id
JOIN public.catalog_source_provider_identities i ON i.source_id=v.source_id AND i.user_id=v.user_id
LEFT JOIN public.catalog_file_tracks c ON c.server_host=i.identity_id::text AND c.item_type='movie' AND c.external_id=v.external_id
WHERE v.item_type='movie' AND coalesce(cardinality(t.audio_languages),0)=0
 AND v.audio_lang_verified_at IS NULL AND c.audio_lang_verified_at IS NULL
 AND (c.audio_lang_retry_at IS NULL OR c.audio_lang_retry_at<=now())
 AND NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs j
 WHERE j.identity_key=i.identity_id::text AND j.item_type='movie' AND j.external_id=v.external_id)
), ranked AS (
 SELECT *,row_number() OVER(PARTITION BY identity_key ORDER BY requested_example DESC,updated_at DESC,variant_id) preference
 FROM candidates), pool AS (SELECT * FROM ranked WHERE preference<=400 ORDER BY preference,identity_key LIMIT 4000)
 SELECT coalesce(jsonb_agg(to_jsonb(pool)),'[]'::jsonb) FROM pool;"""


def filter_provider_labels(rows):
    parser = pathlib.Path(__file__).with_name('provider-catalog-language.mjs').read_bytes()
    code = "const fs=require('fs');(async()=>{const m=await import('data:text/javascript;base64,'+process.argv[1]);const rows=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(rows.filter(r=>m.providerCatalogLanguage(r)===null)));})();"
    return json.loads(lib.run(['docker', 'exec', '-i', 'norva-media-gateway', 'node', '-e', code,
        base64.b64encode(parser).decode()], json.dumps(rows).encode(), timeout=15))


def choose(rows, limit=MAX_FILES):
    require(1 <= limit <= MAX_FILES)
    # Provider round robin, then account usage: include the explicit example and
    # preserve provider variety without selecting the same physical file twice.
    chosen, seen, provider_counts, user_counts = [], set(), {}, {}
    pool = list(rows)
    while pool and len(chosen) < limit:
        pool.sort(key=lambda r: (not r['requested_example'], provider_counts.get(r['identity_key'], 0),
            user_counts.get(r['user_id'], 0), r.get('preference', 0), r['variant_id']))
        row = pool.pop(0)
        key = (row['identity_key'], row['external_id'])
        if key in seen:
            continue
        seen.add(key); chosen.append(row)
        provider_counts[row['identity_key']] = provider_counts.get(row['identity_key'], 0)+1
        user_counts[row['user_id']] = user_counts.get(row['user_id'], 0)+1
    return chosen


def prepare(expected):
    lib.require_release(expected)
    with lock():
        require(not (ROOT / 'plan.private.json').exists())
        rows = choose(filter_provider_labels(query(candidate_sql())))
        require(len(rows) == MAX_FILES and any(r['requested_example'] for r in rows))
        for n, row in enumerate(rows, 1):
            row['sample'] = n
        prepared = time.time()
        plan = {'protocol': 1, 'preparedAt': now(), 'preparedEpoch': prepared,
            'expiresEpoch': prepared+MAX_SECONDS, 'gatewaySha256': expected, 'rows': rows}
        validate(plan)
        save(ROOT / 'plan.private.json', plan, True)
        save(ROOT / 'state.private.json', {'planSha256': hashlib.sha256((ROOT/'plan.private.json').read_bytes()).hexdigest(),
            'rows': {str(r['sample']): {'state': 'planned', 'probeAttempts': 0} for r in rows}, 'updatedAt': now()}, True)
    return summary(plan, private(ROOT / 'state.private.json'))


def current(row):
    p = {k: lib.literal(row[k]) for k in ('user_id', 'source_id', 'variant_id', 'identity_key', 'external_id')}
    return query("""SELECT coalesce((SELECT jsonb_build_object('profile',public.vod_language_profile_snapshot(v.codec_profile),
 'tracks',c.audio_tracks,'audioProbed',c.audio_probed_at IS NOT NULL,'verified',c.audio_lang_verified_at IS NOT NULL,
 'retryAt',c.audio_lang_retry_at,'observedFingerprint',c.observed_profile_fingerprint,
 'probeCircuitRetryAt',(SELECT open_until FROM public.provider_probe_circuit
 WHERE identity_key={identity_key} AND open_until>now()),
 'observedAt',c.observed_profile_probed_at,'observedProfile',c.observed_profile_snapshot,
 'job', (SELECT jsonb_build_object('id',j.id,'state',j.state,'createdAt',j.created_at,'errorCode',j.error_code,
 'owned',j.requested_by=v.user_id AND j.source_id=v.source_id AND j.variant_id=v.id,
 'window',j.strict_lid_window_position,'windows',j.strict_lid_window_count,'verified',j.verified_at IS NOT NULL,
 'quarantined',j.quarantined_at IS NOT NULL,'providerAttempts',j.provider_attempt_count)
 FROM public.catalog_file_audio_validation_jobs j WHERE j.identity_key={identity_key} AND j.item_type='movie'
 AND j.external_id={external_id} ORDER BY created_at DESC LIMIT 1),
 'activeJobs',(SELECT count(*) FROM public.catalog_file_audio_validation_jobs j WHERE j.requested_by={user_id}::uuid
 AND j.state IN ('queued','running','retry_wait','finalizing')),
 'starts24h',(SELECT count(*) FROM public.catalog_file_audio_validation_jobs j WHERE j.requested_by={user_id}::uuid
 AND j.created_at>now()-interval '24 hours'))
FROM public.cloud_title_variants v
JOIN public.admin_internal_accounts internal ON internal.user_id=v.user_id
JOIN auth.users a ON a.id=v.user_id AND a.deleted_at IS NULL AND (a.banned_until IS NULL OR a.banned_until<=now())
JOIN public.cloud_sources s ON s.id=v.source_id AND s.user_id=v.user_id AND s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'
JOIN public.cloud_source_catalog_heads h ON h.source_id=v.source_id AND h.user_id=v.user_id AND h.active_generation_id=v.generation_id
JOIN public.catalog_source_provider_identities i ON i.source_id=v.source_id AND i.user_id=v.user_id AND i.identity_id::text={identity_key}
LEFT JOIN public.catalog_file_tracks c ON c.server_host={identity_key} AND c.item_type='movie' AND c.external_id={external_id}
WHERE v.id={variant_id}::uuid AND v.user_id={user_id}::uuid AND v.source_id={source_id}::uuid
 AND v.item_type='movie' AND v.external_id={external_id}),'null'::jsonb);""".format(**p))


def track_unknown(track):
    return str(track.get('lang') or track.get('language') or '').strip().lower() in UNKNOWN


def profile_ready(value):
    p, tracks = value.get('profile') or {}, value.get('tracks') or []
    audio = p.get('audioTracks') or []
    if not value.get('audioProbed') or not isinstance(tracks, list) or not 1 <= len(tracks) <= 4:
        return False
    if not isinstance(audio, list) or len(audio) != len(tracks):
        return False
    if p.get('probeSource') not in ('gatewayprobe', 'gatewayinband') or not p.get('probedAt'):
        return False
    if p['probeSource'] == 'gatewayinband' and p.get('metadataComplete') is not True:
        return False
    if p.get('container') not in {'mkv','matroska','matroskawebm','webm','mp4','mov',
            'movmp4m4a3gp3g2mj2','avi','ogg','flv','mpg','mpeg','ts','mpegts'}:
        return False
    try:
        observed = (value.get('observedFingerprint'), value.get('observedAt'), value.get('observedProfile'))
        if any(v is not None for v in observed):
            if (observed[0] != lib.fingerprint(p) or not observed[1] or not isinstance(observed[2],dict)
                    or observed[2].get('fileSizeBytes') != p['fileSizeBytes']
                    or datetime.datetime.fromisoformat(observed[1].replace('Z','+00:00'))
                    != datetime.datetime.fromisoformat(p['probedAt'].replace('Z','+00:00'))):
                return False
        return (80 <= float(p['durationSeconds']) <= 86400 and 0 < int(p['fileSizeBytes']) <= 9007199254740991
            and sorted(t['index'] for t in tracks) == sorted(t['index'] for t in audio)
            and len(set(t['index'] for t in audio)) == len(audio))
    except (KeyError, TypeError, ValueError):
        return False


def header_probe(row):
    # The credential never leaves this private process except in the authorized
    # API header. Never log environment, request data, response text, URLs or IDs.
    container = json.loads(lib.run(['docker', 'inspect', 'norva-edge-functions']))[0]
    env = dict(s.split('=', 1) for s in container['Config']['Env'] if '=' in s)
    token = env.get('NORVA_BACKFILL_TOKEN')
    require(isinstance(token, str) and bool(token))
    request = urllib.request.Request('https://api.norva.tv/functions/v1/norva-playback/codec-profile-backfill',
        data=json.dumps({'userId': row['user_id'], 'variantIds': [row['variant_id']]}).encode(),
        headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read(65537)
            require(len(raw) <= 65536)
            value = json.loads(raw)
    except urllib.error.HTTPError as error:
        # Read no provider payload into logs. Keep only a bounded application
        # error identifier and HTTP status, when the API supplies one.
        try:
            body=json.loads(error.read(65536))
            code=body.get('code') or (body.get('details') or {}).get('code')
        except Exception:
            code=None
        if not isinstance(code,str) or not re.fullmatch('[a-zA-Z][a-zA-Z0-9_-]{1,79}',code):
            code='profile_backfill_http_error'
        raise ProbeFailure(code,error.code) from None
    except (TimeoutError,urllib.error.URLError):
        raise ProbeFailure('profile_backfill_transport_uncertain') from None
    require(value.get('protocol') == 1 and value.get('requested') == 1)
    require(value.get('attempted') in (0, 1) and value.get('persisted') in (0, 1))
    reason=value.get('skipped') or value.get('stopped')
    if not isinstance(reason,str) or not re.fullmatch('[a-zA-Z][a-zA-Z0-9_-]{1,79}',reason):
        reason=None
    return {'attempted': value['attempted'], 'persisted': value['persisted'], 'reason':reason,
        'deferredBeforeIO': value['attempted'] == 0 and bool(value.get('skipped') or value.get('stopped'))}


def enqueue(row, value):
    profile = value['profile']
    fp = lib.fingerprint(profile)
    p = {k: lib.literal(row[k]) for k in ('user_id','source_id','variant_id','identity_key','external_id')}
    # Independent source/owner/file revalidation and ordinary tenant limits in
    # the existing RPC. Serialize with the same locks as all other callers.
    guard = """DO $g$ BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended('catalog-file-audio-validation-user:'||{user_id},0));
PERFORM pg_advisory_xact_lock(hashtextextended('catalog-file-audio-validation:'||{identity_key}||':movie:'||{external_id},0));
IF EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs WHERE identity_key={identity_key}
 AND item_type='movie' AND external_id={external_id}) THEN RAISE EXCEPTION 'existing job protected'; END IF;
END $g$;""".format(**p)
    args = [p['user_id']+'::uuid',p['source_id']+'::uuid',p['variant_id']+'::uuid',p['identity_key'],"'movie'",p['external_id'],
        'ARRAY['+','.join(str(int(t['index'])) for t in sorted(profile['audioTracks'],key=lambda t:t['index']))+']::integer[]',
        lib.literal(json.dumps(profile))+'::jsonb',lib.literal(fp),lib.literal(profile['probedAt'])+'::timestamptz',
        str(int(profile['fileSizeBytes']))+'::bigint',lib.literal(json.dumps(value['tracks']))+'::jsonb','false']
    return json.loads(lib.sql("BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'; "+guard
        +' SET LOCAL ROLE service_role; SELECT public.start_automatic_catalog_file_audio_validation_job('
        +','.join(args)+'); COMMIT;', readonly=False))


def controls():
    value = query("""SELECT jsonb_build_object('runtime',public.strict_lid_runtime_health(),
        'paused',coalesce((SELECT enabled FROM public.admin_feature_flags WHERE key='enrichment_paused'),true));""")
    runtime = value.get('runtime') or {}
    return (value.get('paused') is False and runtime.get('audioEnabled') is True
        and runtime.get('legacyEnabled') is False and runtime.get('workerHealthy') is True)


def summary(plan, state):
    counts = {}
    for value in state['rows'].values():
        key = value['state']; counts[key] = counts.get(key, 0)+1
    reasons={}
    for value in state['rows'].values():
        reason=value.get('errorCode') or value.get('deferredReason')
        if reason:reasons[reason]=reasons.get(reason,0)+1
    return {'planned': len(plan['rows']), 'providers': len({r['identity_key'] for r in plan['rows']}),
        'initiallyWithoutTracks': sum(not r['has_track_map'] for r in plan['rows']),
        'requestedExampleIncluded': any(r['requested_example'] for r in plan['rows']),
        'states': counts, 'consumedFileProbeSlots': sum(v.get('probeAttempts',0) for v in state['rows'].values()),
        'diagnosticReasons':reasons,
        'updatedAt': state['updatedAt'], 'accuracy': None,
        'stoppedReason':state.get('stoppedReason'),
        'thresholdsChanged': False, 'oldJobsReset': False}


def step(plan, state):
    require(hashlib.sha256((ROOT/'plan.private.json').read_bytes()).hexdigest() == state['planSha256'])
    rows = validate(plan)
    require(time.time() < plan['expiresEpoch'])
    lib.require_release(plan['gatewaySha256'])
    if not controls():
        return False
    failed=sum(v['state']=='probe_failed_or_uncertain' for v in state['rows'].values())
    succeeded=sum(v.get('probeSucceeded') is True for v in state['rows'].values())
    if failed>=3 and succeeded==0:
        state['stoppedReason']='initial_header_probes_failed'
        state['updatedAt']=now();save(ROOT/'state.private.json',state)
        return False
    persist = lambda: save(ROOT/'state.private.json', state)
    # One new exact file operation per tick. Existing jobs continue under the
    # normal worker, not a parallel test runner with independent provider access.
    for row in rows:
        receipt = state['rows'][str(row['sample'])]
        if receipt['state'] == 'probe_insufficient' and receipt.get('probeSucceeded') is True:
            # Reconcile a successful persisted inventory after a validator fix.
            # This may admit the already captured MP4 family, but never repeat
            # provider I/O, retry a failed request, or reset a validation job.
            existing = current(row)
            if not existing or not profile_ready(existing):
                continue
            receipt['state'] = 'probed'
            receipt['reconciledPersistedProfileAt'] = now()
        if receipt['state'] not in ('planned','probed','validating','start_intent','probe_intent'):
            continue
        if receipt.get('nextEligibleEpoch',0) > time.time():
            continue
        if state.get('userCooldowns',{}).get(row['user_id'],0) > time.time():
            continue
        if state.get('providerCooldowns',{}).get(row['identity_key'],0) > time.time():
            continue
        value = current(row)
        if not value:
            receipt['state'] = 'source_changed'; continue
        job = value.get('job')
        if job:
            if not receipt.get('startIntentAt') or not job.get('owned'):
                receipt['state'] = 'external_job_protected'; continue
            receipt['jobState'] = job['state']
            receipt['windowsDone'] = job.get('window')
            receipt['providerAttempts'] = job.get('providerAttempts')
            receipt['state'] = ('verified' if value.get('verified') and job.get('verified') else
                'quarantined' if job.get('quarantined') else
                'validation_failed' if job['state'] in ('failed','expired','cancelled') else 'validating')
            continue
        if receipt['state'] in ('start_intent','probe_intent'):
            # A lost response is not authorization to repeat provider traffic.
            receipt['state'] = 'uncertain_requires_review'; continue
        if value.get('verified'):
            receipt['state'] = 'already_verified'; continue
        if value.get('probeCircuitRetryAt'):
            retry_epoch=datetime.datetime.fromisoformat(value['probeCircuitRetryAt'].replace('Z','+00:00')).timestamp()
            if retry_epoch > time.time():
                state.setdefault('providerCooldowns',{})[row['identity_key']]=retry_epoch
                receipt['deferredReason']='provider-probe-circuit-open'
                continue
        if value.get('retryAt'):
            retry_epoch=datetime.datetime.fromisoformat(value['retryAt'].replace('Z','+00:00')).timestamp()
            if retry_epoch > time.time():
                receipt['nextEligibleEpoch']=retry_epoch;continue
        # Capture a fresh exact inventory for the pilot's UI-unknown files,
        # including rows whose old cache and displayed projection disagree.
        # One successful refresh also hydrates the existing shared projections.
        if receipt.get('probeAttempts',0) == 0 or not profile_ready(value):
            if receipt.get('probeAttempts',0) >= 1:
                receipt['state'] = 'probe_insufficient'; continue
            receipt.update(state='probe_intent',probeAttempts=1,probeIntentAt=now())
            state['updatedAt']=now(); persist()
            try:
                result = header_probe(row)
                if result['deferredBeforeIO']:
                    receipt.update(state='planned',probeAttempts=0,nextEligibleEpoch=time.time()+180)
                    receipt['deferredReason']=result.get('reason') or 'deferred_before_io'
                    if result.get('reason') in ('live-session','pregen-active'):
                        state.setdefault('userCooldowns',{})[row['user_id']]=time.time()+180
                elif result['persisted'] == 1:
                    receipt['state'] = 'probed'
                    receipt['probeSucceeded'] = True
                    receipt.pop('deferredReason',None)
                else:
                    receipt['state'] = 'probe_insufficient'
            except ProbeFailure as error:
                receipt.update(state='probe_failed_or_uncertain',errorCode=error.code,httpStatus=error.status)
            except Exception:
                receipt['state'] = 'probe_failed_or_uncertain'
                receipt['errorCode'] = 'profile_backfill_local_or_contract_error'
            state['updatedAt']=now(); persist()
            return True
        tracks = value['tracks']
        if not any(track_unknown(t) for t in tracks):
            receipt['state'] = 'identified_from_tracks'; continue
        if value.get('activeJobs',2) >= 2 or value.get('starts24h',20) >= 20:
            receipt['waitingForQuota'] = True; continue
        receipt.pop('waitingForQuota', None)
        receipt.update(state='start_intent',startIntentAt=now())
        state['updatedAt']=now(); persist()
        try:
            result = enqueue(row,value)
            if isinstance(result.get('jobId'),str) and UUID.fullmatch(result['jobId']):
                receipt['state']='validating'
            elif result.get('limited') or result.get('busy'):
                receipt['state']='probed'
                receipt.pop('startIntentAt',None)
            else:
                receipt['state']='start_declined'
        except Exception:
            # Reconcile on the next read, never automatically repeat this start.
            receipt['state']='start_intent'
        state['updatedAt']=now(); persist()
        return True
    state['updatedAt']=now(); persist()
    return False


def operate(once=False):
    # The child may start before launch() has durably saved its PID and released
    # the parent lock. Wait for that handoff; never race it and exit silently.
    with lock(wait=not once):
        plan = private(ROOT/'plan.private.json'); validate(plan)
        state = private(ROOT/'state.private.json')
        while time.time() < plan['expiresEpoch']:
            step(plan,state)
            print(json.dumps(summary(plan,state)),flush=True)
            if once or state.get('stoppedReason') or not any(v['state'] in ('planned','probed','validating','start_intent','probe_intent') for v in state['rows'].values()):
                return
            time.sleep(60)


def launch():
    with lock():
        require(not (ROOT/'launch.private.json').exists())
        plan=private(ROOT/'plan.private.json'); validate(plan)
        save(ROOT/'launch.private.json',{'requestedAt':now()},True)
        with (ROOT/'runner.log').open('x') as output:
            process=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).resolve()),'run'],
                stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.DEVNULL,start_new_session=True)
        save(ROOT/'process.private.json',{'pid':process.pid,'startedAt':now()},True)
    return {'launched':True,'pid':process.pid,'maxFiles':MAX_FILES,'maxRuntimeHours':96}


if __name__ == '__main__':
    os.umask(0o077)
    try:
        parser=argparse.ArgumentParser(description=__doc__)
        parser.add_argument('phase',choices=('prepare','once','launch','run','status'))
        parser.add_argument('--expected-index-sha256')
        args=parser.parse_args()
        if args.phase=='prepare':
            result=prepare(args.expected_index_sha256)
        elif args.phase in ('once','run'):
            operate(args.phase=='once'); sys.exit(0)
        elif args.phase=='launch':
            result=launch()
        else:
            plan=private(ROOT/'plan.private.json');validate(plan)
            result=summary(plan,private(ROOT/'state.private.json'))
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'ok':False,'error':'bounded_pilot_operation_failed'}))
        sys.exit(1)
