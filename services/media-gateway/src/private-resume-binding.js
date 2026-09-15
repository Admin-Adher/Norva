'use strict';
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Optional production canary fence. A configured but invalid allowlist must
// fail closed, not accidentally turn into an unrestricted rollout.
function createPrivateResumeOwnerGate({ enabled = false, ownerHashes } = {}) {
    const scoped = ownerHashes !== undefined && ownerHashes !== null && String(ownerHashes).trim() !== '';
    const owners = new Set(String(ownerHashes || '').split(/[,\s]+/).filter(hex));
    return ownerKey => enabled === true && hex(ownerKey) && (!scoped || owners.has(ownerKey));
}

// Source revision is supplied by the authenticated Edge, never by the player.
// URL and credentials are hashed in-process and never included in diagnostics.
function privateResumeBinding({ ownerKey, sourceUrl, sourceId, sourceRevision, fileSizeBytes, profile = '' } = {}) {
    if (!hex(ownerKey) || typeof sourceUrl !== 'string' || !sourceUrl
        || typeof sourceId !== 'string' || !sourceId || sourceId.length > 128
        || typeof sourceRevision !== 'string' || !sourceRevision || sourceRevision.length > 128
        || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 1) return null;
    return Object.freeze({ ownerKey, sourceUrlHash: hash(sourceUrl), fileSizeBytes,
        profileHash: hash(JSON.stringify(['private-resume-v1', sourceId, sourceRevision, profile])) });
}

function strongResumeIdentity(observed, fileSizeBytes) {
    return observed?.validator?.kind === 'etag'
        && typeof observed.validator.value === 'string' && observed.validator.value.length <= 512
        && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(observed.validator.value)
        && observed.fileSizeBytes === fileSizeBytes && hex(observed.effectiveUrlIdentitySha256)
        ? hash(JSON.stringify([observed.validator.value, fileSizeBytes, observed.effectiveUrlIdentitySha256])) : null;
}
module.exports = { privateResumeBinding, strongResumeIdentity, createPrivateResumeOwnerGate };
