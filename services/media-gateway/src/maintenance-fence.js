'use strict';
const crypto = require('node:crypto');

// An application-level fence, not an inference from queue length. Every job
// admission must hold a lease, including across asynchronous provider checks.
class MaintenanceFence {
    constructor({ now = Date.now, ttlMs = 30000, wake = () => {} } = {}) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000) throw Error('INVALID_MAINTENANCE_TTL');
        Object.assign(this, { now, ttlMs, wake });
        this.active = 0; this.state = null;
    }
    expire() {
        if (this.state?.phase !== 'committed' && this.state && this.now() >= this.state.deadline) {
            this.state = null; this.wake();
        }
    }
    enter() {
        this.expire();
        if (this.state) return null;
        this.active++;
        let released = false;
        return () => { if (!released) { released = true; this.active--; } };
    }
    begin() {
        this.expire();
        if (this.state) throw Error('MAINTENANCE_ALREADY_OWNED');
        const token = crypto.randomBytes(32).toString('hex');
        this.state = { token, phase: 'draining', deadline: this.now() + this.ttlMs };
        return token;
    }
    owned(token) {
        this.expire();
        if (!this.state || this.state.token !== token) throw Error('MAINTENANCE_LEASE_LOST');
        return this.state;
    }
    async verify(token, { snapshot, persisted }) {
        const state = this.owned(token);
        if (state.phase === 'committed') throw Error('MAINTENANCE_COMMITTED');
        state.phase = 'draining';
        const before = snapshot();
        const valid = s => s && s.activeOperations === 0 && s.viewerSessions === 0
            && Array.isArray(s.jobs) && s.jobs.every(j => j.kind === 'storyboard' && j.durable === true
                && typeof j.id === 'string' && typeof j.checkpointDigest === 'string')
            && new Set(s.jobs.map(j => j.id)).size === s.jobs.length;
        if (this.active || !valid(before)) return false;
        // persisted() must load and verify HMAC records from the mounted store.
        const saved = await persisted();
        this.owned(token);
        if (this.state !== state || this.active) return false;
        const after = snapshot();
        if (!valid(after) || JSON.stringify(before) !== JSON.stringify(after) || !Array.isArray(saved)) return false;
        const records = new Map(saved.map(j => [j.id, j.checkpointDigest]));
        if (records.size !== saved.length || records.size !== before.jobs.length
            || before.jobs.some(j => records.get(j.id) !== j.checkpointDigest)) return false;
        state.snapshot = JSON.stringify(after); state.phase = 'ready';
        return true;
    }
    commit(token, snapshot, closeAdmissions) {
        const state = this.owned(token);
        if (state.phase !== 'ready' || this.active || state.snapshot !== JSON.stringify(snapshot()))
            throw Error('MAINTENANCE_NOT_READY');
        // Synchronous: do not yield between the final check and listener close.
        // The integration must close ingress here; no async Docker/API call.
        state.phase = 'committed';
        closeAdmissions();
    }
    cancel(token) {
        const state = this.owned(token);
        if (state.phase === 'committed') throw Error('MAINTENANCE_COMMITTED');
        this.state = null; this.wake();
    }
}
module.exports = { MaintenanceFence };
