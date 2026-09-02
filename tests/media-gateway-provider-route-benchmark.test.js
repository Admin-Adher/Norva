'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MEASUREMENT_KEYS,
  measureProviderRoute,
  normalizePolicy,
  runLeasedProviderRouteBenchmark,
  serializableMeasurements,
} = require('../services/media-gateway/src/providerRouteBenchmark');

function byteStream(chunks) {
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (!chunk) return controller.close();
      controller.enqueue(chunk);
    },
  });
}

test('route probe reads one bounded byte range and closes its isolated dispatcher', async () => {
  const requests = [];
  let closed = 0;
  const measurement = await measureProviderRoute({
    candidate: { slot: 2, nodeTransport: 'socks5' },
    sourceUrl: 'https://provider.invalid/movie/account/secret/42.mkv',
    sampleBytes: 1024 * 1024,
    createDispatcher: () => ({ close: async () => { closed += 1; } }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(byteStream([
        new Uint8Array(512 * 1024),
        new Uint8Array(512 * 1024),
      ]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-1048575/99999999' },
      });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.range, 'bytes=0-1048575');
  assert.equal(requests[0].options.redirect, 'follow');
  assert.equal(measurement.success, true);
  assert.equal(measurement.rangeSeekOk, true);
  assert.equal(measurement.rangeStartBytes, 0);
  assert.equal(measurement.sampleBytes, 1024 * 1024);
  assert.ok(measurement.throughputBytesPerSecond > 0);
  assert.equal(closed, 1);
});

test('route probe validates the exact non-zero byte range used by resumed playback', async () => {
  const requests = [];
  const rangeStartBytes = 64 * 1024 * 1024;
  const measurement = await measureProviderRoute({
    candidate: { slot: 3, nodeTransport: 'http' },
    sourceUrl: 'https://provider.invalid/movie/account/secret/42.mkv',
    sampleBytes: 1024 * 1024,
    rangeStartBytes,
    createDispatcher: () => ({ close: async () => {} }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(byteStream([new Uint8Array(1024 * 1024)]), {
        status: 206,
        headers: {
          'content-range': `bytes ${rangeStartBytes}-${rangeStartBytes + 1024 * 1024 - 1}/5368709120`,
        },
      });
    },
  });
  assert.equal(requests[0].options.headers.range, `bytes=${rangeStartBytes}-${rangeStartBytes + 1024 * 1024 - 1}`);
  assert.equal(measurement.rangeStartBytes, rangeStartBytes);
  assert.equal(measurement.rangeSeekOk, true);
  assert.equal(measurement.resourceSizeBytes, 5368709120);
  assert.equal(measurement.success, true);
});

test('route probe rejects a provider that answers a deep request with the wrong byte range', async () => {
  const measurement = await measureProviderRoute({
    candidate: { slot: 3, nodeTransport: 'http' },
    sourceUrl: 'https://provider.invalid/movie/account/secret/42.mkv',
    sampleBytes: 1024 * 1024,
    rangeStartBytes: 64 * 1024 * 1024,
    createDispatcher: () => ({ close: async () => {} }),
    fetchImpl: async () => new Response(byteStream([new Uint8Array(1024 * 1024)]), {
      status: 206,
      headers: { 'content-range': 'bytes 0-1048575/5368709120' },
    }),
  });
  assert.equal(measurement.success, true);
  assert.equal(measurement.rangeSeekOk, false);
});

test('route probe rejects a short body that only pretends to satisfy an 8 MiB sample', async () => {
  const sampleBytes = 8 * 1024 * 1024;
  const measurement = await measureProviderRoute({
    candidate: { slot: 3, nodeTransport: 'http' },
    sourceUrl: 'https://provider.invalid/movie/account/secret/42.mkv',
    sampleBytes,
    rangeStartBytes: 64 * 1024 * 1024,
    createDispatcher: () => ({ close: async () => {} }),
    fetchImpl: async () => new Response(byteStream([new Uint8Array(1024 * 1024)]), {
      status: 206,
      headers: { 'content-range': `bytes ${64 * 1024 * 1024}-${65 * 1024 * 1024 - 1}/5368709120` },
    }),
  });
  assert.equal(measurement.rangeSeekOk, false);
  assert.equal(measurement.success, false);
});

test('route probe classifies proxy auth and never exposes the response body', async () => {
  let cancelled = 0;
  const measurement = await measureProviderRoute({
    candidate: { slot: 1, nodeTransport: 'http' },
    sourceUrl: 'https://provider.invalid/movie/account/secret/42.mkv',
    sampleBytes: 1024 * 1024,
    createDispatcher: () => ({ close: async () => {} }),
    fetchImpl: async () => ({
      status: 407,
      headers: new Headers(),
      body: { cancel: async () => { cancelled += 1; } },
    }),
  });
  assert.equal(measurement.success, false);
  assert.equal(measurement.proxy407, 1);
  assert.equal(measurement.provider458, 0);
  assert.equal(cancelled, 1);
});

test('leased benchmark sweeps sequentially, reports bounded telemetry, then releases', async () => {
  const candidates = [
    { id: '1:http', slot: 1, nodeTransport: 'http' },
    { id: '1:socks5', slot: 1, nodeTransport: 'socks5' },
  ];
  const actions = [];
  let activeProbe = 0;
  let maximumActiveProbe = 0;
  const outcome = await runLeasedProviderRouteBenchmark({
    accountFingerprint: 'a'.repeat(64),
    hostFingerprint: 'b'.repeat(64),
    ownerInstanceFingerprint: 'c'.repeat(64),
    candidates,
    mediaDurationSeconds: 3_600,
    isAccountIdle: async () => true,
    control: async (action, payload) => {
      actions.push({ action, payload });
      if (action === 'claim') return {
        granted: true,
        leaseToken: '00000000-0000-4000-8000-000000000001',
        policy: { tinyProbeBytes: 262144, sustainedProbeBytes: 4194304, topCandidateCount: 1 },
      };
      if (action === 'pulse') return { active: true, preemptRequested: false };
      if (action === 'report') return { accepted: true, decision: { slot: 1, nodeTransport: 'http' } };
      return { released: true };
    },
    probe: async (candidate, context) => {
      activeProbe += 1;
      maximumActiveProbe = Math.max(maximumActiveProbe, activeProbe);
      await Promise.resolve();
      activeProbe -= 1;
      return {
        success: true,
        sampleBytes: context.sampleBytes,
        ttfbMs: candidate.nodeTransport === 'http' ? 20 : 40,
        first4MiBMs: context.phase === 'sustained' ? 500 : null,
        first16MiBMs: context.phase === 'sustained' ? 2000 : null,
        throughputBytesPerSecond: candidate.nodeTransport === 'http' ? 20_000_000 : 10_000_000,
        varianceRatio: 0.1,
        rangeSeekOk: true,
        rangeStartBytes: context.rangeStartBytes || 0,
        resourceSizeBytes: 512 * 1024 * 1024,
        resets: 0,
        timeouts: 0,
        proxy407: 0,
        provider458: 0,
        http5xx: 0,
      };
    },
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(maximumActiveProbe, 1);
  assert.deepEqual(actions.map((entry) => entry.action), [
    'claim', 'pulse', 'pulse', 'pulse', 'pulse', 'pulse', 'report', 'release',
  ]);
  const report = actions.find((entry) => entry.action === 'report').payload;
  assert.equal(report.measurements.length, 5);
  assert.equal(report.measurements.filter((entry) => entry.phase === 'resume-seek').length, 2);
  assert.equal(report.measurements.filter((entry) => entry.phase === 'resume-seek')
    .every((entry) => entry.rangeStartBytes > 0), true);
  assert.equal(JSON.stringify(report).includes('provider.invalid'), false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('distributed preemption stops before the next candidate and still releases', async () => {
  const actions = [];
  let pulses = 0;
  let probes = 0;
  const outcome = await runLeasedProviderRouteBenchmark({
    accountFingerprint: 'a'.repeat(64),
    hostFingerprint: 'b'.repeat(64),
    ownerInstanceFingerprint: 'c'.repeat(64),
    candidates: [
      { id: '1:http', slot: 1, nodeTransport: 'http' },
      { id: '2:http', slot: 2, nodeTransport: 'http' },
    ],
    isAccountIdle: async () => true,
    control: async (action) => {
      actions.push(action);
      if (action === 'claim') return { granted: true, leaseToken: 'lease', policy: {} };
      if (action === 'pulse') {
        pulses += 1;
        return pulses === 1
          ? { active: true, preemptRequested: false }
          : { active: false, preemptRequested: true };
      }
      return { released: true };
    },
    probe: async () => {
      probes += 1;
      return { success: true, throughputBytesPerSecond: 1_000_000, rangeSeekOk: true };
    },
  });
  assert.equal(outcome.status, 'preempted');
  assert.equal(probes, 1);
  assert.equal(actions.includes('report'), false);
  assert.equal(actions.at(-1), 'release');
});

test('lease polling aborts an in-flight provider read within its bounded interval', async () => {
  let pulses = 0;
  let providerReadAborted = false;
  const outcome = await runLeasedProviderRouteBenchmark({
    accountFingerprint: 'a'.repeat(64),
    hostFingerprint: 'b'.repeat(64),
    ownerInstanceFingerprint: 'c'.repeat(64),
    candidates: [{ id: '1:http', slot: 1, nodeTransport: 'http' }],
    pulseIntervalMs: 10,
    isAccountIdle: async () => true,
    control: async (action) => {
      if (action === 'claim') {
        return { granted: true, leaseToken: '00000000-0000-4000-8000-000000000001', policy: {} };
      }
      if (action === 'pulse') {
        pulses += 1;
        return pulses === 1
          ? { active: true, preemptRequested: false }
          : { active: false, preemptRequested: true };
      }
      return { released: true };
    },
    probe: async (_candidate, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        providerReadAborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  assert.equal(outcome.status, 'preempted');
  assert.equal(providerReadAborted, true);
  assert.ok(pulses >= 2);
});

test('serialized measurements have one strict non-secret schema', () => {
  const [value] = serializableMeasurements([{
    slot: 1,
    nodeTransport: 'http',
    phase: 'tiny',
    sampleBytes: 1024,
    rangeStartBytes: 0,
    success: true,
    sourceUrl: 'https://must-not-leak.invalid/secret',
  }]);
  assert.deepEqual(Object.keys(value), [...MEASUREMENT_KEYS]);
  assert.equal(Object.hasOwn(value, 'sourceUrl'), false);
});

test('benchmark policy preserves an explicit zero confidence threshold', () => {
  assert.equal(normalizePolicy({ minimumConfidence: 0 }).minimumConfidence, 0);
  assert.equal(normalizePolicy({ minimumConfidence: null }).minimumConfidence, 0.65);
  assert.equal(normalizePolicy({}).resumeProbeBytes, 8 * 1024 * 1024);
  assert.equal(normalizePolicy({}).realtimeThroughputMargin, 1.35);
});
