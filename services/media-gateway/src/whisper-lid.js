const { spawn } = require('child_process');

const LANGUAGE_LINE_RE =
    /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\)/gi;
const MAX_PROCESS_OUTPUT_CHARS = 64 * 1024;

function appendBounded(current, chunk) {
    const next = current + chunk.toString();
    return next.length > MAX_PROCESS_OUTPUT_CHARS
        ? next.slice(-MAX_PROCESS_OUTPUT_CHARS)
        : next;
}

function parseWhisperLid(output) {
    const matches = [];
    const text = String(output || '');
    for (const match of text.matchAll(LANGUAGE_LINE_RE)) {
        const lang = String(match[1] || '').toLowerCase();
        const prob = Number(match[2]);
        if (!/^[a-z]{2,3}$/.test(lang) || !Number.isFinite(prob) || prob < 0 || prob > 1) {
            continue;
        }
        matches.push({ lang, prob });
    }
    if (!matches.length) return null;
    if (new Set(matches.map((item) => item.lang)).size !== 1) return null;
    return matches.reduce((best, item) => item.prob > best.prob ? item : best);
}

function buildWhisperDetectOnlyArgs({ model, wavPath, threads }) {
    return [
        '-m', String(model),
        '-f', String(wavPath),
        '-l', 'auto',
        '-dl',
        '-t', String(threads),
    ];
}

function runWhisperDetectOnly({
    bin,
    model,
    wavPath,
    threads,
    timeoutMs,
    spawnImpl = spawn,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onSpawn = null,
}) {
    return new Promise((resolve) => {
        const args = buildWhisperDetectOnlyArgs({ model, wavPath, threads });
        let child;
        try {
            child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({
                ok: false,
                lang: null,
                prob: 0,
                code: null,
                timedOut: false,
                error: `spawn failed: ${String(error?.message || error)}`,
            });
            return;
        }
        try {
            if (typeof onSpawn === 'function') onSpawn(child);
        } catch (error) {
            child.on?.('error', () => {});
            try { child.kill('SIGKILL'); } catch (_) {}
            resolve({
                ok: false,
                lang: null,
                prob: 0,
                code: null,
                timedOut: false,
                error: `spawn hook failed: ${String(error?.message || error)}`,
            });
            return;
        }

        let settled = false;
        let timedOut = false;
        let stdout = '';
        let stderr = '';
        let timer = null;
        let killGraceTimer = null;
        const timeoutResult = (code = null) => ({
            ok: false,
            lang: null,
            prob: 0,
            code,
            timedOut: true,
            error: 'timeout',
        });
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimer(timer);
            if (killGraceTimer !== null) clearTimer(killGraceTimer);
            resolve(value);
        };
        timer = setTimer(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (_) {}
            // Do not start the comparison process while the timed-out child may still consume
            // CPU. Normally SIGKILL is followed immediately by `close`; the grace is only a
            // fail-safe for a broken child-process implementation.
            killGraceTimer = setTimer(() => finish(timeoutResult()), 1000);
        }, timeoutMs);

        child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
        child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
        child.on('error', (error) => finish(timedOut ? timeoutResult() : {
            ok: false,
            lang: null,
            prob: 0,
            code: null,
            timedOut: false,
            error: `process error: ${String(error?.message || error)}`,
        }));
        child.on('close', (code) => {
            if (timedOut) {
                finish(timeoutResult(code));
                return;
            }
            const parsed = parseWhisperLid(`${stderr}\n${stdout}`);
            if (code !== 0 || !parsed) {
                finish({
                    ok: false,
                    lang: null,
                    prob: 0,
                    code,
                    timedOut: false,
                    error: code !== 0 ? `exit ${code}` : 'language output missing',
                });
                return;
            }
            finish({
                ok: true,
                lang: parsed.lang,
                prob: parsed.prob,
                code,
                timedOut: false,
                error: null,
            });
        });
    });
}

module.exports = {
    buildWhisperDetectOnlyArgs,
    parseWhisperLid,
    runWhisperDetectOnly,
};
