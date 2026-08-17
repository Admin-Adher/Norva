const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  STRICT_LID_WINDOW_RECEIPT_MAX_CHARS,
  STRICT_LID_WINDOW_RECEIPT_TTL_MS,
  createStrictLidWindowReceipt,
  openStrictLidWindowReceipt,
  validateStrictLidWindowReceiptsInput,
} = require('../services/media-gateway/src/strict-lid-window-checkpoint');
const {
  resolveStrictLidConsensus,
} = require('../services/media-gateway/src/strict-lid-batch');

const SECRET = 'gateway-test-secret-with-at-least-sixteen-bytes';
const NOW = Date.UTC(2026, 7, 17, 0, 0, 0);

function hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function binding(overrides = {}) {
  return {
    jobId: '123e4567-e89b-42d3-a456-426614174000',
    profileFingerprint: hex('profile'),
    userId: 'user-123',
    trackIndex: 2,
    fileSizeBytes: 987654321,
    durationSeconds: 7248.048,
    windowOrdinal: 1,
    windowCount: 6,
    offsetMilliseconds: 594004,
    method: 'whisper-strict-consensus-v4',
    configDigest: hex('config-v103'),
    modelDigest: hex('model-small'),
    ...overrides,
  };
}

function evidence(overrides = {}) {
  const base = {
    disposition: 'accepted',
    diversity: {
      fingerprint: hex('bonjour tout le monde'),
      shingles: ['bon', 'onj', 'njo', 'jou', 'our'],
    },
    result: {
      language: 'fr',
      candidate: 'fr',
      confidence: 0.991,
      confident: true,
      verified: false,
      validationStatus: 'pending',
      method: 'whisper-strict-consensus-v4',
      consensus: 0,
      whisperLang: 'fr',
      transcriptLang: 'fr',
      transcriptAgrees: true,
      minProbability: 0.95,
      wordCount: 18,
      uniqueWordCount: 14,
      transcriptEvidenceBasis: 'whitespace-words',
      scriptCharacterCount: 0,
      uniqueScriptCharacterCount: 0,
      uniqueScriptBigramCount: 0,
      scriptDensity: 0,
      offset: 594.004,
    },
  };
  return {
    ...base,
    ...overrides,
    diversity: { ...base.diversity, ...(overrides.diversity || {}) },
    result: { ...base.result, ...(overrides.result || {}) },
  };
}

function receipt(options = {}) {
  return createStrictLidWindowReceipt({
    secret: options.secret || SECRET,
    binding: options.binding || binding(),
    evidence: options.evidence || evidence(),
    nowMs: options.nowMs ?? NOW,
    randomBytesImpl: options.randomBytesImpl || (() => Buffer.alloc(12, 7)),
  });
}

function expectCheckpointCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

const SIX_OFFSETS_MS = [594004, 1802012, 3010020, 4218028, 5426036, 6634044];

function evidenceForOrdinal(ordinal, overrides = {}) {
  const marker = `window-${ordinal}-${String.fromCharCode(96 + ordinal)}`;
  return evidence({
    ...overrides,
    diversity: {
      fingerprint: hex(marker),
      shingles: [`w${ordinal}a`, `w${ordinal}b`, `w${ordinal}c`],
      ...(overrides.diversity || {}),
    },
    result: {
      offset: SIX_OFFSETS_MS[ordinal - 1] / 1000,
      ...(overrides.result || {}),
    },
  });
}

function sealedEvidenceSet(overridesByOrdinal = new Map()) {
  return Array.from({ length: 6 }, (_, index) => {
    const ordinal = index + 1;
    const bound = binding({
      windowOrdinal: ordinal,
      offsetMilliseconds: SIX_OFFSETS_MS[index],
    });
    return receipt({
      binding: bound,
      evidence: evidenceForOrdinal(ordinal, overridesByOrdinal.get(ordinal) || {}),
      randomBytesImpl: () => Buffer.alloc(12, ordinal),
    });
  });
}

function openEvidenceSet(receipts) {
  return receipts.map((token, index) => openStrictLidWindowReceipt({
    secret: SECRET,
    receipt: token,
    binding: binding({
      windowOrdinal: index + 1,
      offsetMilliseconds: SIX_OFFSETS_MS[index],
    }),
    nowMs: NOW,
  }));
}

test('window receipt is a bounded five-segment AEAD envelope and round-trips only safe evidence', () => {
  const token = receipt();
  assert.match(
    token,
    /^v1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/,
  );
  assert.ok(token.length <= STRICT_LID_WINDOW_RECEIPT_MAX_CHARS);
  assert.doesNotMatch(token, /bonjour|provider|https|user-123|987654321/i);

  const opened = openStrictLidWindowReceipt({
    secret: SECRET,
    receipt: token,
    binding: binding(),
    nowMs: NOW + 1,
  });
  assert.equal(opened.disposition, 'accepted');
  assert.equal(opened.result.language, 'fr');
  assert.equal(opened.result.wordCount, 18);
  assert.equal(opened.result.offset, 594.004);
  assert.deepEqual(opened.diversity.shingles, ['bon', 'onj', 'njo', 'jou', 'our']);
  assert.equal('sample' in opened.result, false);
});

test('receipt key id is stable across restarts sharing the same secret and changes on rotation', () => {
  const first = receipt({ randomBytesImpl: () => Buffer.alloc(12, 1) });
  const restarted = receipt({ randomBytesImpl: () => Buffer.alloc(12, 2) });
  const rotated = receipt({
    secret: 'rotated-gateway-secret-with-at-least-sixteen-bytes',
    randomBytesImpl: () => Buffer.alloc(12, 3),
  });
  assert.equal(first.split('.')[1], restarted.split('.')[1]);
  assert.notEqual(first.split('.')[1], rotated.split('.')[1]);
  expectCheckpointCode(() => openStrictLidWindowReceipt({
    secret: 'rotated-gateway-secret-with-at-least-sixteen-bytes',
    receipt: first,
    binding: binding(),
    nowMs: NOW,
  }), 'STRICT_LID_WINDOW_RECEIPT_INCOMPATIBLE');
});

test('tamper of version, kid, iv, ciphertext or tag fails closed', () => {
  const token = receipt();
  const parts = token.split('.');
  const flip = (value) => `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  const variants = [
    { token: ['v2', ...parts.slice(1)].join('.'), code: 'STRICT_LID_WINDOW_RECEIPT_INVALID' },
    {
      token: [parts[0], `${parts[1][0] === '0' ? '1' : '0'}${parts[1].slice(1)}`, ...parts.slice(2)].join('.'),
      code: 'STRICT_LID_WINDOW_RECEIPT_INCOMPATIBLE',
    },
    {
      token: [parts[0], parts[1], flip(parts[2]), ...parts.slice(3)].join('.'),
      code: 'STRICT_LID_WINDOW_RECEIPT_INVALID',
    },
    {
      token: [...parts.slice(0, 3), flip(parts[3]), parts[4]].join('.'),
      code: 'STRICT_LID_WINDOW_RECEIPT_INVALID',
    },
    {
      token: [...parts.slice(0, 4), flip(parts[4])].join('.'),
      code: 'STRICT_LID_WINDOW_RECEIPT_INVALID',
    },
  ];
  for (const variant of variants) {
    expectCheckpointCode(() => openStrictLidWindowReceipt({
      secret: SECRET,
      receipt: variant.token,
      binding: binding(),
      nowMs: NOW,
    }), variant.code);
  }
});

test('receipt cannot cross job, profile, user, track, file, duration, ordinal, count, config or model', () => {
  const token = receipt();
  const mismatches = [
    { jobId: '223e4567-e89b-42d3-a456-426614174000' },
    { profileFingerprint: hex('other-profile') },
    { userId: 'other-user' },
    { trackIndex: 3 },
    { fileSizeBytes: 987654322 },
    { durationSeconds: 7248.049 },
    { windowOrdinal: 2, offsetMilliseconds: 1802000 },
    { windowCount: 4, windowOrdinal: 1, offsetMilliseconds: 896006 },
    { configDigest: hex('other-config') },
    { modelDigest: hex('other-model') },
  ];
  for (const mismatch of mismatches) {
    expectCheckpointCode(() => openStrictLidWindowReceipt({
      secret: SECRET,
      receipt: token,
      binding: binding(mismatch),
      nowMs: NOW,
    }), 'STRICT_LID_WINDOW_RECEIPT_INVALID');
  }
});

test('receipt expires at exactly two hours and rejects an invalid clock lifetime', () => {
  const token = receipt();
  assert.equal(STRICT_LID_WINDOW_RECEIPT_TTL_MS, 7_200_000);
  assert.equal(openStrictLidWindowReceipt({
    secret: SECRET,
    receipt: token,
    binding: binding(),
    nowMs: NOW + STRICT_LID_WINDOW_RECEIPT_TTL_MS - 1,
  }).result.language, 'fr');
  expectCheckpointCode(() => openStrictLidWindowReceipt({
    secret: SECRET,
    receipt: token,
    binding: binding(),
    nowMs: NOW + STRICT_LID_WINDOW_RECEIPT_TTL_MS,
  }), 'STRICT_LID_WINDOW_RECEIPT_EXPIRED');
});

test('complete receipt input is exactly four or six bounded strings', () => {
  const four = Array.from({ length: 4 }, () => receipt());
  const six = Array.from({ length: 6 }, () => receipt());
  assert.equal(validateStrictLidWindowReceiptsInput(four, 4).length, 4);
  assert.equal(validateStrictLidWindowReceiptsInput(six, 6).length, 6);
  expectCheckpointCode(
    () => validateStrictLidWindowReceiptsInput(four, 6),
    'STRICT_LID_WINDOW_RECEIPTS_INVALID',
  );
  expectCheckpointCode(
    () => validateStrictLidWindowReceiptsInput([...six, receipt()], 6),
    'STRICT_LID_WINDOW_RECEIPTS_INVALID',
  );
  expectCheckpointCode(
    () => validateStrictLidWindowReceiptsInput([1, ...four.slice(1)], 4),
    'STRICT_LID_WINDOW_RECEIPTS_INVALID',
  );
});

test('receipt creation drops transcript-like extra fields and enforces exact bound inputs', () => {
  const token = receipt({ evidence: evidence({ result: { sample: 'secret transcript' } }) });
  assert.doesNotMatch(token, /secret|transcript/i);
  const opened = openStrictLidWindowReceipt({
    secret: SECRET,
    receipt: token,
    binding: binding(),
    nowMs: NOW,
  });
  assert.equal('sample' in opened.result, false);
  expectCheckpointCode(() => receipt({
    evidence: evidence({ diversity: { shingles: Array.from({ length: 4097 }, () => 'abc') } }),
  }), 'STRICT_LID_WINDOW_EVIDENCE_INVALID');
  expectCheckpointCode(() => receipt({
    evidence: evidence({ result: { offset: 594.005 } }),
  }), 'STRICT_LID_WINDOW_EVIDENCE_INVALID');
});

test('six ordered receipts replay every window into the unchanged strict consensus', () => {
  const receipts = sealedEvidenceSet();
  const complete = validateStrictLidWindowReceiptsInput(receipts, 6);
  const summary = resolveStrictLidConsensus(openEvidenceSet(complete), 4);
  assert.equal(summary.evaluatedSampleCount, 6);
  assert.equal(summary.acceptedSamples.length, 6);
  assert.equal(summary.verified, true);
  assert.equal(summary.votes.get('fr'), 6);
  expectCheckpointCode(
    () => validateStrictLidWindowReceiptsInput(receipts.slice(0, 5), 6),
    'STRICT_LID_WINDOW_RECEIPTS_INVALID',
  );
});

test('a strong conflict in ordinal five vetoes four earlier unanimous receipts', () => {
  const receipts = sealedEvidenceSet(new Map([[5, {
    disposition: 'conflict',
    result: {
      language: null,
      candidate: 'en',
      confident: false,
      whisperLang: 'en',
      transcriptLang: 'fr',
      transcriptAgrees: false,
    },
  }]]));
  const summary = resolveStrictLidConsensus(openEvidenceSet(receipts), 4);
  assert.equal(summary.evaluatedSampleCount, 6);
  assert.equal(summary.rejectedSpeechSampleCount, 1);
  assert.equal(summary.verified, false);
});

test('repeated, weak and insufficient receipts remain evaluated and cannot disappear on retry', () => {
  const firstDiversity = evidenceForOrdinal(1).diversity;
  const receipts = sealedEvidenceSet(new Map([
    [4, {
      disposition: 'weak',
      result: { language: null, confident: false, confidence: 0.7 },
    }],
    [5, {
      disposition: 'insufficient',
      diversity: { fingerprint: hex(''), shingles: [] },
      result: {
        language: null,
        confident: false,
        wordCount: 2,
        uniqueWordCount: 2,
        transcriptEvidenceBasis: 'insufficient',
      },
    }],
    [6, { diversity: firstDiversity }],
  ]));
  const summary = resolveStrictLidConsensus(openEvidenceSet(receipts), 4);
  assert.equal(summary.evaluatedSampleCount, 6);
  assert.equal(summary.ignoredWeakSpeechSampleCount, 1);
  assert.equal(summary.insufficientSpeechSampleCount, 1);
  assert.equal(summary.repeatedSpeechSampleCount, 1);
  assert.equal(summary.acceptedSamples.length, 3);
  assert.equal(summary.verified, false);
});

test('receipt order is cryptographically bound so duplicate and reordered arrays fail', () => {
  const receipts = sealedEvidenceSet();
  const duplicate = [...receipts];
  duplicate[1] = duplicate[0];
  const reordered = [...receipts];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  for (const invalid of [duplicate, reordered]) {
    expectCheckpointCode(() => openEvidenceSet(invalid), 'STRICT_LID_WINDOW_RECEIPT_INVALID');
  }
});
