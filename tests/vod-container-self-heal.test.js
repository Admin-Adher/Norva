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

function containerMismatchPersister() {
  const edge = read(EDGE_PATH);
  const source = sourceBetween(
    edge,
    'function containerObservationItemCas(',
    '\nasync function createGatewaySession(',
  );
  const executable = stripTypeScriptTypes(source, { mode: 'strip' });
  return vm.runInNewContext(
    `(() => { ${executable}; return persistGatewaySourceContainerMismatch; })()`,
    {
      Date,
      Number,
      console: { warn() {} },
      recordOrEmpty: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
      stringOr: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      stringOrNull: (value) => typeof value === 'string' && value.trim() ? value.trim() : null,
      callActiveCatalogGenerationRpc: async (db, name, args, generation) => db.rpc(name, {
        ...args,
        p_generation_id: generation.generationId,
        p_head_revision: generation.headRevision,
        p_config_revision: generation.configRevision,
        p_source_visibility_epoch: generation.sourceVisibilityEpoch,
        p_user_visibility_epoch: generation.userVisibilityEpoch,
      }),
      assertActiveCatalogGenerationCurrent: async () => {},
    },
  );
}

function vodContainerAuthority() {
  const edge = read(EDGE_PATH);
  const source = sourceBetween(
    edge,
    'function resolvedVodContainerAuthority(',
    '\nfunction playbackCostScoreForObservation(',
  );
  const executable = stripTypeScriptTypes(source, { mode: 'strip' });
  const recordOrEmpty = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const normalizeCodecToken = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const canonicalVodContainer = (value) => {
    const token = normalizeCodecToken(value);
    const canonical = token === 'matroska'
      ? 'mkv'
      : token === 'mpeg'
        ? 'mpg'
        : token === 'm4v'
          ? 'mp4'
          : token;
    return ['mkv', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'ts'].includes(canonical)
      ? canonical
      : null;
  };
  return vm.runInNewContext(
    `(() => { ${executable}; return resolvedVodContainerAuthority; })()`,
    {
      canonicalVodContainer,
      firstUsefulCodecProfile: (...values) => values.find((value) => Object.keys(recordOrEmpty(value)).length) || {},
      hasReliableVodCodecProfile: (value) => {
        const profile = recordOrEmpty(value);
        return Array.isArray(profile.audioTracks) &&
          Array.isArray(profile.subtitles) &&
          Boolean(profile.videoCodec && profile.audioCodec && profile.container && profile.probeSource && profile.probedAt);
      },
      normalizeCodecToken,
      recordOrEmpty,
    },
  );
}

test('Gateway container mismatch evidence is exact, typed, and bound to the requested source', () => {
  const normalize = mismatchNormalizer();
  const valid = validMismatch();
  const accepted = normalize(409, valid, valid.evidence.sourceUrlSha256);
  assert.equal(accepted.declaredContainer, 'mkv');
  assert.equal(accepted.observedContainer, 'mp4');
  assert.equal(accepted.evidence.fileSizeBytes, 123456);

  const ts = {
    ...valid,
    observedContainer: 'ts',
    evidence: { ...valid.evidence, kind: 'mpeg-ts-sync-v1' },
  };
  assert.equal(normalize(409, ts, ts.evidence.sourceUrlSha256)?.observedContainer, 'ts');

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

test('the exact owner variant profile outranks lagging item and global catalogue mirrors', () => {
  const edge = read(EDGE_PATH);
  const resolver = sourceBetween(edge, 'async function resolvePlaybackTarget(', '\n// Series have no directly-playable');
  assert.match(resolver, /from\("cloud_catalog_visible_title_variants"\)[\s\S]*select\("codec_profile"\)/);
  assert.match(resolver, /eq\("user_id", userId\)[\s\S]*eq\("source_id", sourceId\)[\s\S]*eq\("item_type", "movie"\)[\s\S]*eq\("external_id", itemId\)[\s\S]*limit\(2\)/);
  assert.match(resolver, /variants\.length === 1[\s\S]*hasReliableVodCodecProfile\(candidate\)/);
  assert.match(resolver, /const storedCodecProfile = hasReliableVodCodecProfile\(exactVariantCodecProfile\)[\s\S]*\? exactVariantCodecProfile/);
});

test('a real MP4 stays on Relay while a mismatched unsafe container still promotes to Gateway', () => {
  const edge = read(EDGE_PATH);
  const create = sourceBetween(edge, 'async function createPlaybackSessionCore(', '\nasync function createPlaybackSession(');
  const helper = sourceBetween(
    edge,
    'function authoritativeVodGatewayTier(',
    '\nfunction playbackCostScoreForObservation(',
  );
  assert.match(create, /const clientMode = choosePlaybackMode/);
  assert.match(create, /itemType === "movie"[\s\S]*authoritativeVodGatewayTier\(resolved\.playbackHint/);
  assert.match(create, /resolvedVodContainerAuthority\([\s\S]*resolved\.playbackHint[\s\S]*resolvedContainerObservation[\s\S]*itemType === "movie"/);
  assert.match(create, /const browserNativeMp4 =[\s\S]*authoritativeVodContainer === "mp4"/);
  assert.match(create, /const serverDemotedAutomaticMp4 =[\s\S]*clientMode === "transcode"[\s\S]*body\.gatewayAutoMode === true/);
  assert.match(create, /clientMode === "relay" &&[\s\S]*!browserNativeMp4 &&[\s\S]*authoritativeVodTier === "video_transcode"/);
  assert.match(create, /gatewayMode: authoritativeVodTier === "video_transcode" \? "transcode" : "remux"/);
  assert.doesNotMatch(create, /clientMode === "direct"\s*&&\s*serverPromotedRelay/);
  assert.match(helper, /container: profile\.container/);
  assert.match(helper, /\["avi", "flv", "mpg", "ogg"\]/);
  assert.match(helper, /function resolvedVodContainerAuthority\(/);
  assert.match(helper, /if \(observedContainer\) return observedContainer/);
  assert.match(helper, /hasReliableVodCodecProfile\(profile\)[\s\S]*canonicalVodContainer\(profile\.container\)/);
  assert.match(helper, /profileToken === "movmp4m4a3gp3g2mj2"/);
});

test('a Gateway-owned ISO-BMFF probe repairs a stale MKV catalogue extension for movies only', () => {
  const resolveContainer = vodContainerAuthority();
  const crescentCity = {
    container: 'mkv',
    codecProfile: {
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioTracks: [{ index: 1, codec: 'aac', language: 'und' }],
      subtitles: [],
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      probeSource: 'gateway_probe',
      probedAt: '2026-09-01T10:00:00.000Z',
      metadataComplete: false,
    },
  };

  assert.equal(resolveContainer(crescentCity, {}, true), 'mp4');
  assert.equal(resolveContainer(crescentCity, {}, false), 'mkv');
  assert.equal(resolveContainer({
    ...crescentCity,
    codecProfile: { ...crescentCity.codecProfile, probeSource: 'request' },
  }, {}, true), 'mkv');
  assert.equal(resolveContainer(crescentCity, { container: 'mkv' }, true), 'mkv');
  assert.equal(resolveContainer({
    ...crescentCity,
    container: 'mov',
  }, {}, false), 'mov');
});

test('only a Norva-built Xtream URL has its terminal container rewritten', () => {
  const rewrite = containerUrlRewriter();
  const xtream = 'https://provider.example/panel/movie/user/pass/42.mkv?token=kept';
  assert.equal(
    rewrite(xtream, 'mkv', 'mp4', 'xtream'),
    'https://provider.example/panel/movie/user/pass/42.mp4?token=kept',
  );
  assert.equal(
    rewrite(xtream, 'mkv', 'ts', 'xtream'),
    'https://provider.example/panel/movie/user/pass/42.ts?token=kept',
  );
  assert.equal(rewrite(xtream, 'mkv', 'mp4', 'm3u'), xtream);
  assert.equal(
    rewrite('https://cdn.example/files/title.mkv', 'mkv', 'mp4', 'xtream'),
    'https://cdn.example/files/title.mkv',
  );
});

test('container persistence keeps the playback-resolution generation and requires an exact item CAS', async () => {
  const persist = containerMismatchPersister();
  const generationA = {
    kind: 'active',
    generationId: '11111111-1111-4111-8111-111111111111',
    headRevision: '7',
    configRevision: '8',
    sourceVisibilityEpoch: '9',
    userVisibilityEpoch: '10',
  };
  const sourceId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';
  const expectedTargetUrlHash = 'a'.repeat(64);
  const base = {
    playbackSessionId: '44444444-4444-4444-8444-444444444444',
    userId,
    sourceId,
    itemType: 'movie',
    itemId: '42',
    expectedTargetUrlHash,
    mismatch: validMismatch(),
    generation: generationA,
  };

  let rpcCalls = 0;
  assert.equal(await persist({
    async rpc() { rpcCalls += 1; throw new Error('must not run'); },
  }, { ...base, playbackHint: {} }), false);
  assert.equal(rpcCalls, 0, 'missing item CAS must make zero persistence RPCs');

  let mutatedGenerationB = false;
  const calls = [];
  const result = await persist({
    async rpc(name, args) {
      calls.push({ name, args });
      // Simulate an A -> B promotion after playback resolution. The SQL ABA
      // overload rejects A's proof before any physical B row can be changed.
      mutatedGenerationB = false;
      return { data: null, error: { code: '40001', message: 'catalog generation changed' } };
    },
  }, {
    ...base,
    playbackHint: {
      __norvaMkvH264FastStartItemCasV2: {
        id: '55555555-5555-4555-8555-555555555555',
        updatedAt: '2026-08-23T10:00:00.000Z',
        targetUrlHash: expectedTargetUrlHash,
      },
    },
  });
  assert.equal(result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'record_catalog_file_container_observation');
  assert.equal(calls[0].args.p_generation_id, generationA.generationId);
  assert.equal(calls[0].args.p_expected_media_item_id, '55555555-5555-4555-8555-555555555555');
  assert.equal(calls[0].args.p_expected_media_item_updated_at, '2026-08-23T10:00:00.000Z');
  assert.equal(mutatedGenerationB, false);

  const edge = read(EDGE_PATH);
  const create = sourceBetween(edge, 'async function createPlaybackSessionCore(', '\nasync function createPlaybackSession(');
  assert.match(create, /playbackGeneration = await readActiveCatalogGenerationSnapshot[\s\S]*const resolved = [\s\S]*assertActiveCatalogGenerationCurrent\([^)]*playbackGeneration\)[\s\S]*createGatewaySession\([\s\S]*playbackGeneration/);
  const writer = sourceBetween(edge, 'async function persistGatewaySourceContainerMismatch(', '\nasync function createGatewaySession(');
  assert.doesNotMatch(writer, /readActiveCatalogGenerationSnapshot/);
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

test('Gateway emits only redacted hashes and recognizes MP4 or MPEG-TS before FFmpeg startup', () => {
  const gateway = read(GATEWAY_PATH);
  const edge = read(EDGE_PATH);
  const deploy = read(path.join(ROOT, 'ops/hetzner/scripts/04-deploy-edge-functions.sh'));
  assert.match(gateway, /version: GATEWAY_VERSION,[\s\S]*vodContainerSelfHealProtocol: 1/);
  assert.match(edge, /version: 77,[\s\S]*vodContainerSelfHealProtocol: 1/);
  assert.match(deploy, /EXPECTED_PLAYBACK_VERSION=77/);
  assert.match(deploy, /EXPECTED_VOD_CONTAINER_SELF_HEAL_PROTOCOL=1/);
  assert.match(deploy, /vodContainerSelfHealProtocol\\\":\$EXPECTED_VOD_CONTAINER_SELF_HEAL_PROTOCOL/);
  const classifier = sourceBetween(
    gateway,
    'function classifyMediaContainerPrefix(',
    '\nasync function primeFullBodyMatroskaAttempt(',
  );
  assert.match(classifier, /subarray\(4, 8\)\.toString\('ascii'\) === 'ftyp'/);
  assert.match(classifier, /prefix\[0\] === 0x47 && prefix\[188\] === 0x47 && prefix\[376\] === 0x47/);
  assert.match(edge, /ts: "mpeg-ts-sync-v1"/);
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
