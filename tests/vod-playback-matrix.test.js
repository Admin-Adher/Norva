// VOD playback matrix + provider-busy (458) classification — regression tests for the
// "Hls is not defined" crash and the 458 → "cannot demux" → transcode-storm cascade.
//
// What is locked down here:
//   1. Every VOD container format observed in production (763k variants: mkv, mp4, m4v,
//      ts, avi, wmv, flv — plus m3u8/live) resolves to a defined playback path in the
//      routing lists of public/js/api.js. No format may fall through to "nothing".
//   2. The provider-busy classifiers actually match the codes the engine emits
//      (BLOCK_HTTP_458 / PROBE_HTTP_458 — underscore defeats \b, the original bug) and
//      ffmpeg's 458 disguise ("Server returned 4XX Client Error, but not one of ...").
//   3. server/utils/upstreamError.js classifies the ffmpeg-458 string as a RETRYABLE
//      UPSTREAM_PROVIDER_BUSY (it used to be terminal UPSTREAM_REFUSED).
//   4. hls.js is vendored locally and both app entries define the promise-based
//      window.ensureHls loader (local first, CDN fallback) — no bare CDN-only tag.
//
// Run: node --test tests/vod-playback-matrix.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── helpers: extract the live routing sets from api.js source ──────────────────
function extractSet(source, anchor) {
  const i = source.indexOf(anchor);
  assert.notStrictEqual(i, -1, `anchor not found: ${anchor}`);
  const open = source.indexOf('[', i);
  const close = source.indexOf(']', open);
  return new Set(source.slice(open + 1, close).split(',')
    .map((s) => s.replace(/['"\s]/g, '')).filter(Boolean));
}

const apiSrc = read('public/js/api.js');
const engineSet = extractSet(apiSrc, 'const ENGINE_DEMUXABLE_CONTAINERS = new Set(');

// The gateway-transcode "unsafe container" list lives inside shouldVodUseGatewayTranscode.
function extractTranscodeSet(source) {
  // The unsafe-container list is the `const unsafeContainer = [...]` array inside
  // shouldVodUseGatewayTranscode (naive first-bracket matching hits `split('?')[0]`).
  const i = source.indexOf('const unsafeContainer = [');
  assert.notStrictEqual(i, -1, 'unsafeContainer list not found');
  const open = source.indexOf('[', i);
  const close = source.indexOf(']', open);
  return new Set(source.slice(open + 1, close).split(',')
    .map((s) => s.replace(/['"\s]/g, '')).filter(Boolean));
}
const transcodeSet = extractTranscodeSet(apiSrc);

// ── 1) format matrix: every production container has a defined path ────────────
// Census (live DB, 2026-07-03): mkv 387,330 · mp4 366,618 · avi 5,613 · ts 3,289 ·
// m4v 272 · wmv 7 · flv 1. m3u8 covers live + every gateway-transcode output.
const PRODUCTION_FORMATS = ['mkv', 'mp4', 'm4v', 'ts', 'avi', 'wmv', 'flv'];

test('every production VOD container routes to a defined playback path', () => {
  for (const ext of PRODUCTION_FORMATS) {
    const viaEngine = engineSet.has(ext);
    const viaTranscode = transcodeSet.has(ext);
    // mp4/m4v with safe codecs play direct (relay); everything else must be
    // engine-demuxable or gateway-transcodable. No format may have NO path.
    const browserSafe = ['mp4', 'm4v', '3gp', '3g2'].includes(ext);
    assert.ok(viaEngine || viaTranscode || browserSafe,
      `container "${ext}" has NO playback path (not engine, not transcode, not browser-safe)`);
  }
});

test('engine handles the catalog majority (mkv/mp4/ts family)', () => {
  for (const ext of ['mkv', 'mp4', 'm4v', 'ts', 'webm', 'mov']) {
    assert.ok(engineSet.has(ext), `engine list must include "${ext}"`);
  }
});

test('non-demuxable legacy containers route to gateway transcode', () => {
  for (const ext of ['avi', 'wmv', 'flv']) {
    assert.ok(!engineSet.has(ext), `engine must NOT claim "${ext}"`);
    assert.ok(transcodeSet.has(ext), `transcode list must include "${ext}"`);
  }
});

// ── 2) provider-busy classification (the regex bug) ────────────────────────────
const watchSrc = read('public/js/pages/WatchPage.js');

function extractRegex(source, methodName) {
  const i = source.indexOf(`${methodName}(message)`);
  assert.notStrictEqual(i, -1, `${methodName} not found`);
  const seg = source.slice(i, i + 800);
  const m = seg.match(/return (\/(?:[^/\\\n]|\\.)+\/[a-z]*)\.test/);
  assert.ok(m, `${methodName} regex not found`);
  return eval(m[1]); // regex literal from our own source
}

const isProviderBusy = extractRegex(watchSrc, 'isProviderBusyError');
const isConnLimit = extractRegex(watchSrc, 'isConnectionLimitError');

test('provider-busy classifier matches the codes the engine actually emits', () => {
  for (const sample of [
    'BLOCK_HTTP_458',                          // the exact code from the user's console log
    'PROBE_HTTP_458',
    'HTTP 458',
    'max connection reached',
    'max connections',
    'Provider connection slot busy PROVIDER_BUSY',
    'FFmpeg exited ... (HTTP 458 max connections)', // gateway's typed detail suffix
  ]) {
    assert.ok(isProviderBusy.test(sample), `isProviderBusyError must match: ${sample}`);
    isProviderBusy.lastIndex = 0;
  }
});

test('provider-busy classifier does NOT swallow real demux/media errors', () => {
  for (const sample of [
    'SOURCE_UNSUPPORTED_CONTAINER',
    'DEMUX_OPEN',
    'NO_SUPPORTED_MIME',
    'SOURCEOPEN_TIMEOUT',
    'MEDIA_ERR_4',
    'HTTP 404 not found',
    'engine v45.8',                       // a bare "458" inside another number must not match
  ]) {
    assert.ok(!isProviderBusy.test(sample), `isProviderBusyError must NOT match: ${sample}`);
    isProviderBusy.lastIndex = 0;
  }
});

test('connection-limit classifier matches BLOCK_HTTP_458 (the original \\b458\\b bug)', () => {
  assert.ok(isConnLimit.test('BLOCK_HTTP_458'));
  assert.ok(isConnLimit.test('PROBE_HTTP_458'));
});

// ── 3) hub upstream-error classification of ffmpeg's 458 disguise ──────────────
const { normalizeUpstreamError } = require('../server/utils/upstreamError.js');

test('ffmpeg 458 disguise classifies as retryable UPSTREAM_PROVIDER_BUSY', () => {
  const r = normalizeUpstreamError(
    'http://provider.example/movie/x.mkv: Server returned 4XX Client Error, but not one of 40{0,1,3,4}');
  assert.strictEqual(r.code, 'UPSTREAM_PROVIDER_BUSY');
  assert.strictEqual(r.terminal, false);
  assert.strictEqual(r.upstreamStatus, 458);
});

test('a plain 404 stays terminal (not mistaken for slot-busy)', () => {
  const r = normalizeUpstreamError('Server returned 404 Not Found');
  assert.notStrictEqual(r.code, 'UPSTREAM_PROVIDER_BUSY');
});

// ── 4) hls.js vendored runtime + robust loaders ────────────────────────────────
test('hls.js is vendored locally and parses', () => {
  const p = path.join(ROOT, 'public/js/vendor/hls-1.5.7.min.js');
  assert.ok(fs.existsSync(p), 'vendored hls.js missing');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.length > 300_000, 'vendored hls.js suspiciously small');
  assert.doesNotThrow(() => new Function(src), 'vendored hls.js does not parse');
});

test('both app entries define the promise-based ensureHls loader (local first)', () => {
  for (const entry of ['public/app/index.html', 'public/app.html']) {
    const src = read(entry);
    assert.ok(src.includes('window.ensureHls = function'), `${entry}: ensureHls missing`);
    assert.ok(src.includes('/js/vendor/hls-1.5.7.min.js'), `${entry}: local-first load missing`);
    const localIdx = src.indexOf('/js/vendor/hls-1.5.7.min.js');
    const cdnIdx = src.indexOf('cdn.jsdelivr.net/npm/hls.js');
    assert.ok(localIdx < cdnIdx, `${entry}: CDN must be the FALLBACK, not first`);
    assert.ok(!/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/hls\.js[^>]*><\/script>/.test(src),
      `${entry}: bare CDN-only script tag must be gone`);
  }
});

test('no unguarded Hls dereference at decision points', () => {
  // Every `Hls.isSupported()` must be preceded by a typeof guard on the same line.
  for (const file of ['public/js/components/VideoPlayer.js', 'public/js/pages/WatchPage.js']) {
    const src = read(file);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (line.includes('Hls.isSupported()') && !line.includes("typeof Hls !== 'undefined'")
        && !line.includes('hlsSupported')) {
        assert.fail(`${file}:${i + 1} unguarded Hls.isSupported(): ${line.trim()}`);
      }
    });
  }
});

// ── 5) raw↔transcode slot ledger wiring (P1 follow-up lot) ──────────────────────
// These lock the CROSS-LANE single-flight wiring: a gateway restart or refactor
// that drops any of these markers reintroduces the 458 contention storm.
test('gateway: raw-pump ledger wired at /raw, /sessions and DELETE /raw-pumps', () => {
  const src = read('services/media-gateway/src/index.js');
  assert.ok(src.includes('const rawPumps = new Set()'), 'pump ledger missing');
  assert.ok(/registerRawPump\(\{\s*ac,/.test(src), '/raw must register its pump');
  assert.ok(src.includes("p !== pump && p.proxyKey === pumpProxyKey"), '/raw must supersede prior-session pumps');
  assert.ok(src.includes("abortRawPumps(\n            (p) => p.proxyKey === proxyKeyFromUrl(sourceUrl)")
    || /stoppedConflictingSessions \+= abortRawPumps\(/.test(src), '/sessions must abort conflicting raw pumps');
  assert.ok(src.includes("app.delete('/raw-pumps', requireGatewayAuth"), 'coordinator kill-switch endpoint missing');
  assert.ok(src.includes('ownerHash: claims.uid ? sha256Hex(claims.uid) : null'), 'owner hash keying missing');
});

test('gateway: same-session concurrent range reads are spared (keepSid)', () => {
  const src = read('services/media-gateway/src/index.js');
  assert.ok(src.includes('if (keepSid && pump.sid && pump.sid === keepSid) continue;'),
    'abortRawPumps must spare same-playback concurrency');
});

test('relay coordinator: zombie reaping, alarm, raw-lane eviction', () => {
  const src = read('services/norva-relay/src/index.js');
  assert.ok(src.includes('async expireRawPumps(sessions)'), 'expireRawPumps missing');
  assert.ok(src.includes('/raw-pumps?ownerKey='), 'gateway kill-switch call missing');
  assert.ok(src.includes('async alarm()'), 'DO alarm handler missing');
  assert.ok(src.includes('setAlarm(Math.min(...expiries)'), 'alarm arming missing');
  assert.ok(src.includes('lapsed.filter((session) => session.gatewaySessionId)'), 'lapsed gateway reaping missing');
  assert.ok(src.includes('const hadGatewayConflict'), 'proportionate waitMs missing');
});

test('edge: raw lane registered in the coordinator at resolve time', () => {
  const src = read('supabase/functions/norva-playback/index.ts');
  assert.ok(src.includes('const rawCoordination = await prepareEdgeSessionCoordinator'), 'raw prepare missing');
  assert.ok(src.includes('lane: "raw"'), 'raw lane marker missing');
  assert.ok(src.includes('lane: options.lane'), 'commit lane passthrough missing');
});
