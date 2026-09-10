const assert = require('node:assert/strict');
const test = require('node:test');
const {
    MAX_WAV_BYTES, MAX_AUDIO_SECONDS, MAX_WAV_CHUNKS, MAX_VAD_SEGMENTS, PCM_SAMPLE_RATE,
    parsePcm16Wav, analyzePcm16Wav, selectSpeechWindow, cropPcm16Wav, createStrictLidAudioDiagnostic,
} = require('../services/media-gateway/src/strict-lid-audio-evidence');

function chunk(name, bytes) {
    const result = Buffer.alloc(8 + bytes.length + bytes.length % 2);
    result.write(name, 0, 'ascii');
    result.writeUInt32LE(bytes.length, 4);
    bytes.copy(result, 8);
    return result;
}

function wave(samples, { before = [], after = [], extended = false, changeFormat = null } = {}) {
    const format = Buffer.alloc(extended ? 18 : 16);
    format.writeUInt16LE(1, 0);
    format.writeUInt16LE(1, 2);
    format.writeUInt32LE(PCM_SAMPLE_RATE, 4);
    format.writeUInt32LE(PCM_SAMPLE_RATE * 2, 8);
    format.writeUInt16LE(2, 12);
    format.writeUInt16LE(16, 14);
    if (changeFormat) changeFormat(format);
    const pcm = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(samples[i], i * 2);
    const chunks = [chunk('fmt ', format), ...before, chunk('data', pcm), ...after];
    const result = Buffer.alloc(12 + chunks.reduce((sum, part) => sum + part.length, 0));
    result.write('RIFF', 0, 'ascii');
    result.writeUInt32LE(result.length - 8, 4);
    result.write('WAVE', 8, 'ascii');
    let offset = 12;
    for (const part of chunks) { part.copy(result, offset); offset += part.length; }
    return result;
}

function errorCode(code) {
    return (error) => error.code === code && error.message === code;
}

test('PCM analysis measures real PCM data duration, not WAV metadata/file size', () => {
    const buffer = wave(new Int16Array(PCM_SAMPLE_RATE).fill(16384), {
        before: [chunk('LIST', Buffer.from('INFO metadata which must not leak')), chunk('JUNK', Buffer.from([1, 2, 3]))],
        after: [chunk('bext', Buffer.alloc(602))],
    });
    const parsed = parsePcm16Wav(buffer);
    const result = analyzePcm16Wav(buffer);
    assert.equal(parsed.chunkCount, 5);
    assert.equal(parsed.dataBytes, 32000);
    assert.ok(buffer.length > parsed.dataBytes + 44);
    assert.equal(result.durationSeconds, 1);
    assert.equal(result.sampleCount, 16000);
    assert.equal(result.silentSampleRatio, 0);
    assert.equal(result.clippedSampleRatio, 0);
    assert.ok(Math.abs(result.peakDbfs + 6.020599913279624) < 1e-10);
    assert.equal(result.peakDbfs, result.rmsDbfs);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(result));
    assert.ok(!JSON.stringify(result).includes('metadata'));
    assert.equal(result.speechSeconds, undefined);
    assert.equal(result.speechRatio, undefined);
});

test('exact digital silence has null dBFS and cannot be labeled as no speech from energy', () => {
    const result = analyzePcm16Wav(wave(new Int16Array(PCM_SAMPLE_RATE)));
    assert.equal(result.peakDbfs, null);
    assert.equal(result.rmsDbfs, null);
    assert.equal(result.silentSampleRatio, 1);
    assert.equal(result.clippedSampleRatio, 0);
    assert.equal(result.speechDetected, undefined);
    assert.equal(result.outcome, undefined);
});

test('signed PCM clipping and near-silent sample ratios are counted exactly', () => {
    const result = analyzePcm16Wav(wave([-32768, 32767, -32, 32, 0, 33, -33, 16384]));
    assert.equal(result.sampleCount, 8);
    assert.equal(result.peakDbfs, 0);
    assert.equal(result.silentSampleRatio, 3 / 8);
    assert.equal(result.clippedSampleRatio, 2 / 8);
    assert.ok(result.rmsDbfs < 0);
});

test('very low measured RMS survives diagnostic serialization without a made-up noise floor', () => {
    const samples = new Int16Array(PCM_SAMPLE_RATE);
    samples[0] = 1;
    const analyzed = analyzePcm16Wav(wave(samples));
    assert.ok(analyzed.rmsDbfs < -120);
    assert.equal(createStrictLidAudioDiagnostic(analyzed).rmsDbfs, analyzed.rmsDbfs);
    assert.notEqual(analyzed.peakDbfs, null);
});

test('PCM WAVEFORMATEX with empty extension is accepted', () => {
    assert.equal(analyzePcm16Wav(wave([1, 2, 3], { extended: true })).sampleCount, 3);
});

test('WAV size, declared RIFF size, and signatures fail closed', () => {
    for (const buffer of [undefined, new Uint8Array(44), Buffer.alloc(43), Buffer.alloc(MAX_WAV_BYTES + 1)]) {
        assert.throws(() => parsePcm16Wav(buffer), errorCode('STRICT_LID_AUDIO_INVALID_WAV_SIZE'));
    }
    for (const mutate of [
        (buffer) => buffer.write('RF64'),
        (buffer) => buffer.write('AVI ', 8),
        (buffer) => buffer.writeUInt32LE(0xffffffff, 4),
        (buffer) => buffer.writeUInt32LE(buffer.length - 10, 4),
        (buffer) => { buffer[0] |= 0x80; },
    ]) {
        const buffer = wave([1, 2]);
        mutate(buffer);
        assert.throws(() => parsePcm16Wav(buffer), errorCode('STRICT_LID_AUDIO_INVALID_RIFF'));
    }
    assert.throws(() => parsePcm16Wav(Buffer.concat([wave([1, 2]), Buffer.alloc(4)])), errorCode('STRICT_LID_AUDIO_INVALID_RIFF'));
});

test('truncated chunk bodies, headers and missing odd-byte padding fail closed', () => {
    const body = wave([1, 2]);
    body.writeUInt32LE(0xffffffff, 40);
    assert.throws(() => parsePcm16Wav(body), errorCode('STRICT_LID_AUDIO_TRUNCATED_CHUNK'));
    const header = Buffer.concat([wave([1]), Buffer.alloc(2)]);
    header.writeUInt32LE(header.length - 8, 4);
    assert.throws(() => parsePcm16Wav(header), errorCode('STRICT_LID_AUDIO_INVALID_CHUNKS'));
    const padded = wave([1], { after: [chunk('JUNK', Buffer.from([1]))] }).subarray(0, -1);
    padded.writeUInt32LE(padded.length - 8, 4);
    assert.throws(() => parsePcm16Wav(padded), errorCode('STRICT_LID_AUDIO_TRUNCATED_CHUNK'));
});

test('unsupported encoding, stereo, sample rates, bit depths, and format invariants fail closed', () => {
    const changes = [
        (format) => format.writeUInt16LE(3, 0),
        (format) => format.writeUInt16LE(0xfffe, 0),
        (format) => format.writeUInt16LE(2, 2),
        (format) => format.writeUInt32LE(48000, 4),
        (format) => format.writeUInt32LE(16000, 8),
        (format) => format.writeUInt16LE(4, 12),
        (format) => format.writeUInt16LE(8, 14),
    ];
    for (const changeFormat of changes) {
        assert.throws(() => parsePcm16Wav(wave([1], { changeFormat })), errorCode('STRICT_LID_AUDIO_UNSUPPORTED_FORMAT'));
    }
    assert.throws(() => parsePcm16Wav(wave([1], { extended: true, changeFormat: (format) => format.writeUInt16LE(2, 16) })), errorCode('STRICT_LID_AUDIO_UNSUPPORTED_FORMAT'));
});

test('duplicate or missing required chunks, empty/odd data, and excess chunks fail closed', () => {
    const format = wave([1]).subarray(20, 36);
    assert.throws(() => parsePcm16Wav(wave([1], { before: [chunk('fmt ', format)] })), errorCode('STRICT_LID_AUDIO_INVALID_FORMAT'));
    assert.throws(() => parsePcm16Wav(wave([1], { after: [chunk('data', Buffer.from([0, 0]))] })), errorCode('STRICT_LID_AUDIO_INVALID_DATA'));
    assert.throws(() => parsePcm16Wav(wave([])), errorCode('STRICT_LID_AUDIO_INVALID_DATA'));
    const noFormat = wave([1]);
    noFormat.write('JUNK', 12);
    assert.throws(() => parsePcm16Wav(noFormat), errorCode('STRICT_LID_AUDIO_MISSING_CHUNK'));
    const noData = wave([1]);
    noData.write('JUNK', 36);
    assert.throws(() => parsePcm16Wav(noData), errorCode('STRICT_LID_AUDIO_MISSING_CHUNK'));
    const oddData = wave([1]);
    oddData.writeUInt32LE(1, 40);
    assert.throws(() => parsePcm16Wav(oddData), errorCode('STRICT_LID_AUDIO_INVALID_DATA'));
    assert.throws(() => parsePcm16Wav(wave([1], { before: Array.from({ length: MAX_WAV_CHUNKS }, () => chunk('JUNK', Buffer.alloc(0))) })), errorCode('STRICT_LID_AUDIO_INVALID_CHUNKS'));
});

test('duration limit is derived from PCM sample count and includes exactly 90 seconds', () => {
    assert.equal(parsePcm16Wav(wave(new Int16Array(MAX_AUDIO_SECONDS * PCM_SAMPLE_RATE))).durationSeconds, 90);
    assert.throws(() => parsePcm16Wav(wave(new Int16Array(MAX_AUDIO_SECONDS * PCM_SAMPLE_RATE + 1))), errorCode('STRICT_LID_AUDIO_DURATION_LIMIT'));
});

test('VAD selector maximizes contiguous speech, merges overlap, and is input-order independent', () => {
    const segments = [[36, 50], [10, 16], [15, 20], [30, 38], [75, 88]];
    const input = { segments, durationSeconds: 90, preferredStartSeconds: 0 };
    const result = selectSpeechWindow(input);
    assert.deepEqual(result, {
        startSeconds: 30, endSeconds: 50, durationSeconds: 20,
        speechSeconds: 20, speechRatio: 1, segmentCount: 1,
    });
    assert.deepEqual(selectSpeechWindow({ ...input, segments: [...segments].reverse() }), result);
    assert.deepEqual(segments, [[36, 50], [10, 16], [15, 20], [30, 38], [75, 88]]);
    assert.ok(Object.isFrozen(result));
});

test('VAD window ties choose proximity to anchor then the earlier start', () => {
    const segments = [{ start: 0, end: 20 }, { start: 40, end: 60 }];
    assert.equal(selectSpeechWindow({ segments, durationSeconds: 60, preferredStartSeconds: 35 }).startSeconds, 40);
    assert.equal(selectSpeechWindow({ segments, durationSeconds: 60, preferredStartSeconds: 20 }).startSeconds, 0);
    const flat = selectSpeechWindow({ segments: [[10, 50]], durationSeconds: 60, preferredStartSeconds: 23.125 });
    assert.equal(flat.startSeconds, 23.125);
    assert.equal(flat.speechSeconds, 20);
});

test('VAD does not splice separated speech segments or count overlapping intervals twice', () => {
    const result = selectSpeechWindow({ segments: [[0, 5], [0, 5], [40, 45]], durationSeconds: 60, preferredStartSeconds: 0 });
    assert.equal(result.startSeconds, 0);
    assert.equal(result.endSeconds, 20);
    assert.equal(result.speechSeconds, 5);
    assert.equal(result.segmentCount, 1);
    assert.equal(result.speechRatio, 0.25);
});

test('VAD selector stays inside one local WAV, clips segment ends, and handles short or silent samples', () => {
    assert.deepEqual(selectSpeechWindow({ segments: [[2, 100], [80, 90], [0, 0]], durationSeconds: 8 }), {
        startSeconds: 0, endSeconds: 8, durationSeconds: 8, speechSeconds: 6, speechRatio: 0.75, segmentCount: 1,
    });
    const silent = selectSpeechWindow({ segments: [], durationSeconds: 60, preferredStartSeconds: 1000 });
    assert.equal(silent.startSeconds, 40);
    assert.equal(silent.endSeconds, 60);
    assert.equal(silent.speechSeconds, 0);
    assert.equal(silent.segmentCount, 0);
    assert.equal(selectSpeechWindow({ segments: [], durationSeconds: 60, preferredStartSeconds: -5 }).startSeconds, 0);
});

test('VAD selection is on PCM sample boundaries and can be reproduced exactly by crop', () => {
    const source = wave(new Int16Array(3 * PCM_SAMPLE_RATE));
    const selected = selectSpeechWindow({
        segments: [[0.23456789, 2.789012345]], durationSeconds: 3,
        targetSeconds: 1.123456789, preferredStartSeconds: 0.3456789123,
    });
    for (const value of [selected.startSeconds, selected.endSeconds, selected.durationSeconds]) {
        assert.ok(Math.abs(value * PCM_SAMPLE_RATE - Math.round(value * PCM_SAMPLE_RATE)) < 1e-8);
    }
    const cropped = cropPcm16Wav(source, selected.startSeconds, selected.durationSeconds);
    assert.equal(cropped.analysis.durationSeconds, selected.durationSeconds);
    assert.ok(selected.endSeconds <= 3);
});

test('VAD input bounds reject non-numeric, non-finite, inverted, and oversized segments', () => {
    for (const segments of [undefined, {}, Array(MAX_VAD_SEGMENTS + 1).fill([0, 1])]) {
        assert.throws(() => selectSpeechWindow({ segments, durationSeconds: 60 }), errorCode('STRICT_LID_AUDIO_INVALID_VAD_SEGMENTS'));
    }
    for (const segment of [null, 1, [], [0], [0, 1, 2], [-1, 1], [2, 1], [NaN, 1], [0, Infinity], ['0', 1], { start: 1, end: '2' }]) {
        assert.throws(() => selectSpeechWindow({ segments: [segment], durationSeconds: 60 }), errorCode('STRICT_LID_AUDIO_INVALID_VAD_SEGMENT'));
    }
    for (const overrides of [
        { durationSeconds: 0 }, { durationSeconds: 91 }, { durationSeconds: NaN }, { durationSeconds: '60' },
        { targetSeconds: 0 }, { targetSeconds: 91 }, { targetSeconds: 0.000001 },
        { preferredStartSeconds: Infinity }, { preferredStartSeconds: '1' },
    ]) {
        assert.throws(() => selectSpeechWindow({ segments: [], durationSeconds: 60, ...overrides }), errorCode('STRICT_LID_AUDIO_INVALID_WINDOW'));
    }
});

test('deterministic VAD selector matches an exhaustive integer-grid oracle', () => {
    let seed = 919;
    const random = (max) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
    for (let iteration = 0; iteration < 80; iteration++) {
        const durationSeconds = 10 + random(25);
        const targetSeconds = 1 + random(9);
        const preferredStartSeconds = random(durationSeconds - targetSeconds + 1);
        const segments = Array.from({ length: 12 }, () => {
            const start = random(durationSeconds);
            return [start, Math.min(durationSeconds, start + 1 + random(8))];
        });
        const spoken = Array.from({ length: durationSeconds }, (_, second) => segments.some(([start, end]) => second >= start && second < end));
        const candidates = Array.from({ length: durationSeconds - targetSeconds + 1 }, (_, start) => ({
            start, speech: spoken.slice(start, start + targetSeconds).filter(Boolean).length,
        })).sort((a, b) => b.speech - a.speech || Math.abs(a.start - preferredStartSeconds) - Math.abs(b.start - preferredStartSeconds) || a.start - b.start);
        const actual = selectSpeechWindow({ segments, durationSeconds, targetSeconds, preferredStartSeconds });
        assert.equal(actual.startSeconds, candidates[0].start);
        assert.equal(actual.speechSeconds, candidates[0].speech);
    }
});

test('maximum VAD segment count is bounded and remains a contiguous local selection', () => {
    const segments = Array.from({ length: MAX_VAD_SEGMENTS }, (_, index) => [index / 32, (index + 0.5) / 32]);
    const actual = selectSpeechWindow({ segments, durationSeconds: 90, preferredStartSeconds: 30 });
    assert.equal(actual.startSeconds, 30);
    assert.equal(actual.endSeconds, 50);
    assert.equal(actual.speechSeconds, 10);
    assert.equal(actual.speechRatio, 0.5);
});

test('crop returns exactly contiguous samples in a new valid WAV and strips metadata', () => {
    const original = wave([10, 20, 30, 40, 50, 60], { before: [chunk('LIST', Buffer.from('private metadata'))] });
    const snapshot = Buffer.from(original);
    const { buffer, analysis } = cropPcm16Wav(original, 2 / PCM_SAMPLE_RATE, 3 / PCM_SAMPLE_RATE);
    assert.equal(buffer.length, 50);
    assert.deepEqual([...Array(3)].map((_, index) => buffer.readInt16LE(44 + index * 2)), [30, 40, 50]);
    assert.equal(analysis.sampleCount, 3);
    assert.equal(analysis.durationSeconds, 3 / PCM_SAMPLE_RATE);
    assert.equal(parsePcm16Wav(buffer).chunkCount, 2);
    assert.ok(!buffer.includes(Buffer.from('private metadata')));
    buffer.writeInt16LE(99, 44);
    assert.deepEqual(original, snapshot);
});

test('crop rounds inward, accepts exact tail and refuses out-of-range or empty requests', () => {
    const original = wave([10, 20, 30, 40]);
    const whole = cropPcm16Wav(original, 0, 4 / PCM_SAMPLE_RATE);
    assert.equal(whole.analysis.sampleCount, 4);
    const inward = cropPcm16Wav(original, 0.5 / PCM_SAMPLE_RATE, 3 / PCM_SAMPLE_RATE);
    assert.equal(inward.analysis.sampleCount, 2);
    assert.equal(inward.buffer.readInt16LE(44), 20);
    assert.equal(inward.buffer.readInt16LE(46), 30);
    for (const [start, duration] of [[-1, 1], [0, 1], [4 / PCM_SAMPLE_RATE, 1 / PCM_SAMPLE_RATE], [NaN, 1], [0, Infinity], ['0', 0.0001], [0, 0]]) {
        assert.throws(() => cropPcm16Wav(original, start, duration), errorCode('STRICT_LID_AUDIO_INVALID_CROP'));
    }
    assert.throws(() => cropPcm16Wav(original, 0, 0.1 / PCM_SAMPLE_RATE), errorCode('STRICT_LID_AUDIO_EMPTY_CROP'));
});

test('closed diagnostics retain only typed bounded metrics and enumerated outcomes', () => {
    const result = createStrictLidAudioDiagnostic({
        ...analyzePcm16Wav(wave([0, 32, 32767])), outcome: 'insufficient-evidence',
        vadSegmentCount: 2, vadSpeechSeconds: 1.5, vadSpeechRatio: 0.5,
        selectionStartSeconds: 2, selectionDurationSeconds: 20, selectionSpeechSeconds: 10, selectionSpeechRatio: 0.5,
        decodeAttemptCount: 2, fallbackAttemptCount: 1, elapsedMs: 1234,
        url: 'http://secret.example/user/password', title: 'private title', transcript: 'private transcript',
        repeatedSegmentCount: undefined, repetitionRatio: undefined,
    });
    assert.equal(result.outcome, 'insufficient-evidence');
    assert.equal(result.vadSegmentCount, 2);
    assert.equal(result.sampleCount, 3);
    assert.equal(result.repeatedSegmentCount, null);
    assert.equal(result.repetitionRatio, null);
    assert.equal(result.event, 'strict_lid_audio_evidence');
    assert.ok(Object.isFrozen(result));
    const serialized = JSON.stringify(result);
    for (const secret of ['secret.example', 'private title', 'private transcript', 'password']) assert.ok(!serialized.includes(secret));
    assert.deepEqual(Object.keys(result), [
        'event', 'protocol', 'outcome', 'sampleCount', 'dataBytes', 'durationSeconds',
        'peakDbfs', 'rmsDbfs', 'silentSampleRatio', 'clippedSampleRatio',
        'vadSegmentCount', 'vadSpeechSeconds', 'vadSpeechRatio',
        'selectionStartSeconds', 'selectionDurationSeconds', 'selectionSpeechSeconds', 'selectionSpeechRatio',
        'decodeAttemptCount', 'fallbackAttemptCount', 'repeatedSegmentCount', 'repetitionRatio', 'elapsedMs',
    ]);
});

test('diagnostics neither coerce values nor expose throws, getters or changing values', () => {
    let getterCount = 0;
    const result = createStrictLidAudioDiagnostic({
        outcome: 'http://secret.example',
        get sampleCount() { getterCount++; return getterCount === 1 ? 2 : 'secret second value'; },
        get durationSeconds() { throw new Error('private URL'); },
        dataBytes: { valueOf() { throw new Error('never coerce'); } },
        rmsDbfs: -Infinity, peakDbfs: 1, silentSampleRatio: -1, clippedSampleRatio: NaN,
        vadSegmentCount: 1.5, decodeAttemptCount: 9, elapsedMs: '2000',
    });
    assert.equal(getterCount, 1);
    assert.equal(result.outcome, 'not-run');
    assert.equal(result.sampleCount, 2);
    for (const name of ['durationSeconds', 'dataBytes', 'rmsDbfs', 'peakDbfs', 'silentSampleRatio', 'clippedSampleRatio', 'vadSegmentCount', 'decodeAttemptCount', 'elapsedMs']) {
        assert.equal(result[name], null);
    }
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(createStrictLidAudioDiagnostic(null).durationSeconds, null);
});
