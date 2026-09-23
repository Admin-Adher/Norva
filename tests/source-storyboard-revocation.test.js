'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const gateway = fs.readFileSync(
  process.env.NORVA_TEST_GATEWAY_SOURCE || path.join(root, 'services/media-gateway/src/index.js'), 'utf8');
const cloud = fs.readFileSync(
  process.env.NORVA_TEST_CLOUD_SOURCE || path.join(root, 'supabase/functions/norva-cloud/index.ts'), 'utf8');
const playback = fs.readFileSync(
  process.env.NORVA_TEST_PLAYBACK_SOURCE || path.join(root, 'supabase/functions/norva-playback/index.ts'), 'utf8');
const HASH = 'a'.repeat(64);
const OWNER = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const NEW = '33333333-3333-4333-8333-333333333333';

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing section ${startMarker}`);
  return source.slice(start, end);
}

function gatewayHarness() {
  const callbacks = [];
  const context = {
    Date, Map, Set, AbortSignal, setTimeout,
    GATEWAY_TOKEN: 'test-token',
    accountExtractions: new Map(), sessions: new Map(), rawPumps: new Set(),
    transcribeWakeState: {}, wakeQueueDrain() {},
    providerAffinityHashForGatewayKey: key => key === 'old-affinity' ? HASH : 'b'.repeat(64),
    proxyKeyFromUrl: url => url === 'old-url' ? 'old-affinity' : 'new-affinity',
    isSessionBlockingProviderSlot: () => true,
    stopChildProcess: async child => { child.closed = true; if (context.activeJob) context.activeJob.activeChild = null; },
    fetch: async (url, init) => {
      callbacks.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ active: true }) };
    },
  };
  vm.runInNewContext(`${section(gateway, 'const transcribeQueue = [];', 'function createQueueWakeState()')}
    globalThis.testApi = { queue: transcribeQueue, revokeSourceStoryboards,
      sourceStoryboardRevoked, setActive(job) { activeStoryboardJob = job; } };`, context);
  return { context, callbacks, ...context.testApi };
}

test('source revocation cancels the matching active and queued storyboards without touching another source or owner', async () => {
  const h = gatewayHarness();
  const job = (uid, sourceId, url, jobId) => ({
    kind: 'storyboard', uid, sourceId, url, jobId,
    callbackUrl: 'https://api.norva.tv/functions/v1/norva-playback/storyboard-callback',
  });
  h.queue.push(job(OWNER, OLD, 'old-url', 'old-queued'));
  h.queue.push(job(OWNER, undefined, 'old-url', 'old-legacy'));
  h.queue.push(job(OWNER, NEW, 'old-url', 'new-source'));
  h.queue.push(job('other-owner', OLD, 'old-url', 'other-owner'));
  const active = job(OWNER, OLD, 'old-url', 'old-active');
  active.activeChild = { closed: false };
  active.childClosed = Promise.resolve();
  h.context.activeJob = active;
  h.setActive(active);

  const result = await h.revokeSourceStoryboards({ sourceId: OLD, ownerId: OWNER, affinityHash: HASH });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.providerDrained, true);
  assert.equal(result.providerIdle, true);
  assert.equal(result.revokedQueued, 2);
  assert.equal(result.stoppedActive, 1);
  assert.equal(active.activeChild, null);
  assert.equal(h.queue.length, 2);
  assert.deepEqual(Array.from(h.queue, item => item.jobId), ['new-source', 'other-owner']);
  assert.equal(h.sourceStoryboardRevoked(OWNER, OLD), true);
  assert.deepEqual(h.callbacks.map(item => item.body.error), ['source_removed', 'source_removed']);
});

test('a remaining provider session keeps the activity fence busy after targeted revocation', async () => {
  const h = gatewayHarness();
  h.context.sessions.set('viewer', { sourceUrl: 'old-url' });
  const result = await h.revokeSourceStoryboards({ sourceId: OLD, ownerId: OWNER, affinityHash: HASH });
  assert.equal(result.providerDrained, true);
  assert.equal(result.providerIdle, false);
});

function cloudHarness(gatewayResults, { onGatewayCall } = {}) {
  const events = [];
  let sourceRead = false;
  let gatewayCallCount = 0;
  const activity = { kind: 'gateway', last_seen_at: '2026-09-23T15:44:42.000Z' };
  const db = {
    from(table) {
      const filters = {};
      let updateValue = null;
      const query = {
        select() { return this; }, is() { return this; },
        eq(column, value) {
          filters[column] = value;
          if (table === 'provider_account_activity' && updateValue && column === 'last_seen_at') {
            events.push({ type: 'fence-cas', filters: { ...filters } });
            if (activity.kind === filters.kind && activity.last_seen_at === filters.last_seen_at) {
              activity.kind = updateValue.kind;
            }
            return Promise.resolve({ error: null });
          }
          return this;
        },
        update(value) {
          updateValue = value;
          events.push({ type: table === 'cloud_sources' ? 'soft-delete' : 'fence-update', value });
          return this;
        },
        maybeSingle() {
          if (table === 'provider_account_activity') {
            events.push({ type: 'fence-read' });
            return Promise.resolve({ data: { ...activity }, error: null });
          }
          assert.equal(table, 'cloud_sources');
          if (!sourceRead) {
            sourceRead = true;
            return Promise.resolve({ data: { id: OLD, source_type: 'xtream', config_ciphertext: 'encrypted', deleted_at: null }, error: null });
          }
          return Promise.resolve({ data: { id: OLD }, error: null });
        },
      };
      return query;
    },
  };
  const context = {
    Date, URL, AbortSignal, console,
    HttpError: class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } },
    getRuntimeConfig: async () => ({
      mediaGatewayUrl: 'http://gateway:8080', mediaGatewayToken: 'token',
      mediaGatewayCanaryUrl: 'http://canary:8080', mediaGatewayCanaryToken: 'token',
    }),
    decryptSourceConfig: async () => ({ serverUrl: 'https://panel.example:8080', username: 'qa-user' }),
    sha256Hex: async () => HASH,
    stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    recordOrEmpty: value => value && typeof value === 'object' ? value : {},
    throwDb: error => { throw error; },
    fetch: async (url, init) => {
      events.push({ type: 'gateway', url, body: JSON.parse(init.body) });
      onGatewayCall?.(++gatewayCallCount, activity);
      const result = gatewayResults.shift();
      return { ok: result?.ok === true, json: async () => result?.body || {} };
    },
  };
  const source = stripTypeScriptTypes(section(cloud, 'async function deleteSource(', 'async function assertOwnedDevice('));
  vm.runInNewContext(`${source}\nglobalThis.testApi = { deleteSource };`, context);
  return { db, events, activity, deleteSource: context.testApi.deleteSource };
}

const idleGateway = () => ({ ok: true, body: { protocol: 1, providerDrained: true, providerIdle: true } });

test('source deletion clears the final extraction heartbeat only after a second idle attestation', async () => {
  const h = cloudHarness([idleGateway(), idleGateway(), idleGateway(), idleGateway()]);
  const result = await h.deleteSource(OLD, OWNER, h.db);
  assert.equal(result.visibilityChanged, true);
  assert.deepEqual(h.events.map(event => event.type), [
    'gateway', 'gateway', 'soft-delete', 'fence-read',
    'gateway', 'gateway', 'fence-update', 'fence-cas',
  ]);
  assert.equal(h.events[0].body.affinityHash, HASH);
  assert.equal(h.events[7].filters.last_seen_at, '2026-09-23T15:44:42.000Z');
  assert.equal(h.activity.kind, 'catalog-refresh');
});

test('a new heartbeat after the idle recheck wins the exact activity comparison', async () => {
  const h = cloudHarness([idleGateway(), idleGateway(), idleGateway(), idleGateway()], {
    onGatewayCall(count, activity) {
      if (count === 4) activity.last_seen_at = '2026-09-23T15:44:43.000Z';
    },
  });
  const result = await h.deleteSource(OLD, OWNER, h.db);
  assert.equal(result.visibilityChanged, true);
  assert.equal(h.activity.kind, 'gateway');
  assert.equal(h.events.at(-1).type, 'fence-cas');
});

test('deletion succeeds but leaves the activity fence when the second attestation is busy', async () => {
  const busyGateway = { ok: true, body: { protocol: 1, providerDrained: true, providerIdle: false } };
  const h = cloudHarness([idleGateway(), idleGateway(), idleGateway(), busyGateway]);
  const result = await h.deleteSource(OLD, OWNER, h.db);
  assert.equal(result.visibilityChanged, true);
  assert.equal(h.activity.kind, 'gateway');
  assert.equal(h.events.filter(event => event.type === 'fence-update').length, 0);
});

test('source deletion fails before soft-delete when a Gateway does not attest drain', async () => {
  const h = cloudHarness([
    idleGateway(),
    { ok: false, body: { protocol: 1, providerDrained: false } },
  ]);
  await assert.rejects(() => h.deleteSource(OLD, OWNER, h.db), error => error.status === 503);
  assert.deepEqual(h.events.map(event => event.type), ['gateway', 'gateway']);
});

test('playback admission accepts only the live source owned by the requested user', async () => {
  const source = stripTypeScriptTypes(section(
    playback, 'async function checkStoryboardAdmission(', 'async function runStoryboardCallback('));
  let active = true;
  const context = {
    HttpError: class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } },
    getRuntimeConfig: async () => ({ mediaGatewayToken: 'token' }),
    recordOrEmpty: value => value && typeof value === 'object' ? value : {},
    stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    throwDb: error => { throw error; },
  };
  vm.runInNewContext(`${source}\nglobalThis.check = checkStoryboardAdmission;`, context);
  const db = { from() { return {
    select() { return this; }, eq() { return this; }, is() { return this; },
    maybeSingle: async () => ({ data: active ? { id: OLD } : null, error: null }),
  }; } };
  const request = token => ({
    headers: { get: () => `Bearer ${token}` },
    json: async () => ({ sourceId: OLD, ownerId: OWNER }),
  });
  assert.equal((await context.check(request('token'), db)).active, true);
  active = false;
  await assert.rejects(() => context.check(request('token'), db), error => error.status === 410);
  await assert.rejects(() => context.check(request('bad-token'), db), error => error.status === 401);
});
