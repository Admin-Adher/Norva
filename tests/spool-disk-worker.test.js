'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { reserveSpoolDisk } = require('../services/media-gateway/src/spool-disk-budget');

test('real worker enforces aggregate disk quota, frees leases once, and checks actual space', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-worker-budget-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const options = { root, bytes: 1024, maxBytes: 3072, minFreeBytes: 0 };
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
        reserveSpoolDisk({ ...options, name: `spool-worker-${i}` })));
    const leases = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    assert.equal(leases.length, 3);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'SPOOL_GLOBAL_QUOTA'));
    await Promise.all(leases.map(lease => lease.checkFreeSpace()));
    await Promise.all(leases.flatMap(lease => [lease.release(), lease.release()]));
    assert.deepEqual(await fs.readdir(path.join(root, '.reservations')), []);
    await assert.rejects(reserveSpoolDisk({ ...options, name: 'spool-no-space', minFreeBytes: Number.MAX_SAFE_INTEGER }),
        { code: 'SPOOL_DISK_RESERVE' });
    const next = await reserveSpoolDisk({ ...options, name: 'spool-recovered' });
    await next.release();
});

test('real worker retains legacy files and fails closed on corrupt durable reservations', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-worker-legacy-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const options = { root, bytes: 10, maxBytes: 15, minFreeBytes: 0, name: 'spool-next' };
    await fs.writeFile(path.join(root, 'spool-orphan.bin'), Buffer.alloc(10));
    await assert.rejects(reserveSpoolDisk(options), { code: 'SPOOL_GLOBAL_QUOTA' });
    await fs.writeFile(path.join(root, '.reservations', '0'.repeat(32) + '.json'), '{truncated');
    await assert.rejects(reserveSpoolDisk({ ...options, maxBytes: 100 }), { code: 'SPOOL_BUDGET_IO' });
    assert.equal((await fs.readdir(path.join(root, '.reservations'))).length, 1);
});

test('worker crash rejects pending operations and future admissions without releasing durable reservations', async () => {
    const filename = require.resolve('../services/media-gateway/src/spool-disk-budget');
    const source = await fs.readFile(filename, 'utf8');
    const sent = []; let created = 0, fake;
    class FakeWorker extends EventEmitter {
        constructor() { super(); created++; fake = this; }
        ref() {} unref() {}
        postMessage(message) { sent.push(message); }
    }
    const exports = { exports: {} };
    vm.runInNewContext(source, { require: name => name === 'node:worker_threads'
        ? { Worker: FakeWorker, isMainThread: true } : require(name),
        module: exports, __filename: filename, setTimeout });
    const reserve = exports.exports.reserveSpoolDisk;
    const pending = reserve({ root: '/private-budget', name: 'spool-a', bytes: 10, maxBytes: 20, minFreeBytes: 0 });
    const rejected = assert.rejects(pending, { code: 'SPOOL_BUDGET_WORKER_UNAVAILABLE' });
    fake.emit('error', new Error('private diagnostic must not escape'));
    fake.emit('exit', 1);
    await rejected;
    await assert.rejects(reserve({}), { code: 'SPOOL_BUDGET_WORKER_UNAVAILABLE' });
    assert.equal(created, 1);
    assert.deepEqual(sent.map(message => message.operation), ['reserve']);
});

test('worker protocol coalesces duplicate release and retries an explicitly failed release', async () => {
    const filename = require.resolve('../services/media-gateway/src/spool-disk-budget');
    const sent = []; let fake;
    class FakeWorker extends EventEmitter {
        constructor() { super(); fake = this; }
        ref() {} unref() {}
        postMessage(message) { sent.push(message); }
    }
    const exports = { exports: {} };
    vm.runInNewContext(await fs.readFile(filename, 'utf8'), { require: name => name === 'node:worker_threads'
        ? { Worker: FakeWorker, isMainThread: true } : require(name), module: exports, __filename: filename, setTimeout });
    const pending = exports.exports.reserveSpoolDisk({});
    fake.emit('message', { id: sent[0].id, value: 'synthetic-lease' });
    const lease = await pending;
    const first = lease.release(); assert.equal(lease.release(), first);
    const rejection = assert.rejects(first, { code: 'EIO' });
    fake.emit('message', { id: sent[1].id, error: 'EIO' }); await rejection;
    const retry = lease.release();
    fake.emit('message', { id: sent[2].id }); await retry; await lease.release();
    assert.deepEqual(sent.map(message => message.operation), ['reserve', 'release', 'release']);
});
