'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const {
    MAX_WAV_BYTES, MAX_AUDIO_SECONDS, MAX_VAD_SEGMENTS, PCM_SAMPLE_RATE,
    analyzePcm16Wav, selectSpeechWindow, cropPcm16Wav, createStrictLidAudioDiagnostic,
} = require('./strict-lid-audio-evidence');

const MAX_VAD_OUTPUT_BYTES = 64 * 1024;
const MAX_VAD_TIMEOUT_MS = 8000;
const MAX_VAD_KILL_GRACE_MS = 1000;
const VAD_OUTCOMES = new Set([
    'not-run', 'unavailable', 'succeeded', 'failed', 'invalid-output', 'output-limit',
    'timed-out', 'aborted', 'preempted',
]);

// Contract pinned to whisper.cpp 080bbbe85230f624f0b52127f1ae1218247989f9,
// examples/vad-speech-segments/speech.cpp. The CLI prints CENTISECONDS, not
// seconds, with a zero-based sequential segment index and exactly two decimals.
function parseStrictLidVadSegments(stdout) {
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_VAD_OUTPUT_BYTES) return null;
    const lines = stdout.trim().split(/\r?\n/);
    const header = /^Detected (0|[1-9]\d{0,3}) speech segments:$/.exec(lines[0] || '');
    if (!header) return null;
    const count = Number(header[1]);
    if (count > MAX_VAD_SEGMENTS || lines.length !== count + 1) return null;
    const segments = [];
    for (let index = 0; index < count; index++) {
        const match = /^Speech segment (0|[1-9]\d*): start = ((?:0|[1-9]\d*)\.\d{2}), end = ((?:0|[1-9]\d*)\.\d{2})$/.exec(lines[index + 1]);
        if (!match || Number(match[1]) !== index) return null;
        // Parse the printed two-decimal centiseconds as integer 1/10000 s
        // first, avoiding an unnecessary second floating-point division.
        const start = Number(match[2].replace('.', '')) / 10000;
        const end = Number(match[3].replace('.', '')) / 10000;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > MAX_AUDIO_SECONDS) return null;
        segments.push(Object.freeze({ start, end }));
    }
    return Object.freeze(segments);
}

function preemptedNow(isPreempted) {
    if (typeof isPreempted !== 'function') return false;
    try { return isPreempted() === true; } catch { return true; }
}

function cleanPath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0');
}

function runStrictLidVadProcess({
    bin, model, wavPath, timeoutMs = MAX_VAD_TIMEOUT_MS, abortSignal = null, onSpawn = null,
    isPreempted = null, spawnImpl = spawn, killGraceMs = MAX_VAD_KILL_GRACE_MS,
} = {}) {
    const result = (outcome, extra = {}) => Object.freeze({
        ok: outcome === 'succeeded', outcome, segments: null,
        aborted: outcome === 'aborted', preempted: outcome === 'preempted', timedOut: outcome === 'timed-out',
        ...extra,
    });
    if (preemptedNow(isPreempted)) return Promise.resolve(result('preempted'));
    if (abortSignal?.aborted) return Promise.resolve(result('aborted'));
    if (!cleanPath(bin) || !cleanPath(model) || !cleanPath(wavPath)) return Promise.resolve(result('unavailable'));
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(MAX_VAD_TIMEOUT_MS, Math.floor(timeoutMs))) : MAX_VAD_TIMEOUT_MS;
    const grace = Number.isFinite(killGraceMs) ? Math.max(1, Math.min(MAX_VAD_KILL_GRACE_MS, Math.floor(killGraceMs))) : MAX_VAD_KILL_GRACE_MS;
    return new Promise((resolve) => {
        let child;
        try {
            // The pinned CLI defaults to CPU; -ug is deliberately absent.
            child = spawnImpl(bin, ['-np', '-vm', model, '-f', wavPath, '-t', '2'], {
                stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            });
        } catch {
            resolve(result('failed'));
            return;
        }
        let settled = false;
        let terminalOutcome = null;
        let aborted = false;
        let preempted = false;
        let timedOut = false;
        let outputBytes = 0;
        const stdoutChunks = [];
        let timeoutTimer = null;
        let graceTimer = null;
        let preemptTimer = null;
        const finish = (outcome, segments = null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutTimer);
            clearTimeout(graceTimer);
            clearTimeout(preemptTimer);
            abortSignal?.removeEventListener?.('abort', onAbort);
            resolve(result(outcome, { segments, aborted, preempted, timedOut }));
        };
        const stop = (outcome) => {
            if (settled) return;
            aborted ||= abortSignal?.aborted === true || outcome === 'aborted';
            preempted ||= preemptedNow(isPreempted) || outcome === 'preempted';
            timedOut ||= outcome === 'timed-out';
            terminalOutcome = preempted ? 'preempted' : (aborted ? 'aborted' : (terminalOutcome || outcome));
            if (graceTimer !== null) return;
            // Wait for close after SIGKILL; the bounded grace also handles a broken
            // process shim without ever treating a late successful exit as evidence.
            graceTimer = setTimeout(() => finish(terminalOutcome), grace);
            try { child.kill('SIGKILL'); } catch { /* close/grace remains authoritative */ }
        };
        const onAbort = () => stop(preemptedNow(isPreempted) ? 'preempted' : 'aborted');
        const readOutput = (chunk, keep) => {
            if (settled || terminalOutcome) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
            outputBytes += bytes.length;
            if (outputBytes > MAX_VAD_OUTPUT_BYTES) { stop('output-limit'); return; }
            if (keep) stdoutChunks.push(bytes);
        };
        child.stdout?.on('data', (chunk) => readOutput(chunk, true));
        // stderr is bounded and drained but never retained, parsed or logged.
        child.stderr?.on('data', (chunk) => readOutput(chunk, false));
        child.on('error', () => stop('failed'));
        child.on('close', (code) => {
            if (settled) return;
            preempted ||= preemptedNow(isPreempted);
            aborted ||= abortSignal?.aborted === true;
            if (preempted || aborted || terminalOutcome) {
                finish(preempted ? 'preempted' : (aborted ? 'aborted' : terminalOutcome));
                return;
            }
            if (code !== 0) { finish('failed'); return; }
            const segments = parseStrictLidVadSegments(Buffer.concat(stdoutChunks).toString('utf8'));
            finish(segments === null ? 'invalid-output' : 'succeeded', segments);
        });
        abortSignal?.addEventListener?.('abort', onAbort, { once: true });
        try { if (typeof onSpawn === 'function') onSpawn(child); }
        catch { stop('failed'); }
        if (abortSignal?.aborted || preemptedNow(isPreempted)) { onAbort(); return; }
        if (settled || terminalOutcome) return;
        timeoutTimer = setTimeout(() => stop('timed-out'), timeout);
        const pollPreemption = () => {
            if (settled || terminalOutcome) return;
            if (preemptedNow(isPreempted)) { stop('preempted'); return; }
            preemptTimer = setTimeout(pollPreemption, 50);
        };
        preemptTimer = setTimeout(pollPreemption, 50);
    });
}

function validPlan(plan) {
    if (!plan || typeof plan !== 'object' || plan.selectionProtocol !== 1) return false;
    const names = ['anchorOffsetMilliseconds', 'searchStartMilliseconds', 'searchDurationMilliseconds',
        'stratumStartMilliseconds', 'stratumEndMilliseconds', 'preferredStartMilliseconds', 'sampleDurationMilliseconds'];
    if (names.some((name) => !Number.isSafeInteger(plan[name]) || plan[name] < 0)) return false;
    return plan.sampleDurationMilliseconds === 20000
        && plan.searchDurationMilliseconds >= 20000 && plan.searchDurationMilliseconds <= 60000
        && plan.searchStartMilliseconds >= plan.stratumStartMilliseconds
        && plan.searchStartMilliseconds + plan.searchDurationMilliseconds <= plan.stratumEndMilliseconds
        && plan.anchorOffsetMilliseconds === plan.searchStartMilliseconds + plan.preferredStartMilliseconds
        && plan.preferredStartMilliseconds + 20000 <= plan.searchDurationMilliseconds;
}

function localSpeechMeasurement(segments, startSeconds, durationSeconds) {
    const local = segments.map(({ start, end }) => ({
        start: Math.max(0, start - startSeconds),
        end: Math.min(durationSeconds, end - startSeconds),
    })).filter(({ start, end }) => start < end);
    return selectSpeechWindow({ segments: local, durationSeconds, targetSeconds: durationSeconds, preferredStartSeconds: 0 });
}

async function prepareStrictLidSpeechSample({
    wavPath, plan, bin = null, model = null, timeoutMs = MAX_VAD_TIMEOUT_MS,
    abortSignal = null, onSpawn = null, isPreempted = null, runVadImpl = runStrictLidVadProcess,
} = {}) {
    const startedAt = Date.now();
    let analysis = null;
    let vadOutcome = 'not-run';
    let timedOut = false;
    const stopped = () => ({ aborted: abortSignal?.aborted === true, preempted: preemptedNow(isPreempted) });
    const diagnostic = (outcome, extra = {}) => Object.freeze({
        ...createStrictLidAudioDiagnostic({ ...analysis, outcome, ...extra, elapsedMs: Math.min(225000, Math.max(0, Date.now() - startedAt)) }),
        vadOutcome,
    });
    const failure = (outcome) => Object.freeze({
        ok: false, offset: null, selection: null, diagnostic: diagnostic(outcome), ...stopped(), timedOut,
    });
    let state = stopped();
    if (state.aborted || state.preempted) return failure(state.preempted ? 'preempted' : 'aborted');
    if (!cleanPath(wavPath) || !validPlan(plan)) return failure('invalid-audio');
    let handle;
    try {
        // This is an existing, private extraction file. Read and rewrite through
        // one descriptor, reject symlinks on supporting platforms and never pad.
        handle = await fsp.open(wavPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
        const initialStat = await handle.stat();
        if (!initialStat.isFile() || initialStat.size < 44 || initialStat.size > MAX_WAV_BYTES) return failure('invalid-audio');
        const source = Buffer.alloc(initialStat.size);
        let bytesRead = 0;
        while (bytesRead < source.length) {
            const read = await handle.read(source, bytesRead, source.length - bytesRead, bytesRead);
            if (read.bytesRead === 0) return failure('invalid-audio');
            bytesRead += read.bytesRead;
        }
        analysis = analyzePcm16Wav(source);
        const usableDuration = Math.min(analysis.durationSeconds, plan.searchDurationMilliseconds / 1000);
        if (usableDuration < 20) return failure('invalid-audio');
        state = stopped();
        if (state.aborted || state.preempted) return failure(state.preempted ? 'preempted' : 'aborted');
        let vad;
        if (!cleanPath(bin) || !cleanPath(model)) {
            vad = { ok: false, outcome: 'unavailable', segments: null };
        } else {
            try { vad = await runVadImpl({ bin, model, wavPath, timeoutMs, abortSignal, onSpawn, isPreempted }); }
            catch { vad = { ok: false, outcome: 'failed', segments: null }; }
        }
        vadOutcome = typeof vad?.outcome === 'string' && VAD_OUTCOMES.has(vad.outcome) ? vad.outcome : 'failed';
        timedOut = vad?.timedOut === true;
        state = stopped();
        if (state.aborted || state.preempted || vad?.aborted || vad?.preempted) {
            return Object.freeze({ ...failure(state.preempted || vad?.preempted ? 'preempted' : 'aborted'),
                aborted: state.aborted || vad?.aborted === true, preempted: state.preempted || vad?.preempted === true });
        }
        let segments = null;
        let chosen = null;
        let totalSpeech = null;
        if (vad?.ok === true && vadOutcome === 'succeeded' && Array.isArray(vad.segments)) {
            try {
                // Revalidate injected/process output through the pure bounded
                // selector before trusting it; a detector failure uses the anchor.
                chosen = selectSpeechWindow({ segments: vad.segments, durationSeconds: usableDuration,
                    targetSeconds: 20, preferredStartSeconds: plan.preferredStartMilliseconds / 1000 });
                const validatedSegments = vad.segments.map((segment) => Array.isArray(segment)
                    ? { start: segment[0], end: segment[1] } : segment);
                totalSpeech = localSpeechMeasurement(validatedSegments, 0, usableDuration);
                segments = validatedSegments;
            } catch { vadOutcome = 'invalid-output'; chosen = null; totalSpeech = null; }
        }
        const useVad = chosen !== null && chosen.speechSeconds > 0;
        const localStartMilliseconds = useVad
            ? Math.max(0, Math.min(Math.round(chosen.startSeconds * 1000), Math.floor((usableDuration - 20) * 1000 + 1e-9)))
            : plan.preferredStartMilliseconds;
        if (localStartMilliseconds + 20000 > usableDuration * 1000 + 1e-9) return failure('invalid-audio');
        const selectedSpeech = segments === null ? null : localSpeechMeasurement(segments, localStartMilliseconds / 1000, 20);
        const selection = Object.freeze({
            protocol: 1, searchStartMilliseconds: plan.searchStartMilliseconds,
            searchDurationMilliseconds: plan.searchDurationMilliseconds,
            selectedOffsetMilliseconds: plan.searchStartMilliseconds + localStartMilliseconds,
            selectedDurationMilliseconds: 20000,
            speechMilliseconds: selectedSpeech === null ? null : Math.floor(selectedSpeech.speechSeconds * 1000 + 1e-9),
            selector: useVad ? 'silero-vad-max-speech-v1' : 'anchor-fallback',
        });
        const cropped = cropPcm16Wav(source, localStartMilliseconds / 1000, 20);
        if (cropped.analysis.sampleCount !== PCM_SAMPLE_RATE * 20) return failure('invalid-audio');
        const currentStat = await handle.stat();
        if (currentStat.size !== initialStat.size || currentStat.mtimeMs !== initialStat.mtimeMs) return failure('invalid-audio');
        state = stopped();
        if (state.aborted || state.preempted) return failure(state.preempted ? 'preempted' : 'aborted');
        let bytesWritten = 0;
        while (bytesWritten < cropped.buffer.length) {
            const written = await handle.write(cropped.buffer, bytesWritten, cropped.buffer.length - bytesWritten, bytesWritten);
            if (written.bytesWritten === 0) return failure('failed');
            bytesWritten += written.bytesWritten;
        }
        await handle.truncate(cropped.buffer.length);
        state = stopped();
        if (state.aborted || state.preempted) return failure(state.preempted ? 'preempted' : 'aborted');
        return Object.freeze({
            ok: true, offset: selection.selectedOffsetMilliseconds / 1000, selection,
            diagnostic: diagnostic('selected', {
                vadSegmentCount: totalSpeech?.segmentCount,
                vadSpeechSeconds: totalSpeech?.speechSeconds, vadSpeechRatio: totalSpeech?.speechRatio,
                selectionStartSeconds: localStartMilliseconds / 1000, selectionDurationSeconds: 20,
                selectionSpeechSeconds: selectedSpeech?.speechSeconds, selectionSpeechRatio: selectedSpeech?.speechRatio,
            }),
            aborted: false, preempted: false, timedOut,
        });
    } catch {
        state = stopped();
        return failure(state.preempted ? 'preempted' : (state.aborted ? 'aborted' : 'invalid-audio'));
    } finally {
        if (handle) { try { await handle.close(); } catch { /* no private path in diagnostics */ } }
    }
}

module.exports = {
    MAX_VAD_OUTPUT_BYTES, MAX_VAD_TIMEOUT_MS, MAX_VAD_KILL_GRACE_MS,
    parseStrictLidVadSegments, runStrictLidVadProcess, prepareStrictLidSpeechSample,
};
