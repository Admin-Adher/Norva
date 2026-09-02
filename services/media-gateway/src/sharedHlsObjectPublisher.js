'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
    canonicalJson,
    openRegularNoFollow,
    parseDedicatedManifestHmacKey,
    safeRelativeAsset,
    validateCompleteHlsDirectory,
} = require('./mkv-hls-cache');
const { deriveGlobalMediaCacheObjectKey } = require('./mediaCacheIdentity');

const SHARED_HLS_MANIFEST_SCHEMA = 1;
const SHARED_HLS_ENVELOPE_SCHEMA = 1;
const MAX_SHARED_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 128 * 1024 * 1024 * 1024;
const DEFAULT_MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

class SharedHlsPublicationError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'SharedHlsPublicationError';
        this.code = code;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function strictPositiveInteger(value, field) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new SharedHlsPublicationError('INVALID_SHARED_HLS_CONFIG', `${field} is invalid`);
    }
    return number;
}

function contentTypeForAsset(relative) {
    const extension = path.posix.extname(relative).toLowerCase();
    if (extension === '.m3u8') return 'application/vnd.apple.mpegurl';
    if (extension === '.m4s') return 'video/iso.segment';
    if (extension === '.mp4') return 'video/mp4';
    if (extension === '.ts') return 'video/mp2t';
    if (extension === '.vtt') return 'text/vtt; charset=utf-8';
    if (extension === '.aac') return 'audio/aac';
    return 'application/octet-stream';
}

function resolveSourceAsset(sourceRoot, relative) {
    const resolved = path.resolve(sourceRoot, ...safeRelativeAsset(relative).split('/'));
    const delta = path.relative(sourceRoot, resolved);
    if (!delta || delta.startsWith('..') || path.isAbsolute(delta)) {
        throw new SharedHlsPublicationError('UNSAFE_SHARED_HLS_ASSET', 'shared HLS asset escaped its source root');
    }
    return resolved;
}

async function readStableAsset(sourceRoot, relative, expected = null, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
    const candidate = resolveSourceAsset(sourceRoot, relative);
    const { handle, stat } = await openRegularNoFollow(candidate, sourceRoot);
    try {
        if (stat.size <= 0 || stat.size > maxFileBytes) {
            throw new SharedHlsPublicationError('SHARED_HLS_FILE_TOO_LARGE', 'shared HLS asset exceeds its file bound');
        }
        if (expected && (
            stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs
            || stat.dev !== expected.dev || stat.ino !== expected.ino
        )) {
            throw new SharedHlsPublicationError('SHARED_HLS_SOURCE_CHANGED', 'shared HLS asset changed before upload');
        }
        const body = await handle.readFile();
        const after = await handle.stat();
        if (body.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
            || after.dev !== stat.dev || after.ino !== stat.ino) {
            throw new SharedHlsPublicationError('SHARED_HLS_SOURCE_CHANGED', 'shared HLS asset changed while reading');
        }
        const digest = sha256(body);
        if (expected && digest !== expected.sha256) {
            throw new SharedHlsPublicationError('SHARED_HLS_SOURCE_CHANGED', 'shared HLS asset content changed before upload');
        }
        return {
            body,
            snapshot: {
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                dev: stat.dev,
                ino: stat.ino,
                sha256: digest,
            },
        };
    } finally {
        await handle.close();
    }
}

function signSharedManifest(payload, key) {
    const payloadJson = canonicalJson(payload);
    const encoded = Buffer.from(payloadJson).toString('base64url');
    const keyId = sha256(key).slice(0, 16);
    const mac = crypto.createHmac('sha256', key)
        .update(`norva-shared-hls-manifest-v1\0${keyId}\0${encoded}`)
        .digest('base64url');
    return { schema: SHARED_HLS_ENVELOPE_SCHEMA, keyId, payload: encoded, mac };
}

function timingSafeTextEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function decodeSharedManifest(body, key) {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    let envelope;
    try { envelope = JSON.parse(text); } catch (error) {
        throw new SharedHlsPublicationError('INVALID_SHARED_HLS_MANIFEST', 'shared HLS manifest JSON is invalid', { cause: error });
    }
    const envelopeKeys = envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        ? Object.keys(envelope).sort().join(',')
        : '';
    if (envelopeKeys !== 'keyId,mac,payload,schema'
        || envelope.schema !== SHARED_HLS_ENVELOPE_SCHEMA
        || !/^[0-9a-f]{16}$/.test(envelope.keyId)
        || typeof envelope.payload !== 'string'
        || !/^[A-Za-z0-9_-]+$/.test(envelope.payload)
        || Buffer.from(envelope.payload, 'base64url').toString('base64url') !== envelope.payload
        || typeof envelope.mac !== 'string'
        || !/^[A-Za-z0-9_-]+$/.test(envelope.mac)
        || Buffer.from(envelope.mac, 'base64url').toString('base64url') !== envelope.mac) {
        throw new SharedHlsPublicationError('INVALID_SHARED_HLS_MANIFEST', 'shared HLS manifest envelope is invalid');
    }
    const keyId = sha256(key).slice(0, 16);
    const expectedMac = crypto.createHmac('sha256', key)
        .update(`norva-shared-hls-manifest-v1\0${envelope.keyId}\0${envelope.payload}`)
        .digest('base64url');
    if (!timingSafeTextEqual(envelope.keyId, keyId) || !timingSafeTextEqual(envelope.mac, expectedMac)) {
        throw new SharedHlsPublicationError('INVALID_SHARED_HLS_MANIFEST', 'shared HLS manifest authentication failed');
    }
    let payloadJson;
    let payload;
    try {
        payloadJson = Buffer.from(envelope.payload, 'base64url').toString('utf8');
        payload = JSON.parse(payloadJson);
    } catch (error) {
        throw new SharedHlsPublicationError('INVALID_SHARED_HLS_MANIFEST', 'shared HLS manifest payload is invalid', { cause: error });
    }
    if (canonicalJson(payload) !== payloadJson || `${canonicalJson(envelope)}\n` !== text) {
        throw new SharedHlsPublicationError('INVALID_SHARED_HLS_MANIFEST', 'shared HLS manifest is not canonical');
    }
    return payload;
}

function validateExistingManifest(payload, expected, nowMs) {
    const keys = [
        'schema', 'identityKind', 'objectKey', 'components', 'rootPlaylist', 'files',
        'totalBytes', 'createdAtMs', 'expiresAtMs', 'completion',
    ];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).sort().join(',') !== keys.sort().join(',')
        || payload.schema !== SHARED_HLS_MANIFEST_SCHEMA
        || payload.identityKind !== 'global-media-object'
        || payload.objectKey !== expected.objectKey
        || canonicalJson(payload.components) !== canonicalJson(expected.components)
        || payload.rootPlaylist !== expected.rootPlaylist
        || canonicalJson(payload.files) !== canonicalJson(expected.files)
        || payload.totalBytes !== expected.totalBytes
        || canonicalJson(payload.completion) !== canonicalJson(expected.completion)
        || !Number.isSafeInteger(payload.createdAtMs)
        || !Number.isSafeInteger(payload.expiresAtMs)
        || payload.createdAtMs <= 0
        || payload.expiresAtMs <= payload.createdAtMs
        || payload.expiresAtMs - payload.createdAtMs > MAX_SHARED_CACHE_TTL_MS) {
        throw new SharedHlsPublicationError('SHARED_HLS_OBJECT_COLLISION', 'existing shared HLS manifest differs from the immutable object');
    }
    if (payload.expiresAtMs <= nowMs) {
        throw new SharedHlsPublicationError('SHARED_HLS_OBJECT_EXPIRED', 'existing shared HLS object requires coordinated eviction before replacement');
    }
    return payload;
}

function validateCompletion(completion) {
    if (!completion || typeof completion !== 'object' || Array.isArray(completion)
        || Object.keys(completion).sort().join(',') !== 'ffmpegExitCode,kind,sourceEof'
        || completion.kind !== 'complete-hls'
        || completion.sourceEof !== true
        || completion.ffmpegExitCode !== 0) {
        throw new SharedHlsPublicationError('INCOMPLETE_SHARED_HLS_REJECTED', 'only an EOF-complete HLS graph can be shared');
    }
}

class SharedHlsObjectPublisher {
    constructor(options = {}) {
        if (!options.objectStore || typeof options.objectStore.put !== 'function' || typeof options.objectStore.get !== 'function') {
            throw new SharedHlsPublicationError('INVALID_SHARED_HLS_CONFIG', 'an immutable object store is required');
        }
        this.objectStore = options.objectStore;
        this.manifestKey = parseDedicatedManifestHmacKey(options.manifestHmacKey);
        this.ttlMs = strictPositiveInteger(options.ttlMs, 'ttlMs');
        if (this.ttlMs > MAX_SHARED_CACHE_TTL_MS) {
            throw new SharedHlsPublicationError('INVALID_SHARED_HLS_CONFIG', 'ttlMs exceeds the 90-day bound');
        }
        this.maxFiles = strictPositiveInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 'maxFiles');
        this.maxFileBytes = strictPositiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
        this.maxEntryBytes = strictPositiveInteger(options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES, 'maxEntryBytes');
        this.maxPlaylistBytes = strictPositiveInteger(options.maxPlaylistBytes ?? DEFAULT_MAX_PLAYLIST_BYTES, 'maxPlaylistBytes');
        this.now = typeof options.now === 'function' ? options.now : Date.now;
    }

    async publish(options = {}) {
        validateCompletion(options.completion);
        const effectiveTtlMs = options.ttlMs === undefined
            ? this.ttlMs
            : strictPositiveInteger(options.ttlMs, 'ttlMs');
        if (effectiveTtlMs > this.ttlMs || effectiveTtlMs > MAX_SHARED_CACHE_TTL_MS) {
            throw new SharedHlsPublicationError(
                'INVALID_SHARED_HLS_CONFIG',
                'adaptive ttl exceeds the configured shared-cache bound',
            );
        }
        const derived = deriveGlobalMediaCacheObjectKey(options.identity);
        if (typeof options.sourceDirectory !== 'string' || !options.sourceDirectory.trim()
            || /[\u0000\r\n]/.test(options.sourceDirectory)) {
            throw new SharedHlsPublicationError('UNSAFE_SHARED_HLS_SOURCE', 'shared HLS source is invalid');
        }
        const sourceDirectory = path.resolve(options.sourceDirectory);
        const sourceStat = await fsp.lstat(sourceDirectory).catch((error) => {
            throw new SharedHlsPublicationError('UNSAFE_SHARED_HLS_SOURCE', 'shared HLS source is unavailable', { cause: error });
        });
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
            throw new SharedHlsPublicationError('UNSAFE_SHARED_HLS_SOURCE', 'shared HLS source must be a real directory');
        }
        const sourceRoot = await fsp.realpath(sourceDirectory);
        const rootPlaylist = safeRelativeAsset(options.rootPlaylist, 'root playlist');
        if (!Array.isArray(options.files) || options.files.length === 0 || options.files.length > this.maxFiles) {
            throw new SharedHlsPublicationError('INVALID_SHARED_HLS_ASSETS', 'shared HLS file list is invalid');
        }
        const names = options.files.map((value) => safeRelativeAsset(value)).sort();
        if (new Set(names).size !== names.length || !names.includes(rootPlaylist)) {
            throw new SharedHlsPublicationError('INVALID_SHARED_HLS_ASSETS', 'shared HLS file list is incomplete or duplicated');
        }

        const prefix = `media-cache/v1/${derived.key.slice(0, 2)}/${derived.key}/`;
        const records = [];
        const snapshots = new Map();
        let totalBytes = 0;
        for (const relative of names) {
            const { snapshot } = await readStableAsset(sourceRoot, relative, null, this.maxFileBytes);
            totalBytes += snapshot.size;
            if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxEntryBytes) {
                throw new SharedHlsPublicationError('SHARED_HLS_ENTRY_TOO_LARGE', 'shared HLS graph exceeds its entry bound');
            }
            snapshots.set(relative, snapshot);
            records.push({
                path: relative,
                objectName: `assets/${sha256(`asset-path\0${relative}`)}`,
                size: snapshot.size,
                sha256: snapshot.sha256,
                contentType: contentTypeForAsset(relative),
            });
        }
        await validateCompleteHlsDirectory(sourceRoot, rootPlaylist, records, this.maxPlaylistBytes);

        const manifestKey = `${prefix}manifest.auth.json`;
        const expectedGraph = {
            objectKey: derived.key,
            components: derived.components,
            rootPlaylist,
            files: records,
            totalBytes,
            completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
        };
        const existingManifest = await this.objectStore.get(manifestKey);
        if (existingManifest) {
            const nowMs = Number(this.now());
            const existingPayload = validateExistingManifest(
                decodeSharedManifest(existingManifest.body, this.manifestKey),
                expectedGraph,
                nowMs,
            );
            return Object.freeze({
                status: 'already-ready',
                objectKey: derived.key,
                components: Object.freeze({ ...derived.components }),
                objectPrefix: prefix,
                manifestKey,
                manifestSha256: sha256(existingManifest.body),
                totalBytes,
                fileCount: records.length,
                expiresAtMs: existingPayload.expiresAtMs,
            });
        }

        // Immutable assets are uploaded first. If any write fails, no manifest
        // exists and the partial prefix is unreachable to readers.
        for (const record of records) {
            const { body } = await readStableAsset(sourceRoot, record.path, snapshots.get(record.path), this.maxFileBytes);
            await this.objectStore.put(`${prefix}${record.objectName}`, body, {
                sha256: record.sha256,
                contentType: record.contentType,
                metadata: {
                    kind: 'hls-asset',
                    'object-key': derived.key,
                    'asset-sha256': record.sha256,
                    'logical-path-sha256': sha256(record.path),
                },
            });
        }

        const createdAtMs = Number(this.now());
        if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0 || createdAtMs + effectiveTtlMs > Number.MAX_SAFE_INTEGER) {
            throw new SharedHlsPublicationError('INVALID_SHARED_HLS_CLOCK', 'shared HLS clock is invalid');
        }
        const payload = {
            schema: SHARED_HLS_MANIFEST_SCHEMA,
            identityKind: 'global-media-object',
            objectKey: derived.key,
            components: derived.components,
            rootPlaylist,
            files: records,
            totalBytes,
            createdAtMs,
            expiresAtMs: createdAtMs + effectiveTtlMs,
            completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
        };
        const envelope = signSharedManifest(payload, this.manifestKey);
        const manifestBody = Buffer.from(`${canonicalJson(envelope)}\n`);
        const manifestSha256 = sha256(manifestBody);
        try {
            await this.objectStore.put(manifestKey, manifestBody, {
                sha256: manifestSha256,
                contentType: 'application/json; charset=utf-8',
                metadata: {
                    kind: 'hls-manifest',
                    'object-key': derived.key,
                    'manifest-sha256': manifestSha256,
                },
            });
        } catch (error) {
            // A distributed peer may have won the manifest-last race. Accept
            // only its authenticated byte-for-byte graph; every other conflict
            // remains terminal and cannot replace the winner.
            const winner = await this.objectStore.get(manifestKey).catch(() => null);
            if (!winner) throw error;
            const winnerPayload = validateExistingManifest(
                decodeSharedManifest(winner.body, this.manifestKey),
                expectedGraph,
                createdAtMs,
            );
            return Object.freeze({
                status: 'already-ready',
                objectKey: derived.key,
                components: Object.freeze({ ...derived.components }),
                objectPrefix: prefix,
                manifestKey,
                manifestSha256: sha256(winner.body),
                totalBytes,
                fileCount: records.length,
                expiresAtMs: winnerPayload.expiresAtMs,
            });
        }
        return Object.freeze({
            status: 'published',
            objectKey: derived.key,
            components: Object.freeze({ ...derived.components }),
            objectPrefix: prefix,
            manifestKey,
            manifestSha256,
            totalBytes,
            fileCount: records.length,
            expiresAtMs: payload.expiresAtMs,
        });
    }
}

module.exports = {
    SHARED_HLS_MANIFEST_SCHEMA,
    SharedHlsObjectPublisher,
    SharedHlsPublicationError,
    contentTypeForAsset,
    decodeSharedManifest,
    signSharedManifest,
};
