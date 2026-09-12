'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');

const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
function between(start, end) {
  const from = edge.indexOf(start), to = edge.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return edge.slice(from, to);
}
const validation = stripTypeScriptTypes(between('function canonicalVodContainer(', '\nfunction containerEvidenceKind(')
  + '\n' + between('function observedGatewayFileProfile(', '\nasync function shareObservedGatewayFile('));
const route = stripTypeScriptTypes(between('async function runCodecProfileBackfill(', '\nasync function runLidBenchmarkEndpoint('));
const now = Date.parse('2026-09-12T03:00:00Z');
class FixedDate extends Date { static now() { return now; } }
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const defaults = () => ({
  recordOrEmpty: record, Date: FixedDate,
  stringOr: (v, fallback) => typeof v === 'string' ? v : fallback,
  stringOrNull: v => typeof v === 'string' && v ? v : null,
  normalizeCodecToken: v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
  normalizeCodecProfile: v => v,
});
const profile = () => ({probeSource: 'gateway_probe', container: 'matroska', durationSeconds: 900,
  fileSizeBytes: 40000000, probedAt: '2026-09-12T02:00:00Z',
  audioTracks: [{index: 1, language: 'fr'}], subtitles: [{index: 2, language: 'en'}]});
function validator(overrides = {}) {
  return vm.runInNewContext(validation+'; observedGatewayFileProfile;', {...defaults(), ...overrides});
}

test('each profile rejection yields exactly one fixed internal reason, never input data', () => {
  const run = validator();
  const cases = [];
  for (const [facet, field] of [['audio', 'audioTracks'], ['subtitle', 'subtitles']]) {
    cases.push([{[field]: undefined}, facet+'_map_missing'],
      [{[field]: Array.from({length: 33}, (_, index) => ({index}))}, facet+'_map_too_large'],
      [{[field]: [{index: 'private-value'}]}, facet+'_index_invalid'],
      [{[field]: [{index: 3}, {index: 3}]}, facet+'_index_duplicate']);
  }
  cases.push([{probeSource: 'private-provider-secret'}, 'probe_source_invalid'],
    [{probeSource: 'gateway_inband', metadataComplete: false}, 'inband_map_incomplete'],
    [{container: 'private-title'}, 'container_unrecognized'], [{durationSeconds: 0}, 'duration_invalid'],
    [{fileSizeBytes: null}, 'file_size_invalid'], [{probedAt: 'private-date'}, 'probe_timestamp_invalid'],
    [{probedAt: new Date(now+300001).toISOString()}, 'probe_timestamp_future']);
  for (const [change, expected] of cases) {
    const reasons = [], input = {...profile(), ...change, privateCredential: 'do-not-log-me'};
    const before = structuredClone(input);
    assert.equal(run(input, reason => reasons.push(reason)), null, expected);
    assert.deepEqual(reasons, [expected]);
    assert.deepEqual(input, before, 'diagnostic must not mutate its input');
    assert.doesNotMatch(JSON.stringify(reasons), /private|do-not-log/);
  }
});

test('successful profiles never call the diagnostic and diagnostic exceptions cannot change rejection', () => {
  const run = validator();
  let count = 0;
  assert.ok(run(profile(), () => { count++; throw Error('observer-broken'); }));
  assert.equal(count, 0);
  assert.equal(run({...profile(), fileSizeBytes: 0}, () => { throw Error('observer-broken'); }), null);
  assert.equal(run({...profile(), fileSizeBytes: 0}), null);
});

test('valid exact boundaries, empty facets and supported demuxer families stay accepted', () => {
  const run = validator();
  for (const changes of [{durationSeconds: 1}, {durationSeconds: 86400}, {fileSizeBytes: 1},
    {fileSizeBytes: Number.MAX_SAFE_INTEGER}, {probedAt: new Date(now+300000).toISOString()},
    {audioTracks: [], subtitles: []}, {audioTracks: [{index: 0}, {index: 128}]},
    {audioTracks: Array.from({length: 32}, (_, index) => ({index}))},
    {probeSource: 'gateway_inband', metadataComplete: true},
    {container: 'matroska,webm'}, {container: 'mov,mp4,m4a,3gp,3g2,mj2'}, {container: 'mpegts'}]) {
    assert.ok(run({...profile(), ...changes}));
  }
});

test('the previous acceptance predicate and the diagnostic version agree across malformed fields', () => {
  // Frozen pre-change predicate. Only the explanatory observer is new; this
  // test is compatibility evidence, not proof of real-file completeness.
  const previous = `function previous(value) {
    const raw=recordOrEmpty(value),audio=raw.audioTracks??raw.audio_tracks,
      subtitles=raw.subtitles??raw.subtitleTracks??raw.subtitle_tracks;
    const validMap=tracks=>{
      if(!Array.isArray(tracks)||tracks.length>32)return false;
      const indices=tracks.map(track=>recordOrEmpty(track).index);
      return indices.every(index=>typeof index==='number'&&Number.isSafeInteger(index)&&index>=0&&index<=128)
        &&new Set(indices).size===indices.length;
    };
    if(!validMap(audio)||!validMap(subtitles))return false;
    const p=normalizeCodecProfile(raw),source=normalizeCodecToken(p.probeSource),duration=Number(p.durationSeconds),
      size=Number(p.fileSizeBytes),at=Date.parse(stringOr(p.probedAt,''));
    return !((source!=='gatewayprobe'&&!(source==='gatewayinband'&&p.metadataComplete===true))
      ||!canonicalVodContainer(p.container)||!Number.isFinite(duration)||duration<1||duration>86400
      ||!Number.isSafeInteger(size)||size<=0||!Number.isFinite(at)||at>Date.now()+300000);
  }`;
  const both = vm.runInNewContext(validation+'\n'+previous+'; ({previous, observedGatewayFileProfile});', defaults());
  const values = [undefined, null, '', false, true, -1, 0, 1, 86400, 86401, Infinity, NaN,
    '1', 'und', [], {}, [{index: 1}], [{index: 129}], [{index: 1}, {index: 1}]];
  for (const key of Object.keys(profile()).concat('metadataComplete')) {
    for (const value of values) {
      const input = {...profile(), [key]: value};
      assert.equal(Boolean(both.observedGatewayFileProfile(input)), both.previous(input), key);
    }
  }
});

function backfillHarness(change) {
  const logs = [], releases = [], fetches = [];
  const ids = {user: '00000000-0000-4000-8000-000000000001', variant: '00000000-0000-4000-8000-000000000002'};
  class HttpError extends Error {
    constructor(status, message, details) { super(message); this.status = status; this.details = details; }
  }
  const chain = {select: () => chain, eq: () => chain,
    in: async () => ({data: [{id: ids.variant, source_id: 'private-source', external_id: 'private-file'}], error: null})};
  const context = {...defaults(), HttpError, Map, Set, crypto: {randomUUID}, AbortSignal,
    PLAYBACK_SESSION_UUID_PATTERN: /^[a-f0-9-]{36}$/,
    console: {warn: (...args) => logs.push(args)}, Deno: {env: {get: () => 'private-token'}},
    codecProfileBackgroundBlockReason: async () => null,
    getRuntimeConfig: async () => ({mediaGatewayUrl: 'https://gateway.invalid', mediaGatewayToken: 'private-token'}),
    resolveSourceIdentity: async () => ({key: 'private-identity'}),
    resolvePlaybackTarget: async () => ({targetUrl: 'https://provider.invalid/private-user/private-password/movie'}),
    providerAccountHashFromUrl: async () => 'a'.repeat(64),
    assertProviderCircuitClosed: async () => {}, assertProviderProbeCircuitClosedStrict: async () => {},
    exactFileProbeAdmissionEnabled: async () => false, claimProviderFileProbeStrict: async () => true,
    releaseProviderFileProbe: async (...args) => releases.push(args),
    sha256Hex: async value => createHash('sha256').update(value).digest('hex'),
    sanitizedProviderErrorCode: () => null, providerProbeTerminalCode: () => null,
    providerProbeResponseAllowsLeaseRelease: () => true,
    fetch: async (...args) => { fetches.push(args); return {ok: true, status: 200, json: async () => ({
      codecProfileRefreshProtocol: 1, codecProfileRefreshed: true, codecProfile: {...profile(), ...change},
    })}; },
  };
  const run = vm.runInNewContext(validation+'\n'+route+'; runCodecProfileBackfill;', context);
  const request = {headers: {get: () => 'Bearer private-token'}, json: async () => ({userId: ids.user, variantIds: [ids.variant]})};
  return {run: () => run(request, {from: () => chain}), logs, releases, fetches};
}

test('the real backfill route logs the fixed reason privately, preserves public error and releases the drained lease', async () => {
  const h = backfillHarness({fileSizeBytes: 0});
  await assert.rejects(h.run(), error => {
    assert.equal(error.status, 502);
    assert.equal(error.details.code, 'incomplete_codec_profile');
    assert.equal(error.details.profileReason, undefined);
    return true;
  });
  assert.equal(h.fetches.length, 1);
  assert.equal(h.releases.length, 1);
  assert.equal(h.logs.length, 1);
  const entry = JSON.parse(JSON.stringify(h.logs[0]));
  assert.deepEqual(entry, ['[codec-profile-backfill-diagnostic]', {
    stage: 'exact-profile-validation', status: 502, kind: 'http', profileReason: 'file_size_invalid',
  }]);
  assert.doesNotMatch(JSON.stringify(entry), /private|https:|password|token|00000000/);
});
