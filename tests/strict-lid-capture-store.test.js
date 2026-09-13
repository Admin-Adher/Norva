'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { StrictLidCaptureStore, acquireCaptureStoreOwnership } = require('../services/media-gateway/src/strict-lid-capture-store');
const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');
const { createStrictLidCapturePipeline } = require('../services/media-gateway/src/strict-lid-capture-pipeline');

const secret = 'private-test-secret-only-not-production';
const drain = { providerDrained: true, providerDrainProtocol: 1 };
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
function decryptCaptureEnvelope(disk, filename, fixtureSecret = secret) {
    assert.deepEqual(disk.subarray(0, 8), Buffer.from('NLIDCAP1'));
    assert.ok(disk.length > 36);
    const key = Buffer.from(crypto.hkdfSync('sha256', fixtureSecret,
        'norva-lid-capture-v1', 'private-working-buffer', 32));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, disk.subarray(8, 20));
    decipher.setAAD(Buffer.from(filename));
    decipher.setAuthTag(disk.subarray(20, 36));
    return JSON.parse(Buffer.concat([decipher.update(disk.subarray(36)), decipher.final()]).toString());
}
function binding(overrides = {}) {
    const plan = planStrictSpeechWindow(3600, 2);
    return { jobId: '12345678-1234-4234-8234-123456789012', userId: 'private-owner',
        profileFingerprint: 'a'.repeat(64), sourceUrlHash: 'b'.repeat(64), trackIndex: 1,
        windowOrdinal: 2, windowCount: 6, durationSeconds: 3600, fileSizeBytes: 1000000,
        offsetMilliseconds: plan.anchorOffsetMilliseconds, selectionProtocol: 1,
        configDigest: 'c'.repeat(64), modelDigest: 'd'.repeat(64), method: 'whisper-strict-consensus-v4', ...overrides };
}
function wav(seconds = 60) {
    const b = Buffer.alloc(44 + seconds * 32000);
    b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
    for (let i = 44; i < b.length; i += 2) b.writeInt16LE((i * 13 % 4096) - 2048, i);
    return b;
}
async function fixture(t, options = {}) {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'norva-capture-proof-')));
    const root = path.join(parent, 'private-buffer');
    let at = 1000000;
    const owner = { held: false, async acquire() {
        if (owner.held) throw Error('duplicate fixture owner');
        owner.held = true;
        return { isHeld: () => owner.held, close: async () => { owner.held = false; } };
    } };
    const configuration = { root, secret, now: () => at, acquireOwnership: () => owner.acquire(), ...options };
    let store = new StrictLidCaptureStore(configuration);
    t.after(async () => {
        await store.close();
        assert.equal(path.dirname(parent), await fs.realpath(os.tmpdir()));
        assert.ok(path.basename(parent).startsWith('norva-capture-proof-'));
        await fs.rm(parent, { recursive: true, force: true });
    });
    await store.open();
    return { get store() { return store; }, root, owner, advance: ms => { at += ms; },
        async restart() { await store.close(); store = new StrictLidCaptureStore(configuration); await store.open(); } };
}

test('capture is encrypted, private, bound to the exact file and durable across a fresh store instance', async t => {
    const f = await fixture(t); const bytes = wav();
    const saved = await f.store.put(binding(), bytes, drain);
    assert.equal(saved.reused, false); assert.equal(saved.sha256, digest(bytes));
    const files = await fs.readdir(f.root); assert.equal(files.length, 1);
    const disk = await fs.readFile(path.join(f.root, files[0]));
    // Ciphertext/nonce bytes can contain short plaintext-looking strings by
    // coincidence. Prove the authenticated envelope instead of substring absence.
    const record = decryptCaptureEnvelope(disk, files[0]);
    assert.equal(record.binding.userId, binding().userId);
    assert.equal(record.sha256, digest(bytes));
    assert.deepEqual(Buffer.from(record.wav, 'base64'), bytes);
    assert.throws(() => decryptCaptureEnvelope(disk, files[0], 'wrong-test-secret'));
    assert.throws(() => decryptCaptureEnvelope(disk, 'different-authenticated-filename.bin'));
    if (process.platform === 'linux') assert.equal((await fs.stat(path.join(f.root, files[0]))).mode & 0o077, 0);
    await f.restart();
    assert.deepEqual((await f.store.get(binding())).wav, bytes);
    assert.equal(f.store.snapshot().entries, 1);
    assert.equal(f.store.snapshot().bytes, disk.length);
});

test('a valid authenticated envelope can contain RIFF without exposing a plaintext WAV', async t => {
    const f = await fixture(t); const bytes = wav();
    await f.store.put(binding(), bytes, drain);
    const [filename] = await fs.readdir(f.root);
    const record = decryptCaptureEnvelope(await fs.readFile(path.join(f.root, filename)), filename);
    const key = Buffer.from(crypto.hkdfSync('sha256', secret,
        'norva-lid-capture-v1', 'private-working-buffer', 32));
    // Deterministic test-only nonce reproduces the old assertion's false
    // positive. Production nonces remain generated by crypto.randomBytes.
    const iv = Buffer.from('RIFFfixture!');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(filename));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
    const disk = Buffer.concat([Buffer.from('NLIDCAP1'), iv, cipher.getAuthTag(), ciphertext]);
    assert.equal(disk.includes(Buffer.from('RIFF')), true);
    assert.deepEqual(decryptCaptureEnvelope(disk, filename), record);
    await fs.writeFile(path.join(f.root, filename), disk);
    assert.deepEqual((await f.store.get(binding())).wav, bytes);
});

test('missing drain or wrong audio duration cannot enter the inference buffer', async t => {
    const f = await fixture(t);
    for (const attestation of [{}, { providerDrained: true }, { providerDrained: false, providerDrainProtocol: 1 }]) {
        await assert.rejects(f.store.put(binding(), wav(), attestation), { code: 'LID_CAPTURE_DRAIN_REQUIRED' });
    }
    await assert.rejects(f.store.put(binding(), wav(19), drain), { code: 'LID_CAPTURE_DURATION_INVALID' });
    await assert.rejects(f.store.put(binding(), wav(61), drain), { code: 'LID_CAPTURE_DURATION_INVALID' });
    assert.equal(f.store.snapshot().entries, 0);
});

test('different owner, job, track, file, source URL or method runtime never reuses an excerpt', async t => {
    const f = await fixture(t); await f.store.put(binding(), wav(), drain);
    for (const changed of [{ userId: 'another-owner' }, { jobId: crypto.randomUUID() }, { trackIndex: 2 },
        { profileFingerprint: 'e'.repeat(64) }, { fileSizeBytes: 2000000 }, { sourceUrlHash: 'e'.repeat(64) },
        { configDigest: 'e'.repeat(64) }, { modelDigest: 'e'.repeat(64) }]) {
        assert.equal(await f.store.get(binding(changed)), null);
    }
    await assert.rejects(f.store.get(binding({ sourceUrlHash: '../outside' })), { code: 'LID_CAPTURE_BINDING_INVALID' });
});

test('idempotent delivery never rewrites audio or extends expiry', async t => {
    const f = await fixture(t); const first = await f.store.put(binding(), wav(), drain);
    const altered = wav(); altered[100] ^= 1; f.advance(1000);
    const second = await f.store.put(binding(), altered, drain);
    assert.equal(second.reused, true); assert.equal(second.expiresAt, first.expiresAt); assert.equal(second.sha256, first.sha256);
    assert.deepEqual((await f.store.get(binding())).wav, wav());
});

test('expired audio is removed from disk and cannot be revived by a read or restart', async t => {
    const f = await fixture(t, { ttlMs: 60_000 }); await f.store.put(binding(), wav(), drain);
    f.advance(60_000); await f.restart();
    assert.equal(await f.store.get(binding()), null); assert.equal(f.store.snapshot().bytes, 0);
    assert.deepEqual(await fs.readdir(f.root), []);
});

test('concurrent writes obey one bounded byte and entry budget', async t => {
    const f = await fixture(t, { maxEntries: 2, maxBytes: 6 * 1024 * 1024 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => f.store.put(binding({ trackIndex: i }), wav(), drain)));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 2);
    assert.ok(results.filter(x => x.status === 'rejected').every(x => x.reason.code === 'LID_CAPTURE_STORE_FULL'));
    assert.equal(f.store.snapshot().entries, 2); assert.ok(f.store.snapshot().bytes <= 6 * 1024 * 1024);
    await f.store.remove(binding({ trackIndex: 0 }));
    assert.equal((await f.store.put(binding({ trackIndex: 9 }), wav(), drain)).reused, false);
});

test('loss of writer ownership stops reads and writes; a live owner cannot be replaced', async t => {
    const f = await fixture(t); await f.store.put(binding(), wav(), drain);
    const competitor = new StrictLidCaptureStore({ root: f.root, secret, acquireOwnership: () => f.owner.acquire() });
    await assert.rejects(competitor.open(), /duplicate fixture owner/);
    f.owner.held = false;
    await assert.rejects(f.store.get(binding()), { code: 'LID_CAPTURE_STORE_OWNERSHIP_LOST' });
    await assert.rejects(f.store.put(binding(), wav(), drain), { code: 'LID_CAPTURE_STORE_OWNERSHIP_LOST' });
});

test('tampered ciphertext is discarded, not passed to inference', async t => {
    const f = await fixture(t); await f.store.put(binding(), wav(), drain);
    const filename = (await fs.readdir(f.root))[0]; const p = path.join(f.root, filename);
    const data = await fs.readFile(p); data[data.length - 1] ^= 1; await fs.writeFile(p, data);
    assert.equal(await f.store.get(binding()), null); assert.equal(f.store.snapshot().entries, 0);
});

test('foreign files are retained and cause startup refusal instead of broad cleanup', async t => {
    const f = await fixture(t); await f.store.close();
    const foreign = path.join(f.root, 'user-notes.txt'); await fs.writeFile(foreign, 'preserve');
    await assert.rejects(f.store.open(), { code: 'LID_CAPTURE_STORE_FOREIGN_FILE' });
    assert.equal(await fs.readFile(foreign, 'utf8'), 'preserve');
});

test('hard links cannot bypass encrypted record confinement or trigger deletion of foreign data', async t => {
    const f = await fixture(t); await f.store.put(binding(), wav(), drain);
    const file = path.join(f.root, (await fs.readdir(f.root))[0]); const link = path.join(path.dirname(f.root), 'linked-record');
    await fs.link(file, link);
    await assert.rejects(f.store.get(binding()), { code: 'LID_CAPTURE_STORE_FILE_INVALID' });
    await assert.rejects(f.store.remove(binding()), { code: 'LID_CAPTURE_STORE_FILE_INVALID' });
    assert.ok((await fs.stat(link)).size > 0);
});

test('native Linux lock ownership is exclusive and releases on helper EOF', { skip: process.platform !== 'linux' }, async t => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-capture-lock-'));
    const p = path.join(parent, 'owner.lock');
    const owner = await acquireCaptureStoreOwnership(p);
    t.after(async () => { await owner.close(); await fs.unlink(p); await fs.rmdir(parent); });
    assert.equal(owner.isHeld(), true);
    await assert.rejects(acquireCaptureStoreOwnership(p), { code: 'LID_CAPTURE_STORE_LOCK_BUSY' });
    await owner.close(); assert.equal(owner.isHeld(), false);
    const next = await acquireCaptureStoreOwnership(p); assert.equal(next.isHeld(), true); await next.close();
});

test('reservations reject duplicates and byte pressure BEFORE extraction; only the exact token can commit', async t => {
    const f = await fixture(t, { maxEntries: 2, maxBytes: 6 * 1024 * 1024 });
    const first = await f.store.reserve(binding());
    const second = await f.store.reserve(binding({ trackIndex: 2 }));
    await assert.rejects(f.store.reserve(binding()), { code: 'LID_CAPTURE_ALREADY_RUNNING' });
    await assert.rejects(f.store.reserve(binding({ trackIndex: 3 })), { code: 'LID_CAPTURE_STORE_FULL' });
    await assert.rejects(f.store.put(binding(), wav(), drain, 'wrong-token'), { code: 'LID_CAPTURE_RESERVATION_LOST' });
    await assert.rejects(f.store.close(), { code: 'LID_CAPTURE_STORE_IN_USE' });
    await f.store.put(binding(), wav(), drain, first.token);
    await first.release(); await second.release();
    assert.equal(f.store.snapshot().reservations, 0);
});

test('plaintext is isolated, removed after failures, and does not remove its reusable encrypted record', async t => {
    const f = await fixture(t); await f.store.put(binding(), wav(), drain);
    let plain;
    await assert.rejects(f.store.withPlaintext(binding(), async p => {
        plain = p;
        assert.equal(path.dirname(path.dirname(p)), f.root);
        assert.deepEqual(await fs.readFile(p), wav());
        if (process.platform === 'linux') assert.equal((await fs.stat(p)).mode & 0o077, 0);
        await fs.writeFile(p + '.selected.wav', wav(20));
        throw Error('fixture inference interrupted');
    }), /fixture inference interrupted/);
    await assert.rejects(fs.stat(plain), { code: 'ENOENT' });
    assert.equal(f.store.snapshot().computations, 0);
    assert.ok(await f.store.get(binding()));
});

test('restart cleans only known orphan inference artifacts; no recursive deletion of foreign data', async t => {
    const f = await fixture(t);
    const dir = path.join(f.root, 'compute-' + crypto.randomUUID());
    await fs.mkdir(dir, { mode: 0o700 }); await fs.writeFile(path.join(dir, 'raw.wav'), wav(), { mode: 0o600 });
    await f.restart(); await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
    await fs.mkdir(dir, { mode: 0o700 }); await fs.writeFile(path.join(dir, 'notes.txt'), 'keep');
    await assert.rejects(f.restart(), { code: 'LID_CAPTURE_STORE_FOREIGN_FILE' });
    assert.equal(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8'), 'keep');
});

function pipelineFixture(store, options = {}) {
    const events = []; let sockets = 0; let reads = 0;
    const pipeline = createStrictLidCapturePipeline({ store, drainTimeoutMs: 10,
        diagnostic: options.diagnostic || (() => {}),
        claimNetwork: () => { events.push('admit'); return { release() { events.push('network-release'); } }; },
        openBroker: async () => { events.push('broker'); sockets++;
            return { close: async () => {
                events.push('drain');
                if (options.drainFails) throw Error('unconfirmed');
                sockets--;
            } };
        },
        extract: async () => { events.push('extract'); reads++; if (options.extractFails) throw options.extractFails; return wav(options.seconds || 60); },
        infer: async p => {
            events.push('infer'); assert.equal(sockets, 0);
            assert.deepEqual(await fs.readFile(p), wav());
            if (options.inferFails) throw Error('interrupted');
            return { receipt: 'test-opaque-receipt' };
        },
    });
    return { pipeline, events, reads: () => reads, sockets: () => sockets };
}

test('internal capture diagnostics distinguish short audio after drain without exposing arbitrary error text', async t => {
    const f = await fixture(t); const diagnostics = [];
    const p = pipelineFixture(f.store, { seconds: 19, diagnostic: value => diagnostics.push(value) });
    await assert.rejects(p.pipeline.capture(binding(), {}), { code: 'LID_CAPTURE_DURATION_INVALID' });
    assert.equal(p.sockets(), 0); assert.equal(f.store.snapshot().entries, 0);
    assert.equal(diagnostics[0].stage, 'store');
    assert.equal(diagnostics[0].code, 'LID_CAPTURE_DURATION_INVALID');
    assert.equal(diagnostics[0].providerDrained, true);
    assert.deepEqual(diagnostics[0].audioMilliseconds, [19000]);
    assert.equal(diagnostics[0].requestedMilliseconds, 60000);
    const q = pipelineFixture(f.store, { diagnostic: value => diagnostics.push(value),
        extractFails: Object.assign(Error('https://private.invalid/secret'), { code: 'SECRET_CREDENTIAL_VALUE' }) });
    await assert.rejects(q.pipeline.capture(binding(), {}));
    assert.equal(diagnostics[1].stage, 'extract'); assert.equal(diagnostics[1].code, 'UNCLASSIFIED');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|secret|SECRET|private-owner|12345678/);
    const r = pipelineFixture(f.store, { diagnostic: () => { throw Error('logger down'); } });
    assert.equal((await r.pipeline.capture(binding(), {})).providerDrained, true);
});

test('a bounded partial search survives storage without padding and still produces a full 20-second selected sample', async t => {
    const { prepareStrictLidSpeechSample } = require('../services/media-gateway/src/strict-lid-speech-sampler');
    const f = await fixture(t);const partial=wav(59.95);const planned=planStrictSpeechWindow(3600,2);
    await f.store.put(binding(),partial,drain);
    await f.restart();assert.deepEqual((await f.store.get(binding())).wav,partial);
    await f.store.withPlaintext(binding(),async sourcePath=>{
        const selected=sourcePath+'.selected.wav';
        const result=await prepareStrictLidSpeechSample({wavPath:sourcePath,plan:planned,selectedWavPath:selected});
        assert.equal(result.ok,true);assert.deepEqual(await fs.readFile(sourcePath),partial);
        const {parsePcm16Wav}=require('../services/media-gateway/src/strict-lid-audio-evidence');
        assert.equal(parsePcm16Wav(await fs.readFile(selected)).sampleCount,320000);
        assert.equal(result.selection.selectedDurationMilliseconds,20000);
    });
    // Exactly the selector minimum is retained, but without speech evidence a
    // missing preferred anchor still fails downstream. No fabricated padding.
    const shortBinding=binding({trackIndex:2});await f.store.put(shortBinding,wav(20),drain);
    await f.store.withPlaintext(shortBinding,async sourcePath=>{
        const result=await prepareStrictLidSpeechSample({wavPath:sourcePath,plan:planned,selectedWavPath:sourcePath+'.selected.wav'});
        assert.equal(result.ok,false);
    });
});

test('pipeline captures only once, attests drain before storage, restarts and computes with ZERO provider reads', async t => {
    const f = await fixture(t); const first = pipelineFixture(f.store);
    const saved = await first.pipeline.capture(binding(), {});
    assert.equal(saved.captured, true); assert.equal(saved.providerDrained, true);
    assert.deepEqual(first.events, ['admit', 'broker', 'extract', 'drain', 'network-release']);
    await f.restart();
    const resumed = pipelineFixture(f.store);
    assert.equal((await resumed.pipeline.capture(binding(), {})).reused, true);
    assert.equal((await resumed.pipeline.compute(binding(), {})).receipt, 'test-opaque-receipt');
    assert.deepEqual(resumed.events, ['infer']); assert.equal(resumed.reads(), 0);
    await resumed.pipeline.acknowledge(binding());
    await assert.rejects(resumed.pipeline.compute(binding(), {}), { code: 'LID_CAPTURE_NOT_FOUND' });
    assert.equal(resumed.reads(), 0);
});

test('uncertain provider drain cannot commit audio, infer, or release the connection reservation', async t => {
    const f = await fixture(t); const p = pipelineFixture(f.store, { drainFails: true });
    await assert.rejects(p.pipeline.capture(binding(), {}), { code: 'LID_CAPTURE_DRAIN_UNCONFIRMED', providerDrained: false });
    assert.equal(f.store.snapshot().entries, 0); assert.equal(f.store.snapshot().reservations, 0);
    assert.equal(p.events.includes('network-release'), false);
    await assert.rejects(p.pipeline.compute(binding(), {}), { code: 'LID_CAPTURE_NOT_FOUND' });
    assert.equal(p.events.includes('infer'), false);
});

test('provider refusal survives safe response filtering and does not trigger a new attempt', async t => {
    const f = await fixture(t); const p = pipelineFixture(f.store,
        { extractFails: Object.assign(Error('secret provider URL must not escape'), { code: 'PROVIDER_BUSY', upstreamStatus: 458 }) });
    await assert.rejects(p.pipeline.capture(binding(), {}), e => {
        assert.equal(e.code, 'PROVIDER_BUSY'); assert.equal(e.upstreamStatus, 458); assert.equal(e.providerDrained, true);
        assert.equal(e.message.includes('secret'), false); return true;
    });
    assert.equal(p.reads(), 1); assert.equal(p.sockets(), 0); assert.equal(f.store.snapshot().entries, 0);
});

test('provider fetch failure has a closed internal code instead of an unclassified extraction', async t => {
    const f=await fixture(t);const diagnostics=[];
    const p=pipelineFixture(f.store,{diagnostic:value=>diagnostics.push(value),
        extractFails:Object.assign(Error('private transport details'),{code:'PROVIDER_FETCH_FAILED'})});
    await assert.rejects(p.pipeline.capture(binding(),{}),{code:'PROVIDER_FETCH_FAILED',providerDrained:true});
    assert.equal(diagnostics[0].code,'PROVIDER_FETCH_FAILED');assert.equal(diagnostics[0].stage,'extract');
    assert.equal(p.reads(),1);assert.equal(p.sockets(),0);assert.equal(f.store.snapshot().entries,0);
    assert.doesNotMatch(JSON.stringify(diagnostics),/private transport/);
});

test('full capture buffer rejects BEFORE opening a provider and inference failures preserve reusable audio', async t => {
    const f = await fixture(t, { maxEntries: 1 }); const p = pipelineFixture(f.store, { inferFails: true });
    await p.pipeline.capture(binding(), {});
    await assert.rejects(p.pipeline.capture(binding({ trackIndex: 2 }), {}), { code: 'LID_CAPTURE_STORE_FULL', providerDrained: true });
    assert.equal(p.reads(), 1);
    await assert.rejects(p.pipeline.compute(binding(), {}), /interrupted/);
    assert.equal((await p.pipeline.status(binding())).captured, true);
    assert.equal(p.reads(), 1);
});

test('four job tracks share one capture; future windows remain exact-bound and are reused without extraction', async t => {
    const f = await fixture(t); let extracts = 0; let closed = false;
    const pipeline = createStrictLidCapturePipeline({ store: f.store,
        claimNetwork: () => ({ release() { assert.equal(closed, true); } }),
        openBroker: async () => ({ close: async () => { closed = true; } }),
        extract: async (_broker, group) => {
            extracts++; assert.equal(group.length, 4);
            return group.map(b => { const audio = wav(); audio[100] ^= b.trackIndex; return audio; });
        }, infer: async () => ({}) });
    const companions = [2, 3, 4].map(trackIndex => binding({ trackIndex }));
    const captured = await pipeline.capture(binding(), {}, undefined, companions);
    assert.equal(captured.extractedTrackCount, 4); assert.equal(extracts, 1);
    const hashes = new Set();
    for (const b of [binding(), ...companions]) {
        assert.equal((await pipeline.capture(b, {})).reused, true);
        hashes.add((await f.store.get(b)).sha256);
        assert.equal(await f.store.get({ ...b, windowOrdinal: 3, offsetMilliseconds: planStrictSpeechWindow(3600, 3).anchorOffsetMilliseconds }), null);
    }
    assert.equal(extracts, 1); assert.equal(hashes.size, 4);
});

test('optional prefetch cannot starve the current track or combine another file, job or temporal window', async t => {
    const f = await fixture(t, { maxEntries: 1 }); const p = pipelineFixture(f.store);
    const result = await p.pipeline.capture(binding(), {}, undefined, [binding({ trackIndex: 2 })]);
    assert.equal(result.extractedTrackCount, 1); assert.equal(p.reads(), 1);
    for (const changed of [{ jobId: crypto.randomUUID() }, { sourceUrlHash: 'e'.repeat(64) },
        { profileFingerprint: 'e'.repeat(64) }, { userId: 'different-owner' }]) {
        await assert.rejects(p.pipeline.capture(binding(), {}, undefined, [binding({ trackIndex: 2, ...changed })]),
            { code: 'LID_CAPTURE_GROUP_INVALID' });
    }
    await assert.rejects(p.pipeline.capture(binding(), {}, undefined, [binding()]), { code: 'LID_CAPTURE_GROUP_INVALID' });
    assert.equal(p.reads(), 1);
});
