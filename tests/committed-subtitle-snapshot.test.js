'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { committedSubtitleSnapshot: snapshot, adler32, MAX_BYTES } = require('../services/media-gateway/src/committed-subtitle-snapshot');
const header = '#tb 0: 1/1000000\n#media_type 0: subtitle\n#codec_id 0: webvtt\n';
const line = (start, duration, text) => `0, ${start * 1000000}, ${start * 1000000}, ${duration * 1000000}, ${Buffer.byteLength(text)}, 0x${adler32(Buffer.from(text)).toString(16).padStart(8, '0')}\n`;
const vtt = Buffer.from('WEBVTT\n\n00:01.000 --> 00:03.000\nFirst\n\n00:09.000 --> 00:12.000\nFuture one\nsecond line\n');
const journal = Buffer.from(header + line(1, 2, 'First') + line(9, 3, 'Future one\nsecond line'));
test('publishes a complete future packet while the producer is still open, without claiming coverage', () => {
    assert.equal(adler32(Buffer.from('First')), 0x05b20208); // FFmpeg receipt
    const got = snapshot(vtt, journal);
    assert.deepEqual(got.cues, [{ start: 1, end: 3, text: 'First' }, { start: 9, end: 12, text: 'Future one\nsecond line' }]);
    assert.equal(got.timeCoverage, false);
    assert.equal(got.complete, false);
});
test('every byte cut of the WebVTT before the committed payload fails closed', () => {
    for (let cut = 0; cut < vtt.length - 1; cut++) assert.equal(snapshot(vtt.subarray(0, cut), journal), null, `cut ${cut}`);
});
test('a missing/partial journal record never publishes the future packet', () => {
    for (let cut = Buffer.byteLength(header + line(1, 2, 'First')); cut < journal.length; cut++) {
        const got = snapshot(vtt, journal.subarray(0, cut));
        assert.equal(got.cues.length, 1, `cut ${cut}`);
    }
});
test('uncommitted trailing WebVTT bytes are not published', () => {
    const firstOnly = Buffer.from(header + line(1, 2, 'First'));
    assert.equal(snapshot(vtt, firstOnly).cues.length, 1);
    assert.equal(snapshot(Buffer.concat([vtt, Buffer.from('\npartial\n00:30.000 -->')]), journal).cues.length, 2);
});
for (const [name, change] of [
    ['payload', b => b.toString().replace('First', 'Worst')],
    ['timestamp', b => b.toString().replace('00:01.000', '00:01.001')],
    ['duration', b => b.toString().replace('00:03.000', '00:04.000')],
    ['wrong file', () => 'WEBVTT\n\n00:00.000 --> 00:01.000\nElsewhere\n'],
]) test(`rejects a mismatching ${name}`, () => assert.equal(snapshot(Buffer.from(change(vtt)), journal), null));
for (const [name, change] of [
    ['clock', b => b.toString().replace('1/1000000', '1/1000')],
    ['zero clock', b => b.toString().replace('1/1000000', '1/0')],
    ['codec', b => b.toString().replace('webvtt', 'subrip')],
    ['type', b => b.toString().replace('subtitle', 'video')],
    ['checksum', b => b.toString().replace('0x05b20208', '0x05b20209')],
    ['size', b => b.toString().replace(', 5,', ', 6,')],
    ['extra clock', b => b.toString() + '#tb 1: 1/1000000\n'],
    ['unsupported side data', b => b.toString().replace('0x05b20208\n', '0x05b20208, S=1, 0\n')],
]) test(`rejects a mismatching ${name} journal`, () => assert.equal(snapshot(vtt, Buffer.from(change(journal))), null));
test('rejects bad UTF8 and bounds both files', () => {
    for (const bad of [null, Buffer.from([0xff]), Buffer.alloc(MAX_BYTES + 1)]) {
        assert.equal(snapshot(bad, journal), null); assert.equal(snapshot(vtt, bad), null);
    }
});
test('preserves UTF8, simultaneous cues, crossing intervals, identifiers and cue settings', () => {
    const bytes = Buffer.from('WEBVTT\n\nfirst-id\n00:01.000 --> 00:13.000 line:90%\nété &amp; <i>text</i>\n\n00:01.000 --> 00:02.000\nother\n');
    const got = snapshot(bytes, Buffer.from(header + line(1, 12, 'été &amp; <i>text</i>') + line(1, 1, 'other')));
    assert.equal(got.cues.length, 2); assert.equal(got.cues[0].end, 13);
    assert.equal(got.cues[0].text, 'été &amp; <i>text</i>'); assert.equal(got.cues[0].id, 'first-id');
    assert.equal(got.cues[0].settings, 'line:90%');
});
