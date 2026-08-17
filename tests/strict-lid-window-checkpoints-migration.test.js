'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260817001127_strict_lid_window_checkpoints.sql'),
  'utf8',
).replace(/\r\n?/g, '\n');
const pgTap = fs.readFileSync(
  path.join(root, 'supabase/tests/strict_lid_window_checkpoints.sql'),
  'utf8',
).replace(/\r\n?/g, '\n');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('window journal is private, bounded and internally coherent', () => {
  for (const column of [
    'strict_lid_window_position',
    'strict_lid_window_count',
    'strict_lid_window_tokens',
    'strict_lid_window_protocol',
  ]) {
    assert.match(migration, new RegExp(`add column ${column}`));
  }
  assert.match(migration, /force row level security/);
  assert.match(migration, /revoke all on table public\.catalog_file_audio_validation_jobs from public, anon, authenticated/);
  assert.match(migration, /attempt_count between 0 and 256/);
  assert.match(migration, /jsonb_array_length\(strict_lid_window_tokens\) = strict_lid_window_position/);
  assert.match(migration, /strict_lid_window_count in \(0, 4, 6\)/);
  assert.match(migration, /length\(token\.value #>> '\{\}'\) > 98304/);
  assert.match(
    migration,
    /\^v1\\\.\[a-f0-9\]\{16\}\\\.\[A-Za-z0-9_-\]\{16\}\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\{22\}\$/,
  );
});

test('claim renewal is owner-bound and does not spend a second attempt', () => {
  const claim = between(
    migration,
    'create or replace function public.claim_catalog_file_audio_validation_job(',
    '\ncreate or replace function public.checkpoint_catalog_file_audio_validation_window(',
  );
  assert.match(claim, /pg_advisory_xact_lock/);
  assert.match(claim, /for update/);
  assert.match(claim, /v_job\.lease_owner is distinct from btrim\(p_lease_owner\)/);
  assert.match(claim, /v_is_renewal/);
  assert.match(claim, /attempt_count >= 256/);
  assert.match(claim, /attempt_count = attempt_count \+ case when v_is_renewal then 0 else 1 end/);
  assert.match(claim, /'windowPosition', v_job\.strict_lid_window_position/);
  assert.match(claim, /'windowTokens', v_job\.strict_lid_window_tokens/);
});

test('window checkpoint is append-only CAS and never advances on a mismatch', () => {
  const checkpoint = between(
    migration,
    'create or replace function public.checkpoint_catalog_file_audio_validation_window(',
    '\ncreate or replace function public.reset_catalog_file_audio_validation_windows(',
  );
  assert.match(checkpoint, /v_job\.state <> 'running'/);
  assert.match(checkpoint, /v_job\.lease_expires_at <= v_now/);
  assert.match(checkpoint, /p_window_ordinal is distinct from v_job\.strict_lid_window_position \+ 1/);
  assert.match(checkpoint, /v_job\.strict_lid_window_tokens \? p_window_token/);
  assert.match(checkpoint, /strict_lid_window_tokens \|\| jsonb_build_array\(p_window_token\)/);
  assert.ok(checkpoint.indexOf("raise exception 'Invalid strict LID window checkpoint'") < checkpoint.indexOf('update public.catalog_file_audio_validation_jobs'));
});

test('reset and final-track transitions require exact live ownership and complete receipts', () => {
  const reset = between(
    migration,
    'create or replace function public.reset_catalog_file_audio_validation_windows(',
    '\ncreate or replace function public.checkpoint_catalog_file_audio_validation_track(',
  );
  const finalizeTrack = between(
    migration,
    'create or replace function public.checkpoint_catalog_file_audio_validation_track(',
    '\n-- Keep the v51 RPC name fail-closed',
  );
  assert.match(reset, /p_window_position is distinct from p_window_count/);
  assert.match(reset, /strict_lid_window_tokens = '\[\]'::jsonb/);
  assert.match(finalizeTrack, /strict_lid_window_position <> v_job\.strict_lid_window_count/);
  assert.match(finalizeTrack, /jsonb_array_length\(v_job\.strict_lid_window_tokens\) <> v_job\.strict_lid_window_count/);
  assert.match(finalizeTrack, /next_track_position = next_track_position \+ 1/);
  assert.match(finalizeTrack, /strict_lid_window_position = 0/);
});

test('every privileged helper and transition is service-role only', () => {
  for (const rpc of [
    'strict_lid_window_tokens_are_valid',
    'start_catalog_file_audio_validation_job',
    'claim_catalog_file_audio_validation_job',
    'checkpoint_catalog_file_audio_validation_window',
    'reset_catalog_file_audio_validation_windows',
    'checkpoint_catalog_file_audio_validation_track',
    'checkpoint_catalog_file_audio_validation_job',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}[\\s\\S]*?from public, anon, authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*?to service_role`));
  }
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test('pgTAP covers ACL, CAS replay, crash resume, multi-track reset and the exact attempt boundary', () => {
  assert.match(pgTap, /relrowsecurity and relforcerowsecurity/);
  assert.match(pgTap, /a concurrent owner cannot steal a live job lease/);
  assert.match(pgTap, /a missing ordinal cannot advance the append-only cursor/);
  assert.match(pgTap, /a duplicate receipt cannot advance the cursor/);
  assert.match(pgTap, /a stale worker cannot checkpoint after ownership changes/);
  assert.match(pgTap, /a crash\/retry resumes at the durable receipt position/);
  assert.match(pgTap, /track advance resets receipts before the next track can be claimed/);
  assert.match(pgTap, /attempt 256 remains the final bounded executable claim/);
  assert.match(pgTap, /attempt 257 is rejected instead of overflowing the bounded journal/);
  assert.match(pgTap, /historical attempt-64 cancellation permits a fresh job under quota/);
  assert.match(pgTap, /select \* from extensions\.finish\(\)/);
  assert.match(pgTap, /rollback;/);
});
