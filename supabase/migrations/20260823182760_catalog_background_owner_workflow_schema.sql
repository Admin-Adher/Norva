begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The discovery cursors make the global bootstrap/stale scan bounded and
-- crash-safe.  They deliberately walk physical keyspaces, not only rows that
-- currently need work, so an all-current population is not rescanned from the
-- beginning on every worker claim.
create table if not exists public.cloud_catalog_background_owner_discovery_cursors (
  discovery_kind text primary key check (
    discovery_kind in ('baseline','candidate','gc')
  ),
  last_key uuid,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

insert into public.cloud_catalog_background_owner_discovery_cursors (
  discovery_kind,last_key,revision,updated_at
) values
  ('baseline',null,0,now()),
  ('candidate',null,0,now()),
  ('gc',null,0,now())
on conflict (discovery_kind) do nothing;

create table if not exists public.cloud_catalog_background_owner_build_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_kind text not null check (
    job_kind in ('baseline','candidate','gc')
  ),
  transition_id uuid,
  snapshot_id uuid,
  base_snapshot_id uuid,
  replace_source_id uuid,
  replace_generation_id uuid,
  state text not null default 'pending' check (
    state in ('pending','processing','completed','dead')
  ),
  lease_sequence integer not null default 0 check (lease_sequence >= 0),
  checkpoint_revision bigint not null default 0
    check (checkpoint_revision >= 0),
  expected_snapshot_revision bigint check (
    expected_snapshot_revision is null or expected_snapshot_revision >= 0
  ),
  expected_visibility_epoch bigint check (
    expected_visibility_epoch is null or expected_visibility_epoch >= 1
  ),
  expected_topology_revision bigint check (
    expected_topology_revision is null or expected_topology_revision >= 0
  ),
  failure_attempt_count integer not null default 0
    check (failure_attempt_count between 0 and 25),
  max_attempts integer not null default 25 check (max_attempts between 1 and 25),
  available_at timestamptz not null default now(),
  lease_owner text check (
    lease_owner is null or (
      btrim(lease_owner) <> '' and length(lease_owner) <= 160
      and lease_owner !~ '[[:cntrl:]]'
    )
  ),
  lease_until timestamptz,
  last_error_code text check (
    last_error_code is null or last_error_code in (
      'lease_expired','snapshot_stale','transition_cancelled',
      'topology_changed','internal_error'
    )
  ),
  completed_at timestamptz,
  dead_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_catalog_background_owner_jobs_user_fk
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint cloud_catalog_background_owner_jobs_transition_fk
    foreign key (user_id,transition_id)
    references public.cloud_source_transitions(user_id,id)
    on update cascade on delete cascade,
  constraint cloud_catalog_background_owner_jobs_snapshot_fk
    foreign key (snapshot_id)
    references public.cloud_catalog_background_owner_snapshots(id)
    on update cascade on delete set null,
  constraint cloud_catalog_background_owner_jobs_base_snapshot_fk
    foreign key (base_snapshot_id)
    references public.cloud_catalog_background_owner_snapshots(id)
    on update cascade on delete set null,
  constraint cloud_catalog_background_owner_jobs_generation_fk
    foreign key (replace_source_id,replace_generation_id)
    references public.cloud_source_catalog_generations(source_id,id)
    on update cascade on delete restrict,
  constraint cloud_catalog_background_owner_jobs_shape_ck check (
    (
      job_kind = 'candidate'
      and transition_id is not null
      and replace_source_id is not null
      and replace_generation_id is not null
    ) or (
      job_kind in ('baseline','gc')
      and transition_id is null
      and replace_source_id is null
      and replace_generation_id is null
      and base_snapshot_id is null
    )
  ),
  constraint cloud_catalog_background_owner_jobs_lease_ck check (
    (state = 'processing' and lease_owner is not null and lease_until is not null)
    or (state <> 'processing' and lease_owner is null and lease_until is null)
  ),
  constraint cloud_catalog_background_owner_jobs_terminal_ck check (
    (state = 'completed' and completed_at is not null and dead_at is null)
    or (state = 'dead' and dead_at is not null and completed_at is null)
    or (state in ('pending','processing')
      and completed_at is null and dead_at is null)
  )
);

create unique index if not exists
  cloud_catalog_background_owner_jobs_one_user_kind_uidx
on public.cloud_catalog_background_owner_build_jobs (user_id,job_kind)
where state in ('pending','processing') and job_kind in ('baseline','gc');

create unique index if not exists
  cloud_catalog_background_owner_jobs_one_transition_uidx
on public.cloud_catalog_background_owner_build_jobs (transition_id,job_kind)
where state in ('pending','processing') and job_kind = 'candidate';

create index if not exists cloud_catalog_background_owner_jobs_claim_idx
on public.cloud_catalog_background_owner_build_jobs (
  state,available_at,lease_until,created_at,id
);

create index if not exists cloud_catalog_background_owner_jobs_user_idx
on public.cloud_catalog_background_owner_build_jobs (
  user_id,state,job_kind,created_at,id
);

alter table public.cloud_catalog_background_owner_discovery_cursors
  enable row level security;
alter table public.cloud_catalog_background_owner_build_jobs
  enable row level security;
revoke all on table
  public.cloud_catalog_background_owner_discovery_cursors,
  public.cloud_catalog_background_owner_build_jobs
from public,anon,authenticated,service_role;

do $assert$
begin
  if not coalesce((
       select bool_and(class.relrowsecurity)
       from pg_catalog.pg_class class
       where class.oid in (
         'public.cloud_catalog_background_owner_discovery_cursors'::regclass,
         'public.cloud_catalog_background_owner_build_jobs'::regclass
       )
     ),false)
     or has_table_privilege(
       'service_role',
       'public.cloud_catalog_background_owner_build_jobs','SELECT'
     )
     or has_table_privilege(
       'authenticated',
       'public.cloud_catalog_background_owner_build_jobs','SELECT'
     )
     or has_table_privilege(
       'anon',
       'public.cloud_catalog_background_owner_discovery_cursors','SELECT'
     )
     or not exists (
       select 1 from pg_catalog.pg_index index_state
       where index_state.indexrelid =
         'public.cloud_catalog_background_owner_jobs_claim_idx'::regclass
         and index_state.indisvalid and index_state.indisready
     ) then
    raise exception 'catalog background owner workflow schema drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
