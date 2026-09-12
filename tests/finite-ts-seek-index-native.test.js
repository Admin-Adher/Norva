'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), { spawn } = require('node:child_process');
const { FiniteTsSeekIndex, indexedTsInputUrl, probeTsOrigin } = require('../services/media-gateway/src/finite-ts-seek-index');
const { crc32 } = require('../services/media-gateway/src/finite-ts-landmarks');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
const brokerHarness = require('./fixtures/finite-ts-index-broker');
const { videoEncoderInputArgs, videoEncoderOutputArgs, resolveVideoEncoderConfig } = require('../services/media-gateway/src/video-encoder');
test('native initial playback prepares the first exact indexed resume, with restart and mono-slot proof',
    { skip: process.env.NORVA_TS_INDEX_NATIVE !== '1', timeout: 180000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-ts-index-native-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = process.env.FFMPEG_PATH || 'ffmpeg';
    const run = args => new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', b => { out += b; if (out.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
        child.stderr.on('data', b => { err = (err + b).slice(-2000); });
        const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Error(`native ${code}: ${err}`)); });
    });
    const input = path.join(root, 'vod.ts');
    await run(['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25',
        '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','120','-c:v','libx264','-threads','1','-preset','ultrafast',
        '-g','300','-keyint_min','300','-sc_threshold','0','-bf','2','-c:a','aac','-ac','2','-f','mpegts',input]);
    // Provider TS commonly carries a third, non-rendered timed-ID3 stream.
    // Add its exact PMT registration (without altering any A/V packets) and
    // prove FFmpeg still reports the same origin before the complete A/B test.
    const plain = fs.readFileSync(input), originalOrigin = await probeTsOrigin(plain.subarray(0, 262144));
    assert.ok(originalOrigin);
    for (let at = 0; at + 188 <= plain.length; at += 188) {
        const packet = plain.subarray(at, at + 188);
        if ((((packet[1] & 31) << 8) | packet[2]) !== 4096 || !(packet[1] & 64)) continue;
        const start = 5 + packet[4], oldSize = 3 + ((packet[start + 1] & 15) << 8) + packet[start + 2];
        const old = Buffer.from(packet.subarray(start, start + oldSize - 4));
        const section = Buffer.concat([old, Buffer.from([0x15,0xe1,2,0xf0,6,5,4,0x49,0x44,0x33,0x20]), Buffer.alloc(4)]);
        section[1] = 0xb0 | ((section.length - 3) >> 8); section[2] = (section.length - 3) & 255;
        section.writeUInt32BE(crc32(section.subarray(0, -4)), section.length - 4);
        assert.ok(start + section.length <= 188); packet.fill(255, start); section.copy(packet, start);
    }
    fs.writeFileSync(input, plain);
    assert.deepEqual(await probeTsOrigin(plain.subarray(0, 262144)), originalOrigin, 'timed ID3 does not change A/V origin or stream order');
    const shifts = new Map(), resets = new Map();
    for (let at = 0; at + 188 <= plain.length; at += 188) {
        const b = plain.subarray(at, at + 188), pid = ((b[1] & 31) << 8) | b[2];
        if (![256, 257].includes(pid)) continue;
        const start = (b[3] & 32) ? 5 + b[4] : 4, q = b.subarray(start);
        if ((b[1] & 64) && q.length >= 19 && q.readUIntBE(0, 3) === 1) {
            const dt = q[7] >> 6 === 3 ? 14 : 9;
            const dts = ((q[dt] >> 1) & 7) * 2 ** 30 + q[dt + 1] * 2 ** 22 + (q[dt + 2] >> 1) * 2 ** 15 + q[dt + 3] * 128 + (q[dt + 4] >> 1);
            const count = resets.get(pid) || 0;
            if (count < 2 && dts / 90000 >= originalOrigin.startSeconds + [12, 36][count]) {
                shifts.set(pid, b[3] & 15); resets.set(pid, count + 1);
            }
        }
        b[3] = (b[3] & 240) | (((b[3] & 15) - (shifts.get(pid) || 0)) & 15);
    }
    assert.deepEqual([...resets.values()], [2, 2], 'both audio and video counter resets exercised');
    fs.writeFileSync(input, plain);
    const size = fs.statSync(input).size;
    let active = 0, peak = 0, count = 0, etag = '"native-v1"';
    const server = http.createServer((req, res) => {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = Math.min(size - 1, range?.[2] ? Number(range[2]) : size - 1);
        if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
        count++; active++; peak = Math.max(peak, active);
        let stream, settled = false;
        const finish = () => { if (!settled) { settled = true; active--; } clearTimeout(timer); stream?.destroy(); };
        const timer = setTimeout(() => {
            res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', ETag: etag });
            stream = fs.createReadStream(input, { start, end }); stream.pipe(res);
        }, 80);
        res.once('close', finish); res.once('finish', finish);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
    const sourceUrl = `http://127.0.0.1:${server.address().port}/vod`;
    const scope = { ownerKey: 'a'.repeat(64), sourceUrl, fileSizeBytes: size };
    const indexRoot = path.join(root, 'index');
    const store = new FiniteTsSeekIndex({ root: indexRoot });
    const ranges = new FinitePlaybackRangeReuse();
    const create = async (observer, useRanges = true) => brokerHarness().createStrictLidBroker({ ...scope,
        dispatcher: null, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: 1024 * 1024,
        finiteWarmupWindowBytes: 262144, finiteSequentialWindowBytes: 8 * 1024 * 1024,
        finiteSeekLookbehindBytes: 256 * 1024, finiteSeekContinuationGraceMs: 50,
        finiteAbandonedDrainMs: 1500, finiteCacheBytes: 64 * 1024 * 1024, finiteResumePrefixTargetBytes: 0,
        finiteResumeRanges: useRanges ? ranges.begin(scope) : null, onFiniteWindow: window => observer?.observe(window),
        completedReleaseDelayMs: 0, supersededReleaseDelayMs: 100 });
    const observer = await store.begin(scope), first = await create(observer);
    t.after(() => first.close());
    await run(['-v','error','-seekable','1','-skip_estimate_duration_from_pts','1','-analyzeduration','500000','-probesize','524288',
        '-i',first.inputUrl,'-t','45','-map','0:v:0','-map','0:a:0','-c','copy','-f','null','-']);
    // Complete only already-open bounded windows, just as normal viewer stop.
    await new Promise(r => setTimeout(r, 200));
    await first.close(); await observer.close(); assert.equal(active, 0);
    assert.ok(observer.hasCandidate(87), `initial seek candidate ${JSON.stringify(store.status())}`);
    const results = [];
    for (const encoder of ['software', ...(process.env.NORVA_TS_INDEX_VAAPI === '1' ? ['vaapi'] : [])]) for (const seekOffset of [41, 87]) for (const indexed of [false, true]) {
        const config = resolveVideoEncoderConfig({ MEDIA_GATEWAY_VIDEO_ENCODER: encoder });
        const reloaded = new FiniteTsSeekIndex({ root: indexRoot });
        // A/B never borrows the other arm's media windows or landmarks. Both
        // start with empty RAM caches; only initial playback's metadata exists.
        const next = await reloaded.begin(scope), broker = await create(indexed ? next : null, false);
        t.after(() => broker.close()); count = 0; peak = 0;
        const at = Date.now(); let point, url = broker.inputUrl;
        if (indexed) {
            assert.equal(next.candidate(seekOffset), null);
            const fresh = await fetch(url, { headers: { Range: 'bytes=0-262143' } });
            await fresh.arrayBuffer(); point = next.candidate(seekOffset); assert.ok(point);
            if (seekOffset === 41) assert.ok(point.absoluteSeconds - point.pts / 90000 < 6,
                'the intact IDR coinciding with the 36s audio counter reset remains usable');
            url = indexedTsInputUrl(url, point, size); assert.ok(url);
        }
        const output = path.join(root, `${indexed}.ts`);
        await run(['-v','error','-y', ...videoEncoderInputArgs(config, true), '-seekable','1','-skip_estimate_duration_from_pts','1','-analyzeduration','500000','-probesize','524288',
            ...(indexed ? ['-copyts','-protocol_whitelist','subfile,http,tcp'] : ['-ss',String(seekOffset - 15)]),
            '-i',url,'-ss', indexed ? String(point.absoluteSeconds) : '15','-t','2','-map','0:v:0','-map','0:a:0',
            ...videoEncoderOutputArgs(config, { forceAligned: true, targetSeconds: 2 }), '-threads','1','-c:a','aac','-f','mpegts',output]);
        const elapsedMs = Date.now() - at;
        await broker.close(); await next.close();
        const decoded = await run(['-v','error','-i',output,'-t','0.48','-map','0:v:0','-map','0:a:0','-threads','1','-f','framehash','-']);
        const video = decoded.split('\n').filter(l => /^0,/.test(l)).map(l => l.split(',').at(-1));
        const audio = decoded.split('\n').filter(l => /^1,/.test(l)).map(l => l.split(',').at(-1));
        results.push({ encoder, seekOffset, indexed, elapsedMs, requests: count, peak, video, audio, reusedBytes: broker.resumeRangeReusedBytes,
            preroll: point ? point.absoluteSeconds - point.pts / 90000 : 15 });
        assert.equal(active, 0); assert.equal(peak, 1);
    }
    for (let i = 0; i < results.length; i += 2) {
        assert.ok(results[i].video.length >= 10 && results[i].audio.length >= 10);
        assert.deepEqual(results[i + 1].video, results[i].video, 'same first decoded video frames');
        assert.deepEqual(results[i + 1].audio, results[i].audio, 'same precisely aligned decoded audio');
        assert.ok(results[i + 1].requests < results[i].requests, 'first indexed seek reduces provider round trips');
    }
    etag = '"native-v2"';
    const changed = await store.begin(scope), changedBroker = await create(changed);
    t.after(() => changedBroker.close());
    const response = await fetch(changedBroker.inputUrl, { headers: { Range: 'bytes=0-262143' } }); await response.arrayBuffer();
    assert.equal(changed.candidate(87), null); await changedBroker.close(); await changed.close();
    const multiple = path.join(root, 'multiple.ts');
    await run(['-v','error','-y','-i',input,'-map','0:v:0','-map','0:a:0','-map','0:a:0','-c','copy','-f','mpegts',multiple]);
    const multiBytes = fs.readFileSync(multiple);
    const multiObserver = await store.begin({ ...scope, sourceUrl: sourceUrl + '/multi', fileSizeBytes: multiBytes.length });
    multiObserver.observe({ start: 0, bytes: multiBytes, proof: { fileSizeBytes: multiBytes.length,
        validator: { kind: 'etag', value: '"multi-v1"' }, effectiveUrlIdentitySha256: 'd'.repeat(64) } });
    await multiObserver.close(); assert.equal(multiObserver.hasCandidate(87), false, 'unsupported multiple-track graph keeps ordinary seeking');
    console.log('native initial index metrics', JSON.stringify(results.map(({video,audio,...r}) => ({ ...r, frames:video.length,audioFrames:audio.length }))));
});
