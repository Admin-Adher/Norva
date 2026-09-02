const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  buildStrictLidExtractionObservability,
  buildStrictLidUnverifiedObservability,
  buildWhisperBatchArgs,
  cleanupStrictLidFiles,
  evaluateStrictTranscriptEvidence,
  parseWhisperBatchLid,
  resolveStrictLidConsensus,
  runWhisperBatchProcess,
  normalizeStrictLidTimelineDurationSeconds,
  strictLidBatchFailureResponse,
  strictLidBatchOutcome,
  strictLidTimelineOffsets,
} = require('../services/media-gateway/src/strict-lid-batch');

class FakeChild extends EventEmitter {
  constructor({ closeOnKill = true } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
    this.closeOnKill = closeOnKill;
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.closeOnKill) setImmediate(() => this.emit('close', null));
    return true;
  }
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const handle = {};
    this.timers.set(handle, {
      at: this.now + Math.max(0, Number(delay) || 0),
      callback,
    });
    return handle;
  };

  clearTimeout = (handle) => {
    this.timers.delete(handle);
  };

  advance(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = target;
  }
}

function sixPaths(prefix) {
  return Array.from({ length: 6 }, (_, index) => `/tmp/${prefix}-${index}.wav`);
}

function languageLines(languages) {
  return languages.map(({ lang, prob }) => (
    `whisper_full_with_state: auto-detected language: ${lang} (p = ${prob})`
  )).join('\n');
}

function diversityFor(text) {
  const evidence = evaluateStrictTranscriptEvidence({
    text,
    wordCount: 20,
    minWords: 12,
    minUniqueWords: 8,
    whisperLanguage: 'fr',
    transcriptLanguage: 'fr',
    transcriptConfident: true,
  });
  return {
    fingerprint: evidence.diversityFingerprint,
    shingles: evidence.diversityShingles,
  };
}

function strictGatewayTimingHarness(gateway) {
  const start = gateway.indexOf('const STRICT_LID_SAMPLE_DURATION_CAP_SECONDS = 20;');
  const end = gateway.indexOf('function strictLanguageSampleDisposition(', start);
  assert.ok(start >= 0 && end > start, 'strict timing helpers must remain dynamically extractable');
  return vm.runInNewContext(
    `(() => { ${gateway.slice(start, end)}; return {
      strictLidSampleDurationSeconds,
      strictLidMediaExtractionTimeoutMs,
      strictLidExtractionBudget,
      strictLidPostExtractionFailure,
    }; })()`,
    { Date, Math, Number, String },
  );
}

function simulateStrictRouteBudget(timing, elapsedWindowsMs, options = {}) {
  const workDeadlineAt = options.workDeadlineAt ?? 215_000;
  const terminalAtOrdinal = Number(options.terminalAtOrdinal || 0);
  let nowMs = 0;
  let completedWindowCount = 0;
  let extractionTimedOut = false;
  let terminalError = null;
  const windows = [];

  for (const [index, rawElapsedMs] of elapsedWindowsMs.entries()) {
    const budget = timing.strictLidExtractionBudget(20, workDeadlineAt, nowMs);
    if (budget.timeoutMs <= 0) {
      extractionTimedOut = true;
      break;
    }
    const elapsedMs = Math.max(0, Number(rawElapsedMs) || 0);
    const spentMs = Math.min(elapsedMs, budget.timeoutMs);
    nowMs += spentMs;
    windows.push({ ordinal: index + 1, elapsedMs: spentMs, timeoutMs: budget.timeoutMs });
    if (index + 1 === terminalAtOrdinal) {
      terminalError = {
        status: 458,
        message: 'provider busy',
        code: 'PROVIDER_BUSY',
        upstreamStatus: 458,
      };
      extractionTimedOut = options.terminalTimedOut === true;
      break;
    }
    if (elapsedMs >= budget.timeoutMs) {
      extractionTimedOut = true;
      break;
    }
    completedWindowCount += 1;
  }

  const failure = timing.strictLidPostExtractionFailure({
    terminalError,
    extractionTimedOut,
    workBudgetExpired: nowMs >= workDeadlineAt,
  });
  const shouldRunBatch = !failure && completedWindowCount === elapsedWindowsMs.length;
  return {
    windows,
    completedWindowCount,
    elapsedMs: nowMs,
    batchCalls: shouldRunBatch ? 1 : 0,
    consensusCalls: shouldRunBatch ? 1 : 0,
    batchTimeoutMs: shouldRunBatch ? workDeadlineAt - nowMs : 0,
    failure,
  };
}

test('strict batch builds ordered multi -f/-of args and accepts exactly six ordered LID lines', () => {
  const wavPaths = sixPaths('sample');
  const outputPrefixes = sixPaths('out').map((file) => file.replace(/\.wav$/, ''));
  const args = buildWhisperBatchArgs({
    model: '/opt/whisper/model.bin',
    wavPaths,
    outputPrefixes,
    threads: 4,
  });

  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '-f'),
    wavPaths,
  );
  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '-of'),
    outputPrefixes,
  );
  assert.equal(args.filter((value) => value === '-f').length, 6);
  assert.equal(args.filter((value) => value === '-of').length, 6);

  const parsed = parseWhisperBatchLid(languageLines([
    { lang: 'fr', prob: 0.99 },
    { lang: 'en', prob: 0.98 },
    { lang: 'es', prob: 0.97 },
    { lang: 'it', prob: 0.96 },
    { lang: 'de', prob: 0.95 },
    { lang: 'pt', prob: 0.94 },
  ]), 6);
  assert.deepEqual(parsed.map((sample) => sample.lang), ['fr', 'en', 'es', 'it', 'de', 'pt']);
  assert.equal(parseWhisperBatchLid(languageLines([{ lang: 'fr', prob: 0.99 }]), 6), null);
  assert.equal(parseWhisperBatchLid(`${languageLines(Array.from({ length: 6 }, () => ({ lang: 'fr', prob: 0.99 })))}\nauto-detected language: fr (p = 0.99)`, 6), null);
  assert.equal(parseWhisperBatchLid(`${languageLines(Array.from({ length: 6 }, () => ({ lang: 'fr', prob: 0.99 })))}\nauto-detected language: broken`, 6), null);
});

test('strict batch spawns Whisper once, preserves six transcript/LID pairs, and cleans every output', async () => {
  const wavPaths = sixPaths('ordered');
  const outputPrefixes = sixPaths('ordered-out').map((file) => file.replace(/\.wav$/, ''));
  const languages = [
    { lang: 'fr', prob: 0.991 },
    { lang: 'en', prob: 0.992 },
    { lang: 'es', prob: 0.993 },
    { lang: 'it', prob: 0.994 },
    { lang: 'de', prob: 0.995 },
    { lang: 'pt', prob: 0.996 },
  ];
  const transcriptByPath = new Map(outputPrefixes.map((prefix, index) => (
    [`${prefix}.txt`, `transcript-${index}`]
  )));
  const unlinked = [];
  const spawnCalls = [];
  const child = new FakeChild();
  const resultPromise = runWhisperBatchProcess({
    bin: '/usr/local/bin/whisper-cli',
    model: '/opt/whisper/model.bin',
    wavPaths,
    outputPrefixes,
    threads: 4,
    timeoutMs: 1000,
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    readFileImpl: async (filePath) => {
      if (!transcriptByPath.has(filePath)) throw new Error('missing');
      return transcriptByPath.get(filePath);
    },
    unlinkImpl: async (filePath) => { unlinked.push(filePath); },
  });
  setImmediate(() => {
    child.stderr.emit('data', Buffer.from(languageLines(languages)));
    child.emit('close', 0);
  });

  const result = await resultPromise;
  assert.equal(spawnCalls.length, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.samples.map((sample) => sample.lang), languages.map((sample) => sample.lang));
  assert.deepEqual(result.samples.map((sample) => sample.text), Array.from({ length: 6 }, (_, index) => `transcript-${index}`));
  assert.deepEqual(unlinked.sort(), outputPrefixes.map((prefix) => `${prefix}.txt`).sort());
});

test('strict consensus verifies four strong plus two weak samples but one strong conflict vetoes', () => {
  const accepted = Array.from({ length: 4 }, (_, index) => ({
    disposition: 'accepted',
    diversity: diversityFor([
      'dans la maison rouge chacun prépare calmement le repas avant le voyage',
      'près de la rivière plusieurs amis racontent leurs souvenirs de vacances',
      'demain notre équipe traversera la montagne avec des cartes et des lampes',
      'après le concert les musiciens rangent leurs instruments dans le camion',
    ][index]),
    result: {
      offset: index * 600,
      language: 'fr',
      confidence: 0.99,
      wordCount: 20 + index,
      uniqueWordCount: 15,
      transcriptAgrees: true,
    },
  }));
  const weak = Array.from({ length: 2 }, (_, index) => ({
    disposition: 'weak',
    result: {
      offset: 3000 + index * 60,
      language: null,
      confidence: 0.82,
      wordCount: 18,
      uniqueWordCount: 12,
      transcriptAgrees: null,
    },
  }));
  const verified = resolveStrictLidConsensus([...accepted, ...weak], 4);
  assert.equal(verified.verified, true);
  assert.equal(verified.language, 'fr');
  assert.equal(verified.acceptedSamples.length, 4);
  assert.equal(verified.ignoredWeakSpeechSampleCount, 2);
  assert.equal(verified.rejectedSpeechSampleCount, 0);

  const vetoed = resolveStrictLidConsensus([
    ...accepted,
    weak[0],
    {
      disposition: 'conflict',
      result: {
        offset: 3060,
        language: null,
        confidence: 0.99,
        wordCount: 24,
        uniqueWordCount: 16,
        transcriptAgrees: false,
      },
    },
  ], 4);
  assert.equal(vetoed.verified, false);
  assert.equal(vetoed.language, null);
  assert.equal(vetoed.rejectedSpeechSampleCount, 1);
});

test('strict unverified observability is a bounded closed schema with no evidence or identifiers', () => {
  const secrets = [
    'https://provider.invalid/movie/token-value.mkv',
    'Bearer super-secret',
    'transcript words must never be logged',
    'user-661db file-a944 session-deadbeef',
    'candidate-fr offset-600 probability-0.99',
  ];
  const report = buildStrictLidUnverifiedObservability({
    extractedWindowCount: 6,
    evaluatedWindowCount: 6,
    acceptedSampleCount: 3,
    acceptedLanguageCount: 1,
    maxConsensus: 3,
    rejectedConflictCount: 0,
    ignoredWeakCount: 1,
    repeatedCount: 1,
    missingDiversityCount: 0,
    insufficientSpeechSampleCount: 1,
    batchOutcome: 'succeeded',
    url: secrets[0],
    token: secrets[1],
    transcript: secrets[2],
    providerAccountUserSessionFileIds: secrets[3],
    candidatesOffsetsProbabilities: secrets[4],
  });
  assert.deepEqual(Object.keys(report), [
    'event',
    'extractedWindowCount',
    'evaluatedWindowCount',
    'acceptedSampleCount',
    'acceptedLanguageCount',
    'maxConsensus',
    'rejectedConflictCount',
    'ignoredWeakCount',
    'repeatedCount',
    'missingDiversityCount',
    'insufficientSpeechSampleCount',
    'batchOutcome',
    'pendingReason',
    'verified',
  ]);
  assert.equal(report.event, 'strict_lid_unverified');
  assert.equal(report.pendingReason, 'repeated-evidence');
  assert.equal(report.verified, false);
  assert.equal(Object.isFrozen(report), true);
  const line = JSON.stringify(report);
  assert.equal(line.split(/\r?\n/).length, 1);
  for (const secret of secrets) assert.equal(line.includes(secret), false);

  const invalid = buildStrictLidUnverifiedObservability({
    extractedWindowCount: '6',
    evaluatedWindowCount: 65,
    acceptedSampleCount: Number.NaN,
    acceptedLanguageCount: Number.POSITIVE_INFINITY,
    maxConsensus: 1.5,
    rejectedConflictCount: {},
    ignoredWeakCount: null,
    repeatedCount: undefined,
    missingDiversityCount: 'secret-value',
    insufficientSpeechSampleCount: -99,
    batchOutcome: 'Bearer must-not-escape',
  });
  assert.deepEqual(
    Object.values(invalid).filter((value) => typeof value === 'number'),
    Array.from({ length: 10 }, () => 0),
  );
  assert.equal(invalid.batchOutcome, 'not-run');
  assert.equal(invalid.pendingReason, 'no-accepted-samples');
  assert.doesNotMatch(JSON.stringify(invalid), /secret|Bearer/i);
  assert.doesNotThrow(() => buildStrictLidUnverifiedObservability(null));

  let batchOutcomeReads = 0;
  const statefulOutcome = {};
  Object.defineProperty(statefulOutcome, 'batchOutcome', {
    enumerable: true,
    get() {
      batchOutcomeReads += 1;
      return batchOutcomeReads === 1 ? 'succeeded' : 'Bearer stateful-secret';
    },
  });
  const singleRead = buildStrictLidUnverifiedObservability(statefulOutcome);
  assert.equal(batchOutcomeReads, 1);
  assert.equal(singleRead.batchOutcome, 'succeeded');
  assert.doesNotMatch(JSON.stringify(singleRead), /Bearer|stateful-secret/i);
});

test('strict extraction observability exposes only bounded ordinal timing and fetch counts', () => {
  const secrets = {
    url: 'https://provider.invalid/account/secret/movie.mkv',
    uid: 'user-secret',
    offset: 1667.867,
    error: 'Bearer credential and transcript',
  };
  const report = buildStrictLidExtractionObservability({
    windowOrdinal: 4,
    elapsedMs: 34_999,
    timeoutMs: 35_000,
    providerFetches: 3,
    outcome: 'timed-out',
    ...secrets,
  });
  assert.deepEqual(report, {
    event: 'strict_lid_extraction_window',
    windowOrdinal: 4,
    elapsedMs: 34_999,
    timeoutMs: 35_000,
    providerFetches: 3,
    outcome: 'timed-out',
  });
  assert.equal(Object.isFrozen(report), true);
  const line = JSON.stringify(report);
  assert.equal(line.split(/\r?\n/).length, 1);
  for (const secret of Object.values(secrets)) assert.equal(line.includes(String(secret)), false);

  assert.deepEqual(buildStrictLidExtractionObservability({
    windowOrdinal: 7,
    elapsedMs: 225_001,
    timeoutMs: -1,
    providerFetches: 1.5,
    outcome: 'invented',
  }), {
    event: 'strict_lid_extraction_window',
    windowOrdinal: 0,
    elapsedMs: 0,
    timeoutMs: 0,
    providerFetches: 0,
    outcome: 'failed',
  });
});

test('strict consensus diagnostics count all six dispositions without changing certification', () => {
  const accepted = {
    disposition: 'accepted',
    diversity: diversityFor('dans la maison rouge chacun prépare calmement le repas avant le voyage'),
    result: {
      offset: 180,
      language: 'fr',
      confidence: 0.99,
      wordCount: 20,
      uniqueWordCount: 15,
      transcriptAgrees: true,
    },
  };
  const summary = resolveStrictLidConsensus([
    accepted,
    {
      disposition: 'conflict',
      result: { offset: 600, language: null, wordCount: 19 },
    },
    {
      disposition: 'weak',
      result: { offset: 1200, language: null, wordCount: 18 },
    },
    {
      ...accepted,
      result: { ...accepted.result, offset: 2400 },
    },
    {
      disposition: 'accepted',
      diversity: null,
      result: { ...accepted.result, offset: 60 },
    },
    {
      disposition: 'insufficient',
      result: { offset: 3000, language: null, wordCount: 1 },
    },
  ], 4);
  assert.equal(summary.evaluatedSampleCount, 6);
  assert.equal(summary.acceptedSamples.length, 1);
  assert.equal(summary.rejectedSpeechSampleCount, 1);
  assert.equal(summary.ignoredWeakSpeechSampleCount, 1);
  assert.equal(summary.repeatedSpeechSampleCount, 1);
  assert.equal(summary.missingDiversitySampleCount, 1);
  assert.equal(summary.insufficientSpeechSampleCount, 1);
  assert.equal(summary.votes.size, 1);
  assert.equal(summary.verified, false);
  assert.equal(summary.language, null);

  const report = buildStrictLidUnverifiedObservability({
    extractedWindowCount: 6,
    evaluatedWindowCount: summary.evaluatedSampleCount,
    acceptedSampleCount: summary.acceptedSamples.length,
    acceptedLanguageCount: summary.votes.size,
    maxConsensus: Math.max(0, ...summary.votes.values()),
    rejectedConflictCount: summary.rejectedSpeechSampleCount,
    ignoredWeakCount: summary.ignoredWeakSpeechSampleCount,
    repeatedCount: summary.repeatedSpeechSampleCount,
    missingDiversityCount: summary.missingDiversitySampleCount,
    insufficientSpeechSampleCount: summary.insufficientSpeechSampleCount,
    batchOutcome: 'succeeded',
  });
  assert.equal(report.pendingReason, 'rejected-conflict');
});

function gatewayTranscriptDetector() {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const start = gateway.indexOf('function detectLanguageFromText(');
  const end = gateway.indexOf("app.post('/sessions'", start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(
    `${gateway.slice(start, end)}; this.detect = detectLanguageFromText;`,
    context,
  );
  return context.detect;
}

function strictEvidence(text, whisperLanguage, detect = gatewayTranscriptDetector()) {
  const transcript = detect(text);
  return {
    transcript,
    evidence: evaluateStrictTranscriptEvidence({
      text,
      wordCount: transcript.words,
      minWords: 12,
      minUniqueWords: 8,
      whisperLanguage,
      transcriptLanguage: transcript.lang,
      transcriptConfident: transcript.confident,
    }),
  };
}

test('strict CJK evidence accepts natural unsegmented transcripts without trusting a container tag', () => {
  const japanese = 'これは日本語の音声トラックです。登場人物たちは古い町を歩きながら、明日の計画について静かに話し合っています。突然遠くで大きな音が聞こえ、みんなが立ち止まって空を見上げました。';
  const chinese = '这是一个用于验证中文音轨的完整句子，人物正在古老的城市里讨论明天的计划，突然远处传来巨大的声音，所有人都停下来抬头望向天空。';
  const korean = '이것은한국어오디오트랙을확인하기위한문장입니다등장인물들은오래된도시를걸으며내일의계획에대해조용히이야기하고있습니다갑자기멀리서큰소리가들려모두하늘을바라봅니다';

  const ja = strictEvidence(japanese, 'ja');
  assert.deepEqual(
    { lang: ja.transcript.lang, confident: ja.transcript.confident, words: ja.transcript.words },
    { lang: 'ja', confident: true, words: 1 },
  );
  assert.equal(ja.evidence.enough, true);
  assert.equal(ja.evidence.basis, 'cjk-character-bigrams');
  assert.ok(ja.evidence.compatibleWordCount >= 12);
  assert.ok(ja.evidence.compatibleUniqueWordCount >= 8);

  const zh = strictEvidence(chinese, 'zh');
  assert.deepEqual(
    { lang: zh.transcript.lang, confident: zh.transcript.confident, words: zh.transcript.words },
    { lang: 'zh', confident: true, words: 1 },
  );
  assert.equal(zh.evidence.enough, true);
  assert.equal(zh.evidence.basis, 'cjk-character-bigrams');

  const ko = strictEvidence(korean, 'ko');
  assert.deepEqual(
    { lang: ko.transcript.lang, confident: ko.transcript.confident, words: ko.transcript.words },
    { lang: 'ko', confident: true, words: 1 },
  );
  assert.equal(ko.evidence.enough, true);
  assert.equal(ko.evidence.basis, 'cjk-character-bigrams');

  // The text detector, not MKV metadata, is authoritative for this alternative proof.
  const mislabeled = strictEvidence(chinese, 'ja');
  assert.equal(mislabeled.evidence.transcriptAgrees, false);
  assert.equal(mislabeled.evidence.enough, false);
  assert.equal(mislabeled.evidence.compatibleWordCount, 1);
  assert.equal(mislabeled.evidence.compatibleUniqueWordCount, 4);
});

test('strict CJK evidence enforces exact character, diversity, bigram and density bounds', () => {
  const kana = Array.from('あいうえおかきくけこさしすせそた');
  const fromPattern = (pattern) => Array.from(pattern)
    .map((character) => kana[character.charCodeAt(0) - 97])
    .join('');
  const evaluate = (text) => evaluateStrictTranscriptEvidence({
    text,
    wordCount: 1,
    minWords: 12,
    minUniqueWords: 8,
    whisperLanguage: 'ja',
    transcriptLanguage: 'ja',
    transcriptConfident: true,
  });

  const exactPass = evaluate(fromPattern('abcdefghijklmnopacegijklmnopaceg'));
  assert.equal(exactPass.scriptCharacterCount, 32);
  assert.equal(exactPass.uniqueScriptCharacterCount, 16);
  assert.equal(exactPass.uniqueScriptBigramCount, 20);
  assert.equal(exactPass.scriptDensity, 1);
  assert.equal(exactPass.enough, true);
  assert.equal(exactPass.compatibleWordCount, 16);
  assert.equal(exactPass.compatibleUniqueWordCount, 20);

  const exactDensityScript = fromPattern(
    'abcdefghijklmnopacegijklmnopaceg'.repeat(3).slice(0, 70),
  );
  const exactDensity = evaluate(`${exactDensityScript}${'a'.repeat(30)}`);
  assert.equal(exactDensity.scriptDensity, 0.7);
  assert.equal(exactDensity.enough, true);
  const belowDensity = evaluate(`${exactDensityScript}${'a'.repeat(31)}`);
  assert.ok(belowDensity.scriptDensity < 0.7);
  assert.equal(belowDensity.enough, false);

  const thirtyOneCharacters = evaluate(Array.from(
    'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみ',
  ).slice(0, 31).join(''));
  assert.equal(thirtyOneCharacters.scriptCharacterCount, 31);
  assert.equal(thirtyOneCharacters.enough, false);

  const fifteenUnique = evaluate(fromPattern('abcdefghijklmnoacegikmnoacegikmn'));
  assert.equal(fifteenUnique.scriptCharacterCount, 32);
  assert.equal(fifteenUnique.uniqueScriptCharacterCount, 15);
  assert.equal(fifteenUnique.uniqueScriptBigramCount, 21);
  assert.equal(fifteenUnique.enough, false);

  const nineteenBigrams = evaluate(fromPattern('abcdefghijklmnopaceghijklmnopace'));
  assert.equal(nineteenBigrams.scriptCharacterCount, 32);
  assert.equal(nineteenBigrams.uniqueScriptCharacterCount, 16);
  assert.equal(nineteenBigrams.uniqueScriptBigramCount, 19);
  assert.equal(nineteenBigrams.enough, false);

  const mixedScript = evaluate(`${fromPattern('abcdefghijklmnopacegijklmnopaceg')}abcdefghijklmnopqrstuvwxyz`);
  assert.ok(mixedScript.scriptDensity < 0.7);
  assert.equal(mixedScript.enough, false);
  assert.equal(mixedScript.compatibleWordCount, 1);
  assert.equal(mixedScript.compatibleUniqueWordCount, 1);
});

test('strict CJK evidence keeps repeated boilerplate and sound labels pending', () => {
  for (const text of [
    'ご視聴ありがとうございました。ご視聴ありがとうございました。ご視聴ありがとうございました。',
    '音楽 音楽 音楽 音楽 音楽 音楽 音楽 音楽 音楽 音楽 音楽 音楽',
  ]) {
    const { evidence } = strictEvidence(text, 'ja');
    assert.equal(evidence.enough, false);
    assert.equal(evidence.basis, 'insufficient');
    assert.equal(
      evidence.compatibleWordCount >= 12 && evidence.compatibleUniqueWordCount >= 8,
      false,
    );
  }
});

function acceptedJapaneseEntry(text, offset) {
  const { transcript, evidence } = strictEvidence(text, 'ja');
  assert.equal(transcript.lang, 'ja');
  assert.equal(transcript.confident, true);
  assert.equal(evidence.enough, true);
  return {
    disposition: 'accepted',
    diversity: {
      fingerprint: evidence.diversityFingerprint,
      shingles: evidence.diversityShingles,
    },
    result: {
      offset,
      language: 'ja',
      confidence: 0.99,
      wordCount: evidence.compatibleWordCount,
      uniqueWordCount: evidence.compatibleUniqueWordCount,
      transcriptAgrees: true,
    },
  };
}

test('strict consensus excludes repeated and strongly similar transcripts from its quorum', () => {
  const boilerplate = '最後までご視聴いただきありがとうございました。チャンネル登録と高評価をよろしくお願いします。';
  const repeated = Array.from({ length: 4 }, (_, index) => (
    acceptedJapaneseEntry(boilerplate, index * 600)
  ));
  const exactCopies = resolveStrictLidConsensus(repeated, 4);
  assert.equal(exactCopies.verified, false);
  assert.equal(exactCopies.acceptedSamples.length, 1);
  assert.equal(exactCopies.repeatedSpeechSampleCount, 3);
  assert.equal(exactCopies.missingDiversitySampleCount, 0);

  const similarVariant = acceptedJapaneseEntry(
    `${boilerplate}次回の配信でも新しい作品をご紹介します。`,
    2400,
  );
  const nearCopies = resolveStrictLidConsensus([
    repeated[0], similarVariant, repeated[1], repeated[2],
  ], 4);
  assert.equal(nearCopies.verified, false);
  assert.equal(nearCopies.acceptedSamples.length, 1);
  assert.equal(nearCopies.repeatedSpeechSampleCount, 3);

  const missingFingerprint = resolveStrictLidConsensus([{
    disposition: 'accepted',
    result: repeated[0].result,
  }], 1);
  assert.equal(missingFingerprint.verified, false);
  assert.equal(missingFingerprint.acceptedSamples.length, 0);
  assert.equal(missingFingerprint.missingDiversitySampleCount, 1);
});

test('strict consensus verifies four information-rich natural Japanese windows when distinct', () => {
  const naturalWindows = [
    'これは日本語の音声トラックです。登場人物たちは古い町を歩きながら、明日の計画について静かに話し合っています。',
    '朝早く駅に着いた家族は、大きな荷物を預けてから売店で温かい飲み物と地図を買い、列車の出発を待ちました。',
    '海辺の小さな食堂では、料理人が新鮮な魚と季節の野菜を使い、地元に伝わる特別な昼食を丁寧に作っています。',
    '研究所の窓から夜空を見上げた学生たちは、観測した星の動きを記録し、翌日の発表に向けて結果を整理しました。',
  ];
  const distinct = naturalWindows.map((text, index) => acceptedJapaneseEntry(text, index * 600));
  const consensus = resolveStrictLidConsensus(distinct, 4);
  assert.equal(consensus.verified, true);
  assert.equal(consensus.language, 'ja');
  assert.equal(consensus.acceptedSamples.length, 4);
  assert.equal(consensus.repeatedSpeechSampleCount, 0);
  assert.equal(consensus.missingDiversitySampleCount, 0);
});

test('missing auto-detected line fails the whole batch closed with six empty results', async () => {
  const wavPaths = sixPaths('missing-line');
  const outputPrefixes = sixPaths('missing-line-out').map((file) => file.replace(/\.wav$/, ''));
  const child = new FakeChild();
  const resultPromise = runWhisperBatchProcess({
    bin: 'whisper-cli',
    model: 'model.bin',
    wavPaths,
    outputPrefixes,
    threads: 4,
    timeoutMs: 1000,
    spawnImpl: () => child,
    readFileImpl: async () => 'must not be read',
    unlinkImpl: async () => {},
  });
  setImmediate(() => {
    child.stderr.emit('data', Buffer.from(languageLines(
      Array.from({ length: 5 }, () => ({ lang: 'fr', prob: 0.99 })),
    )));
    child.emit('close', 0);
  });
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'language output count mismatch');
  assert.equal(result.samples.length, 6);
  assert.ok(result.samples.every((sample) => sample.lang === null && sample.text === ''));
});

test('strict batch exit and parse failures become a fixed drained 502 contract, never consensus', async (t) => {
  const runFailure = async ({ name, code, stderr }) => {
    const wavPaths = sixPaths(name);
    const outputPrefixes = sixPaths(`${name}-out`).map((file) => file.replace(/\.wav$/, ''));
    const child = new FakeChild();
    const resultPromise = runWhisperBatchProcess({
      bin: 'whisper-cli',
      model: 'model.bin',
      wavPaths,
      outputPrefixes,
      threads: 4,
      timeoutMs: 1000,
      spawnImpl: () => child,
      readFileImpl: async () => 'transcript must not be read on a failed batch',
      unlinkImpl: async () => {},
    });
    setImmediate(() => {
      child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return resultPromise;
  };

  for (const fixture of [
    {
      name: 'exit-failure',
      code: 7,
      stderr: 'provider-token secret-transcript https://provider.invalid/file',
    },
    {
      name: 'parse-failure',
      code: 0,
      stderr: languageLines(Array.from({ length: 5 }, () => ({ lang: 'fr', prob: 0.99 }))),
    },
  ]) {
    await t.test(fixture.name, async () => {
      const batch = await runFailure(fixture);
      assert.equal(batch.ok, false);
      assert.equal(strictLidBatchOutcome(batch), 'failed');
      const failure = strictLidBatchFailureResponse({
        ...batch,
        error: `${batch.error} bearer-token raw-stderr transcript-text`,
      });
      assert.deepEqual(failure, {
        status: 502,
        retryAfterSeconds: 30,
        payload: {
          error: 'Strict language inference batch failed',
          code: 'strict_lid_batch_failed',
          retryable: true,
        },
      });
      assert.equal(Object.isFrozen(failure), true);
      assert.equal(Object.isFrozen(failure.payload), true);
      assert.doesNotMatch(
        JSON.stringify(failure),
        /bearer-token|raw-stderr|transcript-text|provider-token|provider\.invalid/i,
      );
      assert.equal(resolveStrictLidConsensus([], 4).verified, false);
    });
  }

  assert.equal(strictLidBatchFailureResponse({ ok: true }), null);
  assert.equal(strictLidBatchFailureResponse({ ok: false, timedOut: true }), null);
  assert.equal(strictLidBatchFailureResponse({ ok: false, aborted: true }), null);
  assert.equal(strictLidBatchFailureResponse({ ok: false, preempted: true }), null);
});

test('strict batch bounds timeout, abort and preemption and still cleans output files', async (t) => {
  const wavPaths = sixPaths('stop');
  const outputPrefixes = sixPaths('stop-out').map((file) => file.replace(/\.wav$/, ''));

  await t.test('timeout', async () => {
    const child = new FakeChild();
    const unlinked = [];
    const result = await runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 5,
      spawnImpl: () => child,
      unlinkImpl: async (filePath) => { unlinked.push(filePath); },
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(unlinked.length, 6);
  });

  await t.test('abort', async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    const resultPromise = runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 1000,
      abortSignal: controller.signal,
      spawnImpl: () => child,
      unlinkImpl: async () => {},
    });
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
    assert.deepEqual(child.kills, ['SIGKILL']);
  });

  await t.test('viewer preemption', async () => {
    let preempted = false;
    const child = new FakeChild();
    const resultPromise = runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 1000,
      spawnImpl: () => child,
      onSpawn: () => { preempted = true; },
      isPreempted: () => preempted,
      unlinkImpl: async () => {},
    });
    setImmediate(() => child.emit('close', null));
    const result = await resultPromise;
    assert.equal(result.preempted, true);
    assert.equal(result.ok, false);
    assert.ok(result.samples.every((sample) => sample.lang === null));
  });
});

test('v102 Whisper reserve admits a 31 s batch and fails closed at 50 s with cleanup', async (t) => {
  const wavPaths = sixPaths('v102-reserve');
  const outputPrefixes = sixPaths('v102-reserve-out').map((file) => file.replace(/\.wav$/, ''));

  await t.test('31 s success', async () => {
    const clock = new FakeClock();
    const child = new FakeChild();
    const unlinked = [];
    const resultPromise = runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 50_000,
      spawnImpl: () => child,
      readFileImpl: async () => 'distinct speech transcript',
      unlinkImpl: async (filePath) => { unlinked.push(filePath); },
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
    });

    clock.advance(31_000);
    assert.deepEqual(child.kills, []);
    child.stderr.emit('data', Buffer.from(languageLines(
      Array.from({ length: 6 }, () => ({ lang: 'fr', prob: 0.99 })),
    )));
    child.emit('close', 0);
    const result = await resultPromise;

    assert.equal(result.ok, true);
    assert.equal(result.timedOut, false);
    assert.equal(unlinked.length, 6);
    assert.equal(clock.timers.size, 0);
  });

  await t.test('50 s timeout', async () => {
    const clock = new FakeClock();
    const child = new FakeChild();
    const unlinked = [];
    const resultPromise = runWhisperBatchProcess({
      bin: 'whisper-cli', model: 'model.bin', wavPaths, outputPrefixes, threads: 4,
      timeoutMs: 50_000,
      spawnImpl: () => child,
      unlinkImpl: async (filePath) => { unlinked.push(filePath); },
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
    });

    clock.advance(49_999);
    assert.deepEqual(child.kills, []);
    clock.advance(1);
    const result = await resultPromise;

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(unlinked.length, 6);
    assert.equal(clock.timers.size, 0);
  });
});

test('strict WAV cleanup is ordered-independent and fail-closed on unlink errors', async () => {
  const seen = [];
  await cleanupStrictLidFiles(sixPaths('cleanup'), async (filePath) => {
    seen.push(filePath);
    if (filePath.endsWith('-2.wav')) throw new Error('already gone');
  });
  assert.equal(seen.length, 6);
});

test('v102 strict extraction budget preserves 50 s for Whisper and exposes the 165 s aggregate', () => {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const timing = strictGatewayTimingHarness(gateway);

  assert.equal(timing.strictLidSampleDurationSeconds(undefined, true), 20);
  assert.equal(timing.strictLidSampleDurationSeconds(0, true), 20);
  assert.equal(timing.strictLidSampleDurationSeconds(60, true), 20);
  assert.equal(timing.strictLidSampleDurationSeconds(4, true), 4);
  assert.equal(timing.strictLidSampleDurationSeconds(0, false), 20);
  assert.equal(timing.strictLidSampleDurationSeconds(30, false), 30);
  assert.equal(timing.strictLidSampleDurationSeconds(120, false), 60);
  assert.equal(timing.strictLidMediaExtractionTimeoutMs(4), 29_000);
  assert.equal(timing.strictLidMediaExtractionTimeoutMs(4.25), 29_250);
  assert.equal(timing.strictLidMediaExtractionTimeoutMs(20), 45_000);
  assert.equal(timing.strictLidMediaExtractionTimeoutMs(60), 45_000);

  assert.deepEqual(
    { ...timing.strictLidExtractionBudget(20, 215_000, 0) },
    { mediaTimeoutMs: 45_000, availableMs: 165_000, timeoutMs: 45_000 },
  );
  assert.deepEqual(
    { ...timing.strictLidExtractionBudget(20, 215_000, 140_000) },
    { mediaTimeoutMs: 45_000, availableMs: 25_000, timeoutMs: 25_000 },
  );
  assert.deepEqual(
    { ...timing.strictLidExtractionBudget(20, 215_000, 137_283) },
    { mediaTimeoutMs: 45_000, availableMs: 27_717, timeoutMs: 27_717 },
  );
  assert.deepEqual(
    { ...timing.strictLidExtractionBudget(20, 215_000, 165_000) },
    { mediaTimeoutMs: 45_000, availableMs: 0, timeoutMs: 0 },
  );
  assert.deepEqual(
    { ...timing.strictLidExtractionBudget(20, Number.NaN, 0) },
    { mediaTimeoutMs: 45_000, availableMs: 0, timeoutMs: 0 },
  );

  const fourStrongThenTimeout = timing.strictLidPostExtractionFailure({
    extractionTimedOut: true,
    successfulSampleCount: 4,
  });
  assert.equal(fourStrongThenTimeout.status, 504);
  assert.equal(fourStrongThenTimeout.payload.code, 'strict_lid_extraction_timeout');
  assert.equal(fourStrongThenTimeout.payload.retryable, true);
  assert.equal(fourStrongThenTimeout.retryAfterSeconds, 30);

  const first458 = timing.strictLidPostExtractionFailure({
    terminalError: {
      status: 458,
      message: 'provider busy',
      code: 'PROVIDER_BUSY',
      upstreamStatus: 458,
    },
    extractionTimedOut: true,
    workBudgetExpired: true,
  });
  assert.equal(first458.status, 458);
  assert.equal(first458.payload.code, 'PROVIDER_BUSY');
  assert.equal(first458.retryAfterSeconds, undefined);

  const timeoutBeatsGenericBudget = timing.strictLidPostExtractionFailure({
    extractionTimedOut: true,
    workBudgetExpired: true,
  });
  assert.equal(timeoutBeatsGenericBudget.payload.code, 'strict_lid_extraction_timeout');
  assert.equal(timing.strictLidPostExtractionFailure({}), null);
});

test('v102 dynamic budget admits the live first five plus a 27 s sixth window and one batch', () => {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const timing = strictGatewayTimingHarness(gateway);
  const result = simulateStrictRouteBudget(
    timing,
    [25_831, 24_356, 24_095, 23_586, 39_415, 27_000],
  );

  assert.equal(result.completedWindowCount, 6);
  assert.equal(result.elapsedMs, 164_283);
  assert.equal(result.batchCalls, 1);
  assert.equal(result.consensusCalls, 1);
  assert.equal(result.batchTimeoutMs, 50_717);
  assert.equal(result.failure, null);
  assert.deepEqual(
    result.windows.map((window) => window.timeoutMs),
    [45_000, 45_000, 45_000, 45_000, 45_000, 27_717],
  );
});

test('v102 exact 27.717 s sixth-window boundary exhausts 165 s and vetoes partial evidence', () => {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const timing = strictGatewayTimingHarness(gateway);
  const result = simulateStrictRouteBudget(
    timing,
    [25_831, 24_356, 24_095, 23_586, 39_415, 27_717],
  );

  assert.equal(result.completedWindowCount, 5);
  assert.equal(result.elapsedMs, 165_000);
  assert.equal(result.windows[5].timeoutMs, 27_717);
  assert.equal(result.batchCalls, 0);
  assert.equal(result.consensusCalls, 0);
  assert.equal(result.failure.status, 504);
  assert.equal(result.failure.payload.code, 'strict_lid_extraction_timeout');
});

test('v102 dynamic terminal 458 keeps priority over extraction and aggregate timeouts', () => {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const timing = strictGatewayTimingHarness(gateway);
  const result = simulateStrictRouteBudget(timing, [45_000, 20_000, 20_000], {
    terminalAtOrdinal: 1,
    terminalTimedOut: true,
  });

  assert.equal(result.batchCalls, 0);
  assert.equal(result.consensusCalls, 0);
  assert.equal(result.failure.status, 458);
  assert.equal(result.failure.payload.code, 'PROVIDER_BUSY');
  assert.equal(result.failure.payload.upstreamStatus, 458);
});

test('signed strict timeline duration is bounded and cannot be coerced from strings', () => {
  assert.equal(normalizeStrictLidTimelineDurationSeconds(7_248.048), 7_248.048);
  assert.equal(normalizeStrictLidTimelineDurationSeconds(86_400), 86_400);
  for (const value of [undefined, null, '7248.048', 0, -1, 86_400.001, NaN, Infinity]) {
    assert.equal(normalizeStrictLidTimelineDurationSeconds(value), null);
  }
});

test('strict timeline sampling centers six complete windows across a long exact VOD', () => {
  const offsets = strictLidTimelineOffsets(7_248.048, 20);
  assert.deepEqual(offsets, [594.004, 1802.012, 3010.02, 4218.028, 5426.036, 6634.044]);
  assert.equal(Object.isFrozen(offsets), true);
  assert.equal(offsets.length, 6);
  for (let index = 0; index < offsets.length; index++) {
    assert.ok(offsets[index] >= 0);
    assert.ok(offsets[index] + 20 <= 7_248.048 + 0.001);
    if (index > 0) assert.ok(offsets[index] - offsets[index - 1] >= 20);
  }
});

test('strict timeline sampling uses exactly four non-overlapping strata for short films', () => {
  assert.deepEqual(strictLidTimelineOffsets(80, 20), [0, 20, 40, 60]);
  assert.deepEqual(strictLidTimelineOffsets(100, 20), [2.5, 27.5, 52.5, 77.5]);
  assert.deepEqual(strictLidTimelineOffsets(119.999, 20), [5, 35, 64.999, 94.999]);
  assert.deepEqual(strictLidTimelineOffsets(120, 20), [0, 20, 40, 60, 80, 100]);
  assert.equal(strictLidTimelineOffsets(79.999, 20), null);
  assert.equal(strictLidTimelineOffsets(86_400.001, 20), null);
  assert.equal(strictLidTimelineOffsets(120, 0), null);
});

test('strict timeline invariants hold from the minimum short film through the maximum duration', () => {
  for (const duration of [80, 80.001, 95.5, 119.999, 120, 120.001, 600, 7_248.048, 86_400]) {
    const offsets = strictLidTimelineOffsets(duration, 20);
    assert.equal(offsets.length, duration < 120 ? 4 : 6);
    assert.equal(new Set(offsets).size, offsets.length);
    for (let index = 0; index < offsets.length; index++) {
      assert.ok(offsets[index] >= 0);
      assert.ok(offsets[index] <= duration - 20 + 0.001);
      if (index > 0) assert.ok(offsets[index] - offsets[index - 1] >= 20 - 0.001);
    }
  }
});

test('v102 route exposes the bounded budget rebalance and fails a broken Whisper batch before consensus', () => {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const routeStart = gateway.indexOf('async function handleDetectLanguageRequest(');
  const routeEnd = gateway.indexOf('// Service-only A/B benchmark.', routeStart);
  const route = gateway.slice(routeStart, routeEnd);
  assert.match(gateway, /const GATEWAY_VERSION = 147;/);
  assert.match(gateway, /const STRICT_LID_REQUEST_BUDGET_MS = clampInt\([\s\S]*225_000,[\s\S]*225_000,/);
  assert.match(gateway, /strictLidBatchProtocol: 1/);
  assert.match(gateway, /strictLidActivityKindProtocol: 1/);
  assert.match(gateway, /strictLidCjkEvidenceProtocol: 1/);
  assert.match(gateway, /strictLidTranscriptDiversityProtocol: 1/);
  assert.match(gateway, /strictLidExtractionTimeoutProtocol: 4/);
  assert.match(gateway, /strictLidBudgetRebalanceProtocol: 1/);
  assert.match(gateway, /strictLidBatchFailureProtocol: 1/);
  assert.match(gateway, /strictLidTimelineSamplingProtocol: 1/);
  assert.match(gateway, /strictLidRangeTimeoutProtocol: 2/);
  assert.match(gateway, /strictLidRangeFirstByteTimeoutMs: STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS/);
  assert.match(gateway, /strictLidRangeIdleTimeoutMs: STRICT_LID_BROKER_IDLE_TIMEOUT_MS/);
  assert.match(gateway, /strictLidFfmpegRwTimeoutUs: STRICT_LID_FFMPEG_RW_TIMEOUT_US/);
  assert.match(gateway, /strictLidSampleDurationCapSeconds: STRICT_LID_SAMPLE_DURATION_CAP_SECONDS/);
  assert.match(gateway, /strictLidWhisperReserveMs: STRICT_LID_WHISPER_RESERVE_MS/);
  assert.match(gateway, /strictLidExtractionStartupMarginMs: STRICT_LID_EXTRACTION_STARTUP_MARGIN_MS/);
  assert.match(gateway, /strictLidExtractionAggregateBudgetMs: STRICT_LID_EXTRACTION_AGGREGATE_BUDGET_MS/);
  assert.match(gateway, /strictLidRequestBudgetMs: STRICT_LID_REQUEST_BUDGET_MS/);
  assert.match(gateway, /const STRICT_LID_WHISPER_RESERVE_MS = 50_000;/);
  assert.match(gateway, /const STRICT_LID_EXTRACTION_STARTUP_MARGIN_MS = 25_000;/);
  assert.match(gateway, /const STRICT_LID_FFMPEG_RW_TIMEOUT_US = 50_000_000;/);
  assert.match(route, /const dur = strict[\s\S]*\? STRICT_LID_SAMPLE_DURATION_CAP_SECONDS[\s\S]*: strictLidSampleDurationSeconds\(req\.query\.dur, false\)/);
  assert.match(route, /normalizeStrictLidTimelineDurationSeconds\(claims\.durationSeconds\)/);
  assert.match(route, /code: 'exact_duration_required'/);
  assert.match(route, /strictLidTimelineOffsets\(strictDurationSeconds, dur\)/);
  assert.match(route, /code: 'strict_lid_duration_too_short'/);
  assert.doesNotMatch(route, /req\.query\.(?:duration|durationSeconds)|WHISPER_STRICT_OFFSETS/);
  const durationPreflight = route.indexOf("code: 'strict_lid_duration_too_short'");
  const brokerOpen = route.indexOf('createStrictLidBroker({');
  assert.ok(durationPreflight >= 0 && brokerOpen > durationPreflight,
    'an uncertifiable signed duration must fail before the strict provider broker opens');
  assert.match(route, /strictLidExtractionBudget\(dur, strictWorkDeadlineAt\)/);
  assert.match(route, /strict \? extractionBudget\.timeoutMs : 30_000/);
  assert.match(route, /if \(strict && ex\.timedOut\) \{[\s\S]*?strictExtractionTimedOut = true;[\s\S]*?break;/);
  assert.match(route, /buildStrictLidExtractionObservability\(input\)/);
  assert.match(route, /strictWavSamples\.push\(\{ offset: off, path: wavPath \}\)/);
  assert.match(
    route,
    /const batchTimeoutMs = strictLidWhisperBatchTimeoutMs\([\s\S]*strictWorkDeadlineAt,[\s\S]*Boolean\(strictWindowContext\)/,
  );
  assert.match(route, /runStrictWhisperBatch\([\s\S]*strictWavSamples\.map/);
  assert.match(route, /strictLanguageBatchSampleResult\(batch\.samples\[index\], sample\.offset\)/);
  assert.equal((gateway.match(/evaluateStrictTranscriptEvidence\(/g) || []).length, 2);
  assert.match(route, /const transcriptEvidence = evaluateStrictTranscriptEvidence\(/);
  assert.match(route, /strictConsensusVerified = summary\.verified/);
  assert.match(route, /strict &&[\s\S]*strictConsensusVerified &&[\s\S]*bestStrictAccepted/);
  assert.match(gateway, /method: 'whisper-strict-consensus-v4'/);
  assert.match(route, /providerDrained: true/);
  assert.match(route, /await closeStrictBrokerForResponse\(\)/);
  assert.match(route, /if \(strict\) \{[\s\S]*strictWavSamples\.push[\s\S]*continue;/);
  assert.match(route, /runWhisperDetect\(wavPath, lidBackgroundOptions\)/);
  const timeoutStop = route.indexOf('if (strict && ex.timedOut)');
  const batchStart = route.indexOf('runStrictWhisperBatch(');
  assert.ok(timeoutStop >= 0 && batchStart > timeoutStop,
    'the first extraction timeout must stop collection before any strict Whisper batch');
  assert.match(route, /strictLidPostExtractionFailure\(\{[\s\S]*terminalError: strictBroker\?\.terminalError,[\s\S]*extractionTimedOut: strictExtractionTimedOut/);
  assert.match(route, /sendDetectionJson\([\s\S]*strictPostExtractionFailure\.status,[\s\S]*strictPostExtractionFailure\.payload/);
  const batchFailureCheck = route.indexOf('else if (batch.ok !== true)');
  const consensusEvaluation = route.indexOf('strictLanguageBatchSampleResult(batch.samples[index]');
  assert.ok(batchFailureCheck >= 0 && consensusEvaluation > batchFailureCheck,
    'a failed batch must become a retryable response before any sample reaches consensus');
  assert.match(route, /else if \(batch\.ok !== true\) \{[\s\S]*strictLidBatchFailureResponse\(batch\)/);
  assert.match(route, /if \(strictBatchFailure\) \{[\s\S]*logStrictLidUnverified\(\);[\s\S]*Cache-Control', 'no-store'[\s\S]*Retry-After[\s\S]*sendDetectionJson\(strictBatchFailure\.status, strictBatchFailure\.payload\)/);
  const logStart = route.indexOf('const logStrictLidUnverified');
  const failureResponse = route.indexOf('if (strictBatchFailure)', logStart);
  const logBlock = route.slice(logStart, failureResponse);
  assert.match(logBlock, /buildStrictLidUnverifiedObservability\(/);
  assert.equal((logBlock.match(/console\.info\(/g) || []).length, 1);
  assert.doesNotMatch(
    logBlock,
    /transcript|sampleText|\burl\b|token|credential|providerAccount|userId|sessionId|fileId|candidate|offset|probability/i,
  );
});
