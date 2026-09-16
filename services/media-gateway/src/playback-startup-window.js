'use strict';
const { createPrivateResumeOwnerGate } = require('./private-resume-binding');

// Independent from the cache rollout. Missing/invalid owners fail closed;
// enabling small transport windows never grants cross-session byte reuse.
function createPlaybackStartupWindowPolicy({ enabled = false, ownerHashes } = {}) {
    const allows = createPrivateResumeOwnerGate({ enabled,
        ownerHashes: String(ownerHashes || '').trim() || 'not-configured' });
    return Object.freeze({
        mp4Session(ownerKey, { finite = false, knownProfile = false, fileSizeBytes } = {}) {
            return allows(ownerKey) && finite === true && knownProfile === true
                && Number.isSafeInteger(fileSizeBytes) && fileSizeBytes > 0;
        },
        bytes(ownerKey, ordinaryBytes) { return allows(ownerKey) ? Math.min(ordinaryBytes, 2 * 1024 * 1024) : ordinaryBytes; },
        requestEnd(ownerKey, start, ordinaryEnd) {
            return allows(ownerKey) ? Math.min(ordinaryEnd, start + 2 * 1024 * 1024 - 1) : ordinaryEnd;
        },
        status() { return { enabled, ownerScoped: true, windowBytes: 2 * 1024 * 1024 }; },
    });
}

module.exports = { createPlaybackStartupWindowPolicy };
