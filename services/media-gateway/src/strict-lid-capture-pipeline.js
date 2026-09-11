'use strict';

const { captureBinding } = require('./strict-lid-capture-store');
const failure = code => Object.assign(new Error(code), { code });
const drained = Object.freeze({ providerDrained: true, providerDrainProtocol: 1 });

// A capture response never includes a language or a receipt. The caller must
// durably acknowledge it and release its distributed provider leases before
// calling infer. Infer has NO extraction fallback: a cache miss returns 409.
function createStrictLidCapturePipeline({ store, claimNetwork, openBroker, extract, infer,
    drainTimeoutMs = 8000, adoptPassive = async () => false } = {}) {
    if (!store || [claimNetwork, openBroker, extract, infer].some(fn => typeof fn !== 'function')) {
        throw failure('LID_CAPTURE_PIPELINE_CONFIG_INVALID');
    }
    const status = async binding => {
        const normalized = captureBinding(binding);
        let record = await store.get(normalized);
        if (!record && await adoptPassive(normalized)) record = await store.get(normalized);
        return { captureProtocol: 1, captured: Boolean(record),
            ...(record ? { expiresAt: record.expiresAt, sha256: record.sha256 } : {}), ...drained };
    };
    async function capture(binding, context, signal, companions = []) {
        const normalized = captureBinding(binding);
        const group = [normalized, ...companions.map(captureBinding)];
        if (group.length > 4 || new Set(group.map(b => b.trackIndex)).size !== group.length
            || group.some(b => JSON.stringify({ ...b, trackIndex: normalized.trackIndex }) !== JSON.stringify(normalized))) {
            throw failure('LID_CAPTURE_GROUP_INVALID');
        }
        let reservation; let broker; let network; let sourceDrained = true;
        const startedAt = Date.now();
        const reservations = [];
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
            reservations.push({ binding: normalized, reservation });
            if (reservation.cached) {
                const cached = await status(normalized);
                if (!cached.captured) throw failure('LID_CAPTURE_NOT_FOUND');
                return { ...cached, reused: true };
            }
            // Future track windows are optional prefetch. A full buffer must
            // not prevent the current track from progressing, nor redownload
            // a companion already retained by this or another owned attempt.
            for (const companion of group.slice(1)) {
                try {
                    const reserved = await store.reserve(companion);
                    reservations.push({ binding: companion, reservation: reserved });
                } catch (error) {
                    if (!['LID_CAPTURE_STORE_FULL', 'LID_CAPTURE_ALREADY_RUNNING'].includes(error?.code)) throw error;
                }
            }
            const pending = reservations.filter(r => !r.reservation.cached);
            network = claimNetwork(context);
            // openBroker only opens a loopback listener, never an upstream
            // socket. Once created it becomes the sole drain authority.
            broker = await openBroker(context, signal, network);
            sourceDrained = false;
            const audio = await extract(broker, pending.length === 1 ? normalized : pending.map(r => r.binding), context, signal);
            const wavs = pending.length === 1 ? [audio] : audio;
            if (!Array.isArray(wavs) || wavs.length !== pending.length || wavs.some(wav => !Buffer.isBuffer(wav))) {
                throw failure('LID_CAPTURE_GROUP_INVALID');
            }
            await closeBroker();
            network?.observe?.({ ok:true, durationMs:Date.now()-startedAt, drained:true });
            let saved;
            for (const [index, item] of pending.entries()) {
                const result = await store.put(item.binding, wavs[index], drained, item.reservation.token);
                if (index === 0) saved = result;
            }
            return { captureProtocol: 1, captured: true, ...saved, extractedTrackCount: pending.length, ...drained };
        } catch (cause) {
            try { await closeBroker(); } catch { sourceDrained = false; }
            network?.observe?.({ ok:false, drained:sourceDrained,
                neutral:!broker || signal?.aborted || ['LANGUAGE_VALIDATION_VIEWER_PREEMPTED',
                    'LANGUAGE_ENRICHMENT_CAPACITY_BUSY','SELECTION_ENRICHMENT_TARGET_NOT_APPROVED'].includes(cause?.code),
                retryAfterSeconds:cause?.retryAfterSeconds });
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
            for (const item of reservations) await item.reservation.release();
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
