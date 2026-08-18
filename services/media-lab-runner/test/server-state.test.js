'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMediaLabService } = require('../src/server');

const TOKEN = 'runner-test-token-0123456789abcdef0123456789';
const ACTOR_A = 'A'.repeat(43);
const ACTOR_B = 'B'.repeat(43);

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
        value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`condition did not settle; last=${JSON.stringify(value)}`);
}

function headers(actor, json = false) {
    return {
        Authorization: `Bearer ${TOKEN}`,
        'X-Norva-Lab-Actor': actor,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
}

test('actor-scoped current state starts asynchronously, enforces the global mono-slot and cancels cleanly', async (t) => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-media-lab-server-'));
    t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
    await fs.writeFile(path.join(fixtureRoot, 'h264-closed-aac.mkv'), Buffer.alloc(4_096, 0x47));

    let gate = deferred();
    let cancelMode = false;
    const adapter = {
        async runPhysicalCase({ protocol, fixture, providerUrl, signal }) {
            assert.equal(protocol, 1);
            assert.equal(fixture.id, 'h264-closed-aac');
            if (cancelMode) {
                await new Promise((resolve, reject) => {
                    if (signal.aborted) return reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
                    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
                });
            }
            await gate.promise;
            for (let read = 0; read < fixture.provider.expectedGets; read += 1) {
                const media = await fetch(providerUrl, { headers: { Range: 'bytes=0-1023' }, signal });
                assert.equal(media.status, 206);
                await media.arrayBuffer();
            }
            return {
                protocol: 1,
                kind: 'norva-media-lab-physical-v1',
                status: 'pass',
                pipeline: fixture.expected.pipeline,
                reason: fixture.expected.runtimeReason,
                gatewayObserved: true,
                browserObserved: true,
                cleanupObserved: true,
                metrics: {
                    ttffMs: 5_000,
                    manifestReadyMs: 2_000,
                    firstSegmentMs: 2_500,
                    bufferedAheadSeconds: 8,
                    productionRateX: 2,
                    browserBufferRateX: 2,
                    rebufferCount: 0,
                    rebufferMs: 0,
                    ffmpegSpawns: 1,
                    analyzerSpawns: 0,
                    seekPassed: true,
                    audioPassed: true,
                },
            };
        },
    };
    const service = createMediaLabService({ token: TOKEN, fixtureRoot, adapter, runTimeoutMs: 5_000 });
    t.after(() => service.close());
    const { origin } = await service.listen(0);
    const endpoint = new URL('/v1/current', origin);

    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 403);
    const start = await fetch(endpoint, {
        method: 'POST',
        headers: headers(ACTOR_A, true),
        body: JSON.stringify({ protocol: 1, fixtureId: 'h264-closed-aac' }),
    });
    assert.equal(start.status, 202);
    assert.deepEqual(await start.json(), { protocol: 1, state: 'running', fixtureId: 'h264-closed-aac' });
    assert.deepEqual(await (await fetch(endpoint, { headers: headers(ACTOR_A) })).json(), {
        protocol: 1,
        state: 'running',
        fixtureId: 'h264-closed-aac',
    });

    const blocked = await fetch(endpoint, {
        method: 'POST',
        headers: headers(ACTOR_B, true),
        body: JSON.stringify({ protocol: 1, fixtureId: 'h264-closed-aac' }),
    });
    assert.equal(blocked.status, 200);
    assert.deepEqual(await blocked.json(), {
        protocol: 1,
        state: 'complete',
        fixtureId: 'h264-closed-aac',
        result: {
            protocol: 1,
            status: 'blocked',
            pipeline: 'video-copy-audio-copy',
            reason: 'runner-busy',
            ttffMs: null,
            manifestReadyMs: null,
            firstSegmentMs: null,
            bufferedAheadSeconds: null,
            productionRateX: null,
            browserBufferRateX: null,
            rebufferCount: null,
            rebufferMs: null,
            providerGets: null,
            maximumConcurrentProviderGets: null,
            ffmpegSpawns: null,
            analyzerSpawns: null,
            http458: null,
            retriesAfter458: null,
            seekPassed: false,
            audioPassed: false,
            cleanupPassed: false,
        },
    });

    gate.resolve();
    const complete = await waitFor(async () => {
        const response = await fetch(endpoint, { headers: headers(ACTOR_A) });
        const body = await response.json();
        return body.state === 'complete' ? body : null;
    });
    assert.equal(complete.fixtureId, 'h264-closed-aac');
    assert.equal(complete.result.status, 'pass');
    assert.equal(complete.result.providerGets, 2);
    assert.equal(complete.result.maximumConcurrentProviderGets, 1);
    assert.doesNotMatch(JSON.stringify(complete), /providerUrl|capability|bearer|runner-test-token/i);

    assert.equal((await fetch(endpoint, { method: 'DELETE', headers: headers(ACTOR_A) })).status, 204);
    assert.deepEqual(await (await fetch(endpoint, { headers: headers(ACTOR_A) })).json(), { protocol: 1, state: 'idle' });

    gate = deferred();
    cancelMode = true;
    const cancelStart = await fetch(endpoint, {
        method: 'POST',
        headers: headers(ACTOR_A, true),
        body: JSON.stringify({ protocol: 1, fixtureId: 'h264-closed-aac' }),
    });
    assert.equal(cancelStart.status, 202);
    assert.equal((await fetch(endpoint, { method: 'DELETE', headers: headers(ACTOR_A) })).status, 204);
    await waitFor(async () => {
        const health = await (await fetch(new URL('/health', origin), {
            headers: { Authorization: `Bearer ${TOKEN}` },
        })).json();
        return health.busy === false ? health : null;
    });
    assert.deepEqual(await (await fetch(endpoint, { headers: headers(ACTOR_A) })).json(), { protocol: 1, state: 'idle' });
});
