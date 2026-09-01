'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260901224500_media_cache_hot_playback_v1.sql',
), 'utf8');

const claim = migration.slice(
  migration.indexOf('create function public.norva_claim_media_cache_playback'),
  migration.indexOf('revoke all on function public.norva_claim_media_cache_playback'),
);

test('hot playback derives one exact active binding and reauthorizes current catalog authority', () => {
  assert.match(claim, /media_cache_bindings binding/);
  assert.match(claim, /binding\.external_id = btrim\(p_item_id\)/);
  assert.match(claim, /binding\.target_url_sha256 = p_target_url_hash/);
  assert.match(claim, /coalesce\(cardinality\(v_binding_ids\), 0\) <> 1/);
  assert.match(claim, /norva_authorize_media_cache_object/);
  assert.match(claim, /v_binding\.variant_id/);
  assert.doesNotMatch(claim, /provider-session:/);
});

test('hot playback serializes per user, enforces capacity, and never claims provider affinity', () => {
  assert.match(claim, /media-cache-user:' \|\| p_user_id::text/);
  assert.match(claim, /v_current_streams >= p_concurrent_limit/);
  assert.match(claim, /capacity_exceeded/);
  assert.match(claim, /provider_account_hash, stream_mime/);
  assert.match(claim, /p_target_url_hash, null,/);
  assert.match(claim, /'direct', 'ready'/);
  assert.doesNotMatch(claim, /'transcode', 'ready'/);
});

test('cache session and first renewable grant commit in the same transaction', () => {
  assert.match(claim, /insert into public\.cloud_playback_sessions/);
  assert.match(claim, /norva_authorize_media_cache_playback/);
  assert.match(claim, /v_grant\.ticket_expires_at/);
  assert.match(claim, /v_grant\.hard_expires_at/);
  assert.ok(
    claim.indexOf('insert into public.cloud_playback_sessions')
      < claim.indexOf('norva_authorize_media_cache_playback'),
  );
});

test('real devices replace only their own session and browser tabs stay entitlement bounded', () => {
  assert.match(claim, /p_device_id is not null and session\.device_id = p_device_id/);
  assert.match(claim, /p_device_id is null[\s\S]*session\.source_id = p_source_id[\s\S]*session\.item_id = p_item_id/);
  assert.match(claim, /not \(session\.id = any\(v_superseded\)\)/);
});

test('hot playback RPC is service-role only', () => {
  assert.match(migration, /revoke all on function public\.norva_claim_media_cache_playback\([\s\S]*from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.norva_claim_media_cache_playback\([\s\S]*to service_role;/);
});
