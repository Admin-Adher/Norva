'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { StoryboardStore } = require('../services/media-gateway/src/storyboard-store');
const { createStoryboardDurabilityPolicy } = require('../services/media-gateway/src/storyboard-durability');
const { createProgress } = require('../services/media-gateway/src/storyboard-progress');
const crypto = require('node:crypto');
const sourceId = crypto.randomUUID();
const uid = crypto.randomUUID();
const callbackUrl = 'https://api.norva.tv/functions/v1/norva-playback/storyboard-callback';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-storyboard-recovery-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return new StoryboardStore(root, 'test-only-signing-key');
}
function job(overrides = {}) {
    return { jobId: crypto.randomUUID(), sourceId, uid, callbackUrl, duration: 120,
        durable: true, url: 'https://provider.invalid/private-credential',
        uploadUrl: 'https://api.norva.tv/storage/private-grant', ...overrides };
}
async function harness(store, capacity = 1) {
    const source = await fs.readFile(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    const code = source.slice(source.indexOf('async function restoreDurableStoryboards()'),
        source.indexOf('async function renewDurableStoryboard(job)'));
    assert.match(source, /await restoreDurableStoryboards\(\);[\s\S]*gatewayHttpServer = app.listen/);
    const state = { storyboardStore: store, transcribeQueue: [], MAX_TRANSCRIBE_QUEUE: capacity,
        durableStoryboardIds: new Set(), storyboardDurability: createStoryboardDurabilityPolicy({
            STORYBOARD_PRIVATE_DIR: store.root, STORYBOARD_DURABLE_SOURCE_IDS: sourceId }),
        isBackendUrl: value => value === callbackUrl,
        insertByPriority: (queue, value) => queue.push(value),
        transcribeWakeState: {}, wakeQueueDrain() {}, queueMicrotask() {}, drainTranscribeQueue() {} };
    vm.runInNewContext(code+'\nthis.restore = restoreDurableStoryboards;', state);
    return state;
}

test('a fresh process restores source and committed frames without persisting transport credentials', async t => {
    const store = await fixture(t);
    const initial = job();
    initial.storyboardProgress = { plan: {}, next: 1, failures: 0, activeMs: 100,
        sourceBinding: 'a'.repeat(64) };
    await store.save(initial);
    const dir = path.join(store.dir(initial.jobId), 'frames');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'frame-000.jpg'), Buffer.from([255,216,1,2,255,217]));
    const disk = await fs.readFile(path.join(store.dir(initial.jobId), 'job.json'), 'utf8');
    assert.ok(!disk.includes('private-credential') && !disk.includes('private-grant'));
    const restarted = new StoryboardStore(store.root, 'test-only-signing-key');
    const [restored] = await restarted.load();
    assert.equal(restored.sourceId, sourceId);
    assert.equal(restored.url, undefined);
    // Only after the normal scheduler obtained a new exact-source grant.
    const progress = await createProgress({ ...restored, durableDir: store.dir(initial.jobId),
        sourceBinding: 'a'.repeat(64), url: 'https://provider.invalid/fresh-grant' });
    assert.equal(progress.next, 1);
    assert.equal(progress.activeMs, 100);
    restored.terminal = { jobId: restored.jobId, ok: true };
    await restarted.save(restored);
    assert.equal((await restarted.load())[0].progress.sourceBinding, 'a'.repeat(64));
});

test('restoration is bounded, idempotent, and retries overflow without deleting checkpoints', async t => {
    const store = await fixture(t);
    await store.save(job()); await store.save(job());
    const h = await harness(store);
    assert.equal(await h.restore(), 1);
    assert.equal(await h.restore(), 0);
    assert.equal(h.transcribeQueue.length, 1);
    h.transcribeQueue.shift(); // first job is active; its id remains reserved
    assert.equal(await h.restore(), 1);
    assert.equal(h.durableStoryboardIds.size, 2);
    assert.equal((await store.load()).length, 2);
});

test('tampered records, disabled sources and invalid callback destinations cannot enter the queue', async t => {
    const store = await fixture(t);
    const tampered = job();
    await store.save(tampered);
    const file = path.join(store.dir(tampered.jobId), 'job.json');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.body = record.body.replace(sourceId, crypto.randomUUID());
    await fs.writeFile(file, JSON.stringify(record));
    await store.save(job({ sourceId: crypto.randomUUID() }));
    await store.save(job({ callbackUrl: 'https://untrusted.invalid/callback' }));
    const h = await harness(store, 50);
    assert.equal(await h.restore(), 0);
});

test('legacy signed checkpoints retain no transport and wait for source renewal', async t => {
    const store = await fixture(t);
    await store.save(job({ sourceId: undefined }));
    const h = await harness(store);
    assert.equal(await h.restore(), 1);
    assert.equal(h.transcribeQueue[0].sourceId, undefined);
    assert.equal(h.transcribeQueue[0].url, undefined);
    assert.equal(h.transcribeQueue[0].durable, true);
});

test('renewal pins the original source and fills legacy source identity from a verified grant', async t => {
    const store = await fixture(t);
    const source = await fs.readFile(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    const code = source.slice(source.indexOf('async function renewDurableStoryboard(job)'),
        source.indexOf('async function finishDurableStoryboard(job, payload)'));
    const otherSource = crypto.randomUUID();
    let grantSource = otherSource;
    const context = { storyboardStore: store, isBackendUrl: () => true, GATEWAY_TOKEN: 'test',
        AbortSignal, URL, Date, FFMPEG_USER_AGENT: 'test',
        storyboardDurability: createStoryboardDurabilityPolicy({
            STORYBOARD_PRIVATE_DIR: store.root, STORYBOARD_DURABLE_ROLLOUT_BPS: '10000' }),
        fetch: async () => ({ ok: true, status: 200, json: async () => ({
            pipeUrl: 'https://gateway.invalid/raw/signed', uploadUrl: 'https://api.norva.tv/storage/fresh',
            sourceId: grantSource, duration: 120, sourceBinding: 'b'.repeat(64) }) }),
        verifyRawToken: () => ({ uid, exp: Date.now()/1000+3600, url: 'https://provider.invalid/fresh' }),
        bytePipeAllowsPurpose: () => true };
    vm.runInNewContext(code+'\nthis.renew = renewDurableStoryboard;', context);
    const pinned = job();
    assert.equal(await context.renew(pinned), false);
    assert.equal(pinned.sourceId, sourceId);
    grantSource = sourceId;
    const legacy = job({ sourceId: undefined });
    assert.equal(await context.renew(legacy), true);
    assert.equal(legacy.sourceId, sourceId);
    assert.equal(legacy.url, 'https://provider.invalid/fresh');
});
