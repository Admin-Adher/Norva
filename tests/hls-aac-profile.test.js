'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the parser shipped to browsers, not a duplicate of the ADTS logic.
// The npm bundle keeps this small parser in one function with no nested funcs.
function bundledAudioConfig(file) {
    const bundle = fs.readFileSync(path.join(__dirname, '../public/js/vendor', file), 'utf8');
    const marker = bundle.indexOf('invalid ADTS sampling index:');
    assert.ok(marker > 0);
    const start = bundle.lastIndexOf('function(', marker);
    const body = bundle.indexOf('{', start);
    let depth = 1, end = body + 1;
    for (; depth && end < bundle.length; end++) {
        if (bundle[end] === '{') depth++;
        if (bundle[end] === '}') depth--;
    }
    assert.equal(depth, 0);
    const events = { ERROR: 'error' }, types = { MEDIA_ERROR: 'media' }, details = { FRAG_PARSING_ERROR: 'parse' };
    return vm.runInNewContext(`(${bundle.slice(start, end)})`, {
        navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36' },
        me: { log() {} }, w: { log() {} }, G: events, S: events, U: types, L: types, B: details, A: details,
    });
}

const parse = bundledAudioConfig('hls-1.7.3.min.js');
const oldParse = bundledAudioConfig('hls-1.5.7.min.js');
function header(index = 3, channels = 2) {
    return Uint8Array.from([0xff, 0xf1, 0x40 | (index << 2) | (channels >> 2), (channels & 3) << 6, 0, 0, 0]);
}

test('the former Chrome path falsely signaled HE-AAC for the Gateway AAC-LC stereo output', () => {
    assert.equal(oldParse({ emit() {} }, header(), 0, undefined).codec, 'mp4a.40.5');
    const actual = parse({ emit() {} }, header(), 0, undefined);
    assert.equal(actual.codec, 'mp4a.40.2');
    assert.equal(actual.samplerate, 48000);
    assert.equal(actual.channelCount, 2);
    assert.deepEqual(Array.from(actual.config), [0x11, 0x90]);
});

test('AAC-LC profile follows source headers for mono, stereo and surround without browser guesses', () => {
    for (const channels of [1, 2, 6]) {
        for (const [index, rate] of [[3, 48000], [4, 44100], [6, 24000]]) {
            const actual = parse({ emit() {} }, header(index, channels), 0, undefined);
            assert.equal(actual.codec, 'mp4a.40.2');
            assert.equal(actual.channelCount, channels);
            assert.equal(actual.samplerate, rate);
        }
    }
});

test('invalid ADTS sample rates fail instead of configuring a guessed decoder', () => {
    const errors = [];
    assert.equal(parse({ emit(...args) { errors.push(args); } }, header(15), 0, undefined), undefined);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][2].fatal, true);
});
