'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function failure(status, code) { return Object.assign(new Error(code), { status, code }); }

// Only Edge sees signed capabilities (which contain provider credentials). The
// browser receives an opaque, revocable handle, never a self-describing token.
function createNativeMp4Sessions({ allows, open, now = Date.now, leaseMs = 60_000,
    maxEntries = 4096, maxActive = 128 } = {}) {
    const entries = new Map();
    const live = entry => entry && !entry.closed && now() < entry.expiresAt && now() < entry.leaseUntil;
    async function close(entry, reason = 'revoked') {
        if (!entry) return;
        if (!entry.closed) {
            entry.closed = true;
            entry.ac.abort();
            entry.closing = (async () => {
                const resource = await entry.opening?.catch(() => null);
                await resource?.close(reason);
            })();
        }
        await entry.closing;
    }
    function active(sid) {
        const entry = entries.get(sid);
        if (!live(entry)) {
            if (entry) void close(entry, 'expired').catch(() => {});
            throw failure(410, 'NATIVE_MP4_SESSION_EXPIRED');
        }
        return entry;
    }
    async function sweep() {
        await Promise.all([...entries.values()].map(async entry => {
            if (!live(entry)) await close(entry, 'expired');
            // Keep revocation tombstones until even the private capability is
            // expired: retrying POST after Back must never resurrect playback.
            if (now() >= entry.expiresAt) entries.delete(entry.sid);
        }));
    }
    return {
        grant(claims) {
            if (!claims || claims.v !== 1 || !['native-browser-mp4', 'native-vod-recovery'].includes(claims.scope)
                || !UUID.test(claims.sid) || !UUID.test(claims.uid)
                || !Number.isSafeInteger(claims.fileSizeBytes) || claims.fileSizeBytes < 1024
                || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now()
                || claims.exp * 1000 > now() + 24 * 3600_000
                || !allows?.(claims)) throw failure(403, 'NATIVE_MP4_CAPABILITY_REJECTED');
            const ownerHash = hash(claims.uid);
            const identity = hash(JSON.stringify([ownerHash, claims.url, claims.fileSizeBytes, claims.exp, claims.ua || '',
                claims.resumeSourceId || '', claims.resumeSourceRevision || '', claims.sharedFragmentGrant || null, claims.scope]));
            const prior = entries.get(claims.sid);
            if (prior) {
                if (prior.identity !== identity) throw failure(409, 'NATIVE_MP4_SESSION_CONFLICT');
                return active(claims.sid);
            }
            if (entries.size >= maxEntries || [...entries.values()].filter(live).length >= maxActive)
                throw failure(503, 'NATIVE_MP4_CAPACITY');
            const entry = { sid: claims.sid, ownerHash, identity, claims: Object.freeze({ ...claims }),
                token: crypto.randomBytes(32).toString('base64url'), expiresAt: claims.exp * 1000,
                leaseUntil: Math.min(claims.exp * 1000, now() + leaseMs), closed: false,
                ac: new AbortController(), opening: null, closing: null };
            entries.set(entry.sid, entry);
            return entry;
        },
        authorize(sid, token) {
            // Uniform denial for incorrect/unknown tokens, before provider I/O.
            const entry = entries.get(sid);
            if (!entry || typeof token !== 'string' || !TOKEN.test(token)
                || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(entry.token)))
                throw failure(401, 'NATIVE_MP4_ACCESS_DENIED');
            return active(sid);
        },
        heartbeat(sid, ownerHash) {
            const entry = entries.get(sid);
            if (!entry || entry.ownerHash !== ownerHash) throw failure(404, 'NATIVE_MP4_SESSION_UNAVAILABLE');
            active(sid);
            entry.leaseUntil = Math.min(entry.expiresAt, now() + leaseMs);
        },
        async resource(entry) {
            active(entry.sid);
            if (!entry.opening) entry.opening = Promise.resolve().then(() => {
                active(entry.sid);
                return open(entry);
            });
            const resource = await entry.opening;
            active(entry.sid);
            return resource;
        },
        close,
        async revoke(ownerHash, sid, global = false) {
            const selected = [...entries.values()].filter(entry => entry.ownerHash === ownerHash
                && (global || entry.sid === sid));
            const count = selected.filter(entry => !entry.closed).length;
            await Promise.all(selected.map(entry => close(entry)));
            return count;
        },
        sweep,
        stats() { return { grants: [...entries.values()].filter(live).length,
            active: [...entries.values()].filter(entry => live(entry) && entry.opening).length }; },
    };
}

// The session's loopback broker serializes all upstream Range reads. It checks
// exact file length and validators; this adapter never contacts the provider.
function pipeNativeMp4(req, res, entry, resource) {
    const target = new URL(resource.inputUrl);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw failure(500, 'NATIVE_MP4_BROKER_INVALID');
    return new Promise(resolve => {
        const headers = {};
        if (typeof req.headers.range === 'string') headers.range = req.headers.range;
        const upstream = http.request(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers });
        const abort = () => upstream.destroy();
        const done = () => { entry.ac.signal.removeEventListener('abort', abort); res.off('close', abort); resolve(); };
        entry.ac.signal.addEventListener('abort', abort, { once: true });
        res.once('close', abort);
        upstream.setTimeout(30_000, () => upstream.destroy(new Error('native idle timeout')));
        upstream.once('response', response => {
            res.statusCode = response.statusCode;
            for (const name of ['content-length', 'content-range', 'accept-ranges']) {
                if (response.headers[name]) res.setHeader(name, response.headers[name]);
            }
            res.setHeader('Content-Type', response.statusCode < 400 && entry.claims.scope === 'native-browser-mp4'
                ? 'video/mp4' : 'application/octet-stream');
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            response.once('error', () => res.destroy());
            response.once('close', done);
            response.pipe(res);
        });
        upstream.once('error', () => {
            if (!res.headersSent) { res.statusCode = entry.closed ? 410 : 502; res.end(); }
            else res.destroy();
            done();
        });
        if (entry.ac.signal.aborted) abort();
        else upstream.end();
    });
}

module.exports = { createNativeMp4Sessions, pipeNativeMp4 };
