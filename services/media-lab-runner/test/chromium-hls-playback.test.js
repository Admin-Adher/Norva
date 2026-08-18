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
