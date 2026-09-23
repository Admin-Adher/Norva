'use strict';

// A bounded, abortable wait for existing startup permits. Slots are released
// after preparation, not after watching the film. Blocked owners cannot hold
// up independent owners behind them.
class StartupAdmissionQueue {
    constructor({ tryAcquire, maxPending = 128, maxPerKey = 4, timeoutMs = 20000 }) {
        Object.assign(this, { tryAcquire, maxPending, maxPerKey, timeoutMs });
        this.pending = []; this.stats = { queued: 0, admitted: 0, timedOut: 0, cancelled: 0, rejected: 0 };
    }
    acquire(owner, provider, signal) {
        if (signal?.aborted) return Promise.reject(this.error('VIEWER_STARTUP_ABORTED'));
        const token = this.tryAcquire(owner, provider);
        if (token) return Promise.resolve(token);
        const keys = [owner && `o:${owner}`, provider && `p:${provider}`].filter(Boolean);
        if (this.pending.length >= this.maxPending || keys.some(key =>
            this.pending.filter(item => item.keys.includes(key)).length >= this.maxPerKey)) {
            this.stats.rejected++; return Promise.reject(this.error('VIEWER_STARTUP_BUSY'));
        }
        return new Promise((resolve, reject) => {
            const item = { owner, provider, keys, resolve, signal };
            const remove = () => { const index = this.pending.indexOf(item); if (index >= 0) this.pending.splice(index, 1); };
            const abort = () => { remove(); item.detach(); this.stats.cancelled++; reject(this.error('VIEWER_STARTUP_ABORTED')); };
            const timer = setTimeout(() => { remove(); item.detach(); this.stats.timedOut++; reject(this.error('VIEWER_STARTUP_BUSY')); }, this.timeoutMs);
            item.detach = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
            this.pending.push(item); this.stats.queued++;
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        });
    }
    wake() {
        for (const item of [...this.pending]) {
            if (item.signal?.aborted) continue;
            const token = this.tryAcquire(item.owner, item.provider);
            if (!token) continue;
            this.pending.splice(this.pending.indexOf(item), 1); item.detach();
            this.stats.admitted++; item.resolve(token);
        }
    }
    error(code) { return Object.assign(new Error(code), { code }); }
    snapshot() { return { pending: this.pending.length, maxPending: this.maxPending, timeoutMs: this.timeoutMs, ...this.stats }; }
}
module.exports = { StartupAdmissionQueue };
