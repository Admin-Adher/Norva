const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  buildWhisperBatchArgs,
  cleanupStrictLidFiles,
  evaluateStrictTranscriptEvidence,
  parseWhisperBatchLid,
  resolveStrictLidConsensus,
  runWhisperBatchProcess,
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

test('strict WAV cleanup is ordered-independent and fail-closed on unlink errors', async () => {
  const seen = [];
  await cleanupStrictLidFiles(sixPaths('cleanup'), async (filePath) => {
    seen.push(filePath);
    if (filePath.endsWith('-2.wav')) throw new Error('already gone');
  });
  assert.equal(seen.length, 6);
});

test('v96 route batches strict inside a 225 s request budget and keeps drain attestations', () => {
  const gateway = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/index.js'),
    'utf8',
  );
  const routeStart = gateway.indexOf('async function handleDetectLanguageRequest(');
  const routeEnd = gateway.indexOf('// Service-only A/B benchmark.', routeStart);
  const route = gateway.slice(routeStart, routeEnd);
  assert.match(gateway, /const GATEWAY_VERSION = 96;/);
  assert.match(gateway, /const STRICT_LID_REQUEST_BUDGET_MS = clampInt\([\s\S]*225_000,[\s\S]*225_000,/);
  assert.match(gateway, /strictLidBatchProtocol: 1/);
  assert.match(gateway, /strictLidActivityKindProtocol: 1/);
  assert.match(gateway, /strictLidCjkEvidenceProtocol: 1/);
  assert.match(gateway, /strictLidTranscriptDiversityProtocol: 1/);
  assert.match(gateway, /strictLidRequestBudgetMs: STRICT_LID_REQUEST_BUDGET_MS/);
  assert.match(route, /strictWavSamples\.push\(\{ offset: off, path: wavPath \}\)/);
  assert.match(route, /const batchTimeoutMs = strictWorkDeadlineAt - Date\.now\(\)/);
  assert.match(route, /runStrictWhisperBatch\([\s\S]*strictWavSamples\.map/);
  assert.match(route, /strictLanguageBatchSampleResult\(batch\.samples\[index\], sample\.offset\)/);
  assert.equal((gateway.match(/evaluateStrictTranscriptEvidence\(/g) || []).length, 2);
  assert.match(route, /const transcriptEvidence = strict[\s\S]*\? evaluateStrictTranscriptEvidence\(/);
  assert.match(route, /strictConsensusVerified = summary\.verified/);
  assert.match(route, /strict &&[\s\S]*strictConsensusVerified &&[\s\S]*bestStrictAccepted/);
  assert.match(gateway, /method: 'whisper-strict-consensus-v4'/);
  assert.match(route, /providerDrained: true/);
  assert.match(route, /await closeStrictBrokerForResponse\(\)/);
  assert.match(route, /if \(strict\) \{[\s\S]*strictWavSamples\.push[\s\S]*continue;/);
  assert.match(route, /runWhisperDetect\(wavPath, lidBackgroundOptions\)/);
  const terminalAfterExtraction = route.indexOf('if (strictBroker?.terminalError)');
  const budgetAfterExtraction = route.indexOf('if (strictWorkBudgetExpired)', terminalAfterExtraction);
  assert.ok(terminalAfterExtraction >= 0 && budgetAfterExtraction > terminalAfterExtraction,
    'a terminal first 458 must win over a simultaneous strict request timeout');
});
