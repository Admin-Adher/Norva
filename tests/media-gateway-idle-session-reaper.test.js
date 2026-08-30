const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'media-gateway', 'src', 'index.js'),
  'utf8',
);

function sourceBetween(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

function loadIdleHarness() {
  const helper = sourceBetween(
    'function touchViewerSessionClientAccess(',
    '\nfunction providerAffinityHashForGatewayKey(',
  );
  const context = { exports: {} };
  vm.runInNewContext(
    `const VIEWER_SESSION_IDLE_TIMEOUT_MS = 120000;\n${helper}\n` +
      'exports.touch = touchViewerSessionClientAccess;\n' +
      'exports.expired = viewerSessionIdleExpired;',
    context,
  );
  return context.exports;
}

test('viewer session idle deadline follows authenticated HLS activity', () => {
  const idle = loadIdleHarness();
  const session = {
    createdAt: new Date(1_000),
    lastClientAccessAtMs: 1_000,
    backgroundCacheContinuation: false,
  };

  assert.equal(idle.expired(session, 120_999), false);
  assert.equal(idle.expired(session, 121_000), true);

  idle.touch(session, 100_000);
  assert.equal(session.lastClientAccessAtMs, 100_000);
  assert.equal(idle.expired(session, 219_999), false);
  assert.equal(idle.expired(session, 220_000), true);
});

test('detached complete-cache continuation is not reaped as an idle viewer', () => {
  const idle = loadIdleHarness();
  const session = {
    createdAt: new Date(1_000),
    lastClientAccessAtMs: 1_000,
    backgroundCacheContinuation: true,
  };

  idle.touch(session, 500_000);
  assert.equal(session.lastClientAccessAtMs, 1_000);
  assert.equal(idle.expired(session, 500_000), false);
});

test('gateway routes renew liveness and the minute reaper closes idle transports', () => {
  const playlist = sourceBetween(
    "app.get('/sessions/:id/playlist.m3u8'",
    "app.get('/sessions/:id/:file'",
  );
  const artifact = sourceBetween(
    "app.get('/sessions/:id/:file'",
    '\nfunction failMkvCompleteHlsCacheSession(',
  );
  const cleanupStart = source.lastIndexOf('setInterval(() => {');
  const cleanupEnd = source.indexOf('bootstrap().catch(', cleanupStart);
  assert.notEqual(cleanupStart, -1);
  assert.notEqual(cleanupEnd, -1);
  const cleanup = source.slice(cleanupStart, cleanupEnd);

  assert.match(playlist, /touchViewerSessionClientAccess\(session\)/);
  assert.match(artifact, /touchViewerSessionClientAccess\(session\)/);
  assert.match(cleanup, /viewerSessionIdleExpired\(session, now\)/);
  assert.match(cleanup, /stopSession\(session, \{ reason: 'viewer-idle' \}\)/);
  assert.match(source, /viewerSessionIdleTimeoutMs: VIEWER_SESSION_IDLE_TIMEOUT_MS/);
  assert.match(source, /const GATEWAY_VERSION = 128;/);
});
