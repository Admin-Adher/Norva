'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
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
      ? resolve(stderr)
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

async function createExactMkvFixture(ffmpeg, root, sparseSubtitles = false) {
  const sourcePath = path.join(root, 'source.mkv');
  const subtitlePath = path.join(root, 'sparse.srt');
  if (sparseSubtitles) await fsp.writeFile(subtitlePath,
    '1\n00:00:14,000 --> 00:00:15,000\nFirst cue\n\n2\n00:01:05,000 --> 00:01:06,000\nFuture cue\n\n');
  await run(ffmpeg, ['-hide_banner','-nostdin','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=120',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=120',
    ...(sparseSubtitles ? ['-i',subtitlePath] : []),
    '-map','0:v:0','-map','1:a:0',...(sparseSubtitles ? ['-map','2:0','-c:s','srt'] : []),
    '-c:v','libx264','-threads','1','-preset','ultrafast',
    '-pix_fmt','yuv420p','-g','48','-keyint_min','48','-sc_threshold','0',
    '-c:a','aac','-b:a','96k','-ac','2','-disposition:a:0','default',sourcePath]);
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

for (const validator of ['strong', 'absent', 'absent-sparse-subtitles']) test(`an abandoned complete-cache producer with ${validator} keeps eligible private data and revalidates it before resume`, {
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
  const sparseSubtitles = validator === 'absent-sparse-subtitles';
  const sourcePath = await createExactMkvFixture(ffmpeg, root, sparseSubtitles);
  const sourceStat = await fsp.stat(sourcePath);
  const probe = JSON.parse(execFileSync(ffprobe, ['-v','error','-show_streams','-show_format','-of','json',sourcePath]));
  const video = probe.streams.find(s => s.codec_type === 'video');
  const [rateNumerator,rateDenominator] = video.r_frame_rate.split('/').map(Number);

  const provider = new ProviderSimulator({ fixtureRoot: root });
  const providerServer = http.createServer((request, response) => {
    if (validator !== 'strong') {
      const setHeader = response.setHeader.bind(response);
      response.setHeader = (name, value) => ['etag','last-modified'].includes(name.toLowerCase())
        ? response : setHeader(name, value);
    }
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
    bandwidthBytesPerSecond: Math.max(64 * 1024, Math.floor(sourceStat.size / 30)),
    disconnectAfterBytes: 0,
    disconnectCount: 0,
    statusSequence: [],
  });
  t.after(() => providerRun.close());

  const gatewayToken = `gateway-${crypto.randomBytes(24).toString('hex')}`;
  const workerToken = `worker-${crypto.randomBytes(24).toString('hex')}`;
  const controlRequests = [];
  const publications = [];
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
    if (request.url === '/media-cache/publication') {
      publications.push(body);
      response.end(JSON.stringify({ ok: true, objectKey: body.object.objectKey, bindingId: crypto.randomUUID() }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  const controlBase = await listen(controlServer);
  t.after(() => closeServer(controlServer));

  const objects = new Map();
  const workerCalls = [];
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const workerServer = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${workerToken}`);
      const match = /^\/internal\/v1\/objects\/([A-Za-z0-9_-]+)$/.exec(request.url);
      assert.ok(match);
      const key = Buffer.from(match[1], 'base64url').toString('utf8');
      workerCalls.push({ method: request.method, key });
      if (request.method === 'PUT') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const digest = hash(body);
        assert.equal(digest, request.headers['x-norva-content-sha256']);
        assert.equal(request.headers['if-none-match'], '*');
        const old = objects.get(key);
        if (old) assert.ok(old.body.equals(body));
        objects.set(key, { body, digest, metadata: request.headers['x-norva-object-metadata'], type: request.headers['content-type'] });
        response.writeHead(old ? 200 : 201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, status: old ? 'already-exists' : 'created', key, sha256: digest, size: body.length }));
      } else {
        assert.equal(request.method, 'GET');
        const obj = objects.get(key);
        if (!obj) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': obj.type, 'content-length': obj.body.length, 'x-norva-content-sha256': obj.digest, 'x-norva-object-metadata': obj.metadata });
        response.end(obj.body);
      }
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  const workerBase = await listen(workerServer);
  t.after(() => closeServer(workerServer));

  const ownerKey = crypto.randomBytes(32).toString('hex');
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
      BOUNDED_HLS_OUTPUT_ENABLED: 'true',
      PRIVATE_RESUME_CACHE_ENABLED: 'true',
      PRIVATE_RESUME_RECENT_SAMPLES_ENABLED: 'true',
      PRIVATE_RESUME_RECENT_SAMPLES_OWNER_HASHES: ownerKey,
      WEAK_VALIDATOR_SPOOL_MIN_FREE_BYTES: '1073741824',
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
  const requestBody = {
      sourceUrl: providerRun.mediaUrl,
      playbackSessionId,
      ownerKey,
      mode: 'remux',
      expiresAt: expiry,
      playbackHint: { streamType: 'movie', container: 'mkv' },
      playbackIdentity: {
        sourceId: crypto.randomUUID(),
        sourceRevision: 'revision-1',
        itemType: 'movie',
        itemId: 'live-join-exact-mkv',
        variantId: crypto.randomUUID(),
      },
      codecProfile: {
        container: 'matroska,webm',
        metadataComplete: true,
        durationSeconds: 120,
        fileSizeBytes: sourceStat.size,
        videoStreamIndex: video.index,
        videoProfile: video.profile,
        videoLevel: video.level,
        videoPixelFormat: video.pix_fmt,
        videoFrameRateNumerator: rateNumerator,
        videoFrameRateDenominator: rateDenominator,
        videoCodec: video.codec_name,
        videoWidth: 320,
        videoHeight: 180,
        audioCodec: 'aac',
        audioChannels: 2,
        audioTracks: [
          { index: 1, language: 'eng', title: 'English', codec: 'aac', channels: 2, sampleRate: 48000, default: true },
        ],
        subtitles: sparseSubtitles ? [{ index:2, language:'eng', codec:'subrip', subtitleType:'text', extractable:true, default:true }] : [],
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
        admission: {
          mode: 'enforced', admitted: true, score: 90, confidence: 80,
          reason: 'popular', ttlSeconds: 2_592_000,
        },
      },
    };
  const producerResponse = await readJson(await fetch(`${gatewayBase}/sessions`, {
    method: 'POST', headers: { ...serviceHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }));
  assert.equal(
    producerResponse.response.status,
    201,
    `${producerResponse.text}\n${gatewayOutput.join('')}`,
  );
  const producer = producerResponse.payload;
  assert.equal(producer.startupTimings.retainedSharedCacheHlsOutput, true);
  assert.equal(producer.startupTimings.ffmpegSpawnCount, 1);
  const deadline = Date.now() + 25_000;
  const producerVideoUrl = sparseSubtitles
    ? new URL(`video.m3u8?token=${encodeURIComponent(playlistToken(producer.hlsUrl))}`,producer.hlsUrl).href : producer.hlsUrl;
  let text = '';
  while (Date.now() < deadline) {
    text = await (await fetch(producerVideoUrl)).text();
    const duration = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((n,m)=>n+Number(m[1]),0);
    if (duration >= 48) break;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  assert.ok([...text.matchAll(/#EXTINF:([0-9.]+)/g)].reduce((n,m)=>n+Number(m[1]),0) >= 48, text);
  assert.ok(!text.includes('#EXT-X-ENDLIST'), 'fixture must stop before EOF');
  assert.equal(providerRun.snapshot().providerGets, 1);
  const close = await readJson(await fetch(`${gatewayBase}/sessions/${producer.id}?resumePosition=4`,
    { method:'DELETE', headers:serviceHeaders }));
  assert.equal(close.response.status,200,close.text);
  const stopped = await waitFor(h=>h.activeSessions===0 && h.vodInputPump.active===0 && h.videoEncoderCapacity.active===0,'drain');
  assert.equal(stopped.privateResumeHlsCache.stores,sparseSubtitles ? 0 : 1,JSON.stringify(stopped.privateResumeHlsCache)+'\n'+gatewayOutput.join(''));
  assert.equal(stopped.privateResumeHlsCache.inputStores,sparseSubtitles ? 1 : 0);
  assert.equal(stopped.sharedMediaCache.stats.publications,0);
  assert.equal(publications.length,0);
  assert.equal(workerCalls.length,0,'partial graph must never reach shared storage');
  assert.ok(controlRequests.some(r=>r.body.action==='abandon'));
  assert.equal(providerRun.snapshot().activeGets,0);
  assert.ok([401,404].includes((await fetch(producer.hlsUrl)).status));
  const resumeBody={...requestBody, playbackSessionId:crypto.randomUUID(), seekOffset:4};
  delete resumeBody.mediaCacheProducer;
  const reopened=await readJson(await fetch(`${gatewayBase}/sessions`,{method:'POST',
    headers:{...serviceHeaders,'Content-Type':'application/json'},body:JSON.stringify(resumeBody)}));
  assert.equal(reopened.response.status,201,reopened.text);
  if (sparseSubtitles) {
    assert.equal(reopened.payload.startupTimings.recentMultiAudioInputHit,true,JSON.stringify(reopened.payload.startupTimings));
    assert.ok(reopened.payload.startupTimings.recentMultiAudioInputSeededBytes>=2*1024*1024);
    assert.notEqual(reopened.payload.startupTimings.privateResumeWindowHit,true);
    assert.equal(reopened.payload.subtitleRenditions.length,1,'ordinary playback must preserve its subtitle lane');
  } else {
    assert.equal(reopened.payload.startupTimings.privateResumeWindowHit,true,JSON.stringify(reopened.payload.startupTimings));
    assert.ok(reopened.payload.startupTimings.privateResumeAheadSeconds>=24);
  }
  if (validator === 'absent') {
    assert.equal(reopened.payload.startupTimings.privateResumeValidationMode, 'sampled-recent-v1');
    assert.equal(reopened.payload.startupTimings.privateResumeInputSeededBytes || 0, 0, 'incomplete HTTP body is not a replayable input window');
  }
  assert.ok(providerRun.snapshot().maximumConcurrentProviderGets<=1);
  const playlist=await (await fetch(reopened.payload.hlsUrl)).text();
  if (!sparseSubtitles) assert.match(playlist,/resume-/);
  await run(ffmpeg,['-v','error','-xerror','-nostdin','-i',reopened.payload.hlsUrl,'-t','8','-f','null','-']);
  // Independent TS encoders reset transport continuity counters at the HLS
  // discontinuity. Validate codecs across that declared splice instead of
  // treating the transport counter reset as a fatal input-packet flag. The
  // PCM sink explicitly numbers decoded samples: this assertion checks codec
  // errors, NOT the source clock or audio continuity at the discontinuity.
  // Those still require the separate browser timing/playback replay.
  const decodedSeconds = sparseSubtitles ? 120 : 55;
  const decodeLog = await run(ffmpeg,['-v','error','-err_detect','explode','-nostdin','-y',
    '-i',reopened.payload.hlsUrl,'-map','0:v:0','-t',String(decodedSeconds),'-f','rawvideo','pipe:1',
    '-map','0:a:0','-af','asetpts=N/SR/TB','-t',String(decodedSeconds),'-f','s16le',os.devNull]);
  assert.equal(decodeLog.trim(), '', 'cached prefix and fresh continuation must decode without codec errors');
  if (sparseSubtitles) {
    const rendition = reopened.payload.subtitleRenditions[0];
    const subtitlePlaylist = new URL(rendition.playlistName, reopened.payload.hlsUrl);
    subtitlePlaylist.searchParams.set('token', playlistToken(reopened.payload.hlsUrl));
    let cues = '';
    const cueDeadline = Date.now() + 10_000;
    while (Date.now() < cueDeadline) {
      const subtitleText = await (await fetch(subtitlePlaylist)).text();
      const segments = subtitleText.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
      cues = '';
      for (const segment of segments) {
        const url = new URL(segment, subtitlePlaylist);
        url.searchParams.set('token', playlistToken(reopened.payload.hlsUrl));
        const response = await fetch(url);
        assert.equal(response.status, 200);
        cues += await response.text();
      }
      if (cues.includes('Future cue')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(cues, /First cue/);
    assert.match(cues, /Future cue/, 'a later sparse subtitle must survive private input replay');
  }
  await fetch(`${gatewayBase}/sessions/${reopened.payload.id}`,{method:'DELETE',headers:serviceHeaders});
  await waitFor(h=>h.activeSessions===0 && h.vodInputPump.active===0 && h.videoEncoderCapacity.active===0,'final drain');
  assert.equal(providerRun.snapshot().activeGets,0);
  t.diagnostic(JSON.stringify({privateWindowStored:!sparseSubtitles,privateWindowHit:!sparseSubtitles,privateInputHit:sparseSubtitles,decodedSeconds,partialSharedPublications:publications.length,
    maximumConcurrentProviderGets:providerRun.snapshot().maximumConcurrentProviderGets,aheadSeconds:reopened.payload.startupTimings.privateResumeAheadSeconds}));
});
