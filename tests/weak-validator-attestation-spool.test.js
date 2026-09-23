'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    WeakValidatorAttestationSpoolError,
    createWeakValidatorAttestationSpool,
} = require('../services/media-gateway/src/weakValidatorAttestationSpool');

async function tempRoot() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'norva-weak-spool-'));
}

test('weak-validator spool hashes authoritative bytes and promotes atomically', async () => {
    const root = await tempRoot();
    const chunks = [Buffer.from('Norva '), Buffer.from('single-response '), Buffer.from('spool')];
    const expected = Buffer.concat(chunks);
    const spool = await createWeakValidatorAttestationSpool({
        root,
        id: 'session-1',
        expectedBytes: expected.length,
        minFreeBytes: 0,
        statfs: async () => ({ availableBytes: 10_000_000 }),
    });
    try {
        for (const chunk of chunks) await spool.append(chunk);
        assert.equal(fs.existsSync(spool.tempPath), true);
        const result = await spool.finalize();
        assert.equal(result.bytes, expected.length);
        assert.equal(result.contentSha256, crypto.createHash('sha256').update(expected).digest('hex'));
        assert.equal(spool.finalized, true);
        assert.equal(spool.snapshot().state, 'finalized');
        assert.equal(spool.snapshot().bytesWritten, expected.length);
        assert.equal(fs.existsSync(result.path), true);
        assert.equal(fs.existsSync(spool.tempPath), false);
        assert.deepEqual(await fsp.readFile(result.path), expected);
        assert.deepEqual(await spool.finalize(), result);
    } finally {
        await spool.cleanup();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('weak-validator spool fails closed on size mismatch and removes partial bytes', async () => {
    const root = await tempRoot();
    const spool = await createWeakValidatorAttestationSpool({
        root,
        id: 'session-2',
        expectedBytes: 4,
        minFreeBytes: 0,
        statfs: async () => ({ availableBytes: 10_000_000 }),
    });
    await spool.append(Buffer.from('abc'));
    await assert.rejects(
        spool.finalize(),
        (error) => error instanceof WeakValidatorAttestationSpoolError
            && error.code === 'SPOOL_SIZE_MISMATCH',
    );
    assert.equal(spool.aborted, true);
    assert.equal(fs.existsSync(spool.tempPath), false);
    await fsp.rm(root, { recursive: true, force: true });
});

test('weak-validator spool enforces object and free-space bounds before provider bytes are retained', async () => {
    const root = await tempRoot();
    await assert.rejects(
        createWeakValidatorAttestationSpool({
            root,
            id: 'session-3',
            expectedBytes: 10,
            maxBytes: 9,
            minFreeBytes: 0,
            statfs: async () => ({ availableBytes: 10_000_000 }),
        }),
        (error) => error.code === 'SPOOL_QUOTA_EXCEEDED',
    );
    await assert.rejects(
        createWeakValidatorAttestationSpool({
            root,
            id: 'session-4',
            expectedBytes: 10,
            minFreeBytes: 100,
            statfs: async () => ({ availableBytes: 109 }),
        }),
        (error) => error.code === 'SPOOL_DISK_RESERVE',
    );
    await fsp.rm(root, { recursive: true, force: true });
});

test('weak-validator spool rejects unsafe identities', async () => {
    const root = await tempRoot();
    await assert.rejects(
        createWeakValidatorAttestationSpool({
            root,
            id: '../escape',
            minFreeBytes: 0,
            statfs: async () => ({ availableBytes: 10_000_000 }),
        }),
        (error) => error.code === 'INVALID_SPOOL_ID',
    );
    await fsp.rm(root, { recursive: true, force: true });
});
