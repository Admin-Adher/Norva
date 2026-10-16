'use strict';
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const zlib = require('node:zlib'), { promisify } = require('node:util');
const { Readable } = require('node:stream'), { pipeline } = require('node:stream/promises');
const gunzip = promisify(zlib.gunzip);
const { SAMPLE_BYTES } = require('./recent-resume-samples');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keyFor = binding => hash(JSON.stringify(binding));
const assetName = name => /^(resume-\d+\.ts|resume-subtitle_\d+-\d+\.vtt)$/.test(name);
const validBinding = b => b && Object.keys(b).length === 4 && hex(b.ownerKey) && hex(b.sourceUrlHash)
    && hex(b.profileHash) && Number.isSafeInteger(b.fileSizeBytes) && b.fileSizeBytes > 0;
const directoryName = /^[a-f0-9]{64}-[a-f0-9]{16}$/;
const recordBytes = m => m.recordBytes ?? (m.storage?.bytes ?? m.bytes);

// A private, bounded disk tier. It never extends an identity proof's lifetime,
// retains provider URLs, or grants playback. Every restored entry still passes
// the current authenticated binding and ordinary fresh-file checks.
class StartupCacheDiskStore {
    constructor({ root, maxBytes = 32 * 1024 ** 3, perOwnerBytes = 2 * 1024 ** 3,
        perFileBytes = 64 * 1024 ** 2, maxEntries = 8192, reserveFreeBytes = 32 * 1024 ** 3,
        retentionMs = 0, purpose = 'startup', now = Date.now } = {}) {
        if (!path.isAbsolute(root || '') || ![maxBytes, perOwnerBytes, perFileBytes, maxEntries, reserveFreeBytes]
            .every(n => Number.isSafeInteger(n) && n > 0) || perFileBytes > perOwnerBytes || perOwnerBytes > maxBytes
            || !Number.isSafeInteger(retentionMs) || retentionMs < 0 || retentionMs > 7*86400_000
            || !['startup','resume'].includes(purpose))
            throw Error('STARTUP_DISK_CONFIG_INVALID');
        Object.assign(this, { root, maxBytes, perOwnerBytes, perFileBytes, maxEntries, reserveFreeBytes, retentionMs, purpose, now });
        this.index = new Map(); this.revoked = new Map(); this.pending = Promise.resolve();
        this.stats = { stores: 0, restores: 0, rejected: 0, evictions: 0 }; this.initialized = false;
    }
    async initialize() {
        await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
        const stat = await fsp.lstat(this.root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('STARTUP_DISK_ROOT_INVALID');
        await fsp.chmod(this.root, 0o700);
        const revoked = await this.readFile(path.join(this.root, 'revoked.json'), 1024 ** 2).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (revoked) {
            const rows = JSON.parse(revoked.toString());
            if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2
                || !hex(row[0]) || !Number.isSafeInteger(row[1]) || row[1] < 0))
                throw Error('STARTUP_DISK_REVOCATION_INVALID');
            for (const [owner, at] of rows) this.revoked.set(owner, at);
        }
        // Iterate instead of buffering an unbounded directory listing. Apply
        // the limits during recovery as well as during new writes.
        const directories = await fsp.opendir(this.root);
        for await (const item of directories) {
            const name = item.name;
            if (!directoryName.test(name)) continue;
            try {
                const dir = path.join(this.root, name), stat = await fsp.lstat(dir);
                if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid-directory');
                const bytes = await this.readFile(path.join(dir, 'manifest.json'), 1024 ** 2);
                const m = JSON.parse(bytes.toString());
                if (!this.validManifest(m) || name.slice(0,64) !== keyFor(m.binding)) throw Error('invalid-manifest');
                const prior = this.index.get(keyFor(m.binding));
                if (prior && prior.createdAt >= m.createdAt) { await this.removeDirectory(name); continue; }
                if (prior) await this.removeDirectory(prior.directory);
                this.index.set(keyFor(m.binding), { ...m, directory: name,
                    recordBytes: bytes.length + (m.storage?.bytes ?? m.bytes) });
                await this.trim(0, m.binding.ownerKey);
            } catch (_) { await this.removeDirectory(name); this.stats.rejected++; }
        }
        await this.trim(); this.initialized = true;
    }
    validManifest(m) {
        const native = ['native-mp4-input-v1','native-file-input-v1'].includes(m?.format);
        if (m?.protocol !== 1 || !validBinding(m.binding)
            || (m.format!==undefined && !native)
            || !hex(m.preparationKey) || !Number.isSafeInteger(m.createdAt) || m.createdAt > this.now()
            || m.createdAt <= (this.revoked.get(m.binding.ownerKey) ?? -1)
            || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= m.createdAt
            || m.expiresAt > m.createdAt + (m.recentProof && !m.identity ? 600_000 : 1_800_000)
            || !Number.isSafeInteger(m.retainedUntil ?? m.expiresAt)
            || (m.retainedUntil ?? m.expiresAt) < m.expiresAt
            || (m.retainedUntil ?? m.expiresAt) > m.createdAt + Math.max(this.retentionMs, m.recentProof && !m.identity ? 600_000 : 1_800_000)
            || (m.retainedUntil ?? m.expiresAt) <= this.now()
            || (m.purpose || 'startup') !== this.purpose || !Number.isFinite(m.start) || m.start<0
            || !Number.isFinite(m.end) || m.ended !== false
            || (native ? this.purpose!=='resume' || m.inputOnly!==true
                || !Number.isFinite(m.durationSeconds) || m.durationSeconds<=0 || m.durationSeconds>86400
                || !Number.isFinite(m.resumePosition) || m.resumePosition<=0 || m.resumePosition>=m.durationSeconds*0.9
                || m.start!==m.resumePosition || m.end!==m.resumePosition
                : this.purpose==='startup' ? m.start!==0 || !(m.end>=60 && m.end<=90)
                    : !(m.end>m.start && m.end-m.start<=150))
            || !(hex(m.identity) || m.recentProof?.kind === 'sampled-recent-v1')
            || (!native && (!Number.isSafeInteger(m.bandwidth) || m.bandwidth <= 0))
            || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > this.perFileBytes
            || !Array.isArray(m.assets) || (!native && !m.assets.length) || m.assets.length > 512
            || !Array.isArray(m.inputWindows) || m.inputWindows.length > 512
            || !Array.isArray(m.segments) || (!native && !m.segments.length) || m.segments.length > 128
            || !Array.isArray(m.subtitlePlaylists) || m.subtitlePlaylists.length > 32) return false;
        if (m.storage && (!['plain', 'gzip'].includes(m.storage.codec)
            || !Number.isSafeInteger(m.storage.bytes) || m.storage.bytes < 1 || m.storage.bytes > m.bytes)) return false;
        if (m.recentProof) {
            const proof = m.recentProof;
            if ((!native && m.identity) || proof.kind !== 'sampled-recent-v1' || !hex(proof.target)
                || proof.fileSizeBytes !== m.binding.fileSizeBytes || !Array.isArray(proof.ranges)
                || proof.ranges.length !== 4 || proof.ranges[0]?.start !== 0) return false;
            let end = -1;
            for (const range of proof.ranges) {
                if (!Number.isSafeInteger(range?.start) || range.start <= end
                    || range.length !== SAMPLE_BYTES || !hex(range.digest)
                    || range.start + range.length > proof.fileSizeBytes) return false;
                end = range.start + range.length - 1;
            }
        }
        // Native MP4 retains exact original ranges, not a fabricated HLS
        // timeline. The complete header and four samples remain mandatory.
        if (native && (!m.recentProof || m.assets.length || m.segments.length || m.subtitlePlaylists.length
            || !m.inputWindows.length || m.inputWindows[0].start!==0 || m.inputWindows[0].length<65536))return false;
        if (m.targetParts && (!['protocol','host','path','queryKeys'].every(key => hex(m.targetParts[key]))
            || Object.keys(m.targetParts).length !== 4)) return false;
        let at = 0;
        const pieces = [...m.assets, ...m.inputWindows];
        for (const p of pieces) {
            if (!Number.isSafeInteger(p?.offset) || p.offset !== at || !Number.isSafeInteger(p.length)
                || p.length < 1 || !hex(p.digest)) return false;
            at += p.length;
        }
        if (at !== m.bytes || new Set(m.assets.map(a=>a.name)).size !== m.assets.length
            || m.assets.some(a=>typeof a.name !== 'string' || !assetName(a.name))
            || m.inputWindows.some(w=>!Number.isSafeInteger(w.start) || w.start<0 || w.start+w.length>m.binding.fileSizeBytes)
            || m.segments.some(s=>!/^resume-\d+\.ts$/.test(s?.name) || !m.assets.some(a=>a.name===s.name)
                || !Number.isFinite(s.duration) || !(s.duration>0 && s.duration<=30))
            || Math.abs(m.segments.reduce((n,s)=>n+s.duration,0)-(m.end-m.start))>0.001) return false;
        return new Set(m.segments.map(s=>s.name)).size === m.segments.length
            && m.subtitlePlaylists.every(row => Array.isArray(row) && row.length === 2
                && /^subtitle_\d+\.m3u8$/.test(row[0]) && Array.isArray(row[1])
                && row[1].length === m.segments.length && row[1].every((s,i)=>s
                    && m.assets.some(a=>a.name===s.name) && s.duration===m.segments[i].duration));
    }
    async readFile(file, maximum) {
        const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw Error('invalid-file');
            return await handle.readFile();
        } finally { await handle.close(); }
    }
    async removeDirectory(name) {
        if (!directoryName.test(name)) throw Error('invalid-directory-name');
        await fsp.rm(path.join(this.root,name), { recursive: true, force: true });
    }
    metadata(binding) {
        const m = this.index.get(keyFor(binding));
        return m && this.validManifest(m) ? m : null;
    }
    bindingForPreparation(key) {
        return [...this.index.values()].find(m=>m.preparationKey===key && this.validManifest(m))?.binding || null;
    }
    discard(binding) {
        const key = keyFor(binding), prior = this.index.get(key);
        if (!prior) return Promise.resolve();
        this.index.delete(key);
        const run = () => this.removeDirectory(prior.directory);
        const result = this.pending.then(run, run);
        this.pending = result.catch(()=>false);
        return result;
    }
    async get(binding) {
        const m = this.metadata(binding);
        // An aged sampled proof remains archived, but cannot become a lease.
        // Only a strong validator can be freshly matched after its short TTL.
        if (!m || (m.recentProof && !m.identity && m.expiresAt <= this.now())) return null;
        try {
            const stored = await this.readFile(path.join(this.root,m.directory,'payload.bin'), this.perFileBytes);
            if (stored.length !== (m.storage?.bytes ?? m.bytes)) throw Error('incomplete-storage');
            const entry = await this.decode(binding, m, stored);
            if (this.metadata(binding)!==m) return null;
            this.stats.restores++;
            return entry;
        } catch (_) {
            if (this.index.get(keyFor(binding)) === m) this.index.delete(keyFor(binding));
            await this.removeDirectory(m.directory); this.stats.rejected++; return null;
        }
    }
    async decode(binding, m, stored) {
        if (!this.validManifest(m) || keyFor(m.binding) !== keyFor(binding)
            || !Buffer.isBuffer(stored) || stored.length !== (m.storage?.bytes ?? m.bytes)
            || (m.recentProof && !m.identity && m.expiresAt <= this.now())) return null;
        const payload = m.storage?.codec === 'gzip'
            ? await gunzip(stored, { maxOutputLength: m.bytes }) : stored;
        if (payload.length !== m.bytes) throw Error('incomplete-payload');
        for (const p of [...m.assets,...m.inputWindows])
            if (hash(payload.subarray(p.offset,p.offset+p.length))!==p.digest) throw Error('corrupt-payload');
        return { ...m, archived: m.expiresAt <= this.now(),
            // This interval exposes a candidate for a fresh check, never a lease.
            expiresAt: m.expiresAt > this.now() ? m.expiresAt
                : Math.min(m.retainedUntil ?? m.expiresAt, this.now()+30_000),
            assets: new Map(m.assets.map(a=>[a.name,payload.subarray(a.offset,a.offset+a.length)])),
            inputWindows: m.inputWindows.map(w=>({start:w.start,payload:payload.subarray(w.offset,w.offset+w.length)})),
            subtitlePlaylists: new Map(m.subtitlePlaylists), leases:0,live:true,capturePurpose:this.purpose };
    }
    async export(binding) {
        const m = this.metadata(binding);
        if (!m) return null;
        const { directory, recordBytes: size, ...manifest } = m;
        const file = path.join(this.root, directory, 'payload.bin');
        const digest = crypto.createHash('sha256');
        let bytes = 0;
        const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const before = await handle.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size > this.perFileBytes) throw Error('invalid-file');
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
                bytes += chunk.length; if (bytes > this.perFileBytes) throw Error('invalid-file');
                digest.update(chunk);
            }
            const after = await handle.stat();
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) return null;
        } finally { await handle.close(); }
        if (bytes !== (m.storage?.bytes ?? m.bytes) || this.metadata(binding) !== m) return null;
        return { manifest: JSON.parse(JSON.stringify(manifest)), file, bytes, digest: digest.digest('hex') };
    }
    put(entry, preparationKey, isCurrent = () => true) {
        const run = () => this.write(entry, preparationKey, isCurrent).catch(() => {
            this.stats.rejected++; return false;
        });
        const result = this.pending.then(run,run);
        this.pending = result.catch(()=>false); return result;
    }
    async write(entry, preparationKey, isCurrent) {
        if (!this.initialized || entry.capturePurpose!==this.purpose || !entry.live || !isCurrent()
            || entry.createdAt <= (this.revoked.get(entry.binding.ownerKey) ?? -1)) return false;
        const parts = [...entry.assets].map(([name,payload])=>({name,payload}));
        parts.push(...entry.inputWindows.map(w=>({start:w.start,payload:w.payload})));
        let at=0;
        const describe = p=>{const out={...p,payload:undefined,offset:at,length:p.payload.length,digest:hash(p.payload)};at+=p.payload.length;return out;};
        const descriptors=parts.map(describe);
        const manifest={protocol:1,binding:entry.binding,preparationKey,createdAt:entry.createdAt,
            expiresAt:entry.expiresAt,start:entry.start,end:entry.end,ended:entry.ended,identity:entry.identity,
            recentProof:entry.recentProof,targetParts:entry.targetParts,bandwidth:entry.bandwidth,bytes:at,
            segments:entry.segments,subtitlePlaylists:[...entry.subtitlePlaylists],
            assets:descriptors.slice(0,entry.assets.size),inputWindows:descriptors.slice(entry.assets.size)};
        if(this.purpose==='resume')manifest.purpose='resume';
        if(['native-mp4-input-v1','native-file-input-v1'].includes(entry.format))Object.assign(manifest,{format:entry.format,inputOnly:true,
            resumePosition:entry.resumePosition,durationSeconds:entry.durationSeconds});
        if (this.retentionMs) manifest.retainedUntil = Math.max(entry.expiresAt, entry.createdAt+this.retentionMs);
        if (!this.validManifest(manifest)) return false;
        // Count the manifest as well as media against the disk quotas. The
        // small margin includes storage metadata added after compression.
        const upperBytes = at + Buffer.byteLength(JSON.stringify(manifest)) + 128;
        if (upperBytes > this.perOwnerBytes || upperBytes > this.maxBytes) return false;
        const stat = await fsp.statfs(this.root);
        if (stat.bavail*stat.bsize < this.reserveFreeBytes + 2 * upperBytes) return false;
        await this.trim(upperBytes,entry.binding.ownerKey);
        const name=keyFor(entry.binding)+'-'+crypto.randomBytes(8).toString('hex'),directory=path.join(this.root,name);
        await fsp.mkdir(directory,{mode:0o700});
        try {
            // Compress as a bounded stream: no second whole-prefix buffer is
            // allocated while a background job competes with a viewer.
            const mediaPath = path.join(directory, 'payload.bin');
            await pipeline(Readable.from(parts.map(p=>p.payload)), zlib.createGzip({ level: 6 }),
                fs.createWriteStream(mediaPath, { flags: 'wx', mode: 0o600 }));
            const compressedBytes = (await fsp.stat(mediaPath)).size;
            const useCompressed = compressedBytes < at * 0.97;
            const file = await fsp.open(mediaPath, useCompressed ? 'r+' : 'w', 0o600);
            try {
                if (!useCompressed) for (const p of parts) await file.writeFile(p.payload);
                await file.sync();
            } finally { await file.close(); }
            manifest.storage = { codec: useCompressed ? 'gzip' : 'plain', bytes: useCompressed ? compressedBytes : at };
            // Publish the manifest last, after media durability. An interrupted
            // write has no valid manifest and cannot enter the index on restart.
            const manifestBody = JSON.stringify(manifest);
            const mf=await fsp.open(path.join(directory,'manifest.tmp'),'wx',0o600);
            try {await mf.writeFile(manifestBody);await mf.sync();} finally {await mf.close();}
            if (!entry.live || !isCurrent() || !this.validManifest(manifest)) throw Error('revoked-before-publication');
            await fsp.rename(path.join(directory,'manifest.tmp'),path.join(directory,'manifest.json'));
            await this.syncDirectory(directory);
            await this.syncDirectory(this.root);
            if (!entry.live || !isCurrent() || !this.validManifest(manifest)) throw Error('revoked-after-flush');
            const prior=this.index.get(keyFor(entry.binding));
            this.index.set(keyFor(entry.binding),{...manifest,directory:name,
                recordBytes: manifest.storage.bytes + Buffer.byteLength(manifestBody)});this.stats.stores++;
            if (prior) await this.removeDirectory(prior.directory);
            return true;
        } catch (_) { await this.removeDirectory(name); this.stats.rejected++;return false; }
    }
    async trim(extra=0,owner=null) {
        for (const [key,m] of this.index) if (!this.validManifest(m)) {this.index.delete(key);await this.removeDirectory(m.directory);}
        const rows=()=>[...this.index.values()];
        const sum=list=>list.reduce((n,m)=>n+recordBytes(m),0);
        while (sum(rows())+extra>this.maxBytes || rows().length+(extra?1:0)>this.maxEntries
            || (owner && sum(rows().filter(m=>m.binding.ownerKey===owner))+extra>this.perOwnerBytes)) {
            const ownOverflow=owner && sum(rows().filter(m=>m.binding.ownerKey===owner))+extra>this.perOwnerBytes;
            const victim=rows().filter(m=>!ownOverflow || m.binding.ownerKey===owner).sort((a,b)=>a.createdAt-b.createdAt)[0];
            if (!victim) throw Error('STARTUP_DISK_BUDGET');
            this.index.delete(keyFor(victim.binding));await this.removeDirectory(victim.directory);this.stats.evictions++;
        }
    }
    async revokeOwner(owner) {
        if (!hex(owner)) return;
        this.revoked.set(owner,this.now());
        const removed=[];
        for (const [key,m] of this.index) if (m.binding.ownerKey===owner) {this.index.delete(key);removed.push(m.directory);}
        // The deny fence immediately blocks old entries in-process, and is
        // durable before this operation confirms the global revocation.
        await this.pending;
        const tmp=path.join(this.root,'revoke-'+crypto.randomBytes(8).toString('hex'));
        const file=await fsp.open(tmp,'wx',0o600);
        try{await file.writeFile(JSON.stringify([...this.revoked]));await file.sync();}finally{await file.close();}
        await fsp.rename(tmp,path.join(this.root,'revoked.json'));
        await this.syncDirectory(this.root);
        await Promise.all(removed.map(name=>this.removeDirectory(name)));
    }
    async syncDirectory(directory) {
        if (process.platform === 'win32') return;
        const handle = await fsp.open(directory, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
    }
    status() { return {protocol:1,persistent:true,entries:[...this.index.values()].filter(m=>this.validManifest(m)).length,
        bytes:[...this.index.values()].reduce((n,m)=>n+recordBytes(m),0),
        decodedBytes:[...this.index.values()].reduce((n,m)=>n+m.bytes,0),
        compression:'lossless-gzip-if-smaller',maxBytes:this.maxBytes,perOwnerBytes:this.perOwnerBytes,...this.stats}; }
}
module.exports={StartupCacheDiskStore};
