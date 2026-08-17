const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const gateway = fs.readFileSync(
  path.join(root, 'services/media-gateway/src/index.js'),
  'utf8',
);
const handlerStart = gateway.indexOf('async function handleDetectLanguageRequest(');
const finalizeStart = gateway.indexOf('async function handleFinalizeStrictLidWindows(');
const capabilityHeaderStart = gateway.indexOf('function detectLanguageCapabilityFromHeader(', finalizeStart);
const handler = gateway.slice(handlerStart, finalizeStart);
const finalizeHandler = gateway.slice(finalizeStart, capabilityHeaderStart);

function timingHarness() {
  const start = gateway.indexOf('const STRICT_LID_SAMPLE_DURATION_CAP_SECONDS = 20;');
  const end = gateway.indexOf('function strictLanguageSampleDisposition(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(
    `(() => { ${gateway.slice(start, end)}; return {
      strictLidExtractionBudget,
      strictLidWindowExtractionBudget,
      strictLidWhisperBatchTimeoutMs,
      strictLidPostExtractionFailure,
    }; })()`,
    { Date, Math, Number, String },
  );
}

function responseHarness() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

function earlyDetectLanguageHarness(claims) {
  return vm.runInNewContext(`(${handler.trim()})`, {
    STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL: 1,
    WHISPER_BIN: null,
    WHISPER_MODEL: null,
    detectLanguageRequestPolicy: (req) => ({
      strict: String(req?.query?.strict || '') === '1',
      requiredScope: 'language-validation',
    }),
    validateDetectLanguageCapability: () => ({ claims, status: 200, error: null }),
  });
}

test('window and finalize capabilities cannot downgrade into non-strict POST or legacy GET', async () => {
  for (const windowFinalize of [undefined, true]) {
    const run = earlyDetectLanguageHarness({
      windowCheckpointProtocol: 1,
      ...(windowFinalize === true ? { windowFinalize: true } : {}),
    });
    for (const req of [
      { method: 'POST', query: {} },
      { method: 'POST', query: { strict: '0' } },
      { method: 'GET', query: {} },
    ]) {
      const res = responseHarness();
      await run(req, res, 'signed-window-capability');
      assert.equal(res.statusCode, 400);
      assert.equal(res.payload.code, 'strict_lid_window_claims_invalid');
      assert.equal(res.payload.providerDrained, true);
      assert.equal(res.payload.providerDrainProtocol, 1);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  }

  const legacy = earlyDetectLanguageHarness({ scope: 'language-validation' });
  const legacyRes = responseHarness();
  await legacy({ method: 'POST', query: {} }, legacyRes, 'legacy-capability');
  assert.equal(legacyRes.statusCode, 503, 'a legacy marker-free capability keeps its old lane');
});

test('v103 exposes additive window checkpoint budgets and leaves legacy v102 limits present', () => {
  assert.match(gateway, /const GATEWAY_VERSION = 103;/);
  assert.match(gateway, /strictLidExtractionTimeoutProtocol: 4/);
  assert.match(gateway, /strictLidWindowCheckpointProtocol: STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL/);
  assert.match(gateway, /strictLidWindowEvidenceEnvelopeProtocol: STRICT_LID_WINDOW_ENVELOPE_PROTOCOL/);
  assert.match(gateway, /strictLidWindowExtractionBudgetMs: STRICT_LID_WINDOW_EXTRACTION_BUDGET_MS/);
  assert.match(gateway, /strictLidCheckpointFfmpegRwTimeoutUs: STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US/);
  assert.match(gateway, /const STRICT_LID_WINDOW_EXTRACTION_BUDGET_MS = 165_000;/);
  assert.match(gateway, /const STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US = 170_000_000;/);
  assert.match(gateway, /const STRICT_LID_FFMPEG_RW_TIMEOUT_US = 50_000_000;/);
});

test('a fresh window attempt survives the live 20.928s and >45s observations but stays bounded at 165s', () => {
  const timing = timingHarness();
  const legacy = timing.strictLidExtractionBudget(20, 215_000, 0);
  const firstAttempt = timing.strictLidWindowExtractionBudget(215_000, 0);
  const secondAttempt = timing.strictLidWindowExtractionBudget(215_000, 0);
  assert.equal(legacy.timeoutMs, 45_000);
  assert.equal(firstAttempt.timeoutMs, 165_000);
  assert.equal(secondAttempt.timeoutMs, 165_000);
  assert.ok(20_928 < firstAttempt.timeoutMs);
  assert.ok(90_000 > legacy.timeoutMs && 90_000 < secondAttempt.timeoutMs);
  assert.equal(timing.strictLidWindowExtractionBudget(215_000, 164_999).timeoutMs, 1);
  assert.equal(timing.strictLidWindowExtractionBudget(215_000, 165_000).timeoutMs, 0);
  assert.equal(timing.strictLidWhisperBatchTimeoutMs(215_000, true, 0), 50_000);
  assert.equal(timing.strictLidWhisperBatchTimeoutMs(215_000, true, 165_000), 50_000);
  assert.equal(timing.strictLidWhisperBatchTimeoutMs(215_000, true, 180_000), 35_000);
  assert.equal(timing.strictLidWhisperBatchTimeoutMs(215_000, false, 0), 215_000);
  const timeout = timing.strictLidPostExtractionFailure({ extractionTimedOut: true });
  assert.equal(timeout.status, 504);
  assert.equal(timeout.payload.code, 'strict_lid_extraction_timeout');
  assert.equal('receipt' in timeout.payload, false);
});

test('window capability selects exactly one signed ordinal and cannot select an offset from query input', () => {
  assert.ok(handlerStart >= 0 && finalizeStart > handlerStart);
  assert.match(handler, /claims\.windowCheckpointProtocol === STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL/);
  assert.match(handler, /strictLidWindowClaimContext\(claims, trackIndex\)/);
  assert.match(
    handler,
    /\[strictWindowContext\.offsets\[strictWindowContext\.windowOrdinal - 1\]\]/,
  );
  assert.match(handler, /strictLidWindowExtractionBudget\(strictWorkDeadlineAt\)/);
  assert.match(handler, /strictLidWhisperBatchTimeoutMs\([\s\S]*Boolean\(strictWindowContext\)/);
  assert.match(handler, /checkpointWindow: true/);
  assert.doesNotMatch(handler, /req\.query\.windowOrdinal|req\.query\.offset/);
});

test('window response is only an opaque receipt and is sent through the drain authority', () => {
  const receiptAt = handler.indexOf('const receipt = createStrictLidWindowReceipt(');
  const responseAt = handler.indexOf('return sendDetectionJson(200, {', receiptAt);
  const genericConsensusAt = handler.indexOf('strictEvaluatedWindowCount = evaluated.length;', receiptAt);
  assert.ok(receiptAt >= 0 && responseAt > receiptAt && genericConsensusAt > responseAt);
  const response = handler.slice(responseAt, genericConsensusAt);
  assert.match(response, /windowCheckpointProtocol: STRICT_LID_WINDOW_CHECKPOINT_PROTOCOL/);
  assert.match(response, /windowOrdinal: strictWindowContext\.windowOrdinal/);
  assert.match(response, /windowCount: strictWindowContext\.windowCount/);
  assert.match(response, /\breceipt\b/);
  assert.doesNotMatch(response, /verified|language|candidate|samples|transcript/);
  const drainAt = handler.indexOf('await closeStrictBrokerForResponse();');
  const jsonAt = handler.indexOf('return res.status(status).json(responsePayload);', drainAt);
  assert.ok(drainAt >= 0 && jsonAt > drainAt);
});

test('first broker terminal error remains ahead of timeout, Whisper and receipt issuance', () => {
  const postFailureAt = handler.indexOf('const strictPostExtractionFailure = strict');
  const terminalAt = handler.indexOf('terminalError: strictBroker?.terminalError', postFailureAt);
  const failureReturnAt = handler.indexOf('return sendDetectionJson(', terminalAt);
  const whisperAt = handler.indexOf('const batch = await runStrictWhisperBatch(', failureReturnAt);
  const receiptAt = handler.indexOf('createStrictLidWindowReceipt(', whisperAt);
  assert.ok(postFailureAt >= 0 && terminalAt > postFailureAt);
  assert.ok(failureReturnAt > terminalAt && whisperAt > failureReturnAt && receiptAt > whisperAt);
});

test('finalize has a dedicated signed capability, validates all ordered receipts and performs zero provider I/O', () => {
  assert.ok(finalizeStart >= 0 && capabilityHeaderStart > finalizeStart);
  assert.match(finalizeHandler, /strictLidWindowClaimContext\(validation\.claims, trackIndex, \{ finalize: true \}\)/);
  assert.match(finalizeHandler, /Object\.keys\(body\)\.length !== 1/);
  assert.match(finalizeHandler, /validateStrictLidWindowReceiptsInput\(body\.receipts, context\.windowCount\)/);
  assert.match(finalizeHandler, /receipts\.map\(\(receipt, index\) => openStrictLidWindowReceipt/);
  assert.match(finalizeHandler, /strictLidWindowReceiptBinding\(context, index \+ 1\)/);
  assert.match(finalizeHandler, /resolveStrictLidConsensus\(evaluated, WHISPER_STRICT_CONSENSUS\)/);
  assert.match(finalizeHandler, /providerDrained: true/);
  for (const forbidden of [
    'createStrictLidBroker',
    'extractAudioWav',
    'runStrictWhisperBatch',
    'fetch(',
    'undiciRequest',
    'withAccountJobLock',
  ]) {
    assert.equal(finalizeHandler.includes(forbidden), false, `finalize must not use ${forbidden}`);
  }
});

test('real finalize handler opens every receipt in ordinal order and attests zero-I/O drain', async () => {
  class CheckpointError extends Error {}
  const openedOrdinals = [];
  const context = {
    windowCount: 6,
  };
  const finalize = vm.runInNewContext(`(${finalizeHandler.trim()})`, {
    LID_LEGACY_FULL_SCOPE: 'lid-legacy-full',
    GATEWAY_TOKEN: 'gateway-secret',
    WHISPER_STRICT_CONSENSUS: 4,
    StrictLidWindowCheckpointError: CheckpointError,
    validateDetectLanguageCapability: () => ({ claims: { ok: true }, status: 200, error: null }),
    strictLidWindowClaimContext: () => context,
    validateStrictLidWindowReceiptsInput: (receipts, count) => {
      assert.equal(count, 6);
      assert.equal(receipts.length, 6);
      return receipts;
    },
    strictLidWindowReceiptBinding: (_context, ordinal) => ({ ordinal }),
    openStrictLidWindowReceipt: ({ binding }) => {
      openedOrdinals.push(binding.ordinal);
      return { result: { language: 'fr' }, disposition: 'accepted', diversity: {} };
    },
    resolveStrictLidConsensus: (entries, needed) => {
      assert.equal(entries.length, 6);
      assert.equal(needed, 4);
      return { evaluatedSampleCount: 6 };
    },
    strictLidWindowConsensusPayload: (summary, count, needed) => {
      assert.equal(summary.evaluatedSampleCount, 6);
      assert.equal(count, 6);
      assert.equal(needed, 4);
      return { verified: true, method: 'whisper-strict-consensus-v4' };
    },
  });
  const req = {
    query: { index: '2' },
    body: { receipts: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'] },
  };
  const res = responseHarness();
  await finalize(req, res, 'capability');
  assert.deepEqual(openedOrdinals, [1, 2, 3, 4, 5, 6]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.verified, true);
  assert.equal(res.payload.providerDrained, true);
  assert.equal(res.payload.providerDrainProtocol, 1);
});

test('real finalize handler maps receipt authentication failure to reset-required before consensus', async () => {
  class CheckpointError extends Error {}
  let consensusCalls = 0;
  const finalize = vm.runInNewContext(`(${finalizeHandler.trim()})`, {
    LID_LEGACY_FULL_SCOPE: 'lid-legacy-full',
    GATEWAY_TOKEN: 'gateway-secret',
    WHISPER_STRICT_CONSENSUS: 4,
    StrictLidWindowCheckpointError: CheckpointError,
    validateDetectLanguageCapability: () => ({ claims: { ok: true }, status: 200, error: null }),
    strictLidWindowClaimContext: () => ({ windowCount: 4 }),
    validateStrictLidWindowReceiptsInput: () => {
      throw new CheckpointError('tampered');
    },
    strictLidWindowReceiptBinding: () => ({}),
    openStrictLidWindowReceipt: () => ({}),
    resolveStrictLidConsensus: () => { consensusCalls += 1; },
    strictLidWindowConsensusPayload: () => ({}),
  });
  const res = responseHarness();
  await finalize(
    { query: { index: '2' }, body: { receipts: ['a', 'b', 'c', 'd'] } },
    res,
    'capability',
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'strict_lid_checkpoint_reset_required');
  assert.equal(res.payload.resetRequired, true);
  assert.equal(res.payload.providerDrained, true);
  assert.equal(consensusCalls, 0);
});

test('checkpoint code never logs or returns sensitive evidence outside the opaque receipt', () => {
  const checkpointModule = fs.readFileSync(
    path.join(root, 'services/media-gateway/src/strict-lid-window-checkpoint.js'),
    'utf8',
  );
  assert.doesNotMatch(checkpointModule, /console\.|providerSourceUrl|capabilityToken|claims\.url/);
  assert.doesNotMatch(checkpointModule, /\bsample\s*:/);
  assert.doesNotMatch(finalizeHandler, /console\.|receipt\)|JSON\.stringify\(.*receipt/);
});

test('legacy monolithic route remains the default when checkpoint claims are absent', () => {
  assert.match(handler, /const strictWindowRequested = strict[\s\S]*claims\.windowCheckpointProtocol/);
  assert.match(
    handler,
    /strictWindowContext[\s\S]*strictLidWindowExtractionBudget\(strictWorkDeadlineAt\)[\s\S]*strictLidExtractionBudget\(dur, strictWorkDeadlineAt\)/,
  );
  assert.match(
    handler,
    /strictWindowContext[\s\S]*\[strictWindowContext\.offsets[\s\S]*: strictTimelineOffsets/,
  );
  assert.match(handler, /if \(strict && !strictWindowContext && offsets\.length < consensusNeeded\)/);
});
