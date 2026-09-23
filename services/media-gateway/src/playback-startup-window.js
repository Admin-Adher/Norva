'use strict';
const { createPrivateResumeOwnerGate } = require('./private-resume-binding');

// Independent from the cache rollout. The explicit global flag removes only
// the rollout allowlist: owners must still come from authenticated Edge input.
// Missing/invalid pilot owners fail closed. Transport windows never grant
// cross-session byte reuse or relax the finite, known-profile MP4 checks.
function createPlaybackStartupWindowPolicy({ enabled = false, ownerHashes, allAuthenticatedOwners = false } = {}) {
    const global = allAuthenticatedOwners === true;
    const allows = createPrivateResumeOwnerGate({ enabled,
        ownerHashes: global ? undefined : String(ownerHashes || '').trim() || 'not-configured' });
    return Object.freeze({
        mp4Session(ownerKey, { finite = false, knownProfile = false, fileSizeBytes } = {}) {
            return allows(ownerKey) && finite === true && knownProfile === true
                && Number.isSafeInteger(fileSizeBytes) && fileSizeBytes > 0;
        },
        bytes(ownerKey, ordinaryBytes) { return allows(ownerKey) ? Math.min(ordinaryBytes, 2 * 1024 * 1024) : ordinaryBytes; },
        requestEnd(ownerKey, start, ordinaryEnd) {
            return allows(ownerKey) ? Math.min(ordinaryEnd, start + 2 * 1024 * 1024 - 1) : ordinaryEnd;
        },
        status() { return { enabled: enabled === true, ownerScoped: !global,
            scope: global ? 'all-authenticated-owners' : 'owner-allowlist', windowBytes: 2 * 1024 * 1024 }; },
    });
}

module.exports = { createPlaybackStartupWindowPolicy };
