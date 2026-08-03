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
const providerMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260802235933_provider_suppression_remediation.sql',
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

test('provider remediation is owner-only in a non-exposed schema', () => {
  assert.match(providerMigration, /create schema if not exists email_private/i);
  assert.match(
    providerMigration,
    /revoke all on schema email_private from public, anon, authenticated, service_role/i,
  );
  assert.match(
    providerMigration,
    /revoke all on function email_private\.norva_resolve_provider_email_suppression\([\s\S]*?from public, anon, authenticated, service_role/i,
  );
  assert.doesNotMatch(
    providerMigration,
    /grant execute on function email_private\.norva_resolve_provider_email_suppression/i,
  );
  assert.doesNotMatch(providerMigration, /notify pgrst/i);
});

test('provider remediation requires the current confirmed usable Auth address', () => {
  assert.match(providerMigration, /v_user\.email <> v_email/);
  assert.match(providerMigration, /v_user\.email_confirmed_at is null/);
  assert.match(providerMigration, /v_user\.deleted_at is not null/);
  assert.match(providerMigration, /v_user\.banned_until[\s\S]*v_now/);
  assert.match(providerMigration, /from auth\.users u[\s\S]*where u\.id = p_user_id[\s\S]*for share/);
  assert.match(providerMigration, /where s\.email = v_email[\s\S]*for update/);
});

test('provider remediation remains fail-closed for complaints and non-provider rows', () => {
  assert.match(providerMigration, /v_suppression\.complaint_seen_at is not null/);
  assert.match(providerMigration, /v_suppression\.provider_suppression_seen_at is null/);
  assert.match(providerMigration, /v_source_event\.event_type <> 'email\.suppressed'/);
  assert.match(
    providerMigration,
    /v_source_event\.occurred_at is distinct from v_suppression\.provider_suppression_seen_at/,
  );
});

test('provider remediation consumes one fresh post-suppression delivered message', () => {
  assert.match(providerMigration, /e\.event_type = 'email\.delivered'/);
  assert.match(providerMigration, /v_email = any\(e\.to_emails\)/);
  assert.match(providerMigration, /@norva\\\.tv/);
  assert.match(providerMigration, /v_delivery_event\.provider_email_id = v_suppression\.source_email_id/);
  assert.match(
    providerMigration,
    /v_delivery_event\.occurred_at <= greatest\([\s\S]*provider_suppression_seen_at[\s\S]*last_seen_at/,
  );
  assert.match(providerMigration, /v_delivery_event\.received_at <= greatest\(/);
  assert.match(providerMigration, /v_now - interval '24 hours'/);
  assert.match(providerMigration, /v_now \+ interval '5 minutes'/);
  assert.match(providerMigration, /a newer hard delivery event prevents provider remediation/);
});

test('provider remediation is audited, single-use and concurrency-safe', () => {
  assert.match(providerMigration, /provider_post_remediation_delivery/);
  assert.match(providerMigration, /resend_delivery:/);
  assert.match(
    providerMigration,
    /insert into public\.cloud_email_suppression_resolution_audit[\s\S]*update public\.cloud_email_suppressions/,
  );
  assert.match(providerMigration, /get diagnostics v_updated = row_count/);
  assert.match(providerMigration, /v_updated <> 1/);
  assert.match(providerMigration, /using errcode = '40001'/);
  assert.doesNotMatch(providerMigration, /cloud_marketing_email_preferences/);
  assert.doesNotMatch(providerMigration, /marketing_email_opt_in/);
});

test('append-only retention is private, age-bounded and keeps public prune semantics', () => {
  assert.match(
    providerMigration,
    /current_setting\('norva\.email_suppression_audit_retention', true\) = 'v1'/,
  );
  assert.match(providerMigration, /tg_op = 'DELETE'/);
  assert.match(providerMigration, /old\.resolved_at < clock_timestamp\(\) - interval '400 days'/);
  assert.match(
    providerMigration,
    /email_private\.norva_prune_email_suppression_resolution_audit\(\)[\s\S]*set_config\('norva\.email_suppression_audit_retention', 'v1', true\)/,
  );
  assert.match(
    providerMigration,
    /set_config\('norva\.email_suppression_audit_retention', '', true\)/,
  );
  assert.match(
    providerMigration,
    /revoke all on function email_private\.norva_prune_email_suppression_resolution_audit\(\)[\s\S]*from public, anon, authenticated, service_role/i,
  );
  assert.match(
    providerMigration,
    /perform email_private\.norva_prune_email_suppression_resolution_audit\(\)/,
  );
  assert.match(
    providerMigration,
    /grant execute on function public\.norva_prune_resend_delivery_events\(\)[\s\S]*to service_role/i,
  );
  assert.match(
    providerMigration,
    /revoke insert, update, delete, truncate[\s\S]*cloud_email_suppression_resolution_audit[\s\S]*from service_role/i,
  );
});
