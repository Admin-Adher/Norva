'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
    finiteMkvLinearSeekBridgeArgs,
    finiteMkvLinearSeekBridgePlan,
} = require('../services/media-gateway/src/finite-mkv-linear-seek-bridge');

const ROOT = path.join(__dirname, '..');

function installedMediaTool(packageName, fallback) {
    try {
        const installed = require(packageName);
        const candidate = typeof installed === 'string' ? installed : installed?.path;
        if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {}
    const probe = spawnSync(fallback, ['-version'], { encoding: 'utf8', windowsHide: true });
    return !probe.error && probe.status === 0 ? fallback : null;
}

function runMediaTool(executable, args, options = {}) {
    return spawnSync(executable, args, {
        encoding: options.encoding || 'utf8',
        input: options.input,
        maxBuffer: 128 * 1024 * 1024,
        windowsHide: true,
    });
}

function runPipedMediaTool(executable, args, inputPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({
            code,
            signal,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr).toString('utf8'),
        }));
        fs.createReadStream(inputPath).once('error', reject).pipe(child.stdin);
    });
}

function frameMd5(output) {
    return String(output || '').split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^0,/.test(line))
        ?.split(',').at(-1)?.trim() || '';
}

test('finite MKV linear seek bridge is limited to the one indexed-resume fallback', () => {
    const base = {
        enabled: true,
        finiteMkv: true,
        indexedInput: false,
        linearFallbacks: 1,
        seekOffsetSeconds: 91,
        prerollSeconds: 30,
    };
    assert.deepEqual(finiteMkvLinearSeekBridgePlan(base), {
        requestedSeekOffsetSeconds: 91,
        bridgeSeekOffsetSeconds: 61,
        fineSeekOffsetSeconds: 30,
        prerollSeconds: 30,
    });
    for (const override of [
        { enabled: false },
        { finiteMkv: false },
        { indexedInput: true },
        { linearFallbacks: 0 },
        { seekOffsetSeconds: 30 },
    ]) {
        assert.equal(finiteMkvLinearSeekBridgePlan({ ...base, ...override }), null);
    }
});

test('real pipe bridge keeps exact resume frames and every language lane', { timeout: 120_000 }, async (t) => {
    const ffmpeg = installedMediaTool('ffmpeg-static', 'ffmpeg');
    const ffprobe = installedMediaTool('@ffprobe-installer/ffprobe', 'ffprobe');
    if (!ffmpeg || !ffprobe) {
        t.skip('ffmpeg and ffprobe are required for the deterministic runtime fixture');
        return;
    }

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-linear-seek-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const subtitles = path.join(temporary, 'subtitles.srt');
    const source = path.join(temporary, 'source.mkv');
    const bridged = path.join(temporary, 'bridged.mkv');
    fs.writeFileSync(subtitles, [
        '1',
        '00:00:00,000 --> 00:02:00,000',
        'Norva deterministic subtitle lane',
        '',
    ].join('\n'));

    const created = runMediaTool(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=120',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=120',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=120',
        '-f', 'srt', '-i', subtitles,
        '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:s:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '64k', '-c:s', 'srt',
        '-metadata:s:a:0', 'language=fra', '-metadata:s:a:1', 'language=eng',
        '-metadata:s:s:0', 'language=spa',
        '-y', source,
    ]);
    assert.equal(created.status, 0, created.stderr || 'fixture creation failed');

    const plan = finiteMkvLinearSeekBridgePlan({
        enabled: true,
        finiteMkv: true,
        indexedInput: false,
        linearFallbacks: 1,
        seekOffsetSeconds: 91,
        prerollSeconds: 30,
    });
    const bridgeArgs = finiteMkvLinearSeekBridgeArgs(plan, [
        '-analyzeduration', '8000000', '-probesize', '8000000',
    ]);
    assert.equal(bridgeArgs.includes('http://'), false);
    assert.equal(bridgeArgs.includes('https://'), false);
    assert.equal(bridgeArgs[bridgeArgs.indexOf('-i') + 1], 'pipe:0');
    assert.deepEqual(bridgeArgs.slice(bridgeArgs.indexOf('-map'), bridgeArgs.indexOf('-map') + 2), ['-map', '0']);

    const bridgeResult = await runPipedMediaTool(ffmpeg, bridgeArgs, source);
    assert.equal(bridgeResult.code, 0, bridgeResult.stderr);
    assert.ok(bridgeResult.stdout.length > 0, 'bridge must emit a Matroska stream');
    fs.writeFileSync(bridged, bridgeResult.stdout);

    const sourceStreams = runMediaTool(ffprobe, [
        '-v', 'error', '-show_entries', 'stream=index,codec_type:stream_tags=language', '-of', 'json', source,
    ]);
    const bridgedStreams = runMediaTool(ffprobe, [
        '-v', 'error', '-show_entries', 'stream=index,codec_type:stream_tags=language', '-of', 'json', bridged,
    ]);
    assert.equal(sourceStreams.status, 0, sourceStreams.stderr);
    assert.equal(bridgedStreams.status, 0, bridgedStreams.stderr);
    assert.deepEqual(JSON.parse(bridgedStreams.stdout).streams, JSON.parse(sourceStreams.stdout).streams);

    const reference = runMediaTool(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', source,
        '-ss', String(plan.requestedSeekOffsetSeconds),
        '-map', '0:V:0', '-frames:v', '1', '-f', 'framemd5', 'pipe:1',
    ]);
    const resumed = runMediaTool(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-ss', String(plan.fineSeekOffsetSeconds),
        '-map', '0:V:0', '-frames:v', '1', '-f', 'framemd5', 'pipe:1',
    ], { input: bridgeResult.stdout });
    assert.equal(reference.status, 0, reference.stderr);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.ok(frameMd5(reference.stdout), 'reference frame hash missing');
    assert.equal(frameMd5(resumed.stdout), frameMd5(reference.stdout));
});

test('local fault-injection gateway reaches HLS through one provider pump and leaves zero resources', {
    timeout: 120_000,
}, async (t) => {
    const ffmpeg = installedMediaTool('ffmpeg-static', 'ffmpeg');
    const ffprobe = installedMediaTool('@ffprobe-installer/ffprobe', 'ffprobe');
    if (!ffmpeg || !ffprobe) {
        t.skip('ffmpeg and ffprobe are required for the deterministic gateway fixture');
        return;
    }

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-linear-gateway-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const sourcePath = path.join(temporary, 'provider-source.mkv');
    const subtitlesPath = path.join(temporary, 'provider-subtitles.srt');
    fs.writeFileSync(subtitlesPath, [
        '1',
        '00:00:00,000 --> 00:02:00,000',
        'Norva provider fault fixture',
        '',
    ].join('\n'));
    const created = runMediaTool(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=120',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=120',
        '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=120',
        '-f', 'srt', '-i', subtitlesPath,
        '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:s:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-b:v', '1M', '-minrate', '1M', '-maxrate', '1M', '-bufsize', '2M',
        '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '64k', '-c:s', 'srt',
        '-metadata:s:a:0', 'language=fra', '-metadata:s:a:1', 'language=eng',
        '-metadata:s:s:0', 'language=spa',
        '-y', sourcePath,
    ]);
    assert.equal(created.status, 0, created.stderr || 'provider fixture creation failed');
    const sourceBytes = fs.readFileSync(sourcePath);
    assert.ok(sourceBytes.length > 4_000_000, 'fixture must exceed the bounded identity prefix');
    const probed = runMediaTool(ffprobe, [
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath,
    ]);
    assert.equal(probed.status, 0, probed.stderr);
    const probe = JSON.parse(probed.stdout);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const audios = probe.streams.filter((stream) => stream.codec_type === 'audio');
    const subtitles = probe.streams.filter((stream) => stream.codec_type === 'subtitle');
    assert.equal(audios.length, 2);
    assert.equal(subtitles.length, 1);
    const codecProfile = {
        container: 'matroska',
        metadataComplete: true,
        probeSource: 'gateway_inband',
        probedAt: new Date().toISOString(),
        fileSizeBytes: sourceBytes.length,
        durationSeconds: Number(probe.format.duration),
        videoCodec: video.codec_name,
        videoStreamIndex: video.index,
        videoProfile: video.profile,
        videoLevel: video.level,
        videoWidth: video.width,
        videoHeight: video.height,
        videoPixelFormat: video.pix_fmt,
        audioTracks: audios.map((stream) => ({
            index: stream.index,
            codec: stream.codec_name,
            profile: stream.profile,
            channels: stream.channels,
            sampleRate: Number(stream.sample_rate),
            language: stream.tags?.language || null,
            default: stream.disposition?.default === 1,
        })),
        subtitles: subtitles.map((stream) => ({
            index: stream.index,
            codec: stream.codec_name,
            language: stream.tags?.language || null,
            default: stream.disposition?.default === 1,
            forced: stream.disposition?.forced === 1,
            extractable: true,
        })),
    };

    let providerRequests = 0;
    let brokerFailures = 0;
    let fullFallbacks = 0;
    let activeProviderResponses = 0;
    let maxActiveProviderResponses = 0;
    const providerRequestLog = [];
    const providerServer = http.createServer((request, response) => {
        providerRequests += 1;
        providerRequestLog.push({ method: request.method, range: String(request.headers.range || '') });
        activeProviderResponses += 1;
        maxActiveProviderResponses = Math.max(maxActiveProviderResponses, activeProviderResponses);
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            activeProviderResponses -= 1;
        };
        response.once('finish', settle);
        response.once('close', settle);

        if (request.method === 'HEAD') {
            response.writeHead(200, {
                'Content-Length': String(sourceBytes.length),
                'Accept-Ranges': 'bytes',
                ETag: '"norva-linear-seek-fixture-v1"',
            });
            response.end();
            return;
        }
        const rangeHeader = String(request.headers.range || '');
        const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);
        const start = match ? Number(match[1]) : 0;
        const requestedEnd = match && match[2] ? Number(match[2]) : sourceBytes.length - 1;
        const end = Math.min(sourceBytes.length - 1, requestedEnd);
        const firstIdentityRequest = providerRequests === 1;
        const fullByteZeroFallback = start === 0 && requestedEnd >= sourceBytes.length - 1;
        if (!firstIdentityRequest && !fullByteZeroFallback) {
            brokerFailures += 1;
            response.writeHead(502, { 'Content-Type': 'text/plain', 'Content-Length': '23' });
            response.end('temporary indexed failure');
            return;
        }
        if (fullByteZeroFallback && !firstIdentityRequest) fullFallbacks += 1;
        const payload = sourceBytes.subarray(start, end + 1);
        response.writeHead(match ? 206 : 200, {
            'Content-Length': String(payload.length),
            'Content-Type': 'video/x-matroska',
            'Accept-Ranges': 'bytes',
            ETag: '"norva-linear-seek-fixture-v1"',
            ...(match ? { 'Content-Range': `bytes ${start}-${end}/${sourceBytes.length}` } : {}),
        });
        response.end(payload);
    });
    await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => providerServer.close(resolve)));
    const providerPort = providerServer.address().port;

    const portReservation = http.createServer();
    await new Promise((resolve) => portReservation.listen(0, '127.0.0.1', resolve));
    const gatewayPort = portReservation.address().port;
    await new Promise((resolve) => portReservation.close(resolve));
    const gatewayToken = 'local-linear-seek-gateway-token';
    const gatewayOutput = [];
    const gateway = spawn(process.execPath, [path.join(ROOT, 'services/media-gateway/src/index.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(gatewayPort),
            OUTPUT_DIR: path.join(temporary, 'gateway-output'),
            GATEWAY_TOKEN: gatewayToken,
            FFMPEG_PATH: ffmpeg,
            FFPROBE_PATH: ffprobe,
            NODE_PATH: path.join(ROOT, 'node_modules'),
            ACCOUNT_ACTIVITY_REPORT_MS: '0',
            MEDIA_GATEWAY_VIDEO_ENCODER: 'software',
            PROVIDER_SLOT_RELEASE_DELAY_MS: '0',
            VOD_INPUT_RETRY_LIMIT: '1',
            PROVIDER_PROXY_URLS: '',
            PROVIDER_PROXY_URL: '',
            PROVIDER_PROXY_SOCKS_URLS: '',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            FINITE_MKV_SEEK_WINDOW_BYTES: String(256 * 1024),
            FINITE_MKV_SEEK_CACHE_BYTES: String(1024 * 1024),
            FINITE_MKV_LINEAR_SEEK_BRIDGE_ENABLED: 'true',
            FINITE_MKV_LINEAR_SEEK_BRIDGE_PREROLL_SECONDS: '30',
            STARTUP_TIMEOUT_MS: '15000',
            MIN_HLS_STARTUP_BUFFER_SECONDS: '2',
            MIN_HLS_STARTUP_SEGMENTS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    gateway.stdout.on('data', (chunk) => gatewayOutput.push(chunk.toString()));
    gateway.stderr.on('data', (chunk) => gatewayOutput.push(chunk.toString()));
    t.after(async () => {
        if (gateway.exitCode === null) gateway.kill('SIGTERM');
        await new Promise((resolve) => {
            if (gateway.exitCode !== null) return resolve();
            gateway.once('exit', resolve);
            setTimeout(() => {
                if (gateway.exitCode === null) gateway.kill('SIGKILL');
            }, 2_000).unref();
        });
    });

    const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    const readHealth = async () => {
        const response = await fetch(`${gatewayBase}/health`);
        assert.equal(response.status, 200);
        return response.json();
    };
    const waitForHealth = async (predicate, label, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        let last = null;
        while (Date.now() < deadline) {
            try {
                last = await readHealth();
                if (predicate(last)) return last;
            } catch (_) {}
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.fail(`${label}; last=${JSON.stringify(last)}\n${gatewayOutput.join('')}`);
    };
    await waitForHealth((health) => health.ok === true, 'gateway did not start');

    const startedAt = Date.now();
    const sessionResponse = await fetch(`${gatewayBase}/sessions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${gatewayToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            sourceUrl: `http://127.0.0.1:${providerPort}/provider-source.mkv`,
            playbackSessionId: 'local-linear-seek-playback',
            ownerKey: 'local-linear-seek-owner',
            mode: 'remux',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            playbackHint: { streamType: 'movie', container: 'mkv', subtitleTrackCount: 1 },
            playbackIdentity: { itemId: 'local-linear-seek-item', itemType: 'movie' },
            codecProfile,
            audioCodec: 'aac',
            audioProfile: 'LC',
            audioChannels: 1,
            audioStreamIndex: audios[0].index,
            clientAudioPassthrough: false,
            seekOffset: 91,
        }),
    });
    const responseText = await sessionResponse.text();
    const session = JSON.parse(responseText);
    const startupMs = Date.now() - startedAt;
    assert.equal(sessionResponse.status, 201, `${responseText}\n${gatewayOutput.join('')}`);
    assert.ok(startupMs < 10_000, `local fault fallback took ${startupMs}ms`);
    assert.equal(session.startupTimings.finiteMkvResumeMode, 'linear-packet-copy-seek-bridge');
    assert.equal(session.startupTimings.linearSeekBridgeSourceOffsetSeconds, 61);
    assert.equal(session.startupTimings.linearSeekBridgeFineSeekSeconds, 30);
    assert.equal(session.startupTimings.linearSeekBridgeSpawnCount, 1);
    assert.equal(session.startupTimings.ffmpegSpawnCount, 2);
    assert.equal(session.multiAudioHls.enabled, true);
    assert.deepEqual(session.audioRenditions.map((track) => track.language), ['fra', 'eng']);
    assert.ok(
        Number(session.startupTimings.finiteMkvSeekProviderFetches) >= 1 &&
        Number(session.startupTimings.finiteMkvSeekInterruptedProviderFetches) >= 1,
        `the indexed path fault must be exercised: requests=${JSON.stringify(providerRequestLog)} timings=${JSON.stringify(session.startupTimings)} logs=${gatewayOutput.join('')}`,
    );
    assert.equal(session.startupTimings.finiteMkvSeekFallbackCode, 'PROVIDER_RECONNECT_EXHAUSTED');
    assert.equal(fullFallbacks, 1, 'exactly one byte-zero provider fallback is allowed');
    assert.equal(maxActiveProviderResponses, 1, 'provider responses must remain serialized');

    const playlistResponse = await fetch(session.hlsUrl);
    const playlist = await playlistResponse.text();
    assert.equal(playlistResponse.status, 200);
    assert.match(playlist, /NAME="FRA"/);
    assert.match(playlist, /NAME="ENG"/);

    const deleteResponse = await fetch(`${gatewayBase}/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${gatewayToken}` },
    });
    assert.equal(deleteResponse.status, 200);
    const finalHealth = await waitForHealth((health) => (
        health.activeSessions === 0 &&
        health.videoEncoderCapacity.active === 0 &&
        health.vodInputPump.active === 0 &&
        health.finiteMkvSeekBroker.active === 0 &&
        health.finiteMkvLinearSeekBridge.active === 0 &&
        health.rawPumpCount === 0
    ), 'gateway did not release the fallback graph');
    assert.equal(activeProviderResponses, 0);
    assert.equal(finalHealth.finiteMkvLinearSeekBridge.stats.failures, 0);
    assert.ok(providerRequests >= 2, JSON.stringify(providerRequestLog));
});
