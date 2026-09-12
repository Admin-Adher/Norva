'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { finiteTsProfileEligible, finiteTsDemuxArgs, finiteTsHttpArgs, FINITE_TS_PROBE_BYTES,
    FINITE_TS_ANALYZE_US, verifyFiniteTsStartupSegments } = require('../services/media-gateway/src/finite-ts-startup');
const gateway = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
const exact = () => ({
    codecProfileSource: 'request',
    playbackIdentity: { itemType: 'movie' },
    playbackHint: { container: 'ts' },
    audioStreamIndex: 1,
    codecProfile: { container: 'ts', probeSource: 'gateway_probe', metadataComplete: false,
        probedAt: new Date().toISOString(), durationSeconds: 3739.709, fileSizeBytes: 977554692,
        videoCodec: 'h264', audioTracks: [{ index: 1, codec: 'aac', profile: 'LC', channels: 2 }] },
});

function probeHarness(enabled = true) {
    const from = gateway.indexOf('function inputProbeArgsForSession(');
    const to = gateway.indexOf('\nfunction isInsufficientInputProbeFailure(', from);
    return vm.runInNewContext(`(() => { ${gateway.slice(from, to)}; return { inputProbeArgsForSession, knownVodInputProbeEligible }; })()`, {
        finiteTsProfileEligible, finiteTsDemuxArgs, FINITE_TS_FAST_START_ENABLED: enabled,
        FINITE_TS_PROBE_BYTES, FINITE_TS_ANALYZE_US, MIN_HLS_STARTUP_SEGMENTS: 3, MIN_HLS_STARTUP_BUFFER_SECONDS: 10,
        KNOWN_VOD_INPUT_PROBE_FAST_PATH_ENABLED: true,
        asRecord: (v) => v && typeof v === 'object' ? v : {},
        normalizeCodecToken: (v) => String(v || '').toLowerCase().replace(/[^a-z0-9.,]+/g, ''),
        stringOrNull: (v) => String(v || '').trim() || null,
        nullableInt: (v) => v === null || v === undefined ? null : Number(v),
        selectedAudioTrackForSession: (s) => s.codecProfile.audioTracks[0],
        isLiveSession: (s) => s.playbackIdentity?.itemType === 'live', sessionStartupStats: {},
        LIVE_INPUT_ANALYZE_DURATION_US: 1_500_000, LIVE_INPUT_PROBE_SIZE_BYTES: 1_500_000,
        KNOWN_VOD_INPUT_ANALYZE_DURATION_US: 2_000_000, KNOWN_VOD_INPUT_PROBE_SIZE_BYTES: 2_000_000,
        VOD_INPUT_ANALYZE_DURATION_US: 8_000_000, VOD_INPUT_PROBE_SIZE_BYTES: 8_000_000,
    });
}

test('finite TS accepts a dated exact server probe without inventing in-band completeness', () => {
    const session = exact();
    const before = JSON.stringify(session);
    assert.equal(finiteTsProfileEligible(session), true);
    assert.equal(JSON.stringify(session), before);
    session.codecProfileSource = 'request+gateway_probe';
    session.codecProfile.container = 'mpegts';
    assert.equal(finiteTsProfileEligible(session), true);
});

test('finite TS rejects live TV, provider hints, incomplete or conflicting maps and containers', () => {
    const changes = [
        s => { s.playbackIdentity.itemType = 'live'; },
        s => { s.playbackIdentity = {}; },
        s => { s.codecProfileSource = 'request_flat'; },
        s => { s.codecProfile.probeSource = 'gateway_inband'; },
        s => { delete s.codecProfile.probedAt; },
        s => { s.codecProfile.probedAt = '2099-01-01'; },
        s => { s.codecProfile.durationSeconds = 0; },
        s => { s.codecProfile.fileSizeBytes = null; },
        s => { s.codecProfile.videoCodec = 'unknown'; },
        s => { s.codecProfile.audioTracks = []; },
        s => { s.codecProfile.audioTracks = [null]; },
        s => { s.codecProfile.audioTracks.push({ index: 1, codec: 'aac' }); },
        s => { s.codecProfile.audioTracks[0].codec = 'unknown'; },
        s => { s.codecProfile.audioTracks[0].index = '1x'; },
        s => { s.audioStreamIndex = 5; },
        s => { s.playbackHint.container = 'mkv'; },
        s => { s.codecProfile.container = 'mkv'; },
    ];
    for (const change of changes) {
        const session = exact(); change(session);
        assert.equal(finiteTsProfileEligible(session), false, change.toString());
    }
});

test('TS reduced probing suppresses only redundant tail duration discovery and resets on full fallback', () => {
    const h = probeHarness(); const session = exact();
    assert.deepEqual(Array.from(h.inputProbeArgsForSession(session)), [
        '-analyzeduration', '500000', '-probesize', '524288', '-skip_estimate_duration_from_pts', '1',
    ]);
    assert.equal(session.finiteTsFastInput, true);
    assert.equal(session.minHlsStartupSegments, 2);
    assert.equal(session.minHlsStartupBufferSeconds, 12);
    session.forceFullInputProbe = true;
    assert.deepEqual(Array.from(h.inputProbeArgsForSession(session)), ['-analyzeduration', '8000000', '-probesize', '8000000']);
    assert.equal(session.finiteTsFastInput, false);
    assert.equal(session.minHlsStartupSegments, 3);
    assert.equal(session.minHlsStartupBufferSeconds, 10);
    assert.equal(session.startupTimings.finiteTsFastInput, false);
    assert.equal(probeHarness(false).knownVodInputProbeEligible(exact()), false);
});

test('live probe, existing MKV budgets, audio choice and full retry maps remain intact', () => {
    const live = exact(); live.playbackIdentity.itemType = 'live';
    assert.deepEqual(Array.from(probeHarness().inputProbeArgsForSession(live)), ['-analyzeduration', '1500000', '-probesize', '1500000']);
    const mkv = exact(); mkv.playbackHint.container = mkv.codecProfile.container = 'mkv';
    assert.deepEqual(Array.from(probeHarness().inputProbeArgsForSession(mkv)), ['-analyzeduration', '2000000', '-probesize', '2000000']);
    assert.deepEqual(finiteTsHttpArgs(), ['-multiple_requests', '1', '-short_seek_size', '262144']);
    assert.match(gateway, /session\.fastInputProbe === true \|\|\s*session\.forceFullInputProbe === true/);
    assert.match(gateway, /const copyAudio = multiAudioPlan \? false : shouldCopyAudio\(session\)/);
    assert.match(gateway, /session\.finiteTsFastInput === true \? finiteTsHttpArgs\(\) : \[\]/);
});

async function run(binary, args, timeout = 45_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', b => { stdout += b; });
        child.stderr.on('data', b => { stderr += b; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`fixture process ${code}: ${stderr.slice(-2000)}`)); });
    });
}

test('native FFmpeg: finite TS starts and seeks with identical media, fewer tail requests and no extra HTTP overlap',
    { skip: process.env.NORVA_TS_REAL_FFMPEG !== '1', timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-finite-ts-'));
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    let server;
    try {
        const fixture = path.join(dir, 'fixture.ts');
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '100', '-c:v', 'libx264', '-threads', '1',
            '-preset', 'ultrafast', '-g', '50', '-bf', '0', '-c:a', 'aac', '-ac', '2', '-f', 'mpegts', fixture]);
        const size = fs.statSync(fixture).size;
        assert.ok(size < 64 * 1024 * 1024);
        let requests = []; let active = 0; let peak = 0;
        server = http.createServer((req, res) => {
            const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
            const start = range ? Number(range[1]) : 0;
            const end = Math.min(size - 1, range?.[2] ? Number(range[2]) : size - 1);
            requests.push(start); active++; peak = Math.max(peak, active);
            let stream; let timer; let settled = false;
            const settle = () => { if (!settled) { settled = true; active--; } clearTimeout(timer); stream?.destroy(); };
            res.once('finish', settle);
            res.once('close', settle);
            timer = setTimeout(() => {
                res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes',
                    'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
                stream = fs.createReadStream(fixture, { start, end }); stream.pipe(res);
            }, 50);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${server.address().port}/fixture.ts`;
        const results = [];
        for (const seek of [0, 37]) {
            const hashes = [];
            for (const fast of [false, true]) {
                requests = []; peak = 0;
                const output = path.join(dir, `${seek}-${fast}.ts`);
                const start = Date.now();
                await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
                    ...(fast ? finiteTsHttpArgs() : []), '-analyzeduration', fast ? String(FINITE_TS_ANALYZE_US) : '8000000',
                    '-probesize', fast ? String(FINITE_TS_PROBE_BYTES) : '8000000', ...(fast ? finiteTsDemuxArgs() : []),
                    ...(seek ? ['-ss', String(seek)] : []), '-i', url, '-t', '8',
                    '-map', '0:V:0', '-map', '0:1', '-c:v', 'copy', '-c:a', 'aac', '-threads', '1', '-f', 'mpegts', output]);
                const metrics = { seek, fast, elapsedMs: Date.now() - start, requests: requests.length,
                    tailRequests: requests.filter(n => n > size - 1_000_000).length, peak };
                results.push(metrics);
                console.log('finite TS synthetic case', JSON.stringify(metrics));
                // FFmpeg can reopen its one input before the server observes
                // the old socket closing. Compare that overlap to baseline;
                // keep-alive alone is not a provider-side serialization proof.
                if (fast) assert.ok(peak <= results.at(-2).peak, JSON.stringify(metrics));
                const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output]));
                assert.equal(probe.streams.filter(s => s.codec_type === 'video').length, 1);
                assert.equal(probe.streams.filter(s => s.codec_type === 'audio').length, 1);
                const digest = await run(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:v:0', '-frames:v', '12', '-f', 'framemd5', '-']);
                const audio = await run(ffmpeg, ['-v', 'error', '-i', output, '-map', '0:a:0', '-t', '1', '-f', 'md5', '-']);
                hashes.push({ video: digest.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim()), audio });
            }
            assert.deepEqual(hashes[1], hashes[0], `same decoded video after seek ${seek}`);
        }
        assert.ok(results[0].tailRequests > results[1].tailRequests, JSON.stringify(results));
        assert.equal(results[1].tailRequests, 0);
        console.log('finite TS synthetic measurements', JSON.stringify(results));
        // Actual local decoding is the admission evidence, never the producer's
        // independent_segments flag alone. No network is available to this path.
        await run(ffmpeg, ['-v', 'error', '-y', '-i', fixture, '-t', '16', '-map', '0:v:0', '-map', '0:a:0',
            '-c', 'copy', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_list_size', '0',
            '-hls_segment_filename', path.join(dir, 'segment-%05d.ts'), path.join(dir, 'ts.m3u8')]);
        const startupFiles = ['segment-00000.ts', 'segment-00001.ts', 'segment-00002.ts'];
        const proof = await verifyFiniteTsStartupSegments({ root: dir, files: startupFiles, durations: [4, 4, 4], bin: ffmpeg });
        assert.equal(proof.verified, true, JSON.stringify(proof));
        // The real slow witness has 12-second GOPs: two complete, independently
        // decoded segments must suffice; a third is not a prerequisite.
        const longDir = path.join(dir, 'long-gop'); fs.mkdirSync(longDir);
        const longSource = path.join(longDir,'source.ts');
        await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '40',
            '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '300', '-keyint_min', '300',
            '-sc_threshold', '0', '-bf', '0', '-c:a', 'aac', '-ac', '2', '-f', 'mpegts',longSource]);
        await run(ffmpeg,['-v','error','-y','-i',longSource,'-map','0:v:0','-map','0:a:0','-c','copy','-f','hls','-hls_time','4',
            '-hls_playlist_type', 'event', '-hls_list_size', '0',
            '-hls_segment_filename', path.join(longDir, 'segment-%05d.ts'), path.join(longDir, 'long.m3u8')]);
        const longDurations = [...fs.readFileSync(path.join(longDir,'long.m3u8'),'utf8')
            .matchAll(/#EXTINF:([\d.]+)/g)].slice(0,2).map(m=>Number(m[1]));
        assert.deepEqual(longDurations, [12,12]);
        assert.equal((await verifyFiniteTsStartupSegments({ root: longDir,
            files: ['segment-00000.ts','segment-00001.ts'], durations: longDurations, bin: ffmpeg })).verified, true);
        const gaps=[];
        for(const aligned of [false,true]) {
            const out=path.join(longDir,aligned?'aligned.ts':'copy-gap.ts');
            await run(ffmpeg,['-v','error','-y','-ss',aligned?'2':'17','-i',longSource,...(aligned?['-ss','15']:[]),'-t','15',
                '-map','0:v:0','-map','0:a:0',...(aligned?['-c:v','libx264','-threads','1','-preset','ultrafast','-g','50','-c:a','aac']:['-c','copy']),'-f','mpegts',out]);
            const p=JSON.parse(await run(ffprobe,['-v','error','-show_entries','stream=codec_type,start_time','-of','json',out]));
            const video=Number(p.streams.find(s=>s.codec_type==='video').start_time),audio=Number(p.streams.find(s=>s.codec_type==='audio').start_time);
            gaps.push(video-audio);
        }
        console.log('finite TS seek synchronization',JSON.stringify({copyGapSeconds:gaps[0],alignedGapSeconds:gaps[1]}));
        assert.ok(gaps[0]>6,'reproduce the leading gap on a mid-GOP copy seek');
        assert.ok(Math.abs(gaps[1])<0.1,'accurate decode seek keeps both tracks on the same start');
        // A video-only graph and a truncated/corrupt segment cannot earn the gate.
        await run(ffmpeg, ['-v', 'error', '-y', '-i', fixture, '-t', '4', '-an', '-c:v', 'copy', '-f', 'mpegts', path.join(dir, 'segment-99999.ts')]);
        assert.equal((await verifyFiniteTsStartupSegments({ root: dir,
            files: ['segment-00000.ts', 'segment-99999.ts'], durations: [4, 4], bin: ffmpeg })).verified, false);
        fs.writeFileSync(path.join(dir, 'segment-99998.ts'), Buffer.alloc(188 * 4, 0x47));
        assert.equal((await verifyFiniteTsStartupSegments({ root: dir,
            files: ['segment-00000.ts', 'segment-99998.ts'], durations: [4, 4], bin: ffmpeg })).verified, false);
        // Reproduce the separate real MKV witness failure: CRF/CQP video plus
        // copied AAC has no nominal bitrate and FFmpeg emits an empty master.
        const mkv = path.join(dir, 'witness.mkv');
        await run(ffmpeg, ['-v', 'error', '-y', '-i', fixture, '-t', '8', '-c', 'copy', mkv]);
        await run(ffmpeg, ['-v', 'error', '-y', '-i', mkv, '-map', '0:v:0', '-map', '0:a:0',
            '-c:v', 'libx264', '-crf', '23', '-preset', 'ultrafast', '-threads', '1', '-g', '50', '-c:a', 'copy',
            '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-master_pl_name', 'playlist.m3u8',
            '-var_stream_map', 'v:0,a:0,name:video', path.join(dir, '%v.m3u8')]);
        const master = fs.readFileSync(path.join(dir, 'playlist.m3u8'), 'utf8');
        assert.equal(master.includes('#EXT-X-STREAM-INF'), false, 'reproduce the observed empty FFmpeg master');
        const { buildExactSubtitleHlsPlan, seedExactSubtitlePlaylists, rewriteExactHlsMaster } = require('../services/media-gateway/src/sharedHlsTracks');
        const subtitlePlan = buildExactSubtitleHlsPlan({ subtitles: [{ index: 2, codec: 'subrip', language: 'eng', extractable: true }] });
        assert.equal(subtitlePlan.enabled, true);
        seedExactSubtitlePlaylists(subtitlePlan, dir);
        const child = fs.readFileSync(path.join(dir, 'video.m3u8'), 'utf8');
        const segments = [...child.matchAll(/#EXTINF:([\d.]+),[^\n]*\n([^\n]+)/g)];
        const segmentPeak = Math.max(...segments.map(([, duration, name]) => fs.statSync(path.join(dir, name.trim())).size * 8 / Number(duration)));
        const repaired = rewriteExactHlsMaster(master, { subtitlePlan,
            fallbackVariant: { playlistName: 'video.m3u8', bandwidth: Math.ceil(segmentPeak * 1.25) } });
        fs.writeFileSync(path.join(dir, 'repaired.m3u8'), repaired);
        const parsed = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', path.join(dir, 'repaired.m3u8')]));
        assert.equal(parsed.streams.filter(s => s.codec_type === 'video').length, 1);
        assert.equal(parsed.streams.filter(s => s.codec_type === 'audio').length, 1);
        console.log('synthetic MKV master repaired with measured bandwidth and retained subtitle rendition');
    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
