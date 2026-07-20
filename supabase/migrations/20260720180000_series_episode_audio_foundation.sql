-- Exact series-episode identity foundation.
--
-- This migration is deliberately passive: it installs no cron, trigger on the
-- provider-facing series-info cache, or automatic worker. The scan kill switch
-- is created disabled. An episode becomes eligible only after a service-role
-- caller has registered a real series-info payload against an owned parent
-- series variant.
--
-- Canonical file-track coordinates for an episode are always:
--   (provider_identity_id::text, 'episode', episode_id)
-- Parent series ids remain catalogue coordinates only.  Ordered file-local
-- track indexes must never be written to a series parent.

begin;

insert into public.admin_feature_flags(key, enabled, description)
values (
  'episode_audio_scan_enabled',
  false,
  'Canari audio des épisodes enregistrés par inventaire exact; reste désactivé jusqu''à validation opérateur'
)
on conflict (key) do update set
  enabled = false,
  description = excluded.description,
  updated_at = clock_timestamp(),
  updated_by = 'migration:series-episode-audio-foundation';

create table if not exists public.catalog_series_episode_memberships (
  user_id uuid not null
    references auth.users(id) on delete cascade,
  source_id uuid not null
    references public.cloud_sources(id) on delete cascade,
  provider_identity_id uuid not null
    references public.provider_identities(id) on delete cascade,
  parent_title_id uuid not null
    references public.cloud_titles(id) on delete cascade,
  parent_variant_id uuid not null
    references public.cloud_title_variants(id) on delete cascade,
  parent_item_type text not null default 'series'
    check (parent_item_type = 'series'),
  parent_series_id text not null
    check (
      btrim(parent_series_id) <> ''
      and length(parent_series_id) <= 255
      and parent_series_id !~ '[[:cntrl:]]'
    ),
  episode_id text not null
    check (
      btrim(episode_id) <> ''
      and length(episode_id) <= 255
      and episode_id !~ '[[:cntrl:]]'
    ),
  container_extension text not null default 'mp4'
    check (container_extension ~ '^[a-z0-9]{1,16}$'),
  season_number integer
    check (season_number between 0 and 9999),
  episode_number integer
    check (episode_number between 0 and 9999),
  payload_fingerprint text not null
    check (payload_fingerprint ~ '^[0-9a-f]{32}$'),
  series_info_observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, parent_series_id, episode_id),
  unique (user_id, parent_variant_id, episode_id),
  foreign key (source_id, parent_item_type, parent_series_id)
    references public.cloud_title_variants(source_id, item_type, external_id)
    on delete cascade
);

create index if not exists catalog_series_episode_memberships_provider_file_idx
  on public.catalog_series_episode_memberships (
    provider_identity_id, episode_id, parent_series_id
  );

create index if not exists catalog_series_episode_memberships_owner_parent_idx
  on public.catalog_series_episode_memberships (
    user_id, source_id, parent_series_id, season_number, episode_number, episode_id
  );

alter table public.catalog_series_episode_memberships enable row level security;
revoke all on table public.catalog_series_episode_memberships
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.catalog_series_episode_memberships to service_role;

comment on table public.catalog_series_episode_memberships is
  'Service-role-only proof that an exact provider episode belongs to an owned parent series variant. '
  'Canonical file tracks use provider_identity_id::text + item_type episode + episode_id.';

-- Retry state for the metadata-only series inventory lane. This state never
-- contains provider credentials or episode track maps. Its denormalized proof
-- is tied to the exact owned parent variant and the server-written identity.
create table if not exists public.catalog_series_inventory_state (
  user_id uuid not null
    references auth.users(id) on delete cascade,
  source_id uuid not null
    references public.cloud_sources(id) on delete cascade,
  provider_identity_id uuid not null
    references public.provider_identities(id) on delete cascade,
  parent_title_id uuid not null
    references public.cloud_titles(id) on delete cascade,
  parent_variant_id uuid not null
    references public.cloud_title_variants(id) on delete cascade,
  parent_item_type text not null default 'series'
    check (parent_item_type = 'series'),
  parent_series_id text not null
    check (
      btrim(parent_series_id) <> ''
      and length(parent_series_id) <= 255
      and parent_series_id !~ '[[:cntrl:]]'
    ),
  consecutive_failures integer not null default 0
    check (consecutive_failures between 0 and 12),
  episode_count integer
    check (episode_count is null or episode_count >= 0),
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  next_retry_at timestamptz not null default now(),
  last_details jsonb not null default '{}'::jsonb
    check (
      jsonb_typeof(last_details) = 'object'
      and octet_length(last_details::text) <= 32768
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_id, parent_series_id),
  unique (user_id, parent_variant_id),
  foreign key (source_id, parent_item_type, parent_series_id)
    references public.cloud_title_variants(source_id, item_type, external_id)
    on delete cascade
);

create index if not exists catalog_series_inventory_state_due_idx
  on public.catalog_series_inventory_state (
    user_id, source_id, next_retry_at, parent_series_id
  );

alter table public.catalog_series_inventory_state enable row level security;
revoke all on table public.catalog_series_inventory_state
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.catalog_series_inventory_state to service_role;

comment on table public.catalog_series_inventory_state is
  'Service-role-only retry state for exact parent-series inventory. No cron is installed by this migration.';

-- Normalize the Xtream shapes observed in production:
--   {"episodes":{"1":[...]}}
--   {"episodes":[[...], [...]]}
--   {"episodes":[...]}
-- Invalid or ambiguous rows are returned with validation_error; the registering
-- RPC rejects the entire payload instead of partially accepting it.
create or replace function public.catalog_series_info_episode_rows(
  p_payload jsonb
) returns table(
  episode_id text,
  container_extension text,
  season_number integer,
  episode_number integer,
  validation_error text
)
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  with episode_root as (
    select case
      when jsonb_typeof(p_payload) = 'object' then p_payload->'episodes'
      else null
    end as value
  ),
  episode_groups as (
    select
      keyed.key as group_key,
      keyed.value as group_value,
      true as keyed_by_season,
      false as flat_array
    from episode_root root
    cross join lateral jsonb_each(
      case
        when jsonb_typeof(root.value) = 'object' then root.value
        else '{}'::jsonb
      end
    ) keyed

    union all

    select
      array_group.ordinality::text as group_key,
      array_group.value as group_value,
      false as keyed_by_season,
      jsonb_typeof(array_group.value) = 'object' as flat_array
    from episode_root root
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(root.value) = 'array' then root.value
        else '[]'::jsonb
      end
    ) with ordinality array_group(value, ordinality)
  ),
  raw_episodes as (
    select
      episode_groups.group_key,
      episode_groups.keyed_by_season,
      episode_groups.flat_array,
      episode.ordinality as episode_ordinality,
      episode.value as episode
    from episode_groups
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(episode_groups.group_value) = 'array'
          then episode_groups.group_value
        else jsonb_build_array(episode_groups.group_value)
      end
    ) with ordinality episode(value, ordinality)
  ),
  extracted as (
    select
      raw_episodes.*,
      array(
        select distinct candidate
        from unnest(array[
          nullif(btrim(raw_episodes.episode->>'id'), ''),
          nullif(btrim(raw_episodes.episode->>'episode_id'), ''),
          nullif(btrim(raw_episodes.episode->>'stream_id'), '')
        ]) candidate
        where candidate is not null
        order by candidate
      ) as episode_ids,
      regexp_replace(
        lower(btrim(coalesce(
          nullif(raw_episodes.episode->>'container_extension', ''),
          nullif(raw_episodes.episode->>'extension', ''),
          'mp4'
        ))),
        '^\.',
        ''
      ) as normalized_container,
      coalesce(
        nullif(btrim(raw_episodes.episode->>'season'), ''),
        nullif(btrim(raw_episodes.episode->>'season_number'), ''),
        case
          when raw_episodes.keyed_by_season
           and raw_episodes.group_key ~ '^[0-9]{1,4}$'
            then raw_episodes.group_key
          else null
        end
      ) as season_text,
      coalesce(
        nullif(btrim(raw_episodes.episode->>'episode_num'), ''),
        nullif(btrim(raw_episodes.episode->>'episode_number'), '')
      ) as episode_text
    from raw_episodes
  )
  select
    case
      when cardinality(extracted.episode_ids) = 1
        then extracted.episode_ids[1]
      else null
    end as episode_id,
    extracted.normalized_container as container_extension,
    case
      when extracted.season_text ~ '^[0-9]{1,4}$'
        then extracted.season_text::integer
      else null
    end as season_number,
    case
      when extracted.episode_text ~ '^[0-9]{1,4}$'
        then extracted.episode_text::integer
      when extracted.episode_text is null
       and jsonb_typeof(extracted.episode) = 'object'
        then case
          when extracted.flat_array
           and extracted.group_key ~ '^[0-9]{1,4}$'
            then extracted.group_key::integer
          else extracted.episode_ordinality::integer
        end
      else null
    end as episode_number,
    case
      when jsonb_typeof(extracted.episode) <> 'object'
        then 'episode-not-object'
      when cardinality(extracted.episode_ids) = 0
        then 'episode-id-missing'
      when cardinality(extracted.episode_ids) > 1
        then 'episode-id-conflict'
      when length(extracted.episode_ids[1]) > 255
        then 'episode-id-too-long'
      when extracted.episode_ids[1] ~ '[[:cntrl:]]'
        then 'episode-id-invalid'
      when extracted.normalized_container !~ '^[a-z0-9]{1,16}$'
        then 'container-invalid'
      when extracted.season_text is not null
       and extracted.season_text !~ '^[0-9]{1,4}$'
        then 'season-invalid'
      when extracted.episode_text is not null
       and extracted.episode_text !~ '^[0-9]{1,4}$'
        then 'episode-number-invalid'
      when extracted.episode_text is null
       and extracted.flat_array
       and extracted.group_key !~ '^[0-9]{1,4}$'
        then 'episode-number-invalid'
      when extracted.episode_text is null
       and extracted.episode_ordinality > 9999
        then 'episode-number-invalid'
      else null
    end as validation_error
  from extracted
$function$;

revoke all on function public.catalog_series_info_episode_rows(jsonb)
  from public, anon, authenticated;
grant execute on function public.catalog_series_info_episode_rows(jsonb)
  to service_role;

-- Enforce all denormalized coordinates even against direct service-role writes.
-- One provider-scoped advisory lock also makes the provider-global episode id
-- collision check race-free without holding a lock per episode.
create or replace function public.guard_catalog_series_episode_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-series-episode-provider:' || new.provider_identity_id::text,
    0
  ));

  if not exists (
    select 1
    from public.cloud_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
     and title.item_type = variant.item_type
    join public.cloud_sources source
      on source.id = variant.source_id
     and source.user_id = variant.user_id
     and source.deleted_at is null
     and source.enabled = true
    join public.catalog_source_provider_identities identity
      on identity.source_id = source.id
     and identity.user_id = source.user_id
    where variant.id = new.parent_variant_id
      and variant.user_id = new.user_id
      and variant.source_id = new.source_id
      and variant.title_id = new.parent_title_id
      and variant.item_type = 'series'
      and variant.external_id = new.parent_series_id
      and identity.identity_id = new.provider_identity_id
  ) then
    raise exception 'Episode membership does not match an active owned parent series variant'
      using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    if exists (
      select 1
      from public.catalog_series_episode_memberships existing
      where existing.provider_identity_id = new.provider_identity_id
        and existing.episode_id = new.episode_id
        and existing.parent_series_id is distinct from new.parent_series_id
    ) then
      raise exception 'Provider episode id is ambiguously attached to multiple parent series'
        using errcode = '23505';
    end if;
  else
    if exists (
      select 1
      from public.catalog_series_episode_memberships existing
      where existing.provider_identity_id = new.provider_identity_id
        and existing.episode_id = new.episode_id
        and existing.parent_series_id is distinct from new.parent_series_id
        and not (
          existing.source_id = old.source_id
          and existing.parent_series_id = old.parent_series_id
          and existing.episode_id = old.episode_id
        )
    ) then
      raise exception 'Provider episode id is ambiguously attached to multiple parent series'
        using errcode = '23505';
    end if;
  end if;

  new.parent_item_type := 'series';
  new.updated_at := clock_timestamp();
  return new;
end
$function$;

revoke all on function public.guard_catalog_series_episode_membership()
  from public, anon, authenticated;

drop trigger if exists trg_guard_catalog_series_episode_membership
  on public.catalog_series_episode_memberships;
create trigger trg_guard_catalog_series_episode_membership
before insert or update
on public.catalog_series_episode_memberships
for each row execute function public.guard_catalog_series_episode_membership();

create or replace function public.register_catalog_series_episodes(
  p_user_id uuid,
  p_source_id uuid,
  p_parent_series_id text,
  p_payload jsonb
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_variant_id uuid;
  v_title_id uuid;
  v_identity_id uuid;
  v_episode_count integer := 0;
  v_invalid text;
  v_duplicate text;
  v_payload_fingerprint text;
begin
  if p_user_id is null
     or p_source_id is null
     or coalesce(btrim(p_parent_series_id), '') = ''
     or length(btrim(p_parent_series_id)) > 255
     or jsonb_typeof(p_payload) is distinct from 'object'
     or coalesce(jsonb_typeof(p_payload->'episodes'), '') not in ('object', 'array') then
    raise exception 'Owned source, parent series id and series-info episodes are required'
      using errcode = '22023';
  end if;

  select
    variant.id,
    variant.title_id,
    identity.identity_id
    into v_variant_id, v_title_id, v_identity_id
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
   and source.enabled = true
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
  where variant.user_id = p_user_id
    and variant.source_id = p_source_id
    and variant.item_type = 'series'
    and variant.external_id = btrim(p_parent_series_id)
    and variant.title_id is not null
  for key share of variant, source;

  if not found then
    raise exception 'Parent series variant is not owned or lacks a verified provider identity'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-series-episode-provider:' || v_identity_id::text,
    0
  ));

  select rows.validation_error
    into v_invalid
  from public.catalog_series_info_episode_rows(p_payload) rows
  where rows.validation_error is not null
  order by rows.validation_error
  limit 1;
  if v_invalid is not null then
    raise exception 'Invalid series-info episode payload: %', v_invalid
      using errcode = '22023';
  end if;

  select duplicate.episode_id
    into v_duplicate
  from (
    select
      rows.episode_id
    from public.catalog_series_info_episode_rows(p_payload) rows
    where rows.validation_error is null
    group by rows.episode_id
    having count(distinct jsonb_build_object(
      'container', rows.container_extension,
      'season', rows.season_number,
      'episode', rows.episode_number
    )) > 1
  ) duplicate
  order by duplicate.episode_id
  limit 1;
  if v_duplicate is not null then
    raise exception 'Series-info repeats episode id % with conflicting coordinates', v_duplicate
      using errcode = '22023';
  end if;

  select count(distinct rows.episode_id)::integer
    into v_episode_count
  from public.catalog_series_info_episode_rows(p_payload) rows
  where rows.validation_error is null;

  -- An empty payload is not authoritative. It cannot erase a previously proven
  -- membership set, which protects against provider soft-block responses.
  if v_episode_count = 0 then
    return 0;
  end if;

  if exists (
    select 1
    from public.catalog_series_info_episode_rows(p_payload) incoming
    join public.catalog_series_episode_memberships existing
      on existing.provider_identity_id = v_identity_id
     and existing.episode_id = incoming.episode_id
    where incoming.validation_error is null
      and existing.parent_series_id is distinct from btrim(p_parent_series_id)
  ) then
    raise exception 'Series-info contains a provider episode id already proven for another parent'
      using errcode = '23505';
  end if;

  v_payload_fingerprint := md5(p_payload::text);

  insert into public.catalog_series_episode_memberships as membership (
    user_id,
    source_id,
    provider_identity_id,
    parent_title_id,
    parent_variant_id,
    parent_item_type,
    parent_series_id,
    episode_id,
    container_extension,
    season_number,
    episode_number,
    payload_fingerprint,
    series_info_observed_at,
    created_at,
    updated_at
  )
  select distinct on (rows.episode_id)
    p_user_id,
    p_source_id,
    v_identity_id,
    v_title_id,
    v_variant_id,
    'series',
    btrim(p_parent_series_id),
    rows.episode_id,
    rows.container_extension,
    rows.season_number,
    rows.episode_number,
    v_payload_fingerprint,
    clock_timestamp(),
    clock_timestamp(),
    clock_timestamp()
  from public.catalog_series_info_episode_rows(p_payload) rows
  where rows.validation_error is null
  order by rows.episode_id, rows.season_number nulls last, rows.episode_number nulls last
  on conflict (source_id, parent_series_id, episode_id) do update set
    user_id = excluded.user_id,
    provider_identity_id = excluded.provider_identity_id,
    parent_title_id = excluded.parent_title_id,
    parent_variant_id = excluded.parent_variant_id,
    parent_item_type = 'series',
    container_extension = excluded.container_extension,
    season_number = excluded.season_number,
    episode_number = excluded.episode_number,
    payload_fingerprint = excluded.payload_fingerprint,
    series_info_observed_at = excluded.series_info_observed_at,
    updated_at = clock_timestamp();

  -- A valid non-empty series-info payload is a complete membership snapshot for
  -- this exact source + parent. Remove only rows absent from that same payload.
  delete from public.catalog_series_episode_memberships existing
  where existing.user_id = p_user_id
    and existing.source_id = p_source_id
    and existing.parent_series_id = btrim(p_parent_series_id)
    and not exists (
      select 1
      from public.catalog_series_info_episode_rows(p_payload) incoming
      where incoming.validation_error is null
        and incoming.episode_id = existing.episode_id
    );

  return v_episode_count;
end
$function$;

revoke all on function public.register_catalog_series_episodes(
  uuid, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.register_catalog_series_episodes(
  uuid, uuid, text, jsonb
) to service_role;

create or replace function public.catalog_series_episode_coordinates(
  p_user_id uuid,
  p_source_id uuid,
  p_parent_series_id text,
  p_episode_id text
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
  episode_number integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    membership.user_id,
    membership.source_id,
    membership.parent_title_id as title_id,
    membership.parent_variant_id as variant_id,
    membership.provider_identity_id,
    membership.provider_identity_id::text as server_host,
    membership.parent_series_id,
    membership.episode_id,
    membership.container_extension,
    membership.season_number,
    membership.episode_number
  from public.catalog_series_episode_memberships membership
  join public.cloud_sources source
    on source.id = membership.source_id
   and source.user_id = membership.user_id
   and source.deleted_at is null
   and source.enabled = true
  join public.catalog_source_provider_identities identity
    on identity.source_id = membership.source_id
   and identity.user_id = membership.user_id
   and identity.identity_id = membership.provider_identity_id
  where membership.user_id = p_user_id
    and membership.source_id = p_source_id
    and membership.parent_series_id = btrim(p_parent_series_id)
    and membership.episode_id = btrim(p_episode_id)
  limit 1
$function$;

revoke all on function public.catalog_series_episode_coordinates(
  uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.catalog_series_episode_coordinates(
  uuid, uuid, text, text
) to service_role;

-- Playback lookup for old and alternate clients that do not send the parent
-- series id. The registry invariant already makes episode_id unambiguous inside
-- one provider identity; an optional parent is only an additional assertion.
create or replace function public.catalog_series_episode_coordinates_by_episode(
  p_user_id uuid,
  p_source_id uuid,
  p_episode_id text
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
  episode_number integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    membership.user_id,
    membership.source_id,
    membership.parent_title_id as title_id,
    membership.parent_variant_id as variant_id,
    membership.provider_identity_id,
    membership.provider_identity_id::text as server_host,
    membership.parent_series_id,
    membership.episode_id,
    membership.container_extension,
    membership.season_number,
    membership.episode_number
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
  where membership.user_id = p_user_id
    and membership.source_id = p_source_id
    and membership.episode_id = btrim(p_episode_id)
    and not exists (
      select 1
      from public.catalog_series_episode_memberships conflicting
      where conflicting.provider_identity_id = membership.provider_identity_id
        and conflicting.episode_id = membership.episode_id
        and conflicting.parent_series_id is distinct from membership.parent_series_id
    )
  limit 1
$function$;

revoke all on function public.catalog_series_episode_coordinates_by_episode(
  uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.catalog_series_episode_coordinates_by_episode(
  uuid, uuid, text
) to service_role;

-- Metadata-only inventory queue. A parent is eligible only through an exact
-- active Xtream source, exact owned series variant and current server-written
-- provider identity. No hostname/providerKey hint participates in this proof.
create or replace function public.catalog_series_inventory_candidates(
  p_user uuid,
  p_source uuid,
  p_limit int default 4
) returns table(
  parent_series_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select variant.external_id as parent_series_id
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
   and source.enabled = true
   and source.sync_status = 'ready'
   and source.source_type = 'xtream'
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
  left join public.catalog_series_inventory_state inventory
    on inventory.user_id = variant.user_id
   and inventory.source_id = variant.source_id
   and inventory.parent_variant_id = variant.id
   and inventory.parent_series_id = variant.external_id
   and inventory.provider_identity_id = identity.identity_id
  where variant.user_id = p_user
    and variant.source_id = p_source
    and variant.item_type = 'series'
    and variant.title_id is not null
    and coalesce(btrim(variant.external_id), '') <> ''
    and (
      inventory.source_id is null
      or inventory.next_retry_at <= now()
    )
  order by
    case when inventory.source_id is null then 0 else 1 end,
    title.release_year desc nulls last,
    inventory.next_retry_at nulls first,
    variant.external_id,
    variant.id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.catalog_series_inventory_candidates(
  uuid, uuid, int
) from public, anon, authenticated;
grant execute on function public.catalog_series_inventory_candidates(
  uuid, uuid, int
) to service_role;

create or replace function public.record_catalog_series_inventory_outcome(
  p_user uuid,
  p_source uuid,
  p_parent_series_id text,
  p_success boolean,
  p_episode_count int default null,
  p_retry_at timestamptz default null,
  p_details jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_variant_id uuid;
  v_title_id uuid;
  v_identity_id uuid;
  v_prior_failures integer := 0;
  v_registered_episode_count integer := 0;
  v_now timestamptz := clock_timestamp();
  v_retry_at timestamptz;
begin
  if p_user is null
     or p_source is null
     or coalesce(btrim(p_parent_series_id), '') = ''
     or length(btrim(p_parent_series_id)) > 255
     or p_success is null
     or (p_success and (p_episode_count is null or p_episode_count <= 0))
     or (p_episode_count is not null and p_episode_count < 0)
     or jsonb_typeof(coalesce(p_details, '{}'::jsonb)) is distinct from 'object'
     or octet_length(coalesce(p_details, '{}'::jsonb)::text) > 32768 then
    raise exception 'Invalid exact series inventory outcome'
      using errcode = '22023';
  end if;

  select
    variant.id,
    variant.title_id,
    identity.identity_id
    into v_variant_id, v_title_id, v_identity_id
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
   and source.enabled = true
   and source.sync_status = 'ready'
   and source.source_type = 'xtream'
  join public.catalog_source_provider_identities identity
    on identity.source_id = source.id
   and identity.user_id = source.user_id
  where variant.user_id = p_user
    and variant.source_id = p_source
    and variant.item_type = 'series'
    and variant.external_id = btrim(p_parent_series_id)
    and variant.title_id is not null
  for key share of variant, source;
  if not found then
    return false;
  end if;

  -- Match register_catalog_series_episodes' provider lock before comparing the
  -- reported count with the authoritative membership snapshot.
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-series-episode-provider:' || v_identity_id::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-series-inventory:'
      || p_source::text
      || ':'
      || btrim(p_parent_series_id),
    0
  ));

  if p_success then
    select count(*)::integer
      into v_registered_episode_count
    from public.catalog_series_episode_memberships membership
    where membership.user_id = p_user
      and membership.source_id = p_source
      and membership.provider_identity_id = v_identity_id
      and membership.parent_variant_id = v_variant_id
      and membership.parent_series_id = btrim(p_parent_series_id);
    if v_registered_episode_count <> p_episode_count then
      raise exception
        'Series inventory outcome does not match the exact registered episode set'
        using errcode = '23514';
    end if;
  end if;

  select inventory.consecutive_failures
    into v_prior_failures
  from public.catalog_series_inventory_state inventory
  where inventory.source_id = p_source
    and inventory.parent_series_id = btrim(p_parent_series_id)
  for update;
  v_prior_failures := coalesce(v_prior_failures, 0);

  v_retry_at := case
    when p_retry_at is not null then
      greatest(
        v_now + interval '1 minute',
        least(v_now + interval '30 days', p_retry_at)
      )
    when p_success then v_now + interval '24 hours'
    else v_now + make_interval(
      mins => least(
        1440,
        15 * power(2::numeric, least(6, v_prior_failures))::integer
      )
    )
  end;

  insert into public.catalog_series_inventory_state as inventory (
    user_id,
    source_id,
    provider_identity_id,
    parent_title_id,
    parent_variant_id,
    parent_item_type,
    parent_series_id,
    consecutive_failures,
    episode_count,
    last_attempted_at,
    last_succeeded_at,
    last_failed_at,
    next_retry_at,
    last_details,
    created_at,
    updated_at
  ) values (
    p_user,
    p_source,
    v_identity_id,
    v_title_id,
    v_variant_id,
    'series',
    btrim(p_parent_series_id),
    case when p_success then 0 else 1 end,
    case when p_success then p_episode_count else null end,
    v_now,
    case when p_success then v_now else null end,
    case when p_success then null else v_now end,
    v_retry_at,
    coalesce(p_details, '{}'::jsonb),
    v_now,
    v_now
  )
  on conflict (source_id, parent_series_id) do update set
    user_id = excluded.user_id,
    provider_identity_id = excluded.provider_identity_id,
    parent_title_id = excluded.parent_title_id,
    parent_variant_id = excluded.parent_variant_id,
    parent_item_type = 'series',
    consecutive_failures = case
      when p_success then 0
      else least(12, inventory.consecutive_failures + 1)
    end,
    episode_count = case
      when p_success then excluded.episode_count
      else inventory.episode_count
    end,
    last_attempted_at = v_now,
    last_succeeded_at = case
      when p_success then v_now
      else inventory.last_succeeded_at
    end,
    last_failed_at = case
      when p_success then inventory.last_failed_at
      else v_now
    end,
    next_retry_at = v_retry_at,
    last_details = excluded.last_details,
    updated_at = v_now;

  return true;
end
$function$;

revoke all on function public.record_catalog_series_inventory_outcome(
  uuid, uuid, text, boolean, int, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_catalog_series_inventory_outcome(
  uuid, uuid, text, boolean, int, timestamptz, jsonb
) to service_role;

-- Merge one canonical episode cache row into one exact tenant observation.
-- This helper never writes an ordered map or a verification cursor to the
-- parent title/variant. The conflict update is atomic: an already strict owner
-- keeps both its languages and certificate. A canonical strict certificate is
-- applied in a second statement because the historical reset trigger clears a
-- certificate whenever the observed language set itself changes.
create or replace function public.merge_catalog_episode_file_observation(
  p_user_id uuid,
  p_source_id uuid,
  p_parent_series_id text,
  p_episode_id text,
  p_include_audio boolean default true,
  p_include_subtitle boolean default true
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_membership public.catalog_series_episode_memberships%rowtype;
  v_cache public.catalog_file_tracks%rowtype;
  v_audio_languages text[] := '{}'::text[];
  v_subtitle_languages text[] := '{}'::text[];
  v_audio_observed boolean := false;
  v_subtitle_observed boolean := false;
begin
  select membership.*
    into v_membership
  from public.catalog_series_episode_memberships membership
  join public.cloud_sources source
    on source.id = membership.source_id
   and source.user_id = membership.user_id
   and source.deleted_at is null
   and source.enabled = true
  join public.catalog_source_provider_identities identity
    on identity.source_id = membership.source_id
   and identity.user_id = membership.user_id
   and identity.identity_id = membership.provider_identity_id
  where membership.user_id = p_user_id
    and membership.source_id = p_source_id
    and membership.parent_series_id = btrim(p_parent_series_id)
    and membership.episode_id = btrim(p_episode_id);

  if not found then
    return null;
  end if;

  select cache.*
    into v_cache
  from public.catalog_file_tracks cache
  where cache.server_host = v_membership.provider_identity_id::text
    and cache.item_type = 'episode'
    and cache.external_id = v_membership.episode_id
  for share;
  if not found then
    return null;
  end if;

  if exists (
    select 1
    from public.catalog_series_episode_memberships conflicting
    where conflicting.provider_identity_id = v_membership.provider_identity_id
      and conflicting.episode_id = v_membership.episode_id
      and conflicting.parent_series_id is distinct from v_membership.parent_series_id
  ) then
    raise exception 'Ambiguous provider episode coordinates'
      using errcode = '23505';
  end if;

  v_audio_observed := coalesce(p_include_audio, false)
    and v_cache.audio_probed_at is not null;
  v_subtitle_observed := coalesce(p_include_subtitle, false)
    and v_cache.subtitle_probed_at is not null;
  if not v_audio_observed and not v_subtitle_observed then
    return null;
  end if;

  if v_audio_observed then
    v_audio_languages := public.cloud_file_track_languages(v_cache.audio_tracks);
  end if;
  if v_subtitle_observed then
    v_subtitle_languages := public.cloud_file_track_languages(v_cache.subtitle_tracks);
  end if;

  insert into public.cloud_title_file_language_observations as observation (
    user_id,
    title_id,
    variant_id,
    file_external_id,
    audio_languages,
    subtitle_languages,
    audio_observed,
    subtitle_observed,
    audio_verified_at,
    audio_verification,
    updated_at
  ) values (
    v_membership.user_id,
    v_membership.parent_title_id,
    v_membership.parent_variant_id,
    v_membership.episode_id,
    v_audio_languages,
    v_subtitle_languages,
    v_audio_observed,
    v_subtitle_observed,
    null,
    case
      when v_audio_observed
        then coalesce(v_cache.audio_lang_verification, '{}'::jsonb)
      else '{}'::jsonb
    end,
    clock_timestamp()
  )
  on conflict (user_id, variant_id, file_external_id) do update set
    title_id = excluded.title_id,
    audio_languages = case
      when observation.audio_verified_at is not null
        then observation.audio_languages
      when excluded.audio_observed
        then excluded.audio_languages
      else observation.audio_languages
    end,
    subtitle_languages = case
      when excluded.subtitle_observed
        then excluded.subtitle_languages
      else observation.subtitle_languages
    end,
    audio_observed = observation.audio_observed or excluded.audio_observed,
    subtitle_observed = observation.subtitle_observed or excluded.subtitle_observed,
    audio_verified_at = observation.audio_verified_at,
    audio_verification = case
      when observation.audio_verified_at is not null
        then observation.audio_verification
      when excluded.audio_observed
        then excluded.audio_verification
      else observation.audio_verification
    end,
    updated_at = clock_timestamp();

  if v_audio_observed then
    if v_cache.audio_lang_verified_at is not null
       and cardinality(v_audio_languages) > 0 then
      update public.cloud_title_file_language_observations observation
         set audio_verified_at = v_cache.audio_lang_verified_at,
             audio_verification =
               coalesce(v_cache.audio_lang_verification, '{}'::jsonb)
               || jsonb_build_object(
                    'status', 'verified',
                    'scope', 'canonical-episode-file'
                  ),
             updated_at = clock_timestamp()
       where observation.user_id = v_membership.user_id
         and observation.title_id = v_membership.parent_title_id
         and observation.variant_id = v_membership.parent_variant_id
         and observation.file_external_id = v_membership.episode_id
         and observation.audio_verified_at is null
         and observation.audio_observed
         and observation.audio_languages = v_audio_languages;
    else
      -- The language-changing upsert trigger may have reset provenance. Restore
      -- only non-strict provenance, guarded by the exact accepted language set.
      update public.cloud_title_file_language_observations observation
         set audio_verification =
               coalesce(v_cache.audio_lang_verification, '{}'::jsonb)
               || jsonb_build_object('scope', 'canonical-episode-file'),
             updated_at = clock_timestamp()
       where observation.user_id = v_membership.user_id
         and observation.title_id = v_membership.parent_title_id
         and observation.variant_id = v_membership.parent_variant_id
         and observation.file_external_id = v_membership.episode_id
         and observation.audio_verified_at is null
         and observation.audio_observed
         and observation.audio_languages = v_audio_languages;
    end if;
  end if;

  return v_membership.parent_title_id;
end
$function$;

revoke all on function public.merge_catalog_episode_file_observation(
  uuid, uuid, text, text, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.merge_catalog_episode_file_observation(
  uuid, uuid, text, text, boolean, boolean
) to service_role;

-- Same call shape as the movie fanout, but episode ownership is resolved only
-- through the exact registry. Caller-supplied maps are intentionally ignored:
-- the canonical cache row is re-read under lock by the merge helper.
create or replace function public.fanout_episode_file_tracks_to_users(
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
  v_title_id uuid;
  v_title_ids uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'episode'
     or coalesce(btrim(p_external_id), '') = ''
     or (
       not coalesce(p_has_audio, false)
       and not coalesce(p_has_subtitle, false)
     ) then
    return 0;
  end if;

  if not exists (
    select 1
    from public.catalog_file_tracks cache
    where cache.server_host = btrim(p_server_host)
      and cache.item_type = 'episode'
      and cache.external_id = btrim(p_external_id)
      and (
        (coalesce(p_has_audio, false) and cache.audio_probed_at is not null)
        or
        (coalesce(p_has_subtitle, false) and cache.subtitle_probed_at is not null)
      )
  ) then
    return 0;
  end if;

  if (
    select count(distinct membership.parent_series_id)
    from public.catalog_series_episode_memberships membership
    where membership.provider_identity_id::text = btrim(p_server_host)
      and membership.episode_id = btrim(p_external_id)
  ) > 1 then
    raise exception 'Ambiguous provider episode coordinates'
      using errcode = '23505';
  end if;

  for v_owner in
    select
      membership.user_id,
      membership.source_id,
      membership.parent_series_id,
      membership.episode_id
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
    where membership.provider_identity_id::text = btrim(p_server_host)
      and membership.episode_id = btrim(p_external_id)
    order by
      membership.user_id,
      membership.source_id,
      membership.parent_series_id
  loop
    v_title_id := public.merge_catalog_episode_file_observation(
      v_owner.user_id,
      v_owner.source_id,
      v_owner.parent_series_id,
      v_owner.episode_id,
      coalesce(p_has_audio, false),
      coalesce(p_has_subtitle, false)
    );
    if v_title_id is not null then
      if not (v_title_id = any(v_title_ids)) then
        v_title_ids := array_append(v_title_ids, v_title_id);
      end if;
      v_count := v_count + 1;
    end if;
  end loop;

  foreach v_title_id in array v_title_ids
  loop
    -- Only the derived set union is refreshed. No ordered track map, strict
    -- cursor, codec profile, or verification marker is written to the parent.
    perform public.recompute_cloud_title_file_languages(
      (select title.user_id from public.cloud_titles title where title.id = v_title_id),
      v_title_id
    );
  end loop;

  return v_count;
end
$function$;

revoke all on function public.fanout_episode_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.fanout_episode_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

create or replace function public.hydrate_catalog_episode_file_tracks(
  p_user_id uuid,
  p_source_id uuid,
  p_parent_series_id text,
  p_episode_ids text[] default null
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_episode record;
  v_title_id uuid;
  v_title_ids uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  if p_user_id is null
     or p_source_id is null
     or coalesce(btrim(p_parent_series_id), '') = '' then
    return 0;
  end if;

  for v_episode in
    select membership.episode_id
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
    join public.catalog_file_tracks cache
      on cache.server_host = membership.provider_identity_id::text
     and cache.item_type = 'episode'
     and cache.external_id = membership.episode_id
     and (
       cache.audio_probed_at is not null
       or cache.subtitle_probed_at is not null
     )
    where membership.user_id = p_user_id
      and membership.source_id = p_source_id
      and membership.parent_series_id = btrim(p_parent_series_id)
      and (
        p_episode_ids is null
        or membership.episode_id = any(p_episode_ids)
      )
    order by
      membership.season_number nulls last,
      membership.episode_number nulls last,
      membership.episode_id
  loop
    v_title_id := public.merge_catalog_episode_file_observation(
      p_user_id,
      p_source_id,
      btrim(p_parent_series_id),
      v_episode.episode_id,
      true,
      true
    );
    if v_title_id is not null then
      if not (v_title_id = any(v_title_ids)) then
        v_title_ids := array_append(v_title_ids, v_title_id);
      end if;
      v_count := v_count + 1;
    end if;
  end loop;

  foreach v_title_id in array v_title_ids
  loop
    perform public.recompute_cloud_title_file_languages(p_user_id, v_title_id);
  end loop;

  return v_count;
end
$function$;

revoke all on function public.hydrate_catalog_episode_file_tracks(
  uuid, uuid, text, text[]
) from public, anon, authenticated;
grant execute on function public.hydrate_catalog_episode_file_tracks(
  uuid, uuid, text, text[]
) to service_role;

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
  select
    membership.user_id,
    membership.source_id,
    membership.parent_title_id as title_id,
    membership.parent_variant_id as variant_id,
    membership.provider_identity_id,
    membership.provider_identity_id::text as server_host,
    membership.parent_series_id,
    membership.episode_id,
    membership.container_extension,
    membership.season_number,
    membership.episode_number,
    coalesce(cache.audio_tracks, '[]'::jsonb) as audio_tracks,
    coalesce(cache.subtitle_tracks, '[]'::jsonb) as subtitle_tracks,
    cache.audio_probed_at,
    cache.subtitle_probed_at
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
    and (
      cache.audio_probed_at is null
      or cache.audio_probed_at < now() - interval '180 days'
    )
    and not exists (
      select 1
      from public.catalog_series_episode_memberships conflicting
      where conflicting.provider_identity_id = membership.provider_identity_id
        and conflicting.episode_id = membership.episode_id
        and conflicting.parent_series_id is distinct from membership.parent_series_id
    )
  order by
    cache.audio_probed_at asc nulls first,
    membership.series_info_observed_at desc,
    membership.parent_series_id,
    membership.season_number nulls last,
    membership.episode_number nulls last,
    membership.episode_id
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
  select
    membership.user_id,
    membership.source_id,
    membership.parent_title_id as title_id,
    membership.parent_variant_id as variant_id,
    membership.provider_identity_id,
    membership.provider_identity_id::text as server_host,
    membership.parent_series_id,
    membership.episode_id,
    membership.container_extension,
    membership.season_number,
    membership.episode_number,
    cache.audio_tracks,
    cache.audio_probed_at,
    cache.audio_whisper_attempted_at,
    cache.audio_whisper_retry_at
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
    and cache.audio_lang_verified_at is null
    and coalesce(
      cache.audio_whisper_retry_at,
      cache.audio_whisper_attempted_at + interval '30 days',
      '-infinity'::timestamptz
    ) <= now()
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
      ) in ('und', 'un', 'mis', 'mul', 'zxx', 'nar', 'unknown')
    )
    and not exists (
      select 1
      from public.catalog_series_episode_memberships conflicting
      where conflicting.provider_identity_id = membership.provider_identity_id
        and conflicting.episode_id = membership.episode_id
        and conflicting.parent_series_id is distinct from membership.parent_series_id
    )
  order by
    coalesce(
      cache.audio_whisper_retry_at,
      cache.audio_whisper_attempted_at + interval '30 days',
      '-infinity'::timestamptz
    ),
    membership.series_info_observed_at desc,
    membership.parent_series_id,
    membership.season_number nulls last,
    membership.episode_number nulls last,
    membership.episode_id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.catalog_episode_lid_candidates(
  uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.catalog_episode_lid_candidates(
  uuid, uuid, integer
) to service_role;

-- Every canonical episode writer calls this guard in its own transaction.
-- Besides rejecting orphan coordinates, the provider lock serializes the
-- decision against atomic series-info replacement.
create or replace function public.catalog_episode_file_coordinate_is_registered(
  p_server_host text,
  p_external_id text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_membership_count integer := 0;
  v_parent_count integer := 0;
begin
  if coalesce(p_server_host, '') = ''
     or p_server_host is distinct from btrim(p_server_host)
     or coalesce(p_external_id, '') = ''
     or p_external_id is distinct from btrim(p_external_id) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-series-episode-provider:' || p_server_host,
    0
  ));
  select
    count(*)::integer,
    count(distinct membership.parent_series_id)::integer
    into v_membership_count, v_parent_count
  from public.catalog_series_episode_memberships membership
  join public.cloud_sources source
    on source.id = membership.source_id
   and source.user_id = membership.user_id
   and source.deleted_at is null
   and source.enabled = true
  join public.catalog_source_provider_identities identity
    on identity.source_id = membership.source_id
   and identity.user_id = membership.user_id
   and identity.identity_id = membership.provider_identity_id
  where membership.provider_identity_id::text = p_server_host
    and membership.episode_id = p_external_id;

  if v_parent_count > 1 then
    raise exception 'Ambiguous provider episode coordinates'
      using errcode = '23505';
  end if;
  return v_membership_count > 0 and v_parent_count = 1;
end
$function$;

revoke all on function public.catalog_episode_file_coordinate_is_registered(
  text, text
) from public, anon, authenticated, service_role;

-- Extend the existing canonical writers to the explicit episode file type.
-- Their movie behavior is unchanged; parent-series rows remain unsupported by
-- the detected/validated writers.
create or replace function public.upsert_catalog_file_tracks(
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
     or p_item_type not in ('movie', 'series', 'episode') then
    return;
  end if;
  if p_item_type = 'episode'
     and not public.catalog_episode_file_coordinate_is_registered(
       p_server_host,
       p_external_id
     ) then
    return;
  end if;

  insert into public.catalog_file_tracks as cache (
    server_host, item_type, external_id,
    audio_tracks, subtitle_tracks,
    audio_probed_at, subtitle_probed_at, updated_at
  ) values (
    p_server_host,
    p_item_type,
    p_external_id,
    case when p_has_audio then coalesce(p_audio_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_subtitle then coalesce(p_subtitle_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_audio then clock_timestamp() else null end,
    case when p_has_subtitle then clock_timestamp() else null end,
    clock_timestamp()
  )
  on conflict (server_host, item_type, external_id) do update set
    audio_lang_verified_at = case
      when p_has_audio
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           is distinct from public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then null
      else cache.audio_lang_verified_at
    end,
    audio_lang_verification = case
      when p_has_audio
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           is distinct from public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then '{}'::jsonb
      else cache.audio_lang_verification
    end,
    audio_tracks = case
      when p_has_audio
       and (
         cache.audio_lang_verified_at is not null
         or cache.audio_lang_verification->>'status' in ('validating', 'pending')
       )
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
    updated_at = clock_timestamp();
end
$function$;

revoke all on function public.upsert_catalog_file_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_catalog_file_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

create or replace function public.upsert_catalog_file_validated_tracks(
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
     or p_item_type not in ('movie', 'episode') then
    return;
  end if;
  if p_item_type = 'episode'
     and not public.catalog_episode_file_coordinate_is_registered(
       p_server_host,
       p_external_id
     ) then
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
    jsonb_build_object(
      'status', 'validating',
      'method', 'whisper-strict-consensus-v4',
      'startedAt', clock_timestamp()
    ),
    clock_timestamp()
  )
  on conflict (server_host, item_type, external_id) do update set
    audio_tracks = case
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
      when p_has_audio then null
      else cache.audio_lang_verified_at
    end,
    audio_lang_verification = case
      when p_has_audio then jsonb_build_object(
        'status', 'validating',
        'method', 'whisper-strict-consensus-v4',
        'startedAt', clock_timestamp()
      )
      else cache.audio_lang_verification
    end,
    updated_at = clock_timestamp();
end
$function$;

revoke all on function public.upsert_catalog_file_validated_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_catalog_file_validated_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

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
     or p_item_type not in ('movie', 'episode') then
    return;
  end if;
  if p_item_type = 'episode'
     and not public.catalog_episode_file_coordinate_is_registered(
       p_server_host,
       p_external_id
     ) then
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
  v_membership_count integer := 0;
  v_parent_count integer := 0;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type not in ('movie', 'episode')
     or coalesce(btrim(p_external_id), '') = '' then
    return false;
  end if;

  if p_item_type = 'episode' then
    perform pg_advisory_xact_lock(hashtextextended(
      'catalog-series-episode-provider:' || btrim(p_server_host),
      0
    ));
    select
      count(*)::integer,
      count(distinct membership.parent_series_id)::integer
      into v_membership_count, v_parent_count
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
    where membership.provider_identity_id::text = btrim(p_server_host)
      and membership.episode_id = btrim(p_external_id);
    if v_membership_count = 0 then
      return false;
    end if;
    if v_parent_count <> 1 then
      raise exception 'Ambiguous provider episode coordinates'
        using errcode = '23505';
    end if;
  end if;

  update public.catalog_file_tracks cache
     set audio_lang_verified_at = case
           when coalesce(p_verified, false)
            and cache.audio_probed_at is not null
            and cardinality(
              public.cloud_file_track_languages(cache.audio_tracks)
            ) > 0
             then coalesce(p_verified_at, clock_timestamp())
           else null
         end,
         audio_lang_retry_at = case
           when coalesce(p_verified, false)
            and cache.audio_probed_at is not null
            and cardinality(
              public.cloud_file_track_languages(cache.audio_tracks)
            ) > 0
             then null
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
    and cardinality(
      public.cloud_file_track_languages(v_cache.audio_tracks)
    ) > 0;

  if p_item_type = 'movie' then
    -- Preserve the deployed movie fanout transaction exactly.
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
  else
    -- Episode owners and future owners are resolved only by the exact registry.
    perform public.fanout_episode_file_tracks_to_users(
      btrim(p_server_host),
      'episode',
      btrim(p_external_id),
      v_cache.audio_tracks,
      v_cache.subtitle_tracks,
      v_cache.audio_probed_at is not null,
      false
    );
  end if;

  return true;
end
$function$;

revoke all on function public.record_catalog_file_audio_verification(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_catalog_file_audio_verification(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
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
  v_membership_count integer := 0;
  v_parent_count integer := 0;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type not in ('movie', 'episode')
     or coalesce(btrim(p_external_id), '') = '' then
    return false;
  end if;

  if p_item_type = 'episode' then
    perform pg_advisory_xact_lock(hashtextextended(
      'catalog-series-episode-provider:' || btrim(p_server_host),
      0
    ));
    select
      count(*)::integer,
      count(distinct membership.parent_series_id)::integer
      into v_membership_count, v_parent_count
    from public.catalog_series_episode_memberships membership
    join public.cloud_sources source
      on source.id = membership.source_id
     and source.user_id = membership.user_id
     and source.deleted_at is null
     and source.enabled = true
    join public.catalog_source_provider_identities identity
      on identity.source_id = membership.source_id
     and identity.user_id = membership.user_id
     and identity.identity_id = membership.provider_identity_id
    where membership.provider_identity_id::text = btrim(p_server_host)
      and membership.episode_id = btrim(p_external_id);
    if v_membership_count = 0 then
      return false;
    end if;
    if v_parent_count <> 1 then
      raise exception 'Ambiguous provider episode coordinates'
        using errcode = '23505';
    end if;
  end if;

  update public.catalog_file_tracks cache
     set audio_whisper_attempted_at = case
           when coalesce(p_completed, false)
             then coalesce(p_attempted_at, clock_timestamp())
           else cache.audio_whisper_attempted_at
         end,
         -- Preserve the deployed dual-use cursor: an untagged completed pass
         -- supplies NULL; tagged basic detection may supply a long retry.
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

create or replace function public.refresh_catalog_file_audio_detection_provenance(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_audio_tracks jsonb
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_method text := 'whisper-basic-v1';
  v_count integer := 0;
  v_rows integer := 0;
  v_canonical_tracks jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type not in ('movie', 'episode')
     or coalesce(btrim(p_external_id), '') = '' then
    return 0;
  end if;

  select cache.audio_tracks
    into v_canonical_tracks
  from public.catalog_file_tracks cache
  where cache.server_host = p_server_host
    and cache.item_type = p_item_type
    and cache.external_id = p_external_id
  for share;
  if not found then return 0; end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_canonical_tracks, '[]'::jsonb)) track
    where track->>'lidMethod' in (
      'whisper-detect-only-v1',
      'lid-cascade-v1'
    )
  ) then
    v_method := case
      when exists (
        select 1
        from jsonb_array_elements(coalesce(v_canonical_tracks, '[]'::jsonb)) track
        where track->>'lidMethod' = 'lid-cascade-v1'
      ) then 'lid-cascade-v1'
      else 'whisper-detect-only-v1'
    end;
  end if;

  update public.catalog_file_tracks cache
     set audio_lang_verification = jsonb_build_object(
           'status', 'detected',
           'method', v_method,
           'scope', case
             when p_item_type = 'episode' then 'canonical-episode-file'
             else 'canonical-file'
           end,
           'detectedAt', clock_timestamp()
         ),
         updated_at = clock_timestamp()
   where cache.server_host = p_server_host
     and cache.item_type = p_item_type
     and cache.external_id = p_external_id
     and cache.audio_lang_verified_at is null;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  if p_item_type = 'movie' then
    update public.cloud_title_file_language_observations observation
       set audio_verification = jsonb_build_object(
             'status', 'detected',
             'method', v_method,
             'scope', 'canonical-file'
           ),
           updated_at = clock_timestamp()
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
       and variant.item_type = 'movie'
       and variant.external_id = p_external_id
       and coalesce(
         verified_identity.identity_id::text,
         'source:' || source.id::text
       ) = p_server_host;
  else
    update public.cloud_title_file_language_observations observation
       set audio_verification = jsonb_build_object(
             'status', 'detected',
             'method', v_method,
             'scope', 'canonical-episode-file'
           ),
           updated_at = clock_timestamp()
      from public.catalog_series_episode_memberships membership
      join public.cloud_sources source
        on source.id = membership.source_id
       and source.user_id = membership.user_id
       and source.deleted_at is null
       and source.enabled = true
     where observation.user_id = membership.user_id
       and observation.title_id = membership.parent_title_id
       and observation.variant_id = membership.parent_variant_id
       and observation.file_external_id = membership.episode_id
       and observation.audio_verified_at is null
       and membership.provider_identity_id::text = p_server_host
       and membership.episode_id = p_external_id;
  end if;
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  return v_count;
end
$function$;

revoke all on function public.refresh_catalog_file_audio_detection_provenance(
  text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.refresh_catalog_file_audio_detection_provenance(
  text, text, text, jsonb
) to service_role;

-- The cascade ledger originally accepted movies only. Episode LID uses the
-- same immutable audit trail, rollout policy and daily cap, so widen only this
-- coordinate constraint before installing the episode persistence branch.
-- Dropping by the stable PostgreSQL-generated name makes the change safe on
-- both a fresh database and one where this migration is retried transactionally.
alter table public.catalog_audio_lid_attempts
  drop constraint if exists catalog_audio_lid_attempts_item_type_check;
alter table public.catalog_audio_lid_attempts
  add constraint catalog_audio_lid_attempts_item_type_check
  check (item_type in ('movie', 'episode'));

-- Preserve the already-deployed movie transaction byte-for-byte behind a
-- private dispatch target. The public RPC below routes movies to it and keeps
-- the new episode branch isolated from movie semantics.
do $rename_movie_lid_persistence$
begin
  if to_regprocedure(
    'public.persist_catalog_movie_audio_lid_outcome(uuid,text,text,text,integer,timestamp with time zone,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamp with time zone)'
  ) is null then
    execute
      'alter function public.persist_catalog_audio_lid_outcome('
      || 'uuid, text, text, text, integer, timestamptz, text, text, integer, '
      || 'text, text, text, double precision, text, integer, integer, integer, '
      || 'jsonb, timestamptz'
      || ') rename to persist_catalog_movie_audio_lid_outcome';
  end if;
end
$rename_movie_lid_persistence$;

revoke all on function public.persist_catalog_movie_audio_lid_outcome(
  uuid, text, text, text, integer, timestamptz, text, text, integer,
  text, text, text, double precision, text, integer, integer, integer,
  jsonb, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.persist_catalog_episode_audio_lid_outcome(
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
  v_membership_count integer := 0;
  v_parent_count integer := 0;
  v_persisted boolean := false;
  v_unknown_remaining boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  -- A lost response may be retried even after the rollout policy changes.
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

  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'episode'
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
    raise exception 'Invalid episode LID cascade coordinates or evidence'
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
    or p_route not in (
      'fast-consensus',
      'whisper-tiebreak',
      'full-transcript-fallback'
    )
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

  -- Serialize against atomic series-info replacement and require a current,
  -- server-written provider identity. Multiple owners are expected; multiple
  -- parent series for the same provider episode are not.
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-series-episode-provider:' || btrim(p_server_host),
    0
  ));
  select
    count(*)::integer,
    count(distinct membership.parent_series_id)::integer
    into v_membership_count, v_parent_count
  from public.catalog_series_episode_memberships membership
  join public.cloud_sources source
    on source.id = membership.source_id
   and source.user_id = membership.user_id
   and source.deleted_at is null
   and source.enabled = true
  join public.catalog_source_provider_identities identity
    on identity.source_id = membership.source_id
   and identity.user_id = membership.user_id
   and identity.identity_id = membership.provider_identity_id
  where membership.provider_identity_id::text = btrim(p_server_host)
    and membership.episode_id = btrim(p_external_id);
  if v_membership_count = 0 then
    raise exception 'Exact episode membership is missing'
      using errcode = 'P0002';
  end if;
  if v_parent_count <> 1 then
    raise exception 'Ambiguous provider episode coordinates'
      using errcode = '23505';
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
    and attempt.created_at >=
      date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';
  if v_attempt_count >= v_policy.daily_cap then
    raise exception 'LID cascade daily cap reached'
      using errcode = '54000';
  end if;

  -- This is the only ordered-map lock/write in the episode branch. It targets
  -- the canonical episode file, never the parent series variant.
  select cache.*
    into v_cache
  from public.catalog_file_tracks cache
  where cache.server_host = btrim(p_server_host)
    and cache.item_type = 'episode'
    and cache.external_id = btrim(p_external_id)
  for update;
  if not found then
    raise exception 'Exact episode catalog file is missing'
      using errcode = 'P0002';
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
    and (track->>'index')::integer = p_stream_index;

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
     and v_previous_language not in (
       'un', 'und', 'mul', 'zxx', 'mis', 'nar', 'unknown'
     ) then
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
    from jsonb_array_elements(v_cache.audio_tracks)
      with ordinality tracks(track, ordinality);

    select exists (
      select 1
      from jsonb_array_elements(v_tracks) tracks(track)
      where lower(btrim(coalesce(
        track->>'lang',
        track->>'language',
        ''
      ))) in ('', 'un', 'und', 'mul', 'zxx', 'mis', 'nar', 'unknown')
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
             'scope', 'canonical-episode-file',
             'route', p_route,
             'policyVersion', p_policy_version,
             'attemptId', p_attempt_id,
             'detectedAt', v_now
           ),
           updated_at = v_now
     where cache.server_host = btrim(p_server_host)
       and cache.item_type = 'episode'
       and cache.external_id = btrim(p_external_id)
       and cache.audio_lang_verified_at is null
       and cache.audio_probed_at = p_expected_audio_probed_at;
    if found then
      v_persisted := true;
      perform public.fanout_episode_file_tracks_to_users(
        btrim(p_server_host),
        'episode',
        btrim(p_external_id),
        v_tracks,
        v_cache.subtitle_tracks,
        true,
        false
      );
    end if;
  elsif p_rollout_mode <> 'shadow' then
    -- Pending/error changes retry metadata on the canonical episode only.
    update public.catalog_file_tracks cache
       set audio_whisper_retry_at =
             coalesce(p_retry_at, v_now + interval '15 minutes'),
           audio_whisper_verification = jsonb_build_object(
             'status', p_status,
             'method', 'lid-cascade-v1',
             'route', p_route,
             'policyVersion', p_policy_version,
             'attemptId', p_attempt_id,
             'attemptedAt', v_now
           ),
           updated_at = v_now
     where cache.server_host = btrim(p_server_host)
       and cache.item_type = 'episode'
       and cache.external_id = btrim(p_external_id)
       and cache.audio_lang_verified_at is null
       and cache.audio_probed_at = p_expected_audio_probed_at;
  end if;

  -- Audit insertion remains last so the cache update, exact registry fanout and
  -- immutable attempt either commit together or roll back together.
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
    btrim(p_server_host),
    'episode',
    btrim(p_external_id),
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
    coalesce(p_evidence, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'failure', v_failure,
        'workerRoute', p_route,
        'workerStatus', p_status,
        'scope', 'canonical-episode-file'
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

revoke all on function public.persist_catalog_episode_audio_lid_outcome(
  uuid, text, text, text, integer, timestamptz, text, text, integer,
  text, text, text, double precision, text, integer, integer, integer,
  jsonb, timestamptz
) from public, anon, authenticated, service_role;

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
begin
  if p_item_type = 'movie' then
    return public.persist_catalog_movie_audio_lid_outcome(
      p_attempt_id,
      p_server_host,
      p_item_type,
      p_external_id,
      p_stream_index,
      p_expected_audio_probed_at,
      p_policy_version,
      p_rollout_mode,
      p_cohort_bucket,
      p_route,
      p_status,
      p_language,
      p_confidence,
      p_sample_sha256,
      p_sample_bytes,
      p_extraction_ms,
      p_inference_ms,
      p_evidence,
      p_retry_at
    );
  elsif p_item_type = 'episode' then
    return public.persist_catalog_episode_audio_lid_outcome(
      p_attempt_id,
      p_server_host,
      p_item_type,
      p_external_id,
      p_stream_index,
      p_expected_audio_probed_at,
      p_policy_version,
      p_rollout_mode,
      p_cohort_bucket,
      p_route,
      p_status,
      p_language,
      p_confidence,
      p_sample_sha256,
      p_sample_bytes,
      p_extraction_ms,
      p_inference_ms,
      p_evidence,
      p_retry_at
    );
  end if;

  raise exception 'Invalid LID cascade item type'
    using errcode = '22023';
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

-- Reuse the existing dynamic fleet for future series-only catalogues. The
-- dispatcher still claims at most one source per user and provider identity;
-- only the eligibility predicate changes from movie to movie-or-series.
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
  lease_seconds integer :=
    greatest(60, least(1800, coalesce(p_lease_seconds, 1200)));
  claimed_count integer := 0;
  token uuid;
  user_lease_claimed boolean;
  identity_lease_claimed boolean;
  user_lease_key text;
  provider_lease_key text;
begin
  delete from public.catalog_enrichment_dispatch_leases lease
   where lease.expires_at < clock_timestamp() - interval '1 day';

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
    and source.source_type in (
      'xtream', 'm3u', 'jellyfin', 'plex', 'local', 'custom'
    )
    and exists (
      select 1
      from public.cloud_title_variants variant
      where variant.source_id = source.id
        and variant.user_id = source.user_id
        and variant.item_type in ('movie', 'series')
    )
  on conflict on constraint catalog_enrichment_source_schedule_pkey do update
    set user_id = excluded.user_id,
        updated_at = case
          when schedule.user_id is distinct from excluded.user_id
            then excluded.updated_at
          else schedule.updated_at
        end
  where schedule.user_id is distinct from excluded.user_id;

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
        from public.cloud_title_variants eligible_variant
        where eligible_variant.source_id = source.id
          and eligible_variant.user_id = source.user_id
          and eligible_variant.item_type in ('movie', 'series')
      )
      and schedule.next_run_at <= clock_timestamp()
      and (
        schedule.lease_until is null
        or schedule.lease_until <= clock_timestamp()
      )
    order by schedule.next_run_at, schedule.source_id
    for update of schedule skip locked
  loop
    if candidate.user_id = any(claimed_users)
       or candidate.identity_key = any(claimed_identities) then
      continue;
    end if;

    token := gen_random_uuid();
    user_lease_key := 'user:' || candidate.user_id::text;
    provider_lease_key := 'provider:' || candidate.identity_key;
    user_lease_claimed := false;
    identity_lease_claimed := false;

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
      claimed_identities :=
        array_append(claimed_identities, candidate.identity_key);
      continue;
    end if;

    update public.catalog_enrichment_source_schedule schedule
       set lease_until =
             clock_timestamp() + make_interval(secs => lease_seconds),
           claim_token = token,
           last_claimed_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where schedule.source_id = candidate.source_id;

    source_id := candidate.source_id;
    user_id := candidate.user_id;
    claim_token := token;
    failure_count :=
      greatest(0, coalesce(candidate.consecutive_failures, 0));
    dispatch_count := greatest(0, coalesce(candidate.dispatch_count, 0));
    return next;

    claimed_users := array_append(claimed_users, candidate.user_id);
    claimed_identities :=
      array_append(claimed_identities, candidate.identity_key);
    claimed_count := claimed_count + 1;
    exit when claimed_count >= batch_limit;
  end loop;
end
$function$;

revoke all on function public.claim_catalog_enrichment_sources(
  integer, integer
) from public, anon, authenticated;
grant execute on function public.claim_catalog_enrichment_sources(
  integer, integer
) to service_role;

-- The expanded fleet has twelve lanes. Only lane 11 closes the sweep and
-- resets cycle_had_work; any work in lanes 0..10 makes the next cycle start
-- promptly. Advancing after failure keeps one broken series lane from pinning
-- movie probes or playback-safe maintenance.
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

  select
    mod(schedule.dispatch_count, 12),
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

  if current_lane = 11 and prior_cycle_had_work then
    delay_seconds := least(delay_seconds, 30);
  end if;

  update public.catalog_enrichment_source_schedule schedule
     set next_run_at =
           clock_timestamp() + make_interval(secs => delay_seconds),
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
         dispatch_count = schedule.dispatch_count + 1,
         cycle_had_work = case
           when current_lane = 11 then false
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

-- Conservative one-time backfill.
--
-- cloud_series_info_cache predates canonical provider identities and is keyed by
-- raw host.  A host hint alone is not cross-tenant proof, so a cached payload is
-- accepted only when all of these independent facts agree:
--   * the exact owned series variant exists on the source;
--   * the source has a server-written canonical identity link;
--   * the source's fingerprint is registered to that same identity;
--   * the parent series also exists in the identity-keyed global catalogue;
--   * the raw host cache row names that exact parent series id.
-- Anything ambiguous, malformed, unresolved, disabled, or deleted is skipped.
do $episode_backfill$
declare
  candidate record;
begin
  for candidate in
    select distinct
      variant.user_id,
      variant.source_id,
      variant.external_id as parent_series_id,
      series_cache.payload
    from public.cloud_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
     and title.item_type = variant.item_type
    join public.cloud_sources source
      on source.id = variant.source_id
     and source.user_id = variant.user_id
     and source.deleted_at is null
     and source.enabled = true
     and source.sync_status = 'ready'
    join public.catalog_source_provider_identities verified_identity
      on verified_identity.source_id = source.id
     and verified_identity.user_id = source.user_id
    join public.catalog_provider_identities fingerprint
      on fingerprint.provider_key = source.config_hint->>'providerKey'
     and fingerprint.identity_id = verified_identity.identity_id
    join public.catalog_media_items canonical_parent
      on canonical_parent.server_host = verified_identity.identity_id::text
     and canonical_parent.item_type = 'series'
     and canonical_parent.external_id = variant.external_id
    join public.cloud_series_info_cache series_cache
      on lower(series_cache.server_host) =
         lower(source.config_hint->>'serverHost')
     and series_cache.series_id = variant.external_id
    where variant.item_type = 'series'
      and variant.title_id is not null
      and coalesce(source.config_hint->>'providerKey', '') <> ''
      and coalesce(source.config_hint->>'serverHost', '') <> ''
      and jsonb_typeof(series_cache.payload) = 'object'
      and jsonb_typeof(series_cache.payload->'episodes') in ('object', 'array')
    order by
      variant.user_id,
      variant.source_id,
      variant.external_id
  loop
    begin
      perform public.register_catalog_series_episodes(
        candidate.user_id,
        candidate.source_id,
        candidate.parent_series_id,
        candidate.payload
      );
    exception
      when data_exception or integrity_constraint_violation then
        raise warning
          'Skipping unsafe episode membership backfill for source %, series %: %',
          candidate.source_id,
          candidate.parent_series_id,
          sqlerrm;
    end;
  end loop;
end
$episode_backfill$;

commit;
