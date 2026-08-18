'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyProbeEvidence } = require('../scripts/fixture-verifier');

function video(overrides = {}) {
    return {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        level: 41,
        pix_fmt: 'yuv420p',
        width: 640,
        height: 360,
        avg_frame_rate: '24/1',
        r_frame_rate: '24/1',
        disposition: { attached_pic: 0, timed_thumbnails: 0, still_image: 0 },
        ...overrides,
    };
}

function audio(index, codec = 'aac', overrides = {}) {
    return {
        index,
        codec_type: 'audio',
        codec_name: codec,
        profile: codec === 'aac' ? 'LC' : undefined,
        channels: 2,
        ...overrides,
    };
}

function packets({ badTimestamps = false } = {}) {
    return [
        { stream_index: 0, pts: '0', dts: '-2', flags: 'K__' },
        { stream_index: 1, pts: '0', dts: '0', flags: 'K__' },
        { stream_index: 0, pts: '2', dts: '0', flags: '___' },
        { stream_index: 0, pts: '1', dts: '1', flags: '___' },
        { stream_index: 0, pts: '48', dts: badTimestamps ? '1' : '46', flags: 'K__' },
    ];
}

function probe(streams, options) {
    return { streams, packets: packets(options) };
}

test('the verifier attests the exact fixed stream shapes and negative properties', () => {
    const cases = [
        ['h264-closed-aac', probe([video(), audio(1)]), 2],
        ['h264-closed-ac3', probe([video(), audio(1, 'ac3', { channels: 6 })]), 2],
        ['h264-open-gop', probe([video(), audio(1)]), 1],
        ['h264-multi-audio', probe([
            video(),
            audio(1, 'aac', { channels: 1 }),
            audio(2, 'ac3', { channels: 1 }),
            audio(3, 'aac', { channels: 1 }),
        ]), 2],
        ['hevc-eac3-cold', probe([
            video({
                codec_name: 'hevc', profile: 'Main 10', level: 93, pix_fmt: 'yuv420p10le',
                width: 1280, height: 720,
            }),
            audio(1, 'eac3', { channels: 6 }),
        ]), null],
        ['h264-level52', probe([
            video({ level: 52, width: 1920, height: 1080, avg_frame_rate: '120/1', r_frame_rate: '120/1' }),
            audio(1),
        ]), 2],
        ['h264-bad-timestamps', probe([video(), audio(1)], { badTimestamps: true }), 2],
        ['h264-pgs', probe([
            video(),
            audio(1),
            { index: 2, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
        ]), 2],
        ['h264-no-etag', probe([video(), audio(1)]), 2],
        ['hevc-full-cache', probe([
            video({
                codec_name: 'hevc', profile: 'Main 10', level: 93, pix_fmt: 'yuv420p10le',
                width: 1280, height: 720,
            }),
            audio(1, 'eac3', { channels: 6 }),
        ]), null],
    ];

    for (const [id, evidence, idrPacketCount] of cases) {
        const attestation = verifyProbeEvidence(id, evidence, { idrPacketCount });
        assert.equal(attestation.protocol, 1, id);
        assert.equal(attestation.kind, 'norva-media-lab-fixture-attestation-v1', id);
        assert.equal(attestation.timestampDefectObserved, id === 'h264-bad-timestamps', id);
    }
});

test('the open and closed GOP assertions use packet keys versus true IDR count', () => {
    const evidence = probe([video(), audio(1)]);
    assert.throws(
        () => verifyProbeEvidence('h264-closed-aac', evidence, { idrPacketCount: 1 }),
        /closed-gop/,
    );
    assert.throws(
        () => verifyProbeEvidence('h264-open-gop', evidence, { idrPacketCount: 2 }),
        /open-gop/,
    );
});

test('the deliberately defective timestamp fixture fails if the muxer repaired its DTS', () => {
    assert.throws(
        () => verifyProbeEvidence('h264-bad-timestamps', probe([video(), audio(1)]), { idrPacketCount: 2 }),
        /timestamp-defect-missing/,
    );
    assert.throws(
        () => verifyProbeEvidence(
            'h264-closed-aac',
            probe([video(), audio(1)], { badTimestamps: true }),
            { idrPacketCount: 2 },
        ),
        /unexpected-timestamp-defect/,
    );
});

test('codec, profile, level, frame-rate, audio topology and PGS claims are fail-closed', () => {
    assert.throws(
        () => verifyProbeEvidence('hevc-eac3-cold', probe([
            video({ codec_name: 'hevc', profile: 'Main', pix_fmt: 'yuv420p', width: 1280, height: 720 }),
            audio(1, 'eac3', { channels: 6 }),
        ])),
        /video-profile/,
    );
    assert.throws(
        () => verifyProbeEvidence('h264-level52', probe([
            video({ level: 52, width: 1920, height: 1080, avg_frame_rate: '60/1', r_frame_rate: '60/1' }),
            audio(1),
        ]), { idrPacketCount: 2 }),
        /video-frame-rate/,
    );
    assert.throws(
        () => verifyProbeEvidence('h264-multi-audio', probe([video(), audio(1)]), { idrPacketCount: 2 }),
        /audio-count/,
    );
    assert.throws(
        () => verifyProbeEvidence('h264-pgs', probe([video(), audio(1)]), { idrPacketCount: 2 }),
        /subtitle-count/,
    );
});
