'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createViewerAttachmentRegistry,
} = require('../services/media-gateway/src/viewerAttachments');

const gateway = fs.readFileSync(path.join(
  __dirname,
  '../services/media-gateway/src/index.js',
), 'utf8');

test('per-viewer attachment tokens are unique, idempotent and individually revocable', () => {
  let nowMs = Date.now();
  let tokenIndex = 0;
  const registry = createViewerAttachmentRegistry({
    maximum: 2,
    now: () => nowMs,
    tokenFactory: () => `token-${++tokenIndex}-${'x'.repeat(32)}`,
  });
  const first = registry.attach({
    attachmentId: '11111111-1111-4111-8111-111111111111',
    playbackSessionId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(nowMs + 60_000).toISOString(),
  });
  const retry = registry.attach({
    attachmentId: first.attachmentId,
    playbackSessionId: first.playbackSessionId,
    expiresAt: new Date(first.expiresAtMs).toISOString(),
  });
  const second = registry.attach({
    attachmentId: '33333333-3333-4333-8333-333333333333',
    playbackSessionId: '44444444-4444-4444-8444-444444444444',
    expiresAt: new Date(nowMs + 60_000).toISOString(),
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.token, first.token);
  assert.notEqual(second.token, first.token);
  assert.equal(registry.authorize(first.token).attachmentId, first.attachmentId);
  assert.equal(registry.authorize(second.token).attachmentId, second.attachmentId);
  assert.equal(registry.revoke(first.attachmentId, first.playbackSessionId).attachmentId, first.attachmentId);
  assert.equal(registry.authorize(first.token), null);
  assert.equal(registry.authorize(second.token).attachmentId, second.attachmentId);
  nowMs += 61_000;
  assert.equal(registry.authorize(second.token), null);
  assert.equal(registry.snapshot().count, 0);
});

test('token collisions are retried and never alias two authorized viewers', () => {
  const colliding = `collision-${'x'.repeat(32)}`;
  const replacement = `replacement-${'y'.repeat(32)}`;
  const tokens = [colliding, colliding, replacement];
  const registry = createViewerAttachmentRegistry({
    maximum: 2,
    tokenFactory: () => tokens.shift(),
  });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const first = registry.attach({
    attachmentId: '11111111-1111-4111-8111-111111111111',
    playbackSessionId: '22222222-2222-4222-8222-222222222222',
    expiresAt,
  });
  const second = registry.attach({
    attachmentId: '33333333-3333-4333-8333-333333333333',
    playbackSessionId: '44444444-4444-4444-8444-444444444444',
    expiresAt,
  });
  assert.equal(first.token, colliding);
  assert.equal(second.token, replacement);
  assert.notEqual(first.token, second.token);
});

test('Gateway joins only a validated producer and rewrites every HLS edge with that viewer token', () => {
  const routes = gateway.slice(
    gateway.indexOf("app.post('/sessions/:id/viewers'"),
    gateway.indexOf("app.use((err, req, res, next)"),
  );
  const auth = gateway.slice(
    gateway.indexOf('function requirePlaybackToken('),
    gateway.indexOf('function cors('),
  );
  assert.match(gateway, /const GATEWAY_VERSION = 155/);
  assert.match(gateway, /function mediaCacheLiveJoinEnabled\([\s\S]*sharedMediaCachePublisher[\s\S]*mediaCacheProducerControl\.active/);
  assert.match(routes, /inspectMediaCacheLiveJoinGraph\(session\)/);
  assert.match(gateway, /topologyValidated: true/);
  assert.match(gateway, /continuityValidated: true/);
  assert.match(routes, /viewerAttachments\.attach/);
  assert.match(routes, /viewerAttachments\?\.revoke/);
  assert.match(routes, /req\.playbackToken/);
  assert.match(auth, /viewerAttachments\?\.authorize/);
  assert.match(auth, /primaryViewerAttached !== false/);
  assert.match(routes, /backgroundCacheContinuationOriginalExpiresAt/);
  assert.match(routes, /completeCacheContinuationDemanded = true/);
  assert.match(routes, /continuationRequested \|\| session\.completeCacheContinuationDemanded === true/);
  assert.doesNotMatch(routes, /console\.(?:log|warn|error)\([^\n]*(?:attachment\.token|playbackToken)/);
});

test('a viewer reattaching to bounded continuation recovers the original transport expiry', () => {
  const start = gateway.indexOf('function mediaCacheLiveViewerCount(');
  const end = gateway.indexOf("app.post('/sessions/:id/viewers'", start);
  assert.ok(start >= 0 && end > start);
  const sharedMediaCacheStats = { liveJoinReattachedContinuations: 0 };
  const cleared = [];
  const harness = vm.runInNewContext(
    `(() => { ${gateway.slice(start, end)}; return { restoreMediaCacheContinuationForViewer }; })()`,
    {
      Date,
      clearTimeout: (timer) => cleared.push(timer),
      randomToken: () => 'rotated',
      sharedMediaCacheStats,
    },
  );
  const originalExpiresAt = new Date(Date.now() + 60 * 60_000);
  const timer = { id: 'continuation-timer' };
  const session = {
    backgroundCacheContinuation: true,
    backgroundCacheContinuationPromise: null,
    backgroundCacheContinuationTimer: timer,
    backgroundCacheContinuationOriginalExpiresAt: originalExpiresAt,
    completeCacheContinuationDemanded: true,
    status: 'background-cache',
    expiresAt: new Date(Date.now() + 60_000),
  };
  assert.equal(harness.restoreMediaCacheContinuationForViewer(session), true);
  assert.equal(session.status, 'ready');
  assert.equal(session.backgroundCacheContinuation, false);
  assert.equal(session.expiresAt.toISOString(), originalExpiresAt.toISOString());
  assert.equal(session.backgroundCacheContinuationOriginalExpiresAt, null);
  assert.equal(session.completeCacheContinuationDemanded, false);
  assert.deepEqual(cleared, [timer]);
  assert.equal(sharedMediaCacheStats.liveJoinReattachedContinuations, 1);
});
