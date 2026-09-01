const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260901143150_file_audio_repair_cohort_v1.sql');
const leaseSafety = read('supabase/migrations/20260901143300_provider_probe_file_lease_fail_closed_v1.sql');
const exactObservation = read('supabase/migrations/20260901143050_exact_audio_observation_nonempty_v1.sql');
const edgeDeploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');
const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
const playback = () => read('supabase/functions/norva-playback/index.ts');

test('KING365 false negatives are materialized once as an exact auditable manifest', () => {
  assert.match(migration, /vod-audio-relay-empty-reset-20260831-king365-v1/);
  assert.match(migration, /variant\.generation_id = cohort\.generation_id/);
  assert.match(migration, /identity\.identity_id = cohort\.provider_identity_id/);
  assert.match(migration, /cache\.updated_at between[\s\S]*2026-08-31 15:26:18\.219296\+00[\s\S]*2026-08-31 15:26:18\.615691\+00/);
  assert.match(migration, /if v_seeded is distinct from 6438/);
  assert.match(migration, /if v_completed < 3 or v_completed > v_seeded/);
  assert.match(migration, /seed_manifest_sha256/);
  assert.match(migration, /extensions\.digest/);
  assert.match(migration, /jsonb_build_object\([\s\S]*'sourceId'[\s\S]*'generationId'[\s\S]*'providerIdentityId'[\s\S]*'titleId'[\s\S]*'variantId'[\s\S]*'fileExternalId'/);
  assert.match(migration, /c80062d545b6fcb62bf5c35fd4b76c991626829a3f26550a5e0fbe8fe5d8acec/);
  assert.doesNotMatch(
    migration.slice(migration.indexOf('create or replace function public.catalog_file_audio_repair_pending')),
    /2026-08-31 15:26:18/,
    'runtime selection must never re-evaluate the forensic timestamp',
  );
});

test('repair cohort is opaque, tenant-bound, active-generation-bound and limited to four', () => {
  const candidates = migration.slice(
    migration.indexOf('create or replace function public.catalog_file_audio_repair_candidates'),
    migration.indexOf('create or replace function public.norva_start_catalog_file_audio_repair_attempt'),
  );
  const startAttempt = migration.slice(
    migration.indexOf('create or replace function public.norva_start_catalog_file_audio_repair_attempt'),
    migration.indexOf('create or replace function public.norva_defer_catalog_file_audio_repair_candidate'),
  );
  const deferCandidate = migration.slice(
    migration.indexOf('create or replace function public.norva_defer_catalog_file_audio_repair_candidate'),
    migration.indexOf('create or replace function public.norva_complete_catalog_file_audio_repair'),
  );
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /force row level security/g);
  assert.match(migration, /revoke all on table public\.catalog_file_audio_repair_cohorts[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /revoke all on table public\.catalog_file_audio_repair_items[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(migration, /security definer/g);
  assert.match(migration, /set search_path = ''/g);
  assert.match(migration, /cohort\.user_id = p_user/);
  assert.match(migration, /cohort\.source_id = p_source/);
  assert.match(migration, /variant\.generation_id = item\.generation_id/);
  assert.match(migration, /identity\.identity_id = item\.provider_identity_id/);
  assert.match(migration, /cohort\.state = 'active'/);
  assert.match(migration, /item\.state = 'pending'/);
  assert.match(migration, /v_limit integer := greatest\(1, least\(4, coalesce\(p_limit, 4\)\)\)/);
  assert.match(migration, /for update of item skip locked/);
  assert.match(candidates, /repair_lease_token uuid/);
  assert.match(candidates, /set state = 'leased'[\s\S]*lease_token = gen_random_uuid\(\)[\s\S]*lease_attempt_started = false[\s\S]*lease_until = v_now \+ interval '10 minutes'/);
  assert.doesNotMatch(candidates, /attempt_count = item\.attempt_count \+ 1/);
  assert.match(startAttempt, /item\.lease_token = p_lease_token/);
  assert.match(startAttempt, /not item\.lease_attempt_started/);
  assert.match(startAttempt, /attempt_count = item\.attempt_count \+ 1[\s\S]*lease_attempt_started = true/);
  assert.match(startAttempt, /cloud_catalog_visible_title_variants/);
  assert.match(deferCandidate, /item\.lease_token = p_lease_token[\s\S]*not item\.lease_attempt_started/);
  assert.match(deferCandidate, /set state = 'pending'[\s\S]*lease_token = null[\s\S]*lease_attempt_started = false/);
  assert.doesNotMatch(deferCandidate, /attempt_count = item\.attempt_count \+ 1/);
  assert.match(candidates, /lease-expired-before-provider-io/);
  assert.match(candidates, /lease-expired-after-provider-attempt/);
  assert.match(candidates, /item\.lease_attempt_started and item\.attempt_count >= 4[\s\S]*then 'quarantined'/);
  assert.match(migration, /grant execute on function public\.catalog_file_audio_repair_pending\(uuid, uuid\)[\s\S]*to service_role/);
  assert.match(migration, /grant execute on function public\.catalog_file_audio_repair_candidates\(uuid, uuid, integer\)[\s\S]*to service_role/);
  assert.match(migration, /grant execute on function public\.norva_start_catalog_file_audio_repair_attempt\([\s\S]*uuid, uuid, uuid, uuid[\s\S]*\) to service_role/);
  assert.match(migration, /grant execute on function public\.norva_defer_catalog_file_audio_repair_candidate\([\s\S]*uuid, uuid, uuid, uuid, text, integer[\s\S]*\) to service_role/);
});

test('raw exact audio observation completes repair independently from subtitle and LID truth', () => {
  const trigger = migration.slice(
    migration.indexOf('create or replace function public.norva_complete_catalog_file_audio_repair'),
  );
  assert.match(trigger, /if new\.audio_observed is true/);
  assert.match(trigger, /item\.user_id = new\.user_id/);
  assert.match(trigger, /item\.title_id = new\.title_id/);
  assert.match(trigger, /item\.variant_id = new\.variant_id/);
  assert.match(trigger, /item\.file_external_id = new\.file_external_id/);
  assert.match(trigger, /item\.state in \('pending', 'leased'\)/);
  assert.match(trigger, /lease_token = null/);
  assert.match(trigger, /lease_attempt_started = false/);
  assert.match(trigger, /lease_until = null/);
  assert.doesNotMatch(trigger, /subtitle_observed|audio_verified_at|audio_languages/);
});

test('seed, lifecycle and retry transitions are durable and fail closed', () => {
  assert.match(migration, /lock table public\.cloud_title_file_language_observations[\s\S]*in share row exclusive mode/);
  const seed = migration.indexOf('insert into public.catalog_file_audio_repair_items');
  const sourceTrigger = migration.indexOf('drop trigger if exists trg_cancel_file_audio_repair_on_source_delete');
  const observationLock = migration.indexOf('lock table public.cloud_title_file_language_observations');
  assert.ok(seed >= 0 && sourceTrigger > seed && observationLock > sourceTrigger,
    'hot lifecycle/observation locks must be acquired only after the large immutable seed');
  assert.match(migration, /audio-observed-seed-reconciled/);
  assert.match(migration, /norva_reconcile_catalog_file_audio_repair/);
  assert.match(migration, /foreign key \(user_id, source_id\)[\s\S]*references public\.cloud_sources\(user_id, id\)[\s\S]*on update cascade on delete cascade/);
  assert.match(migration, /trg_cancel_file_audio_repair_on_head_update/);
  assert.match(migration, /trg_cancel_file_audio_repair_on_identity_update/);
  assert.match(migration, /identity\.verified_at is not null/g);
  assert.match(migration, /KING365 repair lifecycle coordinates changed during seed/);
  assert.match(migration, /head\.active_generation_id = cohort\.generation_id/);
  assert.match(migration, /identity\.identity_id = cohort\.provider_identity_id/);
  assert.match(migration, /state in \('pending', 'leased', 'completed', 'quarantined'\)/);
  assert.match(migration, /lease_token[\s\S]*lease_attempt_started[\s\S]*next_attempt_at[\s\S]*last_attempt_at[\s\S]*quarantined_at/);
  const terminalTransitions = [...migration.matchAll(/set state = '(?:completed|quarantined)',([\s\S]{0,220})/g)];
  assert.ok(terminalTransitions.length >= 4);
  for (const transition of terminalTransitions) {
    assert.match(transition[1], /lease_token = null/);
    assert.match(transition[1], /lease_attempt_started = false/);
  }
});

test('database observation boundary rejects empty or malformed audio maps but allows exact empty subtitles', () => {
  assert.match(exactObservation, /jsonb_typeof\(p_audio_tracks\) is distinct from 'array'/);
  assert.match(exactObservation, /jsonb_array_length\(p_audio_tracks\) = 0/);
  assert.match(exactObservation, /cardinality\(public\.catalog_audio_track_indexes\(p_audio_tracks\)\)[\s\S]*<> jsonb_array_length\(p_audio_tracks\)/);
  assert.match(exactObservation, /Exact audio observation requires a nonempty unique indexed track map/);
  assert.match(exactObservation, /if coalesce\(p_has_subtitle, false\) then[\s\S]*jsonb_typeof\(p_subtitle_tracks\) is distinct from 'array'/);
  assert.doesNotMatch(exactObservation, /jsonb_array_length\(p_subtitle_tracks\) = 0/);
  assert.match(exactObservation, /select head\.active_generation_id[\s\S]*from public\.cloud_source_catalog_heads head[\s\S]*for share/);
  assert.match(exactObservation, /v_head_found and v_active_generation_id is distinct from v_generation_id/);
  assert.match(exactObservation, /not v_head_found and v_generation_id is not null/);
  assert.match(exactObservation, /from public\.catalog_series_episode_memberships membership/);
  assert.match(exactObservation, /membership\.generation_id = v_generation_id/);
  assert.match(exactObservation, /join public\.cloud_source_catalog_heads membership_head/);
  assert.match(exactObservation, /membership_head\.active_generation_id = membership\.generation_id/);
  assert.match(exactObservation, /membership\.parent_title_id = p_title_id/);
  assert.match(exactObservation, /membership\.parent_variant_id = p_variant_id/);
  assert.match(exactObservation, /membership\.parent_series_id = v_variant_external_id/);
  assert.match(exactObservation, /membership\.episode_id = p_file_external_id/);
  assert.match(exactObservation, /identity\.verified_at is not null/);
  assert.match(exactObservation, /for share of membership, membership_head, identity/);
  assert.match(exactObservation, /from public, anon, authenticated, service_role[\s\S]*to service_role/);
});

test('production repair sealing fails closed if KING365 disappears during the seed', () => {
  assert.match(migration, /KING365 source disappeared or was deleted during repair seed/);
  assert.match(migration, /source\.user_id = '7bdab1df-80e6-46f9-bcdf-84b6595819a8'::uuid/);
  assert.match(migration, /if v_cohort_id is null then[\s\S]*if exists \([\s\S]*from public\.cloud_sources source[\s\S]*raise exception 'KING365 repair cohort was not seeded/);
  assert.doesNotMatch(migration, /if exists \([\s\S]{0,180}where id = '4e3d7dd8-9123-4bd6-9a02-36cc92e40a33'::uuid[\s\S]{0,80}and deleted_at is null[\s\S]{0,40}then[\s\S]*select cohort\.id/);
});

test('only borrowed repair lanes use the repair selector and retain sequential provider limits', () => {
  const edge = playback();
  assert.match(sourceSync, /db\.rpc\("catalog_file_audio_repair_pending"/);
  assert.match(sourceSync, /repairCohort = true/);
  assert.match(sourceSync, /repairCohort,/);
  assert.match(sourceSync, /concurrency: 1/);
  assert.match(sourceSync, /fallthrough: false/);
  assert.match(edge, /catalog_file_audio_repair_candidates/);
  assert.match(edge, /repair_lease_token/);
  assert.match(edge, /norva_start_catalog_file_audio_repair_attempt/);
  assert.match(edge, /norva_defer_catalog_file_audio_repair_candidate/);
  assert.match(edge, /norva_cancel_catalog_file_audio_repair_pre_spawn_attempt/);
  assert.match(edge, /finally \{[\s\S]*await deferUnstartedRepairCandidate\(\)/);
  assert.match(edge, /const deferClaimedRepairCandidates = async \(reason: string\)/);
  assert.match(edge, /await deferClaimedRepairCandidates\("footprint-budget"\)/);
  assert.match(edge, /await deferClaimedRepairCandidates\("account-busy"\)/);
  assert.match(edge, /await deferClaimedRepairCandidates\("provider-guard-unavailable"\)/);
  assert.match(edge, /await deferClaimedRepairCandidates\("viewer-midtick"\)/);
  assert.match(edge, /terminalCodes\.includes\("provider_busy"\) \? "provider-busy" : "proxy-auth-failed"/);
  const startCall = edge.indexOf('norva_start_catalog_file_audio_repair_attempt');
  const gatewayFetch = edge.indexOf('fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`', startCall);
  const relayFetch = edge.indexOf('fetch(`${runtimeConfig.relayBaseUrl}/${endpoint}/${token}`', startCall);
  assert.ok(startCall >= 0 && gatewayFetch > startCall && relayFetch > startCall,
    'attempt budget must start before either provider transport');
  assert.match(edge, /if \(!await startRepairAttempt\(sourceId, stringOr\(variant\.id, ""\)\)\) \{[\s\S]*return null/);
  assert.match(edge, /if \(!await startRepairAttempt\(sourceId, stringOr\(variant\.id, ""\)\)\) \{[\s\S]*return;/);
  assert.match(edge, /if \(!repairCohort \|\| repairAttemptStarted \|\| repairCandidateReleased \|\| !repairLeaseToken\) return/);
  assert.match(edge, /repairCohort/);
  assert.match(edge, /if \(repairCohort && !gatewayConfigured\) \{[\s\S]*repair-gateway-unavailable[\s\S]*return;/);
  assert.match(edge, /const preferGatewayProbe = repairCohort \|\| \(/);
  const gatewayOnlyGate = edge.indexOf('const preferGatewayProbe = repairCohort || (');
  const relayBranch = edge.indexOf('const endpoint = mode === "probe" ? "probe-audio" : "vod-info";', gatewayOnlyGate);
  assert.ok(gatewayOnlyGate >= 0 && relayBranch > gatewayOnlyGate,
    'repair candidates must be forced through Gateway before the unreachable Relay branch');
});

test('typed Gateway pre-spawn backpressure atomically restores the repair attempt budget', () => {
  const edge = playback();
  assert.match(edge, /status === 409 && providerCode === "account_busy"/);
  assert.match(edge, /status === 429 && providerCode === "background_busy"/);
  assert.doesNotMatch(
    edge.slice(
      edge.indexOf('function providerProbeRejectedBeforeSpawn('),
      edge.indexOf('function providerProbeResponseAllowsLeaseRelease('),
    ),
    /viewer_preempted/,
  );
  assert.match(edge, /providerProbeRejectedBeforeSpawn\(gw\.status, gatewayProviderCode\)[\s\S]*cancelPreSpawnRepairAttempt\(/);
  assert.match(edge, /repairCandidateReleased = true/);
  assert.match(edge, /repairAttemptStarted \|\| repairCandidateReleased \|\| !repairLeaseToken/);

  assert.match(leaseSafety, /security definer/);
  assert.match(leaseSafety, /item\.lease_token = p_lease_token/g);
  assert.match(leaseSafety, /item\.lease_attempt_started/g);
  assert.match(leaseSafety, /item\.attempt_count > 0/g);
  assert.match(leaseSafety, /attempt_count = greatest\(0, item\.attempt_count - 1\)/);
  assert.match(leaseSafety, /set state = 'pending'[\s\S]*lease_token = null[\s\S]*lease_attempt_started = false[\s\S]*lease_until = null/);
  assert.match(leaseSafety, /grant execute on function public\.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt\([\s\S]*\) to service_role/);
  assert.match(leaseSafety, /notify pgrst, 'reload schema'/);
  assert.match(edgeDeploy, /public\.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt\(uuid,uuid,uuid,uuid,text,integer\)/);
  assert.match(edge, /providerFileProbeLeaseProtocol: 2[\s\S]*repairGatewayOnlyProtocol: 1[\s\S]*repairPreSpawnAttemptCancelProtocol: 1/);

  const helperSource = edge.slice(
    edge.indexOf('function providerProbeRejectedBeforeSpawn('),
    edge.indexOf('function finiteBenchmarkNumber('),
  )
    .replace(/: number/g, '')
    .replace(/: string \| null/g, '')
    .replace(/: JsonRecord/g, '')
    .replace(/: \(\) => void/g, '')
    .replace(/\): boolean/g, ')');
  let retained = 0;
  const helpers = vm.runInNewContext(`(() => {
    const acceptGatewayProviderDrain = (payload, retain) => {
      if (payload.providerDrained === true && payload.providerDrainProtocol === 1) return true;
      retain();
      return false;
    };
    ${helperSource}
    return { providerProbeRejectedBeforeSpawn, providerProbeResponseAllowsLeaseRelease };
  })()`);
  const retain = () => { retained += 1; };
  assert.equal(helpers.providerProbeResponseAllowsLeaseRelease(409, 'account_busy', {}, retain), true);
  assert.equal(helpers.providerProbeResponseAllowsLeaseRelease(429, 'background_busy', {}, retain), true);
  assert.equal(retained, 0, 'typed pre-spawn rejects release without TTL retention');
  assert.equal(helpers.providerProbeResponseAllowsLeaseRelease(409, 'viewer_preempted', {}, retain), false);
  assert.equal(retained, 1, 'post-spawn viewer preemption retains without exact drainage');
  assert.equal(helpers.providerProbeResponseAllowsLeaseRelease(
    503,
    'gateway_failed',
    { providerDrained: true, providerDrainProtocol: 1 },
    retain,
  ), true, 'exact protocol-v1 drainage releases even for terminal non-2xx');
});
