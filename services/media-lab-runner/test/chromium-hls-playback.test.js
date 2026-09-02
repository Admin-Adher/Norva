'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { ChromiumHlsPlaybackHarness } = require('../src/gateway-chromium-adapter');
const {
    buildExactSubtitleHlsPlan,
    rewriteExactSubtitleMediaSequence,
    seedExactSubtitlePlaylists,
} = require('../../media-gateway/src/sharedHlsTracks');

function optionalDependency(name, select = (value) => value) {
    try { return select(require(name)); } catch (_) { return null; }
}

function run(binary, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
        child.once('error', reject);
        child.once('exit', (code) => code === 0
            ? resolve()
            : reject(new Error(`FFMPEG_HLS_FIXTURE_FAILED:${code}:${stderr}`)));
    });
}

function contentType(file) {
    if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (file.endsWith('.vtt')) return 'text/vtt';
    if (file.endsWith('.ts')) return 'video/mp2t';
    return 'application/octet-stream';
}

test('real headless Chromium decodes HLS video and audio, seeks, and reports no rebuffer', async (t) => {
    const ffmpegPath = process.env.MEDIA_LAB_TEST_FFMPEG_PATH || optionalDependency('ffmpeg-static');
    const chromiumPath = process.env.MEDIA_LAB_TEST_CHROMIUM_PATH
        || optionalDependency('playwright', (module) => module.chromium.executablePath());
    const hlsJsPath = path.resolve(__dirname, '..', '..', '..', 'public', 'js', 'vendor', 'hls-1.5.7.min.js');
    if (!ffmpegPath || !chromiumPath || !fs.existsSync(ffmpegPath) || !fs.existsSync(chromiumPath)) {
        t.skip('local FFmpeg/Chromium binaries are unavailable');
        return;
    }
    const outputRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-media-lab-browser-'));
    t.after(() => fsp.rm(outputRoot, { recursive: true, force: true }));
    await run(ffmpegPath, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=4',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
        '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-shortest',
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(outputRoot, 'segment%03d.ts'),
        path.join(outputRoot, 'playlist.m3u8'),
    ]);

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url || '/', 'http://localhost');
        if (url.pathname === '/health') {
            response.setHeader('Content-Type', 'application/json');
            response.end('{"ok":true}');
            return;
        }
        const match = /^\/sessions\/browser-fixture\/(playlist\.m3u8|segment\d{3}\.ts)$/.exec(url.pathname);
        if (!match) {
            response.statusCode = 404;
            response.end('not found');
            return;
        }
        const filePath = path.join(outputRoot, match[1]);
        const stat = await fsp.stat(filePath);
        response.setHeader('Content-Type', contentType(match[1]));
        response.setHeader('Content-Length', String(stat.size));
        fs.createReadStream(filePath).pipe(response);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve, reject) => {
        try { server.closeIdleConnections?.(); } catch (_) {}
        try { server.closeAllConnections?.(); } catch (_) {}
        server.close((error) => error ? reject(error) : resolve());
    }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const harness = new ChromiumHlsPlaybackHarness({
        hlsJsPath,
        chromiumExecutablePath: chromiumPath,
    });
    const result = await harness.play({
        gatewayOrigin: origin,
        hlsUrl: `${origin}/sessions/browser-fixture/playlist.m3u8?token=opaque`,
        timeoutMs: 30_000,
    });
    assert.ok(result.firstFrameMs > 0 && result.firstFrameMs < 30_000);
    assert.ok(result.firstSegmentMs > 0 && result.firstSegmentMs < result.firstFrameMs + 1_000);
    assert.ok(result.bufferedAheadSeconds > 0);
    assert.equal(result.seekPassed, true);
    assert.equal(result.audioPassed, true);
    assert.equal(result.rebufferCount, 0);
    assert.equal(result.rebufferMs, 0);
});

test('real hls.js keeps a late-cue subtitle selected across bootstrap-to-exact transition', async (t) => {
    const ffmpegPath = process.env.MEDIA_LAB_TEST_FFMPEG_PATH || optionalDependency('ffmpeg-static');
    const chromiumPath = process.env.MEDIA_LAB_TEST_CHROMIUM_PATH
        || optionalDependency('playwright', (module) => module.chromium.executablePath());
    const playwright = optionalDependency('playwright-core');
    const hlsJsPath = path.resolve(__dirname, '..', '..', '..', 'public', 'js', 'vendor', 'hls-1.5.7.min.js');
    if (!ffmpegPath || !chromiumPath || !playwright
        || !fs.existsSync(ffmpegPath) || !fs.existsSync(chromiumPath)) {
        t.skip('local FFmpeg/Chromium binaries are unavailable');
        return;
    }

    const outputRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-late-subtitle-browser-'));
    t.after(() => fsp.rm(outputRoot, { recursive: true, force: true }));
    await run(ffmpegPath, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=6',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
        '-c:a', 'aac', '-profile:a', 'aac_low', '-ac', '2', '-shortest',
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(outputRoot, 'segment%03d.ts'),
        path.join(outputRoot, 'video.m3u8'),
    ]);

    const subtitlePlan = buildExactSubtitleHlsPlan({
        subtitles: [{
            index: 2,
            language: 'eng',
            title: 'Late English',
            codec: 'subrip',
            subtitleType: 'text',
            extractable: true,
        }],
    });
    seedExactSubtitlePlaylists(subtitlePlan, outputRoot);
    const bootstrapPlaylist = await fsp.readFile(path.join(outputRoot, 'subtitle_0.m3u8'), 'utf8');
    await fsp.writeFile(path.join(outputRoot, 'subtitle_0-00001.vtt'), [
        'WEBVTT', '',
        '00:02.000 --> 00:04.500',
        'Late cue became available', '',
    ].join('\n'));
    const exactPlaylist = rewriteExactSubtitleMediaSequence([
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-TARGETDURATION:5',
        '#EXTINF:4.500,',
        'subtitle_0-00001.vtt',
        '#EXT-X-ENDLIST',
        '',
    ].join('\n'));
    const masterPlaylist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="norva_subtitles",NAME="Late English",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,LANGUAGE="eng",URI="subtitle_0.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00d,mp4a.40.2",SUBTITLES="norva_subtitles"',
        'video.m3u8',
        '',
    ].join('\n');

    let subtitleRequests = 0;
    let exactResponses = 0;
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url || '/', 'http://localhost');
        if (url.pathname === '/health') {
            response.setHeader('Content-Type', 'application/json');
            response.end('{"ok":true}');
            return;
        }
        if (url.pathname === '/sessions/late-subtitle/playlist.m3u8') {
            response.setHeader('Content-Type', contentType('playlist.m3u8'));
            response.end(masterPlaylist);
            return;
        }
        if (url.pathname === '/sessions/late-subtitle/subtitle_0.m3u8') {
            subtitleRequests += 1;
            // Make the transition deterministic even when browser startup is
            // slower than the intended warm-up delay: the first response is
            // always the bootstrap and the next poll always exposes the cue.
            const exact = subtitleRequests > 1;
            if (exact) exactResponses += 1;
            response.setHeader('Content-Type', contentType('subtitle_0.m3u8'));
            response.setHeader('Cache-Control', 'no-store');
            response.end(exact ? exactPlaylist : bootstrapPlaylist);
            return;
        }
        const match = /^\/sessions\/late-subtitle\/(video\.m3u8|segment\d{3}\.ts|subtitle_0-\d{5}\.vtt)$/.exec(url.pathname);
        if (!match) {
            response.statusCode = 404;
            response.end('not found');
            return;
        }
        const filePath = path.join(outputRoot, match[1]);
        const stat = await fsp.stat(filePath);
        response.setHeader('Content-Type', contentType(match[1]));
        response.setHeader('Content-Length', String(stat.size));
        fs.createReadStream(filePath).pipe(response);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve, reject) => {
        try { server.closeIdleConnections?.(); } catch (_) {}
        try { server.closeAllConnections?.(); } catch (_) {}
        server.close((error) => error ? reject(error) : resolve());
    }));

    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await playwright.chromium.launch({
        headless: true,
        executablePath: chromiumPath,
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--no-first-run'],
    });
    t.after(() => browser.close().catch(() => {}));
    const page = await browser.newPage();
    await page.goto(`${origin}/health`, { waitUntil: 'domcontentloaded' });
    await page.setContent('<!doctype html><meta charset="utf-8"><video playsinline muted></video>');
    await page.addScriptTag({ path: hlsJsPath });
    const result = await page.evaluate(async (sourceUrl) => {
        const video = document.querySelector('video');
        const hls = new Hls({ enableWorker: false, startPosition: 0 });
        const nonFatal = [];
        hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data?.fatal) nonFatal.push(`fatal:${data.details}`);
            else if (data?.details) nonFatal.push(String(data.details));
        });
        hls.attachMedia(video);
        await new Promise((resolve) => hls.once(Hls.Events.MEDIA_ATTACHED, resolve));
        hls.loadSource(sourceUrl);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('manifest timeout')), 8_000);
            hls.once(Hls.Events.MANIFEST_PARSED, () => { clearTimeout(timer); resolve(); });
        });
        hls.subtitleTrack = 0;
        await video.play();
        const deadline = performance.now() + 10_000;
        let cueCount = 0;
        while (performance.now() < deadline) {
            const track = video.textTracks[0];
            cueCount = track?.cues?.length || 0;
            if (cueCount > 0 && video.currentTime > 2.2) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const state = {
            cueCount,
            selectedTrack: hls.subtitleTrack,
            currentTime: video.currentTime,
            fatalErrors: nonFatal.filter((item) => item.startsWith('fatal:')),
            subtitleLoadErrors: nonFatal.filter((item) => item === 'subtitleTrackLoadError'),
        };
        hls.destroy();
        return state;
    }, `${origin}/sessions/late-subtitle/playlist.m3u8?token=opaque`);

    assert.equal(result.selectedTrack, 0);
    assert.ok(result.currentTime > 2.2, 'video playback keeps advancing while the subtitle is warming');
    assert.ok(result.cueCount > 0, 'the exact cue appears without reselecting the subtitle track');
    assert.deepEqual(result.fatalErrors, []);
    assert.deepEqual(result.subtitleLoadErrors, []);
    assert.ok(subtitleRequests >= 2, 'hls.js reloads the live bootstrap playlist');
    assert.ok(exactResponses >= 1, 'hls.js observes the exact replacement playlist');
});
