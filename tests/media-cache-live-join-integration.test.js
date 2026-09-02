'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ProviderSimulator } = require('../services/media-lab-runner/src/provider-simulator');

const ROOT = path.join(__dirname, '..');
const GATEWAY_PATH = path.join(ROOT, 'services/media-gateway/src/index.js');

function locateMediaTools() {
  let ffmpeg = String(process.env.MEDIA_LAB_TEST_FFMPEG_PATH || '').trim();
  let ffprobe = String(process.env.MEDIA_LAB_TEST_FFPROBE_PATH || '').trim();
  try { ffmpeg ||= require('ffmpeg-static'); } catch (_) {}
  try { ffprobe ||= require('@ffprobe-installer/ffprobe').path; } catch (_) {}
  return {
    ffmpeg: ffmpeg && fs.existsSync(ffmpeg) ? ffmpeg : null,
    ffprobe: ffprobe && fs.existsSync(ffprobe) ? ffprobe : null,
  };
}

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`LIVE_JOIN_FIXTURE_FFMPEG_FAILED:${code}:${stderr}`)));
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function reservePort() {
  const server = http.createServer();
  const base = await listen(server);
  const port = Number(new URL(base).port);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function createExactMkvFixture(ffmpeg, root) {
  const subtitlePath = path.join(root, 'captions.srt');
  const sourcePath = path.join(root, 'source.mkv');
  const cues = [];
  for (let index = 0; index < 30; index += 1) {
    const start = index * 4;
    const end = start + 3;
    const clock = (seconds) => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
    cues.push(`${index + 1}\n${clock(start)} --> ${clock(end)}\nCaption ${index + 1}\n`);
  }
  await fsp.writeFile(subtitlePath, `${cues.join('\n')}\n`);
  await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=120',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=120',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=120',
    '-i', subtitlePath,
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:s:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English',
    '-metadata:s:a:1', 'language=fra', '-metadata:s:a:1', 'title=Français',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English CC',
    '-disposition:a:0', 'default', '-disposition:a:1', '0',
    '-shortest', sourcePath,
  ]);
  return sourcePath;
}

function playlistToken(hlsUrl) {
  return new URL(hlsUrl).searchParams.get('token');
}

async function readJson(response) {
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (_) {}
  return { response, payload, text };
}

test('ten authorized viewers live-join one exact MKV producer and detach independently', {
  timeout: 120_000,
}, async (t) => {
  const { ffmpeg, ffprobe } = locateMediaTools();
  if (!ffmpeg || !ffprobe) {
    t.skip('local FFmpeg/FFprobe binaries are unavailable');
    return;
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-live-join-e2e-'));
  const outputRoot = path.join(root, 'gateway-output');
  await fsp.mkdir(outputRoot, { recursive: true });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourcePath = await createExactMkvFixture(ffmpeg, root);
  const sourceStat = await fsp.stat(sourcePath);

  const provider = new ProviderSimulator({ fixtureRoot: root });
  const providerServer = http.createServer((request, response) => {
    provider.handle(request, response).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.statusCode = 404;
        response.end('not found');
      }
    }).catch((error) => {
      if (!response.headersSent) response.statusCode = 500;
      response.end(String(error?.message || 'provider failed'));
    });
  });
  const providerBase = await listen(providerServer);
  t.after(() => closeServer(providerServer));
  const providerRun = await provider.openFixture({
    id: 'live-join-exact-mkv',
    assetFile: 'source.mkv',
    provider: {
      assetRequired: true,
      etag: 'strong',
      delayMs: 0,
      disconnectAfterBytes: 0,
      disconnectCount: 0,
      statusSequence: [],
    },
  }, `${providerBase}/`, {
    delayMs: 0,
    bandwidthBytesPerSecond: Math.max(64 * 1024, Math.floor(sourceStat.size / 25)),
    disconnectAfterBytes: 0,
    disconnectCount: 0,
    statusSequence: [],
  });
  t.after(() => providerRun.close());

  const gatewayToken = `gateway-${crypto.randomBytes(24).toString('hex')}`;
  const workerToken = `worker-${crypto.randomBytes(24).toString('hex')}`;
  const controlRequests = [];
  const controlServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
    controlRequests.push({ method: request.method, url: request.url, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== `Bearer ${gatewayToken}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (request.url === '/media-cache/producer-control') {
      response.end(JSON.stringify({
        protocol: 1,
        state: body.action === 'abandon' ? 'abandoned' : 'renewed',
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  const controlBase = await listen(controlServer);
  t.after(() => closeServer(controlServer));

  // The object store is configured only to make the producer lane authentic.
  // The test deliberately detaches all viewers before EOF, so no object can be
  // published and this endpoint must remain unused.
  let workerRequests = 0;
  const workerServer = http.createServer((_request, response) => {
    workerRequests += 1;
    response.statusCode = 500;
    response.end(JSON.stringify({ error: 'unexpected worker request' }));
  });
  const workerBase = await listen(workerServer);
  t.after(() => closeServer(workerServer));

  const gatewayPort = await reservePort();
  const gateway = spawn(process.execPath, [GATEWAY_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      OUTPUT_DIR: outputRoot,
      GATEWAY_TOKEN: gatewayToken,
      FFMPEG_PATH: ffmpeg,
      FFPROBE_PATH: ffprobe,
      ACCOUNT_ACTIVITY_REPORT_MS: '0',
      XTREAM_PRIVATE_EGRESS_ALLOWLIST: '127.0.0.1',
      MEDIA_GATEWAY_VIDEO_ENCODER: 'software',
      MAX_ACTIVE_VIDEO_ENCODER_SESSIONS: '2',
      MIN_HLS_STARTUP_BUFFER_SECONDS: '4',
      MIN_HLS_STARTUP_SEGMENTS: '2',
      NORVA_EDGE_CALLBACK_BASE: controlBase,
      NORVA_SHARED_MEDIA_CACHE_ENABLED: 'true',
      NORVA_SHARED_MEDIA_CACHE_BACKGROUND_CONTINUATION_ENABLED: 'true',
      NORVA_MEDIA_CACHE_WORKER_URL: `${workerBase}/`,
      NORVA_MEDIA_CACHE_WORKER_TOKEN: workerToken,
      NORVA_MEDIA_CACHE_MANIFEST_HMAC_KEY: crypto.randomBytes(32).toString('hex'),
      NORVA_MEDIA_CACHE_PRODUCER_HEARTBEAT_MS: '5000',
      MEDIA_CACHE_LIVE_JOIN_ENABLED: 'true',
      MEDIA_CACHE_LIVE_JOIN_MAX_VIEWERS: '16',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const gatewayOutput = [];
  gateway.stdout.on('data', (chunk) => gatewayOutput.push(chunk.toString()));
  gateway.stderr.on('data', (chunk) => gatewayOutput.push(chunk.toString()));
  t.after(async () => {
    if (gateway.exitCode === null) gateway.kill('SIGTERM');
    await new Promise((resolve) => {
      if (gateway.exitCode !== null) return resolve();
      gateway.once('exit', resolve);
      setTimeout(() => { if (gateway.exitCode === null) gateway.kill('SIGKILL'); }, 2_000).unref();
    });
  });

  const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
  const serviceHeaders = { Authorization: `Bearer ${gatewayToken}` };
  const health = async () => {
    const response = await fetch(`${gatewayBase}/health`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const waitFor = async (predicate, label, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await health();
        if (predicate(last)) return last;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`${label}; last=${JSON.stringify(last)}\n${gatewayOutput.join('')}`);
  };
  await waitFor((value) => value.sharedMediaCache?.liveJoin?.enabled === true, 'live join did not start');

  const playbackSessionId = crypto.randomUUID();
  const expiry = new Date(Date.now() + 5 * 60_000).toISOString();
  const producerResponse = await readJson(await fetch(`${gatewayBase}/sessions`, {
    method: 'POST',
    headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceUrl: providerRun.mediaUrl,
      playbackSessionId,
      ownerKey: crypto.randomBytes(32).toString('hex'),
      mode: 'remux',
      expiresAt: expiry,
      playbackHint: { streamType: 'movie', container: 'mkv' },
      playbackIdentity: {
        sourceId: crypto.randomUUID(),
        itemType: 'movie',
        itemId: 'live-join-exact-mkv',
        variantId: crypto.randomUUID(),
      },
      codecProfile: {
        container: 'matroska,webm',
        metadataComplete: true,
        durationSeconds: 120,
        fileSizeBytes: sourceStat.size,
        videoCodec: 'h264',
        videoWidth: 320,
        videoHeight: 180,
        audioCodec: 'aac',
        audioChannels: 2,
        audioTracks: [
          { index: 1, language: 'eng', title: 'English', codec: 'aac', channels: 2, default: true },
          { index: 2, language: 'fra', title: 'Français', codec: 'aac', channels: 2, default: false },
        ],
        subtitles: [{
          index: 3,
          language: 'eng',
          title: 'English CC',
          codec: 'subrip',
          subtitleType: 'text',
          extractable: true,
          default: false,
          forced: false,
        }],
        probeSource: 'gateway_inband',
        probedAt: new Date().toISOString(),
      },
      audioStreamIndex: 1,
      clientAudioPassthrough: false,
      mediaCacheProducer: {
        protocol: 1,
        workFingerprint: 'a1'.repeat(32),
        accountFingerprint: 'b2'.repeat(32),
        leaseToken: crypto.randomUUID(),
        ownerInstanceFingerprint: 'c3'.repeat(32),
      },
    }),
  }));
  assert.equal(
    producerResponse.response.status,
    201,
    `${producerResponse.text}\n${gatewayOutput.join('')}`,
  );
  const producer = producerResponse.payload;
  assert.equal(producer.liveJoin?.candidate, true);
  assert.equal(producer.multiAudioHls?.enabled, true);
  assert.equal(producer.exactSubtitleHls?.enabled, true);
  assert.equal(producer.audioRenditions?.length, 2);
  assert.equal(producer.subtitleRenditions?.length, 1);
  assert.equal(producer.startupTimings?.ffmpegSpawnCount, 1);

  // The producer plus nine followers is the ten-viewer concurrency gate.
  const followerSpecs = Array.from({ length: 9 }, () => ({
    attachmentId: crypto.randomUUID(),
    playbackSessionId: crypto.randomUUID(),
  }));
  const followers = await Promise.all(followerSpecs.map(async (spec) => {
    const result = await readJson(await fetch(
      `${gatewayBase}/sessions/${encodeURIComponent(producer.id)}/viewers`,
      {
        method: 'POST',
        headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...spec, expiresAt: expiry }),
      },
    ));
    assert.equal(result.response.status, 201, `${result.text}\n${gatewayOutput.join('')}`);
    assert.equal(result.payload.liveJoin?.topologyValidated, true);
    assert.equal(result.payload.liveJoin?.continuityValidated, true);
    assert.equal(result.payload.audioRenditions?.length, 2);
    assert.equal(result.payload.subtitleRenditions?.length, 1);
    return { ...spec, ...result.payload };
  }));

  const allTokens = [producer, ...followers].map((viewer) => playlistToken(viewer.hlsUrl));
  assert.equal(allTokens.every(Boolean), true);
  assert.equal(new Set(allTokens).size, 10, 'every viewer must own a distinct bearer');
  const masters = await Promise.all([producer, ...followers].map(async (viewer) => {
    const response = await fetch(viewer.hlsUrl);
    assert.equal(response.status, 200);
    return response.text();
  }));
  for (const master of masters) {
    assert.match(master, /TYPE=AUDIO/);
    assert.match(master, /TYPE=SUBTITLES/);
    assert.match(master, /X-NORVA-STREAM-INDEX/);
  }

  const during = await health();
  assert.equal(during.activeSessions, 1);
  assert.equal(during.totalSessions, 1);
  assert.equal(during.videoEncoderCapacity.active, 1);
  assert.equal(during.vodInputPump.active, 1);
  assert.equal(during.sharedMediaCache.liveJoin.activeViewers, 9);
  const providerDuring = providerRun.snapshot();
  assert.equal(providerDuring.providerGets, 1);
  assert.equal(providerDuring.maximumConcurrentProviderGets, 1);
  assert.equal(providerDuring.activeGets, 1);

  const primaryDelete = await readJson(await fetch(
    `${gatewayBase}/sessions/${encodeURIComponent(producer.id)}`,
    { method: 'DELETE', headers: serviceHeaders },
  ));
  assert.equal(primaryDelete.response.status, 202, primaryDelete.text);
  assert.equal(primaryDelete.payload.completeCacheContinuation?.state, 'joined');
  assert.equal((await fetch(producer.hlsUrl)).status, 401);
  assert.equal((await fetch(followers[0].hlsUrl)).status, 200);

  const firstFollower = followers[0];
  const firstDetach = await readJson(await fetch(
    `${gatewayBase}/sessions/${encodeURIComponent(producer.id)}` +
      `/viewers/${encodeURIComponent(firstFollower.attachmentId)}` +
      `?playbackSessionId=${encodeURIComponent(firstFollower.playbackSessionId)}`,
    { method: 'DELETE', headers: serviceHeaders },
  ));
  assert.equal(firstDetach.response.status, 200, firstDetach.text);
  assert.equal(firstDetach.payload.state, 'detached');
  assert.equal((await fetch(firstFollower.hlsUrl)).status, 401);
  assert.equal((await fetch(followers[1].hlsUrl)).status, 200);

  for (const follower of followers.slice(1, -1)) {
    const detached = await readJson(await fetch(
      `${gatewayBase}/sessions/${encodeURIComponent(producer.id)}` +
        `/viewers/${encodeURIComponent(follower.attachmentId)}` +
        `?playbackSessionId=${encodeURIComponent(follower.playbackSessionId)}`,
      { method: 'DELETE', headers: serviceHeaders },
    ));
    assert.equal(detached.response.status, 200, detached.text);
  }

  // The last viewer can hand the producer to bounded background continuation.
  // A new authorized viewer must be able to reclaim it with the original
  // transport expiry instead of inheriting the shortened continuation window.
  const lastFollower = followers[followers.length - 1];
  const backgroundDetach = await readJson(await fetch(
    `${gatewayBase}/sessions/${encodeURIComponent(producer.id)}` +
      `/viewers/${encodeURIComponent(lastFollower.attachmentId)}` +
      `?playbackSessionId=${encodeURIComponent(lastFollower.playbackSessionId)}` +
      '&completeCache=continue',
    { method: 'DELETE', headers: serviceHeaders },
  ));
  assert.equal(backgroundDetach.response.status, 202, backgroundDetach.text);
  assert.equal(backgroundDetach.payload.completeCacheContinuation?.state, 'running');
  assert.equal((await fetch(lastFollower.hlsUrl)).status, 401);

  const reattachedSpec = {
    attachmentId: crypto.randomUUID(),
    playbackSessionId: crypto.randomUUID(),
  };
  const reattached = await readJson(await fetch(
    `${gatewayBase}/sessions/${encodeURIComponent(producer.id)}/viewers`,
    {
      method: 'POST',
      headers: { ...serviceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...reattachedSpec, expiresAt: expiry }),
    },
  ));
  assert.equal(reattached.response.status, 201, `${reattached.text}\n${gatewayOutput.join('')}`);
  assert.equal(reattached.payload.liveJoin?.topologyValidated, true);
  assert.equal(reattached.payload.audioRenditions?.length, 2);
  assert.equal(reattached.payload.subtitleRenditions?.length, 1);
  assert.equal((await fetch(reattached.payload.hlsUrl)).status, 200);

  const finalDetach = await readJson(await fetch(
    `${gatewayBase}/sessions/${encodeURIComponent(producer.id)}` +
      `/viewers/${encodeURIComponent(reattachedSpec.attachmentId)}` +
      `?playbackSessionId=${encodeURIComponent(reattachedSpec.playbackSessionId)}`,
    { method: 'DELETE', headers: serviceHeaders },
  ));
  assert.equal(finalDetach.response.status, 200, finalDetach.text);
  assert.equal(finalDetach.payload.state, 'stopped');

  const finalHealth = await waitFor((value) => (
    value.activeSessions === 0 &&
    value.totalSessions === 0 &&
    value.videoEncoderCapacity.active === 0 &&
    value.vodInputPump.active === 0 &&
    value.finiteMkvSeekBroker.active === 0 &&
    value.rawPumpCount === 0 &&
    value.sharedMediaCache.liveJoin.activeViewers === 0 &&
    value.sharedMediaCache.backgroundContinuation.active === 0
  ), 'Gateway resources were not released');
  assert.equal(finalHealth.activeStrictLidBrokers, 0);
  assert.equal(providerRun.snapshot().providerGets, 1);
  assert.equal(providerRun.snapshot().activeGets, 0);
  assert.equal(workerRequests, 0);
  assert.ok(
    controlRequests.some((entry) => entry.body?.action === 'abandon'),
    'the one producer lease must be explicitly abandoned after the last viewer',
  );
});
