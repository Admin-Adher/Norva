'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { TsLandmarks } = require('./finite-ts-landmarks');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const PARSER_REVISION = 4;
const TTL = 7 * 24 * 60 * 60_000, MAX_FILES = 256, MAX_FILE = 128 * 1024, MAX_POINTS = 512;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validPoint = (p, size) => p && ['byteOffset', 'packetOffset', 'pts', 'dts', 'videoPid', 'audioPid'].every(k => integer(p[k]))
    && p.byteOffset <= p.packetOffset && p.packetOffset - p.byteOffset <= 65536 && p.packetOffset + 188 < size
    && p.pts >= p.dts && p.pts - p.dts <= 180000 && p.pts < 2 ** 33 && p.videoPid < 8191
    && p.audioPid < 8191 && p.videoPid !== p.audioPid && HEX.test(p.signature);
function proofHash(proof, size) {
    if (proof?.fileSizeBytes !== size || proof.validator?.kind !== 'etag'
        || !/^"[^\r\n"]{1,512}"$/.test(proof.validator.value || '') || !HEX.test(proof.effectiveUrlIdentitySha256 || '')) return null;
    return sha(JSON.stringify([size, proof.validator.value, proof.effectiveUrlIdentitySha256]));
}

// Only the small initial window, already acquired for playback. One process at
// a time, one second deadline, no URLs and no additional provider connection.
let originBusy = false;
function probeTsOrigin(bytes, bin = 'ffprobe') {
    if (originBusy || !Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) return Promise.resolve(null);
    originBusy = true;
    return new Promise(resolve => {
        let child, output = '', overflow = false, timer;
        const finish = value => { clearTimeout(timer); originBusy = false; resolve(value); };
        try {
            child = spawn(bin, ['-v', 'fatal', '-threads', '1', '-protocol_whitelist', 'pipe', '-f', 'mpegts',
                '-skip_estimate_duration_from_pts', '1', '-analyzeduration', '500000', '-probesize', '262144',
                '-i', 'pipe:0', '-show_entries', 'format=start_time:stream=index,id,codec_type,codec_name,start_time', '-of', 'json'],
            { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        } catch (_) { finish(null); return; }
        child.stdin.on('error', () => {});
        child.stdout.on('data', b => { output += b; if (output.length > 16384) { overflow = true; child.kill('SIGKILL'); } });
        child.once('error', () => {});
        child.once('close', code => {
            if (code !== 0 || overflow) return finish(null);
            try {
                const data = JSON.parse(output), streams = data.streams || [];
                const video = streams.find(s => s.codec_type === 'video'), audio = streams.find(s => s.codec_type === 'audio');
                const startSeconds = Number(data.format?.start_time);
                const metadata = streams.filter(s => s !== video && s !== audio);
                if (streams.length < 2 || streams.length > 3 || !video || !audio || video.index !== 0 || audio.index !== 1
                    || metadata.some(s => s.index !== 2 || s.codec_type !== 'data' || s.codec_name !== 'timed_id3')
                    || video.codec_name !== 'h264' || !Number.isFinite(startSeconds) || startSeconds < 0
                    || startSeconds >= 86400 || !/^0x[a-f0-9]+$/i.test(video.id) || !/^0x[a-f0-9]+$/i.test(audio.id)) return finish(null);
                finish({ startSeconds, videoPid: Number(video.id), audioPid: Number(audio.id) });
            } catch (_) { finish(null); }
        });
        timer = setTimeout(() => { overflow = true; child.kill('SIGKILL'); }, 1500);
        child.stdin.end(bytes);
    });
}

class FiniteTsSeekIndex {
    constructor({ root, now = Date.now, probeOrigin = probeTsOrigin, bin = 'ffprobe' } = {}) {
        this.root = path.resolve(root); this.now = now; this.probeOrigin = probeOrigin; this.bin = bin;
        this.io = Promise.resolve(); this.pendingWrites = 0; this.hot = new Map();
        this.stats = { writes: 0, reads: 0, hits: 0, invalidations: 0, failures: 0, pointsObserved: 0, droppedWrites: 0 };
    }
    async directory() {
        await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
        const stat = await fsp.lstat(this.root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('TS_INDEX_ROOT');
        const canonical = await fsp.realpath(this.root);
        if (this.canonicalRoot && canonical !== this.canonicalRoot) throw Error('TS_INDEX_ROOT_CHANGED');
        this.root = canonical; this.canonicalRoot = canonical;
    }
    key({ ownerKey, sourceUrl, fileSizeBytes }) {
        if (!HEX.test(ownerKey || '') || !integer(fileSizeBytes) || !fileSizeBytes || typeof sourceUrl !== 'string') return null;
        // A corrected parser must not inherit an unsupported-graph verdict
        // from an older parser. Older metadata remains under the same TTL/quota.
        return sha(JSON.stringify([PARSER_REVISION, ownerKey, sourceUrl, fileSizeBytes]));
    }
    async read(key, size, diskOnly = false) {
        try {
            const cached = this.hot.get(key);
            if (!diskOnly && cached && cached.size === size && this.now() >= cached.createdAt && this.now() - cached.createdAt < TTL) {
                return JSON.parse(JSON.stringify(cached));
            }
            if (!diskOnly) this.hot.delete(key);
            await this.directory();
            const file = path.join(this.root, key + '.json'), linked = await fsp.lstat(file);
            if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1 || linked.size > MAX_FILE) return null;
            const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            let value;
            try {
                const stat = await handle.stat();
                if (stat.ino !== linked.ino || stat.dev !== linked.dev || stat.size > MAX_FILE || stat.nlink !== 1) return null;
                value = JSON.parse(await handle.readFile('utf8'));
            } finally { await handle.close(); }
            const { digest, ...data } = value;
            if (sha(JSON.stringify(data)) !== digest || data.protocol !== 1 || data.parserRevision !== PARSER_REVISION || data.key !== key || data.size !== size
                || !HEX.test(data.proof || '') || !integer(data.createdAt) || data.createdAt > this.now()
                || this.now() - data.createdAt >= TTL || !Array.isArray(data.points) || data.points.length > MAX_POINTS
                || !integer(data.coveredUntil) || data.coveredUntil > size
                || data.points.some(p => !validPoint(p, size) || p.packetOffset >= data.coveredUntil)) return null;
            const o = data.origin;
            if (o !== null && (!o || !Number.isFinite(o.startSeconds) || o.startSeconds < 0 || o.startSeconds >= 86400
                || !integer(o.videoPid) || !integer(o.audioPid))) return null;
            if (typeof data.unsafe !== 'boolean') return null;
            this.stats.reads++; return data;
        } catch (_) { return null; }
    }
    save(data) {
        if (!HEX.test(data?.key || '') || !HEX.test(data?.proof || '') || !integer(data?.size)
            || !Array.isArray(data.points) || data.points.length > MAX_POINTS
            || data.points.some(p => !validPoint(p, data.size))) return this.io;
        // Immutable snapshot; raw media is never retained by the I/O queue.
        const snapshot = JSON.parse(JSON.stringify(data));
        const recent = this.hot.get(snapshot.key);
        if (recent?.proof === snapshot.proof) {
            snapshot.unsafe ||= recent.unsafe; snapshot.origin ||= recent.origin;
            snapshot.createdAt = Math.min(snapshot.createdAt, recent.createdAt);
            snapshot.coveredUntil = Math.max(snapshot.coveredUntil, recent.coveredUntil);
            snapshot.points = [...new Map([...recent.points, ...snapshot.points].map(p => [p.byteOffset, p])).values()]
                .sort((a, b) => a.byteOffset - b.byteOffset);
            while (snapshot.points.length > MAX_POINTS) snapshot.points = snapshot.points.filter((_, i) => i % 2 === 0);
            if (snapshot.unsafe) snapshot.points = [];
        }
        this.hot.delete(snapshot.key); this.hot.set(snapshot.key, snapshot);
        while (this.hot.size > 32) this.hot.delete(this.hot.keys().next().value);
        // Hot metadata makes the next seek independent of disk flush latency.
        // A slow/full disk cannot accumulate an unbounded metadata queue.
        if (this.pendingWrites >= 64) { this.stats.droppedWrites++; return this.io; }
        this.pendingWrites++;
        const job = async () => {
            await this.directory();
            const old = await this.read(snapshot.key, snapshot.size, true);
            if (old?.proof === snapshot.proof) {
                snapshot.unsafe ||= old.unsafe;
                snapshot.origin ||= old.origin;
                snapshot.createdAt = Math.min(snapshot.createdAt, old.createdAt);
                snapshot.coveredUntil = Math.max(snapshot.coveredUntil, old.coveredUntil);
                snapshot.points = [...new Map([...old.points, ...snapshot.points].map(p => [p.byteOffset, p])).values()];
            }
            snapshot.points.sort((a, b) => a.byteOffset - b.byteOffset);
            // Keep broad coverage instead of just the last 512 seconds.
            while (snapshot.points.length > MAX_POINTS) snapshot.points = snapshot.points.filter((_, i) => i % 2 === 0);
            if (snapshot.unsafe) snapshot.points = [];
            const text = JSON.stringify({ ...snapshot, digest: sha(JSON.stringify(snapshot)) });
            if (Buffer.byteLength(text) > MAX_FILE) throw Error('TS_INDEX_SIZE');
            const files = [];
            for (const name of await fsp.readdir(this.root)) {
                if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
                const file = path.join(this.root, name), stat = await fsp.lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
                files.push({ file, age: stat.mtimeMs, size: stat.size });
            }
            files.sort((a, b) => a.age - b.age);
            // Targets are only this module's exact hashed metadata files, never
            // session directories or the surrounding shared cache.
            let total = files.reduce((sum, f) => sum + f.size, 0);
            while (files.length >= MAX_FILES || total + Buffer.byteLength(text) > MAX_FILES * MAX_FILE
                || (files.length && this.now() - files[0].age >= TTL)) {
                const entry = files.shift(); if (!entry) break;
                await fsp.unlink(entry.file); total -= entry.size;
            }
            const temporary = path.join(this.root, snapshot.key + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
            try {
                await fsp.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
                await fsp.rename(temporary, path.join(this.root, snapshot.key + '.json'));
                await fsp.utimes(path.join(this.root, snapshot.key + '.json'), snapshot.createdAt / 1000, snapshot.createdAt / 1000);
            } finally { await fsp.unlink(temporary).catch(() => {}); }
            this.stats.writes++;
        };
        this.io = this.io.then(job).catch(() => { this.stats.failures++; }).finally(() => { this.pendingWrites--; });
        return this.io;
    }
    async begin(scope) {
        const key = this.key(scope);
        if (!key) return null;
        let data = await this.read(key, scope.fileSizeBytes), currentProof = null, dirty = false, lastSave = 0, originJob = null;
        const store = this;
        const flush = () => {
            if (data && dirty && currentProof) { dirty = false; lastSave = store.now(); return store.save(data); }
            return store.io;
        };
        const parser = new TsLandmarks({
            onInvalid: () => {
                if (!data || data.unsafe) return;
                data.unsafe = true; data.points = []; dirty = true; store.stats.invalidations++;
            },
            onPoint: p => {
                if (!data || data.unsafe || !validPoint(p, scope.fileSizeBytes)) return;
                const previous = data.points.filter(x => x.byteOffset < p.byteOffset).at(-1);
                const next = data.points.find(x => x.byteOffset > p.byteOffset);
                if ((previous && previous.dts >= p.dts) || (next && next.dts <= p.dts)
                    || data.points.some(x => x.signature !== p.signature)) { data.unsafe = true; data.points = []; dirty = true; return; }
                if (data.points.some(x => x.byteOffset === p.byteOffset)) return;
                data.points.push(p); data.points.sort((a, b) => a.byteOffset - b.byteOffset);
                while (data.points.length > MAX_POINTS) data.points = data.points.filter((_, i) => i % 2 === 0);
                dirty = true; store.stats.pointsObserved++;
            },
        });
        const select = seconds => {
            if (!data || data.unsafe || !data.origin || !Number.isFinite(seconds) || seconds <= 30) return null;
            const absoluteSeconds = Math.floor(seconds) + data.origin.startSeconds;
            // Unlike an arbitrary binary-search landing, this is a complete
            // observed SPS/PPS/IDR access point with its preceding PAT/PMT.
            // Two seconds retain audio decoder warmup; a point more than 30s
            // away is not a shortcut. The ordinary TS path keeps its 15s guard.
            const point = data.points.filter(p => p.byteOffset > 0 && p.pts / 90000 <= absoluteSeconds - 2
                && absoluteSeconds - p.pts / 90000 <= 30 && p.videoPid === data.origin.videoPid && p.audioPid === data.origin.audioPid).at(-1);
            return point ? { ...point, absoluteSeconds } : null;
        };
        return {
            hasCandidate: seconds => Boolean(select(seconds)),
            candidate: seconds => {
                if (!currentProof || data?.proof !== currentProof) return null;
                const result = select(seconds); if (result) store.stats.hits++; return result;
            },
            observe({ start, bytes, proof }) {
                const bound = proofHash(proof, scope.fileSizeBytes);
                if (!bound) return;
                if (currentProof && currentProof !== bound) { data = null; currentProof = null; return; }
                currentProof = bound;
                if (!data || data.proof !== bound) {
                    data = { protocol: 1, parserRevision: PARSER_REVISION, key, size: scope.fileSizeBytes, proof: bound,
                        createdAt: store.now(), origin: null, points: [], unsafe: false, coveredUntil: 0 };
                }
                if (data.unsafe) return;
                // Never bridge an unobserved timestamp discontinuity. Only
                // continuous coverage from the original beginning extends the
                // persistent timeline; distant seek windows still use RAM reuse.
                if (start > data.coveredUntil) return;
                data.coveredUntil = Math.max(data.coveredUntil, start + bytes.length);
                parser.push(start, bytes);
                if (start === 0 && !data.origin && !originJob && bytes.length >= 188 * 10) {
                    originJob = store.probeOrigin(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)), store.bin)
                        .then(origin => { if (origin && data?.proof === bound) { data.origin = origin; dirty = true; } })
                        .catch(() => {}).finally(() => { originJob = null; void flush(); });
                }
                if (store.now() - lastSave >= 2000) void flush();
            },
            async close() { await originJob; await flush(); },
        };
    }
    prune() {
        for (const [key, value] of this.hot) if (this.now() - value.createdAt >= TTL) this.hot.delete(key);
        const run = async () => {
            await this.directory();
            for (const name of await fsp.readdir(this.root)) {
                const temporary = /^[a-f0-9]{64}\.[a-f0-9]{16}\.tmp$/.test(name);
                if (!temporary && !/^[a-f0-9]{64}\.json$/.test(name)) continue;
                const file = path.join(this.root, name), stat = await fsp.lstat(file);
                if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
                    && this.now() - stat.mtimeMs >= (temporary ? 60000 : TTL)) await fsp.unlink(file);
            }
        };
        this.io = this.io.then(run).catch(() => { this.stats.failures++; }); return this.io;
    }
    status() { return { protocol: 1, parserRevision: PARSER_REVISION, ...this.stats, ttlMs: TTL, maxFiles: MAX_FILES,
        maxBytes: MAX_FILES * MAX_FILE, maxPointsPerFile: MAX_POINTS, maxHotMetadataBytes: 32 * MAX_FILE, mediaBytesPersisted: 0,
        minIndexedPrerollSeconds: 2, maxIndexedPrerollSeconds: 30 }; }
}

function indexedTsInputUrl(inputUrl, point, size) {
    const url = new URL(inputUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.search || url.hash
        || !/^\/finite-mkv-seek\/[a-zA-Z0-9_-]{43}$/.test(url.pathname) || !validPoint(point, size)) return null;
    // FFmpeg's own subfile protocol translates virtual offsets to the exact
    // original bytes. The HTTP broker never lies about Content-Range/size.
    return `subfile,,start,${point.byteOffset},end,${size},,:${inputUrl}`;
}
module.exports = { FiniteTsSeekIndex, probeTsOrigin, indexedTsInputUrl, proofHash };
