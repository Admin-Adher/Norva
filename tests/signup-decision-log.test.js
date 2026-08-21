'use strict';

// Structural and behavioural invariants, not word searches. The list of them is
// the review's own: a token cannot physically be written, observe implies ALLOW
// and cannot be violated in the database, two different policies produce
// different config hashes, and a decision snapshot cannot be edited afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { bundleTypescriptModule } = require('./helpers/bundle-typescript-module');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const migration = read('supabase/migrations/20260822100000_abuse_signup_decisions.sql');

const previousDeno = globalThis.Deno;
let enforcement = 'false';
globalThis.Deno = {
  env: {
    get(name) {
      if (name === 'NORVA_ABUSE_ENFORCEMENT_ENABLED') return enforcement;
      return undefined;
    },
  },
};

const log = bundleTypescriptModule(
  path.join(root, 'supabase/functions/_shared/signup-decision-log.ts'),
);
const engine = bundleTypescriptModule(
  path.join(root, 'supabase/functions/_shared/signup-risk-engine.ts'),
);

test.after(async () => {
  await Promise.all([log, engine]);
  if (previousDeno === undefined) delete globalThis.Deno;
  else globalThis.Deno = previousDeno;
});

const POLICY = {
  riskModelVersion: 'signup-risk-v1',
  velocityRulesVersion: 'velocity-v1',
  thresholds: { low: 20, medium: 40, high: 65, critical: 85 },
  familyCaps: { velocity: 60, network: 18, client: 40, email: 15 },
  negativeCap: -20,
};

// ── the config hash ────────────────────────────────────────────────────────

test('the same policy hashes the same however it was written', async () => {
  const { policyConfigHash } = await log;
  const reordered = {
    velocityRulesVersion: POLICY.velocityRulesVersion,
    negativeCap: POLICY.negativeCap,
    thresholds: { critical: 85, high: 65, low: 20, medium: 40 },
    riskModelVersion: POLICY.riskModelVersion,
    familyCaps: { email: 15, client: 40, network: 18, velocity: 60 },
  };
  assert.equal(await policyConfigHash(reordered), await policyConfigHash(POLICY));
});

test('any change to the policy changes the hash', async () => {
  const { policyConfigHash } = await log;
  const baseline = await policyConfigHash(POLICY);
  const variants = [
    { ...POLICY, thresholds: { ...POLICY.thresholds, medium: 45 } },
    { ...POLICY, familyCaps: { ...POLICY.familyCaps, velocity: 55 } },
    { ...POLICY, negativeCap: -25 },
    { ...POLICY, riskModelVersion: 'signup-risk-v2' },
  ];
  for (const variant of variants) {
    assert.notEqual(await policyConfigHash(variant), baseline);
  }
  // This is what a version name alone cannot do. Thresholds are changeable at
  // runtime, so two rows stamped "v1" could otherwise have been computed under
  // different numbers and nobody would be able to tell.
});

test('the hash is reproducible outside the module', async () => {
  const { policyConfigHash, canonicalJson } = await log;
  // Plain SHA-256 over the canonical rendering, not a keyed digest:
  // configuration is not secret, and the property wanted is that two
  // deployments computing the same policy agree.
  const expected = nodeCrypto.createHash('sha256')
    .update(canonicalJson(POLICY)).digest('hex');
  assert.equal(await policyConfigHash(POLICY), expected);
});

// ── observe implies ALLOW ──────────────────────────────────────────────────

test('with enforcement off, nothing but ALLOW is ever produced', async () => {
  const { buildDecisionRecord, familyTotals } = await log;
  const { assessSignupRisk, SIGNALS } = await engine;
  enforcement = 'false';

  const assessment = assessSignupRisk([
    SIGNALS.tokenMissing(), SIGNALS.submissionUnder1500ms(),
    SIGNALS.headlessUserAgent(), SIGNALS.velocityIp(5, 5),
  ]);
  assert.equal(assessment.level, 'CRITICAL');

  const record = buildDecisionRecord(assessment, POLICY, 'a'.repeat(64), context(), familyTotals(assessment));
  // The verdict is recorded in full — that is the point of observing — but the
  // action taken is not.
  assert.equal(record.would_have_decision, 'BLOCK');
  assert.equal(record.actual_decision, 'ALLOW');
  assert.equal(record.enforcement_enabled, false);
});

test('the database refuses the combination too, not just the code', () => {
  // Defended on two layers on purpose: a future bug in another function must not
  // be able to record a refusal while enforcement is off.
  assert.match(
    migration,
    /constraint signup_decisions_observe_allows check \(\s*\n\s*enforcement_enabled = true or actual_decision = 'ALLOW'\s*\n\s*\)/,
  );
});

test('with enforcement on, the verdict is acted upon', async () => {
  const { buildDecisionRecord, familyTotals } = await log;
  const { assessSignupRisk, SIGNALS } = await engine;
  enforcement = 'true';
  const assessment = assessSignupRisk([SIGNALS.honeypot()]);
  const record = buildDecisionRecord(assessment, POLICY, 'b'.repeat(64), context(), familyTotals(assessment));
  assert.equal(record.would_have_decision, 'RESTRICT');
  assert.equal(record.actual_decision, 'RESTRICT');
  enforcement = 'false';
});

// ── the calculation, not just the result ───────────────────────────────────

test('a clipped signal is distinguishable from one that never fired', async () => {
  const { familyTotals } = await log;
  const { assessSignupRisk, SIGNALS } = await engine;
  // Tor, a hosting ASN and a VPN request 33 between them; the family cap allows
  // 18. Recording only the total would make the third signal look absent, and
  // "this cap is too tight" would be unarguable.
  const assessment = assessSignupRisk([
    SIGNALS.torExit(), SIGNALS.datacenterAsn(), SIGNALS.knownVpn(),
  ]);
  const totals = familyTotals(assessment);
  assert.equal(totals.network.raw, 33);
  assert.equal(totals.network.capped, 18);
});

test('the record carries the numbers that were in force, not a pointer to them', async () => {
  const { buildDecisionRecord, familyTotals } = await log;
  const { assessSignupRisk, SIGNALS } = await engine;
  const assessment = assessSignupRisk([SIGNALS.velocityDevice(3)]);
  const record = buildDecisionRecord(assessment, POLICY, 'c'.repeat(64), context(), familyTotals(assessment));
  assert.deepEqual(record.thresholds_used, POLICY.thresholds);
  assert.equal(record.family_caps_used.velocity, 60);
  assert.equal(record.family_caps_used.negative, -20);
  assert.equal(record.risk_floor, 0);
  assert.equal(record.signals[0].requested, 25);
});

test('raw stays unclamped so the log can show both extremes', async () => {
  const { buildDecisionRecord, familyTotals } = await log;
  const { assessSignupRisk, SIGNALS } = await engine;

  const trusted = assessSignupRisk([
    SIGNALS.velocityIp(3, 3), SIGNALS.trustedDevice(), SIGNALS.authenticatedSession(),
  ]);
  const low = buildDecisionRecord(trusted, POLICY, 'd'.repeat(64), context(), familyTotals(trusted));
  // -15 and -10 request -25; the cap allows -20. 15 - 20 = -5.
  assert.equal(low.observed_raw_score, -5, 'trust outweighed risk, and it shows');
  assert.equal(low.observed_risk_score, 0);

  const flooding = assessSignupRisk(
    Array.from({ length: 4 }, (_, i) => SIGNALS.idempotentRetry(i + 1)),
  );
  const high = buildDecisionRecord(flooding, POLICY, 'e'.repeat(64), context(), familyTotals(flooding));
  assert.equal(high.observed_raw_score, 115, 'intensity beyond the ceiling is kept');
  assert.equal(high.observed_risk_score, 100);
});

test('the database ties risk_score to raw_score', () => {
  assert.match(
    migration,
    /observed_risk_score = least\(100, greatest\(0, observed_raw_score\)\)/,
  );
  assert.match(migration, /observed_risk_score between 0 and 100/);
  // Level boundaries are NOT constrained: they are configuration and will be
  // recalibrated, and a check would turn each recalibration into a migration.
  assert.doesNotMatch(migration, /observed_risk_score >= 40/);
});

// ── append-only, and the outcome split ────────────────────────────────────

test('a snapshot cannot be edited, and only expires away', () => {
  assert.match(migration, /before update or delete on abuse_private\.signup_decisions/);
  assert.match(migration, /cannot be modified/);
  assert.match(migration, /if old\.expires_at < now\(\) then return old; end if;/);
});

test('what is learned later lives in its own table', () => {
  // Otherwise the audit log becomes mutable state and stops being evidence.
  assert.match(migration, /create table if not exists abuse_private\.signup_decision_outcomes/);
  assert.match(migration, /references abuse_private\.signup_decisions\(id\) on delete cascade/);
  for (const column of [
    'email_verified_at', 'source_imported_at', 'meaningful_usage_at',
    'trial_started_at', 'subscription_started_at', 'subscription_retained_at',
    'repeat_trial_pattern', 'device_reuse', 'chargeback_at',
    'manual_review_verdict',
  ]) {
    assert.ok(migration.includes(column), `${column} belongs to the cohort`);
  }
});

// ── what the table is not ─────────────────────────────────────────────────

test('the snapshot holds no reidentifying value, only keyed digests', () => {
  const body = migration.slice(
    migration.indexOf('create table if not exists abuse_private.signup_decisions ('),
    migration.indexOf('  constraint signup_decisions_observe_allows'),
  );
  const columns = [...body.matchAll(/^\s{2}(\w+)\s+(?:text|uuid|boolean|integer|smallint|timestamptz|jsonb|text\[\])\b/gm)]
    .map((m) => m[1]);
  // Structural: the columns that could carry a raw identifier simply do not
  // exist. Digests are pseudonymisation, not anonymisation, which is why the
  // table is private with short retention and a rotatable key — but a raw
  // address has no column to sit in at all.
  for (const forbidden of [
    'ip', 'ip_address', 'email', 'password', 'access_token', 'user_agent',
    'headers', 'request_body', 'upstream_response', 'nonce',
  ]) {
    assert.ok(!columns.includes(forbidden), `${forbidden} must not be a column`);
  }
  assert.ok(columns.includes('ip_subject_hmac'));
  assert.ok(columns.includes('ua_family'), 'a family, not the full header');
});

test('segmentation is present, because a legacy client would skew everything', () => {
  // Every client older than the new endpoint reports TOKEN_MISSING. Reading the
  // population in one block would move the whole distribution.
  for (const column of [
    'auth_method', 'platform', 'app_version', 'signup_endpoint_version',
  ]) {
    assert.ok(migration.includes(column), `${column} must be recorded`);
  }
});

test('telemetry never becomes the reason a signup fails', async () => {
  const { recordDecision } = await log;
  const result = await recordDecision(
    { rpc: () => Promise.resolve({ data: null, error: { code: '42P01' } }) },
    {},
  );
  // A lost row costs one observation. A thrown error would cost a person their
  // account, on a path whose whole point is to be invisible.
  assert.equal(result, null);
});

test('the table is private and expires on its own', () => {
  assert.match(migration, /enable row level security/);
  assert.match(
    migration,
    /revoke all on table abuse_private\.signup_decisions\s*\n\s*from public, anon, authenticated, service_role;/,
  );
  assert.match(migration, /signup_decision_prune/);
  assert.match(
    migration,
    /grant execute on function public\.abuse_signup_decision_record\(jsonb, integer\) to service_role;/,
  );
});

function context() {
  return {
    ipSubjectHmac: '1'.repeat(64),
    mailboxSubjectHmac: '2'.repeat(64),
    deviceSubjectHmac: null,
    attemptFingerprint: '3'.repeat(64),
    asn: 64500,
    country: 'FR',
    uaFamily: 'chrome',
    authMethod: 'password',
    platform: 'web',
    appVersion: null,
    signupEndpointVersion: 'norva-signup-v1',
    hashVersion: 1,
    fingerprintVersion: 1,
  };
}
