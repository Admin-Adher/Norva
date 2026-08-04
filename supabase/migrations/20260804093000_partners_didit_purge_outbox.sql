-- Norva Partners: durable, encrypted and auditable Didit session deletion.
-- Raw provider identifiers, API keys and provider payloads never enter SQL.

alter table affiliate_private.affiliate_kyc_sessions
  add column provider_purge_status text not null default 'not_required',
  add column provider_purge_requested_at timestamptz,
  add column provider_purged_at timestamptz;

alter table affiliate_private.affiliate_didit_certification_sessions
  add column provider_purge_status text not null default 'not_required',
  add column provider_purge_requested_at timestamptz,
  add column provider_purged_at timestamptz;

-- Historical terminal records contain only a one-way provider hash. They are
-- deliberately visible as dead letters instead of being falsely certified as
-- deleted. A fresh certification is required before release approval.
update affiliate_private.affiliate_kyc_sessions
set
  provider_purge_status = 'purge_dead_letter',
  provider_purge_requested_at = coalesce(
    last_event_created_at,
    updated_at,
    created_at
  )
where status <> 'pending';

update affiliate_private.affiliate_didit_certification_sessions
set
  provider_purge_status = 'purge_dead_letter',
  provider_purge_requested_at = coalesce(
    last_event_created_at,
    updated_at,
    created_at
  )
where provider_session_hash is not null
  and status in ('approved', 'declined', 'expired', 'quarantined');

-- A historical active account cannot be certified from a provider session for
-- which Norva has neither the raw identifier nor a deletion proof. Abort the
-- migration instead of silently keeping or demoting an unverifiable account.
do $partners_historical_active_didit_guard$
begin
  if exists (
    select 1
    from affiliate_private.affiliate_accounts account
    join affiliate_private.affiliate_kyc_sessions session
      on session.account_id = account.id
      and session.provider_session_hash = account.verification_reference
    where account.status = 'active'
      and account.verification_provider = 'didit'
      and session.provider_purge_status = 'purge_dead_letter'
  ) then
    raise exception
      'active Partners accounts depend on historical unpurged Didit sessions'
      using errcode = '55000';
  end if;
end;
$partners_historical_active_didit_guard$;

alter table affiliate_private.affiliate_kyc_sessions
  add constraint affiliate_kyc_sessions_provider_purge_state
  check (
    (provider_purge_status = 'not_required'
      and provider_purge_requested_at is null
      and provider_purged_at is null)
    or (provider_purge_status = 'purge_pending'
      and provider_purge_requested_at is not null
      and provider_purged_at is null)
    or (provider_purge_status = 'purged'
      and provider_purge_requested_at is not null
      and provider_purged_at is not null
      and provider_purged_at >= provider_purge_requested_at)
    or (provider_purge_status = 'purge_dead_letter'
      and provider_purge_requested_at is not null
      and provider_purged_at is null)
  );

alter table affiliate_private.affiliate_didit_certification_sessions
  add constraint affiliate_didit_certification_provider_purge_state
  check (
    (provider_purge_status = 'not_required'
      and provider_purge_requested_at is null
      and provider_purged_at is null)
    or (provider_purge_status = 'purge_pending'
      and provider_purge_requested_at is not null
      and provider_purged_at is null)
    or (provider_purge_status = 'purged'
      and provider_purge_requested_at is not null
      and provider_purged_at is not null
      and provider_purged_at >= provider_purge_requested_at)
    or (provider_purge_status = 'purge_dead_letter'
      and provider_purge_requested_at is not null
      and provider_purged_at is null)
  );

create table affiliate_private.affiliate_didit_purge_outbox (
  id                         bigint generated always as identity primary key,
  provider_session_hash      text not null unique
    references affiliate_private.affiliate_didit_session_registry(
      provider_session_hash
    ) on delete restrict,
  session_purpose            text not null,
  source_record_id           uuid not null,
  provider_environment       text not null,
  provider_session_envelope  text,
  status                     text not null default 'pending',
  attempt_count              integer not null default 0,
  lease_count                integer not null default 0,
  available_at               timestamptz not null default now(),
  lease_token                uuid,
  lease_expires_at           timestamptz,
  last_error_code            text,
  last_http_status           integer,
  purged_at                  timestamptz,
  dead_lettered_at           timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint affiliate_didit_purge_outbox_hash
    check (provider_session_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_didit_purge_outbox_source
    check (session_purpose in ('member_kyc', 'certification')),
  constraint affiliate_didit_purge_outbox_environment
    check (provider_environment in ('sandbox', 'live')),
  constraint affiliate_didit_purge_outbox_envelope
    check (
      provider_session_envelope is null
      or (
        length(provider_session_envelope) between 64 and 512
        and provider_session_envelope ~
          '^v1\.[a-z0-9][a-z0-9_-]{0,15}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,384}$'
      )
    ),
  constraint affiliate_didit_purge_outbox_status
    check (status in (
      'waiting_terminal', 'pending', 'leased', 'retry', 'succeeded',
      'dead_letter'
    )),
  constraint affiliate_didit_purge_outbox_attempts
    check (
      attempt_count between 0 and 12
      and lease_count between 0 and 2147483647
    ),
  constraint affiliate_didit_purge_outbox_error_code
    check (
      last_error_code is null
      or last_error_code in (
        'provider_timeout',
        'provider_network',
        'provider_rate_limited',
        'provider_server_error',
        'provider_rejected',
        'configuration_mismatch',
        'envelope_invalid',
        'database_contract_invalid'
      )
    ),
  constraint affiliate_didit_purge_outbox_http_status
    check (
      last_http_status is null
      or last_http_status between 100 and 599
    ),
  constraint affiliate_didit_purge_outbox_timestamps
    check (
      updated_at >= created_at
      and available_at >= created_at
      and (lease_expires_at is null or lease_expires_at > created_at)
      and (purged_at is null or purged_at >= created_at)
      and (dead_lettered_at is null or dead_lettered_at >= created_at)
    ),
  constraint affiliate_didit_purge_outbox_state
    check (
      (status = 'waiting_terminal'
        and provider_session_envelope is not null
        and lease_token is null
        and lease_expires_at is null
        and purged_at is null
        and dead_lettered_at is null
        and attempt_count = 0)
      or (status in ('pending', 'retry')
        and provider_session_envelope is not null
        and lease_token is null
        and lease_expires_at is null
        and purged_at is null
        and dead_lettered_at is null)
      or (status = 'leased'
        and provider_session_envelope is not null
        and lease_token is not null
        and lease_expires_at is not null
        and purged_at is null
        and dead_lettered_at is null)
      or (status = 'succeeded'
        and provider_session_envelope is null
        and lease_token is null
        and lease_expires_at is null
        and purged_at is not null
        and dead_lettered_at is null)
      or (status = 'dead_letter'
        and provider_session_envelope is not null
        and lease_token is null
        and lease_expires_at is null
        and purged_at is null
        and dead_lettered_at is not null)
    )
);

create unique index affiliate_didit_purge_outbox_source_idx
  on affiliate_private.affiliate_didit_purge_outbox (
    session_purpose,
    source_record_id
  );
create index affiliate_didit_purge_outbox_claim_idx
  on affiliate_private.affiliate_didit_purge_outbox (
    available_at,
    id
  ) where status in ('pending', 'retry');
create index affiliate_didit_purge_outbox_lease_idx
  on affiliate_private.affiliate_didit_purge_outbox (
    lease_expires_at,
    id
  ) where status = 'leased';

create table affiliate_private.affiliate_didit_purge_events (
  id                    bigint generated always as identity primary key,
  outbox_id             bigint not null
    references affiliate_private.affiliate_didit_purge_outbox(id)
    on delete restrict,
  event_type            text not null,
  attempt_count         integer not null,
  bounded_result        text,
  http_status           integer,
  created_at            timestamptz not null default now(),
  constraint affiliate_didit_purge_events_type
    check (event_type in (
        'staged',
        'activated',
        'enqueued',
      'leased',
      'lease_recovered',
      'retry_scheduled',
      'purged',
      'dead_lettered'
    )),
  constraint affiliate_didit_purge_events_attempt
    check (attempt_count between 0 and 12),
  constraint affiliate_didit_purge_events_result
    check (
      bounded_result is null
      or bounded_result in (
        'deleted',
        'already_deleted',
        'provider_timeout',
        'provider_network',
        'provider_rate_limited',
        'provider_server_error',
        'provider_rejected',
        'configuration_mismatch',
        'envelope_invalid',
        'database_contract_invalid'
      )
    ),
  constraint affiliate_didit_purge_events_http
    check (http_status is null or http_status between 100 and 599)
);

create index affiliate_didit_purge_events_outbox_idx
  on affiliate_private.affiliate_didit_purge_events (
    outbox_id,
    created_at desc,
    id desc
  );

create table affiliate_private.affiliate_didit_purge_worker_state (
  worker_name       text primary key,
  last_started_at   timestamptz,
  last_completed_at timestamptz,
  last_outcome      text,
  claimed_count     integer not null default 0,
  purged_count      integer not null default 0,
  retry_count       integer not null default 0,
  dead_letter_count integer not null default 0,
  updated_at        timestamptz not null default now(),
  constraint affiliate_didit_purge_worker_name
    check (worker_name = 'didit_purge'),
  constraint affiliate_didit_purge_worker_outcome
    check (
      last_outcome is null
      or last_outcome in ('running', 'ok', 'partial', 'failed')
    ),
  constraint affiliate_didit_purge_worker_counts
    check (
      claimed_count between 0 and 100
      and purged_count between 0 and 100
      and retry_count between 0 and 100
      and dead_letter_count between 0 and 100
    ),
  constraint affiliate_didit_purge_worker_timestamps
    check (
      (last_completed_at is null or last_started_at is not null)
      and (
        last_completed_at is null
        or last_completed_at >= last_started_at
      )
    )
);

insert into affiliate_private.affiliate_didit_purge_worker_state (
  worker_name
) values ('didit_purge');

alter table affiliate_private.affiliate_didit_purge_outbox
  enable row level security;
alter table affiliate_private.affiliate_didit_purge_events
  enable row level security;
alter table affiliate_private.affiliate_didit_purge_worker_state
  enable row level security;

revoke all on
  affiliate_private.affiliate_didit_purge_outbox,
  affiliate_private.affiliate_didit_purge_events,
  affiliate_private.affiliate_didit_purge_worker_state
from public, anon, authenticated, service_role;
revoke all on all sequences in schema affiliate_private
from public, anon, authenticated, service_role;

create trigger affiliate_didit_purge_events_append_only
before update or delete
on affiliate_private.affiliate_didit_purge_events
for each row execute function
  affiliate_private.reject_partners_append_only_mutation();

create or replace function
affiliate_private.guard_didit_purge_managed_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(class.relowner)
  into v_owner
  from pg_catalog.pg_class class
  where class.oid = tg_relid;

  if (
      current_user <> v_owner
      and not pg_has_role(current_user, v_owner, 'MEMBER')
    )
    or current_setting('norva.didit_purge_control', true)
      is distinct from 'managed'
  then
    raise exception 'Didit purge state is service-managed'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger affiliate_didit_purge_outbox_managed
before insert or update or delete
on affiliate_private.affiliate_didit_purge_outbox
for each row execute function
  affiliate_private.guard_didit_purge_managed_mutation();

create trigger affiliate_didit_purge_worker_state_managed
before insert or update or delete
on affiliate_private.affiliate_didit_purge_worker_state
for each row execute function
  affiliate_private.guard_didit_purge_managed_mutation();

create or replace function
affiliate_private.mark_member_didit_purge_pending()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.provider_session_hash is not null
    and new.status <> 'pending'
    and old.status = 'pending'
    and old.provider_purge_status = 'not_required'
  then
    new.provider_purge_status := 'purge_pending';
    new.provider_purge_requested_at := now();
    new.provider_purged_at := null;
  end if;
  return new;
end;
$$;

create trigger affiliate_kyc_sessions_00_mark_purge_pending
before update on affiliate_private.affiliate_kyc_sessions
for each row execute function
  affiliate_private.mark_member_didit_purge_pending();

create or replace function
affiliate_private.mark_certification_didit_purge_pending()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.provider_session_hash is not null
    and new.status in ('approved', 'declined', 'expired', 'quarantined')
    and old.status not in ('approved', 'declined', 'expired', 'quarantined')
    and old.provider_purge_status = 'not_required'
  then
    new.provider_purge_status := 'purge_pending';
    new.provider_purge_requested_at := now();
    new.provider_purged_at := null;
  end if;
  return new;
end;
$$;

create trigger affiliate_didit_certification_00_mark_purge_pending
before update
on affiliate_private.affiliate_didit_certification_sessions
for each row execute function
  affiliate_private.mark_certification_didit_purge_pending();

-- Every activation path, including older reducers, is fail-closed until the
-- exact normalized KYC session has an idempotent 204/404 deletion proof.
create or replace function
affiliate_private.guard_account_activation_until_didit_purged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'active'
    and new.status = 'active'
    and new.verification_provider = 'didit'
    and not exists (
      select 1
      from affiliate_private.affiliate_kyc_sessions session
      where session.account_id = new.id
        and session.provider_session_hash = new.verification_reference
        and session.status = 'verified'
        and session.provider_purge_status = 'purged'
        and session.provider_purged_at is not null
    )
  then
    new.status := 'pending_verification';
  end if;
  return new;
end;
$$;

create trigger affiliate_accounts_00_didit_purge_guard
before update of status
on affiliate_private.affiliate_accounts
for each row execute function
  affiliate_private.guard_account_activation_until_didit_purged();

-- The legacy reducer may have decided activation before the trigger above
-- rewrote the row. Keep the append-only audit semantically exact.
create or replace function
affiliate_private.guard_didit_purge_activation_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_status text;
  v_verification_provider text;
begin
  if new.aggregate_type not in ('account', 'kyc') then return new; end if;
  if new.action not in ('account_activated', 'kyc_result_applied') then
    return new;
  end if;

  select account.status, account.verification_provider
  into v_account_status, v_verification_provider
  from affiliate_private.affiliate_accounts account
  where account.id::text = new.aggregate_key;

  if v_verification_provider = 'didit'
    and v_account_status = 'pending_verification'
  then
    if new.action = 'account_activated' then
      new.action := 'account_activation_deferred_purge';
      new.justification :=
        'Account activation was deferred until provider deletion is proven.';
      new.after_state := new.after_state || jsonb_build_object(
        'status', 'pending_verification',
        'purge_status', 'purge_pending'
      );
    elsif coalesce((new.after_state ->> 'activated')::boolean, false) then
      new.after_state := new.after_state || jsonb_build_object(
        'activated', false,
        'purge_status', 'purge_pending'
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger affiliate_events_00_didit_purge_activation_guard
before insert on affiliate_private.affiliate_events
for each row execute function
  affiliate_private.guard_didit_purge_activation_audit();

create or replace function
affiliate_private.partners_didit_purge_public_status(p_status text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select case p_status
    when 'not_required' then 'not_required'
    when 'waiting_terminal' then 'not_required'
    when 'purge_pending' then 'purge_pending'
    when 'purged' then 'purged'
    when 'purge_dead_letter' then 'purge_dead_letter'
    when 'pending' then 'purge_pending'
    when 'leased' then 'purge_pending'
    when 'retry' then 'purge_pending'
    when 'succeeded' then 'purged'
    when 'dead_letter' then 'purge_dead_letter'
    else 'purge_dead_letter'
  end;
$$;

create or replace function
affiliate_private.partners_didit_purge_sync_source(
  p_provider_session_hash text,
  p_outbox_status text,
  p_purged_at timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_registry affiliate_private.affiliate_didit_session_registry%rowtype;
  v_source_status text :=
    affiliate_private.partners_didit_purge_public_status(p_outbox_status);
begin
  select registry.*
  into v_registry
  from affiliate_private.affiliate_didit_session_registry registry
  where registry.provider_session_hash = p_provider_session_hash;
  if not found then
    raise exception 'Didit purge source is unavailable'
      using errcode = 'P0006';
  end if;

  if v_registry.session_purpose = 'member_kyc' then
    update affiliate_private.affiliate_kyc_sessions session
    set
      provider_purge_status = v_source_status,
      provider_purge_requested_at = coalesce(
        session.provider_purge_requested_at,
        now()
      ),
      provider_purged_at = case
        when v_source_status = 'purged' then coalesce(p_purged_at, now())
        else null
      end,
      updated_at = now()
    where session.id = v_registry.source_record_id
      and session.provider_session_hash = p_provider_session_hash;
  else
    update affiliate_private.affiliate_didit_certification_sessions session
    set
      provider_purge_status = v_source_status,
      provider_purge_requested_at = coalesce(
        session.provider_purge_requested_at,
        now()
      ),
      provider_purged_at = case
        when v_source_status = 'purged' then coalesce(p_purged_at, now())
        else null
      end,
      updated_at = now()
    where session.id = v_registry.source_record_id
      and session.provider_session_hash = p_provider_session_hash;
  end if;
end;
$$;

-- The provider identifier is encrypted and durably staged in the same
-- transaction as the local session record. A staged row is intentionally not
-- claimable until either a terminal webhook or a consent withdrawal activates
-- it.
create or replace function
affiliate_private.partners_didit_purge_stage_member(
  p_provider_session_id text,
  p_provider_session_envelope text,
  p_provider_environment text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session_hash text;
  v_registry affiliate_private.affiliate_didit_session_registry%rowtype;
  v_session affiliate_private.affiliate_kyc_sessions%rowtype;
  v_outbox affiliate_private.affiliate_didit_purge_outbox%rowtype;
  v_inserted boolean := false;
begin
  if p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
    or p_provider_session_envelope is null
    or length(p_provider_session_envelope) not between 64 and 512
    or p_provider_session_envelope !~
      '^v1\.[a-z0-9][a-z0-9_-]{0,15}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,384}$'
    or p_provider_environment not in ('sandbox', 'live')
  then
    raise exception 'invalid Didit purge envelope'
      using errcode = '22023';
  end if;

  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || lower(p_provider_session_id),
      'sha256'
    ),
    'hex'
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:didit:' || v_session_hash, 0)
  );

  select registry.*
  into v_registry
  from affiliate_private.affiliate_didit_session_registry registry
  where registry.provider_session_hash = v_session_hash;
  if not found or v_registry.session_purpose <> 'member_kyc' then
    raise exception 'Didit purge source is unavailable'
      using errcode = 'P0006';
  end if;

  select session.*
  into v_session
  from affiliate_private.affiliate_kyc_sessions session
  where session.id = v_registry.source_record_id
    and session.provider_session_hash = v_session_hash
  for update;
  if not found
    or v_session.provider_environment is distinct from p_provider_environment
  then
    raise exception 'Didit purge source binding conflict'
      using errcode = 'P0003';
  end if;

  perform set_config('norva.didit_purge_control', 'managed', true);
  insert into affiliate_private.affiliate_didit_purge_outbox (
    provider_session_hash,
    session_purpose,
    source_record_id,
    provider_environment,
    provider_session_envelope,
    status
  ) values (
    v_session_hash,
    'member_kyc',
    v_session.id,
    p_provider_environment,
    p_provider_session_envelope,
    'waiting_terminal'
  )
  on conflict (provider_session_hash) do nothing
  returning * into v_outbox;
  v_inserted := found;

  if not v_inserted then
    select outbox.*
    into strict v_outbox
    from affiliate_private.affiliate_didit_purge_outbox outbox
    where outbox.provider_session_hash = v_session_hash
    for update;
    if v_outbox.session_purpose <> 'member_kyc'
      or v_outbox.source_record_id <> v_session.id
      or v_outbox.provider_environment <> p_provider_environment
    then
      raise exception 'Didit purge outbox binding conflict'
        using errcode = 'P0003';
    end if;
  else
    insert into affiliate_private.affiliate_didit_purge_events (
      outbox_id,
      event_type,
      attempt_count
    ) values (v_outbox.id, 'staged', 0);
  end if;

  return affiliate_private.partners_didit_purge_public_status(
    v_outbox.status
  );
end;
$$;

create or replace function
affiliate_private.partners_didit_purge_activate_staged(
  p_provider_session_hash text,
  p_activation_reason text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_outbox affiliate_private.affiliate_didit_purge_outbox%rowtype;
begin
  if p_provider_session_hash !~ '^[0-9a-f]{64}$'
    or p_activation_reason not in (
      'terminal_webhook', 'biometric_consent_withdrawn'
    )
  then
    raise exception 'invalid Didit purge activation'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:didit:' || p_provider_session_hash,
      0
    )
  );
  select outbox.*
  into v_outbox
  from affiliate_private.affiliate_didit_purge_outbox outbox
  where outbox.provider_session_hash = p_provider_session_hash
  for update;
  if not found then
    raise exception 'Didit purge outbox is unavailable'
      using errcode = 'P0006';
  end if;

  if v_outbox.status = 'waiting_terminal' then
    perform set_config('norva.didit_purge_control', 'managed', true);
    update affiliate_private.affiliate_didit_purge_outbox outbox
    set
      status = 'pending',
      available_at = now(),
      updated_at = now()
    where outbox.id = v_outbox.id
    returning * into v_outbox;
    insert into affiliate_private.affiliate_didit_purge_events (
      outbox_id,
      event_type,
      attempt_count
    ) values (v_outbox.id, 'activated', 0);
  end if;

  perform affiliate_private.partners_didit_purge_sync_source(
    p_provider_session_hash,
    v_outbox.status,
    v_outbox.purged_at
  );
  return affiliate_private.partners_didit_purge_public_status(
    v_outbox.status
  );
end;
$$;

create or replace function
affiliate_private.partners_service_kyc_session_record_v3(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_expires_at timestamptz,
  p_reservation_key text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_ttl_seconds integer,
  p_provider_session_envelope text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
  v_purge_status text;
begin
  v_response := affiliate_private.partners_service_kyc_session_record_v2(
    p_user_id,
    p_idempotency_key,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_expires_at,
    p_reservation_key,
    p_provider_environment,
    p_provider_config_fingerprint,
    p_provider_session_ttl_seconds
  );
  v_purge_status := affiliate_private.partners_didit_purge_stage_member(
    p_provider_session_id,
    p_provider_session_envelope,
    p_provider_environment
  );
  return v_response || jsonb_build_object(
    'session_disposition', case
      when v_purge_status = 'not_required' then 'active'
      else 'terminal'
    end,
    'purge_status', v_purge_status
  );
end;
$$;

create or replace function public.partners_service_kyc_session_record_v3(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_expires_at timestamptz,
  p_reservation_key text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_ttl_seconds integer,
  p_provider_session_envelope text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_kyc_session_record_v3(
    p_user_id,
    p_idempotency_key,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_expires_at,
    p_reservation_key,
    p_provider_environment,
    p_provider_config_fingerprint,
    p_provider_session_ttl_seconds,
    p_provider_session_envelope
  );
$$;

create or replace function
affiliate_private.partners_didit_purge_enqueue(
  p_provider_session_id text,
  p_provider_session_envelope text,
  p_provider_environment text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session_hash text;
  v_registry affiliate_private.affiliate_didit_session_registry%rowtype;
  v_environment text;
  v_terminal boolean := false;
  v_outbox affiliate_private.affiliate_didit_purge_outbox%rowtype;
  v_inserted boolean := false;
begin
  if p_provider_session_id is null
    or length(p_provider_session_id) not between 8 and 255
    or p_provider_session_id ~ '[[:space:][:cntrl:]]'
    or p_provider_session_envelope is null
    or length(p_provider_session_envelope) not between 64 and 512
    or p_provider_session_envelope !~
      '^v1\.[a-z0-9][a-z0-9_-]{0,15}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,384}$'
    or p_provider_environment not in ('sandbox', 'live')
  then
    raise exception 'invalid Didit purge envelope'
      using errcode = '22023';
  end if;

  v_session_hash := encode(
    extensions.digest(
      'norva:didit:session:v1:' || lower(p_provider_session_id),
      'sha256'
    ),
    'hex'
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:didit:' || v_session_hash, 0)
  );

  select registry.*
  into v_registry
  from affiliate_private.affiliate_didit_session_registry registry
  where registry.provider_session_hash = v_session_hash;
  if not found then
    raise exception 'Didit purge source is unavailable'
      using errcode = 'P0006';
  end if;

  if v_registry.session_purpose = 'member_kyc' then
    select
      session.provider_environment,
      session.status <> 'pending'
        or session.provider_status in (
          'approved', 'declined', 'expired', 'abandoned', 'kyc_expired'
        )
    into v_environment, v_terminal
    from affiliate_private.affiliate_kyc_sessions session
    where session.id = v_registry.source_record_id
      and session.provider_session_hash = v_session_hash;
  else
    select
      session.provider_environment,
      session.status in ('approved', 'declined', 'expired', 'quarantined')
        or session.provider_status in (
          'approved', 'declined', 'expired', 'abandoned', 'kyc_expired'
        )
    into v_environment, v_terminal
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.id = v_registry.source_record_id
      and session.provider_session_hash = v_session_hash;
  end if;

  if not found then
    raise exception 'Didit purge source is unavailable'
      using errcode = 'P0006';
  end if;
  if not v_terminal then return 'not_required'; end if;
  if v_environment not in ('sandbox', 'live') then
    v_environment := p_provider_environment;
  end if;

  perform set_config('norva.didit_purge_control', 'managed', true);
  insert into affiliate_private.affiliate_didit_purge_outbox (
    provider_session_hash,
    session_purpose,
    source_record_id,
    provider_environment,
    provider_session_envelope
  ) values (
    v_session_hash,
    v_registry.session_purpose,
    v_registry.source_record_id,
    v_environment,
    p_provider_session_envelope
  )
  on conflict (provider_session_hash) do nothing
  returning * into v_outbox;
  v_inserted := found;

  if not v_inserted then
    select outbox.*
    into strict v_outbox
    from affiliate_private.affiliate_didit_purge_outbox outbox
    where outbox.provider_session_hash = v_session_hash
    for update;
    if v_outbox.session_purpose <> v_registry.session_purpose
      or v_outbox.source_record_id <> v_registry.source_record_id
      or v_outbox.provider_environment <> v_environment
    then
      raise exception 'Didit purge outbox binding conflict'
        using errcode = 'P0003';
    end if;
    if v_outbox.status = 'waiting_terminal' then
      perform affiliate_private.partners_didit_purge_activate_staged(
        v_session_hash,
        'terminal_webhook'
      );
      select outbox.*
      into strict v_outbox
      from affiliate_private.affiliate_didit_purge_outbox outbox
      where outbox.provider_session_hash = v_session_hash;
    end if;
  else
    insert into affiliate_private.affiliate_didit_purge_events (
      outbox_id,
      event_type,
      attempt_count
    ) values (v_outbox.id, 'enqueued', 0);
  end if;

  perform affiliate_private.partners_didit_purge_sync_source(
    v_session_hash,
    v_outbox.status,
    v_outbox.purged_at
  );
  return affiliate_private.partners_didit_purge_public_status(
    v_outbox.status
  );
end;
$$;

create or replace function
affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_envelope text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
  v_purge_status text;
begin
  v_response := affiliate_private.partners_service_kyc_webhook_apply(
    p_provider_event_id,
    p_provider_session_id,
    p_provider_workflow_id,
    p_provider_workflow_version,
    p_provider_status,
    p_event_created_at,
    p_document_age,
    p_document_country_iso3,
    p_id_check_approved,
    p_liveness_approved,
    p_face_match_approved,
    p_payload_hash,
    p_provider_environment,
    p_provider_config_fingerprint
  );
  v_purge_status := affiliate_private.partners_didit_purge_enqueue(
    p_provider_session_id,
    p_provider_session_envelope,
    p_provider_environment
  );
  return v_response || jsonb_build_object(
    'purge_status', v_purge_status
  );
end;
$$;

create or replace function
affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_envelope text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
  v_purge_status text;
begin
  v_response :=
    affiliate_private.partners_service_kyc_certification_webhook_apply(
      p_provider_event_id,
      p_provider_session_id,
      p_provider_workflow_id,
      p_provider_workflow_version,
      p_provider_status,
      p_event_created_at,
      p_document_age,
      p_document_country_iso3,
      p_id_check_approved,
      p_liveness_approved,
      p_face_match_approved,
      p_payload_hash,
      p_provider_environment,
      p_provider_config_fingerprint
    );
  v_purge_status := affiliate_private.partners_didit_purge_enqueue(
    p_provider_session_id,
    p_provider_session_envelope,
    p_provider_environment
  );
  return v_response || jsonb_build_object(
    'purge_status', v_purge_status
  );
end;
$$;

create or replace function
public.partners_service_kyc_webhook_apply_and_enqueue_purge(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_envelope text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(
      p_provider_event_id,
      p_provider_session_id,
      p_provider_workflow_id,
      p_provider_workflow_version,
      p_provider_status,
      p_event_created_at,
      p_document_age,
      p_document_country_iso3,
      p_id_check_approved,
      p_liveness_approved,
      p_face_match_approved,
      p_payload_hash,
      p_provider_environment,
      p_provider_config_fingerprint,
      p_provider_session_envelope
    );
$$;

create or replace function
public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
  p_provider_event_id text,
  p_provider_session_id text,
  p_provider_workflow_id text,
  p_provider_workflow_version integer,
  p_provider_status text,
  p_event_created_at timestamptz,
  p_document_age integer,
  p_document_country_iso3 text,
  p_id_check_approved boolean,
  p_liveness_approved boolean,
  p_face_match_approved boolean,
  p_payload_hash text,
  p_provider_environment text,
  p_provider_config_fingerprint text,
  p_provider_session_envelope text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
      p_provider_event_id,
      p_provider_session_id,
      p_provider_workflow_id,
      p_provider_workflow_version,
      p_provider_status,
      p_event_created_at,
      p_document_age,
      p_document_country_iso3,
      p_id_check_approved,
      p_liveness_approved,
      p_face_match_approved,
      p_payload_hash,
      p_provider_environment,
      p_provider_config_fingerprint,
      p_provider_session_envelope
    );
$$;

create or replace function
affiliate_private.partners_service_didit_purge_claim(
  p_batch_size integer,
  p_lease_seconds integer
)
returns table (
  outbox_id bigint,
  lease_token uuid,
  provider_session_hash text,
  provider_session_envelope text,
  provider_environment text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recovered record;
  v_candidate record;
  v_claimed affiliate_private.affiliate_didit_purge_outbox%rowtype;
begin
  if p_batch_size not between 1 and 25
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'invalid Didit purge claim bounds'
      using errcode = '22023';
  end if;
  perform set_config('norva.didit_purge_control', 'managed', true);

  for v_recovered in
    select outbox.id
    from affiliate_private.affiliate_didit_purge_outbox outbox
    where outbox.status = 'leased'
      and outbox.lease_expires_at <= now()
    order by outbox.lease_expires_at, outbox.id
    for update skip locked
  loop
    update affiliate_private.affiliate_didit_purge_outbox outbox
    set
      status = 'retry',
      available_at = now(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = now()
    where outbox.id = v_recovered.id
    returning outbox.* into v_claimed;
    insert into affiliate_private.affiliate_didit_purge_events (
      outbox_id,
      event_type,
      attempt_count
    ) values (v_claimed.id, 'lease_recovered', v_claimed.attempt_count);
  end loop;

  for v_candidate in
    select outbox.id
    from affiliate_private.affiliate_didit_purge_outbox outbox
    where outbox.status in ('pending', 'retry')
      and outbox.available_at <= now()
    order by outbox.available_at, outbox.id
    for update skip locked
    limit p_batch_size
  loop
    update affiliate_private.affiliate_didit_purge_outbox outbox
    set
      status = 'leased',
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      lease_count = outbox.lease_count + 1,
      updated_at = now()
    where outbox.id = v_candidate.id
    returning outbox.* into v_claimed;
    insert into affiliate_private.affiliate_didit_purge_events (
      outbox_id,
      event_type,
      attempt_count
    ) values (v_claimed.id, 'leased', v_claimed.attempt_count);
    return query select
      v_claimed.id,
      v_claimed.lease_token,
      v_claimed.provider_session_hash,
      v_claimed.provider_session_envelope,
      v_claimed.provider_environment;
  end loop;
end;
$$;

create or replace function
affiliate_private.partners_service_didit_purge_complete(
  p_outbox_id bigint,
  p_lease_token uuid,
  p_result text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before affiliate_private.affiliate_didit_purge_outbox%rowtype;
  v_outbox affiliate_private.affiliate_didit_purge_outbox%rowtype;
  v_user_id uuid;
begin
  if p_outbox_id is null or p_outbox_id < 1
    or p_lease_token is null
    or p_result not in ('deleted', 'already_deleted')
  then
    raise exception 'invalid Didit purge completion'
      using errcode = '22023';
  end if;

  select outbox.*
  into v_before
  from affiliate_private.affiliate_didit_purge_outbox outbox
  where outbox.id = p_outbox_id;
  if not found then
    raise exception 'Didit purge lease is unavailable'
      using errcode = 'P0006';
  end if;
  if v_before.status = 'succeeded' then
    return jsonb_build_object(
      'schema_version', 1,
      'completed', true,
      'replayed', true
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:didit:' || v_before.provider_session_hash,
      0
    )
  );
  perform set_config('norva.didit_purge_control', 'managed', true);
  update affiliate_private.affiliate_didit_purge_outbox outbox
  set
    status = 'succeeded',
    provider_session_envelope = null,
    lease_token = null,
    lease_expires_at = null,
    last_error_code = null,
    last_http_status = case
      when p_result = 'deleted' then 204
      else 404
    end,
    purged_at = now(),
    updated_at = now()
  where outbox.id = p_outbox_id
    and outbox.status = 'leased'
    and outbox.lease_token = p_lease_token
  returning outbox.* into v_outbox;
  if not found then
    raise exception 'Didit purge lease is stale'
      using errcode = 'P0003';
  end if;

  insert into affiliate_private.affiliate_didit_purge_events (
    outbox_id,
    event_type,
    attempt_count,
    bounded_result,
    http_status
  ) values (
    v_outbox.id,
    'purged',
    v_outbox.attempt_count,
    p_result,
    v_outbox.last_http_status
  );
  perform affiliate_private.partners_didit_purge_sync_source(
    v_outbox.provider_session_hash,
    v_outbox.status,
    v_outbox.purged_at
  );

  if v_outbox.session_purpose = 'member_kyc' then
    select account.user_id
    into v_user_id
    from affiliate_private.affiliate_kyc_sessions session
    join affiliate_private.affiliate_accounts account
      on account.id = session.account_id
    where session.id = v_outbox.source_record_id;
    if v_user_id is not null then
      begin
        perform affiliate_private.partners_service_activation_reconcile(
          v_user_id
        );
      exception when others then
        -- Deletion proof is authoritative and must not be rolled back by a
        -- separate release/eligibility reconcile. The next explicit reconcile
        -- can safely retry activation.
        null;
      end;
    end if;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'completed', true,
    'replayed', false
  );
end;
$$;

create or replace function
affiliate_private.partners_service_didit_purge_fail(
  p_outbox_id bigint,
  p_lease_token uuid,
  p_error_code text,
  p_http_status integer,
  p_retryable boolean,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before affiliate_private.affiliate_didit_purge_outbox%rowtype;
  v_outbox affiliate_private.affiliate_didit_purge_outbox%rowtype;
  v_attempt integer;
  v_dead_letter boolean;
  v_delay integer;
begin
  if p_outbox_id is null or p_outbox_id < 1
    or p_lease_token is null
    or p_error_code not in (
      'provider_timeout',
      'provider_network',
      'provider_rate_limited',
      'provider_server_error',
      'provider_rejected',
      'configuration_mismatch',
      'envelope_invalid',
      'database_contract_invalid'
    )
    or (p_http_status is not null and p_http_status not between 100 and 599)
    or p_retryable is null
    or (
      p_retry_after_seconds is not null
      and p_retry_after_seconds not between 1 and 3600
    )
  then
    raise exception 'invalid Didit purge failure'
      using errcode = '22023';
  end if;

  select outbox.*
  into v_before
  from affiliate_private.affiliate_didit_purge_outbox outbox
  where outbox.id = p_outbox_id;
  if not found then
    raise exception 'Didit purge lease is unavailable'
      using errcode = 'P0006';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:didit:' || v_before.provider_session_hash,
      0
    )
  );

  v_attempt := least(v_before.attempt_count + 1, 12);
  v_dead_letter := not p_retryable or v_attempt >= 12;
  v_delay := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(3600, (5 * power(2, least(v_attempt - 1, 9)))::integer)
  );

  perform set_config('norva.didit_purge_control', 'managed', true);
  update affiliate_private.affiliate_didit_purge_outbox outbox
  set
    status = case when v_dead_letter then 'dead_letter' else 'retry' end,
    attempt_count = v_attempt,
    available_at = case
      when v_dead_letter then outbox.available_at
      else now() + make_interval(secs => v_delay)
    end,
    lease_token = null,
    lease_expires_at = null,
    last_error_code = p_error_code,
    last_http_status = p_http_status,
    dead_lettered_at = case when v_dead_letter then now() else null end,
    updated_at = now()
  where outbox.id = p_outbox_id
    and outbox.status = 'leased'
    and outbox.lease_token = p_lease_token
  returning outbox.* into v_outbox;
  if not found then
    raise exception 'Didit purge lease is stale'
      using errcode = 'P0003';
  end if;

  insert into affiliate_private.affiliate_didit_purge_events (
    outbox_id,
    event_type,
    attempt_count,
    bounded_result,
    http_status
  ) values (
    v_outbox.id,
    case when v_dead_letter then 'dead_lettered' else 'retry_scheduled' end,
    v_outbox.attempt_count,
    p_error_code,
    p_http_status
  );
  if v_dead_letter then
    perform affiliate_private.partners_didit_purge_sync_source(
      v_outbox.provider_session_hash,
      v_outbox.status,
      null
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', case
      when v_dead_letter then 'dead_lettered'
      else 'retry_scheduled'
    end,
    'attempt_count', v_attempt,
    'retry_after_seconds', case when v_dead_letter then null else v_delay end
  );
end;
$$;

create or replace function
affiliate_private.partners_service_didit_purge_heartbeat(
  p_outcome text,
  p_claimed_count integer,
  p_purged_count integer,
  p_retry_count integer,
  p_dead_letter_count integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_outcome not in ('running', 'ok', 'partial', 'failed')
    or p_claimed_count not between 0 and 100
    or p_purged_count not between 0 and 100
    or p_retry_count not between 0 and 100
    or p_dead_letter_count not between 0 and 100
  then
    raise exception 'invalid Didit purge heartbeat'
      using errcode = '22023';
  end if;
  perform set_config('norva.didit_purge_control', 'managed', true);
  update affiliate_private.affiliate_didit_purge_worker_state state
  set
    last_started_at = case
      when p_outcome = 'running' then now()
      else state.last_started_at
    end,
    last_completed_at = case
      when p_outcome = 'running' then null
      else now()
    end,
    last_outcome = p_outcome,
    claimed_count = p_claimed_count,
    purged_count = p_purged_count,
    retry_count = p_retry_count,
    dead_letter_count = p_dead_letter_count,
    updated_at = now()
  where state.worker_name = 'didit_purge';
end;
$$;

create or replace function
affiliate_private.partners_service_didit_purge_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema_version', 1,
    'waiting_terminal', count(*) filter (
      where outbox.status = 'waiting_terminal'
    ),
    'pending', count(*) filter (where outbox.status in ('pending', 'retry')),
    'leased', count(*) filter (where outbox.status = 'leased'),
    'succeeded', count(*) filter (where outbox.status = 'succeeded'),
    'dead_letter', count(*) filter (where outbox.status = 'dead_letter'),
    'oldest_pending_seconds', coalesce(max(
      extract(epoch from statement_timestamp() - outbox.created_at)::bigint
    ) filter (where outbox.status in ('pending', 'retry', 'leased')), 0),
    'orphaned_source_pending', (
      select count(*)
      from (
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'member_kyc'::text as session_purpose
        from affiliate_private.affiliate_kyc_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_pending'
        union all
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'programme_certification'::text as session_purpose
        from affiliate_private.affiliate_didit_certification_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_pending'
      ) source
      where not exists (
        select 1
        from affiliate_private.affiliate_didit_purge_outbox missing_outbox
        where missing_outbox.provider_session_hash =
          source.provider_session_hash
          and missing_outbox.source_record_id = source.source_record_id
          and missing_outbox.provider_environment =
            source.provider_environment
          and missing_outbox.session_purpose = source.session_purpose
      )
    ),
    'orphaned_source_dead_letter', (
      select count(*)
      from (
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'member_kyc'::text as session_purpose
        from affiliate_private.affiliate_kyc_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_dead_letter'
        union all
        select
          session.id as source_record_id,
          session.provider_session_hash,
          session.provider_environment,
          'programme_certification'::text as session_purpose
        from affiliate_private.affiliate_didit_certification_sessions session
        where session.provider_session_hash is not null
          and session.provider_purge_status = 'purge_dead_letter'
      ) source
      where not exists (
        select 1
        from affiliate_private.affiliate_didit_purge_outbox missing_outbox
        where missing_outbox.provider_session_hash =
          source.provider_session_hash
          and missing_outbox.source_record_id = source.source_record_id
          and missing_outbox.provider_environment =
            source.provider_environment
          and missing_outbox.session_purpose = source.session_purpose
      )
    ),
    'worker', jsonb_build_object(
      'last_started_at', worker.last_started_at,
      'last_completed_at', worker.last_completed_at,
      'last_outcome', worker.last_outcome,
      'heartbeat_fresh', coalesce(
        worker.last_completed_at >= statement_timestamp() - interval '5 minutes',
        false
      )
    )
  )
  from affiliate_private.affiliate_didit_purge_worker_state worker
  left join affiliate_private.affiliate_didit_purge_outbox outbox on true
  where worker.worker_name = 'didit_purge'
  group by
    worker.last_started_at,
    worker.last_completed_at,
    worker.last_outcome;
$$;

create or replace function public.partners_service_didit_purge_claim(
  p_batch_size integer,
  p_lease_seconds integer
)
returns table (
  outbox_id bigint,
  lease_token uuid,
  provider_session_hash text,
  provider_session_envelope text,
  provider_environment text
)
language sql
volatile
security invoker
set search_path = ''
as $$
  select * from affiliate_private.partners_service_didit_purge_claim(
    p_batch_size,
    p_lease_seconds
  );
$$;

create or replace function public.partners_service_didit_purge_complete(
  p_outbox_id bigint,
  p_lease_token uuid,
  p_result text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_didit_purge_complete(
    p_outbox_id,
    p_lease_token,
    p_result
  );
$$;

create or replace function public.partners_service_didit_purge_fail(
  p_outbox_id bigint,
  p_lease_token uuid,
  p_error_code text,
  p_http_status integer,
  p_retryable boolean,
  p_retry_after_seconds integer default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_didit_purge_fail(
    p_outbox_id,
    p_lease_token,
    p_error_code,
    p_http_status,
    p_retryable,
    p_retry_after_seconds
  );
$$;

create or replace function public.partners_service_didit_purge_heartbeat(
  p_outcome text,
  p_claimed_count integer,
  p_purged_count integer,
  p_retry_count integer,
  p_dead_letter_count integer
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_didit_purge_heartbeat(
    p_outcome,
    p_claimed_count,
    p_purged_count,
    p_retry_count,
    p_dead_letter_count
  );
$$;

create or replace function public.partners_service_didit_purge_status()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_didit_purge_status();
$$;

create or replace function
affiliate_private.partners_didit_purge_coverage_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.status = 'approved'
      and session.verified
      and session.provider_environment = 'live'
      and session.provider_purge_status = 'purged'
      and session.provider_purged_at is not null
      and session.verified_at is not null
      and session.provider_purged_at >= session.verified_at
  );
$$;

-- Approval packages remain cryptographically current only while the exact
-- verification-coverage gate also has a completed provider deletion proof.
-- This function is intentionally redefined after approval_registry.
create or replace function
affiliate_private.partners_approval_package_is_current(
  p_approval_package_id uuid,
  p_gate_key text,
  p_deployment_environment text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      (p_gate_key is null or package.gate_key = p_gate_key)
      and package.deployment_environment = lower(
        btrim(coalesce(p_deployment_environment, ''))
      )
      and package.expires_at > statement_timestamp()
      and program.status in ('draft', 'active')
      and package.program_version_key = program.version_key
      and package.program_snapshot_sha256 =
        affiliate_private.partners_program_approval_snapshot_sha256(
          package.program_version_id
        )
      and package.deployment_manifest_sha256 = manifest.manifest_sha256
      and package.source_commit_sha = manifest.source_commit_sha
      and package.deployment_environment = manifest.deployment_environment
      and package.deployment_key = manifest.deployment_key
      and package.deployment_evidence_sha256 =
        manifest.deployment_evidence_sha256
      and manifest.document_hashes @> package.document_hashes
      and package.package_sha256 =
        affiliate_private.partners_approval_package_sha256(
          package.gate_key,
          package.package_version,
          package.program_version_key,
          package.program_snapshot_sha256,
          package.jurisdiction_scope,
          package.document_hashes,
          package.source_commit_sha,
          package.deployment_environment,
          package.deployment_key,
          package.deployment_evidence_sha256,
          package.deployment_manifest_sha256,
          package.approved_by_pseudonym,
          package.approved_at,
          package.expires_at,
          package.justification
        )
      and manifest.manifest_sha256 =
        affiliate_private.partners_deployment_manifest_sha256(
          manifest.deployment_environment,
          manifest.manifest_version,
          manifest.source_commit_sha,
          manifest.deployment_key,
          manifest.deployment_evidence_sha256,
          manifest.document_hashes,
          manifest.registered_by_pseudonym,
          manifest.registered_at,
          manifest.justification
        )
      and not exists (
        select 1
        from unnest(
          affiliate_private.partners_approval_required_document_keys(
            package.gate_key
          )
        ) required(document_key)
        where not package.document_hashes ? required.document_key
          or package.document_hashes ->> required.document_key
            !~ '^[0-9a-f]{64}$'
      )
      and not exists (
        select 1
        from jsonb_array_elements(package.jurisdiction_scope) scope(item)
        left join affiliate_private.affiliate_country_policies policy
          on policy.program_version_id = package.program_version_id
          and policy.country_code = scope.item ->> 'country_code'
          and policy.subdivision_code is not distinct from
            nullif(scope.item ->> 'subdivision_code', '')
        where policy.id is null
          or scope.item ->> 'policy_snapshot_sha256' is distinct from
            affiliate_private.partners_country_policy_approval_snapshot_sha256(
              policy.id
            )
      )
      and not exists (
        select 1
        from affiliate_private.affiliate_country_policies policy
        where policy.program_version_id = package.program_version_id
          and policy.individual_available
          and not exists (
            select 1
            from jsonb_array_elements(package.jurisdiction_scope) scope(item)
            where scope.item ->> 'country_code' = policy.country_code
              and nullif(scope.item ->> 'subdivision_code', '')
                is not distinct from policy.subdivision_code
              and scope.item ->> 'policy_snapshot_sha256' =
                affiliate_private.partners_country_policy_approval_snapshot_sha256(
                  policy.id
                )
          )
      )
      and (
        package.gate_key <>
          'individual_verification_coverage_confirmed'
        or affiliate_private.partners_didit_purge_coverage_ready()
      )
    from affiliate_private.affiliate_approval_packages package
    join affiliate_private.affiliate_program_versions program
      on program.id = package.program_version_id
    join affiliate_private.affiliate_deployment_manifests manifest
      on manifest.id = package.deployment_manifest_id
    join affiliate_private.affiliate_deployment_manifest_bindings
      manifest_binding
      on manifest_binding.deployment_environment =
        package.deployment_environment
      and manifest_binding.deployment_manifest_id = manifest.id
    where package.id = p_approval_package_id
  ), false);
$$;

-- Compatibility callers are always production-scoped. Keeping this as a
-- wrapper prevents an omitted environment from authorizing a sandbox package.
create or replace function
affiliate_private.partners_approval_package_is_current(
  p_approval_package_id uuid,
  p_gate_key text default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select affiliate_private.partners_approval_package_is_current(
    p_approval_package_id,
    p_gate_key,
    'production'
  );
$$;

revoke all on function
  affiliate_private.guard_didit_purge_managed_mutation(),
  affiliate_private.mark_member_didit_purge_pending(),
  affiliate_private.mark_certification_didit_purge_pending(),
  affiliate_private.guard_account_activation_until_didit_purged(),
  affiliate_private.guard_didit_purge_activation_audit()
from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.partners_didit_purge_public_status(text),
  affiliate_private.partners_didit_purge_sync_source(text, text, timestamptz),
  affiliate_private.partners_didit_purge_stage_member(text, text, text),
  affiliate_private.partners_didit_purge_activate_staged(text, text),
  affiliate_private.partners_didit_purge_enqueue(text, text, text),
  affiliate_private.partners_didit_purge_coverage_ready(),
  affiliate_private.partners_approval_package_is_current(uuid, text),
  affiliate_private.partners_approval_package_is_current(uuid, text, text)
from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  ),
  public.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  ),
  public.partners_service_kyc_session_record_v3(
    uuid, text, text, text, integer, text, timestamptz, text,
    text, text, integer, text
  )
to service_role;

revoke all on function
  affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  ),
  affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  ),
  affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  )
to service_role;

revoke all on function
  affiliate_private.partners_service_didit_purge_claim(integer, integer),
  affiliate_private.partners_service_didit_purge_complete(bigint, uuid, text),
  affiliate_private.partners_service_didit_purge_fail(
    bigint, uuid, text, integer, boolean, integer
  ),
  affiliate_private.partners_service_didit_purge_heartbeat(
    text, integer, integer, integer, integer
  ),
  affiliate_private.partners_service_didit_purge_status()
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_didit_purge_claim(integer, integer),
  affiliate_private.partners_service_didit_purge_complete(bigint, uuid, text),
  affiliate_private.partners_service_didit_purge_fail(
    bigint, uuid, text, integer, boolean, integer
  ),
  affiliate_private.partners_service_didit_purge_heartbeat(
    text, integer, integer, integer, integer
  ),
  affiliate_private.partners_service_didit_purge_status()
to service_role;

revoke all on function
  public.partners_service_kyc_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  ),
  public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  ),
  public.partners_service_didit_purge_claim(integer, integer),
  public.partners_service_didit_purge_complete(bigint, uuid, text),
  public.partners_service_didit_purge_fail(
    bigint, uuid, text, integer, boolean, integer
  ),
  public.partners_service_didit_purge_heartbeat(
    text, integer, integer, integer, integer
  ),
  public.partners_service_didit_purge_status()
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_kyc_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  ),
  public.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(
    text, text, text, integer, text, timestamptz, integer, text,
    boolean, boolean, boolean, text, text, text, text
  ),
  public.partners_service_didit_purge_claim(integer, integer),
  public.partners_service_didit_purge_complete(bigint, uuid, text),
  public.partners_service_didit_purge_fail(
    bigint, uuid, text, integer, boolean, integer
  ),
  public.partners_service_didit_purge_heartbeat(
    text, integer, integer, integer, integer
  ),
  public.partners_service_didit_purge_status()
to service_role;

comment on table affiliate_private.affiliate_didit_purge_outbox is
  'Private durable Didit deletion outbox. The only reversible provider identifier is an AES-GCM envelope cleared after a 204/404 proof.';
comment on table affiliate_private.affiliate_didit_purge_events is
  'Append-only bounded Didit deletion audit; it contains no provider identifier, encrypted envelope, secret or response body.';
comment on function public.partners_service_didit_purge_claim(
  integer, integer
) is
  'Service-only bounded lease claim for encrypted Didit deletion work.';
