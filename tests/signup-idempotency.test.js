'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { bundleTypescriptModule } = require('./helpers/bundle-typescript-module');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const migration = read('supabase/migrations/20260822090000_abuse_signup_idempotency.sql');

const TOKEN_SECRET = 'token-secret-long-enough-to-pass-the-guard';
const IDEMPOTENCY_SECRET = 'idem-secret-long-enough-to-pass-the-guard';

const previousDeno = globalThis.Deno;
globalThis.Deno = {
  env: {
    get(name) {
      if (name === 'NORVA_SIGNUP_TOKEN_SECRET') return TOKEN_SECRET;
      if (name === 'NORVA_SIGNUP_IDEMPOTENCY_SECRET') return IDEMPOTENCY_SECRET;
      if (name === 'NORVA_ABUSE_HASH_SALT') return 'hash-key-long-enough-to-pass-the-guard';
      return undefined;
    },
  },
};

const tokens = bundleTypescriptModule(
  path.join(root, 'supabase/functions/_shared/signup-form-token.ts'),
);
const idem = bundleTypescriptModule(
  path.join(root, 'supabase/functions/_shared/signup-idempotency.ts'),
);

test.after(async () => {
  await Promise.all([tokens, idem]);
  if (previousDeno === undefined) delete globalThis.Deno;
  else globalThis.Deno = previousDeno;
});

// ── the signed form token ───────────────────────────────────────────────────

test('a token the server issued verifies, and its age is measured from the server clock', async () => {
  const { issueFormToken, verifyFormToken } = await tokens;
  const now = 1_700_000_000_000;
  const { token, nonce } = await issueFormToken(now);
  const verdict = await verifyFormToken(token, now + 800);
  assert.equal(verdict.state, 'TOKEN_VALID_FRESH');
  assert.equal(verdict.payload.nonce, nonce);
  // 800 ms is the number the timing signal needs, and it comes from a value the
  // client cannot edit.
  assert.equal(verdict.ageMs, 800);
});

test('a client cannot edit the timestamp it is judged on', async () => {
  const { issueFormToken, verifyFormToken } = await tokens;
  const now = 1_700_000_000_000;
  const { token } = await issueFormToken(now);
  const [version, body, mac] = token.split('.');
  // Rewrite the payload to claim the form was issued ten minutes ago, so an
  // 800 ms submission would look like a leisurely one.
  const forged = Buffer.from(JSON.stringify({ n: 'a'.repeat(32), t: now - 600_000 }))
    .toString('base64url');
  assert.notEqual(forged, body);
  const verdict = await verifyFormToken(`${version}.${forged}.${mac}`, now + 800);
  assert.equal(verdict.state, 'TOKEN_INVALID');
  assert.equal(verdict.payload, null);
});

test('an old token is expired rather than invalid, and a missing one is neither', async () => {
  const { issueFormToken, verifyFormToken, TOKEN_MAX_AGE_MS } = await tokens;
  const now = 1_700_000_000_000;
  const { token } = await issueFormToken(now);
  // A tab left open while making coffee is not an anomaly; the weight for this
  // state is 10, not 55.
  const stale = await verifyFormToken(token, now + TOKEN_MAX_AGE_MS + 1000);
  assert.equal(stale.state, 'TOKEN_VALID_EXPIRED');
  assert.ok(stale.payload, 'an expired token is still authentic');

  for (const absent of [null, undefined, '']) {
    assert.equal((await verifyFormToken(absent, now)).state, 'TOKEN_MISSING');
  }
  for (const junk of ['nonsense', '1.2', '1.2.3.4', '2.abc.def']) {
    assert.equal((await verifyFormToken(junk, now)).state, 'TOKEN_INVALID', junk);
  }
});

test('a token stamped in the future is refused, not treated as fresh', async () => {
  const { issueFormToken, verifyFormToken } = await tokens;
  const now = 1_700_000_000_000;
  const { token } = await issueFormToken(now);
  // Beyond a minute of clock skew it is a forgery or a broken clock; either way
  // its age cannot be measured.
  assert.equal((await verifyFormToken(token, now - 300_000)).state, 'TOKEN_INVALID');
  // Inside the tolerance it still works, because real clocks drift.
  assert.equal((await verifyFormToken(token, now - 5_000)).state, 'TOKEN_VALID_FRESH');
});

test('the token layer never rules on replay', async () => {
  const { issueFormToken, verifyFormToken } = await tokens;
  const now = 1_700_000_000_000;
  const { token } = await issueFormToken(now);
  // Verifying twice returns FRESH twice: authenticity is not first use. Freshness
  // of USE is the idempotency layer's answer, and keeping the two apart is what
  // stops a double click from being scored as a forgery.
  assert.equal((await verifyFormToken(token, now + 10)).state, 'TOKEN_VALID_FRESH');
  assert.equal((await verifyFormToken(token, now + 20)).state, 'TOKEN_VALID_FRESH');
});

// ── the request fingerprint ────────────────────────────────────────────────

test('the fingerprint is keyed by a server secret, never by the nonce', async () => {
  const { signupRequestFingerprint, FINGERPRINT_VERSION } = await idem;
  const nonce = 'b'.repeat(32);
  const fingerprint = await signupRequestFingerprint({
    nonce, email: 'user@example.com', surface: 'web', authMethod: 'password',
  });
  assert.match(fingerprint, /^[0-9a-f]{64}$/);

  // The nonce travels to the browser, so it is not a secret and keying with it
  // would let anyone holding a token recompute the fingerprint.
  const keyedByNonce = nodeCrypto.createHmac('sha256', nonce)
    .update(`${FINGERPRINT_VERSION}${nonce}user@example.comwebpassword`).digest('hex');
  assert.notEqual(fingerprint, keyedByNonce);

  // Reproduce the real construction: server key, nonce inside the message,
  // fields length-prefixed.
  const field = (v) => `${String(v).length}:${v}`;
  const message = [
    field(FINGERPRINT_VERSION), field(nonce), field('email:user@example.com'),
    field('web'), field('password'),
    // No credential supplied, so the binding is the fixed marker.
    field('none'),
    // displayName, redirectTo, signupContext: all absent here, each an
    // empty-string field rather than skipped, so their position in the
    // message stays fixed whether or not a caller ever sends them.
    field(''), field(''), field(''),
  ].join('|');
  const expected = nodeCrypto.createHmac('sha256', IDEMPOTENCY_SECRET)
    .update(message).digest('hex');
  assert.equal(fingerprint, expected);
});

test('the same intent is one fingerprint however the address is spelled', async () => {
  const { signupRequestFingerprint } = await idem;
  const base = { nonce: 'c'.repeat(32), surface: 'web', authMethod: 'password' };
  const canonical = await signupRequestFingerprint({ ...base, email: 'user@example.com' });
  assert.equal(
    await signupRequestFingerprint({ ...base, email: '  User@Example.COM ' }),
    canonical,
  );
});

test('changing any part of the intent changes the fingerprint', async () => {
  const { signupRequestFingerprint } = await idem;
  const base = {
    nonce: 'd'.repeat(32), email: 'user@example.com',
    surface: 'web', authMethod: 'password',
  };
  const baseline = await signupRequestFingerprint(base);
  for (const variant of [
    { ...base, nonce: 'e'.repeat(32) },
    { ...base, email: 'other@example.com' },
    { ...base, surface: 'mobile' },
    { ...base, authMethod: 'magic_link' },
    { ...base, displayName: 'Alex' },
    { ...base, redirectTo: 'https://norva.tv/other.html' },
    { ...base, signupContext: { norva_signup_platform: 'web' } },
  ]) {
    assert.notEqual(await signupRequestFingerprint(variant), baseline);
  }
});

test('same nonce, different display name or redirect: a different intent, not a retry', async () => {
  // The scenario the fingerprint exists for: reusing a nonce with the account
  // itself unchanged (same email, same password) but different metadata is
  // not "the same signup submitted twice" any more than a different password
  // would be — it must fall to intent_mismatch at the claim layer, not
  // silently replay the first metadata onto a second, different request.
  const { signupRequestFingerprint } = await idem;
  const base = {
    nonce: 'f'.repeat(32), email: 'user@example.com',
    surface: 'web', authMethod: 'password', credential: 'correct horse',
  };
  const withName = await signupRequestFingerprint({ ...base, displayName: 'Alex' });
  const withOtherName = await signupRequestFingerprint({ ...base, displayName: 'Sam' });
  const withNoName = await signupRequestFingerprint(base);
  assert.notEqual(withName, withOtherName);
  assert.notEqual(withName, withNoName);

  const withRedirect = await signupRequestFingerprint({ ...base, redirectTo: 'https://norva.tv/a.html' });
  const withOtherRedirect = await signupRequestFingerprint({ ...base, redirectTo: 'https://norva.tv/b.html' });
  assert.notEqual(withRedirect, withOtherRedirect);
});

test('signupContext canonicalises by key, so object literal order never matters', async () => {
  const { signupRequestFingerprint } = await idem;
  const base = {
    nonce: '12'.repeat(16), email: 'user@example.com',
    surface: 'web', authMethod: 'password',
  };
  const a = await signupRequestFingerprint({
    ...base,
    signupContext: { norva_signup_platform: 'web', norva_signup_surface: 'browser' },
  });
  const b = await signupRequestFingerprint({
    ...base,
    signupContext: { norva_signup_surface: 'browser', norva_signup_platform: 'web' },
  });
  assert.equal(a, b, 'same entries, different insertion order, must be one fingerprint');

  const different = await signupRequestFingerprint({
    ...base,
    signupContext: { norva_signup_platform: 'web', norva_signup_surface: 'tv' },
  });
  assert.notEqual(a, different);
});

test('fields are length-prefixed, so they cannot be rearranged into each other', async () => {
  const { signupRequestFingerprint } = await idem;
  // Without length prefixes a concatenation of "ab" + "c" and "a" + "bc" would
  // collide. Surface and method are the adjacent pair to prove it on.
  const a = await signupRequestFingerprint({
    nonce: 'f'.repeat(32), email: 'u@e.co', surface: 'web', authMethod: 'password',
  });
  const b = await signupRequestFingerprint({
    nonce: 'f'.repeat(32), email: 'u@e.co', surface: 'webpassword', authMethod: '',
  });
  assert.notEqual(a, b);
});

test('a malformed intent is refused before it can be memoised', async () => {
  const { signupRequestFingerprint } = await idem;
  await assert.rejects(signupRequestFingerprint({
    nonce: 'too-short', email: 'user@example.com', surface: 'web', authMethod: 'password',
  }), /idempotency_nonce_invalid/);
  await assert.rejects(signupRequestFingerprint({
    nonce: 'a'.repeat(32), email: 'not-an-email', surface: 'web', authMethod: 'password',
  }), /idempotency_email_invalid/);
});

test('the same credential retries, a different one does not', async () => {
  const { signupRequestFingerprint } = await idem;
  const base = {
    nonce: '9'.repeat(32), email: 'user@example.com',
    surface: 'web', authMethod: 'password',
  };
  const first = await signupRequestFingerprint({ ...base, credential: 'correct horse' });
  // A double click resends the same credential, so it is the same intention.
  assert.equal(
    await signupRequestFingerprint({ ...base, credential: 'correct horse' }),
    first,
  );
  // A different password is NOT a retry. An earlier version left the credential
  // out of the fingerprint entirely and would have handed this request the first
  // one's result.
  assert.notEqual(
    await signupRequestFingerprint({ ...base, credential: 'battery staple' }),
    first,
  );
  // And omitting it is its own intention rather than a wildcard.
  assert.notEqual(await signupRequestFingerprint(base), first);
});

test('a passwordless flow keeps a stable fingerprint across retries', async () => {
  const { signupRequestFingerprint } = await idem;
  // Magic link and OAuth carry no credential; their retries must still match, so
  // absence maps to a fixed marker rather than to a random value.
  const intent = {
    nonce: '8'.repeat(32), email: 'user@example.com',
    surface: 'web', authMethod: 'magic_link', credential: null,
  };
  assert.equal(
    await signupRequestFingerprint(intent),
    await signupRequestFingerprint({ ...intent }),
  );
});

test('the credential is bound, never kept', async () => {
  const { signupRequestFingerprint } = await idem;
  const source = read('supabase/functions/_shared/signup-idempotency.ts');
  const attempts = read('supabase/migrations/20260822090000_abuse_signup_idempotency.sql');
  // The binding is derived, folded in and dropped: no column, no return value,
  // no second digest persisted anywhere.
  assert.ok(!attempts.includes('credential'), 'no credential column exists');
  assert.match(source, /credential_binding = HMAC/);
  const fingerprint = await signupRequestFingerprint({
    nonce: '7'.repeat(32), email: 'user@example.com',
    surface: 'web', authMethod: 'password', credential: 'a-secret-value',
  });
  // The fingerprint is a MAC, so it cannot contain the credential.
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!fingerprint.includes('a-secret'));
});

// ── the state machine, as the database enforces it ─────────────────────────

test('four states, because an ambiguous failure is not a failure', () => {
  assert.match(migration, /state in \('PROCESSING', 'SUCCESS', 'FAILED_FINAL', 'UNKNOWN'\)/);
  // A timeout after GoTrue created the account looks exactly like a failure from
  // this layer. Calling it final would let the retry create a second account.
  assert.match(migration, /UNKNOWN/);
});

test('the claim is the insert, so two clicks cannot both win it', () => {
  assert.match(migration, /on conflict \(nonce\) do nothing/);
  assert.doesNotMatch(migration, /pg_advisory/i);
  // No select-then-insert window: whichever request wins the primary key owns
  // the attempt and the others read its state.
  assert.match(migration, /v_inserted := found;/);
});

test('a mismatched intent never receives the first result', () => {
  const claim = migration.slice(
    migration.indexOf('function abuse_private.signup_attempt_claim'),
    migration.indexOf('function abuse_private.signup_attempt_settle'),
  );
  assert.match(claim, /request_fingerprint <> p_fingerprint/);
  const mismatch = claim.slice(claim.indexOf('request_fingerprint <> p_fingerprint'));
  const returned = mismatch.slice(0, mismatch.indexOf('end if;'));
  assert.match(returned, /'outcome', 'intent_mismatch'/);
  assert.doesNotMatch(returned, /'result'/, 'no result on a mismatched intent');
});

test('a settled attempt is terminal, and only its owner can settle it', () => {
  const settle = migration.slice(migration.indexOf('function abuse_private.signup_attempt_settle'));
  assert.match(settle, /and request_fingerprint = p_fingerprint/);
  // UNKNOWN is settleable because reconciliation is the act of resolving it.
  // SUCCESS must never silently become FAILED_FINAL.
  assert.match(settle, /state in \('PROCESSING', 'UNKNOWN'\)/);
  assert.match(settle, /p_state not in \('SUCCESS', 'FAILED_FINAL', 'UNKNOWN'\)/);
});

test('a stored secret is unrepresentable, not merely discouraged', () => {
  // A key allow-list was the first attempt and it was not enough: it constrains
  // the NAMES of top-level keys, so {"user_id": {"access_token": "..."}} would
  // have been accepted — user_id is permitted and nothing looked inside it.
  // Typed columns cannot hold a token at all, whatever the calling code does.
  // Read the column list rather than grepping the file: a looser pattern here
  // matched `v_result jsonb` in a DECLARE block, which is a local variable and
  // proves nothing about storage.
  const body = migration.slice(
    migration.indexOf('create table if not exists abuse_private.signup_attempts ('),
    migration.indexOf('  constraint signup_attempts_state'),
  );
  const columns = [...body.matchAll(/^\s{2}(\w+)\s+(?:text|uuid|boolean|integer|smallint|timestamptz|jsonb)\b/gm)]
    .map((m) => m[1]);
  assert.deepEqual(columns, [
    'nonce', 'request_fingerprint', 'fingerprint_version', 'state',
    'result_user_id', 'result_email_confirmation_required', 'result_created',
    'upstream_status', 'attempt_count', 'created_at', 'updated_at', 'expires_at',
  ]);
  assert.doesNotMatch(body, /jsonb/, 'nothing in this table is a blob');
  // And a result belongs only to a settled attempt: PROCESSING carries none.
  assert.match(migration, /state <> 'PROCESSING'/);
  // No word-search for "access_token" and friends. Three attempts at that kind
  // of assertion in this codebase have failed on their own explanatory prose,
  // which proves only that the prose exists. The column list above is the
  // property: a uuid and two booleans have nowhere to put a token.
});

test('the table is private and expires on its own', () => {
  assert.match(migration, /enable row level security/);
  assert.match(
    migration,
    /revoke all on table abuse_private\.signup_attempts\s*\n\s*from public, anon, authenticated, service_role;/,
  );
  assert.match(migration, /signup_attempt_prune/);
  assert.match(migration, /expires_at < now\(\)/);
  assert.match(
    migration,
    /grant execute on function public\.abuse_signup_attempt_claim\(text, text, smallint, integer\)\s*\n\s*to service_role;/,
  );
});
