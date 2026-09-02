import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrivateMediaCacheStoreClient } = require('../../services/media-gateway/src/privateMediaCacheStoreClient');
const { SharedHlsObjectPublisher } = require('../../services/media-gateway/src/sharedHlsObjectPublisher');
const { deriveGlobalMediaCacheObjectKey } = require('../../services/media-gateway/src/mediaCacheIdentity');

function required(name, pattern = null) {
  const value = String(process.env[name] || '').trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`${name} is missing or invalid`);
  return value;
}

function enabled(name, fallback = false) {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  throw new Error(`${name} is invalid`);
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('non-canonical JSON value');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function createTicket(secretHex, objectKey) {
  const nowMs = Date.now();
  const payload = {
    bindingId: crypto.randomUUID(),
    expiresAtMs: nowMs + 120_000,
    issuedAtMs: nowMs,
    nonce: crypto.randomBytes(16).toString('base64url'),
    objectKey,
    playbackSessionId: crypto.randomUUID(),
    schema: 1,
  };
  const encoded = Buffer.from(canonicalJson(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`norva-media-cache-ticket-v1\0${encoded}`)
    .digest('base64url');
  return { token: `mc1.${encoded}.${signature}`, playbackSessionId: payload.playbackSessionId };
}

async function responseJson(response, label) {
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (_) { /* asserted below */ }
  if (!response.ok) {
    const code = payload && typeof payload.code === 'string' ? payload.code : 'UNKNOWN';
    throw new Error(`${label} failed with HTTP ${response.status} (${code})`);
  }
  return payload;
}

async function waitForHealth(baseUrl, serviceToken, attempts = 30) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(new URL('/health', baseUrl), {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return response.json();
      last = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 500 * attempt)));
  }
  throw new Error(`media-cache canary did not become healthy: ${last?.message || 'unknown error'}`);
}

function canaryIdentity(runId) {
  return {
    contentSha256: crypto.createHash('sha256').update(`norva-media-cache-canary\0${runId}`).digest('hex'),
    fileSizeBytes: 16_777_216,
    videoProfile: {
      streamIndex: 0,
      codec: 'h264',
      profile: 'high',
      level: 41,
      width: 1920,
      height: 1080,
      pixelFormat: 'yuv420p',
      frameRateNumerator: 25,
      frameRateDenominator: 1,
    },
    audioTopology: [
      { streamIndex: 1, codec: 'aac', language: 'eng', channels: 2, sampleRate: 48_000, title: 'English', default: true, forced: false },
    ],
    subtitleTopology: [
      { streamIndex: 2, codec: 'webvtt', language: 'fra', title: 'Francais', default: false, forced: false, hearingImpaired: false },
    ],
    durationMilliseconds: 7_200_000,
    pipelineBuild: 'cloudflare-canary-h264-aac-v1',
    segmenterBuild: 'cloudflare-canary-hls-v1',
  };
}

async function writeFixture(directory) {
  const files = {
    'index.m3u8': [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,URI="audio_0.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Francais",LANGUAGE="fra",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="sub_0.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3200000,CODECS="avc1.640029,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"',
      'video.m3u8',
      '',
    ].join('\n'),
    'video.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment-000.ts\n#EXT-X-ENDLIST\n',
    'segment-000.ts': Buffer.from('norva-canary-video-segment-v1'),
    'audio_0.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\naudio_0_000.ts\n#EXT-X-ENDLIST\n',
    'audio_0_000.ts': Buffer.from('norva-canary-audio-segment-v1'),
    'sub_0.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsub_0_000.vtt\n#EXT-X-ENDLIST\n',
    'sub_0_000.vtt': Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.500\nCanary subtitle\n'),
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(directory, name), body);
  return Object.keys(files);
}

async function purgeObject(baseUrl, serviceToken, objectKey, reason = 'eviction') {
  return fetch(new URL(`/internal/v1/cache-objects/${objectKey}`, baseUrl), {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${serviceToken}`,
      'x-norva-purge-reason': reason,
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function recoverObject(baseUrl, serviceToken, objectKey, phase) {
  return responseJson(await fetch(new URL(`/internal/v1/recoveries/${objectKey}`, baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceToken}`,
      'x-norva-recovery-phase': phase,
    },
    signal: AbortSignal.timeout(30_000),
  }), `recovery ${phase}`);
}

const baseUrl = new URL(required('MEDIA_CACHE_CANARY_BASE_URL'));
const serviceToken = required('MEDIA_CACHE_CANARY_SERVICE_TOKEN', /^.{32,}$/);
const manifestKey = required('MEDIA_CACHE_CANARY_MANIFEST_HMAC_KEY', /^[0-9a-f]{64}$/i);
const ticketKey = required('MEDIA_CACHE_CANARY_TICKET_HMAC_KEY', /^[0-9a-f]{64}$/i);
const runId = required('MEDIA_CACHE_CANARY_RUN_ID', /^[A-Za-z0-9._-]{1,128}$/);
const requireGlobalPurge = enabled('MEDIA_CACHE_CANARY_REQUIRE_GLOBAL_PURGE', false);
const cleanupOnly = enabled('MEDIA_CACHE_CANARY_CLEANUP_ONLY', false);
const healthAttempts = boundedInteger('MEDIA_CACHE_CANARY_HEALTH_ATTEMPTS', 30, 1, 60);
const expectedHost = String(process.env.MEDIA_CACHE_CANARY_EXPECT_HOST || '').trim().toLowerCase();
if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== '127.0.0.1' && baseUrl.hostname !== 'localhost') {
  throw new Error('canary base URL must use HTTPS');
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('canary base URL is not canonical');
if (expectedHost && baseUrl.hostname.toLowerCase() !== expectedHost) throw new Error('canary host does not match the isolated target');

const identity = canaryIdentity(runId);
const objectIdentity = deriveGlobalMediaCacheObjectKey(identity);
const objectKey = objectIdentity.key;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-media-cache-canary-'));
const files = await writeFixture(directory);
const store = new PrivateMediaCacheStoreClient({
  baseUrl: baseUrl.toString(),
  serviceToken,
  retryDelaysMs: [100, 300, 1_000],
  timeoutMs: 30_000,
});
const publisher = new SharedHlsObjectPublisher({
  objectStore: store,
  manifestHmacKey: manifestKey,
  ttlMs: 60 * 60 * 1000,
  maxFiles: 64,
  maxEntryBytes: 16 * 1024 * 1024,
});

async function publishFixture() {
  return publisher.publish({
    identity,
    sourceDirectory: directory,
    rootPlaylist: 'index.m3u8',
    files,
    completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
  });
}

async function cleanup() {
  try {
    await publishFixture();
    const verify = await fetch(new URL(`/internal/v1/recoveries/${objectKey}`, baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'x-norva-recovery-phase': 'verify' },
      signal: AbortSignal.timeout(30_000),
    });
    if (verify.ok) await recoverObject(baseUrl, serviceToken, objectKey, 'commit');
  } catch (_) {
    // A clean or never-quarantined object needs no recovery before eviction.
  }
  const purge = await purgeObject(baseUrl, serviceToken, objectKey, 'eviction');
  if (!purge.ok) {
    const payload = await purge.text();
    throw new Error(`canary cleanup failed with HTTP ${purge.status}: ${payload.slice(0, 160)}`);
  }
}

try {
  await waitForHealth(baseUrl, serviceToken, healthAttempts);
  if (cleanupOnly) {
    await cleanup();
    process.stdout.write(`${JSON.stringify({ ok: true, protocol: 1, cleanupOnly: true, objectKey })}\n`);
  } else {
    const health = await responseJson(await fetch(new URL('/health', baseUrl), {
      signal: AbortSignal.timeout(10_000),
    }), 'health');
    if (!health.objectStoreConfigured
      || !health.gatewayAuthConfigured
      || !health.manifestAuthConfigured
      || !health.ticketAuthConfigured
      || !health.sharedEdgeCacheConfigured) {
      throw new Error('canary Worker is not fully configured');
    }
    if (requireGlobalPurge && !health.globalEdgePurgeConfigured) {
      throw new Error('global Cloudflare tag purge is not configured');
    }

    const publication = await publishFixture();
    if (publication.objectKey !== objectKey || publication.fileCount !== files.length) {
      throw new Error('publication identity mismatch');
    }
    const ticket = createTicket(ticketKey, objectKey);
    const headers = { authorization: `Bearer ${ticket.token}`, origin: 'https://norva.tv' };
    const rootUrl = new URL(`/v1/hls/${objectKey}/index.m3u8`, baseUrl);
    const anonymous = await fetch(rootUrl, { signal: AbortSignal.timeout(10_000) });
    if (anonymous.status !== 401) throw new Error(`anonymous read returned HTTP ${anonymous.status}`);

    const root = await fetch(rootUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (!root.ok || root.headers.get('cache-control') !== 'private, no-store') throw new Error('private root playlist delivery failed');
    const rootText = await root.text();
    if (!rootText.includes('TYPE=AUDIO') || !rootText.includes('TYPE=SUBTITLES')) throw new Error('exact track topology was not preserved');

    const segmentUrl = new URL(`/v1/hls/${objectKey}/segment-000.ts`, baseUrl);
    const cold = await fetch(segmentUrl, { headers, signal: AbortSignal.timeout(10_000) });
    const coldBody = Buffer.from(await cold.arrayBuffer());
    if (!cold.ok || cold.headers.get('x-norva-cache-layer') !== 'r2'
      || coldBody.toString() !== 'norva-canary-video-segment-v1') {
      throw new Error('cold R2 delivery proof failed');
    }
    let hotLayer = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const hot = await fetch(segmentUrl, { headers, signal: AbortSignal.timeout(10_000) });
      const hotBody = Buffer.from(await hot.arrayBuffer());
      hotLayer = hot.headers.get('x-norva-cache-layer');
      if (!hot.ok || hotBody.toString() !== 'norva-canary-video-segment-v1') throw new Error('hot delivery bytes changed');
      if (hotLayer === 'cdn') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (hotLayer !== 'cdn') throw new Error('shared CDN cache did not produce a hot hit');

    const audio = await fetch(new URL(`/v1/hls/${objectKey}/audio_0_000.ts`, baseUrl), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!audio.ok || Buffer.from(await audio.arrayBuffer()).toString() !== 'norva-canary-audio-segment-v1') {
      throw new Error('audio rendition delivery failed');
    }
    const subtitle = await fetch(new URL(`/v1/hls/${objectKey}/sub_0_000.vtt`, baseUrl), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!subtitle.ok || !(await subtitle.text()).includes('Canary subtitle')) throw new Error('subtitle rendition delivery failed');

    let purgeProof = null;
    let recovered = false;
    if (requireGlobalPurge) {
      purgeProof = await responseJson(await purgeObject(baseUrl, serviceToken, objectKey, 'corruption'), 'corruption purge');
      if (!purgeProof.globalEdgePurgeConfigured || !purgeProof.globalEdgePurgeCompleted) {
        throw new Error('global Cloudflare tag purge did not complete');
      }
      const quarantined = await fetch(segmentUrl, { headers, signal: AbortSignal.timeout(10_000) });
      const quarantinedPayload = await quarantined.json().catch(() => null);
      if (quarantined.status !== 503 || quarantinedPayload?.code !== 'OBJECT_QUARANTINED') {
        throw new Error('corruption quarantine did not fence delivery');
      }
      await publishFixture();
      const verification = await recoverObject(baseUrl, serviceToken, objectKey, 'verify');
      if (verification.status !== 'verified-quarantined') throw new Error('recovery verification failed');
      const commit = await recoverObject(baseUrl, serviceToken, objectKey, 'commit');
      if (commit.status !== 'ready') throw new Error('recovery commit failed');
      const restored = await fetch(segmentUrl, { headers, signal: AbortSignal.timeout(10_000) });
      if (!restored.ok || Buffer.from(await restored.arrayBuffer()).toString() !== 'norva-canary-video-segment-v1') {
        throw new Error('recovered delivery failed');
      }
      recovered = true;
    }

    const finalPurge = await responseJson(await purgeObject(baseUrl, serviceToken, objectKey, 'eviction'), 'final eviction');
    if (requireGlobalPurge && (!finalPurge.globalEdgePurgeConfigured || !finalPurge.globalEdgePurgeCompleted)) {
      throw new Error('final global Cloudflare tag purge did not complete');
    }
    const metrics = await responseJson(await fetch(new URL('/internal/v1/metrics', baseUrl), {
      headers: { authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(10_000),
    }), 'metrics');
    const serializedMetrics = JSON.stringify(metrics);
    if (serializedMetrics.includes(serviceToken) || serializedMetrics.includes(ticket.token)) {
      throw new Error('metrics exposed an authentication secret');
    }
    // Cloudflare does not guarantee isolate affinity between requests. The
    // response headers above are the live layer proof; isolate-local counters
    // may legitimately be zero when this request reaches another isolate.
    const layerMetricValues = [
      metrics.layers?.cdn?.hits,
      metrics.layers?.cdn?.misses,
      metrics.layers?.cdn?.failures,
      metrics.layers?.cdn?.bytes,
      metrics.layers?.r2?.hits,
      metrics.layers?.r2?.misses,
      metrics.layers?.r2?.failures,
      metrics.layers?.r2?.bytes,
    ];
    if (metrics.protocol !== 1 || layerMetricValues.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error('cache layer metrics schema is incomplete');
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      protocol: 1,
      host: baseUrl.hostname,
      objectKey,
      files: files.length,
      coldLayer: 'r2',
      hotLayer: 'cdn',
      audio: true,
      subtitles: true,
      anonymousDenied: true,
      globalTagPurge: Boolean(purgeProof?.globalEdgePurgeCompleted || finalPurge.globalEdgePurgeCompleted),
      corruptionRecovered: recovered,
      finalObjectsPurged: finalPurge.objectsPurged,
      secretFreeMetrics: true,
    })}\n`);
  }
} finally {
  if (!cleanupOnly) await cleanup();
  await fs.rm(directory, { recursive: true, force: true });
}
