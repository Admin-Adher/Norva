'use strict';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = new Set(['probing', 'producing', 'uploading', 'finalizing']);

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactKeys(value, expected) {
    const keys = Object.keys(record(value)).sort();
    const sorted = [...expected].sort();
    return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function normalizeEndpoint(value) {
    const endpoint = String(value || '').trim().replace(/\/+$/, '');
    if (!endpoint) return '';
    try {
        const parsed = new URL(endpoint);
        const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) return '';
        if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
        return endpoint;
    } catch (_) {
        return '';
    }
}

function normalizeMediaCacheProducerContext(value) {
    const context = record(value);
    if (!exactKeys(context, [
        'accountFingerprint',
        'leaseToken',
        'ownerInstanceFingerprint',
        'protocol',
        'workFingerprint',
    ]) || context.protocol !== 1) return null;
    const workFingerprint = String(context.workFingerprint || '').toLowerCase();
    const accountFingerprint = String(context.accountFingerprint || '').toLowerCase();
    const leaseToken = String(context.leaseToken || '').toLowerCase();
    const ownerInstanceFingerprint = String(context.ownerInstanceFingerprint || '').toLowerCase();
    if (!SHA256_PATTERN.test(workFingerprint)
        || !SHA256_PATTERN.test(accountFingerprint)
        || !UUID_PATTERN.test(leaseToken)
        || !SHA256_PATTERN.test(ownerInstanceFingerprint)) return null;
    return Object.freeze({
        protocol: 1,
        workFingerprint,
        accountFingerprint,
        leaseToken,
        ownerInstanceFingerprint,
    });
}

class MediaCacheProducerControl {
    constructor(options = {}) {
        this.edgeBase = normalizeEndpoint(options.edgeBase);
        this.gatewayToken = String(options.gatewayToken || '');
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.heartbeatMs = Math.max(5_000, Math.min(60_000, Number(options.heartbeatMs) || 20_000));
        this.initialDelayMs = Math.max(250, Math.min(this.heartbeatMs, Number(options.initialDelayMs) || 5_000));
        this.timeoutMs = Math.max(1_000, Math.min(15_000, Number(options.timeoutMs) || 5_000));
        this.onPreempt = typeof options.onPreempt === 'function' ? options.onPreempt : null;
        this.active = Boolean(
            this.edgeBase
            && this.gatewayToken.length >= 16
            && typeof this.fetchImpl === 'function'
        );
        this.stats = {
            attached: 0,
            pulses: 0,
            renewals: 0,
            preemptions: 0,
            demandStops: 0,
            expirations: 0,
            completions: 0,
            abandons: 0,
            failures: 0,
        };
    }

    attach(session, rawContext) {
        const context = normalizeMediaCacheProducerContext(rawContext);
        if (!context) throw new TypeError('MEDIA_CACHE_PRODUCER_CONTEXT_INVALID');
        if (!this.active) throw new TypeError('MEDIA_CACHE_PRODUCER_CONTROL_UNAVAILABLE');
        session.mediaCacheProducer = context;
        session.mediaCacheProducerStage = 'probing';
        session.mediaCacheProducerCompleted = false;
        session.mediaCacheProducerPreemptRequested = false;
        this.stats.attached += 1;
        this.schedule(session, this.initialDelayMs);
        return context;
    }

    detach(session) {
        if (session?.mediaCacheProducerHeartbeatTimer) {
            clearTimeout(session.mediaCacheProducerHeartbeatTimer);
            session.mediaCacheProducerHeartbeatTimer = null;
        }
    }

    schedule(session, delayMs = this.heartbeatMs) {
        this.detach(session);
        if (!session?.mediaCacheProducer || session.mediaCacheProducerCompleted === true) return;
        const timer = setTimeout(() => {
            session.mediaCacheProducerHeartbeatTimer = null;
            this.pulse(session, session.mediaCacheProducerStage || 'producing')
                .catch(() => null)
                .finally(() => {
                    if (!session.mediaCacheProducerCompleted && session.status !== 'ended') {
                        const nextDelay = session.backgroundCacheContinuation === true
                            ? Math.min(this.heartbeatMs, 5_000)
                            : this.heartbeatMs;
                        this.schedule(session, nextDelay);
                    }
                });
        }, Math.max(1, Number(delayMs) || this.heartbeatMs));
        timer.unref?.();
        session.mediaCacheProducerHeartbeatTimer = timer;
    }

    async request(session, body) {
        if (!this.active || !session?.mediaCacheProducer
            || !UUID_PATTERN.test(String(session.playbackSessionId || ''))
            || !UUID_PATTERN.test(String(session.id || ''))) {
            throw new Error('MEDIA_CACHE_PRODUCER_CONTROL_UNAVAILABLE');
        }
        const response = await this.fetchImpl(`${this.edgeBase}/media-cache/producer-control`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.gatewayToken}`,
            },
            body: JSON.stringify({
                protocol: 1,
                playbackSessionId: String(session.playbackSessionId).toLowerCase(),
                gatewaySessionId: String(session.id).toLowerCase(),
                ...body,
            }),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response?.ok) {
            await response?.body?.cancel?.().catch(() => {});
            throw new Error('MEDIA_CACHE_PRODUCER_CONTROL_HTTP');
        }
        const payload = await response.json();
        if (payload?.protocol !== 1 || typeof payload.state !== 'string') {
            throw new Error('MEDIA_CACHE_PRODUCER_CONTROL_PROTOCOL');
        }
        return payload.state;
    }

    async pulse(session, stage = 'producing') {
        if (!session?.mediaCacheProducer || session.mediaCacheProducerCompleted === true) return 'completed';
        if (!STAGES.has(stage)) throw new TypeError('MEDIA_CACHE_PRODUCER_STAGE_INVALID');
        session.mediaCacheProducerStage = stage;
        this.stats.pulses += 1;
        try {
            const continuation = session.backgroundCacheContinuation === true;
            const state = await this.request(session, {
                action: continuation ? 'continuation-pulse' : 'pulse',
                stage,
            });
            if (state === 'renewed') this.stats.renewals += 1;
            if (['preempted', 'idle', 'expired', 'missing'].includes(state)) {
                session.mediaCacheProducerPreemptRequested = true;
                if (state === 'preempted') this.stats.preemptions += 1;
                else if (state === 'idle') this.stats.demandStops += 1;
                if (continuation) {
                    await this.onPreempt?.(session);
                }
            }
            if (state === 'expired' || state === 'missing') this.stats.expirations += 1;
            return state;
        } catch (error) {
            this.stats.failures += 1;
            throw error;
        }
    }

    markCompleted(session) {
        if (!session?.mediaCacheProducer) return;
        session.mediaCacheProducerCompleted = true;
        this.detach(session);
        this.stats.completions += 1;
    }

    async abandon(session) {
        this.detach(session);
        if (!session?.mediaCacheProducer || session.mediaCacheProducerCompleted === true) return 'completed';
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const state = await this.request(session, { action: 'abandon' });
                if (['abandoned', 'completed', 'missing'].includes(state)) {
                    session.mediaCacheProducerCompleted = state === 'completed';
                    this.stats.abandons += state === 'abandoned' ? 1 : 0;
                    return state;
                }
                throw new Error('MEDIA_CACHE_PRODUCER_ABANDON_INVALID');
            } catch (error) {
                lastError = error;
            }
        }
        this.stats.failures += 1;
        throw lastError || new Error('MEDIA_CACHE_PRODUCER_ABANDON_FAILED');
    }

    publicStatus() {
        return { protocol: 1, active: this.active, ...this.stats };
    }
}

module.exports = {
    MediaCacheProducerControl,
    normalizeMediaCacheProducerContext,
};
