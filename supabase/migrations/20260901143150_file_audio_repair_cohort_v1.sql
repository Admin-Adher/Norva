-- Durable, source-scoped repair cohort for the relay-empty false negatives
-- reset on 2026-08-31. Runtime selection never reuses the forensic timestamp:
-- it consumes only the immutable item manifest materialized below.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '15min';

create table if not exists public.catalog_file_audio_repair_cohorts (
  id uuid primary key default gen_random_uuid(),
  cohort_key text not null unique,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  provider_identity_id uuid not null,
  source_migration text not null,
  reason text not null,
  state text not null default 'active',
  seeded_count integer not null default 0,
  completed_count integer not null default 0,
  quarantined_count integer not null default 0,
  seed_manifest_sha256 text,
  seeded_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  state_reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint catalog_file_audio_repair_cohorts_key_ck
    check (btrim(cohort_key) <> ''),
  constraint catalog_file_audio_repair_cohorts_state_ck
    check (state in ('active', 'paused', 'completed', 'cancelled')),
  constraint catalog_file_audio_repair_cohorts_counts_ck
    check (
      seeded_count >= 0
      and completed_count >= 0
      and quarantined_count >= 0
      and completed_count + quarantined_count <= seeded_count
    ),
  constraint catalog_file_audio_repair_cohorts_manifest_ck
    check (seed_manifest_sha256 is null or seed_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  constraint catalog_file_audio_repair_cohorts_completion_ck
    check (
      (state = 'completed'
        and completed_at is not null
        and completed_count = seeded_count
        and quarantined_count = 0)
      or (state <> 'completed' and completed_at is null)
    ),
  constraint catalog_file_audio_repair_cohorts_coordinates_uk
    unique (id, user_id, source_id, generation_id, provider_identity_id),
  constraint catalog_file_audio_repair_cohorts_source_fk
    foreign key (user_id, source_id)
    references public.cloud_sources(user_id, id)
    on update cascade on delete cascade
);

create table if not exists public.catalog_file_audio_repair_items (
  cohort_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  provider_identity_id uuid not null,
  title_id uuid not null,
  variant_id uuid not null,
  file_external_id text not null,
  item_type text not null default 'movie',
  state text not null default 'pending',
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_attempt_started boolean not null default false,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  quarantined_at timestamptz,
  last_error text,
  seed_cache_updated_at timestamptz not null,
  seed_observation_updated_at timestamptz,
  exact_observed_at timestamptz,
  completion_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (cohort_id, user_id, variant_id, file_external_id),
  constraint catalog_file_audio_repair_items_cohort_coordinates_fk
    foreign key (
      cohort_id, user_id, source_id, generation_id, provider_identity_id
    ) references public.catalog_file_audio_repair_cohorts(
      id, user_id, source_id, generation_id, provider_identity_id
    ) on update cascade on delete cascade,
  constraint catalog_file_audio_repair_items_external_id_ck
    check (btrim(file_external_id) <> ''),
  constraint catalog_file_audio_repair_items_type_ck
    check (item_type = 'movie'),
  constraint catalog_file_audio_repair_items_state_ck
    check (state in ('pending', 'leased', 'completed', 'quarantined')),
  constraint catalog_file_audio_repair_items_attempt_count_ck
    check (attempt_count between 0 and 4),
  constraint catalog_file_audio_repair_items_attempt_shape_ck
    check (
      (state = 'pending'
        and lease_token is null
        and not lease_attempt_started
        and lease_until is null
        and quarantined_at is null)
      or (state = 'leased'
        and lease_token is not null
        and lease_until is not null
        and next_attempt_at is null
        and quarantined_at is null)
      or (state = 'completed'
        and lease_token is null
        and not lease_attempt_started
        and lease_until is null
        and next_attempt_at is null
        and quarantined_at is null)
      or (state = 'quarantined'
        and lease_token is null
        and not lease_attempt_started
        and lease_until is null
        and next_attempt_at is null
        and quarantined_at is not null)
    ),
  constraint catalog_file_audio_repair_items_started_attempt_ck
    check (not lease_attempt_started or (state = 'leased' and attempt_count > 0)),
  constraint catalog_file_audio_repair_items_completion_ck
    check (
      (state = 'completed'
        and exact_observed_at is not null
        and btrim(coalesce(completion_reason, '')) <> '')
      or (state <> 'completed'
        and exact_observed_at is null
        and completion_reason is null)
    )
);

alter table public.catalog_file_audio_repair_cohorts enable row level security;
alter table public.catalog_file_audio_repair_cohorts force row level security;
alter table public.catalog_file_audio_repair_items enable row level security;
alter table public.catalog_file_audio_repair_items force row level security;
revoke all on table public.catalog_file_audio_repair_cohorts
  from public, anon, authenticated, service_role;
revoke all on table public.catalog_file_audio_repair_items
  from public, anon, authenticated, service_role;

create unique index if not exists catalog_file_audio_repair_active_source_idx
  on public.catalog_file_audio_repair_cohorts(user_id, source_id)
  where state = 'active';
create index if not exists catalog_file_audio_repair_pending_source_idx
  on public.catalog_file_audio_repair_items(
    cohort_id, user_id, source_id, state, next_attempt_at,
    seed_cache_updated_at, variant_id
  ) where state in ('pending', 'leased');
create index if not exists catalog_file_audio_repair_trigger_idx
  on public.catalog_file_audio_repair_items(user_id, variant_id, file_external_id)
  where state in ('pending', 'leased');
create unique index if not exists catalog_file_audio_repair_lease_token_idx
  on public.catalog_file_audio_repair_items(lease_token)
  where lease_token is not null;

create or replace function public.catalog_file_audio_repair_manifest_sha256(
  p_cohort_id uuid
) returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select encode(extensions.digest(convert_to(string_agg(
    jsonb_build_object(
      'cohortKey', cohort.cohort_key,
      'userId', item.user_id,
      'sourceId', item.source_id,
      'generationId', item.generation_id,
      'providerIdentityId', item.provider_identity_id,
      'titleId', item.title_id,
      'variantId', item.variant_id,
      'fileExternalId', item.file_external_id,
      'itemType', item.item_type
    )::text,
    E'\n' order by
      item.user_id,
      item.source_id,
      item.generation_id,
      item.provider_identity_id,
      item.title_id,
      item.variant_id,
      item.file_external_id,
      item.item_type
  ), 'UTF8'), 'sha256'), 'hex')
  from public.catalog_file_audio_repair_cohorts cohort
  join public.catalog_file_audio_repair_items item
    on item.cohort_id = cohort.id
  where cohort.id = p_cohort_id
$function$;

revoke all on function public.catalog_file_audio_repair_manifest_sha256(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.norva_reconcile_catalog_file_audio_repair(
  p_cohort_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_seeded integer;
  v_completed integer;
  v_quarantined integer;
begin
  select
    count(*)::integer,
    count(*) filter (where item.state = 'completed')::integer,
    count(*) filter (where item.state = 'quarantined')::integer
  into v_seeded, v_completed, v_quarantined
  from public.catalog_file_audio_repair_items item
  where item.cohort_id = p_cohort_id;

  update public.catalog_file_audio_repair_cohorts cohort
     set seeded_count = v_seeded,
         completed_count = v_completed,
         quarantined_count = v_quarantined,
         state = case
           when cohort.state in ('cancelled', 'paused') then cohort.state
           when v_seeded > 0 and v_completed = v_seeded then 'completed'
           when v_seeded > 0
             and v_completed + v_quarantined = v_seeded
             and v_quarantined > 0 then 'paused'
           else 'active'
         end,
         completed_at = case
           when cohort.state not in ('cancelled', 'paused')
             and v_seeded > 0
             and v_completed = v_seeded then clock_timestamp()
           else null
         end,
         state_reason = case
           when cohort.state in ('cancelled', 'paused') then cohort.state_reason
           when v_seeded > 0
             and v_completed + v_quarantined = v_seeded
             and v_quarantined > 0 then 'repair-attempts-exhausted'
           else null
         end,
         updated_at = clock_timestamp()
   where cohort.id = p_cohort_id;
end
$function$;

revoke all on function public.norva_reconcile_catalog_file_audio_repair(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.norva_cancel_catalog_file_audio_repair_on_head_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled',
           completed_at = null,
           state_reason = 'active-generation-changed',
           updated_at = clock_timestamp()
     where cohort.user_id = old.user_id
       and cohort.source_id = old.source_id
       and cohort.generation_id = old.active_generation_id
       and cohort.state = 'active';
    return old;
  end if;
  if new.active_generation_id is distinct from old.active_generation_id then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled',
           completed_at = null,
           state_reason = 'active-generation-changed',
           updated_at = clock_timestamp()
     where cohort.user_id = old.user_id
       and cohort.source_id = old.source_id
       and cohort.generation_id = old.active_generation_id
       and cohort.state = 'active';
  end if;
  return new;
end
$function$;

revoke all on function public.norva_cancel_catalog_file_audio_repair_on_head_change()
  from public, anon, authenticated, service_role;

create or replace function public.norva_cancel_catalog_file_audio_repair_on_identity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled',
           completed_at = null,
           state_reason = 'provider-identity-changed',
           updated_at = clock_timestamp()
     where cohort.user_id = old.user_id
       and cohort.source_id = old.source_id
       and cohort.provider_identity_id = old.identity_id
       and cohort.state = 'active';
    return old;
  end if;
  if new.identity_id is distinct from old.identity_id
     or new.user_id is distinct from old.user_id
     or new.source_id is distinct from old.source_id
     or new.verified_at is null then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled',
           completed_at = null,
           state_reason = 'provider-identity-changed',
           updated_at = clock_timestamp()
     where cohort.user_id = old.user_id
       and cohort.source_id = old.source_id
       and cohort.provider_identity_id = old.identity_id
       and cohort.state = 'active';
  end if;
  return new;
end
$function$;

revoke all on function public.norva_cancel_catalog_file_audio_repair_on_identity_change()
  from public, anon, authenticated, service_role;

create or replace function public.norva_cancel_catalog_file_audio_repair_on_source_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled',
           completed_at = null,
           state_reason = 'source-deleted',
           updated_at = clock_timestamp()
     where cohort.user_id = old.user_id
       and cohort.source_id = old.id
       and cohort.state = 'active';
  end if;
  return new;
end
$function$;

revoke all on function public.norva_cancel_catalog_file_audio_repair_on_source_delete()
  from public, anon, authenticated, service_role;

-- This immutable source coordinate identifies the historical KING365 repair,
-- not a mutable display name. The head and verified identity are captured once
-- and become part of every runtime fence.
insert into public.catalog_file_audio_repair_cohorts (
  cohort_key,
  user_id,
  source_id,
  generation_id,
  provider_identity_id,
  source_migration,
  reason
)
select
  'vod-audio-relay-empty-reset-20260831-king365-v1',
  source.user_id,
  source.id,
  head.active_generation_id,
  identity.identity_id,
  '20260831134040_vod_audio_probe_persistence_repair_v1.sql',
  'relay-empty-success-false-negative'
from public.cloud_sources source
join public.cloud_source_catalog_heads head
  on head.source_id = source.id
 and head.user_id = source.user_id
join public.catalog_source_provider_identities identity
  on identity.source_id = source.id
 and identity.user_id = source.user_id
where source.id = '4e3d7dd8-9123-4bd6-9a02-36cc92e40a33'::uuid
  and source.deleted_at is null
  and head.active_generation_id is not null
  and identity.verified_at is not null
on conflict (cohort_key) do nothing;

-- The forensic bounds contain 6,441 canonical cache rows. Binding them to the
-- exact active variant/head excludes three orphan cache entries and yields the
-- immutable 6,438-item manifest. Three observations have already recovered;
-- seed them as completed without confusing raw exact probing with strict LID.
insert into public.catalog_file_audio_repair_items (
  cohort_id,
  user_id,
  source_id,
  generation_id,
  provider_identity_id,
  title_id,
  variant_id,
  file_external_id,
  item_type,
  state,
  next_attempt_at,
  seed_cache_updated_at,
  seed_observation_updated_at,
  exact_observed_at,
  completion_reason
)
select distinct
  cohort.id,
  variant.user_id,
  variant.source_id,
  variant.generation_id,
  cohort.provider_identity_id,
  variant.title_id,
  variant.id,
  variant.external_id,
  'movie',
  case when coalesce(observation.audio_observed, false)
    then 'completed' else 'pending' end,
  case when coalesce(observation.audio_observed, false)
    then null else clock_timestamp() end,
  cache.updated_at,
  observation.updated_at,
  case when coalesce(observation.audio_observed, false)
    then observation.updated_at else null end,
  case when coalesce(observation.audio_observed, false)
    then 'audio-observed-before-cohort' else null end
from public.catalog_file_audio_repair_cohorts cohort
join public.cloud_title_variants variant
  on variant.user_id = cohort.user_id
 and variant.source_id = cohort.source_id
 and variant.generation_id = cohort.generation_id
 and variant.item_type = 'movie'
left join public.catalog_source_provider_identities identity
  on identity.source_id = variant.source_id
 and identity.user_id = variant.user_id
 and identity.identity_id = cohort.provider_identity_id
 and identity.verified_at is not null
join public.catalog_file_tracks cache
  on cache.server_host = identity.identity_id::text
 and cache.item_type = variant.item_type
 and cache.external_id = variant.external_id
left join public.cloud_title_file_language_observations observation
  on observation.user_id = variant.user_id
 and observation.variant_id = variant.id
 and observation.file_external_id = variant.external_id
where cohort.cohort_key = 'vod-audio-relay-empty-reset-20260831-king365-v1'
  and variant.title_id is not null
  and btrim(variant.external_id) <> ''
  and cache.audio_probed_at is null
  and cache.audio_tracks = '[]'::jsonb
  and cache.updated_at between
    '2026-08-31 15:26:18.219296+00'::timestamptz
    and '2026-08-31 15:26:18.615691+00'::timestamptz
on conflict (cohort_id, user_id, variant_id, file_external_id) do nothing;

create or replace function public.catalog_file_audio_repair_pending(
  p_user uuid,
  p_source uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.catalog_file_audio_repair_cohorts cohort
    join public.catalog_file_audio_repair_items item
      on item.cohort_id = cohort.id
     and item.user_id = cohort.user_id
     and item.source_id = cohort.source_id
     and item.generation_id = cohort.generation_id
     and item.provider_identity_id = cohort.provider_identity_id
    join public.cloud_catalog_visible_title_variants variant
      on variant.user_id = item.user_id
     and variant.source_id = item.source_id
     and variant.generation_id = item.generation_id
     and variant.title_id = item.title_id
     and variant.id = item.variant_id
     and variant.item_type = item.item_type
     and variant.external_id = item.file_external_id
    join public.catalog_source_provider_identities identity
      on identity.source_id = item.source_id
     and identity.user_id = item.user_id
     and identity.identity_id = item.provider_identity_id
     and identity.verified_at is not null
    left join public.cloud_title_file_language_observations observation
      on observation.user_id = item.user_id
     and observation.variant_id = item.variant_id
     and observation.file_external_id = item.file_external_id
    where cohort.user_id = p_user
      and cohort.source_id = p_source
      and cohort.state = 'active'
      and item.state in ('pending', 'leased')
      and not coalesce(observation.audio_observed, false)
  )
$function$;

revoke all on function public.catalog_file_audio_repair_pending(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.catalog_file_audio_repair_pending(uuid, uuid)
  to service_role;

create or replace function public.catalog_file_audio_repair_candidates(
  p_user uuid,
  p_source uuid,
  p_limit integer default 4
) returns table(
  id uuid,
  default_variant_id uuid,
  provider_tmdb_id text,
  repair_lease_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cohort_id uuid;
  v_generation_id uuid;
  v_provider_identity_id uuid;
  v_now timestamptz := clock_timestamp();
  v_limit integer := greatest(1, least(4, coalesce(p_limit, 4)));
begin
  if p_user is null or p_source is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-repair:' || p_user::text || ':' || p_source::text,
    0
  ));

  select cohort.id, cohort.generation_id, cohort.provider_identity_id
    into v_cohort_id, v_generation_id, v_provider_identity_id
  from public.catalog_file_audio_repair_cohorts cohort
  where cohort.user_id = p_user
    and cohort.source_id = p_source
    and cohort.state = 'active';
  if not found then
    return;
  end if;

  -- Lock lifecycle parents before the cohort header. Their update/delete
  -- triggers use the same parent -> header order, avoiding a header/item or
  -- head/header deadlock while keeping the runtime coordinates immutable.
  perform 1
  from public.cloud_sources source
  where source.user_id = p_user
    and source.id = p_source
    and source.deleted_at is null
  for share;
  if not found then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled', completed_at = null,
           state_reason = 'runtime-source-drift', updated_at = v_now
     where cohort.id = v_cohort_id and cohort.state = 'active';
    return;
  end if;

  perform 1
  from public.cloud_source_catalog_heads head
  where head.user_id = p_user
    and head.source_id = p_source
    and head.active_generation_id = v_generation_id
  for share;
  if not found then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled',
           completed_at = null,
           state_reason = 'runtime-generation-drift',
           updated_at = v_now
     where cohort.id = v_cohort_id
       and cohort.state = 'active';
    return;
  end if;

  perform 1
  from public.catalog_source_provider_identities identity
  where identity.user_id = p_user
    and identity.source_id = p_source
    and identity.identity_id = v_provider_identity_id
    and identity.verified_at is not null
  for share;
  if not found then
    update public.catalog_file_audio_repair_cohorts cohort
       set state = 'cancelled', completed_at = null,
           state_reason = 'runtime-provider-identity-drift', updated_at = v_now
     where cohort.id = v_cohort_id and cohort.state = 'active';
    return;
  end if;

  perform 1
  from public.catalog_file_audio_repair_cohorts cohort
  where cohort.id = v_cohort_id
    and cohort.user_id = p_user
    and cohort.source_id = p_source
    and cohort.generation_id = v_generation_id
    and cohort.provider_identity_id = v_provider_identity_id
    and cohort.state = 'active'
  for update;
  if not found then
    return;
  end if;

  update public.catalog_file_audio_repair_items item
     set state = 'completed',
         lease_token = null,
         lease_attempt_started = false,
         lease_until = null,
         next_attempt_at = null,
         exact_observed_at = coalesce(observation.updated_at, v_now),
         completion_reason = 'audio-observed-reconciled',
         last_error = null,
         updated_at = v_now
    from public.cloud_title_file_language_observations observation
   where item.cohort_id = v_cohort_id
     and item.state in ('pending', 'leased')
     and observation.user_id = item.user_id
     and observation.title_id = item.title_id
     and observation.variant_id = item.variant_id
     and observation.file_external_id = item.file_external_id
     and observation.audio_observed is true;

  -- Selection is not provider I/O. An expired unstarted claim therefore
  -- returns to pending without consuming budget; only an exact-token claim
  -- marked started by the provider-I/O caller can back off or quarantine.
  update public.catalog_file_audio_repair_items item
     set state = case
           when item.lease_attempt_started and item.attempt_count >= 4
             then 'quarantined'
           else 'pending'
         end,
         lease_token = null,
         lease_attempt_started = false,
         lease_until = null,
         next_attempt_at = case
           when item.lease_attempt_started and item.attempt_count >= 4 then null
           when not item.lease_attempt_started then v_now
           when item.attempt_count = 1 then v_now + interval '1 minute'
           when item.attempt_count = 2 then v_now + interval '5 minutes'
           else v_now + interval '15 minutes'
         end,
         quarantined_at = case
           when item.lease_attempt_started and item.attempt_count >= 4
           then v_now else null end,
         last_error = case when item.lease_attempt_started
           then 'lease-expired-after-provider-attempt'
           else 'lease-expired-before-provider-io'
         end,
         updated_at = v_now
   where item.cohort_id = v_cohort_id
     and item.state = 'leased'
     and item.lease_until <= v_now;

  update public.catalog_file_audio_repair_items item
     set state = 'quarantined',
         lease_token = null,
         lease_attempt_started = false,
         lease_until = null,
         next_attempt_at = null,
         quarantined_at = coalesce(item.quarantined_at, v_now),
         last_error = coalesce(item.last_error, 'attempt-budget-exhausted'),
         updated_at = v_now
   where item.cohort_id = v_cohort_id
     and item.state = 'pending'
     and item.attempt_count >= 4;

  perform public.norva_reconcile_catalog_file_audio_repair(v_cohort_id);
  if not exists (
    select 1
    from public.catalog_file_audio_repair_cohorts cohort
    where cohort.id = v_cohort_id
      and cohort.state = 'active'
  ) then
    return;
  end if;

  return query
  with selected as (
    select item.cohort_id, item.user_id, item.variant_id,
      item.file_external_id
    from public.catalog_file_audio_repair_items item
    where item.cohort_id = v_cohort_id
      and item.state = 'pending'
      and item.attempt_count < 4
      and coalesce(item.next_attempt_at, '-infinity'::timestamptz) <= v_now
      and not exists (
        select 1
        from public.cloud_title_file_language_observations observation
        where observation.user_id = item.user_id
          and observation.variant_id = item.variant_id
          and observation.file_external_id = item.file_external_id
          and observation.audio_observed is true
      )
      and exists (
        select 1
        from public.cloud_catalog_visible_title_variants variant
        join public.catalog_source_provider_identities identity
          on identity.user_id = variant.user_id
         and identity.source_id = variant.source_id
         and identity.identity_id = item.provider_identity_id
         and identity.verified_at is not null
        where variant.user_id = item.user_id
          and variant.source_id = item.source_id
          and variant.generation_id = item.generation_id
          and variant.title_id = item.title_id
          and variant.id = item.variant_id
          and variant.item_type = item.item_type
          and variant.external_id = item.file_external_id
      )
    order by
      case when exists (
        select 1
        from public.cloud_titles title
        where title.user_id = item.user_id
          and title.id = item.title_id
          and title.item_type = item.item_type
          and title.version_languages @> array['multi']::text[]
      ) then 0 else 1 end,
      item.next_attempt_at nulls first,
      item.seed_cache_updated_at,
      item.title_id,
      item.variant_id
    for update of item skip locked
    limit v_limit
  ), claimed as (
    update public.catalog_file_audio_repair_items item
       set state = 'leased',
           lease_token = gen_random_uuid(),
           lease_attempt_started = false,
           lease_until = v_now + interval '10 minutes',
           next_attempt_at = null,
           last_error = null,
           updated_at = v_now
      from selected
     where item.cohort_id = selected.cohort_id
       and item.user_id = selected.user_id
       and item.variant_id = selected.variant_id
       and item.file_external_id = selected.file_external_id
      returning item.user_id, item.title_id, item.variant_id,
        item.item_type, item.seed_cache_updated_at, item.lease_token
  )
  select title.id, claimed.variant_id, title.provider_tmdb_id,
    claimed.lease_token
  from claimed
  join public.cloud_titles title
    on title.user_id = claimed.user_id
   and title.id = claimed.title_id
   and title.item_type = claimed.item_type
  order by claimed.seed_cache_updated_at, title.id, claimed.variant_id;
end
$function$;

revoke all on function public.catalog_file_audio_repair_candidates(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.catalog_file_audio_repair_candidates(uuid, uuid, integer)
  to service_role;

-- A candidate claim reserves manifest order only. The caller must present the
-- exact opaque token immediately before its first provider byte is requested;
-- only this transition consumes one bounded repair attempt.
create or replace function public.norva_start_catalog_file_audio_repair_attempt(
  p_user uuid,
  p_source uuid,
  p_variant uuid,
  p_lease_token uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cohort_id uuid;
  v_generation_id uuid;
  v_provider_identity_id uuid;
  v_now timestamptz := clock_timestamp();
  v_started boolean := false;
begin
  if p_user is null or p_source is null or p_variant is null
     or p_lease_token is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-repair:' || p_user::text || ':' || p_source::text,
    0
  ));

  select cohort.id, cohort.generation_id, cohort.provider_identity_id
    into v_cohort_id, v_generation_id, v_provider_identity_id
  from public.catalog_file_audio_repair_cohorts cohort
  where cohort.user_id = p_user
    and cohort.source_id = p_source
    and cohort.state = 'active';
  if not found then
    return false;
  end if;

  -- Revalidate the same tenant/source/head/provider fences as selection while
  -- taking locks in the established lifecycle-parent -> cohort -> item order.
  perform 1
  from public.cloud_sources source
  where source.user_id = p_user
    and source.id = p_source
    and source.enabled
    and source.deleted_at is null
    and source.sync_status = 'ready'
  for share;
  if not found then
    return false;
  end if;

  perform 1
  from public.cloud_source_catalog_heads head
  where head.user_id = p_user
    and head.source_id = p_source
    and head.active_generation_id = v_generation_id
  for share;
  if not found then
    return false;
  end if;

  perform 1
  from public.catalog_source_provider_identities identity
  where identity.user_id = p_user
    and identity.source_id = p_source
    and identity.identity_id = v_provider_identity_id
    and identity.verified_at is not null
  for share;
  if not found then
    return false;
  end if;

  perform 1
  from public.catalog_file_audio_repair_cohorts cohort
  where cohort.id = v_cohort_id
    and cohort.user_id = p_user
    and cohort.source_id = p_source
    and cohort.generation_id = v_generation_id
    and cohort.provider_identity_id = v_provider_identity_id
    and cohort.state = 'active'
  for update;
  if not found then
    return false;
  end if;

  update public.catalog_file_audio_repair_items item
     set attempt_count = item.attempt_count + 1,
         lease_attempt_started = true,
         lease_until = v_now + interval '10 minutes',
         last_attempt_at = v_now,
         last_error = null,
         updated_at = v_now
   where item.cohort_id = v_cohort_id
     and item.user_id = p_user
     and item.source_id = p_source
     and item.generation_id = v_generation_id
     and item.provider_identity_id = v_provider_identity_id
     and item.variant_id = p_variant
     and item.state = 'leased'
     and item.lease_token = p_lease_token
     and not item.lease_attempt_started
     and item.lease_until > v_now
     and item.attempt_count < 4
     and exists (
       select 1
       from public.cloud_catalog_visible_title_variants variant
       where variant.user_id = item.user_id
         and variant.source_id = item.source_id
         and variant.generation_id = item.generation_id
         and variant.title_id = item.title_id
         and variant.id = item.variant_id
         and variant.item_type = item.item_type
         and variant.external_id = item.file_external_id
     )
  returning true into v_started;

  return coalesce(v_started, false);
end
$function$;

revoke all on function public.norva_start_catalog_file_audio_repair_attempt(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.norva_start_catalog_file_audio_repair_attempt(
  uuid, uuid, uuid, uuid
) to service_role;

-- If a bounded caller cannot use a selected candidate, release only its exact
-- unstarted token. This never rewinds a real provider attempt or its history.
create or replace function public.norva_defer_catalog_file_audio_repair_candidate(
  p_user uuid,
  p_source uuid,
  p_variant uuid,
  p_lease_token uuid,
  p_reason text,
  p_retry_seconds integer default 30
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cohort_id uuid;
  v_now timestamptz := clock_timestamp();
  v_deferred boolean := false;
begin
  if p_user is null or p_source is null or p_variant is null
     or p_lease_token is null
     or p_retry_seconds is null
     or p_retry_seconds not between 1 and 900 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-repair:' || p_user::text || ':' || p_source::text,
    0
  ));

  -- Lock the lifecycle parent first even for a cancelled cohort: defer is a
  -- release operation and must be able to clear its exact stale reservation.
  perform 1
  from public.cloud_sources source
  where source.user_id = p_user
    and source.id = p_source
  for share;
  if not found then
    return false;
  end if;

  select cohort.id into v_cohort_id
  from public.catalog_file_audio_repair_cohorts cohort
  join public.catalog_file_audio_repair_items item
    on item.cohort_id = cohort.id
   and item.user_id = cohort.user_id
   and item.source_id = cohort.source_id
  where cohort.user_id = p_user
    and cohort.source_id = p_source
    and item.variant_id = p_variant
    and item.state = 'leased'
    and item.lease_token = p_lease_token
  for update of cohort;
  if not found then
    return false;
  end if;

  update public.catalog_file_audio_repair_items item
     set state = 'pending',
         lease_token = null,
         lease_attempt_started = false,
         lease_until = null,
         next_attempt_at = v_now + make_interval(secs => p_retry_seconds),
         last_error = left(coalesce(
           nullif(btrim(p_reason), ''),
           'candidate-deferred-before-provider-io'
         ), 160),
         updated_at = v_now
   where item.cohort_id = v_cohort_id
     and item.user_id = p_user
     and item.source_id = p_source
     and item.variant_id = p_variant
     and item.state = 'leased'
     and item.lease_token = p_lease_token
     and not item.lease_attempt_started
  returning true into v_deferred;

  return coalesce(v_deferred, false);
end
$function$;

revoke all on function public.norva_defer_catalog_file_audio_repair_candidate(
  uuid, uuid, uuid, uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.norva_defer_catalog_file_audio_repair_candidate(
  uuid, uuid, uuid, uuid, text, integer
) to service_role;

create or replace function public.norva_complete_catalog_file_audio_repair()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_cohort_id uuid;
  v_source_id uuid;
begin
  if new.audio_observed is true then
    select item.cohort_id, item.source_id
      into v_cohort_id, v_source_id
    from public.catalog_file_audio_repair_items item
    join public.catalog_file_audio_repair_cohorts cohort
      on cohort.id = item.cohort_id
     and cohort.state = 'active'
    where item.user_id = new.user_id
      and item.title_id = new.title_id
      and item.variant_id = new.variant_id
      and item.file_external_id = new.file_external_id
      and item.state in ('pending', 'leased');
    if not found then
      return new;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      'catalog-file-audio-repair:' || new.user_id::text || ':' || v_source_id::text,
      0
    ));
    perform 1
    from public.catalog_file_audio_repair_cohorts cohort
    where cohort.id = v_cohort_id
      and cohort.state = 'active'
    for update;
    if not found then
      return new;
    end if;

    update public.catalog_file_audio_repair_items item
       set state = 'completed',
           lease_token = null,
           lease_attempt_started = false,
           lease_until = null,
           next_attempt_at = null,
           exact_observed_at = coalesce(new.updated_at, clock_timestamp()),
           completion_reason = 'audio-observed',
           last_error = null,
           updated_at = clock_timestamp()
      from public.catalog_file_audio_repair_cohorts cohort
     where item.user_id = new.user_id
       and item.title_id = new.title_id
       and item.variant_id = new.variant_id
       and item.file_external_id = new.file_external_id
       and item.state in ('pending', 'leased')
       and cohort.id = item.cohort_id
       and cohort.id = v_cohort_id
       and cohort.state = 'active'
     returning item.cohort_id into v_cohort_id;

    if v_cohort_id is not null then
      perform public.norva_reconcile_catalog_file_audio_repair(v_cohort_id);
    end if;
  end if;
  return new;
end
$function$;

revoke all on function public.norva_complete_catalog_file_audio_repair()
  from public, anon, authenticated, service_role;

-- The expensive immutable seed is complete before any hot lifecycle table is
-- locked. Installing these triggers takes transaction-scoped table locks only
-- for the short final reconciliation/hash window. A write committed during the
-- seed is included below; a later write waits and observes the triggers after
-- this transaction commits.
drop trigger if exists trg_cancel_file_audio_repair_on_source_delete
  on public.cloud_sources;
create trigger trg_cancel_file_audio_repair_on_source_delete
after update of deleted_at on public.cloud_sources
for each row execute function public.norva_cancel_catalog_file_audio_repair_on_source_delete();

drop trigger if exists trg_cancel_file_audio_repair_on_head_update
  on public.cloud_source_catalog_heads;
create trigger trg_cancel_file_audio_repair_on_head_update
after update of active_generation_id on public.cloud_source_catalog_heads
for each row execute function public.norva_cancel_catalog_file_audio_repair_on_head_change();

drop trigger if exists trg_cancel_file_audio_repair_on_head_delete
  on public.cloud_source_catalog_heads;
create trigger trg_cancel_file_audio_repair_on_head_delete
after delete on public.cloud_source_catalog_heads
for each row execute function public.norva_cancel_catalog_file_audio_repair_on_head_change();

drop trigger if exists trg_cancel_file_audio_repair_on_identity_update
  on public.catalog_source_provider_identities;
create trigger trg_cancel_file_audio_repair_on_identity_update
after update of identity_id, user_id, source_id, verified_at
on public.catalog_source_provider_identities
for each row execute function public.norva_cancel_catalog_file_audio_repair_on_identity_change();

drop trigger if exists trg_cancel_file_audio_repair_on_identity_delete
  on public.catalog_source_provider_identities;
create trigger trg_cancel_file_audio_repair_on_identity_delete
after delete on public.catalog_source_provider_identities
for each row execute function public.norva_cancel_catalog_file_audio_repair_on_identity_change();

-- Reads remain available. Exact-observation writers now wait only for the
-- bounded trigger installation, reconciliation and manifest assertions.
lock table public.cloud_title_file_language_observations
  in share row exclusive mode;

drop trigger if exists trg_complete_catalog_file_audio_repair
  on public.cloud_title_file_language_observations;
create trigger trg_complete_catalog_file_audio_repair
after insert or update of audio_observed
on public.cloud_title_file_language_observations
for each row
when (new.audio_observed is true)
execute function public.norva_complete_catalog_file_audio_repair();

-- Final reconciliation is deliberately after trigger installation while the
-- observation table remains write-locked. No exact observation can fall into
-- a seed/trigger gap.
do $reconcile_manifest$
declare
  v_cohort_id uuid;
  v_seeded integer;
  v_completed integer;
  v_quarantined integer;
  v_manifest text;
  v_recomputed text;
begin
  select cohort.id into v_cohort_id
  from public.catalog_file_audio_repair_cohorts cohort
  where cohort.cohort_key = 'vod-audio-relay-empty-reset-20260831-king365-v1';

  -- A genuinely empty/fresh database has no production source coordinate and
  -- therefore no production cohort to seal.  Once either coordinate exists,
  -- however, absence/deletion/head drift is a hard failure.  In particular, a
  -- source soft-deleted while the expensive seed is running cannot turn this
  -- targeted migration into a silent no-op.
  if v_cohort_id is null then
    if exists (
      select 1 from public.cloud_sources source
      where source.id = '4e3d7dd8-9123-4bd6-9a02-36cc92e40a33'::uuid
    ) then
      raise exception 'KING365 repair cohort was not seeded with active verified coordinates'
        using errcode = '55000';
    end if;
    return;
  end if;

  perform 1
  from public.cloud_sources source
  where source.id = '4e3d7dd8-9123-4bd6-9a02-36cc92e40a33'::uuid
    and source.user_id = '7bdab1df-80e6-46f9-bcdf-84b6595819a8'::uuid
    and source.deleted_at is null;
  if not found then
    raise exception 'KING365 source disappeared or was deleted during repair seed'
      using errcode = '55000';
  end if;

    -- The lifecycle tables are already locked by the trigger DDL above. Abort
    -- atomically if any source/head/identity coordinate drifted while the large
    -- seed ran, rather than committing a cohort for a superseded catalogue.
    perform 1
    from public.catalog_file_audio_repair_cohorts cohort
    join public.cloud_sources source
      on source.user_id = cohort.user_id
     and source.id = cohort.source_id
     and source.deleted_at is null
    join public.cloud_source_catalog_heads head
      on head.user_id = cohort.user_id
     and head.source_id = cohort.source_id
     and head.active_generation_id = cohort.generation_id
    join public.catalog_source_provider_identities identity
      on identity.user_id = cohort.user_id
     and identity.source_id = cohort.source_id
     and identity.identity_id = cohort.provider_identity_id
     and identity.verified_at is not null
    where cohort.id = v_cohort_id;
    if not found then
      raise exception 'KING365 repair lifecycle coordinates changed during seed'
        using errcode = '55000';
    end if;

    update public.catalog_file_audio_repair_items item
       set state = 'completed',
           lease_token = null,
           lease_attempt_started = false,
           lease_until = null,
           next_attempt_at = null,
           exact_observed_at = coalesce(observation.updated_at, clock_timestamp()),
           completion_reason = 'audio-observed-seed-reconciled',
           last_error = null,
           updated_at = clock_timestamp()
      from public.cloud_title_file_language_observations observation
     where item.cohort_id = v_cohort_id
       and item.state in ('pending', 'leased')
       and observation.user_id = item.user_id
       and observation.title_id = item.title_id
       and observation.variant_id = item.variant_id
       and observation.file_external_id = item.file_external_id
       and observation.audio_observed is true;

    perform public.norva_reconcile_catalog_file_audio_repair(v_cohort_id);
    v_recomputed := public.catalog_file_audio_repair_manifest_sha256(v_cohort_id);
    update public.catalog_file_audio_repair_cohorts cohort
       set seed_manifest_sha256 = v_recomputed,
           updated_at = clock_timestamp()
     where cohort.id = v_cohort_id;

    select cohort.seeded_count, cohort.completed_count,
           cohort.quarantined_count, cohort.seed_manifest_sha256
      into v_seeded, v_completed, v_quarantined, v_manifest
    from public.catalog_file_audio_repair_cohorts cohort
    where cohort.id = v_cohort_id;

    if v_seeded is distinct from 6438 then
      raise exception 'KING365 repair manifest drift: expected 6438, got %', v_seeded
        using errcode = '55000';
    end if;
    if v_completed < 3 or v_completed > v_seeded then
      raise exception 'KING365 repair completion drift: expected at least 3, got %', v_completed
        using errcode = '55000';
    end if;
    if v_quarantined is distinct from 0 then
      raise exception 'KING365 repair seed unexpectedly contains quarantined items: %',
        v_quarantined using errcode = '55000';
    end if;
    if v_manifest is distinct from
       'c80062d545b6fcb62bf5c35fd4b76c991626829a3f26550a5e0fbe8fe5d8acec' then
      raise exception 'KING365 repair manifest hash drift: expected %, got %',
        'c80062d545b6fcb62bf5c35fd4b76c991626829a3f26550a5e0fbe8fe5d8acec',
        v_manifest using errcode = '55000';
    end if;
    if public.catalog_file_audio_repair_manifest_sha256(v_cohort_id)
         is distinct from v_manifest then
      raise exception 'KING365 repair stored manifest hash is not coherent'
        using errcode = '55000';
    end if;
end
$reconcile_manifest$;

comment on table public.catalog_file_audio_repair_cohorts is
  'Service-owned audit manifests for bounded exact-audio repair cohorts.';
comment on table public.catalog_file_audio_repair_items is
  'Immutable tenant/source/generation coordinates consumed only by the established sequential provider/file lease path.';

notify pgrst, 'reload schema';

commit;
