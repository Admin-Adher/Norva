'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

// Classify transient process output in memory. Only these fixed labels may be
// logged: stderr, local capability handles and media titles never leave here.
function classifyStrictLidExtractFailure(stderr) {
    const text = String(stderr || '').slice(-8192).toLowerCase();
    if (/stream map .*matches no streams|invalid stream specifier/.test(text)) return 'track_map_missing';
    if (/protocol .*not on whitelist|format .*not on whitelist/.test(text)) return 'input_format_rejected';
    if (/decoder .*not found|unknown decoder|decoding requested, but no decoder/.test(text)) return 'decoder_unavailable';
    if (/permission denied|no space left on device|read-only file system/.test(text)) return 'workspace_unavailable';
    if (/invalid data found|moov atom not found|could not find codec parameters/.test(text)) return 'invalid_media';
    if (/connection timed out|operation timed out/.test(text)) return 'loopback_timeout';
    if (/server returned (?:4\d\d|5\d\d)|http error (?:4\d\d|5\d\d)/.test(text)) return 'loopback_http_error';
    if (/connection refused|connection reset|input\/output error|i\/o error/.test(text)) return 'loopback_transport_error';
    if (/end of file|unexpected eof|file ended prematurely/.test(text)) return 'truncated_input';
    if (/immediate exit requested|operation interrupted/.test(text)) return 'consumer_cancelled';
    return 'unclassified';
}

// A single local demuxer input, up to four separately mapped unknown tracks.
// No playlist/nested resource demuxer, direct provider URL, transport reconnect,
// or second input. Mono-session arbitration remains the broker's responsibility.
function strictLidMultiExtractArgs({ inputUrl, outputs, startSeconds, durationSeconds, timeoutMs }) {
    let input;
    try { input = new URL(inputUrl); } catch (_) { throw Object.assign(new Error('LID_MULTI_EXTRACT_ARGUMENTS_INVALID'), { code: 'LID_MULTI_EXTRACT_ARGUMENTS_INVALID' }); }
    if (input.protocol !== 'http:' || input.hostname !== '127.0.0.1' || !input.port
        || input.username || input.password || input.search || input.hash || !/^\/strict-lid\/[A-Za-z0-9_-]+$/.test(input.pathname)
        || !Array.isArray(outputs) || outputs.length < 1 || outputs.length > 4
        || outputs.some(o => !Number.isInteger(o.index) || o.index < 0 || o.index > 128
            || !path.isAbsolute(o.path || '') || path.extname(o.path) !== '.wav' || o.path.includes('\0'))
        || new Set(outputs.map(o => o.index)).size !== outputs.length
        || new Set(outputs.map(o => o.path)).size !== outputs.length
        || !Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 24 * 3600
        || !Number.isFinite(durationSeconds) || durationSeconds < 20 || durationSeconds > 60
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 165000) {
        throw Object.assign(new Error('LID_MULTI_EXTRACT_ARGUMENTS_INVALID'), { code: 'LID_MULTI_EXTRACT_ARGUMENTS_INVALID' });
    }
    return ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-rw_timeout', String(timeoutMs * 1000), '-headers', 'Connection: close\r\n',
        '-protocol_whitelist', 'http,tcp',
        '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mpegts,mpeg,ogg,flv',
        '-probesize', '2000000', '-analyzeduration', '3000000',
        ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []), '-i', inputUrl,
        ...outputs.flatMap(o => ['-map', `0:${o.index}`, '-t', String(durationSeconds),
            // -t follows timestamps, which need not equal decoded sample count.
            // Bound actual PCM after resampling; keep original timestamps and
            // never synthesize padding or collect another temporal window.
            '-af', `aresample=16000,atrim=end_sample=${Math.floor(durationSeconds * 16000 + 1e-9)}`,
            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', o.path])];
}

function runStrictLidMultiExtract({ bin, inputUrl, outputs, startSeconds, durationSeconds, timeoutMs = 165000,
    env, signal, onSpawn, isPreempted = () => false, spawnImpl = spawn,
    diagnostic = value => console.info(JSON.stringify(value)) } = {}) {
    const args = strictLidMultiExtractArgs({ inputUrl, outputs, startSeconds, durationSeconds, timeoutMs });
    const preemptedNow = () => { try { return isPreempted() === true; } catch (_) { return true; } };
    const failure = (code, processClosed, extra = {}) => ({ ok: false, code, processClosed, ...extra });
    if (signal?.aborted) return Promise.resolve(failure('LID_CAPTURE_CANCELLED', true));
    if (preemptedNow()) return Promise.resolve(failure('LANGUAGE_VALIDATION_VIEWER_PREEMPTED', true, { preempted: true }));
    return new Promise(resolve => {
        let child; let timer; let grace; let poll; let settled = false; let terminal = null; let bytes = 0;
        let stderrTail = ''; let exitCode = null; const startedAt = Date.now();
        const finish = value => {
            if (settled) return; settled = true;
            clearTimeout(timer); clearTimeout(grace); clearTimeout(poll);
            signal?.removeEventListener('abort', aborted);
            if (!value.ok) {
                const detail = classifyStrictLidExtractFailure(stderrTail);
                stderrTail = '';
                // Logging cannot change cleanup, retries or provider admission.
                try { diagnostic({ event: 'strict_lid_extraction_diagnostic', detail,
                    exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
                    stderrBytes: Math.min(bytes, 65537), elapsedMs: Math.max(0, Date.now() - startedAt),
                    processClosed: value.processClosed === true, outputCount: outputs.length }); } catch (_) {}
            }
            stderrTail = '';
            resolve(value);
        };
        const stop = code => {
            if (terminal || settled) return; terminal = code;
            // Unknown child close is NOT a successful extraction. The caller
            // still closes/drains the only upstream-capable broker separately.
            grace = setTimeout(() => finish(failure('LID_EXTRACT_CLOSE_UNCONFIRMED', false)), 1000);
            try { child.kill('SIGKILL'); } catch (_) {}
        };
        const aborted = () => stop('LID_CAPTURE_CANCELLED');
        try { child = spawnImpl(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); }
        catch (_) { finish(failure('LID_CAPTURE_EXTRACTION_FAILED', true)); return; }
        child.stderr?.on('data', chunk => {
            // Bounded ephemeral classifier input; never returned or persisted.
            bytes += Buffer.byteLength(chunk);
            stderrTail = (stderrTail + chunk.toString().slice(-8192)).slice(-8192);
            if (bytes > 64 * 1024) stop('LID_EXTRACT_OUTPUT_LIMIT');
        });
        child.on('error', () => stop('LID_CAPTURE_EXTRACTION_FAILED'));
        child.on('close', code => {
            exitCode = code;
            const preempted = preemptedNow();
            if (preempted) terminal = 'LANGUAGE_VALIDATION_VIEWER_PREEMPTED';
            else if (signal?.aborted) terminal = 'LID_CAPTURE_CANCELLED';
            finish(code === 0 && !terminal ? { ok: true, processClosed: true, outputs }
                : failure(terminal || 'LID_CAPTURE_EXTRACTION_FAILED', true, { preempted }));
        });
        try { onSpawn?.(child); } catch (_) { stop('LID_CAPTURE_EXTRACTION_FAILED'); }
        if (settled || terminal) return;
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
        timer = setTimeout(() => stop('LID_CAPTURE_EXTRACTION_TIMEOUT'), timeoutMs);
        const check = () => {
            if (settled || terminal) return;
            if (preemptedNow()) stop('LANGUAGE_VALIDATION_VIEWER_PREEMPTED');
            else poll = setTimeout(check, 50);
        };
        poll = setTimeout(check, 50);
    });
}

module.exports = { strictLidMultiExtractArgs, runStrictLidMultiExtract, classifyStrictLidExtractFailure };
