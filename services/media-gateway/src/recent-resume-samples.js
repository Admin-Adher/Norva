'use strict';
const crypto = require('node:crypto');
const SAMPLE_BYTES = 64 * 1024;
const RECENT_TTL_MS = 10 * 60_000;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// This is a short-lived, private sampling policy, NOT a whole-file digest or a
// synthetic provider ETag. Account/source/profile binding remains in the cache.
function sampleProof(samples, fileSizeBytes, target) {
    if (!hex(target) || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 4 * SAMPLE_BYTES
        || !Array.isArray(samples) || samples.length !== 4) return null;
    let end = -1;
    const ranges = [];
    for (const sample of samples) {
        if (!Number.isSafeInteger(sample.start) || sample.start <= end
            || !Buffer.isBuffer(sample.payload) || sample.payload.length !== SAMPLE_BYTES
            || sample.start + SAMPLE_BYTES > fileSizeBytes) return null;
        end = sample.start + SAMPLE_BYTES - 1;
        ranges.push(Object.freeze({ start: sample.start, length: SAMPLE_BYTES, digest: digest(sample.payload) }));
    }
    if (ranges[0].start !== 0) return null;
    return Object.freeze({ kind: 'sampled-recent-v1', target, fileSizeBytes, ranges: Object.freeze(ranges) });
}

function samplesMatch(proof, samples, fileSizeBytes, target) {
    const current = sampleProof(samples, fileSizeBytes, target);
    return Boolean(current && proof?.kind === current.kind && proof.target === target
        && proof.fileSizeBytes === fileSizeBytes && current.ranges.every((range, index) =>
            range.start === proof.ranges[index]?.start && range.digest === proof.ranges[index]?.digest));
}

// Completed in-process input windows only. No provider request at viewer exit.
function captureSamples(entries) {
    const windows = [...entries].filter(e => Number.isSafeInteger(e.start) && e.start >= 0
        && Buffer.isBuffer(e.payload) && e.payload.length >= SAMPLE_BYTES);
    const first = windows.find(e => e.start === 0);
    if (!first) return null;
    const anchors = [];
    for (const e of [...windows].reverse()) {
        for (const offset of [0, Math.floor((e.payload.length - SAMPLE_BYTES) / 2), e.payload.length - SAMPLE_BYTES]) {
            const start = e.start + offset;
            if (start >= SAMPLE_BYTES) anchors.push({ start, payload: e.payload.subarray(offset, offset + SAMPLE_BYTES) });
        }
    }
    // Map insertion order follows completed reads. Prefer the most recent
    // body window, not a high-offset index read earlier during container setup.
    const selected = [];
    for (const sample of anchors) {
        if (selected.every(other => Math.abs(other.start - sample.start) >= SAMPLE_BYTES)) selected.push(sample);
        if (selected.length === 3) break;
    }
    if (selected.length !== 3) return null;
    return [{ start: 0, payload: Buffer.from(first.payload.subarray(0, SAMPLE_BYTES)) },
        ...selected.sort((a, b) => a.start - b.start).map(e => ({ start: e.start, payload: Buffer.from(e.payload) }))];
}

module.exports = { SAMPLE_BYTES, RECENT_TTL_MS, sampleProof, samplesMatch, captureSamples };
