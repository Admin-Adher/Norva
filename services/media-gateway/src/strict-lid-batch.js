const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const LANGUAGE_LINE_RE =
    /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\)/gi;
const MAX_PROCESS_OUTPUT_CHARS = 512 * 1024;
const STRICT_LID_MIN_SCRIPT_CHARACTERS = 32;
const STRICT_LID_MIN_UNIQUE_SCRIPT_CHARACTERS = 16;
const STRICT_LID_MIN_UNIQUE_SCRIPT_BIGRAMS = 20;
const STRICT_LID_MIN_SCRIPT_DENSITY = 0.7;
const STRICT_LID_DIVERSITY_SHINGLE_SIZE = 3;
const STRICT_LID_MAX_SAMPLE_SHINGLE_SIMILARITY = 0.82;
const STRICT_LID_MAX_DIVERSITY_CHARACTERS = 4096;
const STRICT_LID_OBSERVABILITY_MAX_COUNT = 64;
const STRICT_LID_BATCH_OUTCOMES = new Set([
    'not-run',
    'succeeded',
    'failed',
    'timed-out',
    'aborted',
    'preempted',
]);
const STRICT_LID_CJK_CHARACTER_RE = Object.freeze({
    // Japanese evidence deliberately includes kana and Han. The independent transcript
    // detector must still identify `ja`, so a Han-only Chinese transcript cannot be accepted
    // merely because Whisper guessed Japanese.
    ja: /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff]/u,
    zh: /[\u3400-\u4dbf\u4e00-\u9fff]/u,
    ko: /[\u1100-\u11ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u,
});

// Whitespace word counts are not meaningful for Japanese and Chinese: a complete 30-second
// transcript is commonly one token. Accept an alternate, deterministic CJK evidence unit only
// when the independent transcript detector is confident and agrees exactly with Whisper. The
// character, diversity and bigram floors reject silence labels and repeated Whisper boilerplate;
// four separated high-probability samples must still agree before the caller can verify a track.
function evaluateStrictTranscriptEvidence({
    text,
    wordCount,
    minWords,
    minUniqueWords,
    whisperLanguage,
    transcriptLanguage,
    transcriptConfident,
}) {
    const normalizedText = String(text || '').normalize('NFKC').toLowerCase();
    const uniqueWordCount = new Set(normalizedText.match(/\p{L}+/gu) || []).size;
    const requiredWordCount = Number(minWords);
    const requiredUniqueWordCount = Number(minUniqueWords);
    const wordEvidenceEnough = Number.isFinite(requiredWordCount)
        && requiredWordCount > 0
        && Number.isFinite(requiredUniqueWordCount)
        && requiredUniqueWordCount > 0
        && Number(wordCount || 0) >= requiredWordCount
        && uniqueWordCount >= requiredUniqueWordCount;
    const normalizedWhisperLanguage = String(whisperLanguage || '').toLowerCase();
    const normalizedTranscriptLanguage = String(transcriptLanguage || '').toLowerCase();
    const scriptPattern = STRICT_LID_CJK_CHARACTER_RE[normalizedWhisperLanguage] || null;
    const scriptCharacters = scriptPattern
        ? Array.from(normalizedText).filter((character) => scriptPattern.test(character))
        : [];
    const allLetterCount = Array.from(normalizedText).filter((character) => /\p{L}/u.test(character)).length;
    const uniqueScriptCharacterCount = new Set(scriptCharacters).size;
    const scriptBigrams = new Set();
    for (let index = 1; index < scriptCharacters.length; index++) {
        scriptBigrams.add(`${scriptCharacters[index - 1]}${scriptCharacters[index]}`);
    }
    const transcriptAgrees = transcriptConfident === true
        && Boolean(normalizedTranscriptLanguage)
        && normalizedTranscriptLanguage === normalizedWhisperLanguage;
    const scriptDensity = allLetterCount > 0 ? scriptCharacters.length / allLetterCount : 0;
    const scriptEvidenceEnough = Boolean(
        scriptPattern
        && transcriptAgrees
        && scriptCharacters.length >= STRICT_LID_MIN_SCRIPT_CHARACTERS
        && uniqueScriptCharacterCount >= STRICT_LID_MIN_UNIQUE_SCRIPT_CHARACTERS
        && scriptBigrams.size >= STRICT_LID_MIN_UNIQUE_SCRIPT_BIGRAMS
        && scriptDensity >= STRICT_LID_MIN_SCRIPT_DENSITY
    );
    const compatibleWordCount = scriptEvidenceEnough
        ? Math.max(Number(wordCount || 0), Math.floor(scriptCharacters.length / 2))
        : Number(wordCount || 0);
    const compatibleUniqueWordCount = scriptEvidenceEnough
        ? Math.max(uniqueWordCount, scriptBigrams.size)
        : uniqueWordCount;
    const diversityCharacters = Array.from(normalizedText)
        .filter((character) => /[\p{L}\p{N}]/u.test(character))
        .slice(0, STRICT_LID_MAX_DIVERSITY_CHARACTERS);
    const diversityShingles = new Set();
    for (
        let index = 0;
        index + STRICT_LID_DIVERSITY_SHINGLE_SIZE <= diversityCharacters.length;
        index++
    ) {
        diversityShingles.add(
            diversityCharacters.slice(index, index + STRICT_LID_DIVERSITY_SHINGLE_SIZE).join(''),
        );
    }
    const diversityFingerprint = crypto
        .createHash('sha256')
        .update(diversityCharacters.join(''))
        .digest('hex');
    return {
        enough: wordEvidenceEnough || scriptEvidenceEnough,
        basis: wordEvidenceEnough
            ? 'whitespace-words'
            : (scriptEvidenceEnough ? 'cjk-character-bigrams' : 'insufficient'),
        uniqueWordCount,
        compatibleWordCount,
        compatibleUniqueWordCount,
        scriptCharacterCount: scriptCharacters.length,
        uniqueScriptCharacterCount,
        uniqueScriptBigramCount: scriptBigrams.size,
        scriptDensity,
        transcriptAgrees,
        diversityFingerprint,
        diversityShingles: [...diversityShingles],
    };
}

function validStrictTranscriptDiversity(value) {
    return Boolean(
        value
        && /^[a-f0-9]{64}$/.test(String(value.fingerprint || ''))
        && Array.isArray(value.shingles)
        && value.shingles.length > 0
        && value.shingles.every((shingle) => typeof shingle === 'string' && shingle.length > 0)
    );
}

function strictTranscriptShingleSimilarity(left, right) {
    if (!validStrictTranscriptDiversity(left) || !validStrictTranscriptDiversity(right)) return 0;
    if (left.fingerprint === right.fingerprint) return 1;
    const leftSet = new Set(left.shingles);
    const rightSet = new Set(right.shingles);
    const smaller = leftSet.size <= rightSet.size ? leftSet : rightSet;
    const larger = smaller === leftSet ? rightSet : leftSet;
    let overlap = 0;
    for (const shingle of smaller) if (larger.has(shingle)) overlap++;
    // Containment similarity catches a repeated boilerplate phrase with a small appended suffix;
    // ordinary separated dialogue windows retain independent shingles and remain far below 0.82.
    return smaller.size > 0 ? overlap / smaller.size : 0;
}

function strictLidBatchOutcome(batch) {
    try {
        if (!batch || typeof batch !== 'object') return 'not-run';
        if (batch.preempted === true) return 'preempted';
        if (batch.timedOut === true) return 'timed-out';
        if (batch.aborted === true) return 'aborted';
        return batch.ok === true ? 'succeeded' : 'failed';
    } catch (_) {
        return 'not-run';
    }
}

function boundedStrictLidObservabilityCount(value) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= STRICT_LID_OBSERVABILITY_MAX_COUNT
        ? value
        : 0;
}

function strictLidBatchFailureResponse(batch) {
    if (strictLidBatchOutcome(batch) !== 'failed') return null;
    return Object.freeze({
        status: 502,
        retryAfterSeconds: 30,
        payload: Object.freeze({
            error: 'Strict language inference batch failed',
            code: 'strict_lid_batch_failed',
            retryable: true,
        }),
    });
}

function strictLidPendingReason({
    batchOutcome,
    acceptedSampleCount,
    acceptedLanguageCount,
    rejectedConflictCount,
    ignoredWeakCount,
    repeatedCount,
    missingDiversityCount,
    insufficientSpeechSampleCount,
}) {
    if (batchOutcome === 'failed') return 'batch-failed';
    if (rejectedConflictCount > 0) return 'rejected-conflict';
    if (acceptedLanguageCount > 1) return 'language-conflict';
    if (missingDiversityCount > 0) return 'missing-diversity';
    if (repeatedCount > 0) return 'repeated-evidence';
    if (insufficientSpeechSampleCount > 0) return 'insufficient-speech';
    if (ignoredWeakCount > 0) return 'weak-speech';
    if (acceptedSampleCount === 0) return 'no-accepted-samples';
    return 'insufficient-consensus';
}

// Unverified strict-LID logs are intentionally a closed aggregate: accepting only bounded
// counters and fixed enums prevents transcripts, source details, identifiers or model evidence
// from reaching production logs even if a caller passes additional properties by mistake.
function buildStrictLidUnverifiedObservability(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const read = (key) => {
        try { return source[key]; } catch (_) { return undefined; }
    };
    const batchOutcome = read('batchOutcome');
    const safeBatchOutcome = STRICT_LID_BATCH_OUTCOMES.has(batchOutcome)
        ? batchOutcome
        : 'not-run';
    const counts = {
        extractedWindowCount: boundedStrictLidObservabilityCount(read('extractedWindowCount')),
        evaluatedWindowCount: boundedStrictLidObservabilityCount(read('evaluatedWindowCount')),
        acceptedSampleCount: boundedStrictLidObservabilityCount(read('acceptedSampleCount')),
        acceptedLanguageCount: boundedStrictLidObservabilityCount(read('acceptedLanguageCount')),
        maxConsensus: boundedStrictLidObservabilityCount(read('maxConsensus')),
        rejectedConflictCount: boundedStrictLidObservabilityCount(read('rejectedConflictCount')),
        ignoredWeakCount: boundedStrictLidObservabilityCount(read('ignoredWeakCount')),
        repeatedCount: boundedStrictLidObservabilityCount(read('repeatedCount')),
        missingDiversityCount: boundedStrictLidObservabilityCount(read('missingDiversityCount')),
        insufficientSpeechSampleCount: boundedStrictLidObservabilityCount(
            read('insufficientSpeechSampleCount'),
        ),
    };
    return Object.freeze({
        event: 'strict_lid_unverified',
        ...counts,
        batchOutcome: safeBatchOutcome,
        pendingReason: strictLidPendingReason({ ...counts, batchOutcome: safeBatchOutcome }),
        verified: false,
    });
}

function appendBounded(current, chunk) {
    const next = current + chunk.toString();
    return next.length > MAX_PROCESS_OUTPUT_CHARS
        ? next.slice(-MAX_PROCESS_OUTPUT_CHARS)
        : next;
}

function emptyBatchSamples(count) {
    return Array.from({ length: Math.max(0, Number(count) || 0) }, () => ({
        text: '',
        lang: null,
        prob: 0,
    }));
}

// A strict batch is all-or-nothing at the process-output boundary. whisper.cpp emits one
// auto-detected line per input, in input order. If even one line is absent, duplicated,
// malformed or out of range, returning no LID evidence prevents the remaining samples from
// being shifted onto the wrong offsets.
function parseWhisperBatchLid(output, expectedCount) {
    const count = Number(expectedCount);
    if (!Number.isInteger(count) || count <= 0) return null;
    const matches = [];
    const text = String(output || '');
    const detectedLineCount = (text.match(/auto-detected language:/gi) || []).length;
    if (detectedLineCount !== count) return null;
    for (const match of text.matchAll(LANGUAGE_LINE_RE)) {
        const lang = String(match[1] || '').toLowerCase();
        const prob = Number(match[2]);
        if (!/^[a-z]{2,3}$/.test(lang) || !Number.isFinite(prob) || prob < 0 || prob > 1) {
            return null;
        }
        matches.push({ lang, prob });
    }
    return matches.length === count ? matches : null;
}

function buildWhisperBatchArgs({ model, wavPaths, outputPrefixes, threads }) {
    if (!Array.isArray(wavPaths) || wavPaths.length === 0) {
        throw new Error('strict LID batch requires at least one WAV');
    }
    if (!Array.isArray(outputPrefixes) || outputPrefixes.length !== wavPaths.length) {
        throw new Error('strict LID batch output count must match its WAV count');
    }
    const args = ['-m', String(model)];
    for (const wavPath of wavPaths) args.push('-f', String(wavPath));
    args.push('-l', 'auto', '-nt', '-otxt');
    for (const outputPrefix of outputPrefixes) args.push('-of', String(outputPrefix));
    args.push('-t', String(threads));
    return args;
}

function strictLidOutputPrefixes(wavPaths) {
    const nonce = crypto.randomUUID();
    return wavPaths.map((wavPath, index) => path.join(
        path.dirname(wavPath),
        `.norva-strict-lid-${nonce}-${index}`,
    ));
}

async function cleanupStrictLidFiles(paths, unlinkImpl = fsp.unlink) {
    await Promise.all((paths || []).map(async (filePath) => {
        try { await unlinkImpl(filePath); } catch (_) {}
    }));
}

function runWhisperBatchProcess({
    bin,
    model,
    wavPaths,
    threads,
    timeoutMs,
    abortSignal = null,
    spawnImpl = spawn,
    readFileImpl = fsp.readFile,
    unlinkImpl = fsp.unlink,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onSpawn = null,
    isPreempted = null,
    outputPrefixes = null,
}) {
    const inputs = Array.isArray(wavPaths) ? [...wavPaths] : [];
    const prefixes = outputPrefixes || strictLidOutputPrefixes(inputs);
    const empty = () => emptyBatchSamples(inputs.length);
    const failure = (overrides = {}) => ({
        ok: false,
        samples: empty(),
        code: null,
        timedOut: false,
        aborted: false,
        preempted: false,
        error: 'strict LID batch failed',
        ...overrides,
    });

    return new Promise((resolve) => {
        if (abortSignal?.aborted) {
            resolve(failure({ aborted: true, error: 'aborted' }));
            return;
        }

        let args;
        try {
            args = buildWhisperBatchArgs({ model, wavPaths: inputs, outputPrefixes: prefixes, threads });
        } catch (error) {
            resolve(failure({ error: String(error?.message || error) }));
            return;
        }

        let child;
        try {
            child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            resolve(failure({ error: `spawn failed: ${String(error?.message || error)}` }));
            return;
        }

        let settled = false;
        let timedOut = false;
        let aborted = false;
        let stdout = '';
        let stderr = '';
        let timer = null;
        let killGraceTimer = null;
        const transcriptPaths = prefixes.map((prefix) => `${prefix}.txt`);
        const removeAbortListener = () => abortSignal?.removeEventListener?.('abort', onAbort);
        const finish = async (value) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimer(timer);
            if (killGraceTimer !== null) clearTimer(killGraceTimer);
            removeAbortListener();
            await cleanupStrictLidFiles(transcriptPaths, unlinkImpl);
            resolve(value);
        };
        const killedResult = () => failure({
            timedOut,
            aborted,
            preempted: typeof isPreempted === 'function' && isPreempted() === true,
            error: timedOut ? 'timeout' : (aborted ? 'aborted' : 'preempted'),
        });
        const killAndBoundClose = () => {
            try { child.kill('SIGKILL'); } catch (_) {}
            // A real child always emits close after SIGKILL. Keep the request budget authoritative
            // even when a child-process shim or a broken runtime never does.
            killGraceTimer = setTimer(() => { void finish(killedResult()); }, 1000);
        };
        const onAbort = () => {
            aborted = true;
            killAndBoundClose();
        };

        try {
            if (typeof onSpawn === 'function') onSpawn(child);
        } catch (error) {
            child.on?.('error', () => {});
            killAndBoundClose();
            void finish(failure({ error: `spawn hook failed: ${String(error?.message || error)}` }));
            return;
        }

        abortSignal?.addEventListener?.('abort', onAbort, { once: true });
        if (abortSignal?.aborted) {
            onAbort();
            return;
        }
        timer = setTimer(() => {
            timedOut = true;
            killAndBoundClose();
        }, Math.max(1, Number(timeoutMs) || 1));

        child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
        child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
        child.on('error', (error) => {
            const preempted = typeof isPreempted === 'function' && isPreempted() === true;
            void finish((timedOut || aborted || preempted)
                ? killedResult()
                : failure({ error: `process error: ${String(error?.message || error)}` }));
        });
        child.on('close', async (code) => {
            if (settled) return;
            const preempted = typeof isPreempted === 'function' && isPreempted() === true;
            if (timedOut || aborted || preempted) {
                await finish(failure({
                    code,
                    timedOut,
                    aborted,
                    preempted,
                    error: timedOut ? 'timeout' : (aborted ? 'aborted' : 'preempted'),
                }));
                return;
            }
            // The pinned CLI emits its auto-detected line on stderr for each input. Parsing one
            // stream preserves input order; stdout is intentionally not allowed to supply or
            // duplicate evidence.
            const parsed = /auto-detected language:/i.test(stdout)
                ? null
                : parseWhisperBatchLid(stderr, inputs.length);
            if (code !== 0 || !parsed) {
                await finish(failure({
                    code,
                    error: code !== 0 ? `exit ${code}` : 'language output count mismatch',
                }));
                return;
            }
            const texts = await Promise.all(transcriptPaths.map(async (transcriptPath) => {
                try { return String(await readFileImpl(transcriptPath, 'utf8') || '').trim(); }
                catch (_) { return ''; }
            }));
            await finish({
                ok: true,
                samples: parsed.map((lid, index) => ({
                    text: texts[index],
                    lang: lid.lang,
                    prob: lid.prob,
                })),
                code,
                timedOut: false,
                aborted: false,
                preempted: false,
                error: null,
            });
        });
    });
}

// Keep the v93 proof rule explicit and independently testable: four accepted samples from one
// language verify, weak speech is diagnostic only, and one strong conflicting transcript vetoes
// the entire batch even when four other windows agree.
function resolveStrictLidConsensus(sampleResults, consensusNeeded = 4) {
    const acceptedSamples = [];
    const acceptedDiversity = [];
    const votes = new Map();
    let rejectedSpeechSampleCount = 0;
    let ignoredWeakSpeechSampleCount = 0;
    let repeatedSpeechSampleCount = 0;
    let missingDiversitySampleCount = 0;
    let insufficientSpeechSampleCount = 0;
    let evaluatedSampleCount = 0;
    let bestAccepted = null;
    let best = null;
    for (const entry of sampleResults || []) {
        evaluatedSampleCount++;
        const result = entry?.result || null;
        const disposition = String(entry?.disposition || 'insufficient');
        if (disposition === 'conflict') rejectedSpeechSampleCount++;
        if (disposition === 'weak') ignoredWeakSpeechSampleCount++;
        if (disposition === 'insufficient') insufficientSpeechSampleCount++;
        if (result && (!best || Number(result.wordCount || 0) > Number(best.wordCount || 0))) {
            best = result;
        }
        if (disposition !== 'accepted' || !result?.language) continue;
        const diversity = entry?.diversity || null;
        if (!validStrictTranscriptDiversity(diversity)) {
            missingDiversitySampleCount++;
            continue;
        }
        const repeated = acceptedDiversity.some((prior) => (
            prior.fingerprint === diversity.fingerprint
            || strictTranscriptShingleSimilarity(prior, diversity)
                >= STRICT_LID_MAX_SAMPLE_SHINGLE_SIMILARITY
        ));
        if (repeated) {
            repeatedSpeechSampleCount++;
            continue;
        }
        acceptedDiversity.push(diversity);
        const language = String(result.language);
        const sample = {
            offset: result.offset,
            language,
            probability: Number(result.confidence || 0),
            wordCount: Number(result.wordCount || 0),
            uniqueWordCount: Number(result.uniqueWordCount || 0),
            transcriptAgrees: result.transcriptAgrees,
        };
        acceptedSamples.push(sample);
        votes.set(language, (votes.get(language) || 0) + 1);
        if (!bestAccepted || sample.wordCount > Number(bestAccepted.wordCount || 0)) {
            bestAccepted = result;
        }
    }
    const verified = Boolean(
        bestAccepted
        && acceptedSamples.length >= consensusNeeded
        && votes.size === 1
        && rejectedSpeechSampleCount === 0
    );
    return {
        verified,
        language: verified ? acceptedSamples[0].language : null,
        acceptedSamples,
        votes,
        bestAccepted,
        best,
        rejectedSpeechSampleCount,
        ignoredWeakSpeechSampleCount,
        repeatedSpeechSampleCount,
        missingDiversitySampleCount,
        insufficientSpeechSampleCount,
        evaluatedSampleCount,
    };
}

module.exports = {
    buildWhisperBatchArgs,
    buildStrictLidUnverifiedObservability,
    cleanupStrictLidFiles,
    evaluateStrictTranscriptEvidence,
    parseWhisperBatchLid,
    resolveStrictLidConsensus,
    runWhisperBatchProcess,
    strictLidBatchFailureResponse,
    strictLidBatchOutcome,
};
