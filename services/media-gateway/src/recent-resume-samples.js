'use strict';
const crypto = require('node:crypto');
const SAMPLE_BYTES = 64 * 1024;
const RECENT_TTL_MS = 10 * 60_000;
const LINEAR_SAMPLE_WINDOW_BYTES = 2 * 1024 * 1024;
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

// Passive evidence from bytes already delivered to the decoder. A completed
// local window is NOT a completed HTTP response or whole-file authority.
// Optional private input retention keeps only fully observed local intervals:
// the first 8 MiB and the latest completed 2 MiB. No unfinished local suffix
// survives. Only an ordinary drained viewer stop and four fresh matching ranges
// can authorize reuse; a network interruption invalidates every interval.
class LinearResumeSamples {
    constructor(fileSizeBytes, target, { retainInput = false } = {}) {
        this.fileSizeBytes = fileSizeBytes;
        this.target = target;
        this.valid = Number.isSafeInteger(fileSizeBytes)
            && fileSizeBytes >= LINEAR_SAMPLE_WINDOW_BYTES && hex(target);
        this.offset = 0;
        this.window = this.valid ? Buffer.alloc(LINEAR_SAMPLE_WINDOW_BYTES) : null;
        this.head = null;
        this.samples = null;
        this.retainInput = retainInput === true;
        this.prefixWindows = [];
        this.latestWindow = null;
    }

    append(start, bytes) {
        if (!this.valid) return;
        if (start !== this.offset || !Buffer.isBuffer(bytes)
            || start + bytes.length > this.fileSizeBytes) return this.invalidate();
        let consumed = 0;
        while (consumed < bytes.length) {
            const at = this.offset % LINEAR_SAMPLE_WINDOW_BYTES;
            const length = Math.min(bytes.length - consumed, LINEAR_SAMPLE_WINDOW_BYTES - at);
            bytes.copy(this.window, at, consumed, consumed + length);
            consumed += length;
            this.offset += length;
            if (!this.head && this.offset >= SAMPLE_BYTES) this.head = Buffer.from(this.window.subarray(0, SAMPLE_BYTES));
            if (at + length === LINEAR_SAMPLE_WINDOW_BYTES) {
                const base = this.offset - LINEAR_SAMPLE_WINDOW_BYTES;
                if (this.retainInput) {
                    const entry = { start: base, payload: Buffer.from(this.window) };
                    if (base < RECENT_HEADER_MAX_BYTES) this.prefixWindows.push(entry);
                    else this.latestWindow = entry;
                }
                const starts = [base === 0 ? SAMPLE_BYTES : 0,
                    Math.floor((LINEAR_SAMPLE_WINDOW_BYTES - SAMPLE_BYTES) / 2),
                    LINEAR_SAMPLE_WINDOW_BYTES - SAMPLE_BYTES];
                this.samples = [{ start: 0, payload: this.head }, ...starts.map(offset => ({
                    start: base + offset, payload: Buffer.from(this.window.subarray(offset, offset + SAMPLE_BYTES)),
                }))];
            }
        }
    }

    finish({ graceful = false, fileSizeBytes, target } = {}) {
        return this.finishSnapshot({ graceful, fileSizeBytes, target })?.samples || null;
    }

    finishSnapshot({ graceful = false, fileSizeBytes, target } = {}) {
        const samples = this.valid && graceful && fileSizeBytes === this.fileSizeBytes
            && target === this.target && sampleProof(this.samples, fileSizeBytes, target)
            ? this.samples : null;
        const snapshot = samples ? { samples, inputWindows: this.retainInput
            ? [...this.prefixWindows, ...(this.latestWindow ? [this.latestWindow] : [])] : [] } : null;
        this.invalidate();
        return snapshot;
    }

    invalidate() {
        this.valid = false;
        this.window = this.head = this.samples = null;
        this.prefixWindows = [];
        this.latestWindow = null;
    }
}

const RECENT_INPUT_MAX_BYTES = 8 * 1024 * 1024;
// Input-only entries have no HLS assets. They may use the existing per-file
// cache allowance, still reserved inside the unchanged aggregate budget.
const RECENT_MULTI_INPUT_MAX_BYTES = 64 * 1024 * 1024;
const RECENT_HEADER_MAX_BYTES = 8 * 1024 * 1024;

// Completed input only. Prefer caller-ordered headers/index before recent body
// ranges; remove overlaps and detach buffers under a strict aggregate ceiling.
// These bytes have no independent identity authority: the HLS cache exposes
// them only after its exact private binding and fresh sample proof succeed.
function captureInputWindows(entries, fileSizeBytes, maximum = RECENT_INPUT_MAX_BYTES) {
    if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1
        || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > RECENT_MULTI_INPUT_MAX_BYTES
        || !Array.isArray(entries)) return [];
    const selected = []; let bytes = 0;
    for (const entry of entries.slice(0, 512)) {
        if (!Number.isSafeInteger(entry?.start) || entry.start < 0 || !Buffer.isBuffer(entry.payload)
            || !entry.payload.length || entry.start + entry.payload.length > fileSizeBytes) continue;
        let gaps = [[entry.start, entry.start + entry.payload.length]];
        for (const prior of selected) {
            const a = prior.start, b = a + prior.payload.length;
            gaps = gaps.flatMap(([lo, hi]) => hi <= a || lo >= b ? [[lo, hi]]
                : [[lo, Math.min(hi, a)], [Math.max(lo, b), hi]].filter(([x,y]) => x < y));
        }
        for (const [lo, hi] of gaps) {
            const length = Math.min(hi - lo, maximum - bytes);
            if (length <= 0) break;
            selected.push({ start: lo, payload: Buffer.from(entry.payload.subarray(lo-entry.start, lo-entry.start+length)) });
            bytes += length;
        }
        if (bytes >= maximum) break;
    }
    return selected.sort((a,b) => a.start-b.start);
}

module.exports = { SAMPLE_BYTES, RECENT_TTL_MS, sampleProof, samplesMatch, captureSamples,
    LinearResumeSamples, LINEAR_SAMPLE_WINDOW_BYTES,
    RECENT_INPUT_MAX_BYTES, RECENT_MULTI_INPUT_MAX_BYTES, RECENT_HEADER_MAX_BYTES, captureInputWindows };
