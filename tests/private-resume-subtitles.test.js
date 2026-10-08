const test = require('node:test'), assert = require('node:assert/strict');
const { captureSubtitleWindow, parseWebVtt, parseSubtitlePlaylist, videoTimestampOrigin } = require('../services/media-gateway/src/private-resume-subtitles');
const { PrivateResumeHlsCache } = require('../services/media-gateway/src/private-resume-hls-cache');
const { privateResumeBinding } = require('../services/media-gateway/src/private-resume-binding');
const fs = require('node:fs'), vm = require('node:vm');
const { ResumePlaylistClock } = require('../services/media-gateway/src/private-resume-playlist-clock');
const { parseResumeMediaPlaylist } = require('../services/media-gateway/src/private-resume-hls-cache');

test('cached indexed subtitle continuation trims every output on the absolute source clock', () => {
    const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
    const block = source.slice(source.indexOf('function seekArgsForSession('), source.indexOf('\nfunction usesSourceTimestampedCopySeek('));
    const seek = vm.runInNewContext(`(${block})`, {
        isFiniteMkvVodSession: () => true, usesFiniteMkvSeekBroker: () => true,
        exactSubtitleHlsEnabled: s => s.subtitles === true,
    });
    const result = seek({ privateResumeLease: {}, privateResumeContinuationOffset: 68.25, subtitles: true }, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        preInputSeek: ['-ss', '53.25'], postInputSeek: ['-ss', '68.25'],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(seek({ seekOffset: 68, subtitles: true }, true))), {
        preInputSeek: ['-ss', '68'], postInputSeek: [],
    });
});
const renditions = [{ playlistName: 'subtitle_0.m3u8', streamIndex: 2 }];
const vtt = Buffer.from('WEBVTT\n\n1\n00:00:07.000 --> 00:00:13.000\nCross-boundary cue\n\n2\n00:00:22.000 --> 00:00:25.000\nLater cue\n');
function transportPacket(seconds) {
    const packet = Buffer.alloc(188, 255), pts = Math.round(seconds * 90000) % 2 ** 33;
    packet.set([0x47, 0x41, 0, 0x10, 0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]);
    packet.set([0x21 | (Math.floor(pts / 2 ** 30) << 1), Math.floor(pts / 2 ** 22) & 255,
        ((Math.floor(pts / 2 ** 15) & 127) << 1) | 1, Math.floor(pts / 128) & 255,
        ((pts & 127) << 1) | 1], 13);
    return packet;
}
const readAsset = async name => name.endsWith('.m3u8')
    ? Buffer.from('#EXTM3U\n#EXTINF:80,\nsubtitle_0-00001.vtt\n')
    : name.endsWith('.vtt') ? vtt : transportPacket(Number(/segment-(\d+)/.exec(name)[1]) * 4 + 1.4);
const videoSegments = [{ name: 'segment-2.ts', start: 8, end: 12, duration: 4 }, { name: 'segment-3.ts', start: 12, end: 16, duration: 4 }];

test('video clock accounts for mux offset, rollover and invalid packets', () => {
    assert.equal(videoTimestampOrigin(transportPacket(9.4), 8), 126000);
    assert.equal(videoTimestampOrigin(transportPacket(1.4), 2 ** 33 / 90000), 126000);
    assert.equal(videoTimestampOrigin(Buffer.alloc(188), 0), null);
});

test('subtitle cache retains full crossing cues, original clocks and every selected rendition', async () => {
    const graph = await captureSubtitleWindow({ renditions, videoSegments, readAsset });
    assert.equal(graph.playlists.size, 1);
    assert.equal(graph.assets.size, 2);
    for (const bytes of graph.assets.values()) {
        assert.match(bytes.toString(), /00:00:07.000 --> 00:00:13.000/);
        assert.match(bytes.toString(), /MPEGTS:126000/);
        assert.doesNotMatch(bytes.toString(), /Later cue/);
    }
});

test('on-demand continuation renders a single stable fragment at its original index', async () => {
    const graph = await captureSubtitleWindow({ renditions, videoSegments: [videoSegments[1]],
        readAsset, prefix: 'continuation', startIndex: 301 });
    assert.equal(graph.assets.size, 1);
    assert.ok(graph.assets.has('continuation-subtitle_0-301.vtt'));
    assert.match(graph.assets.get('continuation-subtitle_0-301.vtt').toString(), /MPEGTS:126000/);
});

test('subtitle continuation waits for the common coverage and retries late sidecars without video changes', async () => {
    const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
    const block = source.slice(source.indexOf('async function privateResumeSubtitleContinuation('),
        source.indexOf('\nasync function tryStartPrivateResumeWindow('));
    let coverage = 4, reads = 0;
    const context = { fsp: { readFile: async () => { reads++; return 'video'; } },
        parseResumeMediaPlaylist: () => ({ ended: true, segments: [
            { name: 'segment-0.ts', start: 0, end: 4, duration: 4 },
            { name: 'segment-1.ts', start: 4, end: 8, duration: 4 }] }),
        exactSubtitleRenditionsForSession: () => renditions,
        readPrivateResumeAsset: async () => Buffer.from('subtitle'),
        parseSubtitlePlaylist: () => ({ segments: [{ end: coverage }], ended: coverage === 8 }),
    };
    const build = vm.runInNewContext(`(()=>{${block};return privateResumeSubtitleContinuation})()`, context);
    const session = { privateResumeContinuationReady: true };
    const first = await build(session);
    assert.equal(first.segments.length, 1);
    assert.equal(first.ended, false);
    assert.equal(first.assets, undefined, 'no growing movie body retained');
    coverage = 8;
    const [second, concurrent] = await Promise.all([build(session), build(session)]);
    assert.equal(second, concurrent);
    assert.equal(second.segments.length, 2);
    assert.equal(second.ended, true);
    assert.equal(reads, 2, 'concurrent requests share one builder');
});

test('missing coverage, bootstrap, unsupported clocks, escaping names and budgets fail closed', async () => {
    assert.equal(parseSubtitlePlaylist('#EXTM3U\n#EXTINF:4,\n../secret.vtt'), null);
    assert.equal(parseWebVtt(Buffer.from('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n')), null);
    assert.equal(await captureSubtitleWindow({ renditions, videoSegments, readAsset, maxBytes: 1 }), null);
    for (const playlist of ['#EXTM3U\n#EXTINF:4,\nsubtitle_0-00001.vtt\n',
        '#EXTM3U\n#EXT-X-NORVA-BOOTSTRAP:1\n#EXTINF:80,\nsubtitle_0-00000.vtt\n']) {
        assert.equal(await captureSubtitleWindow({ renditions, videoSegments,
            readAsset: async name => name.endsWith('.m3u8') ? Buffer.from(playlist) : vtt }), null);
    }
});

test('an early subtitle ENDLIST cannot certify the rest of a video window', async () => {
    const result = await captureSubtitleWindow({ renditions, videoSegments,
        readAsset: async name => name.endsWith('.m3u8')
            ? Buffer.from('#EXTM3U\n#EXTINF:12,\nsubtitle_0-00001.vtt\n#EXT-X-ENDLIST\n') : await readAsset(name) });
    assert.equal(result, null);
});

test('native empty WebVTT and nonempty fragments have the same header clock', () => {
    assert.equal(parseWebVtt(Buffer.from('WEBVTT\n')).header, parseWebVtt(vtt).header);
    assert.deepEqual(parseWebVtt(Buffer.from('WEBVTT\n')).cues, []);
});

test('continuation never publishes video beyond a prematurely ended subtitle lane', async () => {
    const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
    const block = source.slice(source.indexOf('async function privateResumeSubtitleContinuation('),
        source.indexOf('\nfunction recentDeliveryRouteKey('));
    const build = vm.runInNewContext(`(()=>{${block};return privateResumeSubtitleContinuation})()`, {
        fsp: { readFile: async () => 'video' },
        parseResumeMediaPlaylist: () => ({ ended: false, sequence: 0, segments: [
            {name:'segment-0.ts',start:0,end:4,duration:4}, {name:'segment-1.ts',start:4,end:8,duration:4}] }),
        exactSubtitleRenditionsForSession: () => renditions,
        readPrivateResumeAsset: async () => Buffer.from('subtitle'),
        parseSubtitlePlaylist: () => ({ segments: [{end:4}], ended:true }),
    });
    const graph = await build({privateResumeContinuationReady:true});
    assert.equal(graph.segments.length,1);
    assert.equal(graph.segments[0].end,4);
    assert.equal(graph.ended,false);
});

test('sliding subtitle continuation preserves original clocks, coverage and stable fragment names', async () => {
    const source = fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'), 'utf8');
    const block = source.slice(source.indexOf('async function privateResumeSubtitleContinuation('),
        source.indexOf('\nfunction recentDeliveryRouteKey('));
    const make = sequence => '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\n'
        + Array.from({ length: 4 }, (_, i) => `#EXTINF:4,\nsegment-${sequence+i}.ts\n`).join('');
    let text = make(0), coverage = 16;
    const clock = new ResumePlaylistClock(); clock.observe('video.m3u8', text);
    const build = vm.runInNewContext(`(()=>{${block};return privateResumeSubtitleContinuation})()`, {
        fsp: { readFile: async () => text }, parseResumeMediaPlaylist,
        exactSubtitleRenditionsForSession: () => renditions,
        readPrivateResumeAsset: async () => Buffer.from('subtitle'),
        parseSubtitlePlaylist: () => ({ segments: [{ end: coverage }], ended: false }),
    });
    const session = { privateResumeContinuationReady: true, hlsOutputAdmission: { resumePlaylistClock: clock } };
    const first = await build(session);
    text = make(2);
    assert.equal(await build(session), first, 'unattested publication does not invent a clock');
    clock.observe('video.m3u8', text);
    const second = await build(session);
    assert.equal(second.sequence, 2);
    assert.equal(second.segments.length, 2, 'only through the actual 16 second subtitle coverage');
    assert.equal(second.segments[0].start, 8);
    assert.equal(second.playlists.get('subtitle_0.m3u8')[0].name, 'continuation-subtitle_0-2.vtt');
    coverage = 24;
    const third = await build(session);
    assert.equal(third.segments.length, 4);
    const fragment = await captureSubtitleWindow({ renditions, videoSegments: [third.segments[0]], readAsset,
        prefix: 'continuation', startIndex: third.sequence });
    const bytes = fragment.assets.get('continuation-subtitle_0-2.vtt').toString();
    assert.match(bytes, /MPEGTS:126000/);
    assert.match(bytes, /00:00:07.000 --> 00:00:13.000/);
});

test('HLS cache captures video plus subtitle graph atomically, revalidates, splices, and revokes both', async () => {
    const cache = new PrivateResumeHlsCache();
    const binding = privateResumeBinding({ ownerKey: 'a'.repeat(64), sourceUrl: 'https://example.invalid/movie',
        sourceId: 'a', sourceRevision: '1', fileSizeBytes: 1000000, profile: 'subtitles=2' });
    const observed = { fileSizeBytes: 1000000, validator: { kind: 'etag', value: '"v1"' }, effectiveUrlIdentitySha256: 'b'.repeat(64) };
    const playlist = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n' + Array.from({ length: 20 }, (_, i) => `#EXTINF:4,\nsegment-${i}.ts\n`).join('');
    const args = { binding, observed, position: 10, actualStartOffset: 0, playlist, readAsset, subtitleRenditions: renditions };
    assert.equal(await cache.capture(args), true);
    const lease = cache.acquire(binding, 10, observed);
    assert.match(lease.subtitlePlaylist('subtitle_0.m3u8'), /resume-subtitle_0-0.vtt/);
    assert.match(lease.asset('resume-subtitle_0-1.vtt').toString(), /Cross-boundary/);
    const joined = lease.subtitlePlaylist('subtitle_0.m3u8', [{ name: 'continuation-subtitle_0-0.vtt', duration: 4 }]);
    assert.equal((joined.match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
    const rolled = lease.subtitlePlaylist('subtitle_0.m3u8', [{ name: 'continuation-subtitle_0-5.vtt', duration: 4 }], false, 5);
    const prefixCount = (lease.subtitlePlaylist('subtitle_0.m3u8').match(/#EXTINF/g) || []).length;
    assert.match(rolled, new RegExp(`MEDIA-SEQUENCE:${prefixCount + 5}\\n`));
    assert.match(rolled, /DISCONTINUITY-SEQUENCE:1/);
    assert.doesNotMatch(rolled, /resume-subtitle|PLAYLIST-TYPE/);
    lease.release();
    // Failed replacement must keep the still-valid prior window.
    assert.equal(await cache.capture({ ...args, readAsset: async () => null }), false);
    assert.equal(cache.hasCandidate(binding, 10), true);
    const second = cache.acquire(binding, 10, observed);
    cache.revokeOwner('a'.repeat(64));
    assert.throws(() => second.subtitlePlaylist('subtitle_0.m3u8'), /REVOKED/);
    assert.throws(() => second.asset('resume-subtitle_0-1.vtt'), /REVOKED/);
});
