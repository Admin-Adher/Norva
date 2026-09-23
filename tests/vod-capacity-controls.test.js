'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reserveSpoolDisk } = require('../services/media-gateway/src/spool-disk-budget');
const { StartupAdmissionQueue } = require('../services/media-gateway/src/startup-admission-queue');
const { finiteVodStartupFormat, mp4PrefixState, prefetchFiniteVodHeader, startupHeaderCacheCapacity } = require('../services/media-gateway/src/finite-vod-startup');
const vm = require('node:vm'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');

test('header capacity scales with startup admission, remains bounded and honors disabled capture', () => {
    assert.equal(startupHeaderCacheCapacity(16, 32), 64);
    assert.equal(startupHeaderCacheCapacity(16, 64), 128);
    assert.equal(startupHeaderCacheCapacity(128, 16), 128);
    assert.equal(startupHeaderCacheCapacity(16, 256), 256);
    assert.equal(startupHeaderCacheCapacity(0, 32), 0);
});

test('a reservation released after directory listing does not fail another admission', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-release-race-'));
    const options = { root, bytes: 1024, maxBytes: 4096, minFreeBytes: 0,
        statfs: async () => ({ availableBytes: 1024 ** 3 }) };
    const first = await reserveSpoolDisk({ ...options, name: 'spool-first' });
    const read = fs.readFile; let removed = false;
    fs.readFile = async (...args) => {
        if (!removed && String(args[0]).includes('.reservations') && String(args[0]).endsWith('.json')) {
            removed = true; await first.release();
        }
        return read(...args);
    };
    try {
        const second = await reserveSpoolDisk({ ...options, name: 'spool-second' });
        assert.equal(removed, true); await second.release();
        assert.deepEqual(await fs.readdir(path.join(root, '.reservations')), []);
    } finally { fs.readFile = read; await fs.rm(root, { recursive: true, force: true }); }
});

test('100 simultaneous startup requests share 32 permits without rejection or overcommit', async () => {
    let active = 0, peak = 0;
    const queue = new StartupAdmissionQueue({ tryAcquire: () => {
        if (active === 32) return null;
        active++; peak = Math.max(active, peak); return {};
    } });
    await Promise.all(Array.from({ length: 100 }, async (_, i) => {
        await queue.acquire(`owner${i}`, `provider${i}`);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--; queue.wake();
    }));
    assert.equal(peak, 32); assert.equal(active, 0); assert.equal(queue.snapshot().pending, 0);
    assert.equal(queue.snapshot().admitted, 68);
});
test('queued cancellation, timeout and per-owner saturation release all waiters', async () => {
    const queue = new StartupAdmissionQueue({ tryAcquire: () => null, maxPerKey: 1, timeoutMs: 15 });
    const abort = new AbortController();
    const pending = queue.acquire('owner', 'provider', abort.signal);
    await assert.rejects(queue.acquire('owner', 'other'), { code: 'VIEWER_STARTUP_BUSY' });
    abort.abort(); await assert.rejects(pending, { code: 'VIEWER_STARTUP_ABORTED' });
    await assert.rejects(queue.acquire('other', 'provider'), { code: 'VIEWER_STARTUP_BUSY' });
    assert.equal(queue.snapshot().pending, 0);
});
test('one saturated owner does not block another owner in the startup queue', async () => {
    let available = false;
    const queue = new StartupAdmissionQueue({ tryAcquire: owner => owner === 'free' && available ? {} : null });
    const ac = new AbortController(); const blocked = queue.acquire('blocked', 'p', ac.signal);
    const independent = queue.acquire('free', 'q'); available = true; queue.wake();
    await independent; ac.abort(); await assert.rejects(blocked); assert.equal(queue.snapshot().pending, 0);
});

test('disk reservations enforce the aggregate quota across concurrent writers and finalized files', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-budget-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const opts = { root, bytes: 10, maxBytes: 30, minFreeBytes: 5, statfs: async () => ({ availableBytes: 100 }) };
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveSpoolDisk({ ...opts, name: `spool-${i}` })));
    const accepted = outcomes.filter(x => x.status === 'fulfilled');
    assert.equal(accepted.length, 3);
    assert.ok(outcomes.filter(x => x.status === 'rejected').every(x => x.reason.code === 'SPOOL_GLOBAL_QUOTA'));
    await Promise.all(accepted.map(x => x.value.release()));
    const lease = await reserveSpoolDisk({ ...opts, name: 'spool-finalized' });
    await fs.writeFile(path.join(root, 'spool-finalized.bin'), Buffer.alloc(10));
    await assert.rejects(reserveSpoolDisk({ ...opts, name: 'spool-large', bytes: 25 }), { code: 'SPOOL_GLOBAL_QUOTA' });
    await lease.release(); // orphan bytes still count even after a lost lease
    await assert.rejects(reserveSpoolDisk({ ...opts, name: 'spool-large', bytes: 25 }), { code: 'SPOOL_GLOBAL_QUOTA' });
});
test('disk admission accounts for unmaterialized reservations and legacy bytes independently', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-budget-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const opts = { root, bytes: 20, maxBytes: 100, minFreeBytes: 50, statfs: async () => ({ availableBytes: 85 }) };
    const lease = await reserveSpoolDisk({ ...opts, name: 'spool-active' });
    await assert.rejects(reserveSpoolDisk({ ...opts, name: 'spool-next' }), { code: 'SPOOL_DISK_RESERVE' });
    await fs.writeFile(path.join(root, 'spool-legacy.bin'), Buffer.alloc(81));
    await assert.rejects(reserveSpoolDisk({ ...opts, name: 'spool-next' }), { code: 'SPOOL_GLOBAL_QUOTA' });
    await lease.release();
});

test('separate gateway processes share one atomic disk quota', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-process-budget-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const modulePath = require.resolve('../services/media-gateway/src/spool-disk-budget');
    const batches = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
        const script = `const {reserveSpoolDisk}=require(${JSON.stringify(modulePath)});
            Promise.all(Array.from({length:8},(_,j)=>reserveSpoolDisk({...${JSON.stringify({
                root, bytes: 10, maxBytes: 30, minFreeBytes: 0,
            })},name:'spool-process-${i}-'+j}).then(()=>'admitted',e=>e.code)))
            .then(outcomes=>process.stdout.write(JSON.stringify(outcomes)));`;
        const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; child.stdout.on('data', data => { out += data; });
        child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error('worker_failed')));
    })));
    const outcomes = batches.flat();
    assert.equal(outcomes.filter(value => value === 'admitted').length, 3);
    assert.equal(outcomes.filter(value => value === 'SPOOL_GLOBAL_QUOTA').length, 29);
});
const box = (type, payload = Buffer.alloc(0)) => {
    const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(type, 4); payload.copy(b, 8); return b;
};
test('MP4 pipe admission needs a complete front index; tail, fragmented, truncated and giant boxes fall back', () => {
    assert.equal(mp4PrefixState(Buffer.concat([box('ftyp'), box('moov'), box('mdat')])), 'ready');
    assert.equal(mp4PrefixState(Buffer.concat([box('ftyp'), box('mdat'), box('moov')])), 'seekable');
    assert.equal(mp4PrefixState(Buffer.concat([box('ftyp'), box('sidx')])), 'seekable');
    assert.equal(mp4PrefixState(box('moov', Buffer.alloc(10)).subarray(0, 12)), 'incomplete');
    const large = Buffer.alloc(16); large.writeUInt32BE(1); large.write('moov', 4); large.writeBigUInt64BE(2n ** 63n, 8);
    assert.equal(mp4PrefixState(large), 'seekable');
});
test('live streams, resume and disabled rollouts never enter the retained cold VOD path', () => {
    const s = { playbackHint: { streamType: 'movie', container: 'ts' } };
    assert.equal(finiteVodStartupFormat(s, true), 'ts');
    assert.equal(finiteVodStartupFormat(s), null);
    assert.equal(finiteVodStartupFormat({ ...s, seekOffset: 30 }, true), null);
    assert.equal(finiteVodStartupFormat({ playbackHint: { streamType: 'live', container: 'ts' } }, true), null);
});
test('cold header reads retain every byte in order for playback, without another provider request', async () => {
    const input = [box('ftyp'), box('moov'), box('mdat', Buffer.alloc(256000))];
    let reads = 0, captured = [];
    const session = { retainedVodStartupFormat: 'mp4', startupTimings: {} };
    const opened = { attempt: { preloadedChunks: [input[0]], reader: {} }, range: { total: 256024, end: 256023 } };
    await prefetchFiniteVodHeader(session, opened, { read: async () => ({ value: input[++reads], done: false }),
        capture: (_, offset, chunk) => { assert.equal(offset, Buffer.concat(captured).length); captured.push(chunk); } });
    assert.equal(reads, 2); assert.equal(session.retainedVodHeaderReady, true);
    assert.deepEqual(Buffer.concat(opened.attempt.preloadedChunks), Buffer.concat(input));
});

test('a provider URL labeled MP4 can adopt observed Matroska on the same retained response', async () => {
    const source = await fs.readFile(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start = source.indexOf('async function primeFullBodyMatroskaAttempt(');
    const end = source.indexOf('\nfunction boundedVodResponseValidator(',start);
    const prime = vm.runInNewContext(`(${source.slice(start,end)})`, {
        Buffer, crypto, RAW_PREFIX_SNIFF_BYTES:512, VOD_INPUT_IDLE_TIMEOUT_MS:1000,
        classifyMediaContainerPrefix: bytes => bytes.length>=4 && bytes[0]===0x1a ? {container:'mkv',evidenceKind:'ebml-v1'} : null,
        readRawPrefixChunk: reader => reader.read(), compactRecord: x=>x, fileSizeBytesForSession:()=>1024,
        sha256Hex:s=>crypto.createHash('sha256').update(s).digest('hex'),
    });
    const bytes=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(508)]);
    let reads=0;
    const attempt={response:{body:{getReader:()=>({read:async()=>{reads++;return {value:bytes,done:false};}})}}};
    const session={sourceUrl:'http://fixture/movie/u/p/item.mp4',retainedVodStartupFormat:'mp4',startupTimings:{},
        codecProfile:{videoCodec:'stale'},videoCodec:'stale'};
    await prime(attempt,null,session,{total:1024});
    assert.equal(reads,1);assert.equal(session.sourceContainerAuthority.container,'mkv');
    assert.equal(session.retainedVodStartupFormat,null);assert.equal(session.videoCodec,null);
    assert.deepEqual(Buffer.concat(attempt.preloadedChunks),bytes);
});

test('tail-index MP4 probes through the same serialized broker later used by playback', async () => {
    const source = await fs.readFile(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
    const start = source.indexOf('async function enrichRetainedFiniteVodProfile(');
    const end = source.indexOf('\nasync function enrichSessionCodecProfileFromBoundedHeader(',start);
    let preparations=0, probes=0;
    const broker={inputUrl:'http://127.0.0.1/private-fixture'};
    const enrich = vm.runInNewContext(`(${source.slice(start,end)})`, {
        headerByteCache:new Map(), fileSizeBytesForSession:()=>1024,
        hasReliableVodCodecProfile:p=>p?.videoCodec==='h264',
        prepareFiniteMkvSeekBroker:async s=>{preparations++;s.finiteMkvSeekBroker=broker;return broker;},
        probeCodecProfileUncached:async(url,_ua,options)=>{assert.equal(url,broker.inputUrl);
            assert.equal(options.loopbackBroker,true);probes++;return {videoCodec:'h264',audioCodec:'aac'};},
        mergeCodecProfiles:(a,b)=>({...a,...b}),cacheCodecProfile(){},
    });
    const s={id:'tail-fixture',sourceUrl:'https://provider.example/tail.mp4',retainedVodStartupFormat:'mp4',startupTimings:{},codecProfile:{}};
    await enrich(s);
    assert.equal(preparations,1);assert.equal(probes,1);
    assert.equal(s.finiteMkvSeekBroker,broker);assert.equal(s.retainedVodStartupFormat,null);
    assert.equal(s.finiteVodOutputStartupFormat,'mp4');assert.equal(s.codecProfile.fileSizeBytes,1024);
});
