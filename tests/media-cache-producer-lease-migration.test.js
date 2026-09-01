'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '../supabase/migrations/20260901213000_media_cache_producer_leases_v1.sql',
), 'utf8');

test('distributed media cache singleflight exposes one leader, followers and one ready result', () => {
  assert.match(migration, /create table public\.media_cache_producer_leases/);
  assert.match(migration, /work_fingerprint text primary key/);
  assert.match(migration, /create table public\.media_cache_work_results/);
  assert.match(migration, /object_key text not null references public\.media_cache_objects/);
  assert.match(migration, /select 'ready'::text/);
  assert.match(migration, /select 'leader'::text/);
  assert.match(migration, /select 'follower'::text/);
  assert.match(migration, /on conflict \(work_fingerprint\) do nothing/);
  assert.match(migration, /follower_count = least\(1000000, lease\.follower_count \+ 1\)/);
});

test('producer ownership is renewable, stage-bound, preemptable and token checked', () => {
  assert.match(migration, /create or replace function public\.norva_renew_media_cache_producer/);
  assert.match(migration, /p_stage not in \('probing', 'producing', 'uploading', 'finalizing'\)/);
  assert.match(migration, /lease_token = p_lease_token/);
  assert.match(migration, /owner_instance_fingerprint = p_owner_instance_fingerprint/);
  assert.match(migration, /and not preempt_requested/);
  assert.match(migration, /create or replace function public\.norva_preempt_media_cache_producers/);
  assert.match(migration, /where account_fingerprint = p_account_fingerprint/);
  assert.match(migration, /set preempt_requested = true/);
});

test('only a ready non-quarantined object can atomically complete a producer lease', () => {
  const complete = migration.slice(
    migration.indexOf('create or replace function public.norva_complete_media_cache_producer'),
    migration.indexOf('create or replace function public.norva_abandon_media_cache_producer'),
  );
  assert.match(complete, /pg_advisory_xact_lock/);
  assert.match(complete, /object\.state = 'ready'/);
  assert.match(complete, /object\.quarantined_at is null/);
  assert.match(complete, /object\.expires_at > v_now/);
  assert.match(complete, /and not lease\.preempt_requested/);
  assert.match(complete, /insert into public\.media_cache_work_results/);
  assert.match(complete, /delete from public\.media_cache_producer_leases/);
});

test('lease tables and RPCs are service-only and contain no supplier-specific branch', () => {
  for (const table of ['media_cache_work_results', 'media_cache_producer_leases']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security;`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`));
  }
  for (const fn of [
    'norva_claim_media_cache_producer',
    'norva_renew_media_cache_producer',
    'norva_resolve_media_cache_work',
    'norva_preempt_media_cache_producers',
    'norva_complete_media_cache_producer',
    'norva_abandon_media_cache_producer',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role;`));
  }
  for (const forbidden of ['KING365', 'GOTV', 'STRNG', 'Promax', 'Opplex', 'Airysat', 'provider_name']) {
    assert.equal(migration.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});
