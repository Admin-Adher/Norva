'use strict';
const crypto = require('node:crypto');
const { RECENT_TTL_MS } = require('./recent-resume-samples');
const targets = new WeakMap();
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const url = value => {
    try {
        const u = new URL(value);
        return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
            && u.href.length <= 8192 ? u.href : null;
    } catch (_) { return null; }
};
// An opaque, one-use routing hint, never a content proof. It is retained only
// inside the existing private cache and can be read only after that cache's
// owner/source/generation/profile binding matched. The new ordinary playback
// claim still owns all network I/O, four fresh samples and exact identity checks.
function retainRecentDeliveryTarget({ ownerKey, sourceUrl, userAgent, fileSizeBytes,
    routeKey, targetUrl, targetHash, targetIdentity, now = Date.now() }) {
    if (!hex(ownerKey) || !url(sourceUrl) || !url(targetUrl) || !hex(targetHash) || !hex(targetIdentity)
        || crypto.createHash('sha256').update(targetUrl).digest('hex') !== targetHash
        || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 65536
        || typeof routeKey !== 'string' || !routeKey || routeKey.length > 256
        || typeof userAgent !== 'string' || !Number.isFinite(now)) return null;
    const token = Object.freeze({});
    targets.set(token, { ownerKey, sourceUrl, userAgent, fileSizeBytes, routeKey,
        targetUrl, targetHash, targetIdentity, at: now });
    return token;
}
function consumeRecentDeliveryTarget(token, request) {
    const value = token && targets.get(token);
    if (token) targets.delete(token);
    if (!value) return null;
    const now = request.now ?? Date.now();
    if (!Number.isFinite(now) || now < value.at || now - value.at >= RECENT_TTL_MS
        || ['ownerKey', 'sourceUrl', 'userAgent', 'fileSizeBytes', 'routeKey']
            .some(key => request[key] !== value[key])) return null;
    return { targetUrl: value.targetUrl, targetHash: value.targetHash, targetIdentity: value.targetIdentity };
}
// A startup prefix can outlive several ordinary playback claims. Keep its
// private routing template intact and issue a one-use hint for each check.
// A fork never refreshes its age or exposes its URL; consume still checks the
// full owner/source/size/user-agent/route binding. Forks cannot fork again.
function forkRecentDeliveryTarget(token, { ownerKey, now = Date.now() } = {}) {
    const value = token && targets.get(token);
    if (!value || value.forkable === false || ownerKey !== value.ownerKey
        || !Number.isFinite(now) || now < value.at || now - value.at >= RECENT_TTL_MS) return null;
    const fork = Object.freeze({});
    targets.set(fork, { ...value, forkable: false });
    return fork;
}
module.exports = { retainRecentDeliveryTarget, consumeRecentDeliveryTarget, forkRecentDeliveryTarget };
