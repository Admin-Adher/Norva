'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReadableStream } = require('node:stream/web');
const test = require('node:test');
const { acquireAuthoritativeVodSpool, verifySpoolAttestation } = require('../services/media-gateway/src/authoritative-vod-spool');

test('authoritative spool hashes one complete response and signs its binding', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-authoritative-'));
    const bytes = Buffer.from('one authoritative provider body');
    const key = crypto.randomBytes(32).toString('hex');
    const identity = { tenant: 't', provider: 'p', item: 'i', variant: 'v', sourceRevision: 'r', profile: 'profile' };
    const result = await acquireAuthoritativeVodSpool({
        root, id: 'session-1', identity, sourceUrl: 'https://provider.example/movie.mp4',
        signingKey: key, expectedBytes: bytes.length, minFreeBytes: 0,
        statfs: async () => ({ availableBytes: 10_000_000 }),
        openProviderGet: async () => ({
            status: 200, url: 'https://cdn.example/movie.mp4',
            headers: new Headers({ 'content-length': String(bytes.length), 'content-encoding': 'identity' }),
            body: new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 7)); c.enqueue(bytes.subarray(7)); c.close(); } }),
        }),
    });
    assert.equal(result.contentSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(verifySpoolAttestation(result.attestation, key, identity, 'https://provider.example/movie.mp4'), true);
    await result.spool.cleanup();
    await fsp.rm(root, { recursive: true, force: true });
});

test('authoritative spool attestation fails closed when its signed payload changes', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-authoritative-tamper-'));
    const bytes = Buffer.from('tamper-proof provider body');
    const key = crypto.randomBytes(32).toString('hex');
    const identity = { tenant: 't', provider: 'p', item: 'i', variant: 'v', sourceRevision: 'r', profile: 'profile' };
    const result = await acquireAuthoritativeVodSpool({
        root, id: 'session-tamper', identity, sourceUrl: 'https://provider.example/movie.mkv',
        signingKey: key, expectedBytes: bytes.length, minFreeBytes: 0,
        statfs: async () => ({ availableBytes: 10_000_000 }),
        openProviderGet: async () => ({
            status: 200, url: 'https://cdn.example/movie.mkv',
            headers: new Headers({ 'content-length': String(bytes.length) }),
            body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        }),
    });
    const tampered = { payload: { ...result.attestation.payload, bytes: result.attestation.payload.bytes + 1 }, signature: result.attestation.signature };
    assert.equal(verifySpoolAttestation(tampered, key, identity, 'https://provider.example/movie.mkv'), false);
    await result.spool.cleanup();
    await fsp.rm(root, { recursive: true, force: true });
});
