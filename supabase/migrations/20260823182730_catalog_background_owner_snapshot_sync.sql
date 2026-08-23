begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A transaction-local durable fence lets the central visibility-epoch bump
-- distinguish a payload/membership mutation that patched every live snapshot
-- from an unrelated source/head visibility mutation.  txid_current() prevents
-- a fence left by an older transaction from being reused.
create table if not exists public.cloud_catalog_background_owner_sync_fences (
  user_id uuid primary key,
  transaction_id bigint not null check (transaction_id > 0),
  fence_kind text not null default 'synced' check (
    fence_kind in ('synced','stale')
  ),
  updated_at timestamptz not null default now(),
  constraint cloud_catalog_background_owner_sync_fences_user_fk
    foreign key (user_id) references auth.users(id) on delete cascade
);

alter table public.cloud_catalog_background_owner_sync_fences
  add column if not exists fence_kind text not null default 'synced';
do $fence_constraint$
begin
  if not exists (
    select 1 from pg_constraint constraint_state
    where constraint_state.conrelid =
      'public.cloud_catalog_background_owner_sync_fences'::regclass
      and constraint_state.conname =
        'cloud_catalog_background_owner_sync_fences_kind_ck'
  ) then
    alter table public.cloud_catalog_background_owner_sync_fences
      add constraint cloud_catalog_background_owner_sync_fences_kind_ck
      check (fence_kind in ('synced','stale'));
  end if;
end
$fence_constraint$;

alter table public.cloud_catalog_background_owner_sync_fences
  enable row level security;
revoke all on table public.cloud_catalog_background_owner_sync_fences
  from public, anon, authenticated, service_role;

-- Keep the foundation epoch primitive byte-for-byte compatible.  Owner rows
-- are synchronized directly by payload/membership triggers; an epoch AFTER
-- trigger must never lock snapshot rows because callers reach this primitive
-- through several pre-existing lock orders.
create or replace function public.norva_bump_user_catalog_visibility_epoch(
  p_user_id uuid
) returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_epoch bigint;
begin
  if p_user_id is null then
    raise exception 'user_id is required' using errcode = '22004';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs as epoch (
    user_id, visibility_epoch, updated_at
  ) values (p_user_id, 2, now())
  on conflict (user_id) do update
  set visibility_epoch = epoch.visibility_epoch + 1,
      updated_at = now()
  returning visibility_epoch into v_epoch;
  return v_epoch;
end
$function$;

-- This is a serialization primitive, not an epoch mutation.  Owner snapshot
-- creation/cutover takes the same row before it locks any snapshot version.
-- Statement-level payload/membership triggers call it before their relevance
-- scan, so a transaction that started before a new source map either commits
-- first (and is copied by the builder) or waits and patches the new snapshot.
create or replace function public.norva_lock_catalog_background_owner_epoch(
  p_user_id uuid
) returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_epoch bigint;
begin
  if p_user_id is null then
    raise exception 'catalog background owner epoch user is required'
      using errcode = '22004';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs (
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now())
  on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id
  for update;
  return v_epoch;
end
$function$;

create or replace function public.norva_mark_catalog_background_owner_sync(
  p_user_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null then
    raise exception 'catalog background owner sync user is required'
      using errcode = '22004';
  end if;
  insert into public.cloud_catalog_background_owner_sync_fences (
    user_id, transaction_id, fence_kind, updated_at
  ) values (p_user_id, txid_current(), 'synced', now())
  on conflict (user_id) do update set
    transaction_id = excluded.transaction_id,
    fence_kind = case
      when public.cloud_catalog_background_owner_sync_fences.transaction_id
             = excluded.transaction_id
       and public.cloud_catalog_background_owner_sync_fences.fence_kind = 'stale'
        then 'stale'
      else excluded.fence_kind
    end,
    updated_at = excluded.updated_at;
end
$function$;

create or replace function public.norva_mark_catalog_background_owner_stale(
  p_user_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_epoch bigint;
begin
  if p_user_id is null then
    raise exception 'catalog background stale user is required'
      using errcode = '22004';
  end if;
  if position(
    '|' || p_user_id::text || '|'
    in coalesce(current_setting(
      'norva.catalog_background_owner_deleted_users',true
    ),'')
  ) > 0 then
    return;
  end if;
  -- Global walkers own one of these rows for their whole bounded page.  Take
  -- every matching checkpoint before the pointer, epoch and snapshot rows so
  -- cutover, rebuild and topology invalidation share one lock order.
  perform 1
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.owner_user_id = p_user_id
  order by checkpoint.mode
  for update;
  perform 1
  from public.cloud_catalog_background_owner_pointers pointer
  where pointer.user_id = p_user_id
  for update;
  v_epoch := public.norva_lock_catalog_background_owner_epoch(p_user_id);
  insert into public.cloud_catalog_background_owner_topology_revisions as topology (
    user_id,revision,updated_at
  ) values (p_user_id,1,now())
  on conflict (user_id) do update set
    revision = topology.revision + 1,
    updated_at = excluded.updated_at;
  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set owner_user_id = null,snapshot_id = null,user_visibility_epoch = null,
      last_attempted_at = null,last_title_id = null,
      inflight_items = '[]'::jsonb,
      inflight_last_attempted_at = null,inflight_last_title_id = null,
      inflight_owner_exhausted = false,inflight_byte_count = 0,
      revision = checkpoint.revision + 1,updated_at = now()
  where checkpoint.owner_user_id = p_user_id;
  update public.cloud_catalog_background_owner_snapshots snapshot
  set state = 'stale', stale_at = coalesce(snapshot.stale_at,now()),
      revision = snapshot.revision + 1, updated_at = now()
  where snapshot.user_id = p_user_id
    and snapshot.state in ('building','ready','active','retained');
end
$function$;

create or replace function public.norva_sync_catalog_background_owner_title(
  p_user_id uuid,
  p_title_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or p_title_id is null then
    raise exception 'catalog background owner sync identity is required'
      using errcode = '22004';
  end if;
  -- Direct callers receive the same fence as statement triggers.  The lock is
  -- re-entrant when the statement trigger already acquired it for this user.
  perform public.norva_lock_catalog_background_owner_epoch(p_user_id);
  -- Candidate staging is intentionally off-head.  Do no per-title work until
  -- this logical title already belongs to a live snapshot or one of its
  -- surviving variants belongs to a generation mapped by that snapshot.
  -- This keeps a 1M-row candidate import from manufacturing 1M baseline
  -- tombstones before the candidate owner snapshot has even been created.
  if not exists (
    select 1
    from public.cloud_catalog_background_owner_snapshots snapshot
    join public.cloud_catalog_background_owner_snapshot_rows owner_row
      on owner_row.snapshot_id = snapshot.id
     and owner_row.title_id = p_title_id
    where snapshot.user_id = p_user_id
      and snapshot.state in ('building','ready','active','retained')
  ) and not exists (
    select 1
    from public.cloud_title_variants variant
    join public.cloud_catalog_background_owner_snapshot_sources source_map
      on source_map.source_id = variant.source_id
     and source_map.generation_id = variant.generation_id
    join public.cloud_catalog_background_owner_snapshots snapshot
      on snapshot.id = source_map.snapshot_id
     and snapshot.user_id = variant.user_id
     and snapshot.state in ('building','ready','active','retained')
    where variant.user_id = p_user_id and variant.title_id = p_title_id
  ) then
    return;
  end if;
  -- Serialize only mutations of this logical title.  Every trigger acquires
  -- title keys in ascending order, so two multi-title statements cannot form
  -- a user-wide lock cycle.  The builder never takes this lock and is
  -- insert-only; a concurrent trigger row/tombstone always wins the PK race.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'catalog-background-owner-title:' || p_user_id::text || ':' ||
      p_title_id::text, 0
    )
  );

  with target_snapshots as materialized (
    select snapshot.id
    from public.cloud_catalog_background_owner_snapshots snapshot
    where snapshot.user_id = p_user_id
      and snapshot.state in ('building','ready','active','retained')
  ), owners as materialized (
    select distinct on (target.id)
      target.id as snapshot_id,
      variant.source_id,
      variant.generation_id
    from target_snapshots target
    join public.cloud_catalog_background_owner_snapshot_sources source_map
      on source_map.snapshot_id = target.id
    join public.cloud_title_variants variant
      on variant.user_id = p_user_id
     and variant.title_id = p_title_id
     and variant.source_id = source_map.source_id
     and variant.generation_id = source_map.generation_id
    order by target.id, variant.source_id,
      variant.generation_id, variant.id
  ), effective as materialized (
    select
      owner.snapshot_id,
      owner.source_id,
      owner.generation_id,
      projection.title_id is not null as has_projection,
      coalesce(projection.item_type, title.item_type) as item_type,
      case when projection.title_id is not null
        then projection.provider_tmdb_id else title.provider_tmdb_id end
        as provider_tmdb_id,
      coalesce(projection.match_status, title.match_status) as match_status,
      coalesce(projection.title, title.title) as title,
      case when projection.title_id is not null
        then projection.original_title else title.original_title end
        as original_title,
      case when projection.title_id is not null
        then projection.release_year else title.release_year end as release_year,
      case when projection.title_id is not null
        then projection.poster_url else title.poster_url end as poster_url,
      case when projection.title_id is not null
        then projection.backdrop_url else title.backdrop_url end as backdrop_url,
      case when projection.title_id is not null
        then projection.catalog_metadata else title.metadata end as catalog_metadata,
      case when projection.title_id is not null
        then projection.updated_at else title.updated_at end as payload_updated_at,
      case when projection.title_id is not null
        then projection.year_backfill_attempted_at
        else title.year_backfill_attempted_at end as year_attempted_at,
      case when projection.title_id is not null
        then projection.revalidate_attempted_at
        else title.revalidate_attempted_at end as revalidate_attempted_at,
      case when projection.title_id is not null
        then projection.search_match_attempted_at
        else title.search_match_attempted_at end as search_attempted_at
    from owners owner
    join public.cloud_titles title
      on title.id = p_title_id and title.user_id = p_user_id
    left join public.cloud_source_catalog_generation_candidate_titles projection
      on projection.user_id = p_user_id
     and projection.title_id = p_title_id
     and projection.generation_id = owner.generation_id
  )
  insert into public.cloud_catalog_background_owner_snapshot_rows (
    snapshot_id, user_id, title_id, is_present,
    owner_source_id, owner_generation_id, storage_kind,
    item_type, provider_tmdb_id, match_status,
    title, original_title, release_year, poster_url, backdrop_url,
    catalog_metadata, payload_updated_at,
    year_backfill_attempted_at, revalidate_attempted_at,
    search_match_attempted_at, updated_at
  )
  select
    effective.snapshot_id, p_user_id, p_title_id, true,
    effective.source_id, effective.generation_id,
    case when effective.has_projection then 'projection' else 'global' end,
    effective.item_type, effective.provider_tmdb_id, effective.match_status,
    effective.title, effective.original_title, effective.release_year,
    effective.poster_url, effective.backdrop_url,
    effective.catalog_metadata, effective.payload_updated_at,
    effective.year_attempted_at, effective.revalidate_attempted_at,
    effective.search_attempted_at, now()
  from effective
  on conflict (snapshot_id, title_id) do update set
    is_present = true,
    owner_source_id = excluded.owner_source_id,
    owner_generation_id = excluded.owner_generation_id,
    storage_kind = excluded.storage_kind,
    item_type = excluded.item_type,
    provider_tmdb_id = excluded.provider_tmdb_id,
    match_status = excluded.match_status,
    title = excluded.title,
    original_title = excluded.original_title,
    release_year = excluded.release_year,
    poster_url = excluded.poster_url,
    backdrop_url = excluded.backdrop_url,
    catalog_metadata = excluded.catalog_metadata,
    payload_updated_at = excluded.payload_updated_at,
    year_backfill_attempted_at = excluded.year_backfill_attempted_at,
    revalidate_attempted_at = excluded.revalidate_attempted_at,
    search_match_attempted_at = excluded.search_match_attempted_at,
    updated_at = now();

  -- Never physically delete a build key here.  A false row is an absence
  -- tombstone that wins against an insert-only builder statement which may
  -- still hold a pre-delete MVCC snapshot.
  insert into public.cloud_catalog_background_owner_snapshot_rows (
    snapshot_id,user_id,title_id,is_present,
    owner_source_id,owner_generation_id,storage_kind,
    item_type,provider_tmdb_id,match_status,title,original_title,
    release_year,poster_url,backdrop_url,catalog_metadata,
    payload_updated_at,year_backfill_attempted_at,
    revalidate_attempted_at,search_match_attempted_at,updated_at
  )
  select snapshot.id,p_user_id,p_title_id,false,
    fallback.source_id,fallback.generation_id,'global',
    title.item_type,title.provider_tmdb_id,title.match_status,title.title,
    title.original_title,title.release_year,title.poster_url,title.backdrop_url,
    title.metadata,title.updated_at,title.year_backfill_attempted_at,
    title.revalidate_attempted_at,title.search_match_attempted_at,now()
  from public.cloud_catalog_background_owner_snapshots snapshot
  join lateral (
    select source_map.source_id,source_map.generation_id
    from public.cloud_catalog_background_owner_snapshot_sources source_map
    where source_map.snapshot_id = snapshot.id
    order by source_map.source_id,source_map.generation_id
    limit 1
  ) fallback on true
  join public.cloud_titles title
    on title.id = p_title_id and title.user_id = p_user_id
  where snapshot.user_id = p_user_id
    and snapshot.state in ('building','ready','active','retained')
    and not exists (
      select 1
      from public.cloud_title_variants variant
      join public.cloud_catalog_background_owner_snapshot_sources source_map
        on source_map.snapshot_id = snapshot.id
       and source_map.source_id = variant.source_id
       and source_map.generation_id = variant.generation_id
      where variant.user_id = p_user_id
        and variant.title_id = p_title_id
    )
  on conflict (snapshot_id,title_id) do update set
    is_present = false,updated_at = now();
end
$function$;

create or replace function public.norva_catalog_background_owner_sync_new_rows()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_key record;
  v_user_id uuid;
begin
  -- Acquire every user epoch in deterministic order before the relevance
  -- query.  This covers the otherwise-lost case where the statement began
  -- before a baseline/candidate source map was inserted.
  for v_user_id in
    select distinct row_state.user_id
    from new_rows row_state
    where row_state.user_id is not null
    order by row_state.user_id
  loop
    perform public.norva_lock_catalog_background_owner_epoch(v_user_id);
  end loop;
  if tg_table_name = 'cloud_titles' then
    for v_key in select distinct row_state.user_id,row_state.id as title_id
                 from new_rows row_state
                 order by row_state.user_id,row_state.id
    loop
      perform public.norva_sync_catalog_background_owner_title(
        v_key.user_id,v_key.title_id
      );
    end loop;
    return null;
  end if;
  if tg_table_name = 'cloud_source_catalog_generation_candidate_titles' then
    for v_key in
      select distinct row_state.user_id,row_state.title_id
      from new_rows row_state
      where exists (
        select 1
        from public.cloud_catalog_background_owner_snapshot_sources source_map
        join public.cloud_catalog_background_owner_snapshots snapshot
          on snapshot.id = source_map.snapshot_id
         and snapshot.state in ('building','ready','active','retained')
        where source_map.generation_id = row_state.generation_id
          and snapshot.user_id = row_state.user_id
      )
      order by row_state.user_id,row_state.title_id
    loop
      perform public.norva_sync_catalog_background_owner_title(
        v_key.user_id,v_key.title_id
      );
    end loop;
    return null;
  end if;
  for v_key in
    select distinct row_state.user_id,row_state.title_id
    from new_rows row_state
    where exists (
      select 1
      from public.cloud_catalog_background_owner_snapshot_sources source_map
      join public.cloud_catalog_background_owner_snapshots snapshot
        on snapshot.id = source_map.snapshot_id
       and snapshot.state in ('building','ready','active','retained')
      where source_map.source_id = row_state.source_id
        and source_map.generation_id = row_state.generation_id
        and snapshot.user_id = row_state.user_id
    )
    order by row_state.user_id,row_state.title_id
  loop
    perform public.norva_sync_catalog_background_owner_title(
      v_key.user_id, v_key.title_id
    );
  end loop;
  return null;
end
$function$;

create or replace function public.norva_catalog_background_owner_sync_old_rows()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_key record;
  v_user_id uuid;
begin
  for v_user_id in
    select distinct row_state.user_id
    from old_rows row_state
    where row_state.user_id is not null
    order by row_state.user_id
  loop
    perform public.norva_lock_catalog_background_owner_epoch(v_user_id);
  end loop;
  if tg_table_name = 'cloud_titles' then
    for v_key in select distinct row_state.user_id,row_state.id as title_id
                 from old_rows row_state
                 order by row_state.user_id,row_state.id
    loop
      perform public.norva_sync_catalog_background_owner_title(
        v_key.user_id,v_key.title_id
      );
    end loop;
    return null;
  end if;
  if tg_table_name = 'cloud_source_catalog_generation_candidate_titles' then
    for v_key in
      select distinct row_state.user_id,row_state.title_id
      from old_rows row_state
      where exists (
        select 1
        from public.cloud_catalog_background_owner_snapshot_sources source_map
        join public.cloud_catalog_background_owner_snapshots snapshot
          on snapshot.id = source_map.snapshot_id
         and snapshot.state in ('building','ready','active','retained')
        where source_map.generation_id = row_state.generation_id
          and snapshot.user_id = row_state.user_id
      )
      order by row_state.user_id,row_state.title_id
    loop
      perform public.norva_sync_catalog_background_owner_title(
        v_key.user_id,v_key.title_id
      );
    end loop;
    return null;
  end if;
  for v_key in
    select distinct row_state.user_id,row_state.title_id
    from old_rows row_state
    where exists (
      select 1
      from public.cloud_catalog_background_owner_snapshot_sources source_map
      join public.cloud_catalog_background_owner_snapshots snapshot
        on snapshot.id = source_map.snapshot_id
       and snapshot.state in ('building','ready','active','retained')
      where source_map.source_id = row_state.source_id
        and source_map.generation_id = row_state.generation_id
        and snapshot.user_id = row_state.user_id
    )
    order by row_state.user_id,row_state.title_id
  loop
    perform public.norva_sync_catalog_background_owner_title(
      v_key.user_id, v_key.title_id
    );
  end loop;
  return null;
end
$function$;

create or replace function public.norva_catalog_background_owner_sync_changed_rows()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_key record;
  v_user_id uuid;
begin
  for v_user_id in
    select changed.user_id
    from (
      select row_state.user_id from old_rows row_state
      union
      select row_state.user_id from new_rows row_state
    ) changed
    where changed.user_id is not null
    order by changed.user_id
  loop
    perform public.norva_lock_catalog_background_owner_epoch(v_user_id);
  end loop;
  if tg_table_name = 'cloud_titles' then
    for v_key in
      select distinct changed.user_id,changed.title_id
      from (
        select row_state.user_id,row_state.id as title_id from old_rows row_state
        union
        select row_state.user_id,row_state.id as title_id from new_rows row_state
      ) changed
      order by changed.user_id,changed.title_id
    loop
      perform public.norva_sync_catalog_background_owner_title(
        v_key.user_id,v_key.title_id
      );
    end loop;
    return null;
  end if;
  if tg_table_name = 'cloud_source_catalog_generation_candidate_titles' then
    for v_key in
      select distinct changed.user_id,changed.title_id
      from (
        select row_state.user_id,row_state.title_id,row_state.generation_id
        from old_rows row_state
        union
        select row_state.user_id,row_state.title_id,row_state.generation_id
        from new_rows row_state
      ) changed
      where exists (
        select 1
        from public.cloud_catalog_background_owner_snapshot_sources source_map
        join public.cloud_catalog_background_owner_snapshots snapshot
          on snapshot.id = source_map.snapshot_id
         and snapshot.state in ('building','ready','active','retained')
        where source_map.generation_id = changed.generation_id
          and snapshot.user_id = changed.user_id
      )
      order by changed.user_id,changed.title_id
    loop
      perform public.norva_sync_catalog_background_owner_title(
        v_key.user_id,v_key.title_id
      );
    end loop;
    return null;
  end if;
  for v_key in
    select distinct changed.user_id, changed.title_id
    from (
      select row_state.user_id,row_state.title_id,
             row_state.source_id,row_state.generation_id
      from old_rows row_state
      union
      select row_state.user_id,row_state.title_id,
             row_state.source_id,row_state.generation_id
      from new_rows row_state
    ) changed
    where exists (
      select 1
      from public.cloud_catalog_background_owner_snapshot_sources source_map
      join public.cloud_catalog_background_owner_snapshots snapshot
        on snapshot.id = source_map.snapshot_id
       and snapshot.state in ('building','ready','active','retained')
      where source_map.source_id = changed.source_id
        and source_map.generation_id = changed.generation_id
        and snapshot.user_id = changed.user_id
    )
    order by changed.user_id,changed.title_id
  loop
    perform public.norva_sync_catalog_background_owner_title(
      v_key.user_id, v_key.title_id
    );
  end loop;
  return null;
end
$function$;

create or replace function public.norva_catalog_background_owner_epoch_changed()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Kept only as a private compatibility stub for scratch databases that had
  -- installed an earlier expand draft.  The trigger is dropped below.
  return null;
end
$function$;

create or replace function public.norva_catalog_background_owner_topology_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
begin
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if exists (
    select 1
    from public.cloud_source_transitions transition
    where transition.user_id = v_user_id
      and transition.transition_kind = 'credential'
      and transition.state = 'committing'
  ) then
    raise exception 'user catalog topology is fenced during credential cutover'
      using errcode = '40001';
  end if;
  perform public.norva_mark_catalog_background_owner_stale(v_user_id);
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

create or replace function public.norva_catalog_background_owner_head_topology_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and exists (
    select 1
    from public.cloud_source_transitions transition
    where transition.user_id = new.user_id
      and transition.old_source_id = new.source_id
      and transition.transition_kind = 'credential'
      and transition.state = 'committing'
      and (
        (transition.previous_catalog_generation_id = old.active_generation_id
          and transition.candidate_catalog_generation_id = new.active_generation_id)
        or
        (transition.candidate_catalog_generation_id = old.active_generation_id
          and transition.previous_catalog_generation_id = new.active_generation_id)
      )
  ) then
    return new;
  end if;
  perform public.norva_mark_catalog_background_owner_stale(
    case when tg_op = 'DELETE' then old.user_id else new.user_id end
  );
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

-- Payload transitions are kept separate by operation because PostgreSQL
-- transition tables cannot be attached to a multi-event trigger.
drop trigger if exists trg_cloud_titles_zy_background_owner_i
  on public.cloud_titles;
create trigger trg_cloud_titles_zy_background_owner_i
after insert on public.cloud_titles
referencing new table as new_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_new_rows();

drop trigger if exists trg_cloud_titles_zy_background_owner_u
  on public.cloud_titles;
create trigger trg_cloud_titles_zy_background_owner_u
after update on public.cloud_titles
referencing old table as old_rows new table as new_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_changed_rows();

drop trigger if exists trg_candidate_titles_zy_background_owner_i
  on public.cloud_source_catalog_generation_candidate_titles;
create trigger trg_candidate_titles_zy_background_owner_i
after insert on public.cloud_source_catalog_generation_candidate_titles
referencing new table as new_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_new_rows();

drop trigger if exists trg_candidate_titles_zy_background_owner_u
  on public.cloud_source_catalog_generation_candidate_titles;
create trigger trg_candidate_titles_zy_background_owner_u
after update on public.cloud_source_catalog_generation_candidate_titles
referencing old table as old_rows new table as new_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_changed_rows();

drop trigger if exists trg_candidate_titles_zy_background_owner_d
  on public.cloud_source_catalog_generation_candidate_titles;
create trigger trg_candidate_titles_zy_background_owner_d
after delete on public.cloud_source_catalog_generation_candidate_titles
referencing old table as old_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_old_rows();

drop trigger if exists trg_cloud_title_variants_zy_background_owner_i
  on public.cloud_title_variants;
drop trigger if exists trg_cloud_title_variants_zzz_background_owner_i
  on public.cloud_title_variants;
create trigger trg_cloud_title_variants_zzz_background_owner_i
after insert on public.cloud_title_variants
referencing new table as new_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_new_rows();

drop trigger if exists trg_cloud_title_variants_zy_background_owner_u
  on public.cloud_title_variants;
drop trigger if exists trg_cloud_title_variants_zzz_background_owner_u
  on public.cloud_title_variants;
create trigger trg_cloud_title_variants_zzz_background_owner_u
after update on public.cloud_title_variants
referencing old table as old_rows new table as new_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_changed_rows();

drop trigger if exists trg_cloud_title_variants_zy_background_owner_d
  on public.cloud_title_variants;
drop trigger if exists trg_cloud_title_variants_zzz_background_owner_d
  on public.cloud_title_variants;
create trigger trg_cloud_title_variants_zzz_background_owner_d
after delete on public.cloud_title_variants
referencing old table as old_rows
for each statement execute function
  public.norva_catalog_background_owner_sync_old_rows();

drop trigger if exists trg_cloud_user_visibility_epoch_zz_background_owner
  on public.cloud_user_catalog_visibility_epochs;
drop trigger if exists trg_cloud_sources_background_owner_topology_guard on public.cloud_sources;
drop trigger if exists trg_cloud_sources_background_owner_topology_i on public.cloud_sources;
drop trigger if exists trg_cloud_sources_background_owner_topology_u on public.cloud_sources;
drop trigger if exists trg_cloud_sources_background_owner_topology_d on public.cloud_sources;
create trigger trg_cloud_sources_background_owner_topology_i
before insert on public.cloud_sources
for each row execute function public.norva_catalog_background_owner_topology_guard();
create trigger trg_cloud_sources_background_owner_topology_u
before update of enabled, deleted_at on public.cloud_sources
for each row
when (
  old.enabled is distinct from new.enabled
  or old.deleted_at is distinct from new.deleted_at
)
execute function public.norva_catalog_background_owner_topology_guard();
create trigger trg_cloud_sources_background_owner_topology_d
before delete on public.cloud_sources
for each row execute function public.norva_catalog_background_owner_topology_guard();

drop trigger if exists trg_cloud_source_lifecycle_background_owner_topology_guard on public.cloud_source_lifecycle;
drop trigger if exists trg_cloud_source_lifecycle_background_owner_topology_i on public.cloud_source_lifecycle;
drop trigger if exists trg_cloud_source_lifecycle_background_owner_topology_u on public.cloud_source_lifecycle;
drop trigger if exists trg_cloud_source_lifecycle_background_owner_topology_d on public.cloud_source_lifecycle;
create trigger trg_cloud_source_lifecycle_background_owner_topology_i
before insert on public.cloud_source_lifecycle
for each row execute function public.norva_catalog_background_owner_topology_guard();
create trigger trg_cloud_source_lifecycle_background_owner_topology_u
before update of lifecycle_state, catalog_visibility
on public.cloud_source_lifecycle
for each row
when (
  old.lifecycle_state is distinct from new.lifecycle_state
  or old.catalog_visibility is distinct from new.catalog_visibility
)
execute function public.norva_catalog_background_owner_topology_guard();
create trigger trg_cloud_source_lifecycle_background_owner_topology_d
before delete on public.cloud_source_lifecycle
for each row execute function public.norva_catalog_background_owner_topology_guard();

drop trigger if exists trg_cloud_source_access_background_owner_topology_guard on public.cloud_source_provider_access;
drop trigger if exists trg_cloud_source_access_background_owner_topology_i on public.cloud_source_provider_access;
drop trigger if exists trg_cloud_source_access_background_owner_topology_u on public.cloud_source_provider_access;
drop trigger if exists trg_cloud_source_access_background_owner_topology_d on public.cloud_source_provider_access;
create trigger trg_cloud_source_access_background_owner_topology_i
before insert on public.cloud_source_provider_access
for each row execute function public.norva_catalog_background_owner_topology_guard();
create trigger trg_cloud_source_access_background_owner_topology_u
before update of provider_access_status,
  provider_access_hidden_at,
  provider_access_restored_at
on public.cloud_source_provider_access
for each row
when (
  old.provider_access_status is distinct from new.provider_access_status
  or old.provider_access_hidden_at is distinct from new.provider_access_hidden_at
  or old.provider_access_restored_at is distinct from new.provider_access_restored_at
)
execute function public.norva_catalog_background_owner_topology_guard();
create trigger trg_cloud_source_access_background_owner_topology_d
before delete on public.cloud_source_provider_access
for each row execute function public.norva_catalog_background_owner_topology_guard();

drop trigger if exists trg_cloud_source_heads_background_owner_topology_i on public.cloud_source_catalog_heads;
drop trigger if exists trg_cloud_source_heads_background_owner_topology_u on public.cloud_source_catalog_heads;
drop trigger if exists trg_cloud_source_heads_background_owner_topology_d on public.cloud_source_catalog_heads;
create trigger trg_cloud_source_heads_background_owner_topology_i
before insert on public.cloud_source_catalog_heads
for each row execute function public.norva_catalog_background_owner_head_topology_guard();
create trigger trg_cloud_source_heads_background_owner_topology_u
before update of active_generation_id on public.cloud_source_catalog_heads
for each row when (old.active_generation_id is distinct from new.active_generation_id)
execute function public.norva_catalog_background_owner_head_topology_guard();
create trigger trg_cloud_source_heads_background_owner_topology_d
before delete on public.cloud_source_catalog_heads
for each row execute function public.norva_catalog_background_owner_head_topology_guard();

revoke all on function
  public.norva_lock_catalog_background_owner_epoch(uuid),
  public.norva_mark_catalog_background_owner_sync(uuid),
  public.norva_mark_catalog_background_owner_stale(uuid),
  public.norva_sync_catalog_background_owner_title(uuid,uuid),
  public.norva_catalog_background_owner_sync_new_rows(),
  public.norva_catalog_background_owner_sync_old_rows(),
  public.norva_catalog_background_owner_sync_changed_rows(),
  public.norva_catalog_background_owner_epoch_changed(),
  public.norva_catalog_background_owner_topology_guard(),
  public.norva_catalog_background_owner_head_topology_guard()
from public, anon, authenticated, service_role;

do $assert$
declare
  v_trigger_count integer;
begin
  select count(*) into v_trigger_count
  from pg_trigger trigger_state
  where not trigger_state.tgisinternal
    and trigger_state.tgname in (
      'trg_cloud_titles_zy_background_owner_i',
      'trg_cloud_titles_zy_background_owner_u',
      'trg_candidate_titles_zy_background_owner_i',
      'trg_candidate_titles_zy_background_owner_u',
      'trg_candidate_titles_zy_background_owner_d',
      'trg_cloud_title_variants_zzz_background_owner_i',
      'trg_cloud_title_variants_zzz_background_owner_u',
      'trg_cloud_title_variants_zzz_background_owner_d',
      'trg_cloud_sources_background_owner_topology_i',
      'trg_cloud_sources_background_owner_topology_u',
      'trg_cloud_sources_background_owner_topology_d',
      'trg_cloud_source_lifecycle_background_owner_topology_i',
      'trg_cloud_source_lifecycle_background_owner_topology_u',
      'trg_cloud_source_lifecycle_background_owner_topology_d',
      'trg_cloud_source_access_background_owner_topology_i',
      'trg_cloud_source_access_background_owner_topology_u',
      'trg_cloud_source_access_background_owner_topology_d',
      'trg_cloud_source_heads_background_owner_topology_i',
      'trg_cloud_source_heads_background_owner_topology_u',
      'trg_cloud_source_heads_background_owner_topology_d'
    );
  if v_trigger_count <> 20
     or has_table_privilege(
       'service_role',
       'public.cloud_catalog_background_owner_sync_fences',
       'SELECT'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_sync_catalog_background_owner_title(uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_lock_catalog_background_owner_epoch(uuid)',
       'EXECUTE'
     ) then
    raise exception 'catalog background owner sync contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
