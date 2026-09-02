'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gateway = fs.readFileSync(path.join(
  __dirname,
  '../services/media-gateway/src/index.js',
), 'utf8');

test('Gateway v152 keeps adaptive routing behind dedicated route and benchmark gates', () => {
  assert.match(gateway, /const GATEWAY_VERSION = 152;/);
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

test('Node can choose HTTP or SOCKS5 while child processes retain the same HTTP slot', () => {
  assert.match(gateway, /let providerHttpProxyAgents = \[\];[\s\S]{0,80}let providerSocksProxyAgents = \[\];/);
  assert.match(
    gateway,
    /function pickProxyAgent\(key\)[\s\S]{0,260}route\.nodeTransport === 'socks5'[\s\S]{0,160}agents\[route\.slot - 1\]/,
  );
  assert.match(
    gateway,
    /function pinnedProxyAgentFactory\(key\)[\s\S]{0,320}route\.nodeTransport === 'socks5'[\s\S]{0,220}urls\[route\.slot - 1\]/,
  );
  assert.match(
    gateway,
    /function proxyEnvFor\(key\)[\s\S]{0,240}providerHttpProxyUrls\[poolIndexForKey\(key\)\]/,
  );
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
  const dispatcherFreeze = rawRoute.indexOf('const rawProxyAgent = pickProxyAgent(pumpProxyKey)');
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
  assert.match(gateway, /app\.post\('\/provider-route\/benchmark', requireGatewayAuth/);
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
