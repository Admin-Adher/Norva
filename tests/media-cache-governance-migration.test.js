'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260902103000_media_cache_governance_v1.sql',
), 'utf8');
const objectFoundation = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260901220000_media_cache_exact_playback_grants_v1.sql',
), 'utf8');

function section(start, end) {
  const from = migration.indexOf(start);
  const to = migration.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section missing`);
  return migration.slice(from, to);
}

test('admission is demand-only, opaque and disabled until an enforced rollout', () => {
  assert.match(migration, /admission_mode text not null default 'off'/);
  assert.match(migration, /create table public\.media_cache_demand_buckets/);
  const demand = section(
    'create function public.norva_record_media_cache_demand',
    'create function public.norva_prune_media_cache_demand',
  );
  assert.match(demand, /work_fingerprint/);
  assert.match(demand, /account_fingerprint/);
  assert.match(demand, /v_policy\.admission_mode = 'enforced' and v_recommended/);
  assert.match(demand, /repeated_requests_24h/);
  assert.match(demand, /popular_requests_30d/);
  assert.match(demand, /costly_score_threshold/);
  assert.doesNotMatch(demand, /provider_name|source_url|username|password|ticket|user_id/i);
});

test('R2 budgets, adaptive retention, LFU/LRU ordering and file bounds are explicit', () => {
  assert.match(migration, /l1_max_bytes bigint/);
  assert.match(migration, /r2_max_bytes bigint/);
  assert.match(migration, /r2_max_objects integer/);
  assert.match(migration, /max_files_per_object integer/);
  assert.match(migration, /r2_inventory_cursor text/);
  const schedule = section(
    'create function public.norva_schedule_media_cache_evictions',
    'create function public.norva_claim_media_cache_purge',
  );
  assert.match(schedule, /object\.retention_until <= v_now/);
  assert.match(schedule, /object\.popularity_count asc/);
  assert.match(schedule, /object\.last_accessed_at asc nulls first/);
  assert.match(schedule, /media_cache_playback_grants/);
  assert.match(schedule, /object\.state in \('ready', 'deleting'\)/);
  const candidates = schedule.slice(schedule.indexOf('for v_candidate in'), schedule.indexOf('  loop'));
  assert.doesNotMatch(candidates, /quarantined/);
  assert.match(schedule, /'storage_bytes'/);
  assert.match(schedule, /'storage_objects'/);
  assert.match(schedule, /job\.state = 'failed'[\s\S]*job\.reason in \('corruption', 'legal', 'security'\)/);
  assert.match(schedule, /case preferred\.reason when 'security' then 3 when 'legal' then 2 else 1 end desc/);
  assert.match(schedule, /state = 'queued',[\s\S]*attempts = 0/);
  assert.match(schedule, /completed_job\.state = 'completed'/);
  assert.match(schedule, /limit \(p_batch - v_scheduled\)/);
});

test('physical purge is crash-safe, leased and preserves non-legal bindings', () => {
  const enqueue = section(
    'create function public.norva_enqueue_media_cache_purge',
    'create function public.norva_schedule_media_cache_evictions',
  );
  const claim = section(
    'create function public.norva_claim_media_cache_purge',
    'create function public.norva_complete_media_cache_purge',
  );
  const complete = section(
    'create function public.norva_complete_media_cache_purge',
    'create function public.norva_recover_media_cache_object',
  );
  assert.match(enqueue, /p_reason not in \('eviction', 'orphan', 'corruption', 'legal', 'security'\)/);
  assert.match(enqueue, /v_effective_reason = 'eviction'[\s\S]*media_cache_playback_grants/);
  assert.match(enqueue, /v_effective_reason = 'orphan'[\s\S]*v_object\.state = 'purged'/);
  assert.match(enqueue, /v_effective_reason = 'corruption'[\s\S]*state = case when state = 'purged' then 'purged' else 'quarantined' end/);
  assert.match(enqueue, /else[\s\S]*update public\.media_cache_bindings/);
  assert.match(enqueue, /v_tombstone_reason/);
  assert.match(enqueue, /job\.reason in \('legal', 'security'\)[\s\S]*job\.recovery_cleared_at is null/);
  assert.match(enqueue, /case when v_effective_reason = 'orphan'[\s\S]*interval '15 minutes'/);
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /lease_expires_at/);
  assert.match(complete, /state = 'purged'/);
  assert.match(complete, /media_cache_work_results/);
  assert.match(complete, /v_job\.attempts >= 12/);
  assert.match(complete, /v_job\.reason <> p_reason/);
  assert.match(complete, /return 'superseded'/);
  assert.match(complete, /select job\.object_key into v_object_key[\s\S]*pg_advisory_xact_lock[\s\S]*for update/);
  assert.match(migration, /norva_complete_media_cache_purge\(uuid, text, uuid, text, boolean, text\)/);
});

test('corruption recovery requires verified Worker metadata and a database fence', () => {
  const recovery = section(
    'create function public.norva_recover_media_cache_object',
    '-- The legacy registration function',
  );
  assert.match(recovery, /p_manifest_sha256 !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(recovery, /state in \('quarantined', 'purged'\)/);
  assert.match(recovery, /object\.purge_reason = 'corruption'/);
  assert.match(recovery, /media_cache_purge_jobs/);
  assert.match(recovery, /state = 'ready'/);
  assert.match(recovery, /recovery_cleared_at = v_now/);
  assert.match(recovery, /critical_job\.reason in \('legal', 'security'\)/);
  assert.match(recovery, /object\.content_sha256 = p_content_sha256/);
  assert.match(recovery, /object\.video_profile_sha256 = p_video_profile_sha256/);
  assert.match(recovery, /object\.audio_topology_sha256 = p_audio_topology_sha256/);
  assert.match(recovery, /object\.subtitle_topology_sha256 = p_subtitle_topology_sha256/);
  assert.match(recovery, /object\.root_playlist = p_root_playlist/);
});

test('registration, purge completion, recovery and publication share one object lifecycle lock', () => {
  const seed = '864691128455135232::bigint';
  assert.match(objectFoundation, new RegExp(`hashtextextended\\(p_object_key, ${seed}`));
  for (const [start, end] of [
    ['create function public.norva_enqueue_media_cache_purge', 'create function public.norva_schedule_media_cache_evictions'],
    ['create function public.norva_complete_media_cache_purge', 'create function public.norva_recover_media_cache_object'],
    ['create function public.norva_recover_media_cache_object', '-- The legacy registration function'],
    ['create function public.norva_commit_admitted_media_cache_publication', 'create function public.norva_media_cache_observability_summary'],
  ]) {
    assert.match(section(start, end), new RegExp(`pg_advisory_xact_lock\\([\\s\\S]*${seed}`));
  }
  assert.match(migration, /alter column retention_until set default \(clock_timestamp\(\) \+ interval '1 minute'\)/);
});

test('no-secret observability covers every required cache and lifecycle signal', () => {
  for (const metric of [
    'l1_hit', 'l1_miss', 'l2_hit', 'l2_miss', 'cdn_hit', 'cdn_miss',
    'lookup_ms', 'playlist_ms', 'first_image_ms',
    'ffmpeg_bytes_avoided', 'ffmpeg_seconds_avoided',
    'producer_started', 'viewer_joined', 'fill_completed', 'fill_preempted',
    'fill_expired', 'fill_failed', 'storage_bytes', 'storage_objects',
    'eviction', 'orphan_candidate', 'purge_completed', 'purge_failed',
    'cache_fallback', 'cache_recovery', 'route_score', 'route_confidence',
  ]) assert.match(migration, new RegExp(`'${metric}'`));
  const metrics = section(
    'create table public.media_cache_metric_buckets',
    'create table public.media_cache_purge_jobs',
  );
  assert.doesNotMatch(metrics, /user_id|source_id|object_key|work_fingerprint|ticket|url|credential/i);
});

test('publication is fail-closed behind the admitted wrapper and every RPC is service-only', () => {
  const admitted = section(
    'create function public.norva_commit_admitted_media_cache_publication',
    'create function public.norva_media_cache_observability_summary',
  );
  assert.match(admitted, /media_cache_admitted is distinct from true/);
  assert.match(admitted, /media_cache_admission_mode <> 'enforced'/);
  assert.match(admitted, /p_file_count > v_policy\.max_files_per_object/);
  assert.match(admitted, /greatest\([\s\S]*v_policy\.minimum_retention_seconds[\s\S]*least\(v_gateway\.media_cache_ttl_seconds, v_policy\.hot_ttl_seconds\)/);
  assert.doesNotMatch(admitted, /secs => least\(v_gateway\.media_cache_ttl_seconds, v_policy\.minimum_retention_seconds\)/);
  assert.match(admitted, /norva_commit_media_cache_publication/);
  assert.match(admitted, /job\.reason in \('legal', 'security'\)[\s\S]*job\.reason = 'corruption'[\s\S]*recovery_cleared_at is null/);
  assert.match(admitted, /last_error_code = 'authority_changed'/);
  assert.match(admitted, /job\.state = 'queued'[\s\S]*job\.attempts = 0/);
  assert.match(admitted, /if not found then[\s\S]*delete from public\.media_cache_objects[\s\S]*v_existing_object\.retention_until/);
  assert.match(migration, /revoke execute on function public\.norva_commit_media_cache_publication[\s\S]*from service_role/);
  for (const name of [
    'norva_record_media_cache_demand', 'norva_prune_media_cache_demand',
    'norva_record_media_cache_metric', 'norva_enqueue_media_cache_purge',
    'norva_schedule_media_cache_evictions', 'norva_claim_media_cache_purge',
    'norva_complete_media_cache_purge', 'norva_recover_media_cache_object',
    'norva_commit_admitted_media_cache_publication',
    'norva_media_cache_observability_summary',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}[\\s\\S]*?from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}[\\s\\S]*?to service_role;`));
  }
});

test('hourly buckets are normalized in UTC independently of the database session timezone', () => {
  assert.match(migration, /date_trunc\('hour', bucket_start at time zone 'UTC'\) at time zone 'UTC'/);
  assert.match(migration, /date_trunc\('hour', clock_timestamp\(\) at time zone 'UTC'\) at time zone 'UTC'/);
});

test('storage metrics are gauges and count bytes until physical deletion completes', () => {
  const metrics = section(
    'create function public.norva_record_media_cache_metric',
    'create table public.media_cache_purge_jobs',
  );
  const summary = section(
    'create function public.norva_media_cache_observability_summary',
    'revoke all on function public.norva_record_media_cache_demand',
  );
  assert.match(metrics, /when excluded\.metric in \('storage_bytes', 'storage_objects'\) then excluded\.value_sum/);
  assert.match(summary, /object\.state in \('ready', 'quarantined', 'deleting'\)/);
  assert.match(summary, /array_agg\(per_bucket\.value_sum order by per_bucket\.bucket_start desc\)\)\[1\]/);
  assert.match(summary, /else sum\(per_bucket\.value_sum\)/);
});
