'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
module.exports = function brokerHarness() {
    const source = fs.readFileSync(path.join(__dirname, '../../services/media-gateway/src/index.js'), 'utf8');
    const start = source.indexOf('// ── Strict LID loopback broker (mono-account provider barrier)');
    const end = source.indexOf('// ── End strict LID loopback broker', start);
    if (start < 0 || end < start) throw Error('BROKER_SOURCE_MISSING');
    return vm.runInNewContext(`(() => {${source.slice(start, end)};return {createStrictLidBroker};})()`, {
        AbortController, Buffer, Date, Error, Number, Object, Promise, String, URL,
        clearTimeout, setTimeout, setImmediate, fetch, console,
        crypto: require('node:crypto'), http: require('node:http'),
        undiciRequest: require('undici').request, Readable: require('node:stream').Readable,
        createStrictRangeCollector: require('../../services/media-gateway/src/strict-lid-range-reuse').createStrictRangeCollector,
        FFMPEG_USER_AGENT: 'Norva-Native-Index-Test/1', FINITE_MKV_SEEK_WINDOW_BYTES: 1024 * 1024,
        FINITE_MKV_SEEK_CACHE_BYTES: 64 * 1024 * 1024, PROVIDER_SLOT_RELEASE_DELAY_MS: 0,
        STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS: 30000, STRICT_LID_BROKER_IDLE_TIMEOUT_MS: 15000,
        VOD_INPUT_MAX_RECONNECTS: 4, VOD_INPUT_RETRY_DELAYS_MS: [0], VOD_INPUT_RETRY_LIMIT: 1,
        isHttpUrl: value => /^https?:\/\//.test(value), isProxyAuthenticationFailure: () => false,
        pickProxyAgent: () => null, proxyKeyFromUrl: () => 'native-test',
        strictLidBrokers: new Map(),
    });
};
