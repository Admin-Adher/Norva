const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const migration = read(
  'supabase/migrations/20260724162250_lid_cascade_canary_lease_reliability.sql',
);
const admin = read('supabase/functions/norva-admin/index.ts');

const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing start marker: ${start}`);
  assert.ok(to > from, `missing end marker: ${end}`);
  return source.slice(from, to);
};

test('LID canary renewal is a bounded seven-day service-role operation', () => {
  const renewal = between(
    migration,
    'create or replace function public.renew_audio_lid_cascade_canary(',
    '\nrevoke all on function public.renew_audio_lid_cascade_canary(text)',
  );

  assert.match(renewal, /pg_advisory_xact_lock/);
  assert.match(renewal, /v_new_expires_at := v_now \+ interval '7 days'/);
  assert.match(
    renewal,
    /v_policy\.expires_at > v_now \+ interval '24 hours'/,
  );
  assert.match(renewal, /lease is not yet within its renewal window/);
  assert.match(renewal, /v_policy\.canary_bps not between 1 and 1000/);
  assert.match(renewal, /v_policy\.daily_cap not between 1 and 100/);
  assert.match(renewal, /coalesce\(btrim\(v_policy\.rollout_seed\), ''\) = ''/);
  assert.match(renewal, /v_stage_count <> 1/);
  for (const guard of [
    'not v_audio_enabled',
    'not v_canary_enabled',
    'v_shadow_enabled',
    'v_primary_enabled',
    'v_tagged_enabled',
    'v_detect_shadow_enabled',
    'v_detect_primary_enabled',
  ]) assert.ok(renewal.includes(guard), `missing renewal guard: ${guard}`);

  assert.match(
    migration,
    /revoke all on function public\.renew_audio_lid_cascade_canary\(text\)[\s\S]*from public, anon, authenticated;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.renew_audio_lid_cascade_canary\(text\)[\s\S]*to service_role;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.renew_audio_lid_cascade_canary\(text\)[\s\S]{0,80}to (anon|authenticated)/i,
  );

  // Renewal changes only the expiry. Cohort size, cap and rollout flags remain
  // explicit operator configuration and can never be raised by this RPC.
  const policyUpdate = between(
    renewal,
    'update public.audio_lid_cascade_policy',
    '\n\n  insert into public.audio_lid_cascade_lease_audit',
  );
  assert.match(policyUpdate, /set expires_at = v_new_expires_at/);
  assert.doesNotMatch(policyUpdate, /canary_bps\s*=/);
  assert.doesNotMatch(policyUpdate, /daily_cap\s*=/);
  assert.doesNotMatch(renewal, /update public\.admin_feature_flags/);
});

test('LID lease renewals are append-only, minimally exposed and fully auditable', () => {
  assert.match(
    migration,
    /create table if not exists public\.audio_lid_cascade_lease_audit/,
  );
  for (const field of [
    'previous_expires_at',
    'new_expires_at',
    'lease_days',
    'canary_bps',
    'daily_cap',
    'renewed_at',
    'actor_kind',
    'reason',
  ]) assert.ok(migration.includes(field), `missing audit field: ${field}`);
  assert.match(
    migration,
    /before update or delete on public\.audio_lid_cascade_lease_audit/,
  );
  assert.match(
    migration,
    /raise exception 'audio_lid_cascade_lease_audit is append-only'/,
  );
  assert.match(
    migration,
    /alter table public\.audio_lid_cascade_lease_audit enable row level security/,
  );
  assert.match(
    migration,
    /revoke all on table public\.audio_lid_cascade_lease_audit[\s\S]*from public, anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /grant select on table public\.audio_lid_cascade_lease_audit to service_role;/,
  );
  assert.doesNotMatch(
    migration,
    /grant (select|insert|update|delete)[\s\S]{0,100}audio_lid_cascade_lease_audit[\s\S]{0,80}to (anon|authenticated)/i,
  );
});

test('initial activation only renews an already-safe expired or expiring canary', () => {
  const initial = between(
    migration,
    '-- Reactivate only a canary that is already configured safely.',
    "\nnotify pgrst, 'reload schema';",
  );
  assert.match(initial, /v_health->>'state' in \('expired', 'expiring'\)/);
  assert.match(initial, /public\.renew_audio_lid_cascade_canary/);
  assert.doesNotMatch(initial, /update public\.admin_feature_flags/);
  assert.doesNotMatch(initial, /insert into public\.admin_feature_flags/);
  assert.doesNotMatch(initial, /'active'/);
});

test('LID lease health distinguishes active, expiring, expired and conflicts', () => {
  const health = between(
    migration,
    'create or replace function public.audio_lid_cascade_lease_health()',
    '\nrevoke all on function public.audio_lid_cascade_lease_health()',
  );
  for (const state of ['active', 'expiring', 'expired', 'conflict']) {
    assert.ok(health.includes(`'${state}'`), `missing health state: ${state}`);
  }
  assert.match(health, /v_policy\.expires_at <= v_now \+ interval '24 hours'/);
  assert.match(health, /v_stage_count <> 1/);
  assert.match(health, /coalesce\(btrim\(v_policy\.rollout_seed\), ''\) = ''/);
  assert.match(health, /'secondsRemaining'/);
  assert.match(health, /'lastRenewedAt'/);
  assert.match(
    migration,
    /grant execute on function public\.audio_lid_cascade_lease_health\(\)[\s\S]*to service_role;/,
  );
});

test('admin health and ops sweep expose only sanitized lease state and alert before expiry', () => {
  const reader = between(
    admin,
    'async function readLidCascadeLeaseHealth()',
    '\n// ── Proactive ops alerting',
  );
  assert.match(reader, /admin\.rpc\("audio_lid_cascade_lease_health"\)/);
  for (const state of ['active', 'expiring', 'expired', 'conflict']) {
    assert.ok(reader.includes(`"${state}"`), `admin does not accept ${state}`);
  }
  assert.doesNotMatch(reader, /\.\.\.raw/);
  assert.match(reader, /reason: "health-unavailable"/);

  for (const alert of [
    'lid_cascade_expiring',
    'lid_cascade_expired',
    'lid_cascade_conflict',
  ]) assert.ok(admin.includes(`key: "${alert}"`), `missing ops alert ${alert}`);
  assert.match(admin, /remainingHours/);
  const dispatcher = fs.readFileSync(path.join(root, 'supabase/functions/_shared/ops-notifications.ts'), 'utf8');
  assert.ok(dispatcher.includes("lidActive && s.key.startsWith('lid_cascade_')"));
  assert.match(admin, /lid_cascade: lidCascade/);
  assert.match(
    admin,
    /readLidCascadeLeaseHealth\(\)[\s\S]*lid_cascade: lidCascade/,
  );
});
