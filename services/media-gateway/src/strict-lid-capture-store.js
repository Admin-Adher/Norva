'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeStrictLidWindowBinding } = require('./strict-lid-window-checkpoint');
const { parsePcm16Wav } = require('./strict-lid-audio-evidence');
const { planStrictSpeechWindow } = require('./strict-lid-speech-window');

const MAGIC = Buffer.from('NLIDCAP1');
const MAX_RECORD_BYTES = 3 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const RECORD = /^[a-f0-9]{64}\.bin$/;
const PART = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.part$/;
const WORK = /^compute-[a-f0-9-]{36}$/;
const WORK_FILE = /^(?:raw\.wav|raw\.wav\.selected\.wav|\.norva-strict-lid-[a-f0-9-]{36}-[0-9]+\.txt)$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), { code });

function captureBinding(input) {
    const window = normalizeStrictLidWindowBinding(input);
    if (window.selectionProtocol !== 1 || !HEX.test(input.sourceUrlHash || '')) throw error('LID_CAPTURE_BINDING_INVALID');
    return Object.freeze({ ...window, captureProtocol: 1, sourceUrlHash: input.sourceUrlHash });
}

// One OS-owned writer per volume. Node death closes stdin and releases flock;
// no timestamp, PID-file heuristic or lease expiry can evict a living writer.
// The helper has a fixed command and no provider/network capability. Production
// is Linux; Windows unit tests inject an explicit synthetic ownership fixture.
async function acquireCaptureStoreOwnership(lockPath) {
    if (process.platform !== 'linux') throw error('LID_CAPTURE_STORE_PLATFORM_UNSUPPORTED');
    const handle = await fsp.open(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    const stat = await handle.stat();
    await handle.close();
    if (!stat.isFile() || stat.nlink !== 1) throw error('LID_CAPTURE_STORE_LOCK_INVALID');
    const child = spawn('flock', ['-n', '-E', '75', lockPath, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
    let live = true;
    const closed = new Promise(resolve => child.once('close', () => { live = false; resolve(); }));
    child.once('error', () => { live = false; });
    child.stdin.on('error', () => {});
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(error('LID_CAPTURE_STORE_LOCK_TIMEOUT')); }, 3000);
            const fail = () => { clearTimeout(timeout); reject(error('LID_CAPTURE_STORE_LOCK_BUSY')); };
            child.once('error', fail); child.once('close', fail);
            child.stdout.once('data', bytes => {
                clearTimeout(timeout);
                child.off('error', fail); child.off('close', fail);
                if (bytes.toString() !== 'ready\n') return reject(error('LID_CAPTURE_STORE_LOCK_INVALID'));
                resolve();
            });
        });
    } catch (e) { child.stdin.destroy(); throw e; }
    return { isHeld: () => live, close: async () => { child.stdin.end(); await closed; } };
}

class StrictLidCaptureStore {
    constructor({ root, secret, maxBytes = 64 * 1024 * 1024, maxEntries = 32, ttlMs = 30 * 60_000,
        now = Date.now, acquireOwnership = acquireCaptureStoreOwnership } = {}) {
        if (!path.isAbsolute(root || '') || path.parse(root).root === path.resolve(root)
            || Buffer.byteLength(secret || '') < 16 || !Number.isSafeInteger(maxBytes) || maxBytes < MAX_RECORD_BYTES
            || maxBytes > 256 * 1024 * 1024 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 128
            || !Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 2 * 60 * 60_000) {
            throw error('LID_CAPTURE_STORE_CONFIG_INVALID');
        }
        this.root = path.resolve(root);
        this.key = Buffer.from(crypto.hkdfSync('sha256', secret, 'norva-lid-capture-v1', 'private-working-buffer', 32));
        this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.ttlMs = ttlMs;
        this.now = now; this.acquireOwnership = acquireOwnership; this.owner = null;
        this.serial = Promise.resolve(); this.entries = new Map(); this.bytes = 0;
        this.reservations = new Map(); this.computations = new Set();
    }

    async open() {
        if (this.owner) throw error('LID_CAPTURE_STORE_ALREADY_OPEN');
        await fsp.mkdir(this.root, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        const stat = await fsp.lstat(this.root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fsp.realpath(this.root)) !== this.root
            || (process.platform === 'linux' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
            throw error('LID_CAPTURE_STORE_NOT_PRIVATE');
        }
        this.owner = await this.acquireOwnership(path.join(this.root, 'owner.lock'));
        this.entries.clear(); this.bytes = 0; this.reservations.clear();
        try {
            for (const name of await fsp.readdir(this.root)) {
                if (name === 'owner.lock') continue;
                if (WORK.test(name)) { await this.removeWorkspace(name); continue; }
                if (PART.test(name)) { await this.removeFile(name); continue; }
                if (!RECORD.test(name)) throw error('LID_CAPTURE_STORE_FOREIGN_FILE');
                const record = await this.readRecord(name);
                if (!record || record.expiresAt <= this.now()) { await this.removeFile(name); continue; }
                const size = (await fsp.lstat(path.join(this.root, name))).size;
                this.entries.set(name, { size, expiresAt: record.expiresAt }); this.bytes += size;
            }
            if (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) throw error('LID_CAPTURE_STORE_OVER_CAPACITY');
            return this;
        } catch (e) { await this.owner.close(); this.owner = null; throw e; }
    }

    withLock(callback) {
        const task = this.serial.then(async () => {
            if (!this.owner?.isHeld()) throw error('LID_CAPTURE_STORE_OWNERSHIP_LOST');
            return await callback();
        });
        this.serial = task.catch(() => {});
        return task;
    }

    name(binding) { return crypto.createHmac('sha256', this.key).update(JSON.stringify(captureBinding(binding))).digest('hex') + '.bin'; }

    // Reserve worst-case encrypted bytes BEFORE a provider request. Duplicate
    // captures and a full disk budget cannot waste a mono-account connection.
    reserve(binding) {
        return this.withLock(async () => {
            await this.prune();
            const name = this.name(binding);
            if (this.entries.has(name)) return { cached: true, release: async () => {} };
            if (this.reservations.has(name)) throw error('LID_CAPTURE_ALREADY_RUNNING');
            if (this.entries.size + this.reservations.size >= this.maxEntries
                || this.bytes + (this.reservations.size + 1) * MAX_RECORD_BYTES > this.maxBytes) {
                throw error('LID_CAPTURE_STORE_FULL');
            }
            const token = crypto.randomUUID(); this.reservations.set(name, token);
            return Object.freeze({ cached: false, token, release: () => this.withLock(() => {
                if (this.reservations.get(name) === token) this.reservations.delete(name);
            }) });
        });
    }

    async removeWorkspace(name) {
        if (!WORK.test(name)) throw error('LID_CAPTURE_STORE_PATH_INVALID');
        const target = path.join(this.root, name);
        const stat = await fsp.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()
            || (process.platform === 'linux' && (stat.mode & 0o077) !== 0)) throw error('LID_CAPTURE_STORE_FILE_INVALID');
        const names = await fsp.readdir(target);
        if (names.length > 8 || names.some(n => !WORK_FILE.test(n))) throw error('LID_CAPTURE_STORE_FOREIGN_FILE');
        // Validate the ENTIRE bounded manifest before unlinking any file. Never
        // recurse, follow symlinks, or remove an unrecognized user's artifact.
        for (const n of names) {
            const child = await fsp.lstat(path.join(target, n));
            if (!child.isFile() || child.isSymbolicLink() || child.nlink !== 1) throw error('LID_CAPTURE_STORE_FILE_INVALID');
        }
        for (const n of names) await fsp.unlink(path.join(target, n));
        await fsp.rmdir(target);
    }

    async withPlaintext(binding, callback) {
        const record = await this.get(binding);
        if (!record) throw error('LID_CAPTURE_NOT_FOUND');
        return this.withWorkspace(async wavPath => {
            if (record.expiresAt <= this.now()) throw error('LID_CAPTURE_NOT_FOUND');
            await fsp.writeFile(wavPath, record.wav, { flag: 'wx', mode: 0o600 });
            return callback(wavPath);
        });
    }

    async withWorkspace(callback) {
        const work = await this.withLock(async () => {
            if (this.computations.size >= 2) throw error('LID_CAPTURE_COMPUTE_BUSY');
            const name = 'compute-' + crypto.randomUUID();
            await fsp.mkdir(path.join(this.root, name), { mode: 0o700 });
            this.computations.add(name);
            return { name, wavPath: path.join(this.root, name, 'raw.wav') };
        });
        try {
            if (!this.owner?.isHeld()) throw error('LID_CAPTURE_STORE_OWNERSHIP_LOST');
            return await callback(work.wavPath);
        } finally {
            // The callback must await child close. A restart has the exclusive
            // OS lock and scrubs only these known temporary inference files.
            try { await this.removeWorkspace(work.name); }
            finally { this.computations.delete(work.name); }
        }
    }

    async removeFile(name) {
        if (!RECORD.test(name) && !PART.test(name)) throw error('LID_CAPTURE_STORE_PATH_INVALID');
        const target = path.join(this.root, name);
        const stat = await fsp.lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (!stat) return;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw error('LID_CAPTURE_STORE_FILE_INVALID');
        await fsp.unlink(target);
        this.bytes -= this.entries.get(name)?.size || 0;
        this.entries.delete(name);
    }

    async readRecord(name) {
        if (!RECORD.test(name)) throw error('LID_CAPTURE_STORE_PATH_INVALID');
        const handle = await fsp.open(path.join(this.root, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let encrypted;
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size < 36 || stat.size > MAX_RECORD_BYTES
                || (process.platform === 'linux' && (stat.mode & 0o077) !== 0)) throw error('LID_CAPTURE_STORE_FILE_INVALID');
            encrypted = await handle.readFile();
        } finally { await handle.close(); }
        try {
            if (!encrypted.subarray(0, 8).equals(MAGIC)) return null;
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(8, 20));
            decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(encrypted.subarray(20, 36));
            const record = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(36)), decipher.final()]).toString());
            const binding = captureBinding(record.binding);
            if (this.name(binding) !== name || record.providerDrained !== true || record.protocol !== 1
                || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt)
                || record.createdAt > this.now() || record.expiresAt <= record.createdAt
                || record.expiresAt - record.createdAt > this.ttlMs || typeof record.wav !== 'string') return null;
            const wav = Buffer.from(record.wav, 'base64');
            const parsed = parsePcm16Wav(wav);
            const plan = planStrictSpeechWindow(binding.durationSeconds, binding.windowOrdinal);
            if (sha(wav) !== record.sha256 || parsed.durationSeconds * 1000 !== plan.searchDurationMilliseconds) return null;
            return { ...record, binding, wav };
        } catch (_) { return null; }
    }

    async prune() {
        for (const [name, entry] of this.entries) if (entry.expiresAt <= this.now()) await this.removeFile(name);
    }

    get(binding) {
        return this.withLock(async () => {
            await this.prune();
            const name = this.name(binding);
            if (!this.entries.has(name)) return null;
            const record = await this.readRecord(name);
            if (!record) { await this.removeFile(name); return null; }
            return { wav: record.wav, expiresAt: record.expiresAt, sha256: record.sha256 };
        });
    }

    put(binding, wav, attestation, reservationToken = null) {
        return this.withLock(async () => {
            if (attestation?.providerDrained !== true || attestation?.providerDrainProtocol !== 1) throw error('LID_CAPTURE_DRAIN_REQUIRED');
            const normalized = captureBinding(binding);
            const plan = planStrictSpeechWindow(normalized.durationSeconds, normalized.windowOrdinal);
            const parsed = parsePcm16Wav(wav);
            if (parsed.durationSeconds * 1000 !== plan.searchDurationMilliseconds) throw error('LID_CAPTURE_DURATION_INVALID');
            await this.prune();
            const name = this.name(normalized);
            if (reservationToken !== null && this.reservations.get(name) !== reservationToken) throw error('LID_CAPTURE_RESERVATION_LOST');
            if (this.entries.has(name)) {
                const prior = await this.readRecord(name);
                if (prior) return { reused: true, expiresAt: prior.expiresAt, sha256: prior.sha256 };
                await this.removeFile(name);
            }
            const createdAt = this.now(); const expiresAt = createdAt + this.ttlMs;
            const record = { protocol: 1, binding: normalized, providerDrained: true, createdAt, expiresAt,
                sha256: sha(wav), wav: wav.toString('base64') };
            const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
            cipher.setAAD(Buffer.from(name));
            const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
            const encrypted = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
            const otherReservations = this.reservations.size - (this.reservations.get(name) === reservationToken ? 1 : 0);
            if (this.reservations.has(name) && this.reservations.get(name) !== reservationToken) throw error('LID_CAPTURE_ALREADY_RUNNING');
            if (encrypted.length > MAX_RECORD_BYTES || this.bytes + encrypted.length + otherReservations * MAX_RECORD_BYTES > this.maxBytes
                || this.entries.size + otherReservations >= this.maxEntries) throw error('LID_CAPTURE_STORE_FULL');
            const temporary = name.slice(0, -4) + '.' + crypto.randomUUID() + '.part';
            try {
                const handle = await fsp.open(path.join(this.root, temporary), 'wx', 0o600);
                try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
                await fsp.rename(path.join(this.root, temporary), path.join(this.root, name));
                // fsync the directory on Linux so a completed response survives
                // restart after rename. Windows unit fixtures cannot fsync dirs.
                if (process.platform === 'linux') {
                    const directory = await fsp.open(this.root, 'r');
                    try { await directory.sync(); } finally { await directory.close(); }
                }
                this.entries.set(name, { size: encrypted.length, expiresAt }); this.bytes += encrypted.length;
                this.reservations.delete(name);
                return { reused: false, expiresAt, sha256: record.sha256 };
            } catch (e) {
                await this.removeFile(temporary);
                // If rename succeeded but directory sync failed, stop all new
                // admissions until restart rebuilds the exact disk inventory.
                if (await fsp.lstat(path.join(this.root, name)).catch(() => null)) await this.owner.close();
                throw e;
            }
        });
    }

    remove(binding) { return this.withLock(() => this.removeFile(this.name(binding))); }
    sweep() { return this.withLock(() => this.prune()); }
    snapshot() { return { protocol: 1, ready: this.owner?.isHeld() === true,
        entries: this.entries.size, bytes: this.bytes, reservations: this.reservations.size, computations: this.computations.size,
        maxEntries: this.maxEntries, maxBytes: this.maxBytes, ttlMs: this.ttlMs }; }
    async close() {
        await this.serial;
        if (this.computations.size || this.reservations.size) throw error('LID_CAPTURE_STORE_IN_USE');
        if (this.owner) await this.owner.close(); this.owner = null;
    }
}

module.exports = { StrictLidCaptureStore, captureBinding, acquireCaptureStoreOwnership };
