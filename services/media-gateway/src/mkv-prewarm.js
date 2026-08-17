'use strict';

// Phase 3A building block only. Each invocation below owns one explicit
// provider GET attempt. There is intentionally no fetch implementation, retry,
// HEAD, or reconnect loop in this module: integration must inject the existing
// single-lane provider opener and call again for a later resume attempt.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const METADATA_SCHEMA = 1;
const COMPLETE_SCHEMA = 1;
const DEFAULT_MAX_SOURCE_BYTES = 128 * 1024 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

class MkvPrewarmError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'MkvPrewarmError';
        this.code = code;
        this.terminal = options.terminal === true;
        this.preempted = options.preempted === true;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requiredBoundedString(value, field, maxLength = 4096) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
        throw new MkvPrewarmError('INVALID_PREWARM_IDENTITY', `${field} is invalid`, { terminal: true });
    }
    return value;
}

function normalizeIdentity(identity) {
    const fields = ['tenantId', 'providerId', 'itemId', 'variantId', 'initialUrl', 'profileBuild'];
    if (!exactKeys(identity, fields)) {
        throw new MkvPrewarmError('INVALID_PREWARM_IDENTITY', 'prewarm identity has an unexpected shape', { terminal: true });
    }
    const initialUrl = requiredBoundedString(identity.initialUrl, 'initialUrl', 16_384);
    let parsed;
    try { parsed = new URL(initialUrl); } catch (_) {
        throw new MkvPrewarmError('INVALID_PREWARM_IDENTITY', 'initialUrl is invalid', { terminal: true });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new MkvPrewarmError('INVALID_PREWARM_IDENTITY', 'initialUrl protocol is invalid', { terminal: true });
    }
    return {
        tenantId: requiredBoundedString(identity.tenantId, 'tenantId', 512),
        providerId: requiredBoundedString(identity.providerId, 'providerId', 512),
        itemId: requiredBoundedString(identity.itemId, 'itemId', 512),
        variantId: identity.variantId === null ? null : requiredBoundedString(identity.variantId, 'variantId', 512),
        initialUrl,
        profileBuild: requiredBoundedString(identity.profileBuild, 'profileBuild', 512),
    };
}

function derivePrewarmSpoolKey(identity) {
    const normalized = normalizeIdentity(identity);
    const binding = {
        schema: 1,
        tenant: sha256(`tenant\0${normalized.tenantId}`),
        provider: sha256(`provider\0${normalized.providerId}`),
        item: sha256(`item\0${normalized.itemId}`),
        variant: sha256(`variant\0${normalized.variantId === null ? '<null>' : normalized.variantId}`),
        initialUrl: sha256(`initial-url\0${normalized.initialUrl}`),
        profileBuild: sha256(`profile-build\0${normalized.profileBuild}`),
    };
    return sha256(JSON.stringify(binding));
}

function derivePrewarmLaneKey(providerIdentity) {
    return sha256(`provider-lane\0${requiredBoundedString(providerIdentity, 'providerIdentity', 4096)}`);
}

function strongEtag(value) {
    const etag = typeof value === 'string' ? value.trim() : '';
    if (!/^"[^"\r\n]*"$/.test(etag) || /^W\//i.test(etag)) return '';
    return etag;
}

function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
    const expected = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === expected) {
            return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
        }
    }
    return '';
}

function parseStrictContentRange(value) {
    const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(String(value || '').trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total || total <= 0) return null;
    return { start, end, total, length: end - start + 1 };
}

function responseEffectiveUrl(response) {
    const candidate = typeof response.url === 'string' ? response.url : '';
    let parsed;
    try { parsed = new URL(candidate); } catch (_) {
        throw new MkvPrewarmError('INVALID_EFFECTIVE_URL', 'provider response is missing a valid effective URL', { terminal: true });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new MkvPrewarmError('INVALID_EFFECTIVE_URL', 'provider effective URL protocol is invalid', { terminal: true });
    }
    return candidate;
}

function strictPositiveInteger(value, fallback, field) {
    const candidate = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
        throw new MkvPrewarmError('INVALID_PREWARM_CONFIG', `${field} is invalid`, { terminal: true });
    }
    return candidate;
}

async function ensurePrivateDirectory(directory) {
    await fsp.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new MkvPrewarmError('UNSAFE_SPOOL_PATH', 'spool directory must be a private real directory', { terminal: true });
    }
    await fsp.chmod(directory, PRIVATE_DIRECTORY_MODE);
    return fsp.realpath(directory);
}

function assertInsideRoot(rootReal, candidate) {
    const relative = path.relative(rootReal, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new MkvPrewarmError('UNSAFE_SPOOL_PATH', 'spool path escaped its private root', { terminal: true });
    }
}

async function ensureSafeEntryDirectory(rootReal, spoolKey) {
    const entries = path.join(rootReal, 'entries');
    await ensurePrivateDirectory(entries);
    const shard = path.join(entries, spoolKey.slice(0, 2));
    await ensurePrivateDirectory(shard);
    const entry = path.join(shard, spoolKey);
    await ensurePrivateDirectory(entry);
    assertInsideRoot(rootReal, entry);
    const entryReal = await fsp.realpath(entry);
    assertInsideRoot(rootReal, entryReal);
    return entryReal;
}

async function optionalLstat(filePath) {
    try { return await fsp.lstat(filePath); } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
    }
}

async function readExactJson(filePath, keys, code) {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new MkvPrewarmError('UNSAFE_SPOOL_PATH', 'spool metadata is not a regular file', { terminal: true });
    }
    let parsed;
    try { parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')); } catch (error) {
        throw new MkvPrewarmError(code, 'spool metadata is corrupt', { terminal: true, cause: error });
    }
    if (!exactKeys(parsed, keys)) {
        throw new MkvPrewarmError(code, 'spool metadata has an unexpected shape', { terminal: true });
    }
    return parsed;
}

async function writeNewJsonDurably(filePath, payload) {
    const handle = await fsp.open(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE_MODE);
    try {
        await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function combineSignals(signals) {
    const active = signals.filter((signal) => signal && typeof signal.addEventListener === 'function');
    if (active.length === 0) return undefined;
    if (active.length === 1) return active[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of active) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
}

class PrewarmLaneCoordinator {
    constructor() {
        this.background = new Map();
        this.viewerReservations = new Map();
    }

    beginBackground(laneKey, externalSignal) {
        const key = requiredBoundedString(laneKey, 'laneKey', 512);
        if ((this.viewerReservations.get(key) || 0) > 0) {
            throw new MkvPrewarmError('PREWARM_VIEWER_ACTIVE', 'viewer playback owns this provider lane');
        }
        if (this.background.has(key)) {
            throw new MkvPrewarmError('PREWARM_LANE_OCCUPIED', 'a prewarm attempt already owns this provider lane');
        }
        const controller = new AbortController();
        let resolveDrained;
        const drained = new Promise((resolve) => { resolveDrained = resolve; });
        const entry = { controller, drained, resolveDrained, finished: false };
        this.background.set(key, entry);
        return {
            signal: combineSignals([controller.signal, externalSignal]),
            finish: () => {
                if (entry.finished) return;
                entry.finished = true;
                if (this.background.get(key) === entry) this.background.delete(key);
                resolveDrained();
            },
        };
    }

    async drainForViewer(laneKey, reason = 'viewer') {
        const key = requiredBoundedString(laneKey, 'laneKey', 512);
        const entry = this.background.get(key);
        if (!entry) return { preempted: false, reason };
        entry.controller.abort(new MkvPrewarmError('PREWARM_PREEMPTED', 'prewarm yielded to viewer playback', { preempted: true }));
        await entry.drained;
        return { preempted: true, reason };
    }

    async beginViewer(laneKey, reason = 'viewer') {
        const key = requiredBoundedString(laneKey, 'laneKey', 512);
        this.viewerReservations.set(key, (this.viewerReservations.get(key) || 0) + 1);
        try {
            await this.drainForViewer(key, reason);
        } catch (error) {
            const remaining = Math.max(0, (this.viewerReservations.get(key) || 1) - 1);
            if (remaining === 0) this.viewerReservations.delete(key);
            else this.viewerReservations.set(key, remaining);
            throw error;
        }
        let finished = false;
        return {
            finish: () => {
                if (finished) return;
                finished = true;
                const remaining = Math.max(0, (this.viewerReservations.get(key) || 1) - 1);
                if (remaining === 0) this.viewerReservations.delete(key);
                else this.viewerReservations.set(key, remaining);
            },
        };
    }

    async runViewer(laneKey, openViewer, reason = 'viewer') {
        if (typeof openViewer !== 'function') throw new TypeError('openViewer must be a function');
        const lease = await this.beginViewer(laneKey, reason);
        try { return await openViewer(); } finally { lease.finish(); }
    }
}

function validateMetadata(metadata, spoolKey, normalizedIdentity) {
    if (metadata.schema !== METADATA_SCHEMA
        || metadata.spoolKey !== spoolKey
        || metadata.initialUrlHash !== sha256(normalizedIdentity.initialUrl)
        || metadata.profileBuildHash !== sha256(normalizedIdentity.profileBuild)
        || !/^[0-9a-f]{64}$/.test(metadata.effectiveUrlHash)
        || !/^[0-9a-f]{64}$/.test(metadata.strongEtagHash)
        || metadata.strongEtagHash !== sha256(metadata.strongEtag)
        || !strongEtag(metadata.strongEtag)
        || !Number.isSafeInteger(metadata.totalBytes)
        || metadata.totalBytes <= 0
        || !Number.isSafeInteger(metadata.createdAtMs)
        || metadata.createdAtMs <= 0) {
        throw new MkvPrewarmError('SPOOL_BINDING_MISMATCH', 'spool binding metadata is invalid', { terminal: true });
    }
}

async function cancelBody(body) {
    if (!body) return;
    if (typeof body.cancel === 'function') {
        try { await body.cancel(); } catch (_) { /* best effort: the lane still drains in finally */ }
        return;
    }
    if (typeof body.destroy === 'function') {
        if (body.destroyed || body.closed) return;
        const drained = new Promise((resolve) => {
            const done = () => resolve();
            body.once('close', done);
            body.once('end', done);
            body.once('error', done);
        });
        body.destroy();
        await drained;
    }
}

async function writeAll(handle, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
        const result = await handle.write(buffer, offset, buffer.length - offset);
        if (!result || result.bytesWritten <= 0) {
            throw new MkvPrewarmError('SPOOL_WRITE_FAILED', 'source spool write made no progress', { terminal: true });
        }
        offset += result.bytesWritten;
    }
}

function preemptedError(signal, error) {
    if (signal && signal.aborted) {
        return new MkvPrewarmError('PREWARM_PREEMPTED', 'prewarm yielded before completing the source spool', {
            cause: error,
            preempted: true,
        });
    }
    return null;
}

async function runMkvPrewarmAttempt(options) {
    if (!options || typeof options !== 'object') throw new TypeError('options are required');
    const normalizedIdentity = normalizeIdentity(options.identity);
    const rootReal = await ensurePrivateDirectory(path.resolve(requiredBoundedString(options.spoolRoot, 'spoolRoot', 16_384)));
    const spoolKey = derivePrewarmSpoolKey(normalizedIdentity);
    const entryDirectory = await ensureSafeEntryDirectory(rootReal, spoolKey);
    const metadataPath = path.join(entryDirectory, 'source.meta.json');
    const sourcePath = path.join(entryDirectory, 'source.mkv');
    const completePath = path.join(entryDirectory, 'source.complete.json');
    const lockPath = path.join(entryDirectory, 'attempt.lock');
    const maxSourceBytes = strictPositiveInteger(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, 'maxSourceBytes');
    if (typeof options.openProviderGet !== 'function') throw new TypeError('openProviderGet must be a function');
    if (typeof options.onComplete !== 'function') throw new TypeError('onComplete must be a function');
    if (!(options.coordinator instanceof PrewarmLaneCoordinator)) {
        throw new MkvPrewarmError('PREWARM_COORDINATOR_REQUIRED', 'an explicit PrewarmLaneCoordinator is required', { terminal: true });
    }
    const laneKey = requiredBoundedString(options.laneKey, 'laneKey', 512);

    let lockHandle;
    try {
        lockHandle = await fsp.open(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE_MODE);
    } catch (error) {
        if (error && error.code === 'EEXIST') {
            throw new MkvPrewarmError('PREWARM_ATTEMPT_IN_PROGRESS', 'this source spool already has an active or unreconciled attempt');
        }
        throw error;
    }
    let laneLease;
    let responseBody;
    try {
        const metadataStat = await optionalLstat(metadataPath);
        const sourceStat = await optionalLstat(sourcePath);
        const completeStat = await optionalLstat(completePath);
        if ([metadataStat, sourceStat, completeStat].some((stat) => stat && (stat.isSymbolicLink() || !stat.isFile()))) {
            throw new MkvPrewarmError('UNSAFE_SPOOL_PATH', 'spool files must be regular non-symlink files', { terminal: true });
        }
        if (completeStat) {
            if (!metadataStat || !sourceStat) {
                throw new MkvPrewarmError('CORRUPT_COMPLETE_SPOOL', 'complete marker has no bound source', { terminal: true });
            }
            const metadata = await readExactJson(metadataPath,
                ['schema', 'spoolKey', 'initialUrlHash', 'effectiveUrlHash', 'strongEtag', 'strongEtagHash', 'profileBuildHash', 'totalBytes', 'createdAtMs'],
                'CORRUPT_SPOOL_METADATA');
            validateMetadata(metadata, spoolKey, normalizedIdentity);
            const complete = await readExactJson(completePath,
                ['schema', 'spoolKey', 'totalBytes', 'completedAtMs'],
                'CORRUPT_COMPLETE_SPOOL');
            if (complete.schema !== COMPLETE_SCHEMA || complete.spoolKey !== spoolKey
                || complete.totalBytes !== metadata.totalBytes || sourceStat.size !== metadata.totalBytes) {
                throw new MkvPrewarmError('CORRUPT_COMPLETE_SPOOL', 'complete spool size or binding changed', { terminal: true });
            }
            return { status: 'already-complete', spoolKey, sourcePath, totalBytes: metadata.totalBytes };
        }
        if (metadataStat !== null && sourceStat === null) {
            throw new MkvPrewarmError('CORRUPT_PARTIAL_SPOOL', 'spool metadata exists without source bytes', { terminal: true });
        }
        if (metadataStat === null && sourceStat !== null) {
            throw new MkvPrewarmError('CORRUPT_PARTIAL_SPOOL', 'source bytes exist without binding metadata', { terminal: true });
        }

        let metadata = null;
        let offset = 0;
        if (metadataStat) {
            metadata = await readExactJson(metadataPath,
                ['schema', 'spoolKey', 'initialUrlHash', 'effectiveUrlHash', 'strongEtag', 'strongEtagHash', 'profileBuildHash', 'totalBytes', 'createdAtMs'],
                'CORRUPT_SPOOL_METADATA');
            validateMetadata(metadata, spoolKey, normalizedIdentity);
            offset = sourceStat.size;
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > metadata.totalBytes) {
                throw new MkvPrewarmError('CORRUPT_PARTIAL_SPOOL', 'partial spool size is invalid', { terminal: true });
            }
            if (offset === metadata.totalBytes) {
                throw new MkvPrewarmError('INDETERMINATE_COMPLETE_SPOOL', 'source reached its declared size without an EOF completion marker', { terminal: true });
            }
        }

        laneLease = options.coordinator.beginBackground(laneKey, options.signal);
        const requestHeaders = { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' };
        if (metadata) requestHeaders['If-Range'] = metadata.strongEtag;

        let response;
        try {
            response = await options.openProviderGet({
                url: normalizedIdentity.initialUrl,
                method: 'GET',
                headers: requestHeaders,
                signal: laneLease.signal,
            });
        } catch (error) {
            const yielded = preemptedError(laneLease.signal, error);
            if (yielded) throw yielded;
            throw new MkvPrewarmError('PROVIDER_GET_FAILED', 'the single provider GET attempt failed', { cause: error });
        }
        if (!response || typeof response !== 'object') {
            throw new MkvPrewarmError('INVALID_PROVIDER_RESPONSE', 'provider GET returned no response');
        }
        responseBody = response.body;
        if (responseBody && typeof responseBody.cancel !== 'function' && typeof responseBody.destroy !== 'function') {
            throw new MkvPrewarmError('PROVIDER_BODY_NOT_DRAINABLE', 'provider body must expose cancel() or destroy() for viewer drainage', { terminal: true });
        }
        const status = Number(response.status);
        if (status === 458) {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('PROVIDER_BUSY', 'provider rejected the prewarm lane as busy', { terminal: true });
        }
        if (status !== 206) {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('PROVIDER_RANGE_REQUIRED', 'prewarm requires one strict 206 range response', { terminal: status >= 400 && status < 500 });
        }
        if (!responseBody || typeof responseBody[Symbol.asyncIterator] !== 'function') {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('INVALID_PROVIDER_BODY', 'provider response body is not streamable');
        }
        const encoding = headerValue(response.headers, 'content-encoding').toLowerCase();
        if (encoding && encoding !== 'identity') {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('ENCODED_PROVIDER_RANGE', 'provider range response must use identity encoding', { terminal: true });
        }
        const range = parseStrictContentRange(headerValue(response.headers, 'content-range'));
        const length = Number(headerValue(response.headers, 'content-length'));
        const etag = strongEtag(headerValue(response.headers, 'etag'));
        const effectiveUrl = responseEffectiveUrl(response);
        if (!range || range.start !== offset || !Number.isSafeInteger(length) || length !== range.length) {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('INVALID_CONTENT_RANGE', 'provider Content-Range or Content-Length is inconsistent', { terminal: true });
        }
        if (!etag) {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('STRONG_ETAG_REQUIRED', 'prewarm resume requires a strong ETag', { terminal: true });
        }
        if (range.total > maxSourceBytes) {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('SOURCE_TOO_LARGE', 'provider source exceeds the configured spool bound', { terminal: true });
        }
        if (metadata && (metadata.totalBytes !== range.total
            || metadata.strongEtag !== etag
            || metadata.effectiveUrlHash !== sha256(effectiveUrl))) {
            await cancelBody(responseBody);
            throw new MkvPrewarmError('RESUME_BINDING_CHANGED', 'provider ETag, effective URL, or source size changed', { terminal: true });
        }

        if (!metadata) {
            metadata = {
                schema: METADATA_SCHEMA,
                spoolKey,
                initialUrlHash: sha256(normalizedIdentity.initialUrl),
                effectiveUrlHash: sha256(effectiveUrl),
                strongEtag: etag,
                strongEtagHash: sha256(etag),
                profileBuildHash: sha256(normalizedIdentity.profileBuild),
                totalBytes: range.total,
                createdAtMs: Date.now(),
            };
            await writeNewJsonDurably(metadataPath, metadata);
        }

        const flags = offset === 0
            ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            : fs.constants.O_WRONLY | fs.constants.O_APPEND;
        const sourceHandle = await fsp.open(sourcePath, flags, PRIVATE_FILE_MODE);
        let received = 0;
        let cleanEof = false;
        try {
            const opened = await sourceHandle.stat();
            if (!opened.isFile() || opened.size !== offset) {
                throw new MkvPrewarmError('SPOOL_OFFSET_CHANGED', 'spool size changed before append', { terminal: true });
            }
            for await (const rawChunk of responseBody) {
                if (laneLease.signal && laneLease.signal.aborted) {
                    throw new MkvPrewarmError('PREWARM_PREEMPTED', 'prewarm yielded during provider drainage', { preempted: true });
                }
                const chunk = Buffer.from(rawChunk);
                if (chunk.length === 0) continue;
                if (received + chunk.length > range.length) {
                    throw new MkvPrewarmError('PROVIDER_BODY_TOO_LONG', 'provider sent more bytes than its Content-Range', { terminal: true });
                }
                await writeAll(sourceHandle, chunk);
                received += chunk.length;
            }
            cleanEof = true;
            if (received !== range.length || offset + received !== metadata.totalBytes) {
                throw new MkvPrewarmError('PROVIDER_BODY_TRUNCATED', 'provider ended before the declared source size');
            }
            await sourceHandle.sync();
            const completedStat = await sourceHandle.stat();
            if (completedStat.size !== metadata.totalBytes) {
                throw new MkvPrewarmError('SPOOL_SIZE_MISMATCH', 'fsynced spool size differs from provider metadata', { terminal: true });
            }
        } catch (error) {
            if (received > 0) {
                try { await sourceHandle.sync(); } catch (_) { /* the original failure remains authoritative */ }
            }
            const yielded = error instanceof MkvPrewarmError && error.preempted
                ? error
                : preemptedError(laneLease.signal, error);
            if (yielded) throw yielded;
            if (error instanceof MkvPrewarmError) throw error;
            throw new MkvPrewarmError('PROVIDER_STREAM_INTERRUPTED', 'provider stream ended with an error', { cause: error });
        } finally {
            await sourceHandle.close();
        }
        if (!cleanEof) {
            throw new MkvPrewarmError('PROVIDER_STREAM_INTERRUPTED', 'provider stream did not reach EOF');
        }

        const complete = {
            schema: COMPLETE_SCHEMA,
            spoolKey,
            totalBytes: metadata.totalBytes,
            completedAtMs: Date.now(),
        };
        await writeNewJsonDurably(completePath, complete);
        const proofInput = Object.freeze({
            spoolKey,
            sourcePath,
            totalBytes: metadata.totalBytes,
            initialUrlHash: metadata.initialUrlHash,
            effectiveUrlHash: metadata.effectiveUrlHash,
            strongEtagHash: metadata.strongEtagHash,
            profileBuildHash: metadata.profileBuildHash,
        });
        const proof = await options.onComplete(proofInput);
        return { status: 'complete', ...proofInput, proof };
    } catch (error) {
        if (error instanceof MkvPrewarmError && error.preempted) {
            await cancelBody(responseBody);
            return { status: 'preempted', spoolKey };
        }
        await cancelBody(responseBody);
        throw error;
    } finally {
        if (laneLease) laneLease.finish();
        if (lockHandle) {
            await lockHandle.close().catch(() => {});
            await fsp.unlink(lockPath).catch(() => {});
        }
    }
}

module.exports = {
    MkvPrewarmError,
    PrewarmLaneCoordinator,
    derivePrewarmLaneKey,
    derivePrewarmSpoolKey,
    parseStrictContentRange,
    runMkvPrewarmAttempt,
};
