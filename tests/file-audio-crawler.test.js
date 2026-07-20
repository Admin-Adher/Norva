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
  assert.ok(detector.includes('`${detectBase}?index=${track.index}&dur=20`'));
  assert.ok(detector.includes('AbortSignal.timeout(120_000)'));
  assert.ok(detector.includes('const evidence = basicLidEvidence(det)'));
  assert.ok(detector.includes('if (evidence.accepted && evidence.lang)'));
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
    'async function createBytePipeAccess(',
    '\nasync function createGatewaySession(',
  );
  const policy = between(
    playback,
    'async function getLidDetectionPolicy(',
    '\nasync function decryptSourceConfig(',
  );
  const evidence = between(
    playback,
    'function basicLidEvidence(',
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
  assert.ok(bytePipe.includes('hmacBase64Url(runtimeConfig.mediaGatewayToken, payload)'));
  assert.ok(
    bytePipe.indexOf('...(scope ? { scope } : {})') <
      bytePipe.indexOf('hmacBase64Url(runtimeConfig.mediaGatewayToken, payload)'),
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

  // Legacy transcripts retain their >=4-word guard. Detect-only must carry
  // every explicit contract field and may never impersonate verification.
  assert.ok(evidence.includes('det?.method === "whisper-detect-only-v1"'));
  assert.ok(evidence.includes('det?.evidence === "lid-only-high-confidence"'));
  assert.ok(evidence.includes('det?.fastPathAccepted === true'));
  assert.ok(evidence.includes('det?.confident === true'));
  assert.ok(evidence.includes('det?.verified === false'));
  assert.ok(evidence.includes('det?.fallbackUsed === false'));
  assert.ok(evidence.includes('det?.validationStatus === "pending"'));
  assert.ok(evidence.includes('confidence >= 0.95'));
  assert.ok(evidence.includes('words === 0'));
  assert.ok(evidence.includes('det?.confident === true && words >= 4'));

  // A fast canary result stays exact-file/tenant scoped. The irreversible
  // title-wide union is reserved for historical transcript detections. Method
  // evidence survives resumable multi-pass files, so a later fallback pass
  // cannot accidentally merge an earlier fast language.
  assert.ok(detector.includes('track.lidMethod = evidence.method'));
  assert.ok(detector.includes('lidMethod: t.lidMethod'));
  assert.ok(detector.includes('enriched.map((t) => t.lidMethod)'));
  assert.ok(detector.includes('t.lidMethod === "whisper-detect-only-v1"'));
  assert.ok(detector.includes('detectOnlyDetectedCount === 0'));
  assert.ok(detector.includes('db.rpc("merge_catalog_title_audio"'));
  assert.ok(
    detector.indexOf('detectOnlyDetectedCount === 0') <
      detector.indexOf('db.rpc("merge_catalog_title_audio"'),
  );
  assert.ok(detector.includes('method: detectOnlyDetectedCount > 0'));
  assert.ok(detector.includes('? "whisper-detect-only-v1"'));
  assert.ok(playback.includes('lidMethod: stringOrNull(x?.lidMethod ?? x?.lid_method)'));
  assert.ok(playback.includes('"refresh_catalog_file_audio_detection_provenance"'));
  assert.ok(migration.includes('create or replace function public.refresh_catalog_file_audio_detection_provenance('));
  assert.ok(migration.includes("track->>'lidMethod' = 'whisper-detect-only-v1'"));
  assert.ok(migration.includes("'method', v_method"));
  assert.ok(migration.includes('observation.audio_verified_at is null'));
  assert.ok(detector.includes(': "whisper-basic-v1"'));

  assert.ok(health.includes('version: 35'));
  assert.ok(health.includes('lidDetectOnlyProtocol: 1'));
  assert.ok(health.includes('audioLidEnabled: lidPolicy.enabled'));
  assert.ok(health.includes('lidDetectOnlyMode: lidPolicy.mode'));
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
    '\n// Keep the old >=4-word contract',
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
  assert.ok(policy.includes('expiryMs > Date.now()'));

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
  assert.ok(cascade.includes('if (extractResponse.status === 429) return true'));
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

  assert.ok(health.includes('version: 35'));
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
