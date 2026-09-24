'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
class StoryboardStore {
    constructor(root, secret, maxJobs = 50) {
        if (!path.isAbsolute(root) || !secret) throw new Error('Private storyboard volume and secret required');
        this.root = root; this.secret = secret; this.maxJobs = maxJobs;
    }
    dir(id) {
        if (!validId(id)) throw new Error('Invalid storyboard id');
        return path.join(this.root, id);
    }
    async open() { await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); await fs.chmod(this.root, 0o700); }
    sign(text) { return crypto.createHmac('sha256', this.secret).update(text).digest('hex'); }
    async save(job) {
        await this.open();
        const dir = this.dir(job.jobId);
        const exists = await fs.stat(dir).catch(() => null);
        if (!exists && (await fs.readdir(this.root)).filter(validId).length >= this.maxJobs) throw new Error('Storyboard durable queue full');
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const p = job.storyboardProgress || job.progress;
        // Never persist transport URLs, upload grants, provider passwords or tokens.
        const body = JSON.stringify({ version: 1, jobId: job.jobId, uid: job.uid, sourceId: job.sourceId,
            callbackUrl: job.callbackUrl, duration: job.duration, durable: true,
            storyboardNotBefore: job.storyboardNotBefore || 0, terminal: job.terminal || null,
            progress: p ? { plan: p.plan, next: p.next, failures: p.failures,
                sourceBinding: p.sourceBinding, activeMs: p.activeMs || 0 } : null });
        const tmp = path.join(dir, 'job.json.tmp');
        const handle = await fs.open(tmp, 'w', 0o600);
        try { await handle.writeFile(JSON.stringify({ body, mac: this.sign(body) })); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(tmp, path.join(dir, 'job.json'));
        // fsync directory is supported on Linux (production), best effort on Windows.
        let dh;
        try { dh = await fs.open(dir, 'r'); await dh.sync(); } catch (_) {} finally { await dh?.close(); }
    }
    async load() {
        await this.open();
        const jobs = [];
        for (const id of (await fs.readdir(this.root)).filter(validId)) {
            try {
                const data = JSON.parse(await fs.readFile(path.join(this.dir(id), 'job.json'), 'utf8'));
                const mac = this.sign(data.body);
                if (typeof data.mac !== 'string' || data.mac.length !== mac.length ||
                    !crypto.timingSafeEqual(Buffer.from(data.mac), Buffer.from(mac))) continue;
                const job = JSON.parse(data.body);
                if (job.version !== 1 || job.jobId !== id) continue;
                job.kind = 'storyboard'; job.prio = 1;
                jobs.push(job);
            } catch (_) { /* corrupt/uncommitted records never authorize a provider read */ }
        }
        return jobs;
    }
    async remove(id) { await fs.rm(this.dir(id), { recursive: true, force: true }); }
}
module.exports = { StoryboardStore };
