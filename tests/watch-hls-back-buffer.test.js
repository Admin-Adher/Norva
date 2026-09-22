'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Hls = require('../public/js/vendor/hls-1.5.7.min.js');

const source = fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8');

function watchPrototype(globals = {}) {
    const context = { window: {}, console, setTimeout, clearTimeout, ...globals };
    vm.runInNewContext(source, context, { filename: 'WatchPage.js' });
    return context.window.WatchPage.prototype;
}

function ranges(entries) {
    return { length: entries.length, start: i => entries[i][0], end: i => entries[i][1] };
}

function gatewayPage() {
    const page = Object.create(watchPrototype());
    Object.assign(page, {
        currentPlaybackMode: 'gateway-session',
        streamStartOffset: 0,
        contentType: 'movie',
        content: { sourceId: 'source-1', id: 'movie-1', type: 'movie' },
        hls: {},
        video: {
            currentTime: 600, duration: 1200, ended: false,
            seekable: ranges([[0, 1200]]), buffered: ranges([[570, 720]]),
        },
        getDisplayDuration: () => 1200,
        getValidDuration: () => 1200,
        updateDurationState() {},
    });
    return page;
}

// Capture the actual options passed by playHls, before attaching media or
// opening any network connection. The real vendored controller consumes them.
function watchHlsConfig(url) {
    let config;
    const captured = new Error('constructor options captured');
    class CaptureHls {
        constructor(options) { config = options; throw captured; }
    }
    const page = Object.create(watchPrototype({ Hls: CaptureHls }));
    page.isGatewayPlaybackUrl = value => value.startsWith('/gateway/');
    assert.throws(() => page.playHls(url), error => error === captured);
    return config;
}

test('WatchPage bounds HLS rewind retention while preserving each forward-buffer policy', () => {
    for (const [url, forward, maximum] of [
        ['/gateway/session/master.m3u8', 120, 600],
        ['/api/transcode/session/master.m3u8', 120, 600],
        ['https://example.invalid/movie.m3u8', 30, 60],
    ]) {
        const config = watchHlsConfig(url);
        assert.equal(config.backBufferLength, 30);
        assert.equal(config.maxBufferLength, forward);
        assert.equal(config.maxMaxBufferLength, maximum);
    }
});

test('delivered Hls 1.5.7 trims audio and video at a simulated two-hour position, growing and completed VOD', () => {
    assert.equal(Hls.version, '1.5.7');
    assert.equal(Hls.DefaultConfig.backBufferLength, Infinity);
    for (const live of [true, false]) {
        const events = [];
        const controller = new Hls.DefaultConfig.bufferController({
            config: { ...Hls.DefaultConfig, ...watchHlsConfig('/gateway/session/master.m3u8') },
            on() {}, off() {}, trigger: (event, data) => events.push({ event, data }),
        });
        controller.media = { currentTime: 7203 };
        controller.details = { live, levelTargetDuration: 4 };
        controller.sourceBuffer = {
            audio: { buffered: ranges([[0, 7323]]), ended: false },
            video: { buffered: ranges([[0, 7323]]), ended: false },
        };
        controller.onFragChanged();
        const flushes = events.filter(item => item.event === Hls.Events.BUFFER_FLUSHING);
        assert.equal(flushes.length, 2);
        assert.deepEqual(flushes.map(item => item.data.type).sort(), ['audio', 'video']);
        for (const { data } of flushes) {
            assert.equal(data.startOffset, 0);
            assert.equal(data.endOffset, 7170);
        }
    }
});

test('delivered Hls retains at least a target duration for long segments', () => {
    const flushes = [];
    const controller = new Hls.DefaultConfig.bufferController({
        config: { ...Hls.DefaultConfig, ...watchHlsConfig('/gateway/session/master.m3u8') },
        on() {}, off() {}, trigger: (event, data) => {
            if (event === Hls.Events.BUFFER_FLUSHING) flushes.push(data);
        },
    });
    controller.media = { currentTime: 7203 };
    controller.details = { live: true, levelTargetDuration: 60 };
    controller.sourceBuffer = { video: { buffered: ranges([[0, 7323]]), ended: false } };
    controller.onFragChanged();
    assert.equal(flushes[0].endOffset, 7140);
});

test('active Gateway seeks restart evicted media despite a full seekable timeline', async () => {
    const page = gatewayPage();
    const restarted = [];
    page.restartCloudGatewayStreamAt = async target => restarted.push(target);
    assert.equal(page.isLocalSeekTargetAvailable(120), false);
    await page.seekToTime(120, { immediate: true });
    assert.deepEqual(restarted, [120]);
    assert.equal(page.video.currentTime, 600);
});

test('retained Gateway media stays local even when seekable is empty', async () => {
    const page = gatewayPage();
    page.video.seekable = ranges([]);
    page.restartCloudGatewayStreamAt = async () => assert.fail('buffered rewind must stay local');
    await page.seekToTime(590, { immediate: true });
    assert.equal(page.video.currentTime, 590);
});

test('Gateway buffer membership uses local time while a new session uses the absolute target', async () => {
    const page = gatewayPage();
    page.streamStartOffset = 900;
    page.video.buffered = ranges([[30, 150]]);
    const restarted = [];
    page.restartCloudGatewayStreamAt = async target => restarted.push(target);
    await page.seekToTime(960, { immediate: true });
    assert.equal(page.video.currentTime, 60);
    await page.seekToTime(920, { immediate: true });
    assert.deepEqual(restarted, [920]);
});

test('Gateway gaps, removed edges, absent and mutating ranges cannot be treated as retained media', () => {
    const page = gatewayPage();
    page.video.buffered = ranges([[30, 60], [90, 150]]);
    for (const target of [29.9, 60, 75, 89.9, 150, 150.1]) {
        assert.equal(page.isLocalSeekTargetAvailable(target), false, `target ${target}`);
    }
    for (const target of [30, 59.9, 90, 149.9]) {
        assert.equal(page.isLocalSeekTargetAvailable(target), true, `target ${target}`);
    }
    for (const buffered of [undefined, ranges([]), ranges([[NaN, Infinity]]), {
        length: 1, start() { throw new Error('TimeRanges changed'); }, end: () => 1200,
    }]) {
        page.video.buffered = buffered;
        assert.equal(page.isLocalSeekTargetAvailable(590), false);
    }
    Object.defineProperty(page.video, 'buffered', { get() { throw new Error('detached'); } });
    assert.equal(page.isLocalSeekTargetAvailable(590), false);
});

test('ended Gateway sessions restart even if their stale buffer still contains the target', () => {
    const page = gatewayPage();
    page.video.ended = true;
    assert.equal(page.canRestartForSeek(590), true);
    page.video.ended = false;
    page._playbackEnded = true;
    assert.equal(page.canRestartForSeek(590), true);
});

test('direct playback with native HLS or Hls.js preserves seekable fallback outside the current buffer', async () => {
    for (const [mode, hls] of [['direct', null], ['direct-hls', {}], ['direct-hls', null]]) {
        const page = gatewayPage();
        page.currentPlaybackMode = mode;
        page.hls = hls;
        page.restartCloudGatewayStreamAt = async () => assert.fail('existing direct/native seek must stay local');
        assert.equal(page.isLocalSeekTargetAvailable(120), true);
        await page.seekToTime(120, { immediate: true });
        assert.equal(page.video.currentTime, 120);
    }
});

test('native Gateway HLS also restarts evicted targets and keeps buffered seeks local', async () => {
    const page = gatewayPage();
    page.hls = null;
    const restarted = [];
    page.restartCloudGatewayStreamAt = async target => restarted.push(target);
    await page.seekToTime(120, { immediate: true });
    assert.deepEqual(restarted, [120]);
    assert.equal(page.video.currentTime, 600);
    await page.seekToTime(590, { immediate: true });
    assert.equal(page.video.currentTime, 590);
    assert.deepEqual(restarted, [120]);
});

test('an evicted Gateway seek still uses the existing scheduled-seek path', async () => {
    const page = gatewayPage();
    const scheduled = [];
    page.scheduleProcessedSeek = (...args) => scheduled.push(args);
    page.restartCloudGatewayStreamAt = async () => assert.fail('non-immediate seek must remain scheduled');
    await page.seekToTime(120);
    assert.deepEqual(scheduled, [[120, 1200]]);
});
