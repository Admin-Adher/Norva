'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
const helperStart = source.indexOf('function isLiveHlsSession(');
const helperEnd = source.indexOf('\n// An H.264 stream', helperStart);
const context = vm.createContext({
    path, URL,
    asRecord: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
    FFMPEG_USER_AGENT: 'Norva input test',
    STRICT_LID_FFMPEG_RW_TIMEOUT_US: 90000000,
});
assert.ok(helperStart >= 0 && helperEnd > helperStart);
vm.runInContext(source.slice(helperStart, helperEnd), context);
const argsStart = source.indexOf('    const providerHttpInputArgs =', source.indexOf('function startFfmpeg('));
const argsEnd = source.indexOf('\n    const args =', argsStart);
assert.ok(argsStart >= 0 && argsEnd > argsStart);

function inputArgs(session, { pumpedMkvInput = false, seekableMkvInput = false } = {}) {
    Object.assign(context, { session, pumpedMkvInput, seekableMkvInput });
    return JSON.parse(JSON.stringify(vm.runInContext(`(() => {${source.slice(argsStart, argsEnd)}; return providerHttpInputArgs;})()`, context)));
}
function option(args, name) {
    const i = args.indexOf(name);
    return i < 0 ? null : args[i + 1];
}

test('live HLS honors completed HTTP responses for named and opaque playlist URLs', () => {
    for (const session of [
        { sourceUrl: 'https://example.test/direct.M3U8?token=test', playbackHint: { streamType: 'live' } },
        { sourceUrl: 'https://example.test/opaque', playbackHint: { streamType: 'live', container: 'm3u8' } },
        { sourceUrl: 'https://example.test/opaque', playbackHint: { item_type: 'channel' }, codecProfile: { container: 'hls' } },
        { sourceUrl: 'https://example.test/live.m3u8', playbackHint: {} },
    ]) {
        const args = inputArgs(session);
        assert.equal(option(args, '-reconnect_at_eof'), '0');
        assert.equal(option(args, '-reconnect'), '1', 'unexpected disconnects retain their existing recovery');
        assert.equal(option(args, '-reconnect_streamed'), '1');
        assert.equal(option(args, '-rw_timeout'), '15000000');
        assert.equal(option(args, '-reconnect_on_http_error'), null, 'HTTP refusals remain terminal');
    }
});

test('continuous TS live and explicit VOD preserve their existing input policy', () => {
    for (const session of [
        { sourceUrl: 'https://example.test/live.ts', playbackHint: { streamType: 'live', container: 'ts' } },
        { sourceUrl: 'https://example.test/opaque', playbackHint: { streamType: 'live' } },
        { sourceUrl: 'https://example.test/movie.m3u8', playbackHint: { streamType: 'movie', container: 'm3u8' } },
        { sourceUrl: 'https://example.test/file.mp4', playbackHint: { streamType: 'movie', container: 'mp4' } },
        { sourceUrl: 'invalid', playbackHint: { streamType: 'live' } },
    ]) assert.equal(option(inputArgs(session), '-reconnect_at_eof'), '1');
});

test('Matroska pump and finite broker input remain separate from live HTTP recovery', () => {
    const session = { sourceUrl: 'https://example.test/movie.mkv', playbackHint: { streamType: 'movie', container: 'mkv' } };
    assert.deepEqual(inputArgs(session, { pumpedMkvInput: true }), []);
    assert.deepEqual(inputArgs(session, { seekableMkvInput: true }), ['-seekable', '1', '-rw_timeout', '90000000']);
});
