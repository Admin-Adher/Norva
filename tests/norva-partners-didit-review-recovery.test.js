'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migrationPath =
  'supabase/migrations/20260810201500_partners_didit_review_recovery.sql';
const signedGraceMigrationPath =
  'supabase/migrations/20260810230928_partners_didit_signed_review_grace.sql';
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');

test('Didit manual review continuation is signed, exact and fail closed', () => {
  const migration = read(migrationPath);
  const provider = read('supabase/functions/_shared/didit-partners.ts');
  const webhook = read(
    'supabase/functions/norva-partners-kyc-webhook/index.ts',
  );

  assert.match(
    provider,
    /webhookType: "status\.updated" \| "data\.updated"/,
  );
  assert.match(
    provider,
    /webhookType !== "status\.updated" && webhookType !== "data\.updated"/,
  );
  assert.match(
    provider,
    /result\?\.status === "In Review"[\s\S]*providerStatus = "in_review"/,
  );
  assert.match(
    webhook,
    /certificationReviewUpdate = event\.webhookType === "data\.updated"/,
  );
  assert.match(webhook, /`data\.updated:\$\{event\.providerEventId\}`/);
  assert.match(webhook, /certification_review_update_ignored/);

  assert.match(
    migration,
    /v_is_review_update[\s\S]*\^data\\\.updated:/,
  );
  assert.match(
    migration,
    /v_session\.status <> 'in_review'[\s\S]*v_session\.provider_status <> 'in_review'/,
  );
  assert.match(
    migration,
    /v_session\.provider_workflow_hash <> v_workflow_hash[\s\S]*v_session\.provider_config_fingerprint <> v_fingerprint/,
  );
  assert.match(
    migration,
    /v_session\.expires_at <= now\(\)[\s\S]*p_event_created_at > v_session\.expires_at[\s\S]*p_event_created_at <= v_session\.last_event_created_at/,
  );
  assert.match(
    migration,
    /event\.provider_status = 'in_review'[\s\S]*event\.processing_outcome = 'applied'/,
  );
  assert.match(
    migration,
    /v_provider_status = 'approved'[\s\S]*p_id_check_approved is true[\s\S]*p_liveness_approved is true[\s\S]*p_face_match_approved is true/,
  );
});

test('Didit manual review continuation preserves terminal purge semantics', () => {
  const migration = read(migrationPath);

  assert.match(
    migration,
    /partners_service_kyc_certification_webhook_apply\([\s\S]*partners_didit_purge_enqueue\(/,
  );
  assert.doesNotMatch(
    migration,
    /update affiliate_private\.affiliate_didit_certification_events/,
  );
  assert.doesNotMatch(
    migration,
    /old\.status = 'quarantined'[\s\S]*new\.status = 'approved'/,
  );
  assert.doesNotMatch(
    migration,
    /update affiliate_private\.affiliate_didit_purge_outbox/,
  );
  assert.match(
    migration,
    /'purge_status', v_purge_status/,
  );
});

test('Didit manual review continuation does not widen the public Data API', () => {
  const migration = read(migrationPath);

  assert.doesNotMatch(migration, /create or replace function\s+public\./i);
  assert.doesNotMatch(migration, /grant\s+execute/i);
  assert.match(
    migration,
    /partners_service_kyc_certification_webhook_apply_and_enqueue_pu/,
  );
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = ''/);
});

test('Didit terminal review recovery binds a fresh signed delivery to a bounded grace', () => {
  const migration = read(signedGraceMigrationPath);
  const provider = read('supabase/functions/_shared/didit-partners.ts');
  const webhook = read(
    'supabase/functions/norva-partners-kyc-webhook/index.ts',
  );

  assert.match(provider, /providerDeliveredAt: string/);
  assert.match(
    provider,
    /providerDeliveredAt: new Date\(timestamp \* 1_000\)\.toISOString\(\)/,
  );
  assert.match(
    webhook,
    /partners_service_didit_cert_review_apply_purge/,
  );
  assert.match(
    webhook,
    /p_provider_delivered_at: event\.providerDeliveredAt/,
  );
  assert.match(
    migration,
    /p_provider_delivered_at < statement_timestamp\(\) - interval '10 minutes'/,
  );
  assert.match(
    migration,
    /statement_timestamp\(\) > v_session\.expires_at \+ interval '24 hours'/,
  );
  assert.match(
    migration,
    /p_event_created_at < v_session\.last_event_created_at/,
  );
  assert.doesNotMatch(
    migration,
    /p_event_created_at <= v_session\.last_event_created_at/,
  );
  assert.match(
    migration,
    /event\.provider_status = 'in_review'[\s\S]*event\.processing_outcome = 'applied'[\s\S]*event\.provider_event_created_at = v_session\.last_event_created_at/,
  );
  assert.match(
    migration,
    /v_provider_status not in \([\s\S]*'approved'[\s\S]*'declined'[\s\S]*'kyc_expired'/,
  );
});

test('Didit terminal review recovery is service-only, non-overloaded and purge atomic', () => {
  const migration = read(signedGraceMigrationPath);

  assert.match(
    migration,
    /public\.partners_service_didit_cert_review_apply_purge\(/,
  );
  assert.doesNotMatch(
    migration,
    /public\.partners_service_kyc_certification_webhook_apply_purge\([\s\S]*p_provider_delivered_at/,
  );
  assert.match(migration, /security definer[\s\S]*set search_path = ''/);
  assert.match(migration, /security invoker[\s\S]*set search_path = ''/);
  assert.match(
    migration,
    /revoke all on function[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /grant execute on function[\s\S]*to service_role/,
  );
  assert.match(
    migration,
    /insert into affiliate_private\.affiliate_didit_certification_events[\s\S]*provider_delivered_at[\s\S]*update affiliate_private\.affiliate_didit_certification_sessions[\s\S]*partners_didit_purge_enqueue/,
  );
  assert.doesNotMatch(
    migration,
    /update affiliate_private\.affiliate_didit_certification_events/,
  );
});
