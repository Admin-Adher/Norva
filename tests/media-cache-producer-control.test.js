'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MediaCacheProducerControl,
  normalizeMediaCacheProducerContext,
} = require('../services/media-gateway/src/mediaCacheProducerControl');

const context = Object.freeze({
  protocol: 1,
  workFingerprint: 'ab'.repeat(32),
  accountFingerprint: 'cd'.repeat(32),
  leaseToken: '11111111-1111-4111-8111-111111111111',
  ownerInstanceFingerprint: 'ef'.repeat(32),
});

function session() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    playbackSessionId: '33333333-3333-4333-8333-333333333333',
    status: 'ready',
    backgroundCacheContinuation: false,
  };
}

test('producer context is exact, opaque and rejects partial or extra authority', () => {
  assert.deepEqual(normalizeMediaCacheProducerContext(context), context);
  assert.equal(normalizeMediaCacheProducerContext({ ...context, leaseToken: null }), null);
  assert.equal(normalizeMediaCacheProducerContext({ ...context, sourceUrl: 'https://secret' }), null);
  assert.equal(normalizeMediaCacheProducerContext({ ...context, workFingerprint: 'nope' }), null);
});

test('Gateway pulse carries only session ids, action and stage', async () => {
  const requests = [];
  const control = new MediaCacheProducerControl({
    edgeBase: 'https://edge.example',
    gatewayToken: 'g'.repeat(32),
    initialDelayMs: 60_000,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ protocol: 1, state: 'renewed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const current = session();
  control.attach(current, context);
  assert.equal(await control.pulse(current, 'uploading'), 'renewed');
  control.detach(current);
  assert.deepEqual(requests[0], {
    protocol: 1,
    playbackSessionId: current.playbackSessionId,
    gatewaySessionId: current.id,
    action: 'pulse',
    stage: 'uploading',
  });
  assert.equal(JSON.stringify(requests[0]).includes(context.leaseToken), false);
  assert.equal(control.publicStatus().renewals, 1);
});

test('preemption stops only detached continuation, never an active foreground viewer', async () => {
  const preempted = [];
  const control = new MediaCacheProducerControl({
    edgeBase: 'https://edge.example',
    gatewayToken: 'g'.repeat(32),
    initialDelayMs: 60_000,
    fetchImpl: async () => new Response(JSON.stringify({ protocol: 1, state: 'preempted' })),
    onPreempt: async (current) => preempted.push(current.id),
  });
  const foreground = session();
  control.attach(foreground, context);
  await control.pulse(foreground, 'producing');
  assert.deepEqual(preempted, []);
  foreground.backgroundCacheContinuation = true;
  await control.pulse(foreground, 'producing');
  control.detach(foreground);
  assert.deepEqual(preempted, [foreground.id]);
});

test('successful publication suppresses abandon; failed work abandons with bounded retry', async () => {
  let calls = 0;
  const control = new MediaCacheProducerControl({
    edgeBase: 'https://edge.example',
    gatewayToken: 'g'.repeat(32),
    initialDelayMs: 60_000,
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ protocol: 1, state: body.action === 'abandon' ? 'abandoned' : 'renewed' }));
    },
  });
  const completed = session();
  control.attach(completed, context);
  control.markCompleted(completed);
  assert.equal(await control.abandon(completed), 'completed');
  assert.equal(calls, 0);

  const failed = session();
  failed.id = '44444444-4444-4444-8444-444444444444';
  control.attach(failed, context);
  assert.equal(await control.abandon(failed), 'abandoned');
  assert.equal(calls, 1);
});
