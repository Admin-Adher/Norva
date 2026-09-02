'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260902094500_media_cache_demand_continuation_v1.sql',
), 'utf8');

function section(start, end) {
  const from = migration.indexOf(start);
  const to = migration.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section missing`);
  return migration.slice(from, to);
}

test('continuation becomes background-only after live distributed follower demand', () => {
  assert.match(migration, /add column background_continuation boolean not null default false/);
  const request = section(
    'create function public.norva_request_media_cache_continuation_for_gateway',
    'create function public.norva_pulse_media_cache_continuation_for_gateway',
  );
  assert.match(request, /cloud_gateway_sessions/);
  assert.match(request, /lease\.follower_count > 0/);
  assert.match(request, /not lease\.preempt_requested/);
  assert.match(request, /set background_continuation = true/);
  assert.doesNotMatch(request, /source_url|username|password|provider_name/i);
});

test('continuation heartbeat renews only while demand remains and exposes idle/preempted states', () => {
  const pulse = section(
    'create function public.norva_pulse_media_cache_continuation_for_gateway',
    'create function public.norva_preempt_background_media_cache_producers',
  );
  assert.match(pulse, /lease\.background_continuation/);
  assert.match(pulse, /lease\.follower_count > 0/);
  assert.match(pulse, /return 'preempted'/);
  assert.match(pulse, /return 'idle'/);
  assert.match(pulse, /return 'expired'/);
});

test('a viewer preempts only detached work and can wait for its exact drain', () => {
  const preempt = section(
    'create function public.norva_preempt_background_media_cache_producers',
    'create function public.norva_count_background_media_cache_producers',
  );
  const count = section(
    'create function public.norva_count_background_media_cache_producers',
    'create or replace function public.norva_leave_media_cache_follower',
  );
  for (const body of [preempt, count]) {
    assert.match(body, /lease\.background_continuation/);
    assert.match(body, /p_except_work_fingerprint/);
    assert.match(body, /lease\.work_fingerprint <> p_except_work_fingerprint/);
  }
  assert.match(preempt, /set preempt_requested = true/);
  assert.match(count, /lease\.stage in \('probing', 'producing'\)/);
  assert.doesNotMatch(preempt, /background_continuation\s*=\s*false/);
});

test('the final follower requests immediate bounded stop instead of filling an idle asset', () => {
  const leave = section(
    'create or replace function public.norva_leave_media_cache_follower',
    'revoke all on function',
  );
  assert.match(leave, /follower_count = greatest\(0, lease\.follower_count - 1\)/);
  assert.match(leave, /lease\.background_continuation and lease\.follower_count = 1/);
  assert.match(leave, /preempt_requested = lease\.preempt_requested/);
});

test('every demand-continuation RPC remains service-role only', () => {
  for (const name of [
    'norva_request_media_cache_continuation_for_gateway',
    'norva_pulse_media_cache_continuation_for_gateway',
    'norva_preempt_background_media_cache_producers',
    'norva_count_background_media_cache_producers',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}[\\s\\S]*?from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}[\\s\\S]*?to service_role;`));
  }
});
