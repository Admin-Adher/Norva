const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const src = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const section = src.slice(src.indexOf('function startupCacheOwnerAllowed('), src.indexOf('async function runMediaCacheProducerControl('));
const code = stripTypeScriptTypes(section, { mode: 'transform' });
const userId = '00000000-0000-4000-8000-000000000001', sourceId = '00000000-0000-4000-8000-000000000002';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function harness(options = {}) {
  const events = [], owner = 'a'.repeat(64);
  const target = { targetUrl: 'https://provider.invalid/movie/a/b/1.mkv', accountKey: 'account', accountHash: 'account-hash',
    revision: 'revision', profileFingerprint: 'profile', resolved: { playbackHint: {} },
    profile: { audioTracks: [{ index: 1, codec: 'aac', default: true }], fileSizeBytes: 10000 } };
  const context = vm.createContext({ HttpError, crypto: require('node:crypto').webcrypto, Request, URL, Date, AbortSignal,
    Deno: { env: { get: key => ({ PRIVATE_STARTUP_CACHE_ENABLED: 'true', PRIVATE_STARTUP_CACHE_OWNER_HASHES: owner,
      NORVA_BACKFILL_TOKEN: 'operator-token' })[key] } },
    PLAYBACK_SESSION_UUID_PATTERN: /^[a-f0-9-]{36}$/, recordOrEmpty: value => value || {}, stringOr: (value, fallback) => typeof value === 'string' ? value : fallback,
    sha256Hex: async value => value === userId ? owner : 'hash:' + value,
    resolveSourceIdentity: async () => ({ key: 'identity' }), assertProviderCircuitClosed: async () => {},
    userHasLiveSession: async () => false, accountPregenActive: async (_db, user, source) => {
      assert.equal(user, userId); assert.equal(source, sourceId);
      return options.pregenBusy === true;
    },
    getRuntimeConfig: async () => ({}), mediaGatewayRouteForHlsPlaybackUser: async () => ({ url: 'https://gateway.invalid', token: 'gateway-token' }),
    gatewayPlaybackHints: x => x, boundedInt: (value, fallback, min, max) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback,
    releaseProviderFileProbe: async () => events.push('release-file'),
    fetch: async () => { events.push('gateway'); if (options.transportFailure) throw Error('lost response');
      return { json: async () => ({ protocol: 1, prepared: true, providerDrained: !options.uncertainDrain, refreshAfterSeconds: 240 }) }; },
  });
  vm.runInContext(code, context);
  context.startupCacheTarget = async () => { events.push('target'); if (options.missingEvidence) throw new HttpError(409, 'profile'); return target; };
  const db = { rpc: async name => { events.push(name);
    if (name === 'provider_account_busy') return { data: options.busy === true };
    return { data: !(options.accountRefused && name === 'claim_provider_account_language_validation') };
  }, from: name => {
    const q = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data:
      options.revokedFileLease && name === 'provider_file_probe_leases'
        ? null : { expires_at: new Date(Date.now() + 180000).toISOString() } }) };
    return q;
  } };
  const request = new Request('https://edge.invalid/startup-cache/prepare', { method: 'POST',
    headers: { Authorization: 'Bearer operator-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sourceId, itemType: 'movie', itemId: '1' }) });
  return { context, events, target, db, request };
}
test('startup Edge entry rejects unauthenticated or caller-selected target/profile before authority reads', async () => {
  const h = harness();
  const bad = new Request(h.request.url, { method: 'POST', body: JSON.stringify({ userId, sourceId, itemType: 'movie', itemId: '1', sourceUrl: 'https://other.invalid' }), headers: { Authorization: 'Bearer operator-token' } });
  await assert.rejects(h.context.runStartupCachePreparation(bad, h.db), e => e.status === 400);
  await assert.rejects(h.context.runStartupCachePreparation(new Request(h.request.url, { method: 'POST', body: '{}' }), h.db), e => e.status === 401);
  assert.deepEqual(h.events, []);
});
for (const scenario of ['busy', 'accountRefused', 'missingEvidence', 'pregenBusy', 'revokedFileLease']) test(`startup Edge opens no transport on ${scenario}`, async () => {
  const h = harness({ [scenario]: true });
  assert.equal((await h.context.runStartupCachePreparation(h.request, h.db)).prepared, false);
  assert.equal(h.events.includes('gateway'), false);
  if (scenario === 'revokedFileLease') {
    assert.equal(h.events.filter(name => name === 'claim_provider_file_probe').length, 1);
    assert.equal(h.events.filter(name => name === 'claim_provider_account_language_validation').length, 1);
  }
});
test('startup Edge requires both leases and current authority, then releases only after confirmed drain', async () => {
  const h = harness(), result = await h.context.runStartupCachePreparation(h.request, h.db);
  assert.equal(result.prepared, true); assert.equal(result.refreshAfterSeconds, 240);
  assert.ok(h.events.indexOf('claim_provider_file_probe') < h.events.indexOf('gateway'));
  assert.ok(h.events.indexOf('gateway') < h.events.indexOf('release-file'));
  assert.equal(h.events.at(-1), 'release_provider_account_language_validation');
});
for (const scenario of ['uncertainDrain', 'transportFailure']) test(`startup Edge preserves exclusion on ${scenario}`, async () => {
  const h = harness({ [scenario]: true });
  await assert.rejects(h.context.runStartupCachePreparation(h.request, h.db));
  assert.equal(h.events.includes('release-file'), false);
  assert.equal(h.events.includes('release_provider_account_language_validation'), false);
});
test('startup lease renewal refuses changed source identity/profile and never replaces an expired lease', async () => {
  const h = harness(); const permit = { userId, sourceId, itemType: 'movie', itemId: '1',
    leaseOwner: 'startup-cache:' + userId, identityKey: 'identity', accountHash: h.target.accountHash,
    sourceRevision: h.target.revision, profileFingerprint: h.target.profileFingerprint, targetHash: 'hash:' + h.target.targetUrl };
  assert.equal(await h.context.startupCachePermitCurrent(h.db, permit), true);
  for (const key of ['identityKey', 'sourceRevision', 'profileFingerprint', 'targetHash']) {
    const before = h.events.length;
    assert.equal(await h.context.startupCachePermitCurrent(h.db, { ...permit, [key]: 'changed' }), false);
    assert.equal(h.events.slice(before).includes('claim_provider_file_probe'), false);
  }
  h.db.from = () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null }) });
  assert.equal(await h.context.startupCachePermitCurrent(h.db, permit), false);
});
test('offline startup target resolution rejects non-Xtream or unowned files before delivery discovery', async () => {
  const resolver = src.slice(src.indexOf('async function resolvePlaybackTarget('), src.indexOf('// Series have no directly-playable stream id'));
  for (const hint of [null, { targetUrl: 'https://discovery.invalid' }, { sourceType: 'xtream', streamType: 'movie', streamId: 'different' }]) {
    let discovery = false;
    const q = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: hint ? { playback_hint: hint } : null }) };
    const ctx = vm.createContext({ HttpError, isM3uEpisodeId: () => false, resolveObservedVodContainer: async () => null,
      mediaReadFromCatalog: () => true, recordOrEmpty: x => x || {}, stringOr: (x,f) => typeof x === 'string' ? x : f,
      resolveDiscoveryTarget: async () => { discovery = true; }, db: { from: () => q } });
    vm.runInContext(stripTypeScriptTypes(resolver, { mode: 'transform' }), ctx);
    await assert.rejects(ctx.resolvePlaybackTarget(sourceId, 'movie', '1', userId, ctx.db, {}, true), e => e.status === 409);
    assert.equal(discovery, false);
  }
});
