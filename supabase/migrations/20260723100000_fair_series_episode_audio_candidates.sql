-- Fair first-pass scheduling for exact series episode audio work.
--
-- The original queues ordered every due episode globally. A large, recently
-- inventoried series could consequently consume an entire batch (S01E01,
-- S01E02, ...), while most parent series had never received even one probe.
--
-- These replacements keep the existing ownership, provider identity,
-- ambiguity, source readiness, staleness and retry guards. They only change
-- ordering:
--   1. parents with no prior work are served first;
--   2. one due episode per parent is served before a second episode from any
--      parent;
--   3. the previous deterministic episode ordering remains the tie-breaker.

begin;

create or replace function public.catalog_episode_probe_candidates(
  p_user uuid,
  p_source uuid default null,
  p_limit integer default 4
) returns table(
  user_id uuid,
  source_id uuid,
  title_id uuid,
  variant_id uuid,
  provider_identity_id uuid,
  server_host text,
  parent_series_id text,
  episode_id text,
  container_extension text,
  season_number integer,
  episode_number integer,
  audio_tracks jsonb,
  subtitle_tracks jsonb,
  audio_probed_at timestamptz,
  subtitle_probed_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with owned_memberships as (
    select
      membership.user_id,
      membership.source_id,
      membership.parent_title_id as title_id,
      membership.parent_variant_id as variant_id,
      membership.provider_identity_id,
      membership.parent_series_id,
      membership.episode_id,
      membership.container_extension,
      membership.season_number,
      membership.episode_number,
      membership.series_info_observed_at,
      coalesce(cache.audio_tracks, '[]'::jsonb) as audio_tracks,
      coalesce(cache.subtitle_tracks, '[]'::jsonb) as subtitle_tracks,
      cache.audio_probed_at,
      cache.subtitle_probed_at,
      bool_or(cache.audio_probed_at is not null) over (
        partition by
          membership.user_id,
          membership.source_id,
          membership.parent_series_id
      ) as parent_has_probe
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
     and source.sync_status = 'ready'
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
    left join public.catalog_file_tracks cache
      on cache.server_host = membership.provider_identity_id::text
     and cache.item_type = 'episode'
     and cache.external_id = membership.episode_id
    where membership.user_id = p_user
      and (p_source is null or membership.source_id = p_source)
      and not exists (
        select 1
        from public.catalog_series_episode_memberships conflicting
        where conflicting.provider_identity_id = membership.provider_identity_id
          and conflicting.episode_id = membership.episode_id
          and conflicting.parent_series_id is distinct from membership.parent_series_id
      )
  ),
  due as (
    select
      owned.*,
      row_number() over (
        partition by
          owned.user_id,
          owned.source_id,
          owned.parent_series_id
        order by
          owned.audio_probed_at asc nulls first,
          owned.series_info_observed_at desc,
          owned.season_number nulls last,
          owned.episode_number nulls last,
          owned.episode_id
      ) as parent_due_rank
    from owned_memberships owned
    where owned.audio_probed_at is null
       or owned.audio_probed_at < now() - interval '180 days'
  )
  select
    due.user_id,
    due.source_id,
    due.title_id,
    due.variant_id,
    due.provider_identity_id,
    due.provider_identity_id::text as server_host,
    due.parent_series_id,
    due.episode_id,
    due.container_extension,
    due.season_number,
    due.episode_number,
    due.audio_tracks,
    due.subtitle_tracks,
    due.audio_probed_at,
    due.subtitle_probed_at
  from due
  order by
    case
      when not due.parent_has_probe and due.parent_due_rank = 1 then 0
      else 1
    end,
    due.parent_due_rank,
    due.parent_has_probe asc,
    due.audio_probed_at asc nulls first,
    due.series_info_observed_at desc,
    due.parent_series_id,
    due.season_number nulls last,
    due.episode_number nulls last,
    due.episode_id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.catalog_episode_probe_candidates(
  uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.catalog_episode_probe_candidates(
  uuid, uuid, integer
) to service_role;

create or replace function public.catalog_episode_lid_candidates(
  p_user uuid,
  p_source uuid default null,
  p_limit integer default 4
) returns table(
  user_id uuid,
  source_id uuid,
  title_id uuid,
  variant_id uuid,
  provider_identity_id uuid,
  server_host text,
  parent_series_id text,
  episode_id text,
  container_extension text,
  season_number integer,
  episode_number integer,
  audio_tracks jsonb,
  audio_probed_at timestamptz,
  audio_whisper_attempted_at timestamptz,
  audio_whisper_retry_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with owned_files as (
    select
      membership.user_id,
      membership.source_id,
      membership.parent_title_id as title_id,
      membership.parent_variant_id as variant_id,
      membership.provider_identity_id,
      membership.parent_series_id,
      membership.episode_id,
      membership.container_extension,
      membership.season_number,
      membership.episode_number,
      membership.series_info_observed_at,
      cache.audio_tracks,
      cache.audio_probed_at,
      cache.audio_whisper_attempted_at,
      cache.audio_whisper_retry_at,
      cache.audio_lang_verified_at,
      (
        cache.audio_lang_verified_at is not null
        or cache.audio_whisper_attempted_at is not null
        or cache.audio_whisper_retry_at is not null
        or exists (
          select 1
          from public.catalog_audio_lid_attempts attempt
          where attempt.server_host = membership.provider_identity_id::text
            and attempt.item_type = 'episode'
            and attempt.external_id = membership.episode_id
        )
      ) as file_has_lid_history
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
     and source.sync_status = 'ready'
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
    join public.catalog_file_tracks cache
      on cache.server_host = membership.provider_identity_id::text
     and cache.item_type = 'episode'
     and cache.external_id = membership.episode_id
     and cache.audio_probed_at is not null
    where membership.user_id = p_user
      and (p_source is null or membership.source_id = p_source)
      and not exists (
        select 1
        from public.catalog_series_episode_memberships conflicting
        where conflicting.provider_identity_id = membership.provider_identity_id
          and conflicting.episode_id = membership.episode_id
          and conflicting.parent_series_id is distinct from membership.parent_series_id
      )
  ),
  parent_scored as (
    select
      owned.*,
      bool_or(owned.file_has_lid_history) over (
        partition by
          owned.user_id,
          owned.source_id,
          owned.parent_series_id
      ) as parent_has_lid_history
    from owned_files owned
  ),
  due as (
    select
      scored.*,
      row_number() over (
        partition by
          scored.user_id,
          scored.source_id,
          scored.parent_series_id
        order by
          coalesce(
            scored.audio_whisper_retry_at,
            scored.audio_whisper_attempted_at + interval '30 days',
            '-infinity'::timestamptz
          ),
          scored.series_info_observed_at desc,
          scored.season_number nulls last,
          scored.episode_number nulls last,
          scored.episode_id
      ) as parent_due_rank
    from parent_scored scored
    where scored.audio_lang_verified_at is null
      and coalesce(
        scored.audio_whisper_retry_at,
        scored.audio_whisper_attempted_at + interval '30 days',
        '-infinity'::timestamptz
      ) <= now()
      and exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(scored.audio_tracks) = 'array'
              then scored.audio_tracks
            else '[]'::jsonb
          end
        ) track
        where coalesce(
          nullif(lower(btrim(coalesce(track->>'lang', track->>'language'))), ''),
          'und'
        ) in ('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown')
      )
  )
  select
    due.user_id,
    due.source_id,
    due.title_id,
    due.variant_id,
    due.provider_identity_id,
    due.provider_identity_id::text as server_host,
    due.parent_series_id,
    due.episode_id,
    due.container_extension,
    due.season_number,
    due.episode_number,
    due.audio_tracks,
    due.audio_probed_at,
    due.audio_whisper_attempted_at,
    due.audio_whisper_retry_at
  from due
  order by
    case
      when not due.parent_has_lid_history and due.parent_due_rank = 1 then 0
      else 1
    end,
    due.parent_due_rank,
    due.parent_has_lid_history asc,
    coalesce(
      due.audio_whisper_retry_at,
      due.audio_whisper_attempted_at + interval '30 days',
      '-infinity'::timestamptz
    ),
    due.series_info_observed_at desc,
    due.parent_series_id,
    due.season_number nulls last,
    due.episode_number nulls last,
    due.episode_id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.catalog_episode_lid_candidates(
  uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.catalog_episode_lid_candidates(
  uuid, uuid, integer
) to service_role;

commit;
