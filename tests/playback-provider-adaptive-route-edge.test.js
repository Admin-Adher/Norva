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
  assert.match(edge, /version: 69,[\s\S]*providerAdaptiveRouteControlProtocol: 1/);
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
    edge.indexOf('// POST /pregen-gate'),
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
    edge.indexOf('// POST /pregen-gate'),
  );
  assert.match(resolver, /const disabled = \{[\s\S]*enabled: false,[\s\S]*apply: false,[\s\S]*decision: null/);
  assert.doesNotMatch(resolver, /return \{[\s\S]{0,200}(accountFingerprint|hostFingerprint)/);
});
