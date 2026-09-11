'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { decideLanguageMetadataCapacity: decide } = require('../services/media-gateway/src/language-background-capacity');
const { createEnrichmentNetworkAdmission } = require('../services/media-gateway/src/enrichment-network-admission');
const loaded = import('../supabase/functions/_shared/automatic-vod-language-fleet.mjs');
const sample = { at: 100000, cpuRatio: .2, memoryRatio: .1, hostLoadRatio: .1 };
const idle = { viewer: false, starting: false, foregroundInference: false, benchmark: false };
const network = { maximum: 2, active: 0 };
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const edge = read('supabase/functions/norva-playback/index.ts');
const gateway = read('services/media-gateway/src/index.js');

test('metadata lane is disabled by default and tolerates no missing network telemetry', () => {
    for (const [s, n, enabled] of [[sample, network, false], [null, network, true], [sample, null, true],
        [sample, { maximum: 3, active: 0 }, true], [sample, { maximum: 2, active: -1 }, true]]) {
        assert.equal(decide(s, idle, n, enabled, sample.at).maxWorkers, 0);
    }
});
test('local speech work alone no longer occupies metadata network slots', () => {
    assert.equal(decide(sample, { ...idle, backgroundProcesses: 2, brokers: 2 }, network, true, sample.at).maxWorkers, 2);
    assert.equal(decide(sample, idle, { ...network, active: 2 }, true, sample.at).maxWorkers, 0);
});
for (const key of ['viewer', 'starting', 'foregroundInference', 'benchmark']) test(`${key} stops metadata as well as inference`, () => {
    assert.equal(decide(sample, { ...idle, [key]: true }, network, true, sample.at).maxWorkers, 0);
});
test('resource pressure still reduces and then stops metadata', () => {
    assert.equal(decide({ ...sample, cpuRatio: .65 }, idle, network, true, sample.at).maxWorkers, 1);
    assert.equal(decide({ ...sample, cpuRatio: .85 }, idle, network, true, sample.at).maxWorkers, 0);
    assert.equal(decide(sample, idle, network, true, sample.at + 30001).maxWorkers, 0);
});
test('one synchronous shared reservation caps metadata and capture together, regardless of stale health', async () => {
    const gate = createEnrichmentNetworkAdmission();
    const leases = await Promise.all(Array.from({ length: 100 }, (_, i) => Promise.resolve().then(() =>
        gate.acquire({ accountKey: `account-${i}`, hostKey: 'provider.invalid' }))));
    assert.equal(leases.filter(Boolean).length, 2);
    assert.equal(gate.snapshot().active, 2);
    assert.equal(leases[0].release({ providerDrained: false }), false);
    assert.equal(gate.snapshot().active, 2);
    leases[0].release({ providerDrained: true });
    leases[0].release({ providerDrained: true });
    assert.equal(gate.snapshot().active, 1);
});
test('the same mono-account cannot enter twice; another authorized account can use the other slot', () => {
    const gate = createEnrichmentNetworkAdmission();
    assert.ok(gate.acquire({ accountKey: 'account-a', hostKey: 'same-host' }));
    assert.equal(gate.acquire({ accountKey: 'account-a', hostKey: 'same-host' }), null);
    assert.ok(gate.acquire({ accountKey: 'account-b', hostKey: 'same-host' }));
    assert.equal(gate.acquire({ accountKey: '', hostKey: '' }), null);
    assert.throws(() => createEnrichmentNetworkAdmission({ maximum: 50 }));
});

test('a bounded batch immediately reuses the existing per-file path without detached work', async () => {
    const { processAutomaticVodLanguageBatch: batch } = await loaded;
    let calls = 0;
    const result = await batch({ now: () => 0, runOne: async () => { calls++; return {
        processed: 1, identified: 1, attempted: 1, scanned: 4, hasMore: true }; } });
    assert.equal(calls, 4); assert.equal(result.identified, 4); assert.equal(result.scanned, 16);
});
test('batch preserves progress and yields on busy, failed, deferred, empty or exhausted work', async () => {
    const { processAutomaticVodLanguageBatch: batch } = await loaded;
    for (const last of [{ skipped: 'intake-busy' }, { failed: 1 }, { deferred: 1 }, { exhausted: true },
        { hasMore: false }, { processed: 0, scanned: 0 }]) {
        let calls = 0;
        const result = await batch({ now: () => 0, runOne: async () => ++calls === 1 ? { processed: 1, verified: 1 } : last });
        assert.equal(calls, 2); assert.equal(result.verified, 1);
    }
});
test('batch will not start another probe without a cleanup allowance or swallow an ACK exception', async () => {
    const { processAutomaticVodLanguageBatch: batch } = await loaded;
    let at = 0; let calls = 0;
    await batch({ now: () => at, runOne: async () => { calls++; at = 31000; return { processed: 1 }; } });
    assert.equal(calls, 1);
    await assert.rejects(batch({ runOne: async () => { throw Error('ack-lost'); } }), /ack-lost/);
    await assert.rejects(batch({ maximum: 100, runOne: async () => ({}) }), /Invalid/);
});
test('real Edge metadata refresh cannot use an inference capacity value as a fallback', async () => {
    const calls = [];
    let health = { ok: true, languageBackgroundCapacity: { protocol: 1, maxWorkers: 2 } };
    const context = vm.createContext({ AbortSignal, Number, recordOrEmpty: v => v || {},
        getRuntimeConfig: async () => ({ mediaGatewayUrl: 'http://private.invalid' }),
        fetch: async () => ({ ok: true, json: async () => health }) });
    const start = edge.indexOf('async function refreshLanguageBackgroundCapacity(');
    vm.runInContext(stripTypeScriptTypes(edge.slice(start, edge.indexOf('async function processOneLanguageValidationTrack(', start))), context);
    const db = { rpc: async (name, args) => { calls.push({ name, args }); return { data: true }; } };
    assert.equal(await context.refreshLanguageBackgroundCapacity(db, 'metadata'), false);
    assert.equal(calls.length, 0);
    health.languageMetadataCapacity = { protocol: 1, maxWorkers: 1, reason: 'capacity-available', observedAt: 'fixture' };
    assert.equal(await context.refreshLanguageBackgroundCapacity(db, 'metadata'), true);
    assert.equal(calls[0].name, 'report_catalog_language_metadata_capacity');
});
test('real Edge batch selection requires a server-only feature flag and preserves the legacy fallback', async () => {
    const { processAutomaticVodLanguageBatch } = await loaded;
    const calls = [];
    const context = vm.createContext({ processAutomaticVodLanguageBatch,
        runAutomaticVodLanguageIntake: async (...args) => { calls.push(args[3]); return { processed: 1 }; } });
    const start = edge.indexOf('async function runAutomaticVodLanguageMetadataBatch(');
    vm.runInContext(stripTypeScriptTypes(edge.slice(start, edge.indexOf('// Automatic UNTAGGED', start))), context);
    for (const flag of [{ data: false }, { error: true }, { data: true }]) {
        calls.length = 0;
        await context.runAutomaticVodLanguageMetadataBatch({ rpc: async () => flag }, 'u', 's');
        assert.deepEqual(calls, flag.data === true ? ['metadata', 'metadata', 'metadata', 'metadata'] : [undefined]);
    }
});
test('network reservation is bound to the production probe and both strict route entries', () => {
    assert.equal((gateway.match(/claimNetwork: LANGUAGE_METADATA_LANE_ENABLED \? claimLanguageEnrichmentNetwork/g) || []).length, 3);
    const probe = gateway.slice(gateway.indexOf('async function handleProbeAudioRequest('), gateway.indexOf("app.post('/probe-audio'"));
    assert.ok(probe.indexOf('options.claimNetwork') < probe.indexOf('await probeCodecProfile('));
    assert.match(probe, /networkLease\?\.release\(drainAttestation\)/);
    const handler = gateway.slice(gateway.indexOf('async function handleDetectLanguageRequest('), gateway.indexOf('function buildStrictLidWindowFinalizePendingObservability('));
    assert.ok(handler.indexOf('closeStrictBrokerForResponse(false)') < handler.indexOf('await runStrictWhisperBatch('));
    assert.match(handler, /if \(forResponse && strictWorkBudgetTimer/);
});
