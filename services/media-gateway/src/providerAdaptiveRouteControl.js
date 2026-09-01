'use strict';

const {
    buildProviderRouteCandidates,
    providerRouteFingerprints,
    routeId,
} = require('./providerAdaptiveRoute');

function normalizeEndpoint(value) {
    const endpoint = String(value || '').trim().replace(/\/+$/, '');
    if (!endpoint) return '';
    try {
        const parsed = new URL(endpoint);
        return parsed.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
            ? endpoint
            : '';
    } catch (_) {
        return '';
    }
}

function normalizeAppliedDecision(value, candidates, nowMs) {
    if (!value || typeof value !== 'object') return null;
    let id;
    try { id = routeId(value); } catch (_) { return null; }
    const candidate = candidates.find((item) => item.id === id);
    const expiresAtMs = Date.parse(String(value.expiresAt || ''));
    if (!candidate || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;
    return Object.freeze({
        ...candidate,
        score: Number.isFinite(Number(value.score)) ? Number(value.score) : null,
        confidence: Number.isFinite(Number(value.confidence)) ? Number(value.confidence) : null,
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        selectionReason: String(value.selectionReason || 'account-sticky').slice(0, 64),
        controlStatus: 'applied',
    });
}

class ProviderAdaptiveRouteControl {
    constructor(options = {}) {
        this.requested = options.enabled === true;
        this.httpProxyUrls = Array.isArray(options.httpProxyUrls) ? [...options.httpProxyUrls] : [];
        this.socksProxyUrls = Array.isArray(options.socksProxyUrls) ? [...options.socksProxyUrls] : [];
        this.candidates = buildProviderRouteCandidates({
            httpProxyUrls: this.httpProxyUrls,
            socksProxyUrls: this.socksProxyUrls,
        });
        this.fingerprintKey = options.fingerprintKey || null;
        this.edgeBase = normalizeEndpoint(options.edgeBase);
        this.gatewayToken = String(options.gatewayToken || '');
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.lookupTimeoutMs = Math.max(100, Math.min(2_000, Number(options.lookupTimeoutMs) || 500));
        this.slotIndexForKey = options.slotIndexForKey;
        this.now = options.now || Date.now;
        this.appliedByAffinity = new Map();
        this.shadowByAffinity = new Map();
        this.stats = {
            resolves: 0,
            applied: 0,
            shadows: 0,
            fallbacks: 0,
            timeouts: 0,
            failures: 0,
        };
        this.active = Boolean(
            this.requested &&
            this.httpProxyUrls.length &&
            this.fingerprintKey &&
            this.edgeBase &&
            this.gatewayToken &&
            typeof this.fetchImpl === 'function' &&
            typeof this.slotIndexForKey === 'function'
        );
    }

    fallback(affinityKey, reason = 'adaptive-disabled') {
        const count = this.httpProxyUrls.length;
        if (!count) return null;
        const index = Math.max(0, Math.min(count - 1, Number(this.slotIndexForKey(affinityKey)) || 0));
        const nodeTransport = this.socksProxyUrls.length ? 'socks5' : 'http';
        const candidate = this.candidates.find((item) =>
            item.slot === index + 1 && item.nodeTransport === nodeTransport);
        this.stats.fallbacks += 1;
        return { ...candidate, selectionReason: reason, controlStatus: 'fallback' };
    }

    decisionForAffinity(affinityKey) {
        const nowMs = this.now();
        const applied = this.appliedByAffinity.get(String(affinityKey || ''));
        if (applied && applied.expiresAtMs > nowMs) return applied;
        if (applied) this.appliedByAffinity.delete(String(affinityKey || ''));
        return this.fallback(affinityKey, this.active ? 'deterministic-fallback' : 'adaptive-disabled');
    }

    async resolveForPlayback(sourceUrl, affinityKey, options = {}) {
        if (!this.active) return this.decisionForAffinity(affinityKey);
        this.stats.resolves += 1;
        let fingerprints;
        try {
            fingerprints = providerRouteFingerprints(sourceUrl, this.fingerprintKey);
        } catch (_) {
            this.stats.failures += 1;
            return this.fallback(affinityKey, 'fingerprint-unavailable');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('provider-route-control-timeout')), this.lookupTimeoutMs);
        const parentSignal = options.signal;
        const onAbort = () => controller.abort(parentSignal.reason);
        if (parentSignal) {
            if (parentSignal.aborted) onAbort();
            else parentSignal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            const response = await this.fetchImpl(`${this.edgeBase}/provider-route/resolve`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.gatewayToken}`,
                },
                body: JSON.stringify({
                    protocol: 1,
                    priority: 'viewer',
                    accountFingerprint: fingerprints.accountFingerprint,
                    hostFingerprint: fingerprints.hostFingerprint,
                    candidates: this.candidates.map((candidate) => ({
                        slot: candidate.slot,
                        nodeTransport: candidate.nodeTransport,
                    })),
                }),
                signal: controller.signal,
            });
            if (!response?.ok) throw new Error('provider-route-control-http');
            const payload = await response.json();
            if (payload?.protocol !== 1) throw new Error('provider-route-control-protocol');
            const decision = normalizeAppliedDecision(payload.decision, this.candidates, this.now());
            if (payload.apply === true && decision) {
                this.appliedByAffinity.set(String(affinityKey || ''), decision);
                this.stats.applied += 1;
                return decision;
            }
            if (decision) {
                this.shadowByAffinity.set(String(affinityKey || ''), decision);
                this.stats.shadows += 1;
            }
            return this.fallback(affinityKey, payload.enabled === false ? 'control-disabled' : 'shadow-mode');
        } catch (error) {
            if (controller.signal.aborted && !parentSignal?.aborted) this.stats.timeouts += 1;
            else this.stats.failures += 1;
            return this.fallback(affinityKey, parentSignal?.aborted ? 'playback-aborted' : 'control-unavailable');
        } finally {
            clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', onAbort);
        }
    }

    publicStatus() {
        return {
            protocol: 1,
            requested: this.requested,
            active: this.active,
            candidates: this.candidates.length,
            appliedAccounts: this.appliedByAffinity.size,
            shadowAccounts: this.shadowByAffinity.size,
            ...this.stats,
        };
    }
}

module.exports = {
    ProviderAdaptiveRouteControl,
    normalizeAppliedDecision,
};
