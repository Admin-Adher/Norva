'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const routeEngine = require('../services/media-gateway/src/providerAdaptiveRoute.js');
const edgeSource = fs.readFileSync(path.join(
  __dirname,
  '../supabase/functions/norva-playback/index.ts',
), 'utf8');

function edgeScoringHarness() {
  const start = edgeSource.indexOf('const PROVIDER_ROUTE_FINGERPRINT_PATTERN');
  const end = edgeSource.indexOf('async function getProviderRoutePolicy', start);
  assert.ok(start >= 0 && end > start);
  const prelude = `
    type JsonRecord = Record<string, unknown>;
    type ProviderRouteCoordinate = { slot: number; nodeTransport: "http" | "socks5" };
    function isRecord(value: unknown): value is JsonRecord {
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }
    function recordOrEmpty(value: unknown): JsonRecord { return isRecord(value) ? value : {}; }
    function exactJsonKeys(value: JsonRecord, expected: string[]) {
      const actual = Object.keys(value).sort();
      const wanted = [...expected].sort();
      return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
    }
    function stringOr(value: unknown, fallback: string) {
      return typeof value === "string" && value.trim() ? value.trim() : fallback;
    }
    function providerRouteCoordinate(value: unknown): ProviderRouteCoordinate | null {
      const record = recordOrEmpty(value);
      const slot = Number(record.slot);
      const nodeTransport = stringOr(record.nodeTransport, "");
      if (!Number.isInteger(slot) || slot < 1 || slot > 32) return null;
      if (nodeTransport !== "http" && nodeTransport !== "socks5") return null;
      return { slot, nodeTransport: nodeTransport as "http" | "socks5" };
    }
    function providerRouteCoordinateKey(value: ProviderRouteCoordinate): string {
      return value.slot + ":" + value.nodeTransport;
    }
  `;
  const executable = stripTypeScriptTypes(`${prelude}\n${edgeSource.slice(start, end)}\n({
    evaluateProviderRouteTransitionEdge,
    parseProviderRouteMeasurement,
    providerRoutePolicyNumber,
    rankProviderRouteEdge,
    scoreProviderRouteEdge,
  })`, { mode: 'strip' });
  return vm.runInNewContext(executable, { Math, Number, Object, Array, Set, Map });
}

function measurement(overrides = {}) {
  return {
    first16MiBMs: 4200,
    first4MiBMs: 1100,
    http5xx: 0,
    nodeTransport: 'http',
    phase: 'sustained',
    provider458: 0,
    proxy407: 0,
    rangeSeekOk: true,
    resets: 0,
    sampleBytes: 16 * 1024 * 1024,
    slot: 1,
    success: true,
    throughputBytesPerSecond: 18 * 1024 * 1024,
    timeouts: 0,
    ttfbMs: 180,
    varianceRatio: 0.07,
    ...overrides,
  };
}

test('Edge and Gateway score the same bounded provider measurement', () => {
  const edge = edgeScoringHarness();
  const parsed = edge.parseProviderRouteMeasurement(measurement());
  assert.ok(parsed);
  assert.equal(
    edge.scoreProviderRouteEdge(parsed),
    routeEngine.scoreProviderRouteMeasurement(parsed),
  );
  const proxyFailure = edge.parseProviderRouteMeasurement(measurement({ proxy407: 1 }));
  assert.equal(edge.scoreProviderRouteEdge(proxyFailure), 0);
});

test('Edge measurement parser rejects leaked fields and rankings keep the fastest route first', () => {
  const edge = edgeScoringHarness();
  assert.equal(edge.parseProviderRouteMeasurement({
    ...measurement(),
    sourceUrl: 'https://must-not-be-accepted.invalid/secret',
  }), null);
  const fast = edge.parseProviderRouteMeasurement(measurement());
  const slow = edge.parseProviderRouteMeasurement(measurement({
    slot: 2,
    ttfbMs: 4000,
    first4MiBMs: 12000,
    first16MiBMs: 48000,
    throughputBytesPerSecond: 1024 * 1024,
    varianceRatio: 0.8,
  }));
  const rankings = edge.rankProviderRouteEdge([slow, fast]);
  assert.equal(`${rankings[0].slot}:${rankings[0].nodeTransport}`, '1:http');
  assert.ok(rankings[0].score > rankings[1].score);
});

test('Edge and Gateway apply identical route hysteresis including explicit zero policy values', () => {
  const edge = edgeScoringHarness();
  const nowMs = Date.parse('2026-09-01T20:00:00.000Z');
  const current = {
    slot: 1,
    nodeTransport: 'http',
    score: 50,
    confidence: 0.9,
    expiresAt: '2026-09-02T20:00:00.000Z',
    consecutiveFailures: 0,
  };
  const candidate = {
    ...measurement({ slot: 2, nodeTransport: 'socks5' }),
    score: 51,
    confidence: 0,
    sampleCount: 1,
    metrics: measurement({ slot: 2, nodeTransport: 'socks5' }),
    consecutiveWins: 1,
  };
  const policy = {
    minimumConfidence: 0,
    minimumRelativeGain: 0,
    sustainedCandidateWins: 1,
    consecutiveFailureThreshold: 3,
  };
  assert.equal(edge.providerRoutePolicyNumber({ minimumConfidence: 0 }, 'minimumConfidence', 0.65), 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(edge.evaluateProviderRouteTransitionEdge(current, candidate, policy, nowMs))),
    routeEngine.evaluateProviderRouteTransition({ current, candidate, policy, nowMs }),
  );

  const heldCandidate = { ...candidate, score: 55, confidence: 0.9, consecutiveWins: 2 };
  const heldPolicy = { ...policy, minimumRelativeGain: 0.2, sustainedCandidateWins: 3 };
  assert.deepEqual(
    JSON.parse(JSON.stringify(edge.evaluateProviderRouteTransitionEdge(current, heldCandidate, heldPolicy, nowMs))),
    routeEngine.evaluateProviderRouteTransition({ current, candidate: heldCandidate, policy: heldPolicy, nowMs }),
  );
});
