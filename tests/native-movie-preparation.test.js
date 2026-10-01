const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('supabase/functions/norva-playback/index.ts', 'utf8');
const start = source.indexOf('async function prepareNativeMovieAccessProof(');
const end = source.indexOf('// Exact membership', start);
const code = source.slice(start, end).replace(/options: \{[\s\S]*?\}\) \{/, 'options) {');

async function fixture({ owned = true, dbError = false, drained = true, busy = false,
  timeout = false, responseOk = true, valid = true, saveError = false } = {}) {
  const { nativeVodFileProof } = await import('../supabase/functions/_shared/native-mp4-gateway-policy.mjs');
  const events = [];
  const db = { from(table) {
    assert.equal(table, 'cloud_catalog_visible_title_variants');
    return { select() { return this; }, eq(k, v) { events.push(['filter', k, v]); return this; },
      async maybeSingle() { return { data: owned ? { id: 'owned-variant' } : null, error: dbError }; } };
  } };
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const ctx = { HttpError, nativeVodFileProof, crypto: require('node:crypto').webcrypto, AbortSignal,
    resolveSourceIdentity: async (source, owner) => {
      assert.equal(source, 'source'); assert.equal(owner, 'owner');
      events.push(['identity']); return { key: 'exact-provider' };
    },
    getRuntimeConfig: async () => ({}),
    mediaGatewayRouteForPlaybackUser: async () => ({ url: 'https://gateway.test', token: 'private' }),
    claimProviderFileProbeStrict: async (_db, key, lease, ttl) => {
      assert.equal(key, 'exact-provider'); assert.match(lease, /^native-movie:/); assert.equal(ttl, 90);
      events.push(['claim']); return !busy;
    },
    releaseProviderFileProbe: async () => events.push(['release']),
    recordOrEmpty: v => v && typeof v === 'object' ? v : {},
    sanitizedProviderErrorCode: () => null,
    providerProbeResponseAllowsLeaseRelease: () => drained,
    fetch: async (url, options) => {
      assert.equal(url, 'https://gateway.test/probe-audio');
      assert.deepEqual(JSON.parse(options.body), { url: 'https://owned.test/movie.mkv',
        userAgent: 'native-agent', refreshCodecProfile: true, playbackPreparation: true });
      assert.ok(options.signal instanceof AbortSignal);
      events.push(['probe']); if (timeout) throw new Error('timeout');
      return { ok: responseOk, status: responseOk ? 200 : 429, json: async () => ({
        codecProfile: valid ? { container: 'matroska', probeSource: 'gateway_probe',
          probedAt: new Date().toISOString(), fileSizeBytes: 123456, durationSeconds: 120 } : {},
        audioProbeComplete: true, subtitleProbeComplete: false,
      }) };
    },
    persistObservedCodecProfile: async (_db, file) => {
      events.push(['owner-profile', file]);
      assert.equal(file.variantId, 'owned-variant'); assert.equal(file.strict, true);
    },
    shareObservedGatewayFile: async (_db, file) => {
      events.push(['save', file]); if (saveError) throw new Error('database unavailable');
    },
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return { events, run: () => ctx.prepareNativeMovieAccessProof({ db, userId: 'owner', sourceId: 'source',
    itemId: 'movie', targetUrl: 'https://owned.test/movie.mkv', userAgent: 'native-agent' }) };
}

test('a new owned movie obtains exact drained evidence and persists it for the next playback', async () => {
  const f = await fixture(); assert.equal((await f.run()).fileSizeBytes, 123456);
  assert.deepEqual(f.events.filter(e => e[0] !== 'filter').map(e => e[0]), ['identity', 'claim', 'probe', 'owner-profile', 'save', 'release']);
  for (const pair of [['user_id', 'owner'], ['source_id', 'source'], ['item_type', 'movie'], ['external_id', 'movie']]) {
    assert.ok(f.events.some(e => e[0] === 'filter' && e[1] === pair[0] && e[2] === pair[1]));
  }
  const file = f.events.find(e => e[0] === 'save')[1];
  assert.equal(file.variantId, 'owned-variant'); assert.equal(file.itemType, 'movie');
  assert.equal(file.itemId, 'movie'); assert.equal(file.audioProbeComplete, true);
  assert.equal(file.subtitleProbeComplete, false);
});

for (const scenario of [{ owned: false }, { dbError: true }, { busy: true }, { drained: false },
  { timeout: true }, { valid: false }, { responseOk: false }, { saveError: true }]) {
  test(`movie preparation cannot grant on ${JSON.stringify(scenario)}`, async () => {
    const f = await fixture(scenario); await assert.rejects(f.run());
    if (scenario.owned === false || scenario.dbError || scenario.busy) assert.ok(!f.events.some(e => e[0] === 'probe'));
    if (!scenario.saveError) assert.ok(!f.events.some(e => e[0] === 'save'));
    if (scenario.drained === false || scenario.timeout) assert.ok(!f.events.some(e => e[0] === 'release'));
    if (scenario.saveError) assert.equal(f.events.at(-1)[0], 'release');
  });
}
