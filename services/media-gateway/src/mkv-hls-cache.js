'use strict';

// Phase 3A building block only. This module deliberately performs no provider
// I/O and starts no encoder. A caller may publish only a producer-declared,
// EOF-complete HLS graph; a hit is served exclusively from authenticated local
// state through the verified-asset handle returned by acquire().

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CACHE_KEY_SCHEMA = 1;
const MANIFEST_SCHEMA = 1;
const ENVELOPE_SCHEMA = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_ENTRY_BYTES = 128 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;
const MANIFEST_RESERVE_BYTES = 64 * 1024;
const MAX_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

class MkvHlsCacheError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'MkvHlsCacheError';
        this.code = code;
        this.terminal = options.terminal !== false;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value, depth = 0) {
    if (depth > 24) throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', 'cache identity is too deeply nested');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
    if (!isPlainObject(value)) throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', 'cache identity contains a non-JSON value');
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
}

function exactKeys(value, keys) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value, field, maxLength = 4096) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
        throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', `${field} is invalid`);
    }
    return value;
}

function strongEtag(value) {
    const etag = typeof value === 'string' ? value.trim() : '';
    if (!/^"[^"\r\n]*"$/.test(etag) || /^W\//i.test(etag)) return '';
    return etag;
}

function validateHttpUrl(value, field) {
    const candidate = boundedString(value, field, 16_384);
    let parsed;
    try { parsed = new URL(candidate); } catch (_) {
        throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', `${field} is invalid`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', `${field} protocol is invalid`);
    }
    return candidate;
}

function normalizeCacheIdentity(identity) {
    const keys = ['tenantId', 'providerId', 'itemId', 'variantId', 'initialUrl', 'effectiveUrl', 'strongEtag', 'profile', 'pipelineBuild'];
    if (!exactKeys(identity, keys)) {
        throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', 'cache identity has an unexpected shape');
    }
    if (!isPlainObject(identity.profile)) {
        throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', 'profile must be a structural object');
    }
    const profileJson = canonicalJson(identity.profile);
    if (Buffer.byteLength(profileJson) > 64 * 1024) {
        throw new MkvHlsCacheError('INVALID_CACHE_IDENTITY', 'profile exceeds its cache-key bound');
    }
    const etag = strongEtag(identity.strongEtag);
    if (!etag) throw new MkvHlsCacheError('STRONG_ETAG_REQUIRED', 'complete HLS cache requires a strong ETag');
    return {
        tenantId: boundedString(identity.tenantId, 'tenantId', 512),
        providerId: boundedString(identity.providerId, 'providerId', 512),
        itemId: boundedString(identity.itemId, 'itemId', 512),
        variantId: identity.variantId === null ? null : boundedString(identity.variantId, 'variantId', 512),
        initialUrl: validateHttpUrl(identity.initialUrl, 'initialUrl'),
        effectiveUrl: validateHttpUrl(identity.effectiveUrl, 'effectiveUrl'),
        strongEtag: etag,
        profileJson,
        pipelineBuild: boundedString(identity.pipelineBuild, 'pipelineBuild', 512),
    };
}

function deriveCompleteHlsCacheKey(identity) {
    const normalized = normalizeCacheIdentity(identity);
    const components = {
        tenant: sha256(`tenant\0${normalized.tenantId}`),
        provider: sha256(`provider\0${normalized.providerId}`),
        item: sha256(`item\0${normalized.itemId}`),
        variant: sha256(`variant\0${normalized.variantId === null ? '<null>' : normalized.variantId}`),
        initialUrl: sha256(`initial-url\0${normalized.initialUrl}`),
        effectiveUrl: sha256(`effective-url\0${normalized.effectiveUrl}`),
        strongEtag: sha256(`strong-etag\0${normalized.strongEtag}`),
        profile: sha256(`profile\0${normalized.profileJson}`),
        pipelineBuild: sha256(`pipeline-build\0${normalized.pipelineBuild}`),
    };
    return {
        key: sha256(canonicalJson({ schema: CACHE_KEY_SCHEMA, components })),
        components,
    };
}

function parseDedicatedManifestHmacKey(value) {
    if (Buffer.isBuffer(value)) {
        if (value.length !== 32) throw new MkvHlsCacheError('INVALID_CACHE_HMAC_KEY', 'manifestHmacKey must be exactly 32 bytes');
        return Buffer.from(value);
    }
    if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
    throw new MkvHlsCacheError('INVALID_CACHE_HMAC_KEY', 'a dedicated 64-hex manifest HMAC key is required');
}

function strictPositiveInteger(value, field) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new MkvHlsCacheError('INVALID_CACHE_CONFIG', `${field} is invalid`);
    return number;
}

function strictNonNegativeInteger(value, field) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new MkvHlsCacheError('INVALID_CACHE_CONFIG', `${field} is invalid`);
    return number;
}

function safeRelativeAsset(value, field = 'asset path') {
    const candidate = boundedString(value, field, 1024);
    if (candidate.includes('\\') || candidate.includes('?') || candidate.includes('#') || candidate.includes('%')
        || candidate.startsWith('/') || !/^[A-Za-z0-9._/-]+$/.test(candidate)) {
        throw new MkvHlsCacheError('UNSAFE_CACHE_ASSET', `${field} is unsafe`);
    }
    const normalized = path.posix.normalize(candidate);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')
        || normalized !== candidate || candidate.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new MkvHlsCacheError('UNSAFE_CACHE_ASSET', `${field} escapes its cache entry`);
    }
    return candidate;
}

function resolveInside(root, relative) {
    const resolved = path.resolve(root, ...safeRelativeAsset(relative).split('/'));
    const delta = path.relative(root, resolved);
    if (!delta || delta.startsWith('..') || path.isAbsolute(delta)) {
        throw new MkvHlsCacheError('UNSAFE_CACHE_ASSET', 'asset escaped its cache entry');
    }
    return resolved;
}

async function ensurePrivateDirectory(directory) {
    await fsp.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'cache path must be a private real directory');
    }
    await fsp.chmod(directory, PRIVATE_DIRECTORY_MODE);
    return fsp.realpath(directory);
}

function assertInsideRoot(rootReal, candidate, allowRoot = false) {
    const delta = path.relative(rootReal, candidate);
    if ((!allowRoot && !delta) || delta.startsWith('..') || path.isAbsolute(delta)) {
        throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'cache path escaped its private root');
    }
}

async function optionalLstat(filePath) {
    try { return await fsp.lstat(filePath); } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
    }
}

async function fsyncDirectory(directory) {
    let handle;
    try {
        handle = await fsp.open(directory, fs.constants.O_RDONLY);
        await handle.sync();
    } catch (error) {
        if (process.platform !== 'win32' && (!error || !['EINVAL', 'EISDIR', 'EPERM'].includes(error.code))) throw error;
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
}

async function writeAll(handle, buffer) {
    let offset = 0;
    while (offset < buffer.length) {
        const result = await handle.write(buffer, offset, buffer.length - offset);
        if (!result || result.bytesWritten <= 0) throw new MkvHlsCacheError('CACHE_WRITE_FAILED', 'cache write made no progress');
        offset += result.bytesWritten;
    }
}

function timingSafeTextEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base64urlCanonical(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.includes('=')) return false;
    try { return Buffer.from(value, 'base64url').toString('base64url') === value; } catch (_) { return false; }
}

function signManifest(payload, key) {
    const payloadJson = canonicalJson(payload);
    const encoded = Buffer.from(payloadJson).toString('base64url');
    const keyId = sha256(key).slice(0, 16);
    const mac = crypto.createHmac('sha256', key).update(`norva-mkv-hls-cache\0${keyId}\0${encoded}`).digest('base64url');
    return { schema: ENVELOPE_SCHEMA, keyId, payload: encoded, mac };
}

function decodeManifestEnvelope(envelope, key) {
    if (!exactKeys(envelope, ['schema', 'keyId', 'payload', 'mac']) || envelope.schema !== ENVELOPE_SCHEMA
        || !/^[0-9a-f]{16}$/.test(envelope.keyId) || !base64urlCanonical(envelope.payload)
        || !base64urlCanonical(envelope.mac)) {
        throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest envelope is invalid');
    }
    const expectedKeyId = sha256(key).slice(0, 16);
    if (!timingSafeTextEqual(envelope.keyId, expectedKeyId)) {
        throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest key is unknown');
    }
    const expectedMac = crypto.createHmac('sha256', key)
        .update(`norva-mkv-hls-cache\0${envelope.keyId}\0${envelope.payload}`)
        .digest('base64url');
    if (!timingSafeTextEqual(envelope.mac, expectedMac)) {
        throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest authentication failed');
    }
    let payloadJson;
    let payload;
    try {
        payloadJson = Buffer.from(envelope.payload, 'base64url').toString('utf8');
        payload = JSON.parse(payloadJson);
    } catch (error) {
        throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest payload is invalid', { cause: error });
    }
    if (canonicalJson(payload) !== payloadJson) {
        throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest payload is not canonical');
    }
    return payload;
}

function validateCompletionEvidence(completion) {
    if (!exactKeys(completion, ['kind', 'sourceEof', 'ffmpegExitCode'])
        || completion.kind !== 'complete-hls'
        || completion.sourceEof !== true
        || completion.ffmpegExitCode !== 0) {
        throw new MkvHlsCacheError('INCOMPLETE_HLS_REJECTED', 'cache accepts only full HLS output after source EOF and FFmpeg exit 0');
    }
}

function playlistReferences(text, playlistPath) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', `${playlistPath} is not an HLS playlist`);
    if (lines.some((line) => /^#EXT-X-(?:PREFETCH|PRELOAD-HINT|RENDITION-REPORT|SKIP)(?::|$)/.test(line))) {
        throw new MkvHlsCacheError('INCOMPLETE_HLS_REJECTED', `${playlistPath} contains a live/prefix-only HLS tag`);
    }
    const hasMedia = lines.some((line) => line.startsWith('#EXTINF:'));
    if (hasMedia && !lines.includes('#EXT-X-ENDLIST')) {
        throw new MkvHlsCacheError('INCOMPLETE_HLS_REJECTED', `${playlistPath} has no EXT-X-ENDLIST`);
    }
    const refs = [];
    for (const line of lines) {
        if (!line.startsWith('#')) refs.push(line);
        const uriMatches = [...line.matchAll(/(?:^|[:,])URI="([^"]+)"/g)];
        if (/URI=/.test(line) && uriMatches.length === 0) {
            throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', `${playlistPath} contains an unquoted or malformed URI attribute`);
        }
        for (const match of uriMatches) refs.push(match[1]);
    }
    const base = path.posix.dirname(playlistPath);
    return {
        hasMedia,
        refs: refs.map((reference) => {
            const relative = safeRelativeAsset(reference, 'HLS reference');
            return safeRelativeAsset(base === '.' ? relative : path.posix.join(base, relative), 'resolved HLS reference');
        }),
    };
}

async function validateCompleteHlsDirectory(directory, rootPlaylist, files, maxPlaylistBytes) {
    const available = new Set(files.map((entry) => entry.path));
    if (!available.has(rootPlaylist)) throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', 'root playlist is not in the asset set');
    const queue = [rootPlaylist];
    const reached = new Set();
    let mediaPlaylists = 0;
    while (queue.length) {
        const playlist = queue.shift();
        if (reached.has(playlist)) continue;
        reached.add(playlist);
        if (!playlist.toLowerCase().endsWith('.m3u8')) {
            throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', 'playlist graph points to a non-playlist node');
        }
        const playlistFile = files.find((entry) => entry.path === playlist);
        if (!playlistFile || playlistFile.size > maxPlaylistBytes) {
            throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', 'playlist is missing or exceeds its size bound');
        }
        const text = await fsp.readFile(resolveInside(directory, playlist), 'utf8');
        const parsed = playlistReferences(text, playlist);
        if (parsed.hasMedia) mediaPlaylists += 1;
        for (const reference of parsed.refs) {
            if (!available.has(reference)) throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', `unlisted HLS asset: ${reference}`);
            if (reference.toLowerCase().endsWith('.m3u8')) queue.push(reference);
            else reached.add(reference);
        }
    }
    if (mediaPlaylists === 0) throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', 'HLS graph has no complete media playlist');
    if (reached.size !== available.size) {
        throw new MkvHlsCacheError('INVALID_HLS_PLAYLIST', 'asset set contains files unreachable from the root playlist');
    }
}

function validateManifestPayload(payload, expectedKey) {
    const keys = ['schema', 'key', 'components', 'rootPlaylist', 'files', 'totalBytes', 'createdAtMs', 'expiresAtMs', 'completion'];
    if (!exactKeys(payload, keys) || payload.schema !== MANIFEST_SCHEMA || payload.key !== expectedKey
        || !/^[0-9a-f]{64}$/.test(payload.key)
        || !exactKeys(payload.components, ['tenant', 'provider', 'item', 'variant', 'initialUrl', 'effectiveUrl', 'strongEtag', 'profile', 'pipelineBuild'])
        || Object.values(payload.components).some((value) => !/^[0-9a-f]{64}$/.test(value))
        || !Array.isArray(payload.files) || payload.files.length === 0
        || !Number.isSafeInteger(payload.totalBytes) || payload.totalBytes <= 0
        || !Number.isSafeInteger(payload.createdAtMs) || !Number.isSafeInteger(payload.expiresAtMs)
        || payload.expiresAtMs <= payload.createdAtMs
        || !exactKeys(payload.completion, ['kind', 'sourceEof', 'ffmpegExitCode'])
        || payload.completion.kind !== 'complete-hls' || payload.completion.sourceEof !== true
        || payload.completion.ffmpegExitCode !== 0) {
        throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest payload shape is invalid');
    }
    safeRelativeAsset(payload.rootPlaylist, 'root playlist');
    let total = 0;
    let previous = '';
    for (const file of payload.files) {
        if (!exactKeys(file, ['path', 'size', 'sha256'])) throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache file record is invalid');
        const relative = safeRelativeAsset(file.path);
        if (relative <= previous || !Number.isSafeInteger(file.size) || file.size <= 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
            throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache file ordering or metadata is invalid');
        }
        previous = relative;
        total += file.size;
        if (!Number.isSafeInteger(total)) throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache size overflow');
    }
    if (total !== payload.totalBytes) throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest total is invalid');
    return payload;
}

async function openRegularNoFollow(filePath, allowedRoot) {
    const before = await fsp.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new MkvHlsCacheError('UNSAFE_CACHE_ASSET', 'cache asset must be a regular non-symlink file');
    const real = await fsp.realpath(filePath);
    assertInsideRoot(allowedRoot, real);
    const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    const handle = await fsp.open(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        await handle.close();
        throw new MkvHlsCacheError('UNSAFE_CACHE_ASSET', 'cache asset changed while opening');
    }
    return { handle, stat: opened };
}

async function openVerifiedCacheAsset(entryRoot, record) {
    const filePath = resolveInside(entryRoot, record.path);
    const { handle, stat } = await openRegularNoFollow(filePath, entryRoot);
    if (stat.size !== record.size) {
        await handle.close();
        throw new MkvHlsCacheError('INVALID_CACHE_ENTRY', 'cache asset size changed');
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    try {
        while (position < stat.size) {
            const result = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
            if (!result || result.bytesRead <= 0) throw new MkvHlsCacheError('INVALID_CACHE_ENTRY', 'cache asset ended during verification');
            digest.update(buffer.subarray(0, result.bytesRead));
            position += result.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino
            || !timingSafeTextEqual(digest.digest('hex'), record.sha256)) {
            throw new MkvHlsCacheError('INVALID_CACHE_ENTRY', 'cache asset authentication failed');
        }
        return handle;
    } catch (error) {
        await handle.close().catch(() => {});
        throw error;
    }
}

async function copyAndHashAsset(sourceRoot, destinationRoot, relative, expectedStat) {
    const sourcePath = resolveInside(sourceRoot, relative);
    const destinationPath = resolveInside(destinationRoot, relative);
    await ensurePrivateDirectory(path.dirname(destinationPath));
    const { handle: source, stat: opened } = await openRegularNoFollow(sourcePath, sourceRoot);
    if (opened.size !== expectedStat.size || opened.mtimeMs !== expectedStat.mtimeMs
        || opened.dev !== expectedStat.dev || opened.ino !== expectedStat.ino) {
        await source.close();
        throw new MkvHlsCacheError('CACHE_SOURCE_CHANGED', 'HLS staging asset changed before copy');
    }
    const destination = await fsp.open(destinationPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        PRIVATE_FILE_MODE);
    const digest = crypto.createHash('sha256');
    let position = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        while (position < opened.size) {
            const toRead = Math.min(buffer.length, opened.size - position);
            const result = await source.read(buffer, 0, toRead, position);
            if (!result || result.bytesRead <= 0) throw new MkvHlsCacheError('CACHE_SOURCE_CHANGED', 'HLS staging asset ended during copy');
            const chunk = buffer.subarray(0, result.bytesRead);
            digest.update(chunk);
            await writeAll(destination, chunk);
            position += result.bytesRead;
        }
        const after = await source.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.dev !== opened.dev || after.ino !== opened.ino) {
            throw new MkvHlsCacheError('CACHE_SOURCE_CHANGED', 'HLS staging asset changed during copy');
        }
        await destination.sync();
    } finally {
        await source.close();
        await destination.close();
    }
    return { path: relative, size: opened.size, sha256: digest.digest('hex') };
}

async function directorySizeNoSymlink(directory) {
    let total = 0;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        const stat = await fsp.lstat(candidate);
        if (stat.isSymbolicLink()) throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'cache contains a symlink');
        if (stat.isDirectory()) total += await directorySizeNoSymlink(candidate);
        else if (stat.isFile()) total += stat.size;
        else throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'cache contains a non-regular entry');
        if (!Number.isSafeInteger(total)) throw new MkvHlsCacheError('CACHE_QUOTA_EXCEEDED', 'cache size overflow');
    }
    return total;
}

class CompleteMkvHlsCache {
    constructor(options = {}) {
        this.root = path.resolve(boundedString(options.root, 'root', 16_384));
        this.manifestKey = parseDedicatedManifestHmacKey(options.manifestHmacKey);
        this.maxBytes = strictPositiveInteger(options.maxBytes, 'maxBytes');
        this.minFreeBytes = strictNonNegativeInteger(options.minFreeBytes || 0, 'minFreeBytes');
        this.ttlMs = strictPositiveInteger(options.ttlMs, 'ttlMs');
        if (this.ttlMs > MAX_CACHE_TTL_MS) throw new MkvHlsCacheError('INVALID_CACHE_CONFIG', 'ttlMs exceeds the 90-day bound');
        this.maxEntryBytes = strictPositiveInteger(options.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES, 'maxEntryBytes');
        this.maxFiles = strictPositiveInteger(options.maxFiles || DEFAULT_MAX_FILES, 'maxFiles');
        this.maxPlaylistBytes = strictPositiveInteger(options.maxPlaylistBytes || DEFAULT_MAX_PLAYLIST_BYTES, 'maxPlaylistBytes');
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.statfs = typeof options.statfs === 'function' ? options.statfs : (root) => fsp.statfs(root);
        this.refcounts = new Map();
        this.tail = Promise.resolve();
        this.initialized = false;
        this.rootReal = '';
        this.entriesRoot = '';
        this.tempRoot = '';
    }

    _serial(operation) {
        const result = this.tail.then(operation, operation);
        this.tail = result.catch(() => {});
        return result;
    }

    async _init() {
        if (this.initialized) return;
        this.rootReal = await ensurePrivateDirectory(this.root);
        this.entriesRoot = await ensurePrivateDirectory(path.join(this.rootReal, 'entries'));
        this.tempRoot = await ensurePrivateDirectory(path.join(this.rootReal, 'tmp'));
        assertInsideRoot(this.rootReal, this.entriesRoot);
        assertInsideRoot(this.rootReal, this.tempRoot);
        this.initialized = true;
    }

    _entryDirectory(key) {
        if (!/^[0-9a-f]{64}$/.test(key)) throw new MkvHlsCacheError('INVALID_CACHE_KEY', 'cache key is invalid');
        return path.join(this.entriesRoot, key.slice(0, 2), key);
    }

    async _readManifest(entryDirectory, expectedKey) {
        const entryStat = await fsp.lstat(entryDirectory);
        if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'cache entry is not a real directory');
        const entryReal = await fsp.realpath(entryDirectory);
        assertInsideRoot(this.rootReal, entryReal);
        const manifestPath = path.join(entryReal, 'manifest.auth.json');
        const manifestStat = await fsp.lstat(manifestPath);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024 * 1024) {
            throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest file is invalid');
        }
        let envelope;
        try { envelope = JSON.parse(await fsp.readFile(manifestPath, 'utf8')); } catch (error) {
            throw new MkvHlsCacheError('INVALID_CACHE_MANIFEST', 'cache manifest JSON is invalid', { cause: error });
        }
        const payload = validateManifestPayload(decodeManifestEnvelope(envelope, this.manifestKey), expectedKey);
        return { payload, entryReal };
    }

    async _validateEntryFiles(entryReal, payload) {
        for (const file of payload.files) {
            const candidate = resolveInside(entryReal, file.path);
            const stat = await fsp.lstat(candidate);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) {
                throw new MkvHlsCacheError('INVALID_CACHE_ENTRY', 'cache asset type or size changed');
            }
            const real = await fsp.realpath(candidate);
            assertInsideRoot(entryReal, real);
            if (file.path.toLowerCase().endsWith('.m3u8')) {
                const handle = await openVerifiedCacheAsset(entryReal, file);
                await handle.close();
            }
        }
        await validateCompleteHlsDirectory(entryReal, payload.rootPlaylist, payload.files, this.maxPlaylistBytes);
    }

    async acquire(identity) {
        return this._serial(async () => {
            await this._init();
            const derived = deriveCompleteHlsCacheKey(identity);
            const entryDirectory = this._entryDirectory(derived.key);
            const stat = await optionalLstat(entryDirectory);
            if (!stat) return { hit: false, reason: 'miss', key: derived.key };
            try {
                const { payload, entryReal } = await this._readManifest(entryDirectory, derived.key);
                if (canonicalJson(payload.components) !== canonicalJson(derived.components)) {
                    return { hit: false, reason: 'binding-mismatch', key: derived.key };
                }
                if (payload.expiresAtMs <= Number(this.now())) {
                    return { hit: false, reason: 'expired', key: derived.key };
                }
                await this._validateEntryFiles(entryReal, payload);
                this.refcounts.set(derived.key, (this.refcounts.get(derived.key) || 0) + 1);
                const accessedAt = new Date(Number(this.now()));
                await fsp.utimes(entryReal, accessedAt, accessedAt).catch(() => {});
                let released = false;
                const records = new Map(payload.files.map((file) => [file.path, file]));
                return {
                    hit: true,
                    key: derived.key,
                    rootPlaylist: payload.rootPlaylist,
                    totalBytes: payload.totalBytes,
                    openAsset: async (relative) => {
                        if (released) throw new MkvHlsCacheError('CACHE_LEASE_RELEASED', 'cache lease has already been released');
                        const safe = safeRelativeAsset(relative);
                        const record = records.get(safe);
                        if (!record) throw new MkvHlsCacheError('CACHE_ASSET_NOT_LISTED', 'asset is not part of the authenticated HLS graph');
                        return openVerifiedCacheAsset(entryReal, record);
                    },
                    release: () => {
                        if (released) return;
                        released = true;
                        const remaining = Math.max(0, (this.refcounts.get(derived.key) || 1) - 1);
                        if (remaining === 0) this.refcounts.delete(derived.key);
                        else this.refcounts.set(derived.key, remaining);
                    },
                };
            } catch (error) {
                if (error instanceof MkvHlsCacheError) return { hit: false, reason: 'invalid', key: derived.key };
                throw error;
            }
        });
    }

    async _availableBytes() {
        const stats = await this.statfs(this.rootReal);
        if (stats && Number.isSafeInteger(stats.availableBytes) && stats.availableBytes >= 0) return stats.availableBytes;
        const blockSize = Number(stats && (stats.bsize ?? stats.frsize));
        const availableBlocks = Number(stats && (stats.bavail ?? stats.bfree));
        const bytes = blockSize * availableBlocks;
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new MkvHlsCacheError('CACHE_SPACE_UNKNOWN', 'available cache space cannot be measured');
        return bytes;
    }

    async _scanEntries() {
        const records = [];
        const shards = await fsp.readdir(this.entriesRoot, { withFileTypes: true });
        for (const shard of shards) {
            if (!/^[0-9a-f]{2}$/.test(shard.name) || !shard.isDirectory() || shard.isSymbolicLink()) {
                throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'cache entries root contains an unexpected object');
            }
            const shardDirectory = path.join(this.entriesRoot, shard.name);
            const entries = await fsp.readdir(shardDirectory, { withFileTypes: true });
            for (const entry of entries) {
                if (!/^[0-9a-f]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink() || entry.name.slice(0, 2) !== shard.name) {
                    throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'cache shard contains an unexpected object');
                }
                const entryDirectory = path.join(shardDirectory, entry.name);
                const { payload, entryReal } = await this._readManifest(entryDirectory, entry.name);
                const stat = await fsp.stat(entryReal);
                records.push({
                    key: entry.name,
                    directory: entryReal,
                    bytes: await directorySizeNoSymlink(entryReal),
                    expiresAtMs: payload.expiresAtMs,
                    lastAccessMs: stat.mtimeMs,
                });
            }
        }
        return records;
    }

    async _removeEntry(record) {
        if ((this.refcounts.get(record.key) || 0) > 0) return false;
        assertInsideRoot(this.rootReal, record.directory);
        const stat = await fsp.lstat(record.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MkvHlsCacheError('UNSAFE_CACHE_PATH', 'refusing to evict an unsafe cache path');
        await fsp.rm(record.directory, { recursive: true, force: false });
        return true;
    }

    async _ensureCapacity(incomingBytes) {
        let records = await this._scanEntries();
        const now = Number(this.now());
        for (const record of records.filter((item) => item.expiresAtMs <= now)) await this._removeEntry(record);
        records = await this._scanEntries();
        const tempBytes = await directorySizeNoSymlink(this.tempRoot);
        let total = records.reduce((sum, item) => sum + item.bytes, 0) + tempBytes;
        let available = await this._availableBytes();
        const oldest = records.sort((a, b) => a.lastAccessMs - b.lastAccessMs);
        while (total + incomingBytes > this.maxBytes || available < this.minFreeBytes + incomingBytes) {
            const candidate = oldest.find((item) => (this.refcounts.get(item.key) || 0) === 0);
            if (!candidate) throw new MkvHlsCacheError('CACHE_QUOTA_EXCEEDED', 'cache quota cannot be satisfied without evicting an active entry');
            oldest.splice(oldest.indexOf(candidate), 1);
            if (await this._removeEntry(candidate)) total -= candidate.bytes;
            available = await this._availableBytes();
        }
    }

    async publishComplete(options) {
        return this._serial(async () => {
            await this._init();
            if (!options || typeof options !== 'object') throw new TypeError('publish options are required');
            validateCompletionEvidence(options.completion);
            const derived = deriveCompleteHlsCacheKey(options.identity);
            const rootPlaylist = safeRelativeAsset(options.rootPlaylist, 'root playlist');
            if (!Array.isArray(options.files) || options.files.length === 0 || options.files.length > this.maxFiles) {
                throw new MkvHlsCacheError('INVALID_CACHE_ASSETS', 'complete HLS asset list is invalid');
            }
            const names = options.files.map((item) => safeRelativeAsset(item));
            if (new Set(names).size !== names.length) throw new MkvHlsCacheError('INVALID_CACHE_ASSETS', 'complete HLS asset list contains duplicates');
            names.sort();

            const existingDirectory = this._entryDirectory(derived.key);
            if (await optionalLstat(existingDirectory)) {
                const { payload, entryReal } = await this._readManifest(existingDirectory, derived.key);
                if (canonicalJson(payload.components) !== canonicalJson(derived.components)) {
                    throw new MkvHlsCacheError('CACHE_KEY_COLLISION', 'existing cache entry has different bindings');
                }
                if (payload.expiresAtMs > Number(this.now())) {
                    await this._validateEntryFiles(entryReal, payload);
                    return { status: 'already-exists', key: derived.key, totalBytes: payload.totalBytes };
                }
                if ((this.refcounts.get(derived.key) || 0) > 0) {
                    throw new MkvHlsCacheError('CACHE_ENTRY_ACTIVE_EXPIRED', 'expired cache entry is still leased');
                }
                await this._removeEntry({ key: derived.key, directory: entryReal });
            }

            const sourceDirectory = path.resolve(boundedString(options.sourceDirectory, 'sourceDirectory', 16_384));
            const sourceStat = await fsp.lstat(sourceDirectory);
            if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new MkvHlsCacheError('UNSAFE_CACHE_ASSET', 'HLS staging root must be a real directory');
            const sourceReal = await fsp.realpath(sourceDirectory);
            const sourceSnapshots = new Map();
            let sourceBytes = 0;
            for (const relative of names) {
                const candidate = resolveInside(sourceReal, relative);
                const stat = await fsp.lstat(candidate);
                const real = await fsp.realpath(candidate);
                assertInsideRoot(sourceReal, real);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new MkvHlsCacheError('UNSAFE_CACHE_ASSET', 'HLS staging asset must be a non-empty regular non-symlink file');
                sourceBytes += stat.size;
                if (!Number.isSafeInteger(sourceBytes) || sourceBytes > this.maxEntryBytes) {
                    throw new MkvHlsCacheError('CACHE_ENTRY_TOO_LARGE', 'complete HLS entry exceeds its size bound');
                }
                sourceSnapshots.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
            }
            const reservedBytes = sourceBytes + MANIFEST_RESERVE_BYTES + names.length * 256;
            await this._ensureCapacity(reservedBytes);

            const tempDirectory = await fsp.mkdtemp(path.join(this.tempRoot, 'publish-'));
            await fsp.chmod(tempDirectory, PRIVATE_DIRECTORY_MODE);
            let promoted = false;
            try {
                const fileRecords = [];
                for (const relative of names) {
                    fileRecords.push(await copyAndHashAsset(sourceReal, tempDirectory, relative, sourceSnapshots.get(relative)));
                }
                await validateCompleteHlsDirectory(tempDirectory, rootPlaylist, fileRecords, this.maxPlaylistBytes);
                const createdAtMs = Number(this.now());
                if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0 || createdAtMs + this.ttlMs > Number.MAX_SAFE_INTEGER) {
                    throw new MkvHlsCacheError('INVALID_CACHE_CLOCK', 'cache clock is invalid');
                }
                const payload = {
                    schema: MANIFEST_SCHEMA,
                    key: derived.key,
                    components: derived.components,
                    rootPlaylist,
                    files: fileRecords,
                    totalBytes: fileRecords.reduce((sum, item) => sum + item.size, 0),
                    createdAtMs,
                    expiresAtMs: createdAtMs + this.ttlMs,
                    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
                };
                const envelope = signManifest(payload, this.manifestKey);
                const manifestPath = path.join(tempDirectory, 'manifest.auth.json');
                const manifestHandle = await fsp.open(manifestPath,
                    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
                    PRIVATE_FILE_MODE);
                try {
                    await writeAll(manifestHandle, Buffer.from(`${JSON.stringify(envelope)}\n`));
                    await manifestHandle.sync();
                } finally {
                    await manifestHandle.close();
                }
                await fsyncDirectory(tempDirectory);
                const shardDirectory = await ensurePrivateDirectory(path.dirname(existingDirectory));
                assertInsideRoot(this.rootReal, shardDirectory);
                await fsp.rename(tempDirectory, existingDirectory);
                promoted = true;
                const publishedAt = new Date(createdAtMs);
                await fsp.utimes(existingDirectory, publishedAt, publishedAt);
                await fsyncDirectory(shardDirectory);
                await this._ensureCapacity(0);
                return { status: 'published', key: derived.key, totalBytes: payload.totalBytes };
            } finally {
                if (!promoted) await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
            }
        });
    }

    async prune() {
        return this._serial(async () => {
            await this._init();
            const before = await this._scanEntries();
            const beforeBytes = before.reduce((sum, item) => sum + item.bytes, 0);
            await this._ensureCapacity(0);
            const after = await this._scanEntries();
            const afterBytes = after.reduce((sum, item) => sum + item.bytes, 0);
            return { removedEntries: before.length - after.length, removedBytes: beforeBytes - afterBytes };
        });
    }
}

module.exports = {
    CompleteMkvHlsCache,
    MkvHlsCacheError,
    canonicalJson,
    deriveCompleteHlsCacheKey,
    parseDedicatedManifestHmacKey,
};
