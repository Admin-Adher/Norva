const test = require('node:test');
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const userId = '11111111-2222-4333-8444-555555555555';
const now = new Date('2026-07-29T14:32:00.000Z');

if (!globalThis.crypto) globalThis.crypto = cryptoNode.webcrypto;

let financeModule;
async function finance() {
  if (!financeModule) {
    financeModule = await import(pathToFileURL(
      path.join(root, 'supabase/functions/_shared/partners-finance.mjs'),
    ).href);
  }
  return financeModule;
}

test('RevenueCat financial mapping is table-driven and fail-closed on money', async () => {
  const { revenueCatPartnerObservation } = await finance();
  const cases = [
    {
      label: 'Google Play initial purchase',
      type: 'INITIAL_PURCHASE',
      event: {
        id: 'rc_evt_initial',
        transaction_id: 'gpa.1234',
        store: 'PLAY_STORE',
        environment: 'PRODUCTION',
        currency: 'usd',
        price_in_purchased_currency: 4.99,
        event_timestamp_ms: now.getTime(),
      },
      expected: { eventType: 'capture', rail: 'google_play', parentTransactionId: null },
    },
    {
      label: 'RevenueCat renewal',
      type: 'RENEWAL',
      event: {
        id: 'rc_evt_renewal',
        transaction_id: 'rc_renewal_1',
        store: 'RC_BILLING',
        environment: 'SANDBOX',
        currency: 'EUR',
        price: 5.99,
        event_timestamp_ms: now.getTime(),
      },
      expected: { eventType: 'renewal', rail: 'revenuecat', environment: 'sandbox' },
    },
    {
      label: 'support refund',
      type: 'CANCELLATION',
      event: {
        id: 'rc_refund_1',
        transaction_id: 'rc_capture_1',
        original_transaction_id: 'rc_capture_1',
        cancel_reason: 'CUSTOMER_SUPPORT',
        store: 'PLAY_STORE',
        currency: 'USD',
        event_timestamp_ms: now.getTime(),
      },
      expected: { eventType: 'refund', parentTransactionId: 'rc_capture_1' },
    },
    {
      label: 'transfer',
      type: 'TRANSFER',
      event: {
        id: 'rc_transfer_1',
        store: 'PLAY_STORE',
        event_timestamp_ms: now.getTime(),
      },
      expected: {
        eventType: 'transfer',
        transactionId: 'rc_transfer_1',
        parentTransactionId: null,
      },
    },
  ];

  for (const entry of cases) {
    const observation = revenueCatPartnerObservation(entry.type, entry.event, userId, now);
    assert.ok(observation, entry.label);
    assert.equal(observation.eventType, entry.expected.eventType, entry.label);
    if (entry.expected.rail) assert.equal(observation.rail, entry.expected.rail, entry.label);
    if (entry.expected.environment) {
      assert.equal(observation.environment, entry.expected.environment, entry.label);
    }
    if (entry.expected.transactionId) {
      assert.equal(observation.transactionId, entry.expected.transactionId, entry.label);
    }
    if ('parentTransactionId' in entry.expected) {
      assert.equal(observation.parentTransactionId, entry.expected.parentTransactionId, entry.label);
    }
    assert.equal(observation.currencyExponent, null, entry.label);
    assert.equal(observation.grossMinor, null, entry.label);
    assert.equal(observation.discountMinor, null, entry.label);
    assert.equal(observation.taxMinor, null, entry.label);
    assert.equal(observation.eligibleMinor, null, entry.label);
  }

  assert.equal(
    revenueCatPartnerObservation(
      'CANCELLATION',
      { id: 'not_refund', cancel_reason: 'UNSUBSCRIBE' },
      userId,
      now,
    ),
    null,
  );
  assert.throws(
    () => revenueCatPartnerObservation(
      'TRANSFER',
      { transferred_to: [userId], event_timestamp_ms: now.getTime() },
      userId,
      now,
    ),
    /partners_fact_missing_transaction/,
  );
  assert.throws(
    () => revenueCatPartnerObservation(
      'RENEWAL',
      {
        id: 'event_is_not_a_transaction',
        original_transaction_id: 'shared_subscription_origin',
        event_timestamp_ms: now.getTime(),
      },
      userId,
      now,
    ),
    /partners_fact_missing_transaction/,
  );
  assert.throws(
    () => revenueCatPartnerObservation(
      'CANCELLATION',
      {
        id: 'refund_without_parent',
        cancel_reason: 'CUSTOMER_SUPPORT',
        event_timestamp_ms: now.getTime(),
      },
      userId,
      now,
    ),
    /partners_fact_missing_parent/,
  );
  assert.equal(revenueCatPartnerObservation('REFUND_REVERSED', {}, userId, now), null);
});

test('Revolut maps only settled economic orders and never invents components', async () => {
  const { revolutPartnerObservation } = await finance();
  const cases = [
    { kind: 'first_charge', order: { id: 'ord_1', state: 'COMPLETED', amount: 499, currency: 'USD' }, type: 'capture' },
    { kind: 'resubscribe', order: { id: 'ord_2', state: 'COMPLETED', amount: 499, currency: 'USD' }, type: 'capture' },
    { kind: 'renewal', order: { id: 'ord_3', state: 'COMPLETED', amount: 599, currency: 'EUR' }, type: 'renewal' },
    {
      kind: null,
      order: {
        id: 'ref_1', type: 'refund', state: 'COMPLETED', related_order_id: 'ord_1',
        amount: 200, currency: 'USD',
      },
      type: 'refund',
      parent: 'ord_1',
    },
    {
      kind: null,
      order: {
        id: 'cb_1', type: 'chargeback', state: 'COMPLETED', related_order_id: 'ord_2',
        amount: 499, currency: 'USD',
      },
      type: 'chargeback',
      parent: 'ord_2',
    },
  ];

  for (const entry of cases) {
    const observation = revolutPartnerObservation({
      order: entry.order,
      referredUserId: userId,
      kind: entry.kind,
      environment: 'production',
    }, now);
    assert.ok(observation);
    assert.equal(observation.eventType, entry.type);
    assert.equal(observation.rail, 'web');
    assert.equal(observation.grossMinor, entry.order.amount);
    assert.equal(observation.parentTransactionId, entry.parent ?? null);
    assert.equal(observation.currencyExponent, null);
    assert.equal(observation.discountMinor, null);
    assert.equal(observation.taxMinor, null);
    assert.equal(observation.eligibleMinor, null);
  }

  assert.equal(revolutPartnerObservation({
    order: { id: 'pending', state: 'PROCESSING', amount: 499, currency: 'USD' },
    referredUserId: userId,
    kind: 'renewal',
  }, now), null);
  assert.equal(revolutPartnerObservation({
    order: { id: 'validation', state: 'COMPLETED', amount: 10, currency: 'USD' },
    referredUserId: userId,
    kind: 'trial_setup',
  }, now), null);
});

test('Revolut DISPUTE_LOST maps one authoritative idempotent chargeback', async () => {
  const {
    partnerFinancialFactRpcArgs,
    revolutDisputePartnerObservation,
  } = await finance();
  const dispute = {
    id: 'dispute_lost_1',
    state: 'lost',
    amount: 499,
    currency: 'USD',
    updated_at: '2026-07-29T14:31:00Z',
    payment: {
      order_id: 'order_parent_1',
      amount: 499,
      currency: 'USD',
    },
  };
  const first = revolutDisputePartnerObservation({
    dispute,
    referredUserId: userId,
    environment: 'production',
  }, now);
  const replay = revolutDisputePartnerObservation({
    dispute: { ...dispute, updated_at: '2026-07-29T14:32:00Z' },
    referredUserId: userId,
    environment: 'production',
  }, now);

  assert.equal(first.eventType, 'chargeback');
  assert.equal(first.transactionId, 'dispute_lost_1');
  assert.equal(first.parentTransactionId, 'order_parent_1');
  assert.equal(first.grossMinor, 499);
  assert.equal(first.eligibleMinor, null);
  const firstArgs = await partnerFinancialFactRpcArgs(first);
  const replayArgs = await partnerFinancialFactRpcArgs(replay);
  assert.equal(firstArgs.p_source_event_hash, replayArgs.p_source_event_hash);
  assert.equal(firstArgs.p_payload_hash, replayArgs.p_payload_hash);
  assert.equal(JSON.stringify(firstArgs).includes('dispute_lost_1'), false);
  assert.equal(revolutDisputePartnerObservation({
    dispute: { ...dispute, state: 'under_review' },
    referredUserId: userId,
  }, now), null);
  assert.throws(
    () => revolutDisputePartnerObservation({
      dispute: { ...dispute, payment: {} },
      referredUserId: userId,
    }, now),
    /partners_dispute_missing_parent_order/,
  );
  assert.throws(
    () => revolutDisputePartnerObservation({
      dispute: {
        ...dispute,
        payment: { ...dispute.payment, currency: 'EUR' },
      },
      referredUserId: userId,
    }, now),
    /partners_dispute_currency_mismatch/,
  );
});

test('economic hashes deduplicate Revolut billing and webhook observations', async () => {
  const {
    partnerFinancialFactRpcArgs,
    revolutPartnerObservation,
  } = await finance();
  const fromBilling = revolutPartnerObservation({
    order: {
      id: 'order_shared_123',
      state: 'COMPLETED',
      amount: 499,
      currency: 'USD',
      updated_at: '2026-07-29T14:31:00Z',
    },
    referredUserId: userId,
    kind: 'renewal',
    environment: 'production',
  }, now);
  const fromWebhook = revolutPartnerObservation({
    order: {
      id: 'order_shared_123',
      state: 'COMPLETED',
      amount: 499,
      currency: 'USD',
      updated_at: '2026-07-29T14:32:00Z',
    },
    referredUserId: userId,
    kind: 'renewal',
    environment: 'production',
  }, now);

  const billingArgs = await partnerFinancialFactRpcArgs(fromBilling);
  const webhookArgs = await partnerFinancialFactRpcArgs(fromWebhook);
  assert.equal(billingArgs.p_source_event_hash, webhookArgs.p_source_event_hash);
  assert.equal(billingArgs.p_transaction_hash, webhookArgs.p_transaction_hash);
  assert.equal(billingArgs.p_payload_hash, webhookArgs.p_payload_hash);
  assert.match(billingArgs.p_source_event_hash, /^[0-9a-f]{64}$/);
  assert.match(billingArgs.p_transaction_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(billingArgs).includes('order_shared_123'), false);
});

test('ingest adapter validates the RPC envelope and accepts a durable conflict quarantine', async () => {
  const {
    ingestPartnerFinancialFact,
    revolutPartnerObservation,
  } = await finance();
  const observation = revolutPartnerObservation({
    order: { id: 'order_rpc_1', state: 'COMPLETED', amount: 499, currency: 'USD' },
    referredUserId: userId,
    kind: 'first_charge',
    environment: 'production',
  }, now);
  let captured;
  const successfulDb = {
    async rpc(name, args) {
      captured = { name, args };
      return {
        data: {
          schema_version: 1,
          action: 'financial_fact_ingested',
          replayed: false,
          fact: { key: 'fac_0123456789abcdef01234567', status: 'incomplete', job_status: null },
        },
        error: null,
      };
    },
  };
  const result = await ingestPartnerFinancialFact(successfulDb, observation);
  assert.equal(captured.name, 'partners_worker_financial_fact_ingest');
  assert.equal(captured.args.p_gross_minor, 499);
  assert.equal(captured.args.p_eligible_minor, null);
  assert.equal(result.fact.status, 'incomplete');

  const conflict = await ingestPartnerFinancialFact({
    async rpc() {
      return {
        data: {
          schema_version: 1,
          action: 'financial_fact_ingested',
          replayed: false,
          conflict: true,
          fact: {
            key: 'fac_0123456789abcdef01234567',
            status: 'quarantined',
            job_status: 'dead_letter',
          },
        },
        error: null,
      };
    },
  }, observation);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.fact.status, 'quarantined');

  await assert.rejects(
    ingestPartnerFinancialFact({
      async rpc() {
        return { data: null, error: { code: '08006', message: 'connection lost' } };
      },
    }, observation),
    /partners_fact_ingest_failed:08006/,
  );
  await assert.rejects(
    ingestPartnerFinancialFact({
      async rpc() {
        return { data: null, error: { code: 'P0003', message: 'identity conflict' } };
      },
    }, observation),
    /partners_fact_ingest_failed:P0003/,
  );
});

test('worker error policy is table-driven', async () => {
  const { classifyPartnersWorkerRpcFailure } = await finance();
  const cases = [
    ['P0004', 'retry'],
    ['22023', 'dead_letter'],
    ['23514', 'dead_letter'],
    ['55000', 'dead_letter'],
    ['P0006', 'dead_letter'],
    ['08006', 'retry'],
    ['unknown', 'retry'],
  ];
  for (const [code, outcome] of cases) {
    assert.equal(classifyPartnersWorkerRpcFailure({ code }).outcome, outcome, code);
  }
});

test('worker remains cron-authenticated, bounded and shadow-only', () => {
  const worker = read('supabase/functions/norva-partners-worker/index.ts');
  const config = read('supabase/config.toml');
  const cronRegistration = read(
    'ops/hetzner/scripts/register-norva-partners-cron.sql',
  );
  const adminMigration = read(
    'supabase/migrations/20260729201447_partners_tv_admin_analytics.sql',
  );

  assert.match(worker, /norva_verify_cron_secret/);
  assert.match(worker, /partners_worker_commission_jobs_lease/);
  assert.match(worker, /partners_worker_commission_job_complete/);
  assert.match(worker, /partners_worker_maturation_lease/);
  assert.match(worker, /partners_worker_maturation_complete/);
  assert.match(worker, /partners_worker_shadow_reconcile/);
  assert.match(worker, /partners_worker_heartbeat/);
  for (const workerName of ['commission', 'maturation', 'reconciliation']) {
    assert.match(
      worker,
      new RegExp(`runObservedTask\\([\\s\\S]{0,120}"${workerName}"`),
    );
  }
  assert.doesNotMatch(worker, /p_worker_name:\s*["']payout["']/);
  assert.match(worker, /p_dry_run:\s*true/);
  assert.match(worker, /NORVA_PARTNERS_WORKER_BATCH/);
  assert.match(worker, /,\s*20,\s*1,\s*50,\s*\)/);
  assert.doesNotMatch(worker, /\bfetch\s*\(/);
  assert.doesNotMatch(worker, /\.from\s*\(/);
  assert.match(config, /\[functions\.norva-partners-worker\]\s*\nverify_jwt = false/);
  assert.match(cronRegistration, /'norva-partners-worker'/);
  assert.match(cronRegistration, /'\*\/5 \* \* \* \*'/);
  assert.match(cronRegistration, /norva_cron_shared_secret/);
  assert.match(cronRegistration, /norva-partners-worker\/cron\/run/);
  assert.doesNotMatch(cronRegistration, /Bearer\s+[A-Za-z0-9._-]{24,}/);

  const monitoringSnapshot = adminMigration.slice(
    adminMigration.indexOf(
      'create or replace function affiliate_private.partners_ops_alert_snapshot()',
    ),
    adminMigration.indexOf(
      'create or replace function affiliate_private.admin_partners_monitoring()',
    ),
  );
  for (const workerName of ['commission', 'maturation', 'reconciliation']) {
    assert.match(
      monitoringSnapshot,
      new RegExp(`\\('${workerName}'::text\\)`),
    );
  }
  assert.doesNotMatch(monitoringSnapshot, /\('payout'::text\)/);
  assert.match(
    adminMigration,
    /admin_partners_monitoring\(\)[\s\S]*?return affiliate_private\.partners_ops_alert_snapshot\(\);/,
  );
});

test('database exposes only service-role worker wrappers and bounds retries', () => {
  const migration = read('supabase/migrations/20260729201430_partners_finance_maturation_payout.sql');
  const rpcNames = [
    'partners_worker_financial_observation_required',
    'partners_worker_currency_exponent_resolve',
    'partners_worker_financial_fact_ingest',
    'partners_worker_commission_jobs_lease',
    'partners_worker_commission_job_complete',
    'partners_worker_maturation_lease',
    'partners_worker_maturation_complete',
    'partners_worker_shadow_reconcile',
  ];

  for (const name of rpcNames) {
    assert.match(
      migration,
      new RegExp(`create or replace function\\s+public\\.${name}\\(`),
    );
    assert.match(
      migration,
      new RegExp(
        `grant execute on function\\s+public\\.${name}\\([\\s\\S]*?\\)\\s+to service_role;`,
      ),
    );
  }
  assert.match(migration, /create table affiliate_private\.affiliate_financial_fact_conflicts/);
  assert.match(migration, /financial_fact_conflict/);
  assert.match(migration, /attempts between 0 and 12/);
  assert.equal((migration.match(/v_outcome = 'retry' and v_job\.attempts >= 12/g) ?? []).length, 2);
  assert.equal((migration.match(/where attempts >= 12/g) ?? []).length, 2);
  assert.equal((migration.match(/and j\.attempts < 12/g) ?? []).length, 2);
  assert.match(
    migration,
    /v_event_type in \('refund', 'chargeback'\) and v_parent_hash is null/,
  );
  assert.match(
    migration,
    /and e\.entry_kind in \('reversal', 'manual_reversal'\)/,
  );
  const commissionCompletion = migration.slice(
    migration.indexOf(
      'affiliate_private.partners_worker_commission_job_complete(',
    ),
    migration.indexOf(
      'affiliate_private.partners_worker_maturation_lease(',
    ),
  );
  assert.match(
    commissionCompletion,
    /v_already_reversed[\s\S]*?e\.entry_kind in \('reversal', 'manual_reversal'\)/,
  );
  assert.match(migration, /v_over_reversed/);
  assert.match(migration, /p_dry_run boolean/);
});

test('all three authoritative billing producers call the shared financial adapter', () => {
  const revenueCat = read('supabase/functions/norva-billing-webhook/index.ts');
  const revolutWebhook = read('supabase/functions/norva-revolut-webhook/index.ts');
  const revolutBilling = read('supabase/functions/norva-revolut-billing/index.ts');

  assert.match(revenueCat, /revenueCatPartnerObservation/);
  assert.match(revenueCat, /await ingestPartnerFinancialFact\(admin, partnersObservation\)/);
  assert.match(revolutWebhook, /financial_event: "chargeback"/);
  assert.match(revolutWebhook, /eventType !== "DISPUTE_LOST"/);
  assert.match(revolutWebhook, /revolutDisputePartnerObservation/);
  assert.match(revolutWebhook, /\/api\/disputes\//);
  assert.match(revolutWebhook, /REVOLUT_DISPUTES_API_VERSION = "2026-04-20"/);
  assert.match(revolutWebhook, /dispute reversal financial contract is not configured/);
  assert.ok((revolutWebhook.match(/ingestPartnerFinancialFact/g) ?? []).length >= 4);
  assert.match(revolutBilling, /await ingestPartnerFinancialFact\(db, partnersObservation\)/);

  const ledgerWrite = revolutBilling.indexOf('billing_ledger_write_failed');
  const partnerWrite = revolutBilling.indexOf('await ingestPartnerFinancialFact(db, partnersObservation)');
  const entitlementApply = revolutBilling.indexOf('const applied = await applyBillingSuccess');
  assert.ok(ledgerWrite > -1 && partnerWrite > ledgerWrite && entitlementApply > partnerWrite);
});
