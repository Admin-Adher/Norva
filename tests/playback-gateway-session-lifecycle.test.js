const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const edgePath = path.join(root, 'supabase/functions/norva-playback/index.ts');
const lifecyclePath = path.join(
  root,
  'supabase/functions/_shared/media-gateway-session-lifecycle.mjs',
);
const edgeSource = fs.readFileSync(edgePath, 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('media-gateway cleanup is authenticated, encoded, bounded and accepts idempotent 404', async () => {
  const { cleanupMediaGatewaySession, MEDIA_GATEWAY_SESSION_CLEANUP_TIMEOUT_MS } = await import(
    pathToFileURL(lifecyclePath).href
  );
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204 };
  };

  const deleted = await cleanupMediaGatewaySession({
    baseUrl: 'https://gateway.example/',
    token: 'gateway-secret',
    sessionId: 'cache/session 1',
    fetchImpl,
  });

  assert.equal(MEDIA_GATEWAY_SESSION_CLEANUP_TIMEOUT_MS, 8_000);
  assert.deepEqual(deleted, {
    ok: true,
    status: 204,
    alreadyAbsent: false,
    reason: null,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gateway.example/sessions/cache%2Fsession%201');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gateway-secret');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const absent = await cleanupMediaGatewaySession({
    baseUrl: 'https://gateway.example',
    token: 'gateway-secret',
    sessionId: 'already-gone',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(absent.ok, true);
  assert.equal(absent.alreadyAbsent, true);
});

test('media-gateway cleanup reports refusal, transport failure and invalid input without throwing', async () => {
  const { cleanupMediaGatewaySession } = await import(pathToFileURL(lifecyclePath).href);

  const refused = await cleanupMediaGatewaySession({
    baseUrl: 'https://gateway.example',
    token: 'gateway-secret',
    sessionId: 'live-session',
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(refused, {
    ok: false,
    status: 503,
    alreadyAbsent: false,
    reason: 'gateway-cleanup-refused',
  });

  const unavailable = await cleanupMediaGatewaySession({
    baseUrl: 'https://gateway.example',
    token: 'gateway-secret',
    sessionId: 'live-session',
    fetchImpl: async () => { throw new Error('network details must stay private'); },
  });
  assert.deepEqual(unavailable, {
    ok: false,
    status: 0,
    alreadyAbsent: false,
    reason: 'gateway-cleanup-unavailable',
  });

  let called = false;
  const invalid = await cleanupMediaGatewaySession({
    baseUrl: 'https://gateway.example',
    token: 'gateway-secret',
    sessionId: '',
    fetchImpl: async () => { called = true; },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-cleanup-input');
  assert.equal(called, false);
});

test('gateway DB persistence failure awaits deletion of the newly-created external session', () => {
  const gateway = section(
    edgeSource,
    'async function createGatewaySession(',
    '\nasync function requestGatewaySession(',
  );
  assert.match(gateway, /const externalSessionId = stringOrNull\(gatewayBody\.id\)/);
  assert.match(gateway, /GATEWAY_SESSION_ID_MISSING/);
  assert.match(
    gateway,
    /try \{[\s\S]*?if \(error\) throwDb\(error, "Unable to record gateway session"\);[\s\S]*?catch \(databaseError\) \{[\s\S]*?const cleanup = await cleanupCreatedSession\(\);[\s\S]*?throw databaseError/,
  );
  assert.match(gateway, /external_session_id: externalSessionId/);
  assert.match(gateway, /cleanupCreatedSession,/);
});

test('a rejected or ambiguous coordinator commit deletes Gateway state before failing playback', () => {
  const create = section(
    edgeSource,
    'async function createPlaybackSessionCore(',
    '\nasync function createPlaybackSession(',
  );
  const commit = create.indexOf('const gatewayCommit = await commitEdgeSessionCoordinator');
  const reject = create.indexOf('if (edgeCoordination && !gatewayCommit?.ok)', commit);
  const cleanup = create.indexOf('await gateway?.cleanupCreatedSession?.()', reject);
  const rollback = create.indexOf('await rollbackEdgeSessionCoordinator', cleanup);
  const failure = create.indexOf('await recordPlaybackSessionFailure', rollback);

  assert.ok(commit >= 0, 'Gateway coordinator commit must be observed');
  assert.ok(reject > commit, 'a null/non-ok coordinator commit must fail closed');
  assert.ok(cleanup > reject, 'the created Gateway session must be deleted on commit failure');
  assert.ok(rollback > cleanup, 'an ambiguous Durable Object commit must be ended after Gateway cleanup');
  assert.ok(failure > rollback, 'failure recording must happen only after lifecycle rollback');
  assert.match(create, /status: "failed", expires_at: new Date\(\)\.toISOString\(\)/);
  assert.match(
    create,
    /if \(edgeCoordination && !gatewayCommit\?\.ok\)/,
    'an intentionally unconfigured optional coordinator must not reject playback',
  );
});

test('coordinator rollback ends only the exact Gateway generation and then aborts its lock', () => {
  const rollback = section(
    edgeSource,
    'async function rollbackEdgeSessionCoordinator(',
    '\nasync function endEdgeSessionCoordinator(',
  );
  const end = rollback.indexOf('"/sessions/end"');
  const abort = rollback.indexOf('await abortEdgeSessionCoordinator(coordination)');

  assert.ok(end >= 0);
  assert.ok(abort > end);
  assert.match(rollback, /playbackSessionId: options\.playbackSessionId/);
  assert.match(rollback, /gatewaySessionId: options\.gatewaySessionId/);
});
