'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs
  .readFileSync(path.join(ROOT, file), 'utf8')
  .replace(/\r\n?/g, '\n');
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

test('audio crawler hydrates valid cache and keeps parser misses retryable', () => {
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
  assert.ok(crawler.includes('runProviderProbeWithLease'));
  assert.ok(playback.includes('await releaseProviderFileProbe(db, identityKey, owner)'));
  assert.ok(crawler.includes('provider_probe_circuit_record_tick'));
  assert.ok(crawler.includes('candidateFootprint?.lowFootprint'));
  assert.ok(crawler.includes('cachedAudioTracks.length > 0'));
  assert.ok(crawler.includes('versionTags.includes("multi")'));
  assert.ok(crawler.includes('await new Promise((resolve) => setTimeout(resolve, 2_500))'));
  assert.ok(crawler.includes('const relaySubtitleComplete = authoritativeProbeFacetComplete('));
  assert.ok(crawler.includes('if (!gatewayFallback)'));
  assert.ok(crawler.includes('if (!relaySubtitleComplete) return;'));
  assert.ok(crawler.includes('info = relayInfo;'));
  assert.ok(crawler.includes('subtitles: relaySubtitleTracks'));
  assert.ok(crawler.includes('subtitleProbeComplete: true'));
  assert.ok(crawler.includes('const gatewaySubtitleComplete = authoritativeProbeFacetComplete('));
  assert.ok(crawler.includes('const subtitleObservation = mode === "probe"'));
  assert.ok(crawler.includes('subtitleProbeObservation('));
  assert.ok(crawler.includes('const subtitleProbeComplete = subtitleObservation.complete'));

  const exactEmpty = between(
    crawler,
    'if (!audioProbeComplete && !subtitleProbeComplete)',
    '\n        if (!audioProbeComplete)',
  );
  assert.ok(exactEmpty.includes('diag.relayEmpty++'));
  assert.ok(exactEmpty.includes('return;'));
  assert.ok(!exactEmpty.includes('shareFileTracks('));
  assert.ok(!exactEmpty.includes('markProbed('));

  const subtitleOnly = between(
    crawler,
    'if (!audioProbeComplete) {',
    '\n        for (const code of incoming)',
  );
  assert.ok(subtitleOnly.includes('shareFileTracks('));
  assert.match(subtitleOnly, /orderedSubtitles,\s*\n\s*false,\s*\n\s*true,/);
});

test('relay and gateway expose independent authoritative probe markers', () => {
  const relay = read('services/norva-relay/src/index.js');
  const gateway = read('services/media-gateway/src/index.js');

  assert.ok(relay.includes('/__probeaudio/v4/'));
  assert.ok(relay.includes('audioProbeComplete: false'));
  assert.ok(relay.includes('out.audioProbeComplete = tracks.length > 0'));
  assert.ok(relay.includes(
    'out.subtitleProbeComplete = tracks.length > 0 || container.subtitleTracks.length > 0',
  ));
  assert.ok(relay.includes('if (cacheKey && out.audioProbeComplete)'));

  const endpoint = between(
    gateway,
    'async function handleProbeAudioRequest',
    "\napp.post('/probe-audio'",
  );
  assert.ok(endpoint.includes('hasCompleteMkvPlaybackProfile(profile)'));
  assert.match(
    endpoint,
    /probeCodecProfileUncached\(url, ua, \{\s*background: true,\s*backgroundActivityKind: ACCOUNT_ACTIVITY_KIND_CATALOG_REFRESH,\s*providerDrainState,/,
  );
  assert.ok(endpoint.includes('audioProbeComplete: authoritativeTrackMap && audioTracks.length > 0'));
  assert.ok(endpoint.includes('subtitleProbeComplete: authoritativeTrackMap'));
  assert.ok(endpoint.includes('providerProbeDrainAttestation(providerDrainState)'));
});

test('repair migration clears poisoned movie probes and prioritizes MULTI safely', () => {
  const migration = read(
    'supabase/migrations/20260831134040_vod_audio_probe_persistence_repair_v1.sql',
  );

  assert.ok(migration.includes('norva_poisoned_movie_audio_cache'));
  assert.ok(migration.includes('audio_probed_at = null'));
  assert.ok(migration.includes('audio_observed = false'));
  assert.ok(migration.includes('catalog_file_tracks_movie_audio_probe_nonempty_ck'));
  assert.ok(migration.includes('jsonb_array_length(audio_tracks) > 0'));
  assert.ok(migration.includes("title.version_languages @> array['multi']::text[]"));
  assert.ok(migration.includes('schedule.dispatch_count - mod(schedule.dispatch_count, 12)'));
  assert.ok(migration.includes("affected.source_id::text || ':movie:probe'"));
  assert.ok(migration.includes('schedule.lease_until is null'));
  assert.ok(migration.includes('from public.cloud_title_variants variant'));
  assert.ok(migration.includes('join public.cloud_catalog_visible_sources source'));
  const owners = between(
    migration,
    'create temporary table norva_poisoned_movie_audio_owners',
    '\ncreate unique index norva_poisoned_movie_audio_owners_pk',
  );
  assert.ok(owners.includes('variant.id as variant_id'));
  assert.ok(!owners.includes('observation.audio_observed'));
  assert.ok(!migration.includes('update public.cloud_title_variants variant'));
  assert.ok(migration.includes('proof-aware hydration RPC refreshes'));
  assert.ok(migration.includes('revoke all on function public.file_audio_backfill_candidates('));
  assert.ok(migration.includes('to service_role'));
  assert.ok(!migration.includes('subtitle_observed = false'));
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
    'const responseCodecProfile = stripMkvH264FastStartProof(mergeCodecProfileAnnotations(',
    '\nasync function getPlaybackSession',
  );

  assert.ok(gateway.includes('gatewayBody.audioStreamIndex'));
  assert.ok(gateway.includes('gatewayHints.audioStreamIndex'));
  assert.ok(gateway.includes('audioStreamIndex,'));
  assert.ok(response.includes('gatewaySessionResponse'));
  assert.ok(response.includes('audioStreamIndex: gateway.audioStreamIndex ?? null'));
  assert.ok(response.includes('audio_stream_index: gateway.audioStreamIndex ?? null'));
});

test('tagged-language verification keeps the historical transcript verdict variant-safe', () => {
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
  assert.ok(verifier.includes('catalogGeneration = await readActiveCatalogGenerationSnapshot('));
  assert.ok(verifier.includes('await patchActiveCatalogTitleVariants(db, {'));
  assert.ok(verifier.includes('generation: catalogGeneration'));
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
  assert.ok(verifier.includes('`${detectBase}?index=${t.index}&dur=20&consensus=2`'));
  assert.ok(verifier.includes('AbortSignal.timeout(120_000)'));
  assert.ok(verifier.includes('const evidence = basicLidEvidence(det)'));
  assert.ok(verifier.includes('if (!evidence.accepted || !lang)'));
  assert.ok(verifier.includes('method: "whisper-basic-v1"'));
  assert.ok(verifier.includes('detectionMethods: [...detectionMethods].sort()'));
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
  assert.ok(playback.includes('claimProviderFileProbe(db, identityKey, candidateLeaseOwner, 600)'));
  assert.ok(playback.includes('claimProviderFileProbe(db, identityKey, verifyLeaseOwner, 900)'));
  assert.ok(migration.includes('least(900, coalesce(p_ttl_seconds, 150))'));
  assert.ok(migration.includes('add column if not exists audio_lang_verification jsonb'));
  assert.ok(migration.includes('add column if not exists audio_lang_retry_at timestamptz'));
  assert.ok(migration.includes('create or replace function public.record_catalog_file_audio_verification('));
  assert.ok(verifier.includes('pendingVerdictCount'));
  assert.ok(verifier.includes('consensus: 2'));
  assert.ok(verifier.includes('minConfidence: 0.95'));
  assert.ok(verifier.includes('minWords: 12'));
  assert.ok(verifier.includes('minUniqueWords: 8'));
  assert.ok(!verifier.includes('db.rpc("merge_catalog_title_audio"'));
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

test('unknown audio tracks accept explicit basic-LID evidence with resumable bounded work', () => {
  const migration = read('supabase/migrations/20260719170000_variant_file_audio_crawler.sql');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const detector = between(
    playback,
    'async function detectUntaggedAudioLanguages(',
    '\n// Verify TAGGED-but-contradictory tracks',
  );

  assert.ok(detector.includes('.slice(0, 2)'));
  assert.ok(detector.includes('for (const track of pending)'));
  assert.ok(detector.includes('`${detectBase}?index=${track.index}&dur=20&consensus=2`'));
  assert.ok(detector.includes('AbortSignal.timeout(180_000)'));
  assert.ok(detector.includes('const evidence = basicLidEvidence(det)'));
  assert.ok(detector.includes('const multiWindowConsensus = Number(det?.consensus ?? 0) >= 2'));
  assert.ok(detector.includes('if (evidence.accepted && evidence.lang && multiWindowConsensus)'));
  assert.ok(detector.includes('track.lidMethod = evidence.method'));
  assert.ok(detector.includes('track.lidConfidence = evidence.confidence'));
  assert.ok(detector.includes('enriched.map((t) => t.lidMethod)'));
  assert.ok(detector.includes('track.lidVerdict = "detected"'));
  assert.ok(detector.includes('status: completed ? "detected" : "pending"'));
  assert.ok(!detector.includes('track.lidVerdict = "verified"'));
  assert.ok(!detector.includes('strict=1'));
  assert.ok(!detector.includes('whisper-strict-consensus-v4'));
  assert.ok(detector.includes('lidAttemptedAt'));
  assert.ok(detector.includes('if (!res.ok) continue'));
  assert.ok(detector.includes('record_catalog_file_audio_whisper_outcome'));
  assert.ok(detector.includes('consensus: 2'));
  assert.ok(detector.includes('two-window-gateway-consensus-v3'));
  assert.ok(!playback.includes('if (verificationWork > 0)'));
  assert.ok(playback.includes('}).slice(0, Math.max(1, Math.min(limit, 4)))'));
  assert.ok(playback.includes('const fileExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()'));
  assert.ok(playback.includes('expiresAt: fileExpiresAt'));
  assert.ok(migration.includes('audio_whisper_retry_at'));
  assert.ok(migration.includes('record_catalog_file_audio_whisper_outcome'));
});

test('Edge rollout is signed, dynamically reversible and keeps fast evidence scoped', () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const migration = read('supabase/migrations/20260720120000_audio_lid_rollout_flags.sql');
  const bytePipe = between(
    playback,
    'async function createBytePipeCapability(',
    '\nasync function createGatewaySession(',
  );
  const policy = between(
    playback,
    'async function getLidDetectionPolicy(',
    '\nasync function decryptSourceConfig(',
  );
  const evidence = between(
    playback,
    'function basicLidConsensusSampleAccepted(',
    '\n// Probe a title',
  );
  const detector = between(
    playback,
    'async function detectUntaggedAudioLanguages(',
    '\n// Verify TAGGED-but-contradictory tracks',
  );
  const verifier = between(
    playback,
    'async function verifyTaggedAudioLanguages(',
    '\n// Resolve the parent title plus the exact variant codec profile',
  );
  const health = between(
    playback,
    'if (req.method === "GET" && segments[0] === "health")',
    '\n    if (req.method === "GET" && segments[0] === "telemetry"',
  );

  // A browser query parameter cannot opt into a rollout. The Edge embeds the
  // selected scope inside the HMAC-signed byte-pipe payload.
  assert.ok(bytePipe.includes('...(scope ? { scope } : {})'));
  assert.ok(bytePipe.includes('hmacBase64Url(gatewayRoute.token, payload)'));
  assert.ok(
    bytePipe.indexOf('...(scope ? { scope } : {})') <
      bytePipe.indexOf('hmacBase64Url(gatewayRoute.token, payload)'),
  );

  // The database is consulted independently from runtime secrets, so the kill
  // switch and rollout mode refresh even when all gateway config comes from env.
  assert.ok(policy.includes('.from("admin_feature_flags")'));
  for (const flag of [
    'audio_lid_enabled',
    'lid_detect_only_shadow_enabled',
    'lid_detect_only_production_enabled',
  ]) {
    assert.ok(policy.includes(`"${flag}"`));
    assert.ok(migration.includes(`'${flag}'`));
  }
  assert.ok(policy.includes('lidDetectionPolicyCache = { value, expiresAt: Date.now() + 30_000 }'));
  assert.match(policy, /const enabled = !flags\.has\("audio_lid_enabled"\)[\s\S]*=== true/);
  assert.ok(policy.includes('const conflict = primary && shadow'));
  assert.match(
    policy,
    /mode: !enabled \? "off" : \(conflict \? "conflict" : \(primary \? "primary" : \(shadow \? "shadow" : "off"\)\)\)/,
  );
  assert.match(
    policy,
    /untaggedScope: enabled[\s\S]*primary \? "lid-production-detect-only"[\s\S]*shadow \? "lid-shadow"/,
  );
  // Primary is deliberately absent from taggedScope: mistag correction remains
  // on full transcription. Shadow may compare, but its returned verdict is full.
  assert.ok(policy.includes('taggedScope: enabled && shadow && !conflict ? "lid-shadow" : null'));
  assert.ok(detector.includes('lidPolicy.untaggedScope'));
  assert.ok(verifier.includes('lidPolicy.taggedScope'));
  assert.ok(detector.includes('if (!lidPolicy.enabled) return'));
  assert.ok(verifier.includes('if (!lidPolicy.enabled) return null'));

  assert.match(migration, /'audio_lid_enabled',\s*\n\s*true/);
  assert.match(migration, /'lid_detect_only_shadow_enabled',\s*\n\s*false/);
  assert.match(migration, /'lid_detect_only_production_enabled',\s*\n\s*false/);
  assert.ok(migration.includes('on conflict (key) do nothing'));

  // Transcript evidence is conservative and multi-window. Detect-only keeps
  // its distinct signed contract and may never impersonate verification.
  assert.ok(evidence.includes('method === "whisper-detect-only-v1"'));
  assert.ok(evidence.includes('sample?.evidence === "lid-only-high-confidence"'));
  assert.ok(evidence.includes('sample?.fastPathAccepted === true'));
  assert.ok(evidence.includes('sample?.confident !== true'));
  assert.ok(evidence.includes('sample?.verified === false'));
  assert.ok(evidence.includes('sample?.fallbackUsed === false'));
  assert.ok(evidence.includes('sample?.validationStatus === "pending"'));
  assert.ok(evidence.includes('confidence < 0.95'));
  assert.ok(evidence.includes('words === 0'));
  assert.ok(evidence.includes('whisperConfidence >= 0.95'));
  assert.ok(evidence.includes('words >= 12'));
  assert.ok(evidence.includes('uniqueWords >= 8'));
  assert.ok(evidence.includes('consensus >= 2'));

  // All basic/provisional evidence stays exact-file/tenant scoped. Only the
  // strict certification path may populate the irreversible global union.
  assert.ok(detector.includes('track.lidMethod = evidence.method'));
  assert.ok(detector.includes('lidMethod: t.lidMethod'));
  assert.ok(detector.includes('enriched.map((t) => t.lidMethod)'));
  assert.ok(detector.includes('t.lidMethod === "whisper-detect-only-v1"'));
  assert.ok(!detector.includes('db.rpc("merge_catalog_title_audio"'));
  assert.ok(!verifier.includes('db.rpc("merge_catalog_title_audio"'));
  assert.ok(detector.includes('method: detectOnlyDetectedCount > 0'));
  assert.ok(detector.includes('? "whisper-detect-only-v1"'));
  assert.ok(playback.includes('lidMethod: stringOrNull(x?.lidMethod ?? x?.lid_method)'));
  assert.ok(playback.includes('"refresh_catalog_file_audio_detection_provenance"'));
  assert.ok(migration.includes('create or replace function public.refresh_catalog_file_audio_detection_provenance('));
  assert.ok(migration.includes("track->>'lidMethod' = 'whisper-detect-only-v1'"));
  assert.ok(migration.includes("'method', v_method"));
  assert.ok(migration.includes('observation.audio_verified_at is null'));
  assert.ok(detector.includes(': "whisper-basic-v1"'));

  assert.ok(health.includes('version: 72'));
  assert.ok(health.includes('exactTrackCrawlerProtocol: 2'));
  assert.ok(health.includes('basicLidConsensusProtocol: 2'));
  assert.ok(health.includes('lidDetectOnlyProtocol: 1'));
  assert.ok(health.includes('audioLidEnabled: lidPolicy.enabled'));
  assert.ok(health.includes('lidDetectOnlyMode: lidPolicy.mode'));
});

test('basic transcript LID requires two individually strong windows', () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const source = between(
    playback,
    'function basicLidConsensusSampleAccepted(',
    '\n// Probe a title',
  )
    .replace(/: JsonRecord \| null/g, '')
    .replace(/: string/g, '')
    .replace(/: boolean/g, '')
    .replace(/\): BasicLidEvidence/g, ')')
    .replace(/ as JsonRecord\[\]/g, '');
  const basicLidEvidence = vm.runInNewContext(
    `(() => {
      const stringOrNull = (value) => value == null || value === '' ? null : String(value);
      const normalizeIsoLang = (value) => /^[a-z]{2,3}$/i.test(String(value || ''))
        ? String(value).toLowerCase()
        : null;
      ${source}
      return basicLidEvidence;
    })()`,
  );
  const strongSample = {
    language: 'fr', method: 'whisper-transcript-agreement-v1',
    confident: true, confidence: 0.95, whisperConfidence: 0.97,
    transcriptAgrees: true, wordCount: 12, uniqueWordCount: 8,
  };
  const strong = {
    ...strongSample,
    consensus: 2,
    samples: [{ ...strongSample }, { ...strongSample }],
  };
  const weakSample = { ...strongSample, wordCount: 4, uniqueWordCount: 3 };

  assert.equal(basicLidEvidence(strong).accepted, true);
  assert.equal(basicLidEvidence({ ...strong, confidence: 0.949 }).accepted, false);
  assert.equal(basicLidEvidence({ ...strong, wordCount: 11 }).accepted, false);
  assert.equal(basicLidEvidence({ ...strong, uniqueWordCount: 7 }).accepted, false);
  assert.equal(basicLidEvidence({ ...strong, consensus: 1 }).accepted, false);
  assert.equal(basicLidEvidence({
    ...strong,
    samples: [weakSample, { ...strongSample }],
  }).accepted, false, 'one weak vote cannot borrow the final window evidence');
});

test('gateway method calibration reaches Edge for strong ja/zh/ar/ru Whisper agreement', () => {
  const gateway = read('services/media-gateway/src/index.js');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const gatewaySource = between(
    gateway,
    'const BASIC_LID_MIN_CONFIDENCE',
    '\nfunction strictLanguageBatchSampleResult',
  );
  const edgeSource = between(
    playback,
    'function basicLidConsensusSampleAccepted(',
    '\n// Probe a title',
  )
    .replace(/: JsonRecord \| null/g, '')
    .replace(/: string/g, '')
    .replace(/: boolean/g, '')
    .replace(/\): BasicLidEvidence/g, ')')
    .replace(/ as JsonRecord\[\]/g, '');
  const qualifyGatewaySample = vm.runInNewContext(
    `(() => { ${gatewaySource}; return basicLidConsensusSample; })()`,
  );
  const acceptAtEdge = vm.runInNewContext(
    `(() => {
      const stringOrNull = (value) => value == null || value === '' ? null : String(value);
      const normalizeIsoLang = (value) => /^[a-z]{2,3}$/i.test(String(value || ''))
        ? String(value).toLowerCase()
        : null;
      ${edgeSource}
      return basicLidEvidence;
    })()`,
  );

  for (const [language, transcriptConfidence, evidenceBasis] of [
    ['ja', 0.90, 'cjk-character-bigrams'],
    ['zh', 0.82, 'cjk-character-bigrams'],
    ['ar', 0.85, 'whitespace-words'],
    ['ru', 0.78, 'whitespace-words'],
  ]) {
    const window = {
      language,
      method: 'whisper-transcript-agreement-v1',
      confident: true,
      confidence: 0.98,
      whisperConfidence: 0.98,
      transcriptConfidence,
      transcriptAgrees: true,
      wordCount: 12,
      uniqueWordCount: 8,
      transcriptEvidenceBasis: evidenceBasis,
      verified: false,
      validationStatus: 'pending',
    };
    const first = qualifyGatewaySample(window);
    const second = qualifyGatewaySample({ ...window });
    assert.ok(first, `${language} first gateway window must qualify`);
    assert.ok(second, `${language} second gateway window must qualify`);
    assert.equal(acceptAtEdge({
      ...window,
      consensus: 2,
      samples: [first, second],
    }).accepted, true, `${language} must cross the gateway-to-Edge contract`);
  }
});

test('crawler provider guards and gateway handoff are fail closed', () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const claim = between(
    playback,
    'async function claimProviderFileProbe(',
    '\nasync function providerAccountBusyForCrawler(',
  );
  const busy = between(
    playback,
    'async function providerAccountBusyForCrawler(',
    '\nasync function releaseProviderFileProbe(',
  );
  const live = between(
    playback,
    'async function userHasLiveSession(',
    '\n// Crons ↔ pregen coordination',
  );
  const crawler = between(
    playback,
    'const exactFileScope =',
    '\n// Read-cutover trust artifact',
  );
  const gatewayProbe = between(
    playback,
    'const fetchGatewayProbe = async (stage: string)',
    '\n\n        if (preferGatewayProbe)',
  );

  assert.ok(claim.includes('if (!identityKey || !owner) return false'));
  assert.ok(claim.includes('if (error) return false'));
  assert.match(claim, /catch \(_\) \{\s*return false;/);
  assert.ok(busy.includes('if (!accountKey) return true'));
  assert.ok(busy.includes('db.rpc(\n      "provider_account_busy_for_catalog_refresh"'));
  assert.ok(!busy.includes('db.rpc("provider_account_busy"'));
  assert.ok(busy.includes('if (error) return true'));
  assert.ok(busy.includes('return data !== false'));
  assert.ok(live.includes('if (!userId) return true'));
  for (const guard of ['evError', 'histError', 'sessError']) {
    assert.ok(live.includes(`if (${guard}) return true`));
  }
  assert.ok(crawler.includes('providerAccountBusyForCrawler(db, accountKey)'));
  assert.ok(crawler.includes('skipped: "provider-guard-unavailable"'));
  const transportStart = gatewayProbe.indexOf('providerTransportMayBeActive = true');
  const gatewayFetch = gatewayProbe.indexOf('fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`');
  const drainGate = gatewayProbe.indexOf('providerProbeResponseAllowsLeaseRelease(');
  const terminalGate = gatewayProbe.indexOf('recordTerminalProbeFailure(');
  assert.ok(transportStart >= 0 && transportStart < gatewayFetch);
  assert.ok(drainGate > gatewayFetch && drainGate < terminalGate,
    'every Gateway response must resolve lease safety before terminal/non-2xx handling');
  assert.match(gatewayProbe, /catch \(_\) \{\s*if \(providerTransportMayBeActive\) leaseControl\.retainUntilExpiry\(\)/);
  assert.ok(gatewayProbe.includes('return null'));

  const relayProbe = between(
    crawler,
    'const endpoint = mode === "probe" ? "probe-audio" : "vod-info";',
    '\n        if (debug && !sample && token && !usedGatewayProbe)',
  );
  assert.ok(relayProbe.indexOf('acceptGatewayProviderDrain(relayInfo, leaseControl.retainUntilExpiry)')
    < relayProbe.indexOf('recordTerminalProbeFailure('));
  assert.match(relayProbe, /catch \(error\) \{\s*leaseControl\.retainUntilExpiry\(\);\s*throw error/,
    'Relay fetch/body exceptions must retain the file lease to TTL');
});

test('vod candidates are circuit-guarded and serialized by provider identity without dropping work', async () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const drainSource = between(
    playback,
    'function gatewayProviderDrainAttested(',
    '\nfunction strictLanguageProviderDrainAttested(',
  )
    .replace(/: JsonRecord/g, '')
    .replace(/: \(\) => void/g, '')
    .replace(/\): boolean/g, ')');
  const identitySource = between(
    playback,
    'async function resolveCandidateProviderIdentityKey(',
    '\nfunction newProviderProbeLeaseOwner(',
  )
    .replace(/: SupabaseClient/g, '')
    .replace(/: string/g, '')
    .replace(/\): Promise<string>/g, ')');
  const ownerSource = between(
    playback,
    'function newProviderProbeLeaseOwner(',
    '\nfunction authoritativeProbeFacetComplete(',
  )
    .replace(/: string/g, '');
  const facetSource = between(
    playback,
    'function authoritativeProbeFacetComplete(',
    '\nfunction createProviderIdentitySerialQueue(',
  )
    .replace(/: unknown/g, '')
    .replace(/: boolean/g, '')
    .replace(/: JsonRecord\[\]/g, '')
    .replace(/: string/g, '');
  const queueSource = between(
    playback,
    'function createProviderIdentitySerialQueue()',
    '\ntype ProviderProbeLeaseOutcome',
  )
    .replace('new Map<string, Promise<void>>()', 'new Map()')
    .replace('let unlock: () => void', 'let unlock')
    .replace(
      'return async function runSerial<T>(identityKey: string, task: () => Promise<T>): Promise<T>',
      'return async function runSerial(identityKey, task)',
    )
    .replace('new Promise<void>', 'new Promise');
  const guardSource = between(
    playback,
    'async function runProviderProbeWithLease<T>(',
    '\nasync function providerAccountBusyForCrawler(',
  )
    .replace('async function runProviderProbeWithLease<T>(', 'async function runProviderProbeWithLease(')
    .replace('db: SupabaseClient', 'db')
    .replace('identityKey: string', 'identityKey')
    .replace('owner: string', 'owner')
    .replace('ttlSeconds: number', 'ttlSeconds')
    .replace('task: (control: { retainUntilExpiry: () => void }) => Promise<T>', 'task')
    .replace('): Promise<ProviderProbeLeaseOutcome<T>>', ')')
    .replace('let circuit: { open: boolean; openUntil: string | null };', 'let circuit;');
  let identityLookups = 0;
  let randomOrdinal = 0;
  const leases = new Map();
  const lifecycle = [];
  const helpers = vm.runInNewContext(
    `(() => {
      const resolveSourceIdentity = async (sourceId, userId) => {
        identityLookups += 1;
        return { key: 'identity:' + userId + ':' + sourceId };
      };
      const claimProviderFileProbe = async (_db, identityKey, owner) => {
        lifecycle.push('claim:' + identityKey + ':' + owner);
        if (leases.has(identityKey)) return false;
        leases.set(identityKey, owner);
        return true;
      };
      const releaseProviderFileProbe = async (_db, identityKey, owner) => {
        lifecycle.push('release:' + identityKey + ':' + owner);
        if (leases.get(identityKey) === owner) leases.delete(identityKey);
      };
      const readProviderProbeCircuitStateStrict = async (db, identityKey) => {
        lifecycle.push('circuit:' + identityKey);
        if (db.failCircuit) throw new Error('circuit unavailable');
        return { open: db.circuitOpen === true, openUntil: db.circuitOpen ? 'later' : null };
      };
      ${identitySource}
      ${ownerSource}
      ${drainSource}
      ${facetSource}
      ${queueSource}
      ${guardSource}
      return {
        resolveCandidateProviderIdentityKey,
        newProviderProbeLeaseOwner,
        gatewayProviderDrainAttested,
        acceptGatewayProviderDrain,
        authoritativeProbeFacetComplete,
        subtitleProbeObservation,
        queue: createProviderIdentitySerialQueue(),
        runProviderProbeWithLease,
      };
    })()`,
    {
      identityLookups,
      leases,
      lifecycle,
      crypto: { randomUUID: () => `uuid-${++randomOrdinal}` },
    },
  );

  const vodIdentity = await helpers.resolveCandidateProviderIdentityKey(
    {},
    'source-vod',
    'user-vod',
    '',
  );
  assert.equal(vodIdentity, 'identity:user-vod:source-vod');

  const firstOwner = helpers.newProviderProbeLeaseOwner('whisper-tick', 'variant-1');
  const secondOwner = helpers.newProviderProbeLeaseOwner('whisper-tick', 'variant-1');
  assert.notEqual(firstOwner, secondOwner);

  let active = 0;
  let maxActive = 0;
  let providerCalls = 0;
  const runCandidate = (identityKey, owner, label) => helpers.queue(identityKey, () => (
    helpers.runProviderProbeWithLease({}, identityKey, owner, 150, async () => {
      lifecycle.push('provider:' + label);
      providerCalls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return label;
    })
  ));
  const sameIdentity = await Promise.all([
    runCandidate(vodIdentity, firstOwner, 'first'),
    runCandidate(vodIdentity, secondOwner, 'second'),
  ]);
  assert.deepEqual(sameIdentity.map((outcome) => outcome.status), ['completed', 'completed']);
  assert.equal(providerCalls, 2, 'serialization must not drop the queued candidate');
  assert.equal(maxActive, 1, 'same-identity provider callbacks never overlap');
  assert.ok(lifecycle.indexOf('circuit:' + vodIdentity) < lifecycle.indexOf('provider:first'));
  assert.equal(leases.size, 0);

  active = 0;
  maxActive = 0;
  let releaseDistinct;
  const distinctGate = new Promise((resolve) => { releaseDistinct = resolve; });
  const distinctTask = (identityKey, owner) => helpers.queue(identityKey, () => (
    helpers.runProviderProbeWithLease({}, identityKey, owner, 150, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) releaseDistinct();
      await distinctGate;
      active -= 1;
    })
  ));
  await Promise.all([
    distinctTask('identity:a', 'owner-a'),
    distinctTask('identity:b', 'owner-b'),
  ]);
  assert.equal(maxActive, 2, 'different provider identities may make progress concurrently');

  providerCalls = 0;
  const unavailable = await helpers.runProviderProbeWithLease(
    { failCircuit: true }, 'identity:closed', 'owner-c', 150,
    async () => { providerCalls += 1; },
  );
  assert.equal(unavailable.status, 'guard-unavailable');
  assert.equal(providerCalls, 0, 'circuit RPC failure must perform zero provider I/O');
  assert.equal(leases.size, 0, 'failed circuit reads still release the distributed lease');

  let retained = 0;
  let writes = 0;
  if (helpers.acceptGatewayProviderDrain(
    { providerDrained: true, providerDrainProtocol: 0 },
    () => { retained += 1; },
  )) writes += 1;
  assert.equal(writes, 0, 'an unattested 2xx Gateway payload cannot reach persistence');
  assert.equal(retained, 1, 'an unattested 2xx Gateway payload must retain provider exclusion');
  assert.equal(helpers.gatewayProviderDrainAttested({
    providerDrained: true,
    providerDrainProtocol: 1,
  }), true);

  const retainedOutcome = await helpers.runProviderProbeWithLease(
    {}, 'identity:unattested', 'owner-retained', 150,
    async ({ retainUntilExpiry }) => {
      providerCalls += 1;
      retainUntilExpiry();
      return null;
    },
  );
  assert.equal(retainedOutcome.status, 'completed');
  assert.equal(leases.get('identity:unattested'), 'owner-retained',
    'unattested success must keep the distributed lease until database TTL expiry');
  assert.equal(
    lifecycle.some((entry) => entry === 'release:identity:unattested:owner-retained'),
    false,
  );

  assert.equal(helpers.authoritativeProbeFacetComplete(false, true), false,
    'explicit facet incompleteness must dominate track/legacy evidence');
  assert.equal(helpers.authoritativeProbeFacetComplete(undefined, true), true,
    'marker-less legacy responses retain their compatibility fallback');
  assert.equal(helpers.authoritativeProbeFacetComplete(true, false), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.subtitleProbeObservation(
      false,
      true,
      [{ index: 2, lang: 'fr' }],
      '2026-09-01T12:00:00.000Z',
    ))),
    { complete: false, fields: {} },
    'audio or subtitle rows cannot stamp an explicitly incomplete subtitle facet',
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.subtitleProbeObservation(
      undefined,
      true,
      [{ index: 2, lang: 'fr' }],
      '2026-09-01T12:00:00.000Z',
    ))),
    {
      complete: true,
      fields: {
        subtitle_tracks: [{ index: 2, lang: 'fr' }],
        subtitle_probed_at: '2026-09-01T12:00:00.000Z',
      },
    },
    'only marker-less legacy payloads retain the compatibility promotion',
  );

  const crawler = between(playback, 'const exactFileScope =', '\n// Read-cutover trust artifact');
  const codecBackfill = between(
    playback,
    'async function runCodecProfileBackfill(',
    '\nasync function runLidBenchmarkEndpoint',
  );
  const episodeBackfill = between(
    playback,
    'async function runEpisodeAudioBackfill(',
    '\nasync function runOneDimension(',
  );
  assert.ok(crawler.includes('resolveCandidateProviderIdentityKey('));
  assert.ok(crawler.includes('newProviderProbeLeaseOwner('));
  assert.ok(crawler.indexOf('runProviderProbeWithLease(') < crawler.indexOf('resolveSeriesEpisode('),
    'identity lease and circuit check must enclose target resolution');
  assert.ok(playback.includes('candidateLeaseOwner'));
  assert.ok(crawler.includes('authoritativeProbeFacetComplete(info?.audioProbeComplete, orderedTracks.length > 0)'),
    'audioProbeComplete:false must not be promoted by returned tracks');
  for (const [name, consumer, writeMarker] of [
    ['codec backfill', codecBackfill, 'persistObservedCodecProfile(db, {'],
    ['episode backfill', episodeBackfill, 'const stored = await shareFileTracks('],
  ]) {
    const gateAt = consumer.indexOf('providerProbeResponseAllowsLeaseRelease(');
    assert.ok(gateAt >= 0, `${name} must apply the shared drain gate`);
    assert.ok(gateAt < consumer.indexOf(writeMarker), `${name} drain gate must precede persistence`);
    assert.match(consumer, /if \(releaseLeaseOnExit\) \{[\s\S]*releaseProviderFileProbe/,
      `${name} must retain the lease when drainage is unattested`);
  }
});

test('provider circuit RPC failure prevents the guarded provider call', async () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const source = between(
    playback,
    'async function readProviderProbeCircuitStateStrict(',
    '\nasync function assertProviderProbeCircuitClosedStrict(',
  )
    .replace(
      '): Promise<{ open: boolean; openUntil: string | null }> {',
      ') {',
    )
    .replace('db: SupabaseClient', 'db')
    .replace('identityKey: string', 'identityKey')
    .replace(/ as JsonRecord \| null/g, '');
  const readCircuit = vm.runInNewContext(
    `(() => { ${source}; return readProviderProbeCircuitStateStrict; })()`,
    {
      HttpError: class HttpError extends Error {},
      throwDb(error) { throw error; },
      stringOrNull(value) { return value == null || value === '' ? null : String(value); },
    },
  );
  let providerCalls = 0;
  const guardedProviderCall = async (db) => {
    const state = await readCircuit(db, 'identity-1');
    if (state.open) return 'open';
    providerCalls += 1;
    return 'fetched';
  };

  await assert.rejects(
    guardedProviderCall({ rpc: async () => ({ data: null, error: new Error('RPC unavailable') }) }),
    /RPC unavailable/,
  );
  assert.equal(providerCalls, 0);
  assert.equal(await guardedProviderCall({
    rpc: async () => ({ data: [], error: null }),
  }), 'fetched');
  assert.equal(providerCalls, 1);

  const crawler = between(playback, 'const exactFileScope =', '\n// Read-cutover trust artifact');
  const leaseGuard = between(
    playback,
    'async function runProviderProbeWithLease<T>(',
    '\nasync function providerAccountBusyForCrawler(',
  );
  assert.ok(leaseGuard.includes('readProviderProbeCircuitStateStrict('));
  assert.ok(crawler.includes('runProviderProbeWithLease('));
  assert.ok(crawler.includes('diag.circuitUnavailable++'));
  assert.ok(crawler.includes('skipped: "provider-guard-unavailable"'));
  const episode = between(
    playback,
    'async function episodeProbeCircuitState(',
    '\nasync function episodeProbeRetryBlocked(',
  );
  assert.ok(episode.includes('readProviderProbeCircuitStateStrict'));
  assert.ok(!episode.includes('open: false'));
});

test('LID cascade rollout is exact-file, bounded, fail-closed and atomically audited', () => {
  const playback = read('supabase/functions/norva-playback/index.ts');
  const migration = read('supabase/migrations/20260720130000_lid_cascade_rollout.sql');
  const knownLanguageGuard = read(
    'supabase/migrations/20260720170000_lid_canary_known_language_guard.sql',
  );
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const envExample = read('ops/hetzner/.env.hetzner.example');
  const policy = between(
    playback,
    'async function getLidDetectionPolicy(',
    '\nasync function decryptSourceConfig(',
  );
  const cohort = between(
    playback,
    'async function selectLidCascadeCohort(',
    '\nfunction lidCascadeResponseContainsMedia(',
  );
  const cascade = between(
    playback,
    'async function runLidCascadeAttempt(',
    '\n// Detect-only and transcript evidence stay explicitly distinct.',
  );
  const detector = between(
    playback,
    'async function detectUntaggedAudioLanguages(',
    '\n// Verify TAGGED-but-contradictory tracks',
  );
  const rpc = between(
    migration,
    'create or replace function public.persist_catalog_audio_lid_outcome(',
    '\nrevoke all on function public.persist_catalog_audio_lid_outcome(',
  );
  const health = between(
    playback,
    'if (req.method === "GET" && segments[0] === "health")',
    '\n    if (req.method === "GET" && segments[0] === "telemetry"',
  );

  for (const flag of [
    'lid_cascade_shadow_enabled',
    'lid_cascade_canary_enabled',
    'lid_cascade_primary_enabled',
    'lid_cascade_tagged_writes_enabled',
  ]) {
    assert.ok(policy.includes(`"${flag}"`));
    assert.match(
      migration,
      new RegExp(`'${flag}',\\s*\\n\\s*false`),
    );
  }
  assert.ok(migration.includes('create table if not exists public.audio_lid_cascade_policy'));
  for (const field of [
    'policy_version',
    'rollout_seed',
    'shadow_bps',
    'canary_bps',
    'daily_cap',
    'expires_at',
  ]) assert.ok(migration.includes(field));
  assert.ok(policy.includes('.from("audio_lid_cascade_policy")'));
  assert.ok(policy.includes('.from("catalog_audio_lid_attempts")'));
  assert.ok(policy.includes('cascadeStageCount > 1'));
  assert.ok(policy.includes('(cascadeStageCount === 1 && (primary || shadow))'));
  assert.ok(policy.includes('cascadeMode: "conflict"'));
  assert.ok(policy.includes('const expired = policyShapeValid && expiryMs <= Date.now()'));
  assert.ok(policy.includes('canaryBps > 0 && canaryBps <= 1_000 && dailyCap <= 100'));
  assert.ok(policy.includes('cascadeHealth: expired ? "expired" : "misconfigured"'));
  assert.ok(policy.includes('cascadeHealth: expiryMs - Date.now() <= 24 * 3600_000'));

  // The cohort identity is the canonical provider file, never the user/account.
  assert.ok(cohort.includes('`${policy.cascadeSeed}|${serverHost}|${itemType}|${fileExternalId}`'));
  assert.ok(cohort.includes('await sha256Hex('));
  assert.ok(cohort.includes('digest.slice(0, 8)'));
  assert.ok(cohort.includes('% 10_000'));
  assert.ok(playback.includes('"lid-cascade-shadow-v1"'));
  assert.ok(playback.includes('"lid-cascade-untagged-canary-v1"'));
  assert.ok(playback.includes('"lid-cascade-untagged-primary-v1"'));
  assert.ok(cohort.includes('policy.cascadeAttemptsToday >= policy.cascadeDailyCap'));

  // Exactly one untagged stream is claimed. Once extraction starts there is no
  // same-invocation fallback to the legacy detector.
  assert.ok(detector.includes('const cascadeTrack = unknownTracks.find('));
  assert.ok(detector.includes('unknownTracks[0]'));
  assert.ok(detector.includes('await runLidCascadeAttempt({'));
  assert.ok(detector.includes('if (cascadeHandled) return'));
  assert.ok(cascade.includes('cascadeClaimed = true'));
  assert.ok(cascade.includes('LID_CASCADE_SAMPLE_OFFSETS'));
  assert.ok(cascade.includes('count: "exact", head: true'));
  assert.ok(cascade.includes('priorAttemptCount >= LID_CASCADE_SAMPLE_OFFSETS.length'));
  assert.ok(cascade.includes('selection.cohortBucket + track.index + priorAttemptCount'));
  assert.ok(cascade.includes('.select("policy_version,daily_cap,expires_at")'));
  assert.ok(cascade.includes('Math.max(0, freshAttempts ?? 0) >= freshCap'));
  assert.ok(cascade.includes('durationSeconds: LID_CASCADE_SAMPLE_SECONDS'));
  assert.ok(cascade.includes(
    'if (extractResponse.status === 409 || extractResponse.status === 429) return true',
  ));
  assert.ok(cascade.includes('normalizeIsoLang(stringOrNull(canonicalTrack.lang))'));
  assert.ok(cascade.includes('normalizeIsoLang(stringOrNull(canonicalTrack.language))'));
  assert.ok(knownLanguageGuard.includes('v_old_known <@ v_new_known'));
  assert.ok(knownLanguageGuard.includes(
    'LID cascade cannot replace a known audio language',
  ));
  assert.ok(knownLanguageGuard.includes(
    'before update of audio_tracks, audio_lang_verification',
  ));
  assert.ok(detector.includes('!normalizeIsoLang(t.lang) && Number.isInteger(t.index)'));
  assert.ok(playback.includes('["un", "und", "mis", "mul", "zxx", "nar"]'));

  // Gateway output and worker output are both independently authenticated and
  // constrained before any database call.
  assert.ok(cascade.includes('const lidAssertion = pipe.url.slice('));
  assert.ok(cascade.includes('`${runtimeConfig.mediaGatewayUrl}/extract-language-wav`'));
  assert.ok(cascade.includes('"X-Norva-LID-Assertion": lidAssertion'));
  assert.ok(cascade.includes('method: "POST"'));
  assert.ok(cascade.includes('Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`'));
  assert.ok(cascade.includes('"Content-Type": "application/json"'));
  assert.ok(playback.includes('LID_CASCADE_MAX_WAV_BYTES = 1_572_864'));
  assert.ok(cascade.includes('x-norva-sample-sha256'));
  assert.ok(cascade.includes('await sha256BytesHex(wavBytes)'));
  assert.ok(cascade.includes('/v1/classify'));
  assert.ok(cascade.includes('Authorization: `Bearer ${runtimeConfig.lidWorkerToken}`'));
  assert.ok(cascade.includes('"X-Norva-Lid-Attempt": attemptId'));
  assert.ok(cascade.includes('"X-Norva-Lid-Policy": selection.policyVersion'));
  assert.ok(cascade.includes('"X-Norva-Lid-Mode": selection.mode'));
  assert.ok(cascade.includes('workerBody.protocolVersion !== LID_CASCADE_PROTOCOL_VERSION'));
  assert.ok(cascade.includes('workerBody.attemptId !== attemptId'));
  assert.ok(cascade.includes('workerBody.policyVersion !== selection.policyVersion'));
  assert.ok(cascade.includes('workerBody.method !== LID_CASCADE_METHOD'));
  assert.ok(cascade.includes('workerBody.verified !== false'));
  assert.ok(cascade.includes('workerBody.persisted !== false'));
  assert.ok(cascade.includes('throw new Error("worker-confidence")'));
  for (const route of [
    'fast-consensus',
    'whisper-tiebreak',
    'full-transcript-fallback',
    'pending-no-speech',
    'pending-disagreement',
  ]) assert.ok(playback.includes(`"${route}"`));
  assert.ok(cascade.includes('lidCascadeResponseContainsMedia(workerBody)'));
  assert.ok(cascade.includes('wavBytes?.fill(0)'));

  // The append-only ledger and the exact-track update live in one SECURITY
  // DEFINER transaction. Shadow never reaches either mutation branch.
  assert.ok(migration.includes('create table if not exists public.catalog_audio_lid_attempts'));
  assert.ok(migration.includes('before update or delete on public.catalog_audio_lid_attempts'));
  assert.ok(migration.includes("raise exception 'catalog_audio_lid_attempts is append-only'"));
  assert.ok(migration.includes('grant select on table public.catalog_audio_lid_attempts to service_role'));
  assert.ok(migration.includes('revoke all on function public.reject_catalog_audio_lid_attempt_mutation()'));
  assert.ok(rpc.includes('where attempt.attempt_id = p_attempt_id'));
  assert.ok(rpc.includes("'inserted', false"));
  assert.ok(rpc.includes('for update'));
  assert.ok(rpc.includes('v_cache.audio_lang_verified_at is not null'));
  assert.ok(rpc.includes("v_failure := 'strict-proof-wins'"));
  assert.ok(rpc.includes("v_failure := 'stream-index-duplicated'"));
  assert.ok(rpc.includes("v_failure := 'track-language-already-known'"));
  assert.ok(rpc.includes('v_effective_confidence := null'));
  assert.ok(rpc.includes('p_status = \'detected\' and p_confidence is null'));
  assert.ok(rpc.includes("p_rollout_mode <> 'shadow' and p_status = 'detected'"));
  assert.ok(rpc.includes("'lidMethod', 'lid-cascade-v1'"));
  assert.ok(rpc.includes('perform public.fanout_detected_file_tracks_to_users('));
  assert.ok(rpc.includes('observation.audio_verified_at is null'));
  assert.ok(rpc.includes('insert into public.catalog_audio_lid_attempts('));
  assert.ok(
    rpc.indexOf('update public.catalog_file_tracks cache') <
      rpc.indexOf('insert into public.catalog_audio_lid_attempts('),
  );
  assert.ok(!rpc.includes('merge_catalog_title_audio'));
  assert.ok(!rpc.includes('audio_lang_verified_at ='));

  assert.ok(health.includes('version: 72'));
  assert.ok(health.includes('exactTrackCrawlerProtocol: 2'));
  assert.ok(health.includes('lidCascadeProtocol: 2'));
  assert.ok(health.includes('lidCascadeMode: lidPolicy.cascadeMode'));
  assert.ok(health.includes('lidCascadeWorkerConfigured'));
  for (const config of [playback, compose, envExample]) {
    assert.ok(config.includes('NORVA_LID_WORKER_URL'));
    assert.ok(config.includes('NORVA_LID_WORKER_TOKEN'));
  }
  assert.ok(envExample.includes('LID_WORKER_TOKEN='));
  assert.ok(envExample.includes('Set both token variables to the exact same value'));
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
