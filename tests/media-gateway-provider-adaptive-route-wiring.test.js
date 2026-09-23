'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gateway = fs.readFileSync(path.join(
  __dirname,
  '../services/media-gateway/src/index.js',
), 'utf8');

test('Gateway v166 keeps adaptive routing behind dedicated route and benchmark gates', () => {
  assert.match(gateway, /const GATEWAY_VERSION = 167;/);
  assert.match(gateway, /process\.env\.PROVIDER_ADAPTIVE_ROUTE_ENABLED === 'true'/);
  assert.match(gateway, /process\.env\.PROVIDER_ROUTE_BENCHMARK_ENABLED === 'true'/);
  assert.match(gateway, /process\.env\.PROVIDER_ROUTE_FINGERPRINT_HMAC_KEY/);
  assert.match(gateway, /function decodeProviderRouteFingerprintKey[\s\S]{0,180}\^\[a-f0-9\]\{64\}\$/);
  assert.doesNotMatch(
    gateway,
    /PROVIDER_ROUTE_FINGERPRINT_(HMAC_)?KEY\s*(?:\|\||\?\?)\s*GATEWAY_TOKEN/,
  );
  assert.match(gateway, /providerAdaptiveRoute: providerAdaptiveRouteControl\.publicStatus\(\)/);
  assert.match(gateway, /providerRouteBenchmark: providerRouteBenchmarkPublicStatus\(\)/);
});

test('Node chooses HTTP, forward or SOCKS5 without changing the child process account slot', () => {
  const vm = require('node:vm');
  const { useProviderHttpForward } = require('../services/media-gateway/src/provider-http-forward-policy');
  let transport = 'http';
  const context = {
    useProviderHttpForward, providerHttpForwardAccounts: new Set(),
    providerHttpForwardPolicy: { allCompatibleHttpMedia: true },
    providerProxyAgents: ['configured'], providerProxyUrls: ['configured'],
    providerHttpForwardAgents: ['forward-one', 'forward-two'],
    providerHttpProxyAgents: ['http-one', 'http-two'],
    providerSocksProxyAgents: ['socks-one', 'socks-two'],
    providerHttpProxyUrls: ['http://slot-one.invalid', 'http://slot-two.invalid'],
    providerSocksProxyUrls: ['socks5://slot-one.invalid', 'socks5://slot-two.invalid'],
    providerRouteForKey: key => { assert.equal(key, 'owned-account'); return { slot: 2, nodeTransport: transport }; },
    poolIndexForKey: key => { assert.equal(key, 'owned-account'); return 1; },
    createProviderProxyAgent: url => ({ url }), process: { env: {} },
  };
  const start = gateway.indexOf('function pickProxyAgent(');
  const end = gateway.indexOf('// A strict LID ffmpeg', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(gateway.slice(start, end), context);
  for (transport of ['http', 'socks5']) {
    assert.equal(context.pickProxyAgent('owned-account', 'https://provider.invalid/a.mp4'), transport === 'http' ? 'http-two' : 'socks-two');
    assert.equal(context.pickProxyAgent('owned-account', 'http://provider.invalid/a.mp4'), 'forward-two');
    assert.equal(context.pickProxyAgent('owned-account', 'http://provider.invalid/a.mkv'), transport === 'http' ? 'http-two' : 'socks-two');
    const pinned = context.pinnedProxyAgentFactory('owned-account');
    const expected = `${transport === 'http' ? 'http' : 'socks5'}://slot-two.invalid`;
    assert.equal(pinned().url, expected);
    assert.equal(pinned().url, expected);
    const child = context.proxyEnvFor('owned-account');
    for (const name of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) assert.equal(child[name], 'http://slot-two.invalid');
  }
});
test('complete cache hit avoids route control while every provider-backed session resolves before I/O', () => {
  const sessionRoute = gateway.slice(
    gateway.indexOf("app.post('/sessions'"),
    gateway.indexOf("app.get('/sessions/:id'"),
  );
  const cacheLookup = sessionRoute.indexOf('tryAcquireMkvCompleteHlsCache(cacheLookupSession)');
  const cacheMissGuard = sessionRoute.indexOf('if (!completeHlsCacheLookup.hit)', cacheLookup);
  const resolve = sessionRoute.indexOf('providerAdaptiveRouteControl.resolveForPlayback', cacheMissGuard);
  const providerCleanup = sessionRoute.indexOf('abortRawPumps(', resolve);
  assert.ok(cacheLookup >= 0 && cacheMissGuard > cacheLookup && resolve > cacheMissGuard);
  assert.ok(providerCleanup > resolve, 'route resolution and benchmark preemption must finish before provider cleanup/I/O');
  assert.match(sessionRoute, /adaptiveRouteLookupMs/);
  assert.match(sessionRoute, /adaptiveRouteControlStatus/);
});

test('raw playback preempts route benchmarking before freezing its one dispatcher', () => {
  const rawRoute = gateway.slice(
    gateway.indexOf("app.get('/raw/:token'"),
    gateway.indexOf("app.post('/raw-pumps'"),
  );
  const localPreemption = rawRoute.indexOf('preemptBackgroundWorkGlobally(');
  const routeResolution = rawRoute.indexOf('providerAdaptiveRouteControl.resolveForPlayback');
  const dispatcherFreeze = rawRoute.indexOf('const rawProxyAgent = pickProxyAgent(pumpProxyKey, claims.url)');
  assert.ok(localPreemption >= 0 && routeResolution > localPreemption && dispatcherFreeze > routeResolution);
  assert.match(rawRoute, /if \(ac\.signal\.aborted \|\| res\.destroyed \|\| res\.writableEnded\) return;/);
  assert.ok(rawRoute.indexOf('scheduleProviderRouteBenchmark(', routeResolution) < dispatcherFreeze);
});

test('benchmark learning is bounded, sequential, service-only, and locally preemptable', () => {
  const start = gateway.indexOf('const providerRouteBenchmarkEnabled');
  const end = gateway.indexOf('const activeVideoEncoderAdmissions', start);
  const benchmark = gateway.slice(start, end);
  assert.match(benchmark, /PROVIDER_ROUTE_BENCHMARK_MAX_PENDING/);
  assert.match(benchmark, /runLeasedProviderRouteBenchmark/);
  assert.match(benchmark, /measureProviderRoute/);
  assert.match(benchmark, /providerRouteBenchmarkDispatcher/);
  assert.match(benchmark, /viewerPlaybackActiveLocally\(\)/);
  assert.match(benchmark, /registerAccountExtraction/);
  assert.match(benchmark, /PROVIDER_SLOT_RELEASE_DELAY_MS/);
  assert.match(benchmark, /setViewerPreemptHandler/);
  assert.match(benchmark, /mediaDurationSeconds: job\.mediaDurationSeconds/);
  assert.match(benchmark, /existing\.mediaDurationSeconds = normalizedDuration/);
  assert.match(
    benchmark,
    /\['viewer-active-or-leased', 'lease-unavailable'\][\s\S]{0,220}deferProviderRouteBenchmarkWithoutConsumingAttempt\(job\)/,
  );
  assert.match(
    benchmark,
    /controller\.signal\.aborted[\s\S]{0,180}deferProviderRouteBenchmarkWithoutConsumingAttempt\(job\)/,
  );
  assert.match(benchmark, /function retryProviderRouteBenchmark[\s\S]{0,180}job\.attempts >= 5/);
  assert.match(gateway, /app\.post\('\/provider-route\/benchmark', requireGatewayAuth/);
  assert.match(gateway, /enrichSessionCodecProfileFromBoundedHeader[\s\S]{0,500}providerRouteBenchmarkDurationSeconds\(session\.codecProfile, session\.playbackHint\)/);
});

test('distributed activity reports only HMAC route identities for active viewers', () => {
  const reporter = gateway.slice(
    gateway.indexOf('function activeProviderRouteAccountFingerprints'),
    gateway.indexOf('let _accountActivityLastErrorAt'),
  );
  assert.match(reporter, /fingerprintsForSource/);
  assert.match(reporter, /routeAccountFingerprint/);
  assert.match(reporter, /\^\[0-9a-f\]\{64\}\$/);
  assert.doesNotMatch(reporter, /return .*sourceUrl|return .*affinityKey/);
  assert.match(gateway, /reportViewerActivity\(routeFingerprints/);
});

test('adaptive diagnostics expose coordinates and scores but no control-plane identities', () => {
  const debugStart = gateway.indexOf('function debugSession(session)');
  const debugEnd = gateway.indexOf('function publicUrl(', debugStart);
  const debug = gateway.slice(debugStart, debugEnd);
  assert.match(debug, /transport: providerRoute\.nodeTransport/);
  assert.match(debug, /slot: providerRoute\.slot/);
  assert.match(debug, /score:/);
  assert.match(debug, /confidence:/);
  assert.doesNotMatch(debug, /(accountFingerprint|hostFingerprint|providerHttpProxyUrls|providerSocksProxyUrls)/);
});
