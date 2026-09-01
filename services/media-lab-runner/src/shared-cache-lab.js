'use strict';

const { sha256 } = require('./r2-object-store-simulator');

class SharedCacheLabError extends Error {
    constructor(code) {
        super(code);
        this.name = 'SharedCacheLabError';
        this.code = code;
    }
}

function boundedIdentity(value, field) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000\r\n]/.test(value)) {
        throw new SharedCacheLabError(`SHARED_CACHE_${field.toUpperCase()}_INVALID`);
    }
    return value;
}

function contentKey(value) {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(normalized)) throw new SharedCacheLabError('SHARED_CACHE_CONTENT_KEY_INVALID');
    return normalized;
}

function assetPath(value) {
    const normalized = typeof value === 'string' ? value : '';
    if (
        !normalized
        || normalized.length > 512
        || normalized.startsWith('/')
        || normalized.includes('\\')
        || normalized.split('/').some((part) => !part || part === '.' || part === '..')
        || /[\u0000-\u001f\u007f]/.test(normalized)
    ) throw new SharedCacheLabError('SHARED_CACHE_ASSET_PATH_INVALID');
    return normalized;
}

function canonicalJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (!value || typeof value !== 'object') throw new SharedCacheLabError('SHARED_CACHE_MANIFEST_INVALID');
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function bindingKey({ tenantId, sourceId, variantId }) {
    return [
        boundedIdentity(tenantId, 'tenant_id'),
        boundedIdentity(sourceId, 'source_id'),
        boundedIdentity(variantId, 'variant_id'),
    ].join('\u0000');
}

function sourceKey(tenantId, sourceId) {
    return `${boundedIdentity(tenantId, 'tenant_id')}\u0000${boundedIdentity(sourceId, 'source_id')}`;
}

class SharedHlsCacheLab {
    #store;
    #objects = new Map();
    #bindings = new Map();
    #sources = new Map();

    constructor({ objectStore }) {
        if (!objectStore || typeof objectStore.put !== 'function' || typeof objectStore.get !== 'function') {
            throw new SharedCacheLabError('SHARED_CACHE_OBJECT_STORE_REQUIRED');
        }
        this.#store = objectStore;
    }

    snapshot() {
        return Object.freeze({
            readyObjects: this.#objects.size,
            bindings: this.#bindings.size,
            sources: this.#sources.size,
            objectStore: this.#store.snapshot(),
        });
    }

    setSourceState({ tenantId, sourceId, enabled, visible }) {
        const key = sourceKey(tenantId, sourceId);
        if (typeof enabled !== 'boolean' || typeof visible !== 'boolean') {
            throw new SharedCacheLabError('SHARED_CACHE_SOURCE_STATE_INVALID');
        }
        this.#sources.set(key, Object.freeze({ enabled, visible }));
    }

    bind({ tenantId, sourceId, variantId, contentKey: value }) {
        const key = bindingKey({ tenantId, sourceId, variantId });
        const normalizedContentKey = contentKey(value);
        if (!this.#objects.has(normalizedContentKey)) throw new SharedCacheLabError('SHARED_CACHE_OBJECT_NOT_READY');
        const state = this.#sources.get(sourceKey(tenantId, sourceId));
        if (!state?.enabled || !state.visible) throw new SharedCacheLabError('SHARED_CACHE_SOURCE_NOT_AUTHORIZED');
        this.#bindings.set(key, normalizedContentKey);
    }

    revoke({ tenantId, sourceId, variantId }) {
        return this.#bindings.delete(bindingKey({ tenantId, sourceId, variantId }));
    }

    async publishComplete({ contentKey: value, rootPlaylist, assets, sourceEof, ffmpegExitCode }) {
        const normalizedContentKey = contentKey(value);
        if (sourceEof !== true || ffmpegExitCode !== 0) {
            throw new SharedCacheLabError('SHARED_CACHE_INCOMPLETE_REJECTED');
        }
        const normalizedRootPlaylist = assetPath(rootPlaylist);
        if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
            throw new SharedCacheLabError('SHARED_CACHE_ASSETS_INVALID');
        }
        const entries = Object.entries(assets)
            .map(([name, body]) => [assetPath(name), Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body), 'utf8')])
            .sort(([left], [right]) => left.localeCompare(right));
        if (entries.length === 0 || !entries.some(([name]) => name === normalizedRootPlaylist)) {
            throw new SharedCacheLabError('SHARED_CACHE_ASSETS_INVALID');
        }
        const records = entries.map(([name, body]) => Object.freeze({
            path: name,
            key: `objects/${normalizedContentKey}/assets/${sha256(name)}`,
            size: body.length,
            sha256: sha256(body),
        }));
        const graph = {
            protocol: 1,
            contentKey: normalizedContentKey,
            rootPlaylist: normalizedRootPlaylist,
            files: records,
            completion: { sourceEof: true, ffmpegExitCode: 0 },
        };
        const graphJson = canonicalJson(graph);
        const graphSha256 = sha256(graphJson);
        const existing = this.#objects.get(normalizedContentKey);
        if (existing) {
            if (existing.graphSha256 !== graphSha256) throw new SharedCacheLabError('SHARED_CACHE_CONTENT_KEY_COLLISION');
            return Object.freeze({ status: 'already-ready', contentKey: normalizedContentKey, graphSha256 });
        }

        for (let index = 0; index < entries.length; index += 1) {
            const [, body] = entries[index];
            const record = records[index];
            await this.#store.put(record.key, body, {
                sha256: record.sha256,
                metadata: { kind: 'hls-asset', 'content-key': normalizedContentKey },
            });
        }
        const manifestKey = `objects/${normalizedContentKey}/manifest.json`;
        await this.#store.put(manifestKey, `${graphJson}\n`, {
            sha256: sha256(`${graphJson}\n`),
            metadata: { kind: 'hls-manifest', 'content-key': normalizedContentKey },
        });
        this.#objects.set(normalizedContentKey, Object.freeze({
            contentKey: normalizedContentKey,
            graphSha256,
            manifestKey,
            graph,
        }));
        return Object.freeze({ status: 'published', contentKey: normalizedContentKey, graphSha256 });
    }

    async authorize({ tenantId, sourceId, variantId }) {
        const source = this.#sources.get(sourceKey(tenantId, sourceId));
        if (!source?.enabled || !source.visible) throw new SharedCacheLabError('SHARED_CACHE_ACCESS_DENIED');
        const normalizedBindingKey = bindingKey({ tenantId, sourceId, variantId });
        const normalizedContentKey = this.#bindings.get(normalizedBindingKey);
        if (!normalizedContentKey) throw new SharedCacheLabError('SHARED_CACHE_ACCESS_DENIED');
        const object = this.#objects.get(normalizedContentKey);
        if (!object) throw new SharedCacheLabError('SHARED_CACHE_OBJECT_NOT_READY');
        const manifestObject = await this.#store.get(object.manifestKey);
        if (!manifestObject || sha256(manifestObject.body.toString('utf8').trim()) !== object.graphSha256) {
            throw new SharedCacheLabError('SHARED_CACHE_MANIFEST_INVALID');
        }
        const allowedAssets = new Map(object.graph.files.map((record) => [record.path, record]));
        return Object.freeze({
            contentKey: normalizedContentKey,
            rootPlaylist: object.graph.rootPlaylist,
            readAsset: async (name) => {
                const record = allowedAssets.get(assetPath(name));
                if (!record) throw new SharedCacheLabError('SHARED_CACHE_ASSET_DENIED');
                const stored = await this.#store.get(record.key);
                if (!stored || stored.sha256 !== record.sha256 || stored.size !== record.size) {
                    throw new SharedCacheLabError('SHARED_CACHE_ASSET_CORRUPT');
                }
                return Buffer.from(stored.body);
            },
        });
    }
}

module.exports = Object.freeze({
    SharedHlsCacheLab,
    SharedCacheLabError,
    canonicalJson,
});
