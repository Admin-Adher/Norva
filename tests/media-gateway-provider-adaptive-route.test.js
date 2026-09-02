'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeEngine = require('../services/media-gateway/src/providerAdaptiveRoute.js');

const fingerprintKey = Buffer.alloc(32, 0x5a);

function successfulMeasurement(overrides = {}) {
  return {
    success: true,
    ttfbMs: 250,
    first4MiBMs: 1_200,
    first16MiBMs: 4_500,
    throughputBytesPerSecond: 12 * routeEngine.MIB,
    varianceRatio: 0.08,
    rangeSeekOk: true,
    resets: 0,
    timeouts: 0,
    proxy407: 0,
    provider458: 0,
    http5xx: 0,
    ...overrides,
  };
}

test('candidate matrix separates Node transport while keeping FFmpeg on the matching HTTP slot', () => {
  const httpProxyUrls = Array.from({ length: 5 }, (_, index) => `http://proxy-${index + 1}`);
  const socksProxyUrls = Array.from({ length: 5 }, (_, index) => `socks5://proxy-${index + 1}`);
  const candidates = routeEngine.buildProviderRouteCandidates({ httpProxyUrls, socksProxyUrls });

  assert.equal(candidates.length, 10);
  assert.deepEqual(candidates.slice(0, 4), [
    { id: '1:http', slot: 1, nodeTransport: 'http', ffmpegTransport: 'http', ffmpegSlot: 1 },
    { id: '1:socks5', slot: 1, nodeTransport: 'socks5', ffmpegTransport: 'http', ffmpegSlot: 1 },
    { id: '2:http', slot: 2, nodeTransport: 'http', ffmpegTransport: 'http', ffmpegSlot: 2 },
    { id: '2:socks5', slot: 2, nodeTransport: 'socks5', ffmpegTransport: 'http', ffmpegSlot: 2 },
  ]);
  assert.throws(
    () => routeEngine.buildProviderRouteCandidates({ httpProxyUrls, socksProxyUrls: ['socks5://one'] }),
    /matching slots/i,
  );
});

test('route identity hashes the provider capability, never a commercial label or Norva user', () => {
  const firstMovie = routeEngine.providerRouteFingerprints(
    'https://PANEL.EXAMPLE:443/movie/alice%2Btv/p%40ss/41.mkv',
    fingerprintKey,
  );
  const secondMovie = routeEngine.providerRouteFingerprints(
    'https://panel.example/movie/alice%2Btv/p%40ss/99.mkv',
    fingerprintKey,
  );
  const rotatedPassword = routeEngine.providerRouteFingerprints(
    'https://panel.example/movie/alice%2Btv/other/99.mkv',
    fingerprintKey,
  );

  assert.match(firstMovie.accountFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(firstMovie.accountFingerprint, secondMovie.accountFingerprint);
  assert.equal(firstMovie.hostFingerprint, secondMovie.hostFingerprint);
  assert.notEqual(firstMovie.accountFingerprint, rotatedPassword.accountFingerprint);
  assert.equal(firstMovie.hostFingerprint, rotatedPassword.hostFingerprint);
  assert.deepEqual(Object.keys(firstMovie).sort(), [
    'accountFingerprint',
    'hostFingerprint',
    'protocol',
  ]);
  assert.throws(
    () => routeEngine.providerRouteFingerprints(firstMovie.accountFingerprint, Buffer.alloc(16)),
    /at least 32 bytes/i,
  );
});

test('route score rewards startup speed and stability, fails 407 closed, and does not rotate on one 458', () => {
  const fast = routeEngine.scoreProviderRouteMeasurement(successfulMeasurement());
  const slow = routeEngine.scoreProviderRouteMeasurement(successfulMeasurement({
    ttfbMs: 4_000,
    first4MiBMs: 12_000,
    first16MiBMs: 48_000,
    throughputBytesPerSecond: 1.2 * routeEngine.MIB,
    varianceRatio: 0.7,
  }));
  const one458 = routeEngine.scoreProviderRouteMeasurement(successfulMeasurement({ provider458: 1 }));
  const authFailure = routeEngine.scoreProviderRouteMeasurement(successfulMeasurement({ proxy407: 1 }));

  assert.ok(fast > slow, `${fast} should be greater than ${slow}`);
  assert.ok(one458 > slow, 'one account-busy response must not condemn an otherwise fast route');
  assert.equal(authFailure, 0);
});

test('account stickiness wins, then host learning, then deterministic fallback', () => {
  const candidates = routeEngine.buildProviderRouteCandidates({
    httpProxyUrls: ['http://one', 'http://two'],
    socksProxyUrls: ['socks5://one', 'socks5://two'],
  });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();

  assert.equal(routeEngine.selectInitialProviderRoute({
    candidates,
    accountState: { slot: 2, nodeTransport: 'socks5', expiresAt },
    hostRankings: [{ slot: 1, nodeTransport: 'http' }],
  }).id, '2:socks5');
  assert.equal(routeEngine.selectInitialProviderRoute({
    candidates,
    hostRankings: [{ slot: 1, nodeTransport: 'socks5' }],
  }).id, '1:socks5');
  assert.equal(routeEngine.selectInitialProviderRoute({ candidates, deterministicIndex: 5 }).id, '1:socks5');
});

test('hysteresis changes route only for expiry, repeated route failures, or sustained material gain', () => {
  const current = {
    slot: 1,
    nodeTransport: 'http',
    score: 70,
    confidence: 0.9,
    consecutiveFailures: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const transientWinner = {
    slot: 2,
    nodeTransport: 'socks5',
    score: 90,
    confidence: 0.9,
    consecutiveWins: 1,
  };
  assert.deepEqual(
    routeEngine.evaluateProviderRouteTransition({ current, candidate: transientWinner }).switch,
    false,
  );
  assert.equal(routeEngine.evaluateProviderRouteTransition({
    current,
    candidate: { ...transientWinner, consecutiveWins: 3 },
  }).reason, 'sustained-significant-gain');
  assert.equal(routeEngine.evaluateProviderRouteTransition({
    current: { ...current, consecutiveFailures: 3 },
    candidate: { ...transientWinner, score: 65 },
  }).reason, 'repeated-route-degradation');
  assert.equal(routeEngine.evaluateProviderRouteTransition({
    current: { ...current, expiresAt: new Date(Date.now() - 1_000).toISOString() },
    candidate: transientWinner,
  }).reason, 'current-expired');
});

test('benchmarks are strictly sequential and qualify finalists with two resume-range probes', async () => {
  const candidates = routeEngine.buildProviderRouteCandidates({
    httpProxyUrls: ['http://one', 'http://two'],
    socksProxyUrls: ['socks5://one', 'socks5://two'],
  });
  const observed = [];
  let active = 0;
  let maximumActive = 0;
  const result = await routeEngine.benchmarkProviderRoutesSequentially({
    candidates,
    isAccountIdle: async () => true,
    probe: async (candidate, options) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      observed.push(`${options.phase}:${candidate.id}:${options.sampleBytes}:${options.rangeStartBytes || 0}`);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      const rank = { '1:http': 4, '1:socks5': 1, '2:http': 3, '2:socks5': 2 }[candidate.id];
      return successfulMeasurement({
        ttfbMs: rank * 100,
        first4MiBMs: rank * 600,
        first16MiBMs: rank * 2_000,
        throughputBytesPerSecond: (6 - rank) * routeEngine.MIB,
        rangeStartBytes: options.rangeStartBytes || 0,
        resourceSizeBytes: 5 * 1024 * routeEngine.MIB,
      });
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(maximumActive, 1);
  assert.deepEqual(observed.slice(0, 4).map((entry) => entry.split(':').slice(0, 3).join(':')), [
    'tiny:1:http',
    'tiny:1:socks5',
    'tiny:2:http',
    'tiny:2:socks5',
  ]);
  assert.equal(observed.length, candidates.length + 2 + 4);
  assert.equal(observed.slice(4, 6).every((entry) => entry.startsWith('sustained:')), true);
  assert.equal(observed.slice(-4).every((entry) => entry.startsWith('resume-seek:')), true);
  assert.equal(observed.slice(-4).every((entry) => Number(entry.split(':').at(-1)) > 0), true);
  assert.ok(result.recommendation);
});

test('a route that is fast at byte zero is disqualified when a resumed range fails', async () => {
  const candidates = routeEngine.buildProviderRouteCandidates({
    httpProxyUrls: ['http://fast-prefix-bad-seek', 'http://slower-safe'],
  });
  const result = await routeEngine.benchmarkProviderRoutesSequentially({
    candidates,
    isAccountIdle: async () => true,
    probe: async (candidate, options) => {
      const brokenResume = candidate.id === '1:http' && options.phase === 'resume-seek';
      return successfulMeasurement({
        phase: options.phase,
        sampleBytes: options.sampleBytes,
        rangeStartBytes: options.rangeStartBytes || 0,
        resourceSizeBytes: 5 * 1024 * routeEngine.MIB,
        success: !brokenResume,
        rangeSeekOk: !brokenResume,
        timeouts: brokenResume ? 1 : 0,
        ttfbMs: candidate.id === '1:http' ? 50 : 250,
        first4MiBMs: options.phase === 'sustained' ? (candidate.id === '1:http' ? 500 : 1200) : null,
        first16MiBMs: options.phase === 'sustained' ? (candidate.id === '1:http' ? 2000 : 4500) : null,
      });
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.recommendation.id, '2:http');
  assert.equal(result.rankings.some((route) => route.id === '1:http'), false);
});

test('resume probes stay inside the strict persisted byte-offset contract', () => {
  const offsets = routeEngine.resumeSeekOffsets(
    1024 * 1024 * 1024 * 1024,
    routeEngine.MIB,
  );
  const maximumAlignedOffset = Math.floor(
    routeEngine.MAX_RESUME_RANGE_START_BYTES / routeEngine.MIB,
  ) * routeEngine.MIB;
  assert.equal(offsets.length, 2);
  assert.ok(offsets[0] > 0);
  assert.equal(offsets[1], maximumAlignedOffset);
  assert.ok(offsets.every((offset) => offset <= routeEngine.MAX_RESUME_RANGE_START_BYTES));
});

test('a real playback claim preempts the benchmark before another provider request starts', async () => {
  const candidates = routeEngine.buildProviderRouteCandidates({
    httpProxyUrls: ['http://one', 'http://two'],
  });
  let idleChecks = 0;
  let probeCalls = 0;
  const result = await routeEngine.benchmarkProviderRoutesSequentially({
    candidates,
    isAccountIdle: async () => ++idleChecks === 1,
    probe: async () => {
      probeCalls += 1;
      return successfulMeasurement();
    },
  });

  assert.equal(result.status, 'preempted');
  assert.equal(probeCalls, 1);
});

test('adaptive route source contains no supplier-specific exception', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '../services/media-gateway/src/providerAdaptiveRoute.js',
  ), 'utf8');
  for (const forbidden of ['KING365', 'GOTV', 'STRNG', 'Promax', 'Opplex', 'Airysat']) {
    assert.equal(source.includes(forbidden), false, `route engine must not name ${forbidden}`);
  }
});
