'use strict';

// All analysis is local. Energy describes the signal, never its spoken content.
const MAX_WAV_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 90;
const MAX_WAV_CHUNKS = 128;
const MAX_VAD_SEGMENTS = 2048;
const PCM_SAMPLE_RATE = 16000;
const PCM_SAMPLE_BYTES = 2;
const SILENT_SAMPLE_ABSOLUTE_LIMIT = 32;

function invalid(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Parse a completed RIFF WAV, not an unfinalized streaming/RF64 header. */
function parsePcm16Wav(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > MAX_WAV_BYTES) {
        throw invalid('STRICT_LID_AUDIO_INVALID_WAV_SIZE');
    }
    if (buffer.toString('latin1', 0, 4) !== 'RIFF'
        || buffer.toString('latin1', 8, 12) !== 'WAVE'
        || buffer.readUInt32LE(4) !== buffer.length - 8) {
        throw invalid('STRICT_LID_AUDIO_INVALID_RIFF');
    }
    let offset = 12;
    let chunkCount = 0;
    let format = null;
    let dataOffset = null;
    let dataBytes = null;
    while (offset < buffer.length) {
        if (++chunkCount > MAX_WAV_CHUNKS || offset + 8 > buffer.length) {
            throw invalid('STRICT_LID_AUDIO_INVALID_CHUNKS');
        }
        const chunkId = buffer.toString('latin1', offset, offset + 4);
        const chunkBytes = buffer.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = start + chunkBytes;
        const paddedEnd = end + (chunkBytes % 2);
        if (end > buffer.length || paddedEnd > buffer.length) {
            throw invalid('STRICT_LID_AUDIO_TRUNCATED_CHUNK');
        }
        if (chunkId === 'fmt ') {
            if (format || chunkBytes < 16) throw invalid('STRICT_LID_AUDIO_INVALID_FORMAT');
            format = {
                encoding: buffer.readUInt16LE(start),
                channels: buffer.readUInt16LE(start + 2),
                sampleRate: buffer.readUInt32LE(start + 4),
                byteRate: buffer.readUInt32LE(start + 8),
                blockAlign: buffer.readUInt16LE(start + 12),
                bitsPerSample: buffer.readUInt16LE(start + 14),
            };
            // PCM WAVEFORMATEX may have a zero-sized extension. Any other format
            // needs an explicit decoder rather than being silently read as PCM16.
            if ((chunkBytes !== 16 && chunkBytes !== 18)
                || (chunkBytes === 18 && buffer.readUInt16LE(start + 16) !== 0)
                || format.encoding !== 1 || format.channels !== 1
                || format.sampleRate !== PCM_SAMPLE_RATE
                || format.byteRate !== PCM_SAMPLE_RATE * PCM_SAMPLE_BYTES
                || format.blockAlign !== PCM_SAMPLE_BYTES || format.bitsPerSample !== 16) {
                throw invalid('STRICT_LID_AUDIO_UNSUPPORTED_FORMAT');
            }
        } else if (chunkId === 'data') {
            if (dataOffset !== null || chunkBytes === 0 || chunkBytes % PCM_SAMPLE_BYTES !== 0) {
                throw invalid('STRICT_LID_AUDIO_INVALID_DATA');
            }
            dataOffset = start;
            dataBytes = chunkBytes;
        }
        offset = paddedEnd;
    }
    if (!format || dataOffset === null) throw invalid('STRICT_LID_AUDIO_MISSING_CHUNK');
    const sampleCount = dataBytes / PCM_SAMPLE_BYTES;
    const durationSeconds = sampleCount / PCM_SAMPLE_RATE;
    if (durationSeconds > MAX_AUDIO_SECONDS) throw invalid('STRICT_LID_AUDIO_DURATION_LIMIT');
    return Object.freeze({
        sampleRate: PCM_SAMPLE_RATE, channels: 1, bitsPerSample: 16,
        sampleCount, durationSeconds, dataOffset, dataBytes, chunkCount,
    });
}

function analyzePcm16Wav(buffer) {
    const parsed = parsePcm16Wav(buffer);
    let peak = 0;
    let squareSum = 0;
    let silentSampleCount = 0;
    let clippedSampleCount = 0;
    for (let index = parsed.dataOffset; index < parsed.dataOffset + parsed.dataBytes; index += PCM_SAMPLE_BYTES) {
        const sample = buffer.readInt16LE(index);
        const absolute = Math.abs(sample);
        peak = Math.max(peak, absolute);
        squareSum += sample * sample;
        if (absolute <= SILENT_SAMPLE_ABSOLUTE_LIMIT) silentSampleCount++;
        if (sample === -32768 || sample === 32767) clippedSampleCount++;
    }
    // null represents exact digital silence; no artificial dBFS floor or claim
    // that a non-silent signal contains speech is introduced.
    return Object.freeze({
        sampleRate: parsed.sampleRate, channels: parsed.channels, bitsPerSample: parsed.bitsPerSample,
        sampleCount: parsed.sampleCount, durationSeconds: parsed.durationSeconds, dataBytes: parsed.dataBytes,
        peakDbfs: peak === 0 ? null : 20 * Math.log10(peak / 32768),
        rmsDbfs: squareSum === 0 ? null : 20 * Math.log10(Math.sqrt(squareSum / parsed.sampleCount) / 32768),
        silentSampleRatio: silentSampleCount / parsed.sampleCount,
        clippedSampleRatio: clippedSampleCount / parsed.sampleCount,
    });
}

function normalizedSpeechSegments(segments, durationSamples) {
    if (!Array.isArray(segments) || segments.length > MAX_VAD_SEGMENTS) {
        throw invalid('STRICT_LID_AUDIO_INVALID_VAD_SEGMENTS');
    }
    const intervals = [];
    for (const segment of segments) {
        if (!segment || typeof segment !== 'object') throw invalid('STRICT_LID_AUDIO_INVALID_VAD_SEGMENT');
        const start = Array.isArray(segment) ? segment[0] : segment.start;
        const end = Array.isArray(segment) ? segment[1] : segment.end;
        if ((Array.isArray(segment) && segment.length !== 2)
            || !finiteNumber(start) || !finiteNumber(end) || start < 0 || end < start) {
            throw invalid('STRICT_LID_AUDIO_INVALID_VAD_SEGMENT');
        }
        const boundedStart = Math.ceil(start * PCM_SAMPLE_RATE - 1e-9);
        const boundedEnd = Math.min(Math.floor(end * PCM_SAMPLE_RATE + 1e-9), durationSamples);
        if (boundedStart < boundedEnd) intervals.push({ start: boundedStart, end: boundedEnd });
    }
    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const interval of intervals) {
        const previous = merged[merged.length - 1];
        if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
        else merged.push({ ...interval });
    }
    return merged;
}

/** Select one contiguous local window using only external VAD intervals. */
function selectSpeechWindow({ segments, durationSeconds, targetSeconds = 20, preferredStartSeconds = 0 } = {}) {
    if (!finiteNumber(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_AUDIO_SECONDS
        || !finiteNumber(targetSeconds) || targetSeconds <= 0 || targetSeconds > MAX_AUDIO_SECONDS
        || !finiteNumber(preferredStartSeconds)) {
        throw invalid('STRICT_LID_AUDIO_INVALID_WINDOW');
    }
    // Integer sample coordinates make selection deterministic and directly
    // reproducible by cropPcm16Wav; never splice disconnected VAD segments.
    const durationSamples = Math.floor(durationSeconds * PCM_SAMPLE_RATE + 1e-9);
    const windowDuration = Math.min(Math.floor(targetSeconds * PCM_SAMPLE_RATE + 1e-9), durationSamples);
    if (windowDuration < 1) throw invalid('STRICT_LID_AUDIO_INVALID_WINDOW');
    const merged = normalizedSpeechSegments(segments, durationSamples);
    const maxStart = durationSamples - windowDuration;
    const clampStart = (value) => Math.max(0, Math.min(value, maxStart));
    const preferred = clampStart(Math.round(preferredStartSeconds * PCM_SAMPLE_RATE));
    const candidates = new Set([0, maxStart, preferred]);
    // Sliding interval overlap is piecewise linear. Its extrema occur at these
    // breakpoints (or on a flat optimum containing the preferred position).
    for (const interval of merged) {
        candidates.add(clampStart(interval.start));
        candidates.add(clampStart(interval.end));
        candidates.add(clampStart(interval.start - windowDuration));
        candidates.add(clampStart(interval.end - windowDuration));
    }
    let best = null;
    for (const startSample of candidates) {
        const endSample = Math.min(durationSamples, startSample + windowDuration);
        let speechSamples = 0;
        let segmentCount = 0;
        for (const interval of merged) {
            const overlap = Math.max(0, Math.min(endSample, interval.end) - Math.max(startSample, interval.start));
            speechSamples += overlap;
            if (overlap > 0) segmentCount++;
        }
        speechSamples = Math.min(windowDuration, speechSamples);
        const distance = Math.abs(startSample - preferred);
        if (!best || speechSamples > best.speechSamples
            || (speechSamples === best.speechSamples
                && (distance < best.distance || (distance === best.distance && startSample < best.startSample)))) {
            best = { startSample, endSample, durationSamples: windowDuration, speechSamples, segmentCount, distance };
        }
    }
    return Object.freeze({
        startSeconds: best.startSample / PCM_SAMPLE_RATE, endSeconds: best.endSample / PCM_SAMPLE_RATE,
        durationSeconds: best.durationSamples / PCM_SAMPLE_RATE,
        speechSeconds: best.speechSamples / PCM_SAMPLE_RATE, speechRatio: best.speechSamples / best.durationSamples,
        segmentCount: best.segmentCount,
    });
}

/** Return a standalone PCM WAV. Source metadata is deliberately not copied. */
function cropPcm16Wav(buffer, startSeconds, durationSeconds) {
    const parsed = parsePcm16Wav(buffer);
    if (!finiteNumber(startSeconds) || startSeconds < 0
        || !finiteNumber(durationSeconds) || durationSeconds <= 0
        || startSeconds >= parsed.durationSeconds
        || durationSeconds > parsed.durationSeconds - startSeconds + 1e-9) {
        throw invalid('STRICT_LID_AUDIO_INVALID_CROP');
    }
    // Ceil/floor keep all selected samples inside the requested contiguous range.
    const startSample = Math.ceil(startSeconds * PCM_SAMPLE_RATE - 1e-9);
    const endSample = Math.min(parsed.sampleCount, Math.floor((startSeconds + durationSeconds) * PCM_SAMPLE_RATE + 1e-9));
    if (endSample <= startSample) throw invalid('STRICT_LID_AUDIO_EMPTY_CROP');
    const dataBytes = (endSample - startSample) * PCM_SAMPLE_BYTES;
    const result = Buffer.alloc(44 + dataBytes);
    result.write('RIFF', 0, 'ascii');
    result.writeUInt32LE(36 + dataBytes, 4);
    result.write('WAVEfmt ', 8, 'ascii');
    result.writeUInt32LE(16, 16);
    result.writeUInt16LE(1, 20);
    result.writeUInt16LE(1, 22);
    result.writeUInt32LE(PCM_SAMPLE_RATE, 24);
    result.writeUInt32LE(PCM_SAMPLE_RATE * PCM_SAMPLE_BYTES, 28);
    result.writeUInt16LE(PCM_SAMPLE_BYTES, 32);
    result.writeUInt16LE(16, 34);
    result.write('data', 36, 'ascii');
    result.writeUInt32LE(dataBytes, 40);
    buffer.copy(result, 44, parsed.dataOffset + startSample * PCM_SAMPLE_BYTES, parsed.dataOffset + endSample * PCM_SAMPLE_BYTES);
    return Object.freeze({ buffer: result, analysis: analyzePcm16Wav(result) });
}

const AUDIO_OUTCOMES = new Set([
    'not-run', 'analyzed', 'selected', 'silence', 'no-vad-speech', 'insufficient-evidence',
    'accepted', 'conflict', 'invalid-audio', 'failed', 'timed-out', 'aborted', 'preempted', 'budget-exhausted',
]);

function safeField(value, key) {
    try { return value && typeof value === 'object' ? value[key] : undefined; }
    catch { return undefined; }
}

function boundedMetric(value, min, max, integer = false) {
    return finiteNumber(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? value : null;
}

/** Closed, JSON-safe internal diagnostic: never spread or stringify input. */
function createStrictLidAudioDiagnostic(details = {}) {
    const outcome = safeField(details, 'outcome');
    const result = {
        event: 'strict_lid_audio_evidence', protocol: 1,
        outcome: typeof outcome === 'string' && AUDIO_OUTCOMES.has(outcome) ? outcome : 'not-run',
    };
    const fields = {
        sampleCount: [0, MAX_AUDIO_SECONDS * PCM_SAMPLE_RATE, true],
        dataBytes: [0, MAX_WAV_BYTES, true],
        durationSeconds: [0, MAX_AUDIO_SECONDS],
        // One nonzero PCM16 sample across a 90-second WAV can yield RMS below
        // -150 dBFS. Preserve that real measurement instead of inventing a floor.
        peakDbfs: [-180, 0], rmsDbfs: [-180, 0],
        silentSampleRatio: [0, 1], clippedSampleRatio: [0, 1],
        vadSegmentCount: [0, MAX_VAD_SEGMENTS, true],
        vadSpeechSeconds: [0, MAX_AUDIO_SECONDS], vadSpeechRatio: [0, 1],
        selectionStartSeconds: [0, MAX_AUDIO_SECONDS], selectionDurationSeconds: [0, MAX_AUDIO_SECONDS],
        selectionSpeechSeconds: [0, MAX_AUDIO_SECONDS], selectionSpeechRatio: [0, 1],
        decodeAttemptCount: [0, 8, true], fallbackAttemptCount: [0, 8, true],
        repeatedSegmentCount: [0, MAX_VAD_SEGMENTS, true], repetitionRatio: [0, 1],
        elapsedMs: [0, 225000, true],
    };
    for (const [name, limits] of Object.entries(fields)) result[name] = boundedMetric(safeField(details, name), ...limits);
    return Object.freeze(result);
}

module.exports = {
    MAX_WAV_BYTES, MAX_AUDIO_SECONDS, MAX_WAV_CHUNKS, MAX_VAD_SEGMENTS,
    PCM_SAMPLE_RATE, SILENT_SAMPLE_ABSOLUTE_LIMIT,
    parsePcm16Wav, analyzePcm16Wav, selectSpeechWindow, cropPcm16Wav, createStrictLidAudioDiagnostic,
};
