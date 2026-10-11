'use strict';
const crypto = require('node:crypto');
const { strongResumeIdentity } = require('./private-resume-binding');
const { sampleProof } = require('./recent-resume-samples');
const keyFor = binding => crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
const scopeFor = binding => keyFor([binding.ownerKey,binding.sourceUrlHash,binding.fileSizeBytes]);
const sameFile = (a,b) => ['ownerKey','sourceUrlHash','fileSizeBytes'].every(k=>a[k]===b[k]);

function resumeWindowDisposition(position, duration) {
    if (!Number.isFinite(position) || position <= 0) return 'no-position';
    if (!Number.isFinite(duration) || duration <= 0) return 'unknown-duration';
    return position >= duration * 0.9 ? 'finished' : 'resume';
}

// Optional storage transport around the existing HLS cache. No provider I/O,
// second decoder or foreground wait for R2 writes is introduced. Detached
// snapshots remain charged to the existing RAM budget until I/O has settled.
class PrivateResumePersistence {
    constructor({ cache, store = null, allowsOwner = () => false, maxJobs = 4 } = {}) {
        if (!cache || !Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 8
            || (store && store.disk.purpose !== 'resume')) throw Error('RESUME_PERSISTENCE_CONFIG');
        Object.assign(this, { cache, store, allowsOwner, maxJobs });
        this.tasks = new Map(); this.fences = new Map(); this.pending = Promise.resolve(); this.exhausted = false;
        this.stats = { queued: 0, stored: 0, skipped: 0, failures: 0, retired: 0 };
    }
    enabled(binding) { return Boolean(this.store && binding && this.allowsOwner(binding.ownerKey) && !this.exhausted); }
    hasCandidate(binding, position) { return this.cache.hasCandidate(binding, position); }
    revalidationPlan(binding, position) { return this.cache.revalidationPlan(binding, position); }
    async restore(binding, position, duration, signal) {
        if (!this.enabled(binding) || resumeWindowDisposition(position,duration) !== 'resume') return false;
        const key = scopeFor(binding), fence = this.fences.get(key);
        const cached=this.cache.candidate(binding,position);
        // A second Gateway may have consumed/replaced the stored window. A
        // local archive must not bypass that durable retirement barrier.
        if(cached?.durableOrigin && !await this.store.current(binding,cached.createdAt,signal))this.cache.retire(binding);
        return this.cache.restoreWindow(binding,position,async () => {
            const entry = await this.store.get(binding,signal);
            if(this.fences.get(key) !== fence || !entry || entry.createdAt <= (fence ?? -1))return null;
            entry.durableOrigin=true;return entry;
        });
    }
    async restoreInput(binding, duration, signal) {
        if (!this.enabled(binding) || signal?.aborted || !Number.isFinite(duration) || duration<=0)return false;
        const key=scopeFor(binding),fence=this.fences.get(key),cached=this.cache.inputCandidate(binding);
        if(cached?.format==='native-mp4-input-v1' && (cached.durationSeconds!==duration
            || resumeWindowDisposition(cached.resumePosition,duration)!=='resume')) {
            this.retire(binding,cached.createdAt);return false;
        }
        if(cached?.durableOrigin && !await this.store.current(binding,cached.createdAt,signal))this.cache.retire(binding);
        return this.cache.restoreWindow(binding,0,async()=>{
            const entry=await this.store.get(binding,signal);
            if(signal?.aborted || this.fences.get(key)!==fence || !entry || entry.createdAt<=(fence ?? -1)
                || entry.format!=='native-mp4-input-v1' || entry.durationSeconds!==duration
                || resumeWindowDisposition(entry.resumePosition,duration)!=='resume')return null;
            entry.durableOrigin=true;return entry;
        },'resume',true);
    }
    acquire(binding, position, observed) {
        return this.acquireVerified(binding,this.cache.candidate(binding,position),observed,
            ()=>this.cache.acquire(binding,position,observed));
    }
    acquireInput(binding, observed) {
        return this.acquireVerified(binding,this.cache.inputCandidate(binding),observed,
            ()=>this.cache.acquireInput(binding,observed));
    }
    acquireVerified(binding,candidate,observed,acquire) {
        const lease = acquire();
        if (!lease && candidate && this.enabled(binding) && (strongResumeIdentity(observed,binding.fileSizeBytes)
            || sampleProof(observed?.samples,observed?.fileSizeBytes,observed?.effectiveUrlIdentitySha256)
            || (Number.isSafeInteger(observed?.fileSizeBytes) && observed.fileSizeBytes !== binding.fileSizeBytes)))
            this.retire(binding,candidate.createdAt);
        return lease;
    }
    retire(binding, beforeOrAt = this.cache.now()) {
        if (!this.enabled(binding)) return false;
        const key = scopeFor(binding);
        if (!this.fences.has(key) && this.fences.size >= 8192) { this.exhausted = true; return false; }
        const at = Math.max(beforeOrAt,this.fences.get(key) ?? -1);
        this.fences.set(key,at);
        this.cache.retire(binding);
        for (const entry of [...this.cache.entries.values()]) if (sameFile(entry.binding,binding))this.cache.retire(entry.binding);
        for (const task of this.tasks.values()) if (sameFile(task.binding,binding))task.controller.abort();
        this.stats.retired++;
        // Sequencing this deletion ahead of a later B prevents an old upload
        // from republishing A, even if deletion or publication is interrupted.
        const run = async () => { await this.store.retire(binding,at); };
        const result = this.pending.then(run,run);
        this.pending = result.catch(() => { this.stats.failures++; });
        return true;
    }
    progress(binding, position, initialPosition, duration) {
        if (!this.enabled(binding) || !Number.isFinite(position) || position < 0
            || !Number.isFinite(initialPosition) || initialPosition < 0) return false;
        if (resumeWindowDisposition(position,duration) === 'finished' || position > initialPosition+0.001)
            return this.retire(binding);
        return false;
    }
    queueWindow(binding, position, duration) {
        if (!this.enabled(binding) || resumeWindowDisposition(position,duration) !== 'resume') return false;
        return this.queueSnapshot(binding,this.cache.candidate(binding,position));
    }
    queueInput(binding, position, duration) {
        if (!this.enabled(binding) || resumeWindowDisposition(position,duration)!=='resume')return false;
        const entry=this.cache.inputCandidate(binding);
        if(entry?.format!=='native-mp4-input-v1' || entry.resumePosition!==position || entry.durationSeconds!==duration)return false;
        return this.queueSnapshot(binding,entry);
    }
    queueSnapshot(binding, entry) {
        const key = keyFor(binding), scope=scopeFor(binding);
        if (!entry || entry.capturePurpose !== 'resume' || entry.ended || entry.createdAt <= (this.fences.get(scope) ?? -1)
            || this.tasks.has(key) || this.tasks.size >= this.maxJobs
            || this.cache.bytes+this.cache.reservedBytes+entry.bytes > this.cache.maxBytes) { this.stats.skipped++; return false; }
        const snapshot = { ...entry, assets: new Map(entry.assets), inputWindows: entry.inputWindows.slice(),
            subtitlePlaylists: new Map(entry.subtitlePlaylists), live: true };
        const controller = new AbortController(), task = { controller, binding };
        this.tasks.set(key,task); this.cache.reservedBytes += entry.bytes; this.stats.queued++;
        const current = () => !controller.signal.aborted && snapshot.live && entry.live && !entry.retired
            && entry.createdAt > (this.fences.get(scope) ?? -1);
        const run = async () => {
            if (!current()) return false;
            await this.store.retire(binding,entry.createdAt-1);
            if (!current()) return false;
            return this.store.put(snapshot,key,current,controller.signal);
        };
        const result = this.pending.then(run,run);
        this.pending = result.then(stored => { if (stored) {this.stats.stored++;if(entry.live && !entry.retired)entry.durableOrigin=true;} },() => { this.stats.failures++; })
            .finally(() => {
                snapshot.live = false; snapshot.assets.clear(); snapshot.inputWindows = [];
                this.cache.reservedBytes -= entry.bytes; this.tasks.delete(key); this.cache.prune();
            });
        return true;
    }
    async revokeOwner(owner) {
        for (const task of this.tasks.values()) if (task.binding.ownerKey === owner)task.controller.abort();
        await this.store?.revokeOwner(owner);
    }
    async drained() { await this.pending; }
    status() { return { enabled: Boolean(this.store), durableJobs: this.tasks.size, endCutoffPercent: 90,
        exhausted: this.exhausted, ...this.stats, ...(this.store?{storage:this.store.status()}:{}) }; }
}
module.exports = { PrivateResumePersistence, resumeWindowDisposition };
