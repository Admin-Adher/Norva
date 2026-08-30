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
        end: Math.min(requestedEnd, payload.length - 1, start + windowBytes - 1),
        requestedEnd,
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

    activeProviderReads += 1;
    maxActiveProviderReads = Math.max(maxActiveProviderReads, activeProviderReads);
    const request = {
        start: range.start,
        requestedEnd: range.requestedEnd,
        end: range.end,
        bytes: range.end - range.start + 1,
    };
    requests.push(request);

    // Model the Hetzner broker: the exact bounded provider range is fully
    // materialized before the local FFmpeg response sees a byte.
    const body = Buffer.from(payload.subarray(range.start, range.end + 1));
    await new Promise((resolve) => setImmediate(resolve));
    activeProviderReads -= 1;

    res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${range.start}-${range.end}/${payload.length}`,
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
    });
    res.end(body);
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
