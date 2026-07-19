'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  assert.notStrictEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notStrictEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
};

test('file crawler queues every unfinished movie variant, not one title default', () => {
  const migration = read('supabase/migrations/20260719170000_variant_file_audio_crawler.sql');
  const queue = between(
    migration,
    'create or replace function public.file_audio_backfill_candidates(',
    '\ncomment on function public.file_audio_backfill_candidates(',
  );

  assert.ok(queue.includes('variant.id as default_variant_id'));
  assert.ok(queue.includes('observation.variant_id = variant.id'));
  assert.ok(queue.includes('observation.file_external_id = variant.external_id'));
  assert.ok(queue.includes('not coalesce(observation.audio_observed, false)'));
  assert.ok(!queue.includes('title.default_variant_id = variant.id'));

  // Regression model: observing one sibling must remove exactly that file, not
  // the logical title and all its other versions.
  const variants = ['english', 'french', 'netflix', 'arabic-subs'];
  const pending = (observed) => variants.filter((variant) => !observed.has(variant));
  assert.deepStrictEqual(pending(new Set()), variants);
  assert.deepStrictEqual(
    pending(new Set(['french'])),
    ['english', 'netflix', 'arabic-subs'],
  );
});

test('untagged Whisper queue is exact-file scoped and reuses every canonical cache key', () => {
  const migration = read('supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql');
  const queue = between(
    migration,
    'create or replace function public.file_whisper_candidate_variants(',
    '\nrevoke all on function public.file_whisper_candidate_variants(',
  );

  assert.ok(queue.includes('variant.audio_whisper_attempted_at'));
  assert.ok(queue.includes("cache.item_type = 'movie'"));
  assert.ok(queue.includes('cache.external_id = variant.external_id'));
  assert.ok(queue.includes('catalog_source_provider_identities'));
  assert.ok(queue.includes('verified_identity.identity_id::text'));
  assert.ok(queue.includes("'source:' || source.id::text"));
  assert.ok(!queue.includes('config_hint'));
});

test('audio crawler hydrates cache before provider I/O and persists exact empty maps', () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const crawler = between(
    playback,
    'const exactFileScope =',
    '\n// Read-cutover trust artifact',
  );

  assert.ok(crawler.includes('db.rpc("file_audio_backfill_candidates"'));
  assert.ok(crawler.includes('const effConcurrency = exactFileScope || footprint?.lowFootprint ? 1'));
  assert.ok(crawler.includes('db.rpc("merge_cloud_title_file_languages"'));
  assert.ok(crawler.includes('diag.cacheHydrated++'));
  assert.ok(crawler.indexOf('diag.cacheHydrated++') < crawler.indexOf('resolvePlaybackTarget('));
  assert.ok(crawler.includes('claimProviderFileProbe'));
  assert.ok(crawler.includes('releaseProviderFileProbe'));
  assert.ok(crawler.includes('provider_probe_circuit_record_tick'));
  assert.ok(crawler.includes('candidateFootprint?.lowFootprint'));

  const exactEmpty = between(
    crawler,
    'if (!incoming.length && !hasTracks)',
    '\n        for (const code of incoming)',
  );
  assert.ok(exactEmpty.includes('if (exactFileScope)'));
  assert.ok(exactEmpty.includes('shareFileTracks('));
  assert.ok(exactEmpty.includes('true,'));
});

test('catalog canonicalizes ISO-639-2 evidence before an audio-filter match', () => {
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const aliases = between(
    catalog,
    'const FILE_LANGUAGE_ALIASES:',
    '\nfunction canonicalFileLanguage(',
  );
  const observation = between(
    catalog,
    'function attachFileLanguageObservation(',
    '\n// Attach the GLOBAL cache entry',
  );
  const ranking = between(
    catalog,
    'if (requiredAudioIso) {',
    '\n  return variantsByTitle;',
  );

  assert.match(aliases, /eng:\s*"en"/);
  assert.match(aliases, /fre:\s*"fr"/);
  assert.match(aliases, /fra:\s*"fr"/);
  assert.ok(observation.includes('canonicalFileLanguages(observation.audio_languages)'));
  assert.ok(ranking.includes('canonicalFileLanguage(requiredAudioIso)'));
  assert.ok(ranking.includes('canonicalFileLanguage(track?.lang ?? track?.language)'));
  assert.ok(ranking.includes('canonicalFileLanguage(language)'));
});

test('gateway-selected audio index survives the edge response metadata', () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const gateway = between(
    playback,
    'async function createGatewaySession(',
    '\nasync function requestGatewaySession(',
  );
  const response = between(
    playback,
    'const responseCodecProfile = mergeCodecProfileAnnotations(',
    '\nasync function getPlaybackSession',
  );

  assert.ok(gateway.includes('gatewayBody.audioStreamIndex'));
  assert.ok(gateway.includes('gatewayHints.audioStreamIndex'));
  assert.ok(gateway.includes('audioStreamIndex,'));
  assert.ok(response.includes('gatewaySessionResponse'));
  assert.ok(response.includes('audioStreamIndex: gateway.audioStreamIndex ?? null'));
  assert.ok(response.includes('audio_stream_index: gateway.audioStreamIndex ?? null'));
});

test('tagged-language verification uses the fast basic detector and remains variant-safe', () => {
  const migration = read('supabase/migrations/20260719170000_variant_file_audio_crawler.sql');
  const fastMigration = read('supabase/migrations/20260719210000_fast_audio_language_detection.sql');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const gatewaySource = read('services/media-gateway/src/index.js');
  const suspects = between(
    fastMigration,
    'create or replace function public.file_audio_tag_suspect_variants(',
    '\nrevoke all on function public.file_audio_tag_suspect_variants(',
  );
  const basicOutcome = between(
    fastMigration,
    'create or replace function public.record_catalog_file_audio_whisper_outcome(',
    '\nrevoke all on function public.record_catalog_file_audio_whisper_outcome(',
  );
  const detectedUpsert = between(
    fastMigration,
    'create or replace function public.upsert_catalog_file_detected_tracks(',
    '\nrevoke all on function public.upsert_catalog_file_detected_tracks(',
  );
  const detectedFanout = between(
    fastMigration,
    'create or replace function public.fanout_detected_file_tracks_to_users(',
    '\nrevoke all on function public.fanout_detected_file_tracks_to_users(',
  );
  const verifier = between(
    playback,
    'async function verifyTaggedAudioLanguages(',
    '\n// Resolve the parent title plus the exact variant codec profile',
  );

  assert.ok(suspects.includes('variant.id as default_variant_id'));
  assert.ok(suspects.includes('variant.audio_lang_verified_at'));
  assert.ok(suspects.includes('cache.audio_lang_verified_at'));
  assert.ok(suspects.includes('greatest('));
  assert.ok(suspects.includes('cache.audio_tracks'));
  assert.ok(suspects.includes('p_title_ids uuid[] default null'));
  assert.ok(suspects.includes('title.id = any(p_title_ids)'));
  assert.ok(suspects.includes('candidate.audio_lang_verified_at is null'));
  assert.ok(suspects.includes('cache.audio_whisper_retry_at'));
  assert.ok(suspects.includes('variant.audio_whisper_retry_at'));
  assert.ok(playback.includes('db.rpc("file_audio_tag_suspect_variants"'));
  assert.ok(verifier.includes('if (fileScoped && variantId)'));
  assert.ok(verifier.includes('.from("cloud_title_variants")'));
  assert.ok(verifier.includes('const persisted = await shareFileTracks('));
  assert.ok(verifier.includes('db.rpc("record_catalog_file_audio_whisper_outcome"'));
  assert.ok(!verifier.includes('record_catalog_file_audio_verification'));
  assert.ok(!basicOutcome.includes('audio_lang_verified_at'));
  assert.ok(!basicOutcome.includes('audio_lang_verification'));
  assert.ok(basicOutcome.includes('audio_whisper_retry_at = p_retry_at'));
  assert.ok(detectedUpsert.includes('cache.audio_lang_verified_at is not null'));
  assert.ok(detectedUpsert.includes("jsonb_build_object(\n        'status', 'detected'"));
  assert.ok(!detectedUpsert.includes("in ('validating', 'pending')"));
  assert.ok(playback.includes('"upsert_catalog_file_detected_tracks"'));
  assert.ok(playback.includes('"fanout_detected_file_tracks_to_users"'));
  assert.ok(detectedFanout.includes('v_owner_verified'));
  assert.ok(detectedFanout.includes('v_cache_verified or not v_owner_verified'));
  assert.ok(detectedFanout.includes('and observation.audio_verified_at is null'));
  assert.ok(verifier.includes('`${detectBase}?index=${t.index}&dur=20`'));
  assert.ok(verifier.includes('AbortSignal.timeout(90_000)'));
  assert.ok(verifier.includes('if (!lang || words < 4)'));
  assert.ok(verifier.includes('method: "whisper-basic-v1"'));
  assert.ok(verifier.includes('await recordDetection(classified'));
  assert.ok(verifier.includes('status: classified ? "detected" : "pending"'));
  assert.ok(!verifier.includes('recordVerification'));
  assert.ok(!verifier.includes('strict=1'));
  assert.ok(!verifier.includes('whisper-strict-consensus-v4'));
  assert.ok(verifier.includes('speechVerifiedAt'));
  assert.ok(verifier.includes('.slice(0, 2)'));
  assert.ok(playback.includes('if (verificationWork >= verifyLimit) break'));
  assert.ok(!playback.includes('if (verificationWork >= 1 || verified >= verifyLimit) break'));
  assert.ok(playback.includes('speechTarget === "tagged" ? limit : Math.ceil(limit / 2)'));
  assert.ok(playback.includes('), 2));'));
  assert.ok(!playback.includes('explicitVerifyIds.length * 32'));
  assert.ok(playback.includes('verificationWork += 1'));
  assert.ok(playback.includes('p_title_ids: explicitVerifyIds.length ? explicitVerifyIds : null'));
  assert.ok(playback.includes('fileScoped: fileWhisperScope'));
  assert.ok(playback.includes('claimProviderFileProbe(db, identityKey, whisperLeaseOwner, 600)'));
  assert.ok(playback.includes('claimProviderFileProbe(db, identityKey, verifyLeaseOwner, 900)'));
  assert.ok(migration.includes('least(900, coalesce(p_ttl_seconds, 150))'));
  assert.ok(migration.includes('add column if not exists audio_lang_verification jsonb'));
  assert.ok(migration.includes('add column if not exists audio_lang_retry_at timestamptz'));
  assert.ok(migration.includes('create or replace function public.record_catalog_file_audio_verification('));
  assert.ok(verifier.includes('pendingVerdictCount'));
  assert.ok(verifier.includes('minWords: 4'));
  assert.ok(gatewaySource.includes('const consensusNeeded ='));
  assert.ok(gatewaySource.includes('WHISPER_STRICT_MIN_PROBABILITY'));
  assert.ok(gatewaySource.includes('WHISPER_STRICT_MIN_WORDS'));
  assert.ok(gatewaySource.includes('WHISPER_STRICT_MIN_UNIQUE_WORDS'));
  assert.ok(gatewaySource.includes('!strict && voteCount >= consensusNeeded'));
  assert.ok(gatewaySource.includes('strictSamples.length >= consensusNeeded'));
  assert.ok(gatewaySource.includes('votes.size === 1'));
  assert.ok(gatewaySource.includes('strictRejectedSpeechSamples === 0'));
  assert.ok(gatewaySource.includes('fifth/sixth accepted sample that disagrees must veto'));
  assert.ok(gatewaySource.includes("validationStatus: 'pending'"));
  assert.ok(gatewaySource.includes("validationStatus: 'verified'"));
});

test('unknown audio tracks use the fast basic detector with resumable bounded work', () => {
  const migration = read('supabase/migrations/20260719170000_variant_file_audio_crawler.sql');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const detector = between(
    playback,
    'async function detectUntaggedAudioLanguages(',
    '\n// Verify TAGGED-but-contradictory tracks',
  );

  assert.ok(detector.includes('.slice(0, 2)'));
  assert.ok(detector.includes('for (const track of pending)'));
  assert.ok(detector.includes('`${detectBase}?index=${track.index}&dur=20`'));
  assert.ok(detector.includes('AbortSignal.timeout(90_000)'));
  assert.ok(detector.includes('method: "whisper-basic-v1"'));
  assert.ok(detector.includes('det?.confident === true && words >= 4'));
  assert.ok(detector.includes('track.lidVerdict = "detected"'));
  assert.ok(detector.includes('status: completed ? "detected" : "pending"'));
  assert.ok(!detector.includes('track.lidVerdict = "verified"'));
  assert.ok(!detector.includes('strict=1'));
  assert.ok(!detector.includes('whisper-strict-consensus-v4'));
  assert.ok(detector.includes('lidAttemptedAt'));
  assert.ok(detector.includes('if (!res.ok) continue'));
  assert.ok(detector.includes('record_catalog_file_audio_whisper_outcome'));
  assert.ok(!playback.includes('if (verificationWork > 0)'));
  assert.ok(playback.includes('}).slice(0, Math.max(1, Math.min(limit, 4)))'));
  assert.ok(playback.includes('const fileExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()'));
  assert.ok(playback.includes('expiresAt: fileExpiresAt'));
  assert.ok(migration.includes('audio_whisper_retry_at'));
  assert.ok(migration.includes('record_catalog_file_audio_whisper_outcome'));
});

test('database language parser collapses terminology and bibliographic aliases', () => {
  const migration = read('supabase/migrations/20260719170000_variant_file_audio_crawler.sql');
  const parser = between(
    migration,
    'create or replace function public.cloud_file_track_languages(',
    '\nrevoke all on function public.cloud_file_track_languages(jsonb)',
  );

  assert.ok(parser.includes("when 'fre' then 'fr'"));
  assert.ok(parser.includes("when 'fra' then 'fr'"));
  assert.ok(parser.includes("when 'eng' then 'en'"));
  assert.ok(parser.includes('array_agg(distinct language_code'));
  assert.ok(migration.includes('update public.cloud_title_file_language_observations observation'));
  assert.ok(migration.includes('title.file_audio_languages is distinct from unions.audio_languages'));
});

test('strict correction survives later raw probes and securely reaches current and future owners', () => {
  const crawlerMigration = read('supabase/migrations/20260719170000_variant_file_audio_crawler.sql');
  const fleetMigration = read('supabase/migrations/20260719180000_dynamic_enrichment_fleet.sql');
  const projection = read('supabase/functions/_shared/vod-title-projection.ts');
  const catalog = read('supabase/functions/norva-catalog/index.ts');
  const rawUpsert = between(
    crawlerMigration,
    'create or replace function public.upsert_catalog_file_tracks(',
    '\nrevoke all on function public.upsert_catalog_file_tracks(',
  );
  const fanout = between(
    fleetMigration,
    'create or replace function public.fanout_file_tracks_to_users(',
    '\nrevoke all on function public.fanout_file_tracks_to_users(',
  );
  const hydrate = between(
    fleetMigration,
    'create or replace function public.hydrate_cloud_title_file_languages(',
    '\nrevoke all on function public.hydrate_cloud_title_file_languages(',
  );
  const verification = between(
    fleetMigration,
    'create or replace function public.record_catalog_file_audio_verification(',
    '\nrevoke all on function public.record_catalog_file_audio_verification(',
  );

  assert.ok(rawUpsert.includes('cache.audio_lang_verified_at is not null'));
  assert.ok(rawUpsert.includes("cache.audio_lang_verification->>'status' in ('validating', 'pending')"));
  assert.ok(rawUpsert.includes('then cache.audio_tracks'));
  assert.ok(rawUpsert.includes('catalog_audio_track_indexes(cache.audio_tracks)'));
  assert.ok(rawUpsert.includes('catalog_audio_track_indexes(coalesce(p_audio_tracks'));

  for (const body of [fanout, hydrate, verification]) assert.ok(!body.includes('config_hint'));
  for (const body of [fanout, verification]) {
    assert.ok(body.includes('catalog_source_provider_identities'));
    assert.ok(body.includes('verified_identity.identity_id::text'));
    assert.ok(body.includes("'source:' || source.id::text"));
  }
  assert.ok(hydrate.includes('catalog_source_file_cache_key'));
  assert.ok(fanout.includes('select cache.*'));
  assert.ok(fanout.includes('mark_cloud_title_file_audio_verification'));
  assert.ok(hydrate.includes('audio_lang_verified_at'));
  assert.ok(hydrate.includes('audio_verification'));
  assert.ok(verification.includes('merge_cloud_title_file_languages'));
  assert.ok(verification.includes('mark_cloud_title_file_audio_verification'));

  assert.ok(projection.includes('catalog_source_provider_identities'));
  assert.ok(projection.includes('return identityId || `source:${sourceId}`'));
  assert.ok(!between(
    projection,
    'async function resolveProjectionCacheKey(',
    '\nfunction boundedProviderOverview(',
  ).includes('config_hint'));
  assert.ok(catalog.includes('context.exactKeysBySource.set(sourceId, [`source:${sourceId}`])'));
});
