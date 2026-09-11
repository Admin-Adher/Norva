'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createEnrichmentNetworkAdmission } = require('../services/media-gateway/src/enrichment-network-admission');
const gateway = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
const section = (start, end) => gateway.slice(gateway.indexOf(start), gateway.indexOf(end, gateway.indexOf(start)));
function response() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setHeader = () => {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = payload => { res.payload = payload; res.writableEnded = true; return payload; };
    return res;
}
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
function claim(gate, key) {
    return () => {
        const lease = gate.acquire({ accountKey: key, hostKey: 'fixture.invalid' });
        if (lease) return lease;
        throw Object.assign(Error('capacity occupied'), { code: 'LANGUAGE_ENRICHMENT_CAPACITY_BUSY', status: 429 });
    };
}

function probeFixture({ probeBarrier, drainBarrier, drainFails = false } = {}) {
    let probes = 0;
    const profile = { probeSource: 'gatewayprobe', audioTracks: [{ index: 1, language: 'en' }], subtitles: [] };
    const run = vm.runInNewContext(`(${section('async function handleProbeAudioRequest(', "app.post('/probe-audio'").trim()})`, {
        createProviderProbeDrainState: () => ({ providerProbeStarted: false }),
        isHttpUrl: () => true, sanitizeUserAgent: x => x,
        proxyKeyFromUrl: x => x, accountSlotBusyLocally: () => false, accountExtractions: new Map(),
        ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH: 'fixture',
        probeCodecProfile: async (_url, _ua, options) => {
            probes++; options.providerDrainState.providerProbeStarted = true;
            if (probeBarrier) await probeBarrier.promise;
            return profile;
        },
        normalizeCodecToken: x => x, hasCompleteMkvPlaybackProfile: () => true,
        hasUsefulCodecProfile: () => true, publicMkvCodecProfile: x => x,
        providerProbeDrainAttestation: async () => {
            if (drainBarrier) await drainBarrier.promise;
            if (drainFails) throw Error('uncertain drain');
            return { providerDrained: true, providerDrainProtocol: 1 };
        },
    });
    return { run, probes: () => probes };
}

test('actual probe handler holds the shared reservation through provider drain, not just ffprobe exit', async () => {
    const gate = createEnrichmentNetworkAdmission();
    const probeBarrier = deferred(); const drainBarrier = deferred();
    const f = probeFixture({ probeBarrier, drainBarrier });
    const first = response();
    const running = f.run({ body: { url: 'https://fixture.invalid/file' } }, first, { claimNetwork: claim(gate, 'account') });
    await new Promise(r => setImmediate(r));
    assert.equal(f.probes(), 1); assert.equal(gate.snapshot().active, 1);
    probeBarrier.resolve();
    await new Promise(r => setImmediate(r));
    assert.equal(gate.snapshot().active, 1);
    const second = response();
    await f.run({ body: { url: 'https://fixture.invalid/other-file' } }, second, { claimNetwork: claim(gate, 'account') });
    assert.equal(second.statusCode, 429); assert.equal(f.probes(), 1);
    assert.equal(second.payload.providerDrained, true); // This rejected request did no I/O.
    assert.equal(gate.snapshot().active, 1); // It cannot release the FIRST request.
    drainBarrier.resolve(); await running;
    assert.equal(first.payload.audioLanguages[0], 'en'); assert.equal(gate.snapshot().active, 0);
});

test('actual probe cleanup uncertainty never frees a provider reservation or attests success', async () => {
    const gate = createEnrichmentNetworkAdmission(); const f = probeFixture({ drainFails: true });
    const res = response();
    await f.run({ body: { url: 'https://fixture.invalid/file' } }, res, { claimNetwork: claim(gate, 'account') });
    assert.equal(res.statusCode, 502); assert.equal(res.payload.code, 'provider_drain_unconfirmed');
    assert.notEqual(res.payload.providerDrained, true); assert.equal(gate.snapshot().active, 1);
});

function strictFixture({ closeFails = false } = {}) {
    const events = []; const timers = new Set(); const gate = createEnrichmentNetworkAdmission();
    const signed = { uid: 'fixture', url: 'https://fixture.invalid/file', fileSizeBytes: 1000000,
        durationSeconds: 3600, windowCheckpointProtocol: 1 };
    const window = { durationSeconds: 3600, windowOrdinal: 1, windowCount: 6, offsets: [100, 700, 1300, 1900, 2500, 3100] };
    const run = vm.runInNewContext(`(${section('async function handleDetectLanguageRequest(', 'function buildStrictLidWindowFinalizePendingObservability(').trim()})`, {
        AbortController, Date, Math, Number, Object, String,
        console: { info() {} },
        detectLanguageRequestPolicy: () => ({ strict: true }),
        validateDetectLanguageCapability: () => ({ claims: signed }),
        STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL: 1, STRICT_LID_REQUEST_BUDGET_MS: 225000,
        STRICT_LID_DRAIN_RESPONSE_RESERVE_MS: 5000, STRICT_LID_SAMPLE_DURATION_CAP_SECONDS: 20,
        normalizeStrictLidFileSize: x => x, normalizeStrictLidTimelineDurationSeconds: x => x,
        WHISPER_BIN: '/fixture', WHISPER_MODEL: '/fixture', WHISPER_STRICT_CONSENSUS: 4,
        rejectWhileLidBenchmarkRuns: () => false, FFMPEG_USER_AGENT: 'fixture',
        strictLidTimelineOffsets: () => window.offsets, strictLidWindowClaimContext: () => window,
        setTimeout: callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
        clearTimeout: timer => timers.delete(timer),
        createStrictLidBroker: async () => { events.push('broker-open'); return {
            inputUrl: 'http://127.0.0.1/fixture', providerFetches: 0,
            async close() { events.push('provider-drain'); if (closeFails) throw Error('drain failed'); },
        }; },
        accountJobKey: () => 'fixture', proxyKeyFromUrl: () => 'fixture', sha256Hex: () => 'fixture',
        isAccountJobBusy: () => false, accountSlotBusyLocally: () => false,
        buildStrictLidExtractionObservability: () => ({}),
        planStrictSpeechWindow: () => ({ searchStartSeconds: 80, searchDurationSeconds: 60 }),
        strictLidWindowExtractionBudget: () => ({ timeoutMs: 10000 }),
        withAccountJobLock: async (_key, fn) => fn(),
        extractAudioWav: async () => { events.push('extracted'); return { ok: true, path: '/fixture/raw.wav' }; },
        runStrictSpeechSampler: async () => ({ ok: true, offset: 100, selection: {} }),
        fsp: { unlink: async () => {} }, strictLidPostExtractionFailure: () => null,
        strictLidWhisperBatchTimeoutMs: () => 10000,
        runStrictWhisperBatch: async () => {
            events.push('inference');
            assert.equal(gate.snapshot().active, 0, 'network must be available before CPU inference');
            assert.equal(timers.size, 1, 'original work deadline must still be armed');
            return { ok: true, evaluatedSamples: [{ disposition: 'accepted', result: { wordCount: 20, uniqueWordCount: 15 } }] };
        },
        strictLidBatchOutcome: () => 'succeeded', GATEWAY_TOKEN: 'fixture-secret',
        strictLidWindowReceiptBinding: () => ({}), createStrictLidWindowReceipt: () => 'opaque-receipt',
        cleanupStrictLidFiles: async () => events.push('audio-cleaned'),
    });
    return { run, events, timers, gate };
}

test('actual strict route releases drained network before inference without cancelling its original time budget', async () => {
    const f = strictFixture(); const res = response();
    await f.run({ query: { strict: '1', index: '1' } }, res, 'fixture-capability', { claimNetwork: claim(f.gate, 'account') });
    assert.equal(res.statusCode, 200); assert.equal(res.payload.receipt, 'opaque-receipt');
    assert.equal(res.payload.providerDrained, true);
    assert.deepEqual(f.events, ['broker-open', 'extracted', 'provider-drain', 'inference', 'audio-cleaned']);
    assert.equal(f.timers.size, 0);
});

test('actual strict route does not compute, create a receipt or free a slot if drain fails', async () => {
    const f = strictFixture({ closeFails: true }); const res = response();
    await f.run({ query: { strict: '1', index: '1' } }, res, 'fixture-capability', { claimNetwork: claim(f.gate, 'account') });
    assert.equal(res.statusCode, 502); assert.equal(res.payload.code, 'strict_lid_drain_failed');
    assert.notEqual(res.payload.providerDrained, true); assert.equal(res.payload.receipt, undefined);
    assert.ok(!f.events.includes('inference')); assert.equal(f.gate.snapshot().active, 1);
});
