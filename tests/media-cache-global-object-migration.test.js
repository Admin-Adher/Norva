'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260901203000_media_cache_global_objects_v1.sql',
), 'utf8');

test('global media objects and tenant bindings are separate server-only authorities', () => {
  for (const table of ['media_cache_objects', 'media_cache_bindings']) {
    assert.match(migration, new RegExp(`create table public\\.${table} \\(`));
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security;`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`));
  }
  const objectTable = migration.slice(
    migration.indexOf('create table public.media_cache_objects'),
    migration.indexOf('create index media_cache_objects_eviction_idx'),
  );
  for (const forbidden of ['user_id', 'source_id', 'media_item_id', 'variant_id', 'external_id', 'target_url']) {
    assert.doesNotMatch(objectTable, new RegExp(`\\b${forbidden}\\b`, 'i'));
  }
  for (const identity of [
    'content_sha256', 'file_size_bytes', 'video_profile_sha256', 'audio_topology_sha256',
    'subtitle_topology_sha256', 'duration_milliseconds', 'pipeline_build', 'segmenter_build',
  ]) {
    assert.match(objectTable, new RegExp(`\\b${identity}\\b`));
  }
});

test('binding and authorization require exact live catalog authority', () => {
  const authorize = migration.slice(
    migration.indexOf('create or replace function public.norva_authorize_media_cache_object'),
    migration.indexOf('create or replace function public.norva_revoke_media_cache_bindings'),
  );
  for (const guard of [
    /binding\.user_id = p_user_id/,
    /binding\.source_id = p_source_id/,
    /binding\.item_type = p_item_type/,
    /binding\.target_url_sha256 = p_target_url_sha256/,
    /binding\.variant_id is not distinct from p_variant_id/,
    /item\.external_id = btrim\(p_external_id\)/,
    /item\.available/,
    /source\.enabled/,
    /source\.deleted_at is null/,
    /source\.sync_status <> 'disabled'/,
    /object\.state = 'ready'/,
    /object\.expires_at > v_now/,
  ]) {
    assert.match(authorize, guard);
  }
  assert.match(migration, /media_cache_bindings_authority_unique unique nulls not distinct/);
  assert.match(migration, /on conflict on constraint media_cache_bindings_authority_unique do update/);
});

test('source disable or soft deletion revokes only bindings, never the shared object', () => {
  const trigger = migration.slice(
    migration.indexOf('create or replace function public.norva_revoke_media_cache_bindings_on_source_state'),
    migration.indexOf('drop trigger if exists media_cache_bindings_source_state_trg'),
  );
  assert.match(trigger, /not new\.enabled/);
  assert.match(trigger, /new\.deleted_at is not null/);
  assert.match(trigger, /new\.sync_status = 'disabled'/);
  assert.match(trigger, /update public\.media_cache_bindings/);
  assert.doesNotMatch(trigger, /(?:delete|update)\s+(?:from\s+)?public\.media_cache_objects/i);
});

test('object publication is manifest-last shaped and all callable surfaces are service-only', () => {
  assert.match(migration, /Called only after every immutable asset has been uploaded/);
  assert.match(migration, /p_manifest_sha256/);
  assert.match(migration, /state,\s*storage_backend,[\s\S]*'ready',\s*p_storage_backend/);
  for (const fn of [
    'norva_register_ready_media_cache_object',
    'norva_bind_media_cache_object',
    'norva_authorize_media_cache_object',
    'norva_revoke_media_cache_bindings',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role;`));
  }
});

test('no supplier exception, title label, TMDB id or raw provider URL enters the schema', () => {
  for (const forbidden of [
    'KING365', 'GOTV', 'STRNG', 'Promax', 'Opplex', 'Airysat',
    'provider_name', 'display_name', 'raw_title', 'tmdb_id', 'source_url', 'effective_url',
  ]) {
    assert.equal(migration.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});
