'use strict';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Invoke only AFTER verifyRawToken has verified the Edge HMAC. The signed scope
// attests that Edge resolved the owned movie and proved its exact browser codec
// compatibility. This policy never changes provider routing or slot ownership.
function allowsNativeMp4Capability(claims, { publicBaseUrl, enabled = true } = {}) {
    if (enabled !== true || !claims || claims.v !== 1
        || !['native-browser-mp4', 'native-vod-recovery'].includes(claims.scope)
        || !UUID.test(claims.sid) || !UUID.test(claims.uid) || !UUID.test(claims.resumeSourceId)
        || !Number.isSafeInteger(claims.fileSizeBytes) || claims.fileSizeBytes < 1024) return false;
    try {
        const source = new URL(claims.url);
        const base = new URL(publicBaseUrl);
        // The signed scope follows the owned-file container/codec proof. A real
        // MP4 may use .m4v, a misleading extension or no extension at all; URL
        // suffixes must not contradict the authoritative proof and strand it.
        return base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash
            && ['http:', 'https:'].includes(source.protocol)
            && !source.username && !source.password && !source.hash;
    } catch (_) { return false; }
}

module.exports = { allowsNativeMp4Capability };
