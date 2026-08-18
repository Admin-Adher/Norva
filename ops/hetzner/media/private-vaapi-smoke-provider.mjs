import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';

const FIXTURE_PATH = process.env.NORVA_CANARY_FIXTURE_PATH || '/canary/fixture-hevc-eac3.mkv';
const FIXTURE_ROUTE = process.env.NORVA_CANARY_FIXTURE_ROUTE || '/fixture-hevc-eac3.mkv';
const PORT = Number.parseInt(process.env.NORVA_CANARY_PROVIDER_PORT || '8090', 10);
const HOST = process.env.NORVA_CANARY_PROVIDER_HOST || '0.0.0.0';

function fail(message) {
    throw new Error(`NORVA_CANARY_PROVIDER_${message}`);
}

function parseSingleRange(value, size) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(value || '').trim());
    if (!match) return null;
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return null;
    if (start < 0 || start >= size || requestedEnd < start) return null;
    return { start, end: Math.min(requestedEnd, size - 1) };
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

export async function createCanaryProvider({
    fixturePath = FIXTURE_PATH,
    fixtureRoute = FIXTURE_ROUTE,
    host = HOST,
    port = PORT,
} = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) fail('PORT_INVALID');
    if (!/^\/fixture-[a-z0-9-]+\.mkv$/.test(fixtureRoute)) fail('ROUTE_INVALID');
    const stat = await fsp.stat(fixturePath);
    if (!stat.isFile() || stat.size <= 0) fail('FIXTURE_INVALID');
    const digest = await sha256File(fixturePath);
    const etag = `"norva-canary-${digest}"`;
    const stats = {
        getRequests: 0,
        headRequests: 0,
        rangeRequests: 0,
        fullRequests: 0,
        invalidRanges: 0,
        active: 0,
        maximumConcurrent: 0,
        bytesServed: 0,
        fileSizeBytes: stat.size,
    };

    const server = http.createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://norva-canary.invalid');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');

        if (url.pathname === '/health') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: true, protocol: 1 }));
            return;
        }
        if (url.pathname === '/stats') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ...stats }));
            return;
        }
        if (url.pathname !== fixtureRoute || !['GET', 'HEAD'].includes(request.method || '')) {
            response.writeHead(404).end();
            return;
        }

        if (request.method === 'HEAD') stats.headRequests += 1;
        else stats.getRequests += 1;

        let selectedRange = null;
        const rangeHeader = request.headers.range;
        const ifRange = String(request.headers['if-range'] || '');
        const rangeMayApply = rangeHeader && (!ifRange || ifRange === etag);
        if (rangeMayApply) {
            selectedRange = parseSingleRange(rangeHeader, stat.size);
            if (!selectedRange) {
                stats.invalidRanges += 1;
                response.writeHead(416, {
                    'Accept-Ranges': 'bytes',
                    'Content-Range': `bytes */${stat.size}`,
                    ETag: etag,
                }).end();
                return;
            }
        }

        const start = selectedRange?.start ?? 0;
        const end = selectedRange?.end ?? (stat.size - 1);
        const length = end - start + 1;
        if (selectedRange) stats.rangeRequests += 1;
        else stats.fullRequests += 1;
        const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(length),
            'Content-Type': 'video/x-matroska',
            ETag: etag,
        };
        if (selectedRange) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        response.writeHead(selectedRange ? 206 : 200, headers);
        if (request.method === 'HEAD') {
            response.end();
            return;
        }

        stats.active += 1;
        stats.maximumConcurrent = Math.max(stats.maximumConcurrent, stats.active);
        let finalized = false;
        const finalize = () => {
            if (finalized) return;
            finalized = true;
            stats.active = Math.max(0, stats.active - 1);
        };
        const stream = fs.createReadStream(fixturePath, { start, end });
        stream.on('data', (chunk) => { stats.bytesServed += chunk.length; });
        stream.once('error', () => {
            finalize();
            if (!response.headersSent) response.writeHead(500);
            response.destroy();
        });
        stream.once('close', finalize);
        response.once('close', finalize);
        stream.pipe(response);
    });
    server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    return {
        server,
        stats,
        address: server.address(),
        async close() {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const provider = await createCanaryProvider();
    const shutdown = async () => {
        await provider.close().catch(() => {});
        process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    console.log(`NORVA_CANARY_PROVIDER_READY port=${provider.address.port} bytes=${provider.stats.fileSizeBytes}`);
}
