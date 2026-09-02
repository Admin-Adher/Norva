'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260901220000_media_cache_exact_playback_grants_v1.sql',
), 'utf8');

test('ready global objects publish one exact safe root playlist without tenant coordinates', () => {
  assert.match(migration, /alter table public\.media_cache_objects\s+add column root_playlist text/);
  assert.match(migration, /state = 'staging'[\s\S]*root_playlist is null/);
  assert.match(migration, /state in \('ready', 'quarantined', 'deleting'\)[\s\S]*root_playlist is not null/);
  const register = migration.slice(
    migration.indexOf('create function public.norva_register_ready_media_cache_object'),
    migration.indexOf('create or replace function public.norva_bind_media_cache_object'),
  );
  assert.match(register, /p_root_playlist text/);
  assert.match(register, /root_playlist = excluded\.root_playlist/);
  assert.match(register, /storage_backend = excluded\.storage_backend/);
  assert.match(register, /object_prefix = excluded\.object_prefix/);
  assert.doesNotMatch(register, /\bp_user_id\b|\bp_source_id\b|\bprovider\b|\btitle\b|\btmdb\b|\btarget_url\b/i);
});

test('cache bindings authorize exact active movies and exact generation-aware episodes', () => {
  assert.match(migration, /alter column media_item_id drop not null/);
  assert.match(migration, /alter column variant_id set not null/);
  assert.match(migration, /min\(variant\.id::text\)::uuid as variant_id/);
  assert.doesNotMatch(migration, /min\(variant\.id\)/);
  assert.match(migration, /having count\(\*\) = 1[\s\S]*media cache binding backfill is incomplete/);
  assert.match(migration, /\(item_type = 'movie' and media_item_id is not null\)[\s\S]*\(item_type = 'episode' and media_item_id is null\)/);
  assert.match(migration, /media_cache_bindings_authority_unique unique \([\s\S]*external_id,[\s\S]*variant_id,[\s\S]*target_url_sha256/);
  const bind = migration.slice(
    migration.indexOf('create or replace function public.norva_bind_media_cache_object'),
    migration.indexOf('drop function public.norva_authorize_media_cache_object'),
  );
  assert.match(bind, /cloud_source_catalog_heads[\s\S]*active_generation_id = item\.generation_id/);
  assert.match(bind, /catalog_series_episode_coordinates_by_episode\([\s\S]*p_user_id, p_source_id, btrim\(p_external_id\)/);
  assert.match(bind, /where coordinates\.variant_id = p_variant_id/);
});

test('playback grant derives authority from one live session and refuses ambiguous bindings', () => {
  const grant = migration.slice(
    migration.indexOf('create function public.norva_authorize_media_cache_playback'),
    migration.indexOf('create function public.norva_revoke_media_cache_playback_grant'),
  );
  assert.match(grant, /cloud_playback_sessions session/);
  assert.match(grant, /session\.user_id = p_user_id/);
  assert.match(grant, /v_session\.status not in \('pending', 'ready'\)/);
  assert.match(grant, /v_session\.superseded_at is not null/);
  assert.match(grant, /binding\.external_id = v_session\.item_id/);
  assert.match(grant, /binding\.target_url_sha256 = v_session\.target_url_hash/);
  assert.match(grant, /coalesce\(cardinality\(v_binding_ids\), 0\) <> 1/);
  assert.match(grant, /norva_authorize_media_cache_object\([\s\S]*v_binding\.variant_id/);
  assert.match(grant, /v_session\.created_at \+ interval '8 hours'/);
  assert.match(grant, /p_ticket_ttl_seconds not between 30 and 300/);
  assert.doesNotMatch(grant, /p_source_id|p_external_id|p_variant_id|p_target_url_sha256/);
});

test('grant state is server-only and terminal playback state revokes only the grant', () => {
  assert.match(migration, /create table public\.media_cache_playback_grants/);
  assert.match(migration, /force row level security/);
  assert.match(migration, /revoke all on table public\.media_cache_playback_grants from public, anon, authenticated/);
  assert.match(migration, /after update of status, superseded_at on public\.cloud_playback_sessions/);
  const trigger = migration.slice(
    migration.indexOf('create function public.norva_revoke_media_cache_grant_on_session_state'),
    migration.indexOf('create trigger media_cache_playback_grant_session_state_trg'),
  );
  assert.match(trigger, /new\.status in \('failed', 'expired'\) or new\.superseded_at is not null/);
  assert.match(trigger, /update public\.media_cache_playback_grants/);
  assert.doesNotMatch(trigger, /delete from public\.media_cache_objects|update public\.media_cache_objects/);
  for (const fn of [
    'norva_authorize_media_cache_playback',
    'norva_revoke_media_cache_playback_grant',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public, anon, authenticated;`));
  }
});
