'use strict';
const crypto = require('node:crypto');
const { strongResumeIdentity } = require('./private-resume-binding');
const keyFor = binding => crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
const namePattern = /^[a-z0-9][a-z0-9._-]{0,127}\.ts$/i;

// Deliberately accepts only independent, unencrypted single A/V MPEG-TS HLS.
// Source container is immaterial (MP4/MKV/TS). Other rendition graphs are a
// cache miss: never silently remove an audio or subtitle track to obtain a hit.
function parseResumeMediaPlaylist(text) {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024 || !text.startsWith('#EXTM3U')
        || /#EXT-X-(?:STREAM-INF|MEDIA:|KEY:|MAP:|BYTERANGE:|GAP|DISCONTINUITY)/.test(text)
        || !text.includes('#EXT-X-INDEPENDENT-SEGMENTS')) return null;
    const segments = []; let duration = null, elapsed = 0;
    for (const line of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        if (line.startsWith('#EXTINF:')) {
            if (duration !== null) return null;
            duration = Number(line.slice(8).split(',')[0]);
            if (!Number.isFinite(duration) || duration <= 0 || duration > 30) return null;
        } else if (!line.startsWith('#')) {
            if (duration === null || !namePattern.test(line) || line.includes('..')) return null;
            segments.push({ name: line, duration, start: elapsed, end: elapsed + duration });
            elapsed += duration; duration = null;
        }
    }
    if (duration !== null || !segments.length || new Set(segments.map(s => s.name)).size !== segments.length) return null;
    return { segments, ended: /#EXT-X-ENDLIST(?:\r?\n|$)/.test(text), duration: elapsed };
}

function mergedResumePlaylist(window, continuationText = '') {
    const continuation = continuationText ? parseResumeMediaPlaylist(continuationText) : null;
    if (continuationText && !continuation) throw new Error('RESUME_CONTINUATION_GRAPH_INVALID');
    // EVENT headers must remain identical when the encoder's first segment
    // arrives (RFC 8216 6.2.1). Use the admission ceiling, not a moving maximum.
    // Playback still starts at the explicit resume offset with a 6 s buffer;
    // this header only bounds legal segment durations and playlist reloads.
    const target = 30;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS',
        `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:EVENT'];
    for (const s of window.segments) lines.push(`#EXTINF:${s.duration.toFixed(6)},`, s.name);
    if (continuation?.segments.length) {
        // Each encoder starts a new timestamp sequence. Exactly one explicit
        // discontinuity belongs at the splice, never ahead of the cached prefix.
        lines.push('#EXT-X-DISCONTINUITY');
        for (const s of continuation.segments) lines.push(`#EXTINF:${s.duration.toFixed(6)},`, s.name);
    }
    if (window.ended || continuation?.ended) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
}

class PrivateResumeHlsCache {
    constructor({ maxBytes = 128 * 1024 * 1024, perFileBytes = 32 * 1024 * 1024,
        maxEntries = 32, ttlMs = 30 * 60_000, windowSeconds = 48, minimumAheadSeconds = 24, now = Date.now } = {}) {
        if (![maxBytes, perFileBytes, maxEntries, ttlMs, windowSeconds, minimumAheadSeconds].every(Number.isSafeInteger)
            || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 || perFileBytes < 1 || perFileBytes > maxBytes
            || maxEntries < 1 || maxEntries > 128 || ttlMs < 1 || ttlMs > 30 * 60_000
            || windowSeconds < 1 || windowSeconds > 120 || minimumAheadSeconds < 1 || minimumAheadSeconds > windowSeconds)
            throw new Error('RESUME_CACHE_CONFIG_INVALID');
        Object.assign(this, { maxBytes, perFileBytes, maxEntries, ttlMs, windowSeconds, minimumAheadSeconds, now });
        this.entries = new Map(); this.bytes = 0; this.reservedBytes = 0; this.epoch = 0;
        this.stats = { stores: 0, hits: 0, misses: 0, invalidations: 0, evictions: 0 };
    }
    drop(key, entry) {
        if (this.entries.get(key) !== entry) return;
        this.entries.delete(key); this.bytes -= entry.bytes; entry.live = false; entry.assets.clear();
    }
    prune() {
        for (const [key, entry] of this.entries) if (!entry.leases && entry.expiresAt <= this.now()) this.drop(key, entry);
    }
    revokeOwner(ownerKey) {
        this.epoch++;
        for (const [key, entry] of this.entries) if (entry.binding.ownerKey === ownerKey) {
            this.drop(key, entry); this.stats.invalidations++;
        }
    }
    candidate(binding, position) {
        this.prune();
        if (!binding || !Number.isFinite(position) || position < 0) return null;
        const entry = this.entries.get(keyFor(binding));
        return entry?.live && entry.expiresAt > this.now() && position >= entry.start
            && position < entry.end && (entry.ended || entry.end - position >= this.minimumAheadSeconds)
            ? entry : null;
    }
    hasCandidate(binding, position) { return Boolean(this.candidate(binding, position)); }
    acquire(binding, position, observed) {
        const entry = this.candidate(binding, position);
        if (!entry) { this.stats.misses++; return null; }
        const identity = strongResumeIdentity(observed, binding.fileSizeBytes);
        if (!identity || identity !== entry.identity) {
            this.drop(keyFor(binding), entry); this.stats.invalidations++; this.stats.misses++; return null;
        }
        let released = false; entry.leases++; this.stats.hits++;
        const valid = () => !released && entry.live && this.entries.get(keyFor(binding)) === entry;
        const ensure = () => { if (!valid()) throw new Error('RESUME_CACHE_REVOKED'); };
        return Object.freeze({
            start: entry.start, end: entry.end, ended: entry.ended, aheadSeconds: entry.end - position,
            playlist: continuation => { ensure(); return mergedResumePlaylist(entry, continuation); },
            asset: name => { ensure(); const bytes = entry.assets.get(name); return bytes ? Buffer.from(bytes) : null; },
            release: () => { if (!released) { released = true; entry.leases--; this.prune(); } },
        });
    }
    async capture({ binding, observed, position, actualStartOffset, playlist, readAsset } = {}) {
        if (!binding || !Number.isFinite(position) || position <= 0 || !Number.isFinite(actualStartOffset)
            || actualStartOffset < 0 || typeof readAsset !== 'function') return false;
        const identity = strongResumeIdentity(observed, binding.fileSizeBytes);
        const parsed = identity && parseResumeMediaPlaylist(playlist);
        if (!parsed) return false;
        const localPosition = position - actualStartOffset;
        const index = parsed.segments.findIndex(s => s.start <= localPosition && s.end > localPosition);
        if (index < 0) return false;
        const selected = parsed.segments.slice(Math.max(0, index - 1)).filter(s => s.start < localPosition + this.windowSeconds);
        const start = selected[0].start + actualStartOffset;
        const end = selected.at(-1).end + actualStartOffset;
        const ended = parsed.ended && selected.at(-1) === parsed.segments.at(-1);
        if (!ended && end - position < this.minimumAheadSeconds) return false;
        this.prune(); const key = keyFor(binding), prior = this.entries.get(key);
        if (prior?.leases) return false;
        if (prior) this.drop(key, prior);
        // Reserve the entire per-file budget before asynchronous reads. Pending
        // captures and leased windows count towards the same hard memory bound.
        const reservation = 2 * this.perFileBytes; // read buffer + immutable copy
        while (this.entries.size >= this.maxEntries || this.bytes + this.reservedBytes + reservation > this.maxBytes) {
            const victim = [...this.entries].find(([, entry]) => !entry.leases);
            if (!victim) return false;
            this.drop(...victim); this.stats.evictions++;
        }
        this.reservedBytes += reservation;
        const epoch = this.epoch; let bytes = 0; const assets = new Map(), segments = [];
        try {
            for (const [i, segment] of selected.entries()) {
                const payload = await readAsset(segment.name, this.perFileBytes - bytes);
                if (epoch !== this.epoch || !Buffer.isBuffer(payload) || !payload.length
                    || payload.length > this.perFileBytes - bytes) return false;
                const name = `resume-${i}.ts`;
                // Detached immutable snapshot. A new FFmpeg process may delete
                // or replace its temporary files without changing this cache.
                assets.set(name, Buffer.from(payload)); bytes += payload.length;
                segments.push({ name, duration: segment.duration });
            }
            if (this.entries.has(key) || this.entries.size >= this.maxEntries) return false;
            this.entries.set(key, { binding, identity, start, end, ended, segments, assets, bytes,
                expiresAt: this.now() + this.ttlMs, leases: 0, live: true });
            this.bytes += bytes; this.stats.stores++; return true;
        } catch (_) { return false; }
        finally { this.reservedBytes -= reservation; }
    }
    publicStatus() { this.prune(); return { protocol: 1, ...this.stats, entries: this.entries.size,
        bytes: this.bytes, reservedBytes: this.reservedBytes, maxBytes: this.maxBytes,
        perFileBytes: this.perFileBytes, ttlMs: this.ttlMs, windowSeconds: this.windowSeconds,
        scope: 'private-owner-source-revision', revalidation: 'current-strong-etag-size-target' }; }
}
module.exports = { PrivateResumeHlsCache, parseResumeMediaPlaylist, mergedResumePlaylist };
