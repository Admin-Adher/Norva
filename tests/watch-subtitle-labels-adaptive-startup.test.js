'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8');
function watch(globals = {}) {
    const env = { window: {}, console, Intl, document: { documentElement: { lang: 'fr' } }, ...globals };
    vm.runInNewContext(source, env);
    return Object.create(env.window.WatchPage.prototype);
}
test('probe, HLS and native subtitle labels expose the same declared Dutch language', () => {
    const page = watch();
    for (const language of ['dut', 'nld', 'nl']) {
        for (const track of [{ title: 'Subtitle 1', language }, { name: 'Subtitle 1', lang: language },
            { label: 'Subtitle 1', language }, { name: 'Subtitle 1 2', lang: language }]) {
            const before = JSON.stringify(track);
            assert.equal(page.getSubtitleMenuLabel(track, [track], 0), 'Néerlandais');
            assert.equal(JSON.stringify(track), before);
        }
    }
});
test('subtitle labels keep roles, useful titles and duplicate identity without promoting an inferred conflict', () => {
    const page = watch();
    assert.equal(page.getSubtitleTrackLabel({ language: 'dut', inferredLanguage: 'fr', title: 'Subtitle 1' }), 'Néerlandais');
    assert.equal(page.getSubtitleTrackLabel({ language: 'und', inferredLanguage: 'fr', title: 'Subtitle 1' }), 'Français');
    assert.equal(page.getSubtitleTrackLabel({ name: 'NL', lang: 'dut' }), 'Néerlandais');
    assert.equal(page.getSubtitleTrackLabel({ name: 'Commentary', lang: 'eng' }), 'Anglais - Commentary');
    assert.equal(page.getSubtitleTrackLabel({ name: 'Subtitle 1', lang: 'dut', attrs: {
        FORCED: 'YES', CHARACTERISTICS: 'public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound',
    } }), 'Néerlandais - Forced - SDH');
    const tracks = [{ name: 'Subtitle 1', lang: 'dut' }, { name: 'Subtitle 2', lang: 'nld' }];
    assert.equal(page.getSubtitleMenuLabel(tracks[0], tracks, 0), 'Néerlandais - Piste 1');
    assert.equal(page.getSubtitleMenuLabel(tracks[1], tracks, 1), 'Néerlandais - Piste 2');
    assert.equal(page.getSubtitleTrackLabel({ name: 'Subtitle 1', lang: 'und' }, 'Sous-titres'), 'Sous-titres');
});
test('HLS and native saved choices use formatted labels but retain their original indices and language', () => {
    const page = watch();
    page._hlsOwnsExactSubtitles = true;
    page.hls = { subtitleTrack: 0, subtitleTracks: [{ name: 'Subtitle 1', lang: 'dut' }] };
    page.hlsTrackSourceStreamIndex = () => 2;
    const choice = page.getCurrentSubtitlePreference();
    assert.equal(choice.label, 'Néerlandais'); assert.equal(choice.index, 0);
    assert.equal(choice.streamIndex, 2); assert.equal(choice.language, 'dut');
    page.hls = null;
    page.video = { textTracks: [{ label: 'Subtitle 1', language: 'dut', mode: 'showing' }] };
    assert.equal(page.getCurrentSubtitlePreference().label, 'Néerlandais');
    assert.equal(page.getCurrentSubtitlePreference().index, 0);
    const menu = source.slice(source.indexOf('    updateCaptionsTracks()'), source.indexOf('    getSubtitleStyle()'));
    assert.doesNotMatch(menu, /label: track\.name \|\| track\.lang/);
    assert.match(menu, /this\.getSubtitleMenuLabel\(track, hlsSubtitleTracks, index\)/);
});
const pendingPolicy = { protocol: 2, eligible: false, pipeline: 'video-transcode',
    reason: 'encode-rate-below-minimum', minimumEncodeRateX: 2, observedEncodeRateX: 1.583, targetBufferSeconds: null };
test('only an exact selected graph with a rate-only rejection enables later observation', () => {
    const page = watch();
    assert.equal(page.gatewayStartupBufferOptions(pendingPolicy).adaptive, true);
    assert.equal(page.gatewayStartupBufferOptions(pendingPolicy).minimumSeconds, 96);
    for (const value of [null, {}, { ...pendingPolicy, protocol: 1 }, { ...pendingPolicy, eligible: true },
        { ...pendingPolicy, reason: 'missing-proof' }, { ...pendingPolicy, reason: 'ts-startup-decode-unverified' },
        { ...pendingPolicy, targetBufferSeconds: 6 }, { ...pendingPolicy, pipeline: 'unknown' },
        { ...pendingPolicy, observedEncodeRateX: null }]) {
        assert.notEqual(page.gatewayStartupBufferOptions(value).adaptive, true);
    }
});
async function gate(buffer, change = () => {}, options = {}) {
    let now = 0;
    const page = watch({ Date: { now: () => now }, setTimeout: (fn, ms) => { now += ms; fn(); } });
    const hls = { levels: [{ details: { live: true, fragments: Array.from({ length: 4 }, () => ({ duration: 2 })) } }] };
    page.hls = hls;
    page.video = { paused: true, currentTime: 0, ended: false, readyState: 4, videoWidth: 1920 };
    page.isStalePlaybackAttempt = () => false;
    page.gatewayBufferedAheadSeconds = () => { change(page, now); return buffer(now); };
    const result = await page.waitForGatewayStartupBuffer(3, hls,
        { ...page.gatewayStartupBufferOptions(pendingPolicy), timeoutMs: 6000, ...options });
    return { result, now, evidence: page._gatewayStartupAdaptiveEvidence };
}
test('a sustained later buffer growth releases the gate without waiting for 96 seconds', async () => {
    const result = await gate(t => 6 + 4 * Math.floor(t / 400));
    assert.equal(result.result, true); assert.equal(result.now, 2000);
    assert.ok(result.evidence.appends >= 3); assert.ok(result.evidence.bufferedSeconds >= 12);
    assert.ok(result.evidence.rateX >= 2);
});
test('a cached burst, slow feed, gaps, missing frames or unbounded segments do not earn adaptive startup', async () => {
    for (const [buffer, change] of [
        [t => t === 0 ? 6 : 30], [t => 6 + t / 1000], [t => 6 + 4 * Math.floor(t / 3000)],
        [t => 6 + 4 * Math.floor(t / 400), page => { page.video.videoWidth = 0; }],
        [t => 6 + 4 * Math.floor(t / 400), page => { page.hls.levels[0].details.fragments[0].duration = 30; }],
        [t => 6 + 4 * Math.floor(t / 400), page => { page.hls.levels[0].details.fragments = []; }],
    ]) {
        const result = await gate(buffer, change);
        assert.equal(result.result, false); assert.equal(result.evidence, null);
    }
});
test('adaptive observation never survives cancellation or an HLS instance replacement', async () => {
    for (const change of [page => { page.isStalePlaybackAttempt = () => true; }, page => { page.hls = {}; }]) {
        const result = await gate(t => 6 + 4 * Math.floor(t / 400), (page, t) => { if (t >= 1000) change(page); });
        assert.equal(result.result, false); assert.equal(result.evidence, null);
    }
});
