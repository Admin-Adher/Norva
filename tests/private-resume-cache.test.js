'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { privateResumeBinding, createPrivateResumeOwnerGate } = require('../services/media-gateway/src/private-resume-binding');
const { PrivateResumeHlsCache, parseResumeMediaPlaylist, mergedResumePlaylist } = require('../services/media-gateway/src/private-resume-hls-cache');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
const { StrictLidRangeReuse } = require('../services/media-gateway/src/strict-lid-range-reuse');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ownerKey = 'a'.repeat(64), fileSizeBytes = 10_000_000;
const base = { ownerKey, sourceUrl: 'https://provider.invalid/movie/private/file.mp4',
    sourceId: 'source-a', sourceRevision: '1', fileSizeBytes, profile: 'audio=1' };
const observed = { fileSizeBytes, validator: { kind: 'etag', value: '"file-v1"' }, effectiveUrlIdentitySha256: 'b'.repeat(64) };
test('private resume canary admits only an exact configured owner and invalid configuration fails closed', () => {
    const other = 'c'.repeat(64);
    for (const ownerHashes of [undefined, '', ' ']) {
        assert.equal(createPrivateResumeOwnerGate({ ownerHashes })(ownerKey), false);
        assert.equal(createPrivateResumeOwnerGate({ enabled: true, ownerHashes })(ownerKey), true);
    }
    const canary = createPrivateResumeOwnerGate({ enabled: true, ownerHashes: ` ${ownerKey},invalid ` });
    assert.equal(canary(ownerKey), true);
    assert.equal(canary(other), false);
    assert.equal(canary('invalid'), false);
    assert.equal(createPrivateResumeOwnerGate({ enabled: true, ownerHashes: 'invalid' })(ownerKey), false);
    assert.equal(createPrivateResumeOwnerGate({ enabled: false, ownerHashes: ownerKey })(ownerKey), false);
    assert.equal(createPrivateResumeOwnerGate({ enabled: true })('invalid'), false);
});

test('all private resume ingress paths enforce the owner rollout fence', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    assert.match(source, /const privateRanges = canUsePrivateResumeCache\(entry\.ownerHash\)/);
    assert.match(source, /const privateRanges = canUsePrivateResumeCache\(session\.ownerKey\)/);
    assert.match(source, /if \(!canUsePrivateResumeCache\(session\?\.ownerKey\)\) return null/);
});
const playlist = (durations = Array(20).fill(4), ended = false) => '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + durations.map((duration, i) => `#EXTINF:${duration},\nsegment-${i}.ts`).join('\n') + (ended ? '\n#EXT-X-ENDLIST\n' : '\n');
const capture = (cache, binding = privateResumeBinding(base), more = {}) => cache.capture({ binding,
    observed, position: 10, actualStartOffset: 0, playlist: playlist(),
    readAsset: async () => Buffer.alloc(188, 0x47), ...more });

test('an explicit larger bounded HLS budget admits a high-bitrate window without weakening identity', async () => {
    const fixture = { playlist: playlist(Array(10).fill(4)), position: 1,
        readAsset: async () => Buffer.alloc(4096, 0x47) };
    const small = new PrivateResumeHlsCache({ maxBytes: 128 * 1024, perFileBytes: 32 * 1024 });
    assert.equal(await capture(small, privateResumeBinding(base), fixture), false);
    assert.equal(small.publicStatus().lastCaptureRejection, 'asset-unavailable-or-budget');
    const large = new PrivateResumeHlsCache({ maxBytes: 256 * 1024, perFileBytes: 64 * 1024 });
    assert.equal(await capture(large, privateResumeBinding(base), fixture), true);
    assert.equal(large.publicStatus().bytes, 40 * 1024);
    assert.equal(large.publicStatus().reservedBytes, 0);
    assert.equal(await capture(large, privateResumeBinding(base), { ...fixture,
        observed: { ...observed, validator: { kind: 'etag', value: 'W/"weak"' } } }), false);
    assert.equal(large.publicStatus().lastCaptureRejection, 'unverified-identity');
    assert.throws(() => new PrivateResumeHlsCache({ maxBytes: 257 * 1024 * 1024 }), /CONFIG_INVALID/);
});

test('intentional FFmpeg stop retains finalized resume segments but never certifies a complete film', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    const start = source.indexOf("child.on('exit', async (code, signal) => {", source.indexOf('function startFfmpeg(session)'));
    const end = source.indexOf("\n    child.on('close'", start);
    assert.ok(start > 0 && end > start);
    for (const scenario of ['stopping', 'stopping-error', 'failed', 'complete']) {
        let handler;
        const session = { status: scenario.startsWith('stopping') ? 'stopping' : 'ready', logTail: '' };
        if (scenario === 'stopping-error') session.lastError = 'real upstream failure';
        vm.runInNewContext(source.slice(start, end), { child: { on: (_, callback) => { handler = callback; } },
            session, pumpedMkvInput: false, inputPump: null, linearSeekBridge: null, outputAdmission: null,
            releaseVideoEncoderAdmission() {}, applyFiniteMkvSeekBrokerFailure() {}, wakePlaybackBlockedQueues() {},
            lastNonEmptyLine: () => 'encoder failure' });
        await handler(scenario === 'complete' ? 0 : 255, scenario.startsWith('stopping') ? 'SIGTERM' : null);
        assert.equal(session.completeHlsCacheFfmpegCompletedCleanly, scenario === 'complete');
        if (scenario === 'stopping') assert.equal(session.lastError, undefined);
        if (scenario === 'stopping-error') assert.equal(session.lastError, 'real upstream failure');
        if (scenario === 'failed') assert.equal(session.status, 'failed');
        if (scenario === 'complete') assert.equal(session.status, 'ended');
    }
});

test('Gateway recognizes ffprobe container aliases, not just filename labels', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    const start = source.indexOf('function privateResumeFormat('), end = source.indexOf('\nfunction ', start + 1);
    const format = vm.runInNewContext('(' + source.slice(start, end) + ')', {
        isLiveSession: s => s.live === true, isFiniteMkvVodSession: s => s.mkv === true,
        normalizeCodecToken: value => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    });
    for (const container of ['mp4', 'mov,mp4,m4a,3gp,3g2,mj2']) assert.equal(format({ codecProfile: { container } }), 'mp4');
    for (const container of ['mpegts', 'ts']) assert.equal(format({ codecProfile: { container } }), 'mpegts');
    assert.equal(format({ mkv: true }), 'mkv');
    assert.equal(format({ live: true, mkv: true }), null);
    assert.equal(format({ codecProfile: { container: 'avi' } }), null);
});

test('an EVENT resume playlist never changes its headers when longer continuation segments arrive', () => {
    const window = { segments: [{ name: 'resume-0.ts', duration: 3.84 }], ended: false };
    const initial = mergedResumePlaylist(window);
    const next = mergedResumePlaylist(window, playlist([6.24, 4]));
    assert.ok(next.startsWith(initial), 'the continuation may append, never rewrite the cached EVENT prefix');
    assert.match(next, /#EXT-X-TARGETDURATION:30/);
    assert.equal((next.match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
});

test('Gateway does not publish replaceable continuation artifacts before startup validation', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    const route = source.indexOf("app.get('/sessions/:id/playlist.m3u8'");
    const start = source.indexOf('if (session.privateResumeLease) {', route);
    const end = source.indexOf('} else if', start);
    assert.ok(route > 0 && start > route && end > start);
    for (const ready of [undefined, false, true]) {
        let reads = 0;
        const session = { privateResumeContinuationReady: ready, playlistPath: 'fixture',
            privateResumeLease: { playlist: continuation => 'cached-prefix' + continuation } };
        const getPlaylist = vm.runInNewContext('(async () => { let playlist; ' + source.slice(start, end) + '} return playlist; })', {
            session, exactSubtitleHlsEnabled: () => false,
            fsp: { readFile: async () => { reads++; return '+validated-continuation'; } },
        });
        assert.equal(await getPlaylist(), ready ? 'cached-prefix+validated-continuation' : 'cached-prefix');
        assert.equal(reads, ready ? 1 : 0);
    }
});

for (const result of ['ready', 'failed', 'aborted']) test(`private continuation publication is fenced until ${result}`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    const start = source.indexOf('async function tryStartPrivateResumeWindow(');
    const end = source.indexOf('\nfunction usesFiniteMkvSeekBroker', start);
    let finish;
    const session = { seekOffset: 10, startupTimings: {}, lastError: null };
    const run = vm.runInNewContext('(' + source.slice(start, end) + ')', {
        AbortController, Date, Error, Number,
        privateResumeHlsBindingForSession: () => ({}), privateResumeFormat: () => 'mpegts',
        privateResumeHlsCache: { hasCandidate: () => true, acquire: () => ({ start: 4, end: 60, aheadSeconds: 50 }) },
        prepareFiniteMkvSeekBroker: async () => ({ inputUrl: 'http://fixture.invalid' }),
        fileSizeBytesForSession: () => 1_000_000, privateResumeObservedIdentity: () => ({}),
        fetch: async () => ({ status: 206, arrayBuffer: async () => new ArrayBuffer(65536) }),
        startSessionWithProviderRetry: () => new Promise(resolve => { finish = resolve; }),
        observeSessionStartOffset: async () => {}, abortedVodInputPumpError: () => Error('aborted'),
    });
    assert.equal(await run(session), true);
    assert.equal(session.privateResumeContinuationReady, false);
    if (result === 'aborted') session.privateResumeContinuationController.abort();
    finish(result !== 'failed');
    await session.privateResumeContinuationPromise;
    assert.equal(session.privateResumeContinuationReady, result === 'ready');
    if (result === 'failed') assert.equal(session.status, 'failed');
});

for (const format of ['mp4', 'mkv', 'mpegts']) test(`${format}: retain a playable window, revalidate, seek precisely, and splice once`, async () => {
    const cache = new PrivateResumeHlsCache();
    const binding = privateResumeBinding({ ...base, sourceUrl: `https://provider.invalid/film.${format}` });
    assert.equal(await capture(cache, binding), true);
    const lease = cache.acquire(binding, 10.375, observed);
    assert.equal(lease.start, 4); assert.equal(lease.end, 60);
    const initial = lease.playlist('');
    assert.ok(!initial.includes('DISCONTINUITY')); assert.ok(!initial.includes('ENDLIST'));
    const first = lease.asset('resume-0.ts'); first.fill(0);
    assert.equal(lease.asset('resume-0.ts')[0], 0x47);
    const combined = lease.playlist(playlist([4.004, 3.996], true));
    assert.equal((combined.match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
    assert.ok(combined.indexOf('resume-13.ts') < combined.indexOf('#EXT-X-DISCONTINUITY'));
    assert.ok(combined.indexOf('#EXT-X-DISCONTINUITY') < combined.indexOf('segment-0.ts'));
    assert.ok(combined.endsWith('#EXT-X-ENDLIST\n'));
    lease.release(); assert.throws(() => lease.playlist(), /REVOKED/);
});

test('owner, source, revision, exact bytes and track profile each isolate a window', async () => {
    const cache = new PrivateResumeHlsCache(); await capture(cache);
    for (const change of [{ ownerKey: 'c'.repeat(64) }, { sourceUrl: base.sourceUrl + '?new-token=1' },
        { sourceId: 'source-b' }, { sourceRevision: '2' }, { fileSizeBytes: fileSizeBytes + 1 }, { profile: 'audio=2' }]) {
        assert.equal(cache.hasCandidate(privateResumeBinding({ ...base, ...change }), 10), false);
    }
    assert.equal(privateResumeBinding({ ...base, sourceRevision: '' }), null);
    assert.equal(privateResumeBinding({ ...base, ownerKey: 'raw-user-id' }), null);
});

for (const [label, change] of [
    ['weak', { validator: { kind: 'etag', value: 'W/"file-v1"' } }],
    ['missing', { validator: null }], ['changed', { validator: { kind: 'etag', value: '"file-v2"' } }],
    ['last-modified', { validator: { kind: 'last-modified', value: 'yesterday' } }],
    ['target', { effectiveUrlIdentitySha256: 'c'.repeat(64) }], ['size', { fileSizeBytes: fileSizeBytes + 1 }],
]) test(`${label}: current identity must reject and discard stale HLS`, async () => {
    const cache = new PrivateResumeHlsCache(); await capture(cache);
    assert.equal(cache.acquire(privateResumeBinding(base), 10, { ...observed, ...change }), null);
    assert.equal(cache.publicStatus().bytes, 0);
});

test('weak identity never stores playable bytes; no matching-size-only shortcut', async () => {
    const cache = new PrivateResumeHlsCache(); let reads = 0;
    assert.equal(await capture(cache, privateResumeBinding(base), { observed: { ...observed, validator: null },
        readAsset: () => { reads++; } }), false);
    assert.equal(reads, 0);
});

test('expiry prevents new leases; revocation stops an active lease', async () => {
    let now = 0; const cache = new PrivateResumeHlsCache({ now: () => now, ttlMs: 100 });
    const binding = privateResumeBinding(base); await capture(cache);
    const lease = cache.acquire(binding, 10, observed); now = 101;
    assert.equal(cache.acquire(binding, 10, observed), null);
    assert.ok(lease.asset('resume-0.ts'));
    cache.revokeOwner(ownerKey);
    assert.throws(() => lease.asset('resume-0.ts'), /REVOKED/);
    assert.equal(cache.publicStatus().bytes, 0); lease.release();
});

test('pending captures are fenced by revocation and bounded during concurrent reads', async () => {
    const cache = new PrivateResumeHlsCache({ maxBytes: 8192, perFileBytes: 4096 });
    let release; const pending = capture(cache, undefined, { readAsset: () => new Promise(resolve => { release = resolve; }) });
    assert.equal(cache.publicStatus().reservedBytes, 8192);
    assert.equal(await capture(cache, privateResumeBinding({ ...base, sourceRevision: '2' })), false);
    cache.revokeOwner(ownerKey); release(Buffer.alloc(188));
    assert.equal(await pending, false); assert.equal(cache.publicStatus().reservedBytes, 0);
});

test('short buffers, oversized segments, unsafe URIs and rendition graphs are cache misses', async () => {
    const cache = new PrivateResumeHlsCache({ maxBytes: 2048, perFileBytes: 512 });
    assert.equal(await capture(cache, undefined, { position: 1000 }), false);
    assert.equal(await capture(cache, undefined, { playlist: playlist([4, 4, 4]) }), false);
    assert.equal(await capture(cache, undefined, { readAsset: async () => Buffer.alloc(513) }), false);
    for (const bad of [playlist().replace('segment-0.ts', '../secret.ts'),
        playlist().replace('segment-0.ts', 'https://evil.invalid/a.ts'),
        playlist() + '#EXT-X-KEY:METHOD=AES-128,URI="key"\n',
        playlist() + '#EXT-X-MEDIA:TYPE=AUDIO\n', playlist() + '#EXT-X-DISCONTINUITY\n',
        playlist().replace('#EXT-X-INDEPENDENT-SEGMENTS', '')]) assert.equal(parseResumeMediaPlaylist(bad), null);
    assert.throws(() => mergedResumePlaylist({ segments: [{ name: 'resume-0.ts', duration: 4 }] }, 'invalid'), /GRAPH_INVALID/);
});

test('fractional segment duration stays exact across repeated returns', async () => {
    const cache = new PrivateResumeHlsCache(); const binding = privateResumeBinding(base);
    await capture(cache, binding, { playlist: playlist(Array(20).fill(4.004)), actualStartOffset: 400.375, position: 410.2 });
    const lease = cache.acquire(binding, 410.2, observed);
    assert.ok(Math.abs(lease.start - 404.379) < 1e-8);
    assert.ok(Math.abs(lease.end - (400.375 + 15 * 4.004)) < 1e-8); lease.release();
});

test('MP4 initialization and interior bytes require a fresh read and source revision', () => {
    const cache = new FinitePlaybackRangeReuse({ maxBytes: 32 * 1024 * 1024, perFileBytes: 16 * 1024 * 1024,
        maxRetainedWindowBytes: 8 * 1024 * 1024 });
    const first = cache.begin(base); assert.equal(first.hasPriorRanges, false); first.confirm(observed);
    assert.equal(first.remember(0, Buffer.alloc(6_500_000, 1)), true);
    assert.equal(first.remember(8_000_000, Buffer.alloc(1000, 2)), true);
    const second = cache.begin(base); assert.equal(second.hasPriorRanges, true);
    assert.equal(second.read(0, 10), null); second.confirm(observed);
    assert.equal(second.read(6_000_000, 6_000_010)[0], 1);
    assert.equal(second.read(8_000_000, 8_000_010)[0], 2);
    assert.equal(cache.begin({ ...base, sourceRevision: '2' }).hasPriorRanges, false);
    cache.revokeOwner(ownerKey); assert.equal(second.read(0, 10), null);
    assert.equal(cache.publicStatus().bytes, 0);
});

test('revocation fences an unconfirmed byte handle racing its first response', () => {
    const cache = new StrictLidRangeReuse();
    const pending = cache.begin({ userHash: ownerKey, sourceUrlHash: 'b'.repeat(64), profileHash: 'c'.repeat(64), fileSizeBytes });
    cache.revokeOwner(ownerKey); assert.equal(pending.confirm(observed), false);
    assert.equal(pending.remember(0, Buffer.alloc(32), { providerDrained: true }), false);
});
