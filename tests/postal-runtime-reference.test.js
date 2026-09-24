const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

const verifier = import('../supabase/functions/_shared/postal-webhook-verifier.mjs');
const webhook = import('../supabase/functions/_shared/postal-webhook-http.mjs');
const privateProtocol = import('../supabase/functions/norva-auth-email/private-protocol.mjs');
const deployedKeys = require('../supabase/functions/norva-postal-webhook/trusted-keys.json');

test('versioned Postal webhook trust contains public verification keys only', async () => {
  const keys = Object.values(deployedKeys.trustedKeys ?? {});
  assert.equal(deployedKeys.enabled, true);
  assert.ok(keys.length > 0 && keys.length <= 2);
  for (const pem of keys) {
    assert.match(pem.trim(), /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/);
    assert.equal(pem.includes('PRIVATE KEY'), false);
    await webcrypto.subtle.importKey('spki', Buffer.from(pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, ''), 'base64'),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
});

test('signed Postal event is accepted once, while tampering and unknown keys fail before the ledger', async () => {
  const { verifyPostalWebhook } = await verifier;
  const { handlePostalWebhookRequest } = await webhook;
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`;
  const trustedKeys = { fixture: pem };
  const uuid = '6a130e16-b78b-40fb-a0ba-3e51670d9f93';
  const raw = Buffer.from(JSON.stringify({
    event: 'MessageSent', uuid, timestamp: Math.floor(Date.now() / 1000),
    payload: { message: { id: 7, direction: 'outgoing', tag: `norva-postal-canary-${uuid}` }, status: 'Sent' },
  }));
  const signature = Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, raw)).toString('base64');
  const headers = new Headers({ 'content-type': 'application/json', 'x-postal-signature-kid': 'fixture', 'x-postal-signature-256': signature });
  const verified = await verifyPostalWebhook(raw, headers, trustedKeys);
  assert.equal(verified.valid, true);
  assert.equal(verified.inboxDeliveryProven, false);
  assert.equal(verified.deliveryKey, `norva-postal-canary-${uuid}`);

  const seen = new Set();
  let ledgerCalls = 0;
  const ledger = { applyEvent: async (event) => {
    ledgerCalls++;
    if (seen.has(event.eventId)) return { result: 'duplicate' };
    seen.add(event.eventId);
    return { result: 'applied' };
  } };
  const send = (body, requestHeaders = headers) => handlePostalWebhookRequest(new Request(
    'https://api.norva.tv/functions/v1/norva-postal-webhook',
    { method: 'POST', headers: requestHeaders, body },
  ), { loadConfig: async () => ({ enabled: true, trustedKeys }), ledger });
  assert.equal((await send(raw)).status, 200);
  assert.equal((await send(raw)).status, 200);
  assert.equal(ledgerCalls, 2);
  const tampered = Buffer.from(raw);
  tampered[tampered.length - 2] ^= 1;
  assert.equal((await send(tampered)).status, 401);
  assert.equal((await send(raw, new Headers({ ...Object.fromEntries(headers), 'x-postal-signature-kid': 'unknown' }))).status, 401);
  assert.equal(ledgerCalls, 2);
});

test('private auth forwarding selects only the exact pair and requires a durable encrypted receipt', async () => {
  const { privateAuthForwarder, open, seal } = await privateProtocol;
  const transportKey = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const allowlist = { userId: 'fixture-user', currentEmail: 'old@example.test', newEmail: 'new@example.test' };
  let calls = 0;
  const forward = privateAuthForwarder({ allowlist, transportKey, fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.body.includes('new@example.test'), false);
    const envelope = JSON.parse(init.body);
    const clear = await open(envelope, transportKey, 'request');
    assert.equal(clear.payload.user.new_email, allowlist.newEmail);
    const receipt = await seal({ requestId: envelope.id, status: 200, acceptance: 'durable_pair' }, transportKey, 'response');
    return new Response(JSON.stringify(receipt), { status: 200 });
  } });
  const input = { payload: { user: { id: allowlist.userId, email: allowlist.currentEmail, new_email: allowlist.newEmail }, email_data: { email_action_type: 'email_change' } } };
  assert.equal(await forward({ payload: { ...input.payload, user: { ...input.payload.user, id: 'other' } } }), null);
  assert.equal(calls, 0);
  const response = await forward(input);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});
