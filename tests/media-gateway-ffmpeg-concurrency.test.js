'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const encoder = require('../services/media-gateway/src/video-encoder');
const { boundedHlsArgs } = require('../services/media-gateway/src/bounded-hls-output');
const { loopbackOutputEnv } = require('../services/media-gateway/src/hls-output-admission');

const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
const first = source.indexOf('function startFfmpeg(session) {');
const last = source.indexOf('\nfunction seekArgsForSession(', first);
assert.ok(first >= 0 && last > first);

function build({ encode = false, audioCopy = true, backend = 'vaapi', hardwareDecode = false,
    admitted = true } = {}) {
    const captured = new Error('captured before process creation');
    let args = null, released = 0, outputStopped = 0;
    const config = { backend, hardwareDecode, device: '/dev/dri/renderD128' };
    const context = { path, boundedHlsArgs, loopbackOutputEnv, ...encoder, VIDEO_ENCODER_CONFIG: config,
        FFMPEG_PATH: 'ffmpeg', FFMPEG_USER_AGENT: 'test',
        multiAudioHlsEnabled: () => false, exactSubtitleHlsEnabled: () => false,
        inputProbeArgsForSession: () => ['-analyzeduration', '500000', '-probesize', '524288'],
        shouldCopyAudio: () => audioCopy,
        audioArgsForSession: () => audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'],
        audioMapForSession: () => '0:1', normalizeAudioStreamIndex: Number,
        videoModeForSession: () => encode ? 'encode' : 'copy',
        vaapiHardwareDecodeCodecForSession: () => hardwareDecode ? 'h264' : null,
        reserveVideoEncoderAdmission: () => admitted, releaseVideoEncoderAdmission: () => { released++; },
        usesFiniteMkvSeekBroker: () => false, isFiniteMkvVodSession: () => false,
        finiteMkvLinearSeekBridgePlanForSession: () => null,
        usesSourceTimestampedCopySeek: () => false,
        seekArgsForSession: () => ({ preInputSeek: [], postInputSeek: [] }),
        isLiveHlsSession: () => false, isLiveSession: () => false,
        appendSubtitleOutputs: () => {},
        spawn: (_bin, value) => { args = Array.from(value); throw captured; },
    };
    const run = vm.runInNewContext(`(${source.slice(first, last)})`, context);
    const session = { outputDir: '/private/test', playlistPath: '/private/test/playlist.m3u8',
        retainedVodStartupFormat: 'mp4', fastInputProbe: true, boundedHlsOutput: true,
        hlsOutputAdmission: { urlFor: name => `http://127.0.0.1:12345/test/${name}`, stop: () => { outputStopped++; } },
        startupTimings: {}, hlsTargetSeconds: 4 };
    let error;
    try { run(session); } catch (value) { error = value; }
    if (admitted) assert.equal(error, captured);
    else assert.equal(error?.code, 'VIDEO_ENCODER_CAPACITY_BUSY');
    return { args, released, outputStopped };
}

for (const variant of [
    { name: 'full copy' },
    { name: 'audio conversion', audioCopy: false },
    { name: 'VAAPI decode and encode', encode: true, hardwareDecode: true, audioCopy: false },
    { name: 'software decode with VAAPI encode', encode: true, audioCopy: false },
    { name: 'software video encode', encode: true, backend: 'software', audioCopy: false },
]) {
    test(`${variant.name} bounds filter pools while preserving codec, maps and HLS output`, () => {
        const { args, released, outputStopped } = build(variant);
        const option = name => args[args.indexOf(name) + 1];
        assert.equal(option('-filter_threads'), '1');
        assert.equal(option('-filter_complex_threads'), '1');
        assert.equal(option('-threads:a'), '1');
        assert.equal(option('-c:v'), variant.encode ? variant.backend === 'software' ? 'libx264' : 'h264_vaapi' : 'copy');
        assert.equal(option('-c:a'), variant.audioCopy === false ? 'aac' : 'copy');
        assert.deepEqual(args.flatMap((value, index) => value === '-map' ? [args[index + 1]] : []), ['0:V:0', '0:1']);
        assert.equal(option('-hls_time'), '4');
        assert.equal(option('-hls_list_size'), '64');
        assert.equal(option('-hls_flags'), 'independent_segments+delete_segments');
        assert.equal(option('-method'), 'PUT');
        assert.equal(option('-http_persistent'), '0');
        assert.equal(args.at(-1), 'http://127.0.0.1:12345/test/playlist.m3u8');
        assert.equal(option('-i'), 'pipe:0');
        const inputThreads = args.slice(0, args.indexOf('-i')).includes('-threads');
        assert.equal(inputThreads, !variant.encode || variant.hardwareDecode === true);
        if (variant.encode && variant.backend !== 'software') assert.equal(option('-qp'), '23');
        assert.equal(released, 1, 'a failed spawn still releases the encoder admission');
        assert.equal(outputStopped, 1, 'a failed spawn also stops the output admission');
    });
}

test('encoder capacity denial cannot spawn any process', () => {
    const { args, released } = build({ encode: true, admitted: false });
    assert.equal(args, null); assert.equal(released, 0);
});
