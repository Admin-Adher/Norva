'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
const retrySource = source.slice(source.indexOf('async function startSessionWithProviderRetry('),
    source.indexOf('\nfunction normalizeFileSizeBytes('));
const invalid = () => Object.assign(new Error('Invalid H.264 prefix'), { code: 'LIVE_TS_STARTUP_INVALID' });

function fixture({ live = true, failure = invalid, rejected = 3, abortAt = '', failEncode = false,
    releaseFailed = false } = {}) {
    const events = [], controller = new AbortController();
    let active = 0, maxActive = 0;
    const session = { status: 'starting', mode: 'remux', outputDir: '/fixture', startupTimings: {},
        liveTsStartupGate: { snapshot: () => ({ rejected }) } };
    const run = vm.runInNewContext(`(${retrySource})`, {
        BOUNDED_HLS_OUTPUT_ENABLED: false, HLS_OUTPUT_SESSION_MAX_BYTES: 1,
        STARTUP_TIMEOUT_MS: 100, PROVIDER_SLOT_RELEASE_DELAY_MS: 250,
        isLiveSession: () => live, videoModeForSession: s => s.videoMode || 'copy',
        prepareWeakAuthoritativeSpool: async () => {},
        startFfmpeg: s => { events.push(`start:${s.videoMode || 'copy'}`); active++; maxActive = Math.max(active, maxActive); return { exitCode: null, signalCode: null }; },
        waitForPlaylist: async s => { if (s.videoMode !== 'encode' || failEncode) throw failure(); events.push('ready'); },
        stopBoundedMkvInputPump: async () => events.push('pump-stop'),
        stopFiniteMkvLinearSeekBridge: async () => {},
        stopChildProcess: async child => { events.push('producer-joined'); if (!releaseFailed) { active--; child.exitCode = 0; } if (abortAt === 'stop') controller.abort(); },
        waitForVodInputRetry: async () => { events.push('release-wait'); if (abortAt === 'wait') controller.abort(); return !controller.signal.aborted; },
        removeSessionDir: async () => events.push('remove-output'), fsp: { mkdir: async () => {} },
        abortedVodInputPumpError: () => Object.assign(new Error('Stopped'), { name: 'AbortError' }),
        applyFiniteMkvSeekBrokerFailure: () => false, isVaapiHardwareDecodeFailure: () => false,
        console: { warn() {} },
    });
    return { session, events, controller, run: () => run(session, controller.signal), maxActive: () => maxActive };
}

test('proven invalid Live prefix serializes one encoder fallback after producer release', async () => {
    const f = fixture();
    assert.equal(await f.run(), true);
    assert.deepEqual(f.events, ['start:copy', 'pump-stop', 'producer-joined', 'release-wait',
        'remove-output', 'start:encode', 'ready']);
    assert.equal(f.maxActive(), 1);
    assert.equal(f.session.startupTimings.liveTsStartupFallback, 'invalid-h264-prefix');
    assert.equal(f.session.status, 'ready');
});

test('an invalid encoder output cannot trigger a second fallback', async () => {
    const f = fixture({ failEncode: true });
    assert.equal(await f.run(), false);
    assert.equal(f.events.filter(event => event.startsWith('start:')).length, 2);
    assert.equal(f.maxActive(), 1);
});

test('a stop failure cannot overlap a still running provider producer', async () => {
    const f = fixture({ releaseFailed: true });
    await assert.rejects(f.run(), { code: 'LIVE_TS_STARTUP_RELEASE_FAILED' });
    assert.deepEqual(f.events, ['start:copy', 'pump-stop', 'producer-joined']);
    assert.equal(f.maxActive(), 1);
});

test('cancellation during old producer cleanup never starts a replacement', async () => {
    for (const abortAt of ['stop', 'wait']) {
        const f = fixture({ abortAt });
        await assert.rejects(f.run(), { name: 'AbortError' });
        assert.equal(f.events.filter(event => event.startsWith('start:')).length, 1);
    }
});

test('VOD, insufficient evidence and network errors do not gain a video fallback', async () => {
    for (const options of [{ live: false }, { rejected: 2 },
        { failure: () => new Error('Playlist timeout') },
        { failure: () => Object.assign(new Error('Provider refusal'), { code: 'HTTP_458' }) }]) {
        const f = fixture(options);
        assert.equal(await f.run(), false);
        assert.deepEqual(f.events, ['start:copy']);
        assert.equal(f.session.videoMode, undefined);
    }
});
