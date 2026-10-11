'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
const code = source.slice(source.indexOf('function runStoryboardProcess('), source.indexOf('async function runStoryboardJob('));
function harness(blocked = false) {
    const child = new EventEmitter(); child.pid = 123; child.stderr = { resume() {} }; child.kill = () => true;
    const state = { spawned: 0, released: 0, cooldown: [], activity: [] };
    const context = {
        FFMPEG_PATH: 'ffmpeg', process, setTimeout, clearTimeout,
        backgroundJobBlockedByViewer: () => blocked,
        spawn: () => { state.spawned++; return child; },
        trackStoryboardChild() {}, proxyEnvFor: () => ({}), proxyKeyFromUrl: () => 'opaque-account',
        registerAccountExtraction: (_key, _child, activity, preemptible) => {
            state.activity.push(activity); assert.equal(preemptible, true);
            return { release() { state.released++; } };
        },
        markStoryboardRun: url => state.cooldown.push(url),
    };
    vm.runInNewContext(code + '\nthis.run = runStoryboardProcess;', context);
    return { state, child, run: providerRead => context.run({ url: 'https://provider.invalid/file', prio: 1 }, [], 1000, providerRead) };
}
test('a confirmed provider batch close applies cooldown even before the full sprite is finished', async () => {
    for (const exitCode of [0, 1]) {
        const h = harness(), pending = h.run(true);
        assert.equal(h.state.cooldown.length, 0);
        h.child.emit('close', exitCode);
        assert.equal((await pending).ok, exitCode === 0);
        assert.equal(h.state.released, 1);
        assert.deepEqual(h.state.activity, [true]);
        assert.equal(h.state.cooldown.length, 1);
    }
});
test('local assembly retains CPU preemption but neither account activity nor provider cooldown', async () => {
    const h = harness(), pending = h.run(false);
    h.child.emit('close', 0); assert.equal((await pending).ok, true);
    assert.deepEqual(h.state.activity, [false]); assert.deepEqual(h.state.cooldown, []);
    assert.equal(h.state.released, 1);
});
test('a held background quiesce prevents batch acquisition', async () => {
    const h = harness(true); assert.equal((await h.run(true)).preempted, true);
    assert.equal(h.state.spawned, 0); assert.deepEqual(h.state.activity, []);
});
test('a live-child error does not release its slot or start its cooldown', async () => {
    const h = harness(), pending = h.run(true);
    h.child.emit('error', Error('transport still unconfirmed'));
    assert.equal(h.state.released, 0); assert.equal(h.state.cooldown.length, 0);
    h.child.emit('close', 1); await pending;
    assert.equal(h.state.released, 1); assert.equal(h.state.cooldown.length, 1);
});

function legacyHarness(preempted) {
    const child = new EventEmitter(); child.pid = 123;
    child.stderr = new EventEmitter(); child.kill = () => true;
    const state = { released: 0, cooldown: [] };
    const context = {
        FFMPEG_PATH: 'ffmpeg', process, setTimeout, clearTimeout,
        STORYBOARD_TILE_WIDTH: 212, spawn: () => child, proxyEnvFor: () => ({}),
        trackStoryboardChild() {}, proxyKeyFromUrl: () => 'account',
        storyboardEncodingArgs: () => [],
        registerAccountExtraction: () => ({ preempted, release() { state.released++; } }),
        markStoryboardRun: url => state.cooldown.push(url),
        fsp: { unlink: async () => {}, stat: async () => ({ size: 0 }) },
        redactCreds: value => value, console: { warn() {} },
    };
    const legacy = source.slice(source.indexOf('function extractStoryboardSprite('),
        source.indexOf('// Restore only signed checkpoints;'));
    assert.ok(legacy.startsWith('function extractStoryboardSprite('));
    vm.runInNewContext(legacy + '\nthis.run = extractStoryboardSprite;', context);
    return { child, state, run: () => context.run('https://provider.invalid/file', 'qa', 10, 10, 2, '/tmp/sprite', 1000, '', true, {}) };
}
test('a preempted legacy sprite marks provider cooldown before requeue', async () => {
    const h = legacyHarness(true), pending = h.run();
    h.child.emit('close', 1);
    assert.equal((await pending).preempted, true);
    assert.equal(h.state.cooldown.length, 1); assert.equal(h.state.released, 1);
});
test('legacy sprite retains the account after a live process error until confirmed close', async () => {
    const h = legacyHarness(false), pending = h.run();
    h.child.emit('error', Error('kill failed'));
    assert.equal(h.state.released, 0); assert.equal(h.state.cooldown.length, 0);
    h.child.emit('close', 1); assert.equal((await pending).ok, false);
    assert.equal(h.state.released, 1); assert.equal(h.state.cooldown.length, 1);
});
