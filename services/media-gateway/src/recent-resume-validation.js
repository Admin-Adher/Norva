'use strict';
const { SAMPLE_BYTES } = require('./recent-resume-samples');
const crypto = require('node:crypto');

// Diagnostic digests only. Never an alternate identity or a permission to
// reuse bytes across targets. No URL, credential or query value escapes.
function recentResumeTargetParts(value) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        const parts = { protocol: url.protocol, host: url.host, path: url.pathname,
            queryKeys: [...new Set(url.searchParams.keys())].sort().join('&') };
        return Object.fromEntries(Object.entries(parts).map(([key, part]) =>
            [key, crypto.createHash('sha256').update(part).digest('hex')]));
    } catch (_) { return null; }
}
function compareRecentResumeTargetParts(previous, current) {
    const keys = ['protocol', 'host', 'path', 'queryKeys'];
    if (!keys.every(key => /^[a-f0-9]{64}$/.test(previous?.[key] || '')
        && /^[a-f0-9]{64}$/.test(current?.[key] || ''))) return null;
    return Object.fromEntries(keys.map(key => [key, previous[key] === current[key]]));
}

// The caller owns the ordinary playback claim. A separate uncached broker
// prevents an old byte-range cache from validating itself. No retry or route
// rotation; close/drain must finish before normal playback can take over.
async function validateRecentResume({ plan, createBroker, signal, budgetMs = 8000, fetchImpl = fetch,
    acceptIdentity = () => true, onIdentityRejected = () => {} }) {
    if (!plan || plan.kind !== 'sampled-recent-v1' || plan.ranges?.length !== 4
        || plan.ranges.some(r => !Number.isSafeInteger(r.start) || r.start < 0 || r.length !== SAMPLE_BYTES)) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, Math.min(8000, Math.max(1, budgetMs)));
    let broker;
    try {
        if (controller.signal.aborted) return null;
        broker = await createBroker(controller.signal);
        const samples = [];
        for (const range of plan.ranges) {
            if (controller.signal.aborted) return null;
            const response = await fetchImpl(broker.inputUrl, { signal: controller.signal,
                headers: { Range: `bytes=${range.start}-${range.start + range.length - 1}` } });
            if (response.status !== 206) { await response.body?.cancel(); return null; }
            const payload = Buffer.from(await response.arrayBuffer());
            if (payload.length !== SAMPLE_BYTES || broker.terminalError) return null;
            // A different current delivery target already makes this cache
            // ineligible. Finish/drain this exact response, then avoid the
            // remaining reads; success still requires all four fresh samples.
            if (!acceptIdentity()) { onIdentityRejected(); return null; }
            samples.push({ start: range.start, payload });
        }
        return controller.signal.aborted ? null : samples;
    } catch (_) { return null; }
    finally {
        clearTimeout(timer);
        controller.abort();
        await broker?.close();
        signal?.removeEventListener('abort', abort);
    }
}
module.exports = { validateRecentResume, recentResumeTargetParts, compareRecentResumeTargetParts };
