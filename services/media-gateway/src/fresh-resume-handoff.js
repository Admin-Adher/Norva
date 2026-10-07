'use strict';
const crypto = require('node:crypto');
const capabilities = new WeakMap();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const hex = value => /^[a-f0-9]{64}$/.test(value || '');

// One-use, in-process transfer of this playback's freshly drained header.
// This is not a retained-cache proof and cannot validate an older representation.
function createFreshResumeHandoff({ scope, sourceUrl, userAgent, fileSizeBytes, targetUrl,
    effectiveUrlSha256, effectiveUrlIdentitySha256, validator, targetParts, payload, now = Date.now() }) {
    if (!scope || typeof scope !== 'object' || !/^https?:\/\//.test(targetUrl || '')
        || !hex(effectiveUrlSha256) || !hex(effectiveUrlIdentitySha256)
        || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 65536
        || !Buffer.isBuffer(payload) || payload.length !== 65536) return null;
    const token = Object.freeze({});
    capabilities.set(token, { scope, sourceUrl, userAgent, fileSizeBytes, targetUrl,
        effectiveUrlSha256, effectiveUrlIdentitySha256, validator, targetParts,
        payload: Buffer.from(payload), capturedAt: now });
    return token;
}
function consumeFreshResumeHandoff(token, { scope, sourceUrl, userAgent, fileSizeBytes, now = Date.now() }) {
    const value = token && capabilities.get(token);
    if (token) capabilities.delete(token);
    if (!value || value.scope !== scope || value.sourceUrl !== sourceUrl || value.userAgent !== userAgent
        || value.fileSizeBytes !== fileSizeBytes || now < value.capturedAt || now-value.capturedAt > 10000) return null;
    return { ...value, prefix: { captureOwner: scope.id, complete: true, capturedAt: value.capturedAt,
        sourceSha256: hash(sourceUrl), fileSizeBytes, effectiveUrlIdentitySha256: value.effectiveUrlIdentitySha256,
        validator: value.validator, payload: value.payload } };
}
module.exports = { createFreshResumeHandoff, consumeFreshResumeHandoff };
