'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LANGUAGE_LINE_RE =
    /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\)/gi;
const MAX_PROCESS_OUTPUT_CHARS = 64 * 1024;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;

function appendBounded(current, chunk) {
    const next = current + Buffer.from(chunk).toString('utf8');
    return next.length > MAX_PROCESS_OUTPUT_CHARS
        ? next.slice(-MAX_PROCESS_OUTPUT_CHARS)
        : next;
}

function parseWhisperLid(output) {
    const matches = [];
    for (const match of String(output || '').matchAll(LANGUAGE_LINE_RE)) {
        const lang = String(match[1] || '').toLowerCase();
        const prob = Number(match[2]);
        if (!/^[a-z]{2,3}$/.test(lang) || !Number.isFinite(prob) || prob < 0 || prob > 1) {
            continue;
        }
        matches.push({ lang, prob });
    }
    if (!matches.length || new Set(matches.map((item) => item.lang)).size !== 1) {
        return null;
    }
    return matches.reduce((best, item) => item.prob > best.prob ? item : best);
}

function safeProcessError(value) {
    return String(value?.message || value || 'whisper failed')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160) || 'whisper failed';
}

function runCli({
    bin,
    args,
    timeoutMs,
    spawnImpl = spawn,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawnImpl(bin, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (error) {
            resolve({
                ok: false,
                code: null,
                timedOut: false,
                stdout: '',
                stderr: '',
                error: `spawn failed: ${safeProcessError(error)}`,
            });
            return;
        }

        let settled = false;
        let timedOut = false;
        let stdout = '';
        let stderr = '';
        let killGraceTimer = null;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimer(timer);
            if (killGraceTimer !== null) clearTimer(killGraceTimer);
            resolve(result);
        };
        const timedOutResult = (code = null) => ({
            ok: false,
            code,
            timedOut: true,
            stdout: '',
            stderr: '',
            error: 'timeout',
        });
        const timer = setTimer(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (_) {}
            killGraceTimer = setTimer(() => finish(timedOutResult()), 1000);
        }, timeoutMs);

        child.stdout?.on('data', (chunk) => {
            stdout = appendBounded(stdout, chunk);
        });
        child.stderr?.on('data', (chunk) => {
            stderr = appendBounded(stderr, chunk);
        });
        child.on('error', (error) => finish(timedOut ? timedOutResult() : {
            ok: false,
            code: null,
            timedOut: false,
            stdout: '',
            stderr: '',
            error: `process error: ${safeProcessError(error)}`,
        }));
        child.on('close', (code) => {
            if (timedOut) {
                finish(timedOutResult(code));
                return;
            }
            finish({
                ok: code === 0,
                code,
                timedOut: false,
                stdout,
                stderr,
                error: code === 0 ? null : `exit ${code}`,
            });
        });
    });
}

async function runWhisperDetectOnly({
    bin,
    model,
    wavPath,
    threads,
    timeoutMs,
    spawnImpl,
}) {
    const processResult = await runCli({
        bin,
        args: [
            '-m', String(model),
            '-f', String(wavPath),
            '-l', 'auto',
            '-dl',
            '-t', String(threads),
        ],
        timeoutMs,
        spawnImpl,
    });
    const parsed = parseWhisperLid(`${processResult.stderr}\n${processResult.stdout}`);
    if (processResult.ok !== true || !parsed) {
        return {
            ok: false,
            lang: null,
            prob: 0,
            timedOut: processResult.timedOut === true,
            errorCode: processResult.timedOut ? 'timeout' : 'detect-only-failed',
            error: processResult.error || 'language output missing',
        };
    }
    return {
        ok: true,
        lang: parsed.lang,
        prob: parsed.prob,
        timedOut: false,
        errorCode: null,
        error: null,
    };
}

function transcriptMetrics(value) {
    const words = String(value || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
    const normalized = words.map((word) => word.normalize('NFKC').toLocaleLowerCase('und'));
    return {
        wordCount: Math.min(100_000, words.length),
        uniqueWordCount: Math.min(100_000, new Set(normalized).size),
    };
}

async function runWhisperFull({
    bin,
    model,
    wavPath,
    threads,
    timeoutMs,
    spawnImpl,
}) {
    const outputPrefix = path.join(
        path.dirname(wavPath),
        `.whisper-${crypto.randomUUID()}`,
    );
    const outputPath = `${outputPrefix}.txt`;
    try {
        const processResult = await runCli({
            bin,
            args: [
                '-m', String(model),
                '-f', String(wavPath),
                '-l', 'auto',
                '-nt',
                '-otxt',
                '-of', outputPrefix,
                '-t', String(threads),
            ],
            timeoutMs,
            spawnImpl,
        });
        const parsed = parseWhisperLid(`${processResult.stderr}\n${processResult.stdout}`);
        if (processResult.ok !== true || !parsed) {
            return {
                ok: false,
                lang: null,
                prob: 0,
                wordCount: 0,
                uniqueWordCount: 0,
                timedOut: processResult.timedOut === true,
                errorCode: processResult.timedOut ? 'timeout' : 'full-whisper-failed',
                error: processResult.error || 'language output missing',
            };
        }

        let text;
        try {
            const stat = await fsp.stat(outputPath);
            if (!stat.isFile() || stat.size < 1 || stat.size > MAX_TRANSCRIPT_BYTES) {
                throw new Error('transcript size is outside the bounded range');
            }
            text = await fsp.readFile(outputPath, 'utf8');
        } catch (error) {
            return {
                ok: false,
                lang: null,
                prob: 0,
                wordCount: 0,
                uniqueWordCount: 0,
                timedOut: false,
                errorCode: 'transcript-unavailable',
                error: safeProcessError(error),
            };
        }
        const metrics = transcriptMetrics(text);
        text = '';
        return {
            ok: true,
            lang: parsed.lang,
            prob: parsed.prob,
            ...metrics,
            timedOut: false,
            errorCode: null,
            error: null,
        };
    } finally {
        await fsp.unlink(outputPath).catch(() => {});
    }
}

module.exports = {
    parseWhisperLid,
    runWhisperDetectOnly,
    runWhisperFull,
    transcriptMetrics,
};
