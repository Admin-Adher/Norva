const test = require('node:test'), assert = require('node:assert/strict');
const { retainedSubtitleClock, retainedSubtitleClockArgs, SOURCE_CLOCK } = require('../services/media-gateway/src/retained-subtitle-clock');
const { privateResumeProfile } = require('../services/media-gateway/src/private-resume-profile');
const { captureSubtitleWindow } = require('../services/media-gateway/src/private-resume-subtitles');

test('only the admitted retained exact-subtitle producer changes its mux clock', () => {
    const admitted = { retainedRequestBinding: 'signed-owner-binding', exactSubtitleHls: { enabled: true } };
    assert.equal(retainedSubtitleClock(admitted), true);
    for (const change of [{ retainedRequestBinding: null }, { exactSubtitleHls: { enabled: false } },
        { multiAudioHls: { enabled: true } }, { mediaCacheProducer: {} }, { completeHlsCacheLease: {} }])
        assert.equal(retainedSubtitleClock({ ...admitted, ...change }), false);
    assert.equal(retainedSubtitleClock(null), false);
    assert.deepEqual(retainedSubtitleClockArgs(false), []);
    const args = retainedSubtitleClockArgs(true);
    assert.equal(args[args.indexOf('-hls_segment_options') + 1], 'mpegts_copyts=1:avoid_negative_ts=disabled');
});

test('a source-clock HLS window never shares the old mux-clock cache key', () => {
    const input = { format: 'mkv', audio: { index: 1 }, encoder: 'software', subtitles: [{ streamIndex: 2 }] };
    const legacy = privateResumeProfile(input);
    assert.equal(legacy, privateResumeProfile({ ...input, subtitleClock: undefined }));
    assert.notEqual(legacy, privateResumeProfile({ ...input, subtitleClock: SOURCE_CLOCK }));
    assert.equal(privateResumeProfile({ ...input, subtitleClock: 'guessed-offset' }), null);
    const sourceClock = { ...input, subtitleClock: SOURCE_CLOCK };
    const absolute = privateResumeProfile({ ...sourceClock, subtitleInputClock: 'absolute-v1' });
    assert.ok(absolute);
    assert.notEqual(absolute, privateResumeProfile(sourceClock));
    const alignedAudio = privateResumeProfile({ ...sourceClock, subtitleInputClock: 'absolute-v2' });
    assert.ok(alignedAudio);
    assert.notEqual(alignedAudio, absolute, 'zero-padded AAC windows cannot match the aligned graph');
    assert.equal(privateResumeProfile({ ...input, subtitleInputClock: 'absolute-v2' }), null);
    assert.equal(privateResumeProfile({ ...sourceClock, subtitleInputClock: 'guessed' }), null);
    assert.equal(privateResumeProfile({ ...input, subtitleInputClock: 'absolute-v1' }), null);
});

test('source-clock cache preserves full cue timestamps without adding video priming', async () => {
    const rendition = { playlistName: 'subtitle_0.m3u8' };
    const readAsset = async n => n.endsWith('.m3u8')
        ? Buffer.from('#EXTM3U\n#EXTINF:150,\nsubtitle_0-00001.vtt\n')
        : Buffer.from('WEBVTT\n\n00:40.023 --> 00:45.023\nCrossing\n\n02:00.023 --> 02:05.023\nFuture\n');
    for (const prefix of ['resume', 'continuation']) {
        const graph = await captureSubtitleWindow({ renditions: [rendition], readAsset, sourcePesClock: true, prefix,
            videoSegments: [{ name: 'v.ts', start: 42, end: 44, duration: 2 }] });
        assert.ok(graph);
        const payload = [...graph.assets.values()][0].toString();
        assert.match(payload, /MPEGTS:0\n/);
        assert.match(payload, /00:40.023 --> 00:45.023/);
        assert.doesNotMatch(payload, /Future/);
    }
    assert.equal(await captureSubtitleWindow({ renditions: [rendition], readAsset,
        sourcePesClock: 1, videoSegments: [{ name: 'v.ts', start: 42, end: 44, duration: 2 }] }), null);
});
