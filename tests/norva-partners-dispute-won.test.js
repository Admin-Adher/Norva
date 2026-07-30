const test = require("node:test");
const assert = require("node:assert/strict");
const cryptoNode = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const read = (file) =>
  fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const userId = "11111111-2222-4333-8444-555555555555";
const now = new Date("2026-07-30T08:12:00.000Z");

if (!globalThis.crypto) globalThis.crypto = cryptoNode.webcrypto;

let financeModule;
async function finance() {
  if (!financeModule) {
    financeModule = await import(
      pathToFileURL(
        path.join(root, "supabase/functions/_shared/partners-finance.mjs"),
      ).href
    );
  }
  return financeModule;
}

function wonDispute(overrides = {}) {
  return {
    id: "dispute_economic_identity_1",
    state: "won",
    amount: 499,
    currency: "USD",
    updated_at: "2026-07-30T08:11:00.000Z",
    payment: {
      order_id: "order_economic_parent_1",
      amount: 499,
      currency: "USD",
    },
    ...overrides,
  };
}

test("Revolut DISPUTE_WON maps only an authoritative production correction", async () => {
  const {
    partnerChargebackReversalRpcArgs,
    revolutDisputeWonPartnerObservation,
  } = await finance();
  const first = revolutDisputeWonPartnerObservation(
    {
      dispute: wonDispute(),
      referredUserId: userId,
      environment: "production",
    },
    now,
  );
  const replay = revolutDisputeWonPartnerObservation(
    {
      dispute: wonDispute({ updated_at: "2026-07-30T08:12:00.000Z" }),
      referredUserId: userId,
      environment: "production",
    },
    now,
  );

  assert.equal(first.eventType, "chargeback_reversal");
  assert.equal(first.rail, "web");
  assert.equal(first.environment, "production");
  assert.equal(first.transactionId, "dispute_economic_identity_1");
  assert.equal(first.parentTransactionId, "order_economic_parent_1");
  assert.equal(first.grossMinor, 499);
  assert.equal(first.currency, "USD");

  const firstArgs = await partnerChargebackReversalRpcArgs(first);
  const replayArgs = await partnerChargebackReversalRpcArgs(replay);
  assert.deepEqual(
    {
      source: firstArgs.p_source_event_hash,
      payload: firstArgs.p_payload_hash,
      dispute: firstArgs.p_dispute_hash,
      parent: firstArgs.p_parent_order_hash,
    },
    {
      source: replayArgs.p_source_event_hash,
      payload: replayArgs.p_payload_hash,
      dispute: replayArgs.p_dispute_hash,
      parent: replayArgs.p_parent_order_hash,
    },
  );
  assert.match(firstArgs.p_source_event_hash, /^[0-9a-f]{64}$/);
  assert.match(firstArgs.p_dispute_hash, /^[0-9a-f]{64}$/);
  assert.equal(
    JSON.stringify(firstArgs).includes("dispute_economic_identity_1"),
    false,
  );
  assert.equal(
    JSON.stringify(firstArgs).includes("order_economic_parent_1"),
    false,
  );

  assert.equal(
    revolutDisputeWonPartnerObservation(
      {
        dispute: wonDispute({ state: "lost" }),
        referredUserId: userId,
        environment: "production",
      },
      now,
    ),
    null,
  );
  assert.throws(
    () =>
      revolutDisputeWonPartnerObservation(
        {
          dispute: wonDispute({ payment: {} }),
          referredUserId: userId,
          environment: "production",
        },
        now,
      ),
    /partners_dispute_won_missing_parent_order/,
  );
  assert.throws(
    () =>
      revolutDisputeWonPartnerObservation(
        {
          dispute: wonDispute({
            payment: {
              order_id: "order_economic_parent_1",
              currency: "EUR",
            },
          }),
          referredUserId: userId,
          environment: "production",
        },
        now,
      ),
    /partners_dispute_won_currency_mismatch/,
  );
  assert.throws(
    () =>
      revolutDisputeWonPartnerObservation(
        {
          dispute: wonDispute(),
          referredUserId: userId,
          environment: "sandbox",
        },
        now,
      ),
    /partners_dispute_won_invalid_environment/,
  );
  assert.throws(
    () =>
      revolutDisputeWonPartnerObservation(
        {
          dispute: wonDispute({
            updated_at: undefined,
            created_at: "not-an-authoritative-timestamp",
          }),
          referredUserId: userId,
          environment: "production",
        },
        now,
      ),
    /partners_dispute_won_invalid_observed_at/,
  );
});

test("Revolut signature rotation accepts one exact comma-delimited HMAC only", async () => {
  const { revolutWebhookSignatureMatches } = await finance();
  const expected = `v1=${"a".repeat(64)}`;
  const oldSignature = `v1=${"b".repeat(64)}`;
  const unrelatedSignature = `v1=${"c".repeat(64)}`;

  assert.equal(
    revolutWebhookSignatureMatches(
      `${oldSignature}, ${expected}, ${unrelatedSignature}`,
      expected,
    ),
    true,
  );
  assert.equal(
    revolutWebhookSignatureMatches(
      `${oldSignature}, ${unrelatedSignature}`,
      expected,
    ),
    false,
  );
  assert.equal(
    revolutWebhookSignatureMatches(`${expected}0`, expected),
    false,
  );
  assert.equal(revolutWebhookSignatureMatches("", expected), false);
});

test("chargeback reversal is durably queued before provider acknowledgement", async () => {
  const {
    enqueuePartnerChargebackReversal,
    revolutDisputeWonPartnerObservation,
  } = await finance();
  const observation = revolutDisputeWonPartnerObservation(
    {
      dispute: wonDispute(),
      referredUserId: userId,
      environment: "production",
    },
    now,
  );
  let captured;
  const result = await enqueuePartnerChargebackReversal(
    {
      async rpc(name, args) {
        captured = { name, args };
        return {
          data: {
            schema_version: 1,
            action: "chargeback_reversal_queued",
            replayed: false,
            conflict: false,
            job: {
              key: "crw_0123456789abcdef01234567",
              status: "pending",
            },
          },
          error: null,
        };
      },
    },
    observation,
  );
  assert.equal(
    captured.name,
    "partners_worker_revolut_dispute_won_enqueue",
  );
  assert.equal(result.job.status, "pending");
  assert.equal(result.conflict, false);
});

test("database correction is one-to-one, proof-bound and fail-closed", () => {
  const migration = read(
    "supabase/migrations/20260730100200_partners_revolut_dispute_won.sql",
  );
  const financeSource = read(
    "supabase/functions/_shared/partners-finance.mjs",
  );

  assert.match(
    migration,
    /event_type in \([\s\S]*?'chargeback_reversal'[\s\S]*?\)/,
  );
  assert.match(
    migration,
    /create unique index affiliate_commission_entries_reinstatement_once_idx[\s\S]*?where entry_kind = 'reinstatement'/,
  );
  assert.match(
    migration,
    /where fact\.environment = 'production'[\s\S]*?and fact\.rail = 'web'[\s\S]*?and fact\.event_type = 'chargeback'[\s\S]*?and fact\.transaction_hash = v_dispute_hash/,
  );
  assert.match(
    migration,
    /v_loss\.parent_transaction_hash <> v_parent_order_hash[\s\S]*?v_loss\.referred_user_id is distinct from p_referred_user_id[\s\S]*?v_loss\.currency is distinct from v_currency[\s\S]*?v_loss\.gross_minor is distinct from p_gross_minor/,
  );
  assert.match(
    migration,
    /where entry\.fact_id = v_loss\.id[\s\S]*?and entry\.entry_kind = 'reversal'/,
  );
  assert.match(
    migration,
    /'reinstatement',[\s\S]*?v_reversal\.id,[\s\S]*?v_reversal\.amount_minor/,
  );
  assert.match(
    migration,
    /'platform_commission_recovery',[\s\S]*?'debit',[\s\S]*?v_reinstatement\.amount_minor/,
  );
  assert.match(
    migration,
    /v_recovery_cancel_minor := least\([\s\S]*?v_reversal_recovery_due_minor,[\s\S]*?v_recovery_due_outstanding_minor/,
  );
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*?partners_balance_lock/);
  assert.match(
    migration,
    /affiliate_revolut_dispute_won_jobs[\s\S]*?status in \('pending', 'leased', 'retry', 'succeeded', 'dead_letter'\)/,
  );
  assert.match(
    migration,
    /partners_worker_revolut_dispute_won_enqueue[\s\S]*?chargeback_reversal_queued/,
  );
  assert.match(
    migration,
    /partners_worker_revolut_dispute_won_jobs_lease[\s\S]*?for update skip locked/,
  );
  assert.match(
    migration,
    /partners_worker_revolut_dispute_won_job_complete[\s\S]*?partners_worker_revolut_dispute_won_ingest/,
  );
  assert.match(
    migration,
    /v_origin\.transaction_hash is distinct from v_parent_order_hash/,
  );
  assert.match(
    migration,
    /p_observed_at < v_loss\.occurred_at/,
  );
  assert.match(
    migration,
    /posting\.ledger_account not in \([\s\S]*?'partner_recovery_due'/,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function public\.partners_worker_revolut_dispute_won_ingest\(/,
  );
  assert.match(
    migration,
    /revoke all on function[\s\S]*?affiliate_private\.partners_worker_revolut_dispute_won_ingest\([\s\S]*?from public, anon, authenticated, service_role;/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function\s+affiliate_private\.partners_worker_revolut_dispute_won_ingest\(/,
  );
  assert.doesNotMatch(
    financeSource,
    /export async function ingestPartnerChargebackReversal/,
  );
  for (
    const rpc of [
      "partners_worker_revolut_dispute_won_enqueue",
      "partners_worker_revolut_dispute_won_jobs_lease",
      "partners_worker_revolut_dispute_won_job_complete",
    ]
  ) {
    assert.match(
      migration,
      new RegExp(
        `grant execute on function\\s+public\\.${rpc}\\([\\s\\S]*?\\)\\s+to service_role;`,
      ),
    );
    assert.doesNotMatch(
      migration,
      new RegExp(
        `grant execute on function\\s+public\\.${rpc}\\([\\s\\S]*?\\)\\s+to (?:anon|authenticated);`,
      ),
    );
  }
  assert.match(
    migration,
    /v_reversal_pending_minor[\s\S]*?v_reversal_available_minor[\s\S]*?v_reversal_clearing_minor[\s\S]*?v_reversal_recovery_due_minor/,
  );
  assert.match(
    migration,
    /release\.created_at <= v_reinstatement\.created_at[\s\S]*?when v_release_precedes_reinstatement then 0[\s\S]*?then v_reversal_pending_minor/,
  );
  assert.doesNotMatch(migration, /v_accrual\.matures_at <= now\(\)/);
  assert.match(
    migration,
    /j\.status = 'succeeded'[\s\S]*?partners_net_reversed_minor\(accrual\.id\)[\s\S]*?completed_at = null/,
  );
});

test("webhook re-fetches won state, queues durably and marks it last", () => {
  const webhook = read("supabase/functions/norva-revolut-webhook/index.ts");
  const branchStart = webhook.indexOf("if (disputeEvent)");
  const branchEnd = webhook.indexOf(
    "// Authoritative order from Revolut",
    branchStart,
  );
  const branch = webhook.slice(branchStart, branchEnd);

  assert.match(branch, /expectedDisputeState = eventType === "DISPUTE_WON"/);
  assert.match(branch, /const dispute = await fetchDispute\(disputeId\)/);
  assert.match(branch, /authoritativeDisputeState !== expectedDisputeState/);
  assert.match(branch, /revolutDisputeWonPartnerObservation/);
  assert.match(branch, /await enqueuePartnerChargebackReversal/);
  assert.match(branch, /financial_event: "chargeback_reversal"/);
  assert.ok(
    branch.indexOf("await enqueuePartnerChargebackReversal") <
      branch.indexOf("await recordProcessedEvent"),
  );
  assert.match(branch, /queued: true/);
  assert.match(branch, /}, 202\)/);
  assert.doesNotMatch(
    branch,
    /applyProjectionCausally|finalizeCheckoutEntitlement/,
  );
  assert.match(webhook, /REVOLUT_DISPUTES_API_VERSION = "2026-04-20"/);
  assert.match(
    webhook,
    /revolutWebhookSignatureMatches\(sigHeader, expected\)/,
  );
  assert.doesNotMatch(webhook, /console\.log\([^)]*eventId/);
});

test("all balance consumers use net reversals and reporting restores semantics", () => {
  const correctionMigration = read(
    "supabase/migrations/20260730100200_partners_revolut_dispute_won.sql",
  );
  const worker = read("supabase/functions/norva-partners-worker/index.ts");
  const page = read("public/js/pages/PartnersPage.js");
  const adminPage = read("public/js/pages/AdminPage.js");

  assert.ok(
    (
      correctionMigration.match(
        /affiliate_private\.partners_net_reversed_minor\(/g,
      ) ?? []
    ).length >= 4,
  );
  assert.match(
    correctionMigration,
    /v_reversed :=[\s\S]*?partners_net_reversed_minor\(v_accrual\.id\)/,
  );
  assert.match(
    correctionMigration,
    /'chargeback_reversal_count'/,
  );
  assert.match(
    correctionMigration,
    /'commission_reinstated_minor'/,
  );
  assert.match(
    correctionMigration,
    /when 'reinstatement' then 'commission_restored'/,
  );
  assert.match(page, /commission_restored: 'Commission restored'/);
  assert.match(worker, /type JobKind = "commission" \| "correction" \| "maturation"/);
  assert.match(
    worker,
    /drainJobKind\(db, "correction", workerId\)/,
  );
  assert.match(
    correctionMigration,
    /v_type not in \('commission', 'correction', 'maturation'\)/,
  );
  assert.match(
    correctionMigration,
    /'correction_dead_letter'[\s\S]*?affiliate_revolut_dispute_won_jobs/,
  );
  assert.match(adminPage, /\['commission', 'correction', 'maturation'\]/);
  assert.match(adminPage, /\^crw_\[0-9a-f\]\{24\}\$/);
});
