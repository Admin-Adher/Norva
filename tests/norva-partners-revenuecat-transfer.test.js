const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const transferModule = () =>
  import(
    pathToFileURL(
      path.join(root, "supabase/functions/_shared/revenuecat-transfer.mjs"),
    ).href
  );
const workerModule = () =>
  import(
    pathToFileURL(
      path.join(
        root,
        "supabase/functions/_shared/revenuecat-transfer-worker.mjs",
      ),
    ).href
  );

const sourceUserId = "11111111-1111-4111-8111-111111111111";
const destinationUserId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-07-30T08:00:00.000Z");
const expires = "2026-08-30T08:00:00.000Z";

function transferEvent(overrides = {}) {
  return {
    id: "rc-transfer-event-001",
    type: "TRANSFER",
    event_timestamp_ms: now.getTime(),
    transferred_from: ["$RCAnonymousID:private-source", sourceUserId],
    transferred_to: ["$RCAnonymousID:private-destination", destinationUserId],
    environment: "PRODUCTION",
    store: "PLAY_STORE",
    app_id: "app_norva_phone",
    ...overrides,
  };
}

function customerInfo(overrides = {}) {
  return {
    request_date_ms: now.getTime(),
    subscriber: {
      original_app_user_id: "$RCAnonymousID:not-an-authority",
      subscriptions: {
        "norva_plus:monthly": {
          expires_date: expires,
          grace_period_expires_date: null,
          is_sandbox: false,
          period_type: "normal",
          purchase_date: "2026-07-30T07:55:00.000Z",
          store: "play_store",
          unsubscribe_detected_at: null,
          billing_issues_detected_at: null,
        },
      },
      entitlements: {
        pro: {
          product_identifier: "norva_plus:monthly",
          expires_date: expires,
          grace_period_expires_date: null,
        },
      },
      ...overrides,
    },
  };
}

test("TRANSFER parsing accepts exactly one canonical destination and hashes aliases without persisting them", async () => {
  const { parseRevenueCatTransferEvent, minimizedRevenueCatTransferPayload } =
    await transferModule();
  const parsed = parseRevenueCatTransferEvent(transferEvent());
  assert.equal(parsed.destinationUserId, destinationUserId);
  assert.deepEqual(parsed.sourceUserIds, [sourceUserId]);
  assert.equal(parsed.sourceIdentifierCount, 2);
  assert.equal(parsed.destinationIdentifierCount, 2);
  assert.match(parsed.fingerprintMaterial, /\$RCAnonymousID:private-source/);

  const payload = minimizedRevenueCatTransferPayload(parsed, {
    applied: true,
    disposition: "applied",
    sourceExpiredCount: 1,
  });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /private-source|private-destination/);
  assert.doesNotMatch(serialized, new RegExp(sourceUserId));
  assert.doesNotMatch(serialized, new RegExp(destinationUserId));
  assert.equal(payload._norva.authority, "revenuecat_customer_info_refetch");
});

test("TRANSFER parsing rejects missing, malformed and ambiguous destination contracts", async () => {
  const { parseRevenueCatTransferEvent } = await transferModule();
  assert.throws(
    () => parseRevenueCatTransferEvent(transferEvent({ id: null })),
    /transfer_missing_event_id/,
  );
  assert.throws(
    () =>
      parseRevenueCatTransferEvent(
        transferEvent({
          transferred_to: [
            destinationUserId,
            "33333333-3333-4333-8333-333333333333",
          ],
        }),
      ),
    /transfer_destination_not_unique/,
  );
  assert.throws(
    () => parseRevenueCatTransferEvent(transferEvent({ transferred_from: [] })),
    /transfer_invalid_source_identifiers/,
  );
  assert.throws(
    () =>
      parseRevenueCatTransferEvent(
        transferEvent({ transferred_from: [sourceUserId, 7] }),
      ),
    /transfer_invalid_source_identifiers/,
  );
  assert.throws(
    () =>
      parseRevenueCatTransferEvent(
        transferEvent({ transferred_from: [sourceUserId, sourceUserId] }),
      ),
    /transfer_invalid_source_identifiers/,
  );
  assert.throws(
    () =>
      parseRevenueCatTransferEvent(
        transferEvent({
          event_timestamp_ms: now.getTime() + 5 * 60 * 1000 + 1,
        }),
        now,
      ),
    /transfer_event_timestamp_in_future/,
  );
});

test("RevenueCat app allowlisting is optional but fails closed when configured", async () => {
  const {
    parseRevenueCatAllowedAppIds,
    parseRevenueCatTransferEvent,
    revenueCatEventAppAllowed,
  } = await transferModule();
  const unrestricted = parseRevenueCatAllowedAppIds("");
  assert.equal(revenueCatEventAppAllowed(transferEvent(), unrestricted), true);

  const allowed = parseRevenueCatAllowedAppIds(
    "app_norva_phone,app_norva_tablet",
  );
  assert.equal(revenueCatEventAppAllowed(transferEvent(), allowed), true);
  assert.equal(
    revenueCatEventAppAllowed(
      transferEvent({ app_id: "app_other_product" }),
      allowed,
    ),
    false,
  );
  assert.equal(
    revenueCatEventAppAllowed(transferEvent({ app_id: undefined }), allowed),
    false,
  );
  assert.throws(
    () => parseRevenueCatAllowedAppIds("app_norva_phone, invalid app"),
    /transfer_app_allowlist_invalid/,
  );

  const first = parseRevenueCatTransferEvent(transferEvent());
  const second = parseRevenueCatTransferEvent(
    transferEvent({ app_id: "app_norva_tablet" }),
  );
  assert.notEqual(first.fingerprintMaterial, second.fingerprintMaterial);
});

test("fresh CustomerInfo proves one active plan and creates a bounded destination patch", async () => {
  const { parseRevenueCatTransferEvent, resolveRevenueCatTransferAuthority } =
    await transferModule();
  const transfer = parseRevenueCatTransferEvent(transferEvent());
  const authority = resolveRevenueCatTransferAuthority(
    customerInfo(),
    transfer,
    { "norva_plus:monthly": "plus" },
    now,
  );
  assert.equal(authority.patch.user_id, destinationUserId);
  assert.equal(authority.patch.provider, "google_play");
  assert.equal(authority.patch.plan_code, "plus");
  assert.equal(authority.patch.status, "active");
  assert.equal(authority.patch.current_period_end, expires);
  assert.equal(authority.patch.billing_product_id, "norva_plus:monthly");
  assert.equal(
    authority.patch.billing_terms_source,
    "revenuecat_transfer_refetch",
  );
  assert.equal(authority.patch.mrr_cents, null);
  assert.equal(authority.patch.billing_currency, null);
  assert.doesNotMatch(
    authority.authorityFingerprintMaterial,
    /\$RCAnonymousID:not-an-authority/,
  );
});

test("CustomerInfo status mapping preserves trial, cancellation and bounded billing grace", async () => {
  const { parseRevenueCatTransferEvent, resolveRevenueCatTransferAuthority } =
    await transferModule();
  const transfer = parseRevenueCatTransferEvent(transferEvent());
  const map = { "norva_plus:monthly": "plus" };

  const trial = customerInfo();
  trial.subscriber.subscriptions["norva_plus:monthly"].period_type = "trial";
  const trialAuthority = resolveRevenueCatTransferAuthority(
    trial,
    transfer,
    map,
    now,
  );
  assert.equal(trialAuthority.patch.status, "trialing");
  assert.equal(trialAuthority.patch.trial_ends_at, expires);

  const cancelled = customerInfo();
  cancelled.subscriber.subscriptions[
    "norva_plus:monthly"
  ].unsubscribe_detected_at = "2026-07-30T07:59:00.000Z";
  assert.equal(
    resolveRevenueCatTransferAuthority(cancelled, transfer, map, now).patch
      .status,
    "cancelled_at_period_end",
  );

  const graceEnd = "2026-08-31T08:00:00.000Z";
  const pastDue = customerInfo();
  pastDue.subscriber.subscriptions[
    "norva_plus:monthly"
  ].billing_issues_detected_at = "2026-07-30T07:59:00.000Z";
  pastDue.subscriber.subscriptions[
    "norva_plus:monthly"
  ].grace_period_expires_date = graceEnd;
  pastDue.subscriber.entitlements.pro.grace_period_expires_date = graceEnd;
  const pastDueAuthority = resolveRevenueCatTransferAuthority(
    pastDue,
    transfer,
    map,
    now,
  );
  assert.equal(pastDueAuthority.patch.status, "past_due");
  assert.equal(pastDueAuthority.patch.fail_open_until, graceEnd);
});

test("CustomerInfo refetch fails closed on missing entitlement, sandbox mismatch and mixed tiers", async () => {
  const { parseRevenueCatTransferEvent, resolveRevenueCatTransferAuthority } =
    await transferModule();
  const transfer = parseRevenueCatTransferEvent(transferEvent());
  const productMap = {
    "norva_plus:monthly": "plus",
    "norva_family:monthly": "family",
  };

  assert.throws(
    () =>
      resolveRevenueCatTransferAuthority(
        customerInfo({ entitlements: {} }),
        transfer,
        productMap,
        now,
      ),
    /transfer_no_active_entitlement/,
  );
  assert.throws(
    () =>
      resolveRevenueCatTransferAuthority(
        { ...customerInfo(), request_date_ms: now.getTime() - 11 * 60 * 1000 },
        transfer,
        productMap,
        now,
      ),
    /transfer_stale_authority_response/,
  );
  assert.throws(
    () =>
      resolveRevenueCatTransferAuthority(
        customerInfo({
          subscriptions: {
            "norva_plus:monthly": {
              expires_date: expires,
              period_type: "normal",
              purchase_date: "2026-07-30T07:55:00.000Z",
              store: "play_store",
            },
          },
        }),
        transfer,
        productMap,
        now,
      ),
    /transfer_no_active_entitlement/,
  );
  assert.throws(
    () =>
      resolveRevenueCatTransferAuthority(
        customerInfo({
          subscriptions: {
            "norva_plus:monthly": {
              expires_date: expires,
              is_sandbox: true,
              period_type: "normal",
              purchase_date: "2026-07-30T07:55:00.000Z",
              store: "play_store",
            },
          },
        }),
        transfer,
        productMap,
        now,
      ),
    /transfer_no_active_entitlement/,
  );
  const noEnvironment = parseRevenueCatTransferEvent(
    transferEvent({ environment: undefined }),
  );
  assert.equal(noEnvironment.environment, null);
  assert.equal(
    resolveRevenueCatTransferAuthority(
      customerInfo(),
      noEnvironment,
      productMap,
      now,
    ).resolvedEnvironment,
    "PRODUCTION",
  );

  const mixed = customerInfo();
  mixed.subscriber.subscriptions["norva_family:monthly"] = {
    expires_date: expires,
    is_sandbox: false,
    period_type: "normal",
    purchase_date: "2026-07-30T07:55:00.000Z",
    store: "play_store",
  };
  mixed.subscriber.entitlements.family = {
    product_identifier: "norva_family:monthly",
    expires_date: expires,
  };
  assert.throws(
    () => resolveRevenueCatTransferAuthority(mixed, transfer, productMap, now),
    /transfer_ambiguous_active_plan/,
  );
});

test("missing TRANSFER environment/store are resolved only from one unambiguous authority", async () => {
  const { parseRevenueCatTransferEvent, resolveRevenueCatTransferAuthority } =
    await transferModule();
  const transfer = parseRevenueCatTransferEvent(
    transferEvent({ environment: undefined, store: undefined }),
    now,
  );
  const productMap = {
    "norva_plus:monthly": "plus",
    "norva_plus:annual": "plus",
  };
  const ambiguousEnvironment = customerInfo();
  ambiguousEnvironment.subscriber.subscriptions["norva_plus:annual"] = {
    expires_date: expires,
    is_sandbox: true,
    period_type: "normal",
    purchase_date: "2026-07-30T07:55:00.000Z",
    store: "play_store",
  };
  ambiguousEnvironment.subscriber.entitlements.annual = {
    product_identifier: "norva_plus:annual",
    expires_date: expires,
  };
  assert.throws(
    () =>
      resolveRevenueCatTransferAuthority(
        ambiguousEnvironment,
        transfer,
        productMap,
        now,
      ),
    /transfer_ambiguous_environment/,
  );

  const ambiguousStore = customerInfo();
  ambiguousStore.subscriber.subscriptions["norva_plus:annual"] = {
    expires_date: expires,
    is_sandbox: false,
    period_type: "normal",
    purchase_date: "2026-07-30T07:55:00.000Z",
    store: "stripe",
  };
  ambiguousStore.subscriber.entitlements.annual = {
    product_identifier: "norva_plus:annual",
    expires_date: expires,
  };
  assert.throws(
    () =>
      resolveRevenueCatTransferAuthority(
        ambiguousStore,
        transfer,
        productMap,
        now,
      ),
    /transfer_ambiguous_store/,
  );

  const ambiguousStatus = customerInfo();
  ambiguousStatus.subscriber.subscriptions["norva_plus:annual"] = {
    expires_date: expires,
    is_sandbox: false,
    period_type: "trial",
    purchase_date: "2026-07-30T07:55:00.000Z",
    store: "play_store",
  };
  ambiguousStatus.subscriber.entitlements.annual = {
    product_identifier: "norva_plus:annual",
    expires_date: expires,
  };
  assert.throws(
    () =>
      resolveRevenueCatTransferAuthority(
        ambiguousStatus,
        transfer,
        productMap,
        now,
      ),
    /transfer_ambiguous_active_status/,
  );
});

test("RevenueCat HMAC verifies raw bytes in constant-time within a bounded timestamp window", async () => {
  const { verifyRevenueCatWebhookSignature } = await transferModule();
  const rawBody = JSON.stringify({ event: transferEvent() });
  const secret = "unit-test-secret-with-at-least-32-bytes";
  const timestamp = Math.floor(now.getTime() / 1000);
  const signatureFor = (value) =>
    crypto
      .createHmac("sha256", secret)
      .update(`${value}.${rawBody}`)
      .digest("hex");
  const signature = signatureFor(timestamp);

  assert.equal(
    await verifyRevenueCatWebhookSignature({
      rawBody,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      secret,
      now,
    }),
    true,
  );
  assert.equal(
    await verifyRevenueCatWebhookSignature({
      rawBody: `${rawBody} `,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      secret,
      now,
    }),
    false,
  );
  const staleTimestamp = timestamp - 301;
  assert.equal(
    await verifyRevenueCatWebhookSignature({
      rawBody,
      signatureHeader:
        `t=${staleTimestamp},v1=${signatureFor(staleTimestamp)}`,
      secret,
      now,
    }),
    false,
  );
  const futureTimestamp = timestamp + 301;
  assert.equal(
    await verifyRevenueCatWebhookSignature({
      rawBody,
      signatureHeader:
        `t=${futureTimestamp},v1=${signatureFor(futureTimestamp)}`,
      secret,
      now,
    }),
    false,
  );
});

test("authority fetch honors Retry-After on 429/503 and opens the batch circuit", async () => {
  const {
    fetchRevenueCatTransferAuthority,
    RevenueCatAuthorityRequestError,
  } = await workerModule();
  let observedSignal = null;
  await assert.rejects(
    fetchRevenueCatTransferAuthority({
      destinationUserId,
      apiKey: "rc-secret",
      deadlineMs: now.getTime() + 45_000,
      nowMs: () => now.getTime(),
      fetchImpl: async (_url, options) => {
        observedSignal = options.signal;
        return {
          status: 429,
          headers: { get: () => "120" },
          text: async () => "",
        };
      },
    }),
    (error) => {
      assert.ok(error instanceof RevenueCatAuthorityRequestError);
      assert.equal(error.code, "authority_fetch_http_429");
      assert.equal(error.retryAfterSeconds, 120);
      assert.equal(error.stopBatch, true);
      return true;
    },
  );
  assert.ok(observedSignal instanceof AbortSignal);

  await assert.rejects(
    fetchRevenueCatTransferAuthority({
      destinationUserId,
      apiKey: "rc-secret",
      deadlineMs: now.getTime() + 45_000,
      nowMs: () => now.getTime(),
      fetchImpl: async () => ({
        status: 503,
        headers: {
          get: () => new Date(now.getTime() + 90_000).toUTCString(),
        },
        text: async () => "",
      }),
    }),
    (error) => {
      assert.equal(error.code, "authority_fetch_http_503");
      assert.equal(error.retryAfterSeconds, 90);
      assert.equal(error.stopBatch, true);
      return true;
    },
  );
});

test("worker cycle publishes degraded bounded heartbeats for partial/dead-letter work and lease loss", async () => {
  const { runRevenueCatTransferWorkerCycle } = await workerModule();
  const base = {
    leased: 0,
    applied: 0,
    terminal_rejected: 0,
    partial: 0,
    succeeded: 0,
    retry: 0,
    dead_letter: 0,
    dead_letter_moved: 0,
  };
  const heartbeats = [];
  const result = await runRevenueCatTransferWorkerCycle({
    deadlineMs: now.getTime() + 45_000,
    nowMs: () => now.getTime(),
    drainPartnerOutbox: async () => ({
      ...base,
      leased: 1,
      dead_letter_moved: 1,
    }),
    drainTransfers: async () => ({
      ...base,
      leased: 2,
      partial: 1,
      dead_letter: 1,
    }),
    recordHeartbeat: async (status, details) => {
      heartbeats.push({ status, details });
    },
  });
  assert.equal(result.heartbeat_status, "degraded");
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].status, "degraded");
  assert.equal(heartbeats[0].details.transfer_partial, 1);
  assert.equal(heartbeats[0].details.transfer_dead_letter, 1);
  assert.equal(heartbeats[0].details.partner_dead_letter_moved, 1);
  assert.doesNotMatch(JSON.stringify(heartbeats[0]), /user_id|account_id|email/);

  const failedHeartbeats = [];
  await assert.rejects(
    runRevenueCatTransferWorkerCycle({
      deadlineMs: now.getTime() + 45_000,
      nowMs: () => now.getTime(),
      drainPartnerOutbox: async () => ({ ...base }),
      drainTransfers: async () => {
        throw new Error("revenuecat_transfer_lease_lost");
      },
      recordHeartbeat: async (status, details) => {
        failedHeartbeats.push({ status, details });
      },
      errorCode: (error) => error.message,
    }),
    /revenuecat_transfer_lease_lost/,
  );
  assert.equal(failedHeartbeats.length, 1);
  assert.equal(failedHeartbeats[0].status, "degraded");
  assert.equal(
    failedHeartbeats[0].details.failure_code,
    "revenuecat_transfer_lease_lost",
  );
});

test("Edge TRANSFER path requires a 200 refetch and delegates one atomic database mutation", () => {
  const source = read("supabase/functions/norva-billing-webhook/index.ts");
  const transferStart = source.indexOf(
    "async function handleRevenueCatTransfer",
  );
  const transferEnd = source.indexOf(
    "async function enrichGooglePlayPartnersObservation",
  );
  const block = source.slice(transferStart, transferEnd);
  assert.match(block, /REVENUECAT_SECRET_API_KEY/);
  assert.match(block, /api\.revenuecat\.com\/v1\/subscribers/);
  assert.match(block, /if \(response\.status !== 200\)/);
  assert.match(block, /response\.status[\s\S]*201[\s\S]*not proof/i);
  assert.match(block, /resolveRevenueCatTransferAuthority/);
  assert.match(block, /apply_revenuecat_entitlement_transfer/);
  assert.match(
    block,
    /recordRevenueCatTransfer[\s\S]*authority_verification_pending/,
  );
  assert.match(block, /if \(!result\.terminal\)[\s\S]*503/);
  assert.doesNotMatch(block, /revenueCatPartnerObservation/);
  assert.ok(
    block.indexOf("resolveRevenueCatTransferAuthority") <
      block.indexOf('"apply_revenuecat_entitlement_transfer"'),
  );
  assert.doesNotMatch(block, /recordProcessedEvent\(/);
  assert.doesNotMatch(source, /TODO\(transfer\)/);
  assert.match(source, /verifyRevenueCatWebhookSignature/);
  assert.match(source, /X-RevenueCat-Webhook-Signature/);
  assert.ok(
    source.indexOf("verifyRevenueCatWebhookSignature") <
      source.indexOf("JSON.parse(rawBody)"),
  );
});

test("database transfer RPC is private, atomic and distinguishes newer, equal, expired and policy-preserved sources", () => {
  const baseSql = read(
    "supabase/migrations/20260730100000_revenuecat_transfer_projection.sql",
  );
  const sql = read(
    "supabase/migrations/20260730100100_revenuecat_transfer_replay_cron.sql",
  );
  const pgTap = read("supabase/tests/revenuecat_transfer.sql");
  assert.match(
    baseSql,
    /create table if not exists public\.cloud_revenuecat_transfer_events/,
  );
  assert.match(
    baseSql,
    /alter table public\.cloud_revenuecat_transfer_events enable row level security/,
  );
  assert.match(
    baseSql,
    /revoke all on table public\.cloud_revenuecat_transfer_events[\s\S]*public, anon, authenticated/,
  );
  assert.match(sql, /create or replace function public\.record_revenuecat_entitlement_transfer/);
  assert.match(sql, /revenuecat_transfer_event_conflict/);
  assert.match(sql, /public\.apply_revenuecat_entitlement_event\(/);
  assert.match(sql, /hashtextextended\(v_source_id::text, 20260721\)/);
  assert.match(sql, /public\.norva_is_internal_account\(v_source_id\)/);
  assert.match(
    sql,
    /v_source_projection\.status in \('revoked', 'refunded', 'fraud'\)/,
  );
  assert.match(
    sql,
    /v_source_projection\.provider[\s\S]*'revenuecat', 'google_play', 'apple_app_store', 'stripe', 'web'/,
  );
  assert.match(sql, /v_source_cursor\.last_event_at[\s\S]*> p_event_at/);
  assert.match(sql, /source_equal_timestamp_requires_reconciliation/);
  assert.match(sql, /source_newer_preserved_count/);
  assert.match(sql, /v_source_projection\.status = 'expired'/);
  assert.match(sql, /provider_customer_id = null/);
  assert.match(sql, /billing_terms_source = null/);
  assert.match(sql, /'TRANSFER_SOURCE_EXPIRED'/);
  assert.match(sql, /source_newer_pending_count/);
  assert.match(sql, /partner_status = case/);
  assert.match(sql, /revenuecat_transfer_retry_jobs_lease/);
  assert.match(sql, /revenuecat_transfer_retry_job_complete/);
  assert.match(sql, /revenuecat_transfer_retry_job_defer/);
  assert.match(sql, /'dead_letter_moved'/);
  assert.match(sql, /'partner_dead_letter_moved'/);
  assert.match(
    sql,
    /create or replace function affiliate_private\.partners_worker_heartbeat/,
  );
  assert.match(sql, /'revenuecat_transfer'/);
  assert.match(sql, /'dead_letter'/);
  assert.match(
    sql,
    /grant execute on function public\.apply_revenuecat_entitlement_transfer[\s\S]*to service_role/,
  );
  assert.doesNotMatch(
    sql,
    /jsonb_build_object\([\s\S]{0,400}'transferred_(from|to)'/,
  );
  assert.match(
    pgTap,
    /'30000000-0000-4000-8000-000000000010'::uuid[\s\S]*union all[\s\S]*'30000000-0000-4000-8000-000000000012'::uuid/,
  );
  assert.match(
    pgTap,
    /'30000000-0000-4000-8000-000000000007'::uuid[\s\S]*union all[\s\S]*'30000000-0000-4000-8000-000000000008'::uuid/,
  );
  assert.match(
    pgTap,
    /select source_equal_pending_count[\s\S]*?where event_id = 'rc-transfer-pgtap-causal'[\s\S]*?\),\s*0::smallint,/,
  );
  assert.match(
    pgTap,
    /source_absent_count \+[\s\S]*?where event_id = 'rc-transfer-pgtap-c'[\s\S]*?\),\s*3::smallint,/,
  );
});

test("dedicated cron worker reserves Partners delivery and enforces the bounded authority budget", () => {
  const worker = read(
    "supabase/functions/norva-revenuecat-transfer-worker/index.ts",
  );
  assert.match(worker, /norva_verify_cron_secret/);
  assert.match(worker, /revenuecat_transfer_retry_jobs_lease/);
  assert.match(worker, /resolveRevenueCatTransferAuthority/);
  assert.match(worker, /apply_revenuecat_entitlement_transfer/);
  assert.match(
    worker,
    /if \(result\.terminal\)[\s\S]*result\.applied \? "applied" : "terminal_rejected"/,
  );
  assert.match(worker, /revenuecat_transfer_partner_jobs_lease/);
  assert.match(worker, /ingestPartnerFinancialFact/);
  const cycle = read(
    "supabase/functions/_shared/revenuecat-transfer-worker.mjs",
  );
  assert.ok(
    cycle.indexOf("await drainPartnerOutbox") <
      cycle.indexOf("await drainTransfers"),
  );
  assert.match(worker, /REVENUECAT_TRANSFER_RUN_BUDGET_MS/);
  assert.match(worker, /Date\.now\(\) >= deadlineMs/);
  assert.match(worker, /authority_batch_deferred/);
  assert.match(worker, /partners_worker_heartbeat/);
  assert.match(worker, /p_worker_name: "revenuecat_transfer"/);
  assert.doesNotMatch(worker, /console\.(?:log|error)\([^)]*destinationUserId/);

  const config = read("supabase/config.toml");
  const compose = read("ops/hetzner/docker-compose.supabase.yml");
  const cron = read(
    "ops/hetzner/scripts/register-norva-revenuecat-transfer-cron.sql",
  );
  assert.match(config, /\[functions\.norva-revenuecat-transfer-worker\][\s\S]*verify_jwt = false/);
  assert.match(compose, /NORVA_REVENUECAT_TRANSFER_WORKER_BATCH/);
  assert.match(compose, /NORVA_REVENUECAT_TRANSFER_WORKER_BATCH:-4/);
  assert.match(compose, /NORVA_REVENUECAT_TRANSFER_WORKER_MAX_BATCHES:-1/);
  assert.match(compose, /NORVA_REVENUECAT_TRANSFER_WORKER_LEASE_SECONDS:-120/);
  assert.match(compose, /NORVA_REVENUECAT_ALLOWED_APP_IDS/);
  assert.match(cron, /norva-revenuecat-transfer-worker\/cron\/run/);
  assert.match(cron, /norva_cron_shared_secret/);
});
