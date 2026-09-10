"""Operator-only, three-file maximum pilot; all output is a closed aggregate.

prepare/eligible-counts/status only read the database. prepare writes a private
host plan once. start N explicitly starts one NEW exact file using the existing
tenant-fenced RPC. No resets, replacement files, retiming, flags or quarantines.
An uncertain start is never automatically retried: status can observe its row.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import urllib.request

ROOT = pathlib.Path('/home/adrien/.norva/strict-lid-adaptive-evidence-20260910')
PLAN_PATH = ROOT / 'pilot.private.json'
EXPECTED_GATEWAY_VERSION = 167
MAX_SAMPLES = 3
os.umask(0o077)


def run(args, data=None, timeout=30):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('bounded_operation_failed')
    return result.stdout


def sql(query, readonly=True):
    args = ['docker', 'exec']
    if readonly:
        args += ['-e', 'PGOPTIONS=-c default_transaction_read_only=on']
    args += ['-i', 'norva-db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
    return run(args, query.encode(), timeout=30).decode().strip()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def require_release(expected_hash):
    if not re.fullmatch(r'[a-f0-9]{64}', expected_hash or ''):
        raise RuntimeError('invalid_release_hash')
    live = run(['docker', 'exec', 'norva-media-gateway', 'cat', '/app/src/index.js'])
    if hashlib.sha256(live.replace(b'\r\n', b'\n')).hexdigest() != expected_hash:
        raise RuntimeError('gateway_release_mismatch')
    # Environment is used only for the private local health endpoint, never output.
    container = json.loads(run(['docker', 'inspect', 'norva-media-gateway']))[0]
    env = dict(entry.split('=', 1) for entry in container['Config']['Env'] if '=' in entry)
    ip = container['NetworkSettings']['Networks']['norva_default']['IPAddress']
    with urllib.request.urlopen('http://' + ip + ':' + env.get('PORT', '8080') + '/health', timeout=10) as response:
        health = json.load(response)
    engine = health.get('languageDetectEngine') or {}
    if (health.get('version') != EXPECTED_GATEWAY_VERSION or health.get('ok') is not True
            or engine.get('runtimeVerified') is not True
            or engine.get('speechSamplerRuntimeVerified') is not True
            or engine.get('strictLidSpeechSelectionProtocol') != 1):
        raise RuntimeError('adaptive_runtime_not_ready')


def eligible_cte(extra_variant_predicate=''):
    return """WITH candidates AS MATERIALIZED (
SELECT v.user_id, v.source_id, v.id AS variant_id, i.identity_id::text AS identity_key,
       v.external_id, public.vod_language_profile_snapshot(v.codec_profile) AS profile,
       c.audio_tracks
FROM public.cloud_title_variants v
JOIN public.admin_internal_accounts internal ON internal.user_id=v.user_id
JOIN auth.users account ON account.id=v.user_id AND account.deleted_at IS NULL
 AND (account.banned_until IS NULL OR account.banned_until<=now())
JOIN public.cloud_sources s ON s.id=v.source_id AND s.user_id=v.user_id
 AND s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'
JOIN public.cloud_source_catalog_heads h ON h.source_id=v.source_id AND h.user_id=v.user_id
 AND h.active_generation_id=v.generation_id
JOIN public.catalog_source_provider_identities i ON i.source_id=v.source_id AND i.user_id=v.user_id
JOIN public.catalog_file_tracks c ON c.server_host=i.identity_id::text
 AND c.item_type=v.item_type AND c.external_id=v.external_id
WHERE v.item_type='movie' AND v.codec_profile IS NOT NULL
__EXTRA__
AND NULLIF(btrim(v.codec_profile->>'videoCodec'),'') IS NOT NULL
AND NULLIF(btrim(v.codec_profile->>'audioCodec'),'') IS NOT NULL
AND jsonb_typeof(v.codec_profile->'subtitles')='array'
AND c.audio_probed_at IS NOT NULL AND c.audio_lang_verified_at IS NULL
AND (c.audio_lang_retry_at IS NULL OR c.audio_lang_retry_at<=now())
AND jsonb_array_length(CASE WHEN jsonb_typeof(c.audio_tracks)='array' THEN c.audio_tracks ELSE '[]'::jsonb END)=1
AND public.catalog_audio_track_indexes(c.audio_tracks)=public.vod_language_profile_audio_indices(v.codec_profile)
AND EXISTS(SELECT 1 FROM jsonb_array_elements(
 CASE WHEN jsonb_typeof(c.audio_tracks)='array' THEN c.audio_tracks ELSE '[]'::jsonb END) t
 WHERE coalesce(nullif(lower(btrim(coalesce(t->>'lang',t->>'language'))),''),'und')='und')
AND NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs j
 WHERE j.identity_key=i.identity_id::text AND j.item_type='movie' AND j.external_id=v.external_id)
), eligible AS MATERIALIZED (
SELECT * FROM candidates
WHERE profile->>'probeSource' IN ('gatewayinband','gatewayprobe')
AND (profile->>'probeSource'<>'gatewayinband' OR profile->'metadataComplete'='true'::jsonb)
AND profile->>'container' IN ('mkv','matroska','matroskawebm','mp4','mov','avi','ogg','flv','mpg','ts')
AND (profile->>'durationSeconds')::numeric BETWEEN 80 AND 86400
AND (profile->>'fileSizeBytes')::numeric BETWEEN 1 AND 9007199254740991
AND jsonb_array_length(profile->'audioTracks')=1
AND CASE WHEN pg_input_is_valid(profile->>'probedAt','timestamp with time zone')
 THEN (profile->>'probedAt')::timestamptz BETWEEN now()-interval '48 hours' AND now()+interval '1 minute'
 ELSE false END
) """.replace('__EXTRA__', extra_variant_predicate)


def read_query(query):
    return json.loads(sql("BEGIN READ ONLY; SET LOCAL statement_timeout='20s'; " + query + ' ROLLBACK;'))


def eligible_counts():
    return read_query(eligible_cte() + """SELECT jsonb_build_object(
'eligibleVariantRows',count(*), 'distinctProviders',count(distinct identity_key),
'distinctInternalAccounts',count(distinct user_id),
'distinctExactFiles',count(distinct (identity_key,external_id)),
'freshWithinHours',48,'previouslyUntriedOnly',true,'internalAccountsOnly',true) FROM eligible;""")


def fingerprint(profile):
    # Match the deployed JavaScript key order and numeric serialization exactly.
    program = """const fs=require('fs'),crypto=require('crypto');
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const norm=x=>String(x||'').toLowerCase().replace(/[^a-z0-9.]+/g,'');
const tracks=p.audioTracks.map(t=>({index:Number(t.index),codec:norm(t.codec),
channels:Number.isInteger(t.channels)&&t.channels>=0&&t.channels<=16?t.channels:null,default:t.default===true})).sort((a,b)=>a.index-b.index);
console.log(crypto.createHash('sha256').update(JSON.stringify({protocol:2,metadataComplete:p.metadataComplete===true,
probeSource:norm(p.probeSource),probedAt:p.probedAt,container:norm(p.container),durationSeconds:Number(p.durationSeconds),
fileSizeBytes:Number(p.fileSizeBytes),audioTracks:tracks})).digest('hex'));"""
    value = run(['docker', 'exec', '-i', 'norva-media-gateway', 'node', '-e', program],
                json.dumps(profile).encode(), timeout=10).decode().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', value):
        raise RuntimeError('profile_fingerprint_failed')
    return value


def validate_plan(plan):
    if not isinstance(plan, dict):
        raise RuntimeError('private_plan_invalid')
    rows = plan.get('rows') if isinstance(plan, dict) else None
    if (plan.get('protocol') != 1 or plan.get('expectedGatewayVersion') != EXPECTED_GATEWAY_VERSION
            or not isinstance(rows, list) or not 1 <= len(rows) <= MAX_SAMPLES
            or not all(isinstance(row, dict) for row in rows)
            or [row.get('sample') for row in rows] != list(range(1, len(rows)+1))
            or len({row['identity_key'] for row in rows}) != len(rows)
            or not re.fullmatch(r'[a-f0-9]{64}', plan.get('expectedIndexSha256') or '')):
        raise RuntimeError('private_plan_invalid')
    return rows


@contextlib.contextmanager
def locked_plan():
    # A single private journal prevents two explicit operator invocations from
    # racing the same sample or losing one another's durable start intentions.
    with PLAN_PATH.open('r+', encoding='utf8') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        plan = json.load(handle)
        validate_plan(plan)
        def save():
            handle.seek(0)
            json.dump(plan, handle)
            handle.truncate()
            handle.flush()
            os.fsync(handle.fileno())
        try:
            yield plan, save
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def prepare(expected_hash):
    require_release(expected_hash)
    if PLAN_PATH.exists():
        raise RuntimeError('private_plan_already_exists')
    rows = read_query(eligible_cte() + """, ranked AS (
SELECT *, row_number() OVER(PARTITION BY identity_key ORDER BY profile->>'probedAt' DESC,variant_id) AS preference
FROM eligible), chosen AS (
SELECT user_id,source_id,variant_id,identity_key,external_id,profile,audio_tracks
FROM ranked WHERE preference=1 ORDER BY profile->>'probedAt' DESC,identity_key LIMIT 3)
SELECT coalesce(jsonb_agg(to_jsonb(chosen)),'[]'::jsonb) FROM chosen;""")
    if not 1 <= len(rows) <= MAX_SAMPLES:
        raise RuntimeError('no_new_internal_sample_available')
    for ordinal, row in enumerate(rows, 1):
        row['sample'] = ordinal
        row['fingerprint'] = fingerprint(row['profile'])
    plan = {'protocol': 1, 'preparedAt': utc_now(), 'expectedIndexSha256': expected_hash,
            'expectedGatewayVersion': EXPECTED_GATEWAY_VERSION, 'rows': rows}
    validate_plan(plan)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with PLAN_PATH.open('x', encoding='utf8') as handle:
        json.dump(plan, handle)
        handle.flush()
        os.fsync(handle.fileno())
    return {'prepared': len(rows), 'distinctProviders': len(rows), 'internalAccountsOnly': True,
            'previouslyUntriedOnly': True, 'maxSamples': MAX_SAMPLES, 'databaseChanged': False}


def start(sample, expected_hash):
    require_release(expected_hash)
    with locked_plan() as (plan, save):
        if plan['expectedIndexSha256'] != expected_hash:
            raise RuntimeError('private_plan_release_mismatch')
        row = next((value for value in plan['rows'] if value['sample'] == sample), None)
        if row is None or row.get('startRequestedAt') or row.get('job'):
            raise RuntimeError('sample_start_not_available')
        profile = row['profile']
        indices = [int(track['index']) for track in profile['audioTracks']]
        if len(indices) != 1 or fingerprint(profile) != row['fingerprint']:
            raise RuntimeError('private_profile_invalid')
        predicate = 'AND v.id=' + literal(row['variant_id']) + '::uuid'
        guard = """DO $guard$ BEGIN
PERFORM pg_advisory_xact_lock(hashtextextended(%s,0));
PERFORM pg_advisory_xact_lock(hashtextextended(%s,0));
IF NOT EXISTS(%s SELECT 1 FROM eligible WHERE user_id=%s::uuid AND source_id=%s::uuid
 AND identity_key=%s AND external_id=%s AND profile=%s::jsonb AND audio_tracks=%s::jsonb)
THEN RAISE EXCEPTION 'New internal sample guard declined'; END IF;
END $guard$;""" % (
            literal('catalog-file-audio-validation-user:' + row['user_id']),
            literal('catalog-file-audio-validation:' + row['identity_key'] + ':movie:' + row['external_id']),
            eligible_cte(predicate), literal(row['user_id']), literal(row['source_id']),
            literal(row['identity_key']), literal(row['external_id']),
            literal(json.dumps(profile)), literal(json.dumps(row['audio_tracks'])))
        args = [literal(row['user_id'])+'::uuid', literal(row['source_id'])+'::uuid',
                literal(row['variant_id'])+'::uuid', literal(row['identity_key']), "'movie'", literal(row['external_id']),
                'ARRAY['+','.join(map(str, indices))+']::integer[]', literal(json.dumps(profile))+'::jsonb',
                literal(row['fingerprint']), literal(profile['probedAt'])+'::timestamptz',
                str(int(profile['fileSizeBytes']))+'::bigint', literal(json.dumps(row['audio_tracks']))+'::jsonb', 'false']
        # Persist intention before the transaction. An interrupted response cannot
        # lead an automatic retry to enqueue a second operation for the same file.
        row['startRequestedAt'] = utc_now()
        save()
        result = json.loads(sql("BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'; "
            + guard + ' SET LOCAL ROLE service_role; SELECT public.start_automatic_catalog_file_audio_validation_job('
            + ','.join(args) + '); COMMIT;', readonly=False))
        job = result.get('jobId')
        if not isinstance(job, str) or not re.fullmatch(r'[a-f0-9-]{36}', job):
            return {'sample': sample, 'enqueued': False, 'normalGateDeclined': True, 'automaticRetry': False}
        row['job'] = job
        save()
        return {'sample': sample, 'enqueued': True, 'normalWorker': True,
                'oldJobsUntouched': True, 'quarantinesTouched': False}


def status():
    with locked_plan() as (plan, _save):
        rows = plan['rows']
        output = []
        for row in rows:
            predicate = 'j.id=' + literal(row['job']) + '::uuid' if row.get('job') else (
                'j.identity_key=' + literal(row['identity_key']) + " AND j.item_type='movie' AND j.external_id="
                + literal(row['external_id']) + ' AND j.requested_by=' + literal(row['user_id']) + '::uuid'
                + ' AND j.profile_fingerprint=' + literal(row['fingerprint'])
                + ' AND j.created_at>=' + literal(plan['preparedAt']) + '::timestamptz')
            value = read_query("""SELECT coalesce((SELECT jsonb_build_object(
'state',j.state,'attempts',j.provider_attempt_count,
'errorCode',CASE WHEN j.error_code IS NULL THEN NULL
 WHEN j.error_code ~ '^[A-Z0-9_]{1,80}$' THEN j.error_code ELSE 'OTHER' END,
'retryAt',j.retry_at,'updatedAt',j.updated_at,
'noProgress',j.consecutive_provider_no_progress_count,'window',j.strict_lid_window_position,
'windows',j.strict_lid_window_count,'tracksDone',j.next_track_position,
'verified',j.verified_at IS NOT NULL,'quarantined',j.quarantined_at IS NOT NULL,
'cacheVerified',c.audio_lang_verified_at IS NOT NULL,
'cacheAudioTrackCount',jsonb_array_length(CASE WHEN jsonb_typeof(c.audio_tracks)='array' THEN c.audio_tracks ELSE '[]'::jsonb END))
FROM public.catalog_file_audio_validation_jobs j
LEFT JOIN public.catalog_file_tracks c ON c.server_host=j.identity_key AND c.item_type=j.item_type AND c.external_id=j.external_id
WHERE """ + predicate + " ORDER BY j.created_at DESC LIMIT 1),'{}'::jsonb);")
            if not value:
                value = {'state': 'start_unresolved' if row.get('startRequestedAt') else 'not_started'}
            elif not row.get('job'):
                value['observedAfterStartWithoutJournalReceipt'] = True
            output.append({'sample': row['sample'], **value})
        return {'samples': output, 'planned': len(rows), 'distinctProviders': len(rows),
                'verified': sum(value.get('verified') is True for value in output),
                'cacheVerified': sum(value.get('cacheVerified') is True for value in output),
                'quarantined': sum(value.get('quarantined') is True for value in output),
                'databaseChanged': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    phases = parser.add_subparsers(dest='phase', required=True)
    phases.add_parser('eligible-counts')
    phases.add_parser('status')
    phases.add_parser('prepare').add_argument('--expected-index-sha256', required=True)
    start_parser = phases.add_parser('start')
    start_parser.add_argument('sample', type=int, choices=range(1, MAX_SAMPLES+1))
    start_parser.add_argument('--expected-index-sha256', required=True)
    args = parser.parse_args()
    if args.phase == 'prepare':
        result = prepare(args.expected_index_sha256)
    elif args.phase == 'start':
        result = start(args.sample, args.expected_index_sha256)
    elif args.phase == 'status':
        result = status()
    else:
        result = eligible_counts()
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never print PSQL context, command input, profile data, paths or env.
        print(json.dumps({'ok': False, 'error': 'adaptive_pilot_operation_failed'}))
        raise SystemExit(1)
