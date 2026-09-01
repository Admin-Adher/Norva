'use strict';

const crypto = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_GET_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([100, 500]);

class PrivateMediaCacheStoreError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'PrivateMediaCacheStoreError';
        this.code = code;
        this.status = options.status || 0;
        this.retryable = options.retryable === true;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeObjectKey(value) {
    const key = typeof value === 'string' ? value : '';
    if (!key || Buffer.byteLength(key, 'utf8') > 1024 || key.startsWith('/') || key.includes('\\')
        || /[\u0000-\u001f\u007f]/.test(key)
        || key.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_OBJECT_KEY_INVALID', 'private media cache object key is invalid');
    }
    return key;
}

function normalizeDigest(value, field) {
    const digest = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_DIGEST_INVALID', `${field} is invalid`);
    }
    return digest;
}

function normalizeMetadata(value) {
    if (value === undefined) return Object.freeze({});
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_METADATA_INVALID', 'private media cache metadata is invalid');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_METADATA_INVALID', 'private media cache metadata is invalid');
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > 32) throw new PrivateMediaCacheStoreError('MEDIA_CACHE_METADATA_INVALID', 'private media cache metadata is too large');
    const normalized = {};
    for (const [key, metadataValue] of entries) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)
            || typeof metadataValue !== 'string'
            || Buffer.byteLength(metadataValue, 'utf8') > 1024
            || /[\u0000\r\n]/.test(metadataValue)) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_METADATA_INVALID', 'private media cache metadata is invalid');
        }
        normalized[key] = metadataValue;
    }
    return Object.freeze(normalized);
}

function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (!value || typeof value !== 'object') {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_METADATA_INVALID', 'private media cache metadata is invalid');
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function boundedPositiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_CLIENT_CONFIG_INVALID', `${field} is invalid`);
    }
    return number;
}

function normalizeBaseUrl(value) {
    let url;
    try { url = new URL(String(value || '')); } catch (_) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_CLIENT_CONFIG_INVALID', 'private media cache Worker URL is invalid');
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_CLIENT_CONFIG_INVALID', 'private media cache Worker URL is not pinned safely');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

function normalizeServiceToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (token.length < 32 || token.length > 4096 || /[\u0000\r\n]/.test(token)) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_CLIENT_CONFIG_INVALID', 'private media cache service token is invalid');
    }
    return token;
}

async function readResponseBodyBounded(response, maximumBytes, timeoutMs) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && (declared < 0 || declared > maximumBytes)) {
        throw new PrivateMediaCacheStoreError('MEDIA_CACHE_RESPONSE_TOO_LARGE', 'private media cache response exceeds its bound', { status: response.status });
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let timeout;
    const timeoutFailure = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new PrivateMediaCacheStoreError(
            'MEDIA_CACHE_WORKER_UNAVAILABLE',
            'private media cache response body timed out',
            { status: response.status, retryable: true },
        )), timeoutMs);
    });
    try {
        while (true) {
            const { value, done } = await Promise.race([reader.read(), timeoutFailure]);
            if (done) break;
            const chunk = Buffer.from(value || []);
            total += chunk.length;
            if (total > maximumBytes) {
                await reader.cancel().catch(() => {});
                throw new PrivateMediaCacheStoreError('MEDIA_CACHE_RESPONSE_TOO_LARGE', 'private media cache response exceeds its bound', { status: response.status });
            }
            chunks.push(chunk);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally {
        clearTimeout(timeout);
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class PrivateMediaCacheStoreClient {
    constructor(options = {}) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl);
        this.serviceToken = normalizeServiceToken(options.serviceToken);
        this.fetch = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
        if (typeof this.fetch !== 'function') {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_CLIENT_CONFIG_INVALID', 'fetch is unavailable');
        }
        this.timeoutMs = boundedPositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', 120_000);
        this.maxPutBytes = boundedPositiveInteger(options.maxPutBytes ?? DEFAULT_MAX_PUT_BYTES, 'maxPutBytes');
        this.maxGetBytes = boundedPositiveInteger(options.maxGetBytes ?? DEFAULT_MAX_GET_BYTES, 'maxGetBytes');
        const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
        if (!Array.isArray(delays) || delays.length > 5
            || delays.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 10_000)) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_CLIENT_CONFIG_INVALID', 'retryDelaysMs is invalid');
        }
        this.retryDelaysMs = [...delays];
    }

    _url(key) {
        const encoded = Buffer.from(normalizeObjectKey(key), 'utf8').toString('base64url');
        return new URL(`internal/v1/objects/${encoded}`, this.baseUrl);
    }

    async _fetchWithRetry(url, requestFactory) {
        let lastError;
        for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const response = await this.fetch(url, requestFactory(controller.signal));
                if (response.status < 500 || attempt === this.retryDelaysMs.length) return response;
                await response.body?.cancel().catch(() => {});
                lastError = new PrivateMediaCacheStoreError('MEDIA_CACHE_WORKER_UNAVAILABLE', 'private media cache Worker is unavailable', {
                    status: response.status,
                    retryable: true,
                });
            } catch (error) {
                if (attempt === this.retryDelaysMs.length) {
                    throw new PrivateMediaCacheStoreError('MEDIA_CACHE_WORKER_UNAVAILABLE', 'private media cache Worker request failed', {
                        cause: error,
                        retryable: true,
                    });
                }
                lastError = error;
            } finally {
                clearTimeout(timeout);
            }
            await delay(this.retryDelaysMs[attempt]);
        }
        throw lastError;
    }

    async put(keyValue, bodyValue, options = {}) {
        const key = normalizeObjectKey(keyValue);
        const body = Buffer.isBuffer(bodyValue) ? Buffer.from(bodyValue) : null;
        if (!body || body.length <= 0 || body.length > this.maxPutBytes) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_BODY_INVALID', 'private media cache upload body is invalid');
        }
        const digest = sha256(body);
        if (options.sha256 !== undefined && normalizeDigest(options.sha256, 'sha256') !== digest) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_DIGEST_MISMATCH', 'private media cache upload digest does not match its body');
        }
        const metadata = normalizeMetadata(options.metadata);
        const contentType = typeof options.contentType === 'string' && options.contentType.length <= 256
            && !/[\u0000\r\n]/.test(options.contentType)
            ? options.contentType
            : 'application/octet-stream';
        const url = this._url(key);
        const response = await this._fetchWithRetry(url, (signal) => ({
            method: 'PUT',
            signal,
            headers: {
                authorization: `Bearer ${this.serviceToken}`,
                'content-length': String(body.length),
                'content-type': contentType,
                'if-none-match': '*',
                'x-norva-content-sha256': digest,
                'x-norva-object-metadata': Buffer.from(canonicalJson(metadata)).toString('base64url'),
            },
            body,
        }));
        const responseBody = await readResponseBodyBounded(response, 64 * 1024, this.timeoutMs);
        if (![200, 201].includes(response.status)) {
            const code = response.status === 409 || response.status === 412
                ? 'MEDIA_CACHE_IMMUTABLE_CONFLICT'
                : ([401, 403].includes(response.status) ? 'MEDIA_CACHE_WORKER_AUTH_FAILED' : 'MEDIA_CACHE_PUT_FAILED');
            throw new PrivateMediaCacheStoreError(code, 'private media cache upload was rejected', {
                status: response.status,
                retryable: response.status >= 500,
            });
        }
        let payload;
        try { payload = JSON.parse(responseBody.toString('utf8')); } catch (error) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_RESPONSE_INVALID', 'private media cache upload response is invalid', { cause: error });
        }
        if (!payload || payload.ok !== true || !['created', 'already-exists'].includes(payload.status)
            || payload.key !== key || payload.sha256 !== digest || payload.size !== body.length) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_RESPONSE_INVALID', 'private media cache upload response is not bound to the request');
        }
        return Object.freeze({ status: payload.status, key, sha256: digest, size: body.length });
    }

    async get(keyValue) {
        const key = normalizeObjectKey(keyValue);
        const url = this._url(key);
        const response = await this._fetchWithRetry(url, (signal) => ({
            method: 'GET',
            signal,
            headers: { authorization: `Bearer ${this.serviceToken}` },
        }));
        if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return null;
        }
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => {});
            const code = [401, 403].includes(response.status) ? 'MEDIA_CACHE_WORKER_AUTH_FAILED' : 'MEDIA_CACHE_GET_FAILED';
            throw new PrivateMediaCacheStoreError(code, 'private media cache read was rejected', {
                status: response.status,
                retryable: response.status >= 500,
            });
        }
        const body = await readResponseBodyBounded(response, this.maxGetBytes, this.timeoutMs);
        const digest = normalizeDigest(response.headers.get('x-norva-content-sha256'), 'response sha256');
        if (sha256(body) !== digest) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_DIGEST_MISMATCH', 'private media cache response digest is invalid');
        }
        const declaredSize = Number(response.headers.get('content-length'));
        if (!Number.isSafeInteger(declaredSize) || declaredSize !== body.length) {
            throw new PrivateMediaCacheStoreError('MEDIA_CACHE_RESPONSE_INVALID', 'private media cache response size is invalid');
        }
        let metadata = {};
        const encodedMetadata = response.headers.get('x-norva-object-metadata');
        if (encodedMetadata) {
            try {
                if (!/^[A-Za-z0-9_-]+$/.test(encodedMetadata)
                    || Buffer.from(encodedMetadata, 'base64url').toString('base64url') !== encodedMetadata) {
                    throw new Error('metadata is not canonical base64url');
                }
                metadata = normalizeMetadata(JSON.parse(Buffer.from(encodedMetadata, 'base64url').toString('utf8')));
            } catch (error) {
                if (error instanceof PrivateMediaCacheStoreError) throw error;
                throw new PrivateMediaCacheStoreError('MEDIA_CACHE_RESPONSE_INVALID', 'private media cache metadata response is invalid', { cause: error });
            }
        }
        return Object.freeze({ key, body, size: body.length, sha256: digest, metadata });
    }
}

module.exports = {
    PrivateMediaCacheStoreClient,
    PrivateMediaCacheStoreError,
    normalizeObjectKey,
};
