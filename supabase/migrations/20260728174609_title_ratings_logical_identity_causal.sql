-- EXPAND phase for logical-title reactions.
--
-- Deployment order:
--   1. Apply this migration while the legacy Edge function is still live.
--   2. Deploy the dual-read/CAS Edge function.
--   3. Upgrade clients to send expectedRevision + operationId.
--   4. Observe cloud_title_ratings_expand_audit().
--   5. Only create a later CONTRACT migration when unresolved_rows = 0 and
--      compatibility_writes_30d = 0.
--
-- This migration deliberately keeps source_id, item_id and the original
-- provider-scoped UNIQUE constraint. It never deletes legacy data.

begin;

alter table public.cloud_title_ratings
  add column if not exists title_id uuid,
  add column if not exists server_revision bigint not null default 0,
  add column if not exists last_operation_id uuid;

-- Re-entrant exact-alias backfill. Rows without a materialized projection stay
-- untouched and remain visible in the audit function below.
update public.cloud_title_ratings as reaction
set title_id = variant.title_id
from public.cloud_title_variants as variant
where reaction.title_id is null
  and variant.user_id = reaction.user_id
  and variant.source_id::text = reaction.source_id
  and variant.item_type = reaction.item_type
  and variant.external_id = reaction.item_id;

-- Composite ownership keys let the EXPAND foreign keys enforce that a profile
-- and a logical title belong to the same account as the reaction. They are
-- non-destructive because id is already unique on both parent tables.
create unique index if not exists uidx_cloud_account_profiles_id_user_expand
  on public.cloud_account_profiles (id, user_id);

create unique index if not exists uidx_cloud_titles_id_user_type_expand
  on public.cloud_titles (id, user_id, item_type);

create unique index if not exists uidx_cloud_sources_id_user_expand
  on public.cloud_sources (id, user_id);

-- Existing rows are intentionally not rejected during EXPAND. NOT VALID checks
-- protect every new/changed row and can be validated in the later CONTRACT phase
-- after the counters prove the legacy backlog is empty.
alter table public.cloud_title_ratings
  add constraint cloud_title_ratings_rating_expand_check
    check (rating in (-1, 0, 1)) not valid,
  add constraint cloud_title_ratings_item_type_expand_check
    check (item_type in ('movie', 'series')) not valid,
  add constraint cloud_title_ratings_server_revision_check
    check (server_revision >= 0) not valid,
  add constraint cloud_title_ratings_user_expand_fk
    foreign key (user_id)
    references auth.users(id)
    on delete cascade
    not valid,
  add constraint cloud_title_ratings_profile_expand_fk
    foreign key (profile_id, user_id)
    references public.cloud_account_profiles(id, user_id)
    on delete cascade
    not valid,
  add constraint cloud_title_ratings_title_expand_fk
    foreign key (title_id, user_id, item_type)
    references public.cloud_titles(id, user_id, item_type)
    on delete cascade
    not valid;

create index if not exists idx_cloud_title_ratings_profile_title_expand
  on public.cloud_title_ratings (profile_id, title_id, server_revision desc)
  where title_id is not null;

create index if not exists idx_cloud_title_ratings_last_operation_expand
  on public.cloud_title_ratings (last_operation_id)
  where last_operation_id is not null;

-- A persistent operation ledger makes operationId idempotent even after a newer
-- reaction supersedes it. Keeping only last_operation_id on the reaction rows
-- would not be enough for a late retry of an older request.
create table if not exists public.cloud_title_rating_operations (
  operation_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null,
  title_id uuid not null,
  source_id uuid not null,
  item_type text not null check (item_type in ('movie', 'series')),
  item_id text not null,
  requested_rating smallint not null check (requested_rating in (-1, 0, 1)),
  expected_revision bigint,
  result_rating smallint not null check (result_rating in (-1, 0, 1)),
  result_revision bigint not null check (result_revision >= 0),
  applied boolean not null,
  conflict boolean not null,
  compatibility_mode boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (profile_id, user_id)
    references public.cloud_account_profiles(id, user_id)
    on delete cascade,
  foreign key (title_id, user_id, item_type)
    references public.cloud_titles(id, user_id, item_type)
    on delete cascade,
  foreign key (source_id, user_id)
    references public.cloud_sources(id, user_id)
    on delete cascade
);

create index if not exists idx_cloud_title_rating_operations_profile_created
  on public.cloud_title_rating_operations (profile_id, created_at desc);

create index if not exists idx_cloud_title_rating_operations_compat_created
  on public.cloud_title_rating_operations (created_at desc)
  where compatibility_mode;

alter table public.cloud_title_rating_operations enable row level security;
revoke all on table public.cloud_title_rating_operations from anon, authenticated;
grant select, insert, update, delete
  on table public.cloud_title_rating_operations
  to service_role;

-- Read-only rollout gate. No row contents or account identifiers are returned.
create or replace function public.cloud_title_ratings_expand_audit()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with reaction_counts as (
    select
      count(*)::bigint as total_rows,
      count(*) filter (where reaction.title_id is not null)::bigint as resolved_rows,
      count(*) filter (where reaction.title_id is null)::bigint as unresolved_rows,
      count(*) filter (
        where not exists (
          select 1 from auth.users as account
          where account.id = reaction.user_id
        )
      )::bigint as orphan_user_rows,
      count(*) filter (
        where reaction.profile_id is null
           or not exists (
                select 1
                from public.cloud_account_profiles as profile
                where profile.id = reaction.profile_id
                  and profile.user_id = reaction.user_id
              )
      )::bigint as orphan_profile_rows,
      count(*) filter (
        where not exists (
          select 1
          from public.cloud_sources as source
          where source.id::text = reaction.source_id
            and source.user_id = reaction.user_id
          )
      )::bigint as orphan_source_rows,
      count(*) filter (
        where reaction.title_id is not null
          and not exists (
            select 1
            from public.cloud_titles as title
            where title.id = reaction.title_id
              and title.user_id = reaction.user_id
              and title.item_type = reaction.item_type
          )
      )::bigint as orphan_title_rows,
      count(*) filter (
        where reaction.title_id is null
          and exists (
            select 1
            from public.cloud_title_variants as variant
            where variant.user_id = reaction.user_id
              and variant.source_id::text = reaction.source_id
              and variant.item_type = reaction.item_type
              and variant.external_id = reaction.item_id
          )
      )::bigint as backfillable_rows
    from public.cloud_title_ratings as reaction
  ),
  compatibility_counts as (
    select
      count(*) filter (
        where operation.compatibility_mode
          and operation.created_at >= now() - interval '30 days'
      )::bigint as compatibility_writes_30d,
      max(operation.created_at) filter (
        where operation.compatibility_mode
      ) as last_compatibility_write_at
    from public.cloud_title_rating_operations as operation
  )
  select jsonb_build_object(
    'contract_version', 1,
    'total_rows', reaction.total_rows,
    'resolved_rows', reaction.resolved_rows,
    'unresolved_rows', reaction.unresolved_rows,
    'backfillable_rows', reaction.backfillable_rows,
    'orphan_user_rows', reaction.orphan_user_rows,
    'orphan_profile_rows', reaction.orphan_profile_rows,
    'orphan_source_rows', reaction.orphan_source_rows,
    'orphan_title_rows', reaction.orphan_title_rows,
    'compatibility_writes_30d', compatibility.compatibility_writes_30d,
    'last_compatibility_write_at', compatibility.last_compatibility_write_at,
    'contract_ready',
      reaction.unresolved_rows = 0
      and reaction.orphan_user_rows = 0
      and reaction.orphan_profile_rows = 0
      and reaction.orphan_source_rows = 0
      and reaction.orphan_title_rows = 0
      and compatibility.compatibility_writes_30d = 0
  )
  from reaction_counts as reaction
  cross join compatibility_counts as compatibility;
$$;

revoke all on function public.cloud_title_ratings_expand_audit()
from public, anon, authenticated;
grant execute on function public.cloud_title_ratings_expand_audit()
to service_role;

-- Preserve attached reactions when the existing catalogue reconciler merges a
-- normalized cloud_titles row into its canonical TMDB sibling. Rows are
-- repointed, never deleted, and every affected profile receives a revision
-- greater than either pre-merge side.
create or replace function public.norva_repoint_title_ratings_on_merge()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  canonical_title_id uuid;
begin
  -- A nested FK cascade (notably account deletion) already owns the lifecycle.
  if pg_trigger_depth() > 1 or old.provider_tmdb_id is null then
    return old;
  end if;

  select candidate.id
    into canonical_title_id
  from public.cloud_titles as candidate
  where candidate.id <> old.id
    and candidate.user_id = old.user_id
    and candidate.item_type = old.item_type
    and candidate.provider_tmdb_id = old.provider_tmdb_id
  order by
    (
      select count(*)
      from public.cloud_title_variants as variant
      where variant.title_id = candidate.id
    ) desc,
    (candidate.identity_source = 'provider_tmdb') desc,
    candidate.created_at asc,
    candidate.id
  limit 1;

  if canonical_title_id is null then
    return old;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'title-rating-title:' || old.user_id::text || ':' ||
      least(old.id::text, canonical_title_id::text),
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'title-rating-title:' || old.user_id::text || ':' ||
      greatest(old.id::text, canonical_title_id::text),
      0
    )
  );

  with profile_state as (
    select
      reaction.profile_id,
      coalesce(max(reaction.server_revision), 0) + 1 as merged_revision,
      (
        array_agg(
          reaction.rating
          order by reaction.server_revision desc,
                   reaction.updated_at desc,
                   reaction.id desc
        )
      )[1] as merged_rating
    from public.cloud_title_ratings as reaction
    where reaction.title_id in (old.id, canonical_title_id)
    group by reaction.profile_id
  )
  update public.cloud_title_ratings as reaction
  set
    title_id = canonical_title_id,
    rating = state.merged_rating,
    server_revision = state.merged_revision,
    last_operation_id = null,
    updated_at = now()
  from profile_state as state
  where reaction.title_id in (old.id, canonical_title_id)
    and reaction.profile_id is not distinct from state.profile_id;

  update public.cloud_title_rating_operations
  set title_id = canonical_title_id
  where title_id = old.id;

  return old;
end;
$$;

drop trigger if exists trg_cloud_titles_repoint_ratings_on_merge
  on public.cloud_titles;
create trigger trg_cloud_titles_repoint_ratings_on_merge
before delete on public.cloud_titles
for each row execute function public.norva_repoint_title_ratings_on_merge();

revoke all on function public.norva_repoint_title_ratings_on_merge()
from public, anon, authenticated;
grant execute on function public.norva_repoint_title_ratings_on_merge()
to service_role;

-- Compare-and-set writer.
--
-- Modern clients:
--   expectedRevision is mandatory and must equal the authoritative revision.
--   operationId is mandatory and permanently idempotent through the ledger.
--
-- Compatibility clients:
--   the Edge passes compatibility_mode=true and expectedRevision=NULL.
--   Arrival order temporarily wins, is counted by the rollout audit, and still
--   receives a server revision. This path must be removed only in CONTRACT.
create or replace function public.upsert_cloud_title_rating_cas(
  p_user_id uuid,
  p_profile_id uuid,
  p_title_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_item_id text,
  p_rating smallint,
  p_operation_id uuid,
  p_expected_revision bigint default null,
  p_compatibility_mode boolean default false
)
returns table (
  rating smallint,
  revision bigint,
  applied boolean,
  conflict boolean,
  idempotent boolean,
  compatibility_mode boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  previous_operation public.cloud_title_rating_operations%rowtype;
  current_rating smallint := 0;
  current_revision bigint := 0;
  next_revision bigint;
begin
  if p_operation_id is null then
    raise exception 'operation_id is required' using errcode = '22023';
  end if;
  if p_rating not in (-1, 0, 1) then
    raise exception 'rating must be -1, 0 or 1' using errcode = '22023';
  end if;
  if p_item_type not in ('movie', 'series') then
    raise exception 'item_type must be movie or series' using errcode = '22023';
  end if;
  if nullif(btrim(p_item_id), '') is null then
    raise exception 'item_id is required' using errcode = '22023';
  end if;
  if not p_compatibility_mode and p_expected_revision is null then
    raise exception 'expected_revision is required' using errcode = '22023';
  end if;
  if p_expected_revision is not null and p_expected_revision < 0 then
    raise exception 'expected_revision must be non-negative' using errcode = '22023';
  end if;

  -- Lock operation identity first, then logical title in deterministic order.
  perform pg_advisory_xact_lock(
    hashtextextended('title-rating-operation:' || p_operation_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'title-rating-title:' || p_user_id::text || ':' || p_title_id::text,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'title-rating:' || p_user_id::text || ':' ||
      p_profile_id::text || ':' || p_title_id::text,
      0
    )
  );

  select operation.*
    into previous_operation
  from public.cloud_title_rating_operations as operation
  where operation.operation_id = p_operation_id;

  if found then
    if previous_operation.user_id <> p_user_id
       or previous_operation.profile_id <> p_profile_id
       or previous_operation.title_id <> p_title_id
       or previous_operation.source_id <> p_source_id
       or previous_operation.item_type <> p_item_type
       or previous_operation.item_id <> p_item_id
       or previous_operation.requested_rating <> p_rating
       or previous_operation.expected_revision is distinct from p_expected_revision
       or previous_operation.compatibility_mode <> p_compatibility_mode then
      raise exception 'operation_id was reused with a different request'
        using errcode = '22023';
    end if;

    return query
      select
        previous_operation.result_rating,
        previous_operation.result_revision,
        previous_operation.applied,
        previous_operation.conflict,
        true,
        previous_operation.compatibility_mode;
    return;
  end if;

  if not exists (
    select 1
    from public.cloud_account_profiles as profile
    where profile.id = p_profile_id
      and profile.user_id = p_user_id
  ) then
    raise exception 'profile does not belong to account' using errcode = '23503';
  end if;

  if not exists (
    select 1
    from public.cloud_sources as source
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.deleted_at is null
  ) then
    raise exception 'source does not belong to account' using errcode = '23503';
  end if;

  if not exists (
    select 1
    from public.cloud_titles as title
    where title.id = p_title_id
      and title.user_id = p_user_id
      and title.item_type = p_item_type
  ) then
    raise exception 'logical title does not belong to account' using errcode = '23503';
  end if;

  if not exists (
    select 1
    from public.cloud_title_variants as variant
    where variant.user_id = p_user_id
      and variant.title_id = p_title_id
      and variant.source_id = p_source_id
      and variant.item_type = p_item_type
      and variant.external_id = p_item_id
  ) then
    raise exception 'variant does not belong to logical title' using errcode = '23503';
  end if;

  -- Include both canonical rows and the exact legacy alias. During EXPAND an old
  -- Edge may have written the exact row before title_id was attached.
  select coalesce(max(reaction.server_revision), 0)
    into current_revision
  from public.cloud_title_ratings as reaction
  where reaction.user_id = p_user_id
    and reaction.profile_id = p_profile_id
    and (
      reaction.title_id = p_title_id
      or (
        reaction.source_id = p_source_id::text
        and reaction.item_type = p_item_type
        and reaction.item_id = p_item_id
      )
    );

  select reaction.rating
    into current_rating
  from public.cloud_title_ratings as reaction
  where reaction.user_id = p_user_id
    and reaction.profile_id = p_profile_id
    and (
      reaction.title_id = p_title_id
      or (
        reaction.source_id = p_source_id::text
        and reaction.item_type = p_item_type
        and reaction.item_id = p_item_id
      )
    )
  order by
    reaction.server_revision desc,
    reaction.updated_at desc,
    reaction.id desc
  limit 1;
  current_rating := coalesce(current_rating, 0);

  if not p_compatibility_mode and p_expected_revision <> current_revision then
    insert into public.cloud_title_rating_operations (
      operation_id, user_id, profile_id, title_id, source_id,
      item_type, item_id, requested_rating, expected_revision,
      result_rating, result_revision, applied, conflict,
      compatibility_mode
    )
    values (
      p_operation_id, p_user_id, p_profile_id, p_title_id, p_source_id,
      p_item_type, p_item_id, p_rating, p_expected_revision,
      current_rating, current_revision, false, true, false
    );

    return query
      select current_rating, current_revision, false, true, false, false;
    return;
  end if;

  next_revision := current_revision + 1;

  -- Synchronize every already-attached legacy alias plus the current exact row.
  update public.cloud_title_ratings as reaction
  set
    title_id = p_title_id,
    rating = p_rating,
    server_revision = next_revision,
    last_operation_id = p_operation_id,
    updated_at = now()
  where reaction.user_id = p_user_id
    and reaction.profile_id = p_profile_id
    and (
      reaction.title_id = p_title_id
      or (
        reaction.source_id = p_source_id::text
        and reaction.item_type = p_item_type
        and reaction.item_id = p_item_id
      )
    );

  -- Always materialize the current provider alias. The legacy Edge/read contract
  -- can therefore still resolve this exact variant during the EXPAND window.
  insert into public.cloud_title_ratings (
    user_id,
    profile_id,
    source_id,
    item_type,
    item_id,
    rating,
    title_id,
    server_revision,
    last_operation_id,
    created_at,
    updated_at
  )
  values (
    p_user_id,
    p_profile_id,
    p_source_id::text,
    p_item_type,
    p_item_id,
    p_rating,
    p_title_id,
    next_revision,
    p_operation_id,
    now(),
    now()
  )
  on conflict (user_id, profile_id, source_id, item_type, item_id) do update
  set
    rating = excluded.rating,
    title_id = excluded.title_id,
    server_revision = excluded.server_revision,
    last_operation_id = excluded.last_operation_id,
    updated_at = excluded.updated_at;

  insert into public.cloud_title_rating_operations (
    operation_id, user_id, profile_id, title_id, source_id,
    item_type, item_id, requested_rating, expected_revision,
    result_rating, result_revision, applied, conflict,
    compatibility_mode
  )
  values (
    p_operation_id, p_user_id, p_profile_id, p_title_id, p_source_id,
    p_item_type, p_item_id, p_rating, p_expected_revision,
    p_rating, next_revision, true, false, p_compatibility_mode
  );

  return query
    select p_rating, next_revision, true, false, false, p_compatibility_mode;
end;
$$;

revoke all on function public.upsert_cloud_title_rating_cas(
  uuid, uuid, uuid, uuid, text, text, smallint, uuid, bigint, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_cloud_title_rating_cas(
  uuid, uuid, uuid, uuid, text, text, smallint, uuid, bigint, boolean
) to service_role;

-- Supabase/PostgREST may have cached the pre-expand table/RPC shape.
notify pgrst, 'reload schema';

commit;
