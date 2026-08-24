begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

do $prerequisite$
begin
  if to_regclass('public.cloud_source_direct_fallback_leases') is null then
    raise exception 'provider account deletion requires migration 20260823174000_provider_direct_fallback_source_lease.sql'
      using errcode = '55000',
            detail = 'missing_relation=public.cloud_source_direct_fallback_leases';
  end if;
end
$prerequisite$;

-- Account deletion is prepared in bounded, reconstructible batches.  The auth
-- row is retained until the durable provider-subgraph proof reaches READY.
-- This contract makes no boundedness claim for unrelated account-wide auth
-- cascades (billing/paywall/analytics retention is a separate deployment
-- gate).  This migration does not enable a feature flag.
create table if not exists public.cloud_provider_account_delete_preparations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state text not null default 'pending' check (
    state in ('pending','processing','ready','dead')
  ),
  phase text not null default 'drain' check (
    phase in (
      'drain','sources_pending','playback','owner','heads','payload',
      'generation_control','generations','titles',
      'transition_control','transitions','source_control','verify','ready'
    )
  ),
  deletion_epoch bigint not null default 1 check (deletion_epoch >= 1),
  generation_cursor uuid,
  delete_relation text,
  delete_filter_column name,
  delete_filter_value uuid,
  delete_cursor jsonb not null default '{}'::jsonb check (
    jsonb_typeof(delete_cursor) = 'object'
  ),
  revision bigint not null default 0 check (revision >= 0),
  lease_sequence integer not null default 0 check (lease_sequence >= 0),
  lease_owner text,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  failure_attempt_count integer not null default 0 check (
    failure_attempt_count >= 0
  ),
  max_attempts integer not null default 25 check (max_attempts between 1 and 100),
  deleted_rows bigint not null default 0 check (deleted_rows >= 0),
  mutated_rows bigint not null default 0 check (mutated_rows >= 0),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_provider_account_delete_preparations_lease_ck check (
    (state = 'processing' and lease_owner is not null
      and btrim(lease_owner) <> '' and length(lease_owner) <= 160
      and lease_until is not null)
    or (state <> 'processing' and lease_owner is null and lease_until is null)
  ),
  constraint cloud_provider_account_delete_preparations_ready_ck check (
    (state = 'ready' and phase = 'ready' and ready_at is not null)
    or (state <> 'ready' and phase <> 'ready' and ready_at is null)
  )
);

-- Rerunning this split migration against a compile database created from an
-- earlier draft must converge to the same shape without weakening any check.
alter table public.cloud_provider_account_delete_preparations
  add column if not exists deletion_epoch bigint not null default 1,
  add column if not exists mutated_rows bigint not null default 0,
  add column if not exists delete_relation text,
  add column if not exists delete_filter_column name,
  add column if not exists delete_filter_value uuid,
  add column if not exists delete_cursor jsonb not null default '{}'::jsonb;
alter table public.cloud_provider_account_delete_preparations
  drop constraint if exists cloud_provider_account_delete_preparations_delete_cursor_ck;
alter table public.cloud_provider_account_delete_preparations
  add constraint cloud_provider_account_delete_preparations_delete_cursor_ck check (
    jsonb_typeof(delete_cursor) = 'object'
    and (
      (delete_relation is null and delete_filter_column is null
        and delete_filter_value is null and delete_cursor = '{}'::jsonb)
      or (delete_relation is not null and delete_filter_column is not null
        and delete_filter_value is not null)
    )
  );
alter table public.cloud_provider_account_delete_preparations
  drop constraint if exists cloud_provider_account_delete_preparations_phase_check;
alter table public.cloud_provider_account_delete_preparations
  add constraint cloud_provider_account_delete_preparations_phase_check check (
    phase in (
      'drain','sources_pending','playback','owner','heads','payload',
      'generation_control','generations','titles',
      'transition_control','transitions',
      'source_control','verify','ready'
    )
  );

commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

alter table public.cloud_sources
  add column if not exists provider_deletion_pending boolean not null default false,
  add column if not exists provider_deletion_epoch bigint not null default 0;
do $source_check$
declare
  v_constraint pg_catalog.pg_constraint%rowtype;
  v_epoch_attnum smallint;
begin
  select attribute.attnum into strict v_epoch_attnum
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid = 'public.cloud_sources'::regclass
    and attribute.attname = 'provider_deletion_epoch'
    and not attribute.attisdropped;
  select constraint_state.* into v_constraint
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid = 'public.cloud_sources'::regclass
    and constraint_state.conname = 'cloud_sources_provider_deletion_epoch_ck';
  if found then
    if v_constraint.contype <> 'c'
       or v_constraint.conkey <> array[v_epoch_attnum]::smallint[] then
      raise exception 'cloud_sources deletion epoch check homonym is noncanonical'
        using errcode = '55000';
    end if;
  else
    alter table public.cloud_sources
      add constraint cloud_sources_provider_deletion_epoch_ck check (
        provider_deletion_epoch >= 0
      ) not valid;
  end if;
end
$source_check$;

commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';
alter table public.cloud_sources
  validate constraint cloud_sources_provider_deletion_epoch_ck;
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

-- A provider-call permit is deliberately distinct from a worker/job lease.
-- The lease says who may mutate durable job state; this short-lived row says
-- whether an external provider HTTP call is still legal at the exact account
-- and source deletion epochs.  Every route is bound to one durable authority.
create table if not exists public.cloud_provider_call_permits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  source_id uuid not null references public.cloud_sources(id) on delete restrict,
  transition_id uuid references public.cloud_source_transitions(id) on delete restrict,
  job_id uuid references public.cloud_source_credential_transition_jobs(id) on delete restrict,
  direct_fallback_lease_token uuid references
    public.cloud_source_direct_fallback_leases(lease_token) on delete cascade,
  playback_session_id uuid references public.cloud_playback_sessions(id) on delete cascade,
  permit_token uuid not null unique default gen_random_uuid(),
  permit_owner text not null check (
    btrim(permit_owner) <> '' and length(permit_owner) <= 160
  ),
  authorization_kind text not null check (
    authorization_kind in ('credential_job','direct_fallback','playback')
  ),
  expected_account_deletion_epoch bigint not null check (
    expected_account_deletion_epoch >= 0
  ),
  expected_source_deletion_epoch bigint not null check (
    expected_source_deletion_epoch >= 0
  ),
  expected_job_lease_sequence integer,
  max_http_timeout_ms integer not null check (
    max_http_timeout_ms between 1000 and 120000
  ),
  max_response_bytes integer not null check (
    max_response_bytes between 1024 and 33554432
  ),
  operation_kind text not null check (
    operation_kind in (
      'account_info','catalog_page','metadata_spool',
      'playback_stream','direct_fallback'
    )
  ),
  operation_id_hash text check (
    operation_id_hash is null or operation_id_hash ~ '^[0-9a-f]{64}$'
  ),
  safety_margin_seconds integer not null default 10 check (
    safety_margin_seconds between 10 and 30
  ),
  state text not null default 'active' check (
    state in ('active','released','expired')
  ),
  acquired_at timestamptz not null default clock_timestamp(),
  permit_until timestamptz not null,
  released_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint cloud_provider_call_permits_authority_ck check (
    (authorization_kind = 'credential_job'
      and transition_id is not null and job_id is not null
      and expected_job_lease_sequence is not null
      and direct_fallback_lease_token is null and playback_session_id is null)
    or (authorization_kind = 'direct_fallback'
      and transition_id is null and job_id is null
      and expected_job_lease_sequence is null
      and direct_fallback_lease_token is not null
      and playback_session_id is null)
    or (authorization_kind = 'playback'
      and transition_id is null and job_id is null
      and expected_job_lease_sequence is null
      and direct_fallback_lease_token is null
      and playback_session_id is not null)
  ),
  constraint cloud_provider_call_permits_terminal_ck check (
    (state = 'active' and released_at is null)
    or (state in ('released','expired') and released_at is not null)
  ),
  constraint cloud_provider_call_permits_timeout_ck check (
    permit_until > acquired_at
    and permit_until > acquired_at
      + make_interval(secs => safety_margin_seconds)
      + make_interval(secs => ((max_http_timeout_ms + 999) / 1000))
  )
);
create index if not exists cloud_provider_call_permits_user_active_idx
  on public.cloud_provider_call_permits(user_id,permit_until,id)
  where state = 'active';
create index if not exists norva_adk_011a8fdc4821_idx
  on public.cloud_provider_call_permits(user_id,id);
-- The permit table is introduced by this migration, after the standalone
-- online-index unit.  Create its account-delete playback cursor index here so
-- a pristine replay never references a relation that does not yet exist.
create index if not exists norva_adk_playback_permit_idx
  on public.cloud_provider_call_permits(playback_session_id,id);
create index if not exists cloud_provider_call_permits_source_active_idx
  on public.cloud_provider_call_permits(source_id,permit_until,id)
  where state = 'active';
create index if not exists cloud_provider_call_permits_source_gc_idx
  on public.cloud_provider_call_permits(source_id,id);
do $permit_authority_fk$
declare
  v_delete_action "char";
begin
  select constraint_state.confdeltype into v_delete_action
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid = 'public.cloud_provider_call_permits'::regclass
    and constraint_state.conname =
      'cloud_provider_call_permits_direct_fallback_lease_token_fkey';
  if v_delete_action is distinct from 'c'::"char" then
    alter table public.cloud_provider_call_permits
      drop constraint if exists
        cloud_provider_call_permits_direct_fallback_lease_token_fkey;
    alter table public.cloud_provider_call_permits
      add constraint cloud_provider_call_permits_direct_fallback_lease_token_fkey
      foreign key (direct_fallback_lease_token) references
        public.cloud_source_direct_fallback_leases(lease_token)
        on delete cascade;
  end if;
  select constraint_state.confdeltype into v_delete_action
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid = 'public.cloud_provider_call_permits'::regclass
    and constraint_state.conname =
      'cloud_provider_call_permits_playback_session_id_fkey';
  if v_delete_action is distinct from 'c'::"char" then
    alter table public.cloud_provider_call_permits
      drop constraint if exists
        cloud_provider_call_permits_playback_session_id_fkey;
    alter table public.cloud_provider_call_permits
      add constraint cloud_provider_call_permits_playback_session_id_fkey
      foreign key (playback_session_id) references
        public.cloud_playback_sessions(id) on delete cascade;
  end if;
end
$permit_authority_fk$;

create table if not exists public.cloud_provider_transport_stop_actions (
  user_id uuid primary key references
    public.cloud_provider_account_delete_preparations(user_id)
    on delete cascade,
  deletion_epoch bigint not null check (deletion_epoch >= 1),
  state text not null default 'pending' check (
    state in ('pending','processing','completed','dead')
  ),
  revision bigint not null default 0 check (revision >= 0),
  lease_sequence integer not null default 0 check (lease_sequence >= 0),
  lease_owner text,
  lease_until timestamptz,
  failure_attempt_count integer not null default 0 check (
    failure_attempt_count between 0 and 25
  ),
  max_attempts integer not null default 25 check (max_attempts between 1 and 25),
  available_at timestamptz not null default now(),
  completed_at timestamptz,
  transport_stop_receipt_hash text check (
    transport_stop_receipt_hash is null
    or transport_stop_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_provider_transport_stop_actions_lease_ck check (
    (state = 'processing' and lease_owner is not null
      and btrim(lease_owner) <> '' and length(lease_owner) <= 160
      and lease_until is not null)
    or (state <> 'processing' and lease_owner is null and lease_until is null)
  ),
  constraint cloud_provider_transport_stop_actions_completed_ck check (
    (state = 'completed' and completed_at is not null
      and transport_stop_receipt_hash is not null)
    or (state <> 'completed' and completed_at is null
      and transport_stop_receipt_hash is null)
  )
);
alter table public.cloud_provider_transport_stop_actions enable row level security;
revoke all on table public.cloud_provider_transport_stop_actions
from public,anon,authenticated,service_role;

alter table public.cloud_provider_account_delete_preparations
  enable row level security;
revoke all on table public.cloud_provider_account_delete_preparations
from public,anon,authenticated,service_role;
alter table public.cloud_provider_call_permits enable row level security;
revoke all on table public.cloud_provider_call_permits
from public,anon,authenticated,service_role;


commit;
