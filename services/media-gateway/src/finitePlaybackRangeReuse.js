'use strict';

const crypto = require('node:crypto');
const { StrictLidRangeReuse } = require('./strict-lid-range-reuse');

// Reuse the already bounded/TTL-aware fragment store, not its strict-LID
// admission policy. A stale PLAYBACK cache is a miss, not a playback failure.
// No cached validator becomes an authorization or a new session's If-Range.
class FinitePlaybackRangeReuse {
    constructor(options = {}) {
        this.store = new StrictLidRangeReuse({ maxBytes: 64 * 1024 * 1024,
            perFileBytes: 8 * 1024 * 1024, maxFiles: 32, maxFragments: 64,
            ttlMs: 30 * 60_000, ...options });
        this.maxRetainedWindowBytes = 1280 * 1024;
        this.skippedSequentialWindows = 0;
    }

    begin({ ownerKey, sourceUrl, fileSizeBytes } = {}) {
        if (!/^[a-f0-9]{64}$/.test(String(ownerKey || '')) || !sourceUrl
            || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1) return null;
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        const fragments = this.store.begin({ userHash: ownerKey,
            sourceUrlHash: hash(String(sourceUrl)), profileHash: hash('finite-ts-resume-v1'), fileSizeBytes });
        let checked = false;
        let reusedBytes = 0;
        return Object.freeze({
            // Called only AFTER a current, complete, validated provider range
            // has drained. No cached bytes or old validator are exposed first.
            confirm(observed) {
                if (checked) return fragments.confirmed;
                checked = true;
                try { return fragments.confirm(observed); }
                catch (error) {
                    if (error?.code !== 'VOD_CHANGED') throw error;
                    fragments.invalidate();
                    return false;
                }
            },
            read(start, end) {
                const prior = fragments.priorRanges.find(f => f.start <= start && f.end >= start);
                const bytes = prior ? fragments.read(start, Math.min(end, prior.end)) : null;
                reusedBytes += bytes?.length || 0;
                return bytes;
            },
            missingEnd(start, end) {
                if (!fragments.confirmed) return end;
                const next = fragments.priorRanges.find(f => f.start > start && f.start <= end);
                return next ? next.start - 1 : end;
            },
            remember: (start, payload) => {
                // Retain the small timestamp-search windows (+256 KiB lookbehind),
                // not the 8 MiB sequential playback bodies. A large body would
                // evict the useful interior seek fragments, then evict itself
                // because the protected header/tail already occupy the budget.
                // The ordinary per-session playback cache remains unchanged.
                if (Buffer.isBuffer(payload) && payload.length > this.maxRetainedWindowBytes) {
                    this.skippedSequentialWindows++;
                    return false;
                }
                return fragments.remember(start, payload, { providerDrained: true });
            },
            get reusedBytes() { return reusedBytes; },
            invalidate: fragments.invalidate,
        });
    }

    prune() { this.store.prune(); }

    publicStatus() {
        return { ...this.store.snapshot(), scope: 'process-private-owner-exact-source',
            revalidation: 'current-drained-range-strong-etag-size-target',
            maxBytes: this.store.maxBytes, perFileBytes: this.store.perFileBytes,
            maxFiles: this.store.maxFiles, maxFragments: this.store.maxFragments, ttlMs: this.store.ttlMs,
            maxRetainedWindowBytes: this.maxRetainedWindowBytes,
            skippedSequentialWindows: this.skippedSequentialWindows };
    }
}

module.exports = { FinitePlaybackRangeReuse };
