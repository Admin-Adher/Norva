'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MaintenanceFence } = require('../services/media-gateway/src/maintenance-fence');
const job = { id: 'one', kind: 'storyboard', durable: true, checkpointDigest: 'signed-checkpoint' };
const snapshot = () => ({ activeOperations: 0, viewerSessions: 0, jobs: [job] });
const persisted = async () => [{ id: job.id, checkpointDigest: job.checkpointDigest }];
test('saved deferred queue is restartable while new admissions remain fenced', async () => {
    const f = new MaintenanceFence(), token = f.begin();
    assert.equal(f.enter(), null);
    assert.equal(await f.verify(token, { snapshot, persisted }), true);
    let closed = false;
    f.commit(token, snapshot, () => { closed = true; assert.equal(f.enter(), null); });
    assert.equal(closed, true);
    assert.throws(() => f.cancel(token), /COMMITTED/);
});
test('an admission waiting on an async provider check prevents readiness', async () => {
    const f = new MaintenanceFence(), release = f.enter(), token = f.begin();
    assert.equal(await f.verify(token, { snapshot, persisted }), false);
    release(); release();
    assert.equal(await f.verify(token, { snapshot, persisted }), true);
});
test('missing or divergent durable checkpoints, active work, and viewers fail closed', async () => {
    for (const changes of [{ activeOperations: 1 }, { viewerSessions: 1 }, { jobs: [{ ...job, durable: false }] }]) {
        const f = new MaintenanceFence(), token = f.begin();
        assert.equal(await f.verify(token, { snapshot: () => ({ ...snapshot(), ...changes }), persisted }), false);
    }
    for (const saved of [[], [{ id: 'one', checkpointDigest: 'old' }]]) {
        const f = new MaintenanceFence(), token = f.begin();
        assert.equal(await f.verify(token, { snapshot, persisted: async () => saved }), false);
    }
});
test('expiry during checkpoint IO cannot authorize a stale restart', async () => {
    let time = 0, wakes = 0;
    const f = new MaintenanceFence({ now: () => time, ttlMs: 1000, wake: () => wakes++ }), token = f.begin();
    await assert.rejects(f.verify(token, { snapshot, persisted: async () => { time = 1001; return persisted(); } }), /LEASE_LOST/);
    assert.equal(wakes, 1);
    assert.equal(typeof f.enter(), 'function');
});
test('state drift after readiness and foreign cancellation cannot restart or unlock', async () => {
    const f = new MaintenanceFence(), token = f.begin();
    await f.verify(token, { snapshot, persisted });
    assert.throws(() => f.commit(token, () => ({ ...snapshot(), viewerSessions: 1 }), () => assert.fail()), /NOT_READY/);
    assert.throws(() => f.cancel('foreign'), /LEASE_LOST/);
    assert.equal(f.enter(), null);
    f.cancel(token);
    assert.equal(typeof f.enter(), 'function');
});
