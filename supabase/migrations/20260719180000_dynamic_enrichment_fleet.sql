-- Dynamic catalogue/audio enrichment fleet.
--
-- The historical audio/subtitle crons embedded one user UUID (and frequently
-- one source UUID) in every job body.  They therefore never discovered a new
-- customer or a provider uploaded after the cron was registered.  This queue is
-- source-backed instead: every tick reconciles all currently active, ready
-- sources that own at least one movie variant. A newly imported movie catalogue
-- appears automatically without an ops edit or another cron.schedule call.
-- Parent-series variants deliberately remain playback-only until they carry an
-- exact episode file id; probing a representative episode and writing it onto a
-- series parent would manufacture incorrect track metadata.
--
-- A short claim lease makes overlapping pg_cron ticks harmless.  The dispatcher
-- additionally takes at most one source per user and one source per canonical
-- provider identity in a batch, preventing concurrent provider sessions while
-- still allowing independent panels to progress in parallel.

-- Server-written source -> canonical identity link.  cloud_sources.config_hint
-- is owner-editable, so it must never be trusted as a cross-tenant lock key:
-- otherwise a user could copy another providerKey and hold that provider's
-- scheduler lease.  The sync engine writes this table only after the
-- service-role-only stream-ID resolver has verified the canonical identity.
create table if not exists public.catalog_source_provider_identities (
  source_id uuid primary key
    references public.cloud_sources(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  identity_id uuid not null
    references public.provider_identities(id) on delete cascade,
  provider_key text not null,
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, user_id)
);

create index if not exists catalog_source_provider_identities_identity_idx
  on public.catalog_source_provider_identities (identity_id, source_id);

create table if not exists public.catalog_enrichment_source_schedule (
  source_id uuid primary key
    references public.cloud_sources(id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  next_run_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_token uuid,
  last_claimed_at timestamptz,
  last_finished_at timestamptz,
  dispatch_count integer not null default 0
    check (dispatch_count >= 0),
  cycle_had_work boolean not null default false,
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  last_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.catalog_enrichment_source_schedule
  add column if not exists cycle_had_work boolean not null default false;

create index if not exists catalog_enrichment_source_schedule_due_idx
  on public.catalog_enrichment_source_schedule
    (next_run_at, lease_until, source_id);

create table if not exists public.catalog_enrichment_dispatch_leases (
  lease_key text primary key,
  claim_token uuid not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (coalesce(btrim(lease_key), '') <> ''),
  check (length(lease_key) <= 500)
);

create index if not exists catalog_enrichment_dispatch_leases_expiry_idx
  on public.catalog_enrichment_dispatch_leases (expires_at);

alter table public.catalog_enrichment_source_schedule enable row level security;
alter table public.catalog_enrichment_dispatch_leases enable row level security;
alter table public.catalog_source_provider_identities enable row level security;
revoke all on table public.catalog_enrichment_source_schedule
  from public, anon, authenticated;
revoke all on table public.catalog_enrichment_dispatch_leases
  from public, anon, authenticated;
revoke all on table public.catalog_source_provider_identities
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.catalog_enrichment_source_schedule to service_role;
grant select, insert, update, delete
  on table public.catalog_enrichment_dispatch_leases to service_role;
grant select, insert, update, delete
  on table public.catalog_source_provider_identities to service_role;

-- Safe rollout backfill for sources that predate the server-written link. Match
-- only from actual imported stream ids against the canonical identity samples;
-- never trust the owner-editable config_hint/providerKey for this decision.
with source_samples as materialized (
  select
    source.id as source_id,
    source.user_id,
    array(
      select ids.external_id
      from (
        select distinct item.external_id
        from public.cloud_media_items item
        where item.source_id = source.id
          and item.item_type in ('movie', 'series')
          and coalesce(item.external_id, '') <> ''
      ) ids
      order by md5(ids.external_id)
      limit 256
    ) as stream_sample
  from public.cloud_sources source
  where source.sync_status = 'ready'
    and source.enabled = true
    and source.deleted_at is null
),
resolved as (
  select
    sample.source_id,
    sample.user_id,
    best.identity_id,
    best.score
  from source_samples sample
  cross join lateral (
    select
      identity.id as identity_id,
      (
        cardinality(array(
          select value from unnest(identity.stream_sample) value
          intersect
          select value from unnest(sample.stream_sample) value
        ))::numeric
        /
        nullif(cardinality(array(
          select value from unnest(identity.stream_sample) value
          union
          select value from unnest(sample.stream_sample) value
        )), 0)
      ) as score
    from public.provider_identities identity
    where identity.stream_sample && sample.stream_sample
    order by score desc nulls last, identity.id
    limit 1
  ) best
  where cardinality(sample.stream_sample) >= 32
    and best.score >= 0.5
)
insert into public.catalog_source_provider_identities (
  source_id, user_id, identity_id, provider_key, verified_at, updated_at
)
select
  resolved.source_id,
  resolved.user_id,
  resolved.identity_id,
  'content-sample:' || resolved.identity_id::text,
  clock_timestamp(),
  clock_timestamp()
from resolved
on conflict (source_id) do nothing;

-- One authoritative cache-key resolver for every projection, crawler and
-- fanout. The source-local fallback is intentionally not a hostname: until a
-- canonical identity has been verified, no cross-tenant reuse is safe.
create or replace function public.catalog_source_file_cache_key(
  p_source_id uuid,
  p_user_id uuid
) returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(
    verified_identity.identity_id::text,
    'source:' || source.id::text
  )
  from public.cloud_sources source
  left join public.catalog_source_provider_identities verified_identity
    on verified_identity.source_id = source.id
   and verified_identity.user_id = source.user_id
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.deleted_at is null
  limit 1
$function$;

revoke all on function public.catalog_source_file_cache_key(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.catalog_source_file_cache_key(uuid, uuid)
  to service_role;

-- Replace the legacy config_hint-based fanout. The caller's supplied track map
-- is never trusted after the cache upsert: read the canonical row back so a
-- late raw ffprobe cannot reintroduce a bad tag after strict speech correction.
create or replace function public.fanout_file_tracks_to_users(
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
  v_audio text[] := '{}'::text[];
  v_verified boolean := false;
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
  v_audio := case
    when v_has_audio then public.cloud_file_track_languages(v_cache.audio_tracks)
    else '{}'::text[]
  end;
  v_verified := v_has_audio
    and v_cache.audio_lang_verified_at is not null
    and cardinality(v_audio) > 0;

  for v_owner in
    select distinct
      variant.user_id,
      variant.title_id,
      variant.id as variant_id,
      variant.external_id
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
    perform public.merge_cloud_title_file_languages(
      v_owner.user_id,
      v_owner.title_id,
      v_owner.variant_id,
      v_owner.external_id,
      v_cache.audio_tracks,
      v_cache.subtitle_tracks,
      v_has_audio,
      v_has_subtitle
    );

    -- Clear an old tenant certificate immediately when a validated rewrite or
    -- structural raw-probe change has made the canonical row pending.
    if v_verified then
      perform public.mark_cloud_title_file_audio_verification(
        v_owner.user_id,
        v_owner.variant_id,
        v_owner.external_id,
        true,
        v_cache.audio_lang_verified_at,
        coalesce(v_cache.audio_lang_verification, '{}'::jsonb)
          || jsonb_build_object(
            'status', 'verified',
            'scope', 'canonical-file'
          )
      );
    elsif v_has_audio then
      -- A fresh raw probe is immediately eligible for strict validation. Only
      -- record_catalog_file_audio_verification(false) applies the one-day retry
      -- after an actual inconclusive speech attempt.
      update public.cloud_title_file_language_observations observation
         set audio_verified_at = null,
             audio_verification = jsonb_build_object(
               'status', 'pending',
               'scope', 'canonical-file'
             ),
             updated_at = clock_timestamp()
       where observation.user_id = v_owner.user_id
         and observation.variant_id = v_owner.variant_id
         and observation.file_external_id = v_owner.external_id;
      update public.cloud_title_variants variant
         set audio_lang_verified_at = null,
             audio_lang_verify_retry_at = null
       where variant.user_id = v_owner.user_id
         and variant.id = v_owner.variant_id;
      perform public.recompute_cloud_title_file_languages(
        v_owner.user_id,
        v_owner.title_id
      );
    end if;

    -- Legacy title-level ordered maps are retained only for a true single-file
    -- title. Audio is published there only after strict verification.
    update public.cloud_titles title
       set audio_tracks = case
             when v_verified then v_cache.audio_tracks
             else title.audio_tracks
           end,
           audio_languages = case
             when v_verified then v_audio
             else title.audio_languages
           end,
           audio_probed_at = case
             when v_verified then v_cache.audio_probed_at
             else title.audio_probed_at
           end,
           subtitle_tracks = case
             when v_has_subtitle then v_cache.subtitle_tracks
             else title.subtitle_tracks
           end,
           subtitle_probed_at = case
             when v_has_subtitle then v_cache.subtitle_probed_at
             else title.subtitle_probed_at
           end
     where title.user_id = v_owner.user_id
       and title.id = v_owner.title_id
       and title.item_type = 'movie'
       and not exists (
         select 1
         from public.cloud_title_variants sibling
         where sibling.user_id = v_owner.user_id
           and sibling.title_id = v_owner.title_id
           and sibling.id <> v_owner.variant_id
       );

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$function$;

revoke all on function public.fanout_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.fanout_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

-- Future owners hydrate from a canonical row only when their source's
-- server-written identity resolves to that row. A caller-provided p_server_key
-- is retained for RPC compatibility but cannot override this decision.
create or replace function public.hydrate_cloud_title_file_languages(
  p_user_id uuid,
  p_source_id uuid,
  p_server_key text,
  p_item_type text,
  p_external_ids text[]
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_file record;
  v_title_id uuid;
  v_title_ids uuid[] := '{}'::uuid[];
  v_cache_key text;
  v_audio_languages text[];
  v_audio_verified boolean;
  v_count integer := 0;
begin
  if p_user_id is null
     or p_source_id is null
     or p_item_type is distinct from 'movie' then
    return 0;
  end if;

  v_cache_key := public.catalog_source_file_cache_key(p_source_id, p_user_id);
  if coalesce(btrim(v_cache_key), '') = '' then return 0; end if;

  for v_file in
    select
      variant.user_id,
      variant.title_id,
      variant.id as variant_id,
      variant.external_id,
      cache.audio_tracks,
      cache.subtitle_tracks,
      cache.audio_probed_at is not null as audio_observed,
      cache.subtitle_probed_at is not null as subtitle_observed,
      cache.audio_lang_verified_at,
      cache.audio_lang_retry_at,
      cache.audio_lang_verification
    from public.cloud_title_variants variant
    join public.catalog_file_tracks cache
      on cache.server_host = v_cache_key
     and cache.item_type = variant.item_type
     and cache.external_id = variant.external_id
    where variant.user_id = p_user_id
      and variant.source_id = p_source_id
      and variant.item_type = 'movie'
      and variant.title_id is not null
      and (p_external_ids is null or variant.external_id = any(p_external_ids))
      and (
        cache.audio_probed_at is not null
        or cache.subtitle_probed_at is not null
      )
    order by variant.title_id, variant.id
  loop
    v_audio_languages := case
      when v_file.audio_observed
        then public.cloud_file_track_languages(v_file.audio_tracks)
      else '{}'::text[]
    end;
    v_audio_verified := v_file.audio_observed
      and v_file.audio_lang_verified_at is not null
      and cardinality(v_audio_languages) > 0;

    insert into public.cloud_title_file_language_observations as observation (
      user_id, title_id, variant_id, file_external_id,
      audio_languages, subtitle_languages,
      audio_observed, subtitle_observed,
      audio_verified_at, audio_verification, updated_at
    ) values (
      v_file.user_id,
      v_file.title_id,
      v_file.variant_id,
      v_file.external_id,
      v_audio_languages,
      case
        when v_file.subtitle_observed
          then public.cloud_file_track_languages(v_file.subtitle_tracks)
        else '{}'::text[]
      end,
      v_file.audio_observed,
      v_file.subtitle_observed,
      case when v_audio_verified then v_file.audio_lang_verified_at else null end,
      case
        when v_audio_verified
          then coalesce(v_file.audio_lang_verification, '{}'::jsonb)
        else '{}'::jsonb
      end,
      clock_timestamp()
    )
    on conflict (user_id, variant_id, file_external_id) do update set
      title_id = excluded.title_id,
      audio_languages = case
        when excluded.audio_observed then excluded.audio_languages
        else observation.audio_languages
      end,
      subtitle_languages = case
        when excluded.subtitle_observed then excluded.subtitle_languages
        else observation.subtitle_languages
      end,
      audio_observed = observation.audio_observed or excluded.audio_observed,
      subtitle_observed = observation.subtitle_observed or excluded.subtitle_observed,
      updated_at = clock_timestamp();

    -- The verification-reset trigger correctly clears a changed audio map on
    -- conflict. Restore the certificate only after the canonical map is stored.
    update public.cloud_title_file_language_observations observation
       set audio_verified_at = case
             when v_audio_verified then v_file.audio_lang_verified_at
             else null
           end,
           audio_verification = case
             when v_audio_verified
               then coalesce(v_file.audio_lang_verification, '{}'::jsonb)
             else '{}'::jsonb
           end,
           updated_at = clock_timestamp()
     where observation.user_id = v_file.user_id
       and observation.variant_id = v_file.variant_id
       and observation.file_external_id = v_file.external_id;

    update public.cloud_title_variants variant
       set audio_lang_verified_at = case
             when v_audio_verified then v_file.audio_lang_verified_at
             else null
           end,
           audio_lang_verify_retry_at = case
             when v_audio_verified then null
             else v_file.audio_lang_retry_at
           end
     where variant.user_id = v_file.user_id
       and variant.id = v_file.variant_id;

    if not (v_file.title_id = any(v_title_ids)) then
      v_title_ids := array_append(v_title_ids, v_file.title_id);
    end if;
    v_count := v_count + 1;
  end loop;

  foreach v_title_id in array v_title_ids
  loop
    perform public.recompute_cloud_title_file_languages(p_user_id, v_title_id);
  end loop;

  return v_count;
end
$function$;

revoke all on function public.hydrate_cloud_title_file_languages(
  uuid, uuid, text, text, text[]
) from public, anon, authenticated;
grant execute on function public.hydrate_cloud_title_file_languages(
  uuid, uuid, text, text, text[]
) to service_role;

-- A canonical strict-verification result is propagated to every current owner
-- and will also be inherited by future owners through the secure hydrator.
create or replace function public.record_catalog_file_audio_verification(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_verified boolean,
  p_verified_at timestamptz default now(),
  p_retry_at timestamptz default null,
  p_provenance jsonb default '{"method":"whisper-strict-consensus-v4","consensus":4}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_owner record;
  v_cache public.catalog_file_tracks%rowtype;
  v_changed integer := 0;
  v_effective_verified boolean;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'movie'
     or coalesce(btrim(p_external_id), '') = '' then
    return false;
  end if;

  update public.catalog_file_tracks cache
     set audio_lang_verified_at = case
           when coalesce(p_verified, false)
             then coalesce(p_verified_at, clock_timestamp())
           else null
         end,
         audio_lang_retry_at = case
           when coalesce(p_verified, false) then null
           else coalesce(p_retry_at, clock_timestamp() + interval '1 day')
         end,
         audio_lang_verification = coalesce(p_provenance, '{}'::jsonb),
         updated_at = clock_timestamp()
   where cache.server_host = p_server_host
     and cache.item_type = p_item_type
     and cache.external_id = p_external_id;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return false; end if;

  select cache.*
    into v_cache
  from public.catalog_file_tracks cache
  where cache.server_host = p_server_host
    and cache.item_type = p_item_type
    and cache.external_id = p_external_id;

  v_effective_verified := coalesce(p_verified, false)
    and v_cache.audio_probed_at is not null
    and cardinality(public.cloud_file_track_languages(v_cache.audio_tracks)) > 0;

  for v_owner in
    select distinct
      variant.user_id,
      variant.title_id,
      variant.id as variant_id,
      variant.external_id
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
    perform public.merge_cloud_title_file_languages(
      v_owner.user_id,
      v_owner.title_id,
      v_owner.variant_id,
      v_owner.external_id,
      v_cache.audio_tracks,
      v_cache.subtitle_tracks,
      v_cache.audio_probed_at is not null,
      v_cache.subtitle_probed_at is not null
    );
    perform public.mark_cloud_title_file_audio_verification(
      v_owner.user_id,
      v_owner.variant_id,
      v_owner.external_id,
      v_effective_verified,
      v_cache.audio_lang_verified_at,
      coalesce(p_provenance, '{}'::jsonb)
        || jsonb_build_object(
          'status', case
            when v_effective_verified then 'verified'
            else 'pending'
          end,
          'scope', 'canonical-file'
        )
    );
  end loop;

  return true;
end
$function$;

revoke all on function public.record_catalog_file_audio_verification(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_catalog_file_audio_verification(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) to service_role;

-- Secure replacements for both speech queues. A user-controlled providerKey or
-- hostname can no longer make a source inspect/suppress another tenant's file.
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
        cache.audio_lang_retry_at
      ) as audio_lang_retry_at
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
    and (
      candidate.audio_lang_verified_at is null
      or candidate.audio_lang_verified_at < p_retry_before
    )
    and (
      candidate.audio_lang_retry_at is null
      or candidate.audio_lang_retry_at <= now()
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

create or replace function public.file_whisper_candidate_variants(
  p_user uuid,
  p_source uuid default null,
  p_limit int default 4,
  p_retry_before timestamptz default now() - interval '30 days'
) returns table(
  id uuid,
  default_variant_id uuid,
  provider_tmdb_id text,
  audio_tracks jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    title.id,
    variant.id as default_variant_id,
    title.provider_tmdb_id,
    cache.audio_tracks
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
    and (
      greatest(
        variant.audio_whisper_attempted_at,
        cache.audio_whisper_attempted_at
      ) is null
      or greatest(
        variant.audio_whisper_attempted_at,
        cache.audio_whisper_attempted_at
      ) < p_retry_before
    )
    and (
      greatest(
        variant.audio_whisper_retry_at,
        cache.audio_whisper_retry_at
      ) is null
      or greatest(
        variant.audio_whisper_retry_at,
        cache.audio_whisper_retry_at
      ) <= now()
    )
    and exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(cache.audio_tracks) = 'array'
            then cache.audio_tracks
          else '[]'::jsonb
        end
      ) track
      where coalesce(
        nullif(lower(btrim(coalesce(track->>'lang', track->>'language'))), ''),
        'und'
      ) in ('und', 'un', 'mis', 'mul', 'zxx', 'nar')
    )
  order by title.release_year desc nulls last, title.id, variant.id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.file_whisper_candidate_variants(
  uuid, uuid, int, timestamptz
) from public, anon, authenticated;
grant execute on function public.file_whisper_candidate_variants(
  uuid, uuid, int, timestamptz
) to service_role;

create or replace function public.claim_catalog_enrichment_sources(
  p_limit integer default 2,
  p_lease_seconds integer default 240
) returns table(
  source_id uuid,
  user_id uuid,
  claim_token uuid,
  failure_count integer,
  dispatch_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict use_column
declare
  candidate record;
  claimed_users uuid[] := '{}'::uuid[];
  claimed_identities text[] := '{}'::text[];
  batch_limit integer := greatest(1, least(8, coalesce(p_limit, 2)));
  lease_seconds integer := greatest(60, least(1800, coalesce(p_lease_seconds, 1200)));
  claimed_count integer := 0;
  token uuid;
  user_lease_claimed boolean;
  identity_lease_claimed boolean;
  user_lease_key text;
  provider_lease_key text;
begin
  -- Bounded retention: lease rows are tiny, but deleted users/providers must
  -- not leave one row forever.
  delete from public.catalog_enrichment_dispatch_leases lease
   where lease.expires_at < clock_timestamp() - interval '1 day';

  -- Reconciliation, rather than a one-time seed, is what covers future users
  -- and future provider uploads.  Disabled/deleted/incomplete imports are not
  -- queued; they become eligible automatically when the source is ready again.
  insert into public.catalog_enrichment_source_schedule as schedule (
    source_id,
    user_id,
    next_run_at,
    updated_at
  )
  select
    source.id,
    source.user_id,
    clock_timestamp(),
    clock_timestamp()
  from public.cloud_sources source
  where source.sync_status = 'ready'
    and source.enabled = true
    and source.deleted_at is null
    and source.source_type in ('xtream', 'm3u', 'jellyfin', 'plex', 'local', 'custom')
    and exists (
      select 1
      from public.cloud_title_variants variant
      where variant.source_id = source.id
        and variant.user_id = source.user_id
        and variant.item_type = 'movie'
    )
  on conflict on constraint catalog_enrichment_source_schedule_pkey do update
    set user_id = excluded.user_id,
        updated_at = case
          when schedule.user_id is distinct from excluded.user_id
            then excluded.updated_at
          else schedule.updated_at
        end
  where schedule.user_id is distinct from excluded.user_id;

  -- FOR UPDATE SKIP LOCKED is the cross-isolate single-flight guard.  Iterating
  -- in due order also gives every source fair round-robin service.
  for candidate in
    select
      schedule.source_id,
      schedule.user_id,
      schedule.consecutive_failures,
      schedule.dispatch_count,
      coalesce(
        'identity:' || verified_identity.identity_id::text,
        'source:' || source.id::text
      ) as identity_key
    from public.catalog_enrichment_source_schedule schedule
    join public.cloud_sources source
      on source.id = schedule.source_id
     and source.user_id = schedule.user_id
    left join public.catalog_source_provider_identities verified_identity
      on verified_identity.source_id = source.id
     and verified_identity.user_id = source.user_id
    where source.sync_status = 'ready'
      and source.enabled = true
      and source.deleted_at is null
      and exists (
        select 1
        from public.cloud_title_variants movie_variant
        where movie_variant.source_id = source.id
          and movie_variant.user_id = source.user_id
          and movie_variant.item_type = 'movie'
      )
      and schedule.next_run_at <= clock_timestamp()
      and (
        schedule.lease_until is null
        or schedule.lease_until <= clock_timestamp()
      )
    order by schedule.next_run_at, schedule.source_id
    for update of schedule skip locked
  loop
    -- One user can own several panels and multiple users can share a canonical
    -- provider.  Neither case may open two autonomous sessions in one batch.
    if candidate.user_id = any(claimed_users)
       or candidate.identity_key = any(claimed_identities) then
      continue;
    end if;

    token := gen_random_uuid();
    user_lease_key := 'user:' || candidate.user_id::text;
    provider_lease_key := 'provider:' || candidate.identity_key;
    user_lease_claimed := false;
    identity_lease_claimed := false;

    -- These leases outlive the short claim RPC transaction.  Local arrays avoid
    -- duplicate work in one batch; these rows prevent two concurrent cron ticks
    -- from claiming the same account/provider in separate isolates.
    insert into public.catalog_enrichment_dispatch_leases as lease (
      lease_key, claim_token, expires_at, updated_at
    ) values (
      user_lease_key,
      token,
      clock_timestamp() + make_interval(secs => lease_seconds),
      clock_timestamp()
    )
    on conflict (lease_key) do update
       set claim_token = excluded.claim_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
     where lease.expires_at <= clock_timestamp()
    returning true into user_lease_claimed;
    if not coalesce(user_lease_claimed, false) then
      claimed_users := array_append(claimed_users, candidate.user_id);
      continue;
    end if;

    insert into public.catalog_enrichment_dispatch_leases as lease (
      lease_key, claim_token, expires_at, updated_at
    ) values (
      provider_lease_key,
      token,
      clock_timestamp() + make_interval(secs => lease_seconds),
      clock_timestamp()
    )
    on conflict (lease_key) do update
       set claim_token = excluded.claim_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
     where lease.expires_at <= clock_timestamp()
    returning true into identity_lease_claimed;
    if not coalesce(identity_lease_claimed, false) then
      delete from public.catalog_enrichment_dispatch_leases lease
       where lease.lease_key = user_lease_key
         and lease.claim_token = token;
      claimed_identities := array_append(claimed_identities, candidate.identity_key);
      continue;
    end if;

    update public.catalog_enrichment_source_schedule schedule
       set lease_until = clock_timestamp() + make_interval(secs => lease_seconds),
           claim_token = token,
           last_claimed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where schedule.source_id = candidate.source_id;

    source_id := candidate.source_id;
    user_id := candidate.user_id;
    claim_token := token;
    failure_count := greatest(0, coalesce(candidate.consecutive_failures, 0));
    dispatch_count := greatest(0, coalesce(candidate.dispatch_count, 0));
    return next;

    claimed_users := array_append(claimed_users, candidate.user_id);
    claimed_identities := array_append(claimed_identities, candidate.identity_key);
    claimed_count := claimed_count + 1;
    exit when claimed_count >= batch_limit;
  end loop;
end
$function$;

revoke all on function public.claim_catalog_enrichment_sources(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_catalog_enrichment_sources(integer, integer)
  to service_role;

create or replace function public.finish_catalog_enrichment_source(
  p_source_id uuid,
  p_claim_token uuid,
  p_success boolean,
  p_next_delay_seconds integer,
  p_release_leases boolean default true,
  p_result jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  changed integer := 0;
  delay_seconds integer;
  current_lane integer;
  prior_cycle_had_work boolean;
  result_had_work boolean;
begin
  if p_source_id is null or p_claim_token is null then
    return false;
  end if;

  delay_seconds := greatest(
    30,
    least(
      86400,
      coalesce(
        p_next_delay_seconds,
        case when coalesce(p_success, false) then 300 else 600 end
      )
    )
  );

  -- Serialize completion against the exact active token. Besides rejecting a
  -- stale finisher, this lets the database remember whether any earlier lane
  -- in the current six-lane sweep found work.
  select
    mod(schedule.dispatch_count, 6),
    schedule.cycle_had_work
    into current_lane, prior_cycle_had_work
    from public.catalog_enrichment_source_schedule schedule
   where schedule.source_id = p_source_id
     and schedule.claim_token = p_claim_token
   for update;
  if not found then
    return false;
  end if;

  result_had_work := coalesce((p_result->>'processed')::integer, 0) > 0
    or coalesce(p_result @> '{"hasMore":true}'::jsonb, false);

  -- A dry speech lane only proves the full sweep is drained when all four
  -- preceding lanes were also dry. If any earlier lane processed rows or
  -- advertised more work, rotate back to lane 0 on the next cron tick.
  if current_lane = 5 and prior_cycle_had_work then
    delay_seconds := least(delay_seconds, 30);
  end if;

  update public.catalog_enrichment_source_schedule schedule
     set next_run_at = clock_timestamp() + make_interval(secs => delay_seconds),
         lease_until = case
           when coalesce(p_release_leases, true) then null
           else schedule.lease_until
         end,
         claim_token = case
           when coalesce(p_release_leases, true) then null
           else schedule.claim_token
         end,
         last_finished_at = clock_timestamp(),
         consecutive_failures = case
           when coalesce(p_success, false) then 0
           else least(12, schedule.consecutive_failures + 1)
         end,
         -- Advance even after a failed lane. A final-lane outage must not pin
         -- provider probes, subtitles, speech validation or synopsis.
         dispatch_count = schedule.dispatch_count + 1,
         cycle_had_work = case
           when current_lane = 5 then false
           else prior_cycle_had_work or result_had_work
         end,
         last_result = coalesce(p_result, '{}'::jsonb),
         updated_at = clock_timestamp()
   where schedule.source_id = p_source_id
     and schedule.claim_token = p_claim_token;
  get diagnostics changed = row_count;

  if coalesce(p_release_leases, true) then
    delete from public.catalog_enrichment_dispatch_leases lease
     where lease.claim_token = p_claim_token;
  end if;

  return changed = 1;
end
$function$;

revoke all on function public.finish_catalog_enrichment_source(
  uuid, uuid, boolean, integer, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.finish_catalog_enrichment_source(
  uuid, uuid, boolean, integer, boolean, jsonb
) to service_role;

create or replace function public.catalog_enrichment_fleet_preflight()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'schemaVersion', 2,
    'scheduledSources', (
      select count(*) from public.catalog_enrichment_source_schedule
    ),
    'verifiedProviderLinks', (
      select count(*) from public.catalog_source_provider_identities
    )
  )
$function$;

revoke all on function public.catalog_enrichment_fleet_preflight()
  from public, anon, authenticated;
grant execute on function public.catalog_enrichment_fleet_preflight()
  to service_role;

-- Stage the generic dispatcher INACTIVE. The guarded deployment script first
-- checks edge v9 + token + schema, then atomically retires the legacy detection
-- jobs and activates this one. A migration must never disable the known-good
-- fleet before the new worker is reachable.
do $block$
declare
  dynamic_job_id bigint;
begin
  dynamic_job_id := cron.schedule(
    'norva-dynamic-enrichment-fleet',
    '* * * * *',
    $cron$
      select net.http_post(
        url := 'https://api.norva.tv/functions/v1/norva-source-sync/cron/enrichment-fleet?limit=4',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'norva_cron_shared_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
      );
    $cron$
  );
  perform cron.alter_job(dynamic_job_id, active => false);
end
$block$;
