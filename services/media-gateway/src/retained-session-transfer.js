'use strict';

// In-memory ownership of a still-running decoder, never an authorization or
// provider lease. Callers keep ordinary startup locks/claims during resume.
// A single parked producer retains its existing encoder/output reservations.
class RetainedSessionTransfer {
    #entries = new Map(); #stop; #revoke; #now; #setTimer; #clearTimer;
    constructor({ stop, revoke, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
        this.#stop = stop; this.#revoke = revoke; this.#now = now;
        this.#setTimer = setTimer; this.#clearTimer = clearTimer;
    }
    forget(session) {
        const entry = this.#entries.get(session);
        if (!entry) return;
        this.#clearTimer(entry.timer); this.#entries.delete(session);
        // An input EOF caused by revocation/expiry may have FFmpeg exit 0.
        // It is not a whole-file completion certificate.
        session.retainedInputInterrupted = true;
        session.retainedSessionState = null;
    }
    async discard(session) {
        session.retainedInputInterrupted = true;
        await this.#stop(session);
    }
    async park(session, binding, position) {
        if (!binding || this.#entries.size || !session?.retainedInputScope
            || session.stoppingPromise || session.status !== 'ready'
            || !Number.isFinite(position) || position <= 0
            || !session.ffmpeg || session.ffmpeg.exitCode !== null || session.ffmpeg.signalCode) return false;
        const started = this.#now();
        const entry = { binding, position, started, deadline: started + 10000, token: null, timer: null };
        this.#entries.set(session, entry);
        session.retainedSessionState = 'parking'; session.status = 'retained-parking';
        try {
            // Synchronous revocation includes already-authorized HTTP responses.
            this.#revoke(session);
            entry.timer = this.#setTimer(() => {
                if (this.#entries.get(session) === entry) void this.discard(session).catch(() => {});
            }, 10000);
            entry.timer?.unref?.();
            entry.token = await session.finiteMkvSeekBroker.parkRetainedInput(session.retainedInputScope);
            if (!entry.token || !this.#valid(session, entry)) { await this.discard(session); return false; }
            session.retainedSessionState = 'parked'; session.status = 'retained';
            return true;
        } catch (_) { await this.discard(session); return false; }
    }
    #valid(session, entry) {
        const now = this.#now();
        return this.#entries.get(session) === entry && now >= entry.started && now < entry.deadline
            && !session.stoppingPromise && !session.lastError && !session.inputFailure
            && session.ffmpeg?.exitCode === null && !session.ffmpeg.signalCode;
    }
    async resume(binding, position, { accept, validate, adopt }) {
        const found = [...this.#entries].find(([s, e]) => e.binding === binding && s.retainedSessionState === 'parked');
        if (!found) return null;
        const [session, entry] = found;
        // The next request may resume only at the explicit exit position, not
        // use a retained decoder as an arbitrary-seek or cross-file shortcut.
        if (!Number.isFinite(position) || Math.abs(position - entry.position) > 0.25
            || !this.#valid(session, entry)) { await this.discard(session); return null; }
        session.retainedSessionState = 'validating'; session.status = 'retained-validating';
        try {
            if (!await accept(session) || !this.#valid(session, entry)) { await this.discard(session); return null; }
            const resumed = await session.finiteMkvSeekBroker.resumeRetainedInput(entry.token, session.retainedInputScope,
                async signal => await validate(session, signal) === true && this.#valid(session, entry),
                () => {
                    if (!this.#valid(session, entry) || adopt(session) !== true) return false;
                    this.#clearTimer(entry.timer); this.#entries.delete(session);
                    session.retainedSessionState = null;
                    return true;
                });
            if (!resumed) { await this.discard(session); return null; }
            return session;
        } catch (_) { await this.discard(session); return null; }
    }
}
module.exports = { RetainedSessionTransfer };
