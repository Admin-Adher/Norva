'use strict';

// Internal capability only. The session owner must separately hold the normal
// provider claim and validate the current source before resuming. This barrier
// never grants an account lease or exposes a public pause/resume endpoint.
class RetainedInputBarrier {
    #scope; #state = 'active'; #active = 0; #waiters = new Set(); #idle = new Set();
    #token = null; #timer = null; #started = null; #deadline = null;
    #now; #ttl; #onClose; #setTimer; #clearTimer;
    #validationController = null;
    #validationDone = Promise.resolve();

    constructor({ scope, ttlMs = 5000, onClose, now = Date.now,
        setTimer = setTimeout, clearTimer = clearTimeout }) {
        if (!scope || typeof scope !== 'object' || !Number.isSafeInteger(ttlMs)
            || ttlMs < 1 || ttlMs > 10000 || typeof onClose !== 'function') {
            throw new Error('INVALID_RETAINED_INPUT_OPTIONS');
        }
        this.#scope = scope; this.#ttl = ttlMs; this.#now = now;
        this.#onClose = onClose; this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    }

    #expire() {
        if (this.#deadline !== null && (this.#now() >= this.#deadline || this.#now() < this.#started)) {
            this.close('expired');
        }
    }

    #notify() {
        for (const wake of this.#waiters) wake();
        this.#waiters.clear();
        if (!this.#active || this.#state === 'closed') {
            for (const wake of this.#idle) wake();
            this.#idle.clear();
        }
    }

    async wait(signal) {
        for (;;) {
            this.#expire();
            if (signal?.aborted || this.#state === 'closed') throw new Error('RETAINED_INPUT_CLOSED');
            if (this.#state === 'active') return;
            await new Promise(resolve => {
                const wake = () => { this.#waiters.delete(wake); signal?.removeEventListener('abort', wake); resolve(); };
                this.#waiters.add(wake); signal?.addEventListener('abort', wake, { once: true });
                if (signal?.aborted) wake();
            });
        }
    }

    // Called synchronously under the existing mono-provider mutex. A pause
    // racing with queue acquisition must release that mutex and wait again.
    enter() {
        this.#expire();
        if (this.#state !== 'active') return null;
        this.#active++;
        let released = false;
        return () => { if (!released) { released = true; this.#active--; this.#notify(); } };
    }

    async park(scope, drainTransport) {
        this.#expire();
        if (scope !== this.#scope || this.#state !== 'active') return null;
        this.#state = 'parking'; this.#started = this.#now(); this.#deadline = this.#started + this.#ttl;
        this.#timer = this.#setTimer(() => this.close('expired'), this.#ttl);
        this.#timer?.unref?.();
        try {
            if (this.#active) await new Promise(resolve => this.#idle.add(resolve));
            this.#expire();
            if (this.#state !== 'parking') return null;
            // Includes strict transport disposal and the ordinary provider's
            // release grace. No drained receipt exists until both finish.
            await drainTransport();
            this.#expire();
            if (this.#state !== 'parking') return null;
            this.#state = 'parked'; this.#token = Object.freeze({});
            return this.#token;
        } catch (_) { this.close('drain-failed'); return null; }
    }

    async resume(token, scope, validate, restartTransport) {
        this.#expire();
        if (this.#state !== 'parked' || scope !== this.#scope || !token || token !== this.#token) return false;
        this.#token = null; this.#state = 'validating';
        this.#validationController = new AbortController();
        let validationSettled;
        this.#validationDone = new Promise(resolve => { validationSettled = resolve; });
        try {
            // The caller checks its ordinary claim and fresh file samples. The
            // gate remains shut until that uncached validation has drained.
            const valid = await validate(this.#validationController.signal);
            this.#expire();
            if (this.#state !== 'validating') return false;
            if (valid !== true) { this.close('validation-failed'); return false; }
            // Synchronous creation only: no async dispatcher may appear after
            // close has already cleaned up its owner.
            if (restartTransport() !== true) { this.close('restart-failed'); return false; }
            this.#clearTimer(this.#timer); this.#timer = null; this.#deadline = null;
            this.#state = 'active'; this.#notify(); return true;
        } catch (_) { this.close('validation-failed'); return false; }
        finally { this.#validationController = null; validationSettled(); }
    }

    close(reason = 'closed') {
        if (this.#state === 'closed') return;
        this.#state = 'closed'; this.#token = null; this.#deadline = null;
        this.#validationController?.abort();
        this.#clearTimer(this.#timer); this.#timer = null; this.#notify();
        try { this.#onClose(reason); } catch (_) { /* Owner cleanup is idempotent. */ }
    }

    status() { this.#expire(); return { state: this.#state, activeWindows: this.#active, waiting: this.#waiters.size }; }
    async waitForValidation() { await this.#validationDone; }
}
module.exports = { RetainedInputBarrier };
