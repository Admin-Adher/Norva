-- Progressive, exact-file rollout for the production audio-language cascade.
--
-- All rollout stages start disabled. The Edge selects a stable SHA-256 cohort,
-- the internal worker returns non-certifying evidence, and this migration owns
-- the only atomic write path. A cascade result can fill one NULL/unknown track;
-- it can never overwrite a language or create/clear strict verification proof.

begin;

insert into public.admin_feature_flags(key, enabled, description)
values
  (
    'lid_cascade_shadow_enabled',
    false,
    'Shadow VAD + ECAPA/sherpa + Whisper cascade; journalise uniquement, aucune langue n''est modifiée'
  ),
  (
    'lid_cascade_canary_enabled',
    false,
    'Canari exact-file du pipeline LID cascade; remplit seulement une piste audio encore inconnue'
  ),
  (
    'lid_cascade_primary_enabled',
    false,
    'Rollout primaire du pipeline LID cascade après validation du canari'
  ),
  (
    'lid_cascade_tagged_writes_enabled',
    false,
    'Réservé à une future phase; doit rester false car la cascade v1 ne modifie jamais une piste taguée'
  )
on conflict (key) do nothing;

create table if not exists public.audio_lid_cascade_policy (
  singleton boolean primary key default true,
  policy_version text not null default 'lid-cascade-v1',
  rollout_seed text not null default gen_random_uuid()::text,
  shadow_bps integer not null default 0
    check (shadow_bps between 0 and 10000),
  canary_bps integer not null default 0
    check (canary_bps between 0 and 10000),
  daily_cap integer not null default 100
    check (daily_cap between 1 and 1000000),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint audio_lid_cascade_policy_singleton_ck check (singleton),
  constraint audio_lid_cascade_policy_version_ck
    check (policy_version = 'lid-cascade-v1'),
  constraint audio_lid_cascade_policy_seed_ck
    check (btrim(rollout_seed) <> '')
);

insert into public.audio_lid_cascade_policy(
  singleton, policy_version, shadow_bps, canary_bps, daily_cap, expires_at
)
values (true, 'lid-cascade-v1', 0, 0, 100, null)
on conflict (singleton) do nothing;

drop trigger if exists trg_audio_lid_cascade_policy_updated_at
  on public.audio_lid_cascade_policy;
create trigger trg_audio_lid_cascade_policy_updated_at
before update on public.audio_lid_cascade_policy
for each row execute function public.norva_set_updated_at();

alter table public.audio_lid_cascade_policy enable row level security;
revoke all on table public.audio_lid_cascade_policy
  from public, anon, authenticated;
grant select on table public.audio_lid_cascade_policy to service_role;

create table if not exists public.catalog_audio_lid_attempts (
  attempt_id uuid primary key,
  server_host text not null check (btrim(server_host) <> ''),
  item_type text not null check (item_type = 'movie'),
  external_id text not null check (btrim(external_id) <> ''),
  stream_index integer not null check (stream_index between 0 and 1024),
  expected_audio_probed_at timestamptz not null,
  policy_version text not null check (policy_version = 'lid-cascade-v1'),
  rollout_mode text not null
    check (rollout_mode in ('shadow', 'canary', 'primary')),
  cohort_bucket integer not null check (cohort_bucket between 0 and 9999),
  route text check (
    route is null or route in (
      'fast-consensus',
      'whisper-tiebreak',
      'full-transcript-fallback',
      'pending-no-speech',
      'pending-disagreement'
    )
  ),
  status text not null check (status in ('detected', 'pending', 'error')),
  language text check (language is null or language ~ '^[a-z]{2}$'),
  confidence double precision
    check (confidence is null or confidence between 0 and 1),
  sample_sha256 text
    check (sample_sha256 is null or sample_sha256 ~ '^[a-f0-9]{64}$'),
  sample_bytes integer
    check (sample_bytes is null or sample_bytes between 1 and 1572864),
  extraction_ms integer check (extraction_ms is null or extraction_ms > 0),
  inference_ms integer check (inference_ms is null or inference_ms > 0),
  previous_language text,
  persisted boolean not null default false,
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

create index if not exists catalog_audio_lid_attempts_policy_day_idx
  on public.catalog_audio_lid_attempts(policy_version, created_at);
create index if not exists catalog_audio_lid_attempts_file_idx
  on public.catalog_audio_lid_attempts(
    server_host, item_type, external_id, stream_index, policy_version, rollout_mode
  );

create or replace function public.reject_catalog_audio_lid_attempt_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  raise exception 'catalog_audio_lid_attempts is append-only'
    using errcode = '55000';
end
$function$;

revoke all on function public.reject_catalog_audio_lid_attempt_mutation()
  from public, anon, authenticated;

drop trigger if exists trg_catalog_audio_lid_attempts_immutable
  on public.catalog_audio_lid_attempts;
create trigger trg_catalog_audio_lid_attempts_immutable
before update or delete on public.catalog_audio_lid_attempts
for each row execute function public.reject_catalog_audio_lid_attempt_mutation();

alter table public.catalog_audio_lid_attempts enable row level security;
revoke all on table public.catalog_audio_lid_attempts
  from public, anon, authenticated;
grant select on table public.catalog_audio_lid_attempts to service_role;

create or replace function public.persist_catalog_audio_lid_outcome(
  p_attempt_id uuid,
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_stream_index integer,
  p_expected_audio_probed_at timestamptz,
  p_policy_version text,
  p_rollout_mode text,
  p_cohort_bucket integer,
  p_route text,
  p_status text,
  p_language text default null,
  p_confidence double precision default null,
  p_sample_sha256 text default null,
  p_sample_bytes integer default null,
  p_extraction_ms integer default null,
  p_inference_ms integer default null,
  p_evidence jsonb default '{}'::jsonb,
  p_retry_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.catalog_audio_lid_attempts%rowtype;
  v_policy public.audio_lid_cascade_policy%rowtype;
  v_cache public.catalog_file_tracks%rowtype;
  v_track jsonb;
  v_track_count integer := 0;
  v_tracks jsonb;
  v_previous_language text;
  v_effective_route text := p_route;
  v_effective_status text := p_status;
  v_effective_language text := p_language;
  v_effective_confidence double precision := p_confidence;
  v_failure text;
  v_stage_count integer := 0;
  v_old_stage_count integer := 0;
  v_attempt_count integer := 0;
  v_persisted boolean := false;
  v_unknown_remaining boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  -- Idempotency is checked before rollout gates, so a caller may safely retry a
  -- response lost after commit even if an operator disabled the stage meanwhile.
  if p_attempt_id is null then
    raise exception 'Attempt id is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_attempt_id::text, 0));
  select attempt.*
    into v_existing
  from public.catalog_audio_lid_attempts attempt
  where attempt.attempt_id = p_attempt_id;
  if found then
    return jsonb_build_object(
      'attemptId', v_existing.attempt_id,
      'inserted', false,
      'persisted', v_existing.persisted,
      'status', v_existing.status,
      'language', v_existing.language
    );
  end if;

  if p_attempt_id is null
     or coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'movie'
     or coalesce(btrim(p_external_id), '') = ''
     or p_stream_index is null
     or p_stream_index not between 0 and 1024
     or p_expected_audio_probed_at is null
     or p_policy_version is distinct from 'lid-cascade-v1'
     or p_rollout_mode is null
     or p_rollout_mode not in ('shadow', 'canary', 'primary')
     or p_cohort_bucket is null
     or p_cohort_bucket not between 0 and 9999
     or p_status is null
     or p_status not in ('detected', 'pending', 'error')
     or jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) is distinct from 'object'
     or octet_length(coalesce(p_evidence, '{}'::jsonb)::text) > 32768 then
    raise exception 'Invalid LID cascade coordinates or evidence'
      using errcode = '22023';
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'Invalid LID confidence' using errcode = '22023';
  end if;
  if (p_status = 'detected' and p_confidence is null)
     or (p_status <> 'detected' and p_confidence is not null) then
    raise exception 'Confidence must come from the engine selecting a detected route'
      using errcode = '22023';
  end if;
  if p_sample_sha256 is not null and p_sample_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid sample digest' using errcode = '22023';
  end if;
  if p_sample_bytes is not null and p_sample_bytes not between 1 and 1572864 then
    raise exception 'Invalid sample size' using errcode = '22023';
  end if;
  if p_status <> 'error' and (
    p_sample_sha256 is null or p_sample_bytes is null or p_extraction_ms is null
  ) then
    raise exception 'Successful worker observations require sample evidence'
      using errcode = '22023';
  end if;
  if p_status = 'detected' and (
    p_route is null
    or p_route not in ('fast-consensus', 'whisper-tiebreak', 'full-transcript-fallback')
    or p_language is null
    or p_language !~ '^[a-z]{2}$'
  ) then
    raise exception 'Detected route requires one canonical language'
      using errcode = '22023';
  end if;
  if p_status = 'pending' and (
    p_route is null
    or p_route not in ('pending-no-speech', 'pending-disagreement')
    or p_language is not null
  ) then
    raise exception 'Pending route cannot carry a language'
      using errcode = '22023';
  end if;
  if p_status = 'error' and (p_route is not null or p_language is not null) then
    raise exception 'Edge errors cannot impersonate a worker route'
      using errcode = '22023';
  end if;

  select policy.*
    into v_policy
  from public.audio_lid_cascade_policy policy
  where policy.singleton
  for update;
  if not found
     or v_policy.policy_version is distinct from p_policy_version
     or v_policy.expires_at is null
     or v_policy.expires_at <= v_now then
    raise exception 'LID cascade policy is missing or expired'
      using errcode = '55000';
  end if;

  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'audio_lid_enabled'
  ), false) then
    raise exception 'Audio LID kill switch is disabled'
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_stage_count
  from public.admin_feature_flags flag
  where flag.enabled
    and flag.key in (
      'lid_cascade_shadow_enabled',
      'lid_cascade_canary_enabled',
      'lid_cascade_primary_enabled'
    );
  select count(*)::integer
    into v_old_stage_count
  from public.admin_feature_flags flag
  where flag.enabled
    and flag.key in (
      'lid_detect_only_shadow_enabled',
      'lid_detect_only_production_enabled',
      'lid_cascade_tagged_writes_enabled'
    );
  if v_stage_count <> 1 or v_old_stage_count <> 0 then
    raise exception 'Conflicting LID rollout flags'
      using errcode = '55000';
  end if;
  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = case p_rollout_mode
      when 'shadow' then 'lid_cascade_shadow_enabled'
      when 'canary' then 'lid_cascade_canary_enabled'
      else 'lid_cascade_primary_enabled'
    end
  ), false) then
    raise exception 'Requested LID rollout mode is not enabled'
      using errcode = '55000';
  end if;
  if (p_rollout_mode = 'shadow' and p_cohort_bucket >= v_policy.shadow_bps)
     or (p_rollout_mode = 'canary' and p_cohort_bucket >= v_policy.canary_bps) then
    raise exception 'Exact file is outside the configured cohort'
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_attempt_count
  from public.catalog_audio_lid_attempts attempt
  where attempt.policy_version = p_policy_version
    and attempt.created_at >= date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';
  if v_attempt_count >= v_policy.daily_cap then
    raise exception 'LID cascade daily cap reached'
      using errcode = '54000';
  end if;

  select cache.*
    into v_cache
  from public.catalog_file_tracks cache
  where cache.server_host = p_server_host
    and cache.item_type = p_item_type
    and cache.external_id = p_external_id
  for update;
  if not found then
    raise exception 'Exact catalog file is missing' using errcode = 'P0002';
  end if;

  select count(*)::integer, (jsonb_agg(track)->0)
    into v_track_count, v_track
  from jsonb_array_elements(
    case
      when jsonb_typeof(v_cache.audio_tracks) = 'array' then v_cache.audio_tracks
      else '[]'::jsonb
    end
  ) tracks(track)
  where coalesce(track->>'index', '') ~ '^[0-9]+$'
    and (track->>'index')::integer = p_stream_index
  ;

  v_previous_language := lower(nullif(btrim(coalesce(
    v_track->>'lang',
    v_track->>'language',
    ''
  )), ''));
  if v_cache.audio_probed_at is distinct from p_expected_audio_probed_at then
    v_failure := 'audio-probe-cas-mismatch';
  elsif v_cache.audio_lang_verified_at is not null then
    v_failure := 'strict-proof-wins';
  elsif v_track_count = 0 then
    v_failure := 'stream-index-missing';
  elsif v_track_count <> 1 then
    v_failure := 'stream-index-duplicated';
  elsif v_previous_language ~ '^[a-z]{2,3}$'
     and v_previous_language not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar') then
    v_failure := 'track-language-already-known';
  end if;

  if v_failure is not null then
    v_effective_route := null;
    v_effective_status := 'error';
    v_effective_language := null;
    v_effective_confidence := null;
  elsif p_rollout_mode <> 'shadow' and p_status = 'detected' then
    select coalesce(jsonb_agg(
      case
        when coalesce(track->>'index', '') ~ '^[0-9]+$'
         and (track->>'index')::integer = p_stream_index
          then (track - 'language') || jsonb_build_object(
            'lang', p_language,
            'lidMethod', 'lid-cascade-v1',
            'lidConfidence', p_confidence,
            'lidVerdict', 'detected',
            'lidAttemptedAt', v_now,
            'lidEvidenceId', p_attempt_id
          )
        else track
      end
      order by ordinality
    ), '[]'::jsonb)
      into v_tracks
    from jsonb_array_elements(v_cache.audio_tracks) with ordinality tracks(track, ordinality);

    select exists (
      select 1
      from jsonb_array_elements(v_tracks) tracks(track)
      where lower(btrim(coalesce(track->>'lang', track->>'language', '')))
        in ('', 'un', 'und', 'mul', 'zxx', 'mis', 'nar', 'unknown')
    ) into v_unknown_remaining;

    update public.catalog_file_tracks cache
       set audio_tracks = v_tracks,
           audio_whisper_attempted_at = case
             when not v_unknown_remaining then v_now
             else cache.audio_whisper_attempted_at
           end,
           audio_whisper_retry_at = case
             when v_unknown_remaining then v_now
             else null
           end,
           audio_whisper_verification = jsonb_build_object(
             'status', 'detected',
             'method', 'lid-cascade-v1',
             'route', p_route,
             'policyVersion', p_policy_version,
             'attemptId', p_attempt_id,
             'detectedAt', v_now
           ),
           audio_lang_verification = jsonb_build_object(
             'status', 'detected',
             'method', 'lid-cascade-v1',
             'scope', 'canonical-file',
             'route', p_route,
             'policyVersion', p_policy_version,
             'attemptId', p_attempt_id,
             'detectedAt', v_now
           ),
           updated_at = v_now
     where cache.server_host = p_server_host
       and cache.item_type = p_item_type
       and cache.external_id = p_external_id
       and cache.audio_lang_verified_at is null
       and cache.audio_probed_at = p_expected_audio_probed_at;
    if found then
      v_persisted := true;
      perform public.fanout_detected_file_tracks_to_users(
        p_server_host,
        p_item_type,
        p_external_id,
        v_tracks,
        v_cache.subtitle_tracks,
        true,
        false
      );

      -- fanout_detected_file_tracks_to_users predates this method. Repair only
      -- non-strict owner provenance; strict tenant evidence remains immutable.
      update public.cloud_title_file_language_observations observation
         set audio_verification = jsonb_build_object(
               'status', 'detected',
               'method', 'lid-cascade-v1',
               'scope', 'canonical-file',
               'route', p_route,
               'policyVersion', p_policy_version,
               'attemptId', p_attempt_id
             ),
             updated_at = v_now
        from public.cloud_title_variants variant
        join public.cloud_sources source
          on source.id = variant.source_id
         and source.user_id = variant.user_id
         and source.deleted_at is null
        left join public.catalog_source_provider_identities verified_identity
          on verified_identity.source_id = source.id
         and verified_identity.user_id = source.user_id
       where observation.user_id = variant.user_id
         and observation.variant_id = variant.id
         and observation.file_external_id = p_external_id
         and observation.audio_verified_at is null
         and variant.item_type = p_item_type
         and variant.external_id = p_external_id
         and coalesce(
           verified_identity.identity_id::text,
           'source:' || source.id::text
         ) = p_server_host;
    end if;
  elsif p_rollout_mode <> 'shadow' then
    -- Pending/error evidence is retry metadata only. It never mutates the map,
    -- title union, provenance, or any strict certificate.
    update public.catalog_file_tracks cache
       set audio_whisper_retry_at = coalesce(p_retry_at, v_now + interval '15 minutes'),
           audio_whisper_verification = jsonb_build_object(
             'status', p_status,
             'method', 'lid-cascade-v1',
             'route', p_route,
             'policyVersion', p_policy_version,
             'attemptId', p_attempt_id,
             'attemptedAt', v_now
           ),
           updated_at = v_now
     where cache.server_host = p_server_host
       and cache.item_type = p_item_type
       and cache.external_id = p_external_id
       and cache.audio_lang_verified_at is null
       and cache.audio_probed_at = p_expected_audio_probed_at;
  end if;

  -- Keep this INSERT last: the immutable ledger and any accepted exact-track
  -- update/fanout commit or roll back together.
  insert into public.catalog_audio_lid_attempts(
    attempt_id,
    server_host,
    item_type,
    external_id,
    stream_index,
    expected_audio_probed_at,
    policy_version,
    rollout_mode,
    cohort_bucket,
    route,
    status,
    language,
    confidence,
    sample_sha256,
    sample_bytes,
    extraction_ms,
    inference_ms,
    previous_language,
    persisted,
    evidence,
    created_at,
    completed_at
  ) values (
    p_attempt_id,
    p_server_host,
    p_item_type,
    p_external_id,
    p_stream_index,
    p_expected_audio_probed_at,
    p_policy_version,
    p_rollout_mode,
    p_cohort_bucket,
    v_effective_route,
    v_effective_status,
    v_effective_language,
    v_effective_confidence,
    p_sample_sha256,
    p_sample_bytes,
    p_extraction_ms,
    p_inference_ms,
    v_previous_language,
    v_persisted,
    coalesce(p_evidence, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'failure', v_failure,
      'workerRoute', p_route,
      'workerStatus', p_status
    )),
    v_now,
    clock_timestamp()
  );

  return jsonb_build_object(
    'attemptId', p_attempt_id,
    'inserted', true,
    'persisted', v_persisted,
    'status', v_effective_status,
    'language', v_effective_language
  );
end
$function$;

revoke all on function public.persist_catalog_audio_lid_outcome(
  uuid, text, text, text, integer, timestamptz, text, text, integer,
  text, text, text, double precision, text, integer, integer, integer,
  jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.persist_catalog_audio_lid_outcome(
  uuid, text, text, text, integer, timestamptz, text, text, integer,
  text, text, text, double precision, text, integer, integer, integer,
  jsonb, timestamptz
) to service_role;

commit;
