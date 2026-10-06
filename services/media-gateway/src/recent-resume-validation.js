'use strict';
const { SAMPLE_BYTES } = require('./recent-resume-samples');

// The caller owns the ordinary playback claim. A separate uncached broker
// prevents an old byte-range cache from validating itself. No retry or route
// rotation; close/drain must finish before normal playback can take over.
async function validateRecentResume({ plan, createBroker, signal, budgetMs = 8000, fetchImpl = fetch }) {
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
module.exports = { validateRecentResume };
