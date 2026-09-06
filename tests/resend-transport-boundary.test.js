'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const transport = import('../supabase/functions/_shared/resend-transport.mjs');
const doubles=import('./helpers/postal-wire-double.mjs');
const previousDeno=globalThis.Deno;
test.before(()=>{globalThis.Deno={env:{get:k=>k==='NORVA_POSTAL_WIRE_KEY'?'7'.repeat(64):undefined}};});
test.after(()=>{globalThis.Deno=previousDeno;});

function response(payload, status, headers = {}) {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function claim() {
  return {
    delivery_key: 'behavioral:no-source:user-cohort:step-1',
    recipient_email: 'internal-recipient@example.test',
    request_from: 'Norva <support@norva.tv>',
    request_reply_to: 'support@norva.tv',
    request_subject: 'Connect your source',
    request_html: '<p>Open Norva to connect your source.</p>',
    request_text: 'Open Norva to connect your source.',
    request_tags: [
      { name: 'app', value: 'norva' },
      { name: 'flow', value: 'behavioral_no_source' },
    ],
    request_headers: { 'X-Entity-Ref-ID': 'behavioral-no-source-step-1' },
  };
}

test('Postal HTTP boundary freezes the reviewed multipart request and accepts only a 2xx provider id', async () => {
  const { sendResendDelivery } = await transport;
  const {postalDouble}=await doubles;
  const calls = [];
  const result = await sendResendDelivery(claim(), {
    apiKey: 're_internal_test_secret_1234567890',
    fetchImpl: postalDouble(async(clear,init)=>{
      calls.push({clear,init});
      return {status:200,body:{id:'email-provider-accepted-1'}};
    }),
  });

  assert.deepEqual(result, {
    accepted: true,
    status: 200,
    emailId: 'email-provider-accepted-1',
    response: { id: 'email-provider-accepted-1' },
    error: '',
    retryAfterSeconds: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clear.kind,'single');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).has('Authorization'),false);
  assert.equal(calls[0].clear.key,claim().delivery_key);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.signal.aborted, false);
  assert.deepEqual(calls[0].clear.messages, {
    from: claim().request_from,
    reply_to: claim().request_reply_to,
    to: [claim().recipient_email],
    subject: claim().request_subject,
    html: claim().request_html,
    text: claim().request_text,
    tags: claim().request_tags,
    headers: claim().request_headers,
  });
});

test('Postal HTTP boundary keeps ambiguous, throttled and timeout outcomes retryable by the durable worker', async () => {
  const { sendResendDelivery } = await transport;
  const {postalDouble}=await doubles;
  const queued = [
    response({}, 202),
    response({
      name: 'rate_limited',
      message: 'Recipient internal-recipient@example.test; key re_secret_123456789012345',
      ignored: 'must not cross the diagnostic boundary',
    }, 429, { 'retry-after': '120' }),
  ];
  const fetchImpl=postalDouble(async()=>{
    const r=queued.shift();return{status:r.status,body:await r.json(),...(r.headers.has('retry-after')?{retryAfter:Number(r.headers.get('retry-after'))}:{})};
  });

  const ambiguous = await sendResendDelivery(claim(), {
    apiKey: 'test', fetchImpl,
  });
  assert.deepEqual(ambiguous, {
    accepted: false,
    status: 202,
    emailId: null,
    response: {},
    error: 'resend_missing_id',
    retryAfterSeconds: null,
  });

  const throttled = await sendResendDelivery(claim(), {
    apiKey: 'test', fetchImpl,
  });
  assert.equal(throttled.accepted, false);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.emailId, null);
  assert.equal(throttled.error, 'resend_http_429');
  assert.equal(throttled.retryAfterSeconds, 120);
  assert.deepEqual(throttled.response, {
    name: 'rate_limited',
    message: 'Recipient [email]; key [credential]',
  });
  assert.equal(JSON.stringify(throttled).includes('internal-recipient@example.test'), false);
  assert.equal(JSON.stringify(throttled).includes('re_secret_'), false);
  assert.equal(JSON.stringify(throttled).includes('must not cross'), false);

  const timeout = await sendResendDelivery(claim(), {
    apiKey: 'test',
    fetchImpl: async () => {
      throw new DOMException('simulated timeout', 'TimeoutError');
    },
  });
  assert.deepEqual(timeout, {
    accepted: false,
    status: null,
    emailId: null,
    response: {},
    error: 'transport_timeout',
    retryAfterSeconds: null,
  });
});
