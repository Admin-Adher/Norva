'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLiveTsStartupGate, declaredTsTracks, projectLivePlaylist, parseLivePlaylist } = require('../services/media-gateway/src/live-ts-startup');
const { decodeStartupSegments, verifyFiniteTsStartupSegments } = require('../services/media-gateway/src/finite-ts-startup');

const playlist = (count, start = 0) => '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-INDEPENDENT-SEGMENTS\n'
    + `#EXT-X-MEDIA-SEQUENCE:${start}\n` + Array.from({ length: count }, (_, i) => `#EXTINF:4,\nsegment-${String(start + i).padStart(5, '0')}.ts\n`).join('');

test('Live diagnostic proves a track-start gap from decoded frame timestamps, not missing frames', async () => {
    const hash = 'a'.repeat(64);
    const frames = (tb, pts) => `#tb 0: ${tb}\n0, ${pts}, ${pts}, 1, 100, ${hash}\n0, ${pts + 1}, ${pts + 1}, 1, 100, ${hash}\n`;
    for (const [video, audio, expected] of [
        [frames('1/25', 0), frames('1/48000', 0), 'decoded'],
        [frames('1/25', 128), frames('1/48000', 0), 'delayed-track-start'],
        [frames('1/25', 0), frames('1/48000', 48000), 'delayed-track-start'],
        [frames('1/25', 128), '', 'inconclusive'],
        [frames('0/25', 0), frames('1/48000', 0), 'inconclusive'],
        [frames('1/25', 0).replace('#tb', '#unknown'), frames('1/48000', 0), 'inconclusive'],
    ]) {
        const spawnImpl = (_bin, args, options) => {
            assert.ok(args.includes('passthrough'));
            assert.ok(!args.includes('-t'));
            const child = new EventEmitter();
            child.stdio = options.stdio.map(() => new PassThrough());
            child.stderr = child.stdio[2]; child.kill = () => {};
            process.nextTick(() => { child.stdio[1].emit('data', video); child.stdio[4].emit('data', audio); child.emit('close', 0); });
            return child;
        };
        assert.deepEqual(await decodeStartupSegments('unused', [3], { diagnostics: true, spawnImpl }),
            { verified: expected === 'decoded', reason: expected });
    }
});

test('prefix projection preserves real media sequence, duration and discontinuity accounting', () => {
    const source = playlist(4, 40).replace('#EXTINF:4,', '#EXT-X-DISCONTINUITY\n#EXTINF:4,');
    const result = projectLivePlaylist(source, 41);
    assert.match(result, /#EXT-X-MEDIA-SEQUENCE:41/);
    assert.match(result, /#EXT-X-DISCONTINUITY-SEQUENCE:1/);
    assert.doesNotMatch(result, /segment-00040/);
    assert.equal(parseLivePlaylist(result).segments.length, 3);
    assert.equal(projectLivePlaylist(result, 41), result);
    assert.match(projectLivePlaylist(playlist(3, 50), 41), /MEDIA-SEQUENCE:50/);
    assert.throws(() => projectLivePlaylist(source, null), /UNVERIFIED/);
    assert.throws(() => projectLivePlaylist(source, 50), /UNVERIFIED/);
});

test('projection refuses encryption, byte ranges and unowned media names', () => {
    for (const source of [playlist(3).replace('#EXTINF:4,', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,'),
        playlist(3).replace('segment-00000.ts', '../segment-00000.ts'),
        playlist(3).replace('segment-00000.ts', 'https://example.test/source.ts'),
        playlist(3).replace('#EXTINF:4,', '#EXT-X-BYTERANGE:10\n#EXTINF:4,')])
        assert.throws(() => projectLivePlaylist(source, 1), /SCOPE/);
});

test('unknown initial playlist tags preserve the legacy route without an obligatory diagnostic', async () => {
    const gate = createLiveTsStartupGate({ root: '/unused', bin: 'unused', decode: () => { throw new Error('Unexpected diagnostic'); } });
    const source = playlist(3).replace('#EXTM3U', '#EXTM3U\n#EXT-X-ALLOW-CACHE:YES');
    assert.equal(await gate.check(source), true);
    assert.equal(gate.project(source), source);
    assert.equal(gate.snapshot().verified, false);
    assert.equal(gate.snapshot().attempts, 0);
});

test('decoder diagnostics distinguish resource failures from explicit bitstream errors split across chunks', async () => {
    for (const [chunks, expected] of [
        [['Error while decoding stream #0:0: Cannot allocate memory'], 'inconclusive'],
        [['Error while decoding stream #0:0: Resource temporarily unavailable'], 'inconclusive'],
        [['Cannot allocate memory\n[h264] non-existing PPS 0 referenced'], 'inconclusive'],
        [['Cannot allocate memory\n', '[h264] non-existing PPS 0 referenced'], 'inconclusive'],
        [['[h264] non-existing PPS 0 referenced\n', 'Cannot allocate memory'], 'inconclusive'],
        [['Resource temporarily unavailable\n', '[h264] non-existing SPS 0 referenced'], 'inconclusive'],
        [['[h264] non-exis', 'ting PPS 0 referenced'], 'invalid-bitstream'],
    ]) {
        const spawnImpl = (_bin, _args, options) => {
            const child = new EventEmitter();
            child.stdio = options.stdio.map(() => new PassThrough());
            child.stderr = child.stdio[2]; child.kill = () => {};
            process.nextTick(() => { chunks.forEach(chunk => child.stderr.emit('data', Buffer.from(chunk))); child.emit('close', 1); });
            return child;
        };
        const result = await decodeStartupSegments('unused', [3], { diagnostics: true, spawnImpl });
        assert.deepEqual(result, { verified: false, reason: expected });
    }
});

test('a decoder timeout dominates a bitstream message emitted during teardown', async () => {
    const spawnImpl = (_bin, _args, options) => {
        const child = new EventEmitter(); let killed = false;
        child.stdio = options.stdio.map(() => new PassThrough()); child.stderr = child.stdio[2];
        child.kill = () => {
            if (killed) return;
            killed = true; child.stderr.emit('data', Buffer.from('[h264] non-existing PPS 0 referenced'));
            process.nextTick(() => child.emit('close', 1));
        };
        return child;
    };
    assert.deepEqual(await decodeStartupSegments('unused', [3], { diagnostics: true, spawnImpl, timeoutMs: 5 }),
        { verified: false, reason: 'timeout' });
});

function run(bin, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${code}: ${stderr}`)); });
    });
}

test('real MPEG-TS startup proof and lifecycle', { skip: process.env.NORVA_LIVE_TS_REAL_FFMPEG !== '1', timeout: 45_000 }, async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-live-startup-'));
    const bin = process.env.FFMPEG_PATH || 'ffmpeg';
    const good = path.join(root, 'good.ts'), bad = path.join(root, 'bad.ts'), radio = path.join(root, 'radio.ts');
    const silent = path.join(root, 'silent.ts');
    try {
        await run(bin, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-threads', '1',
            '-preset', 'ultrafast', '-g', '25', '-bf', '0', '-c:a', 'aac', '-ac', '2', '-f', 'mpegts', good]);
        await run(bin, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', good, '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts', radio]);
        await run(bin, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', good, '-map', '0:v:0', '-c', 'copy', '-f', 'mpegts', silent]);
        const media = await fsp.readFile(good);
        const broken = Buffer.from(media);
        let removed = 0;
        // Mutate actual Annex-B SPS/PPS NAL types in a TS. Remuxing with a
        // bitstream filter can silently inject the original extradata again.
        for (let i = 0; i + 4 < broken.length; i++) {
            if (broken[i] === 0 && broken[i + 1] === 0 && broken[i + 2] === 1
                && [7, 8].includes(broken[i + 3] & 31)) {
                broken[i + 3] = (broken[i + 3] & 0xe0) | 12; removed++;
            }
        }
        assert.ok(removed >= 2);
        await fsp.writeFile(bad, broken);
        assert.deepEqual(declaredTsTracks(media), { scope: 'h264', tracks: ['video', 'audio'] });
        assert.deepEqual(declaredTsTracks(await fsp.readFile(bad)), { scope: 'h264', tracks: ['video', 'audio'] }, 'missing SPS cannot masquerade as radio');
        assert.deepEqual(declaredTsTracks(await fsp.readFile(radio)), { scope: 'audio-only' });
        const corruptPmt = Buffer.from(media);
        for (let i = 0; i + 188 <= corruptPmt.length; i += 188) {
            if ((((corruptPmt[i + 1] & 31) << 8) | corruptPmt[i + 2]) === 0) corruptPmt[i + 10] ^= 1;
        }
        assert.equal(declaredTsTracks(corruptPmt), null, 'CRC rejects an unproven program map');

        const reset = async (first = bad) => {
            for (let i = 0; i < 4; i++) await fsp.copyFile(i ? good : first, path.join(root, `segment-${String(i).padStart(5, '0')}.ts`));
        };
        await t.test('rejects a real SPS/PPS-less prefix and starts at an independently decoded segment', async () => {
            await reset();
            const gate = createLiveTsStartupGate({ root, bin });
            assert.equal(await gate.check(playlist(4)), true);
            const { proofMs, ...evidence } = gate.snapshot();
            assert.ok(Number.isFinite(proofMs) && proofMs >= 0);
            assert.deepEqual(evidence, { verified: true, bypass: false, minimum: 1, attempts: 2, rejected: 1, reason: 'decoded' });
            assert.equal(gate.allows('segment-00000.ts'), false);
            assert.equal(gate.allows('segment-00001.ts'), true);
            assert.equal(parseLivePlaylist(gate.project(playlist(4))).segments.length, 3);
            assert.doesNotMatch(gate.project(playlist(4)), /segment-00000/);
            assert.throws(() => gate.project(playlist(4).replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128')),
                { code: 'LIVE_TS_STARTUP_PROOF_CHANGED' });
        });
        await t.test('audio-only remains outside the H.264 guard and is never inferred after failed video', async () => {
            await reset(radio);
            const gate = createLiveTsStartupGate({ root, bin, decode: () => { throw new Error('Radio must remain outside this proof'); } });
            assert.equal(await gate.check(playlist(1)), true);
            assert.equal(gate.snapshot().reason, 'audio-only');
            await reset(); await fsp.copyFile(radio, path.join(root, 'segment-00001.ts'));
            const changed = createLiveTsStartupGate({ root, bin });
            assert.equal(await changed.check(playlist(2)), true);
            assert.equal(changed.snapshot().reason, 'program-changed');
            assert.equal(changed.snapshot().verified, false);
            assert.equal(changed.allows('segment-00000.ts'), false);
        });
        await t.test('concurrent checks share one proof and an inconclusive timeout never drops a segment', async () => {
            await reset(good);
            let count = 0, finish;
            const gate = createLiveTsStartupGate({ root, bin, decode: () => {
                count++; return new Promise(resolve => { finish = resolve; });
            } });
            const a = gate.check(playlist(4)), b = gate.check(playlist(4));
            while (!finish) await new Promise(setImmediate);
            assert.equal(count, 1);
            finish({ verified: false, reason: 'timeout' });
            assert.deepEqual(await Promise.all([a, b]), [true, true]);
            assert.equal(gate.snapshot().rejected, 0);
            assert.equal(gate.snapshot().verified, false);
            assert.equal(gate.project(playlist(4)), playlist(4));
        });
        await t.test('a new producer generation cannot reuse a previous cutoff', async () => {
            await reset();
            const old = createLiveTsStartupGate({ root, bin });
            assert.equal(await old.check(playlist(4)), true);
            await reset(good);
            const fresh = createLiveTsStartupGate({ root, bin });
            assert.equal(fresh.allows('segment-00000.ts'), false);
            assert.equal(await fresh.check(playlist(1)), true);
            assert.equal(fresh.snapshot().minimum, 0);
        });
        await t.test('real audio-leading encoded prefix is projected before independently synchronized media', async () => {
            const delayed = path.join(root, 'delayed.ts');
            await run(bin, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-itsoffset', '3', '-i', good,
                '-i', good, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-f', 'mpegts', delayed]);
            await reset(delayed);
            const gate = createLiveTsStartupGate({ root, bin });
            assert.equal(await gate.check(playlist(2)), true);
            assert.equal(gate.snapshot().verified, true);
            assert.equal(gate.snapshot().minimum, 1);
            assert.equal(gate.snapshot().rejected, 1);
            assert.equal(gate.allows('segment-00000.ts'), false);
        });
        await t.test('silent H.264 uses its declared video lane; the existing VOD AV proof remains strict', async () => {
            await reset(silent);
            const gate = createLiveTsStartupGate({ root, bin });
            assert.equal(await gate.check(playlist(1)), true);
            assert.equal(gate.snapshot().verified, true);
            const strict = await verifyFiniteTsStartupSegments({ root, bin,
                files: ['segment-00000.ts', 'segment-00001.ts'], durations: [4, 4] });
            assert.equal(strict.verified, false, 'VOD still requires its original AV contract');
            await reset(good);
            assert.equal((await verifyFiniteTsStartupSegments({ root, bin,
                files: ['segment-00000.ts', 'segment-00001.ts'], durations: [4, 4] })).verified, true);
        });
        await t.test('three invalid segments fail closed without serving an untested fourth segment', async () => {
            await reset();
            await fsp.copyFile(bad, path.join(root, 'segment-00001.ts'));
            await fsp.copyFile(bad, path.join(root, 'segment-00002.ts'));
            const gate = createLiveTsStartupGate({ root, bin });
            await assert.rejects(gate.check(playlist(3)), { code: 'LIVE_TS_STARTUP_INVALID' });
            await assert.rejects(gate.check(playlist(4)), { code: 'LIVE_TS_STARTUP_INVALID' });
            assert.equal(gate.snapshot().attempts, 3);
            assert.equal(gate.snapshot().verified, false);
            assert.equal(gate.snapshot().minimum, 3);
            assert.equal(gate.allows('segment-00002.ts'), false);
            assert.equal(gate.allows('segment-00003.ts'), false);
            assert.equal(gate.snapshot().bypass, false);
        });
        await t.test('healthy 1080p local proof adds one bounded decoder and no discarded prefix', async () => {
            const hd = path.join(root, 'segment-00000.ts');
            await run(bin, ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25',
                '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-threads', '1',
                '-preset', 'ultrafast', '-g', '25', '-bf', '0', '-c:a', 'aac', '-ac', '2', '-f', 'mpegts', hd]);
            const durations = [];
            for (let i = 0; i < 3; i++) {
                const gate = createLiveTsStartupGate({ root, bin });
                const start = performance.now();
                assert.equal(await gate.check(playlist(1)), true);
                durations.push(Math.round(performance.now() - start));
                assert.equal(gate.snapshot().verified, true);
                assert.equal(gate.snapshot().attempts, 1);
                assert.equal(gate.snapshot().rejected, 0);
                const extended = playlist(3).replace('#EXTM3U', '#EXTM3U\n#EXT-X-ALLOW-CACHE:YES');
                assert.equal(gate.project(extended), extended, 'healthy refreshes retain the prior playlist contract');
            }
            t.diagnostic(`Local synthetic 1080p startup proof milliseconds: ${durations.join(', ')}`);
        });
        await t.test('abort during the local decoder never promotes ready or advances the cutoff', async () => {
            await reset(good);
            const controller = new AbortController();
            let entered, release;
            const started = new Promise(resolve => { entered = resolve; });
            const gate = createLiveTsStartupGate({ root, bin, signal: controller.signal,
                decode: async () => { entered(); await new Promise(resolve => { release = resolve; }); return { verified: true, reason: 'decoded' }; } });
            const pending = gate.check(playlist(1)); await started;
            controller.abort(); release();
            assert.equal(await pending, false);
            assert.equal(gate.snapshot().minimum, null);
            assert.equal(gate.snapshot().reason, 'aborted');
        });
        await t.test('real decoder abort is bounded and not corruption evidence', async () => {
            const handle = await fsp.open(good);
            try {
                const controller = new AbortController();
                const pending = decodeStartupSegments(bin, [handle.fd], { diagnostics: true, signal: controller.signal });
                controller.abort();
                const result = await pending;
                assert.equal(result.verified, false); assert.equal(result.reason, 'aborted');
            } finally { await handle.close(); }
        });
    } finally {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^norva-live-startup-/);
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('the real readiness inspection rechecks reserve after projecting the accepted prefix', async () => {
    const gateway = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    const start = gateway.indexOf('async function inspectHlsMediaPlaylistArtifact(');
    const end = gateway.indexOf('\nasync function inspectMediaCacheLiveJoinGraph(', start);
    const session = { outputDir: '/output', minHlsStartupSegments: 3, minHlsStartupBufferSeconds: 10,
        startupTimings: {}, liveTsStartupGate: { check: async () => true, project: text => projectLivePlaylist(text, 1),
            snapshot: () => ({ verified: true, rejected: 1, reason: 'decoded' }) } };
    let body = playlist(3);
    const context = vm.createContext({ path, asRecord: value => value || {}, isWithin: () => true,
        MIN_HLS_STARTUP_BUFFER_SECONDS: 10, MIN_HLS_STARTUP_SEGMENTS: 3,
        fsp: { readFile: async () => body, stat: async () => ({ isFile: () => true, size: 1000, mtimeMs: 1000 }) } });
    vm.runInContext(gateway.slice(start, end), context);
    assert.equal(await context.inspectHlsMediaPlaylistArtifact(session, { playlistPath: '/output/playlist.m3u8' }), null);
    body = playlist(4);
    const ready = await context.inspectHlsMediaPlaylistArtifact(session, { playlistPath: '/output/playlist.m3u8' });
    assert.equal(ready.inspection.segmentCount, 3);
    assert.equal(ready.inspection.durationSeconds, 12);
    assert.equal(ready.inspection.mediaSequence, 1);
    let release;
    session.liveTsStartupGate = { check: () => new Promise(resolve => { release = resolve; }), project() { throw new Error('Old gate must not publish'); } };
    const abandoned = context.inspectHlsMediaPlaylistArtifact(session, { playlistPath: '/output/playlist.m3u8' });
    while (!release) await new Promise(setImmediate);
    session.liveTsStartupGate = {};
    release(true);
    assert.equal(await abandoned, null, 'an old generation cannot publish after replacement');
    assert.match(gateway, /session\.liveTsStartupGate && !session\.liveTsStartupGate\.allows\(requested\)/);
    assert.match(gateway, /if \(session\?\.liveTsStartupGate\) playlist = session\.liveTsStartupGate\.project\(playlist\)/);
});
