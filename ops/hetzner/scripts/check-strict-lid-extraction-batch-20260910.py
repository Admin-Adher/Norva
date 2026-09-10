"""Operator-only bounded sample, at most three internal-account provider identities.

prepare is read-only. start N enqueues ONE previously untried exact file through
the existing tenant-fenced RPC; the normal worker retains leases, quotas,
entitlements, viewer priority, retries and quarantine. No flags, old jobs or
verified languages are rewritten. Private plan stays on the Docker host.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

os.umask(0o077)
root = pathlib.Path('/home/adrien/.norva/strict-lid-extraction-20260910')
plan_path = root / 'batch-v2.private.json'

def sql(query, readonly=True):
    args = ['docker', 'exec']
    if readonly: args += ['-e', 'PGOPTIONS=-c default_transaction_read_only=on']
    args += ['-i', 'norva-db', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
    p = subprocess.run(args, input=query.encode(), capture_output=True, timeout=30)
    if p.returncode:
        # PSQL context may contain data values: return no raw diagnostic body.
        raise RuntimeError('bounded_database_operation_failed')
    return p.stdout.decode().strip()

def literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def fingerprint(profile):
    # Match the deployed JS fingerprint's key order and numeric serialization.
    program = """const fs=require('fs'),crypto=require('crypto');
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const norm=x=>String(x||'').toLowerCase().replace(/[^a-z0-9.]+/g,'');
const tracks=p.audioTracks.map(t=>({index:Number(t.index),codec:norm(t.codec),
channels:Number.isInteger(t.channels)&&t.channels>=0&&t.channels<=16?t.channels:null,default:t.default===true})).sort((a,b)=>a.index-b.index);
console.log(crypto.createHash('sha256').update(JSON.stringify({protocol:2,metadataComplete:p.metadataComplete===true,
probeSource:norm(p.probeSource),probedAt:p.probedAt,container:norm(p.container),durationSeconds:Number(p.durationSeconds),
fileSizeBytes:Number(p.fileSizeBytes),audioTracks:tracks})).digest('hex'));"""
    p = subprocess.run(['docker', 'exec', '-i', 'norva-media-gateway', 'node', '-e', program],
                       input=json.dumps(profile).encode(), capture_output=True, timeout=10)
    assert p.returncode == 0, 'Fingerprint failed'
    return p.stdout.decode().strip()

phase = sys.argv[1]
if phase in ['prepare', 'prepare-replacement']:
    replacement = phase == 'prepare-replacement'
    previous = json.loads(plan_path.read_text()) if replacement else []
    if replacement:
        assert len(previous) == 3 and all(r.get('job') for r in previous), 'Only one new replacement is allowed'
        first = next(r for r in previous if r['sample'] == 1)
        # Never revive or reset the quarantined diagnostic sample. Select one
        # previously untried file of the SAME provider after the pinning fix.
        assert sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT count(*) FROM public.catalog_file_audio_validation_jobs WHERE id="
                   + literal(first['job']) + "::uuid AND state='failed' AND quarantined_at IS NOT NULL; ROLLBACK;") == '1'
        live = subprocess.check_output(['docker', 'exec', 'norva-media-gateway', 'cat', '/app/src/index.js'])
        assert hashlib.sha256(live.replace(b'\r\n', b'\n')).hexdigest() == 'ef0f9652b91adfecddfc070ab04731e021adeb407342a8f22a7e37ef56a055f5', 'Reviewed signed-target fix not deployed'
    else:
        assert not plan_path.exists(), 'Do not replace an existing bounded sample'
    query = """
BEGIN READ ONLY; SET LOCAL statement_timeout='20s';
WITH eligible AS MATERIALIZED (
SELECT v.user_id,v.source_id,v.id variant_id,i.identity_id::text identity_key,v.external_id,
       public.vod_language_profile_snapshot(v.codec_profile) profile,c.audio_tracks,
       row_number() OVER(PARTITION BY i.identity_id ORDER BY v.codec_profile->>'probedAt' DESC,v.id) preference
FROM public.cloud_title_variants v
JOIN public.admin_internal_accounts internal ON internal.user_id=v.user_id
JOIN public.cloud_sources s ON s.id=v.source_id AND s.user_id=v.user_id AND s.enabled AND s.deleted_at IS NULL AND s.sync_status='ready'
JOIN public.cloud_source_catalog_heads h ON h.source_id=v.source_id AND h.user_id=v.user_id AND h.active_generation_id=v.generation_id
JOIN public.catalog_source_provider_identities i ON i.source_id=v.source_id AND i.user_id=v.user_id
JOIN public.catalog_file_tracks c ON c.server_host=i.identity_id::text AND c.item_type=v.item_type AND c.external_id=v.external_id
WHERE v.item_type='movie' AND v.codec_profile IS NOT NULL
__PROVIDER_SCOPE__
AND v.codec_profile->>'probeSource' IN ('gateway_inband','gateway_probe')
AND regexp_replace(lower(coalesce(v.codec_profile->>'container','')),'[^a-z0-9]+','','g')
    IN ('mkv','matroska','matroskawebm','mp4','mov','avi','ogg','flv','mpg','ts')
AND v.codec_profile->>'videoCodec' IS NOT NULL AND v.codec_profile->>'audioCodec' IS NOT NULL
AND jsonb_typeof(v.codec_profile->'subtitles')='array'
AND coalesce(v.codec_profile->>'probedAt','') >= '2026-09-08'
AND c.audio_probed_at IS NOT NULL AND c.audio_lang_verified_at IS NULL
AND (c.audio_lang_retry_at IS NULL OR c.audio_lang_retry_at<=now())
AND jsonb_array_length(c.audio_tracks)=1
AND public.catalog_audio_track_indexes(c.audio_tracks)=public.vod_language_profile_audio_indices(v.codec_profile)
AND public.vod_language_profile_file_size_bytes(v.codec_profile)>0
AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.audio_tracks) t WHERE coalesce(nullif(t->>'lang',''),'und')='und')
AND NOT EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs j WHERE j.identity_key=i.identity_id::text AND j.item_type='movie' AND j.external_id=v.external_id)
), chosen AS (SELECT * FROM eligible WHERE preference=1 ORDER BY profile->>'probedAt' DESC LIMIT __SAMPLE_LIMIT__)
SELECT coalesce(jsonb_agg(to_jsonb(chosen)),'[]'::jsonb) FROM chosen;
ROLLBACK;
"""
    query = query.replace('__PROVIDER_SCOPE__',
        'AND i.identity_id::text=' + literal(first['identity_key']) if replacement else '')
    query = query.replace('__SAMPLE_LIMIT__', '1' if replacement else '3')
    rows = json.loads(sql(query))
    assert (len(rows) == 1 if replacement else 2 <= len(rows) <= 3), 'Insufficient eligible internal samples'
    for ordinal, row in enumerate(rows, 4 if replacement else 1):
        p = row['profile']
        assert p['probeSource'] in ['gatewayprobe', 'gatewayinband']
        assert p['probeSource'] != 'gatewayinband' or p['metadataComplete'] is True
        assert 80 <= p['durationSeconds'] <= 86400
        assert len(p['audioTracks']) == len(row['audio_tracks']) == 1
        row['fingerprint'] = fingerprint(p)
        row['sample'] = ordinal
    plan_path.write_text(json.dumps(previous + rows))
    print(json.dumps({'prepared': len(rows), 'distinctProviders': len(set(r['identity_key'] for r in rows)),
                      'internalAccountsOnly': True, 'previouslyUntriedOnly': True,
                      'profiles': [{'sample': r['sample'], 'probedAt': r['profile']['probedAt'],
                                    'container': r['profile']['container'], 'tracks': len(r['audio_tracks'])} for r in rows]}))
elif phase == 'start':
    sample = int(sys.argv[2])
    assert sample in [1, 2, 3, 4]
    rows = json.loads(plan_path.read_text())
    row = next(r for r in rows if r['sample'] == sample)
    assert not row.get('job'), 'Sample already enqueued'
    p = row['profile']
    indices = [int(t['index']) for t in p['audioTracks']]
    args = [literal(row['user_id'])+'::uuid', literal(row['source_id'])+'::uuid', literal(row['variant_id'])+'::uuid',
            literal(row['identity_key']), "'movie'", literal(row['external_id']),
            'ARRAY['+','.join(map(str, indices))+']::integer[]', literal(json.dumps(p))+'::jsonb',
            literal(row['fingerprint']), literal(p['probedAt'])+'::timestamptz', str(p['fileSizeBytes'])+'::bigint',
            literal(json.dumps(row['audio_tracks']))+'::jsonb', 'false']
    guard = """DO $guard$ BEGIN
IF NOT EXISTS(SELECT 1 FROM public.admin_internal_accounts WHERE user_id=%s::uuid)
OR EXISTS(SELECT 1 FROM public.catalog_file_audio_validation_jobs WHERE identity_key=%s AND item_type='movie' AND external_id=%s)
THEN RAISE EXCEPTION 'Sample is no longer new and internal'; END IF; END $guard$;""" % (
        literal(row['user_id']), literal(row['identity_key']), literal(row['external_id']))
    result = json.loads(sql("BEGIN; SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'; " + guard
        + " SET LOCAL ROLE service_role; SELECT public.start_automatic_catalog_file_audio_validation_job("
        + ','.join(args) + '); COMMIT;', readonly=False))
    assert result.get('jobId'), 'Normal enqueue quota or ownership gate declined sample'
    row['job'] = result['jobId']
    plan_path.write_text(json.dumps(rows))
    print(json.dumps({'sample': sample, 'enqueued': True, 'state': result.get('state'),
                      'normalWorker': True, 'oldJobsUntouched': True}))
elif phase == 'retest-after-fix':
    # One operator replay of THIS new diagnostic sample, not an old quarantine.
    # Preserve both attempt counters and all normal account/file/worker gates.
    rows = json.loads(plan_path.read_text())
    row = next(r for r in rows if r['sample'] == 1)
    assert row.get('job') and not row.get('operatorReplay'), 'Replay already used or sample absent'
    live = subprocess.check_output(['docker', 'exec', 'norva-media-gateway', 'cat', '/app/src/index.js'])
    assert hashlib.sha256(live.replace(b'\r\n', b'\n')).hexdigest() == 'a611b2b2fb874437ae9b090f6b742fa010dcf4b71829f11c662d915e2ba9882a', 'Reviewed extraction fix not deployed'
    query = """BEGIN; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='3s';
WITH changed AS (UPDATE public.catalog_file_audio_validation_jobs SET retry_at=clock_timestamp()
WHERE id=%s::uuid AND requested_by=%s::uuid AND profile_fingerprint=%s
AND state='retry_wait' AND error_code='LANGUAGE_VALIDATION_GATEWAY_ERROR'
AND created_at>='2026-09-10T18:26:00Z'::timestamptz AND quarantined_at IS NULL
AND provider_attempt_count=2 AND consecutive_provider_no_progress_count=2 AND lease_owner IS NULL
RETURNING id) SELECT count(*) FROM changed; COMMIT;""" % (
        literal(row['job']), literal(row['user_id']), literal(row['fingerprint']))
    assert sql(query, readonly=False) == '1', 'Replay compare-and-swap declined'
    row['operatorReplay'] = True
    plan_path.write_text(json.dumps(rows))
    print(json.dumps({'sample': 1, 'oneScopedReplay': True, 'countersReset': False, 'quarantinesTouched': False}))
elif phase == 'status':
    rows = json.loads(plan_path.read_text())
    output = []
    for row in rows:
        if not row.get('job'):
            output.append({'sample': row['sample'], 'state': 'not_started'})
            continue
        query = """BEGIN READ ONLY; SET LOCAL statement_timeout='10s';
SELECT jsonb_build_object('state',j.state,'error',j.error_code,'attempts',j.provider_attempt_count,
'noProgress',j.consecutive_provider_no_progress_count,'window',j.strict_lid_window_position,
'windows',j.strict_lid_window_count,'tracksDone',j.next_track_position,'verified',j.verified_at IS NOT NULL,
'quarantined',j.quarantined_at IS NOT NULL,'updatedAt',j.updated_at,'retryAt',j.retry_at,
'cacheVerified',c.audio_lang_verified_at IS NOT NULL,'cacheAudioTrackCount',jsonb_array_length(c.audio_tracks))
FROM public.catalog_file_audio_validation_jobs j
LEFT JOIN public.catalog_file_tracks c ON c.server_host=j.identity_key AND c.item_type=j.item_type AND c.external_id=j.external_id
WHERE j.id=%s::uuid; ROLLBACK;""" % literal(row['job'])
        output.append({'sample': row['sample'], **json.loads(sql(query))})
    print(json.dumps(output))
else:
    raise RuntimeError('Unknown phase')
