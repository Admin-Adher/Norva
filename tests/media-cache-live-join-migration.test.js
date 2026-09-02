'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260902100000_media_cache_live_join_v1.sql',
), 'utf8');

test('live join separates one producer from individually revocable viewer rows', () => {
  assert.match(migration, /media_cache_live_attachment_id uuid/);
  assert.match(migration, /media_cache_live_producer_gateway_row_id uuid/);
  assert.match(migration, /media_cache_primary_attached boolean/);
  assert.match(migration, /cloud_gateway_sessions_media_cache_live_attachment_unique/);
  assert.match(migration, /media_cache_live_attachment_state in \('pending', 'active', 'releasing', 'revoked', 'failed'\)/);
});

test('live claim re-authorizes the current source and never claims a second provider account', () => {
  const claim = migration.slice(
    migration.indexOf('create function public.norva_claim_media_cache_live_playback'),
    migration.indexOf('create function public.norva_activate_media_cache_live_playback'),
  );
  assert.match(claim, /norva_assert_source_catalog_visible_locked/);
  assert.match(claim, /cloud_source_catalog_heads/);
  assert.match(claim, /catalog_series_episode_coordinates_by_episode/);
  assert.match(claim, /media_cache_producer_leases[\s\S]*lease\.stage = 'producing'/);
  assert.match(claim, /session\.id <> v_producer\.playback_session_id/);
  assert.match(claim, /'transcode', 'pending', p_target_url_hash, null/);
  assert.doesNotMatch(claim, /claim_cloud_playback_session/);
});

test('follower transfer and primary departure are atomic and demand aware', () => {
  const activation = migration.slice(
    migration.indexOf('create function public.norva_activate_media_cache_live_playback'),
    migration.indexOf('create function public.norva_rollback_media_cache_live_playback'),
  );
  const primaryDetach = migration.slice(
    migration.indexOf('create or replace function public.norva_request_media_cache_continuation_for_gateway'),
    migration.indexOf('create function public.norva_request_media_cache_continuation_for_live_attachment'),
  );
  assert.match(activation, /follower_count = greatest\(0, lease\.follower_count - 1\)/);
  assert.match(activation, /background_continuation = false/);
  assert.match(activation, /media_cache_live_attachment_state = 'active'/);
  assert.match(activation, /media_cache_live_attachment_state = 'active'[\s\S]*v_attachment\.hls_url = p_hls_url/);
  assert.match(primaryDetach, /media_cache_primary_attached = false/);
  assert.match(primaryDetach, /v_active_attachments > 0 or lease\.follower_count > 0/);
  assert.match(primaryDetach, /background_continuation = \(v_active_attachments = 0\)/);
});

test('simultaneous viewer departures serialize and reserve the last continuation decision', () => {
  const detach = migration.slice(
    migration.indexOf('create function public.norva_request_media_cache_continuation_for_live_attachment'),
    migration.indexOf('create function public.norva_finalize_media_cache_live_attachment_release'),
  );
  assert.match(detach, /media_cache_live_attachment_state in \('active', 'releasing'\)[\s\S]*for update/);
  assert.match(detach, /media_cache_live_producer_gateway_row_id[\s\S]*for update/);
  assert.match(detach, /media_cache_live_attachment_state = 'releasing'/);
  assert.match(detach, /candidate\.media_cache_live_attachment_state = 'active'/);
});

test('live join activation rejects an expired producer even after an earlier claim', () => {
  const activation = migration.slice(
    migration.indexOf('create function public.norva_activate_media_cache_live_playback'),
    migration.indexOf('create function public.norva_rollback_media_cache_live_playback'),
  );
  assert.match(activation, /gateway\.expires_at > v_now/);
});

test('all live-join mutation RPCs remain service-role only', () => {
  for (const name of [
    'norva_claim_media_cache_live_playback',
    'norva_activate_media_cache_live_playback',
    'norva_rollback_media_cache_live_playback',
    'norva_request_media_cache_continuation_for_live_attachment',
    'norva_finalize_media_cache_live_attachment_release',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}[\\s\\S]*?from public, anon, authenticated`, 'i'));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}[\\s\\S]*?to service_role`, 'i'));
  }
});
