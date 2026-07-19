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
const vm = require('node:vm');

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
  assert.ok(isConnLimit.test('BLOCK_HTTP_429'));
});

test('engine provider connection blocks do not fall through to transcode', () => {
  const guard = "if (this.isConnectionLimitError(msg))";
  const guardIndex = watchSrc.indexOf(guard);
  const fallbackIndex = watchSrc.indexOf('fallbackEngineToTranscode(playbackAttemptId, startTime)');
  assert.notEqual(guardIndex, -1, 'connection-limit guard missing from engine failure path');
  assert.notEqual(fallbackIndex, -1, 'transcode fallback call missing from engine failure path');
  assert.ok(guardIndex < fallbackIndex, 'connection-limit guard must run before transcode fallback');
  const guardBody = watchSrc.slice(guardIndex, fallbackIndex);
  assert.match(guardBody, /showPlaybackError\(msg, \{ immediate: true \}\)/);
  assert.match(guardBody, /return;/);
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

// public/app/index.html was a stale duplicate shell served at /app/ — deleted
// (redirected to /app in _redirects); the single entry is public/app.html.
test('the app entry defines the promise-based ensureHls loader (local first)', () => {
  for (const entry of ['public/app.html']) {
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

// ── 6) post-seek remux continuity + position-preserving recovery ───────────────
test('browser engine rejects discontinuous mux writes before they reach MediaSource', () => {
  const src = read('public/js/norvaEngine.js');
  assert.ok(src.includes('writePos !== expectedWritePos'), 'strict mux write-position guard missing');
  assert.ok(src.includes('MUX_WRITE_DISCONTINUITY'), 'typed discontinuity error missing');
  assert.ok(src.includes('this.onFatal(error)'), 'player fatal callback missing');
  assert.ok(src.includes('if (this._fatalSignaled)'), 'all writes after a fatal discontinuity must be dropped');
  assert.ok(src.includes('fatalBytesDropped'), 'post-fatal write drops must be observable');
  const guard = src.slice(src.indexOf('writePos !== expectedWritePos'), src.indexOf('// Trace write position'));
  assert.ok(guard.includes('return;'), 'bad mux bytes must be dropped');
  assert.ok(!guard.includes('this.queue.push'), 'bad mux bytes must never reach the append queue');
});

test('engine runtime recovery resumes MKV/MP4 once and keeps the selected audio index', () => {
  const start = watchSrc.indexOf('async handleEngineRuntimeFailure(');
  const end = watchSrc.indexOf('\n    destroyEngine()', start);
  assert.notStrictEqual(start, -1, 'runtime recovery helper missing');
  assert.notStrictEqual(end, -1, 'runtime recovery helper end missing');
  const body = watchSrc.slice(start, end);
  assert.ok(body.includes('const maxEngineRetries = wasTs ? 2 : 1'),
    'non-TS media must receive one bounded engine retry');
  assert.ok(body.includes('startTime: resumeAt'), 'engine retry must resume at the failure position');
  assert.ok(body.includes('audioStreamIndex: selectedAudioIndex'), 'engine retry must preserve selected audio');
  assert.ok(body.includes('fallbackEngineToTranscode(playbackAttemptId, resumeAt)'),
    'gateway fallback must receive the captured position');
  assert.ok(body.includes('Number.isFinite(visiblePosition) && visiblePosition > 0'),
    'a backward seek must resume from the visible playhead, not the monotone snapshot');
  assert.ok(body.includes('this._engineRuntimeRecoveryAttemptId === playbackAttemptId'),
    'runtime recovery must deduplicate only the same playback attempt');
  assert.ok(body.indexOf('const rememberedPosition = Number(this._lastKnownPlaybackPosition)')
      < body.indexOf('const snapshotPosition = Number(this.getResumeSnapshotPosition?.())'),
    'the remembered playhead must be captured before the snapshot getter can observe a reset video');
  assert.ok(body.includes('if (this.isStalePlaybackAttempt(playbackAttemptId)) return true;'),
    'an obsolete recovery must not surface its error over a newer title');
});

test('version failover is scoped to the playback attempt and cannot replace a newer title', () => {
  const start = watchSrc.indexOf('async tryNextVersion(');
  const end = watchSrc.indexOf('\n    updateVolumeUI()', start);
  const body = watchSrc.slice(start, end);
  assert.ok(body.includes('playbackAttemptId = this._playbackAttemptId'),
    'failover must capture its playback attempt');
  assert.ok(body.includes('this.isStalePlaybackAttempt(playbackAttemptId)'),
    'failover must reject stale resolves');
  assert.ok(body.includes('this.content !== contentAtStart'),
    'failover must not mutate a different title');
  assert.ok(body.includes('playbackAttemptId,'),
    'loadVideo must retain the guarded playback attempt');
  assert.ok(body.includes('await this.cleanupStaleCloudPlaybackSession(resultSessionId)'),
    'a stale alternate-version resolve must release its provider session');
  assert.ok(body.includes('this.content.cloudSourceId = nextCloudSourceId'),
    'failover must replace the exact cloud-source identity');
  assert.ok(body.includes('this.content.containerExtension = nextContainer'),
    'failover must replace the content-level container alias');
  assert.ok(body.includes('this.content.versionIndex = nextIndex'),
    'the resumable content object must retain the selected version index');
  assert.ok(body.includes('this.replaceExactContentAudioMetadata(exactAudioTracks, exactAudioLanguages)'),
    'failover must replace, not merge, exact-file audio metadata');
  assert.ok(body.includes('this.getLanguageSafeFailoverPreferences()'),
    'failover must retain language semantics without reusing a file-relative stream index');
  assert.ok(body.includes('this.getLanguageSafeFailoverAudioOptions('),
    'failover must map the retained language onto the sibling file before resolving it');
  assert.ok(body.includes('...nextAudioOptions'),
    'the sibling file audio index must be sent when its Gateway session is created');
});

test('version failover remaps a language preference instead of reusing the old file index', () => {
  const context = { window: {}, console, setTimeout, clearTimeout };
  vm.runInNewContext(watchSrc, context, { filename: 'WatchPage.js' });
  const page = Object.create(context.window.WatchPage.prototype);
  const safePreference = page.getLanguageSafeFailoverPreferences({
    audio: { source: 'probe', streamIndex: 7, language: 'fra' },
  });
  const options = page.getLanguageSafeFailoverAudioOptions([
    { index: 2, lang: 'eng' },
    { index: 11, lang: 'fre', codec: 'aac', channels: 2 },
  ], safePreference);

  assert.strictEqual(safePreference.audio.language, 'fr');
  assert.strictEqual(Object.hasOwn(safePreference.audio, 'streamIndex'), false);
  assert.strictEqual(options.audioStreamIndex, 11);
  assert.notStrictEqual(options.audioStreamIndex, 7);
});

test('a fatal callback during engine load cannot start a competing fallback', () => {
  const start = watchSrc.indexOf('async playWithEngine(');
  const end = watchSrc.indexOf('\n    async fallbackEngineToTranscode(', start);
  const body = watchSrc.slice(start, end);
  const identityGuards = body.match(/this\.norvaEngine !== engine/g) || [];
  assert.ok(identityGuards.length >= 3,
    'onFatal, load success, and load catch must all reject an obsolete engine');
  assert.ok(body.includes('try { engine.destroy(); } catch (_) {}'),
    'an obsolete engine must destroy only itself, never the replacement');
});

test('engine-to-gateway fallback keeps the exact offset without restarting play()', () => {
  const start = watchSrc.indexOf('async fallbackEngineToTranscode(');
  const end = watchSrc.indexOf('\n    async handleEngineRuntimeFailure(', start);
  assert.notStrictEqual(start, -1, 'engine fallback helper missing');
  assert.notStrictEqual(end, -1, 'engine fallback helper end missing');
  const body = watchSrc.slice(start, end);
  assert.ok(body.includes('startOffsetOverride'), 'explicit resume override missing');
  assert.ok(body.includes('resumeTarget: startOffset'), 'resume target must be propagated');
  assert.ok(body.includes('await this.loadVideo('), 'lane swap must use loadVideo');
  assert.ok(!body.includes('await this.play(c,'), 'play() would reset the retry budget and playback state');
  assert.ok(body.includes('await this.cleanupStaleCloudPlaybackSession(resultSessionId)'),
    'a stale gateway fallback resolve must release its provider session');
});

test('delayed engine setup retries never destroy a replacement engine', () => {
  const start = watchSrc.indexOf('async playWithEngine(');
  const end = watchSrc.indexOf('\n    async fallbackEngineToTranscode(', start);
  const body = watchSrc.slice(start, end);
  const slotRetry = body.slice(body.indexOf('if (isSlotBusy(msg) && attempt < SLOT_BUSY_RETRIES)'),
    body.indexOf('// A SOURCEOPEN_TIMEOUT'));
  const sourceOpenRetry = body.slice(body.indexOf('if (/SOURCEOPEN_TIMEOUT/i.test(msg)'),
    body.indexOf('// Slot still busy'));
  assert.ok(slotRetry.includes('if (this.isStalePlaybackAttempt(playbackAttemptId)) return;'),
    'slot retry must abandon a stale wait');
  assert.ok(sourceOpenRetry.includes('if (this.isStalePlaybackAttempt(playbackAttemptId)) return;'),
    'SOURCEOPEN retry must abandon a stale wait');
  assert.ok(!slotRetry.includes('if (this.isStalePlaybackAttempt(playbackAttemptId)) { this.destroyEngine()'),
    'slot retry must not destroy a newer engine');
  assert.ok(!sourceOpenRetry.includes('if (this.isStalePlaybackAttempt(playbackAttemptId)) { this.destroyEngine()'),
    'SOURCEOPEN retry must not destroy a newer engine');
});

test('engine retry budget cannot re-arm inside the historical ~50 second crash loop', () => {
  assert.ok(watchSrc.includes('(this._engineRetryFromPos || 0) + 120'),
    'runtime retry budget must require two healthy minutes before re-arming');
});

// ── 7) exact-file track isolation ──────────────────────────────────────────────
test('playback reads the exact file cache before any single-title fallback', () => {
  const src = read('supabase/functions/norva-playback/index.ts');
  const cacheLookup = src.indexOf('.from("catalog_file_tracks")');
  const singleTitleFallback = src.indexOf('Backwards compatibility for a genuinely single-version title only');
  assert.notStrictEqual(cacheLookup, -1, 'catalog_file_tracks lookup missing');
  assert.notStrictEqual(singleTitleFallback, -1, 'single-version title fallback guard missing');
  assert.ok(cacheLookup < singleTitleFallback, 'exact file cache must win over title-level maps');
  assert.ok(src.includes('Number(titleRow?.variant_count ?? 0) <= 1'),
    'grouped title tracks must be rejected');
  assert.ok(src.includes('const fileExternalId = itemId'),
    'series caches must use the exact episode id, not the parent series id');
  assert.ok(src.includes('const singleMovieTitle = itemType === "movie"'),
    'series episodes must never reuse or overwrite parent-title track indices');
  assert.ok(src.includes('String(titleRow?.variant_external_id ?? "") === String(itemId)'),
    'codec-profile tracks must belong to the exact played file');
});

test('catalog variants expose only exact file-scoped tracks', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.ok(src.includes('async function attachExactFileTracks('), 'exact variant cache join missing');
  assert.ok(src.includes('__file_audio_tracks'), 'exact audio tracks are not attached');
  assert.ok(src.includes('audio_tracks_scope: audioTracks !== undefined ? "file"'), 'file scope marker missing');
  assert.ok(src.includes('audioIso ? 24 : HOME_RAIL_VARIANT_LIMIT'),
    'audio-filtered details must not hide the matching variant behind the default cap');
});

test('live file probe replaces stale title languages and reports exact file identity', () => {
  const enrichStart = watchSrc.indexOf('async enrichCloudPlaybackTracks(');
  const enrichEnd = watchSrc.indexOf('\n    // True when the title is known', enrichStart);
  const enrich = watchSrc.slice(enrichStart, enrichEnd);
  assert.ok(enrich.includes('this.replaceExactContentAudioMetadata('),
    'live probe must replace exact-file tracks and languages');
  assert.ok(enrich.includes('if (isStaleEnrichment()) return;'),
    'a late probe must not overwrite a newer file');
  assert.ok(!enrich.includes('const merged = Array.from(new Set([...existing, ...langs]))'),
    'live probe must not merge languages inherited from another version');

  const reportStart = watchSrc.indexOf('\n    reportObservedAudioLanguages() {');
  const reportEnd = watchSrc.indexOf('\n    updateAudioTracks()', reportStart);
  const report = watchSrc.slice(reportStart, reportEnd);
  for (const field of ['cloudSourceId,', 'itemType,', 'itemId: externalId', 'externalId,']) {
    assert.ok(report.includes(field), `observed-language payload missing ${field}`);
  }
});

test('resume snapshots keep exact metadata for alternate versions', () => {
  const start = watchSrc.indexOf('sanitizeResumeContent(');
  const end = watchSrc.indexOf('\n    sanitizeResumePlayback(', start);
  const body = watchSrc.slice(start, end);
  for (const field of ['cloudSourceId:', 'audioTracks:', 'audioTracksScope:', 'audioLanguages:', 'subtitleTracks:', 'subtitleTracksScope:']) {
    assert.ok(body.includes(field), `resume version metadata missing ${field}`);
  }
});
