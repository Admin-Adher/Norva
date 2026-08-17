'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const ROOT = path.join(__dirname, '..');
const GATEWAY = fs.readFileSync(path.join(ROOT, 'services/media-gateway/src/index.js'), 'utf8').replace(/\r\n?/g, '\n');
const EDGE = fs.readFileSync(path.join(ROOT, 'supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n?/g, '\n');
const WATCH = fs.readFileSync(path.join(ROOT, 'public/js/pages/WatchPage.js'), 'utf8').replace(/\r\n?/g, '\n');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} section missing`);
  return source.slice(start, end);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const CURRENT_KEY = Buffer.alloc(32, 0x11);
const PREVIOUS_KEY = Buffer.alloc(32, 0x22);
const DOMAIN = Buffer.from('NORVA/MKV-H264-FASTSTART/V2\0');
const keyId = (key) => crypto.createHash('sha256')
  .update('NORVA/MKV-H264-FASTSTART/V2/KID\0').update(key).digest('hex');

function loadFastStartHarness() {
  const proofBlock = between(
    GATEWAY,
    'function mkvH264FastStartProofForProfile(',
    '\nconst mkvH264HlsCacheStats =',
  );
  const analyzerGate = between(
    GATEWAY,
    'function shouldCreateMkvH264FullFilePacketAnalyzer(',
    '\nfunction abandonMkvH264FullFileAnalyzer(',
  );
  const context = {
    crypto,
    TextDecoder,
    Buffer,
    Date,
    MKV_H264_FAST_START_PROTOCOL: 2,
    MKV_H264_FAST_START_PROOF_BUILD: 1,
    MKV_H264_FAST_START_COPY_ACTIVATION_READY: true,
    MKV_H264_FAST_START_PROOF_CURRENT_KEY: CURRENT_KEY,
    MKV_H264_FAST_START_PROOF_PREVIOUS_KEY: PREVIOUS_KEY,
    MKV_H264_FAST_START_PROOF_VERIFICATION_KEYS: [
      { key: CURRENT_KEY, kid: keyId(CURRENT_KEY) },
      { key: PREVIOUS_KEY, kid: keyId(PREVIOUS_KEY) },
    ],
    MKV_H264_FAST_START_PROOF_MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000,
    MKV_H264_FAST_START_PROOF_FUTURE_SKEW_MS: 5 * 60 * 1000,
    MKV_H264_FAST_START_MAX_GOP_SECONDS: 2,
    MKV_H264_FAST_START_MIN_KEYFRAMES: 3,
    MKV_H264_FAST_START_BUFFER_SECONDS: 6,
    MKV_H264_FAST_START_MIN_SEGMENTS: 3,
    MKV_H264_FAST_START_MIN_ENCODE_RATE_X: 1.15,
    EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
    EXACT_MATROSKA_H264_MAX_WIDTH: 1920,
    EXACT_MATROSKA_H264_MAX_HEIGHT: 1080,
    EXACT_MATROSKA_H264_MAX_PIXELS: 1920 * 1080,
    stableJson,
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    compactRecord: (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
      value !== undefined && value !== null && value !== ''
    ))),
    normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    normalizeSessionKey: (value) => String(value || '').trim() || null,
    stringOrNull: (value) => String(value || '').trim() || null,
    sha256Hex: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
    mkvH264FastStartProofKeyId: keyId,
    isFiniteMkvVodSession: (session) => session?.testFinite !== false,
    isLiveSession: () => false,
    cacheCodecProfile: () => {},
    videoModeForSession: (session) => session.videoMode || 'encode',
    audioModeForSession: (session) => session.testAudioMode || 'encode',
  };
  return vm.runInNewContext(
    `(() => { ${proofBlock}\n${analyzerGate}; return {
      fingerprint: mkvH264FastStartProfileFingerprint,
      seal: sealMkvH264FastStartProof,
      open: openMkvH264FastStartProof,
      finalize: maybeFinalizeMkvH264FastStartProof,
      assess: assessMkvH264FastStart,
      freeze: freezeMkvH264FastStart,
      policy: startupPolicyForSession,
      analyzerGate: shouldCreateMkvH264FullFilePacketAnalyzer,
    }; })()`,
    context,
  );
}

function loadEdgeHarness() {
  const snippets = [
    between(EDGE, 'function publicPlaybackSession(', '\nasync function providerAccountHashFromUrl('),
    between(EDGE, 'async function persistObservedCodecProfile(', '\nfunction mergePlaybackHints('),
    between(EDGE, 'function bindServerMkvFastStartProof(', '\nfunction firstUsefulCodecProfile('),
    between(EDGE, 'function normalizeMkvH264FastStartProof(', '\nfunction stripMkvH264FastStartProof('),
  ].join('\n');
  const js = stripTypeScriptTypes(snippets, { mode: 'strip' });
  const recordOrEmpty = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const compactRecord = (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
    value !== undefined && value !== null && value !== ''
  )));
  const normalizeProof = (value) => {
    if (typeof value !== 'string' || value.length > 16_384) return null;
    const parts = value.split('.');
    return parts.length === 2 && parts[0] && parts[1].length === 43 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
      ? value : null;
  };
  const normalizeProfile = (value) => {
    const profile = { ...recordOrEmpty(value) };
    const proof = normalizeProof(profile.mkvH264FastStartProof ?? profile.mkv_h264_fast_start_proof);
    delete profile.mkv_h264_fast_start_proof;
    if (proof) profile.mkvH264FastStartProof = proof;
    else delete profile.mkvH264FastStartProof;
    return compactRecord(profile);
  };
  const context = {
    Date,
    console,
    recordOrEmpty,
    compactRecord,
    stringOrNull: (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
    normalizeCodecProfile: normalizeProfile,
    hasUsefulCodecProfile: (profile) => Boolean(profile?.videoCodec || profile?.audioCodec || profile?.container),
    stripMkvH264FastStartProof: (value) => {
      const profile = { ...recordOrEmpty(value) };
      delete profile.mkvH264FastStartProof;
      delete profile.mkv_h264_fast_start_proof;
      return compactRecord(profile);
    },
    firstUsefulCodecProfile: (...values) => values.map(normalizeProfile).find((profile) => (
      profile.videoCodec || profile.audioCodec || profile.container
    )) || {},
    mergeCodecProfileAnnotations: (existing, observed) => compactRecord({ ...recordOrEmpty(existing), ...recordOrEmpty(observed) }),
    mergePlaybackHints: (base, override) => compactRecord({ ...recordOrEmpty(base), ...recordOrEmpty(override) }),
    compatibilityTierForCodecProfile: () => 'gateway',
    playbackCostScoreForObservation: () => 1,
    isProjectionMissing: () => false,
    throwDb: (error) => { throw error; },
    HttpError: class HttpError extends Error {},
  };
  return vm.runInNewContext(
    `(() => { ${js}; return {
      publicPlaybackSession,
      persistObservedCodecProfile,
      bindServerMkvFastStartProof,
      normalizeMkvH264FastStartProof,
    }; })()`,
    context,
  );
}

function mediaItemDb(item) {
  const state = { patches: [] };
  const db = {
    from() {
      let mode = 'read';
      let patch = null;
      const filters = {};
      const query = {
        select() {
          if (mode === 'update') {
            const matches = filters.id === item?.id && filters.updated_at === item?.updated_at;
            if (matches) state.patches.push(patch);
            return Promise.resolve({ data: matches ? [{ id: item.id }] : [], error: null });
          }
          return query;
        },
        update(value) { mode = 'update'; patch = value; return query; },
        eq(key, value) { if (mode === 'update') filters[key] = value; return query; },
        maybeSingle() { return Promise.resolve({ data: item, error: null }); },
      };
      return query;
    },
  };
  return { db, state };
}

function exactProfile(overrides = {}) {
  return {
    metadataComplete: true,
    probeSource: 'gateway_inband',
    probedAt: '2026-08-17T12:00:00.000Z',
    fileSizeBytes: 1_000_000,
    container: 'matroska,webm',
    durationSeconds: 120,
    videoCodec: 'h264',
    videoProfile: 'High',
    videoPixelFormat: 'yuv420p',
    videoWidth: 1920,
    videoHeight: 1080,
    audioCodec: 'aac',
    audioProfile: 'LC',
    audioChannels: 2,
    audioSampleRate: 48_000,
    audioChannelLayout: 'stereo',
    audioTracks: [{
      index: 1, codec: 'aac', profile: 'LC', channels: 2,
      sampleRate: 48_000, channelLayout: 'stereo', default: true,
    }],
    subtitles: [],
    ...overrides,
  };
}

function proofSession(harness, overrides = {}) {
  const { codecProfile: codecProfileOverrides, ...sessionOverrides } = overrides;
  const codecProfile = exactProfile(codecProfileOverrides);
  const session = {
    id: 'session-1',
    sourceUrl: 'https://provider.example/movie/account/title.mkv',
    ownerKey: 'owner-hash',
    providerSlotKey: 'account:provider-hash',
    playbackIdentity: { sourceId: 'source-1', itemType: 'movie', itemId: 'movie-1', variantId: '' },
    playbackHint: { streamType: 'movie', container: 'mkv' },
    codecProfile,
    mode: 'remux',
    seekOffset: 0,
    forceAlignedMultiAudioVideoEncode: false,
    vodInputEffectiveUrlSha256: crypto.createHash('sha256').update('effective-url').digest('hex'),
    vodInputStrongValidator: {
      type: 'etag-sha256',
      digest: crypto.createHash('sha256').update('"etag-v1"').digest('hex'),
    },
    mkvH264FullFilePacketMetrics: {
      bytesAnalyzed: codecProfile.fileSizeBytes,
      packetCount: 3_000,
      keyframeCount: 60,
      firstPacketKeyframe: true,
      coverageSeconds: codecProfile.durationSeconds,
      maxKeyframeGapSeconds: 2,
      ptsPresent: true,
      dtsPresent: true,
      dtsMonotonic: true,
      muxTimestampsSafe: true,
      negativeTimestampCount: 0,
      timestampDiscontinuityCount: 0,
      firstPtsSeconds: 0,
      firstDtsSeconds: 0,
      maxPtsDtsSkewSeconds: 0.08,
      analyzerType: 'ffprobe-packet-stream-v1',
      analyzerDigest: crypto.createHash('sha256')
        .update('ffprobe-packet-stream-v1|pts_time,dts_time,duration_time,flags').digest('hex'),
    },
    ...sessionOverrides,
  };
  const fingerprint = harness.fingerprint(session.codecProfile, session.codecProfile.fileSizeBytes);
  session.mkvH264CurrentHeaderAuthority = {
    source: 'gateway-inband-current',
    captureOwner: session.id,
    profileFingerprint: fingerprint,
  };
  return session;
}

function resign(payload, key) {
  const bytes = Buffer.from(stableJson(payload));
  const mac = crypto.createHmac('sha256', key).update(DOMAIN).update(bytes).digest();
  return `${bytes.toString('base64url')}.${mac.toString('base64url')}`;
}

function decodeEnvelope(envelope) {
  return JSON.parse(Buffer.from(envelope.split('.')[0], 'base64url').toString('utf8'));
}

test('cold full EOF mints a signed full-file proof; only the next request may copy video', () => {
  const h = loadFastStartHarness();
  const now = Date.parse('2026-08-17T12:00:00Z');
  const cold = proofSession(h);
  assert.equal(h.assess(cold, now).reason, 'missing-proof');
  cold.videoMode = 'encode';
  const envelope = h.finalize(cold, now);
  assert.equal(typeof envelope, 'string');
  assert.equal(envelope.split('.').length, 2);
  assert.equal(cold.videoMode, 'encode', 'EOF never mutates the current frozen graph');
  const payload = h.open(envelope);
  assert.equal(payload.protocol, 2);
  assert.equal(payload.scope, 'full-file');
  assert.equal(payload.metrics.bytesAnalyzed, cold.codecProfile.fileSizeBytes);
  assert.equal(payload.metrics.coverageSeconds, cold.codecProfile.durationSeconds);
  assert.equal('sourceUrl' in payload, false, 'proof payload contains no raw URL');

  const replay = proofSession(h, { codecProfile: { mkvH264FastStartProof: envelope } });
  assert.equal(h.assess(replay, now + 1).eligible, true);
  assert.equal(h.freeze(replay).eligible, true);
  assert.equal(replay.forceMkvH264FastStartAudioTranscode, true);
});

test('HMAC v2 rejects malformed/cross-key/canonical aliases and accepts the previous key grace slot', () => {
  const h = loadFastStartHarness();
  const now = Date.parse('2026-08-17T12:00:00Z');
  const session = proofSession(h);
  const current = h.finalize(session, now);
  const payload = decodeEnvelope(current);
  assert.equal(h.open(`${current}=`), null);
  assert.equal(h.open(current.replace('.', '.+')), null);
  assert.equal(h.open(resign({ ...payload, unexpected: true }, CURRENT_KEY)), null);
  assert.equal(h.open(resign({ ...payload, kid: keyId(CURRENT_KEY) }, PREVIOUS_KEY)), null);
  const previous = { ...payload, kid: keyId(PREVIOUS_KEY) };
  assert.equal(h.open(resign(previous, PREVIOUS_KEY)).kid, keyId(PREVIOUS_KEY));
  const invalidUtf8 = Buffer.from([0xff, 0xfe]);
  const invalidUtf8Mac = crypto.createHmac('sha256', CURRENT_KEY).update(DOMAIN).update(invalidUtf8).digest('base64url');
  assert.equal(h.open(`${invalidUtf8.toString('base64url')}.${invalidUtf8Mac}`), null);
  assert.equal(h.open(resign({ ...payload, metrics: { ...payload.metrics, alias: 1 } }, CURRENT_KEY)), null);
  const nonCanonical = Buffer.from(stableJson(payload).replace('"build":1', '"build":-0'));
  const nonCanonicalMac = crypto.createHmac('sha256', CURRENT_KEY).update(DOMAIN).update(nonCanonical).digest('base64url');
  assert.equal(h.open(`${nonCanonical.toString('base64url')}.${nonCanonicalMac}`), null);
});

test('proof signing key decoder accepts exactly 32-byte hex and fails closed otherwise', () => {
  const source = between(GATEWAY, 'function decodeMkvH264FastStartProofKey(', '\nfunction mkvH264FastStartProofKeyId(').trim();
  const decode = vm.runInNewContext(`(${source})`, { Buffer });
  assert.equal(decode('11'.repeat(32)).length, 32);
  for (const invalid of ['', '11'.repeat(31), '11'.repeat(33), Buffer.alloc(32).toString('base64'), 'zz'.repeat(32)]) {
    assert.equal(decode(invalid), null);
  }
});

test('proof admission is bound to URL, redirect target, validator, owner, item, file and graph build', () => {
  const h = loadFastStartHarness();
  const now = Date.parse('2026-08-17T12:00:00Z');
  const original = proofSession(h);
  const envelope = h.finalize(original, now);
  const makeReplay = () => proofSession(h, { codecProfile: { mkvH264FastStartProof: envelope } });
  const cases = [
    ['proof-source-mismatch', (s) => { s.sourceUrl += '?other'; }],
    ['proof-effective-url-mismatch', (s) => { s.vodInputEffectiveUrlSha256 = 'a'.repeat(64); }],
    ['validator-mismatch', (s) => { s.vodInputStrongValidator.digest = 'b'.repeat(64); }],
    ['proof-tenant-mismatch', (s) => { s.ownerKey = 'another-owner'; }],
    ['proof-item-mismatch', (s) => { s.playbackIdentity.itemId = 'another-item'; }],
    ['profile-fingerprint-mismatch', (s) => { s.codecProfile.videoWidth = 1280; }],
    ['profile-fingerprint-mismatch', (s) => { s.codecProfile.audioProfile = 'HE-AAC'; }],
  ];
  for (const [reason, mutate] of cases) {
    const replay = makeReplay();
    mutate(replay);
    assert.equal(h.assess(replay, now + 1).reason, reason);
  }
  const buildMismatch = makeReplay();
  buildMismatch.codecProfile.mkvH264FastStartProof = resign({ ...decodeEnvelope(envelope), build: 2 }, CURRENT_KEY);
  assert.equal(h.assess(buildMismatch, now + 1).reason, 'unsupported-proof');
});

test('profile fingerprint ignores observation timestamps but rejects structural codec changes', () => {
  const h = loadFastStartHarness();
  const base = exactProfile();
  const first = h.fingerprint(base, base.fileSizeBytes);
  const observedLater = h.fingerprint({
    ...base,
    probedAt: '2026-09-01T00:00:00Z',
    probeSource: 'exact_file_probe',
  }, base.fileSizeBytes);
  assert.equal(observedLater, first);
  assert.notEqual(h.fingerprint({ ...base, videoHeight: 720 }, base.fileSizeBytes), first);
  assert.notEqual(h.fingerprint({ ...base, audioTracks: [{ ...base.audioTracks[0], channels: 6 }] }, base.fileSizeBytes), first);
});

test('expiry is inclusive at the signed deadline and stale one millisecond later', () => {
  const h = loadFastStartHarness();
  const now = Date.parse('2026-08-17T12:00:00Z');
  const original = proofSession(h);
  const envelope = h.finalize(original, now);
  const payload = decodeEnvelope(envelope);
  const replay = proofSession(h, { codecProfile: { mkvH264FastStartProof: envelope } });
  assert.equal(h.assess(replay, payload.expiresAtMs).eligible, true);
  assert.equal(h.assess(replay, payload.expiresAtMs + 1).reason, 'stale-proof');
});

test('analyzer is absent on replay, episode, seek, multi-audio, HEVC and explicit transcode', () => {
  const h = loadFastStartHarness();
  const candidate = proofSession(h);
  assert.equal(h.analyzerGate(candidate), true);
  const cases = [
    { mkvH264FastStart: { eligible: true } },
    { playbackIdentity: { sourceId: 's', itemType: 'series', itemId: 'e' } },
    { seekOffset: 10 },
    { forceAlignedMultiAudioVideoEncode: true },
    { mode: 'transcode' },
    { codecProfile: exactProfile({ videoCodec: 'hevc' }) },
  ];
  for (const override of cases) assert.equal(h.analyzerGate({ ...candidate, ...override }), false);
});

test('startup policy protocol 2 shortens the buffer only for measured copy video and never exposes proof', () => {
  const h = loadFastStartHarness();
  const now = Date.parse('2026-08-17T12:00:00Z');
  const cold = proofSession(h);
  const envelope = h.finalize(cold, now);
  const replay = proofSession(h, { codecProfile: { mkvH264FastStartProof: envelope } });
  h.freeze(replay);
  replay.videoMode = 'copy';
  replay.testAudioMode = 'encode';
  replay.startupTimings = { playlistBufferSeconds: 6, ffmpegReadyMs: 3_000 };
  assert.deepEqual(JSON.parse(JSON.stringify(h.policy(replay))), {
    protocol: 2,
    eligible: true,
    pipeline: 'audio-transcode',
    targetBufferSeconds: 6,
    minimumEncodeRateX: 1.15,
    observedEncodeRateX: 2,
    reason: 'mkv-h264-copy-ready',
  });
});

test('Edge authority, response redaction, original-item CAS and protocol-2 Web contract are wired fail closed', () => {
  const create = between(EDGE, 'async function createPlaybackSession(', '\nasync function getPlaybackSession(');
  const cleanup = between(EDGE, 'async function expirePlaybackSession(', '\nasync function recordPlaybackSessionFailure(');
  const closeAll = between(EDGE, 'async function closeOpenGatewaySessionsForUser(', '\nasync function prepareEdgeSessionCoordinator(');
  const publicSession = between(EDGE, 'function publicPlaybackSession(', '\nasync function providerAccountHashFromUrl(');
  const bind = between(EDGE, 'function bindServerMkvFastStartProof(', '\nfunction firstUsefulCodecProfile(');
  assert.match(create, /itemType === "movie" \? resolved\.playbackHint : \{\}/);
  assert.match(create, /variantId: null/);
  assert.match(create, /__norvaMkvH264FastStartItemCasV2/);
  assert.match(create, /deferGatewayProfilePersistenceForMkvFastStart/);
  assert.match(bind, /serverAuthority/);
  assert.match(publicSession, /stripMkvH264FastStartProofDeep/);
  assert.match(publicSession, /mkv_h264_fast_start_proof/);
  assert.match(cleanup, /finalCodecProfile[\s\S]*expectedItemCas/);
  assert.match(closeAll, /finalCodecProfile[\s\S]*expectedItemCas/);
  assert.match(EDGE, /protocol !== 2/);
  assert.match(WATCH, /Number\(policy\.protocol\) !== 2/);
  assert.match(WATCH, /protocol: 2/);
});

test('Edge runtime strips forged proofs and persists partial/EOF profiles only against the original item version', async () => {
  const edge = loadEdgeHarness();
  const proof = `e30.${'a'.repeat(43)}`;
  const forged = { codecProfile: { container: 'mkv', videoCodec: 'h264', mkvH264FastStartProof: proof } };
  const episode = edge.bindServerMkvFastStartProof(forged, forged, false);
  assert.equal(episode.codecProfile.mkvH264FastStartProof, undefined);
  const movie = edge.bindServerMkvFastStartProof(forged, forged, true);
  assert.equal(movie.codecProfile.mkvH264FastStartProof, proof);

  const stored = {
    playback_hint: { codecProfile: { mkvH264FastStartProof: proof } },
    nested: [{ codec_profile: { mkv_h264_fast_start_proof: proof } }],
    __norvaMkvH264FastStartItemCasV2: { id: 'internal' },
  };
  const publicValue = edge.publicPlaybackSession(stored);
  assert.equal(JSON.stringify(publicValue).includes(proof), false);
  assert.equal(JSON.stringify(publicValue).includes('__norvaMkvH264FastStartItemCasV2'), false);
  assert.equal(stored.playback_hint.codecProfile.mkvH264FastStartProof, proof, 'redaction must not mutate stored JSON');

  const item = {
    id: '10000000-0000-4000-8000-000000000001',
    updated_at: '2026-08-17T12:00:00.000Z',
    metadata: {},
    playback_hint: { codecProfile: { container: 'mkv', videoCodec: 'h264' } },
  };
  const baseOptions = {
    userId: 'u', sourceId: 's', itemType: 'movie', itemId: 'm',
    startupMs: null, audioMode: null, requireItemCas: true, itemOnly: true,
    expectedItemCas: { id: item.id, updatedAt: item.updated_at, targetUrlHash: 'a'.repeat(64) },
  };
  const partialDb = mediaItemDb(item);
  assert.equal(await edge.persistObservedCodecProfile(partialDb.db, {
    ...baseOptions,
    codecProfile: { container: 'mkv', videoCodec: 'h264' },
    allowProofReplacement: false,
  }), true);
  assert.equal(JSON.stringify(partialDb.state.patches).includes(proof), false);

  const eofDb = mediaItemDb(item);
  assert.equal(await edge.persistObservedCodecProfile(eofDb.db, {
    ...baseOptions,
    codecProfile: { container: 'mkv', videoCodec: 'h264', mkvH264FastStartProof: proof },
    allowProofReplacement: true,
  }), true);
  assert.equal(JSON.stringify(eofDb.state.patches).includes(proof), true);

  const driftedDb = mediaItemDb({ ...item, updated_at: '2026-08-17T12:01:00.000Z' });
  assert.equal(await edge.persistObservedCodecProfile(driftedDb.db, {
    ...baseOptions,
    codecProfile: { container: 'mkv', videoCodec: 'h264', mkvH264FastStartProof: proof },
    allowProofReplacement: true,
  }), false);
  assert.equal(driftedDb.state.patches.length, 0);
});

test('local HLS cache remains explicitly dark and uses no Gateway bearer-token fallback', () => {
  assert.match(GATEWAY, /const MKV_H264_FAST_START_COPY_ACTIVATION_READY = false/);
  assert.match(GATEWAY, /closed-gop-proof-unavailable/);
  assert.match(GATEWAY, /const MKV_H264_HLS_CACHE_ACTIVATION_READY = false/);
  assert.match(GATEWAY, /scope: 'local-replica'/);
  assert.doesNotMatch(
    between(GATEWAY, 'const MKV_H264_HLS_CACHE_SECRET', '\nconst MULTI_AUDIO_HLS_PROTOCOL'),
    /GATEWAY_TOKEN/,
  );
});
