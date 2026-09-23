const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHlsOutputControl, boundedHlsArgs } = require('../services/media-gateway/src/bounded-hls-output');

test('VOD output pauses before the rolling window can overtake a stalled client and resumes on consumption', async () => {
    const signals = []; let names = Array.from({ length: 18 }, (_, i) => `segment-${String(i).padStart(5, '0')}.ts`);
    const io = { readdir: async () => names, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1024 }),
        statfs: async () => ({ bavail: 1024 ** 3, bsize: 4096 }) };
    const c = createHlsOutputControl({ root: '/test', child: { exitCode: null, kill: s => signals.push(s) },
        io, intervalMs: 60000, onFailure: () => assert.fail('unexpected failure') });
    try {
        await c.tick(); assert.deepEqual(signals, ['SIGSTOP']);
        c.served('segment-00004.ts'); assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);
        c.served('../segment-99999.ts'); assert.equal(c.snapshot().consumed, 4);
        names = [...names, 'segment-00025.ts']; await c.tick(); assert.equal(signals.at(-1), 'SIGSTOP');
        c.stop(); assert.equal(signals.at(-1), 'SIGCONT');
    } finally { c.stop(); }
});

test('storage overrun terminates only its producer and unpauses it for teardown', async () => {
    const signals = [], failures = [];
    const c = createHlsOutputControl({ root: '/test', child: { exitCode: null, kill: s => signals.push(s) },
        maxBytes: 100, io: { readdir: async () => ['segment-00050.ts'],
            lstat: async () => ({ size: 101, isFile: () => true, isSymbolicLink: () => false }),
            statfs: async () => ({ bavail: 1024 ** 3, bsize: 4096 }) },
        intervalMs: 60000, onFailure: e => failures.push(e) });
    await c.tick(); await c.tick();
    assert.deepEqual(failures, ['HLS_OUTPUT_STORAGE_CAPACITY']); assert.deepEqual(signals, ['SIGSTOP', 'SIGCONT']);
    c.stop();
});

test('rolling output is explicit and never declares an EVENT playlist or a complete cache', () => {
    assert(!boundedHlsArgs(true).includes('event'));
    assert(boundedHlsArgs(true).includes('independent_segments+temp_file+delete_segments'));
    assert(boundedHlsArgs(false).includes('event'));
});
