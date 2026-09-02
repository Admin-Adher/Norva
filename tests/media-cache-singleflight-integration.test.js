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
const { PrivateR2Simulator } = require('../services/media-lab-runner/src/r2-object-store-simulator');
const { SharedHlsCacheLab } = require('../services/media-lab-runner/src/shared-cache-lab');
const { runSharedCacheSingleflightCase } = require(
  '../services/media-lab-runner/src/shared-cache-singleflight-runner',
);

function locateFfmpeg() {
  const explicit = String(process.env.MEDIA_LAB_TEST_FFMPEG_PATH || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  try {
    const bundled = require('ffmpeg-static');
    return bundled && fs.existsSync(bundled) ? bundled : null;
  } catch (_) {
    return null;
  }
}

function runFfmpeg(binary, args, onSpawn = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    onSpawn(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`MEDIA_LAB_FFMPEG_FAILED:${code}:${stderr}`)));
  });
}

async function readHlsAssets(root) {
  const names = (await fsp.readdir(root)).filter((name) => /\.(?:m3u8|ts)$/i.test(name)).sort();
  const assets = {};
  for (const name of names) assets[name] = await fsp.readFile(path.join(root, name));
  return assets;
}

test('ten concurrent cold viewers share one real provider lane, one FFmpeg and one private HLS object', async (t) => {
  const ffmpeg = locateFfmpeg();
  if (!ffmpeg) {
    t.skip('local FFmpeg binary is unavailable');
    return;
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-singleflight-e2e-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.mkv');
  const hlsRoot = path.join(root, 'hls');
  const r2Root = path.join(root, 'r2');
  await fsp.mkdir(hlsRoot, { recursive: true });

  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=4',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '2', '-shortest', sourcePath,
  ]);

  const provider = new ProviderSimulator({ fixtureRoot: root });
  const server = http.createServer((request, response) => {
    provider.handle(request, response).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.statusCode = 404;
        response.end('not found');
      }
    }).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  const providerRun = await provider.openFixture({
    id: 'singleflight-e2e',
    assetFile: 'source.mkv',
    provider: {
      assetRequired: true,
      etag: 'strong',
      delayMs: 0,
      bandwidthBytesPerSecond: 0,
      disconnectAfterBytes: 0,
      disconnectCount: 0,
      statusSequence: [],
    },
  }, `http://127.0.0.1:${server.address().port}/`);
  t.after(() => providerRun.close());

  const objectStore = new PrivateR2Simulator({ root: r2Root });
  const cache = new SharedHlsCacheLab({ objectStore });
  const sourceBody = await fsp.readFile(sourcePath);
  const contentKey = crypto.createHash('sha256').update(sourceBody).digest('hex');
  let ffmpegSpawns = 0;

  const evidence = await runSharedCacheSingleflightCase({
    clientCount: 10,
    timeoutMs: 30_000,
    pollMs: 25,
    produce: async () => {
      await runFfmpeg(ffmpeg, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-i', providerRun.mediaUrl,
        '-map', '0:v:0', '-map', '0:a:0',
        '-c', 'copy',
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(hlsRoot, 'segment-%03d.ts'),
        path.join(hlsRoot, 'playlist.m3u8'),
      ], () => { ffmpegSpawns += 1; });
      await cache.publishComplete({
        contentKey,
        rootPlaylist: 'playlist.m3u8',
        assets: await readHlsAssets(hlsRoot),
        sourceEof: true,
        ffmpegExitCode: 0,
      });
      return contentKey;
    },
    consume: async ({ clientIndex, objectKey }) => {
      const identity = {
        tenantId: `tenant-${clientIndex}`,
        sourceId: `source-${clientIndex}`,
        variantId: `variant-${clientIndex}`,
      };
      cache.setSourceState({ ...identity, enabled: true, visible: true });
      cache.bind({ ...identity, contentKey: objectKey });
      const grant = await cache.authorize(identity);
      const playlist = (await grant.readAsset('playlist.m3u8')).toString('utf8');
      const firstSegment = playlist.split(/\r?\n/).find((line) => line && !line.startsWith('#'));
      assert.ok(firstSegment, 'published playlist must reference a media segment');
      assert.ok((await grant.readAsset(firstSegment)).length > 0);
      return true;
    },
  });

  const providerCounters = providerRun.snapshot();
  assert.equal(evidence.producerRuns, 1);
  assert.equal(evidence.leaderCount, 1);
  assert.equal(evidence.readyFollowerCount, 9);
  assert.equal(evidence.results.every((result) => result.consumed === true), true);
  assert.equal(ffmpegSpawns, 1);
  assert.equal(providerCounters.maximumConcurrentProviderGets, 1);
  assert.equal(providerCounters.activeGets, 0);
  assert.equal(evidence.authority.followers, 0);
  assert.equal(cache.snapshot().readyObjects, 1);
  assert.equal(cache.snapshot().bindings, 10);
});
