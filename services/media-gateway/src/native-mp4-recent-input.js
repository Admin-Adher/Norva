'use strict';
const { validateRecentResume, recentResumeTargetEligible } = require('./recent-resume-validation');

async function revalidateNativeRecentInput({ cache, persistence = null, binding, scope, signal, createBroker } = {}) {
    const plan = binding && cache.inputRevalidationPlan(binding);
    if (!plan) return null;
    let identity = null, handoff = null;
    const samples = await validateRecentResume({ plan, signal,
        // A renewed delivery path may finish the four fresh checks under the
        // same owner/source and host policy. Only acquireInput can authorize
        // old bytes, after all four digests and the exact size match.
        acceptIdentity: () => Boolean(identity && recentResumeTargetEligible(plan, identity)),
        onFreshValidatedHeader: (broker, payload) => { handoff = broker.takeFreshValidatedHeader(payload); },
        createBroker: validationSignal => createBroker(validationSignal, current => { identity = current; }, scope, plan),
    });
    // An unavailable fresh read grants nothing, but does not discard complete
    // private bytes merely because this attempt timed out. Their TTL remains
    // unchanged; another ordinary opening still needs all four fresh samples.
    if (signal?.aborted || !samples || !identity) return null;
    const lease = (persistence || cache).acquireInput(binding, { ...identity, samples, fileSizeBytes: binding.fileSizeBytes });
    if (!lease) return null;
    try { return { lease, snapshot: lease.inputSnapshot(), handoff }; }
    catch (error) { lease.release(); throw error; }
}

module.exports = { revalidateNativeRecentInput };
