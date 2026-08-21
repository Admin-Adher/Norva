'use strict';

// Every arbitration settled in review is pinned here as a scenario. The scoring
// model is arguable, which is exactly why the arguments belong in a test file
// rather than in a comment: changing a weight has to break a named case.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const loading = importTypescriptModule(path.join(
  __dirname,
  '..',
  'supabase/functions/_shared/signup-risk-engine.ts',
));

test('a family sharing one laptop is not a suspect', async () => {
  const { assessSignupRisk, SIGNALS } = await loading;
  // Third account on the browser, third signup on the home connection, and one
  // of the earlier accounts is a healthy verified one. This is the case an
  // earlier draft got wrong: a rule disabling trust whenever velocity fired
  // pushed it to MEDIUM, because the device tier is itself +25.
  const result = assessSignupRisk([
    SIGNALS.velocityDevice(3),
    SIGNALS.velocityIp(3, 3),
    SIGNALS.trustedDevice(),
  ]);
  assert.equal(result.rawScore, 25);
  assert.equal(result.level, 'LOW');
});

test('a double click costs monitoring, never a refusal', async () => {
  const { assessSignupRisk, SIGNALS, tokenStateAllowsTiming } = await loading;
  // A replay is not proof of automation: a double click, a network retry or a
  // service worker all produce one.
  const result = assessSignupRisk([SIGNALS.idempotentRetry(1)]);
  assert.equal(result.riskScore, 40);
  assert.equal(result.level, 'MEDIUM');
  // And the timing must not be judged on a replay, or the same double click
  // would collect 40 + 30 and land in HIGH on one human accident.
  assert.equal(tokenStateAllowsTiming('TOKEN_VALID_REPLAYED'), false);
});

test('replays escalate as they repeat', async () => {
  const { assessSignupRisk, SIGNALS } = await loading;
  const at = (n) => assessSignupRisk(
    Array.from({ length: n }, (_, i) => SIGNALS.idempotentRetry(i + 1)),
  );
  assert.equal(at(1).level, 'MEDIUM');
  assert.equal(at(2).riskScore, 65);
  assert.equal(at(2).level, 'HIGH');
  assert.equal(at(3).riskScore, 90);
  assert.equal(at(3).level, 'CRITICAL');
  // raw_score is kept unclamped: knowing a request reached 115 rather than
  // simply "100" is worth having when the distributions are read.
  assert.equal(at(4).rawScore, 115);
  assert.equal(at(4).riskScore, 100);
});

test('strong evidence cannot be laundered by trust', async () => {
  const { assessSignupRisk, SIGNALS } = await loading;
  const forged = assessSignupRisk([
    SIGNALS.tokenInvalid(),
    SIGNALS.trustedDevice(),
    SIGNALS.credibleInteraction(),
  ]);
  // 55 - 20 = 35, but the floor holds it at 55.
  assert.equal(forged.floorApplied, 55);
  assert.equal(forged.rawScore, 55);

  const honeypot = assessSignupRisk([SIGNALS.honeypot(), SIGNALS.trustedDevice()]);
  assert.equal(honeypot.rawScore, 45);
  assert.equal(honeypot.level, 'MEDIUM');
});

test('a honeypot alone is MEDIUM, never a block', async () => {
  const { assessSignupRisk, SIGNALS, LEVEL_THRESHOLDS } = await loading;
  const result = assessSignupRisk([SIGNALS.honeypot()]);
  assert.equal(result.level, 'MEDIUM');
  assert.ok(result.riskScore < LEVEL_THRESHOLDS.high,
    'a password manager touching an invisible field must not refuse a signup');
});

test('no single signal reaches HIGH', async () => {
  const { assessSignupRisk, SIGNALS, LEVEL_THRESHOLDS } = await loading;
  const singles = [
    SIGNALS.tokenInvalid(), SIGNALS.honeypot(), SIGNALS.tokenMissing(),
    SIGNALS.idempotentRetry(1), SIGNALS.nonceIntentMismatch(), SIGNALS.tokenExpired(),
    SIGNALS.submissionUnder1500ms(), SIGNALS.submissionUnder3000ms(),
    SIGNALS.velocityDevice(5), SIGNALS.velocityIp(5, 5), SIGNALS.velocitySubnet(8),
    SIGNALS.velocityEmailExact(3), SIGNALS.velocityMailbox(3),
    SIGNALS.datacenterAsn(), SIGNALS.torExit(), SIGNALS.knownVpn(),
    SIGNALS.headlessUserAgent(), SIGNALS.missingUserAgent(),
    SIGNALS.clientHintsContradiction(), SIGNALS.missingAcceptLanguage(),
    SIGNALS.disposableEmailDomain(),
  ].filter(Boolean);
  for (const signal of singles) {
    const { riskScore, level } = assessSignupRisk([signal]);
    assert.ok(riskScore < LEVEL_THRESHOLDS.high, `${signal.code} reached ${riskScore}`);
    assert.notEqual(level, 'HIGH');
    assert.notEqual(level, 'CRITICAL');
  }
});

test('who someone is never adds up to a verdict', async () => {
  const { assessSignupRisk, SIGNALS, LEVEL_THRESHOLDS } = await loading;
  // VPN, Tor, a hosting ASN, a throwaway domain and a missing Accept-Language:
  // every profile signal at once, and nothing behavioural.
  const result = assessSignupRisk([
    SIGNALS.knownVpn(), SIGNALS.datacenterAsn(), SIGNALS.torExit(),
    SIGNALS.disposableEmailDomain(), SIGNALS.missingAcceptLanguage(),
  ]);
  assert.ok(result.riskScore < LEVEL_THRESHOLDS.high, `reached ${result.riskScore}`);
  assert.equal(result.contributions.find((c) => c.code === 'network_tor_exit').capped, true,
    'the network family is capped at 18, so these cannot stack');
});

test('a privacy-conscious developer is left alone', async () => {
  const { assessSignupRisk, SIGNALS } = await loading;
  const result = assessSignupRisk([
    SIGNALS.knownVpn(), SIGNALS.datacenterAsn(), SIGNALS.missingAcceptLanguage(),
  ]);
  assert.equal(result.level, 'LOW');
});

test('an ordinary Gmail address with dots and digits scores nothing', async () => {
  const { assessSignupRisk } = await loading;
  // The shape of an address is never a signal. firstname.lastname.12345@gmail.com
  // is not evidence of anything.
  const result = assessSignupRisk([]);
  assert.equal(result.riskScore, 0);
  assert.equal(result.level, 'SAFE');
});

test('an obvious script is caught outright', async () => {
  const { assessSignupRisk, SIGNALS } = await loading;
  const result = assessSignupRisk([
    SIGNALS.tokenMissing(),
    SIGNALS.submissionUnder1500ms(),
    SIGNALS.headlessUserAgent(),
    SIGNALS.velocityIp(5, 5),
  ]);
  assert.equal(result.level, 'CRITICAL');
  assert.ok(result.familiesInvolved.length >= 3, 'several independent families');
  assert.equal(result.repeatedStrongEvidence, true);
});

test('one dimension contributes only its highest tier', async () => {
  const { SIGNALS } = await loading;
  // 5 accounts on a device matches both the 3rd and 5th tiers; returning both
  // would put one dimension at 65 and let a single signal reach HIGH.
  assert.equal(SIGNALS.velocityDevice(5).weight, 40);
  assert.equal(SIGNALS.velocityIp(5, 20).code, 'velocity_ip_5_per_1h');
});

test('a common User-Agent counts for almost nothing, and only with behaviour', async () => {
  const { SIGNALS } = await loading;
  // At Norva's scale a shared Chrome build fires by arithmetic alone.
  assert.equal(SIGNALS.sharedUserAgent(false), null);
  assert.equal(SIGNALS.sharedUserAgent(true).weight, 5);
});

test('the ASN is not a per-user signal at all', async () => {
  const { SIGNALS } = await loading;
  // A consumer ASN can carry millions of subscribers, so a raw signup count per
  // ASN becomes true by growth rather than by abuse. It survives only as network
  // reputation and as global anomaly detection.
  assert.equal(SIGNALS.velocityAsn, undefined);
});

test('trust is bounded, so it can never become a laundering path', async () => {
  const { assessSignupRisk, SIGNALS, NEGATIVE_CAP } = await loading;
  const result = assessSignupRisk([
    SIGNALS.velocityIp(3, 3),
    SIGNALS.trustedDevice(),
    SIGNALS.authenticatedSession(),
    SIGNALS.credibleInteraction(),
  ]);
  // -15 -10 -5 is -30, capped to -20.
  assert.equal(result.rawScore, 15 + NEGATIVE_CAP);
  assert.equal(result.riskScore, 0, 'clamped, never negative');
});

test('families are recorded even when their budget is spent', async () => {
  const { assessSignupRisk, SIGNALS } = await loading;
  const result = assessSignupRisk([
    SIGNALS.honeypot(),
    SIGNALS.idempotentRetry(1),
  ]);
  // 85 is CRITICAL by score, but both signals are behavioural accidents that a
  // human can produce. The enforcement rule will require two independent
  // families; recording that now is the only way to answer later how many HIGH
  // verdicts rested on one kind of evidence twice.
  assert.equal(result.riskScore, 85);
  assert.deepEqual(result.familiesInvolved, ['behaviour']);
});

test('timing is judged only where the timestamp can be trusted', async () => {
  const { tokenStateAllowsTiming } = await loading;
  assert.equal(tokenStateAllowsTiming('TOKEN_VALID_FRESH'), true);
  assert.equal(tokenStateAllowsTiming('TOKEN_VALID_EXPIRED'), true);
  // No signature verified means no trustworthy server timestamp to measure from.
  assert.equal(tokenStateAllowsTiming('TOKEN_MISSING'), false);
  assert.equal(tokenStateAllowsTiming('TOKEN_INVALID'), false);
  assert.equal(tokenStateAllowsTiming('TOKEN_VALID_REPLAYED'), false);
});

test('thresholds are injectable, so an attack is answered by configuration', async () => {
  const { assessSignupRisk, SIGNALS } = await loading;
  const signals = [SIGNALS.honeypot()];
  assert.equal(assessSignupRisk(signals).level, 'MEDIUM');
  assert.equal(
    assessSignupRisk(signals, {
      thresholds: { low: 10, medium: 20, high: 30, critical: 40 },
    }).level,
    'CRITICAL',
  );
});
