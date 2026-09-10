const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createStrictLidInference } = require('../services/media-gateway/src/strict-lid-inference');
const { createStrictLidAudioDiagnostic } = require('../services/media-gateway/src/strict-lid-audio-evidence');
const { evaluateStrictTranscriptEvidence, resolveStrictLidConsensus } = require('../services/media-gateway/src/strict-lid-batch');
const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');
const { createStrictLidWindowReceipt, openStrictLidWindowReceipt } = require('../services/media-gateway/src/strict-lid-window-checkpoint');

const gateway = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
function between(startMarker, endMarker) {
    const start = gateway.indexOf(startMarker);
    const end = gateway.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, startMarker);
    return gateway.slice(start, end).trim();
}
const samplerSource = between('async function runStrictSpeechSampler(', 'async function runStrictWhisperBatch(');
const ledgerSource = between('const accountBackgroundWhispers', '// True while THIS box holds');
const runtimeSource = between('function strictLidWindowRuntimeBinding(', 'function strictLidWindowClaimContext(');

function samplerHarness({ busy = false, busyChecks = null, runtimeVerified = true, prepare } = {}) {
    const pending = [];
    const children = [];
    const checks = busyChecks ? [...busyChecks] : null;
    const context = {
        Map, Set, Number, String, Math,
        console: { log() {}, warn() {} },
        os: { constants: { priority: { PRIORITY_LOW: 19 } }, setPriority() {} },
        process: { platform: 'linux', kill() { throw new Error('not needed'); } },
        WHISPER_SPEECH_SAMPLER_RUNTIME_VERIFIED: runtimeVerified,
        WHISPER_VAD_BIN: '/local/vad', WHISPER_VAD_MODEL: '/local/model',
        whisperInferenceActive: 0,
        createStrictLidAudioDiagnostic,
        viewerPlaybackActiveLocally: () => checks?.length ? checks.shift() : busy,
        prepareStrictLidSpeechSample: prepare || ((options) => {
            const child = { pid: 321, kills: [], kill(signal) { this.kills.push(signal); return true; } };
            children.push(child);
            options.onSpawn(child);
            return new Promise((resolve) => pending.push({ options, resolve }));
        }),
    };
    const api = vm.runInNewContext(`(() => {
        ${ledgerSource}
        ${samplerSource}
        return { runStrictSpeechSampler, preemptBackgroundWhispersGlobally,
            backgroundWhisperCount, active: () => whisperInferenceActive };
    })()`, context);
    return { ...api, pending, children };
}
const backgroundOptions = { backgroundKey: 'internal-test-account', preemptibleBackground: true, timeoutMs: 8000 };

test('sampler is not started when viewer playback or cancellation already has priority', async () => {
    let calls = 0;
    const viewer = samplerHarness({ busy: true, prepare: async () => { calls++; } });
    const busyResult = await viewer.runStrictSpeechSampler('/local/sample.wav', {}, backgroundOptions);
    assert.equal(busyResult.ok, false);
    assert.equal(busyResult.preempted, true);
    assert.equal(viewer.active(), 0);
    assert.equal(viewer.backgroundWhisperCount(), 0);
    const controller = new AbortController();
    controller.abort();
    const cancelled = samplerHarness({ prepare: async () => { calls++; } });
    const result = await cancelled.runStrictSpeechSampler('/local/sample.wav', {}, {
        ...backgroundOptions, abortSignal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(calls, 0);
});

test('sampler uses the real background ledger and releases both counters after success', async () => {
    const harness = samplerHarness();
    const pending = harness.runStrictSpeechSampler('/local/sample.wav', {}, backgroundOptions);
    assert.equal(harness.active(), 1);
    assert.equal(harness.backgroundWhisperCount(), 1);
    assert.equal(harness.pending[0].options.bin, '/local/vad');
    assert.equal(harness.pending[0].options.model, '/local/model');
    assert.equal(harness.pending[0].options.timeoutMs, 8000);
    harness.pending[0].resolve({ ok: true, offset: 1 });
    assert.equal((await pending).ok, true);
    assert.equal(harness.active(), 0);
    assert.equal(harness.backgroundWhisperCount(), 0);
});

test('viewer preemption during or racing sampler spawn cannot return accepted preparation', async () => {
    const harness = samplerHarness();
    const pending = harness.runStrictSpeechSampler('/local/sample.wav', {}, backgroundOptions);
    assert.equal(harness.preemptBackgroundWhispersGlobally('', 'test'), 1);
    assert.deepEqual(harness.children[0].kills, ['SIGKILL']);
    harness.pending[0].resolve({ ok: true });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.preempted, true);
    assert.equal(harness.active(), 0);
    assert.equal(harness.backgroundWhisperCount(), 0);

    const race = samplerHarness({ busyChecks: [false, true] });
    const raced = race.runStrictSpeechSampler('/local/sample.wav', {}, backgroundOptions);
    assert.deepEqual(race.children[0].kills, ['SIGKILL']);
    assert.equal(race.pending[0].options.isPreempted(), true);
    race.pending[0].resolve({ ok: true });
    assert.equal((await raced).preempted, true);
    assert.equal(race.active(), 0);
    assert.equal(race.backgroundWhisperCount(), 0);
});

test('sampler exceptions release the ledger and unverified runtime receives no binary or model', async () => {
    for (const afterSpawn of [false, true]) {
        const harness = samplerHarness({ prepare: async (options) => {
            if (afterSpawn) options.onSpawn({ pid: 321, kill() {} });
            throw new Error('local preparation failed');
        } });
        await assert.rejects(harness.runStrictSpeechSampler('/local/sample.wav', {}, backgroundOptions));
        assert.equal(harness.active(), 0);
        assert.equal(harness.backgroundWhisperCount(), 0);
    }
    const unavailable = samplerHarness({ runtimeVerified: false, prepare: async (options) => {
        assert.equal(options.bin, null);
        assert.equal(options.model, null);
        return { ok: true };
    } });
    await unavailable.runStrictSpeechSampler('/local/sample.wav', {}, backgroundOptions);
    assert.equal(unavailable.active(), 0);
});

function runtimeBinding(overrides = {}, source = runtimeSource) {
    return vm.runInNewContext(`(${source})()`, {
        crypto,
        WHISPER_MODEL_SHA256: 'a'.repeat(64), WHISPER_MODEL_BUILD_SHA256: 'a'.repeat(64),
        WHISPER_BIN_SHA256: 'b'.repeat(64), WHISPER_BIN_BUILD_SHA256: 'b'.repeat(64),
        STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL: 1, STRICT_LID_WINDOW_ENVELOPE_PROTOCOL: 1,
        STRICT_LID_WINDOW_METHOD: 'whisper-strict-consensus-v4', WHISPER_CPP_COMMIT: 'pinned-test',
        WHISPER_STRICT_CONSENSUS: 4, WHISPER_STRICT_MIN_PROBABILITY: 0.95,
        WHISPER_STRICT_MIN_WORDS: 12, WHISPER_STRICT_MIN_UNIQUE_WORDS: 8,
        STRICT_LID_SAMPLE_DURATION_CAP_SECONDS: 20,
        WHISPER_VAD_BIN_SHA256: 'c'.repeat(64), WHISPER_VAD_MODEL_SHA256: 'd'.repeat(64),
        WHISPER_SPEECH_SAMPLER_RUNTIME_VERIFIED: true,
        ...overrides,
    });
}

test('runtime binding prevents receipt mixing when selector identity or quality policy changes', () => {
    const original = runtimeBinding().configDigest;
    for (const override of [
        { WHISPER_VAD_BIN_SHA256: 'e'.repeat(64) },
        { WHISPER_VAD_MODEL_SHA256: 'f'.repeat(64) },
        { WHISPER_SPEECH_SAMPLER_RUNTIME_VERIFIED: false },
    ]) assert.notEqual(runtimeBinding(override).configDigest, original);
    assert.match(runtimeSource, /qualityFallbackProtocol: 1/);
    assert.notEqual(runtimeBinding({}, runtimeSource.replace('qualityFallbackProtocol: 1', 'qualityFallbackProtocol: 2')).configDigest, original);
    assert.notEqual(runtimeBinding({}, runtimeSource.replace('speechSearchDurationSeconds: 60', 'speechSearchDurationSeconds: 61')).configDigest, original);
});

test('real strict evaluator cross-pass disagreement survives the authenticated receipt as one veto', async () => {
    const evaluator = vm.runInNewContext(`(() => {
        ${between('function strictLanguageSampleDisposition(', 'const BASIC_LID_MIN_CONFIDENCE')}
        ${between('function strictLanguageBatchSampleResult(', 'function strictLidWindowRuntimeBinding(')}
        ${between('function detectLanguageFromText(', "app.post('/sessions'")}
        return strictLanguageBatchSampleResult;
    })()`, { evaluateStrictTranscriptEvidence, WHISPER_STRICT_MIN_WORDS: 12,
        WHISPER_STRICT_MIN_UNIQUE_WORDS: 8, WHISPER_STRICT_MIN_PROBABILITY: 0.95 });
    const first = { text: 'The quick brown fox and the curious young boy are walking together with their friendly dog near this quiet village today.', lang: 'en', prob: 0.8 };
    const second = { text: 'Je marche dans la ville avec les enfants et nous regardons le jardin où les fleurs sont belles pour cette journée de vacances.', lang: 'fr', prob: 0.99 };
    const offset = 604.004;
    assert.equal(evaluator(first, offset).disposition, 'weak');
    assert.equal(evaluator(second, offset).disposition, 'accepted');
    let calls = 0;
    const batch = await createStrictLidInference().run({
        vadModel: '/local/vad-model', wavPaths: ['/local/one.wav'], timeoutMs: 1000,
        evaluateSample: (sample) => evaluator(sample, offset),
    }, async () => ({ ok: true, samples: [calls++ === 0 ? first : second] }));
    assert.equal(calls, 2);
    assert.equal(batch.evaluatedSamples.length, 1);
    const value = batch.evaluatedSamples[0];
    assert.equal(value.disposition, 'conflict');
    assert.equal(value.result.qualityFallbackConflict, true);
    assert.equal(value.result.transcriptAgrees, true);
    const plan = planStrictSpeechWindow(7248.048, 1);
    const binding = {
        jobId: '123e4567-e89b-42d3-a456-426614174000', profileFingerprint: 'a'.repeat(64),
        userId: 'test-only-user', trackIndex: 2, fileSizeBytes: 1234567,
        durationSeconds: 7248.048, windowOrdinal: 1, windowCount: 6,
        offsetMilliseconds: plan.anchorOffsetMilliseconds, method: 'whisper-strict-consensus-v4',
        configDigest: runtimeBinding().configDigest, modelDigest: 'a'.repeat(64), selectionProtocol: 1,
    };
    const evidence = { ...value, selection: {
        protocol: 1, searchStartMilliseconds: plan.searchStartMilliseconds,
        searchDurationMilliseconds: plan.searchDurationMilliseconds,
        selectedOffsetMilliseconds: 604004, selectedDurationMilliseconds: 20000,
        speechMilliseconds: 16000, selector: 'silero-vad-max-speech-v1',
    } };
    const secret = 'local-test-secret-long-enough';
    const receipt = createStrictLidWindowReceipt({ secret, binding, evidence });
    const opened = openStrictLidWindowReceipt({ secret, binding, receipt });
    assert.equal(opened.disposition, 'conflict');
    assert.equal(opened.result.qualityFallbackConflict, true);
    assert.equal(opened.result.transcriptAgrees, true);
    assert.equal(opened.result.offset, offset);
    const consensus = resolveStrictLidConsensus([opened], 4);
    assert.equal(consensus.rejectedSpeechSampleCount, 1);
    assert.equal(consensus.evaluatedSampleCount, 1);
    assert.equal(consensus.verified, false);
    assert.doesNotMatch(receipt, /walking|jardin|test-only-user|1234567/);
});
