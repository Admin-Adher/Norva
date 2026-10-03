const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

async function run({ code, blockAt = 1, payload = { info: { audio: {} } }, transportError, guardError } = {}) {
  const { runProviderAudioMetadataBatch } = await import('../supabase/functions/_shared/provider-audio-metadata-batch.mjs');
  const text = fs.readFileSync(require('node:path').join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
  const start = text.indexOf('async function ownedMetadataProviderBlockReason(');
  const end = text.indexOf('\nasync function exactFileProbeAdmissionEnabled(', start);
  const counts = { gates: 0, claims: 0, network: 0, releases: 0, writes: 0, sourceFences: 0 };
  const acks = [];
  class HttpError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
  const chain = { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null }; } };
  const db = { from: () => chain, async rpc(name) {
    if (name === 'catalog_owned_language_metadata_enabled_for_source') return { data: true };
    assert.equal(name, 'record_owned_movie_language_declaration'); counts.writes++; return { data: 1 };
  } };
  const context = vm.createContext({
    HttpError, crypto: { randomUUID: () => 'synthetic-lease' }, PLAYBACK_SESSION_UUID_PATTERN: /^identity$/,
    stringOr: (x, fallback) => typeof x === 'string' ? x : fallback, stringOrNull: x => x || null,
    recordOrEmpty: x => x && typeof x === 'object' ? x : {}, isRecord: x => !!x && typeof x === 'object' && !Array.isArray(x),
    readActiveCatalogGenerationSnapshot: async () => ({ generationId: 'generation', configRevision: 1, sourceVisibilityEpoch: 1 }),
    loadSourceConfig: async () => ({ serverUrl: 'https://supplier.invalid', username: 'fixture', password: 'fixture' }),
    getRuntimeConfig: async () => ({ mediaGatewayUrl: 'https://gateway.invalid', mediaGatewayToken: 'fixture' }),
    resolvePlaybackTarget: async () => ({ targetUrl: 'https://supplier.invalid/movie/123' }),
    providerAccountHashFromUrl: async () => 'account', codecProfileBackgroundBlockReason: async () => null,
    assertProviderCircuitClosed: async () => {
      counts.gates++;
      if (guardError) throw guardError;
      if (code === 'PROVIDER_ACCOUNT_BUSY' && counts.gates === blockAt) throw new HttpError(409, 'private details', { code });
    },
    assertProviderProbeCircuitClosedStrict: async () => {
      if (code === 'PROVIDER_PROBE_CIRCUIT_OPEN' && counts.gates === blockAt) throw new HttpError(409, 'private details', { code });
    },
    claimProviderFileProbeStrict: async () => { counts.claims++; return true; },
    releaseProviderFileProbe: async () => { counts.releases++; },
    assertActiveCatalogGenerationCurrent: async () => { counts.sourceFences++; },
    requireAutomaticLanguageEnrichmentAccess: async () => {}, loadLanguageValidationIdentity: async () => 'identity',
    catalogGenerationRpcFence: () => ({}),
    fetchBoundedProviderJson: async () => { counts.network++; if (transportError) throw transportError; return { response: { ok: true }, value: payload }; },
  });
  vm.runInContext(stripTypeScriptTypes(text.slice(start, end)), context);
  let claimed = false;
  const result = await runProviderAudioMetadataBatch({
    claim: async () => claimed ? { hasMore: false } : (claimed = true, { variantId: 'variant' }),
    read: () => context.runOwnedMovieLanguageMetadata(db, 'owner', 'source', 'variant', '123', 'identity'),
    finish: async (_item, outcome) => { acks.push(outcome); }, pause: async () => {},
  });
  return { result, counts, acks };
}

for (const code of ['PROVIDER_ACCOUNT_BUSY', 'PROVIDER_PROBE_CIRCUIT_OPEN']) {
  for (const blockAt of [1, 2]) test(`${code} at preflight ${blockAt} defers without a request, failed attempt or uncertain lease`, async () => {
    const x = await run({ code, blockAt });
    assert.equal(x.result.deferred, 1); assert.equal(x.result.failed, 0); assert.equal(x.result.attempted, 0);
    assert.equal(x.result.skipped, code.toLowerCase()); assert.equal(x.counts.network, 0); assert.equal(x.counts.writes, 0);
    assert.equal(x.counts.claims, blockAt - 1); assert.equal(x.counts.releases, blockAt - 1);
    assert.equal(x.acks.length, 1); assert.equal(x.acks[0].uncertain, false);
    assert.doesNotMatch(JSON.stringify(x), /private details/);
  });
}
test('a completed invalid metadata body remains failed but releases transport exclusion', async () => {
  const x = await run({ payload: {} });
  assert.equal(x.result.failed, 1); assert.equal(x.result.attempted, 1); assert.equal(x.result.identified, 0);
  assert.equal(x.acks[0].code, 'provider-metadata-invalid'); assert.equal(x.acks[0].uncertain, false);
  assert.equal(x.counts.releases, 1); assert.equal(x.counts.writes, 0);
});
test('unknown preflight failures retain conservative acknowledgement', async () => {
  const x = await run({ guardError: new Error('database unavailable') });
  assert.equal(x.result.failed, 1); assert.equal(x.acks[0].uncertain, true); assert.equal(x.counts.network, 0);
});
test('a transport exception with a guard-looking code cannot obtain a preflight exemption', async () => {
  const error = Object.assign(new Error('transport failed'), { details: { code: 'PROVIDER_PROBE_CIRCUIT_OPEN' } });
  const x = await run({ transportError: error });
  assert.equal(x.result.failed, 1); assert.equal(x.acks[0].uncertain, true);
  assert.equal(x.counts.network, 1); assert.equal(x.counts.releases, 0);
});
test('admitted metadata keeps both gates, source fences, persistence and one provider request', async () => {
  const x = await run();
  assert.equal(x.result.identified, 1); assert.equal(x.counts.gates, 2);
  assert.equal(x.counts.sourceFences, 2); assert.equal(x.counts.network, 1);
  assert.equal(x.counts.writes, 1); assert.equal(x.counts.releases, 1); assert.equal(x.acks.length, 1);
});
