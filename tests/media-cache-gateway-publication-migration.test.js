'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260901223000_media_cache_gateway_publication_v1.sql',
), 'utf8');

test('Gateway publication derives exact binding authority from its playback session', () => {
  const commit = migration.slice(
    migration.indexOf('create function public.norva_commit_media_cache_publication'),
    migration.indexOf('create function public.norva_resolve_media_cache_playback'),
  );
  assert.match(commit, /cloud_playback_sessions playback[\s\S]*cloud_gateway_sessions gateway/);
  assert.match(commit, /gateway\.external_session_id = p_gateway_session_id/);
  assert.match(commit, /playback\.superseded_at is null/);
  assert.match(commit, /cloud_source_catalog_heads[\s\S]*active_generation_id = item\.generation_id/);
  assert.match(commit, /catalog_series_episode_coordinates_by_episode/);
  assert.match(commit, /coalesce\(cardinality\(v_variant_ids\), 0\) <> 1/);
  assert.match(commit, /norva_register_ready_media_cache_object/);
  assert.match(commit, /norva_bind_media_cache_object/);
  assert.doesNotMatch(commit, /p_source_id|p_item_id|p_external_id|p_variant_id|p_target_url_sha256/);
});

test('hot lookup accepts only session plus user and reuses the exact authorization RPC', () => {
  const resolve = migration.slice(
    migration.indexOf('create function public.norva_resolve_media_cache_playback'),
    migration.indexOf('revoke all on function public.norva_commit_media_cache_publication'),
  );
  assert.match(resolve, /p_playback_session_id uuid,[\s\S]*p_user_id uuid/);
  assert.match(resolve, /session\.status in \('pending', 'ready'\)/);
  assert.match(resolve, /session\.superseded_at is null/);
  assert.match(resolve, /binding\.external_id = v_session\.item_id/);
  assert.match(resolve, /binding\.target_url_sha256 = v_session\.target_url_hash/);
  assert.match(resolve, /coalesce\(cardinality\(v_binding_ids\), 0\) <> 1/);
  assert.match(resolve, /norva_authorize_media_cache_object/);
  assert.doesNotMatch(resolve, /p_object_key|p_source_id|p_external_id|p_variant_id|p_target_url_sha256/);
});

test('publication and lookup are service-only', () => {
  for (const fn of ['norva_commit_media_cache_publication', 'norva_resolve_media_cache_playback']) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role;`));
  }
});
