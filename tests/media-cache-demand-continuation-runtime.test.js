'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ProviderSimulator } = require('../services/media-lab-runner/src/provider-simulator');
const {
  MediaCacheProducerControl,
} = require('../services/media-gateway/src/mediaCacheProducerControl');

const PRODUCER_CONTEXT = Object.freeze({
  protocol: 1,
  workFingerprint: 'ab'.repeat(32),
  accountFingerprint: 'cd'.repeat(32),
  leaseToken: '11111111-1111-4111-8111-111111111111',
  ownerInstanceFingerprint: 'ef'.repeat(32),
});

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

function runFfmpeg(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`MEDIA_LAB_FFMPEG_FAILED:${code}:${stderr}`)));
  });
}

function launchProducer(binary, mediaUrl) {
  const child = spawn(binary, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', mediaUrl,
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
    '-f', 'null', '-',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, shell: false });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

function stopProducer(producer) {
  if (!producer?.child || producer.child.exitCode !== null || producer.child.signalCode) {
    return producer?.exited || Promise.resolve();
  }
  producer.child.kill('SIGTERM');
  return producer.exited;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('demand keeps the detached producer alive, zero demand stops it, and a new viewer preempts before reconnecting', async (t) => {
  const ffmpeg = locateFfmpeg();
  if (!ffmpeg) {
    t.skip('local FFmpeg binary is unavailable');
    return;
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-continuation-e2e-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.mkv');
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=12',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-c:a', 'aac', '-ac', '2', '-shortest', sourcePath,
  ]);

  const provider = new ProviderSimulator({ fixtureRoot: root });
  const providerServer = http.createServer((request, response) => {
    provider.handle(request, response).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.statusCode = 404;
        response.end();
      }
    }).catch(() => response.destroy());
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    providerServer.closeAllConnections?.();
    providerServer.close(() => resolve());
  }));
  const providerRun = await provider.openFixture({
    id: 'continuation-e2e',
    assetFile: 'source.mkv',
    provider: {
      assetRequired: true,
      etag: 'strong',
      delayMs: 0,
    },
  }, `http://127.0.0.1:${providerServer.address().port}/`, {
    delayMs: 0,
    bandwidthBytesPerSecond: 96 * 1024,
    disconnectAfterBytes: 0,
    disconnectCount: 0,
    statusSequence: [],
  });
  t.after(() => providerRun.close());

  const demand = { followers: 1, preempt: false };
  const controlRequests = [];
  const controlServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    controlRequests.push(body);
    const state = demand.preempt ? 'preempted' : (demand.followers > 0 ? 'renewed' : 'idle');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ protocol: 1, state }));
  });
  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => controlServer.close(() => resolve())));

  let activeProducer = null;
  const session = {
    id: '22222222-2222-4222-8222-222222222222',
    playbackSessionId: '33333333-3333-4333-8333-333333333333',
    status: 'ready',
    backgroundCacheContinuation: false,
  };
  const control = new MediaCacheProducerControl({
    edgeBase: `http://127.0.0.1:${controlServer.address().port}`,
    gatewayToken: 'g'.repeat(32),
    initialDelayMs: 60_000,
    onPreempt: async (current) => {
      await stopProducer(activeProducer);
      current.status = 'ended';
    },
  });
  control.attach(session, PRODUCER_CONTEXT);
  activeProducer = launchProducer(ffmpeg, providerRun.mediaUrl);
  t.after(() => stopProducer(activeProducer).catch(() => {}));
  assert.equal(await waitFor(() => providerRun.snapshot().activeGets === 1), true);
  const originalPid = activeProducer.child.pid;

  // The first viewer has left, but one registered follower still wants this
  // exact work. The detached session must keep the same socket and FFmpeg.
  session.backgroundCacheContinuation = true;
  assert.equal(await control.pulse(session, 'producing'), 'renewed');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(activeProducer.child.pid, originalPid);
  assert.equal(activeProducer.child.exitCode, null);
  assert.equal(providerRun.snapshot().activeGets, 1);

  // Once the final follower leaves, the very next demand pulse stops both
  // owners instead of finishing an unrequested catalogue-wide prefill.
  demand.followers = 0;
  assert.equal(await control.pulse(session, 'producing'), 'idle');
  assert.equal(session.status, 'ended');
  assert.equal(await waitFor(() => providerRun.snapshot().activeGets === 0), true);
  assert.equal(control.publicStatus().demandStops, 1);

  // Start a second detached fill, then let a real foreground request preempt it.
  assert.equal(providerRun.resetCounters(), true);
  demand.followers = 1;
  demand.preempt = false;
  const secondSession = {
    id: '44444444-4444-4444-8444-444444444444',
    playbackSessionId: '55555555-5555-4555-8555-555555555555',
    status: 'ready',
    backgroundCacheContinuation: true,
  };
  control.attach(secondSession, { ...PRODUCER_CONTEXT, leaseToken: '66666666-6666-4666-8666-666666666666' });
  activeProducer = launchProducer(ffmpeg, providerRun.mediaUrl);
  assert.equal(await waitFor(() => providerRun.snapshot().activeGets === 1), true);
  demand.preempt = true;
  assert.equal(await control.pulse(secondSession, 'producing'), 'preempted');
  assert.equal(await waitFor(() => providerRun.snapshot().activeGets === 0), true);

  const foreground = await fetch(providerRun.mediaUrl, { headers: { Range: 'bytes=0-65535' } });
  assert.equal(foreground.status, 206);
  assert.equal((await foreground.arrayBuffer()).byteLength, 65_536);
  assert.equal(providerRun.snapshot().maximumConcurrentProviderGets, 1);
  assert.equal(providerRun.snapshot().activeGets, 0);
  assert.equal(control.publicStatus().preemptions, 1);
  assert.deepEqual(controlRequests.map((request) => request.action), [
    'continuation-pulse',
    'continuation-pulse',
    'continuation-pulse',
  ]);
  control.detach(session);
  control.detach(secondSession);
});
