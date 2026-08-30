#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const inputPath = process.argv[2];
const ffmpegPath = process.argv[3];
const seekSeconds = Number(process.argv[4] || 921);
const windowBytes = Number(process.argv[5] || 1024 * 1024);

if (!inputPath || !ffmpegPath) {
    console.error('usage: node finite-mkv-seek-window-smoke.js <input.mkv> <ffmpeg.exe> [seekSeconds] [windowBytes]');
    process.exit(2);
}
if (!Number.isFinite(seekSeconds) || seekSeconds < 0 || !Number.isSafeInteger(windowBytes) || windowBytes <= 0) {
    console.error('seekSeconds must be non-negative and windowBytes must be a positive safe integer');
    process.exit(2);
}

const payload = fs.readFileSync(inputPath);
const requests = [];
let activeProviderReads = 0;
let maxActiveProviderReads = 0;
let brokerQueue = Promise.resolve();
let activeLocalRequest = null;
let latestLocalRequestId = 0;

function waitForLocalDrain(res) {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            res.off('drain', done);
            res.off('close', done);
            res.off('error', done);
            resolve();
        };
        res.once('drain', done);
        res.once('close', done);
        res.once('error', done);
    });
}

function parseRange(value) {
    const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value || '').trim());
    if (!match) return null;
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : payload.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= payload.length || requestedEnd < start) {
        return null;
    }
    return {
        start,
        end: Math.min(requestedEnd, payload.length - 1),
    };
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') {
        res.writeHead(200, {
            'Accept-Ranges': 'bytes',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(payload.length),
        });
        return res.end();
    }
    const range = parseRange(req.headers.range);
    if (req.method !== 'GET' || !range) {
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
        return res.end();
    }

    res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${range.start}-${range.end}/${payload.length}`,
        'Content-Length': String(range.end - range.start + 1),
        'Cache-Control': 'no-store',
    });

    // Model protocol 3: FFmpeg receives one continuous local range while every
    // local request and exact provider window share one serialized queue. A
    // newer FFmpeg cue supersedes the old loopback response only after the
    // current provider window has been fully materialized.
    if (activeLocalRequest) {
        activeLocalRequest.superseded = true;
        if (!activeLocalRequest.providerActive && !activeLocalRequest.res.destroyed) {
            activeLocalRequest.res.destroy();
        }
    }
    const localRequest = {
        id: ++latestLocalRequestId,
        providerActive: false,
        res,
        superseded: false,
    };
    const work = brokerQueue.catch(() => {}).then(async () => {
        if (localRequest.id !== latestLocalRequestId) {
            if (!res.destroyed) res.destroy();
            return;
        }
        activeLocalRequest = localRequest;
        for (let start = range.start; start <= range.end; start += windowBytes) {
            if (localRequest.superseded || res.destroyed) break;
            const end = Math.min(range.end, start + windowBytes - 1);
            localRequest.providerActive = true;
            activeProviderReads += 1;
            maxActiveProviderReads = Math.max(maxActiveProviderReads, activeProviderReads);
            const body = Buffer.from(payload.subarray(start, end + 1));
            requests.push({ start, end, bytes: body.length });
            await new Promise((resolve) => setImmediate(resolve));
            activeProviderReads -= 1;
            localRequest.providerActive = false;
            if (localRequest.superseded || res.destroyed) {
                if (!res.destroyed) res.destroy();
                break;
            }
            if (!res.write(body)) await waitForLocalDrain(res);
        }
        if (!res.destroyed) res.end();
        if (activeLocalRequest === localRequest) activeLocalRequest = null;
    });
    brokerQueue = work.catch(() => {});
    await work;
});

server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/media.mkv`;
    const startedAt = Date.now();
    const child = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'warning',
        '-ss', String(seekSeconds),
        '-seekable', '1',
        '-i', url,
        '-t', '4',
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-f', 'null',
        os.devNull,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code, signal) => {
        const result = {
            code,
            signal,
            elapsedMs: Date.now() - startedAt,
            seekSeconds,
            windowBytes,
            fileBytes: payload.length,
            requestCount: requests.length,
            maxActiveProviderReads,
            requests,
            stderr: stderr.trim(),
        };
        console.log(JSON.stringify(result, null, 2));
        server.close(() => process.exit(code === 0 ? 0 : 1));
    });
});
