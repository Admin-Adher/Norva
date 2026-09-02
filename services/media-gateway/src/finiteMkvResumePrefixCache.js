'use strict';

const crypto = require('crypto');

function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeStrongEtag(value) {
    const validator = value && typeof value === 'object' ? value : null;
    const etag = String(validator?.value || '').trim();
    if (
        validator?.kind !== 'etag'
        || validator?.header !== 'If-Range'
        || !etag
        || etag.length > 512
        || /^W\//i.test(etag)
        || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)
    ) return null;
    return { kind: 'etag', header: 'If-Range', value: etag };
}

class FiniteMkvResumePrefixCache {
    constructor(options = {}) {
        this.maxBytes = normalizePositiveInteger(options.maxBytes, 128 * 1024 * 1024);
        this.maxEntryBytes = Math.min(
            this.maxBytes,
            normalizePositiveInteger(options.maxEntryBytes, 8 * 1024 * 1024),
        );
        this.ttlMs = normalizePositiveInteger(options.ttlMs, 30 * 60 * 1000);
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.entries = new Map();
        this.bytes = 0;
        this.stats = {
            hits: 0,
            misses: 0,
            stores: 0,
            rejected: 0,
            evictions: 0,
            expired: 0,
        };
    }

    keyFor(sourceUrl) {
        const value = String(sourceUrl || '');
        if (!value) return null;
        return crypto.createHash('sha256')
            .update('norva-finite-mkv-resume-prefix-v1\0')
            .update(value)
            .digest('hex');
    }

    deleteKey(key, reason = 'evicted') {
        const entry = this.entries.get(key);
        if (!entry) return false;
        this.entries.delete(key);
        this.bytes = Math.max(0, this.bytes - entry.payload.length);
        if (reason === 'expired') this.stats.expired += 1;
        else this.stats.evictions += 1;
        return true;
    }

    prune(nowMs = this.now()) {
        for (const [key, entry] of this.entries) {
            if (entry.expiresAtMs <= nowMs) this.deleteKey(key, 'expired');
        }
        while (this.bytes > this.maxBytes && this.entries.size > 0) {
            this.deleteKey(this.entries.keys().next().value, 'evicted');
        }
    }

    get(options = {}) {
        const key = this.keyFor(options.sourceUrl);
        const fileSizeBytes = Number(options.fileSizeBytes);
        if (!key || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) {
            this.stats.misses += 1;
            return null;
        }
        this.prune();
        const entry = this.entries.get(key);
        if (!entry || entry.fileSizeBytes !== fileSizeBytes) {
            this.stats.misses += 1;
            return null;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        this.stats.hits += 1;
        return {
            fileSizeBytes: entry.fileSizeBytes,
            validator: entry.validator ? { ...entry.validator } : null,
            effectiveUrlIdentitySha256: entry.effectiveUrlIdentitySha256,
            payload: entry.payload,
        };
    }

    put(options = {}) {
        const key = this.keyFor(options.sourceUrl);
        const fileSizeBytes = Number(options.fileSizeBytes);
        const validator = normalizeStrongEtag(options.validator);
        const suppliedValidator = options.validator && typeof options.validator === 'object'
            ? options.validator
            : null;
        const identity = String(options.effectiveUrlIdentitySha256 || '').toLowerCase();
        const payload = options.payload;
        if (
            !key
            || !Number.isSafeInteger(fileSizeBytes)
            || fileSizeBytes <= 0
            || (suppliedValidator?.kind === 'etag' && !validator)
            || !/^[a-f0-9]{64}$/.test(identity)
            || !Buffer.isBuffer(payload)
            || payload.length <= 0
            || payload.length > this.maxEntryBytes
            || payload.length > fileSizeBytes
        ) {
            this.stats.rejected += 1;
            return false;
        }
        const stored = {
            fileSizeBytes,
            validator,
            effectiveUrlIdentitySha256: identity,
            payload: Buffer.from(payload),
            expiresAtMs: this.now() + this.ttlMs,
        };
        const previous = this.entries.get(key);
        if (previous) {
            this.entries.delete(key);
            this.bytes = Math.max(0, this.bytes - previous.payload.length);
        }
        this.entries.set(key, stored);
        this.bytes += stored.payload.length;
        this.stats.stores += 1;
        this.prune();
        return this.entries.get(key) === stored;
    }

    publicStatus() {
        this.prune();
        return {
            protocol: 1,
            scope: 'process-private-exact-source',
            validator: 'strong-etag-or-exact-source-size-current-prefix',
            entries: this.entries.size,
            bytes: this.bytes,
            maxBytes: this.maxBytes,
            maxEntryBytes: this.maxEntryBytes,
            ttlMs: this.ttlMs,
            stats: { ...this.stats },
        };
    }
}

module.exports = {
    FiniteMkvResumePrefixCache,
    normalizeStrongEtag,
};
