'use strict';

// The boundary either holds or it does not, so these are all behavioural: forge
// a value, change a byte, point an envelope at another route, replay it late,
// and each one has to be refused for its own named reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const root = path.join(__dirname, '..');
const modulePath = path.join(root, 'supabase/functions/_shared/edge-ingress.ts');
const loading = importTypescriptModule(modulePath);
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260822110000_abuse_ingress_request_ids.sql'),
  'utf8',
);

const KEYS = { currentVersion: 2, current: 'k'.repeat(48), previousVersion: 1, previous: 'j'.repeat(48) };
const NOW = 1_700_000_000_000;
const BODY = new TextEncoder().encode(JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(12) }));

async function envelopeFor(mod, overrides = {}) {
  return {
    version: mod.INGRESS_VERSION,
    keyVersion: KEYS.currentVersion,
    audience: mod.INGRESS_AUDIENCE_SIGNUP,
    timestampMs: NOW,
    requestId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    method: 'POST',
    route: '/',
    contentType: 'application/json',
    bodyHash: await mod.hashBody(BODY),
    clientIp: '88.163.67.137',
    asn: 3215,
    country: 'FR',
    ...overrides,
  };
}

function expectation(mod, overrides = {}) {
  return {
    audience: mod.INGRESS_AUDIENCE_SIGNUP,
    method: 'POST',
    route: '/',
    contentType: 'application/json; charset=utf-8',
    rawBody: BODY,
    nowMs: NOW + 500,
    ...overrides,
  };
}

test('a properly signed envelope is accepted and yields the network facts', async () => {
  const mod = await loading;
  const header = await mod.signIngress(await envelopeFor(mod), KEYS.current);
  const verdict = await mod.verifyIngress(header, KEYS, expectation(mod));
  assert.equal(verdict.ok, true);
  const facts = mod.trustedFacts(verdict.envelope);
  assert.deepEqual(facts, { clientIp: '88.163.67.137', asn: 3215, country: 'FR' });
});

test('one changed byte in the body invalidates the request', async () => {
  const mod = await loading;
  const header = await mod.signIngress(await envelopeFor(mod), KEYS.current);
  // The hash is taken over raw bytes precisely so this cannot slip through: a
  // parsed-then-reserialised comparison would accept a body that two layers
  // render differently.
  const tampered = new Uint8Array(BODY);
  tampered[tampered.length - 1] ^= 0x01;
  const verdict = await mod.verifyIngress(header, KEYS, expectation(mod, { rawBody: tampered }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'ingress_body_mismatch');
});

test('an envelope cannot be pointed at another route', async () => {
  const mod = await loading;
  const header = await mod.signIngress(await envelopeFor(mod), KEYS.current);
  // The signed method and route are compared against what was actually served.
  // Reading them out of the envelope and believing them would let one signed
  // statement be aimed at a different handler.
  //
  // The route is FUNCTION-RELATIVE, not a URL path. Kong carries
  // strip_path: true on functions-v1, so signing the full path bound the
  // signature to a value the gateway rewrote in transit — every request was
  // refused as ingress_route_mismatch in production, which is how this was
  // found. '/token' against '/' is the real cross-route replay this stops.
  for (const overrides of [
    { route: '/token' },
    { method: 'GET' },
  ]) {
    const verdict = await mod.verifyIngress(header, KEYS, expectation(mod, overrides));
    assert.equal(verdict.reason, 'ingress_route_mismatch', JSON.stringify(overrides));
  }
});

test('an envelope minted for another service is refused', async () => {
  const mod = await loading;
  const header = await mod.signIngress(
    await envelopeFor(mod, { audience: 'norva-partners-edge-v1' }),
    KEYS.current,
  );
  const verdict = await mod.verifyIngress(header, KEYS, expectation(mod));
  assert.equal(verdict.reason, 'ingress_audience_mismatch');
});

test('a captured envelope dies quickly, and a future one is refused', async () => {
  const mod = await loading;
  const header = await mod.signIngress(await envelopeFor(mod), KEYS.current);
  const stale = await mod.verifyIngress(header, KEYS, expectation(mod, {
    nowMs: NOW + mod.INGRESS_MAX_AGE_MS + 1000,
  }));
  assert.equal(stale.reason, 'ingress_stale');

  // Clocks drift; a minute either way is not an attack.
  const skewed = await mod.verifyIngress(header, KEYS, expectation(mod, { nowMs: NOW - 30_000 }));
  assert.equal(skewed.ok, true);
  const future = await mod.verifyIngress(header, KEYS, expectation(mod, { nowMs: NOW - 120_000 }));
  assert.equal(future.reason, 'ingress_future');
});

test('a forged signature is refused, and so is a swapped key', async () => {
  const mod = await loading;
  const envelope = await envelopeFor(mod);
  const header = await mod.signIngress(envelope, KEYS.current);
  const [v, body] = header.split('.');

  const forged = await mod.verifyIngress(`${v}.${body}.${'A'.repeat(43)}`, KEYS, expectation(mod));
  assert.equal(forged.reason, 'ingress_signature_invalid');

  // Signed with the previous key but claiming the current version: the version
  // selects the key, so this cannot pass.
  const mismatched = await mod.signIngress(envelope, KEYS.previous);
  const verdict = await mod.verifyIngress(mismatched, KEYS, expectation(mod));
  assert.equal(verdict.reason, 'ingress_signature_invalid');
});

test('rotation works: the previous key is accepted, an unknown one is not', async () => {
  const mod = await loading;
  // Planned now rather than during an emergency.
  const old = await mod.signIngress(
    await envelopeFor(mod, { keyVersion: KEYS.previousVersion }),
    KEYS.previous,
  );
  assert.equal((await mod.verifyIngress(old, KEYS, expectation(mod))).ok, true);

  // Once the rotation window closes, the keyring no longer carries it.
  const narrowed = { currentVersion: KEYS.currentVersion, current: KEYS.current };
  assert.equal(
    (await mod.verifyIngress(old, narrowed, expectation(mod))).reason,
    'ingress_key_unknown',
  );
});

test('a body larger than a signup could need is refused before anything else', async () => {
  const mod = await loading;
  const header = await mod.signIngress(await envelopeFor(mod), KEYS.current);
  const huge = new Uint8Array(mod.MAX_INGRESS_BODY_BYTES + 1);
  const verdict = await mod.verifyIngress(header, KEYS, expectation(mod, { rawBody: huge }));
  // Cheapest possible refusal: no hashing, no parsing, no crypto.
  assert.equal(verdict.reason, 'ingress_body_too_large');
});

test('only JSON is accepted, however the header is spelled', async () => {
  const mod = await loading;
  const header = await mod.signIngress(await envelopeFor(mod), KEYS.current);
  // Parameters are dropped and case folded, so "application/json; charset=utf-8"
  // is the same content type.
  assert.equal((await mod.verifyIngress(header, KEYS, expectation(mod, {
    contentType: 'Application/JSON',
  }))).ok, true);
  assert.equal((await mod.verifyIngress(header, KEYS, expectation(mod, {
    contentType: 'text/plain',
  }))).reason, 'ingress_content_type_mismatch');
});

test('a missing or malformed header is named, not guessed at', async () => {
  const mod = await loading;
  assert.equal((await mod.verifyIngress(null, KEYS, expectation(mod))).reason, 'ingress_header_missing');
  for (const junk of ['nonsense', '1.2', '1.2.3.4']) {
    const verdict = await mod.verifyIngress(junk, KEYS, expectation(mod));
    assert.ok(
      ['ingress_header_malformed', 'ingress_version_unknown'].includes(verdict.reason),
      `${junk} -> ${verdict.reason}`,
    );
  }
});

test('derived metadata may be absent without refusing a legitimate signup', async () => {
  const mod = await loading;
  // The signed client IP is the primary network fact. ASN and country are
  // observability and a weak signal; Cloudflare not supplying them is not a
  // reason to refuse anybody.
  const header = await mod.signIngress(
    await envelopeFor(mod, { asn: null, country: null }),
    KEYS.current,
  );
  const verdict = await mod.verifyIngress(header, KEYS, expectation(mod));
  assert.equal(verdict.ok, true);
  assert.deepEqual(mod.trustedFacts(verdict.envelope), {
    clientIp: '88.163.67.137', asn: null, country: null,
  });
});

test('nonsense metadata is dropped rather than believed', async () => {
  const mod = await loading;
  const header = await mod.signIngress(
    await envelopeFor(mod, { asn: 99999999999, country: 'france' }),
    KEYS.current,
  );
  const verdict = await mod.verifyIngress(header, KEYS, expectation(mod));
  assert.equal(verdict.ok, true, 'a signed envelope stays authentic');
  const facts = mod.trustedFacts(verdict.envelope);
  assert.equal(facts.asn, null);
  assert.equal(facts.country, null);
});

test('normalisation is identical on both sides', async () => {
  const mod = await loading;
  assert.equal(mod.normalisePath('/a//b/?x=1#y'), '/a/b');
  assert.equal(mod.normalisePath('a/b/'), '/a/b');
  assert.equal(mod.normalisePath('/'), '/');
  assert.equal(mod.normaliseMethod(' post '), 'POST');
  assert.equal(mod.normaliseContentType('Application/JSON; charset=UTF-8'), 'application/json');
});

test('the canonical form cannot be rearranged into another valid one', async () => {
  const mod = await loading;
  const a = mod.canonicalEnvelope(await envelopeFor(mod, { method: 'POST', route: '/x' }));
  const b = mod.canonicalEnvelope(await envelopeFor(mod, { method: 'POST/x', route: '' }));
  assert.notEqual(a, b);
});

test('the request id is consumed atomically, exactly once', () => {
  // Same discipline as the signup nonce: the insert is the lock, so a burst of
  // identical replays produces one winner and no select-then-insert window.
  assert.match(migration, /on conflict \(request_id\) do nothing/);
  assert.doesNotMatch(migration, /pg_advisory/i);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /expires_at < now\(\)/);
  // Short-lived on purpose: this protects one transport hop, not a user session.
  assert.match(migration, /300/);
});
