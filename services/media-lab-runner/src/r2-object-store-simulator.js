'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_LAB_OBJECT_BYTES = 32 * 1024 * 1024;

class R2SimulatorError extends Error {
    constructor(code) {
        super(code);
        this.name = 'R2SimulatorError';
        this.code = code;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeKey(value) {
    const key = typeof value === 'string' ? value : '';
    if (
        !key
        || Buffer.byteLength(key, 'utf8') > 1024
        || key.startsWith('/')
        || key.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(key)
        || key.split('/').some((part) => !part || part === '.' || part === '..')
    ) throw new R2SimulatorError('R2_SIMULATOR_KEY_INVALID');
    return key;
}

function normalizeBody(value) {
    const body = Buffer.isBuffer(value)
        ? Buffer.from(value)
        : (typeof value === 'string' ? Buffer.from(value, 'utf8') : null);
    if (!body || body.length === 0 || body.length > MAX_LAB_OBJECT_BYTES) {
        throw new R2SimulatorError('R2_SIMULATOR_BODY_INVALID');
    }
    return body;
}

function normalizeMetadata(value) {
    if (value === undefined) return Object.freeze({});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new R2SimulatorError('R2_SIMULATOR_METADATA_INVALID');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new R2SimulatorError('R2_SIMULATOR_METADATA_INVALID');
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > 32) throw new R2SimulatorError('R2_SIMULATOR_METADATA_INVALID');
    const normalized = {};
    for (const [key, metadataValue] of entries) {
        if (
            !/^[a-z][a-z0-9-]{0,63}$/.test(key)
            || typeof metadataValue !== 'string'
            || Buffer.byteLength(metadataValue, 'utf8') > 1024
            || /[\u0000\r\n]/.test(metadataValue)
        ) throw new R2SimulatorError('R2_SIMULATOR_METADATA_INVALID');
        normalized[key] = metadataValue;
    }
    return Object.freeze(normalized);
}

class PrivateR2Simulator {
    #root;
    #initialized = false;
    #unavailable = false;
    #putFailures = new Set();
    #operationOrdinals = { put: 0, get: 0, head: 0, delete: 0 };
    #locks = new Map();
    #counters = {
        puts: 0,
        gets: 0,
        heads: 0,
        deletes: 0,
        idempotentPuts: 0,
        conflicts: 0,
        unavailable: 0,
    };

    constructor({ root, failPutOrdinals = [] }) {
        if (!root) throw new R2SimulatorError('R2_SIMULATOR_ROOT_REQUIRED');
        this.#root = path.resolve(root);
        if (!Array.isArray(failPutOrdinals) || failPutOrdinals.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
            throw new R2SimulatorError('R2_SIMULATOR_FAILURE_PLAN_INVALID');
        }
        this.#putFailures = new Set(failPutOrdinals);
    }

    setUnavailable(value) {
        this.#unavailable = value === true;
    }

    snapshot() {
        return Object.freeze({ ...this.#counters });
    }

    async #init() {
        if (this.#initialized) return;
        await fsp.mkdir(path.join(this.#root, 'objects'), { recursive: true, mode: 0o700 });
        await fsp.mkdir(path.join(this.#root, 'tmp'), { recursive: true, mode: 0o700 });
        this.#initialized = true;
    }

    #paths(key) {
        const digest = sha256(key);
        const shard = path.join(this.#root, 'objects', digest.slice(0, 2));
        return Object.freeze({
            shard,
            body: path.join(shard, `${digest}.body`),
            metadata: path.join(shard, `${digest}.json`),
        });
    }

    async #withKeyLock(key, task) {
        const previous = this.#locks.get(key) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.#locks.set(key, current);
        await previous;
        try {
            return await task();
        } finally {
            release();
            if (this.#locks.get(key) === current) this.#locks.delete(key);
        }
    }

    #begin(operation) {
        this.#operationOrdinals[operation] += 1;
        if (this.#unavailable || (operation === 'put' && this.#putFailures.delete(this.#operationOrdinals.put))) {
            this.#counters.unavailable += 1;
            throw new R2SimulatorError('R2_SIMULATOR_UNAVAILABLE');
        }
    }

    async #readRecord(key) {
        const paths = this.#paths(key);
        const raw = await fsp.readFile(paths.metadata, 'utf8').catch((error) => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (raw === null) return null;
        const metadata = JSON.parse(raw);
        if (
            metadata.key !== key
            || !Number.isSafeInteger(metadata.size)
            || metadata.size <= 0
            || !/^[a-f0-9]{64}$/.test(metadata.sha256)
        ) throw new R2SimulatorError('R2_SIMULATOR_OBJECT_CORRUPT');
        return Object.freeze({ paths, metadata });
    }

    async put(keyValue, bodyValue, { sha256: expectedSha256 = null, metadata = undefined } = {}) {
        const key = normalizeKey(keyValue);
        const body = normalizeBody(bodyValue);
        const digest = sha256(body);
        if (expectedSha256 !== null && expectedSha256 !== digest) {
            throw new R2SimulatorError('R2_SIMULATOR_CHECKSUM_MISMATCH');
        }
        const normalizedMetadata = normalizeMetadata(metadata);
        this.#begin('put');
        return this.#withKeyLock(key, async () => {
            await this.#init();
            const existing = await this.#readRecord(key);
            if (existing) {
                if (
                    existing.metadata.sha256 !== digest
                    || existing.metadata.size !== body.length
                    || JSON.stringify(existing.metadata.metadata) !== JSON.stringify(normalizedMetadata)
                ) {
                    this.#counters.conflicts += 1;
                    throw new R2SimulatorError('R2_SIMULATOR_IMMUTABLE_CONFLICT');
                }
                this.#counters.idempotentPuts += 1;
                return Object.freeze({ status: 'already-exists', key, sha256: digest, size: body.length });
            }
            const paths = this.#paths(key);
            await fsp.mkdir(paths.shard, { recursive: true, mode: 0o700 });
            const nonce = crypto.randomBytes(12).toString('hex');
            const tempBody = path.join(this.#root, 'tmp', `${nonce}.body`);
            const tempMetadata = path.join(this.#root, 'tmp', `${nonce}.json`);
            const record = {
                protocol: 1,
                key,
                size: body.length,
                sha256: digest,
                metadata: normalizedMetadata,
            };
            try {
                await fsp.writeFile(tempBody, body, { flag: 'wx', mode: 0o600 });
                await fsp.writeFile(tempMetadata, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
                await fsp.rename(tempBody, paths.body);
                try {
                    await fsp.rename(tempMetadata, paths.metadata);
                } catch (error) {
                    await fsp.rm(paths.body, { force: true });
                    throw error;
                }
            } finally {
                await Promise.all([
                    fsp.rm(tempBody, { force: true }),
                    fsp.rm(tempMetadata, { force: true }),
                ]);
            }
            this.#counters.puts += 1;
            return Object.freeze({ status: 'created', key, sha256: digest, size: body.length });
        });
    }

    async head(keyValue) {
        const key = normalizeKey(keyValue);
        this.#begin('head');
        await this.#init();
        this.#counters.heads += 1;
        const record = await this.#readRecord(key);
        if (!record) return null;
        return Object.freeze({
            key,
            size: record.metadata.size,
            sha256: record.metadata.sha256,
            metadata: Object.freeze({ ...record.metadata.metadata }),
        });
    }

    async get(keyValue) {
        const key = normalizeKey(keyValue);
        this.#begin('get');
        await this.#init();
        this.#counters.gets += 1;
        const record = await this.#readRecord(key);
        if (!record) return null;
        const body = await fsp.readFile(record.paths.body);
        if (body.length !== record.metadata.size || sha256(body) !== record.metadata.sha256) {
            throw new R2SimulatorError('R2_SIMULATOR_OBJECT_CORRUPT');
        }
        return Object.freeze({
            key,
            body,
            size: body.length,
            sha256: record.metadata.sha256,
            metadata: Object.freeze({ ...record.metadata.metadata }),
        });
    }

    async delete(keyValue) {
        const key = normalizeKey(keyValue);
        this.#begin('delete');
        return this.#withKeyLock(key, async () => {
            await this.#init();
            const record = await this.#readRecord(key);
            if (!record) return false;
            await fsp.rm(record.paths.metadata, { force: false });
            await fsp.rm(record.paths.body, { force: false });
            this.#counters.deletes += 1;
            return true;
        });
    }
}

module.exports = Object.freeze({
    PrivateR2Simulator,
    R2SimulatorError,
    normalizeKey,
    sha256,
});
