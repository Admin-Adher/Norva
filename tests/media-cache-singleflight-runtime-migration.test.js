'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260902093000_media_cache_singleflight_runtime_v1.sql',
), 'utf8');

test('Gateway producer authority is opaque, complete and all-or-none', () => {
  for (const column of [
    'media_cache_work_fingerprint',
    'media_cache_account_fingerprint',
    'media_cache_lease_token',
    'media_cache_owner_instance_fingerprint',
  ]) assert.match(migration, new RegExp(`add column ${column}`));
  assert.match(migration, /cloud_gateway_sessions_media_cache_producer_context_check/);
  assert.match(migration, /pg_catalog\.num_nonnulls\([\s\S]*?\) = 4/);
  assert.match(migration, /cloud_gateway_sessions_media_cache_lease_unique/);
});

test('ready follower resolves object server-side then derives exact current variant and binding', () => {
  const follower = migration.slice(
    migration.indexOf('create function public.norva_claim_ready_media_cache_work_playback'),
    migration.indexOf('create function public.norva_leave_media_cache_follower'),
  );
  assert.match(follower, /media_cache_work_results result/);
  assert.match(follower, /object\.state = 'ready'/);
  assert.match(follower, /object\.quarantined_at is null/);
  assert.match(follower, /cloud_source_catalog_heads/);
  assert.match(follower, /catalog_series_episode_coordinates_by_episode/);
  assert.match(follower, /norva_bind_media_cache_object/);
  assert.match(follower, /norva_claim_media_cache_playback/);
  assert.doesNotMatch(follower, /p_object_key/);
});

test('Gateway can renew, complete or abandon only its attached producer lease', () => {
  const pulse = migration.slice(
    migration.indexOf('create function public.norva_pulse_media_cache_producer_for_gateway'),
    migration.indexOf('create function public.norva_complete_media_cache_producer_for_gateway'),
  );
  const complete = migration.slice(
    migration.indexOf('create function public.norva_complete_media_cache_producer_for_gateway'),
    migration.indexOf('create function public.norva_abandon_media_cache_producer_for_gateway'),
  );
  const abandon = migration.slice(
    migration.indexOf('create function public.norva_abandon_media_cache_producer_for_gateway'),
    migration.indexOf('revoke all on function'),
  );
  assert.match(pulse, /norva_renew_media_cache_producer/);
  assert.match(pulse, /return 'preempted'/);
  assert.match(complete, /norva_complete_media_cache_producer/);
  assert.match(complete, /media_cache_work_results/);
  assert.match(abandon, /norva_abandon_media_cache_producer/);
  for (const body of [pulse, complete, abandon]) {
    assert.match(body, /cloud_gateway_sessions/);
    assert.doesNotMatch(body, /source_url|password|username/i);
  }
});

test('all singleflight runtime RPCs remain service-only', () => {
  for (const name of [
    'norva_claim_ready_media_cache_work_playback',
    'norva_leave_media_cache_follower',
    'norva_pulse_media_cache_producer_for_gateway',
    'norva_complete_media_cache_producer_for_gateway',
    'norva_abandon_media_cache_producer_for_gateway',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}[\\s\\S]*?from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}[\\s\\S]*?to service_role;`));
  }
});
