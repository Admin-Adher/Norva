import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260722005000_false_permanent_email_suppression_resolution.sql',
), 'utf8');

test('false permanent-bounce resolution is service-role only and direct writes are closed', () => {
  assert.match(migration, /revoke all on function public\.norva_resolve_false_permanent_email_suppression\([\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.norva_resolve_false_permanent_email_suppression\([\s\S]*?to service_role/i);
  assert.match(migration, /revoke all on table public\.cloud_email_suppressions from service_role/i);
  assert.match(migration, /grant select on table public\.cloud_email_suppressions to service_role/i);
});

test('resolution requires the current confirmed usable address and recent post-suppression proof', () => {
  assert.match(migration, /v_user\.email <> v_email/);
  assert.match(migration, /v_user\.email_confirmed_at is null/);
  assert.match(migration, /v_user\.deleted_at is not null/);
  assert.match(migration, /v_user\.banned_until[\s\S]*clock_timestamp\(\)/);
  assert.match(migration, /p_verified_at < clock_timestamp\(\) - interval '7 days'/);
  assert.match(migration, /p_verified_at < v_suppression\.last_seen_at/);
  assert.match(migration, /fresh_confirmation_link/);
  assert.match(migration, /verified_mailbox_reply/);
  assert.match(migration, /verification reference does not match the verification method/);
});

test('complaints and provider suppressions remain durable hard blocks', () => {
  assert.match(migration, /complaint_seen_at timestamptz/);
  assert.match(migration, /provider_suppression_seen_at timestamptz/);
  assert.match(migration, /new\.complaint_seen_at := greatest\(/);
  assert.match(migration, /new\.provider_suppression_seen_at := greatest\(/);
  assert.match(migration, /complaint suppressions cannot be resolved by this recovery path/);
  assert.match(migration, /provider suppressions require provider-side remediation/);
});

test('only a source permanent-bounce event qualifies and a later event can reactivate safety', () => {
  assert.match(migration, /v_source_event\.event_type <> 'email\.bounced'/);
  assert.match(migration, /diagnostic_data ->> 'type'[\s\S]*<> 'permanent'/);

  const delivery = fs.readFileSync(path.join(
    root,
    'supabase/migrations/20260721234000_resend_delivery_observability.sql',
  ), 'utf8');
  assert.match(delivery, /on conflict \(email\) do update set[\s\S]*active = true[\s\S]*resolved_at = null/);
});

test('resolution evidence is append-only, address-minimized and fully attributable', () => {
  assert.match(migration, /user_fingerprint text not null/);
  assert.match(migration, /extensions\.digest\('norva-user-resolution:v1:' \|\| p_user_id::text/);
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf('create table if not exists public.cloud_email_suppression_resolution_audit'),
      migration.indexOf('comment on table public.cloud_email_suppression_resolution_audit'),
    ),
    /\b(?:email|user_id)\s+(?:text|uuid)\b/,
  );
  assert.match(migration, /verification_method text not null/);
  assert.match(migration, /verification_reference text not null unique/);
  assert.match(migration, /resolution_reason text not null/);
  assert.match(migration, /operator_actor text not null/);
  assert.match(migration, /before update or delete on public\.cloud_email_suppression_resolution_audit/);
  assert.match(migration, /raise exception 'email suppression resolution audit is append-only'/);
});
