-- Norva Partners: Airwallex Financial Reports reconciliation worker.
--
-- Airwallex documents the Financial Reports API and v1.1.0 field catalogue,
-- but not the complete physical CSV layout. The provider contract is therefore
-- version-pinned and Finance-approved per environment before any report row can
-- reach the existing settlement-observation RPC. Both environments start in
-- draft. This migration does not enable live payouts or any cron.

create table affiliate_private.affiliate_airwallex_report_contracts (
  environment             text primary key,
  contract_version        text not null,
  api_version             text not null,
  report_version          text not null,
  status                  text not null default 'draft',
  approved_evidence_hash  text,
  approved_by_pseudonym   text,
  approved_at             timestamptz,
  justification           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint affiliate_airwallex_report_contracts_environment
    check (environment in ('sandbox', 'production')),
  constraint affiliate_airwallex_report_contracts_version
    check (
      contract_version =
        'transaction_recon_csv_1_1_0_preamble_v1'
      and api_version = '2024-04-30'
      and report_version = '1.1.0'
    ),
  constraint affiliate_airwallex_report_contracts_status
    check (status in ('draft', 'approved', 'revoked')),
  constraint affiliate_airwallex_report_contracts_approval
    check (
      (
        status = 'approved'
        and approved_evidence_hash ~ '^[0-9a-f]{64}$'
        and approved_by_pseudonym ~ '^[0-9a-f]{64}$'
        and approved_at is not null
        and length(justification) between 12 and 1000
      )
      or (
        status in ('draft', 'revoked')
        and approved_evidence_hash is null
        and approved_by_pseudonym is null
        and approved_at is null
        and (
          justification is null
          or length(justification) between 12 and 1000
        )
      )
    )
);

insert into affiliate_private.affiliate_airwallex_report_contracts (
  environment,
  contract_version,
  api_version,
  report_version
)
values
  (
    'sandbox',
    'transaction_recon_csv_1_1_0_preamble_v1',
    '2024-04-30',
    '1.1.0'
  ),
  (
    'production',
    'transaction_recon_csv_1_1_0_preamble_v1',
    '2024-04-30',
    '1.1.0'
  );

create table affiliate_private.affiliate_airwallex_report_runs (
  id                      uuid primary key default gen_random_uuid(),
  report_key              text not null unique default (
    'afr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  environment             text not null
    references affiliate_private.affiliate_airwallex_report_contracts(
      environment
    )
    on delete restrict,
  contract_version        text not null,
  period_start            date not null,
  period_end              date not null,
  file_name               text not null,
  status                  text not null default 'planned',
  provider_report_id      text,
  provider_report_hash    text,
  provider_status         text,
  worker_id               text,
  lease_token_hash        text,
  leased_until            timestamptz,
  attempts                integer not null default 0,
  next_attempt_at         timestamptz not null default now(),
  content_sha256          text,
  content_bytes           integer,
  row_count               integer,
  candidate_count         integer,
  matched_count           integer,
  unmatched_count         integer,
  last_error_code         text,
  provider_completed_at   timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (
    environment,
    contract_version,
    period_start,
    period_end
  ),
  constraint affiliate_airwallex_report_runs_key
    check (report_key ~ '^afr_[0-9a-f]{24}$'),
  constraint affiliate_airwallex_report_runs_contract
    check (
      contract_version =
        'transaction_recon_csv_1_1_0_preamble_v1'
    ),
  constraint affiliate_airwallex_report_runs_period
    check (
      period_start >= date '2020-01-01'
      and period_end > period_start
      and period_end - period_start between 1 and 35
    ),
  constraint affiliate_airwallex_report_runs_file
    check (
      file_name ~
        '^NORVA_TRANSACTION_RECON_[0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9a-f]{12}[.]csv$'
    ),
  constraint affiliate_airwallex_report_runs_status
    check (
      status in (
        'planned',
        'leased',
        'pending',
        'retry',
        'completed',
        'exception'
      )
    ),
  constraint affiliate_airwallex_report_runs_provider
    check (
      (
        provider_report_id is null
        and provider_report_hash is null
        and provider_status is null
      )
      or (
        length(provider_report_id) between 8 and 128
        and provider_report_id !~ '[[:space:][:cntrl:]]'
        and provider_report_hash ~ '^[0-9a-f]{64}$'
        and provider_status in ('PENDING', 'COMPLETED')
      )
    ),
  constraint affiliate_airwallex_report_runs_lease
    check (
      (
        status <> 'leased'
        and worker_id is null
        and lease_token_hash is null
        and leased_until is null
      )
      or (
        status = 'leased'
        and worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
        and lease_token_hash ~ '^[0-9a-f]{64}$'
        and leased_until is not null
      )
    ),
  constraint affiliate_airwallex_report_runs_attempts
    check (attempts between 0 and 20),
  constraint affiliate_airwallex_report_runs_result
    check (
      (
        status = 'completed'
        and provider_status = 'COMPLETED'
        and content_sha256 ~ '^[0-9a-f]{64}$'
        and content_bytes between 16 and 8388608
        and row_count between 0 and 25000
        and candidate_count between 0 and 250
        and matched_count = candidate_count
        and unmatched_count = 0
        and completed_at is not null
      )
      or (
        status <> 'completed'
        and content_sha256 is null
        and content_bytes is null
        and row_count is null
        and candidate_count is null
        and matched_count is null
        and unmatched_count is null
        and completed_at is null
      )
    ),
  constraint affiliate_airwallex_report_runs_error
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    )
);

create unique index affiliate_airwallex_report_runs_provider_idx
  on affiliate_private.affiliate_airwallex_report_runs (
    environment,
    provider_report_hash
  )
  where provider_report_hash is not null;
create index affiliate_airwallex_report_runs_work_idx
  on affiliate_private.affiliate_airwallex_report_runs (
    environment,
    status,
    next_attempt_at,
    created_at
  );

alter table affiliate_private.affiliate_airwallex_report_contracts
  enable row level security;
alter table affiliate_private.affiliate_airwallex_report_contracts
  force row level security;
alter table affiliate_private.affiliate_airwallex_report_runs
  enable row level security;
alter table affiliate_private.affiliate_airwallex_report_runs
  force row level security;

revoke all on table
  affiliate_private.affiliate_airwallex_report_contracts,
  affiliate_private.affiliate_airwallex_report_runs
from public, anon, authenticated, service_role;

create or replace function
affiliate_private.admin_partners_airwallex_report_contract_set(
  p_environment text,
  p_approved boolean,
  p_evidence_hash text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_environment text := lower(btrim(coalesce(p_environment, '')));
  v_evidence text := lower(btrim(coalesce(p_evidence_hash, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_contract text := 'transaction_recon_csv_1_1_0_preamble_v1';
  v_actor text;
  v_row affiliate_private.affiliate_airwallex_report_contracts%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Airwallex report contract mutation requires AAL2'
      using errcode = '42501';
  end if;
  if v_environment not in ('sandbox', 'production')
    or p_approved is null
    or length(v_justification) not between 12 and 1000
    or (
      p_approved
      and (
        v_evidence !~ '^[0-9a-f]{64}$'
        or v_confirmation <>
          'APPROVE:AIRWALLEX_REPORT:' || v_environment || ':' || v_contract
      )
    )
    or (
      not p_approved
      and v_confirmation <>
        'REVOKE:AIRWALLEX_REPORT:' || v_environment || ':' || v_contract
    )
  then
    raise exception 'invalid Airwallex report contract mutation'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();

  update affiliate_private.affiliate_airwallex_report_contracts contract
  set
    status = case when p_approved then 'approved' else 'revoked' end,
    approved_evidence_hash = case when p_approved then v_evidence else null end,
    approved_by_pseudonym = case when p_approved then v_actor else null end,
    approved_at = case when p_approved then now() else null end,
    justification = v_justification,
    updated_at = now()
  where contract.environment = v_environment
    and contract.contract_version = v_contract
    and contract.api_version = '2024-04-30'
    and contract.report_version = '1.1.0'
  returning * into v_row;
  if not found then
    raise exception 'Airwallex report contract is unavailable'
      using errcode = 'P0002';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    'airwallex-report-contract:' || v_environment,
    case
      when p_approved then 'airwallex_report_contract_approved'
      else 'airwallex_report_contract_revoked'
    end,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'environment', v_environment,
      'contract_version', v_contract,
      'status', v_row.status,
      'evidence_hash', v_row.approved_evidence_hash
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_report_contract_set',
    'environment', v_environment,
    'contract_version', v_contract,
    'status', v_row.status,
    'approved_at', v_row.approved_at
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_report_lease(
  p_environment text,
  p_worker_id text,
  p_lease_token_hash text,
  p_lookback_days integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_environment text := lower(btrim(coalesce(p_environment, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_contract
    affiliate_private.affiliate_airwallex_report_contracts%rowtype;
  v_start date;
  v_end date := current_date;
  v_file_name text;
  v_until timestamptz;
  v_run affiliate_private.affiliate_airwallex_report_runs%rowtype;
begin
  if v_environment not in ('sandbox', 'production')
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_lookback_days not between 2 and 35
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'invalid Airwallex report lease'
      using errcode = '22023';
  end if;
  select contract.*
  into v_contract
  from affiliate_private.affiliate_airwallex_report_contracts contract
  where contract.environment = v_environment;
  if not found or v_contract.status <> 'approved' then
    raise exception 'Airwallex report contract is not Finance-approved'
      using errcode = 'P0001';
  end if;

  v_start := v_end - p_lookback_days;
  v_file_name :=
    'NORVA_TRANSACTION_RECON_' ||
    to_char(v_end, 'YYYY_MM_DD') || '_' ||
    left(
      encode(
        extensions.digest(
          concat_ws(
            ':',
            'norva:airwallex-report:v1',
            v_environment,
            v_contract.contract_version,
            v_start::text,
            v_end::text
          ),
          'sha256'
        ),
        'hex'
      ),
      12
    ) ||
    '.csv';

  if exists (
    select 1
    from affiliate_private.affiliate_payout_dispatches dispatch
    join affiliate_private.affiliate_payout_items item
      on item.id = dispatch.payout_item_id
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where dispatch.provider = 'airwallex'
      and dispatch.provider_transfer_id is not null
      and dispatch.provider_state = 'PAID'
      and dispatch.reconciliation_status = 'pending'
      and item.status = 'submitted'
      and cycle.status = 'submitted'
      and cycle.live_execution
      and dispatch.created_at::date between v_start and v_end
  ) then
    insert into affiliate_private.affiliate_airwallex_report_runs (
      environment,
      contract_version,
      period_start,
      period_end,
      file_name
    )
    values (
      v_environment,
      v_contract.contract_version,
      v_start,
      v_end,
      v_file_name
    )
    on conflict (
      environment,
      contract_version,
      period_start,
      period_end
    ) do nothing;
  end if;

  v_until := now() + make_interval(secs => p_lease_seconds);
  select run.*
  into v_run
  from affiliate_private.affiliate_airwallex_report_runs run
  where run.environment = v_environment
    and run.contract_version = v_contract.contract_version
    and run.period_start = v_start
    and run.period_end = v_end
    and run.attempts < 20
    and run.next_attempt_at <= now()
    and (
      run.status in ('planned', 'pending', 'retry')
      or (run.status = 'leased' and run.leased_until < now())
    )
  for update skip locked;

  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'airwallex_report_lease_empty',
      'contract', jsonb_build_object(
        'approved', true,
        'environment', v_contract.environment,
        'contract_version', v_contract.contract_version,
        'api_version', v_contract.api_version,
        'report_version', v_contract.report_version,
        'approved_at', v_contract.approved_at
      ),
      'run', null
    );
  end if;

  update affiliate_private.affiliate_airwallex_report_runs run
  set
    status = 'leased',
    worker_id = v_worker,
    lease_token_hash = v_lease,
    leased_until = v_until,
    attempts = run.attempts + 1,
    updated_at = now()
  where run.id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_report_leased',
    'contract', jsonb_build_object(
      'approved', true,
      'environment', v_contract.environment,
      'contract_version', v_contract.contract_version,
      'api_version', v_contract.api_version,
      'report_version', v_contract.report_version,
      'approved_at', v_contract.approved_at
    ),
    'run', jsonb_build_object(
      'key', v_run.report_key,
      'environment', v_run.environment,
      'contract_version', v_run.contract_version,
      'period_start', v_run.period_start,
      'period_end', v_run.period_end,
      'file_name', v_run.file_name,
      'provider_report_id', v_run.provider_report_id,
      'provider_status', v_run.provider_status,
      'attempt', v_run.attempts,
      'leased_until', v_run.leased_until
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_report_provider_record(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_provider_report_id text,
  p_provider_status text,
  p_retry_after_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_report_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_provider_id text := btrim(coalesce(p_provider_report_id, ''));
  v_status text := upper(btrim(coalesce(p_provider_status, '')));
  v_hash text;
  v_run affiliate_private.affiliate_airwallex_report_runs%rowtype;
begin
  if v_key !~ '^afr_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or length(v_provider_id) not between 8 and 128
    or v_provider_id ~ '[[:space:][:cntrl:]]'
    or v_status not in ('PENDING', 'COMPLETED')
    or p_retry_after_seconds not between 30 and 21600
  then
    raise exception 'invalid Airwallex report provider observation'
      using errcode = '22023';
  end if;
  v_hash := encode(extensions.digest(v_provider_id, 'sha256'), 'hex');

  select run.*
  into v_run
  from affiliate_private.affiliate_airwallex_report_runs run
  where run.report_key = v_key
  for update;
  if not found
    or v_run.status <> 'leased'
    or v_run.worker_id <> v_worker
    or v_run.lease_token_hash <> v_lease
    or v_run.leased_until < now()
    or (
      v_run.provider_report_hash is not null
      and v_run.provider_report_hash <> v_hash
    )
  then
    raise exception 'Airwallex report lease was lost'
      using errcode = 'P0004';
  end if;

  update affiliate_private.affiliate_airwallex_report_runs run
  set
    provider_report_id = v_provider_id,
    provider_report_hash = v_hash,
    provider_status = v_status,
    provider_completed_at = case
      when v_status = 'COMPLETED'
        then coalesce(run.provider_completed_at, now())
      else null
    end,
    status = case
      when v_status = 'PENDING' and run.attempts >= 20 then 'exception'
      when v_status = 'PENDING' then 'pending'
      else 'leased'
    end,
    worker_id = case when v_status = 'PENDING' then null else v_worker end,
    lease_token_hash = case when v_status = 'PENDING' then null else v_lease end,
    leased_until = case when v_status = 'PENDING' then null else v_run.leased_until end,
    next_attempt_at = case
      when v_status = 'PENDING' and run.attempts >= 20
        then now() + interval '100 years'
      when v_status = 'PENDING'
        then now() + make_interval(secs => p_retry_after_seconds)
      else run.next_attempt_at
    end,
    last_error_code = case
      when v_status = 'PENDING' and run.attempts >= 20
        then 'provider_report_pending_timeout'
      else null
    end,
    updated_at = now()
  where run.id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_report_provider_recorded',
    'run', jsonb_build_object(
      'key', v_run.report_key,
      'status', v_run.status,
      'provider_status', v_run.provider_status
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_report_candidates(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_key text := lower(btrim(coalesce(p_report_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_run affiliate_private.affiliate_airwallex_report_runs%rowtype;
  v_total integer;
  v_items jsonb;
begin
  if v_key !~ '^afr_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid Airwallex report candidates request'
      using errcode = '22023';
  end if;
  select run.*
  into v_run
  from affiliate_private.affiliate_airwallex_report_runs run
  join affiliate_private.affiliate_airwallex_report_contracts contract
    on contract.environment = run.environment
    and contract.contract_version = run.contract_version
    and contract.status = 'approved'
  where run.report_key = v_key
    and run.status = 'leased'
    and run.worker_id = v_worker
    and run.lease_token_hash = v_lease
    and run.leased_until >= now()
    and run.provider_status = 'COMPLETED';
  if not found then
    raise exception 'Airwallex report lease was lost'
      using errcode = 'P0004';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_payout_dispatches dispatch
  join affiliate_private.affiliate_payout_items item
    on item.id = dispatch.payout_item_id
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = item.cycle_id
  where dispatch.provider = 'airwallex'
    and dispatch.provider_transfer_id is not null
    and dispatch.provider_state = 'PAID'
    and dispatch.reconciliation_status = 'pending'
    and item.status = 'submitted'
    and cycle.status = 'submitted'
    and cycle.live_execution
    and dispatch.created_at::date
      between v_run.period_start and v_run.period_end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'dispatch_key', rows.dispatch_key,
        'request_id', rows.request_id,
        'provider_transfer_id', rows.provider_transfer_id,
        'amount_minor', rows.amount_minor,
        'currency', rows.currency,
        'currency_exponent', rows.currency_exponent,
        'created_at', rows.created_at
      )
      order by rows.created_at, rows.dispatch_key
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      dispatch.dispatch_key,
      dispatch.request_id,
      dispatch.provider_transfer_id,
      item.amount_minor,
      item.currency,
      cycle.currency_exponent,
      dispatch.created_at
    from affiliate_private.affiliate_payout_dispatches dispatch
    join affiliate_private.affiliate_payout_items item
      on item.id = dispatch.payout_item_id
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where dispatch.provider = 'airwallex'
      and dispatch.provider_transfer_id is not null
      and dispatch.provider_state = 'PAID'
      and dispatch.reconciliation_status = 'pending'
      and item.status = 'submitted'
      and cycle.status = 'submitted'
      and cycle.live_execution
      and dispatch.created_at::date
        between v_run.period_start and v_run.period_end
    order by dispatch.created_at, dispatch.id
    limit 250
  ) rows;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_report_candidates',
    'total', v_total,
    'truncated', v_total > 250,
    'items', v_items
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_report_apply(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_content_sha256 text,
  p_content_bytes integer,
  p_row_count integer,
  p_candidate_count integer,
  p_observations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_key text := lower(btrim(coalesce(p_report_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_hash text := lower(btrim(coalesce(p_content_sha256, '')));
  v_run affiliate_private.affiliate_airwallex_report_runs%rowtype;
  v_candidate_keys text[];
  v_input_keys text[];
  v_observation jsonb;
  v_observed jsonb;
  v_applied integer := 0;
begin
  if v_key !~ '^afr_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or v_hash !~ '^[0-9a-f]{64}$'
    or p_content_bytes not between 16 and 8388608
    or p_row_count not between 0 and 25000
    or p_candidate_count not between 0 and 250
    or jsonb_typeof(p_observations) <> 'array'
    or jsonb_array_length(p_observations) <> p_candidate_count
  then
    raise exception 'invalid Airwallex report application'
      using errcode = '22023';
  end if;

  select run.*
  into v_run
  from affiliate_private.affiliate_airwallex_report_runs run
  join affiliate_private.affiliate_airwallex_report_contracts contract
    on contract.environment = run.environment
    and contract.contract_version = run.contract_version
    and contract.status = 'approved'
    and contract.api_version = '2024-04-30'
    and contract.report_version = '1.1.0'
  where run.report_key = v_key
    and run.status = 'leased'
    and run.worker_id = v_worker
    and run.lease_token_hash = v_lease
    and run.leased_until >= now()
    and run.provider_status = 'COMPLETED'
  for update of run;
  if not found then
    raise exception 'Airwallex report lease was lost'
      using errcode = 'P0004';
  end if;

  select coalesce(
    array_agg(candidate.dispatch_key order by candidate.dispatch_key),
    array[]::text[]
  )
  into v_candidate_keys
  from (
    select dispatch.id, dispatch.dispatch_key
    from affiliate_private.affiliate_payout_dispatches dispatch
    join affiliate_private.affiliate_payout_items item
      on item.id = dispatch.payout_item_id
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where dispatch.provider = 'airwallex'
      and dispatch.provider_transfer_id is not null
      and dispatch.provider_state = 'PAID'
      and dispatch.reconciliation_status = 'pending'
      and item.status = 'submitted'
      and cycle.status = 'submitted'
      and cycle.live_execution
      and dispatch.created_at::date
        between v_run.period_start and v_run.period_end
    order by dispatch.dispatch_key
    for update of dispatch
  ) candidate;

  select coalesce(
    array_agg(
      observation.value ->> 'dispatch_key'
      order by observation.value ->> 'dispatch_key'
    ),
    array[]::text[]
  )
  into v_input_keys
  from jsonb_array_elements(p_observations) observation(value);

  if cardinality(v_candidate_keys) <> p_candidate_count
    or v_input_keys is distinct from v_candidate_keys
  then
    raise exception 'Airwallex report candidates changed before apply'
      using errcode = 'P0004';
  end if;

  for v_observation in
    select observation.value
    from jsonb_array_elements(p_observations) observation(value)
    order by observation.value ->> 'dispatch_key'
  loop
    if jsonb_typeof(v_observation) <> 'object'
      or (
        select array_agg(field.key order by field.key)
        from jsonb_object_keys(v_observation) field(key)
      ) is distinct from array[
        'amount_minor',
        'currency',
        'dispatch_key',
        'observed_at',
        'proof_hash',
        'provider_transfer_id',
        'settlement_reference',
        'value_date'
      ]::text[]
    then
      raise exception 'invalid Airwallex report observation envelope'
        using errcode = '22023';
    end if;

    v_observed :=
      affiliate_private.partners_service_airwallex_settlement_observe(
        v_observation ->> 'dispatch_key',
        v_observation ->> 'provider_transfer_id',
        v_observation ->> 'settlement_reference',
        v_observation ->> 'proof_hash',
        (v_observation ->> 'amount_minor')::bigint,
        v_observation ->> 'currency',
        (v_observation ->> 'value_date')::date,
        (v_observation ->> 'observed_at')::timestamptz,
        'partners-airwallex-report-v1'
      );
    if v_observed ->> 'action' <> 'airwallex_settlement_observed'
      or (v_observed -> 'observation' ->> 'key')
        !~ '^aso_[0-9a-f]{24}$'
    then
      raise exception 'invalid Airwallex settlement observation result'
        using errcode = 'P0004';
    end if;
    v_applied := v_applied + 1;
  end loop;

  update affiliate_private.affiliate_airwallex_report_runs run
  set
    status = 'completed',
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    content_sha256 = v_hash,
    content_bytes = p_content_bytes,
    row_count = p_row_count,
    candidate_count = p_candidate_count,
    matched_count = p_candidate_count,
    unmatched_count = 0,
    last_error_code = null,
    completed_at = now(),
    updated_at = now()
  where run.id = v_run.id
  returning * into v_run;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_report_applied',
    'observed_count', v_applied,
    'run', jsonb_build_object(
      'key', v_run.report_key,
      'status', v_run.status,
      'row_count', v_run.row_count,
      'candidate_count', v_run.candidate_count,
      'matched_count', v_run.matched_count,
      'unmatched_count', v_run.unmatched_count
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_airwallex_report_retry(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_error_code text,
  p_retry_after_seconds integer,
  p_terminal boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_report_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_error text := lower(btrim(coalesce(p_error_code, '')));
  v_run affiliate_private.affiliate_airwallex_report_runs%rowtype;
begin
  if v_key !~ '^afr_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or v_error !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    or p_retry_after_seconds not between 30 and 21600
    or p_terminal is null
  then
    raise exception 'invalid Airwallex report retry'
      using errcode = '22023';
  end if;

  update affiliate_private.affiliate_airwallex_report_runs run
  set
    status = case
      when p_terminal or run.attempts >= 20 then 'exception'
      else 'retry'
    end,
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    file_name = case
      when v_error = 'report_candidates_unmatched'
        and not p_terminal
        and run.attempts < 20
      then
        'NORVA_TRANSACTION_RECON_' ||
        to_char(run.period_end, 'YYYY_MM_DD') || '_' ||
        left(
          encode(
            extensions.digest(
              concat_ws(
                ':',
                'norva:airwallex-report-retry:v1',
                run.report_key,
                run.attempts::text
              ),
              'sha256'
            ),
            'hex'
          ),
          12
        ) ||
        '.csv'
      else run.file_name
    end,
    provider_report_id = case
      when v_error = 'report_candidates_unmatched'
        and not p_terminal
        and run.attempts < 20
      then null
      else run.provider_report_id
    end,
    provider_report_hash = case
      when v_error = 'report_candidates_unmatched'
        and not p_terminal
        and run.attempts < 20
      then null
      else run.provider_report_hash
    end,
    provider_status = case
      when v_error = 'report_candidates_unmatched'
        and not p_terminal
        and run.attempts < 20
      then null
      else run.provider_status
    end,
    provider_completed_at = case
      when v_error = 'report_candidates_unmatched'
        and not p_terminal
        and run.attempts < 20
      then null
      else run.provider_completed_at
    end,
    next_attempt_at = case
      when p_terminal or run.attempts >= 20
        then now() + interval '100 years'
      else now() + make_interval(secs => p_retry_after_seconds)
    end,
    last_error_code = v_error,
    updated_at = now()
  where run.report_key = v_key
    and run.status = 'leased'
    and run.worker_id = v_worker
    and run.lease_token_hash = v_lease
    and run.leased_until >= now()
  returning * into v_run;
  if not found then
    raise exception 'Airwallex report lease was lost'
      using errcode = 'P0004';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_report_retried',
    'run', jsonb_build_object(
      'key', v_run.report_key,
      'status', v_run.status,
      'error_code', v_run.last_error_code
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_airwallex_report_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contracts jsonb;
  v_runs jsonb;
  v_alerts jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'environment', contract.environment,
        'contract_version', contract.contract_version,
        'api_version', contract.api_version,
        'report_version', contract.report_version,
        'status', contract.status,
        'approved_at', contract.approved_at
      )
      order by contract.environment
    ),
    '[]'::jsonb
  )
  into v_contracts
  from affiliate_private.affiliate_airwallex_report_contracts contract;

  select coalesce(
    jsonb_agg(to_jsonb(rows)),
    '[]'::jsonb
  )
  into v_runs
  from (
    select
      run.report_key as key,
      run.environment,
      run.period_start,
      run.period_end,
      run.status,
      run.provider_status,
      run.attempts,
      run.row_count,
      run.candidate_count,
      run.matched_count,
      run.unmatched_count,
      run.last_error_code,
      run.created_at,
      run.updated_at,
      run.completed_at
    from affiliate_private.affiliate_airwallex_report_runs run
    order by run.created_at desc, run.id desc
    limit 25
  ) rows;

  with alerts as (
    select
      'airwallex_report_exception'::text as code,
      'critical'::text as severity,
      count(*)::bigint as count
    from affiliate_private.affiliate_airwallex_report_runs
    where status = 'exception'
    having count(*) > 0
    union all
    select
      'airwallex_report_stale',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_airwallex_report_runs
    where status in ('planned', 'leased', 'pending', 'retry')
      and updated_at < now() - interval '30 minutes'
    having count(*) > 0
    union all
    select
      'airwallex_report_candidates_unmatched',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_airwallex_report_runs
    where status = 'retry'
      and last_error_code = 'report_candidates_unmatched'
    having count(*) > 0
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', alerts.code,
        'severity', alerts.severity,
        'count', alerts.count
      )
      order by alerts.severity, alerts.code
    ),
    '[]'::jsonb
  )
  into v_alerts
  from alerts;

  return jsonb_build_object(
    'schema_version', 1,
    'contracts', v_contracts,
    'runs', v_runs,
    'alerts', v_alerts
  );
end;
$$;

-- Add a distinct, observable heartbeat for the Financial Reports worker.
alter table affiliate_private.affiliate_worker_heartbeats
  drop constraint if exists affiliate_worker_heartbeats_name;
alter table affiliate_private.affiliate_worker_heartbeats
  add constraint affiliate_worker_heartbeats_name
  check (
    worker_name in (
      'commission',
      'correction',
      'maturation',
      'reconciliation',
      'payout',
      'payout_report',
      'revenuecat_transfer'
    )
  );

create or replace function affiliate_private.partners_worker_heartbeat(
  p_worker_name text,
  p_status text,
  p_details jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := lower(btrim(coalesce(p_worker_name, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if v_worker not in (
    'commission',
    'correction',
    'maturation',
    'reconciliation',
    'payout',
    'payout_report',
    'revenuecat_transfer'
  )
    or v_status not in ('healthy', 'degraded', 'blocked')
    or jsonb_typeof(v_details) <> 'object'
    or v_details ?| array[
      'email', 'token', 'secret', 'payload', 'user_id', 'account_id',
      'provider_report_id', 'request_id', 'provider_transfer_id'
    ]::text[]
  then
    raise exception 'invalid worker heartbeat'
      using errcode = '22023';
  end if;
  insert into affiliate_private.affiliate_worker_heartbeats (
    worker_name,
    status,
    last_seen_at,
    details,
    updated_at
  )
  values (v_worker, v_status, now(), v_details, now())
  on conflict (worker_name) do update
  set
    status = excluded.status,
    last_seen_at = excluded.last_seen_at,
    details = excluded.details,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'worker_heartbeat_recorded',
    'worker', v_worker,
    'status', v_status
  );
end;
$$;

-- Keep the final monitoring projection cumulative. The report worker is an
-- expected production worker once this migration is installed, and report
-- failures must surface through the same Ops endpoint used by the alert sweep.
create or replace function affiliate_private.partners_ops_alert_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_workers jsonb;
  v_alerts jsonb;
  v_kyc_used bigint;
begin
  with expected(worker_name) as (
    values
      ('commission'::text),
      ('correction'::text),
      ('maturation'::text),
      ('reconciliation'::text),
      ('payout'::text),
      ('payout_report'::text),
      ('revenuecat_transfer'::text)
  )
  select jsonb_agg(
    jsonb_build_object(
      'worker', e.worker_name,
      'status', case
        when h.worker_name is null then 'not_configured'
        when h.last_seen_at < now() - interval '15 minutes' then 'stale'
        else h.status
      end,
      'last_seen_at', h.last_seen_at
    )
    order by e.worker_name
  )
  into v_workers
  from expected e
  left join affiliate_private.affiliate_worker_heartbeats h
    on h.worker_name = e.worker_name;

  select count(*)
  into v_kyc_used
  from affiliate_private.affiliate_kyc_sessions
  where created_at >= now() - interval '30 days';

  with alerts as (
    select
      'commission_dead_letter'::text as code,
      'critical'::text as severity,
      count(*)::bigint as count
    from affiliate_private.affiliate_commission_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'chargeback_reversal_dead_letter',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_revolut_dispute_won_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'chargeback_reversal_conflict',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_revolut_dispute_won_conflicts
    having count(*) > 0
    union all
    select
      'maturation_dead_letter',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_maturation_jobs
    where status = 'dead_letter'
    having count(*) > 0
    union all
    select
      'financial_fact_conflict',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_financial_fact_conflicts
    having count(*) > 0
    union all
    select
      'financial_transfer_quarantined_recent',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_financial_facts
    where event_type = 'transfer'
      and facts_status = 'quarantined'
      and created_at >= now() - interval '24 hours'
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_dead_letter',
      'critical',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'dead_letter'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_partial_aged',
      'warning',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'partial'
        and first_seen_at < now() - interval '15 minutes'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_quarantined_aged',
      'warning',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'quarantined'
        and first_seen_at < now() - interval '15 minutes'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'revenuecat_transfer_partner_dead_letter',
      'critical',
      count(*)::bigint
    from (
      select 1
      from public.cloud_revenuecat_transfer_events
      where status = 'applied'
        and partner_status = 'dead_letter'
      limit 1000000
    ) bounded
    having count(*) > 0
    union all
    select
      'airwallex_report_exception',
      'critical',
      count(*)::bigint
    from affiliate_private.affiliate_airwallex_report_runs
    where status = 'exception'
    having count(*) > 0
    union all
    select
      'airwallex_report_stale',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_airwallex_report_runs
    where status in ('planned', 'leased', 'pending', 'retry')
      and updated_at < now() - interval '30 minutes'
    having count(*) > 0
    union all
    select
      'airwallex_report_candidates_unmatched',
      'warning',
      count(*)::bigint
    from affiliate_private.affiliate_airwallex_report_runs
    where status = 'retry'
      and last_error_code = 'report_candidates_unmatched'
    having count(*) > 0
    union all
    select
      'shadow_reconciliation_mismatch',
      'critical',
      r.mismatch_count
    from affiliate_private.affiliate_shadow_reconciliation_runs r
    where r.id = (
      select latest.id
      from affiliate_private.affiliate_shadow_reconciliation_runs latest
      order by latest.created_at desc
      limit 1
    )
      and r.status = 'mismatch'
    union all
    select
      'kyc_quota_warning',
      case when v_kyc_used >= 500 then 'critical' else 'warning' end,
      v_kyc_used
    where v_kyc_used >= 400
    union all
    select
      'worker_heartbeat_missing',
      'critical',
      count(*)::bigint
    from (
      values
        ('commission'::text),
        ('correction'::text),
        ('maturation'::text),
        ('reconciliation'::text),
        ('payout'::text),
        ('payout_report'::text),
        ('revenuecat_transfer'::text)
    ) expected(worker_name)
    left join affiliate_private.affiliate_worker_heartbeats h
      on h.worker_name = expected.worker_name
      and h.last_seen_at >= now() - interval '15 minutes'
    where h.worker_name is null
    having count(*) > 0
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', a.code,
        'severity', a.severity,
        'count', a.count
      )
      order by a.severity, a.code
    ),
    '[]'::jsonb
  )
  into v_alerts
  from alerts a;

  return jsonb_build_object(
    'schema_version', 1,
    'workers', v_workers,
    'alerts', v_alerts,
    'kyc_quota', jsonb_build_object(
      'used', v_kyc_used,
      'informational_limit', 500,
      'blocking', false
    )
  );
end;
$$;

create or replace function
public.admin_partners_airwallex_report_contract_set(
  p_environment text,
  p_approved boolean,
  p_evidence_hash text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_airwallex_report_contract_set(
      p_environment,
      p_approved,
      p_evidence_hash,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.partners_worker_airwallex_report_lease(
  p_environment text,
  p_worker_id text,
  p_lease_token_hash text,
  p_lookback_days integer,
  p_lease_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_airwallex_report_lease(
    p_environment,
    p_worker_id,
    p_lease_token_hash,
    p_lookback_days,
    p_lease_seconds
  );
$$;

create or replace function
public.partners_worker_airwallex_report_provider_record(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_provider_report_id text,
  p_provider_status text,
  p_retry_after_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_airwallex_report_provider_record(
      p_report_key,
      p_worker_id,
      p_lease_token_hash,
      p_provider_report_id,
      p_provider_status,
      p_retry_after_seconds
    );
$$;

create or replace function
public.partners_worker_airwallex_report_candidates(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_airwallex_report_candidates(
      p_report_key,
      p_worker_id,
      p_lease_token_hash
    );
$$;

create or replace function
public.partners_worker_airwallex_report_apply(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_content_sha256 text,
  p_content_bytes integer,
  p_row_count integer,
  p_candidate_count integer,
  p_observations jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_airwallex_report_apply(
    p_report_key,
    p_worker_id,
    p_lease_token_hash,
    p_content_sha256,
    p_content_bytes,
    p_row_count,
    p_candidate_count,
    p_observations
  );
$$;

create or replace function
public.partners_worker_airwallex_report_retry(
  p_report_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_error_code text,
  p_retry_after_seconds integer,
  p_terminal boolean
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_airwallex_report_retry(
    p_report_key,
    p_worker_id,
    p_lease_token_hash,
    p_error_code,
    p_retry_after_seconds,
    p_terminal
  );
$$;

create or replace function
public.admin_partners_airwallex_report_status()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_airwallex_report_status();
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'affiliate_private.admin_partners_airwallex_report_contract_set(text,boolean,text,text,text)',
    'affiliate_private.partners_worker_airwallex_report_lease(text,text,text,integer,integer)',
    'affiliate_private.partners_worker_airwallex_report_provider_record(text,text,text,text,text,integer)',
    'affiliate_private.partners_worker_airwallex_report_candidates(text,text,text)',
    'affiliate_private.partners_worker_airwallex_report_apply(text,text,text,text,integer,integer,integer,jsonb)',
    'affiliate_private.partners_worker_airwallex_report_retry(text,text,text,text,integer,boolean)',
    'affiliate_private.admin_partners_airwallex_report_status()',
    'public.admin_partners_airwallex_report_contract_set(text,boolean,text,text,text)',
    'public.partners_worker_airwallex_report_lease(text,text,text,integer,integer)',
    'public.partners_worker_airwallex_report_provider_record(text,text,text,text,text,integer)',
    'public.partners_worker_airwallex_report_candidates(text,text,text)',
    'public.partners_worker_airwallex_report_apply(text,text,text,text,integer,integer,integer,jsonb)',
    'public.partners_worker_airwallex_report_retry(text,text,text,text,integer,boolean)',
    'public.admin_partners_airwallex_report_status()'
  ]
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      v_signature
    );
  end loop;
end;
$$;

grant execute on function
  affiliate_private.admin_partners_airwallex_report_contract_set(
    text, boolean, text, text, text
  ),
  affiliate_private.admin_partners_airwallex_report_status(),
  public.admin_partners_airwallex_report_contract_set(
    text, boolean, text, text, text
  ),
  public.admin_partners_airwallex_report_status()
to authenticated;

grant execute on function
  affiliate_private.partners_worker_airwallex_report_lease(
    text, text, text, integer, integer
  ),
  affiliate_private.partners_worker_airwallex_report_provider_record(
    text, text, text, text, text, integer
  ),
  affiliate_private.partners_worker_airwallex_report_candidates(
    text, text, text
  ),
  affiliate_private.partners_worker_airwallex_report_apply(
    text, text, text, text, integer, integer, integer, jsonb
  ),
  affiliate_private.partners_worker_airwallex_report_retry(
    text, text, text, text, integer, boolean
  ),
  public.partners_worker_airwallex_report_lease(
    text, text, text, integer, integer
  ),
  public.partners_worker_airwallex_report_provider_record(
    text, text, text, text, text, integer
  ),
  public.partners_worker_airwallex_report_candidates(
    text, text, text
  ),
  public.partners_worker_airwallex_report_apply(
    text, text, text, text, integer, integer, integer, jsonb
  ),
  public.partners_worker_airwallex_report_retry(
    text, text, text, text, integer, boolean
  )
to service_role;

-- Settlement observations are accepted only as part of the owner-executed,
-- all-candidates atomic report apply above. No API role may submit a standalone
-- settlement observation after the authoritative report pipeline exists.
revoke all on function
  affiliate_private.partners_service_airwallex_settlement_observe(
    text, text, text, text, bigint, text, date, timestamptz, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_airwallex_settlement_observe(
    text, text, text, text, bigint, text, date, timestamptz, text
  )
from public, anon, authenticated, service_role;

comment on table
  affiliate_private.affiliate_airwallex_report_contracts is
  'Finance-approved, environment-specific parser contract. No provider PII.';
comment on table
  affiliate_private.affiliate_airwallex_report_runs is
  'Private async report state. Provider identifiers are never exposed publicly.';
comment on function
  public.partners_worker_airwallex_report_candidates(text,text,text) is
  'Returns only bounded service-role payout correlation fields; no beneficiary data.';

notify pgrst, 'reload schema';
