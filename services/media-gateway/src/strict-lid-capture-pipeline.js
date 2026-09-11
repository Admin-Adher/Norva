'use strict';

const { captureBinding } = require('./strict-lid-capture-store');
const failure = code => Object.assign(new Error(code), { code });
const drained = Object.freeze({ providerDrained: true, providerDrainProtocol: 1 });

// A capture response never includes a language or a receipt. The caller must
// durably acknowledge it and release its distributed provider leases before
// calling infer. Infer has NO extraction fallback: a cache miss returns 409.
function createStrictLidCapturePipeline({ store, claimNetwork, openBroker, extract, infer,
    drainTimeoutMs = 8000 } = {}) {
    if (!store || [claimNetwork, openBroker, extract, infer].some(fn => typeof fn !== 'function')) {
        throw failure('LID_CAPTURE_PIPELINE_CONFIG_INVALID');
    }
    const status = async binding => {
        const record = await store.get(captureBinding(binding));
        return { captureProtocol: 1, captured: Boolean(record),
            ...(record ? { expiresAt: record.expiresAt, sha256: record.sha256 } : {}), ...drained };
    };
    async function capture(binding, context, signal) {
        const normalized = captureBinding(binding);
        let reservation; let broker; let network; let sourceDrained = true;
        let closePromise;
        const closeBroker = () => {
            if (closePromise) return closePromise;
            closePromise = (async () => {
                if (!broker) return;
                let timer;
                try {
                    await Promise.race([broker.close(), new Promise((_, reject) => {
                        timer = setTimeout(() => reject(failure('LID_CAPTURE_DRAIN_UNCONFIRMED')), drainTimeoutMs);
                    })]);
                    sourceDrained = true;
                    network?.release(drained);
                } finally { clearTimeout(timer); }
            })();
            return closePromise;
        };
        try {
            const prior = await status(normalized);
            if (prior.captured) return { ...prior, reused: true };
            if (signal?.aborted) throw failure('LID_CAPTURE_CANCELLED');
            reservation = await store.reserve(normalized);
            if (reservation.cached) {
                const cached = await status(normalized);
                if (!cached.captured) throw failure('LID_CAPTURE_NOT_FOUND');
                return { ...cached, reused: true };
            }
            network = claimNetwork(context);
            // openBroker only opens a loopback listener, never an upstream
            // socket. Once created it becomes the sole drain authority.
            broker = await openBroker(context, signal);
            sourceDrained = false;
            const wav = await extract(broker, normalized, context, signal);
            await closeBroker();
            const saved = await store.put(normalized, wav, drained, reservation.token);
            return { captureProtocol: 1, captured: true, ...saved, ...drained };
        } catch (cause) {
            try { await closeBroker(); } catch { sourceDrained = false; }
            const code = sourceDrained && /^[A-Z][A-Z0-9_]{1,79}$/.test(cause?.code || '')
                ? cause.code : (sourceDrained ? 'LID_CAPTURE_FAILED' : 'LID_CAPTURE_DRAIN_UNCONFIRMED');
            throw Object.assign(failure(code), { providerDrained: sourceDrained, providerDrainProtocol: 1,
                ...(Number.isInteger(cause?.status) && cause.status >= 400 && cause.status <= 599
                    ? { status: cause.status } : {}),
                ...(Number.isInteger(cause?.upstreamStatus) && cause.upstreamStatus >= 400 && cause.upstreamStatus <= 599
                    ? { upstreamStatus: cause.upstreamStatus } : {}) });
        } finally {
            // A failed loopback allocation did no provider I/O. No other path
            // releases this reservation without a positive broker drain.
            if (!broker) network?.release(drained);
            await reservation?.release();
        }
    }
    async function compute(binding, context, signal) {
        if (signal?.aborted) throw failure('LID_CAPTURE_CANCELLED');
        const normalized = captureBinding(binding);
        return store.withPlaintext(normalized, wavPath => infer(wavPath, normalized, context, signal));
    }
    return Object.freeze({ status, capture, compute, acknowledge: binding => store.remove(captureBinding(binding)) });
}

module.exports = { createStrictLidCapturePipeline };
