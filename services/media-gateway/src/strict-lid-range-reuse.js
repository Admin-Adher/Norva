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
        maxFiles = 16, maxFragments = 64, ttlMs = 10 * 60_000, now = Date.now,
        // Protected viewer window. When set together with a viewer anchor, a
        // fragment lying entirely outside [anchor - behind, anchor + ahead] is
        // not retained at all: distant read-ahead is dropped rather than
        // allowed to consume the budget the resume window needs. Both null
        // (the default) preserves the previous behaviour exactly.
        retainBehindBytes = null, retainAheadBytes = null } = {}) {
        if (![maxBytes, perFileBytes, maxFiles, maxFragments, ttlMs].every(Number.isSafeInteger)
            || maxBytes < 1 || maxBytes > 128 * 1024 * 1024 || perFileBytes < 1 || perFileBytes > maxBytes
            || maxFiles < 1 || maxFiles > 128 || maxFragments < 1 || maxFragments > 256
            || ttlMs < 1 || ttlMs > 30 * 60_000) throw new Error('LID_RANGE_CACHE_CONFIG_INVALID');
        Object.assign(this, { maxBytes, perFileBytes, maxFiles, maxFragments, ttlMs, now });
        this.retainBehindBytes = Number.isSafeInteger(retainBehindBytes) && retainBehindBytes >= 0
            ? retainBehindBytes : null;
        this.retainAheadBytes = Number.isSafeInteger(retainAheadBytes) && retainAheadBytes >= 0
            ? retainAheadBytes : null;
        this.droppedDistantPrefetch = 0;
        this.entries = new Map(); this.bytes = 0; this.revocationEpoch = 0;
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

    // Read-only introspection for operators. Byte coordinates, sizes and ages
    // only: never payload bytes, validators, effective identities or owner
    // hashes. `ref` is a truncated digest of already-hashed binding material,
    // enough to correlate two observations, not to reconstruct a source.
    describe() {
        this.prune();
        const at = this.now();
        return {
            protocol: 1,
            files: this.entries.size,
            bytes: this.bytes,
            limits: { maxBytes: this.maxBytes, perFileBytes: this.perFileBytes,
                maxFiles: this.maxFiles, maxFragments: this.maxFragments, ttlMs: this.ttlMs,
                retainBehindBytes: this.retainBehindBytes, retainAheadBytes: this.retainAheadBytes },
            droppedDistantPrefetch: this.droppedDistantPrefetch,
            entries: Array.from(this.entries.entries()).map(([key, entry]) => ({
                ref: String(key).slice(0, 12),
                live: entry.live === true,
                bytes: entry.bytes,
                anchor: Number.isSafeInteger(entry.anchor) ? entry.anchor : null,
                fragments: entry.fragments.length,
                expiresInMs: Math.max(0, entry.expiresAt - at),
                ranges: entry.fragments.map(fragment => ({
                    start: fragment.start,
                    end: fragment.end,
                    bytes: fragment.payload.length,
                    priority: fragment.priority,
                    idleMs: at - fragment.used,
                })),
            })),
        };
    }
    revokeOwner(userHash) {
        if (!hex(userHash)) return 0;
        // Also fence handles opened before revocation but not yet confirmed.
        this.revocationEpoch++;
        let count = 0;
        for (const [key, entry] of this.entries) if (entry.userHash === userHash) {
            this.drop(key, entry); count++;
        }
        return count;
    }
    begin({ userHash, sourceUrlHash, profileHash, fileSizeBytes } = {}) {
        if (![userHash, sourceUrlHash, profileHash].every(hex) || !Number.isSafeInteger(fileSizeBytes)
            || fileSizeBytes < 1) throw new Error('LID_RANGE_CACHE_BINDING_INVALID');
        this.prune();
        const key = crypto.createHash('sha256').update(JSON.stringify([userHash, sourceUrlHash, profileHash, fileSizeBytes])).digest('hex');
        let entry = this.entries.get(key); let confirmed = false; let disabled = false;
        const revocationEpoch = this.revocationEpoch;
        const prior = entry ? { validator: { kind: 'etag', header: 'If-Range', value: entry.etag },
            effectiveUrlIdentitySha256: entry.identity } : null;
        const live = () => !disabled && revocationEpoch === this.revocationEpoch && entry?.live && entry.expiresAt > this.now()
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
            // interior excerpts are evicted before those.
            //
            // Among interior excerpts, evict by DISTANCE from the viewer, not by
            // recency. Read-ahead runs far beyond the viewer (a 20x encode is
            // thousands of seconds ahead by the time playback stops), so the most
            // recently remembered fragment is always the frontier and the least
            // recently remembered one is the window nearest the viewer. Plain LRU
            // therefore retains the frontier and discards precisely the bytes a
            // resume at the saved position needs. With a viewer anchor, drop the
            // furthest fragment instead and keep the playable window.
            while (entry.bytes > this.perFileBytes || entry.fragments.length > this.maxFragments) {
                const anchor = Number.isSafeInteger(entry.anchor) ? entry.anchor : null;
                const distance = (f) => (f.start <= anchor && f.end >= anchor)
                    ? 0
                    : (f.start > anchor ? f.start - anchor : anchor - f.end);
                const ordered = [...entry.fragments].sort((a, b) => a.priority - b.priority
                    || (anchor === null
                        ? a.used - b.used
                        : (distance(b) - distance(a)) || (a.used - b.used)));
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
                if (disabled || revocationEpoch !== this.revocationEpoch) return false;
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
                    entry = current || { userHash, etag: observed.validator.value, identity: observed.effectiveUrlIdentitySha256,
                        fragments: [], bytes: 0, live: true, anchor: null, expiresAt: this.now() + this.ttlMs };
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
                // Drop distant read-ahead instead of letting it evict the window
                // the viewer is actually in. Only applies once a viewer anchor
                // and an explicit window are configured.
                const outsideProtectedWindow = Number.isSafeInteger(entry?.anchor)
                    && (this.retainAheadBytes !== null || this.retainBehindBytes !== null)
                    && (
                        (this.retainAheadBytes !== null && start > entry.anchor + this.retainAheadBytes)
                        || (this.retainBehindBytes !== null && end < entry.anchor - this.retainBehindBytes)
                    );
                if (outsideProtectedWindow) { this.droppedDistantPrefetch++; return false; }
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
            // The viewer's current byte position, used only to choose eviction
            // victims. It admits no bytes, relaxes no validation and is ignored
            // entirely when absent.
            anchorAt: (byteOffset) => {
                if (!confirmed || !live() || !entry) return false;
                if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset >= fileSizeBytes) return false;
                entry.anchor = byteOffset;
                trim();
                return true;
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
