'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('terminal Didit results enqueue encrypted deletion atomically', () => {
  const migration = read(
    'supabase/migrations/20260804093000_partners_didit_purge_outbox.sql',
  );
  const webhook = read(
    'supabase/functions/norva-partners-kyc-webhook/index.ts',
  );
  const memberEdge = read('supabase/functions/norva-partners/index.ts');
  const envelope = read(
    'supabase/functions/_shared/didit-purge-envelope.ts',
  );

  assert.match(migration, /affiliate_didit_purge_outbox/);
  assert.match(migration, /affiliate_didit_purge_events_append_only/);
  assert.match(
    migration,
    /partners_service_kyc_webhook_apply_and_enqueue_purge/,
  );
  assert.match(
    migration,
    /partners_service_kyc_certification_webhook_apply_and_enqueue_purge/,
  );
  const aliasMigration = read(
    'supabase/migrations/20260810150039_partners_didit_certification_rpc_alias.sql',
  );
  assert.match(
    aliasMigration,
    /rename to partners_service_kyc_certification_webhook_apply_purge/,
  );
  assert.match(
    webhook,
    /partners_service_kyc_certification_webhook_apply_purge/,
  );
  assert.doesNotMatch(
    webhook,
    /partners_service_kyc_certification_webhook_apply_and_enqueue_purge/,
  );
  assert.match(migration, /provider_purge_status = 'purge_pending'/);
  assert.match(migration, /provider_session_envelope = null/);
  assert.match(
    migration,
    /\[A-Za-z0-9_-\]\{22\}\[A-Za-z0-9_-\]\*\$/,
  );
  assert.doesNotMatch(migration, /\{22,384\}/);
  assert.match(migration, /provider_purged_at/);
  assert.match(migration, /status = 'waiting_terminal'/);
  assert.match(
    migration,
    /when 'waiting_terminal' then 'not_required'/,
  );
  assert.match(
    migration,
    /where outbox\.status in \('pending', 'retry'\)[\s\S]*for update skip locked/,
  );
  assert.match(migration, /partners_didit_purge_stage_member/);
  assert.match(migration, /partners_didit_purge_activate_staged/);
  assert.match(
    migration,
    /v_outbox\.status = 'waiting_terminal'[\s\S]*'terminal_webhook'/,
  );
  assert.match(webhook, /encryptDiditPurgeEnvelope/);
  assert.match(webhook, /p_provider_session_envelope/);
  assert.doesNotMatch(webhook, /console\.(?:log|error|warn)\([^)]*providerSessionId/);
  assert.match(envelope, /AES-GCM/);
  assert.match(envelope, /norva:partners:didit-purge:v1:/);
  assert.match(memberEdge, /encryptDiditPurgeEnvelope/);
  assert.match(memberEdge, /p_provider_session_envelope: providerSessionEnvelope/);
  assert.match(memberEdge, /session_disposition === "withdrawn"/);
  assert.doesNotMatch(
    memberEdge,
    /session_disposition === "withdrawn"[\s\S]{0,500}url: providerSession\.hostedUrl/,
  );
});

test('Didit deletion is bounded, idempotent, observable and fail closed', () => {
  const migration = read(
    'supabase/migrations/20260804093000_partners_didit_purge_outbox.sql',
  );
  const provider = read('supabase/functions/_shared/didit-partners.ts');
  const worker = read(
    'supabase/functions/norva-partners-didit-purge-worker/index.ts',
  );
  const preflight = read(
    'ops/hetzner/scripts/check-norva-partners-pilot-preactivation.sql',
  );
  const cron = read(
    'ops/hetzner/scripts/register-norva-partners-didit-purge-cron.sql',
  );

  assert.match(provider, /response\.status === 204/);
  assert.match(provider, /response\.status === 404/);
  assert.match(provider, /provider_rate_limited/);
  assert.match(migration, /for update skip locked/);
  assert.match(migration, /attempt_count \+ 1, 12/);
  assert.match(migration, /status = 'dead_letter'/);
  assert.match(
    migration,
    /guard_account_activation_until_didit_purged/,
  );
  assert.match(migration, /partners_didit_purge_coverage_ready/);
  assert.match(
    migration,
    /affiliate_didit_purge_worker_state worker[\s\S]*left join affiliate_private\.affiliate_didit_purge_outbox outbox on true/,
  );
  assert.match(worker, /NORVA_PARTNERS_DIDIT_PURGE_BATCH/);
  assert.match(worker, /NORVA_PARTNERS_DIDIT_PURGE_MAX_BATCHES/);
  assert.match(worker, /partners_service_didit_purge_heartbeat/);
  assert.match(worker, /orphaned_source_dead_letter/);
  assert.match(worker, /orphaned dead letters/);
  assert.match(
    migration,
    /missing_outbox\.source_record_id = source\.source_record_id[\s\S]*missing_outbox\.provider_environment =[\s\S]*source\.provider_environment[\s\S]*missing_outbox\.session_purpose = source\.session_purpose/,
  );
  assert.match(preflight, /didit\.purge_outbox_clear/);
  assert.match(preflight, /didit\.orphaned_source_dead_letter/);
  assert.match(preflight, /didit\.pending_member_purge_coverage/);
  assert.match(
    preflight,
    /outbox\.provider_environment = session\.provider_environment/,
  );
  assert.match(preflight, /didit\.purge_worker_heartbeat/);
  assert.match(cron, /\* \* \* \* \*/);
  assert.match(cron, /norva-partners-didit-purge-worker\/cron\/run/);
});

test('historical Didit purge orphans are recovered without exposing provider data', () => {
  const recoveryMigration = read(
    'supabase/migrations/20260811074511_partners_didit_orphan_purge_recovery.sql',
  );
  const sharedWorker = read(
    'supabase/functions/_shared/didit-purge-worker.ts',
  );
  const worker = read(
    'supabase/functions/norva-partners-didit-purge-worker/index.ts',
  );

  assert.match(
    recoveryMigration,
    /partners_service_didit_purge_orphans\(text, integer\)/,
  );
  assert.match(
    recoveryMigration,
    /partners_service_didit_purge_recover\(text, text, text\)/,
  );
  assert.match(recoveryMigration, /p_limit not between 1 and 5/);
  assert.match(recoveryMigration, /'certification'::text as session_purpose/);
  assert.doesNotMatch(
    recoveryMigration,
    /'programme_certification'::text as session_purpose/,
  );
  assert.match(
    recoveryMigration,
    /partners_didit_purge_enqueue\([\s\S]*p_provider_session_id,[\s\S]*p_provider_session_envelope/,
  );
  assert.match(
    recoveryMigration,
    /from public, anon, authenticated, service_role;[\s\S]*to service_role;/,
  );
  assert.doesNotMatch(recoveryMigration, /owner to supabase_admin/);
  assert.match(
    recoveryMigration,
    /procedure_row\.proowner = current_user::regrole/,
  );
  assert.match(sharedWorker, /DIDIT_LIST_MAX_PAGES = 4/);
  assert.match(sharedWorker, /DIDIT_LIST_PAGE_SIZE = 25/);
  assert.match(sharedWorker, /DIDIT_LIST_TIMEOUT_MS = 8_000/);
  assert.match(sharedWorker, /readBoundedDiditResponseBody/);
  assert.match(sharedWorker, /redirect: "error"/);
  assert.match(sharedWorker, /session_kind", "user"/);
  assert.match(sharedWorker, /workflow_id", config\.workflowId/);
  assert.doesNotMatch(
    sharedWorker,
    /searchParams\.set\("status"/,
    'historical provider status must not hide a reviewed terminal session',
  );
  assert.match(sharedWorker, /TERMINAL_DIDIT_PURGE_STATUSES/);
  assert.match(
    sharedWorker,
    /diditProviderSessionHash\([\s\S]*TERMINAL_DIDIT_PURGE_STATUSES\.has/,
    'recovery requires both an exact one-way hash and current terminal status',
  );
  assert.match(sharedWorker, /encryptDiditPurgeEnvelope/);
  assert.match(worker, /partners_service_didit_purge_orphans/);
  assert.match(worker, /partners_service_didit_purge_recover/);
  assert.match(worker, /orphan_pending/);
  assert.match(worker, /orphan_recovery_error/);
  assert.doesNotMatch(
    worker,
    /console\.(?:log|info|error|warn)\([^)]*(?:providerSessionId|providerSessionHash|providerSessionEnvelope)/,
  );
});

test('final enforcement retires all reducers that can omit the purge envelope', () => {
  const enforcement = read(
    'supabase/migrations/20260804170000_partners_biometric_consent_enforcement.sql',
  );
  assert.match(
    enforcement,
    /public\.partners_service_kyc_session_record_v2\([\s\S]*from service_role/,
  );
  assert.match(
    enforcement,
    /pending Didit sessions are missing durable purge coverage/,
  );
  assert.match(
    enforcement,
    /session\.status = 'pending'[\s\S]*affiliate_didit_purge_outbox/,
  );
  for (const reducer of [
    'affiliate_private.partners_service_kyc_webhook_apply',
    'public.partners_service_kyc_webhook_apply',
    'affiliate_private.partners_service_kyc_certification_webhook_apply',
    'public.partners_service_kyc_certification_webhook_apply',
  ]) {
    assert.match(
      enforcement,
      new RegExp(
        reducer.replaceAll('.', '\\.') +
          '\\([\\s\\S]*?boolean, boolean, boolean, text, text, text[\\s\\S]*?from service_role',
      ),
    );
  }
});

test('documented individual webhooks may omit session_kind but KYB fails closed', () => {
  const provider = read('supabase/functions/_shared/didit-partners.ts');
  const providerTests = read(
    'supabase/functions/_shared/didit-partners.test.ts',
  );

  assert.match(
    provider,
    /raw\.session_kind !== undefined && raw\.session_kind !== null/,
  );
  assert.match(provider, /hasDiditBusinessMarker\(raw\)/);
  assert.match(provider, /normalized\.includes\("kyb"\)/);
  assert.match(providerTests, /session_kind: undefined/);
  assert.match(providerTests, /workflow_type: "kyb"/);
  assert.match(
    providerTests,
    /documented individual KYC webhooks may omit session_kind/,
  );
});
