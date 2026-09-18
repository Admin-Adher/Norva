'use strict';
const crypto = require('node:crypto');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MiB = 1024 * 1024;

// This is a server-only, opt-in cache. A catalogue id is not a byte identity.
// In particular, do NOT use the private broker's query-normalized target here:
// the entire effective URL (including query values) must identify one resource.
function sharedProof(observed, size) {
    if (observed?.fileSizeBytes !== size || !hex(observed.effectiveUrlSha256)
        || observed.validator?.kind !== 'etag'
        || typeof observed.validator.value !== 'string' || observed.validator.value.length > 512
        || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(observed.validator.value)) return null;
    const control = typeof observed.cacheControl === 'string' ? observed.cacheControl.toLowerCase() : '';
    // Explicit upstream shared-cache permission, plus an operator-enabled
    // provider grant. A private/no-store response must never enter this pool.
    if (/\b(?:private|no-store|no-cache)\b/.test(control)
        || !/(?:^|,)\s*(?:public\s*(?:,|$)|s-maxage\s*=\s*"?[1-9]\d*"?\s*(?:,|$))/.test(control)
        || (observed.vary && String(observed.vary).trim()) || observed.setCookie === true) return null;
    return digest([observed.effectiveUrlSha256, observed.validator.value, size]);
}

class SharedPlaybackRanges {
    constructor({ enabled = false, maxBytes = 64 * MiB, perFileBytes = 16 * MiB,
        fragmentBytes = MiB, prefixBytes = 8 * MiB, tailBytes = MiB,
        maxEntries = 128, maxDemandEntries = 2048, ttlMs = 10 * 60_000, now = Date.now } = {}) {
        if (![maxBytes, perFileBytes, fragmentBytes, prefixBytes, tailBytes, maxEntries, maxDemandEntries, ttlMs]
            .every(Number.isSafeInteger) || maxBytes < 1 || maxBytes > 128 * MiB
            || perFileBytes < 1 || perFileBytes > maxBytes || fragmentBytes < 1 || fragmentBytes > perFileBytes
            || prefixBytes < 0 || prefixBytes > perFileBytes || tailBytes < 0 || tailBytes > perFileBytes
            || maxEntries < 1 || maxEntries > 4096 || maxDemandEntries < 1 || maxDemandEntries > 8192
            || ttlMs < 1 || ttlMs > 30 * 60_000) throw new Error('SHARED_RANGE_CONFIG_INVALID');
        Object.assign(this, { enabled, maxBytes, perFileBytes, fragmentBytes, prefixBytes, tailBytes,
            maxEntries, maxDemandEntries, ttlMs, now });
        this.entries = new Map(); this.demand = new Map(); this.bytes = 0;
        // A single epoch fences outstanding handles without retaining an
        // unbounded table of former users. Revocation may cause other misses,
        // never an entitlement bypass; shared bytes themselves are not a grant.
        this.epoch = 0;
        this.stats = { stores: 0, hits: 0, reusedBytes: 0, evictions: 0, coldInteriorSkipped: 0 };
    }
    drop(key, entry) {
        if (this.entries.get(key) !== entry) return;
        this.entries.delete(key); this.bytes -= entry.payload.length;
    }
    prune() {
        for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.drop(key, entry);
        for (const [key, entry] of this.demand) if (entry.expiresAt <= this.now()) this.demand.delete(key);
    }
    revokeOwner(ownerKey) { if (hex(ownerKey)) this.epoch++; }
    begin({ grant, ownerKey, fileSizeBytes, signal } = {}) {
        this.prune();
        if (!this.enabled || !hex(ownerKey) || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1
            || grant?.protocol !== 1 || grant?.ownerKey !== ownerKey
            || !hex(grant.providerIdentitySha256) || !hex(grant.catalogueItemSha256)
            || !Number.isSafeInteger(grant.expiresAtMs) || grant.expiresAtMs <= this.now()
            || grant.expiresAtMs > this.now() + 24 * 3600_000) return null;
        const epoch = this.epoch;
        const expiresAtMs = grant.expiresAtMs;
        const namespace = digest([grant.providerIdentitySha256, grant.catalogueItemSha256]);
        let proof = null, disabled = false, reusedBytes = 0;
        const live = () => !disabled && epoch === this.epoch && !signal?.aborted && this.now() < expiresAtMs;
        const candidates = () => {
            this.prune();
            return live() && proof ? [...this.entries.values()].filter(e => e.namespace === namespace && e.proof === proof) : [];
        };
        const touchDemand = (start, end) => {
            const key = digest([namespace, proof, start, end]);
            let d = this.demand.get(key);
            if (!d) d = { firstOwner: ownerKey, popular: false, expiresAt: this.now() + this.ttlMs };
            if (d.firstOwner !== ownerKey) d.popular = true;
            this.demand.delete(key); this.demand.set(key, d);
            while (this.demand.size > this.maxDemandEntries) this.demand.delete(this.demand.keys().next().value);
            return { key, popular: d.popular };
        };
        return Object.freeze({
            // Check a small fresh provider range on opt-in shared requests.
            // No cached validator, URL or data is exposed before confirm().
            requiresValidation: true,
            confirm: observed => {
                if (!live()) return false;
                const next = sharedProof(observed, fileSizeBytes);
                if (!next || (proof && proof !== next)) { disabled = true; proof = null; return false; }
                proof = next; return true;
            },
            read: (start, end) => {
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
                const entry = candidates().find(e => e.start <= start && e.end >= start);
                if (!entry) return null;
                this.entries.delete(entry.key); this.entries.set(entry.key, entry);
                const bytes = Buffer.from(entry.payload.subarray(start - entry.start, Math.min(end, entry.end) - entry.start + 1));
                this.stats.hits++; this.stats.reusedBytes += bytes.length; reusedBytes += bytes.length; return bytes;
            },
            missingEnd: (start, end) => candidates().reduce((until, e) => e.start > start && e.start <= until ? e.start - 1 : until, end),
            remember: (start, payload) => {
                if (!live() || !proof || !Number.isSafeInteger(start) || start < 0 || !Buffer.isBuffer(payload)
                    || !payload.length || payload.length > 8 * MiB || start + payload.length > fileSizeBytes) return false;
                let stored = false;
                // Exact fragments from an already-drained provider response;
                // no prefetch, secondary connection or full-file materializing.
                for (let offset = 0; offset < payload.length;) {
                    const from = start + offset;
                    const length = Math.min(payload.length - offset, this.fragmentBytes - from % this.fragmentBytes);
                    const end = from + length - 1;
                    const { key, popular } = touchDemand(from, end);
                    const priority = end < this.prefixBytes || from >= fileSizeBytes - this.tailBytes ? 1 : 0;
                    if (!priority && !popular) { this.stats.coldInteriorSkipped++; offset += length; continue; }
                    if (this.entries.has(key)) { offset += length; continue; }
                    const fileBytes = () => [...this.entries.values()].filter(e => e.namespace === namespace && e.proof === proof)
                        .reduce((sum, e) => sum + e.payload.length, 0);
                    while (this.bytes + length > this.maxBytes || this.entries.size >= this.maxEntries || fileBytes() + length > this.perFileBytes) {
                        const ownFull = fileBytes() + length > this.perFileBytes;
                        const victim = [...this.entries.values()]
                            .filter(e => !ownFull || (e.namespace === namespace && e.proof === proof))
                            .sort((a, b) => a.priority - b.priority)[0];
                        if (!victim) break;
                        this.drop(victim.key, victim); this.stats.evictions++;
                    }
                    if (this.bytes + length <= this.maxBytes && fileBytes() + length <= this.perFileBytes && this.entries.size < this.maxEntries) {
                        const bytes = Buffer.from(payload.subarray(offset, offset + length));
                        this.entries.set(key, { key, namespace, proof, start: from, end, payload: bytes, priority,
                            expiresAt: this.now() + this.ttlMs });
                        this.bytes += length; this.stats.stores++; stored = true;
                    }
                    offset += length;
                }
                return stored;
            },
            invalidate: () => { disabled = true; proof = null; },
            get reusedBytes() { return reusedBytes; },
        });
    }
    publicStatus() { this.prune(); return { enabled: this.enabled, ...this.stats, entries: this.entries.size,
        bytes: this.bytes, maxBytes: this.maxBytes, perFileBytes: this.perFileBytes, ttlMs: this.ttlMs,
        demandEntries: this.demand.size, scope: 'authorized-catalogue-exact-target-strong-etag', policy: 'prefix-index-popular' }; }
}

// Private cache remains the fallback; neither grant nor proof is shared with
// the player. Both stores receive only completed broker ranges.
function hybridPlaybackRanges(privateRanges, sharedRanges) {
    if (!sharedRanges) return privateRanges;
    let privateConfirmed = false, sharedConfirmed = false;
    return Object.freeze({
        hasPriorRanges: Boolean(privateRanges?.hasPriorRanges), requiresValidation: true,
        confirm(observed) {
            privateConfirmed = privateRanges?.confirm(observed) === true;
            sharedConfirmed = sharedRanges.confirm(observed) === true;
            return privateConfirmed || sharedConfirmed;
        },
        read: (start, end) => privateRanges?.read(start, end) || sharedRanges.read(start, end),
        anchorAt(byteOffset) {
            const privateAnchored = privateRanges?.anchorAt?.(byteOffset) === true;
            const sharedAnchored = sharedRanges.anchorAt?.(byteOffset) === true;
            return privateAnchored || sharedAnchored;
        },
        missingEnd: (start, end) => Math.min(privateRanges?.missingEnd(start, end) ?? end, sharedRanges.missingEnd(start, end)),
        remember(start, bytes) {
            const own = privateConfirmed && privateRanges.remember(start, bytes);
            const common = sharedConfirmed && sharedRanges.remember(start, bytes);
            return Boolean(own || common);
        },
        invalidate() { privateRanges?.invalidate(); sharedRanges.invalidate(); },
        get reusedBytes() { return (privateRanges?.reusedBytes || 0) + sharedRanges.reusedBytes; },
        get sharedReusedBytes() { return sharedRanges.reusedBytes; },
    });
}
module.exports = { SharedPlaybackRanges, sharedProof, hybridPlaybackRanges };
