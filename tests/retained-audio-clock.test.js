'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { retainedSubtitleClock } = require('../services/media-gateway/src/retained-subtitle-clock');
const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
const args = source.slice(source.indexOf('const TRANSCODE_AUDIO_ARGS = ['), source.indexOf('\n];', source.indexOf('const TRANSCODE_AUDIO_ARGS = [')) + 3);
const fn = source.slice(source.indexOf('function audioArgsForSession('), source.indexOf('\nfunction audioModeForSession('));
const context = vm.createContext({ retainedSubtitleClock, shouldCopyAudio: () => false });
vm.runInContext(args + '\n' + fn + '\nthis.audio = audioArgsForSession; this.original = TRANSCODE_AUDIO_ARGS;', context);
const retained = { retainedRequestBinding: 'admitted', exactSubtitleHls: { enabled: true } };

test('retained source-clock AAC preserves the input origin instead of padding silence from zero', () => {
    const actual = Array.from(context.audio(retained, false));
    assert.equal(actual[actual.indexOf('-af') + 1], 'aresample=48000:async=1');
    assert.equal(actual[actual.indexOf('-profile:a') + 1], 'aac_low');
    assert.equal(actual[actual.indexOf('-ar') + 1], '48000');
    assert.equal(actual[actual.indexOf('-ac') + 1], '2');
    assert.equal(actual[actual.indexOf('-b:a') + 1], '160k');
    assert.equal(context.original[1], 'aresample=48000:async=1:first_pts=0');
});

test('ordinary, multi-audio and complete-cache graphs retain their existing AAC policy', () => {
    for (const overrides of [{ retainedRequestBinding: null }, { exactSubtitleHls: { enabled: false } },
        { multiAudioHls: { enabled: true } }, { mediaCacheProducer: {} }, { completeHlsCacheLease: {} }]) {
        const actual = Array.from(context.audio({ ...retained, ...overrides }, false));
        assert.equal(actual[actual.indexOf('-af') + 1], 'aresample=48000:async=1:first_pts=0');
    }
    assert.deepEqual(Array.from(context.audio(retained, true)), ['-c:a', 'copy']);
});
