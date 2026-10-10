'use strict';
const crypto = require('node:crypto');

// Uses the existing cache's memory reservations, eviction, ownership, TTL,
// revalidation and subtitle coverage. A separate binding prevents a prefix
// from replacing a viewer's recent resume window for the same physical file.
const startupBinding = binding => binding && Object.freeze({ ...binding,
    profileHash: crypto.createHash('sha256').update(JSON.stringify([
        'private-startup-prefix-v1', binding.profileHash,
    ])).digest('hex') });
const preparationKey = body => crypto.createHash('sha256').update(JSON.stringify([
    body.ownerKey, body.sourceUrl, body.playbackIdentity, body.codecProfile,
    body.audioStreamIndex, body.subtitleStreamIndex, body.audioMode, body.clientAudioPassthrough,
])).digest('hex');

function createPrivateStartupCache(cache) {
    const stats = { stores: 0, hits: 0, rejects: 0 };
    const prepared = new Map();
    return Object.freeze({
        remember(body, binding) {
            const key = preparationKey(body);
            if (!prepared.has(key) && prepared.size >= 32) prepared.delete(prepared.keys().next().value);
            prepared.set(key, startupBinding(binding));
        },
        remainingSeconds(body) {
            const key = preparationKey(body), binding = prepared.get(key);
            const entry = binding && cache.candidate(binding, 0);
            if (!entry) { prepared.delete(key); return 0; }
            return Math.max(0, Math.floor((entry.expiresAt - cache.now()) / 1000));
        },
        hasCandidate: (binding, position) => position === 0 && cache.hasCandidate(startupBinding(binding), 0),
        revalidationPlan: (binding, position) => position === 0 ? cache.revalidationPlan(startupBinding(binding), 0) : null,
        acquire(binding, position, observed) {
            const lease = position === 0 ? cache.acquire(startupBinding(binding), 0, observed) : null;
            if (lease) stats.hits++;
            return lease;
        },
        async capture(args) {
            const stored = await cache.capture({ ...args, binding: startupBinding(args.binding),
                position: 0, capturePurpose: 'startup' });
            stats[stored ? 'stores' : 'rejects']++;
            return stored;
        },
        status: () => ({ protocol: 1, seconds: 60, scope: 'private-owner-source-revision',
            budget: 'shared-with-private-resume', partialPublication: false, ...stats }),
    });
}
module.exports = { createPrivateStartupCache, startupBinding };
