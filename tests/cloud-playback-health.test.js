const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function harness(report) {
  const events = [];
  const API = { playbackStatus: { report, getAll: async () => [] } };
  const window = { API, dispatchEvent: event => events.push(event) };
  const context = vm.createContext({ window, API, console: { warn() {} },
    CustomEvent: function(type, options) { this.type = type; this.detail = options.detail; } });
  vm.runInContext(fs.readFileSync('public/js/utils/playbackHealth.js', 'utf8'), context);
  return { health: window.PlaybackHealth, events, API, window };
}
const target = { sourceId: 'source', itemType: 'episode', itemId: 'episode-2', status: 'broken', sessionId: 'session' };

test('unacknowledged or rejected writes cannot hide an episode or announce persistence', async () => {
  for (const report of [async () => ({ success: true }), async () => { throw new Error('offline'); },
    async () => ({ ignored: true }), async () => ({ persisted: false })]) {
    const { health, events } = harness(report);
    await health.report(target);
    assert.equal(health.statuses.size, 0);
    assert.equal(events.length, 0);
  }
});

test('acknowledged cloud failures remain retryable and do not condemn another platform', async () => {
  const { health, events } = harness(async body => {
    assert.equal(body.sessionId, 'session');
    return { persisted: true, entry: { ...target, unavailable: false, last_error: 'format' } };
  });
  await health.report(target);
  assert.equal(health.isBroken('source', 'episode', 'episode-2'), true);
  assert.equal(health.isUnavailable('source', 'episode', 'episode-2'), false);
  assert.equal(health.isBroken('source', 'series', 'episode-2'), false);
  assert.equal(events.length, 1);
});

test('local legacy terminal failures and transient connection errors retain their distinctions', () => {
  const { health } = harness();
  assert.equal(health.isUnavailableEntry({ status: 'broken', lastError: 'invalid file' }), true);
  assert.equal(health.isUnavailableEntry({ status: 'broken', lastError: '503 gateway unavailable' }), false);
  assert.equal(health.isUnavailableEntry({ status: 'ok', unavailable: true }), false);
});

test('watch health targets the exact episode and forwards the cloud session', async () => {
  let report;
  const context = vm.createContext({ window: { PlaybackHealth: {} },
    PlaybackHealth: { report: async data => { report = data; } }, console });
  context.window.PlaybackHealth.report = context.PlaybackHealth.report;
  vm.runInContext(fs.readFileSync('public/js/pages/WatchPage.js', 'utf8') + '\nthis.Watch = WatchPage;', context);
  const watch = Object.create(context.Watch.prototype);
  watch.content = { sourceId: 'source', id: 'episode-2', seriesId: 'series-1', type: 'series' };
  watch.currentCloudPlaybackSessionId = 'cloud-session';
  await watch.reportPlaybackStatus('ok');
  assert.equal(report.itemType, 'episode');
  assert.equal(report.itemId, 'episode-2');
  assert.equal(report.sessionId, 'cloud-session');
});

test('a slow snapshot cannot erase recovery reported while the request was in flight', async () => {
  let resolve;
  const { health, API } = harness(async () => ({ persisted: true, entry: { ...target, status: 'ok', updated_at: '2026-10-01T10:01:00Z' } }));
  API.playbackStatus.getAll = () => new Promise(done => { resolve = done; });
  const loading = health.load();
  await health.report({ ...target, status: 'ok' });
  resolve([{ ...target, updated_at: '2026-10-01T10:00:00Z' }]);
  await loading;
  assert.equal(health.isBroken('source', 'episode', 'episode-2'), false);
  assert.equal(health.statuses.size, 1);
});

test('out-of-order HTTP acknowledgements cannot replace a newer recovery', async () => {
  let resolve;
  const { health, API, events } = harness(() => new Promise(done => { resolve = done; }));
  const old = health.report(target);
  API.playbackStatus.report = async () => ({ entry: { ...target, status: 'ok', updated_at: '2026-10-01T10:01:00Z' } });
  await health.report({ ...target, status: 'ok' });
  resolve({ entry: { ...target, updated_at: '2026-10-01T10:00:00Z' } });
  await old;
  assert.equal(health.isBroken('source', 'episode', 'episode-2'), false);
  assert.equal(events.length, 1);
});

test('switching account or source visibility discards cached and in-flight health', async () => {
  let resolve;
  const { health, window, events } = harness(() => new Promise(done => { resolve = done; }));
  window.NorvaCloud = { token: 'owner-a', catalogVisibility: { epoch: () => 1 } };
  const pending = health.report(target);
  window.NorvaCloud.token = 'owner-b';
  resolve({ entry: { ...target, updated_at: '2026-10-01T10:01:00Z' } });
  await pending;
  assert.equal(health.statuses.size, 0);
  assert.equal(events.length, 0);
  health.setStatus(target);
  window.NorvaCloud.catalogVisibility.epoch = () => 2;
  assert.equal(health.isBroken('source', 'episode', 'episode-2'), false);
});

function edgeHarness(rpc) {
  const source = fs.readFileSync('supabase/functions/norva-playback/index.ts', 'utf8');
  const start = source.indexOf('async function playbackHealth(');
  const end = source.indexOf('async function recordPlaybackEvent(', start);
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const context = vm.createContext({ URL, HttpError, readJson: req => req.json(),
    stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    PLAYBACK_SESSION_UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    throwDb: () => { throw new HttpError(500, 'Database error'); },
    assertOwnedSource: async () => { throw new HttpError(404, 'Source not found'); } });
  vm.runInContext(transformSync(source.slice(start, end), { loader: 'ts' }).code, context);
  return (req, owner = 'authenticated-owner', device = null) => context.playbackHealth(req, owner, { rpc }, device);
}
const sessionId = '11111111-1111-4111-8111-111111111111';

test('health endpoint binds writes to authenticated identity and ignores forged media/owner fields', async () => {
  const handle = edgeHarness(async (name, args) => {
    assert.equal(name, 'norva_record_playback_health');
    assert.equal(args.p_user, 'authenticated-owner');
    assert.equal(args.p_device, 'paired-device');
    assert.equal(args.p_session, sessionId);
    assert.equal(args.p_source, undefined);
    assert.equal(args.p_item_id, undefined);
    return { data: { persisted: true }, error: null };
  });
  const response = await handle(new Request('https://example.test/playback/health', { method: 'POST',
    body: JSON.stringify({ sessionId, status: 'ok', userId: 'victim', sourceId: 'victim-source', itemId: 'parent-series' }) }),
  'authenticated-owner', 'paired-device');
  assert.equal(response.persisted, true);
});

test('health endpoint propagates rejection and database errors, and rejects invalid or foreign filters', async () => {
  for (const [error, status] of [[{ code: 'P0002' }, 404], [{ code: 'XX000' }, 500]]) {
    const handle = edgeHarness(async () => ({ error }));
    await assert.rejects(handle(new Request('https://example.test/playback/health', { method: 'POST',
      body: JSON.stringify({ sessionId, status: 'ok' }) })), err => err.status === status);
  }
  const handle = edgeHarness(async () => { throw new Error('must not reach storage'); });
  await assert.rejects(handle(new Request('https://example.test/playback/health?sourceId=invalid')), err => err.status === 400);
  await assert.rejects(handle(new Request('https://example.test/playback/health?sourceId=' + sessionId)), err => err.status === 404);
});

function adapterHarness(playback) {
  const storage = new Map();
  const NorvaCloud = { playback };
  const window = { NorvaCloud, location: { hostname: 'norva.tv', origin: 'https://norva.tv' } };
  const context = vm.createContext({ window, NorvaCloud, URL, URLSearchParams, AbortController, Headers,
    navigator: { userAgent: 'fixture' }, console, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
  vm.runInContext(fs.readFileSync('public/js/api.js', 'utf8') + '\nthis.adapter = CloudAdapter;', context);
  return context.adapter;
}

test('cloud adapter reads every page and translates UUIDs to the catalogue source aliases', async () => {
  let calls = 0;
  const adapter = adapterHarness({ health: async params => {
    calls++;
    assert.equal(params.itemType, 'movie');
    if (calls === 1) return { entries: Array.from({ length: 500 }, (_, i) => ({ source_id: sessionId, item_type: 'movie', item_id: String(i), cursor: String(i) })) };
    assert.equal(params.after, '499');
    return { entries: [{ source_id: sessionId, item_type: 'movie', item_id: 'last' }] };
  } });
  const entries = await adapter.request('GET', '/playback-status?itemType=movie');
  assert.equal(entries.length, 501);
  assert.equal(calls, 2);
  assert.equal(typeof entries[0].source_id, 'number');
  assert.equal(entries[0].source_id, entries[500].source_id);
});

test('cloud adapter exposes failures instead of a fabricated empty snapshot or successful write', async () => {
  const adapter = adapterHarness({ health: async () => { throw new Error('edge unavailable'); },
    reportHealth: async () => { throw new Error('storage unavailable'); } });
  await assert.rejects(adapter.request('GET', '/playback-status'), /edge unavailable/);
  await assert.rejects(adapter.request('POST', '/playback-status/report', { sessionId, status: 'ok' }), /storage unavailable/);
  assert.equal((await adapter.request('POST', '/playback-status/report', { status: 'ok' })).persisted, false);
  await assert.rejects(adapter.request('POST', '/playback-status/scan-live-modes', {}), /not available/);
});
