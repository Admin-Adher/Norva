-- Keep fast Whisper language detection distinct from strict speech proof.
--
-- A basic 20-second result is useful catalogue evidence, but it must never
-- create, clear, or refresh audio_lang_verified_at. The basic detector uses the
-- Whisper cursor columns for its own retry schedule; strict proof remains
-- immutable until a future strict verifier explicitly replaces it.

begin;

-- Basic LID may replace stale container tags and old pending-validation maps,
-- but it must defer to a completed strict certificate while stream indexes are
-- unchanged. This is deliberately separate from both raw ffprobe writes and
-- the strict validator's destructive "validating" write path.
create or replace function public.upsert_catalog_file_detected_tracks(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_audio_tracks jsonb,
  p_subtitle_tracks jsonb,
  p_has_audio boolean,
  p_has_subtitle boolean
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if coalesce(btrim(p_server_host), '') = ''
     or coalesce(btrim(p_external_id), '') = ''
     or p_item_type is distinct from 'movie' then
    return;
  end if;

  insert into public.catalog_file_tracks as cache (
    server_host, item_type, external_id,
    audio_tracks, subtitle_tracks,
    audio_probed_at, subtitle_probed_at,
    audio_lang_verified_at, audio_lang_verification,
    updated_at
  ) values (
    p_server_host,
    p_item_type,
    p_external_id,
    case when p_has_audio then coalesce(p_audio_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_subtitle then coalesce(p_subtitle_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_audio then clock_timestamp() else null end,
    case when p_has_subtitle then clock_timestamp() else null end,
    null,
    case when p_has_audio then jsonb_build_object(
      'status', 'detected',
      'method', 'whisper-basic-v1',
      'detectedAt', clock_timestamp()
    ) else '{}'::jsonb end,
    clock_timestamp()
  )
  on conflict (server_host, item_type, external_id) do update set
    audio_tracks = case
      when p_has_audio
       and cache.audio_lang_verified_at is not null
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           = public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then cache.audio_tracks
      when p_has_audio then coalesce(p_audio_tracks, '[]'::jsonb)
      else cache.audio_tracks
    end,
    subtitle_tracks = case
      when p_has_subtitle then coalesce(p_subtitle_tracks, '[]'::jsonb)
      else cache.subtitle_tracks
    end,
    audio_probed_at = case
      when p_has_audio then clock_timestamp()
      else cache.audio_probed_at
    end,
    subtitle_probed_at = case
      when p_has_subtitle then clock_timestamp()
      else cache.subtitle_probed_at
    end,
    audio_lang_verified_at = case
      when not p_has_audio then cache.audio_lang_verified_at
      when cache.audio_lang_verified_at is not null
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           = public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then cache.audio_lang_verified_at
      else null
    end,
    audio_lang_verification = case
      when not p_has_audio then cache.audio_lang_verification
      when cache.audio_lang_verified_at is not null
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           = public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then cache.audio_lang_verification
      else jsonb_build_object(
        'status', 'detected',
        'method', 'whisper-basic-v1',
        'detectedAt', clock_timestamp()
      )
    end,
    updated_at = clock_timestamp();
end
$function$;

revoke all on function public.upsert_catalog_file_detected_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_catalog_file_detected_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

-- Fan out a basic detection without downgrading a tenant-only legacy strict
-- proof. Canonical strict proof still wins globally. When the canonical cache
-- is only detected, an owner that already has strict proof keeps its exact
-- audio observation while non-strict owners receive the detected map.
create or replace function public.fanout_detected_file_tracks_to_users(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_audio_tracks jsonb,
  p_subtitle_tracks jsonb,
  p_has_audio boolean,
  p_has_subtitle boolean
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_owner record;
  v_cache public.catalog_file_tracks%rowtype;
  v_count integer := 0;
  v_has_audio boolean := false;
  v_has_subtitle boolean := false;
  v_cache_verified boolean := false;
  v_owner_verified boolean := false;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or coalesce(btrim(p_external_id), '') = ''
     or p_item_type is distinct from 'movie'
     or (
       not coalesce(p_has_audio, false)
       and not coalesce(p_has_subtitle, false)
     ) then
    return 0;
  end if;

  select cache.*
    into v_cache
  from public.catalog_file_tracks cache
  where cache.server_host = p_server_host
    and cache.item_type = p_item_type
    and cache.external_id = p_external_id
  for share;
  if not found then return 0; end if;

  v_has_audio := coalesce(p_has_audio, false)
    and v_cache.audio_probed_at is not null;
  v_has_subtitle := coalesce(p_has_subtitle, false)
    and v_cache.subtitle_probed_at is not null;
  v_cache_verified := v_has_audio
    and v_cache.audio_lang_verified_at is not null
    and cardinality(public.cloud_file_track_languages(v_cache.audio_tracks)) > 0;

  for v_owner in
    select distinct
      variant.user_id,
      variant.title_id,
      variant.id as variant_id,
      variant.external_id,
      variant.audio_lang_verified_at
    from public.cloud_title_variants variant
    join public.cloud_sources source
      on source.id = variant.source_id
     and source.user_id = variant.user_id
     and source.deleted_at is null
    left join public.catalog_source_provider_identities verified_identity
      on verified_identity.source_id = source.id
     and verified_identity.user_id = source.user_id
    where variant.item_type = 'movie'
      and variant.external_id = p_external_id
      and variant.title_id is not null
      and coalesce(
        verified_identity.identity_id::text,
        'source:' || source.id::text
      ) = p_server_host
    order by variant.user_id, variant.title_id, variant.id
  loop
    select coalesce(bool_or(observation.audio_verified_at is not null), false)
      into v_owner_verified
    from public.cloud_title_file_language_observations observation
    where observation.user_id = v_owner.user_id
      and observation.variant_id = v_owner.variant_id
      and observation.file_external_id = v_owner.external_id;
    v_owner_verified := v_owner_verified or v_owner.audio_lang_verified_at is not null;

    perform public.merge_cloud_title_file_languages(
      v_owner.user_id,
      v_owner.title_id,
      v_owner.variant_id,
      v_owner.external_id,
      v_cache.audio_tracks,
      v_cache.subtitle_tracks,
      v_has_audio and (v_cache_verified or not v_owner_verified),
      v_has_subtitle
    );

    if v_cache_verified then
      perform public.mark_cloud_title_file_audio_verification(
        v_owner.user_id,
        v_owner.variant_id,
        v_owner.external_id,
        true,
        v_cache.audio_lang_verified_at,
        coalesce(v_cache.audio_lang_verification, '{}'::jsonb)
          || jsonb_build_object('status', 'verified', 'scope', 'canonical-file')
      );
    elsif v_has_audio and not v_owner_verified then
      update public.cloud_title_file_language_observations observation
         set audio_verification = jsonb_build_object(
               'status', 'detected',
               'method', 'whisper-basic-v1',
               'scope', 'canonical-file'
             ),
             updated_at = clock_timestamp()
       where observation.user_id = v_owner.user_id
         and observation.variant_id = v_owner.variant_id
         and observation.file_external_id = v_owner.external_id
         and observation.audio_verified_at is null;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$function$;

revoke all on function public.fanout_detected_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.fanout_detected_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

create or replace function public.record_catalog_file_audio_whisper_outcome(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_completed boolean,
  p_attempted_at timestamptz default now(),
  p_retry_at timestamptz default null,
  p_provenance jsonb default '{"method":"whisper-basic-v1"}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  changed integer := 0;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'movie'
     or coalesce(btrim(p_external_id), '') = '' then
    return false;
  end if;

  update public.catalog_file_tracks cache
     set audio_whisper_attempted_at = case
           when coalesce(p_completed, false)
             then coalesce(p_attempted_at, clock_timestamp())
           else cache.audio_whisper_attempted_at
         end,
         -- A completed untagged pass supplies NULL and leaves the queue.
         -- Tagged basic detection supplies a 90-day retry without borrowing
         -- the strict-verification cursor or certificate.
         audio_whisper_retry_at = p_retry_at,
         audio_whisper_verification = coalesce(p_provenance, '{}'::jsonb),
         updated_at = clock_timestamp()
   where cache.server_host = p_server_host
     and cache.item_type = p_item_type
     and cache.external_id = p_external_id;
  get diagnostics changed = row_count;
  return changed = 1;
end
$function$;

revoke all on function public.record_catalog_file_audio_whisper_outcome(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_catalog_file_audio_whisper_outcome(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) to service_role;

-- The tagged basic queue is a detector/corrector, not a strict revalidator.
-- Exclude every canonical file that already has stronger proof and use both
-- basic and legacy retry cursors so a successful detection cannot be claimed
-- again on the next minute tick.
create or replace function public.file_audio_tag_suspect_variants(
  p_user uuid,
  p_source uuid default null,
  p_limit int default 4,
  p_retry_before timestamptz default now() - interval '90 days',
  p_title_ids uuid[] default null
) returns table(
  id uuid,
  default_variant_id uuid,
  provider_tmdb_id text,
  audio_tracks jsonb,
  audio_languages text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with candidates as (
    select
      title.id,
      variant.id as default_variant_id,
      title.provider_tmdb_id,
      cache.audio_tracks,
      public.cloud_file_track_languages(cache.audio_tracks) as audio_languages,
      coalesce(nullif(variant.raw_title, ''), title.title, '') as release_name,
      greatest(
        variant.audio_lang_verified_at,
        cache.audio_lang_verified_at
      ) as audio_lang_verified_at,
      greatest(
        variant.audio_lang_verify_retry_at,
        cache.audio_lang_retry_at,
        variant.audio_whisper_retry_at,
        cache.audio_whisper_retry_at
      ) as detection_retry_at
    from public.cloud_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
     and title.item_type = variant.item_type
    join public.cloud_sources source
      on source.id = variant.source_id
     and source.user_id = variant.user_id
     and source.deleted_at is null
    left join public.catalog_source_provider_identities verified_identity
      on verified_identity.source_id = source.id
     and verified_identity.user_id = source.user_id
    join public.catalog_file_tracks cache
      on cache.server_host = coalesce(
        verified_identity.identity_id::text,
        'source:' || source.id::text
      )
     and cache.item_type = 'movie'
     and cache.external_id = variant.external_id
     and cache.audio_probed_at is not null
    where variant.user_id = p_user
      and variant.item_type = 'movie'
      and variant.title_id is not null
      and (p_source is null or variant.source_id = p_source)
      and (p_title_ids is null or title.id = any(p_title_ids))
  )
  select
    candidate.id,
    candidate.default_variant_id,
    candidate.provider_tmdb_id,
    candidate.audio_tracks,
    candidate.audio_languages
  from candidates candidate
  where cardinality(candidate.audio_languages) > 0
    and candidate.audio_lang_verified_at is null
    and (
      candidate.detection_retry_at is null
      or candidate.detection_retry_at <= now()
    )
  order by
    (
      cardinality(candidate.audio_languages) = 1
      and not candidate.audio_languages @> array['fr']
      and candidate.release_name !~* 'french'
    ) desc,
    candidate.id,
    candidate.default_variant_id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.file_audio_tag_suspect_variants(
  uuid, uuid, int, timestamptz, uuid[]
) from public, anon, authenticated;
grant execute on function public.file_audio_tag_suspect_variants(
  uuid, uuid, int, timestamptz, uuid[]
) to service_role;

comment on table public.catalog_enrichment_dispatch_leases is
  'Cross-isolate user/provider single-flight leases. Fleet throughput scales across distinct identities only.';

-- The production cron command is operational state owned by postgres. The
-- activation script updates its URL to limit=8; keeping that owner-only change
-- out of a supabase_admin migration avoids a permission-dependent deployment.

commit;
