const test = require('node:test'), assert = require('node:assert/strict');
const { privateResumeProfile } = require('../services/media-gateway/src/private-resume-profile');
test('enriching intrinsic file metadata does not orphan an identity-revalidated window', () => {
    const first = { format: 'mpegts', audio: { index: 1, codec: 'aac' }, encoder: 'vaapi' };
    assert.equal(privateResumeProfile(first), privateResumeProfile({ ...first,
        audio: { index: 1, codec: 'aac', channels: 2, sampleRate: 48000 }, width: 1920,
        audioMode: 'auto', clientAudioPassthrough: true }));
    for (const change of [{ audio: { index: 2 } }, { audioMode: 'transcode' },
        { clientAudioPassthrough: false }, { encoder: 'software' }, { format: 'mkv' },
        { subtitles: [{ streamIndex: 3 }] }])
        assert.notEqual(privateResumeProfile(first), privateResumeProfile({ ...first, ...change }));
    assert.equal(privateResumeProfile({ ...first, audio: {} }), null);
    assert.equal(privateResumeProfile({ ...first, audioMode: 'unknown' }), null);
});
