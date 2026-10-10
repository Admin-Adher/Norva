'use strict';
const { validateRecentResume } = require('./recent-resume-validation');

async function revalidateNativeRecentInput({ cache, binding, scope, signal, createBroker } = {}) {
    const plan = binding && cache.inputRevalidationPlan(binding);
    if (!plan) return null;
    let identity = null, handoff = null;
    const samples = await validateRecentResume({ plan, signal,
        acceptIdentity: () => Boolean(identity && identity.effectiveUrlIdentitySha256 === plan.target),
        onFreshValidatedHeader: (broker, payload) => { handoff = broker.takeFreshValidatedHeader(payload); },
        createBroker: validationSignal => createBroker(validationSignal, current => { identity = current; }, scope, plan),
    });
    // An unavailable fresh read grants nothing, but does not discard complete
    // private bytes merely because this attempt timed out. Their TTL remains
    // unchanged; another ordinary opening still needs all four fresh samples.
    if (signal?.aborted || !samples || !identity) return null;
    const lease = cache.acquireInput(binding, { ...identity, samples, fileSizeBytes: binding.fileSizeBytes });
    if (!lease) return null;
    try { return { lease, snapshot: lease.inputSnapshot(), handoff }; }
    catch (error) { lease.release(); throw error; }
}

module.exports = { revalidateNativeRecentInput };
