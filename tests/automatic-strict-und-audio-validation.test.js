'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/g, '\n');
const playback = read('supabase/functions/norva-playback/index.ts');
const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
const deployEdge = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');
const migration = read('supabase/migrations/20260901143200_strict_und_audio_validation_v1.sql');
const pgTap = read('supabase/tests/automatic_strict_und_audio_validation.sql');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('automatic exact-file und paths honor the global LID kill switch before enqueue', () => {
  const detector = between(
    playback,
    'async function detectUntaggedAudioLanguages(',
    '\n// Verify TAGGED-but-contradictory tracks',
  );
  const policy = detector.indexOf('const lidPolicy = await getLidDetectionPolicy(db)');
  const disabled = detector.indexOf('if (!lidPolicy.enabled) return;');
  const enqueue = detector.indexOf('await enqueueAutomaticStrictLanguageValidation({');
  assert.ok(policy >= 0 && disabled > policy && enqueue > disabled);
  assert.match(detector, /fileScoped && itemType === "movie" && variantId[\s\S]*enqueueAutomaticStrictLanguageValidation[\s\S]*return;/);
  assert.match(detector, /fileScoped && itemType === "episode"[\s\S]*Never open a second probe[\s\S]*return;/);
  const helper = between(
    playback,
    'async function enqueueAutomaticStrictLanguageValidation(',
    '\n// Automatic UNTAGGED audio enrichment',
  );
  const helperPolicy = helper.indexOf('const lidPolicy = await getLidDetectionPolicy(db)');
  const helperDisabled = helper.indexOf('if (!lidPolicy.enabled) return false;');
  const helperRpc = helper.indexOf('"start_automatic_catalog_file_audio_validation_job"');
  assert.ok(helperPolicy >= 0 && helperDisabled > helperPolicy && helperRpc > helperDisabled);
});

test('episode enqueue requires the exact probe response to attest provider drainage', () => {
  const enqueue = between(
    playback,
    'async function enqueueAutomaticStrictLanguageValidation(',
    '\n// Automatic UNTAGGED audio enrichment',
  );
  const episodeProbe = between(
    playback,
    'async function runEpisodeAudioBackfill(',
    '\nasync function runOneDimension(',
  );
  assert.match(enqueue, /providerDrainAttested\?: boolean/);
  assert.match(enqueue, /itemType === "episode" && providerDrainAttested !== true[\s\S]*return false/);
  assert.match(enqueue, /p_provider_drain_attested: itemType === "episode" && providerDrainAttested === true/);
  const drain = episodeProbe.indexOf('const leaseReleaseSafe = providerProbeResponseAllowsLeaseRelease(');
  const strictEnqueue = episodeProbe.indexOf('enqueueAutomaticStrictLanguageValidation({');
  assert.ok(drain >= 0 && strictEnqueue > drain, 'episode enqueue must occur after drain acceptance');
  assert.match(episodeProbe, /providerDrainAttested: gatewayProviderDrainAttested\(info\)/);

  let helper = between(
    playback,
    'function gatewayProviderDrainAttested(',
    '\nfunction acceptGatewayProviderDrain(',
  ).replace('(payload: JsonRecord)', '(payload)');
  const context = {};
  vm.runInNewContext(`${helper}; this.attested = gatewayProviderDrainAttested;`, context);
  assert.equal(context.attested({ providerDrained: true, providerDrainProtocol: 1 }), true);
  assert.equal(context.attested({ providerDrained: true, providerDrainProtocol: 2 }), false);
  assert.equal(context.attested({ providerDrainProtocol: 1 }), false);
});

test('movies and episodes use one durable strict 4/6-window worker', () => {
  const enqueue = between(
    playback,
    'async function enqueueAutomaticStrictLanguageValidation(',
    '\n// Automatic UNTAGGED audio enrichment',
  );
  const revalidate = between(
    playback,
    'async function revalidateLanguageValidationClaim(',
    '\nfunction gatewayProviderDrainAttested(',
  );
  const worker = between(
    playback,
    'async function processOneLanguageValidationTrack(',
    '\nasync function finalizeLanguageValidationTrackWindows(',
  );
  assert.match(enqueue, /requireStrictLidWindowCount/);
  assert.match(enqueue, /"start_automatic_catalog_file_audio_validation_job"/);
  assert.match(revalidate, /rawItemType === "movie" \|\| rawItemType === "episode"/);
  assert.match(revalidate, /loadExactEpisodeLanguageValidationProfile/);
  assert.match(worker, /current\.itemType === "episode"[\s\S]*resolveExactEpisodePlaybackTarget\([\s\S]*current\.exactProfile\.episodeCoordinates/);
  assert.doesNotMatch(worker, /resolveSeriesEpisodeUrl/);
  assert.match(playback, /strict_lid_window_count in \(0, 4, 6\)|strictLidWindowCountForDuration/);
});

test('durable episode snapshots are revalidated without pretending they contain presentation fields', () => {
  const loader = between(
    playback,
    'async function loadExactEpisodeLanguageValidationProfile(',
    '\nfunction hasExactGatewayInbandVodProfile(',
  );
  assert.match(loader, /catalog_file_audio_validation_jobs/);
  assert.match(loader, /catalog_series_episode_memberships/);
  assert.match(loader, /cloud_catalog_visible_title_variants/);
  assert.match(loader, /generation_id/);
  assert.match(loader, /provider_identity_id/);
  assert.match(loader, /episodeCoordinates/);
  assert.match(loader, /exactLanguageValidationProfileFromSnapshot/);
  assert.doesNotMatch(loader, /exactLanguageValidationProfileFromGateway\(/);
});

test('an episode validation job builds the provider URL for that exact episode', async () => {
  let resolver = between(
    playback,
    'async function resolveExactEpisodePlaybackTarget(',
    '\nasync function resolvePlaybackTarget(',
  );
  resolver = resolver
    .replace(/sourceId: string/g, 'sourceId')
    .replace(/userId: string/g, 'userId')
    .replace(/episodeCoordinates: JsonRecord/g, 'episodeCoordinates')
    .replace(/requestHint: JsonRecord/g, 'requestHint')
    .replace(/db: SupabaseClient/g, 'db');
  const calls = [];
  const context = {
    recordOrEmpty: (value) => value && typeof value === 'object' ? value : {},
    stringOr: (value, fallback) => typeof value === 'string' && value.length ? value : fallback,
    resolveObservedVodContainer: async () => null,
    loadSourceConfig: async () => ({
      serverUrl: 'https://provider.example',
      username: 'user',
      password: 'secret',
    }),
    xtreamStreamUrl: (coordinates) => {
      calls.push(coordinates);
      return `${coordinates.serverUrl}/series/${coordinates.streamId}.${coordinates.container}`;
    },
    mergePlaybackHints: (_left, right) => right,
    HttpError: class HttpError extends Error {},
  };
  vm.runInNewContext(`${resolver}; this.resolve = resolveExactEpisodePlaybackTarget;`, context);
  const resolved = await context.resolve(
    'source-1',
    'user-1',
    {
      episode_id: 'episode-N',
      parent_series_id: 'series-parent',
      container_extension: 'mkv',
    },
    {},
    {},
  );
  assert.equal(resolved.targetUrl, 'https://provider.example/series/episode-N.mkv');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].streamType, 'series');
  assert.equal(calls[0].streamId, 'episode-N');
  assert.equal(calls[0].container, 'mkv');
  assert.equal(resolved.playbackHint.audioSeriesId, 'series-parent');
});

test('automatic enqueue and finalization are tenant, source, active-generation and type bound', () => {
  const start = between(
    migration,
    'create or replace function public.start_automatic_catalog_file_audio_validation_job(',
    '\nrevoke all on function public.start_automatic_catalog_file_audio_validation_job(',
  );
  const finalize = between(
    migration,
    'create or replace function public.finalize_catalog_file_audio_validation_job(',
    '\nrevoke all on function public.finalize_catalog_file_audio_validation_job(',
  );
  for (const body of [start, finalize]) {
    assert.match(body, /security definer/);
    assert.match(body, /set search_path = ''/);
    assert.match(body, /cloud_source_catalog_heads/);
    assert.match(body, /active_generation_id = (?:variant|membership)\.generation_id|generation_id = head\.active_generation_id|(?:variant|membership)\.generation_id = v_active_generation_id/);
    assert.match(body, /catalog_source_provider_identities/);
    assert.match(body, /requested_by|p_requested_by/);
    assert.match(body, /source_id/);
    assert.match(body, /item_type/);
  }
  assert.match(start, /catalog_series_episode_memberships/);
  assert.match(start, /Automatic language validation requires an untagged audio track/);
  assert.match(start, /\('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown'\)/);
  assert.match(start, /parent_item_type = 'series'/);
  assert.match(start, /parent_variant\.item_type = 'series'/);
  assert.match(start, /source\.sync_status = 'ready'/);
  assert.match(start, /p_item_type = 'episode' and p_provider_drain_attested is not true/);
  assert.match(start, /'retry_wait', v_now, null/);
  assert.match(start, /LANGUAGE_VALIDATION_CONCURRENCY_LIMIT/);
  assert.match(start, /v_active_count >= 2/);
  assert.match(start, /LANGUAGE_VALIDATION_RATE_LIMITED/);
  assert.match(start, /v_starts_24h >= 20/);
  assert.match(finalize, /catalog_series_episode_memberships/);
  assert.match(finalize, /parent_item_type = 'series'/);
  assert.match(finalize, /source\.sync_status = 'ready'/);
  assert.match(finalize, /from public\.cloud_sources source[\s\S]*?for share;/);
  assert.match(finalize, /from public\.cloud_source_catalog_heads head[\s\S]*?for share;/);
  assert.match(finalize, /from public\.catalog_source_provider_identities identity[\s\S]*?for share;/);
  assert.match(finalize, /from public\.cloud_title_variants parent_variant[\s\S]*?for share;/);
  assert.match(finalize, /variant\.generation_id = v_active_generation_id[\s\S]*?for update;/);
  assert.match(finalize, /membership\.generation_id = v_active_generation_id[\s\S]*?for update;/);
  const sourceLock = finalize.indexOf('from public.cloud_sources source');
  const headLock = finalize.indexOf('from public.cloud_source_catalog_heads head');
  const identityLock = finalize.indexOf('from public.catalog_source_provider_identities identity');
  const publication = finalize.indexOf('perform public.upsert_catalog_file_validated_tracks');
  assert.ok(sourceLock >= 0 && sourceLock < headLock);
  assert.ok(headLock < identityLock);
  assert.ok(identityLock < publication);
  assert.match(migration, /set local lock_timeout = '5s'/);
  assert.match(migration, /set local statement_timeout = '120s'/);
  assert.doesNotMatch(migration, /catalog-file-audio-validation:'[^\n]*:movie:/);
  assert.match(migration, /v_job\.identity_key \|\| ':' \|\|[\s\S]*v_job\.item_type \|\| ':'/);
});

test('only strict finalization can publish an automatic language into exact tracks/facets', () => {
  const finalizer = between(
    migration,
    'create or replace function public.finalize_catalog_file_audio_validation_job(',
    '\nrevoke all on function public.finalize_catalog_file_audio_validation_job(',
  );
  const provisional = between(
    migration,
    'create or replace function public.persist_catalog_audio_lid_outcome(',
    '\nrevoke all on function public.persist_catalog_audio_lid_outcome(',
  );
  assert.match(finalizer, /upsert_catalog_file_validated_tracks/);
  assert.match(finalizer, /record_catalog_file_audio_verification/);
  assert.match(finalizer, /whisper-strict-consensus-v4/);
  assert.match(provisional, /case when p_status = 'detected' then 'pending'/);
  assert.match(provisional, /when p_status = 'detected' then 'pending-disagreement'/);
  assert.match(provisional, /'provisionalRoute'/);
  assert.match(provisional, /'provisionalLanguage'/);
  assert.match(provisional, /'publicationBlockedBy', 'strict-multi-window-required'/);
  assert.match(provisional, /v_route, v_status, null, null/);
  assert.match(provisional, /p_route not in \('fast-consensus', 'whisper-tiebreak', 'full-transcript-fallback'\)/);
  assert.match(provisional, /p_language !~ '\^\[a-z\]\{2\}\$'/);
  assert.match(provisional, /p_confidence is null[\s\S]*p_confidence < 0[\s\S]*p_confidence > 1/);
});

test('episode retry and quarantine state target the episode cache, never a same-id movie', () => {
  const fail = between(
    migration,
    'create or replace function public.fail_catalog_file_audio_validation_job(',
    '\nrevoke all on function public.fail_catalog_file_audio_validation_job(',
  );
  const quarantine = between(
    migration,
    'create or replace function public.norva_quarantine_audio_validation_provider_no_progress(',
    '\nrevoke all on function public.norva_quarantine_audio_validation_provider_no_progress(',
  );
  for (const transition of [fail, quarantine]) {
    assert.match(transition, /v_job\.item_type not in \('movie', 'episode'\)/);
    assert.match(transition, /record_catalog_file_audio_verification\([\s\S]*v_job\.item_type/);
    assert.doesNotMatch(transition, /record_catalog_file_audio_verification\([\s\S]*?'movie'/);
  }
});

test('new privileged RPCs are service-role only and pgTAP covers the ACLs', () => {
  for (const rpc of [
    'start_automatic_catalog_file_audio_validation_job',
    'fail_catalog_file_audio_validation_job',
    'norva_quarantine_audio_validation_provider_no_progress',
    'finalize_catalog_file_audio_validation_job',
    'persist_catalog_audio_lid_outcome',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}[\\s\\S]*?from public, anon, authenticated, service_role`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*?to service_role`));
  }
  assert.match(pgTap, /not has_function_privilege\(\s*'anon'/);
  assert.match(pgTap, /not has_function_privilege\(\s*'authenticated'/);
  assert.match(pgTap, /has_function_privilege\(\s*'service_role'/);
  assert.match(pgTap, /cloud_source_catalog_heads/);
  assert.match(pgTap, /select \* from extensions\.finish\(\)/);
  assert.match(pgTap, /rollback;/);
});

test('borrowed repair lanes consume only the durable source cohort with max four sequential files', () => {
  const worker = between(
    playback,
    'async function runOneDimension(',
    '\nasync function runCatalogMirrorVerify(',
  );
  assert.match(worker, /const repairCohort = body\.repairCohort === true/);
  assert.match(worker, /repairCohort && !sourceId[\s\S]*AUDIO_REPAIR_SOURCE_REQUIRED/);
  assert.match(worker, /Math\.min\(repairCohort \? 4 : 300/);
  assert.match(worker, /repairCohort && !exactFileScope[\s\S]*AUDIO_REPAIR_SCOPE_REQUIRED/);
  assert.match(
    worker,
    /repairCohort[\s\S]*?db\.rpc\("catalog_file_audio_repair_candidates", \{[\s\S]*?p_user: userId,[\s\S]*?p_source: sourceId,[\s\S]*?p_limit: limit/,
  );
  assert.match(worker, /const effConcurrency = exactFileScope \|\| footprint\?\.lowFootprint \? 1 : concurrency/);
  assert.match(sourceSync, /const repairCohortPending = \(lane === 1 \|\| lane === 4 \|\| lane === 8\)/);
  assert.match(sourceSync, /lane === 8 && repairCohortPending\) \? "untagged" : "tagged"/);
});

test('tagged and untagged Whisper sweeps have independent exhaustion keys', () => {
  const keyer = between(
    playback,
    'function sweepDimKey(',
    '\nasync function exhaustedMap(',
  );
  assert.match(keyer, /\["tagged", "untagged"\]\.includes\(speechTarget\)/);
  assert.match(keyer, /`whisper-\$\{speechTarget\}`/);
  assert.doesNotMatch(keyer, /const dim = subtitleTarget \? "subtitle" : \(mode \|\| "vod"\)/);
});

test('exact movie probes enqueue strict und certification before releasing the file lease', () => {
  const worker = between(
    playback,
    'async function runOneDimension(',
    '\nasync function runCatalogMirrorVerify(',
  );
  assert.match(worker, /const enqueueExactMovieUnknowns = async \(persisted: boolean\)/);
  assert.match(worker, /!usedGatewayProbe[\s\S]*orderedTracks\.some/);
  assert.match(worker, /enqueueAutomaticStrictLanguageValidation\(\{[\s\S]*itemType: "movie"/);
  assert.match(worker, /await enqueueExactMovieUnknowns\(persisted\)/);
});

test('production health and deploy verification expose the strict und protocol', () => {
  assert.match(playback, /version:\s*76/);
  assert.match(playback, /automaticStrictUndAudioProtocol:\s*1/);
  assert.match(playback, /automaticStrictUndAudioConsensus:\s*"4\/6"/);
  assert.match(deployEdge, /EXPECTED_PLAYBACK_VERSION=68/);
  assert.match(deployEdge, /automaticStrictUndAudioProtocol/);
  assert.match(deployEdge, /automaticStrictUndAudioConsensus/);
});
