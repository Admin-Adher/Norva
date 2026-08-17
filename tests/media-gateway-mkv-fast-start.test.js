'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
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
const ANALYZER_TYPE = 'ffprobe-key-packets-plus-ffmpeg-idr-framecrc-v2';
const ANALYZER_DIGEST = crypto.createHash('sha256').update([
  'ffprobe-key-packets-plus-ffmpeg-idr-framecrc-v2',
  'stream-select:ffprobe=V:0,ffmpeg=0:V:0',
  'ffprobe:packet=stream_index,pts,dts,duration,flags',
  'ffprobe:stream=index,time_base,profile,level,refs,r_frame_rate,avg_frame_rate,pix_fmt,width,height',
  'ffmpeg:-copyts,-copytb=1,-avoid_negative_ts=disabled',
  'bsf:h264_mp4toannexb,filter_units=pass_types=5',
  'timeline:relative-pts0,dts1,duration,time-base-microseconds',
].join('|')).digest('hex');
const keyId = (key) => crypto.createHash('sha256')
  .update('NORVA/MKV-H264-FASTSTART/V2/KID\0').update(key).digest('hex');

function loadFastStartHarness(overrides = {}) {
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
    MKV_H264_FAST_START_PROOF_BUILD: 2,
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
    MKV_H264_FAST_START_ANALYZER_TYPE: ANALYZER_TYPE,
    MKV_H264_FAST_START_ANALYZER_DIGEST: ANALYZER_DIGEST,
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
    ...overrides,
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

function loadAnalyzerHarness(overrides = {}) {
  const analyzerBlock = between(
    GATEWAY,
    'function strictMkvAnalyzerInteger(',
    '\nasync function runBoundedMkvInputPump(',
  );
  const activeAnalyzers = new Set();
  const context = {
    Buffer,
    crypto,
    PassThrough,
    setTimeout,
    clearTimeout,
    spawn,
    FFPROBE_PATH: overrides.ffprobePath || 'ffprobe',
    FFMPEG_PATH: overrides.ffmpegPath || 'ffmpeg',
    MKV_H264_FAST_START_COPY_ACTIVATION_READY: true,
    MKV_H264_FAST_START_PROOF_CURRENT_KEY: Buffer.alloc(32, 1),
    MKV_H264_FAST_START_ANALYZER_BUFFER_BYTES: overrides.bufferBytes || 8 * 1024 * 1024,
    MKV_H264_FAST_START_ANALYZER_STOP_TIMEOUT_MS: 2_000,
    MKV_H264_FAST_START_ANALYZER_MAX_LINE_BYTES: 4 * 1024,
    MKV_H264_FAST_START_ANALYZER_MAX_TIMELINE_RECORDS: 100_000,
    MKV_H264_FAST_START_MIN_KEYFRAMES: 3,
    MKV_H264_FAST_START_ANALYZER_TYPE: ANALYZER_TYPE,
    MKV_H264_FAST_START_ANALYZER_DIGEST: ANALYZER_DIGEST,
    CODEC_PROBE_TIMEOUT_MS: 60_000,
    EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
    EXACT_MATROSKA_H264_MAX_WIDTH: 1920,
    EXACT_MATROSKA_H264_MAX_HEIGHT: 1080,
    EXACT_MATROSKA_H264_MAX_PIXELS: 1920 * 1080,
    mkvH264FullFileAnalyzers: activeAnalyzers,
    isFiniteMkvVodSession: () => true,
    mkvH264FastStartIdentityContext: () => ({ tenantScopeSha256: 'a', itemScopeSha256: 'b' }),
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    exactRecordKeys: (value, expected) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const actual = Object.keys(value).sort();
      const wanted = [...expected].sort();
      return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
    },
    loopbackOnlyEnv: () => ({ ...process.env }),
    sanitizeLog: (value) => String(value || ''),
    ...overrides,
  };
  const functions = vm.runInNewContext(
    `(() => { ${analyzerBlock}; return {
      create: createMkvH264FullFilePacketAnalyzer,
      write: writeMkvH264FullFileAnalyzerChunk,
      finish: finishMkvH264FullFileAnalyzer,
      stop: stopMkvH264FullFileAnalyzer,
    }; })()`,
    context,
  );
  return { ...functions, activeAnalyzers };
}

function loadBuildCodecProfileHarness() {
  const source = between(
    GATEWAY,
    'function buildCodecProfile(',
    '\n// Store a successful profile in the codec-profile cache',
  );
  const compactRecord = (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
    value !== undefined && value !== null && value !== ''
  )));
  return vm.runInNewContext(`(() => { ${source}; return buildCodecProfile; })()`, {
    Date,
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    compactRecord,
    stringOrNull: (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
    nullableInt: (value) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null,
    nullableFloat: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
    normalizeFileSizeBytes: (value) => Number.isSafeInteger(Number(value)) ? Number(value) : null,
    estimateDurationFromFormat: () => null,
    streamLanguage: () => null,
    streamTitle: (_stream, fallback) => fallback,
    subtitleKind: () => 'unknown',
  });
}

function analyzerSession(fileSizeBytes, overrides = {}) {
  return {
    id: 'analyzer-session',
    sourceUrl: 'https://provider.example/movie/u/p/file.mkv',
    playbackIdentity: { sourceId: 's', itemType: 'movie', itemId: 'm' },
    codecProfile: exactProfile({
      fileSizeBytes,
      durationSeconds: 8.083,
      videoWidth: 320,
      videoHeight: 180,
    }),
    mode: 'remux',
    seekOffset: 0,
    mkvH264FastStart: { eligible: false },
    ...overrides,
  };
}

async function analyzeFixtureBytes(harness, bytes, sessionOverrides = {}) {
  const analyzer = harness.create(analyzerSession(bytes.length, sessionOverrides));
  assert.ok(analyzer, 'candidate analyzer must be created');
  harness.lastAnalyzer = analyzer;
  assert.equal(harness.write(analyzer, bytes), true, 'fixture must fit the bounded local queues');
  return await harness.finish(analyzer);
}

function analyzerFailureSummary(analyzer) {
  if (!analyzer) return 'analyzer missing';
  return JSON.stringify({
    failed: analyzer.failed,
    reason: analyzer.abandonedReason,
    droppedChunks: analyzer.droppedChunks,
    packetExitCode: analyzer.packetExitCode,
    idrExitCode: analyzer.idrExitCode,
    packetStderr: analyzer.packetStderr,
    idrStderr: analyzer.idrStderr,
    packetCount: analyzer.packetCount,
    keyframeCount: analyzer.keyframeCount,
    idrCount: analyzer.idrCount,
    packetTimeBase: analyzer.packetTimeBase,
    idrTimeBase: analyzer.idrTimeBase,
    streamMetadata: analyzer.streamMetadata,
  });
}

function scriptedAnalyzerChild(stdoutText, options = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exited = false;
  child.kills = 0;
  const emitExit = (code) => {
    if (child.exited) return;
    child.exited = true;
    child.emit('exit', code);
    child.emit('close', code);
  };
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      if (options.slow !== true) callback();
    },
    final(callback) {
      if (options.slow === true) return;
      if (options.stderr) child.stderr.write(options.stderr);
      child.stdout.end(stdoutText);
      child.stderr.end();
      callback();
      queueMicrotask(() => emitExit(options.exitCode ?? 0));
    },
  });
  child.kill = () => {
    child.kills += 1;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    queueMicrotask(() => emitExit(null));
    return true;
  };
  return child;
}

const VALID_PACKET_ANALYZER_OUTPUT = [
  'packet|stream_index=0|pts=83|dts=N/A|duration=41|flags=K__',
  'packet|stream_index=0|pts=2083|dts=2000|duration=41|flags=K__',
  'packet|stream_index=0|pts=4083|dts=4000|duration=41|flags=K__',
  'stream|index=0|profile=High|width=320|height=180|pix_fmt=yuv420p|level=40|refs=1|r_frame_rate=24/1|avg_frame_rate=24/1|time_base=1/1000',
  '',
].join('\n');
const VALID_IDR_ANALYZER_OUTPUT = [
  '#software: test',
  '#tb 0: 1/1000',
  '0,0,83,41,100,0x01',
  '0,2000,2083,41,100,0x02',
  '0,4000,4083,41,100,0x03',
  '',
].join('\n');

async function scriptedAnalyzerResult(packetOutput, idrOutput) {
  const children = [
    scriptedAnalyzerChild(packetOutput),
    scriptedAnalyzerChild(idrOutput),
  ];
  let index = 0;
  const harness = loadAnalyzerHarness({ spawn: () => children[index++] });
  const result = await analyzeFixtureBytes(harness, Buffer.alloc(256, 1));
  assert.equal(harness.activeAnalyzers.size, 0);
  assert.ok(children.every((child) => child.exited));
  return result;
}

function availableMediaTool(envName, executableName) {
  const configured = String(process.env[envName] || '').trim();
  const candidates = configured ? [configured] : [executableName];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function runMediaTool(executable, args, options = {}) {
  return spawnSync(executable, args, {
    encoding: options.encoding || 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function loadEdgeHarness() {
  const snippets = [
    between(EDGE, 'function publicPlaybackSession(', '\nasync function providerAccountHashFromUrl('),
    between(EDGE, 'async function persistObservedCodecProfile(', '\nfunction mergePlaybackHints('),
    between(EDGE, 'function gatewayCodecProfileContainer(', '\nfunction gatewayPlaybackHints('),
    between(EDGE, 'function bindServerMkvFastStartProof(', '\nfunction firstUsefulCodecProfile('),
    between(EDGE, 'function normalizeMkvH264FastStartProof(', '\nfunction stripMkvH264FastStartProof('),
    between(EDGE, 'function normalizeCodecProfile(', '\nfunction normalizeGatewayAudioRenditions('),
    between(EDGE, 'function normalizeCodecProfileTracks(', '\nfunction hasUsefulCodecProfile('),
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
    stringOr: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    boundedNullableInt: (value, minimum, maximum) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
    },
    boundedNullableNumber: (value, minimum, maximum) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
    },
    exactPositiveSafeInteger: (value) => {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    },
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
      normalizeCodecProfile,
      gatewayCodecProfileContainer,
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
    videoStreamIndex: 0,
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
      videoStreamIndex: codecProfile.videoStreamIndex,
      keyframeCount: 60,
      idrCount: 60,
      keyTimelineSha256: 'a'.repeat(64),
      idrTimelineSha256: 'a'.repeat(64),
      closedGopIdrVerified: true,
      firstPacketKeyframe: true,
      coverageSeconds: codecProfile.durationSeconds,
      maxKeyframeGapSeconds: 2,
      ptsPresent: true,
      dtsPresent: true,
      dtsMonotonic: true,
      muxTimestampsSafe: true,
      negativeTimestampCount: 0,
      timestampDiscontinuityCount: 0,
      leadingMissingDtsCount: 2,
      firstPtsSeconds: 0,
      firstDtsSeconds: 0,
      maxPtsDtsSkewSeconds: 0.08,
      streamTimeBaseNumerator: 1,
      streamTimeBaseDenominator: 1_000,
      videoProfile: 'High',
      videoLevel: 42,
      videoRefs: 4,
      videoFpsNumerator: 24,
      videoFpsDenominator: 1,
      videoWidth: 1920,
      videoHeight: 1080,
      videoPixelFormat: 'yuv420p',
      analyzerType: ANALYZER_TYPE,
      analyzerDigest: ANALYZER_DIGEST,
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

test('codec profile binds the exact first uppercase-V stream and excludes cover/thumbnail video', () => {
  const buildCodecProfile = loadBuildCodecProfileHarness();
  const profile = buildCodecProfile({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { index: 2, codec_type: 'video', codec_name: 'mjpeg', disposition: { timed_thumbnails: 1 } },
      { index: 4, codec_type: 'video', codec_name: 'png', disposition: { still_image: 1 } },
      {
        index: 5, codec_type: 'video', codec_name: 'h264', profile: 'High',
        width: 320, height: 180, pix_fmt: 'yuv420p', disposition: {},
      },
      { index: 6, codec_type: 'video', codec_name: 'hevc', disposition: {} },
    ],
    format: { format_name: 'matroska,webm', duration: '8.0' },
  }, Date.now(), 'gateway_inband');
  assert.equal(profile.videoStreamIndex, 5);
  assert.equal(profile.videoCodec, 'h264');
  assert.equal(profile.videoWidth, 320);

  const noPlayableVideo = buildCodecProfile({
    streams: [{ index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }],
    format: { format_name: 'matroska,webm' },
  }, Date.now(), 'gateway_inband');
  assert.equal(noPlayableVideo.videoStreamIndex, undefined);
  assert.equal(noPlayableVideo.videoCodec, undefined);
});

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
  const nonCanonical = Buffer.from(stableJson(payload).replace('"build":2', '"build":-0'));
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
  const previousOnly = loadFastStartHarness({ MKV_H264_FAST_START_PROOF_CURRENT_KEY: null });
  assert.equal(previousOnly.assess(proofSession(previousOnly)).reason, 'proof-signing-unavailable');
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
  buildMismatch.codecProfile.mkvH264FastStartProof = resign({ ...decodeEnvelope(envelope), build: 3 }, CURRENT_KEY);
  assert.equal(h.assess(buildMismatch, now + 1).reason, 'unsupported-proof');

  const metricMutations = [
    (metrics) => ({ ...metrics, closedGopIdrVerified: false }),
    (metrics) => ({ ...metrics, videoStreamIndex: metrics.videoStreamIndex + 1 }),
    (metrics) => ({ ...metrics, idrCount: metrics.idrCount - 1 }),
    (metrics) => ({ ...metrics, idrTimelineSha256: 'f'.repeat(64) }),
    (metrics) => ({ ...metrics, videoLevel: 50 }),
    (metrics) => ({ ...metrics, videoRefs: 5 }),
    (metrics) => ({ ...metrics, videoFpsNumerator: 61 }),
    (metrics) => ({ ...metrics, videoPixelFormat: 'yuv444p' }),
  ];
  for (const mutateMetrics of metricMutations) {
    const replay = makeReplay();
    const changedPayload = { ...decodeEnvelope(envelope), metrics: mutateMetrics(decodeEnvelope(envelope).metrics) };
    replay.codecProfile.mkvH264FastStartProof = resign(changedPayload, CURRENT_KEY);
    assert.equal(h.assess(replay, now + 1).reason, 'invalid-full-file-proof');
  }
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
  assert.notEqual(h.fingerprint({ ...base, videoStreamIndex: 2 }, base.fileSizeBytes), first);
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

test('dual analyzer parser accepts only one bounded matching K/IDR timeline', async (t) => {
  const valid = await scriptedAnalyzerResult(VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT);
  assert.equal(valid.closedGopIdrVerified, true);
  assert.equal(valid.keyframeCount, 3);
  assert.equal(valid.idrCount, 3);
  assert.equal(valid.keyTimelineSha256, valid.idrTimelineSha256);
  assert.equal(valid.streamTimeBaseNumerator, 1);
  assert.equal(valid.streamTimeBaseDenominator, 1_000);
  assert.equal(valid.videoStreamIndex, 0);
  const nonZeroInputStream = await scriptedAnalyzerResult(
    VALID_PACKET_ANALYZER_OUTPUT
      .replaceAll('stream_index=0', 'stream_index=5')
      .replace('stream|index=0', 'stream|index=5'),
    VALID_IDR_ANALYZER_OUTPUT,
  );
  assert.equal(nonZeroInputStream.closedGopIdrVerified, true, 'ffprobe input stream index is not the framecrc output index');
  assert.equal(nonZeroInputStream.videoStreamIndex, 5);
  const batchedPacketOutput = [
    ...Array.from({ length: 101 }, (_, index) => {
      const pts = 83 + index * 40;
      const dts = index === 0 ? 'N/A' : String(pts - 80);
      const flags = index === 0 || index === 50 || index === 100 ? 'K__' : '___';
      return `packet|stream_index=0|pts=${pts}|dts=${dts}|duration=40|flags=${flags}`;
    }),
    'stream|index=0|profile=High|width=320|height=180|pix_fmt=yuv420p|level=40|refs=1|r_frame_rate=25/1|avg_frame_rate=25/1|time_base=1/1000',
    '',
  ].join('\n');
  assert.ok(Buffer.byteLength(batchedPacketOutput) > 4 * 1024);
  const batchedIdrOutput = [
    '#tb 0: 1/1000',
    '0,0,83,40,100,0x01',
    '0,2003,2083,40,100,0x02',
    '0,4003,4083,40,100,0x03',
    '',
  ].join('\n');
  assert.equal(
    (await scriptedAnalyzerResult(batchedPacketOutput, batchedIdrOutput)).closedGopIdrVerified,
    true,
    'a large stdout chunk containing many bounded lines must not look like one oversized line',
  );

  const invalidCases = [
    ['missing time base', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('#tb 0: 1/1000\n', '')],
    ['duplicate time base', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('#tb 0: 1/1000', '#tb 0: 1/1000\n#tb 0: 1/1000')],
    ['data before time base', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('#tb 0: 1/1000\n', '').replace('#software: test\n', '0,0,83,41,100,0x00\n#tb 0: 1/1000\n')],
    ['N/A framecrc timestamp', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('0,2000,2083', '0,N/A,2083')],
    ['unsafe integer', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('0,4000,4083', '0,9007199254740992,4083')],
    ['zero payload', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('41,100,0x02', '41,0,0x02')],
    ['extra stream', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('0,2000,2083', '1,2000,2083')],
    ['time-base mismatch', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('1/1000', '1/90000')],
    ['open GOP count mismatch', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace(/0,2000[\s\S]*$/, '')],
    ['timeline mismatch', VALID_PACKET_ANALYZER_OUTPUT, VALID_IDR_ANALYZER_OUTPUT.replace('0,4000,4083', '0,4000,4084')],
    ['non-increasing key PTS', VALID_PACKET_ANALYZER_OUTPUT.replace('pts=4083|dts=4000', 'pts=2083|dts=4000'), VALID_IDR_ANALYZER_OUTPUT],
    ['oversized FPS rational', VALID_PACKET_ANALYZER_OUTPUT.replace('r_frame_rate=24/1', 'r_frame_rate=1000000001/1'), VALID_IDR_ANALYZER_OUTPUT],
    ['discarded packet', VALID_PACKET_ANALYZER_OUTPUT.replace('flags=K__', 'flags=KD_'), VALID_IDR_ANALYZER_OUTPUT],
    ['line overflow', VALID_PACKET_ANALYZER_OUTPUT, `#${'x'.repeat(4_097)}\n${VALID_IDR_ANALYZER_OUTPUT}`],
  ];
  for (const [name, packetOutput, idrOutput] of invalidCases) {
    await t.test(name, async () => {
      assert.equal(await scriptedAnalyzerResult(packetOutput, idrOutput), null);
    });
  }
});

test('real closed-GOP fixture matches every IDR and open-GOP segments are rejected', { timeout: 120_000 }, async (t) => {
  const ffmpegPath = availableMediaTool('NORVA_TEST_FFMPEG_PATH', 'ffmpeg');
  const ffprobePath = availableMediaTool('NORVA_TEST_FFPROBE_PATH', 'ffprobe');
  if (!ffmpegPath || !ffprobePath) {
    t.skip('set NORVA_TEST_FFMPEG_PATH and NORVA_TEST_FFPROBE_PATH for the runtime fixture');
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-mkv-idr-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const createFixture = (name, closedGop) => {
    const output = path.join(tempRoot, `${name}.mkv`);
    const created = runMediaTool(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-profile:v', 'high', '-level:v', '4.0',
      '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-bf', '2', '-refs', '3', '-flags', closedGop ? '+cgop' : '-cgop',
      '-an', '-avoid_negative_ts', 'make_zero', '-y', output,
    ]);
    assert.equal(created.status, 0, created.stderr || `failed to create ${name}`);
    return output;
  };
  const closedFile = createFixture('closed', true);
  const openFile = createFixture('open', false);
  const countKeyPackets = (file) => {
    const result = runMediaTool(ffprobePath, [
      '-v', 'error', '-select_streams', 'V:0', '-show_packets',
      '-show_entries', 'packet=pts,dts,duration,flags', '-of', 'compact=p=1:nk=0', file,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split(/\r?\n/).filter((line) => /flags=[A-Z_]*K/.test(line)).length;
  };
  const countIdrPackets = (file) => {
    const result = runMediaTool(ffmpegPath, [
      '-v', 'error', '-nostdin', '-copyts', '-copytb', '1',
      '-avoid_negative_ts', 'disabled', '-i', file, '-map', '0:V:0',
      '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb,filter_units=pass_types=5',
      '-f', 'framecrc', 'pipe:1',
    ]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split(/\r?\n/).filter((line) => /^0,/.test(line)).length;
  };
  const closedKeys = countKeyPackets(closedFile);
  const closedIdrs = countIdrPackets(closedFile);
  const openKeys = countKeyPackets(openFile);
  const openIdrs = countIdrPackets(openFile);
  assert.equal(closedKeys, 4);
  assert.equal(closedIdrs, closedKeys);
  assert.equal(openKeys, 4);
  assert.ok(openIdrs < openKeys, 'negative fixture must contain recovery-point keyframes without IDR NALs');

  const harness = loadAnalyzerHarness({ ffmpegPath, ffprobePath });
  const closedMetrics = await analyzeFixtureBytes(harness, fs.readFileSync(closedFile));
  assert.ok(closedMetrics, analyzerFailureSummary(harness.lastAnalyzer));
  assert.equal(closedMetrics.closedGopIdrVerified, true);
  assert.equal(closedMetrics.idrCount, closedMetrics.keyframeCount);
  assert.equal(closedMetrics.keyTimelineSha256, closedMetrics.idrTimelineSha256);
  assert.equal(await analyzeFixtureBytes(harness, fs.readFileSync(openFile)), null);

  const createMultiVideoFixture = (name, firstVideo, secondVideo) => {
    const output = path.join(tempRoot, `${name}.mkv`);
    const created = runMediaTool(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=8',
      '-i', firstVideo, '-i', secondVideo,
      '-map', '0:a:0', '-map', '1:V:0', '-map', '2:V:0',
      '-c:a', 'aac', '-c:v', 'copy', '-t', '8', '-y', output,
    ]);
    assert.equal(created.status, 0, created.stderr || `failed to create ${name}`);
    return output;
  };
  const selectedVideoIndex = (file) => {
    const selected = runMediaTool(ffprobePath, [
      '-v', 'error', '-select_streams', 'V:0',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
    ]);
    assert.equal(selected.status, 0, selected.stderr);
    return Number(selected.stdout.trim());
  };
  const positiveMulti = createMultiVideoFixture('audio-closed-open', closedFile, openFile);
  const negativeMulti = createMultiVideoFixture('audio-open-closed', openFile, closedFile);
  assert.equal(selectedVideoIndex(positiveMulti), 1, 'audio stream 0 must not renumber the selected input video');
  assert.equal(selectedVideoIndex(negativeMulti), 1);
  const profileProbe = runMediaTool(ffprobePath, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', positiveMulti,
  ]);
  assert.equal(profileProbe.status, 0, profileProbe.stderr);
  const selectedProfile = loadBuildCodecProfileHarness()(
    JSON.parse(profileProbe.stdout), Date.now(), 'gateway_inband',
  );
  assert.equal(selectedProfile.videoStreamIndex, 1);
  const positiveMultiBytes = fs.readFileSync(positiveMulti);
  const positiveMultiMetrics = await analyzeFixtureBytes(harness, positiveMultiBytes, {
    codecProfile: exactProfile({
      fileSizeBytes: positiveMultiBytes.length,
      durationSeconds: 8.083,
      videoStreamIndex: 1,
      videoWidth: 320,
      videoHeight: 180,
      audioTracks: [{ index: 0, codec: 'aac', profile: 'LC', channels: 2, sampleRate: 48_000, default: true }],
    }),
  });
  assert.ok(positiveMultiMetrics, analyzerFailureSummary(harness.lastAnalyzer));
  assert.equal(positiveMultiMetrics.videoStreamIndex, selectedProfile.videoStreamIndex);
  assert.equal(
    await analyzeFixtureBytes(harness, fs.readFileSync(negativeMulti)),
    null,
    'an open first V stream must be rejected even when a later video stream is closed-GOP',
  );
  const multiProofHarness = loadFastStartHarness();
  const multiProofSession = proofSession(multiProofHarness, {
    codecProfile: {
      fileSizeBytes: positiveMultiBytes.length,
      durationSeconds: positiveMultiMetrics.coverageSeconds,
      videoStreamIndex: 1,
      videoWidth: 320,
      videoHeight: 180,
      audioTracks: [{ index: 0, codec: 'aac', profile: 'LC', channels: 2, sampleRate: 48_000, default: true }],
    },
    mkvH264FullFilePacketMetrics: positiveMultiMetrics,
  });
  const multiProof = multiProofHarness.finalize(multiProofSession, Date.parse('2026-08-17T12:00:00Z'));
  assert.equal(decodeEnvelope(multiProof).metrics.videoStreamIndex, 1);
  assert.equal(harness.activeAnalyzers.size, 0);
  const proofHarness = loadFastStartHarness();
  const cold = proofSession(proofHarness, {
    codecProfile: {
      fileSizeBytes: fs.statSync(closedFile).size,
      durationSeconds: closedMetrics.coverageSeconds,
      videoWidth: 320,
      videoHeight: 180,
    },
    mkvH264FullFilePacketMetrics: closedMetrics,
  });
  const learnedProof = proofHarness.finalize(cold, Date.parse('2026-08-17T12:00:00Z'));
  assert.equal(typeof learnedProof, 'string');
  const replay = proofSession(proofHarness, {
    codecProfile: {
      fileSizeBytes: fs.statSync(closedFile).size,
      durationSeconds: closedMetrics.coverageSeconds,
      videoWidth: 320,
      videoHeight: 180,
      mkvH264FastStartProof: learnedProof,
    },
  });
  assert.equal(proofHarness.assess(replay, Date.parse('2026-08-17T12:00:01Z')).eligible, true);

  const segment = (file, name) => {
    const directory = path.join(tempRoot, `${name}-hls`);
    fs.mkdirSync(directory);
    const result = runMediaTool(ffmpegPath, [
      '-v', 'error', '-i', file, '-map', '0:V:0', '-c:v', 'copy', '-an',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_segment_type', 'mpegts', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(directory, 'segment-%03d.ts'),
      path.join(directory, 'playlist.m3u8'),
    ]);
    assert.equal(result.status, 0, result.stderr);
    return fs.readdirSync(directory)
      .filter((entry) => entry.endsWith('.ts')).sort()
      .map((entry) => path.join(directory, entry));
  };
  const closedSegments = segment(closedFile, 'closed');
  const openSegments = segment(openFile, 'open');
  const nullSink = process.platform === 'win32' ? 'NUL' : '/dev/null';
  assert.equal(closedSegments.length, 4);
  for (const file of closedSegments) {
    const decoded = runMediaTool(ffmpegPath, ['-v', 'error', '-xerror', '-i', file, '-map', '0:V:0', '-f', 'null', nullSink]);
    assert.equal(decoded.status, 0, decoded.stderr);
  }
  const openDecodeFailures = openSegments.slice(1).filter((file) => (
    runMediaTool(ffmpegPath, ['-v', 'error', '-xerror', '-i', file, '-map', '0:V:0', '-f', 'null', nullSink]).status !== 0
  ));
  assert.ok(openDecodeFailures.length > 0, 'at least one non-initial open-GOP segment must fail isolated decode');
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

test('an admitted replay starts one FFmpeg graph with copied video and transcoded audio', () => {
  const session = {
    id: 'fast-replay',
    sourceUrl: 'https://provider.example/movie/u/p/file.mkv',
    outputDir: path.join(os.tmpdir(), 'norva-fast-replay-args'),
    playlistPath: path.join(os.tmpdir(), 'norva-fast-replay-args', 'playlist.m3u8'),
    hlsTargetSeconds: 2,
    videoMode: 'copy',
    forceMkvH264FastStartAudioTranscode: true,
    forceExactMatroskaH264Reencode: false,
    forceAlignedMultiAudioVideoEncode: false,
    fastInputProbe: false,
    forceFullInputProbe: false,
    status: 'starting',
    logTail: '',
  };
  let capturedArgs = null;
  let spawnCount = 0;
  const fakeSpawn = (_binary, args) => {
    spawnCount += 1;
    capturedArgs = args;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.destroy = () => {};
    return child;
  };
  const startFfmpegSource = between(GATEWAY, 'function startFfmpeg(', '\nfunction seekArgsForSession(').trim();
  const startFfmpeg = vm.runInNewContext(`(${startFfmpegSource})`, {
    path,
    multiAudioHlsEnabled: () => false,
    inputProbeArgsForSession: () => [],
    shouldCopyAudio: (value) => value.forceMkvH264FastStartAudioTranscode !== true,
    audioArgsForSession: (_value, copyAudio) => copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2'],
    audioMapForSession: () => '0:1',
    normalizeAudioStreamIndex: (value) => Number(value),
    videoModeForSession: (value) => value.videoMode,
    isFiniteMkvVodSession: () => true,
    usesSourceTimestampedCopySeek: () => false,
    seekArgsForSession: () => ({ preInputSeek: [], postInputSeek: [] }),
    appendSubtitleOutputs: () => {},
    spawn: fakeSpawn,
    FFMPEG_PATH: 'ffmpeg',
    proxyEnvFor: () => ({}),
    proxyKeyFromUrl: () => 'provider.example',
    sanitizeLog: (value) => value,
    appendLogTail: () => {},
    console: { warn() {}, error() {} },
    lastNonEmptyLine: () => '',
    wakePlaybackBlockedQueues: () => {},
    startBoundedMkvInputPump: () => ({
      controller: { abort() {} },
      promise: new Promise(() => {}),
      completed: false,
    }),
    stopChildProcess: async () => {},
    waitForPlaylist: async () => {},
    STARTUP_TIMEOUT_MS: 60_000,
    EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
  });
  startFfmpeg(session);
  assert.equal(spawnCount, 1);
  assert.equal(capturedArgs[capturedArgs.indexOf('-map') + 1], '0:V:0?', 'replay must map the same uppercase-V stream that was attested');
  assert.equal(capturedArgs[capturedArgs.indexOf('-c:v') + 1], 'copy');
  assert.equal(capturedArgs[capturedArgs.indexOf('-c:a') + 1], 'aac');
  assert.equal(capturedArgs[capturedArgs.indexOf('-profile:a') + 1], 'aac_low');
  assert.equal(capturedArgs[capturedArgs.indexOf('-hls_time') + 1], '2');
  assert.equal(capturedArgs.includes('-force_key_frames'), false, 'copy graph must not invent segment independence');
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
  assert.equal(edge.normalizeCodecProfile({ video_stream_index: 5 }).videoStreamIndex, 5);
  assert.equal(edge.normalizeCodecProfile({ videoStreamIndex: 1_025 }).videoStreamIndex, undefined);
  const forged = { codecProfile: { container: 'mkv', videoCodec: 'h264', mkvH264FastStartProof: proof } };
  const episode = edge.bindServerMkvFastStartProof(forged, forged, false);
  assert.equal(episode.codecProfile.mkvH264FastStartProof, undefined);
  const movie = edge.bindServerMkvFastStartProof(forged, forged, true);
  assert.equal(movie.codecProfile.mkvH264FastStartProof, proof);
  assert.equal(
    edge.gatewayCodecProfileContainer({ container: 'matroska,webm' }, { container: 'mp4' }),
    'matroska,webm',
    'the current Gateway profile must win over a stale/client container hint',
  );

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
    codecProfile: { container: 'mkv', videoStreamIndex: 5, videoCodec: 'h264' },
    allowProofReplacement: false,
  }), true);
  assert.equal(partialDb.state.patches[0].playback_hint.codecProfile.videoStreamIndex, 5);
  assert.equal(JSON.stringify(partialDb.state.patches).includes(proof), false);

  const eofDb = mediaItemDb(item);
  assert.equal(await edge.persistObservedCodecProfile(eofDb.db, {
    ...baseOptions,
    codecProfile: { container: 'mkv', videoStreamIndex: 5, videoCodec: 'h264', mkvH264FastStartProof: proof },
    allowProofReplacement: true,
  }), true);
  assert.equal(eofDb.state.patches[0].playback_hint.codecProfile.videoStreamIndex, 5);
  assert.equal(JSON.stringify(eofDb.state.patches).includes(proof), true);

  const proofHarness = loadFastStartHarness();
  const trained = proofSession(proofHarness);
  const learnedEnvelope = proofHarness.finalize(trained, Date.parse('2026-08-17T12:00:00Z'));
  const roundTripDb = mediaItemDb(item);
  assert.equal(await edge.persistObservedCodecProfile(roundTripDb.db, {
    ...baseOptions,
    codecProfile: trained.codecProfile,
    allowProofReplacement: true,
  }), true);
  const persistedProfile = roundTripDb.state.patches[0].playback_hint.codecProfile;
  assert.equal(persistedProfile.videoStreamIndex, 0);
  assert.equal(persistedProfile.mkvH264FastStartProof, learnedEnvelope);
  const replayAfterEdgeRoundTrip = proofSession(proofHarness, { codecProfile: persistedProfile });
  assert.equal(
    proofHarness.assess(replayAfterEdgeRoundTrip, Date.parse('2026-08-17T12:00:01Z')).eligible,
    true,
    'the signed stream index must survive Gateway cleanup, Edge normalization and owner-row persistence',
  );

  const driftedDb = mediaItemDb({ ...item, updated_at: '2026-08-17T12:01:00.000Z' });
  assert.equal(await edge.persistObservedCodecProfile(driftedDb.db, {
    ...baseOptions,
    codecProfile: { container: 'mkv', videoCodec: 'h264', mkvH264FastStartProof: proof },
    allowProofReplacement: true,
  }), false);
  assert.equal(driftedDb.state.patches.length, 0);
});

test('signed video copy is active while the local HLS cache remains explicitly dark', () => {
  assert.match(GATEWAY, /const MKV_H264_FAST_START_COPY_ACTIVATION_READY = true/);
  assert.match(GATEWAY, /closed-gop-proof-unavailable/);
  assert.match(GATEWAY, /const MKV_H264_HLS_CACHE_ACTIVATION_READY = false/);
  assert.match(GATEWAY, /scope: 'local-replica'/);
  assert.doesNotMatch(
    between(GATEWAY, 'const MKV_H264_HLS_CACHE_SECRET', '\nconst MULTI_AUDIO_HLS_PROTOCOL'),
    /GATEWAY_TOKEN/,
  );
});
