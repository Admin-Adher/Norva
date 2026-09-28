const test = require('node:test');
const assert = require('node:assert/strict');
const { codecProbeInputOptions } = require('../services/media-gateway/src/codec-probe-input-options');

test('remote probes tolerate HLS segment names while excluding local protocols', () => {
    for (const url of ['https://provider.example/stream?token=test', 'http://provider.example/movie.mp4']) {
        const options = codecProbeInputOptions(url);
        assert.equal(options[options.indexOf('-extension_picky') + 1], '0');
        const protocols = options[options.indexOf('-protocol_whitelist') + 1].split(',');
        for (const unsafe of ['file', 'data', 'concat', 'pipe']) assert.ok(!protocols.includes(unsafe));
        for (const required of ['https', 'http', 'httpproxy', 'crypto']) assert.ok(protocols.includes(required));
    }
});

test('local and malformed probes retain their existing input handling', () => {
    for (const url of ['/tmp/probe.mp4', 'file:///tmp/probe.mp4', 'pipe:0', 'not a URL']) {
        assert.deepEqual(codecProbeInputOptions(url), []);
    }
});
