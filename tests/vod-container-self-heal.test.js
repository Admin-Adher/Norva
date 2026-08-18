'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const ROOT = path.join(__dirname, '..');
const EDGE_PATH = path.join(ROOT, 'supabase/functions/norva-playback/index.ts');
const GATEWAY_PATH = path.join(ROOT, 'services/media-gateway/src/index.js');
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase/migrations/20260818104800_vod_container_observation_self_heal.sql',
);

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function mismatchNormalizer() {
  const edge = read(EDGE_PATH);
  const source = sourceBetween(
    edge,
    'function exactJsonKeys(',
    '\nfunction playbackHintForObservedContainer(',
  );
  const executable = stripTypeScriptTypes(source, { mode: 'strip' });
  return vm.runInNewContext(
    `(() => { ${executable}; return normalizeGatewaySourceContainerMismatch; })()`,
    {
      Object,
      Number,
      normalizeCodecToken: (value) => String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, ''),
      recordOrEmpty: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
      stringOr: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      exactPositiveSafeInteger: (value) => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      },
    },
  );
}

function validMismatch() {
  return {
    protocol: 1,
    code: 'SOURCE_CONTAINER_MISMATCH',
    declaredContainer: 'mkv',
    observedContainer: 'mp4',
    evidence: {
      kind: 'iso-bmff-ftyp-v1',
      prefixSha256: 'a'.repeat(64),
      sourceUrlSha256: 'b'.repeat(64),
      effectiveUrlSha256: 'c'.repeat(64),
      validatorKind: 'etag',
      validatorSha256: 'd'.repeat(64),
      fileSizeBytes: 123456,
    },
  };
}

function containerUrlRewriter() {
  const edge = read(EDGE_PATH);
  const source = sourceBetween(
    edge,
    'function rewriteVodContainerUrl(',
    '\nfunction containerObservationItemCas(',
  );
  const executable = stripTypeScriptTypes(source, { mode: 'strip' });
  return vm.runInNewContext(
    `(() => { ${executable}; return rewriteVodContainerUrl; })()`,
    { URL },
  );
}

test('Gateway container mismatch evidence is exact, typed, and bound to the requested source', () => {
  const normalize = mismatchNormalizer();
  const valid = validMismatch();
  const accepted = normalize(409, valid, valid.evidence.sourceUrlSha256);
  assert.equal(accepted.declaredContainer, 'mkv');
  assert.equal(accepted.observedContainer, 'mp4');
  assert.equal(accepted.evidence.fileSizeBytes, 123456);

  for (const invalid of [
    { status: 502, body: valid, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, protocol: '1' }, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, unexpected: true }, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, observedContainer: 'mkv' }, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, evidence: { ...valid.evidence, extra: true } }, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, evidence: { ...valid.evidence, sourceUrlSha256: 'e'.repeat(64) } }, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, evidence: { ...valid.evidence, kind: 'ebml-v1' } }, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, evidence: { ...valid.evidence, validatorKind: 'none' } }, expected: valid.evidence.sourceUrlSha256 },
    { status: 409, body: { ...valid, evidence: { ...valid.evidence, fileSizeBytes: '123456' } }, expected: valid.evidence.sourceUrlSha256 },
  ]) {
    assert.equal(normalize(invalid.status, invalid.body, invalid.expected), null);
  }
});

test('the correction is a single mutually exclusive retry and HTTP 458 stays terminal after it', () => {
  const edge = read(EDGE_PATH);
  const gatewaySession = sourceBetween(
    edge,
    'async function createGatewaySession(',
    '\nasync function requestGatewaySession(',
  );
  const mismatchGate = gatewaySession.indexOf('normalizeGatewaySourceContainerMismatch(');
  const persist = gatewaySession.indexOf('persistGatewaySourceContainerMismatch(', mismatchGate);
  const correctedRequest = gatewaySession.indexOf('const retry = await requestGatewaySession(', persist);
  const busyGate = gatewaySession.indexOf('isProviderBusyFailure', correctedRequest);
  const correctedBusy = gatewaySession.indexOf('if (containerCorrectionRetried)', busyGate);
  const openCircuit = gatewaySession.indexOf('openProviderPlaybackCircuit(providerAccountHash, db, true)', correctedBusy);
  assert.ok(mismatchGate >= 0 && mismatchGate < persist);
  assert.ok(persist < correctedRequest && correctedRequest < busyGate);
  assert.ok(busyGate < correctedBusy && correctedBusy < openCircuit);
  const terminalBranch = gatewaySession.slice(correctedBusy, gatewaySession.indexOf('} else {', correctedBusy));
  assert.doesNotMatch(terminalBranch, /requestGatewaySession\(/);
  assert.match(gatewaySession, /containerCorrectionRetried = true/);
  assert.doesNotMatch(gatewaySession, /while\s*\([^)]*containerCorrection|for\s*\([^)]*containerCorrection/);
});

test('a persisted observation overrides client and provider extensions for current and future accounts', () => {
  const edge = read(EDGE_PATH);
  const resolver = sourceBetween(edge, 'async function resolvePlaybackTarget(', '\n// Series have no directly-playable');
  const observation = resolver.indexOf('resolveObservedVodContainer(');
  const xtreamFallback = resolver.indexOf('xtreamPlaybackContainer(');
  assert.ok(observation >= 0 && observation < xtreamFallback);
  assert.match(resolver, /containerObservation\?\.container\s*\?\?\s*xtreamPlaybackContainer/);
  assert.match(resolver, /playbackHintForObservedContainer\(storedPlaybackHintBase, containerObservation\.container\)/);
  assert.match(edge, /sourceContainerAuthorityFromObservation\([\s\S]*sourceContainerObservation[\s\S]*targetUrl/);
});

test('only a Norva-built Xtream URL has its terminal container rewritten', () => {
  const rewrite = containerUrlRewriter();
  const xtream = 'https://provider.example/panel/movie/user/pass/42.mkv?token=kept';
  assert.equal(
    rewrite(xtream, 'mkv', 'mp4', 'xtream'),
    'https://provider.example/panel/movie/user/pass/42.mp4?token=kept',
  );
  assert.equal(rewrite(xtream, 'mkv', 'mp4', 'm3u'), xtream);
  assert.equal(
    rewrite('https://cdn.example/files/title.mkv', 'mkv', 'mp4', 'xtream'),
    'https://cdn.example/files/title.mkv',
  );
});

test('the database observation is service-only, playback-bound, atomic, and sync-resistant', () => {
  const sql = read(MIGRATION_PATH);
  assert.match(sql, /create table if not exists public\.catalog_file_container_observations/);
  assert.match(sql, /alter table public\.catalog_file_container_observations enable row level security/);
  assert.match(sql, /revoke all on table public\.catalog_file_container_observations from public, anon, authenticated/);
  assert.match(sql, /grant all on table public\.catalog_file_container_observations to service_role/);
  assert.match(sql, /record_catalog_file_container_observation/);
  assert.match(sql, /ps\.target_url_hash[\s\S]*v_target_url_hash <> v_source_url_sha256/);
  assert.match(sql, /p_evidence - array\[[\s\S]*'fileSizeBytes'[\s\S]*\]::text\[\]/);
  assert.match(sql, /insert into public\.catalog_file_container_observations[\s\S]*on conflict \(server_host, item_type, external_id\) do update/);
  assert.match(sql, /update public\.cloud_media_items/);
  assert.match(sql, /update public\.cloud_title_variants/);
  assert.match(sql, /update public\.catalog_media_items/);
  assert.match(sql, /update public\.catalog_title_variants/);
  assert.match(sql, /revoke all on function public\.record_catalog_file_container_observation[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(sql, /source_url\s+text|effective_url\s+text|validator_value\s+text/);

  const syncSql = read(path.join(ROOT, 'supabase/migrations/20260627170000_sync_source_to_catalog.sql'));
  assert.doesNotMatch(syncSql, /delete from\s+(public\.)?catalog_file_container_observations/i);
});

test('Gateway emits only redacted hashes and recognizes MP4 before FFmpeg startup', () => {
  const gateway = read(GATEWAY_PATH);
  const edge = read(EDGE_PATH);
  const deploy = read(path.join(ROOT, 'ops/hetzner/scripts/04-deploy-edge-functions.sh'));
  assert.match(gateway, /version: GATEWAY_VERSION,[\s\S]*vodContainerSelfHealProtocol: 1/);
  assert.match(edge, /version: 57,[\s\S]*vodContainerSelfHealProtocol: 1/);
  assert.match(deploy, /EXPECTED_PLAYBACK_VERSION=57/);
  assert.match(deploy, /EXPECTED_VOD_CONTAINER_SELF_HEAL_PROTOCOL=1/);
  assert.match(deploy, /vodContainerSelfHealProtocol\\\":\$EXPECTED_VOD_CONTAINER_SELF_HEAL_PROTOCOL/);
  const classifier = sourceBetween(
    gateway,
    'function classifyMediaContainerPrefix(',
    '\nasync function primeFullBodyMatroskaAttempt(',
  );
  assert.match(classifier, /subarray\(4, 8\)\.toString\('ascii'\) === 'ftyp'/);
  assert.match(classifier, /sourceUrlSha256/);
  assert.match(classifier, /effectiveUrlSha256/);
  assert.match(classifier, /validatorSha256/);
  assert.doesNotMatch(classifier, /sourceUrl:\s|effectiveUrl:\s|validatorValue/);
  const createRoute = sourceBetween(gateway, "app.post('/sessions'", '\nfunction gatewayCreatedSessionPayload');
  assert.ok(
    createRoute.indexOf("err?.code === 'SOURCE_CONTAINER_MISMATCH'")
      < createRoute.indexOf("console.warn('[media-gateway] unable to bound finite MKV input:"),
  );
  assert.match(createRoute, /res\.status\(409\)\.json\(err\.details\)/);
});
