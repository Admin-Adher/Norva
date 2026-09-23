'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { request } = require('undici');
const { createProviderProxyAgent } = require('../services/media-gateway/src/providerProxyAgent');
const { useProviderHttpForward } = require('../services/media-gateway/src/provider-http-forward-policy');
const { providerAccountAffinityKey, proxySlotIndexForAccount } = require('../services/media-gateway/src/providerProxyPool');

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

test('real forward proxy preserves byte ranges, errors and pinned account slot without forcing HTTPS forward', async t => {
    const originRequests = [];
    const proxyRequests = [];
    const connectRequests = [];
    const file = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const origin = http.createServer((req, res) => {
        originRequests.push({ path: req.url, range: req.headers.range, ifRange: req.headers['if-range'],
            userAgent: req.headers['user-agent'], proxyAuth: req.headers['proxy-authorization'] });
        const status = Number(new URL(req.url, 'http://fixture').searchParams.get('status'));
        if ([401, 403, 429, 458, 500, 503].includes(status)) {
            res.writeHead(status, { 'Retry-After': '4', 'Content-Length': '0' }).end();
            return;
        }
        const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
        const start = match ? Number(match[1]) : 0;
        const end = match ? Number(match[2]) : file.length - 1;
        if (start >= file.length || end < start) {
            res.writeHead(416, { 'Content-Range': `bytes */${file.length}`, 'Content-Length': '0' }).end();
            return;
        }
        const chunk = file.subarray(start, Math.min(end + 1, file.length));
        res.writeHead(match ? 206 : 200, { 'Accept-Ranges': 'bytes', ETag: '"fixture-exact-file"',
            'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${file.length}`,
            'Content-Length': String(chunk.length), 'Content-Type': 'video/mp4' });
        res.end(chunk);
    });
    const originUrl = await listen(origin);
    const proxies = [];
    const agents = [];
    t.after(async () => {
        await Promise.all(agents.map(agent => agent.destroy()));
        await Promise.all([...proxies, origin].map(server => new Promise(resolve => {
            server.closeAllConnections();
            server.close(resolve);
        })));
    });
    for (let slot = 0; slot < 5; slot += 1) {
        const proxy = http.createServer((req, res) => {
            proxyRequests.push({ slot, target: req.url, authorization: req.headers['proxy-authorization'] });
            const target = new URL(req.url);
            if (target.origin !== originUrl) { res.writeHead(502).end(); return; }
            const headers = { ...req.headers };
            delete headers['proxy-authorization'];
            const upstream = http.request(target, { method: req.method, headers }, response => {
                res.writeHead(response.statusCode, response.headers);
                response.pipe(res);
            });
            upstream.on('error', () => res.destroy());
            req.pipe(upstream);
        });
        proxy.on('connect', (req, socket) => {
            connectRequests.push({ slot, target: req.url, authorization: req.headers['proxy-authorization'] });
            // No TLS interception: deny this fixture tunnel after proving that
            // Undici chose CONNECT instead of a plaintext absolute-URI request.
            socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        });
        const proxyUrl = new URL(await listen(proxy));
        proxies.push(proxy);
        proxyUrl.username = `slot-${slot}`;
        proxyUrl.password = 'fixture-secret';
        agents.push(createProviderProxyAgent(proxyUrl.toString(), { proxyTunnel: false }));
    }
    const source = `${originUrl}/movie/new-account/password/file.mp4`;
    const account = providerAccountAffinityKey(source);
    const slot = proxySlotIndexForAccount(account, agents.length);
    const dispatcher = agents[slot];
    assert.equal(useProviderHttpForward(account, source, new Set(), { allCompatibleHttpMedia: true }), true);
    for (const [start, end] of [[0, 9], [40, 49], [10, 19]]) {
        const response = await request(source, { dispatcher, headers: {
            Range: `bytes=${start}-${end}`, 'If-Range': '"fixture-exact-file"', 'User-Agent': 'Norva-fixture' } });
        assert.equal(response.statusCode, 206);
        assert.equal(response.headers['content-range'], `bytes ${start}-${end}/${file.length}`);
        assert.equal(response.headers.etag, '"fixture-exact-file"');
        assert.equal(await response.body.text(), file.subarray(start, end + 1).toString());
    }
    for (const status of [401, 403, 429, 458, 500, 503]) {
        const response = await request(`${source}?status=${status}`, { dispatcher });
        assert.equal(response.statusCode, status);
        assert.equal(response.headers['retry-after'], '4');
        await response.body.dump();
    }
    const invalidRange = await request(source, { dispatcher, headers: { Range: 'bytes=999-1000' } });
    assert.equal(invalidRange.statusCode, 416);
    assert.equal(invalidRange.headers['content-range'], `bytes */${file.length}`);
    await invalidRange.body.dump();
    const changedMedia = `${originUrl}/series/new-account/rotated-password/other.ts`;
    assert.equal(providerAccountAffinityKey(changedMedia), account);
    assert.equal(proxySlotIndexForAccount(providerAccountAffinityKey(changedMedia), agents.length), slot);
    const ts = await request(changedMedia, { dispatcher, headers: { Range: 'bytes=0-3' } });
    assert.equal(ts.statusCode, 206);
    assert.equal(await ts.body.text(), '0123');
    assert.equal(proxyRequests.length, 11, 'provider refusals must not create retries or rotate slots');
    assert.ok(proxyRequests.every(entry => entry.slot === slot));
    assert.ok(proxyRequests.every(entry => entry.authorization === `Basic ${Buffer.from(`slot-${slot}:fixture-secret`).toString('base64')}`));
    assert.equal(originRequests.length, 11);
    assert.ok(originRequests.every(entry => entry.proxyAuth === undefined));
    assert.deepEqual(originRequests.slice(0, 3).map(entry => [entry.range, entry.ifRange, entry.userAgent]),
        [['bytes=0-9', '"fixture-exact-file"', 'Norva-fixture'], ['bytes=40-49', '"fixture-exact-file"', 'Norva-fixture'],
            ['bytes=10-19', '"fixture-exact-file"', 'Norva-fixture']]);
    const secureSource = source.replace('http:', 'https:');
    assert.equal(useProviderHttpForward(account, secureSource, new Set(), { allCompatibleHttpMedia: true }), false);
    await assert.rejects(request(secureSource, { dispatcher, headersTimeout: 1000, bodyTimeout: 1000 }));
    assert.equal(connectRequests.length, 1);
    assert.equal(connectRequests[0].slot, slot);
    assert.equal(proxyRequests.length, 11, 'HTTPS must never use an HTTP forward request');
});
