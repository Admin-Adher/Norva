'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migrationPath =
  'supabase/migrations/20260810201500_partners_didit_review_recovery.sql';
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
