'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { nativeFileStartupOptions } = require('../services/media-gateway/src/native-file-startup-policy');
const harness = require('./fixtures/finite-ts-index-broker');

test('only native recovery changes cold header fetching', () => {
    assert.deepEqual(nativeFileStartupOptions('native-browser-mp4'),
        { finiteWarmupWindowBytes: 0, finiteWarmupCueGraceMs: 0 });
    assert.deepEqual(nativeFileStartupOptions('native-browser-mp4', true),
        { finiteWarmupWindowBytes: 65536, finiteWarmupCueGraceMs: 0 });
});

test('native header then tail stays byte-exact without aborting a provider window', async t => {
    const media = Buffer.alloc(1024 * 1024, 37);
    let active = 0, peak = 0;
    const fetched = [];
    const origin = http.createServer((req, res) => {
        const [, a, b] = req.headers.range.match(/^bytes=(\d+)-(\d+)$/);
        const start = Number(a), end = Number(b);
        active++; peak = Math.max(peak, active); fetched.push([start, end]);
        res.on('close', () => active--);
        res.writeHead(206, { 'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${media.length}`, ETag: '"native-fixture"' });
        res.end(media.subarray(start, end + 1));
    });
    await new Promise(r => origin.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => origin.close(r)));
    const broker = await harness().createStrictLidBroker({
        sourceUrl: `http://127.0.0.1:${origin.address().port}/movie`, fileSizeBytes: media.length,
        dispatcher: null, pathPrefix: 'finite-mkv-seek',
        finiteWindowBytes: 8 * 1024 * 1024, finiteSequentialWindowBytes: 8 * 1024 * 1024,
        ...nativeFileStartupOptions('native-vod-recovery'),
        completedReleaseDelayMs: 0, supersededReleaseDelayMs: 2500,
    });
    t.after(() => broker.close());
    const head = await fetch(broker.inputUrl, { headers: { Range: `bytes=0-${media.length - 1}` } });
    assert.equal(head.headers.get('content-length'), String(media.length));
    const reader = head.body.getReader();
    let received = 0;
    while (received < 65536) received += (await reader.read()).value.length;
    await reader.cancel();
    const at = Date.now();
    const tail = await fetch(broker.inputUrl, { headers: { Range: `bytes=${media.length - 4096}-${media.length - 1}` } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), media.subarray(-4096));
    assert.ok(Date.now() - at < 1500, 'no 2500 ms interrupted-request grace needed');
    assert.equal(broker.interruptedProviderFetches, 0);
    assert.deepEqual(fetched, [[0, 65535], [media.length - 4096, media.length - 1]]);
    assert.equal(peak, 1);
});
