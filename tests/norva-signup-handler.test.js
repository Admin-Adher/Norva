'use strict';

// The handler's contract is an ORDER, so these assertions are about order. A
// module that calls the database before verifying a signature, or writes its
// decision snapshot after hearing back from GoTrue, is wrong in a way no unit
// test on its pieces would catch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const handler = read('supabase/functions/norva-signup/index.ts');
const proxy = read('functions/_shared/signup-ingress.ts');

const at = (needle, from = 0) => {
  const index = handler.indexOf(needle, from);
  assert.ok(index >= 0, `missing: ${needle}`);
  return index;
};

test('nothing costly happens before the ingress signature holds', () => {
  const verify = at('await verifyIngress(');
  // The publicly reachable edge will receive invalid signatures whatever the
  // design, so the refusal has to be cheap. Crypto answers impersonation; the
  // Kong floor answers volume.
  assert.ok(at('await req.arrayBuffer()') < verify, 'the body is read first, and capped');
  assert.ok(at('MAX_INGRESS_BODY_BYTES) return opaque(413)') < verify);
  assert.ok(verify < at('createClient('), 'no database client before verification');
  assert.ok(verify < at('JSON.parse(new TextDecoder().decode(rawBody))'), 'no parsing before it');
});

test('the request id is consumed before any work worth replaying', () => {
  const consume = at('abuse_ingress_request_consume');
  assert.ok(at('await verifyIngress(') < consume, 'authenticity first');
  assert.ok(consume < at('readPayload(JSON.parse('), 'then single-use, then work');
});

test('the decision snapshot is written before GoTrue is called', () => {
  const snapshot = at('await recordDecision(db, record)');
  const upstream = at('await fetch(');
  // The snapshot has to be what was known at the moment of the signup. Writing
  // it afterwards would let the outcome colour the evidence.
  assert.ok(snapshot < upstream, 'evidence before outcome');
  assert.ok(at('assessSignupRisk(signals') < snapshot);
});

test('a replay answers from memory and never reaches GoTrue', () => {
  const replay = at('if (claim?.outcome === "replay") {\n    if (claim.state === "SUCCESS")');
  const upstream = at('await fetch(');
  assert.ok(replay < upstream, 'the memoised answer returns before the call');
  // A double click must produce exactly one upstream call, so every branch of a
  // replay returns.
  const block = handler.slice(replay, upstream);
  assert.match(block, /return json\(\{ status: "ok"/);
  assert.match(block, /return json\(\{ status: "pending" \}, 202\)/);
  assert.match(block, /if \(claim\?\.outcome === "intent_mismatch"\) return opaque\(409\)/);
  assert.ok(!block.includes('fetch('), 'no upstream call on any replay path');
});

test('an ambiguous upstream failure becomes UNKNOWN, never a blind retry', () => {
  const block = handler.slice(at('} catch (error) {', at('await fetch(')));
  assert.match(block, /"UNKNOWN"/);
  // A deterministic refusal is final; a timeout after the account may already
  // exist is not.
  assert.match(handler, /"FAILED_FINAL", null, upstreamStatus/);
  assert.ok(!block.slice(0, block.indexOf('return')).includes('fetch('), 'no retry inside the catch');
});

test('enforcement gates the one line that could refuse', () => {
  // When enforcement is switched on, this is the only behaviour that changes.
  assert.match(handler, /if \(record\.actual_decision !== "ALLOW"\) return opaque\(429\);/);
  const gate = at('if (record.actual_decision !== "ALLOW")');
  assert.ok(at('await recordDecision(db, record)') < gate, 'observed even when refused');
});

test('velocity failure removes signals and refuses nobody', () => {
  const block = handler.slice(at('signup_velocity_unavailable') - 600, at('signup_velocity_unavailable') + 200);
  // A broken counter must never stop a legitimate account being created.
  assert.match(block, /catch \(error\)/);
  assert.ok(!block.includes('return opaque'), 'no refusal in the velocity catch');
});

test('nothing the person typed is ever logged', () => {
  for (const source of [handler, proxy]) {
    // Structural: the logger is only ever handed named scalars, and these
    // identifiers never appear inside a log call.
    const logCalls = [...source.matchAll(/(?:logEvent|console\.\w+)\([\s\S]{0,900}?\n\s*\}\);/g)]
      .map((m) => m[0]).join('\n');
    for (const forbidden of [
      'payload.email', 'payload.password', 'payload.formToken', 'payload.honeypot',
      'rawBody', 'req.body', 'request.body', 'JSON.stringify(payload',
    ]) {
      assert.ok(!logCalls.includes(forbidden), `${forbidden} must not reach a log`);
    }
  }
});

test('an exception is never bound to an object that holds a credential', () => {
  // A stacktrace carrying the request would carry the password with it.
  assert.match(proxy, /\} catch \{/, 'the proxy catch binds nothing');
  // On the edge, the one bound catch reports a name, never the payload.
  assert.match(handler, /String\(\(error as Error\)\?\.name \?\? "unknown"\)/);
});

test('every refusal looks the same from outside', () => {
  // "Your IP has created 3 accounts and our maximum is 3" tells an attacker
  // exactly what to pace against. The reason lives in the logs and the snapshot.
  assert.match(handler, /Unable to complete registration\. Please try again later\./);
  assert.match(proxy, /Unable to complete registration\. Please try again later\./);
  const opaqueCalls = (handler.match(/return opaque\(\d+\)/g) || []).length;
  assert.ok(opaqueCalls >= 6, `expected several opaque refusals, found ${opaqueCalls}`);
});

test('health reports whether the path can work, never with what', () => {
  const block = handler.slice(at('service: "norva-signup"'), at('// 1 — route'));
  assert.match(block, /ingress_current: Boolean\(/);
  // Booleans only: a health endpoint that echoed a secret would be a very quiet
  // way to leak one.
  assert.ok(!block.includes('INGRESS_KEYS.current,'), 'no value is echoed');
  assert.ok(!block.includes('SERVICE_KEY,'));
});

test('the token route needs an authenticated ingress like everything else', () => {
  const tokenRoute = at('if (path === "/token") {');
  assert.ok(at('await verifyIngress(') < tokenRoute);
  assert.ok(at('abuse_ingress_request_consume') < tokenRoute, 'single-use too');
  // Issuing a token is cheap, which is exactly why it needs its own floor.
  assert.match(read('functions/api/signup-token.ts'), /own volumetric floor/);
});
