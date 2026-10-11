'use strict';
const crypto = require('node:crypto');
const { RECENT_TTL_MS } = require('./recent-resume-samples');
const targets = new WeakMap();
const consumedTargets = new WeakMap();
const refusedTargets = new Map();
const refusalKey = value => crypto.createHash('sha256').update(JSON.stringify(
    ['ownerKey','sourceUrl','userAgent','fileSizeBytes','routeKey'].map(key=>value[key]))).digest('hex');
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
    for (const [key, at] of refusedTargets) if (now >= at + RECENT_TTL_MS) refusedTargets.delete(key);
    const key = refusalKey(value), refusedAt = refusedTargets.get(key);
    // A refused retained URL is only a failed routing shortcut. Delivery
    // paths can rotate at every normal opening: suppress hints for this
    // exact private source/route binding, not just the previous signed path.
    // A different target is NEVER accepted as proof by this routing choice.
    // The next
    // claim starts at its normal source on the SAME pinned route and must
    // still freshly validate the target and all four sample digests.
    if (refusedAt !== undefined && now - refusedAt < RECENT_TTL_MS) return null;
    const resolved = { targetUrl: value.targetUrl, targetHash: value.targetHash, targetIdentity: value.targetIdentity };
    consumedTargets.set(resolved, { key, at: now });
    return resolved;
}

// Record only the observed 509 refusal of a genuine consumed hint, after its
// uncached broker has drained. Keep hashes/timestamps, never URLs or media.
// This does not retry the failed claim or authorize a cache hit.
function noteRecentDeliveryTargetFailure(resolved, { upstreamStatus, now = Date.now() } = {}) {
    const value = resolved && consumedTargets.get(resolved);
    if (!value || upstreamStatus !== 509 || !Number.isFinite(now) || now < value.at) return false;
    consumedTargets.delete(resolved);
    refusedTargets.delete(value.key); refusedTargets.set(value.key, now);
    while (refusedTargets.size > 64) refusedTargets.delete(refusedTargets.keys().next().value);
    return true;
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
module.exports = { retainRecentDeliveryTarget, consumeRecentDeliveryTarget, forkRecentDeliveryTarget, noteRecentDeliveryTargetFailure };
