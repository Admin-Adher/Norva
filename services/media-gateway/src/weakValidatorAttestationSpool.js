'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { reserveSpoolDisk } = require('./spool-disk-budget');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ID_LENGTH = 128;

class WeakValidatorAttestationSpoolError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'WeakValidatorAttestationSpoolError';
        this.code = code;
        if (details && typeof details === 'object') this.details = details;
    }
}

function boundedPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, maximum);
}

function boundedNonNegativeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, maximum);
}

function normalizedExpectedBytes(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeSpoolId(value) {
    const text = String(value || '').trim();
    if (!text || text.length > MAX_ID_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(text)) {
        throw new WeakValidatorAttestationSpoolError(
            'INVALID_SPOOL_ID',
            'The weak-validator spool identity is invalid',
        );
    }
    return text;
}

async function availableBytes(root, statfs = null) {
    const probe = typeof statfs === 'function' ? statfs : (candidate) => fsp.statfs(candidate);
    const stats = await probe(root);
    if (stats && Number.isSafeInteger(stats.availableBytes) && stats.availableBytes >= 0) {
        return stats.availableBytes;
    }
    const blockSize = Number(stats && (stats.bsize ?? stats.frsize));
    const availableBlocks = Number(stats && (stats.bavail ?? stats.bfree));
    const bytes = blockSize * availableBlocks;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new WeakValidatorAttestationSpoolError(
            'SPOOL_SPACE_UNKNOWN',
            'Available spool space cannot be measured',
        );
    }
    return bytes;
}

async function syncDirectory(directory) {
    let handle;
    try {
        handle = await fsp.open(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
        await handle.sync();
    } catch (_) {
        // Directory fsync is unavailable on a few supported filesystems (and
        // on Windows). The file fsync and atomic rename remain mandatory.
    } finally {
        await handle?.close().catch(() => {});
    }
}

/**
 * Creates the pilot-only, single-response spool used for weak/absent provider
 * validators. The caller appends bytes from the authoritative provider body;
 * this helper never opens a URL or performs a second GET. A final spool is
 * visible only after fsync + atomic rename and can be fed to a local HLS pass.
 */
async function createWeakValidatorAttestationSpool(options = {}) {
    if (typeof options.root !== 'string' || !options.root.trim()) {
        throw new WeakValidatorAttestationSpoolError('INVALID_SPOOL_ROOT', 'An explicit private spool root is required');
    }
    const root = path.resolve(options.root);
    const id = safeSpoolId(options.id || crypto.randomUUID());
    const expectedBytes = normalizedExpectedBytes(options.expectedBytes);
    const maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    const minFreeBytes = boundedNonNegativeInteger(options.minFreeBytes, DEFAULT_MIN_FREE_BYTES);
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const statfs = options.statfs;
    const startedAt = Number(now());

    if (expectedBytes && expectedBytes > maxBytes) {
        throw new WeakValidatorAttestationSpoolError(
            'SPOOL_QUOTA_EXCEEDED',
            'The provider object exceeds the weak-validator spool quota',
            { expectedBytes, maxBytes },
        );
    }
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await fsp.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new WeakValidatorAttestationSpoolError('UNSAFE_SPOOL_PATH', 'The spool root must be a real private directory');
    }
    await fsp.chmod(root, 0o700);
    const rootReal = await fsp.realpath(root);
    const freeBytes = await availableBytes(rootReal, statfs);
    const requiredBytes = (expectedBytes || maxBytes) + minFreeBytes;
    if (freeBytes < requiredBytes) {
        throw new WeakValidatorAttestationSpoolError(
            'SPOOL_DISK_RESERVE',
            'The weak-validator spool would violate the free-space reserve',
            { freeBytes, requiredBytes },
        );
    }

    const nonce = crypto.randomBytes(12).toString('hex');
    const tempPath = path.join(rootReal, `spool-${id}-${nonce}.part`);
    const finalPath = path.join(rootReal, `spool-${id}-${nonce}.bin`);
    const reservation = options.totalMaxBytes ? await reserveSpoolDisk({ root: rootReal,
        name: `spool-${id}-${nonce}`, bytes: expectedBytes || maxBytes,
        maxBytes: options.totalMaxBytes, minFreeBytes, ...(statfs ? { statfs } : {}) }) : null;
    let handle;
    try { handle = await fsp.open(
        tempPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
    ); } catch (error) { await reservation?.release(); throw error; }
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    let closed = false;
    let finalized = false;
    let aborted = false;
    let finalizedResult = null;
    let finalizedAt = null;
    let abortReason = null;
    let lastDiskCheckBytes = -4 * 1024 * 1024;

    const closeHandle = async () => {
        if (closed) return;
        closed = true;
        await handle.close();
    };
    const removePath = async (target) => {
        await fsp.rm(target, { force: true }).catch(() => {});
    };
    const rejectState = () => {
        throw new WeakValidatorAttestationSpoolError(
            'SPOOL_NOT_WRITABLE',
            'The weak-validator spool is no longer writable',
        );
    };

    return {
        tempPath,
        get finalPath() { return finalized ? finalPath : null; },
        get bytes() { return bytes; },
        get expectedBytes() { return expectedBytes; },
        get finalized() { return finalized; },
        get aborted() { return aborted; },
        snapshot() {
            const nowMs = Number(now());
            return {
                protocol: 1,
                state: finalized ? 'finalized' : (aborted ? 'aborted' : 'writing'),
                bytesWritten: bytes,
                expectedBytes,
                maxBytes,
                startedAtMs: startedAt,
                durationMs: finalizedAt === null
                    ? Math.max(0, nowMs - startedAt)
                    : Math.max(0, finalizedAt - startedAt),
                ...(finalizedAt === null ? {} : { finalizedAtMs: finalizedAt }),
                ...(abortReason ? { abortReason } : {}),
            };
        },
        async append(chunk) {
            if (finalized || aborted || closed) rejectState();
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
            if (!value.length) return;
            if (bytes + value.length > maxBytes || (expectedBytes && bytes + value.length > expectedBytes)) {
                aborted = true;
                abortReason = 'quota';
                await closeHandle().catch(() => {});
                await removePath(tempPath);
                await reservation?.release();
                throw new WeakValidatorAttestationSpoolError(
                    'SPOOL_QUOTA_EXCEEDED',
                    'The provider body exceeded the weak-validator spool bound',
                    { bytes, chunkBytes: value.length, expectedBytes, maxBytes },
                );
            }
            try {
                if (reservation && bytes - lastDiskCheckBytes >= 4 * 1024 * 1024) {
                    await reservation.checkFreeSpace(); lastDiskCheckBytes = bytes;
                }
                let written = 0;
                while (written < value.length) {
                    const result = await handle.write(value, written, value.length - written);
                    if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
                        throw new Error('spool-write-no-progress');
                    }
                    written += result.bytesWritten;
                }
                digest.update(value);
                bytes += value.length;
            } catch (error) {
                aborted = true;
                abortReason = 'write-failed';
                await closeHandle().catch(() => {});
                await removePath(tempPath);
                await reservation?.release();
                throw new WeakValidatorAttestationSpoolError(
                    'SPOOL_WRITE_FAILED',
                    'The weak-validator spool could not be written',
                    { cause: error?.code || error?.name || 'write-error' },
                );
            }
        },
        async finalize() {
            if (finalized) {
                return { ...finalizedResult };
            }
            if (aborted || closed) rejectState();
            if (!bytes || (expectedBytes && bytes !== expectedBytes)) {
                aborted = true;
                abortReason = 'size-mismatch';
                await closeHandle().catch(() => {});
                await removePath(tempPath);
                await reservation?.release();
                throw new WeakValidatorAttestationSpoolError(
                    'SPOOL_SIZE_MISMATCH',
                    'The weak-validator spool did not reach its exact expected size',
                    { bytes, expectedBytes },
                );
            }
            const contentSha256 = digest.digest('hex');
            try {
                await handle.sync();
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size !== bytes) {
                    throw new WeakValidatorAttestationSpoolError(
                        'SPOOL_SIZE_MISMATCH',
                        'The finalized weak-validator spool size is not exact',
                        { bytes, statSize: stat.size },
                    );
                }
                await closeHandle();
                await fsp.rename(tempPath, finalPath);
                await syncDirectory(rootReal);
                finalized = true;
                finalizedAt = Number(now());
                finalizedResult = {
                    path: finalPath,
                    bytes,
                    contentSha256,
                    durationMs: Math.max(0, Number(now()) - startedAt),
                };
                return { ...finalizedResult };
            } catch (error) {
                aborted = true;
                abortReason = 'finalize-failed';
                await closeHandle().catch(() => {});
                await removePath(tempPath);
                await removePath(finalPath);
                await reservation?.release();
                if (error instanceof WeakValidatorAttestationSpoolError) throw error;
                throw new WeakValidatorAttestationSpoolError(
                    'SPOOL_FINALIZE_FAILED',
                    'The weak-validator spool could not be finalized atomically',
                    { cause: error?.code || error?.name || 'finalize-error' },
                );
            }
        },
        async cleanup() {
            await closeHandle().catch(() => {});
            await removePath(tempPath);
            await removePath(finalPath);
            await reservation?.release();
            finalized = false;
        },
        async abort(reason = 'aborted') {
            if (finalized || aborted) return;
            aborted = true;
            abortReason = String(reason || 'aborted').slice(0, 96);
            await closeHandle().catch(() => {});
            await removePath(tempPath);
            await removePath(finalPath);
            await reservation?.release();
            return abortReason;
        },
    };
}

module.exports = {
    WeakValidatorAttestationSpoolError,
    createWeakValidatorAttestationSpool,
};
