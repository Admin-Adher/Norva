begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Background catalogue work cannot derive its display owner after applying a
-- LIMIT: a shadowed global shell can otherwise consume every bounded page.
-- Keep a versioned, private owner snapshot and flip only its pointer at the
-- same user-visibility linearization point as a catalogue head change.
create table if not exists public.cloud_catalog_background_owner_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  transition_id uuid,
  base_snapshot_id uuid,
  snapshot_kind text not null check (snapshot_kind in ('baseline','candidate')),
  state text not null default 'building' check (
    state in (
      'building','ready','active','retained','stale',
      'purging','purged','failed'
    )
  ),
  replace_source_id uuid,
  replace_generation_id uuid,
  build_visibility_epoch bigint not null check (build_visibility_epoch >= 1),
  applied_visibility_epoch bigint not null check (applied_visibility_epoch >= 1),
  topology_revision bigint not null default 0 check (topology_revision >= 0),
  build_cursor uuid,
  row_count bigint not null default 0 check (row_count >= 0),
  revision bigint not null default 0 check (revision >= 0),
  completed_at timestamptz,
  activated_at timestamptz,
  retained_at timestamptz,
  stale_at timestamptz,
  purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  constraint cloud_catalog_background_snapshots_user_fk
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint cloud_catalog_background_snapshots_transition_fk
    foreign key (user_id, transition_id)
    references public.cloud_source_transitions(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_catalog_background_snapshots_base_fk
    foreign key (user_id, base_snapshot_id)
    references public.cloud_catalog_background_owner_snapshots(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_catalog_background_snapshots_generation_fk
    foreign key (replace_source_id, replace_generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict,
  constraint cloud_catalog_background_snapshots_shape_ck check (
    (
      snapshot_kind = 'baseline'
      and base_snapshot_id is null
      and replace_source_id is null
      and replace_generation_id is null
    )
    or (
      snapshot_kind = 'candidate'
      and transition_id is not null
      and (base_snapshot_id is not null
        or state in ('active','retained','stale','purging','purged','failed'))
      and replace_source_id is not null
      and replace_generation_id is not null
    )
  ),
  constraint cloud_catalog_background_snapshots_state_time_ck check (
    (state = 'building' and completed_at is null)
    or (state = 'ready' and completed_at is not null)
    or (state = 'active' and completed_at is not null and activated_at is not null)
    or (state = 'retained' and completed_at is not null
      and activated_at is not null and retained_at is not null)
    or state in ('stale','purging','purged','failed')
  )
);

alter table public.cloud_catalog_background_owner_snapshots
  add column if not exists topology_revision bigint not null default 0;

-- Visibility epochs also fence externally visible page cursors, but payload
-- refreshes legitimately advance them while a large owner snapshot is being
-- built.  Topology has a narrower durable revision: only a source/head
-- membership change advances it.  A snapshot built across such a change can
-- never be activated, even if the topology transaction started before the
-- snapshot row existed and therefore could not mark that row stale directly.
create table if not exists public.cloud_catalog_background_owner_topology_revisions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

drop index if exists
  public.cloud_catalog_background_snapshots_transition_kind_uidx;
create unique index
  cloud_catalog_background_snapshots_transition_kind_uidx
on public.cloud_catalog_background_owner_snapshots (
  transition_id, snapshot_kind
)
where transition_id is not null
  and state in ('building','ready','active','retained');

-- This table is new and remains unreachable until the final contract gate.
-- Recreate the evolving expand constraint exactly on rerun rather than
-- accepting a same-named stale definition from an interrupted pre-activation
-- rollout.
alter table public.cloud_catalog_background_owner_snapshots
  drop constraint if exists cloud_catalog_background_snapshots_shape_ck;
alter table public.cloud_catalog_background_owner_snapshots
  add constraint cloud_catalog_background_snapshots_shape_ck check (
    (
      snapshot_kind = 'baseline'
      and base_snapshot_id is null
      and replace_source_id is null
      and replace_generation_id is null
    )
    or (
      snapshot_kind = 'candidate'
      and transition_id is not null
      and (base_snapshot_id is not null
        or state in ('active','retained','stale','purging','purged','failed'))
      and replace_source_id is not null
      and replace_generation_id is not null
    )
  );

create unique index if not exists
  cloud_catalog_background_snapshots_one_building_uidx
on public.cloud_catalog_background_owner_snapshots (user_id)
where state = 'building';

create index if not exists cloud_catalog_background_snapshots_gc_idx
on public.cloud_catalog_background_owner_snapshots (
  state, purge_after, user_id, id
)
where state in ('retained','stale','purging');

create table if not exists public.cloud_catalog_background_owner_snapshot_sources (
  snapshot_id uuid not null,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, source_id),
  unique (snapshot_id, source_id, generation_id),
  constraint cloud_catalog_background_snapshot_sources_snapshot_fk
    foreign key (user_id, snapshot_id)
    references public.cloud_catalog_background_owner_snapshots(user_id, id)
    on update cascade on delete cascade,
  constraint cloud_catalog_background_snapshot_sources_generation_fk
    foreign key (source_id, generation_id)
    references public.cloud_source_catalog_generations(source_id, id)
    on update cascade on delete restrict
);

create index if not exists cloud_catalog_background_snapshot_sources_gen_idx
on public.cloud_catalog_background_owner_snapshot_sources (
  snapshot_id, generation_id, source_id
);

create table if not exists public.cloud_catalog_background_owner_snapshot_rows (
  snapshot_id uuid not null,
  user_id uuid not null,
  title_id uuid not null,
  is_present boolean not null default true,
  owner_source_id uuid not null,
  owner_generation_id uuid not null,
  storage_kind text not null check (storage_kind in ('projection','global')),
  item_type text not null check (item_type in ('movie','series')),
  provider_tmdb_id text,
  match_status text not null check (
    match_status in (
      'provider_unverified','provider_verified','matched',
      'weak','unmatched','manual'
    )
  ),
  title text not null check (btrim(title) <> ''),
  original_title text,
  release_year integer,
  poster_url text,
  backdrop_url text,
  catalog_metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(catalog_metadata) = 'object'
    and octet_length(catalog_metadata::text) <= 1048576
  ),
  payload_updated_at timestamptz not null,
  year_backfill_attempted_at timestamptz,
  revalidate_attempted_at timestamptz,
  search_match_attempted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (snapshot_id, title_id),
  constraint cloud_catalog_background_snapshot_rows_snapshot_fk
    foreign key (user_id, snapshot_id)
    references public.cloud_catalog_background_owner_snapshots(user_id, id)
    on update cascade on delete cascade,
  constraint cloud_catalog_background_snapshot_rows_title_fk
    foreign key (user_id, title_id)
    references public.cloud_titles(user_id, id)
    on update cascade on delete cascade,
  constraint cloud_catalog_background_snapshot_rows_owner_fk
    foreign key (snapshot_id, owner_source_id, owner_generation_id)
    references public.cloud_catalog_background_owner_snapshot_sources(
      snapshot_id, source_id, generation_id
    )
    on update cascade on delete restrict
);

alter table public.cloud_catalog_background_owner_snapshot_rows
  add column if not exists is_present boolean not null default true;

-- All three queues are ordered by the scheduling key, not title_id.  A tail
-- due item therefore remains reachable in O(log N) even when every earlier
-- title was attempted recently.  snapshot_id makes stale versions invisible
-- before the scan budget is consumed.
drop index if exists public.cloud_catalog_background_owner_year_due_idx;
create index cloud_catalog_background_owner_year_due_idx
on public.cloud_catalog_background_owner_snapshot_rows (
  snapshot_id,
  coalesce(year_backfill_attempted_at, '-infinity'::timestamptz),
  title_id
)
where is_present and release_year is null and provider_tmdb_id is not null;

drop index if exists public.cloud_catalog_background_owner_revalidate_due_idx;
create index cloud_catalog_background_owner_revalidate_due_idx
on public.cloud_catalog_background_owner_snapshot_rows (
  snapshot_id,
  coalesce(revalidate_attempted_at, '-infinity'::timestamptz),
  title_id
)
where is_present and match_status in ('provider_unverified','weak')
  and provider_tmdb_id is not null
  and provider_tmdb_id <> '0';

drop index if exists public.cloud_catalog_background_owner_search_due_idx;
create index cloud_catalog_background_owner_search_due_idx
on public.cloud_catalog_background_owner_snapshot_rows (
  snapshot_id,
  coalesce(search_match_attempted_at, '-infinity'::timestamptz),
  title_id
)
where is_present and match_status = 'unmatched';

create table if not exists public.cloud_catalog_background_owner_pointers (
  user_id uuid primary key,
  active_snapshot_id uuid not null,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  constraint cloud_catalog_background_owner_pointers_user_fk
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint cloud_catalog_background_owner_pointers_snapshot_fk
    foreign key (user_id, active_snapshot_id)
    references public.cloud_catalog_background_owner_snapshots(user_id, id)
    on update cascade on delete restrict
);

create table if not exists public.cloud_catalog_background_mode_checkpoints (
  mode text primary key check (
    mode in ('year_pending','revalidate_pending','search_pending')
  ),
  state text not null default 'pending' check (
    state in ('pending','processing')
  ),
  owner_user_id uuid,
  snapshot_id uuid,
  user_visibility_epoch bigint,
  retry_before timestamptz,
  last_attempted_at timestamptz,
  last_title_id uuid,
  inflight_items jsonb not null default '[]'::jsonb,
  inflight_last_attempted_at timestamptz,
  inflight_last_title_id uuid,
  inflight_owner_exhausted boolean not null default false,
  inflight_byte_count integer not null default 0,
  revision bigint not null default 0 check (revision >= 0),
  lease_sequence integer not null default 0 check (lease_sequence >= 0),
  lease_owner text,
  lease_until timestamptz,
  completed_cycles bigint not null default 0 check (completed_cycles >= 0),
  updated_at timestamptz not null default now(),
  constraint cloud_catalog_background_mode_checkpoint_shape_ck check (
    (
      state = 'processing'
      and lease_owner is not null
      and btrim(lease_owner) <> ''
      and length(lease_owner) <= 160
      and lease_until is not null
      and retry_before is not null
    )
    or (
      state = 'pending'
      and lease_owner is null
      and lease_until is null
    )
  ),
  constraint cloud_catalog_background_mode_checkpoint_cursor_ck check (
    (owner_user_id is null and snapshot_id is null
      and user_visibility_epoch is null
      and last_attempted_at is null and last_title_id is null)
    or (owner_user_id is not null and snapshot_id is not null
      and user_visibility_epoch >= 1)
  ),
  constraint cloud_catalog_background_mode_checkpoint_inflight_ck check (
    jsonb_typeof(inflight_items) = 'array'
    and octet_length(inflight_items::text) <= 2097152
    and inflight_byte_count between 0 and 2097152
    and (
      (jsonb_array_length(inflight_items) = 0
        and inflight_last_attempted_at is null
        and inflight_last_title_id is null
        and not inflight_owner_exhausted
        and inflight_byte_count = 0)
      or (state = 'processing'
        and jsonb_array_length(inflight_items) between 1 and 500
        and inflight_last_title_id is not null
        and inflight_byte_count = octet_length(inflight_items::text))
    )
  ),
  constraint cloud_catalog_background_mode_checkpoint_snapshot_fk
    foreign key (owner_user_id, snapshot_id)
    references public.cloud_catalog_background_owner_snapshots(user_id, id)
    on update cascade on delete restrict
);

-- Idempotent upgrade for scratch/rolling databases that applied an earlier
-- expand snapshot while this not-yet-activated contract was still moving.
alter table public.cloud_catalog_background_mode_checkpoints
  add column if not exists user_visibility_epoch bigint;
alter table public.cloud_catalog_background_mode_checkpoints
  add column if not exists inflight_items jsonb not null default '[]'::jsonb,
  add column if not exists inflight_last_attempted_at timestamptz,
  add column if not exists inflight_last_title_id uuid,
  add column if not exists inflight_owner_exhausted boolean not null default false,
  add column if not exists inflight_byte_count integer not null default 0;
-- The composite snapshot FK already proves the owner identity while assigned.
-- A direct auth FK would acquire an auth.users KEY SHARE lock after the walker
-- has locked the singleton checkpoint, inverting account deletion's inevitable
-- auth-user -> checkpoint order.  The BEFORE DELETE reset below is the exact
-- cascade fence and leaves no dangling assignment.
alter table public.cloud_catalog_background_mode_checkpoints
  drop constraint if exists cloud_catalog_background_mode_checkpoint_user_fk;
do $checkpoint_constraint$
begin
  if not exists (
    select 1 from pg_constraint constraint_state
    where constraint_state.conrelid =
      'public.cloud_catalog_background_mode_checkpoints'::regclass
      and constraint_state.conname =
        'cloud_catalog_background_mode_checkpoint_epoch_ck'
  ) then
    alter table public.cloud_catalog_background_mode_checkpoints
      add constraint cloud_catalog_background_mode_checkpoint_epoch_ck
      check (
        (owner_user_id is null and user_visibility_epoch is null)
        or (owner_user_id is not null and user_visibility_epoch >= 1)
      );
  end if;
end
$checkpoint_constraint$;
alter table public.cloud_catalog_background_mode_checkpoints
  drop constraint if exists cloud_catalog_background_mode_checkpoint_inflight_ck;
alter table public.cloud_catalog_background_mode_checkpoints
  add constraint cloud_catalog_background_mode_checkpoint_inflight_ck
  check (
    jsonb_typeof(inflight_items) = 'array'
    and octet_length(inflight_items::text) <= 2097152
    and inflight_byte_count between 0 and 2097152
    and (
      (jsonb_array_length(inflight_items) = 0
        and inflight_last_attempted_at is null
        and inflight_last_title_id is null
        and not inflight_owner_exhausted
        and inflight_byte_count = 0)
      or (state = 'processing'
        and jsonb_array_length(inflight_items) between 1 and 500
        and inflight_last_title_id is not null
        and inflight_byte_count = octet_length(inflight_items::text))
    )
  );

insert into public.cloud_catalog_background_mode_checkpoints(mode)
values ('year_pending'),('revalidate_pending'),('search_pending')
on conflict (mode) do nothing;

create or replace function public.norva_catalog_background_owner_user_delete_reset()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_delete_fence text := coalesce(
    current_setting('norva.catalog_background_owner_deleted_users',true),'|'
  );
begin
  perform set_config(
    'norva.catalog_background_owner_deleted_users',
    v_delete_fence || old.id::text || '|',true
  );
  perform 1
  from public.cloud_catalog_background_mode_checkpoints checkpoint
  where checkpoint.owner_user_id = old.id
  order by checkpoint.mode
  for update;
  update public.cloud_catalog_background_mode_checkpoints checkpoint
  set state = 'pending',
      owner_user_id = null,
      snapshot_id = null,
      user_visibility_epoch = null,
      retry_before = null,
      last_attempted_at = null,
      last_title_id = null,
      inflight_items = '[]'::jsonb,
      inflight_last_attempted_at = null,
      inflight_last_title_id = null,
      inflight_owner_exhausted = false,
      inflight_byte_count = 0,
      lease_owner = null,
      lease_until = null,
      revision = checkpoint.revision + 1,
      updated_at = now()
  where checkpoint.owner_user_id = old.id;
  return old;
end
$function$;

drop trigger if exists trg_auth_users_catalog_background_owner_reset
  on auth.users;
create trigger trg_auth_users_catalog_background_owner_reset
before delete on auth.users
for each row execute function
  public.norva_catalog_background_owner_user_delete_reset();

revoke all on function
  public.norva_catalog_background_owner_user_delete_reset()
from public, anon, authenticated, service_role;

alter table public.cloud_catalog_background_owner_snapshots enable row level security;
alter table public.cloud_catalog_background_owner_topology_revisions enable row level security;
alter table public.cloud_catalog_background_owner_snapshot_sources enable row level security;
alter table public.cloud_catalog_background_owner_snapshot_rows enable row level security;
alter table public.cloud_catalog_background_owner_pointers enable row level security;
alter table public.cloud_catalog_background_mode_checkpoints enable row level security;

revoke all on table
  public.cloud_catalog_background_owner_snapshots,
  public.cloud_catalog_background_owner_topology_revisions,
  public.cloud_catalog_background_owner_snapshot_sources,
  public.cloud_catalog_background_owner_snapshot_rows,
  public.cloud_catalog_background_owner_pointers,
  public.cloud_catalog_background_mode_checkpoints
from public, anon, authenticated, service_role;

do $assert$
declare
  v_private boolean;
  v_rls boolean;
begin
  select bool_and(not has_table_privilege(role_name, relation_name, 'SELECT'))
    into v_private
  from (values
    ('anon'),('authenticated'),('service_role')
  ) role_list(role_name)
  cross join (values
    ('public.cloud_catalog_background_owner_snapshots'),
    ('public.cloud_catalog_background_owner_topology_revisions'),
    ('public.cloud_catalog_background_owner_snapshot_sources'),
    ('public.cloud_catalog_background_owner_snapshot_rows'),
    ('public.cloud_catalog_background_owner_pointers'),
    ('public.cloud_catalog_background_mode_checkpoints')
  ) relation_list(relation_name);

  select bool_and(class.relrowsecurity)
    into v_rls
  from pg_class class
  join pg_namespace namespace on namespace.oid = class.relnamespace
  where namespace.nspname = 'public'
    and class.relname in (
      'cloud_catalog_background_owner_snapshots',
      'cloud_catalog_background_owner_topology_revisions',
      'cloud_catalog_background_owner_snapshot_sources',
      'cloud_catalog_background_owner_snapshot_rows',
      'cloud_catalog_background_owner_pointers',
      'cloud_catalog_background_mode_checkpoints'
    );

  if not coalesce(v_private,false)
     or not coalesce(v_rls,false)
     or (select count(*) from public.cloud_catalog_background_mode_checkpoints) <> 3
     or to_regclass('public.cloud_catalog_background_owner_year_due_idx') is null
     or to_regclass('public.cloud_catalog_background_owner_revalidate_due_idx') is null
     or to_regclass('public.cloud_catalog_background_owner_search_due_idx') is null
     or not exists (
       select 1 from pg_catalog.pg_trigger trigger_state
       where trigger_state.tgrelid = 'auth.users'::regclass
         and trigger_state.tgname =
           'trg_auth_users_catalog_background_owner_reset'
         and trigger_state.tgenabled = 'O'
         and not trigger_state.tgisinternal
     ) then
    raise exception 'catalog background owner snapshot schema drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
