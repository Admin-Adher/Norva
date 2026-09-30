'use strict';

// Internal, owner + server-issued playback UUID only. Tombstones close the
// cancel-before-POST race without evicting another Play from the same owner.
function createPlaybackPreparationCancellation({ ttlMs = 300_000, maximum = 4096,
    now = Date.now, drainTimeoutMs = 8000 } = {}) {
    const tombstones = new Map(), pending = new Map();
    const key = (owner, id) => {
        if (!/^[a-f0-9]{64}$/.test(owner || '')
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id || ''))
            throw Object.assign(new Error('Invalid preparation identity'), { code: 'PREPARATION_SCOPE_INVALID' });
        return `${owner}:${id}`;
    };
    const sweep = () => {
        for (const [id, until] of tombstones) if (until <= now() && !pending.has(id)) tombstones.delete(id);
    };
    return {
        assertOpen(owner, id) {
            const scope = key(owner, id); sweep();
            if (tombstones.has(scope)) throw Object.assign(new Error('Playback preparation cancelled'),
                { code: 'PLAYBACK_PREPARATION_CANCELLED' });
        },
        begin(owner, id, abort) {
            const scope = key(owner, id); sweep();
            if (tombstones.has(scope)) throw Object.assign(new Error('Playback preparation cancelled'),
                { code: 'PLAYBACK_PREPARATION_CANCELLED' });
            if (pending.has(scope)) throw Object.assign(new Error('Playback preparation already running'),
                { code: 'PLAYBACK_PREPARATION_DUPLICATE' });
            if (pending.size >= maximum) throw Object.assign(new Error('Preparation ledger is full'),
                { code: 'PREPARATION_CANCEL_CAPACITY' });
            let release;
            const drained = new Promise(resolve => { release = resolve; });
            const entry = { abort, drained, verify: async () => true }; pending.set(scope, entry);
            let released = false;
            return (verify = async () => true) => {
                if (released) return;
                released = true;
                entry.verify = verify;
                if (!tombstones.has(scope) && pending.get(scope) === entry) pending.delete(scope);
                release();
            };
        },
        async cancel(owner, id, closeExact) {
            const scope = key(owner, id); sweep();
            if (!tombstones.has(scope) && tombstones.size >= maximum)
                throw Object.assign(new Error('Cancellation ledger is full'), { code: 'PREPARATION_CANCEL_CAPACITY' });
            // Synchronous fence precedes any stop/await. Never evict a live tombstone.
            tombstones.set(scope, Math.max(tombstones.get(scope) || 0, now() + ttlMs));
            const active = pending.get(scope);
            active?.abort();
            let timer;
            const work = (async () => {
                await closeExact(owner, id);
                await active?.drained;
                if (active && !await active.verify()) return false;
                // Catch a session published just as its POST completed.
                await closeExact(owner, id);
                if (active && pending.get(scope) === active) pending.delete(scope);
                return true;
            })();
            // Keep errors handled even when the bounded HTTP answer precedes cleanup.
            const settled = work.then(value => value === true, () => false);
            try {
                const drained = await Promise.race([settled,
                    new Promise(resolve => { timer = setTimeout(() => resolve(false), drainTimeoutMs); })]);
                return { drained, ownerKey: owner, playbackSessionId: id };
            } finally { clearTimeout(timer); }
        },
        snapshot() { sweep(); return { tombstones: tombstones.size, pending: pending.size }; },
    };
}

module.exports = { createPlaybackPreparationCancellation };
