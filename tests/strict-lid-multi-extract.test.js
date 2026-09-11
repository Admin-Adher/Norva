'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { strictLidMultiExtractArgs, runStrictLidMultiExtract, classifyStrictLidExtractFailure } = require('../services/media-gateway/src/strict-lid-multi-extract');
const { parsePcm16Wav } = require('../services/media-gateway/src/strict-lid-audio-evidence');
const base = { bin: '/fixture/ffmpeg', inputUrl: 'http://127.0.0.1:9999/strict-lid/fixture',
    outputs: [{ index: 1, path: path.join(os.tmpdir(), 'fixture-one.wav') }], startSeconds: 10, durationSeconds: 20, timeoutMs: 10000 };

test('up to four exact audio maps share ONE input, with no playlist/resource demuxer or reconnect', () => {
    const args = strictLidMultiExtractArgs({ ...base, outputs: [1, 2, 4, 8].map(index => ({ index, path: path.join(os.tmpdir(), `fixture-${index}.wav`) })) });
    assert.equal(args.filter(x => x === '-i').length, 1); assert.equal(args.filter(x => x === '-map').length, 4);
    assert.deepEqual(args.filter((_, i) => args[i - 1] === '-map'), ['0:1', '0:2', '0:4', '0:8']);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp');
    assert.doesNotMatch(args[args.indexOf('-format_whitelist') + 1], /concat|hls|dash|image2|sdp/);
    assert.equal(args.some(x => x.startsWith('-reconnect')), false);
    assert.deepEqual(args.filter((_,i)=>args[i-1]==='-af'), Array(4).fill('aresample=16000,atrim=end_sample=320000'));
    assert.equal(args.some(x=>/apad|asetpts/.test(x)),false);
});

test('direct provider URLs, unbounded windows and ambiguous track/output mappings are rejected before spawn', () => {
    for (const changed of [{ inputUrl: 'https://provider.invalid/movie' }, { inputUrl: 'file:///tmp/private' },
        { inputUrl: 'http://127.0.0.1:9999/other' }, { inputUrl: base.inputUrl + '?source=other' },
        { outputs: [] }, { outputs: [base.outputs[0], base.outputs[0]] },
        { outputs: Array.from({ length: 5 }, (_, index) => ({ index, path: path.join(os.tmpdir(), `fixture-${index}.wav`) })) },
        { durationSeconds: 61 }, { startSeconds: -1 }, { timeoutMs: 165001 }]) {
        assert.throws(() => strictLidMultiExtractArgs({ ...base, ...changed }), { code: 'LID_MULTI_EXTRACT_ARGUMENTS_INVALID' });
    }
});

function processFixture({ closeCode = 0, outputOverflow = false, manual = false } = {}) {
    let spawns = 0; const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null)); };
    return { child, spawns: () => spawns, spawnImpl: () => {
        spawns++;
        if (!manual) queueMicrotask(() => {
            if (outputOverflow) child.stderr.emit('data', Buffer.alloc(65537));
            else child.emit('close', closeCode);
        });
        return child;
    } };
}

test('closed extraction diagnostics never expose source text and do not change process cleanup', async () => {
    const diagnostics = []; const p = processFixture({ manual: true });
    const pending = runStrictLidMultiExtract({ ...base, spawnImpl: p.spawnImpl, diagnostic: d => diagnostics.push(d) });
    p.child.stderr.emit('data', Buffer.from("SECRET http://private.invalid/password Stream map '0:8' matches no "));
    p.child.stderr.emit('data', Buffer.from('streams. Secret film name'));
    p.child.emit('close', 1);
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.processClosed, true);
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].detail, 'track_map_missing');
    assert.equal(diagnostics[0].exitCode, 1);
    assert.doesNotMatch(JSON.stringify({ result, diagnostics }), /SECRET|private\.invalid|password|Secret film/);
    assert.equal(classifyStrictLidExtractFailure('https://x.invalid/404?secret=403'), 'unclassified');
    assert.equal(classifyStrictLidExtractFailure('Server returned 502 Bad Gateway'), 'loopback_http_error');
    const q = processFixture({ closeCode: 1 });
    assert.equal((await runStrictLidMultiExtract({ ...base, spawnImpl: q.spawnImpl,
        diagnostic: () => { throw Error('logger unavailable'); } })).processClosed, true);
});

test('a cancelled or viewer-preempted extraction starts no child', async () => {
    const p = processFixture(); const signal = AbortSignal.abort();
    assert.equal((await runStrictLidMultiExtract({ ...base, signal, spawnImpl: p.spawnImpl })).ok, false);
    assert.equal((await runStrictLidMultiExtract({ ...base, isPreempted: () => true, spawnImpl: p.spawnImpl })).preempted, true);
    assert.equal(p.spawns(), 0);
});

test('one child serves the complete output list and no failed/oversized process output is accepted', async () => {
    const p = processFixture(); const result = await runStrictLidMultiExtract({ ...base, spawnImpl: p.spawnImpl });
    assert.equal(p.spawns(), 1); assert.equal(result.ok, true); assert.equal(result.processClosed, true);
    for (const settings of [{ closeCode: 1 }, { outputOverflow: true }]) {
        const bad = processFixture(settings); const result = await runStrictLidMultiExtract({ ...base, spawnImpl: bad.spawnImpl });
        assert.equal(result.ok, false); assert.equal(result.processClosed, true);
    }
});

test('abort after spawn waits for child close and never starts a fallback connection', async () => {
    const p = processFixture({ manual: true }); const controller = new AbortController();
    const pending = runStrictLidMultiExtract({ ...base, signal: controller.signal, spawnImpl: p.spawnImpl });
    controller.abort(); const result = await pending;
    assert.equal(result.code, 'LID_CAPTURE_CANCELLED'); assert.equal(result.processClosed, true);
    assert.deepEqual(p.child.kills, ['SIGKILL']); assert.equal(p.spawns(), 1);
});

test('native FFmpeg demuxes two real tracks in one input with fewer source bytes and refuses a nested playlist',
    { skip: process.env.NORVA_CAPTURE_REAL_FFMPEG !== '1' }, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'norva-multi-input-proof-')));
    const source = path.join(root, 'two-tracks.mkv');
    const server = http.createServer(); let servedBytes = 0; let requests = 0; let forbidden = 0;
    t.after(async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('norva-multi-input-proof-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=22',
            '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000:duration=22',
            '-map', '0:a', '-map', '1:a', '-c:a', 'pcm_s16le', source], { stdio: 'ignore' });
        child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('synthetic media generation failed')));
    });
    const bytes = await fs.readFile(source);
    server.on('request', (req, res) => {
        requests++;
        if (req.url === '/forbidden.aac') { forbidden++; res.writeHead(500); res.end(); return; }
        if (req.url === '/strict-lid/playlist') {
            const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:20\n#EXTINF:20,\nhttp://127.0.0.1:${server.address().port}/forbidden.aac\n#EXT-X-ENDLIST\n`;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(playlist); return;
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || 'bytes=0-');
        const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start >= bytes.length) { res.writeHead(416); res.end(); return; }
        const body = bytes.subarray(start, end + 1); servedBytes += body.length;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': body.length,
            'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes', Connection: 'close' }); res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const inputUrl = `http://127.0.0.1:${server.address().port}/strict-lid/synthetic`;
    const outputs = [0, 1].map(index => ({ index, path: path.join(root, `track-${index}.wav`) }));
    const run = outputList => runStrictLidMultiExtract({ ...base, bin: 'ffmpeg', inputUrl, outputs: outputList, startSeconds: 0 });
    assert.equal((await run(outputs)).ok, true);
    const together = { bytes: servedBytes, requests };
    const digests = [];
    for (const o of outputs) {
        const wav = await fs.readFile(o.path); assert.equal(parsePcm16Wav(wav).durationSeconds, 20);
        digests.push(crypto.createHash('sha256').update(wav).digest('hex'));
    }
    assert.notEqual(digests[0], digests[1]);
    servedBytes = 0; requests = 0;
    for (const o of outputs) assert.equal((await run([o])).ok, true);
    assert.ok(together.bytes < servedBytes, 'one input should avoid re-reading the same multiplexed test file');
    t.diagnostic(JSON.stringify({ syntheticDualTrackBytes: together.bytes, separateTrackBytes: servedBytes,
        dualTrackRequests: together.requests, separateTrackRequests: requests, providerRequests: 0 }));
    const rejected = await runStrictLidMultiExtract({ ...base, bin: 'ffmpeg', outputs,
        inputUrl: `http://127.0.0.1:${server.address().port}/strict-lid/playlist`, startSeconds: 0 });
    assert.equal(rejected.ok, false); assert.equal(forbidden, 0);
    const counts=[];
    for(const bounded of [false,true]){
        const result=await runStrictLidMultiExtract({...base,bin:'ffmpeg',inputUrl,outputs:[outputs[0]],startSeconds:0,
            spawnImpl:(bin,args,options)=>spawn(bin,args.map(arg=>arg==='aresample=16000,atrim=end_sample=320000'
                ? 'aresample=16000,asetpts=PTS-0.125/TB'+(bounded?',atrim=end_sample=320000':'') : arg),options)});
        assert.equal(result.ok,true);
        counts.push(parsePcm16Wav(await fs.readFile(outputs[0].path)).sampleCount);
    }
    assert.equal(counts[1],320000);assert.ok(counts[0]>=counts[1]);
    t.diagnostic(JSON.stringify({syntheticNegativeTimestampSamples:counts[0],boundedSamples:counts[1],providerRequests:0}));
});
