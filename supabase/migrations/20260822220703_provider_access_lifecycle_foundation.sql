begin;
set local lock_timeout = '2s';
set local statement_timeout = '5min';

-- Provider-access lifecycle foundation.
--
-- This migration is intentionally additive at the data-model layer and keeps
-- every feature flag OFF.  Staging isolation itself is not flag-gated: once a
-- lifecycle row is hidden/staging it must never enter a user-facing read.

-- The six OFF flag rows are installed by the first short post-foundation unit.
-- Keeping this long definition transaction free of writes to existing tables
-- avoids holding application row locks while the routines are parsed.

-- Account-wide, monotone cache token. A per-source maximum is insufficient:
-- another source can already own a larger epoch and mask a later change.
create table public.cloud_user_catalog_visibility_epochs (
  user_id uuid primary key,
  visibility_epoch bigint not null default 1 check (visibility_epoch >= 1),
  updated_at timestamptz not null default now()
);

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
  ) values (
    -- A missing row has the externally observable immutable baseline 1.  The
    -- first catalog mutation must therefore acknowledge 1 -> 2 rather than
    -- materialising the baseline after the mutation already happened.
    p_user_id, 2, now()
  )
  on conflict (user_id) do update
  set visibility_epoch = epoch.visibility_epoch + 1,
      updated_at = now()
  returning visibility_epoch into v_epoch;
  return v_epoch;
end
$function$;

revoke all on function public.norva_bump_user_catalog_visibility_epoch(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.norva_user_catalog_visibility_epoch(
  p_user_id uuid
) returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := nullif(auth.jwt() ->> 'role', '');
  v_setting_role text := nullif(current_setting('request.jwt.claim.role', true), '');
  v_sql_role text := nullif(current_setting('role', true), 'none');
  v_epoch bigint;
begin
  if p_user_id is null then return null; end if;
  if coalesce(v_jwt_role, v_setting_role, v_sql_role, '') <> 'service_role'
     and not ((v_sql_role is null or v_sql_role = 'postgres') and session_user = 'postgres')
     and auth.uid() is distinct from p_user_id then
    return null;
  end if;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id;
  return coalesce(v_epoch, 1);
end
$function$;

revoke all on function public.norva_user_catalog_visibility_epoch(uuid)
  from public, anon;
grant execute on function public.norva_user_catalog_visibility_epoch(uuid)
  to authenticated, service_role;

-- Composite tenant foreign keys below rely on the canonical concurrent index
-- installed by 20260822220000.  Their definitions are applied after this long
-- function transaction in short, per-table migrations.

create table public.cloud_source_lifecycle (
  source_id uuid primary key,
  user_id uuid not null,
  lifecycle_state text not null default 'active'
    check (lifecycle_state in (
      'active', 'staging', 'replaced', 'purge_pending', 'purged'
    )),
  catalog_visibility text not null default 'visible'
    check (catalog_visibility in ('visible', 'hidden')),
  replacement_root_id uuid not null,
  replaces_source_id uuid,
  replaced_by_source_id uuid,
  config_revision bigint not null default 0 check (config_revision >= 0),
  visibility_epoch bigint not null default 1 check (visibility_epoch >= 1),
  activated_at timestamptz,
  hidden_at timestamptz,
  rollback_until timestamptz,
  purge_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_source_lifecycle_visibility_ck check (
    (lifecycle_state = 'active' and catalog_visibility = 'visible')
    or
    (lifecycle_state <> 'active' and catalog_visibility = 'hidden')
  ),
  constraint cloud_source_lifecycle_links_ck check (
    source_id is distinct from replaces_source_id
    and source_id is distinct from replaced_by_source_id
    and (
      replaces_source_id is null
      or replaced_by_source_id is null
      or replaces_source_id <> replaced_by_source_id
    )
  ),
  constraint cloud_source_lifecycle_replaced_link_ck check (
    replaced_by_source_id is null
    or lifecycle_state in ('replaced', 'purge_pending', 'purged')
  ),
  constraint cloud_source_lifecycle_purge_window_ck check (
    purge_after is null
    or rollback_until is null
    or purge_after >= rollback_until
  )
);

create unique index cloud_source_lifecycle_one_visible_root_uidx
  on public.cloud_source_lifecycle (user_id, replacement_root_id)
  where lifecycle_state = 'active' and catalog_visibility = 'visible';

create index cloud_source_lifecycle_replaces_idx
  on public.cloud_source_lifecycle (user_id, replaces_source_id)
  where replaces_source_id is not null;

create index cloud_source_lifecycle_replaced_by_idx
  on public.cloud_source_lifecycle (user_id, replaced_by_source_id)
  where replaced_by_source_id is not null;

create table public.cloud_source_provider_access (
  source_id uuid primary key,
  user_id uuid not null,
  provider_access_status text not null default 'unknown'
    check (provider_access_status in (
      'unknown',
      'active',
      'expiring',
      'expected_expired',
      'expired_confirmed',
      'access_unavailable_confirmed',
      'check_failed_temporary',
      'restoring'
    )),
  provider_access_started_on date,
  provider_access_expires_on date,
  provider_access_expiry_source text
    check (provider_access_expiry_source is null or provider_access_expiry_source in (
      'user_entered', 'provider_reported', 'inferred'
    )),
  provider_access_manual_override boolean not null default false,
  provider_access_reminders_enabled boolean not null default false,
  provider_access_last_checked_at timestamptz,
  provider_access_last_confirmed_active_at timestamptz,
  provider_access_last_detected_at timestamptz,
  provider_access_hidden_at timestamptz,
  provider_access_restored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_source_provider_access_dates_ck check (
    provider_access_started_on is null
    or provider_access_expires_on is null
    or provider_access_expires_on >= provider_access_started_on
  )
);

create index cloud_source_provider_access_status_idx
  on public.cloud_source_provider_access (user_id, provider_access_status, source_id);

create table public.cloud_source_access_cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  started_on date,
  expires_on date,
  term_value integer,
  term_unit text check (term_unit is null or term_unit in ('day', 'week', 'month', 'year')),
  origin text not null check (origin in ('provider_reported', 'user_entered')),
  status text not null default 'active' check (status in ('active', 'superseded', 'ended')),
  created_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (user_id, id),
  constraint cloud_source_access_cycles_term_ck check (
    (term_value is null and term_unit is null)
    or (term_value is not null and term_value > 0 and term_unit is not null)
  ),
  constraint cloud_source_access_cycles_dates_ck check (
    started_on is null or expires_on is null or expires_on >= started_on
  ),
  constraint cloud_source_access_cycles_superseded_at_ck check (
    (status = 'active' and superseded_at is null)
    or status <> 'active'
  )
);

create unique index cloud_source_access_cycles_one_active_uidx
  on public.cloud_source_access_cycles (source_id)
  where status = 'active';

create index cloud_source_access_cycles_user_source_idx
  on public.cloud_source_access_cycles (user_id, source_id, created_at desc);

create table public.cloud_source_transitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  transition_kind text not null check (transition_kind in ('credential', 'replacement')),
  old_source_id uuid not null,
  candidate_source_id uuid,
  state text not null default 'validating' check (state in (
    'validating',
    'staging',
    'importing',
    'ready_to_switch',
    'committing',
    'completed',
    'failed',
    'cancelled'
  )),
  identity_decision text check (
    identity_decision is null
    or identity_decision in ('same_catalog', 'different_catalog', 'ambiguous')
  ),
  decision_origin text check (
    decision_origin is null or decision_origin in ('automatic', 'manual')
  ),
  idempotency_key text not null check (
    btrim(idempotency_key) <> '' and length(idempotency_key) <= 200
  ),
  candidate_secret_ref text check (
    candidate_secret_ref is null or (
      btrim(candidate_secret_ref) <> '' and length(candidate_secret_ref) <= 512
    )
  ),
  previous_secret_ref text check (
    previous_secret_ref is null or (
      btrim(previous_secret_ref) <> '' and length(previous_secret_ref) <= 512
    )
  ),
  readiness_check_id uuid,
  readiness_passed_at timestamptz,
  expected_catalog_version bigint check (
    expected_catalog_version is null or expected_catalog_version >= 0
  ),
  import_counts jsonb not null default '{}'::jsonb check (
    jsonb_typeof(import_counts) = 'object'
    and octet_length(import_counts::text) <= 32768
  ),
  validation_summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(validation_summary) = 'object'
    and octet_length(validation_summary::text) <= 32768
  ),
  expected_source_revision bigint not null check (expected_source_revision >= 0),
  expected_candidate_revision bigint check (
    expected_candidate_revision is null or expected_candidate_revision >= 0
  ),
  revision bigint not null default 0 check (revision >= 0),
  promotion_idempotency_key text check (
    promotion_idempotency_key is null or (
      btrim(promotion_idempotency_key) <> ''
      and length(promotion_idempotency_key) <= 200
    )
  ),
  promotion_expected_source_revision bigint check (
    promotion_expected_source_revision is null
    or promotion_expected_source_revision >= 0
  ),
  promotion_expected_transition_revision bigint check (
    promotion_expected_transition_revision is null
    or promotion_expected_transition_revision >= 0
  ),
  promotion_result jsonb check (
    promotion_result is null
    or (jsonb_typeof(promotion_result) = 'object' and octet_length(promotion_result::text) <= 8192)
  ),
  started_at timestamptz not null default now(),
  ready_at timestamptz,
  committing_at timestamptz,
  completed_at timestamptz,
  rollback_until timestamptz,
  reversal_of_transition_id uuid,
  failure_code text check (
    failure_code is null or (btrim(failure_code) <> '' and length(failure_code) <= 120)
  ),
  created_by text check (created_by is null or length(created_by) <= 200),
  approved_by text check (approved_by is null or length(approved_by) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, idempotency_key),
  constraint cloud_source_transitions_reversal_owner_fk
    foreign key (user_id, reversal_of_transition_id)
    references public.cloud_source_transitions(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_transitions_kind_ck check (
    (transition_kind = 'credential'
      and candidate_source_id is null
      and candidate_secret_ref is not null
      and expected_candidate_revision is null)
    or
    (transition_kind = 'replacement'
      and candidate_source_id is not null
      and candidate_source_id <> old_source_id
      and expected_candidate_revision is not null)
  ),
  constraint cloud_source_transitions_reversal_kind_ck check (
    reversal_of_transition_id is null or transition_kind = 'replacement'
  ),
  constraint cloud_source_transitions_decision_origin_ck check (
    (identity_decision is null and decision_origin is null)
    or
    (identity_decision is not null and decision_origin is not null)
  ),
  constraint cloud_source_transitions_completed_payload_ck check (
    state <> 'completed'
    or transition_kind = 'credential'
    or (
      promotion_idempotency_key is not null
      and promotion_expected_source_revision is not null
      and promotion_expected_transition_revision is not null
      and promotion_result is not null
    )
  )
);

create unique index cloud_source_transitions_one_nonterminal_old_uidx
  on public.cloud_source_transitions (old_source_id)
  where state not in ('completed', 'failed', 'cancelled');

create unique index cloud_source_transitions_one_nonterminal_candidate_uidx
  on public.cloud_source_transitions (candidate_source_id)
  where candidate_source_id is not null
    and state not in ('completed', 'failed', 'cancelled');

create index cloud_source_transitions_user_state_idx
  on public.cloud_source_transitions (user_id, state, created_at desc);

create table public.cloud_source_identity_assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  transition_id uuid not null,
  algorithm_version text not null check (
    btrim(algorithm_version) <> '' and length(algorithm_version) <= 120
  ),
  old_identity_id uuid,
  candidate_identity_id uuid,
  sample_size_old integer not null default 0 check (sample_size_old >= 0),
  sample_size_new integer not null default 0 check (sample_size_new >= 0),
  overlap_count integer not null default 0 check (
    overlap_count >= 0
    and overlap_count <= least(sample_size_old, sample_size_new)
  ),
  similarity_score numeric(6,5) check (
    similarity_score is null or (similarity_score >= 0 and similarity_score <= 1)
  ),
  secondary_signals jsonb not null default '{}'::jsonb check (
    jsonb_typeof(secondary_signals) = 'object'
    and octet_length(secondary_signals::text) <= 32768
  ),
  automatic_decision text not null check (
    automatic_decision in ('same_catalog', 'different_catalog', 'ambiguous')
  ),
  final_decision text check (
    final_decision is null
    or final_decision in ('same_catalog', 'different_catalog', 'ambiguous')
  ),
  decision_origin text check (
    decision_origin is null or decision_origin in ('automatic', 'manual')
  ),
  decided_at timestamptz,
  decided_by text check (decided_by is null or length(decided_by) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (transition_id, algorithm_version),
  constraint cloud_source_identity_assessments_transition_owner_fk
    foreign key (user_id, transition_id)
    references public.cloud_source_transitions(user_id, id)
    on update cascade on delete cascade,
  constraint cloud_source_identity_assessments_final_ck check (
    (final_decision is null and decision_origin is null and decided_at is null)
    or
    (final_decision is not null and decision_origin is not null and decided_at is not null)
  ),
  constraint cloud_source_identity_assessments_origin_ck check (
    decision_origin is distinct from 'automatic'
    or final_decision = automatic_decision
  ),
  constraint cloud_source_identity_assessments_manual_actor_ck check (
    decision_origin is distinct from 'manual'
    or (
      final_decision in ('same_catalog', 'different_catalog')
      and decided_by is not null
      and btrim(decided_by) <> ''
    )
  ),
  constraint cloud_source_identity_assessments_automatic_minimum_ck check (
    automatic_decision = 'ambiguous'
    or (sample_size_old >= 32 and sample_size_new >= 32)
  )
);

create table public.cloud_source_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  transition_id uuid,
  access_cycle_id uuid,
  event_kind text not null check (
    btrim(event_kind) <> '' and length(event_kind) <= 120
  ),
  idempotency_key text not null check (
    btrim(idempotency_key) <> '' and length(idempotency_key) <= 240
  ),
  payload jsonb not null default '{}'::jsonb check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768
  ),
  actor text check (actor is null or length(actor) <= 200),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  constraint cloud_source_lifecycle_events_transition_owner_fk
    foreign key (user_id, transition_id)
    references public.cloud_source_transitions(user_id, id)
    on update cascade on delete restrict,
  constraint cloud_source_lifecycle_events_cycle_owner_fk
    foreign key (user_id, access_cycle_id)
    references public.cloud_source_access_cycles(user_id, id)
    on update cascade on delete restrict
);

create index cloud_source_lifecycle_events_source_idx
  on public.cloud_source_lifecycle_events (user_id, source_id, occurred_at desc);

-- Lifecycle links and state changes are service-owned and checked centrally.
create or replace function public.norva_cloud_source_lifecycle_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_link_owner uuid;
  v_has_catalog boolean;
begin
  if tg_op = 'UPDATE' then
    if new.source_id is distinct from old.source_id
       or new.user_id is distinct from old.user_id then
      raise exception 'source lifecycle identity is immutable' using errcode = '23514';
    end if;
    if new.config_revision < old.config_revision
       or new.visibility_epoch < old.visibility_epoch then
      raise exception 'source lifecycle revisions cannot decrease' using errcode = '23514';
    end if;
    if new.lifecycle_state is distinct from old.lifecycle_state then
      if not (
        (old.lifecycle_state = 'active' and new.lifecycle_state in ('staging', 'replaced', 'purge_pending'))
        or (old.lifecycle_state = 'staging' and new.lifecycle_state in ('active', 'purge_pending'))
        or (old.lifecycle_state = 'replaced' and new.lifecycle_state in ('active', 'purge_pending'))
        or (old.lifecycle_state = 'purge_pending' and new.lifecycle_state = 'purged')
      ) then
        raise exception 'invalid source lifecycle transition: % -> %',
          old.lifecycle_state, new.lifecycle_state
          using errcode = '23514';
      end if;

      -- The only active -> staging transition is candidate initialisation before
      -- any catalog row exists. It must happen in the source-creation transaction.
      if old.lifecycle_state = 'active' and new.lifecycle_state = 'staging' then
        select exists (
          select 1 from public.cloud_media_items item where item.source_id = new.source_id
          union all
          select 1 from public.cloud_title_variants variant where variant.source_id = new.source_id
          union all
          select 1 from public.cloud_live_logical_channels channel where channel.source_id = new.source_id
          union all
          select 1 from public.cloud_live_variants variant where variant.source_id = new.source_id
        ) into v_has_catalog;
        if v_has_catalog then
          raise exception 'a populated active source cannot become staging'
            using errcode = '23514';
        end if;
      end if;
    end if;
  end if;

  if not exists (
    select 1 from public.cloud_sources source
    where source.id = new.replacement_root_id and source.user_id = new.user_id
  ) then
    raise exception 'replacement root must belong to lifecycle owner'
      using errcode = '23503';
  end if;

  if new.replaces_source_id is not null then
    select source.user_id into v_link_owner
    from public.cloud_sources source
    where source.id = new.replaces_source_id;
    if v_link_owner is distinct from new.user_id then
      raise exception 'replaces_source_id crosses tenant boundary' using errcode = '23503';
    end if;
  end if;

  if new.replaced_by_source_id is not null then
    select source.user_id into v_link_owner
    from public.cloud_sources source
    where source.id = new.replaced_by_source_id;
    if v_link_owner is distinct from new.user_id then
      raise exception 'replaced_by_source_id crosses tenant boundary' using errcode = '23503';
    end if;
  end if;

  new.updated_at := now();
  return new;
end
$function$;

create trigger trg_cloud_source_lifecycle_guard
before insert or update on public.cloud_source_lifecycle
for each row execute function public.norva_cloud_source_lifecycle_guard();

create or replace function public.norva_cloud_source_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_candidate public.cloud_source_lifecycle%rowtype;
  v_old public.cloud_source_lifecycle%rowtype;
  v_reversed public.cloud_source_transitions%rowtype;
  v_has_matching_assessment boolean := false;
  v_transition_enabled boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'source transitions cannot be deleted' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.state <> 'validating' then
      raise exception 'a transition must start in VALIDATING' using errcode = '23514';
    end if;
    if new.transition_kind = 'credential' and new.candidate_secret_ref is null then
      raise exception 'credential candidate secret reference is required'
        using errcode = '23514';
    end if;
    new.revision := 0;
    new.started_at := coalesce(new.started_at, now());
    new.ready_at := null;
    new.committing_at := null;
    new.completed_at := null;
  else
    if new.id is distinct from old.id
       or new.user_id is distinct from old.user_id
       or new.transition_kind is distinct from old.transition_kind
       or new.old_source_id is distinct from old.old_source_id
       or new.candidate_source_id is distinct from old.candidate_source_id
       or new.idempotency_key is distinct from old.idempotency_key
       or new.candidate_secret_ref is distinct from old.candidate_secret_ref
       or new.reversal_of_transition_id is distinct from old.reversal_of_transition_id
       or new.expected_source_revision is distinct from old.expected_source_revision
       or new.expected_candidate_revision is distinct from old.expected_candidate_revision then
      raise exception 'transition identity is immutable' using errcode = '23514';
    end if;

    if old.state in ('completed', 'failed', 'cancelled') then
      raise exception 'terminal transition is immutable' using errcode = '23514';
    end if;

    if old.state in ('ready_to_switch', 'committing')
       and (
         new.identity_decision is distinct from old.identity_decision
         or new.decision_origin is distinct from old.decision_origin
         or new.previous_secret_ref is distinct from old.previous_secret_ref
         or new.readiness_check_id is distinct from old.readiness_check_id
         or new.readiness_passed_at is distinct from old.readiness_passed_at
         or new.expected_catalog_version is distinct from old.expected_catalog_version
       ) then
      raise exception 'transition proof is immutable after READY_TO_SWITCH'
        using errcode = '23514';
    end if;

    if new.state is distinct from old.state then
      if not (
        (old.state = 'validating' and new.state in ('staging', 'failed', 'cancelled'))
        or (old.state = 'staging' and new.state in ('importing', 'failed', 'cancelled'))
        or (old.state = 'importing' and new.state in ('ready_to_switch', 'failed', 'cancelled'))
        or (old.state = 'ready_to_switch' and new.state in ('committing', 'failed', 'cancelled'))
        or (old.state = 'committing' and new.state in ('completed', 'failed'))
      ) then
        raise exception 'invalid % transition: % -> %',
          upper(new.transition_kind), old.state, new.state
          using errcode = '23514';
      end if;
    end if;
    new.revision := old.revision + 1;
    new.started_at := old.started_at;
    new.ready_at := old.ready_at;
    new.committing_at := old.committing_at;
    new.completed_at := old.completed_at;
  end if;

  select flag.enabled into v_transition_enabled
  from public.admin_feature_flags flag
  where flag.key = case new.transition_kind
    when 'credential' then 'provider_credential_transition_v1_enabled'
    when 'replacement' then 'provider_replacement_v1_enabled'
    else '__invalid_transition_kind__'
  end;
  if not found or not coalesce(v_transition_enabled, false) then
    if tg_op = 'INSERT' then
      raise exception 'provider % transition feature is disabled', new.transition_kind
        using errcode = '55000';
    elsif new.state is distinct from old.state
       and old.state <> 'committing'
       and new.state not in ('failed', 'cancelled') then
      raise exception 'provider % transition feature is disabled', new.transition_kind
        using errcode = '55000';
    end if;
  end if;

  select lifecycle.* into v_old
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = new.old_source_id and lifecycle.user_id = new.user_id;
  if not found then
    raise exception 'old source lifecycle is missing' using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    if new.expected_source_revision is not null
       and new.expected_source_revision is distinct from v_old.config_revision then
      raise exception 'stale source revision at transition creation' using errcode = '40001';
    end if;
    new.expected_source_revision := v_old.config_revision;
  end if;

  if new.transition_kind = 'credential' then
    if not (
      v_old.lifecycle_state = 'active'
      and v_old.catalog_visibility = 'visible'
    ) then
      raise exception 'credential source A must remain ACTIVE/VISIBLE'
        using errcode = '23514';
    end if;
    if new.state in ('ready_to_switch', 'committing', 'completed')
       and new.previous_secret_ref is null then
      raise exception 'credential rollback secret reference is required before READY_TO_SWITCH'
        using errcode = '23514';
    end if;
  else
    select lifecycle.* into v_candidate
    from public.cloud_source_lifecycle lifecycle
    where lifecycle.source_id = new.candidate_source_id and lifecycle.user_id = new.user_id;
    if not found then
      raise exception 'candidate source lifecycle is missing' using errcode = '23503';
    end if;

    if tg_op = 'INSERT' then
      if new.expected_candidate_revision is not null
         and new.expected_candidate_revision is distinct from v_candidate.config_revision then
        raise exception 'stale candidate revision at transition creation' using errcode = '40001';
      end if;
      new.expected_candidate_revision := v_candidate.config_revision;
    end if;

    if new.reversal_of_transition_id is null then
      if new.state in ('validating', 'staging', 'importing', 'ready_to_switch', 'committing')
         and not (
           v_old.lifecycle_state = 'active'
           and v_old.catalog_visibility = 'visible'
           and v_candidate.lifecycle_state = 'staging'
           and v_candidate.catalog_visibility = 'hidden'
           and v_candidate.replaces_source_id is not distinct from new.old_source_id
           and v_candidate.replacement_root_id is not distinct from v_old.replacement_root_id
         ) then
        raise exception 'replacement requires A ACTIVE/VISIBLE and B STAGING/HIDDEN'
          using errcode = '23514';
      end if;
      if new.state in ('failed', 'cancelled')
         and not (
           v_old.lifecycle_state = 'active'
           and v_old.catalog_visibility = 'visible'
           and v_candidate.lifecycle_state in ('staging', 'purge_pending')
           and v_candidate.catalog_visibility = 'hidden'
           and v_candidate.replacement_root_id is not distinct from v_old.replacement_root_id
         ) then
        raise exception 'terminal replacement must leave A intact and B hidden'
          using errcode = '23514';
      end if;
    else
      if new.id is not distinct from new.reversal_of_transition_id then
        raise exception 'a transition cannot reverse itself' using errcode = '23514';
      end if;
      select transition.* into v_reversed
      from public.cloud_source_transitions transition
      where transition.id = new.reversal_of_transition_id
        and transition.user_id = new.user_id;
      if found and (
         v_reversed.transition_kind is distinct from 'replacement'
         or v_reversed.state is distinct from 'completed'
         or v_reversed.old_source_id is distinct from new.candidate_source_id
         or v_reversed.candidate_source_id is distinct from new.old_source_id
      ) then
        raise exception 'reversal must invert one completed replacement'
          using errcode = '23514';
      end if;
      if found
         and new.state not in ('failed', 'cancelled')
         and (
           v_reversed.rollback_until is null
           or v_reversed.rollback_until < now()
         ) then
        raise exception 'replacement rollback window has expired' using errcode = '55000';
      end if;
      if found
         and new.state in ('validating', 'staging', 'importing', 'ready_to_switch', 'committing')
         and not (
           v_old.lifecycle_state = 'active'
           and v_old.catalog_visibility = 'visible'
           and v_candidate.lifecycle_state = 'replaced'
           and v_candidate.catalog_visibility = 'hidden'
           and v_candidate.replaced_by_source_id is not distinct from new.old_source_id
           and v_candidate.replacement_root_id is not distinct from v_old.replacement_root_id
         ) then
        raise exception 'reversal requires current B ACTIVE/VISIBLE and retained A REPLACED/HIDDEN'
          using errcode = '23514';
      end if;
      if found
         and new.state in ('failed', 'cancelled')
         and not (
           v_old.lifecycle_state = 'active'
           and v_old.catalog_visibility = 'visible'
           and v_candidate.lifecycle_state in ('replaced', 'purge_pending')
           and v_candidate.catalog_visibility = 'hidden'
           and v_candidate.replacement_root_id is not distinct from v_old.replacement_root_id
         ) then
        raise exception 'terminal reversal must leave current B intact and retained A hidden'
          using errcode = '23514';
      end if;
    end if;

    if new.state = 'completed'
       and not (
         v_candidate.lifecycle_state = 'active'
         and v_candidate.catalog_visibility = 'visible'
         and v_old.lifecycle_state = 'replaced'
         and v_old.catalog_visibility = 'hidden'
         and v_old.replaced_by_source_id is not distinct from v_candidate.source_id
         and v_candidate.replaces_source_id is not distinct from v_old.source_id
         and v_candidate.replacement_root_id is not distinct from v_old.replacement_root_id
       ) then
      raise exception 'completed replacement requires atomic lifecycle promotion'
        using errcode = '23514';
    end if;
  end if;

  if new.state in ('ready_to_switch', 'committing', 'completed') then
    if new.readiness_check_id is null or new.readiness_passed_at is null then
      raise exception 'readiness proof is required before READY_TO_SWITCH'
        using errcode = '23514';
    end if;
    if new.transition_kind = 'credential'
       and new.identity_decision is distinct from 'same_catalog' then
      raise exception 'CREDENTIAL transition requires SAME_CATALOG'
        using errcode = '23514';
    end if;
    if new.transition_kind = 'replacement'
       and new.identity_decision is distinct from 'different_catalog' then
      raise exception 'REPLACEMENT transition requires DIFFERENT_CATALOG'
        using errcode = '23514';
    end if;
    select exists (
      select 1
      from public.cloud_source_identity_assessments assessment
      where assessment.transition_id = new.id
        and assessment.user_id = new.user_id
        and assessment.final_decision is not distinct from new.identity_decision
        and assessment.decision_origin is not distinct from new.decision_origin
        and assessment.decided_at is not null
    ) into v_has_matching_assessment;
    if not v_has_matching_assessment then
      raise exception 'final identity assessment does not match transition decision'
        using errcode = '23514';
    end if;
    if new.state in ('ready_to_switch', 'committing')
       and v_old.config_revision is distinct from new.expected_source_revision then
      raise exception 'source revision changed after transition creation' using errcode = '40001';
    end if;
    if new.transition_kind = 'replacement' then
      if new.expected_catalog_version is null then
        raise exception 'replacement catalog version proof is required before READY_TO_SWITCH'
          using errcode = '23514';
      end if;
      if new.state in ('ready_to_switch', 'committing')
         and v_candidate.config_revision is distinct from new.expected_candidate_revision then
        raise exception 'candidate revision changed after transition creation' using errcode = '40001';
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' and new.state is distinct from old.state then
    if new.state = 'ready_to_switch' then
      new.ready_at := now();
    elsif new.state = 'committing' then
      new.committing_at := now();
    elsif new.state = 'completed' then
      new.completed_at := now();
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

create trigger trg_cloud_source_transitions_guard
before insert or update or delete on public.cloud_source_transitions
for each row execute function public.norva_cloud_source_transition_guard();

create or replace function public.norva_cloud_source_identity_assessment_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'identity assessments cannot be deleted' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if old.final_decision is not null then
      raise exception 'final identity assessment is immutable' using errcode = '23514';
    end if;
    if new.id is distinct from old.id
       or new.user_id is distinct from old.user_id
       or new.transition_id is distinct from old.transition_id
       or new.algorithm_version is distinct from old.algorithm_version
       or new.old_identity_id is distinct from old.old_identity_id
       or new.candidate_identity_id is distinct from old.candidate_identity_id
       or new.sample_size_old is distinct from old.sample_size_old
       or new.sample_size_new is distinct from old.sample_size_new
       or new.overlap_count is distinct from old.overlap_count
       or new.similarity_score is distinct from old.similarity_score
       or new.secondary_signals is distinct from old.secondary_signals
       or new.automatic_decision is distinct from old.automatic_decision then
      raise exception 'identity assessment evidence is immutable'
        using errcode = '23514';
    end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

create trigger trg_cloud_source_identity_assessments_guard
before update or delete on public.cloud_source_identity_assessments
for each row execute function public.norva_cloud_source_identity_assessment_guard();

create or replace function public.norva_cloud_source_lifecycle_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'cloud_source_lifecycle_events is append-only' using errcode = '42501';
end
$function$;

create trigger trg_cloud_source_lifecycle_events_append_only
before update or delete on public.cloud_source_lifecycle_events
for each row execute function public.norva_cloud_source_lifecycle_events_append_only();

-- Existing sources are not scanned by the migration.  The service-owned RPC
-- below advances a durable UUID keyset in batches of at most 500.  The
-- cloud_sources INSERT trigger is installed by the following short migration,
-- so UUIDs inserted before/after the cursor cannot be missed.  A global scan is
-- used only once as the completion backstop.
create table public.cloud_provider_access_foundation_rollout (
  singleton boolean primary key default true check (singleton),
  phase text not null default 'pending' check (phase in ('pending','running','complete')),
  source_cursor uuid,
  inspected_sources bigint not null default 0 check (inspected_sources >= 0),
  lifecycle_rows_inserted bigint not null default 0 check (lifecycle_rows_inserted >= 0),
  access_rows_inserted bigint not null default 0 check (access_rows_inserted >= 0),
  epoch_rows_inserted bigint not null default 0 check (epoch_rows_inserted >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.cloud_provider_access_foundation_rollout(singleton) values (true);

create or replace function public.norva_backfill_provider_access_foundation(
  p_limit integer default 500
) returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '30s'
as $function$
declare
  v_rollout public.cloud_provider_access_foundation_rollout%rowtype;
  v_source public.cloud_sources%rowtype;
  v_inspected integer := 0;
  v_lifecycle integer := 0;
  v_access integer := 0;
  v_epoch integer := 0;
  v_rows integer := 0;
  v_source_epoch bigint;
  v_candidate_ids uuid[];
  v_expected integer := 0;
  v_last uuid;
  v_complete boolean := false;
  v_previous_skip text := current_setting('norva.skip_visibility_epoch_bump', true);
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'provider access foundation backfill limit must be between 1 and 500'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-access-foundation-backfill', 0)
  );
  select rollout.* into strict v_rollout
  from public.cloud_provider_access_foundation_rollout rollout
  where rollout.singleton
  for update;
  v_last := v_rollout.source_cursor;
  if v_rollout.phase = 'complete' then
    return jsonb_build_object(
      'complete', true, 'inspectedSources', 0,
      'lifecycleRowsInserted', 0, 'accessRowsInserted', 0,
      'epochRowsInserted', 0, 'nextCursor', v_rollout.source_cursor
    );
  end if;

  perform set_config('norva.skip_visibility_epoch_bump', 'on', true);
  select coalesce(array_agg(candidate.id order by candidate.id), '{}'::uuid[])
    into v_candidate_ids
  from (
    select source.id
    from public.cloud_sources source
    where v_rollout.source_cursor is null or source.id > v_rollout.source_cursor
    order by source.id
    limit p_limit
  ) candidate;
  v_expected := cardinality(v_candidate_ids);

  for v_source in
    select source.*
    from public.cloud_sources source
    where source.id = any(v_candidate_ids)
    order by source.id
    for share of source skip locked
  loop
    v_inspected := v_inspected + 1;
    v_last := v_source.id;
    insert into public.cloud_user_catalog_visibility_epochs(user_id, visibility_epoch, updated_at)
    values (v_source.user_id, 1, now())
    on conflict (user_id) do nothing;
    get diagnostics v_rows = row_count;
    v_epoch := v_epoch + v_rows;
    select epoch.visibility_epoch into strict v_source_epoch
    from public.cloud_user_catalog_visibility_epochs epoch
    where epoch.user_id = v_source.user_id;

    insert into public.cloud_source_lifecycle (
      source_id, user_id, lifecycle_state, catalog_visibility,
      replacement_root_id, config_revision, visibility_epoch,
      activated_at, hidden_at, purge_after, created_at, updated_at
    ) values (
      v_source.id, v_source.user_id,
      case when v_source.deleted_at is null then 'active' else 'purge_pending' end,
      case when v_source.deleted_at is null then 'visible' else 'hidden' end,
      v_source.id, 0, v_source_epoch,
      case when v_source.deleted_at is null then v_source.created_at else null end,
      v_source.deleted_at, v_source.deleted_at, v_source.created_at, now()
    ) on conflict (source_id) do nothing;
    get diagnostics v_rows = row_count;
    v_lifecycle := v_lifecycle + v_rows;

    insert into public.cloud_source_provider_access (
      source_id, user_id, provider_access_status, created_at, updated_at
    ) values (
      v_source.id, v_source.user_id, 'unknown', v_source.created_at, now()
    ) on conflict (source_id) do nothing;
    get diagnostics v_rows = row_count;
    v_access := v_access + v_rows;
  end loop;
  if v_inspected <> v_expected then
    raise exception 'provider access foundation source batch is locked; retry unchanged cursor'
      using errcode = '55P03', detail = 'reason=source_batch_locked';
  end if;
  perform set_config('norva.skip_visibility_epoch_bump', coalesce(v_previous_skip, ''), true);

  if v_inspected > 0 then
    update public.cloud_provider_access_foundation_rollout rollout
    set phase = 'running', source_cursor = v_last,
        inspected_sources = rollout.inspected_sources + v_inspected,
        lifecycle_rows_inserted = rollout.lifecycle_rows_inserted + v_lifecycle,
        access_rows_inserted = rollout.access_rows_inserted + v_access,
        epoch_rows_inserted = rollout.epoch_rows_inserted + v_epoch,
        started_at = coalesce(rollout.started_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where rollout.singleton;
  else
    v_complete := not exists (
      select 1
      from public.cloud_sources source
      left join public.cloud_source_lifecycle lifecycle
        on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
      left join public.cloud_source_provider_access access_state
        on access_state.source_id = source.id and access_state.user_id = source.user_id
      left join public.cloud_user_catalog_visibility_epochs epoch
        on epoch.user_id = source.user_id
      where lifecycle.source_id is null
         or access_state.source_id is null
         or epoch.user_id is null
         or lifecycle.user_id is distinct from source.user_id
         or access_state.user_id is distinct from source.user_id
         or lifecycle.visibility_epoch < 1
         or lifecycle.visibility_epoch > epoch.visibility_epoch
         or (
           source.deleted_at is null
           and (lifecycle.lifecycle_state <> 'active' or lifecycle.catalog_visibility <> 'visible')
         )
         or (
           source.deleted_at is not null
           and (lifecycle.lifecycle_state <> 'purge_pending' or lifecycle.catalog_visibility <> 'hidden')
         )
    );
    update public.cloud_provider_access_foundation_rollout rollout
    set phase = case when v_complete then 'complete' else 'running' end,
        source_cursor = case when v_complete then rollout.source_cursor else null end,
        completed_at = case when v_complete then coalesce(rollout.completed_at, clock_timestamp()) else null end,
        started_at = coalesce(rollout.started_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where rollout.singleton;
  end if;
  return jsonb_build_object(
    'complete', v_complete, 'inspectedSources', v_inspected,
    'lifecycleRowsInserted', v_lifecycle, 'accessRowsInserted', v_access,
    'epochRowsInserted', v_epoch, 'nextCursor', v_last
  );
exception when others then
  perform set_config('norva.skip_visibility_epoch_bump', coalesce(v_previous_skip, ''), true);
  raise;
end
$function$;

revoke all on function public.norva_backfill_provider_access_foundation(integer)
  from public, anon, authenticated, service_role;

create or replace function public.norva_provider_access_foundation_fk_is_exact(
  p_table regclass,
  p_name name,
  p_keys name[],
  p_referenced_table regclass,
  p_referenced_keys name[],
  p_update_action text,
  p_delete_action text,
  p_validated boolean
) returns boolean
language plpgsql stable set search_path = ''
as $function$
declare
  v_constraint pg_catalog.pg_constraint%rowtype;
begin
  select constraint_state.* into v_constraint
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid = p_table and constraint_state.conname = p_name;
  return found
    and v_constraint.contype = 'f'
    and v_constraint.convalidated is not distinct from p_validated
    and not v_constraint.condeferrable and not v_constraint.condeferred
    and v_constraint.conparentid = 0 and v_constraint.coninhcount = 0
    and v_constraint.conislocal and v_constraint.conbin is null
    and v_constraint.confrelid = p_referenced_table
    and v_constraint.confupdtype::text = p_update_action
    and v_constraint.confdeltype::text = p_delete_action
    and v_constraint.confmatchtype = 's'
    and cardinality(v_constraint.conkey) = cardinality(p_keys)
    and cardinality(v_constraint.confkey) = cardinality(p_referenced_keys)
    and not exists (
      select 1 from pg_catalog.unnest(p_keys) with ordinality expected(column_name, ordinal)
      left join pg_catalog.pg_attribute attribute_state
        on attribute_state.attrelid = p_table and attribute_state.attname = expected.column_name and not attribute_state.attisdropped
      where attribute_state.attnum is null or v_constraint.conkey[expected.ordinal] <> attribute_state.attnum
    )
    and not exists (
      select 1 from pg_catalog.unnest(p_referenced_keys) with ordinality expected(column_name, ordinal)
      left join pg_catalog.pg_attribute attribute_state
        on attribute_state.attrelid = p_referenced_table and attribute_state.attname = expected.column_name and not attribute_state.attisdropped
      where attribute_state.attnum is null or v_constraint.confkey[expected.ordinal] <> attribute_state.attnum
    );
end
$function$;

create or replace function public.norva_provider_access_foundation_trigger_is_exact(
  p_table regclass,
  p_name name,
  p_function regprocedure,
  p_tgtype integer
) returns boolean
language sql stable set search_path = ''
as $function$
  select count(*) = 1 and bool_and(
    trigger_state.tgfoid = p_function::oid
    and trigger_state.tgtype = p_tgtype
    and trigger_state.tgenabled = 'O'
    and not trigger_state.tgisinternal
    and trigger_state.tgconstraint = 0
    and trigger_state.tgnargs = 0
    and trigger_state.tgqual is null
  )
  from pg_catalog.pg_trigger trigger_state
  where trigger_state.tgrelid = p_table::oid and trigger_state.tgname = p_name
$function$;

create or replace function public.norva_provider_access_foundation_policy_is_exact(
  p_table regclass,
  p_name name,
  p_command text,
  p_qual_sha256 text,
  p_check_sha256 text
) returns boolean
language sql stable set search_path = ''
as $function$
  select count(*) = 1 and bool_and(
    policy_state.polpermissive
    and policy_state.polcmd::text = p_command
    and policy_state.polroles = array['authenticated'::regrole::oid]
    and encode(extensions.digest(coalesce(pg_catalog.pg_get_expr(policy_state.polqual, policy_state.polrelid), ''), 'sha256'), 'hex') = p_qual_sha256
    and encode(extensions.digest(coalesce(pg_catalog.pg_get_expr(policy_state.polwithcheck, policy_state.polrelid), ''), 'sha256'), 'hex') = p_check_sha256
  )
  from pg_catalog.pg_policy policy_state
  where policy_state.polrelid = p_table::oid and policy_state.polname = p_name
$function$;

revoke all on function public.norva_provider_access_foundation_fk_is_exact(regclass,name,name[],regclass,name[],text,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.norva_provider_access_foundation_trigger_is_exact(regclass,name,regprocedure,integer) from public, anon, authenticated, service_role;
revoke all on function public.norva_provider_access_foundation_policy_is_exact(regclass,name,text,text,text) from public, anon, authenticated, service_role;

create or replace function public.norva_cloud_source_bootstrap_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.cloud_source_lifecycle (
    source_id,
    user_id,
    lifecycle_state,
    catalog_visibility,
    replacement_root_id,
    config_revision,
    visibility_epoch,
    activated_at,
    hidden_at,
    purge_after,
    created_at,
    updated_at
  ) values (
    new.id,
    new.user_id,
    case when new.deleted_at is null then 'active' else 'purge_pending' end,
    case when new.deleted_at is null then 'visible' else 'hidden' end,
    new.id,
    0,
    1,
    case when new.deleted_at is null then coalesce(new.created_at, now()) else null end,
    new.deleted_at,
    new.deleted_at,
    coalesce(new.created_at, now()),
    now()
  );

  insert into public.cloud_source_provider_access (
    source_id, user_id, provider_access_status, created_at, updated_at
  ) values (
    new.id, new.user_id, 'unknown', coalesce(new.created_at, now()), now()
  );
  return new;
end
$function$;

create or replace function public.norva_cloud_source_lifecycle_bump_epoch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_epoch bigint;
  v_user_id uuid;
begin
  if tg_op = 'DELETE' then
    v_user_id := old.user_id;
  else
    v_user_id := new.user_id;
  end if;
  if current_setting('norva.skip_visibility_epoch_bump', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_epoch := public.norva_bump_user_catalog_visibility_epoch(v_user_id);
  if tg_op <> 'DELETE' then
    update public.cloud_source_lifecycle lifecycle
    set visibility_epoch = v_epoch,
        updated_at = now()
    where lifecycle.source_id = new.source_id
      and lifecycle.visibility_epoch is distinct from v_epoch;
  end if;
  delete from public.cloud_catalog_facet_summary summary
  where summary.user_id = v_user_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger trg_cloud_source_lifecycle_insert_epoch
after insert on public.cloud_source_lifecycle
for each row execute function public.norva_cloud_source_lifecycle_bump_epoch();

create trigger trg_cloud_source_lifecycle_update_epoch
after update of lifecycle_state, catalog_visibility on public.cloud_source_lifecycle
for each row
when (
  old.lifecycle_state is distinct from new.lifecycle_state
  or old.catalog_visibility is distinct from new.catalog_visibility
)
execute function public.norva_cloud_source_lifecycle_bump_epoch();

create or replace function public.norva_cloud_source_track_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_epoch bigint;
begin
  if new.source_type is distinct from old.source_type
     or new.config_ciphertext is distinct from old.config_ciphertext then
    update public.cloud_source_lifecycle lifecycle
    set config_revision = lifecycle.config_revision + 1,
        updated_at = now()
    where lifecycle.source_id = new.id and lifecycle.user_id = new.user_id;
  end if;

  if new.enabled is distinct from old.enabled then
    v_epoch := public.norva_bump_user_catalog_visibility_epoch(new.user_id);
    update public.cloud_source_lifecycle lifecycle
    set visibility_epoch = v_epoch,
        updated_at = now()
    where lifecycle.source_id = new.id and lifecycle.user_id = new.user_id;
    delete from public.cloud_catalog_facet_summary summary
    where summary.user_id = new.user_id;
  end if;

  -- Preserve the existing DELETE /sources soft-delete contract while making it
  -- lifecycle-safe. Physical cleanup remains asynchronous and is now blocked by
  -- lifecycle/event references until a later purge migration owns the tombstone.
  if old.deleted_at is null and new.deleted_at is not null then
    update public.cloud_source_lifecycle lifecycle
    set lifecycle_state = 'purge_pending',
        catalog_visibility = 'hidden',
        hidden_at = coalesce(lifecycle.hidden_at, new.deleted_at, now()),
        purge_after = greatest(
          coalesce(lifecycle.purge_after, new.deleted_at, now()),
          coalesce(lifecycle.rollback_until, '-infinity'::timestamptz)
        ),
        updated_at = now()
    where lifecycle.source_id = new.id
      and lifecycle.user_id = new.user_id
      and lifecycle.lifecycle_state in ('active', 'staging', 'replaced');
  end if;
  return new;
end
$function$;

create or replace function public.norva_cloud_source_access_visibility_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
begin
  if tg_op = 'DELETE' then
    v_user_id := old.user_id;
  else
    v_user_id := new.user_id;
  end if;
  if coalesce((
    select bool_and(flag.enabled)
    from public.admin_feature_flags flag
    where flag.key in (
      'provider_access_v1_enabled',
      'provider_access_visibility_v1_enabled'
    )
  ), false) then
    perform public.norva_bump_user_catalog_visibility_epoch(v_user_id);
    delete from public.cloud_catalog_facet_summary summary
    where summary.user_id = v_user_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

create trigger trg_cloud_source_provider_access_visibility_update
after update of provider_access_status,
  provider_access_hidden_at,
  provider_access_restored_at
on public.cloud_source_provider_access
for each row
when (
  old.provider_access_status is distinct from new.provider_access_status
  or old.provider_access_hidden_at is distinct from new.provider_access_hidden_at
  or old.provider_access_restored_at is distinct from new.provider_access_restored_at
)
execute function public.norva_cloud_source_access_visibility_changed();

create trigger trg_cloud_source_provider_access_visibility_delete
after delete on public.cloud_source_provider_access
for each row execute function public.norva_cloud_source_access_visibility_changed();

create or replace function public.norva_provider_access_flag_visibility_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.key = 'provider_access_visibility_v1_enabled'
     and new.enabled is distinct from old.enabled then
    -- This row was forced OFF before this trigger was installed and is
    -- immutable until global cache epoch v2.  Therefore provider_access_v1 may
    -- be exercised while the effective visibility gate remains false, and two
    -- concurrent cross-row toggles cannot create a write-skew path to ON.
    raise exception 'provider access visibility flags require global cache epoch v2'
      using errcode = '55000', detail = 'reason=global_visibility_epoch_v2_required';
  end if;
  return new;
end
$function$;

create or replace function public.norva_provider_access_feature_activation_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_complete boolean;
begin
  if new.key in (
       'provider_access_v1_enabled',
       'provider_access_auto_detection_v1_enabled',
       'provider_access_notifications_v1_enabled',
       'provider_access_visibility_v1_enabled',
       'provider_credential_transition_v1_enabled',
       'provider_replacement_v1_enabled'
     )
     and new.enabled
     and (tg_op = 'INSERT' or not old.enabled) then
    select rollout.phase = 'complete' and rollout.completed_at is not null
      into v_complete
    from public.cloud_provider_access_foundation_rollout rollout
    where rollout.singleton;
    if not coalesce(v_complete, false)
       or exists (
         select 1
         from public.cloud_sources source
         left join public.cloud_source_lifecycle lifecycle
           on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
         left join public.cloud_source_provider_access access_state
           on access_state.source_id = source.id and access_state.user_id = source.user_id
         left join public.cloud_user_catalog_visibility_epochs epoch
           on epoch.user_id = source.user_id
         where lifecycle.source_id is null
            or access_state.source_id is null
            or epoch.user_id is null
       ) then
      raise exception 'provider access foundation backfill must be complete before activation'
        using errcode = '55000', detail = 'reason=foundation_backfill_incomplete';
    end if;
  end if;
  return new;
end
$function$;

-- Authorization-free core predicate for service-only projections and audited
-- SECURITY DEFINER admin reads.  Keeping it separate avoids making a cross-user
-- admin inspection pretend to be the inspected user.  It is not callable by an
-- authenticated client directly.
create or replace function public.norva_source_catalog_visible_internal(
  p_source_id uuid,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with feature_gate as (
    select
      coalesce(bool_or(flag.enabled) filter (
        where flag.key = 'provider_access_v1_enabled'
      ), false) as access_enabled,
      coalesce(bool_or(flag.enabled) filter (
        where flag.key = 'provider_access_visibility_v1_enabled'
      ), false) as visibility_enabled,
      coalesce(bool_or(flag.enabled), false) as any_enabled
    from public.admin_feature_flags flag
    where flag.key in (
      'provider_access_v1_enabled',
      'provider_access_auto_detection_v1_enabled',
      'provider_access_notifications_v1_enabled',
      'provider_access_visibility_v1_enabled',
      'provider_credential_transition_v1_enabled',
      'provider_replacement_v1_enabled'
    )
  )
  select p_source_id is not null
     and p_user_id is not null
     and exists (
       select 1
       from public.cloud_sources source
       left join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = source.id
        and lifecycle.user_id = source.user_id
       left join public.cloud_source_provider_access access
         on access.source_id = source.id
        and access.user_id = source.user_id
       left join public.cloud_user_catalog_visibility_epochs epoch
         on epoch.user_id = source.user_id
       cross join feature_gate gate
       where source.id = p_source_id
         and source.user_id = p_user_id
         and source.enabled
         and source.deleted_at is null
         and (
           (lifecycle.source_id is null
             and not gate.any_enabled)
           or (
             lifecycle.lifecycle_state = 'active'
             and lifecycle.catalog_visibility = 'visible'
           )
         )
         and (
           (access.source_id is null and not gate.any_enabled)
           or (
             access.source_id is not null
             and (
               not (gate.access_enabled and gate.visibility_enabled)
               or (
                 access.provider_access_status not in (
                   'expired_confirmed', 'access_unavailable_confirmed'
                 )
                 and (
                   access.provider_access_status <> 'restoring'
                   or access.provider_access_hidden_at is null
                   or access.provider_access_restored_at >= access.provider_access_hidden_at
                 )
               )
             )
           )
         )
         and (epoch.user_id is not null or not gate.any_enabled)
     );
$function$;

revoke all on function public.norva_source_catalog_visible_internal(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.norva_source_catalog_visible_internal(uuid, uuid)
  to service_role;

-- Exact public contract used by Edge guards and RLS.  A missing lifecycle/access
-- row keeps an enabled legacy source visible only while all six lifecycle flags
-- are OFF.  Once a lifecycle row exists, staging/hidden states remain
-- isolated regardless of flags.  The activation trigger requires backfill zero.
create or replace function public.norva_source_catalog_visible(
  p_source_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_jwt_role text := nullif(auth.jwt() ->> 'role', '');
  v_setting_role text := nullif(current_setting('request.jwt.claim.role', true), '');
  v_sql_role text := nullif(current_setting('role', true), 'none');
  v_allowed boolean := false;
begin
  if p_source_id is null or p_user_id is null then
    return false;
  end if;

  v_allowed := coalesce(
    coalesce(v_jwt_role, v_setting_role, v_sql_role, '') = 'service_role'
    or ((v_sql_role is null or v_sql_role = 'postgres') and session_user = 'postgres')
    or auth.uid() = p_user_id,
    false
  );
  if not v_allowed then
    return false;
  end if;
  return public.norva_source_catalog_visible_internal(p_source_id, p_user_id);
end
$function$;

revoke all on function public.norva_source_catalog_visible(uuid, uuid)
  from public, anon;
grant execute on function public.norva_source_catalog_visible(uuid, uuid)
  to authenticated, service_role;

-- Mutation/session guard. The lock order matches cloud_sources writers and the
-- promotion RPC, so visibility cannot flip between validation and the write.
create or replace function public.norva_assert_source_catalog_visible_locked(
  p_source_id uuid,
  p_user_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_source_id is null or p_user_id is null then
    raise exception 'source catalog is not visible' using errcode = '55000';
  end if;

  perform 1
  from public.cloud_sources source
  where source.id = p_source_id and source.user_id = p_user_id
  for update;
  if not found then
    raise exception 'source catalog is not visible' using errcode = '55000';
  end if;

  perform 1
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = p_source_id and lifecycle.user_id = p_user_id
  for update;

  perform 1
  from public.cloud_source_provider_access access
  where access.source_id = p_source_id and access.user_id = p_user_id
  for update;
  if not public.norva_source_catalog_visible(p_source_id, p_user_id) then
    raise exception 'source catalog is not visible' using errcode = '55000';
  end if;
end
$function$;

revoke all on function public.norva_assert_source_catalog_visible_locked(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Canonical service-only catalog read contract.  The sources view is explicit
-- so config_ciphertext can never be exposed by SELECT *.
create or replace view public.cloud_catalog_visible_sources
with (security_invoker = true, security_barrier = true)
as
select
  source.id,
  source.user_id,
  source.source_type,
  source.display_name,
  source.config_hint,
  source.sync_status,
  source.sync_error,
  source.catalog_version,
  source.last_synced_at,
  source.created_at,
  source.updated_at,
  source.auto_refresh_state,
  source.auto_refresh_next_at,
  source.deleted_at,
  source.enabled,
  coalesce(lifecycle.lifecycle_state, 'active') as lifecycle_state,
  coalesce(lifecycle.catalog_visibility, 'visible') as catalog_visibility,
  coalesce(lifecycle.replacement_root_id, source.id) as replacement_root_id,
  lifecycle.replaces_source_id,
  lifecycle.replaced_by_source_id,
  coalesce(lifecycle.config_revision, 0) as config_revision,
  coalesce(lifecycle.visibility_epoch, epoch.visibility_epoch, 1) as visibility_epoch,
  coalesce(epoch.visibility_epoch, 1) as user_visibility_epoch,
  coalesce(access.provider_access_status, 'unknown') as provider_access_status,
  access.provider_access_started_on,
  access.provider_access_expires_on,
  access.provider_access_expiry_source,
  coalesce(access.provider_access_manual_override, false) as provider_access_manual_override,
  coalesce(access.provider_access_reminders_enabled, false) as provider_access_reminders_enabled,
  access.provider_access_last_checked_at,
  access.provider_access_last_confirmed_active_at,
  access.provider_access_last_detected_at,
  access.provider_access_hidden_at,
  access.provider_access_restored_at
from public.cloud_sources source
left join public.cloud_source_lifecycle lifecycle
  on lifecycle.source_id = source.id
 and lifecycle.user_id = source.user_id
left join public.cloud_source_provider_access access
  on access.source_id = source.id
 and access.user_id = source.user_id
left join public.cloud_user_catalog_visibility_epochs epoch
  on epoch.user_id = source.user_id
where public.norva_source_catalog_visible_internal(source.id, source.user_id);

-- Settings/management needs to retain an active source whose Provider Access
-- is confirmed unavailable, and a replaced source during rollback. Candidate B
-- and purged tombstones are never exposed; encrypted configuration is omitted.
create or replace view public.cloud_source_management_sources
with (security_invoker = true, security_barrier = true)
as
with feature_gate as (
  select not coalesce(bool_or(flag.enabled), false) as all_flags_off
  from public.admin_feature_flags flag
  where flag.key in (
    'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
    'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
  )
)
select
  source.id,
  source.user_id,
  source.source_type,
  source.display_name,
  source.config_hint,
  source.sync_status,
  source.sync_error,
  source.catalog_version,
  source.last_synced_at,
  source.created_at,
  source.updated_at,
  source.auto_refresh_state,
  source.auto_refresh_next_at,
  source.deleted_at,
  source.enabled,
  coalesce(lifecycle.lifecycle_state, 'active') as lifecycle_state,
  coalesce(lifecycle.catalog_visibility, 'visible') as catalog_visibility,
  coalesce(lifecycle.replacement_root_id, source.id) as replacement_root_id,
  lifecycle.replaces_source_id,
  lifecycle.replaced_by_source_id,
  coalesce(lifecycle.config_revision, 0) as config_revision,
  coalesce(lifecycle.visibility_epoch, epoch.visibility_epoch, 1) as visibility_epoch,
  coalesce(lifecycle.activated_at, case when source.deleted_at is null then source.created_at end) as activated_at,
  lifecycle.hidden_at,
  lifecycle.rollback_until,
  lifecycle.purge_after,
  coalesce(epoch.visibility_epoch, 1) as user_visibility_epoch,
  coalesce(access.provider_access_status, 'unknown') as provider_access_status,
  access.provider_access_started_on,
  access.provider_access_expires_on,
  access.provider_access_expiry_source,
  coalesce(access.provider_access_manual_override, false) as provider_access_manual_override,
  coalesce(access.provider_access_reminders_enabled, false) as provider_access_reminders_enabled,
  access.provider_access_last_checked_at,
  access.provider_access_last_confirmed_active_at,
  access.provider_access_last_detected_at,
  access.provider_access_hidden_at,
  access.provider_access_restored_at,
  public.norva_source_catalog_visible_internal(source.id, source.user_id) as catalog_visible
from public.cloud_sources source
left join public.cloud_source_lifecycle lifecycle
  on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
left join public.cloud_source_provider_access access
  on access.source_id = source.id and access.user_id = source.user_id
left join public.cloud_user_catalog_visibility_epochs epoch
  on epoch.user_id = source.user_id
cross join feature_gate gate
where coalesce(lifecycle.lifecycle_state, 'active') not in ('staging', 'purged')
  and (
    (lifecycle.source_id is not null and access.source_id is not null and epoch.user_id is not null)
    or gate.all_flags_off
  );

create or replace view public.cloud_catalog_visible_media_items
with (security_invoker = true, security_barrier = true)
as
select item.*
from public.cloud_media_items item
join public.cloud_catalog_visible_sources source
  on source.id = item.source_id and source.user_id = item.user_id;

create or replace view public.cloud_catalog_visible_title_variants
with (security_invoker = true, security_barrier = true)
as
select variant.*
from public.cloud_title_variants variant
join public.cloud_catalog_visible_sources source
  on source.id = variant.source_id and source.user_id = variant.user_id;

create or replace view public.cloud_catalog_visible_live_logical_channels
with (security_invoker = true, security_barrier = true)
as
select channel.*
from public.cloud_live_logical_channels channel
join public.cloud_catalog_visible_sources source
  on source.id = channel.source_id and source.user_id = channel.user_id;

create or replace view public.cloud_catalog_visible_live_variants
with (security_invoker = true, security_barrier = true)
as
select variant.*
from public.cloud_live_variants variant
join public.cloud_catalog_visible_sources source
  on source.id = variant.source_id and source.user_id = variant.user_id;

create or replace view public.cloud_catalog_visible_favorites
with (security_invoker = true, security_barrier = true)
as
select favorite.*
from public.cloud_favorites favorite
join public.cloud_catalog_visible_sources source
  on source.id = favorite.source_id and source.user_id = favorite.user_id;

create or replace view public.cloud_catalog_visible_watch_history
with (security_invoker = true, security_barrier = true)
as
select history.*
from public.cloud_watch_history history
left join public.cloud_catalog_visible_sources source
  on source.id = history.source_id and source.user_id = history.user_id
where history.source_id is null or source.id is not null;

-- cloud_titles is user-scoped rather than source-scoped. Recompute the mutable
-- rollup from visible variants and exact visible file observations. A title
-- with only staging/hidden variants has no row in this view.
create or replace view public.cloud_catalog_visible_titles
with (security_invoker = true, security_barrier = true)
as
select
  title.id,
  title.user_id,
  title.item_type,
  title.identity_key,
  title.identity_source,
  title.provider_tmdb_id,
  title.provider_imdb_id,
  title.match_status,
  title.title,
  title.original_title,
  title.release_year,
  title.poster_url,
  title.backdrop_url,
  title.metadata,
  best_variant.id as default_variant_id,
  visible_rollup.variant_count,
  best_variant.last_observed_ttff_ms,
  title.synced_at,
  title.created_at,
  title.updated_at,
  visible_rollup.version_languages,
  coalesce(file_languages.file_audio_languages, '{}'::text[]) as audio_languages,
  file_languages.audio_probed_at,
  null::jsonb as audio_tracks,
  title.genre_category,
  title.genre_payload,
  '[]'::jsonb as subtitle_tracks,
  file_languages.subtitle_probed_at,
  visible_rollup.whisper_attempted_at,
  title.year_backfill_attempted_at,
  title.revalidate_attempted_at,
  title.search_match_attempted_at,
  file_languages.audio_lang_verified_at,
  title.genre_buckets,
  title.rating_num,
  coalesce(file_languages.file_audio_languages, '{}'::text[]) as file_audio_languages,
  coalesce(file_languages.file_subtitle_languages, '{}'::text[]) as file_subtitle_languages,
  coalesce(file_languages.file_audio_verified_languages, '{}'::text[])
    as file_audio_verified_languages,
  visible_rollup.visible_source_ids
from public.cloud_titles title
cross join lateral (
  select
    count(*)::integer as variant_count,
    array_agg(distinct variant.source_id order by variant.source_id) as visible_source_ids,
    coalesce(
      array_agg(distinct lower(btrim(variant.language)) order by lower(btrim(variant.language)))
        filter (where nullif(btrim(variant.language), '') is not null),
      '{}'::text[]
    ) as version_languages,
    max(variant.audio_whisper_attempted_at) as whisper_attempted_at
  from public.cloud_catalog_visible_title_variants variant
  where variant.title_id = title.id and variant.user_id = title.user_id
) visible_rollup
join lateral (
  select variant.id, variant.last_observed_ttff_ms
  from public.cloud_catalog_visible_title_variants variant
  where variant.title_id = title.id and variant.user_id = title.user_id
  order by
    variant.playback_cost_score asc,
    variant.last_observed_ttff_ms asc nulls last,
    variant.created_at desc
  limit 1
) best_variant on true
left join lateral (
  select
    coalesce(array_agg(distinct language_code order by language_code)
      filter (where facet = 'audio'), '{}'::text[]) as file_audio_languages,
    coalesce(array_agg(distinct language_code order by language_code)
      filter (where facet = 'subtitle'), '{}'::text[]) as file_subtitle_languages,
    coalesce(array_agg(distinct language_code order by language_code)
      filter (where facet = 'verified_audio'), '{}'::text[])
      as file_audio_verified_languages,
    max(observed_at) filter (where facet = 'audio') as audio_probed_at,
    max(observed_at) filter (where facet = 'subtitle') as subtitle_probed_at,
    max(verified_at) filter (where facet = 'verified_audio') as audio_lang_verified_at
  from (
    select
      'audio'::text as facet,
      lower(language_code) as language_code,
      observation.updated_at as observed_at,
      null::timestamptz as verified_at
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.audio_observed
    cross join lateral unnest(observation.audio_languages) language_code
    where variant.title_id = title.id and variant.user_id = title.user_id

    union all

    select
      'subtitle'::text,
      lower(language_code),
      observation.updated_at,
      null::timestamptz
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.subtitle_observed
    cross join lateral unnest(observation.subtitle_languages) language_code
    where variant.title_id = title.id and variant.user_id = title.user_id

    union all

    select
      'verified_audio'::text,
      lower(language_code),
      observation.updated_at,
      observation.audio_verified_at
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.audio_observed
     and observation.audio_verified_at is not null
    cross join lateral unnest(observation.audio_languages) language_code
    where variant.title_id = title.id and variant.user_id = title.user_id
  ) exact_language
  where language_code ~ '^[a-z]{2,3}$'
    and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
) file_languages on true
where visible_rollup.variant_count > 0;

revoke all on table
  public.cloud_source_management_sources,
  public.cloud_catalog_visible_sources,
  public.cloud_catalog_visible_media_items,
  public.cloud_catalog_visible_title_variants,
  public.cloud_catalog_visible_titles,
  public.cloud_catalog_visible_live_logical_channels,
  public.cloud_catalog_visible_live_variants,
  public.cloud_catalog_visible_favorites,
  public.cloud_catalog_visible_watch_history
from public, anon, authenticated;

grant select on table
  public.cloud_source_management_sources,
  public.cloud_catalog_visible_sources,
  public.cloud_catalog_visible_media_items,
  public.cloud_catalog_visible_title_variants,
  public.cloud_catalog_visible_titles,
  public.cloud_catalog_visible_live_logical_channels,
  public.cloud_catalog_visible_live_variants,
  public.cloud_catalog_visible_favorites,
  public.cloud_catalog_visible_watch_history
to service_role;

-- Single-snapshot history lookup. A requested source is itself an authorization
-- boundary: if it is hidden, the source-less renewal row must not become a
-- fallback. Without a source, retain the bounded legacy latest-row behavior.
create or replace function public.get_cloud_watch_history_item_visible(
  p_user_id uuid,
  p_profile_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_item_id text
) returns table (
  source_id uuid,
  item_type text,
  item_id text,
  progress_seconds integer,
  duration_seconds integer,
  completed boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    history.source_id,
    history.item_type,
    history.item_id,
    history.progress_seconds,
    history.duration_seconds,
    history.completed,
    history.updated_at
  from public.cloud_catalog_visible_watch_history history
  where history.user_id = p_user_id
    and history.profile_id = p_profile_id
    and history.item_type = p_item_type
    and history.item_id = p_item_id
    and (
      p_source_id is null
      or (
        public.norva_source_catalog_visible(p_source_id, p_user_id)
        and (history.source_id = p_source_id or history.source_id is null)
      )
    )
  order by
    case
      when p_source_id is not null and history.source_id = p_source_id then 0
      when p_source_id is not null and history.source_id is null then 1
      else 0
    end,
    history.updated_at desc,
    history.source_id nulls last
  limit 1
$function$;

revoke all on function public.get_cloud_watch_history_item_visible(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.get_cloud_watch_history_item_visible(
  uuid, uuid, uuid, text, text
) to service_role;

create or replace function public.cloud_catalog_visible_title_ids_by_source_languages(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid,
  p_audio_language text default null,
  p_subtitle_language text default null
) returns table(title_id uuid)
language sql
stable
security invoker
set search_path = ''
as $function$
  select distinct variant.title_id
  from public.cloud_catalog_visible_title_variants variant
  where variant.user_id = p_user_id
    and variant.source_id = p_source_id
    and variant.item_type = p_item_type
    and p_item_type in ('movie', 'series')
    and public.norva_source_catalog_visible(p_source_id, p_user_id)
    and (
      nullif(lower(btrim(p_audio_language)), '') is null
      or exists (
        select 1
        from public.cloud_title_file_language_observations observation
        where observation.user_id = variant.user_id
          and observation.title_id = variant.title_id
          and observation.variant_id = variant.id
          and observation.audio_observed
          and nullif(lower(btrim(p_audio_language)), '') = any(observation.audio_languages)
      )
    )
    and (
      nullif(lower(btrim(p_subtitle_language)), '') is null
      or exists (
        select 1
        from public.cloud_title_file_language_observations observation
        where observation.user_id = variant.user_id
          and observation.title_id = variant.title_id
          and observation.variant_id = variant.id
          and observation.subtitle_observed
          and nullif(lower(btrim(p_subtitle_language)), '') = any(observation.subtitle_languages)
      )
    )
$function$;

revoke all on function public.cloud_catalog_visible_title_ids_by_source_languages(
  uuid, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.cloud_catalog_visible_title_ids_by_source_languages(
  uuid, text, uuid, text, text
) to service_role;

-- Atomic favorite write contract for norva-cloud. A prior Edge visibility
-- check is advisory only; this guard and UPSERT share one database transaction.
create or replace function public.upsert_cloud_favorite_visible(
  p_user_id uuid,
  p_profile_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_item_id text,
  p_item_name text default null,
  p_item_meta jsonb default '{}'::jsonb
) returns setof public.cloud_favorites
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_saved public.cloud_favorites%rowtype;
begin
  if p_user_id is null
     or p_profile_id is null
     or p_source_id is null
     or nullif(btrim(p_item_type), '') is null
     or nullif(btrim(p_item_id), '') is null then
    raise exception 'invalid favorite coordinates' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.cloud_account_profiles profile
    where profile.id = p_profile_id and profile.user_id = p_user_id
  ) then
    raise exception 'favorite profile is not owned by user' using errcode = '23503';
  end if;

  perform public.norva_assert_source_catalog_visible_locked(p_source_id, p_user_id);

  insert into public.cloud_favorites (
    user_id, profile_id, source_id, item_type, item_id, item_name, item_meta
  ) values (
    p_user_id,
    p_profile_id,
    p_source_id,
    p_item_type,
    p_item_id,
    p_item_name,
    coalesce(p_item_meta, '{}'::jsonb)
  )
  on conflict (profile_id, source_id, item_type, item_id)
  do update set
    user_id = excluded.user_id,
    item_name = excluded.item_name,
    item_meta = excluded.item_meta
  returning * into v_saved;

  return next v_saved;
end
$function$;

revoke all on function public.upsert_cloud_favorite_visible(
  uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.upsert_cloud_favorite_visible(
  uuid, uuid, uuid, text, text, text, jsonb
) to service_role;

-- Preserve causal last-write-wins history semantics while moving the source
-- visibility check under the same row locks as the UPSERT.
create or replace function public.upsert_cloud_watch_history_causal(
  p_user_id uuid,
  p_profile_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_item_id text,
  p_parent_item_id text,
  p_item_name text,
  p_progress_seconds integer,
  p_duration_seconds integer,
  p_completed boolean,
  p_data jsonb,
  p_watched_at timestamptz
) returns setof public.cloud_watch_history
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_saved public.cloud_watch_history%rowtype;
begin
  if p_user_id is null
     or p_profile_id is null
     or nullif(btrim(p_item_type), '') is null
     or nullif(btrim(p_item_id), '') is null then
    raise exception 'invalid history coordinates' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.cloud_account_profiles profile
    where profile.id = p_profile_id and profile.user_id = p_user_id
  ) then
    raise exception 'history profile is not owned by user' using errcode = '23503';
  end if;
  if p_source_id is not null then
    perform public.norva_assert_source_catalog_visible_locked(p_source_id, p_user_id);
  end if;

  insert into public.cloud_watch_history as history (
    user_id,
    profile_id,
    source_id,
    item_type,
    item_id,
    parent_item_id,
    item_name,
    progress_seconds,
    duration_seconds,
    completed,
    data,
    watched_at
  ) values (
    p_user_id,
    p_profile_id,
    p_source_id,
    p_item_type,
    p_item_id,
    p_parent_item_id,
    p_item_name,
    greatest(coalesce(p_progress_seconds, 0), 0),
    greatest(coalesce(p_duration_seconds, 0), 0),
    coalesce(p_completed, false),
    coalesce(p_data, '{}'::jsonb),
    coalesce(p_watched_at, now())
  )
  on conflict (profile_id, source_id, item_type, item_id)
  do update set
    user_id = excluded.user_id,
    parent_item_id = coalesce(
      excluded.parent_item_id,
      history.parent_item_id
    ),
    item_name = coalesce(excluded.item_name, history.item_name),
    progress_seconds = excluded.progress_seconds,
    duration_seconds = case
      when excluded.duration_seconds > 0 then excluded.duration_seconds
      else history.duration_seconds
    end,
    completed = case
      when p_completed is not null then p_completed
      when excluded.progress_seconds >= 60 then false
      else history.completed
    end,
    data = history.data || excluded.data,
    watched_at = excluded.watched_at
  where history.watched_at is null
     or excluded.watched_at >= history.watched_at
  returning * into v_saved;

  if v_saved.id is null then
    select history.* into v_saved
    from public.cloud_watch_history history
    where history.profile_id = p_profile_id
      and history.source_id is not distinct from p_source_id
      and history.item_type = p_item_type
      and history.item_id = p_item_id;
  end if;

  return next v_saved;
end
$function$;

revoke all on function public.upsert_cloud_watch_history_causal(
  uuid, uuid, uuid, text, text, text, text, integer, integer, boolean, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_cloud_watch_history_causal(
  uuid, uuid, uuid, text, text, text, text, integer, integer, boolean, jsonb, timestamptz
) to service_role;

-- Preserve mono-account arbitration, validation-lease behavior and the exact
-- result contract. Source/lifecycle/access are locked and revalidated before
-- any existing session is superseded or a new session is inserted.
create or replace function public.claim_cloud_playback_session(
  p_session_id uuid,
  p_user_id uuid,
  p_source_id uuid,
  p_device_id uuid,
  p_item_type text,
  p_item_id text,
  p_mode text,
  p_status text,
  p_target_url_hash text,
  p_provider_account_hash text,
  p_stream_mime text,
  p_playback_hint jsonb,
  p_expires_at timestamptz
) returns table(new_session_id uuid, superseded_session_ids uuid[])
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_superseded uuid[] := '{}'::uuid[];
begin
  if p_session_id is null or p_user_id is null
     or p_source_id is null
     or p_provider_account_hash is null
     or p_provider_account_hash !~ '^[0-9a-f]{64}$'
     or nullif(p_item_type, '') is null
     or nullif(p_item_id, '') is null
     or p_mode is null or p_mode not in ('direct', 'relay', 'transcode')
     or p_status is null or p_status not in ('pending', 'ready')
     or p_expires_at is null
     or p_expires_at <= v_now then
    raise exception 'invalid playback session claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-session:' || p_provider_account_hash, 0)
  );
  v_now := clock_timestamp();
  if p_expires_at <= v_now then
    raise exception 'invalid playback session claim' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.provider_account_language_validation_leases lease
    where lease.provider_account_hash = p_provider_account_hash
      and lease.expires_at > v_now
  ) then
    raise exception 'provider language validation in progress'
      using errcode = '55P03';
  end if;

  perform public.norva_assert_source_catalog_visible_locked(p_source_id, p_user_id);

  select coalesce(array_agg(session.id order by session.created_at), '{}'::uuid[])
    into v_superseded
  from public.cloud_playback_sessions session
  where session.provider_account_hash = p_provider_account_hash
    and session.status in ('pending', 'ready');

  update public.cloud_playback_sessions session
  set status = 'expired',
      expires_at = least(session.expires_at, v_now),
      superseded_at = v_now,
      updated_at = v_now
  where session.id = any(v_superseded);

  insert into public.cloud_playback_sessions (
    id, user_id, source_id, device_id, item_type, item_id, mode, status,
    target_url_hash, provider_account_hash, stream_mime, playback_hint, expires_at
  ) values (
    p_session_id, p_user_id, p_source_id, p_device_id, p_item_type, p_item_id,
    p_mode, p_status, p_target_url_hash, p_provider_account_hash, p_stream_mime,
    coalesce(p_playback_hint, '{}'::jsonb), p_expires_at
  );

  return query select p_session_id, v_superseded;
end
$function$;

revoke all on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) to service_role;

-- The physical rollup remains useful for technical writers, but it can no
-- longer select a hidden/staging default. User-facing reads use the view above.
create or replace function public.refresh_cloud_title_rollup(target_title_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  best_variant_id uuid;
  best_ttff integer;
  variant_total integer;
begin
  if target_title_id is null then return; end if;

  select variant.id, variant.last_observed_ttff_ms
    into best_variant_id, best_ttff
  from public.cloud_title_variants variant
  where variant.title_id = target_title_id
    and public.norva_source_catalog_visible(variant.source_id, variant.user_id)
  order by
    variant.playback_cost_score asc,
    variant.last_observed_ttff_ms asc nulls last,
    variant.created_at desc
  limit 1;

  select count(*)::integer into variant_total
  from public.cloud_title_variants variant
  where variant.title_id = target_title_id
    and public.norva_source_catalog_visible(variant.source_id, variant.user_id);

  update public.cloud_titles title
  set default_variant_id = best_variant_id,
      variant_count = coalesce(variant_total, 0),
      last_observed_ttff_ms = best_ttff,
      updated_at = now()
  where title.id = target_title_id;
end
$function$;

revoke all on function public.refresh_cloud_title_rollup(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_cloud_title_rollup(uuid)
  to service_role;

-- Facet materialisations and live fallbacks must consume the same visible set.
create or replace function public.cloud_refresh_facet_summary(
  p_user_id uuid,
  p_item_type text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_counts jsonb;
  v_audio text[];
  v_version text[];
  v_audio_counts jsonb;
  v_sub_counts jsonb;
begin
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
    into v_counts
  from (
    select bucket, count(*)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(
      coalesce(title.genre_buckets, array['autres'])
    ) bucket
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and bucket <> 'autres'
    group by bucket
  ) genre_counts;

  select
    coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb),
    coalesce(array_agg(language_code order by language_code), '{}'::text[])
    into v_audio_counts, v_audio
  from (
    select language_code, count(distinct title.id)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(title.file_audio_languages) language_code
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) audio_counts;

  select coalesce(array_agg(distinct lower(version_language)), '{}'::text[])
    into v_version
  from public.cloud_catalog_visible_titles title
  cross join lateral unnest(
    coalesce(title.version_languages, '{}'::text[])
  ) version_language
  where title.user_id = p_user_id
    and title.item_type = p_item_type
    and version_language is not null;

  select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
    into v_sub_counts
  from (
    select language_code, count(distinct title.id)::bigint as n
    from public.cloud_catalog_visible_titles title
    cross join lateral unnest(title.file_subtitle_languages) language_code
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) subtitle_counts;

  insert into public.cloud_catalog_facet_summary (
    user_id,
    item_type,
    genre_bucket_counts,
    audio_langs,
    version_tags,
    audio_lang_counts,
    subtitle_lang_counts,
    refreshed_at
  ) values (
    p_user_id,
    p_item_type,
    coalesce(v_counts, '{}'::jsonb),
    coalesce(v_audio, '{}'::text[]),
    coalesce(v_version, '{}'::text[]),
    coalesce(v_audio_counts, '{}'::jsonb),
    coalesce(v_sub_counts, '{}'::jsonb),
    now()
  )
  on conflict (user_id, item_type) do update set
    genre_bucket_counts = excluded.genre_bucket_counts,
    audio_langs = excluded.audio_langs,
    version_tags = excluded.version_tags,
    audio_lang_counts = excluded.audio_lang_counts,
    subtitle_lang_counts = excluded.subtitle_lang_counts,
    refreshed_at = excluded.refreshed_at;
end
$function$;

create or replace function public.cloud_refresh_all_facet_summaries(
  p_limit integer default 100
) returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate record;
  refreshed integer := 0;
begin
  for candidate in
    select visible.user_id, visible.item_type
    from (
      select distinct title.user_id, title.item_type
      from public.cloud_catalog_visible_titles title
    ) visible
    left join public.cloud_catalog_facet_summary summary
      on summary.user_id = visible.user_id
     and summary.item_type = visible.item_type
    where summary.user_id is null
       or summary.refreshed_at < now() - interval '30 minutes'
    order by summary.refreshed_at nulls first
    limit greatest(1, least(1000, coalesce(p_limit, 100)))
  loop
    perform public.cloud_refresh_facet_summary(candidate.user_id, candidate.item_type);
    refreshed := refreshed + 1;
  end loop;
  return refreshed;
end
$function$;

create or replace function public.cloud_exact_language_counts(
  p_user_id uuid,
  p_item_type text
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_audio_counts jsonb;
  v_sub_counts jsonb;
begin
  select summary.audio_lang_counts, summary.subtitle_lang_counts
    into v_audio_counts, v_sub_counts
  from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id
    and summary.item_type = p_item_type
    and summary.refreshed_at >= now() - interval '30 minutes';

  if not found then
    select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
      into v_audio_counts
    from (
      select language_code, count(distinct title.id)::bigint as n
      from public.cloud_catalog_visible_titles title
      cross join lateral unnest(title.file_audio_languages) language_code
      where title.user_id = p_user_id
        and title.item_type = p_item_type
        and language_code ~ '^[a-z]{2,3}$'
        and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
      group by language_code
    ) audio_counts;

    select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
      into v_sub_counts
    from (
      select language_code, count(distinct title.id)::bigint as n
      from public.cloud_catalog_visible_titles title
      cross join lateral unnest(title.file_subtitle_languages) language_code
      where title.user_id = p_user_id
        and title.item_type = p_item_type
        and language_code ~ '^[a-z]{2,3}$'
        and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
      group by language_code
    ) subtitle_counts;
  end if;

  return jsonb_build_object(
    'audio', coalesce(v_audio_counts, '{}'::jsonb),
    'subtitles', coalesce(v_sub_counts, '{}'::jsonb)
  );
end
$function$;

create or replace function public.cloud_exact_language_counts_by_source(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with exact_languages as (
    select
      observation.title_id,
      lower(language_code) as language_code,
      'audio'::text as facet
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.audio_observed
    cross join lateral unnest(observation.audio_languages) language_code
    where variant.user_id = p_user_id
      and variant.source_id = p_source_id
      and variant.item_type = p_item_type
      and public.norva_source_catalog_visible(p_source_id, p_user_id)

    union all

    select
      observation.title_id,
      lower(language_code),
      'subtitles'::text
    from public.cloud_catalog_visible_title_variants variant
    join public.cloud_title_file_language_observations observation
      on observation.user_id = variant.user_id
     and observation.title_id = variant.title_id
     and observation.variant_id = variant.id
     and observation.subtitle_observed
    cross join lateral unnest(observation.subtitle_languages) language_code
    where variant.user_id = p_user_id
      and variant.source_id = p_source_id
      and variant.item_type = p_item_type
      and public.norva_source_catalog_visible(p_source_id, p_user_id)
  ),
  counts as (
    select facet, language_code, count(distinct title_id)::bigint as title_count
    from exact_languages
    where language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by facet, language_code
  )
  select jsonb_build_object(
    'audio', coalesce(
      jsonb_object_agg(language_code, title_count) filter (where facet = 'audio'),
      '{}'::jsonb
    ),
    'subtitles', coalesce(
      jsonb_object_agg(language_code, title_count) filter (where facet = 'subtitles'),
      '{}'::jsonb
    )
  )
  from counts
$function$;

create or replace function public.cloud_genre_bucket_counts(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid default null
) returns table(bucket text, n bigint)
language sql
stable
security definer
set search_path = ''
as $function$
  select genre_bucket, count(*)::bigint
  from public.cloud_catalog_visible_titles title
  cross join lateral unnest(
    coalesce(title.genre_buckets, array['autres'])
  ) genre_bucket
  where title.user_id = p_user_id
    and title.item_type = p_item_type
    and genre_bucket <> 'autres'
    and (
      p_source_id is null
      or (
        public.norva_source_catalog_visible(p_source_id, p_user_id)
        and p_source_id = any(title.visible_source_ids)
      )
    )
  group by genre_bucket
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cloud_refresh_all_facet_summaries(integer)
  from public, anon, authenticated;
revoke all on function public.cloud_exact_language_counts(uuid, text)
  from public, anon, authenticated;
revoke all on function public.cloud_exact_language_counts_by_source(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.cloud_genre_bucket_counts(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid, text) to service_role;
grant execute on function public.cloud_refresh_all_facet_summaries(integer) to service_role;
grant execute on function public.cloud_exact_language_counts(uuid, text) to service_role;
grant execute on function public.cloud_exact_language_counts_by_source(uuid, text, uuid)
  to service_role;
grant execute on function public.cloud_genre_bucket_counts(uuid, text, uuid) to service_role;

-- Background catalog enrichment must never select or mutate a staging-only title.
create or replace function public.fill_user_audio_from_catalog(
  p_user_id uuid,
  p_item_type text,
  p_limit integer default 5000
) returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  with todo as (
    select title.id, catalog.audio_languages as languages
    from public.cloud_titles title
    join public.catalog_titles catalog using (item_type, provider_tmdb_id)
    where title.user_id = p_user_id
      and title.item_type = p_item_type
      and title.audio_languages = '{}'::text[]
      and catalog.audio_languages <> '{}'::text[]
      and exists (
        select 1
        from public.cloud_title_variants variant
        join public.cloud_catalog_visible_sources source
          on source.id = variant.source_id
         and source.user_id = variant.user_id
        where variant.title_id = title.id
          and variant.user_id = title.user_id
      )
    limit greatest(0, least(20000, coalesce(p_limit, 5000)))
  )
  update public.cloud_titles title
  set audio_languages = todo.languages
  from todo
  where title.id = todo.id;
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

create or replace function public.audio_backfill_candidates(
  p_user uuid,
  p_source uuid,
  p_item_type text default 'movie',
  p_target text default 'audio',
  p_require_tags text[] default null,
  p_untagged_only boolean default false,
  p_limit integer default 25
) returns table(id uuid, default_variant_id uuid, provider_tmdb_id text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(1, least(300, coalesce(p_limit, 25)));
  v_sql text;
begin
  if not public.norva_source_catalog_visible(p_source, p_user) then
    return;
  end if;
  v_sql := format(
    'select title.id, title.default_variant_id, title.provider_tmdb_id '
    'from public.cloud_title_variants variant '
    'join public.cloud_titles title '
    'on title.id = variant.title_id and title.default_variant_id = variant.id '
    'where variant.source_id = %L and variant.item_type = %L '
    'and title.user_id = %L and title.variant_count > 0 and %s',
    p_source,
    p_item_type,
    p_user,
    case when p_target = 'subtitle'
      then 'title.subtitle_probed_at is null'
      else 'title.audio_languages = ''{}''::text[] and '
           '(title.audio_probed_at is null or '
           'title.audio_probed_at < now() - interval ''180 days'')'
    end
  );
  if p_untagged_only then
    v_sql := v_sql || ' and title.version_languages = ''{}''::text[]';
  end if;
  if p_require_tags is not null and coalesce(cardinality(p_require_tags), 0) > 0 then
    v_sql := v_sql || format(' and title.version_languages && %L::text[]', p_require_tags);
  end if;
  v_sql := v_sql || format(
    ' order by title.release_year desc nulls last, title.id asc limit %s',
    v_limit
  );
  return query execute v_sql;
end
$function$;

create or replace function public.file_audio_backfill_candidates(
  p_user uuid,
  p_source uuid default null,
  p_item_type text default 'movie',
  p_target text default 'audio',
  p_require_tags text[] default null,
  p_untagged_only boolean default false,
  p_limit integer default 25
) returns table(id uuid, default_variant_id uuid, provider_tmdb_id text)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    title.id,
    variant.id as default_variant_id,
    title.provider_tmdb_id
  from public.cloud_title_variants variant
  join public.cloud_catalog_visible_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  left join public.cloud_title_file_language_observations observation
    on observation.user_id = variant.user_id
   and observation.title_id = variant.title_id
   and observation.variant_id = variant.id
   and observation.file_external_id = variant.external_id
  where p_item_type = 'movie'
    and variant.item_type = 'movie'
    and variant.user_id = p_user
    and variant.title_id is not null
    and coalesce(btrim(variant.external_id), '') <> ''
    and (p_source is null or variant.source_id = p_source)
    and (
      case when p_target = 'subtitle'
        then not coalesce(observation.subtitle_observed, false)
        else not coalesce(observation.audio_observed, false)
          or observation.updated_at < now() - interval '180 days'
      end
    )
    and (not coalesce(p_untagged_only, false) or title.version_languages = '{}'::text[])
    and (
      p_require_tags is null
      or coalesce(cardinality(p_require_tags), 0) = 0
      or title.version_languages && p_require_tags
    )
  order by title.release_year desc nulls last, title.id, variant.id
  limit greatest(1, least(300, coalesce(p_limit, 25)))
$function$;

revoke all on function public.fill_user_audio_from_catalog(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) from public, anon, authenticated;
revoke all on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) from public, anon, authenticated;
grant execute on function public.fill_user_audio_from_catalog(uuid, text, integer)
  to service_role;
grant execute on function public.audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) to service_role;
grant execute on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, integer
) to service_role;

-- RLS on the new tables is enabled here.  Rewrites of the nine pre-existing
-- traffic-table policies are installed one table per short migration after
-- this transaction commits.

alter table public.cloud_user_catalog_visibility_epochs enable row level security;
alter table public.cloud_source_lifecycle enable row level security;
alter table public.cloud_source_provider_access enable row level security;
alter table public.cloud_source_access_cycles enable row level security;
alter table public.cloud_source_transitions enable row level security;
alter table public.cloud_source_identity_assessments enable row level security;
alter table public.cloud_source_lifecycle_events enable row level security;
alter table public.cloud_provider_access_foundation_rollout enable row level security;

revoke all on table
  public.cloud_user_catalog_visibility_epochs,
  public.cloud_source_lifecycle,
  public.cloud_source_provider_access,
  public.cloud_source_access_cycles,
  public.cloud_source_transitions,
  public.cloud_source_identity_assessments,
  public.cloud_source_lifecycle_events,
  public.cloud_provider_access_foundation_rollout
from public, anon, authenticated, service_role;

grant select on table public.cloud_user_catalog_visibility_epochs to service_role;
grant select on table public.cloud_provider_access_foundation_rollout to service_role;
grant select, insert, update, delete on table
  public.cloud_source_lifecycle,
  public.cloud_source_provider_access,
  public.cloud_source_access_cycles,
  public.cloud_source_transitions,
  public.cloud_source_identity_assessments
to service_role;
grant select, insert on table public.cloud_source_lifecycle_events to service_role;

-- Current repository clients use the service-owned Edge APIs. Close the legacy
-- direct Data API surface so config_ciphertext and hidden rows cannot be reached
-- during the migration-before-Edge deployment window.
revoke all on table
  public.cloud_sources,
  public.cloud_media_items,
  public.cloud_titles,
  public.cloud_title_variants,
  public.cloud_title_overrides,
  public.cloud_live_logical_channels,
  public.cloud_live_variants,
  public.cloud_favorites,
  public.cloud_watch_history
from anon, authenticated;

revoke all on function
  public.norva_cloud_source_lifecycle_guard(),
  public.norva_cloud_source_transition_guard(),
  public.norva_cloud_source_identity_assessment_guard(),
  public.norva_cloud_source_lifecycle_events_append_only(),
  public.norva_cloud_source_bootstrap_lifecycle(),
  public.norva_cloud_source_lifecycle_bump_epoch(),
  public.norva_cloud_source_track_revision(),
  public.norva_cloud_source_access_visibility_changed(),
  public.norva_provider_access_flag_visibility_changed(),
  public.norva_provider_access_feature_activation_guard()
from public, anon, authenticated, service_role;

-- Short, transaction-scoped and idempotent A -> B promotion. No external I/O,
-- catalog copy, fingerprinting, cleanup or notification delivery occurs here.
create or replace function public.norva_promote_source_replacement(
  p_transition_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_expected_source_revision bigint,
  p_expected_transition_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_role text := coalesce(
    nullif(auth.jwt() ->> 'role', ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), 'none'),
    ''
  );
  v_transition public.cloud_source_transitions%rowtype;
  v_old public.cloud_source_lifecycle%rowtype;
  v_candidate public.cloud_source_lifecycle%rowtype;
  v_old_source public.cloud_sources%rowtype;
  v_candidate_source public.cloud_sources%rowtype;
  v_candidate_access public.cloud_source_provider_access%rowtype;
  v_replacement_enabled boolean := false;
  v_rollback_until timestamptz;
  v_visibility_epoch bigint;
  v_result jsonb;
begin
  if v_role is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_transition_id is null or p_user_id is null then
    raise exception 'transition_id and user_id are required' using errcode = '22004';
  end if;
  if p_idempotency_key is null
     or btrim(p_idempotency_key) = ''
     or length(p_idempotency_key) > 200 then
    raise exception 'invalid promotion idempotency key' using errcode = '22023';
  end if;

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.id = p_transition_id
    and transition.user_id = p_user_id
  for update;
  if not found then
    raise exception 'replacement transition not found' using errcode = 'P0002';
  end if;

  if v_transition.state = 'completed' then
    if v_transition.promotion_idempotency_key is not distinct from p_idempotency_key
       and v_transition.promotion_expected_source_revision
         is not distinct from p_expected_source_revision
       and v_transition.promotion_expected_transition_revision
         is not distinct from p_expected_transition_revision
       and v_transition.promotion_result is not null then
      return v_transition.promotion_result;
    end if;
    raise exception 'completed transition cannot be replayed with different promotion inputs'
      using errcode = '22023';
  end if;

  select flag.enabled into v_replacement_enabled
  from public.admin_feature_flags flag
  where flag.key = 'provider_replacement_v1_enabled'
  for share;
  if not found or not coalesce(v_replacement_enabled, false) then
    raise exception 'provider replacement feature is disabled' using errcode = '55000';
  end if;

  if v_transition.transition_kind is distinct from 'replacement'
     or v_transition.state is distinct from 'ready_to_switch'
     or v_transition.identity_decision is distinct from 'different_catalog'
     or v_transition.readiness_check_id is null
     or v_transition.readiness_passed_at is null
     or v_transition.candidate_source_id is null then
    raise exception 'replacement transition is not ready to switch'
      using errcode = '55000';
  end if;
  if v_transition.reversal_of_transition_id is not null then
    raise exception 'reverse promotion requires the compensating promotion RPC'
      using errcode = '55000';
  end if;
  if v_transition.revision is distinct from p_expected_transition_revision then
    raise exception 'stale transition revision' using errcode = '40001';
  end if;
  if v_transition.expected_source_revision is distinct from p_expected_source_revision then
    raise exception 'promotion source revision does not match transition snapshot'
      using errcode = '40001';
  end if;

  -- Existing source writers lock cloud_sources before their revision trigger
  -- locks lifecycle. Promotion follows the same deterministic A/B order.
  perform 1
  from public.cloud_sources source
  where source.id in (
    v_transition.old_source_id,
    v_transition.candidate_source_id
  )
    and source.user_id = p_user_id
  order by source.id
  for update;

  perform 1
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id in (
    v_transition.old_source_id,
    v_transition.candidate_source_id
  )
    and lifecycle.user_id = p_user_id
  order by lifecycle.source_id
  for update;

  select source.* into v_old_source
  from public.cloud_sources source
  where source.id = v_transition.old_source_id
    and source.user_id = p_user_id;
  if not found
     or v_old_source.deleted_at is not null
     or not v_old_source.enabled then
    raise exception 'source A is not available before promotion' using errcode = '55000';
  end if;

  select lifecycle.* into v_old
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.old_source_id
    and lifecycle.user_id = p_user_id;
  select lifecycle.* into v_candidate
  from public.cloud_source_lifecycle lifecycle
  where lifecycle.source_id = v_transition.candidate_source_id
    and lifecycle.user_id = p_user_id;
  if v_old.source_id is null or v_candidate.source_id is null then
    raise exception 'replacement lifecycle endpoints are missing' using errcode = '23503';
  end if;

  if v_old.lifecycle_state is distinct from 'active'
     or v_old.catalog_visibility is distinct from 'visible'
     or v_old.config_revision is distinct from p_expected_source_revision then
    raise exception 'source A changed before promotion' using errcode = '40001';
  end if;
  if v_candidate.lifecycle_state is distinct from 'staging'
     or v_candidate.catalog_visibility is distinct from 'hidden'
     or v_candidate.replaces_source_id is distinct from v_old.source_id
     or v_candidate.replacement_root_id is distinct from v_old.replacement_root_id
     or v_candidate.config_revision is distinct from v_transition.expected_candidate_revision then
    raise exception 'source B is not the expected hidden staging candidate'
      using errcode = '23514';
  end if;

  select source.* into v_candidate_source
  from public.cloud_sources source
  where source.id = v_candidate.source_id
    and source.user_id = p_user_id;
  if not found
     or v_candidate_source.deleted_at is not null
     or not v_candidate_source.enabled
     or v_candidate_source.sync_status is distinct from 'ready' then
    raise exception 'source B is not technically ready' using errcode = '55000';
  end if;

  select access.* into v_candidate_access
  from public.cloud_source_provider_access access
  where access.source_id = v_candidate.source_id
    and access.user_id = p_user_id
  for update;
  if not found then
    raise exception 'source B Provider Access snapshot is missing'
      using errcode = '23503';
  end if;
  if v_candidate_access.provider_access_status in (
       'expired_confirmed',
       'access_unavailable_confirmed'
     )
     or (
       v_candidate_access.provider_access_status = 'restoring'
       and v_candidate_access.provider_access_hidden_at is not null
       and (
         v_candidate_access.provider_access_restored_at is null
         or v_candidate_access.provider_access_restored_at
           < v_candidate_access.provider_access_hidden_at
       )
     ) then
    raise exception 'source B Provider Access is not restorable at promotion'
      using errcode = '55000';
  end if;
  if v_transition.expected_catalog_version is not null
     and v_candidate_source.catalog_version::bigint
       is distinct from v_transition.expected_catalog_version then
    raise exception 'source B catalog version is stale' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.cloud_media_items item
    where item.source_id = v_candidate.source_id and item.user_id = p_user_id
    union all
    select 1 from public.cloud_title_variants variant
    where variant.source_id = v_candidate.source_id and variant.user_id = p_user_id
    union all
    select 1 from public.cloud_live_logical_channels channel
    where channel.source_id = v_candidate.source_id and channel.user_id = p_user_id
  ) then
    raise exception 'source B catalog is empty' using errcode = '55000';
  end if;

  update public.cloud_source_transitions transition
  set state = 'committing',
      promotion_idempotency_key = p_idempotency_key,
      promotion_expected_source_revision = p_expected_source_revision,
      promotion_expected_transition_revision = p_expected_transition_revision,
      rollback_until = coalesce(transition.rollback_until, now() + interval '7 days')
  where transition.id = v_transition.id
  returning transition.rollback_until into v_rollback_until;

  -- Bump the account token exactly once and stamp both lifecycle endpoints with
  -- the same value. Lifecycle triggers are suppressed only inside this transaction.
  perform set_config('norva.skip_visibility_epoch_bump', 'on', true);
  v_visibility_epoch := public.norva_bump_user_catalog_visibility_epoch(p_user_id);

  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state = 'replaced',
      catalog_visibility = 'hidden',
      replaced_by_source_id = v_candidate.source_id,
      hidden_at = now(),
      rollback_until = v_rollback_until,
      config_revision = lifecycle.config_revision + 1,
      visibility_epoch = v_visibility_epoch,
      updated_at = now()
  where lifecycle.source_id = v_old.source_id
    and lifecycle.user_id = p_user_id;

  update public.cloud_source_lifecycle lifecycle
  set lifecycle_state = 'active',
      catalog_visibility = 'visible',
      replacement_root_id = v_old.replacement_root_id,
      replaces_source_id = v_old.source_id,
      replaced_by_source_id = null,
      activated_at = now(),
      hidden_at = null,
      config_revision = lifecycle.config_revision + 1,
      visibility_epoch = v_visibility_epoch,
      updated_at = now()
  where lifecycle.source_id = v_candidate.source_id
    and lifecycle.user_id = p_user_id;

  perform set_config('norva.skip_visibility_epoch_bump', 'off', true);

  v_result := jsonb_build_object(
    'oldSourceId', v_old.source_id,
    'newSourceId', v_candidate.source_id,
    'replacementRootId', v_old.replacement_root_id,
    'visibilityEpoch', v_visibility_epoch,
    'transitionId', v_transition.id,
    'state', 'COMPLETED'
  );

  update public.cloud_source_transitions transition
  set state = 'completed',
      promotion_result = v_result
  where transition.id = v_transition.id;

  insert into public.cloud_source_lifecycle_events (
    user_id,
    source_id,
    transition_id,
    event_kind,
    idempotency_key,
    payload,
    actor
  ) values
  (
    p_user_id,
    v_old.source_id,
    v_transition.id,
    'source_replaced',
    'promotion:' || v_transition.id::text || ':old-replaced',
    jsonb_build_object(
      'replacementSourceId', v_candidate.source_id,
      'visibilityEpoch', v_visibility_epoch
    ),
    'service_role'
  ),
  (
    p_user_id,
    v_candidate.source_id,
    v_transition.id,
    'source_promoted',
    'promotion:' || v_transition.id::text || ':new-active',
    jsonb_build_object(
      'replacedSourceId', v_old.source_id,
      'visibilityEpoch', v_visibility_epoch
    ),
    'service_role'
  );

  -- The summary table is read directly by one existing Edge fast path. Delete,
  -- rather than merely age, so it cannot serve stale A or pre-staging B counts.
  delete from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id;

  return v_result;
end
$function$;

revoke all on function public.norva_promote_source_replacement(
  uuid, uuid, text, bigint, bigint
) from public, anon, authenticated;
grant execute on function public.norva_promote_source_replacement(
  uuid, uuid, text, bigint, bigint
) to service_role;

-- User-facing source payloads must never relay the persisted provider error.
-- Mirror the existing Edge sanitizer's ordered, coarse classifications and
-- return only a bounded stable code.  Operational norva-admin reads keep their
-- separate base-table contract and can classify the raw value internally.
create or replace function public.norva_public_source_sync_error_category(
  p_sync_error text
) returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  with normalized as (
    select lower(coalesce(p_sync_error, '')) as error_text
  )
  select case
    when nullif(btrim(p_sync_error), '') is null then null
    when error_text ~ (
      '(^|[^a-z0-9])'
      || '(458|user_multi_ip|account[_[:space:]-]*shar|'
      || 'account[_[:space:]-]*busy|already[[:space:]]+in[[:space:]]+use|'
      || 'max(imum)?[_[:space:]-]*conn|slot[_[:space:]-]*busy)'
      || '([^a-z0-9]|$)'
    ) then 'PROVIDER_BUSY'
    when error_text ~ (
      '(^|[^a-z0-9])'
      || '(expired|expire|inactive|disabled|banned|subscription|renew|'
      || 'unpaid|paid|trial[[:space:]]+ended)'
      || '([^a-z0-9]|$)'
    ) then 'PROVIDER_ACCESS_EXPIRED'
    when error_text ~ (
      '(^|[^a-z0-9])'
      || '(401|403|unauthorized|forbidden|auth|auth[_[:space:]-]*fail|'
      || 'authentication|credential|credentials|invalid[[:space:]]+user|'
      || 'invalid[[:space:]]+pass|invalid[[:space:]]+password|'
      || 'invalid[[:space:]]+login|bad[[:space:]]+password|'
      || 'wrong[[:space:]]+password)'
      || '([^a-z0-9]|$)'
    ) then 'PROVIDER_CREDENTIALS_REJECTED'
    when error_text ~ (
      '(^|[^a-z0-9])'
      || '(media[[:space:]]+gateway|gateway[[:space:]]+refused|refused|'
      || '500|502|503|504|timeout|timed[[:space:]]+out|econn|enotfound|'
      || 'dns|network|unreachable|service[[:space:]]+unavailable|'
      || 'temporarily[[:space:]]+unavailable)'
      || '([^a-z0-9]|$)'
    ) then 'PROVIDER_TEMPORARILY_UNAVAILABLE'
    else 'SOURCE_SYNC_FAILED'
  end
  from normalized;
$function$;

revoke all on function public.norva_public_source_sync_error_category(text)
  from public, anon, authenticated;
grant execute on function public.norva_public_source_sync_error_category(text)
  to service_role;

-- AdminPage is user-facing even though the caller is an administrator.  Keep
-- operational norva-admin diagnostics on their base-table contract, but make
-- this per-user fiche obey the same lifecycle projection as the product.
-- Driver rows retain their bounded five-minute cache: source entries are joined
-- to the current management projection, hidden entries have all catalog counts
-- zeroed, and a cached panel is returned only when every cached contributor to
-- that panel is currently visible.  Ambiguous replacement panels fail closed
-- instead of mixing A and B counts.
create or replace function public.admin_user_detail(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_user jsonb;
  v_email text;
  v_driver boolean;
  v_sources jsonb;
  v_enrichment jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(user_row), user_row.email, user_row.is_driver
  into v_user, v_email, v_driver
  from (
    select
      auth_user.id as user_id,
      auth_user.email::text as email,
      auth_user.created_at,
      auth_user.last_sign_in_at,
      auth_user.email_confirmed_at is not null as email_confirmed,
      auth_user.banned_until is not null
        and auth_user.banned_until > now() as banned,
      coalesce(auth_user.raw_app_meta_data ->> 'role', 'user') as role,
      exists (
        select 1
        from public.admin_enrichment_accounts account
        where account.user_id = auth_user.id
      ) as is_driver,
      auth_user.raw_app_meta_data ->> 'provider' as auth_provider
    from auth.users auth_user
    where auth_user.id = p_user_id
  ) user_row;

  if v_user is null then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  if v_driver then
    select coalesce(
      jsonb_agg(
        (cached.element - 'sync_error' - 'syncError') || jsonb_build_object(
          'source_id', management.id,
          'display_name', coalesce(
            management.display_name,
            left(management.id::text, 8)
          ),
          'sync_status', management.sync_status,
          'sync_error', public.norva_public_source_sync_error_category(
            management.sync_error
          ),
          'catalog_version', management.catalog_version,
          'created_at', management.created_at,
          'last_synced_at', management.last_synced_at,
          'catalog_visible', management.catalog_visible,
          'lifecycle_state', management.lifecycle_state,
          'media_items', case
            when management.catalog_visible
              then coalesce(cached.element -> 'media_items', '0'::jsonb)
            else '0'::jsonb
          end,
          'variants', case
            when management.catalog_visible
              then coalesce(cached.element -> 'variants', '0'::jsonb)
            else '0'::jsonb
          end,
          'movie_titles', case
            when management.catalog_visible
              then coalesce(cached.element -> 'movie_titles', '0'::jsonb)
            else '0'::jsonb
          end,
          'series_titles', case
            when management.catalog_visible
              then coalesce(cached.element -> 'series_titles', '0'::jsonb)
            else '0'::jsonb
          end,
          'incomplete', case
            when management.catalog_visible
              then coalesce(cached.element -> 'incomplete', 'false'::jsonb)
            else 'false'::jsonb
          end
        )
        order by
          (management.sync_error is not null) desc,
          management.created_at
      ),
      '[]'::jsonb
    )
    into v_sources
    from public.admin_dashboard_cache cache
    cross join lateral jsonb_array_elements(
      coalesce(cache.sources, '[]'::jsonb)
    ) cached(element)
    join public.cloud_source_management_sources management
      on management.user_id = p_user_id
     and management.id::text = cached.element ->> 'source_id'
    where cache.id = 1
      and cached.element ->> 'owner_email' = v_email;

    select coalesce(jsonb_agg(cached_panel.element), '[]'::jsonb)
    into v_enrichment
    from public.admin_dashboard_cache cache
    cross join lateral jsonb_array_elements(
      coalesce(cache.coverage, '[]'::jsonb)
    ) cached_panel(element)
    where cache.id = 1
      and cached_panel.element ->> 'owner_email' = v_email
      and exists (
        select 1
        from jsonb_array_elements(
          coalesce(cache.sources, '[]'::jsonb)
        ) cached_source(element)
        join public.cloud_catalog_visible_sources visible_source
          on visible_source.user_id = p_user_id
         and visible_source.id::text = cached_source.element ->> 'source_id'
        where cached_source.element ->> 'owner_email' = v_email
          and coalesce(
            nullif(cached_source.element ->> 'identity_name', ''),
            cached_source.element ->> 'display_name'
          ) = cached_panel.element ->> 'panel'
      )
      and not exists (
        select 1
        from jsonb_array_elements(
          coalesce(cache.sources, '[]'::jsonb)
        ) cached_source(element)
        where cached_source.element ->> 'owner_email' = v_email
          and coalesce(
            nullif(cached_source.element ->> 'identity_name', ''),
            cached_source.element ->> 'display_name'
          ) = cached_panel.element ->> 'panel'
          and not exists (
            select 1
            from public.cloud_catalog_visible_sources visible_source
            where visible_source.user_id = p_user_id
              and visible_source.id::text = cached_source.element ->> 'source_id'
          )
      )
      -- coverage is not capped with cache.sources; check the current complete
      -- source set too so the 300-row operational cache bound cannot hide a
      -- staging/replaced contributor that shares the same panel identity.
      and not exists (
        select 1
        from public.cloud_sources base_source
        left join public.catalog_provider_identities catalog_identity
          on catalog_identity.status = 'active'
         and catalog_identity.provider_key = nullif(
           base_source.config_hint ->> 'providerKey', ''
         )
        left join public.provider_identities identity
          on identity.id = catalog_identity.identity_id
        where base_source.user_id = p_user_id
          and coalesce(
            identity.display_name,
            base_source.display_name,
            left(base_source.id::text, 8)
          ) = cached_panel.element ->> 'panel'
          and not public.norva_source_catalog_visible_internal(
            base_source.id,
            base_source.user_id
          )
      );
  else
    select coalesce(
      jsonb_agg(
        to_jsonb(source_row)
        order by (source_row.sync_error is not null) desc, source_row.created_at
      ),
      '[]'::jsonb
    )
    into v_sources
    from (
      select
        management.id as source_id,
        coalesce(management.display_name, left(management.id::text, 8))
          as display_name,
        management.sync_status,
        public.norva_public_source_sync_error_category(
          management.sync_error
        ) as sync_error,
        management.catalog_version,
        management.created_at,
        management.last_synced_at,
        management.catalog_visible,
        management.lifecycle_state,
        (
          select count(*)
          from public.cloud_catalog_visible_media_items media
          where media.user_id = p_user_id
            and media.source_id = management.id
        ) as media_items,
        (
          select count(*)
          from public.cloud_catalog_visible_title_variants variant
          where variant.user_id = p_user_id
            and variant.source_id = management.id
        ) as variants,
        (
          select count(*)
          from public.cloud_catalog_visible_titles title
          where title.user_id = p_user_id
            and title.item_type = 'movie'
            and management.id = any(title.visible_source_ids)
        ) as movie_titles,
        (
          select count(*)
          from public.cloud_catalog_visible_titles title
          where title.user_id = p_user_id
            and title.item_type = 'series'
            and management.id = any(title.visible_source_ids)
        ) as series_titles,
        exists (
          select 1
          from public.cloud_catalog_visible_media_items media
          where media.user_id = p_user_id
            and media.source_id = management.id
            and media.item_type in ('movie', 'series')
        ) and not exists (
          select 1
          from public.cloud_catalog_visible_title_variants variant
          where variant.user_id = p_user_id
            and variant.source_id = management.id
        ) as incomplete,
        identity.display_name::text as identity_name
      from public.cloud_source_management_sources management
      left join public.catalog_provider_identities catalog_identity
        on catalog_identity.status = 'active'
       and catalog_identity.provider_key = coalesce(
         nullif(management.config_hint ->> 'providerKey', ''),
         (
           select candidate.provider_key
           from public.catalog_provider_identities candidate
           where candidate.display_name = management.display_name
             and candidate.status = 'active'
           limit 1
         )
       )
      left join public.provider_identities identity
        on identity.id = catalog_identity.identity_id
      where management.user_id = p_user_id
    ) source_row;

    select coalesce(jsonb_agg(to_jsonb(enrichment_row)), '[]'::jsonb)
    into v_enrichment
    from (
      select
        coalesce(
          identity.display_name,
          visible_source.display_name,
          left(visible_source.id::text, 8)
        ) as panel,
        visible_title.item_type,
        count(*) as total,
        count(*) filter (
          where cardinality(visible_title.audio_languages) > 0
        ) as resolved,
        round(
          100.0 * count(*) filter (
            where cardinality(visible_title.audio_languages) > 0
          ) / nullif(count(*), 0),
          1
        ) as resolved_pct,
        count(*) filter (
          where visible_title.audio_probed_at is null
            and cardinality(visible_title.audio_languages) = 0
        ) as never_probed,
        count(*) filter (
          where visible_title.audio_probed_at > now() - interval '24 hours'
        ) as probed_24h,
        count(*) filter (
          where visible_title.audio_probed_at > now() - interval '24 hours'
            and cardinality(visible_title.audio_languages) > 0
        ) as resolved_24h,
        case
          when count(*) filter (
            where visible_title.audio_probed_at > now() - interval '24 hours'
          ) > 0 then ceil(
            count(*) filter (
              where visible_title.audio_probed_at is null
                and cardinality(visible_title.audio_languages) = 0
            )::numeric
            / count(*) filter (
              where visible_title.audio_probed_at > now() - interval '24 hours'
            )
          )
          else null
        end as eta_days,
        count(*) filter (
          where visible_title.subtitle_probed_at is not null
        ) as subtitle_probed,
        count(*) filter (
          where cardinality(visible_title.file_subtitle_languages) > 0
        ) as subtitle_found
      from public.cloud_catalog_visible_titles visible_title
      cross join lateral unnest(visible_title.visible_source_ids)
        visible_title_source(source_id)
      join public.cloud_catalog_visible_sources visible_source
        on visible_source.id = visible_title_source.source_id
       and visible_source.user_id = visible_title.user_id
      left join public.catalog_provider_identities catalog_identity
        on catalog_identity.status = 'active'
       and catalog_identity.provider_key = nullif(
         visible_source.config_hint ->> 'providerKey', ''
       )
      left join public.provider_identities identity
        on identity.id = catalog_identity.identity_id
      where visible_title.user_id = p_user_id
        and visible_title.variant_count > 0
      group by
        coalesce(identity.id::text, visible_source.id::text),
        coalesce(
          identity.display_name,
          visible_source.display_name,
          left(visible_source.id::text, 8)
        ),
        visible_title.item_type
      order by panel, visible_title.item_type
    ) enrichment_row;
  end if;

  return jsonb_build_object(
    'user', v_user,
    'sources', v_sources,
    'enrichment', v_enrichment
  );
end
$function$;

revoke all on function public.admin_user_detail(uuid) from public, anon;
grant execute on function public.admin_user_detail(uuid) to authenticated;

-- The catalog Edge routes below predate the lifecycle model and historically
-- read cloud_media_items directly.  Keep their exact PostgREST signatures and
-- result contracts, but make every returned row flow through the single
-- catalog-visibility projection.  This closes the staging/replaced/confirmed-
-- unavailable bypass for both fuzzy search and every grid strategy.
create or replace function public.search_media_items(
  p_user uuid,
  p_item_type text,
  p_q text,
  p_limit integer default 24,
  p_dedup boolean default false
) returns setof public.cloud_media_items
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $function$
  with matched as (
    select
      item,
      coalesce(item.dedup_key, item.id::text) as dedup_group,
      (item.title ilike '%' || p_q || '%') as substring_hit,
      extensions.similarity(item.title, p_q) as match_similarity
    from public.cloud_catalog_visible_media_items item
    where item.user_id = p_user
      and item.item_type = p_item_type
      and (
        item.title ilike '%' || p_q || '%'
        or item.title operator(extensions.%) p_q
      )
  ),
  representatives as (
    select distinct on (dedup_group)
      item,
      max(substring_hit::integer) over (
        partition by dedup_group
      ) as group_substring_hit,
      max(match_similarity) over (
        partition by dedup_group
      ) as group_similarity
    from matched
    where p_dedup
    order by
      dedup_group,
      ((item).poster_url is not null) desc,
      (((item).metadata ->> 'providerTmdbId') is not null) desc,
      (item).rating_num desc nulls last,
      (item).external_id
  ),
  raw_matches as (
    select
      item,
      substring_hit::integer as group_substring_hit,
      match_similarity as group_similarity
    from matched
    where not p_dedup
  ),
  result_rows as (
    select * from representatives
    union all
    select * from raw_matches
  )
  select (item).*
  from result_rows
  order by
    group_substring_hit desc,
    group_similarity desc,
    (item).title
  limit greatest(1, least(p_limit, 50));
$function$;

revoke all on function public.search_media_items(
  uuid, text, text, integer, boolean
) from public, anon, authenticated;
grant execute on function public.search_media_items(
  uuid, text, text, integer, boolean
) to service_role;

-- Bounded strategy probe for the filtered grid path.  Hidden/replaced/staging
-- rows must not switch a visible user's response from the exact-total contract
-- to the large-account null-total contract.  OFFSET N + LIMIT 1 examines at
-- most N+1 visible rows; the hard cap keeps every caller bounded to 60,001.
create or replace function public.norva_visible_catalog_exceeds(
  p_user_id uuid,
  p_item_type text,
  p_threshold integer
) returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists (
    select 1
    from public.cloud_catalog_visible_media_items media
    where media.user_id = p_user_id
      and (p_item_type is null or media.item_type = p_item_type)
    limit 1
    offset least(greatest(coalesce(p_threshold, 0), 0), 60000)
  );
$function$;

revoke all on function public.norva_visible_catalog_exceeds(
  uuid, text, integer
) from public, anon, authenticated;
grant execute on function public.norva_visible_catalog_exceeds(
  uuid, text, integer
) to service_role;

create or replace function public.list_media_items_deduped(
  p_user uuid,
  p_item_type text default null,
  p_source uuid default null,
  p_category text default null,
  p_search text default null,
  p_year_min integer default null,
  p_year_max integer default null,
  p_min_rating numeric default null,
  p_added_after_epoch bigint default null,
  p_sort text default 'default',
  p_limit integer default 60,
  p_offset integer default 0
) returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_big boolean;
  v_order text;
  v_result jsonb;
begin
  v_order := case p_sort
    when 'added' then 'added_at desc nulls last, external_id'
    when 'rating' then 'rating_num desc nulls last, external_id'
    when 'year' then 'release_year desc nulls last, external_id'
    when 'year-asc' then 'release_year asc nulls last, external_id'
    else 'title asc, external_id'
  end;

  -- Default grid: preserve a bounded, ordered page and its null-total contract.
  -- is_dedup_primary is account-global and can legally remain on replaced A;
  -- never let that hidden flag suppress its visible B sibling.  Instead, each
  -- visible candidate wins only when it is the richest currently visible row
  -- in its group.  NULL keys remain their own one-row groups.  The outer scan
  -- keeps the requested order and stops at limit/offset; the indexed
  -- (user_id,item_type,dedup_key) lookup is bounded to the candidate's group.
  if p_source is null and p_category is null then
    execute format($query$
      with page as (
        select ordered_item.*, row_number() over () as __rn
        from (
          select media.*
          from public.cloud_catalog_visible_media_items media
          where media.user_id = $1
            and ($2::text is null or media.item_type = $2)
            and (
              media.dedup_key is null
              or media.id = (
                select representative.id
                from public.cloud_catalog_visible_media_items representative
                where representative.user_id = media.user_id
                  and representative.item_type = media.item_type
                  and representative.dedup_key = media.dedup_key
                order by
                  (representative.poster_url is not null) desc,
                  ((representative.metadata ->> 'providerTmdbId') is not null) desc,
                  representative.rating_num desc nulls last,
                  representative.external_id,
                  representative.id
                limit 1
              )
            )
            and ($3::text is null or media.title ilike '%%' || $3 || '%%')
            and (
              $4::integer is null
              or (media.release_year >= $4 and media.release_year <= $5)
            )
            and ($6::numeric is null or media.rating_num >= $6)
            and ($7::bigint is null or media.added_at >= $7)
          order by %s
          limit greatest($8, 0)
          offset greatest($9, 0)
        ) ordered_item
      )
      select jsonb_build_object(
        'items', coalesce(
          (
            select jsonb_agg(
              to_jsonb(page) - '__rn'
              order by page.__rn
            )
            from page
          ),
          '[]'::jsonb
        ),
        'films', (select count(*) from page),
        'total', null
      )
    $query$, v_order)
    into v_result
    using
      p_user,
      p_item_type,
      p_search,
      p_year_min,
      p_year_max,
      p_min_rating,
      p_added_after_epoch,
      p_limit,
      p_offset;
    return v_result;
  end if;

  -- Preserve the large-visible-catalog contract without letting hidden rows
  -- influence the strategy.  This path never consults the global primary flag,
  -- so a hidden primary cannot suppress a visible sibling here either.
  v_big := public.norva_visible_catalog_exceeds(
    p_user,
    p_item_type,
    60000
  );
  if v_big then
    execute format($query$
      with page as (
        select ordered_item.*, row_number() over () as __rn
        from (
          select media.*
          from public.cloud_catalog_visible_media_items media
          where media.user_id = $1
            and ($2::text is null or media.item_type = $2)
            and ($3::uuid is null or media.source_id = $3)
            and ($4::text is null or media.parent_external_id = $4)
            and ($5::text is null or media.title ilike '%%' || $5 || '%%')
            and (
              $6::integer is null
              or (media.release_year >= $6 and media.release_year <= $7)
            )
            and ($8::numeric is null or media.rating_num >= $8)
            and ($9::bigint is null or media.added_at >= $9)
          order by %s
          limit greatest($10, 0)
          offset greatest($11, 0)
        ) ordered_item
      )
      select jsonb_build_object(
        'items', coalesce(
          (
            select jsonb_agg(
              to_jsonb(page) - '__rn'
              order by page.__rn
            )
            from page
          ),
          '[]'::jsonb
        ),
        'films', (select count(*) from page),
        'total', null
      )
    $query$, v_order)
    into v_result
    using
      p_user,
      p_item_type,
      p_source,
      p_category,
      p_search,
      p_year_min,
      p_year_max,
      p_min_rating,
      p_added_after_epoch,
      p_limit,
      p_offset;
    return v_result;
  end if;

  -- Filtered normal-account path: retain exact, cross-page, per-bucket dedup.
  with filtered as (
    select
      media.*,
      coalesce(media.dedup_key, media.id::text) as _dedup_group
    from public.cloud_catalog_visible_media_items media
    where media.user_id = p_user
      and (p_item_type is null or media.item_type = p_item_type)
      and (p_source is null or media.source_id = p_source)
      and (p_category is null or media.parent_external_id = p_category)
      and (p_search is null or media.title ilike '%' || p_search || '%')
      and (
        p_year_min is null
        or (
          media.release_year >= p_year_min
          and media.release_year <= p_year_max
        )
      )
      and (p_min_rating is null or media.rating_num >= p_min_rating)
      and (
        p_added_after_epoch is null
        or media.added_at >= p_added_after_epoch
      )
  ),
  representatives as (
    select distinct on (_dedup_group)
      _dedup_group,
      added_at,
      rating_num,
      release_year,
      lower(title) as _title,
      external_id
    from filtered
    order by
      _dedup_group,
      (poster_url is not null) desc,
      ((metadata ->> 'providerTmdbId') is not null) desc,
      rating_num desc nulls last,
      external_id
  ),
  ordered as (
    select
      _dedup_group,
      row_number() over (
        order by
          case when p_sort = 'added' then added_at end desc nulls last,
          case when p_sort = 'rating' then rating_num end desc nulls last,
          case when p_sort = 'year' then release_year end desc nulls last,
          case when p_sort = 'year-asc' then release_year end asc nulls last,
          case
            when p_sort is null or p_sort in ('name', 'default', '')
              then _title
          end asc nulls last,
          external_id
      ) as _row_number
    from representatives
  ),
  page_films as (
    select _dedup_group, _row_number
    from ordered
    order by _row_number
    offset greatest(p_offset, 0)
    limit greatest(p_limit, 0)
  )
  select jsonb_build_object(
    'items', coalesce(
      (
        select jsonb_agg(
          to_jsonb(filtered) - '_dedup_group'
          order by page_films._row_number, filtered.external_id
        )
        from page_films
        join filtered using (_dedup_group)
      ),
      '[]'::jsonb
    ),
    'films', (select count(*) from page_films),
    'total', (select count(*) from representatives)
  )
  into v_result;

  return v_result;
end
$function$;

revoke all on function public.list_media_items_deduped(
  uuid, text, uuid, text, text, integer, integer, numeric, bigint, text,
  integer, integer
) from public, anon, authenticated;
grant execute on function public.list_media_items_deduped(
  uuid, text, uuid, text, text, integer, integer, numeric, bigint, text,
  integer, integer
) to service_role;

notify pgrst, 'reload schema';

commit;
