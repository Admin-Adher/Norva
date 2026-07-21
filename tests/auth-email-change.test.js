const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const functionUrl = pathToFileURL(
  path.join(root, 'supabase/functions/norva-auth-email/index.ts'),
).href;

const previousDeno = globalThis.Deno;
globalThis.Deno = {
  env: {
    get(name) {
      if (name === 'PUBLIC_SITE_URL') return 'https://norva.tv';
      return undefined;
    },
  },
  serve() {},
};

const authEmail = import(functionUrl);

test('authentication email transport is bounded, deterministic and provider-acknowledged', async () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-auth-email/index.ts'), 'utf8');
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(source, /"Idempotency-Key": request\.idempotencyKey/);
  assert.match(source, /https:\/\/api\.resend\.com\/emails\/batch/);
  assert.match(source, /signal: AbortSignal\.timeout\(8_000\)/);
  assert.match(source, /acknowledgedResendIds\(response, request\.batch, request\.expectedIds\)/);
  assert.doesNotMatch(source, /String\(response\.message/);
});

test.after(async () => {
  await authEmail;
  if (previousDeno === undefined) delete globalThis.Deno;
  else globalThis.Deno = previousDeno;
});

function emailData(overrides = {}) {
  return {
    token: 'current-token',
    token_hash: 'new-address-hash',
    redirect_to: 'https://norva.tv/app?source=email#settings',
    email_action_type: 'email_change',
    ...overrides,
  };
}

function actionUrl(message) {
  const match = message.html.match(/<a href="([^"]+)"/);
  assert.ok(match, 'email CTA URL was not rendered');
  return new URL(match[1]);
}

test('secure email change sends both confirmations with Supabase hash mapping', async () => {
  const { buildOutboundEmails } = await authEmail;
  const messages = buildOutboundEmails({
    user: {
      email: 'current@example.com',
      new_email: 'next@example.com',
    },
    email_data: emailData({
      token_new: 'new-address-token',
      token_hash_new: 'current-address-hash',
    }),
  });

  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ to }) => to), [
    'current@example.com',
    'next@example.com',
  ]);

  const currentUrl = actionUrl(messages[0]);
  const nextUrl = actionUrl(messages[1]);
  assert.equal(currentUrl.searchParams.get('token_hash'), 'current-address-hash');
  assert.equal(nextUrl.searchParams.get('token_hash'), 'new-address-hash');
  assert.equal(currentUrl.searchParams.get('type'), 'email_change');
  assert.equal(nextUrl.searchParams.get('type'), 'email_change');
  assert.match(messages[0].subject, /Confirm your email change/);
  assert.match(messages[1].subject, /Confirm your new email/);
});

test('secure email change uses one strict idempotent batch with complete equivalent payloads', async () => {
  const { buildOutboundEmails, buildResendAuthRequest } = await authEmail;
  const messages = buildOutboundEmails({
    user: {
      email: 'current@example.com',
      new_email: 'next@example.com',
    },
    email_data: emailData({ token_hash_new: 'current-address-hash' }),
  });

  const request = buildResendAuthRequest(messages, 'wh_01-safe-delivery');
  assert.equal(request.endpoint, 'https://api.resend.com/emails/batch');
  assert.equal(request.idempotencyKey, 'norva-auth-wh_01-safe-delivery-batch');
  assert.equal(request.idempotencyKey.includes('@'), false);
  assert.equal(request.expectedIds, 2);
  assert.equal(request.batch, true);
  assert.ok(Array.isArray(request.body));
  assert.equal(request.body.length, 2);
  for (const [index, payload] of request.body.entries()) {
    assert.deepEqual(payload.to, [messages[index].to]);
    assert.equal(payload.from, 'Norva <noreply@norva.tv>');
    assert.equal(payload.reply_to, 'support@norva.tv');
    assert.equal(payload.text, messages[index].text);
    assert.equal(payload.html, messages[index].html);
    assert.deepEqual(payload.tags, [
      { name: 'app', value: 'norva' },
      { name: 'category', value: 'transactional_auth' },
      { name: 'flow', value: messages[index].flow },
    ]);
  }
});

test('provider acknowledgement requires every unique id from the auth batch', async () => {
  const { acknowledgedResendIds } = await authEmail;
  assert.deepEqual(
    acknowledgedResendIds({ data: [{ id: 'email-current' }, { id: 'email-next' }] }, true, 2),
    ['email-current', 'email-next'],
  );
  assert.equal(acknowledgedResendIds({ data: [{ id: 'email-current' }] }, true, 2), null);
  assert.equal(
    acknowledgedResendIds({ data: [{ id: 'same-id' }, { id: 'same-id' }] }, true, 2),
    null,
  );
  assert.deepEqual(acknowledgedResendIds({ id: 'single-id' }, false, 1), ['single-id']);
});

test('auth hook rejects batches larger than its two-message security contract', async () => {
  const { buildResendAuthRequest } = await authEmail;
  const message = { to: 'a@example.com', subject: 's', html: '<p>x</p>', text: 'x', flow: 'recovery' };
  assert.throws(() => buildResendAuthRequest([], 'delivery'), /batch size/);
  assert.throws(() => buildResendAuthRequest([message, message, message], 'delivery'), /batch size/);
});

test('email change without secure mode sends only token_hash to the new address', async () => {
  const { buildOutboundEmails } = await authEmail;
  const messages = buildOutboundEmails({
    user: {
      email: 'current@example.com',
      new_email: 'next@example.com',
    },
    email_data: emailData(),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'next@example.com');
  assert.equal(actionUrl(messages[0]).searchParams.get('token_hash'), 'new-address-hash');
});

test('action links preserve same-origin redirect_to through account returnTo', async () => {
  const { verifyUrl } = await authEmail;
  const url = new URL(verifyUrl(emailData(), 'chosen-hash'));

  assert.equal(url.origin, 'https://norva.tv');
  assert.equal(url.pathname, '/account.html');
  assert.equal(url.searchParams.get('token_hash'), 'chosen-hash');
  assert.equal(url.searchParams.get('type'), 'email_change');
  assert.equal(url.searchParams.get('returnTo'), '/app?source=email#settings');
});

test('action links reject cross-origin redirects instead of creating an open redirect', async () => {
  const { verifyUrl } = await authEmail;
  const url = new URL(verifyUrl(emailData({ redirect_to: 'https://attacker.example/phish' })));
  assert.equal(url.searchParams.has('returnTo'), false);
});

test('account verification landings do not loop and preserve a nested returnTo', async () => {
  const { verifyUrl } = await authEmail;
  const plainLanding = new URL(verifyUrl(emailData({
    redirect_to: 'https://norva.tv/account.html',
  })));
  assert.equal(plainLanding.searchParams.has('returnTo'), false);

  const nestedLanding = new URL(verifyUrl(emailData({
    redirect_to: 'https://norva.tv/account.html?returnTo=%2Fapp%23series',
  })));
  assert.equal(nestedLanding.searchParams.get('returnTo'), '/app#series');
});

test('non-email-change messages retain the current recipient and redirect', async () => {
  const { buildOutboundEmails } = await authEmail;
  const messages = buildOutboundEmails({
    user: { email: 'member@example.com' },
    email_data: emailData({
      email_action_type: 'recovery',
      token_hash: 'recovery-hash',
      redirect_to: '/app#movies',
    }),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'member@example.com');
  const url = actionUrl(messages[0]);
  assert.equal(url.searchParams.get('token_hash'), 'recovery-hash');
  assert.equal(url.searchParams.get('returnTo'), '/app#movies');
  assert.match(messages[0].html, /<html lang="en">/);
  assert.match(messages[0].text, /Reset your password/);
  assert.match(messages[0].text, /https:\/\/norva\.tv\/account\.html/);
  assert.equal(messages[0].flow, 'recovery');
});

test('auth sender provides plain text, reply-to, stable tags and retry idempotency', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-auth-email/index.ts'), 'utf8');
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /norva-auth-/);
  assert.match(source, /reply_to: REPLY_TO/);
  assert.match(source, /text: email\.text/);
  assert.match(source, /transactional_auth/);
});

test('incomplete secure email-change payloads fail before a delivery set is built', async () => {
  const { buildOutboundEmails } = await authEmail;
  assert.throws(() => buildOutboundEmails({
    user: { new_email: 'next@example.com' },
    email_data: emailData({ token_hash_new: 'current-address-hash' }),
  }), /Missing current email recipient/);

  assert.throws(() => buildOutboundEmails({
    user: { email: 'current@example.com' },
    email_data: emailData({ token_hash_new: 'current-address-hash' }),
  }), /Missing new email recipient/);
});
