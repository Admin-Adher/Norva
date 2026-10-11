'use strict';
const crypto = require('node:crypto');
const { forkRecentDeliveryTarget } = require('./recent-delivery-target');
const { strongResumeIdentity } = require('./private-resume-binding');
const { sampleProof } = require('./recent-resume-samples');

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

function createPrivateStartupCache(cache, disk = null) {
    const stats = { stores: 0, hits: 0, rejects: 0 };
    const prepared = new Map();
    return Object.freeze({
        recordAssetFailure(reason) {
            if (['size-budget', 'not-finalized'].includes(reason)) stats.lastAssetFailure = reason;
        },
        remember(body, binding) {
            const key = preparationKey(body);
            if (!prepared.has(key) && prepared.size >= 32) prepared.delete(prepared.keys().next().value);
            prepared.set(key, startupBinding(binding));
        },
        remainingSeconds(body) {
            const key = preparationKey(body), binding = prepared.get(key) || disk?.bindingForPreparation(key);
            const stored=binding && disk?.metadata(binding);
            if (stored?.identity && stored.retainedUntil)
                return Math.max(0,Math.floor((stored.retainedUntil-cache.now())/1000));
            const entry = binding && cache.candidate(binding, 0);
            if (!entry) {
                prepared.delete(key);
                return stored ? Math.max(0,Math.floor((stored.expiresAt-cache.now())/1000)) : 0;
            }
            return Math.max(0, Math.floor((entry.expiresAt - cache.now()) / 1000));
        },
        hasCandidate: (binding, position) => position === 0 && cache.hasCandidate(startupBinding(binding), 0),
        async restore(binding) {
            if (!disk || !binding) return false;
            const scoped=startupBinding(binding);
            return await cache.restoreStartup(scoped,()=>disk.get(scoped));
        },
        async remainingSecondsAsync(body, signal) {
            if (disk?.lookupPreparation) await disk.lookupPreparation(preparationKey(body), body.ownerKey, signal);
            return this.remainingSeconds(body);
        },
        async revokeOwner(ownerKey) {
            for (const [key,binding] of prepared) if (binding.ownerKey===ownerKey) prepared.delete(key);
            if (disk) await disk.revokeOwner(ownerKey);
        },
        revalidationPlan(binding, position) {
            const plan = position === 0 ? cache.revalidationPlan(startupBinding(binding), 0) : null;
            return plan ? { ...plan, deliveryTarget: forkRecentDeliveryTarget(plan.deliveryTarget,
                { ownerKey: binding.ownerKey, now: cache.now() }) } : null;
        },
        acquire(binding, position, observed) {
            const scoped = startupBinding(binding);
            const candidate = position === 0 ? cache.candidate(scoped, 0) : null;
            const lease = position === 0 ? cache.acquire(scoped, 0, observed) : null;
            // A definite fresh mismatch must invalidate both tiers. A missing
            // observation is transient and cannot certify or refresh media.
            const definiteObservation = observed && (strongResumeIdentity(observed, binding?.fileSizeBytes)
                || sampleProof(observed.samples, observed.fileSizeBytes, observed.effectiveUrlIdentitySha256)
                || (Number.isSafeInteger(observed.fileSizeBytes) && observed.fileSizeBytes > 0
                    && observed.fileSizeBytes !== binding?.fileSizeBytes));
            if (!lease && candidate && definiteObservation && disk) disk.discard(scoped).catch(()=>{});
            if (lease && candidate.archived && candidate.identity) {
                candidate.expiresAt = Math.min(candidate.retainedUntil, cache.now()+cache.ttlMs);
                candidate.archived = false;
            }
            if (lease) stats.hits++;
            return lease;
        },
        async capture(args) {
            const stored = await cache.capture({ ...args, binding: startupBinding(args.binding),
                position: 0, capturePurpose: 'startup' });
            let durable=stored;
            if (stored && disk) {
                const entry=cache.candidate(startupBinding(args.binding),0);
                durable=Boolean(entry && args.preparationBody
                    && await disk.put(entry,preparationKey(args.preparationBody),args.isCurrent || (()=>true),args.signal));
                if (!durable && entry) {
                    for (const [key, current] of cache.entries) if (current === entry) cache.drop(key, entry);
                }
            }
            stats[durable ? 'stores' : 'rejects']++;
            return durable;
        },
        status: () => ({ protocol: 1, seconds: 60, scope: 'private-owner-source-revision',
            budget: 'shared-with-private-resume', partialPublication: false, ...stats,
            ...(disk ? {disk:disk.status()} : {}) }),
    });
}
module.exports = { createPrivateStartupCache, startupBinding };
