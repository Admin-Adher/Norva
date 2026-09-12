'use strict';

// Process-private byte fragments, not a VOD cache. A new broker MUST obtain a
// current exact 206 with the same strong ETag, size and target identity before
// reading any fragment. Last-Modified, URL equality and matching file size alone
// are never sufficient. No network code or provider credentials live here.
const crypto = require('node:crypto');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const strong = value => typeof value === 'string' && value.length <= 512
    && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const changed = () => Object.assign(new Error('VOD_CHANGED'), { code: 'VOD_CHANGED', status: 502 });

class StrictLidRangeReuse {
    constructor({ maxBytes = 32 * 1024 * 1024, perFileBytes = 4 * 1024 * 1024,
        maxFiles = 16, maxFragments = 64, ttlMs = 10 * 60_000, now = Date.now } = {}) {
        if (![maxBytes, perFileBytes, maxFiles, maxFragments, ttlMs].every(Number.isSafeInteger)
            || maxBytes < 1 || maxBytes > 128 * 1024 * 1024 || perFileBytes < 1 || perFileBytes > maxBytes
            || maxFiles < 1 || maxFiles > 128 || maxFragments < 1 || maxFragments > 256
            || ttlMs < 1 || ttlMs > 30 * 60_000) throw new Error('LID_RANGE_CACHE_CONFIG_INVALID');
        Object.assign(this, { maxBytes, perFileBytes, maxFiles, maxFragments, ttlMs, now });
        this.entries = new Map(); this.bytes = 0;
        this.stats = { reusedBytes: 0, hits: 0, invalidations: 0, evictions: 0 };
    }
    drop(key, entry) {
        if (this.entries.get(key) !== entry) return;
        this.entries.delete(key); this.bytes -= entry.bytes; entry.live = false;
        // Existing broker handles may outlive TTL/LRU eviction. Release their
        // retained buffers too; the global bound must reflect real ownership.
        entry.fragments.length = 0;
        entry.bytes = 0;
    }
    prune() {
        const at = this.now();
        for (const [key, entry] of this.entries) if (entry.expiresAt <= at) this.drop(key, entry);
    }
    snapshot() {
        this.prune();
        return { protocol: 1, files: this.entries.size, bytes: this.bytes, ...this.stats };
    }
    begin({ userHash, sourceUrlHash, profileHash, fileSizeBytes } = {}) {
        if (![userHash, sourceUrlHash, profileHash].every(hex) || !Number.isSafeInteger(fileSizeBytes)
            || fileSizeBytes < 1) throw new Error('LID_RANGE_CACHE_BINDING_INVALID');
        this.prune();
        const key = crypto.createHash('sha256').update(JSON.stringify([userHash, sourceUrlHash, profileHash, fileSizeBytes])).digest('hex');
        let entry = this.entries.get(key); let confirmed = false; let disabled = false;
        const prior = entry ? { validator: { kind: 'etag', header: 'If-Range', value: entry.etag },
            effectiveUrlIdentitySha256: entry.identity } : null;
        const live = () => !disabled && entry?.live && entry.expiresAt > this.now()
            && this.entries.get(key) === entry;
        const touch = () => { this.entries.delete(key); this.entries.set(key, entry); };
        const invalidate = () => {
            if (live()) { this.drop(key, entry); this.stats.invalidations++; }
            disabled = true; confirmed = false;
        };
        const matches = observed => observed?.validator?.kind === 'etag' && strong(observed.validator.value)
            && hex(observed.effectiveUrlIdentitySha256) && observed.fileSizeBytes === fileSizeBytes;
        const find = (start, end) => live() ? entry.fragments.find(f => f.start <= start && f.end >= start && start <= end) : null;
        const trim = () => {
            // Preserve the initial header and terminal index preferentially;
            // interior excerpts are optional and are evicted before those.
            while (entry.bytes > this.perFileBytes || entry.fragments.length > this.maxFragments) {
                const ordered = [...entry.fragments].sort((a, b) => a.priority - b.priority || a.used - b.used);
                const victim = ordered[0];
                entry.fragments.splice(entry.fragments.indexOf(victim), 1);
                entry.bytes -= victim.payload.length; this.bytes -= victim.payload.length; this.stats.evictions++;
            }
            while (this.entries.size > this.maxFiles || this.bytes > this.maxBytes) {
                const oldest = this.entries.entries().next().value;
                if (!oldest) break;
                this.drop(...oldest); this.stats.evictions++;
            }
        };
        return Object.freeze({
            prior,
            // Immutable coordinates only, for playback to distinguish fragments
            // retained before this session from bytes acquired during it.
            priorRanges: Object.freeze((entry?.fragments || []).map(f => Object.freeze({ start: f.start, end: f.end }))),
            // Only informs a one-byte conditional revalidation request. It
            // exposes no cached bytes before the upstream response is checked.
            hasCandidate: (start, end) => Boolean(find(start, end)),
            get confirmed() { return confirmed && live(); },
            confirm: observed => {
                if (disabled) return false;
                if (!matches(observed)) {
                    if (prior || live()) { invalidate(); throw changed(); }
                    disabled = true; return false;
                }
                const current = entry || this.entries.get(key);
                if (current && (current.etag !== observed.validator.value || current.identity !== observed.effectiveUrlIdentitySha256)) {
                    // A stale session cannot overwrite a newer representation.
                    invalidate(); throw changed();
                }
                if (entry && !live()) { disabled = true; return false; }
                if (!entry) {
                    entry = current || { etag: observed.validator.value, identity: observed.effectiveUrlIdentitySha256,
                        fragments: [], bytes: 0, live: true, expiresAt: this.now() + this.ttlMs };
                    this.entries.set(key, entry); trim();
                }
                confirmed = live(); if (confirmed) touch(); return confirmed;
            },
            read: (start, end) => {
                if (!confirmed || !live()) return null;
                const f = find(start, end); if (!f) return null;
                f.used = this.now(); touch();
                const bytes = f.payload.subarray(start - f.start, Math.min(end, f.end) - f.start + 1);
                this.stats.hits++; this.stats.reusedBytes += bytes.length;
                return Buffer.from(bytes); // callers cannot mutate retained proof
            },
            // Bound a missing range at the next cached fragment, never at an
            // arbitrary tiny window. This avoids multiplying provider requests.
            missingEnd: (start, end) => {
                if (!confirmed || !live()) return end;
                const next = entry.fragments.find(f => f.start > start && f.start <= end);
                return next ? next.start - 1 : end;
            },
            remember: (start, payload, { providerDrained = false } = {}) => {
                if (!providerDrained || !confirmed || !live() || !Buffer.isBuffer(payload) || !payload.length
                    || payload.length > this.perFileBytes || !Number.isSafeInteger(start) || start < 0
                    || start + payload.length > fileSizeBytes) return false;
                const end = start + payload.length - 1;
                // Store only missing intervals; overlapping seeks do not multiply
                // memory or replace bytes attested under the pinned representation.
                let offset = start;
                for (const f of [...entry.fragments.filter(f => f.start <= end), { start: end + 1, end: end + 1 }]) {
                    if (f.end < offset) continue;
                    if (f.start > end + 1) break;
                    const until = Math.min(end + 1, f.start);
                    if (until > offset) {
                        const bytes = Buffer.from(payload.subarray(offset - start, until - start));
                        entry.fragments.push({ start: offset, end: until - 1, payload: bytes, used: this.now(),
                            priority: offset < 256 * 1024 || until > fileSizeBytes - 1024 * 1024 ? 1 : 0 });
                        entry.bytes += bytes.length; this.bytes += bytes.length;
                    }
                    offset = Math.max(offset, f.end + 1);
                    if (offset > end) break;
                }
                entry.fragments.sort((a, b) => a.start - b.start); touch(); trim();
                return live();
            },
            invalidate,
        });
    }
}

// A bounded prefix of an existing provider response. Retaining this must never
// cause another byte to be requested or delay/cancel the real consumer.
function createStrictRangeCollector(start, maxBytes = 512 * 1024) {
    let size = 0; const chunks = [];
    return {
        push(chunk) {
            if (!Buffer.isBuffer(chunk) || size >= maxBytes) return;
            const copy = Buffer.from(chunk.subarray(0, maxBytes - size));
            chunks.push(copy); size += copy.length;
        },
        commit(session) {
            if (size) session.remember(start, Buffer.concat(chunks, size), { providerDrained: true });
            chunks.length = 0; size = 0;
        },
    };
}

module.exports = { StrictLidRangeReuse, createStrictRangeCollector };
