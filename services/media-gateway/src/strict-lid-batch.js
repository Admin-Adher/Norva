const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const LANGUAGE_LINE_RE =
    /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\)/gi;
const MAX_PROCESS_OUTPUT_CHARS = 512 * 1024;

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
    const votes = new Map();
    let rejectedSpeechSampleCount = 0;
    let ignoredWeakSpeechSampleCount = 0;
    let bestAccepted = null;
    let best = null;
    for (const entry of sampleResults || []) {
        const result = entry?.result || null;
        const disposition = String(entry?.disposition || 'insufficient');
        if (disposition === 'conflict') rejectedSpeechSampleCount++;
        if (disposition === 'weak') ignoredWeakSpeechSampleCount++;
        if (result && (!best || Number(result.wordCount || 0) > Number(best.wordCount || 0))) {
            best = result;
        }
        if (disposition !== 'accepted' || !result?.language) continue;
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
    };
}

module.exports = {
    buildWhisperBatchArgs,
    cleanupStrictLidFiles,
    parseWhisperBatchLid,
    resolveStrictLidConsensus,
    runWhisperBatchProcess,
};
