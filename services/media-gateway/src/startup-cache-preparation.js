'use strict';
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

// Invoke the normal Gateway session implementation without creating a public
// viewer ticket or inventing a second media pipeline. The internal marker is
// an object reference; an HTTP body cannot request background privileges.
async function createInternalSession(handler, body, job) {
    const req = Object.assign(new EventEmitter(), { body, startupCacheJob: job,
        aborted: false, destroyed: false, protocol: 'http', get: () => '127.0.0.1' });
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
        headersSent: false, statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
        json(value) { this.payload = value; this.headersSent = true; this.writableEnded = true; return this; } });
    const abort = () => { req.aborted = true; req.emit('aborted'); };
    job.signal.addEventListener('abort', abort, { once: true });
    try {
        if (job.signal.aborted) throw Error('STARTUP_PREPARATION_CANCELLED');
        await handler(req, res);
        if (job.signal.aborted || res.statusCode !== 201 || !res.payload?.id)
            throw Error('STARTUP_PREPARATION_FAILED');
        return res.payload;
    } finally { job.signal.removeEventListener('abort', abort); }
}

class StartupCachePreparation {
    constructor({ allowsOwner, canStart, authorize, sessionForId, covered, stop, remainingSeconds = () => 0,
        durationMs = 110_000, pollMs = 500, recheckMs = 2_000 } = {}) {
        if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 110_000)
            throw Error('STARTUP_PREPARATION_BUDGET_INVALID');
        Object.assign(this, { allowsOwner, canStart, authorize, sessionForId, covered, stop, remainingSeconds,
            durationMs, pollMs, recheckMs });
        this.jobs = new Set(); this.handler = null;
        this.stats = { prepared: 0, deferred: 0, preempted: 0, failed: 0, drainFailures: 0 };
    }
    bindSessionCreate(handler) { this.handler = handler; return handler; }
    async prepare({ ownerKey, accountKey, body, permit }) {
        if (!this.allowsOwner(ownerKey) || !this.handler || this.jobs.size || !this.canStart(body)) {
            this.stats.deferred++;
            return { protocol: 1, prepared: false, providerDrained: true, reason: 'not-admitted' };
        }
        const controller = new AbortController();
        const job = { ownerKey, accountKey, body, permit, signal: controller.signal,
            session: null, complete: false, abort: () => { job.complete = false; controller.abort(); } };
        // Register synchronously, before authorization or any provider I/O.
        this.jobs.add(job);
        job.done = this.run(job);
        return await job.done;
    }
    async run(job) {
        let timer, watcher, checking = false, drained = false, prepared = false;
        try {
            timer = setTimeout(job.abort, this.durationMs);
            job.assertAuthorized = async () => {
                if (job.signal.aborted) throw Error('STARTUP_PREPARATION_CANCELLED');
                if (!job.authorization) {
                    job.authorization = Promise.resolve().then(() => this.authorize(job))
                        .finally(() => { job.authorization = null; });
                }
                if (!await job.authorization) throw Error('STARTUP_PREPARATION_NOT_AUTHORIZED');
                if (job.signal.aborted) throw Error('STARTUP_PREPARATION_CANCELLED');
            };
            await job.assertAuthorized();
            const remaining = this.remainingSeconds(job.body);
            if (remaining > 120) {
                job.preexisting = true;
            } else {
                watcher = setInterval(() => {
                    if (checking || job.signal.aborted) return;
                    checking = true;
                    job.assertAuthorized().catch(job.abort).finally(() => { checking = false; });
                }, this.recheckMs);
                const payload = await createInternalSession(this.handler, job.body, job);
                job.session = this.sessionForId(payload.id);
                if (!job.session) throw Error('STARTUP_PREPARATION_SESSION_MISSING');
                while (!await this.covered(job.session)) {
                    if (job.session.lastError || job.session.inputFailure || job.session.status === 'ended')
                        throw Error('STARTUP_PREPARATION_MEDIA_FAILED');
                    await delay(this.pollMs, null, { signal: job.signal });
                }
                await job.assertAuthorized();
                job.complete = true;
            }
        } catch (_) {
            this.stats.failed++;
        } finally {
            clearTimeout(timer); clearInterval(watcher);
            if (job.authorization) {
                try { if (!await job.authorization) job.abort(); }
                catch (_) { job.abort(); }
            }
            // stop() must prove transport drain before exclusion is released.
            // An uncertain cleanup stays in the ledger and blocks new warmups.
            try {
                if (job.session) await this.stop(job.session, job);
                drained = true;
            } catch (_) { this.stats.drainFailures++; }
            prepared = drained && !job.signal.aborted && (job.preexisting || job.session?.startupCacheStored === true);
            if (drained) this.jobs.delete(job);
        }
        if (prepared) this.stats.prepared++;
        return { protocol: 1, prepared, seconds: prepared ? 60 : 0, providerDrained: drained,
            refreshAfterSeconds: prepared ? Math.max(30, Math.min(300, this.remainingSeconds(job.body) - 120)) : 60,
            reason: prepared ? 'prefix-ready' : job.signal.aborted ? 'cancelled' : 'not-prepared' };
    }
    async preempt(predicate) {
        const jobs = [...this.jobs].filter(predicate);
        for (const job of jobs) { this.stats.preempted++; job.abort(); }
        const results = await Promise.allSettled(jobs.map(job => job.done));
        return { stopped: jobs.length, providerDrained: results.every(r => r.status === 'fulfilled' && r.value.providerDrained === true) };
    }
    status() { return { protocol: 1, active: this.jobs.size, maximum: 1,
        preparationBudgetMs: this.durationMs, preemptable: true, ...this.stats }; }
}
module.exports = { StartupCachePreparation, createInternalSession };
