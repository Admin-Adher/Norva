'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    PrivateR2Simulator,
    R2SimulatorError,
    sha256,
} = require('../src/r2-object-store-simulator');
const {
    SharedHlsCacheLab,
    SharedCacheLabError,
} = require('../src/shared-cache-lab');

async function tempRoot(t, prefix) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

function completeAssets(marker = 'shared-segment') {
    return Object.freeze({
        'playlist.m3u8': '#EXTM3U\n#EXTINF:2,\nsegment-00001.ts\n#EXT-X-ENDLIST\n',
        'segment-00001.ts': Buffer.from(marker),
    });
}

test('private R2 simulator is immutable, strongly readable and fail closed while unavailable', async (t) => {
    const store = new PrivateR2Simulator({ root: await tempRoot(t, 'norva-r2-simulator-') });
    const body = Buffer.from('immutable-object');
    const created = await store.put('objects/aa/asset', body, {
        sha256: sha256(body),
        metadata: { kind: 'hls-asset' },
    });
    assert.equal(created.status, 'created');
    assert.equal((await store.head('objects/aa/asset')).sha256, sha256(body));
    assert.deepEqual((await store.get('objects/aa/asset')).body, body);
    assert.equal((await store.put('objects/aa/asset', body, {
        metadata: { kind: 'hls-asset' },
    })).status, 'already-exists');
    await assert.rejects(
        () => store.put('objects/aa/asset', Buffer.from('different')),
        (error) => error instanceof R2SimulatorError && error.code === 'R2_SIMULATOR_IMMUTABLE_CONFLICT',
    );
    await assert.rejects(
        () => store.put('objects/aa/asset', body, { metadata: { kind: 'different-kind' } }),
        (error) => error instanceof R2SimulatorError && error.code === 'R2_SIMULATOR_IMMUTABLE_CONFLICT',
    );
    store.setUnavailable(true);
    await assert.rejects(
        () => store.get('objects/aa/asset'),
        (error) => error instanceof R2SimulatorError && error.code === 'R2_SIMULATOR_UNAVAILABLE',
    );
    store.setUnavailable(false);
    assert.equal(await store.delete('objects/aa/asset'), true);
    assert.equal(await store.head('objects/aa/asset'), null);
});

test('two authorized tenants reuse one complete object while bindings remain isolated', async (t) => {
    const store = new PrivateR2Simulator({ root: await tempRoot(t, 'norva-shared-cache-') });
    const cache = new SharedHlsCacheLab({ objectStore: store });
    const key = 'ab'.repeat(32);
    const publication = await cache.publishComplete({
        contentKey: key,
        rootPlaylist: 'playlist.m3u8',
        assets: completeAssets(),
        sourceEof: true,
        ffmpegExitCode: 0,
    });
    assert.equal(publication.status, 'published');
    assert.equal((await cache.publishComplete({
        contentKey: key,
        rootPlaylist: 'playlist.m3u8',
        assets: completeAssets(),
        sourceEof: true,
        ffmpegExitCode: 0,
    })).status, 'already-ready');

    for (const identity of [
        { tenantId: 'tenant-a', sourceId: 'source-a', variantId: 'variant-1' },
        { tenantId: 'tenant-b', sourceId: 'source-b', variantId: 'variant-9' },
    ]) {
        cache.setSourceState({ tenantId: identity.tenantId, sourceId: identity.sourceId, enabled: true, visible: true });
        cache.bind({ ...identity, contentKey: key });
    }
    const tenantA = await cache.authorize({ tenantId: 'tenant-a', sourceId: 'source-a', variantId: 'variant-1' });
    const tenantB = await cache.authorize({ tenantId: 'tenant-b', sourceId: 'source-b', variantId: 'variant-9' });
    assert.deepEqual(await tenantA.readAsset('segment-00001.ts'), Buffer.from('shared-segment'));
    assert.deepEqual(await tenantB.readAsset('segment-00001.ts'), Buffer.from('shared-segment'));
    assert.equal(tenantA.contentKey, tenantB.contentKey);
    assert.deepEqual(cache.snapshot(), {
        readyObjects: 1,
        bindings: 2,
        sources: 2,
        objectStore: {
            puts: 3,
            gets: 4,
            heads: 0,
            deletes: 0,
            idempotentPuts: 0,
            conflicts: 0,
            unavailable: 0,
        },
    });

    cache.setSourceState({ tenantId: 'tenant-a', sourceId: 'source-a', enabled: false, visible: false });
    await assert.rejects(
        () => cache.authorize({ tenantId: 'tenant-a', sourceId: 'source-a', variantId: 'variant-1' }),
        (error) => error instanceof SharedCacheLabError && error.code === 'SHARED_CACHE_ACCESS_DENIED',
    );
    assert.deepEqual(
        await (await cache.authorize({ tenantId: 'tenant-b', sourceId: 'source-b', variantId: 'variant-9' }))
            .readAsset('segment-00001.ts'),
        Buffer.from('shared-segment'),
    );
    await assert.rejects(
        () => cache.authorize({ tenantId: 'tenant-c', sourceId: 'source-c', variantId: 'variant-1' }),
        (error) => error instanceof SharedCacheLabError && error.code === 'SHARED_CACHE_ACCESS_DENIED',
    );
});

test('a failed asset upload never exposes a ready manifest or bindable object', async (t) => {
    const store = new PrivateR2Simulator({
        root: await tempRoot(t, 'norva-shared-cache-failure-'),
        failPutOrdinals: [2],
    });
    const cache = new SharedHlsCacheLab({ objectStore: store });
    const key = 'cd'.repeat(32);
    await assert.rejects(
        () => cache.publishComplete({
            contentKey: key,
            rootPlaylist: 'playlist.m3u8',
            assets: completeAssets(),
            sourceEof: true,
            ffmpegExitCode: 0,
        }),
        (error) => error instanceof R2SimulatorError && error.code === 'R2_SIMULATOR_UNAVAILABLE',
    );
    assert.equal(cache.snapshot().readyObjects, 0);
    assert.equal(await store.head(`objects/${key}/manifest.json`), null);
    cache.setSourceState({ tenantId: 'tenant-a', sourceId: 'source-a', enabled: true, visible: true });
    assert.throws(
        () => cache.bind({ tenantId: 'tenant-a', sourceId: 'source-a', variantId: 'variant-a', contentKey: key }),
        (error) => error instanceof SharedCacheLabError && error.code === 'SHARED_CACHE_OBJECT_NOT_READY',
    );
});

test('an identical content key cannot be rebound to a different HLS graph', async (t) => {
    const store = new PrivateR2Simulator({ root: await tempRoot(t, 'norva-shared-cache-collision-') });
    const cache = new SharedHlsCacheLab({ objectStore: store });
    const key = 'ef'.repeat(32);
    await cache.publishComplete({
        contentKey: key,
        rootPlaylist: 'playlist.m3u8',
        assets: completeAssets('first'),
        sourceEof: true,
        ffmpegExitCode: 0,
    });
    await assert.rejects(
        () => cache.publishComplete({
            contentKey: key,
            rootPlaylist: 'playlist.m3u8',
            assets: completeAssets('second'),
            sourceEof: true,
            ffmpegExitCode: 0,
        }),
        (error) => error instanceof SharedCacheLabError && error.code === 'SHARED_CACHE_CONTENT_KEY_COLLISION',
    );
});
