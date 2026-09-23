'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const SEGMENT = /^(segment|video|audio_\d+)-(\d{5,8})\.ts$/;
const PLAYLIST = /^(?:playlist|video|audio_\d+)\.m3u8$/;
const PATTERN = /^(?:(?:segment|video|audio_\d+|%v)-%05d\.ts|(?:playlist|video|audio_\d+|%v)\.m3u8)$/;
const HLS_OUTPUT_ADMISSION_PROTOCOL = 1;

function loopbackOutputEnv(inputEnv = process.env) {
    const env = { ...inputEnv };
    env.no_proxy = ['127.0.0.1', 'localhost', '::1', env.no_proxy || env.NO_PROXY || ''].filter(Boolean).join(',');
    env.NO_PROXY = env.no_proxy;
    return env;
}

async function* completedRequestBody(req) {
    try { for await (const chunk of req) yield chunk; }
    catch (error) {
        // FFmpeg closes a nonpersistent write socket without awaiting 200.
        // Node may report ECONNRESET while a fully parsed body still drains to
        // disk. Only a COMPLETE HTTP message can survive that transport close;
        // preserve any readable tail and let the bounded file writer finish.
        if (!req.complete || error.code !== 'ECONNRESET') throw error;
        let chunk; while ((chunk = req.read()) !== null) yield chunk;
    }
}

// FFmpeg 5.1 does not wait for a PUT's final 200 response. A fresh HTTP
// request with URL user-info DOES wait for Expect:100-continue before
// opening the output body. Admit that handshake only when the viewer has
// room for the next segment. No timer/SIGSTOP or elapsed-time credit can let
// a fast remuxer overwrite the unread HLS window while JS is delayed/paused.
async function createHlsOutputAdmission({ root, targetSeconds = 4, aheadSeconds = 64,
    maxBytes = 512 * 1024 ** 2, onFailure = () => {}, io = fsp }) {
    const capability = crypto.randomBytes(32).toString('hex');
    const rootPath = path.resolve(root);
    const ahead = Math.max(4, Math.ceil(aheadSeconds / targetSeconds));
    const queue = [], sockets = new Set(), sizes = new Map(), writers = new Set();
    let stopped = false, failed = false, finishing = false, active = false, consumed = -1, produced = -1, bytes = 0, peakBytes = 0;
    let logRemainder = '', discardLogRemainder = false;
    let admissionWaits = 0, admittedSegments = 0, closePromise = null, finishPromise = null;
    // Never reuse an old producer's HLS window, including after a failed retry
    // cleanup. Other pre-existing regular files (e.g. subtitles) consume budget.
    for (const name of await io.readdir(rootPath)) {
        const stat = await io.lstat(path.join(rootPath, name));
        if (!stat.isFile() || stat.isSymbolicLink() || SEGMENT.test(name) || PLAYLIST.test(name))
            throw new Error('HLS_OUTPUT_NOT_EMPTY');
        sizes.set(name, stat.size); bytes += stat.size;
    }
    if (bytes > maxBytes) throw new Error('HLS_OUTPUT_STORAGE_CAPACITY');
    peakBytes = bytes;
    const server = http.createServer({ maxHeaderSize: 8192 });
    server.maxConnections = 64;
    server.requestTimeout = 0; server.timeout = 0; server.headersTimeout = 10_000;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const fail = () => { if (!stopped) { failed = true; stop(); onFailure('HLS_OUTPUT_ADMISSION_FAILED'); } };
    const reject = (res, status) => { res.writeHead(status, { 'Content-Length': '0', Connection: 'close' }); res.end(); };
    function nameFor(req) {
        const supplied = req.url?.slice(1, 65);
        if (req.url?.[0] !== '/' || req.url?.[65] !== '/' || !/^[a-f0-9]{64}$/.test(supplied || '')
            || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))) return null;
        const name = req.url.slice(capability.length + 2);
        return SEGMENT.test(name) || PLAYLIST.test(name) ? name : null;
    }
    async function write(entry) {
        const { req, res, name, number } = entry;
        const target = path.join(rootPath, name);
        const temporary = path.join(rootPath, '.' + name + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
        try {
            if (stopped) return;
            res.writeContinue();
            if (req.method === 'DELETE') {
                for await (const chunk of req) if (chunk.length) throw new Error('DELETE_BODY');
                await io.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
                bytes -= sizes.get(name) || 0; sizes.delete(name);
            } else {
                let received = 0;
                const limit = PLAYLIST.test(name) ? Math.min(maxBytes, 1024 * 1024) : maxBytes;
                const bounded = new Transform({ transform(chunk, _encoding, callback) {
                    received += chunk.length;
                    // Includes the old destination until atomic rename removes
                    // it, so the reservation is never temporarily exceeded.
                    if (stopped || received > limit || bytes + received > maxBytes) callback(new Error('OUTPUT_LIMIT'));
                    else callback(null, chunk);
                } });
                await pipeline(completedRequestBody(req), bounded, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
                if (stopped) return;
                await io.rename(temporary, target);
                bytes += received - (sizes.get(name) || 0); sizes.set(name, received);
                peakBytes = Math.max(peakBytes, bytes);
                if (number !== null) { produced = Math.max(produced, number); admittedSegments++; }
            }
            res.writeHead(200, { 'Content-Length': '0', Connection: 'close' }); res.end();
        } catch (_) {
            res.destroy(); if (!stopped) fail();
        } finally {
            await io.unlink(temporary).catch(() => {});
        }
    }
    function drain() {
        if (stopped || active) return;
        // A blocked next-segment request cannot hold up playlist publication or
        // deletion of already-consumed files on another rendition's connection.
        const index = queue.findIndex(entry => entry.number === null || entry.req.method === 'DELETE'
            || entry.number - consumed < ahead);
        if (index < 0) return;
        const entry = queue.splice(index, 1)[0];
        if (entry.req.destroyed || entry.res.destroyed) { drain(); return; }
        active = true;
        const writer = write(entry).finally(() => { writers.delete(writer); active = false; drain(); });
        writers.add(writer);
    }
    // Reject ordinary PUTs: without the handshake FFmpeg can race through the
    // entire film while ignoring final HTTP responses. The capability is never
    // exposed in the browser playlist or a user-visible playback URL.
    server.on('request', (_req, res) => reject(res, 417));
    server.on('checkContinue', (req, res) => {
        const name = nameFor(req);
        if (stopped || finishing || !name || !['PUT', 'DELETE'].includes(req.method)) return reject(res, 403);
        if (queue.length >= 32) { reject(res, 429); fail(); return; }
        const match = SEGMENT.exec(name);
        const number = match ? Number(match[2]) : null;
        if (number !== null && number - consumed >= ahead) admissionWaits++;
        const entry = { req, res, name, number };
        queue.push(entry);
        req.once('close', () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); });
        drain();
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolve(); });
    });
    server.on('error', fail);
    function stop() {
        if (closePromise) return closePromise;
        stopped = true; queue.length = 0;
        for (const socket of sockets) socket.destroy();
        closePromise = Promise.all([new Promise(resolve => server.close(resolve)), ...writers]).then(() => undefined);
        return closePromise;
    }
    function finish(timeoutMs = 5000) {
        if (finishPromise) return finishPromise;
        finishing = true;
        finishPromise = (async () => {
            // Process exit is not proof that the last accepted PUT has reached
            // disk. Drain only already-admitted writes, within a fixed deadline.
            let timer;
            const timeout = new Promise((_, rejectTimeout) => {
                timer = setTimeout(() => rejectTimeout(new Error('HLS_OUTPUT_DRAIN_TIMEOUT')), timeoutMs);
            });
            try {
                do { await Promise.race([Promise.all([...writers]), timeout]); } while (writers.size);
                if (failed || stopped || queue.length) throw new Error('HLS_OUTPUT_DRAIN_INCOMPLETE');
            } catch (error) { fail(); throw error; }
            finally { clearTimeout(timer); await stop(); }
        })();
        return finishPromise;
    }
    const redact = text => String(text).replace(/http:\/\/(?:[^\s/@]+@)?127\.0\.0\.1:\d+\/[a-f0-9]{64}\//g, '[bounded-hls-output]/');
    return {
        urlFor(name) {
            if (stopped || (!PATTERN.test(name) && !SEGMENT.test(name))) throw new Error('HLS_OUTPUT_NAME_INVALID');
            // The harmless user-info forces FFmpeg 5.1's Expect handshake on
            // each fresh output connection; the random path authorizes.
            return `http://norva:continue@127.0.0.1:${server.address().port}/${capability}/${name}`;
        },
        served(name) {
            const match = SEGMENT.exec(name);
            // Unselected audio renditions must not deadlock the shared FFmpeg
            // muxer, and audio prefetch alone must not advance the video window.
            if (!stopped && match && ['segment', 'video'].includes(match[1])) {
                consumed = Math.max(consumed, Number(match[2])); drain();
            }
        },
        stop, finish,
        redact,
        redactLogChunk(chunk, flush = false) {
            let text = String(chunk);
            if (discardLogRemainder) {
                const end = text.search(/[\r\n]/);
                if (end < 0) return '';
                text = text.slice(end + 1); discardLogRemainder = false;
            }
            text = logRemainder + text;
            const end = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
            if (flush) { logRemainder = ''; return redact(text); }
            logRemainder = text.slice(end);
            if (logRemainder.length > 64 * 1024) {
                logRemainder = ''; discardLogRemainder = true;
                return redact(text.slice(0, end)) + '[FFmpeg log line truncated]\n';
            }
            return redact(text.slice(0, end));
        },
        snapshot() { return { protocol: HLS_OUTPUT_ADMISSION_PROTOCOL, consumed, produced, bytes, peakBytes, maxBytes,
            aheadSegments: ahead, admissionWaits, admittedSegments, pending: queue.length, stopped }; },
    };
}

module.exports = { HLS_OUTPUT_ADMISSION_PROTOCOL, createHlsOutputAdmission, loopbackOutputEnv };
