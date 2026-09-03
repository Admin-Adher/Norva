'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { stripTypeScriptTypes } = require('node:module');
const { CompleteMkvHlsCache } = require('../services/media-gateway/src/mkv-hls-cache');
const {
  videoEncoderInputArgs,
  videoEncoderOutputArgs,
} = require('../services/media-gateway/src/video-encoder');
const {
  buildExactSubtitleHlsPlan,
} = require('../services/media-gateway/src/sharedHlsTracks');

const ROOT = path.join(__dirname, '..');
const GATEWAY = fs.readFileSync(path.join(ROOT, 'services/media-gateway/src/index.js'), 'utf8').replace(/\r\n?/g, '\n');
const EDGE = fs.readFileSync(path.join(ROOT, 'supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n?/g, '\n');
const WATCH = fs.readFileSync(path.join(ROOT, 'public/js/pages/WatchPage.js'), 'utf8').replace(/\r\n?/g, '\n');

function gatewayChildNodePath() {
  const candidates = [];
  const addCandidate = (candidate) => {
    const normalized = String(candidate || '').trim();
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  addCandidate(process.env.NORVA_TEST_NODE_MODULES);
  addCandidate(path.join(ROOT, 'node_modules'));
  for (const inherited of String(process.env.NODE_PATH || '').split(path.delimiter)) addCandidate(inherited);

  const commonDirProbe = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (commonDirProbe.status === 0) {
    const reported = String(commonDirProbe.stdout || '').trim();
    const commonGitDirectory = path.isAbsolute(reported) ? reported : path.resolve(ROOT, reported);
    addCandidate(path.join(path.dirname(commonGitDirectory), 'node_modules'));
  }

  const dependencyRoots = candidates.filter((candidate) => (
    fs.existsSync(path.join(candidate, 'express', 'package.json'))
  ));
  assert.ok(
    dependencyRoots.length > 0,
    `Gateway integration test requires an installed express dependency; searched ${candidates.join(', ')}`,
  );
  return dependencyRoots.join(path.delimiter);
}

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
const COMPLETE_CACHE_KEY = Buffer.alloc(32, 0x33);
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
  const multiAudioBlock = between(
    GATEWAY,
    'function multiAudioProfileAssessment(',
    '\nfunction multiAudioHlsEnabled(',
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
    VAAPI_VOD_FAST_START_BUFFER_SECONDS: 6,
    VAAPI_VOD_FAST_START_MIN_ENCODE_RATE_X: 2,
    VIDEO_ENCODER_CONFIG: { backend: 'software' },
    VIDEO_ENCODER_PREFLIGHT: { ready: true },
    MKV_H264_FAST_START_ANALYZER_TYPE: ANALYZER_TYPE,
    MKV_H264_FAST_START_ANALYZER_DIGEST: ANALYZER_DIGEST,
    MKV_COMPLETE_HLS_CACHE_PROTOCOL: 2,
    MKV_COMPLETE_HLS_CACHE_LOCATOR_BUILD: 2,
    MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY: COMPLETE_CACHE_KEY,
    MKV_COMPLETE_HLS_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
    MKV_COMPLETE_HLS_CACHE_PIPELINE_BUILD: 'mkv-complete-hls-mpegts-v6',
    MKV_COMPLETE_HLS_CACHE_PROFILE_SNAPSHOT_MAX_BYTES: 256 * 1024,
    mkvCompleteHlsCache: {},
    EXACT_MATROSKA_H264_HLS_TARGET_SECONDS: 2,
    EXACT_MATROSKA_H264_MAX_WIDTH: 1920,
    EXACT_MATROSKA_H264_MAX_HEIGHT: 1080,
    EXACT_MATROSKA_H264_MAX_PIXELS: 1920 * 1080,
    MULTI_AUDIO_HLS_PROTOCOL: 1,
    MAX_MULTI_AUDIO_RENDITIONS: 12,
    MAX_EXACT_SUBTITLE_HLS_RENDITIONS: 32,
    MAX_CACHEABLE_EXACT_SUBTITLE_HLS_RENDITIONS: 8,
    stableJson,
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    compactRecord: (record) => Object.fromEntries(Object.entries(record || {}).filter(([, value]) => (
      value !== undefined && value !== null && value !== ''
    ))),
    normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    normalizeSessionKey: (value) => String(value || '').trim() || null,
    stringOrNull: (value) => String(value || '').trim() || null,
    normalizeAudioStreamIndex: (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1024 ? parsed : null;
    },
    buildExactSubtitleHlsPlan,
    sha256Hex: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
    mkvH264FastStartProofKeyId: keyId,
    isFiniteMkvVodSession: (session) => session?.testFinite !== false,
    isLiveSession: () => false,
    cacheCodecProfile: () => {},
    multiAudioHlsEnabled: (session) => session?.multiAudioHls?.enabled === true,
    videoModeForSession: (session) => session.videoMode || 'encode',
    audioModeForSession: (session) => session.testAudioMode || 'encode',
    ...overrides,
  };
  return vm.runInNewContext(
    `(() => { ${multiAudioBlock}\n${proofBlock}\n${analyzerGate}; return {
      fingerprint: mkvH264FastStartProfileFingerprint,
      seal: sealMkvH264FastStartProof,
      open: openMkvH264FastStartProof,
      finalize: maybeFinalizeMkvH264FastStartProof,
      assess: assessMkvH264FastStart,
      freeze: freezeMkvH264FastStart,
      needsCurrentHeader: needsMkvH264CurrentHeaderAuthority,
      policy: startupPolicyForSession,
      applyVaapiReadiness: applyVaapiVodStartupReadiness,
      analyzerGate: shouldCreateMkvH264FullFilePacketAnalyzer,
      buildCompleteCacheLocator: buildMkvCompleteHlsCacheLocator,
      verifyGenericCompleteCache: verifiedGenericMkvCompleteCacheBinding,
      openCompleteCacheProof: openMkvCompleteHlsCacheProof,
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
  const source = [
    between(
      GATEWAY,
      'function strictMkvAnalyzerRational(',
      '\nfunction sameMkvAnalyzerRational(',
    ),
    between(
      GATEWAY,
      'function buildCodecProfile(',
      '\n// Store a successful profile in the codec-profile cache',
    ),
  ].join('\n');
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
  const session = analyzerSession(bytes.length, sessionOverrides);
  const analyzer = harness.create(session);
  assert.ok(analyzer, 'candidate analyzer must be created');
  harness.lastAnalyzer = analyzer;
  harness.lastSession = session;
  assert.equal(session.startupTimings.analyzerSpawnCount, 2);
  assert.equal(harness.write(analyzer, bytes), true, 'fixture must fit the bounded local queues');
  return await harness.finish(analyzer);
}

function loadCompleteCachePromotionBarrierHarness(publish) {
  const block = between(
    GATEWAY,
    'function scheduleMkvCompleteHlsCachePromotion(',
    '\nfunction needsMkvH264CurrentHeaderAuthority(',
  );
  return vm.runInNewContext(
    `(() => { ${block}; return scheduleMkvCompleteHlsCachePromotion; })()`,
    { Promise, console, maybePublishMkvCompleteHlsCache: publish },
  );
}

function loadCompleteCacheContinuationHarness(overrides = {}) {
  const block = between(
    GATEWAY,
    'function mkvCompleteHlsBackgroundContinuationTargets(',
    '\nfunction needsMkvH264CurrentHeaderAuthority(',
  );
  const timers = [];
  const stats = {
    continuationsStarted: 0,
    continuationsCompleted: 0,
    continuationsPreempted: 0,
    continuationsTimedOut: 0,
    continuationsFailed: 0,
    continuationCallbackFailures: 0,
  };
  const context = {
    Date,
    Promise,
    AbortSignal,
    setImmediate,
    MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_REQUESTED: true,
    SHARED_MEDIA_CACHE_BACKGROUND_CONTINUATION_REQUESTED: false,
    MKV_COMPLETE_HLS_BACKGROUND_CONTINUATION_MAX_MS: 30 * 60 * 1000,
    MKV_COMPLETE_HLS_BACKGROUND_CALLBACK_TIMEOUT_MS: 1_000,
    MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY: Buffer.alloc(32, 7),
    GATEWAY_TOKEN: 'gateway-token',
    edgeCallbackBase: 'http://edge.internal/norva-playback',
    mkvCompleteHlsCache: {},
    sharedMediaCachePublisher: null,
    mediaCacheProducerControl: { active: false, schedule() {} },
    sessions: new Map(),
    providerSlotKeyForSession: () => 'provider-slot',
    isSessionBlockingProviderSlot: () => false,
    mkvCompleteHlsCacheStats: stats,
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    mkvCompleteHlsCacheStaticContext: () => ({ eligible: true, reason: 'accepted' }),
    sharedMediaCacheStaticContext: () => ({ eligible: false, reason: 'disabled' }),
    randomToken: () => 'rotated-private-token',
    scheduleMkvCompleteHlsCachePromotion: async (session) => {
      session.codecProfile = {
        container: 'matroska,webm',
        videoCodec: 'hevc',
        mkvCompleteHlsCacheProof: `e30.${'z'.repeat(43)}`,
      };
      session.mkvCompleteHlsCacheProofFinalized = true;
      return { status: 'published' };
    },
    scheduleSharedMediaCachePublication: async () => null,
    privateFinalCodecProfileForSession: (session) => session.codecProfile,
    mkvCompleteHlsCacheProofForProfile: (profile) => profile?.mkvCompleteHlsCacheProof || null,
    wakePlaybackBlockedQueues: () => {},
    sleep: async () => {},
    fetch: async () => ({ ok: true, status: 200 }),
    stopSession: async (session, options) => { session.testStopReason = options?.reason || null; },
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    ...overrides,
  };
  const harness = vm.runInNewContext(
    `(() => { ${block}; return {
      enabled: mkvCompleteHlsBackgroundContinuationEnabled,
      assess: assessMkvCompleteHlsBackgroundContinuation,
      settle: settleMkvCompleteHlsBackgroundContinuation,
      report: reportMkvCompleteHlsBackgroundContinuation,
      finish: finishMkvCompleteHlsBackgroundContinuation,
      start: startMkvCompleteHlsBackgroundContinuation,
    }; })()`,
    context,
  );
  return { ...harness, stats, timers };
}

function loadCompleteCachePreemptionHarness(sessions, stopSession) {
  const block = between(
    GATEWAY,
    'async function stopConflictingProviderSessions(',
    '\nasync function stopConflictingOwnerSessions(',
  );
  return vm.runInNewContext(
    `(() => { ${block}; return stopConflictingProviderSessions; })()`,
    {
      sessions,
      providerSlotKeyForSession: (session) => session.providerSlotKey,
      isSessionBlockingProviderSlot: (session) => Boolean(
        session?.backgroundCacheContinuation === true && !session?.stoppingPromise &&
        session?.backgroundCacheContinuationProviderDrained !== true,
      ),
      stopSession,
      console: { log() {} },
      Promise,
    },
  );
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

function loadEdgeHarness(overrides = {}) {
  const snippets = [
    between(EDGE, 'function publicPlaybackSession(', '\nasync function providerAccountHashFromUrl('),
    between(EDGE, 'async function persistObservedCodecProfile(', '\nfunction mergePlaybackHints('),
    between(EDGE, 'function gatewayCodecProfileContainer(', '\nfunction gatewayPlaybackHints('),
    between(EDGE, 'function bindServerMkvFastStartProof(', '\nfunction firstUsefulCodecProfile('),
    between(EDGE, 'function normalizeMkvH264FastStartProof(', '\nfunction stripMkvH264FastStartProof('),
    between(EDGE, 'function mkvH264FastStartItemCasFromPlaybackSession(', '\nfunction normalizeGatewayStartupPolicy('),
    between(EDGE, 'function normalizeCodecProfile(', '\nfunction normalizeGatewayAudioRenditions('),
    between(EDGE, 'function normalizeCodecProfileTracks(', '\nfunction hasUsefulCodecProfile('),
    between(EDGE, 'function requireConfiguredMediaGatewayCallback(', '\n// Best-effort account-activity'),
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
  let runtimeConfig = null;
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
      delete profile.mkvCompleteHlsCacheProof;
      delete profile.mkv_complete_hls_cache_proof;
      return compactRecord(profile);
    },
    firstUsefulCodecProfile: (...values) => values.map(normalizeProfile).find((profile) => (
      profile.videoCodec || profile.audioCodec || profile.container
    )) || {},
    mergeCodecProfileAnnotations: (existing, observed) => compactRecord({ ...recordOrEmpty(existing), ...recordOrEmpty(observed) }),
    mergePlaybackHints: (base, override) => compactRecord({ ...recordOrEmpty(base), ...recordOrEmpty(override) }),
    // Public-field allowlisting is exercised by playback-public-payload-contract;
    // this extracted harness isolates the proof-stripping/CAS behavior.
    sanitizePlaybackSession: (value) => value,
    compatibilityTierForCodecProfile: () => 'gateway',
    playbackCostScoreForObservation: () => 1,
    isProjectionMissing: () => false,
    isCatalogGenerationSuperseded: () => false,
    readActiveCatalogGenerationSnapshot: async (_db, sourceId, userId) => ({
      sourceId,
      userId,
      generationId: '90000000-0000-4000-8000-000000000001',
      headRevision: 1,
      sourceCatalogEpoch: 1,
      sourceConfigRevision: 1,
    }),
    patchActiveCatalogMediaItems: async (db, options) => {
      let update = db.from('cloud_media_items')
        .update(options.patch)
        .eq('user_id', options.userId)
        .eq('source_id', options.sourceId)
        .eq('generation_id', options.generation.generationId)
        .eq('id', options.id);
      if (options.updatedAt) update = update.eq('updated_at', options.updatedAt);
      const { data, error } = await update.select('id');
      return { data, error, superseded: false };
    },
    patchActiveCatalogTitleVariants: async () => ({ data: [], error: null, superseded: false }),
    throwDb: (error) => { throw error; },
    PLAYBACK_SESSION_UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    getRuntimeConfig: async () => runtimeConfig,
    HttpError: class HttpError extends Error {
      constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
      }
    },
    ...overrides,
  };
  const harness = vm.runInNewContext(
    `(() => { ${js}; return {
      publicPlaybackSession,
      persistObservedCodecProfile,
      bindServerMkvFastStartProof,
      normalizeMkvH264FastStartProof,
      normalizeCodecProfile,
      gatewayCodecProfileContainer,
      requireConfiguredMediaGatewayCallback,
      runCompleteHlsCacheCallback,
    }; })()`,
    context,
  );
  harness.setRuntimeConfig = (value) => { runtimeConfig = value; };
  return harness;
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

function completeCacheCallbackDb({ gatewaySession, playbackSession, item }) {
  const state = { patches: [] };
  const db = {
    from(table) {
      let mode = 'read';
      let patch = null;
      const filters = {};
      const query = {
        select() {
          if (mode !== 'update') return query;
          const matches = filters.id === item?.id && filters.updated_at === item?.updated_at;
          if (matches) {
            state.patches.push(patch);
            item.metadata = patch.metadata;
            item.playback_hint = patch.playback_hint;
            item.updated_at = '2026-08-17T12:00:01.000Z';
          }
          return Promise.resolve({ data: matches ? [{ id: item.id }] : [], error: null });
        },
        update(value) { mode = 'update'; patch = value; return query; },
        eq(key, value) { filters[key] = value; return query; },
        maybeSingle() {
          if (table === 'cloud_gateway_sessions') {
            const matches = gatewaySession &&
              gatewaySession.external_session_id === filters.external_session_id &&
              gatewaySession.playback_session_id === filters.playback_session_id;
            return Promise.resolve({ data: matches ? gatewaySession : null, error: null });
          }
          if (table === 'cloud_playback_sessions') {
            const matches = playbackSession && playbackSession.id === filters.id &&
              playbackSession.user_id === filters.user_id;
            return Promise.resolve({ data: matches ? playbackSession : null, error: null });
          }
          if (table === 'cloud_catalog_visible_media_items') {
            return Promise.resolve({ data: item, error: null });
          }
          throw new Error(`unexpected table ${table}`);
        },
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
      {
        index: 7, codec_type: 'subtitle', codec_name: 'subrip',
        disposition: { default: 1 },
      },
    ],
    format: { format_name: 'matroska,webm', duration: '8.0' },
  }, Date.now(), 'gateway_inband');
  assert.equal(profile.videoStreamIndex, 5);
  assert.equal(profile.videoCodec, 'h264');
  assert.equal(profile.videoWidth, 320);
  assert.equal(profile.subtitles[0].default, true,
    'ffprobe subtitle disposition.default survives the gateway profile boundary');

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
  assert.equal(replay.mkvH264FastStartAudioAuthority, true);
  assert.equal(replay.forceMkvH264FastStartAudioTranscode, false);
});

test('current-header capture is limited to eligible H.264 copy graphs and one authority per session', () => {
  const h = loadFastStartHarness();
  const eligible = proofSession(h);
  eligible.mkvH264FastStart = { eligible: false };
  delete eligible.mkvH264CurrentHeaderAuthority;
  assert.equal(h.needsCurrentHeader(eligible), true, 'an unproven eligible H.264 graph needs current bytes');

  const multiAudio = proofSession(h, {
    codecProfile: {
      audioTracks: [
        exactProfile().audioTracks[0],
        { index: 2, codec: 'aac', profile: 'LC', channels: 2, sampleRate: 48_000 },
      ],
    },
  });
  multiAudio.mkvH264FastStart = { eligible: false };
  delete multiAudio.mkvH264CurrentHeaderAuthority;
  assert.equal(h.needsCurrentHeader(multiAudio), false, 'multi-audio can never enter the copy lane');

  const enriched = proofSession(h);
  enriched.mkvH264FastStart = { eligible: false };
  assert.equal(h.needsCurrentHeader(enriched), false, 'matching current-session authority is not recaptured');
  enriched.mkvH264CurrentHeaderAuthority.profileFingerprint = 'f'.repeat(64);
  assert.equal(h.needsCurrentHeader(enriched), true, 'a stale profile fingerprint must be recaptured');
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

test('generic complete-cache locator admits a prepared HEVC graph without provider rediscovery', () => {
  const h = loadFastStartHarness();
  const trained = proofSession(h, {
    mode: 'transcode',
    videoMode: 'encode',
    testAudioMode: 'transcode',
    audioStreamIndex: 1,
    audioMode: 'transcode',
    clientAudioPassthrough: false,
    hlsTargetSeconds: 4,
    inputPump: { completed: true },
    codecProfile: {
      videoCodec: 'hevc',
      videoProfile: 'Main',
      videoPixelFormat: 'yuv420p10le',
    },
  });
  const issuedAtMs = Date.parse('2026-08-17T12:30:00.000Z');
  const locator = h.buildCompleteCacheLocator(trained, issuedAtMs);
  assert.ok(locator?.envelope);
  assert.equal(locator.payload.scope, 'complete-hls');
  assert.equal(
    locator.payload.pipelineBuild,
    'mkv-complete-hls-mpegts-v6:video-encode:audio-transcode:subtitles-webvtt-0:target-4',
  );
  assert.equal(h.openCompleteCacheProof(locator.envelope)?.profileFingerprint, locator.payload.profileFingerprint);

  trained.codecProfile.videoCodec = 'h264';
  assert.equal(locator.codecProfileSnapshot.videoCodec, 'hevc', 'locator must retain an immutable JSON profile snapshot');

  const replay = {
    ...trained,
    inputPump: null,
    codecProfile: { ...locator.codecProfileSnapshot, mkvCompleteHlsCacheProof: locator.envelope },
  };
  const accepted = h.verifyGenericCompleteCache(replay, issuedAtMs + 1_000);
  assert.equal(accepted.eligible, true);
  assert.equal(accepted.binding.pipelineBuild, locator.payload.pipelineBuild);

  const requestShapedReplay = { ...replay };
  delete requestShapedReplay.audioStreamIndex;
  delete requestShapedReplay.audioMode;
  delete requestShapedReplay.clientAudioPassthrough;
  assert.equal(
    h.verifyGenericCompleteCache(requestShapedReplay, issuedAtMs + 1_000).eligible,
    true,
    'runtime-only audio hints must not invalidate an identical single-audio HLS graph',
  );

  const acceptedSeek = h.verifyGenericCompleteCache({
    ...replay,
    seekOffset: 2_062,
  }, issuedAtMs + 1_000);
  assert.equal(acceptedSeek.eligible, true,
    'a complete local HLS graph must remain valid for a non-zero local seek');
  assert.equal(acceptedSeek.binding.pipelineBuild, locator.payload.pipelineBuild);

  assert.equal(h.verifyGenericCompleteCache({ ...replay, sourceUrl: `${replay.sourceUrl}?changed=1` }, issuedAtMs + 1_000).eligible, false);
  assert.equal(h.verifyGenericCompleteCache({
    ...replay,
    playbackIdentity: { ...replay.playbackIdentity, itemId: 'another-movie' },
  }, issuedAtMs + 1_000).eligible, false);
  assert.equal(h.verifyGenericCompleteCache({
    ...replay,
    codecProfile: { ...replay.codecProfile, videoCodec: 'h264' },
  }, issuedAtMs + 1_000).eligible, false);
  const tampered = `${locator.envelope.slice(0, -1)}${locator.envelope.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(h.verifyGenericCompleteCache({
    ...replay,
    codecProfile: { ...replay.codecProfile, mkvCompleteHlsCacheProof: tampered },
  }, issuedAtMs + 1_000).eligible, false);
});

test('generic complete-cache lookup authenticates the signed segmentation target without live VAAPI state', () => {
  const h = loadFastStartHarness({
    VIDEO_ENCODER_CONFIG: { backend: 'vaapi' },
    VIDEO_ENCODER_PREFLIGHT: { ready: true },
  });
  const issuedAtMs = Date.parse('2026-08-17T12:40:00.000Z');
  const trained = proofSession(h, {
    mode: 'remux',
    videoMode: 'encode',
    testAudioMode: 'transcode',
    hlsTargetSeconds: 2,
    inputPump: { completed: true },
    codecProfile: {
      videoCodec: 'hevc',
      videoProfile: 'Main 10',
      videoPixelFormat: 'yuv420p10le',
      audioCodec: 'eac3',
      audioProfile: '',
      audioChannels: 6,
      audioChannelLayout: '5.1',
      audioTracks: [{
        index: 1, codec: 'eac3', profile: '', channels: 6,
        sampleRate: 48_000, channelLayout: '5.1', default: true,
      }],
    },
  });
  const locator = h.buildCompleteCacheLocator(trained, issuedAtMs);
  assert.equal(
    locator?.payload?.pipelineBuild,
    'mkv-complete-hls-mpegts-v6:video-encode:audio-transcode:subtitles-webvtt-0:target-2',
  );

  const requestShapedReplay = {
    ...trained,
    videoMode: undefined,
    hlsTargetSeconds: undefined,
    inputPump: null,
    codecProfile: { ...locator.codecProfileSnapshot, mkvCompleteHlsCacheProof: locator.envelope },
  };
  assert.equal(
    h.verifyGenericCompleteCache(requestShapedReplay, issuedAtMs + 1_000).eligible,
    true,
    'a signed complete graph must not depend on mutable live-session target state',
  );
});

test('generic complete-cache locator binds the exact multi-audio HLS topology', () => {
  const h = loadFastStartHarness();
  const issuedAtMs = Date.parse('2026-08-17T12:45:00.000Z');
  const trained = proofSession(h, {
    codecProfileSource: 'request',
    mode: 'remux',
    videoMode: 'encode',
    testAudioMode: 'transcode',
    audioStreamIndex: 2,
    hlsTargetSeconds: 2,
    inputPump: { completed: true },
    codecProfile: {
      audioCodec: 'aac',
      audioProfile: 'LC',
      audioChannels: 2,
      audioTracks: [
        {
          index: 1, codec: 'aac', profile: 'LC', channels: 2,
          sampleRate: 48_000, channelLayout: 'stereo', language: 'fra',
          title: 'Francais', default: true,
        },
        {
          index: 2, codec: 'eac3', profile: '', channels: 6,
          sampleRate: 48_000, channelLayout: '5.1', language: 'eng',
          title: 'English 5.1', default: false,
        },
      ],
    },
  });
  const locator = h.buildCompleteCacheLocator(trained, issuedAtMs);
  assert.ok(locator?.envelope);
  assert.equal(
    locator.payload.pipelineBuild,
    'mkv-complete-hls-mpegts-v6:video-encode:audio-multi-aac-2:subtitles-webvtt-0:target-2',
  );

  const replay = {
    ...trained,
    // The pre-provider cache lookup is constructed directly from the request
    // and has no live-session HLS target yet.
    hlsTargetSeconds: undefined,
    inputPump: null,
    codecProfile: { ...locator.codecProfileSnapshot, mkvCompleteHlsCacheProof: locator.envelope },
  };
  assert.equal(h.verifyGenericCompleteCache(replay, issuedAtMs + 1_000).eligible, true);
  assert.equal(h.verifyGenericCompleteCache({
    ...replay,
    audioStreamIndex: 1,
  }, issuedAtMs + 1_000).reason, 'cache-proof-profile-mismatch');
  assert.equal(h.verifyGenericCompleteCache({
    ...replay,
    codecProfile: {
      ...replay.codecProfile,
      audioTracks: replay.codecProfile.audioTracks.map((track, index) => (
        index === 1 ? { ...track, title: 'Different label' } : track
      )),
    },
  }, issuedAtMs + 1_000).reason, 'cache-proof-profile-mismatch');
});

test('complete-cache promotion waits for both drained media and the final enriched profile', async () => {
  const calls = [];
  const schedule = loadCompleteCachePromotionBarrierHarness(async (session) => {
    calls.push(session.codecProfile.videoCodec);
    return { status: 'published' };
  });

  const mediaFirst = {
    id: 'media-first',
    assetSource: 'session-output',
    codecProfile: { videoCodec: 'hevc' },
    completeHlsCachePromotionPromise: null,
    completeHlsCacheMediaReady: true,
    completeHlsCacheProfileReady: false,
  };
  assert.equal(schedule(mediaFirst), null);
  mediaFirst.codecProfile = { videoCodec: 'hevc-enriched' };
  mediaFirst.completeHlsCacheProfileReady = true;
  const firstPromise = schedule(mediaFirst);
  assert.equal(schedule(mediaFirst), firstPromise, 'promotion must remain idempotent');
  await firstPromise;

  const profileFirst = {
    id: 'profile-first',
    assetSource: 'session-output',
    codecProfile: { videoCodec: 'h264-enriched' },
    completeHlsCachePromotionPromise: null,
    completeHlsCacheMediaReady: false,
    completeHlsCacheProfileReady: true,
  };
  assert.equal(schedule(profileFirst), null);
  profileFirst.completeHlsCacheMediaReady = true;
  await schedule(profileFirst);

  assert.deepEqual(calls, ['hevc-enriched', 'h264-enriched']);
  assert.match(GATEWAY, /completeHlsCacheProfileReady = true;[\s\S]{0,160}scheduleMkvCompleteHlsCachePromotion\(session\)/);
  const ffmpegBlock = between(GATEWAY, 'function startFfmpeg(', '\nfunction seekArgsForSession(');
  const closeAt = ffmpegBlock.indexOf("child.on('close', () => {");
  const graphFinalizationAt = ffmpegBlock.indexOf('finalizeSessionExactHlsTrackGraph(session)', closeAt);
  const mediaReadyAt = ffmpegBlock.indexOf('session.completeHlsCacheMediaReady = true;', graphFinalizationAt);
  const promotionAt = ffmpegBlock.indexOf('scheduleMkvCompleteHlsCachePromotion(session)', mediaReadyAt);
  assert.ok(closeAt >= 0, 'cache publication must be gated by FFmpeg close');
  assert.ok(graphFinalizationAt > closeAt, 'the exact track graph must finalize after FFmpeg close');
  assert.ok(mediaReadyAt > graphFinalizationAt, 'media becomes cache-ready only after exact graph finalization');
  assert.ok(promotionAt > mediaReadyAt, 'promotion starts only after the immutable graph is ready');
});

test('complete-cache continuation revokes playback, keeps the same owners, and reports one finalized proof', async () => {
  const callbackRequests = [];
  const harness = loadCompleteCacheContinuationHarness({
    fetch: async (url, options) => {
      callbackRequests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  const ffmpeg = { exitCode: null, signalCode: null };
  const inputPump = { completed: false };
  const session = {
    id: '30000000-0000-4000-8000-000000000001',
    playbackSessionId: '20000000-0000-4000-8000-000000000001',
    accessToken: 'browser-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    assetSource: 'session-output',
    completeHlsCacheProfileReady: true,
    completeHlsCacheMediaReady: false,
    mkvCompleteHlsCacheProofFinalized: false,
    vodInputStrongValidator: { type: 'etag-sha256', digest: 'a'.repeat(64) },
    vodInputEffectiveUrlSha256: 'b'.repeat(64),
    ffmpeg,
    inputPump,
    codecProfile: { container: 'matroska,webm', videoCodec: 'hevc' },
  };

  const started = harness.start(session, Date.now());
  assert.equal(started.started, true);
  assert.equal(session.status, 'background-cache');
  assert.equal(session.accessToken, 'rotated-private-token');
  assert.equal(session.ffmpeg, ffmpeg, 'detach must retain the exact FFmpeg owner');
  assert.equal(session.inputPump, inputPump, 'detach must retain the exact provider pump');
  assert.equal(callbackRequests.length, 0, 'no callback may run before clean EOF');
  assert.equal(harness.stats.continuationsStarted, 1);
  assert.equal(harness.timers.length, 1);
  assert.match(
    between(GATEWAY, 'function requirePlaybackToken(', '\nfunction cors('),
    /backgroundCacheContinuation === true[\s\S]*status\(410\)/,
    'all detached browser URLs must be terminal before token evaluation',
  );

  inputPump.completed = true;
  session.completeHlsCacheFfmpegCompletedCleanly = true;
  session.completeHlsCacheMediaReady = true;
  const completion = harness.finish(session);
  assert.equal(harness.finish(session), completion, 'completion must be idempotent');
  assert.equal(await completion, true);
  assert.equal(callbackRequests.length, 1);
  assert.equal(callbackRequests[0].url, 'http://edge.internal/norva-playback/complete-cache-callback');
  assert.equal(callbackRequests[0].options.headers.Authorization, 'Bearer gateway-token');
  const callbackBody = JSON.parse(callbackRequests[0].options.body);
  assert.deepEqual(callbackBody, {
    protocol: 1,
    playbackSessionId: session.playbackSessionId,
    gatewaySessionId: session.id,
    status: 'completed',
    finalCodecProfile: session.codecProfile,
  });
  assert.equal(JSON.stringify(callbackBody).includes('http://provider'), false);
  assert.equal(session.testStopReason, 'background-completed');
  assert.equal(session.backgroundCacheContinuationProviderDrained, true);
  assert.equal(session.status, 'background-callback');
  assert.equal(harness.stats.continuationsCompleted, 1);
  assert.equal(harness.stats.continuationCallbackFailures, 0);

  const callbackFailure = loadCompleteCacheContinuationHarness({
    fetch: async () => ({ ok: false, status: 422 }),
  });
  const callbackFailureSession = {
    ...session,
    id: '30000000-0000-4000-8000-000000000003',
    backgroundCacheContinuation: false,
    backgroundCacheContinuationPromise: null,
    backgroundCacheContinuationOutcome: null,
    backgroundCacheContinuationProviderDrained: false,
    stoppingPromise: null,
    mkvCompleteHlsCacheProofFinalized: false,
    completeHlsCacheMediaReady: false,
    completeHlsCacheFfmpegCompletedCleanly: false,
    codecProfile: { container: 'matroska,webm', videoCodec: 'hevc' },
  };
  assert.equal(callbackFailure.start(callbackFailureSession, Date.now()).started, true);
  callbackFailureSession.inputPump.completed = true;
  callbackFailureSession.completeHlsCacheMediaReady = true;
  callbackFailureSession.completeHlsCacheFfmpegCompletedCleanly = true;
  assert.equal(await callbackFailure.finish(callbackFailureSession), true);
  assert.equal(callbackFailureSession.backgroundCacheContinuationProviderDrained, true);
  assert.equal(callbackFailureSession.testStopReason, 'background-completed');
  assert.equal(callbackFailure.stats.continuationsCompleted, 1);
  assert.equal(callbackFailure.stats.continuationCallbackFailures, 1);

  const timedOut = loadCompleteCacheContinuationHarness();
  const timedOutSession = {
    ...session,
    id: '30000000-0000-4000-8000-000000000004',
    backgroundCacheContinuation: false,
    backgroundCacheContinuationPromise: null,
    backgroundCacheContinuationOutcome: null,
    backgroundCacheContinuationProviderDrained: false,
    stoppingPromise: null,
    mkvCompleteHlsCacheProofFinalized: false,
    completeHlsCacheMediaReady: false,
    completeHlsCacheFfmpegCompletedCleanly: false,
    codecProfile: { container: 'matroska,webm', videoCodec: 'hevc' },
  };
  assert.equal(timedOut.start(timedOutSession, Date.now()).started, true);
  timedOut.timers[0].callback();
  await Promise.resolve();
  assert.equal(timedOutSession.backgroundCacheContinuationOutcome, 'timeout');
  assert.equal(timedOutSession.testStopReason, 'background-timeout');
  assert.equal(timedOut.stats.continuationsTimedOut, 1);
  assert.equal(timedOut.stats.continuationsCompleted, 0);

  const weakValidator = {
    ...session,
    id: '30000000-0000-4000-8000-000000000002',
    backgroundCacheContinuation: false,
    backgroundCacheContinuationPromise: null,
    backgroundCacheContinuationOutcome: null,
    stoppingPromise: null,
    mkvCompleteHlsCacheProofFinalized: false,
    vodInputStrongValidator: { type: 'last-modified-sha256', digest: 'c'.repeat(64) },
  };
  assert.equal(harness.assess(weakValidator).reason, 'strong-validator-required');
});

test('a viewer preempts and drains a detached cache continuation before provider startup may continue', async () => {
  const background = {
    id: 'background-session',
    sourceUrl: 'https://provider.invalid/movie/user/pass/title.mkv',
    providerSlotKey: 'account:shared',
    backgroundCacheContinuation: true,
    backgroundCacheContinuationProviderDrained: false,
    stoppingPromise: null,
  };
  const drainedCallbackOnly = {
    ...background,
    id: 'background-callback-only',
    backgroundCacheContinuationProviderDrained: true,
  };
  const sessions = new Map([
    [background.id, background],
    [drainedCallbackOnly.id, drainedCallbackOnly],
  ]);
  const calls = [];
  let releaseDrain;
  const drained = new Promise((resolve) => { releaseDrain = resolve; });
  const preempt = loadCompleteCachePreemptionHarness(sessions, async (session, options) => {
    calls.push({ session, options });
    await drained;
  });
  let settled = false;
  const preemption = preempt('account:shared').then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.reason, 'viewer-preempted');
  assert.equal(settled, false, 'the caller must still be waiting for provider drain');
  releaseDrain();
  assert.equal(await preemption, 1);
  assert.equal(settled, true);
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
  const ffprobeFiveFlags = await scriptedAnalyzerResult(
    VALID_PACKET_ANALYZER_OUTPUT
      .replaceAll('flags=K__', 'flags=K_')
      .replaceAll('flags=___', 'flags=__'),
    VALID_IDR_ANALYZER_OUTPUT,
  );
  assert.equal(
    ffprobeFiveFlags.closedGopIdrVerified,
    true,
    'FFprobe 5.x emits two-column packet flags and must remain compatible',
  );
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

  await t.test('accepts the exact private-canary H264 AAC fixture graph', async () => {
    const canaryFile = path.join(tempRoot, 'private-canary-h264-aac.mkv');
    const created = runMediaTool(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', '14', '-map', '0:0', '-map', '1:0',
      '-vf', 'format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level:v', '4.0',
      '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0',
      '-x264-params', 'open-gop=0:keyint=60:min-keyint=60:scenecut=0:bframes=0',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '160k',
      '-f', 'matroska', '-y', canaryFile,
    ]);
    assert.equal(created.status, 0, created.stderr || 'failed to create private-canary fixture');
    const canaryBytes = fs.readFileSync(canaryFile);
    const canaryMetrics = await analyzeFixtureBytes(harness, canaryBytes, {
      codecProfile: exactProfile({
        fileSizeBytes: canaryBytes.length,
        durationSeconds: 14,
        videoWidth: 1280,
        videoHeight: 720,
      }),
    });
    assert.ok(canaryMetrics, analyzerFailureSummary(harness.lastAnalyzer));
    assert.equal(canaryMetrics.closedGopIdrVerified, true);
    assert.equal(canaryMetrics.idrCount, canaryMetrics.keyframeCount);
    assert.ok(Math.abs(canaryMetrics.coverageSeconds - 14) <= 2);
  });

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

test('startup policy protocol 2 shortens the buffer for measured copy video and never exposes proof', () => {
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

test('startup policy protocol 2 admits only a measured VAAPI video transcode above 2x', () => {
  const h = loadFastStartHarness({
    VIDEO_ENCODER_CONFIG: { backend: 'vaapi' },
    VIDEO_ENCODER_PREFLIGHT: { ready: true },
  });
  const session = proofSession(h);
  session.videoMode = 'encode';
  session.testAudioMode = 'encode';
  session.startupTimings = {
    videoEncoder: 'vaapi',
    playlistBufferSeconds: 12,
    ffmpegReadyMs: 13_799,
    sustainedMediaProductionRateX: 2.18,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(h.policy(session))), {
    protocol: 2,
    eligible: true,
    pipeline: 'video-transcode',
    targetBufferSeconds: 6,
    minimumEncodeRateX: 2,
    observedEncodeRateX: 2.18,
    reason: 'vaapi-transcode-ready',
  });

  delete session.startupTimings.sustainedMediaProductionRateX;
  session.startupTimings.playlistBufferSeconds = 10;
  session.startupTimings.ffmpegReadyMs = 6_000;
  assert.deepEqual(JSON.parse(JSON.stringify(h.policy(session))), {
    protocol: 2,
    eligible: false,
    pipeline: 'video-transcode',
    targetBufferSeconds: null,
    minimumEncodeRateX: 2,
    observedEncodeRateX: 1.667,
    reason: 'encode-rate-below-minimum',
  });

  session.startupTimings = {
    videoEncoder: 'software',
    playlistBufferSeconds: 10,
    ffmpegReadyMs: 500,
  };
  assert.equal(h.policy(session).eligible, false);
});

test('VAAPI finite MKV readiness uses three two-second segments without weakening multi-audio proof', () => {
  const h = loadFastStartHarness({
    VIDEO_ENCODER_CONFIG: { backend: 'vaapi' },
    VIDEO_ENCODER_PREFLIGHT: { ready: true },
  });
  const singleAudio = {
    videoMode: 'encode',
    hlsTargetSeconds: 4,
    minHlsStartupBufferSeconds: 10,
    minHlsStartupSegments: 3,
    startupTimings: {},
  };
  assert.equal(h.applyVaapiReadiness(singleAudio), true);
  assert.equal(singleAudio.hlsTargetSeconds, 2);
  assert.equal(singleAudio.minHlsStartupBufferSeconds, 6);
  assert.equal(singleAudio.minHlsStartupSegments, 3);
  assert.equal(singleAudio.startupTimings.vaapiFastReadiness, true);

  const multiAudio = {
    videoMode: 'encode',
    hlsTargetSeconds: 2,
    minHlsStartupBufferSeconds: 20,
    minHlsStartupSegments: 3,
    multiAudioHls: { enabled: true },
    startupTimings: {},
  };
  assert.equal(h.applyVaapiReadiness(multiAudio), true);
  assert.equal(multiAudio.hlsTargetSeconds, 2);
  assert.equal(multiAudio.minHlsStartupBufferSeconds, 20);
  assert.equal(multiAudio.minHlsStartupSegments, 3);
});

test('an admitted replay starts one FFmpeg graph with copied video and proof-selected audio mode', () => {
  const session = {
    id: 'fast-replay',
    sourceUrl: 'https://provider.example/movie/u/p/file.mkv',
    outputDir: path.join(os.tmpdir(), 'norva-fast-replay-args'),
    playlistPath: path.join(os.tmpdir(), 'norva-fast-replay-args', 'playlist.m3u8'),
    hlsTargetSeconds: 2,
    videoMode: 'copy',
    forceMkvH264FastStartAudioTranscode: false,
    forceExactMatroskaH264Reencode: false,
    forceAlignedMultiAudioVideoEncode: false,
    fastInputProbe: false,
    forceFullInputProbe: false,
    status: 'starting',
    logTail: '',
    startupTimings: {},
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
    exactSubtitleHlsEnabled: () => false,
    inputProbeArgsForSession: () => [],
    shouldCopyAudio: (value) => value.forceMkvH264FastStartAudioTranscode !== true,
    audioArgsForSession: (_value, copyAudio) => copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2'],
    audioMapForSession: () => '0:1',
    normalizeAudioStreamIndex: (value) => Number(value),
    videoModeForSession: (value) => value.videoMode,
    vaapiHardwareDecodeCodecForSession: () => null,
    videoEncoderInputArgs,
    videoEncoderOutputArgs,
    VIDEO_ENCODER_CONFIG: { backend: 'software' },
    reserveVideoEncoderAdmission: () => true,
    releaseVideoEncoderAdmission: () => {},
    isFiniteMkvVodSession: () => true,
    usesFiniteMkvSeekBroker: () => false,
    finiteMkvLinearSeekBridgePlanForSession: () => null,
    usesSourceTimestampedCopySeek: () => false,
    seekArgsForSession: () => ({ preInputSeek: [], postInputSeek: [] }),
    appendSubtitleOutputs: () => {},
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    spawn: fakeSpawn,
    FFMPEG_PATH: 'ffmpeg',
    proxyEnvFor: () => ({}),
    loopbackOnlyEnv: () => ({}),
    proxyKeyFromUrl: () => 'provider.example',
    sanitizeLog: (value) => value,
    appendLogTail: () => {},
    applyFiniteMkvSeekBrokerFailure: () => false,
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
  assert.equal(session.startupTimings.ffmpegSpawnCount, 1);
  assert.equal(capturedArgs[capturedArgs.indexOf('-map') + 1], '0:V:0?', 'replay must map the same uppercase-V stream that was attested');
  assert.equal(capturedArgs[capturedArgs.indexOf('-c:v') + 1], 'copy');
  assert.equal(capturedArgs[capturedArgs.indexOf('-c:a') + 1], 'copy');
  assert.equal(capturedArgs.includes('-profile:a'), false);
  assert.equal(capturedArgs[capturedArgs.indexOf('-hls_time') + 1], '2');
  assert.equal(capturedArgs.includes('-force_key_frames'), false, 'copy graph must not invent segment independence');
});

test('complete-cache Gateway sessions stay authenticated, bound and fail closed through every lease lifecycle', async (t) => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-complete-cache-route-'));
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }));
  const outputRoot = path.join(temporary, 'output');
  const cacheRoot = path.join(temporary, 'cache');
  const stage = path.join(temporary, 'stage');
  await fsp.mkdir(stage, { recursive: true });
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXTINF:2.000,',
    'segment-00000.ts',
    '#EXTINF:2.000,',
    'segment-00001.ts',
    '#EXTINF:2.000,',
    'segment-00002.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  await fsp.writeFile(path.join(stage, 'playlist.m3u8'), playlist);
  await fsp.writeFile(path.join(stage, 'segment-00000.ts'), Buffer.alloc(1024, 0x11));
  await fsp.writeFile(path.join(stage, 'segment-00001.ts'), Buffer.alloc(1024, 0x22));
  await fsp.writeFile(path.join(stage, 'segment-00002.ts'), Buffer.alloc(1024, 0x33));

  let providerGets = 0;
  const provider = http.createServer((req, res) => {
    if (req.method === 'GET') providerGets += 1;
    res.writeHead(404).end('provider trap reached');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const providerPort = provider.address().port;
  const sourceUrl = `http://127.0.0.1:${providerPort}/movie/user/pass/title.mkv`;
  const ownerKey = 'a1'.repeat(32);
  const providerSlotKey = `account:${crypto.createHash('sha256')
    .update(`127.0.0.1:${providerPort}\0user\0pass`).digest('hex')}`;
  const h = loadFastStartHarness();
  const authorityFor = (itemId) => {
    const playbackIdentity = { sourceId: 'source-1', itemType: 'movie', itemId, variantId: '' };
    const trained = proofSession(h, {
      id: `trained-${itemId}`,
      sourceUrl,
      ownerKey,
      providerSlotKey,
      playbackIdentity,
      vodInputEffectiveUrlSha256: crypto.createHash('sha256').update(`effective-${itemId}`).digest('hex'),
      vodInputStrongValidator: {
        type: 'etag-sha256',
        digest: crypto.createHash('sha256').update(`"etag-${itemId}"`).digest('hex'),
      },
    });
    const envelope = h.finalize(trained, Date.now());
    assert.equal(typeof envelope, 'string');
    const proof = decodeEnvelope(envelope);
    return {
      playbackIdentity,
      trained,
      envelope,
      binding: {
        tenantScopeSha256: proof.tenantScopeSha256,
        providerScopeSha256: proof.providerScopeSha256,
        itemScopeSha256: proof.itemScopeSha256,
        sourceUrlSha256: proof.sourceUrlSha256,
        effectiveUrlSha256: proof.effectiveUrlSha256,
        strongEtagSha256: proof.validator.digest,
        profileFingerprint: proof.profileFingerprint,
        fileSizeBytes: proof.fileSizeBytes,
        pipelineBuild: 'mkv-complete-hls-mpegts-v6:video-copy:audio-copy',
        proofBuild: proof.build,
      },
    };
  };
  const cachedAuthority = authorityFor('movie-cached');
  const mismatchedAuthority = authorityFor('movie-not-cached');
  const abortedAuthority = authorityFor('movie-aborted');
  const cacheKey = '34'.repeat(32);
  const cache = new CompleteMkvHlsCache({
    root: cacheRoot,
    manifestHmacKey: cacheKey,
    maxBytes: 64 * 1024 * 1024,
    minFreeBytes: 0,
    ttlMs: 60_000,
    maxEntryBytes: 16 * 1024 * 1024,
    maxFiles: 2_000,
    statfs: async () => ({ availableBytes: 1024 * 1024 * 1024 }),
  });
  const published = await cache.publishCompleteVerified({
    binding: cachedAuthority.binding,
    sourceDirectory: stage,
    rootPlaylist: 'playlist.m3u8',
    files: ['playlist.m3u8', 'segment-00000.ts', 'segment-00001.ts', 'segment-00002.ts'],
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  });
  const hevcProfile = exactProfile({
    videoCodec: 'hevc',
    videoProfile: 'Main',
    videoPixelFormat: 'yuv420p10le',
    audioCodec: 'eac3',
    audioProfile: '',
    audioChannels: 6,
    audioChannelLayout: '5.1',
    audioTracks: [{
      index: 1, codec: 'eac3', profile: '', channels: 6,
      sampleRate: 48_000, channelLayout: '5.1', default: true,
    }],
  });
  const hevcPlaybackIdentity = {
    sourceId: 'source-1', itemType: 'movie', itemId: 'movie-hevc-cached', variantId: '',
  };
  const hevcHarness = loadFastStartHarness({
    MKV_COMPLETE_HLS_CACHE_LOCATOR_KEY: Buffer.from(cacheKey, 'hex'),
  });
  const hevcTrained = proofSession(hevcHarness, {
    sourceUrl,
    ownerKey,
    providerSlotKey,
    playbackIdentity: hevcPlaybackIdentity,
    mode: 'remux',
    videoMode: 'encode',
    testAudioMode: 'transcode',
    audioStreamIndex: 1,
    audioMode: 'transcode',
    clientAudioPassthrough: false,
    hlsTargetSeconds: 4,
    inputPump: { completed: true },
    vodInputEffectiveUrlSha256: crypto.createHash('sha256').update('effective-hevc-cached').digest('hex'),
    vodInputStrongValidator: {
      type: 'etag-sha256',
      digest: crypto.createHash('sha256').update('"etag-hevc-cached"').digest('hex'),
    },
    codecProfile: hevcProfile,
  });
  const hevcLocator = hevcHarness.buildCompleteCacheLocator(hevcTrained, Date.now());
  assert.ok(hevcLocator?.envelope);
  const hevcCacheBinding = JSON.parse(JSON.stringify(hevcLocator.binding));
  assert.equal((await cache.publishCompleteVerified({
    binding: hevcCacheBinding,
    sourceDirectory: stage,
    rootPlaylist: 'playlist.m3u8',
    files: ['playlist.m3u8', 'segment-00000.ts', 'segment-00001.ts', 'segment-00002.ts'],
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  })).status, 'published');

  // A graph with many authenticated child playlists makes cache acquisition
  // intentionally asynchronous. The abort case can therefore observe that the
  // POST handler has entered its startup lock before closing the request, without
  // adding a production-only delay hook or relying on a fixed race window.
  const abortStage = path.join(temporary, 'abort-stage');
  await fsp.mkdir(abortStage, { recursive: true });
  const abortRoot = ['#EXTM3U', '#EXT-X-VERSION:3'];
  const abortFiles = ['master.m3u8', 'shared.ts'];
  const childPlaylistCount = 240;
  await fsp.writeFile(path.join(abortStage, 'shared.ts'), Buffer.alloc(188, 0x47));
  for (let index = 0; index < childPlaylistCount; index += 1) {
    const name = `media-${String(index).padStart(4, '0')}.m3u8`;
    abortRoot.push(`#EXT-X-STREAM-INF:BANDWIDTH=${100_000 + index}`, name);
    abortFiles.push(name);
    await fsp.writeFile(path.join(abortStage, name), [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXTINF:2.000,',
      'shared.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'));
  }
  await fsp.writeFile(path.join(abortStage, 'master.m3u8'), `${abortRoot.join('\n')}\n`);
  await cache.publishCompleteVerified({
    binding: abortedAuthority.binding,
    sourceDirectory: abortStage,
    rootPlaylist: 'master.m3u8',
    files: abortFiles,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  });

  const gatewayToken = 'gateway-cache-integration-token';
  const portReservation = http.createServer();
  await new Promise((resolve) => portReservation.listen(0, '127.0.0.1', resolve));
  const gatewayPort = portReservation.address().port;
  await new Promise((resolve) => portReservation.close(resolve));
  const child = spawn(process.execPath, [path.join(ROOT, 'services/media-gateway/src/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      OUTPUT_DIR: outputRoot,
      GATEWAY_TOKEN: gatewayToken,
      ACCOUNT_ACTIVITY_REPORT_MS: '0',
      MKV_H264_FAST_START_PROOF_HMAC_KEY: CURRENT_KEY.toString('hex'),
      MKV_COMPLETE_HLS_CACHE_ENABLED: 'true',
      MKV_CACHE_COORDINATION_MODE: 'local',
      MKV_CACHE_SINGLE_INSTANCE_ATTESTED: 'true',
      MKV_COMPLETE_HLS_CACHE_ROOT: cacheRoot,
      MKV_COMPLETE_HLS_CACHE_MANIFEST_HMAC_KEY: cacheKey,
      MKV_COMPLETE_HLS_CACHE_MAX_BYTES: String(64 * 1024 * 1024),
      MKV_COMPLETE_HLS_CACHE_MIN_FREE_BYTES: '0',
      MKV_COMPLETE_HLS_CACHE_MAX_ENTRY_BYTES: String(16 * 1024 * 1024),
      FFMPEG_PATH: path.join(temporary, 'ffmpeg-must-not-spawn'),
      NODE_PATH: gatewayChildNodePath(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2_000).unref();
    });
  });
  const base = `http://127.0.0.1:${gatewayPort}`;
  const readHealth = async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const waitForHealth = async (predicate, label, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await readHealth();
        if (predicate(last)) return last;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`${label}; last health=${JSON.stringify(last)}\n${output.join('')}`);
  };
  let health = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) { health = await response.json(); break; }
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(health, output.join(''));
  assert.equal(health.mkvCompleteHlsCache.enabled, true, JSON.stringify(health.mkvCompleteHlsCache));

  const sessionBody = (authority, overrides = {}) => ({
      sourceUrl,
      playbackSessionId: `edge-${authority.playbackIdentity.itemId}`,
      ownerKey,
      mode: 'remux',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      playbackHint: { streamType: 'movie', container: 'mkv' },
      playbackIdentity: authority.playbackIdentity,
      codecProfile: { ...authority.trained.codecProfile, mkvH264FastStartProof: authority.envelope },
      audioCodec: 'aac',
      audioProfile: 'LC',
      audioChannels: 2,
      clientAudioPassthrough: true,
      seekOffset: 0,
      ...overrides,
  });
  const createSession = async (authority, overrides = {}) => {
    const response = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionBody(authority, overrides)),
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) {}
    return { response, payload, text };
  };

  const first = await createSession(cachedAuthority);
  const created = first.payload;
  assert.equal(first.response.status, 201, `${first.text}\n${output.join('')}`);
  assert.equal(created.videoMode, 'copy');
  assert.equal(created.audioMode, 'copy');
  assert.equal(created.videoModeReason, 'complete_hls_cache_hit');
  assert.equal(created.startupTimings.completeHlsCacheHit, true);
  assert.equal(created.startupTimings.providerGetCount, 0);
  assert.equal(created.startupTimings.ffmpegSpawnCount, 0);
  assert.equal(created.startupTimings.stoppedConflictingSessions, 0);
  assert.equal(created.startupTimings.globalBackgroundExtractionPreemptions, 0);
  assert.equal(created.startupTimings.globalBackgroundWhisperPreemptions, 0);
  assert.equal(created.startupTimings.globalBackgroundCpuPreemptions, 0);
  assert.equal(providerGets, 0);

  const unauthorized = await fetch(created.hlsUrl.replace(/token=[^&]+/, 'token=wrong'));
  assert.equal(unauthorized.status, 401);
  const playlistResponse = await fetch(created.hlsUrl);
  assert.equal(playlistResponse.status, 200);
  const servedPlaylist = await playlistResponse.text();
  assert.match(servedPlaylist, /segment-00000\.ts\?token=/);
  const segmentUrl = new URL(servedPlaylist.split('\n').find((line) => line.startsWith('segment-00000.ts')), created.hlsUrl);
  const segmentResponse = await fetch(segmentUrl);
  assert.equal(segmentResponse.status, 200);
  assert.equal((await segmentResponse.arrayBuffer()).byteLength, 1024);
  assert.equal(providerGets, 0);

  const deleteResponse = await fetch(`${base}/sessions/${created.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${gatewayToken}` },
  });
  assert.equal(deleteResponse.status, 200);
  const after = await readHealth();
  assert.equal(after.mkvCompleteHlsCache.stats.activeLeases, 0);
  assert.equal(providerGets, 0);

  const cachedSeekResponse = await createSession(cachedAuthority, {
    playbackSessionId: 'edge-movie-cached-seek',
    seekOffset: 4,
  });
  assert.equal(cachedSeekResponse.response.status, 201, cachedSeekResponse.text);
  assert.equal(cachedSeekResponse.payload.videoModeReason, 'complete_hls_cache_hit');
  assert.equal(cachedSeekResponse.payload.requestedSeekOffset, 4);
  assert.equal(cachedSeekResponse.payload.actualStartOffset, 0);
  assert.equal(cachedSeekResponse.payload.localSeekTarget, 4);
  assert.equal(cachedSeekResponse.payload.sourceTimestamps, true);
  assert.equal(cachedSeekResponse.payload.startupTimings.completeHlsCacheLocalSeek, true);
  assert.equal(cachedSeekResponse.payload.startupTimings.providerGetCount, 0);
  assert.equal(cachedSeekResponse.payload.startupTimings.ffmpegSpawnCount, 0);
  assert.equal(providerGets, 0, 'cached seek must remain zero-provider');
  const cachedSeekDelete = await fetch(`${base}/sessions/${cachedSeekResponse.payload.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${gatewayToken}` },
  });
  assert.equal(cachedSeekDelete.status, 200);
  assert.equal((await readHealth()).mkvCompleteHlsCache.stats.activeLeases, 0);

  const beforeBypass = await readHealth();
  const providerBeforeBypass = providerGets;
  const bypass = await createSession(cachedAuthority, {
    playbackSessionId: 'edge-movie-cached-bypass',
    completeHlsCachePolicy: 'bypass',
  });
  assert.notEqual(bypass.response.status, 201, bypass.text);
  assert.ok(providerGets > providerBeforeBypass,
    'an authenticated cache bypass must use the provider even when a valid entry exists');
  const afterBypass = await readHealth();
  assert.equal(afterBypass.mkvCompleteHlsCache.stats.hits, beforeBypass.mkvCompleteHlsCache.stats.hits);
  assert.equal(afterBypass.mkvCompleteHlsCache.stats.misses, beforeBypass.mkvCompleteHlsCache.stats.misses);
  assert.equal(afterBypass.mkvCompleteHlsCache.stats.invalidProofs, beforeBypass.mkvCompleteHlsCache.stats.invalidProofs);
  assert.equal(afterBypass.mkvCompleteHlsCache.stats.activeLeases, 0);

  const providerBeforeHevc = providerGets;
  const hevcResponse = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceUrl,
      playbackSessionId: 'edge-movie-hevc-cached',
      ownerKey,
      mode: 'remux',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      playbackHint: { streamType: 'movie', container: 'mkv' },
      playbackIdentity: hevcPlaybackIdentity,
      codecProfile: { ...hevcProfile, mkvCompleteHlsCacheProof: hevcLocator.envelope },
      audioCodec: 'eac3',
      audioChannels: 6,
      seekOffset: 0,
    }),
  });
  const hevcCreatedText = await hevcResponse.text();
  const hevcCreated = JSON.parse(hevcCreatedText);
  assert.equal(hevcResponse.status, 201, `${hevcCreatedText}\n${output.join('')}`);
  assert.equal(hevcCreated.videoModeReason, 'complete_hls_cache_hit');
  assert.equal(hevcCreated.startupPolicy?.reason, 'complete-hls-cache-hit');
  assert.equal(hevcCreated.startupTimings?.providerGetCount, 0);
  assert.equal(hevcCreated.startupTimings?.ffmpegSpawnCount, 0);
  assert.doesNotMatch(JSON.stringify(hevcCreated), /mkvCompleteHlsCacheProof|mkv_complete_hls_cache_proof/);
  assert.equal(providerGets, providerBeforeHevc, 'prepared HEVC cache hit must not rediscover the provider');
  const hevcDelete = await fetch(`${base}/sessions/${hevcCreated.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${gatewayToken}` },
  });
  assert.equal(hevcDelete.status, 200);
  assert.equal((await readHealth()).mkvCompleteHlsCache.stats.activeLeases, 0);

  const cacheEntryRoot = path.join(cacheRoot, 'entries', published.key.slice(0, 2), published.key);
  const cachedManifestPath = path.join(cacheEntryRoot, 'manifest.auth.json');
  const cachedManifest = JSON.parse(await fsp.readFile(cachedManifestPath, 'utf8'));
  cachedManifest.mac = `${cachedManifest.mac.slice(0, -1)}${cachedManifest.mac.endsWith('A') ? 'B' : 'A'}`;
  await fsp.writeFile(cachedManifestPath, JSON.stringify(cachedManifest));
  const providerBeforeInvalidManifest = providerGets;
  const invalidManifest = await createSession(cachedAuthority);
  assert.equal(invalidManifest.response.status, 503, invalidManifest.text);
  assert.equal(invalidManifest.payload?.code, 'COMPLETE_HLS_CACHE_INVALID');
  assert.equal(providerGets, providerBeforeInvalidManifest,
    'an authenticated cache manifest failure must terminate before any provider fallback');
  assert.equal((await cache.publishCompleteVerified({
    binding: cachedAuthority.binding,
    sourceDirectory: stage,
    rootPlaylist: 'playlist.m3u8',
    files: ['playlist.m3u8', 'segment-00000.ts', 'segment-00001.ts', 'segment-00002.ts'],
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  })).status, 'published');

  const missesBefore = after.mkvCompleteHlsCache.stats.misses;
  const providerBeforeMismatch = providerGets;
  const mismatch = await createSession(mismatchedAuthority);
  assert.notEqual(mismatch.response.status, 201, mismatch.text);
  assert.ok(providerGets > providerBeforeMismatch, 'a valid binding without a cache entry must reach the provider');
  const afterMismatch = await readHealth();
  assert.ok(afterMismatch.mkvCompleteHlsCache.stats.misses > missesBefore);
  assert.equal(afterMismatch.mkvCompleteHlsCache.stats.activeLeases, 0);

  const corrupt = await createSession(cachedAuthority);
  assert.equal(corrupt.response.status, 201, `${corrupt.text}\n${output.join('')}`);
  const corruptPlaylistResponse = await fetch(corrupt.payload.hlsUrl);
  const corruptPlaylist = await corruptPlaylistResponse.text();
  const corruptSegmentUrl = new URL(
    corruptPlaylist.split('\n').find((line) => line.startsWith('segment-00000.ts')),
    corrupt.payload.hlsUrl,
  );
  const cachedSegment = path.join(cacheEntryRoot, 'segment-00000.ts');
  await fsp.writeFile(cachedSegment, Buffer.alloc(1024, 0x7e));
  const corruptionsBefore = (await readHealth()).mkvCompleteHlsCache.stats.corruptions;
  const providerBeforeCorruption = providerGets;
  const corruptSegmentResponse = await fetch(corruptSegmentUrl);
  assert.equal(corruptSegmentResponse.status, 502);
  const afterCorruption = await waitForHealth((value) => (
    value.mkvCompleteHlsCache.stats.activeLeases === 0
      && value.mkvCompleteHlsCache.stats.corruptions > corruptionsBefore
  ), 'corrupt cached asset did not terminate and release its lease');
  assert.equal(providerGets, providerBeforeCorruption, 'cache corruption must never fall back to the provider');
  assert.equal((await fetch(`${base}/sessions/${corrupt.payload.id}`, {
    headers: { Authorization: `Bearer ${gatewayToken}` },
  })).status, 404);
  assert.equal(afterCorruption.mkvCompleteHlsCache.stats.activeLeases, 0);
  const providerBeforeQuarantinedReplay = providerGets;
  const quarantinedReplay = await createSession(cachedAuthority);
  assert.notEqual(quarantinedReplay.response.status, 201, quarantinedReplay.text);
  assert.ok(providerGets > providerBeforeQuarantinedReplay,
    'a quarantined entry must be removed so the next request is a real miss, never the same poisoned hit');
  assert.equal((await cache.publishCompleteVerified({
    binding: cachedAuthority.binding,
    sourceDirectory: stage,
    rootPlaylist: 'playlist.m3u8',
    files: ['playlist.m3u8', 'segment-00000.ts', 'segment-00001.ts', 'segment-00002.ts'],
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  })).status, 'published');

  const expiring = await createSession(cachedAuthority, {
    expiresAt: new Date(Date.now() + 200).toISOString(),
  });
  assert.equal(expiring.response.status, 201, `${expiring.text}\n${output.join('')}`);
  const waitUntilExpiry = Math.max(0, Date.parse(expiring.payload.expiresAt) - Date.now() + 5);
  await new Promise((resolve) => setTimeout(resolve, waitUntilExpiry));
  const expiredPlaylist = await fetch(expiring.payload.hlsUrl);
  assert.equal(expiredPlaylist.status, 410);
  await waitForHealth((value) => value.mkvCompleteHlsCache.stats.activeLeases === 0,
    'expired cache session did not release its lease');
  assert.equal((await fetch(`${base}/sessions/${expiring.payload.id}`, {
    headers: { Authorization: `Bearer ${gatewayToken}` },
  })).status, 404);

  const abortBaseline = await readHealth();
  const providerBeforeAbort = providerGets;
  const abortBody = JSON.stringify(sessionBody(abortedAuthority));
  let abortResponseStatus = null;
  let abortRequest;
  const abortRequestDone = new Promise((resolve) => {
    abortRequest = http.request({
      hostname: '127.0.0.1',
      port: gatewayPort,
      path: '/sessions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(abortBody),
      },
    }, (response) => {
      abortResponseStatus = response.statusCode;
      response.resume();
      response.once('end', resolve);
    });
    abortRequest.once('error', resolve);
    abortRequest.once('close', resolve);
    abortRequest.end(abortBody);
  });
  await waitForHealth((value) => (
    value.sessionStartupStats.attempts > abortBaseline.sessionStartupStats.attempts
      && value.viewerSessionStartupLockCount > 0
  ), 'aborted create never entered the Gateway startup lock');
  abortRequest.destroy();
  await abortRequestDone;
  const afterAbort = await waitForHealth((value) => (
    value.mkvCompleteHlsCache.stats.hits > abortBaseline.mkvCompleteHlsCache.stats.hits
      && value.mkvCompleteHlsCache.stats.activeLeases === 0
      && value.viewerSessionStartupLockCount === 0
  ), 'aborted cache create did not acquire then release its pending lease');
  assert.equal(abortResponseStatus, null, 'the intentionally aborted create must not publish a response');
  assert.equal(afterAbort.sessionStartupStats.successes, abortBaseline.sessionStartupStats.successes);
  assert.equal(providerGets, providerBeforeAbort, 'aborted cache create must not reach the provider');

  const createRoute = between(GATEWAY, "app.post('/sessions'", '\n// Cross-device kill-switch');
  const cacheAcquireIndex = createRoute.indexOf('await tryAcquireMkvCompleteHlsCache(cacheLookupSession)');
  const providerReservationIndex = createRoute.indexOf('viewerStartupReservation = reserveViewerStartup()');
  const rawPreemptionIndex = createRoute.indexOf('abortRawPumps(');
  const backgroundPreemptionIndex = createRoute.indexOf('preemptBackgroundWorkGlobally(');
  const providerStopIndex = createRoute.indexOf('await stopConflictingProviderSessions(');
  assert.ok(cacheAcquireIndex >= 0);
  for (const destructiveIndex of [
    providerReservationIndex,
    rawPreemptionIndex,
    backgroundPreemptionIndex,
    providerStopIndex,
  ]) {
    assert.ok(destructiveIndex > cacheAcquireIndex,
      'authenticated complete-cache acquisition must precede every provider/background preemption');
  }
});

test('Edge authority, response redaction, original-item CAS and protocol-2 Web contract are wired fail closed', () => {
  const create = between(EDGE, 'async function createPlaybackSessionCore(', '\nasync function createPlaybackSession(');
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
  assert.match(publicSession, /mkv_complete_hls_cache_proof/);
  assert.match(cleanup, /finalCodecProfile[\s\S]*expectedItemCas/);
  assert.match(cleanup, /finalCompleteCacheProof[\s\S]*allowProofReplacement/);
  assert.doesNotMatch(cleanup, /itemOnly:\s*true/,
    'normal exit must publish the exact stream inventory to the variant for post-playback LID');
  assert.match(cleanup, /searchParams\.set\("completeCache", "continue"\)/);
  assert.match(closeAll, /finalCodecProfile[\s\S]*expectedItemCas/);
  assert.match(closeAll, /finalCompleteCacheProof[\s\S]*allowProofReplacement/);
  assert.doesNotMatch(closeAll, /itemOnly:\s*true/,
    'orphan cleanup must publish the exact stream inventory to the variant for post-playback LID');
  assert.match(EDGE, /protocol !== 2/);
  assert.match(WATCH, /Number\(policy\.protocol\) !== 2/);
  assert.match(WATCH, /protocol: 2/);
});

test('Edge runtime strips forged proofs and persists partial/EOF profiles only against the original item version', async () => {
  const edge = loadEdgeHarness();
  const proof = `e30.${'a'.repeat(43)}`;
  const cacheProof = `e30.${'b'.repeat(43)}`;
  assert.equal(edge.normalizeCodecProfile({ video_stream_index: 5 }).videoStreamIndex, 5);
  assert.equal(edge.normalizeCodecProfile({ videoStreamIndex: 1_025 }).videoStreamIndex, undefined);
  const forged = { codecProfile: {
    container: 'mkv', videoCodec: 'h264',
    mkvH264FastStartProof: proof,
    mkvCompleteHlsCacheProof: cacheProof,
  } };
  const episode = edge.bindServerMkvFastStartProof(forged, forged, false);
  assert.equal(episode.codecProfile.mkvH264FastStartProof, undefined);
  assert.equal(episode.codecProfile.mkvCompleteHlsCacheProof, undefined);
  const movie = edge.bindServerMkvFastStartProof(forged, forged, true);
  assert.equal(movie.codecProfile.mkvH264FastStartProof, proof);
  assert.equal(movie.codecProfile.mkvCompleteHlsCacheProof, cacheProof);
  assert.equal(
    edge.gatewayCodecProfileContainer({ container: 'matroska,webm' }, { container: 'mp4' }),
    'matroska,webm',
    'the current Gateway profile must win over a stale/client container hint',
  );

  const stored = {
    playback_hint: { codecProfile: { mkvH264FastStartProof: proof } },
    nested: [{ codec_profile: {
      mkv_h264_fast_start_proof: proof,
      mkv_complete_hls_cache_proof: cacheProof,
    } }],
    __norvaMkvH264FastStartItemCasV2: { id: 'internal' },
  };
  const publicValue = edge.publicPlaybackSession(stored);
  assert.equal(JSON.stringify(publicValue).includes(proof), false);
  assert.equal(JSON.stringify(publicValue).includes(cacheProof), false);
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

  const variantPatches = [];
  const variantEdge = loadEdgeHarness({
    patchActiveCatalogTitleVariants: async (_db, options) => {
      variantPatches.push(options.patch);
      return { data: [{ id: 'variant-1' }], error: null, superseded: false };
    },
  });
  const variantDb = mediaItemDb(item);
  assert.equal(await variantEdge.persistObservedCodecProfile(variantDb.db, {
    ...baseOptions,
    itemOnly: false,
    codecProfile: {
      container: 'mkv',
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioTracks: [{ index: 1, codec: 'aac', channels: 6 }],
      mkvH264FastStartProof: proof,
      mkvCompleteHlsCacheProof: cacheProof,
    },
    allowProofReplacement: true,
  }), true);
  assert.equal(variantPatches.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(variantPatches[0].codec_profile.audioTracks)),
    [{ index: 1, order: 0, codec: 'aac', channels: 6 }],
  );
  assert.equal(variantPatches[0].codec_profile.mkvH264FastStartProof, undefined);
  assert.equal(variantPatches[0].codec_profile.mkvCompleteHlsCacheProof, undefined);

  const completeCacheDb = mediaItemDb(item);
  assert.equal(await edge.persistObservedCodecProfile(completeCacheDb.db, {
    ...baseOptions,
    codecProfile: {
      container: 'mkv', videoCodec: 'hevc', mkvCompleteHlsCacheProof: cacheProof,
    },
    allowProofReplacement: true,
  }), true);
  assert.equal(
    completeCacheDb.state.patches[0].playback_hint.codecProfile.mkvCompleteHlsCacheProof,
    cacheProof,
  );

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

test('Edge complete-cache callback binds the configured Gateway route and preserves the original item CAS', async () => {
  const edge = loadEdgeHarness();
  const defaultToken = 'default-token';
  const canaryToken = 'canary-token';
  edge.setRuntimeConfig({
    mediaGatewayRouting: {
      defaultRoute: { kind: 'default', url: 'http://default.internal', token: defaultToken, gatewayId: null },
      canaryRoute: { kind: 'canary', url: 'http://canary.internal', token: canaryToken, gatewayId: 'hetzner-vaapi' },
    },
  });
  const playbackSessionId = '20000000-0000-4000-8000-000000000001';
  const gatewaySessionId = '30000000-0000-4000-8000-000000000001';
  const targetUrlHash = 'c'.repeat(64);
  const cacheProof = `e30.${'d'.repeat(43)}`;
  const gatewaySession = {
    id: '40000000-0000-4000-8000-000000000001',
    user_id: '50000000-0000-4000-8000-000000000001',
    playback_session_id: playbackSessionId,
    gateway_id: 'hetzner-vaapi',
    external_session_id: gatewaySessionId,
    status: 'expired',
  };
  const playbackSession = {
    id: playbackSessionId,
    user_id: gatewaySession.user_id,
    source_id: '60000000-0000-4000-8000-000000000001',
    item_type: 'movie',
    item_id: 'movie-1',
    target_url_hash: targetUrlHash,
    playback_hint: {
      __norvaMkvH264FastStartItemCasV2: {
        id: '70000000-0000-4000-8000-000000000001',
        updatedAt: '2026-08-17T12:00:00.000Z',
        targetUrlHash,
      },
    },
    status: 'expired',
  };
  const item = {
    id: '70000000-0000-4000-8000-000000000001',
    updated_at: '2026-08-17T12:00:00.000Z',
    metadata: {},
    playback_hint: { codecProfile: { container: 'matroska,webm', videoCodec: 'hevc' } },
  };
  const payload = {
    protocol: 1,
    playbackSessionId,
    gatewaySessionId,
    status: 'completed',
    finalCodecProfile: {
      container: 'matroska,webm',
      videoCodec: 'hevc',
      audioCodec: 'eac3',
      audioTracks: [{ index: 1, order: 0, codec: 'eac3', channels: 6 }],
      mkvCompleteHlsCacheProof: cacheProof,
    },
  };
  const request = (token, body = payload) => ({
    headers: { get: (name) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : null },
    json: async () => body,
  });

  const callbackDb = completeCacheCallbackDb({ gatewaySession, playbackSession, item });
  const first = await edge.runCompleteHlsCacheCallback(request(canaryToken), callbackDb.db);
  assert.equal(first.ok, true);
  assert.equal(first.protocol, 1);
  assert.equal(first.persisted, true);
  assert.equal(JSON.stringify(first).includes(cacheProof), false, 'callback response must never expose the proof');
  assert.equal(callbackDb.state.patches.length, 1);
  assert.equal(
    callbackDb.state.patches[0].playback_hint.codecProfile.mkvCompleteHlsCacheProof,
    cacheProof,
  );

  const duplicate = await edge.runCompleteHlsCacheCallback(request(canaryToken), callbackDb.db);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.persisted, false, 'a duplicate callback must not bypass the original CAS');
  assert.equal(callbackDb.state.patches.length, 1);

  const wrongRouteDb = completeCacheCallbackDb({ gatewaySession, playbackSession, item: { ...item } });
  await assert.rejects(
    edge.runCompleteHlsCacheCallback(request(defaultToken), wrongRouteDb.db),
    (error) => error.status === 404,
  );
  await assert.rejects(
    edge.runCompleteHlsCacheCallback(request('unconfigured-token'), wrongRouteDb.db),
    (error) => error.status === 401,
  );
  await assert.rejects(
    edge.runCompleteHlsCacheCallback(request(canaryToken, { ...payload, extra: true }), wrongRouteDb.db),
    (error) => error.status === 400,
  );
  await assert.rejects(
    edge.runCompleteHlsCacheCallback(request(canaryToken, {
      ...payload,
      finalCodecProfile: { container: 'matroska,webm', videoCodec: 'hevc' },
    }), wrongRouteDb.db),
    (error) => error.status === 422,
  );
});

test('signed video copy is active while the local HLS cache remains explicitly dark', () => {
  assert.match(GATEWAY, /const MKV_H264_FAST_START_COPY_ACTIVATION_READY = true/);
  assert.match(GATEWAY, /closed-gop-proof-unavailable/);
  assert.match(GATEWAY, /const MKV_H264_HLS_CACHE_ACTIVATION_READY = false/);
  assert.match(GATEWAY, /scope: 'local-replica'/);
  assert.doesNotMatch(
    between(GATEWAY, 'const MKV_H264_HLS_CACHE_SECRET', '\nconst MKV_COMPLETE_HLS_CACHE_PROTOCOL'),
    /GATEWAY_TOKEN/,
  );
});
