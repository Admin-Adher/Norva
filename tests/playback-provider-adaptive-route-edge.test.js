'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edge = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');

test('playback edge exposes the service-authenticated provider route resolver', () => {
  assert.match(edge, /version: 75,[\s\S]*providerAdaptiveRouteControlProtocol: 1/);
  assert.match(
    edge,
    /segments\[0\] === "provider-route" && segments\[1\] === "resolve"[\s\S]*runProviderRouteResolve/,
  );
  assert.match(
    edge,
    /async function runProviderRouteResolve[\s\S]*requireConfiguredMediaGatewayCallback\(req, runtimeConfig\)/,
  );
});

test('route resolver accepts only one-way identities and route coordinates', () => {
  assert.match(
    edge,
    /const expectedKeys = \[[\s\S]*"accountFingerprint"[\s\S]*"candidates"[\s\S]*"hostFingerprint"[\s\S]*"priority"[\s\S]*"protocol"/,
  );
  assert.match(edge, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(edge, /Object\.keys\(candidateRecord\)\.sort\(\)\.join\(","\) !== "nodeTransport,slot"/);
  assert.doesNotMatch(
    edge.slice(edge.indexOf('async function runProviderRouteResolve'), edge.indexOf('// POST /pregen-gate')),
    /body\.(sourceUrl|serverUrl|username|password|userId|sourceId)/,
  );
});

test('viewer resolution preempts a benchmark before reading a sticky account or host decision', () => {
  const resolver = edge.slice(
    edge.indexOf('async function runProviderRouteResolve'),
    edge.indexOf('const PROVIDER_ROUTE_FINGERPRINT_PATTERN'),
  );
  const preempt = resolver.indexOf('norva_preempt_provider_route_lease');
  const accountLookup = resolver.indexOf('.from("provider_route_state")');
  assert.ok(preempt >= 0 && accountLookup > preempt);
  assert.match(resolver, /scope", "account"/);
  assert.match(resolver, /scope", "host"/);
  assert.match(resolver, /apply: enabled && !shadowMode && Boolean\(decision\)/);
});

test('route-control migration lag fails open to the Gateway sticky route without leaking state', () => {
  const resolver = edge.slice(
    edge.indexOf('async function runProviderRouteResolve'),
    edge.indexOf('const PROVIDER_ROUTE_FINGERPRINT_PATTERN'),
  );
  assert.match(resolver, /const disabled = \{[\s\S]*enabled: false,[\s\S]*apply: false,[\s\S]*decision: null/);
  assert.doesNotMatch(resolver, /return \{[\s\S]{0,200}(accountFingerprint|hostFingerprint)/);
});

test('edge coordinates a strict leased benchmark and persists only bounded telemetry', () => {
  assert.match(
    edge,
    /segments\[0\] === "provider-route" && segments\[1\] === "benchmark"[\s\S]*runProviderRouteBenchmark/,
  );
  const benchmark = edge.slice(
    edge.indexOf('async function persistProviderRouteState'),
    edge.indexOf('function requireConfiguredMediaGatewayCallback'),
  );
  assert.match(benchmark, /\["claim", "pulse", "report", "release"\]/);
  assert.match(benchmark, /norva_claim_provider_route_lease/);
  assert.match(benchmark, /norva_renew_provider_route_lease/);
  assert.match(benchmark, /norva_release_provider_route_lease/);
  assert.match(benchmark, /provider_route_measurements/);
  assert.match(benchmark, /minimum_relative_gain/);
  assert.match(benchmark, /sustained_candidate_wins/);
  assert.doesNotMatch(benchmark, /body\.(sourceUrl|serverUrl|username|password|userId|sourceId)/);
});

test('viewer activity is an HMAC-only distributed fence for benchmark claims', () => {
  assert.match(
    edge,
    /segments\[0\] === "provider-route" && segments\[1\] === "activity"[\s\S]*runProviderRouteActivity/,
  );
  const activity = edge.slice(
    edge.indexOf('async function runProviderRouteActivity'),
    edge.indexOf('async function providerRouteBenchmarkLease'),
  );
  assert.match(activity, /norva_touch_provider_route_activity/);
  assert.match(activity, /PROVIDER_ROUTE_FINGERPRINT_PATTERN/);
  assert.doesNotMatch(activity, /sourceUrl|username|password|providerName|userId/);
});
