'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(
  __dirname,
  '../supabase/migrations/20260901193000_provider_adaptive_route_control_v1.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const resumeSeekMigrationPath = path.join(
  __dirname,
  '../supabase/migrations/20260902213500_provider_route_resume_seek_benchmark_v2.sql',
);
const resumeSeekMigration = fs.readFileSync(resumeSeekMigrationPath, 'utf8');
const realtimeViabilityMigrationPath = path.join(
  __dirname,
  '../supabase/migrations/20260903114500_provider_route_realtime_viability_v3.sql',
);
const realtimeViabilityMigration = fs.readFileSync(realtimeViabilityMigrationPath, 'utf8');

test('adaptive provider routing control plane defines policies, state, measurements, and leases', () => {
  for (const table of [
    'provider_route_policies',
    'provider_route_state',
    'provider_route_measurements',
    'provider_route_activity',
    'provider_route_leases',
  ]) {
    assert.match(migration, new RegExp(`create table public\\.${table} \\(`));
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security;`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`));
  }
  assert.match(migration, /scope in \('account', 'host'\)/);
  assert.match(migration, /node_transport in \('http', 'socks5'\)/);
  assert.match(migration, /ffmpeg_slot = route_slot/);
});

test('route measurement contract covers startup, sustained throughput, seek, and typed failures', () => {
  for (const signal of [
    'ttfb_ms',
    'first_4mib_ms',
    'first_16mib_ms',
    'throughput_bytes_per_second',
    'variance_ratio',
    'range_seek_ok',
    'resets',
    'timeouts',
    'proxy_407',
    'provider_458',
    'http_5xx',
    'route_score',
    'route_confidence',
  ]) {
    assert.match(migration, new RegExp(`\\b${signal}\\b`));
  }
});

test('v2 route evidence requires bounded non-zero resume probes and expires prefix-only state', () => {
  assert.match(resumeSeekMigration, /add column if not exists resume_probe_bytes integer not null default 1048576/);
  assert.match(resumeSeekMigration, /add column if not exists range_start_bytes bigint not null default 0/);
  assert.match(resumeSeekMigration, /phase in \('tiny', 'sustained', 'resume-seek', 'real-playback'\)/);
  assert.match(resumeSeekMigration, /phase = 'resume-seek' and range_start_bytes > 0/);
  assert.match(resumeSeekMigration, /update public\.provider_route_state[\s\S]*expires_at = greatest/);
  assert.doesNotMatch(resumeSeekMigration, /delete from public\.provider_route_(state|measurements)/);
});

test('v3 route evidence uses long deep probes and an exact realtime throughput floor', () => {
  assert.match(realtimeViabilityMigration, /realtime_throughput_margin numeric\(4,2\) not null default 1\.35/);
  assert.match(realtimeViabilityMigration, /alter column resume_probe_bytes set default 8388608/);
  assert.match(realtimeViabilityMigration, /resume_probe_bytes between 4194304 and 16777216/);
  assert.match(realtimeViabilityMigration, /minimum_required_bytes_per_second bigint not null default 0/);
  assert.match(realtimeViabilityMigration, /update public\.provider_route_state[\s\S]*expires_at = greatest/);
  assert.doesNotMatch(realtimeViabilityMigration, /delete from public\.provider_route_(state|measurements)/);
});

test('route benchmark lease is distributed, bounded, service-only, and preemptable by playback', () => {
  assert.match(migration, /create or replace function public\.norva_claim_provider_route_lease/);
  assert.match(migration, /on conflict \(account_fingerprint\) do update[\s\S]*expires_at <= v_now/);
  assert.match(migration, /create or replace function public\.norva_renew_provider_route_lease/);
  assert.match(migration, /and not preempt_requested/);
  assert.match(migration, /create or replace function public\.norva_preempt_provider_route_lease/);
  assert.match(migration, /create or replace function public\.norva_touch_provider_route_activity/);
  assert.match(migration, /create or replace function public\.norva_release_provider_route_lease/);
  assert.match(migration, /purpose = 'route-benchmark'/);
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*provider_route_activity[\s\S]*expires_at > v_now/);
  assert.match(migration, /provider_route_activity[\s\S]*activity_kind in \('viewer', 'gateway'\)/);
  assert.doesNotMatch(migration, /grant execute[\s\S]{0,180}to (anon|authenticated)/i);
});

test('route control stores only one-way identities and no supplier-specific exception', () => {
  const stateBlock = migration.slice(
    migration.indexOf('create table public.provider_route_state'),
    migration.indexOf('create index provider_route_state_host_rank_idx'),
  );
  const measurementBlock = migration.slice(
    migration.indexOf('create table public.provider_route_measurements'),
    migration.indexOf('create index provider_route_measurements_account_recent_idx'),
  );
  const activityBlock = migration.slice(
    migration.indexOf('create table public.provider_route_activity'),
    migration.indexOf('create index provider_route_activity_expiry_idx'),
  );
  for (const unsafeColumn of ['user_id', 'source_id', 'server_url', 'provider_url', 'username', 'password', 'proxy_url']) {
    assert.doesNotMatch(stateBlock, new RegExp(`\\b${unsafeColumn}\\b`, 'i'));
    assert.doesNotMatch(measurementBlock, new RegExp(`\\b${unsafeColumn}\\b`, 'i'));
    assert.doesNotMatch(activityBlock, new RegExp(`\\b${unsafeColumn}\\b`, 'i'));
  }
  for (const forbidden of ['KING365', 'GOTV', 'STRNG', 'Promax', 'Opplex', 'Airysat']) {
    assert.equal(migration.includes(forbidden), false);
  }
});
