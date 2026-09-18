'use strict';
const crypto = require('node:crypto');

// A narrow, lease-held gate over BACKGROUND provider admission only.
//
// It is deliberately not the maintenance fence: that one answers 503 to every
// non-viewer request while held, which would stop job enqueues, callbacks and
// catalogue calls for the whole window. This gate defers provider-reading
// metadata HTTP requests with retryable 429s, and interrupts nothing already
// running. A background job that meets a
// closed gate takes the SAME path as one blocked by an active viewer: it is
// deferred and re-queued, with its `deferred` heartbeat, so no work is lost.
//
// Safety properties, in order of importance:
//   1. It expires on its own. Holding it requires an explicit renewal before
//      each deadline, so a dead client reopens admission within `ttlMs`.
//   2. It has an absolute ceiling: no renewal can extend a window beyond
//      `maxWindowMs`, whatever the client does.
//   3. Viewer playback always wins: `releaseForViewer()` drops the gate, so a
//      real viewer never waits behind a diagnostic window.
class ProviderQuiesce {
    constructor({ now = Date.now, ttlMs = 30_000, maxWindowMs = 20 * 60_000 } = {}) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
            throw new Error('INVALID_QUIESCE_TTL');
        }
        if (!Number.isSafeInteger(maxWindowMs) || maxWindowMs < ttlMs || maxWindowMs > 60 * 60_000) {
            throw new Error('INVALID_QUIESCE_WINDOW');
        }
        Object.assign(this, { now, ttlMs, maxWindowMs });
        this.state = null;
        this.activeMetadataRequests = 0;
        this.stats = { windows: 0, renewals: 0, expiries: 0, viewerReleases: 0, deferrals: 0 };
    }

    expire() {
        if (this.state && this.now() >= this.state.deadline) {
            this.state = null;
            this.stats.expiries += 1;
        }
    }

    begin(reason = '') {
        this.expire();
        if (this.state) throw new Error('QUIESCE_ALREADY_HELD');
        const at = this.now();
        this.state = {
            token: crypto.randomBytes(32).toString('hex'),
            startedAt: at,
            deadline: at + this.ttlMs,
            reason: String(reason || '').slice(0, 120),
        };
        this.stats.windows += 1;
        return this.state.token;
    }

    renew(token) {
        this.expire();
        if (!this.state || this.state.token !== token) throw new Error('QUIESCE_LEASE_LOST');
        const at = this.now();
        // The clamp is what enforces the ceiling: since the deadline can never
        // exceed it, expiry always fires at the ceiling at the latest, and the
        // lease is simply gone from then on. No separate exhaustion path is
        // needed, and adding one would be unreachable.
        const ceiling = this.state.startedAt + this.maxWindowMs;
        this.state.deadline = Math.min(at + this.ttlMs, ceiling);
        this.stats.renewals += 1;
        return this.state.deadline - at;
    }

    cancel(token) {
        this.expire();
        if (!this.state || this.state.token !== token) throw new Error('QUIESCE_LEASE_LOST');
        this.state = null;
    }

    // Viewer playback outranks any diagnostic window, unconditionally.
    releaseForViewer() {
        this.expire();
        if (!this.state) return false;
        this.state = null;
        this.stats.viewerReleases += 1;
        return true;
    }

    blocked() {
        this.expire();
        if (!this.state) return false;
        this.stats.deferrals += 1;
        return true;
    }

    status() {
        this.expire();
        const at = this.now();
        return {
            protocol: 1,
            metadataAdmissionProtocol: 1,
            activeMetadataRequests: this.activeMetadataRequests,
            held: Boolean(this.state),
            ttlMs: this.ttlMs,
            maxWindowMs: this.maxWindowMs,
            remainingMs: this.state ? Math.max(0, this.state.deadline - at) : 0,
            windowRemainingMs: this.state
                ? Math.max(0, this.state.startedAt + this.maxWindowMs - at)
                : 0,
            reason: this.state ? this.state.reason : null,
            ...this.stats,
        };
    }
}

// These routes can read providers without going through the background queues.
// Keep local inference, receipts/finalization, job enqueues and viewer routes
// open. In particular, draining an already admitted request must remain possible.
function isProviderMetadataRequest(req) {
    if (req.method === 'GET') return /^\/detect-language\/[^/]+\/?$/.test(req.path);
    if (req.method !== 'POST') return false;
    const path = req.path.replace(/\/$/, '');
    return ['/probe-audio', '/detect-language', '/detect-language/capture/capture',
        '/extract-language-wav', '/provider-route/benchmark', '/xtream/epg',
        '/xtream/series-info', '/xtream/metadata-page', '/xtream/metadata'].includes(path)
        || /^\/benchmark-language\/[^/]+$/.test(path);
}

function metadataAdmission(quiesce) {
    return (req, res, next) => {
        if (!isProviderMetadataRequest(req)) return next();
        if (quiesce.blocked()) {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Retry-After', '30');
            // Attests only this rejected request: no handler/provider was opened.
            // It does NOT attest that other previously admitted work has drained.
            return res.status(429).json({ code: 'LANGUAGE_ENRICHMENT_CAPACITY_BUSY',
                retryable: true, providerDrained: true, providerDrainProtocol: 1 });
        }
        quiesce.activeMetadataRequests++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            quiesce.activeMetadataRequests--;
        };
        res.once('finish', release);
        res.once('close', release);
        // This is HTTP activity, not a provider-drain assertion. The runbook must
        // additionally wait for brokers, subprocesses and inference to finish.
        next();
    };
}

// Routes are authenticated and never published by the public prefix, which only
// exposes GET/HEAD/OPTIONS on /sessions/*.
//
// Always mounted, and inert until an authenticated caller takes a lease: with
// no lease held `blocked()` is false, so mounting this changes no behaviour on
// its own. There is deliberately no enable flag, because the release protocol
// for this service requires the container Config to be preserved byte for byte
// across a swap (assert_clone), so a new environment variable could not be
// introduced without breaking that invariant. Holding a lease already requires
// the gateway token, which can create and stop sessions outright, so the gate
// grants no privilege that token did not already have — and unlike those, it
// expires on its own within `ttlMs`.
function registerProviderQuiesce({ app, authenticate, wake = () => {} }) {
    const quiesce = new ProviderQuiesce();
    const timer = setInterval(() => quiesce.expire(), 1_000);
    timer.unref();
    app.use(metadataAdmission(quiesce));
    app.get('/provider-quiesce', authenticate, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, ...quiesce.status() });
    });
    for (const action of ['begin', 'renew', 'cancel']) {
        app.post(`/provider-quiesce/${action}`, authenticate, (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                if (action === 'begin') {
                    const token = quiesce.begin(req.body?.reason);
                    return res.json({ ok: true, token, ...quiesce.status() });
                }
                const token = String(req.body?.token || '');
                if (action === 'renew') {
                    const remainingMs = quiesce.renew(token);
                    return res.json({ ok: true, remainingMs, ...quiesce.status() });
                }
                quiesce.cancel(token);
                wake();
                return res.json({ ok: true, resumed: true, ...quiesce.status() });
            } catch (error) {
                return res.status(409).json({ error: 'Quiesce lease unavailable', code: error.message });
            }
        });
    }
    return quiesce;
}

module.exports = { ProviderQuiesce, registerProviderQuiesce, metadataAdmission, isProviderMetadataRequest };
