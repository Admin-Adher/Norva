-- Norva Partners - post-hardening two-person Airwallex settlement reconciliation.
--
-- Airwallex PAID remains an observation, never proof of settlement by itself.
-- A service worker records a minimized, hashed settlement observation; a
-- first human Finance actor reviews it and a second, distinct human Finance
-- actor confirms or quarantines it. Only confirmation creates the immutable,
-- balanced settlement ledger entry and advances the payout item/cycle. No
-- provider identifier, response body, bank coordinate, or settlement document
-- is retained.

create table
affiliate_private.affiliate_airwallex_settlement_observations (
  id                         uuid primary key default gen_random_uuid(),
  observation_key            text not null unique default (
    'aso_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  dispatch_id                 uuid not null
    references affiliate_private.affiliate_payout_dispatches(id)
    on delete restrict,
  observation_kind           text not null,
  evidence_source             text not null
    default 'transaction_reconciliation_report',
  provider_state              text not null,
  provider_reference_hash     text not null,
  proof_hash                  text not null unique,
  amount_minor                bigint not null,
  currency                    text not null,
  value_date                  date not null,
  observed_at                 timestamptz not null,
  observer_actor_pseudonym    text not null,
  created_at                  timestamptz not null default now(),
  constraint affiliate_airwallex_settlement_observations_key
    check (observation_key ~ '^aso_[0-9a-f]{24}$'),
  constraint affiliate_airwallex_settlement_observations_kind
    check (
      observation_kind in ('settlement_evidence', 'post_settlement_exception')
    ),
  constraint affiliate_airwallex_settlement_observations_source
    check (
      evidence_source in (
        'transaction_reconciliation_report',
        'post_settlement_provider_observation'
      )
      and (
        (
          observation_kind = 'settlement_evidence'
          and evidence_source = 'transaction_reconciliation_report'
        )
        or (
          observation_kind = 'post_settlement_exception'
          and evidence_source = 'post_settlement_provider_observation'
        )
      )
    ),
  constraint affiliate_airwallex_settlement_observations_state
    check (
      (
        observation_kind = 'settlement_evidence'
        and provider_state = 'PAID'
      )
      or (
        observation_kind = 'post_settlement_exception'
        and provider_state in ('FAILED', 'CANCELLED', 'REVERSED')
      )
    ),
  constraint affiliate_airwallex_settlement_observations_hashes
    check (
      provider_reference_hash ~ '^[0-9a-f]{64}$'
      and proof_hash ~ '^[0-9a-f]{64}$'
      and observer_actor_pseudonym ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_airwallex_settlement_observations_money
    check (
      amount_minor between 1 and 9007199254740991
      and currency ~ '^[A-Z]{3}$'
    ),
  constraint affiliate_airwallex_settlement_observations_time
    check (
      value_date >= date '2020-01-01'
      and value_date <= (observed_at at time zone 'UTC')::date + 1
      and observed_at <= created_at + interval '5 minutes'
    ),
  unique (id, dispatch_id)
);

create index affiliate_airwallex_settlement_observations_dispatch_idx
  on affiliate_private.affiliate_airwallex_settlement_observations (
    dispatch_id,
    created_at desc,
    id
  );

create table affiliate_private.affiliate_airwallex_settlement_reviews (
  id                         uuid primary key default gen_random_uuid(),
  review_key                 text not null unique default (
    'asr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  observation_id             uuid not null unique,
  dispatch_id                uuid not null,
  review_actor_pseudonym     text not null,
  confirmation_hash          text not null unique,
  justification              text not null,
  created_at                 timestamptz not null default now(),
  constraint affiliate_airwallex_settlement_reviews_observation_fk
    foreign key (observation_id, dispatch_id)
    references
      affiliate_private.affiliate_airwallex_settlement_observations(
        id,
        dispatch_id
      )
    on delete restrict,
  constraint affiliate_airwallex_settlement_reviews_key
    check (review_key ~ '^asr_[0-9a-f]{24}$'),
  constraint affiliate_airwallex_settlement_reviews_actor
    check (review_actor_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_airwallex_settlement_reviews_confirmation
    check (confirmation_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_airwallex_settlement_reviews_justification
    check (length(btrim(justification)) between 12 and 1000),
  unique (id, observation_id, dispatch_id)
);

create index affiliate_airwallex_settlement_reviews_dispatch_idx
  on affiliate_private.affiliate_airwallex_settlement_reviews (
    dispatch_id,
    created_at desc,
    id
  );

create table affiliate_private.affiliate_airwallex_settlement_decisions (
  id                         uuid primary key default gen_random_uuid(),
  decision_key               text not null unique default (
    'asd_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  observation_id             uuid not null unique,
  review_id                  uuid not null unique,
  dispatch_id                uuid not null,
  decision                    text not null,
  decision_actor_pseudonym    text not null,
  confirmation_hash          text not null,
  justification              text not null,
  settlement_entry_id        uuid unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  created_at                  timestamptz not null default now(),
  constraint affiliate_airwallex_settlement_decisions_observation_fk
    foreign key (observation_id, dispatch_id)
    references
      affiliate_private.affiliate_airwallex_settlement_observations(
        id,
        dispatch_id
      )
    on delete restrict,
  constraint affiliate_airwallex_settlement_decisions_review_fk
    foreign key (review_id, observation_id, dispatch_id)
    references
      affiliate_private.affiliate_airwallex_settlement_reviews(
        id,
        observation_id,
        dispatch_id
      )
    on delete restrict,
  constraint affiliate_airwallex_settlement_decisions_key
    check (decision_key ~ '^asd_[0-9a-f]{24}$'),
  constraint affiliate_airwallex_settlement_decisions_value
    check (decision in ('confirmed', 'quarantined')),
  constraint affiliate_airwallex_settlement_decisions_actor
    check (decision_actor_pseudonym ~ '^[0-9a-f]{64}$'),
  constraint affiliate_airwallex_settlement_decisions_confirmation
    check (confirmation_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_airwallex_settlement_decisions_justification
    check (length(btrim(justification)) between 12 and 1000),
  constraint affiliate_airwallex_settlement_decisions_ledger
    check (
      (decision = 'confirmed') = (settlement_entry_id is not null)
    )
);

create unique index affiliate_airwallex_settlement_confirmed_dispatch_idx
  on affiliate_private.affiliate_airwallex_settlement_decisions (dispatch_id)
  where decision = 'confirmed';
create index affiliate_airwallex_settlement_decisions_dispatch_idx
  on affiliate_private.affiliate_airwallex_settlement_decisions (
    dispatch_id,
    created_at desc,
    id
  );

-- A payout allocation can be settled only once. PostgreSQL uniqueness over
-- (entry_kind, fact_id) does not cover payout settlements because fact_id is
-- intentionally NULL for those entries.
create unique index affiliate_payout_settlement_allocation_once_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where entry_kind = 'payout_settlement';

alter table affiliate_private.affiliate_airwallex_settlement_observations
  enable row level security;
alter table affiliate_private.affiliate_airwallex_settlement_reviews
  enable row level security;
alter table affiliate_private.affiliate_airwallex_settlement_decisions
  enable row level security;

revoke all on table
  affiliate_private.affiliate_airwallex_settlement_observations,
  affiliate_private.affiliate_airwallex_settlement_reviews,
  affiliate_private.affiliate_airwallex_settlement_decisions
from public, anon, authenticated, service_role;

create trigger affiliate_airwallex_settlement_observations_append_only
before update or delete
on affiliate_private.affiliate_airwallex_settlement_observations
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

create trigger affiliate_airwallex_settlement_reviews_append_only
before update or delete
on affiliate_private.affiliate_airwallex_settlement_reviews
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

create trigger affiliate_airwallex_settlement_decisions_append_only
before update or delete
on affiliate_private.affiliate_airwallex_settlement_decisions
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

create or replace function
affiliate_private.guard_airwallex_settlement_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_observation
    affiliate_private.affiliate_airwallex_settlement_observations%rowtype;
  v_review
    affiliate_private.affiliate_airwallex_settlement_reviews%rowtype;
begin
  select observation.*
  into strict v_observation
  from affiliate_private.affiliate_airwallex_settlement_observations observation
  where observation.id = new.observation_id
    and observation.dispatch_id = new.dispatch_id;

  select review.*
  into strict v_review
  from affiliate_private.affiliate_airwallex_settlement_reviews review
  where review.id = new.review_id
    and review.observation_id = new.observation_id
    and review.dispatch_id = new.dispatch_id;

  if v_review.review_actor_pseudonym = new.decision_actor_pseudonym
  then
    raise exception 'settlement review and decision require distinct Finance actors'
      using errcode = '42501';
  end if;
  if new.decision = 'confirmed'
    and (
      v_observation.observation_kind <> 'settlement_evidence'
      or v_observation.provider_state <> 'PAID'
    )
  then
    raise exception 'only PAID settlement evidence can be confirmed'
      using errcode = '23514';
  end if;
  if new.decision = 'confirmed'
    and not exists (
      select 1
      from affiliate_private.affiliate_payout_dispatches dispatch
      join affiliate_private.affiliate_payout_items item
        on item.id = dispatch.payout_item_id
      join affiliate_private.affiliate_payout_cycles cycle
        on cycle.id = item.cycle_id
      join affiliate_private.affiliate_commission_entries settlement
        on settlement.id = new.settlement_entry_id
      where dispatch.id = new.dispatch_id
        and item.allocation_entry_id = settlement.related_entry_id
        and settlement.entry_kind = 'payout_settlement'
        and settlement.account_id = item.account_id
        and settlement.amount_minor = v_observation.amount_minor
        and settlement.currency = v_observation.currency
        and settlement.currency_exponent = cycle.currency_exponent
        and (
          select count(*)
          from affiliate_private.affiliate_commission_postings posting
          where posting.entry_id = settlement.id
            and (
              (
                posting.ledger_account = 'partner_payout_clearing'
                and posting.direction = 'debit'
              )
              or (
                posting.ledger_account = 'partner_cash_settled'
                and posting.direction = 'credit'
              )
            )
            and posting.amount_minor = v_observation.amount_minor
            and posting.currency = v_observation.currency
        ) = 2
    )
  then
    raise exception 'settlement decision ledger does not match its evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_airwallex_settlement_decision_guard
before insert on affiliate_private.affiliate_airwallex_settlement_decisions
for each row execute function
  affiliate_private.guard_airwallex_settlement_decision();

create or replace function
affiliate_private.assert_payout_settlement_semantics()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allocation affiliate_private.affiliate_commission_entries%rowtype;
  v_posting_count integer;
  v_expected_count integer;
begin
  if new.entry_kind <> 'payout_settlement' then
    return null;
  end if;

  select allocation.*
  into v_allocation
  from affiliate_private.affiliate_commission_entries allocation
  where allocation.id = new.related_entry_id
    and allocation.entry_kind = 'payout_allocation';

  if not found
    or v_allocation.account_id is distinct from new.account_id
    or v_allocation.currency is distinct from new.currency
    or v_allocation.currency_exponent is distinct from new.currency_exponent
    or v_allocation.amount_minor is distinct from new.amount_minor
  then
    raise exception 'payout settlement does not match its allocation'
      using errcode = '23514';
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where posting.currency = new.currency
        and posting.amount_minor = new.amount_minor
        and (
          (
            posting.ledger_account = 'partner_payout_clearing'
            and posting.direction = 'debit'
          )
          or (
            posting.ledger_account = 'partner_cash_settled'
            and posting.direction = 'credit'
          )
        )
    )::integer
  into v_posting_count, v_expected_count
  from affiliate_private.affiliate_commission_postings posting
  where posting.entry_id = new.id;

  if v_posting_count <> 2 or v_expected_count <> 2 then
    raise exception 'payout settlement postings are not canonical'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger affiliate_payout_settlement_semantics
after insert on affiliate_private.affiliate_commission_entries
deferrable initially deferred
for each row execute function
  affiliate_private.assert_payout_settlement_semantics();

-- The original adapter required REVERSED to map only to `reversed`. Once a
-- transfer has been financially confirmed, a late reversal is instead an
-- exception requiring investigation; the settled ledger must not be rewritten.
alter table affiliate_private.affiliate_payout_dispatches
  drop constraint affiliate_payout_dispatches_reconciliation;
alter table affiliate_private.affiliate_payout_dispatches
  add constraint affiliate_payout_dispatches_reconciliation
  check (
    reconciliation_status in (
      'not_ready',
      'pending',
      'confirmed',
      'exception',
      'reversed'
    )
    and (
      provider_state <> 'PAID'
      or reconciliation_status in ('pending', 'confirmed', 'exception')
    )
    and (
      provider_state <> 'REVERSED'
      or reconciliation_status in ('reversed', 'exception')
    )
  );

alter table affiliate_private.affiliate_payout_dispatches
  drop constraint affiliate_payout_dispatches_job_status;
alter table affiliate_private.affiliate_payout_dispatches
  add constraint affiliate_payout_dispatches_job_status
  check (
    job_status in (
      'pending',
      'leased',
      'observing',
      'settled',
      'exception',
      'dead_letter'
    )
  );

create or replace function
affiliate_private.guard_airwallex_post_settlement_dispatch()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_settlement
    affiliate_private.affiliate_airwallex_settlement_observations%rowtype;
  v_proof_hash text;
begin
  -- Quarantine, conflicting evidence and post-settlement exceptions are
  -- terminal operator decisions.  The provider observation RPC predates this
  -- reconciliation workflow and projects every fresh PAID event back to
  -- pending/observing.  Preserve the terminal projection here so a later
  -- provider event cannot reopen an already undecidable Finance queue row.
  if old.reconciliation_status = 'exception' then
    if new.provider is distinct from old.provider
      or new.request_id is distinct from old.request_id
      or new.payout_item_id is distinct from old.payout_item_id
      or new.provider_transfer_id is distinct from old.provider_transfer_id
      or new.provider_transfer_hash is distinct from old.provider_transfer_hash
    then
      raise exception 'exception payout dispatch identity is immutable'
        using errcode = '55000';
    end if;

    new.reconciliation_status := 'exception';
    new.job_status := 'exception';
    new.worker_id := null;
    new.lease_token_hash := null;
    new.leased_until := null;
    new.next_attempt_at := greatest(
      new.next_attempt_at,
      now() + interval '100 years'
    );
    new.last_error_code := coalesce(
      old.last_error_code,
      'settlement_exception'
    );
    return new;
  end if;

  if old.reconciliation_status <> 'confirmed' then
    if new.reconciliation_status = 'confirmed' then
      if new.provider_state <> 'PAID'
        or new.provider_transfer_id is null
        or new.provider_transfer_hash is null
        or new.provider is distinct from old.provider
        or new.request_id is distinct from old.request_id
        or new.payout_item_id is distinct from old.payout_item_id
        or new.provider_transfer_id is distinct from old.provider_transfer_id
        or new.provider_transfer_hash is distinct from
          old.provider_transfer_hash
        or not exists (
          select 1
          from affiliate_private.affiliate_airwallex_settlement_decisions
            decision
          join affiliate_private.affiliate_airwallex_settlement_observations
            observation
            on observation.id = decision.observation_id
            and observation.dispatch_id = decision.dispatch_id
          join affiliate_private.affiliate_payout_items item
            on item.id = new.payout_item_id
          where decision.dispatch_id = new.id
            and decision.decision = 'confirmed'
            and observation.observation_kind = 'settlement_evidence'
            and observation.provider_state = 'PAID'
            and item.status = 'settled'
            and item.provider_transfer_hash is not distinct from
              new.provider_transfer_hash
        )
      then
        raise exception 'confirmed settlement projection is incomplete'
          using errcode = 'P0004';
      end if;
      new.job_status := 'settled';
      new.worker_id := null;
      new.lease_token_hash := null;
      new.leased_until := null;
      new.next_attempt_at := now() + interval '100 years';
      new.last_error_code := null;
    end if;
    return new;
  end if;

  if new.provider is distinct from old.provider
    or new.request_id is distinct from old.request_id
    or new.payout_item_id is distinct from old.payout_item_id
    or new.provider_transfer_id is distinct from old.provider_transfer_id
    or new.provider_transfer_hash is distinct from old.provider_transfer_hash
  then
    raise exception 'confirmed payout dispatch identity is immutable'
      using errcode = '55000';
  end if;

  -- Replayed PAID observations may refresh provider timestamps, but they can
  -- never demote a confirmed reconciliation.
  if new.provider_state = 'PAID' then
    new.reconciliation_status := 'confirmed';
    new.job_status := 'settled';
    new.worker_id := null;
    new.lease_token_hash := null;
    new.leased_until := null;
    new.last_error_code := null;
    new.next_attempt_at := greatest(
      new.next_attempt_at,
      now() + interval '100 years'
    );
    return new;
  end if;

  if new.provider_state not in ('FAILED', 'CANCELLED', 'REVERSED') then
    raise exception 'confirmed settlement cannot regress'
      using errcode = 'P0006';
  end if;

  select observation.*
  into strict v_settlement
  from affiliate_private.affiliate_airwallex_settlement_decisions decision
  join affiliate_private.affiliate_airwallex_settlement_observations observation
    on observation.id = decision.observation_id
    and observation.dispatch_id = decision.dispatch_id
  where decision.dispatch_id = old.id
    and decision.decision = 'confirmed';

  v_proof_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'airwallex-post-settlement-exception:v1',
        old.id::text,
        new.provider_state,
        coalesce(new.provider_status, ''),
        coalesce(new.funding_status, ''),
        coalesce(new.provider_updated_at::text, ''),
        coalesce(new.provider_transfer_hash, '')
      ),
      'sha256'
    ),
    'hex'
  );

  insert into
    affiliate_private.affiliate_airwallex_settlement_observations (
      dispatch_id,
      observation_kind,
      evidence_source,
      provider_state,
      provider_reference_hash,
      proof_hash,
      amount_minor,
      currency,
      value_date,
      observed_at,
      observer_actor_pseudonym
    )
  values (
    old.id,
    'post_settlement_exception',
    'post_settlement_provider_observation',
    new.provider_state,
    v_settlement.provider_reference_hash,
    v_proof_hash,
    v_settlement.amount_minor,
    v_settlement.currency,
    v_settlement.value_date,
    coalesce(new.provider_updated_at, now()),
    encode(
      extensions.digest(
        'norva:partners:airwallex-post-settlement-monitor:v1',
        'sha256'
      ),
      'hex'
    )
  )
  on conflict (proof_hash) do nothing;

  new.reconciliation_status := 'exception';
  new.job_status := 'exception';
  new.worker_id := null;
  new.lease_token_hash := null;
  new.leased_until := null;
  new.next_attempt_at := now() + interval '100 years';
  new.last_error_code :=
    'post_settlement_' || lower(new.provider_state);
  return new;
end;
$$;

create trigger affiliate_airwallex_post_settlement_dispatch_guard
before update
on affiliate_private.affiliate_payout_dispatches
for each row execute function
  affiliate_private.guard_airwallex_post_settlement_dispatch();

create or replace function
affiliate_private.guard_airwallex_settled_payout_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'settled' then
      raise exception 'new payout item cannot start settled'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status <> 'settled' then
    if new.status = 'settled' and (
      new.provider_transfer_hash is null
      or new.amount_minor is distinct from old.amount_minor
      or new.original_amount_minor is distinct from old.original_amount_minor
      or new.recovered_minor is distinct from old.recovered_minor
      or new.allocation_entry_id is distinct from old.allocation_entry_id
      or new.account_id is distinct from old.account_id
      or new.cycle_id is distinct from old.cycle_id
      or new.currency is distinct from old.currency
      or new.payout_profile_id is distinct from old.payout_profile_id
      or not exists (
        select 1
        from affiliate_private.affiliate_payout_dispatches dispatch
        join affiliate_private.affiliate_airwallex_settlement_decisions decision
          on decision.dispatch_id = dispatch.id
          and decision.decision = 'confirmed'
        join affiliate_private.affiliate_commission_entries settlement
          on settlement.id = decision.settlement_entry_id
        where dispatch.payout_item_id = old.id
          and dispatch.provider = 'airwallex'
          and dispatch.provider_state = 'PAID'
          and dispatch.provider_transfer_hash is not distinct from
            new.provider_transfer_hash
          and settlement.related_entry_id is not distinct from
            new.allocation_entry_id
          and settlement.account_id is not distinct from new.account_id
          and settlement.amount_minor is not distinct from new.amount_minor
          and settlement.currency is not distinct from new.currency
      )
    ) then
      raise exception 'payout item cannot settle without confirmed evidence'
        using errcode = 'P0004';
    end if;
    return new;
  end if;

  if new.amount_minor is distinct from old.amount_minor
    or new.original_amount_minor is distinct from old.original_amount_minor
    or new.recovered_minor is distinct from old.recovered_minor
    or new.allocation_entry_id is distinct from old.allocation_entry_id
    or new.account_id is distinct from old.account_id
    or new.cycle_id is distinct from old.cycle_id
    or new.currency is distinct from old.currency
    or new.payout_profile_id is distinct from old.payout_profile_id
    or new.provider_transfer_hash is distinct from old.provider_transfer_hash
  then
    raise exception 'settled payout financial fields are immutable'
      using errcode = '55000';
  end if;

  if new.status <> 'settled' then
    if not exists (
      select 1
      from affiliate_private.affiliate_payout_dispatches dispatch
      where dispatch.payout_item_id = old.id
        and (
          (
            dispatch.provider_state = 'PAID'
            and dispatch.reconciliation_status = 'confirmed'
            and exists (
              select 1
              from
                affiliate_private.affiliate_airwallex_settlement_decisions
                  decision
              where decision.dispatch_id = dispatch.id
                and decision.decision = 'confirmed'
            )
          )
          or (
            dispatch.reconciliation_status = 'exception'
            and exists (
              select 1
              from
                affiliate_private.affiliate_airwallex_settlement_observations
                  observation
              where observation.dispatch_id = dispatch.id
                and observation.observation_kind =
                  'post_settlement_exception'
            )
          )
        )
    ) then
      raise exception 'settled payout status is immutable'
        using errcode = '55000';
    end if;
    new.status := 'settled';
    new.provider_transfer_hash := old.provider_transfer_hash;
  end if;
  return new;
end;
$$;

create trigger affiliate_airwallex_settled_payout_item_guard
before insert or update on affiliate_private.affiliate_payout_items
for each row execute function
  affiliate_private.guard_airwallex_settled_payout_item();

create or replace function
affiliate_private.guard_airwallex_settled_payout_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_items integer;
  v_settled integer;
  v_total bigint;
begin
  if tg_op = 'INSERT' then
    if new.status = 'settled' then
      raise exception 'new payout cycle cannot start settled'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status <> 'settled' and new.status = 'settled' then
    select
      count(*)::integer,
      count(*) filter (where item.status = 'settled')::integer,
      coalesce(sum(item.amount_minor), 0)::bigint
    into v_items, v_settled, v_total
    from affiliate_private.affiliate_payout_items item
    where item.cycle_id = old.id;

    if not new.live_execution
      or new.settled_at is null
      or v_items < 1
      or v_items <> new.item_count
      or v_settled <> v_items
      or v_total <> new.total_minor
      or exists (
        select 1
        from affiliate_private.affiliate_payout_items item
        where item.cycle_id = old.id
          and not exists (
            select 1
            from affiliate_private.affiliate_payout_dispatches dispatch
            join affiliate_private.affiliate_airwallex_settlement_decisions
              decision
              on decision.dispatch_id = dispatch.id
              and decision.decision = 'confirmed'
            where dispatch.payout_item_id = item.id
              and dispatch.provider = 'airwallex'
              and dispatch.provider_state = 'PAID'
              and dispatch.reconciliation_status = 'confirmed'
          )
      )
    then
      raise exception 'payout cycle cannot settle with incomplete items'
        using errcode = 'P0004';
    end if;
    return new;
  end if;

  if old.status = 'settled' and (
    new.status is distinct from old.status
    or new.period_start is distinct from old.period_start
    or new.period_end is distinct from old.period_end
    or new.currency is distinct from old.currency
    or new.currency_exponent is distinct from old.currency_exponent
    or new.live_execution is distinct from old.live_execution
    or new.total_minor is distinct from old.total_minor
    or new.item_count is distinct from old.item_count
    or new.approved_by_pseudonym is distinct from
      old.approved_by_pseudonym
    or new.approved_at is distinct from old.approved_at
    or new.submitted_at is distinct from old.submitted_at
    or new.settled_at is distinct from old.settled_at
  ) then
    raise exception 'settled payout cycle is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_airwallex_settled_payout_cycle_guard
before insert or update on affiliate_private.affiliate_payout_cycles
for each row execute function
  affiliate_private.guard_airwallex_settled_payout_cycle();

create or replace function
affiliate_private.partners_service_airwallex_settlement_observe(
  p_dispatch_key text,
  p_provider_transfer_id text,
  p_settlement_reference text,
  p_proof_hash text,
  p_amount_minor bigint,
  p_currency text,
  p_value_date date,
  p_observed_at timestamptz,
  p_worker_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_dispatch_key, '')));
  v_provider_id text := btrim(coalesce(p_provider_transfer_id, ''));
  v_reference text := btrim(coalesce(p_settlement_reference, ''));
  v_proof_hash text := lower(btrim(coalesce(p_proof_hash, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_provider_hash text;
  v_reference_hash text;
  v_observer text;
  v_dispatch affiliate_private.affiliate_payout_dispatches%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_observation
    affiliate_private.affiliate_airwallex_settlement_observations%rowtype;
  v_conflicted boolean := false;
begin
  if v_key !~ '^pds_[0-9a-f]{24}$'
    or length(v_provider_id) not between 8 and 128
    or v_provider_id ~ '[[:space:][:cntrl:]]'
    or length(v_reference) not between 8 and 255
    or v_reference ~ '[[:cntrl:]]'
    or v_proof_hash !~ '^[0-9a-f]{64}$'
    or p_amount_minor is null
    or p_amount_minor not between 1 and 9007199254740991
    or v_currency !~ '^[A-Z]{3}$'
    or p_value_date is null
    or p_value_date < date '2020-01-01'
    or p_value_date > current_date + 1
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or p_observed_at < p_value_date::timestamptz - interval '2 days'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
  then
    raise exception 'invalid Airwallex settlement observation'
      using errcode = '22023';
  end if;

  v_provider_hash := encode(
    extensions.digest(v_provider_id, 'sha256'),
    'hex'
  );
  v_reference_hash := encode(
    extensions.digest(v_reference, 'sha256'),
    'hex'
  );
  v_observer := encode(
    extensions.digest(
      'norva:partners:airwallex-settlement-observer:v1:' || v_worker,
      'sha256'
    ),
    'hex'
  );

  select dispatch.*
  into v_dispatch
  from affiliate_private.affiliate_payout_dispatches dispatch
  where dispatch.dispatch_key = v_key
    and dispatch.provider = 'airwallex'
    and dispatch.provider_transfer_hash = v_provider_hash
    and dispatch.provider_transfer_id = v_provider_id
  for update;
  if not found then
    raise exception 'Airwallex payout dispatch is unavailable'
      using errcode = 'P0002';
  end if;

  select observation.*
  into v_observation
  from affiliate_private.affiliate_airwallex_settlement_observations observation
  where observation.proof_hash = v_proof_hash;
  if found then
    if v_observation.dispatch_id <> v_dispatch.id
      or v_observation.observation_kind <> 'settlement_evidence'
      or v_observation.provider_state <> 'PAID'
      or v_observation.provider_reference_hash <> v_reference_hash
      or v_observation.amount_minor <> p_amount_minor
      or v_observation.currency <> v_currency
      or v_observation.value_date <> p_value_date
    then
      raise exception 'settlement proof was reused with another request'
        using errcode = 'P0003';
    end if;
    v_conflicted := exists (
      select 1
      from affiliate_private.affiliate_airwallex_settlement_observations prior
      where prior.dispatch_id = v_dispatch.id
        and prior.observation_kind = 'settlement_evidence'
        and prior.id <> v_observation.id
    );
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'airwallex_settlement_observed',
      'replayed', true,
      'conflicted', v_conflicted,
      'observation', jsonb_build_object(
        'key', v_observation.observation_key,
        'value_date', v_observation.value_date,
        'currency', v_observation.currency,
        'amount_minor', v_observation.amount_minor
      )
    );
  end if;

  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_dispatch.payout_item_id
  for update;
  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;

  if v_dispatch.provider_state <> 'PAID'
    or v_dispatch.reconciliation_status <> 'pending'
    or v_item.status <> 'submitted'
    or v_item.provider_transfer_hash is distinct from v_provider_hash
    or v_item.amount_minor <> p_amount_minor
    or v_item.currency <> v_currency
    or v_cycle.status <> 'submitted'
    or not v_cycle.live_execution
    or v_cycle.currency <> v_currency
    or v_item.allocation_entry_id is null
    or not exists (
      select 1
      from affiliate_private.affiliate_commission_entries allocation
      where allocation.id = v_item.allocation_entry_id
        and allocation.account_id = v_item.account_id
        and allocation.entry_kind = 'payout_allocation'
        and allocation.currency = v_currency
        and allocation.currency_exponent = v_cycle.currency_exponent
        and allocation.amount_minor = p_amount_minor
    )
  then
    raise exception 'Airwallex settlement guards are incomplete'
      using errcode = 'P0004';
  end if;

  v_conflicted := exists (
    select 1
    from affiliate_private.affiliate_airwallex_settlement_observations prior
    where prior.dispatch_id = v_dispatch.id
      and prior.observation_kind = 'settlement_evidence'
      and (
        prior.provider_reference_hash <> v_reference_hash
        or prior.proof_hash <> v_proof_hash
        or prior.amount_minor <> p_amount_minor
        or prior.currency <> v_currency
        or prior.value_date <> p_value_date
      )
  );

  insert into affiliate_private.affiliate_airwallex_settlement_observations (
    dispatch_id,
    observation_kind,
    evidence_source,
    provider_state,
    provider_reference_hash,
    proof_hash,
    amount_minor,
    currency,
    value_date,
    observed_at,
    observer_actor_pseudonym
  )
  values (
    v_dispatch.id,
    'settlement_evidence',
    'transaction_reconciliation_report',
    'PAID',
    v_reference_hash,
    v_proof_hash,
    p_amount_minor,
    v_currency,
    p_value_date,
    p_observed_at,
    v_observer
  )
  returning * into v_observation;

  if v_conflicted then
    update affiliate_private.affiliate_payout_dispatches dispatch
    set
      reconciliation_status = 'exception',
      job_status = 'exception',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + interval '100 years',
      last_error_code = 'settlement_evidence_conflict',
      updated_at = now()
    where dispatch.id = v_dispatch.id;
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
    v_dispatch.dispatch_key,
    case
      when v_conflicted then 'airwallex_settlement_conflicted'
      else 'airwallex_settlement_observed'
    end,
    'service',
    v_observer,
    'Minimized Airwallex settlement evidence was recorded.',
    jsonb_build_object(
      'observation_key', v_observation.observation_key,
      'evidence_source', v_observation.evidence_source,
      'amount_minor', v_observation.amount_minor,
      'currency', v_observation.currency,
      'value_date', v_observation.value_date,
      'conflicted', v_conflicted
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_settlement_observed',
    'replayed', false,
    'conflicted', v_conflicted,
    'observation', jsonb_build_object(
      'key', v_observation.observation_key,
      'value_date', v_observation.value_date,
      'currency', v_observation.currency,
      'amount_minor', v_observation.amount_minor
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_airwallex_settlement_review(
  p_observation_key text,
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
  v_key text := lower(btrim(coalesce(p_observation_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_confirmation_hash text;
  v_observation
    affiliate_private.affiliate_airwallex_settlement_observations%rowtype;
  v_existing affiliate_private.affiliate_airwallex_settlement_reviews%rowtype;
  v_dispatch affiliate_private.affiliate_payout_dispatches%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_review affiliate_private.affiliate_airwallex_settlement_reviews%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Airwallex settlement mutation requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^aso_[0-9a-f]{24}$'
    or v_confirmation <> 'REVIEW:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Airwallex settlement review'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();

  select observation.*
  into v_observation
  from affiliate_private.affiliate_airwallex_settlement_observations observation
  where observation.observation_key = v_key;
  if not found then
    raise exception 'Airwallex settlement observation is unavailable'
      using errcode = 'P0002';
  end if;

  select dispatch.*
  into v_dispatch
  from affiliate_private.affiliate_payout_dispatches dispatch
  where dispatch.id = v_observation.dispatch_id
  for update;
  if not found then
    raise exception 'Airwallex payout dispatch is unavailable'
      using errcode = 'P0002';
  end if;

  v_confirmation_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:airwallex-settlement-review:v1',
        v_actor,
        v_observation.proof_hash,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  select review.*
  into v_existing
  from affiliate_private.affiliate_airwallex_settlement_reviews review
  where review.observation_id = v_observation.id;
  if found then
    if v_existing.review_actor_pseudonym is distinct from v_actor
      or v_existing.confirmation_hash is distinct from v_confirmation_hash
      or v_existing.justification is distinct from v_justification
    then
      raise exception 'settlement observation already has another review'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'airwallex_settlement_reviewed',
      'replayed', true,
      'review', jsonb_build_object(
        'key', v_existing.review_key,
        'observation_key', v_key
      )
    );
  end if;

  select item.*
  into strict v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_dispatch.payout_item_id
  for update;
  select cycle.*
  into strict v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;

  if v_observation.observation_kind <> 'settlement_evidence'
    or v_observation.provider_state <> 'PAID'
    or v_dispatch.provider_state <> 'PAID'
    or v_dispatch.reconciliation_status <> 'pending'
    or v_dispatch.provider_transfer_hash is null
    or v_item.status <> 'submitted'
    or v_item.provider_transfer_hash is distinct from
      v_dispatch.provider_transfer_hash
    or v_item.amount_minor is distinct from v_observation.amount_minor
    or v_item.currency is distinct from v_observation.currency
    or v_cycle.status <> 'submitted'
    or not v_cycle.live_execution
    or v_cycle.currency is distinct from v_observation.currency
    or (
      select count(*)
      from affiliate_private.affiliate_airwallex_settlement_observations evidence
      where evidence.dispatch_id = v_dispatch.id
    ) <> 1
    or exists (
      select 1
      from affiliate_private.affiliate_airwallex_settlement_decisions decision
      where decision.dispatch_id = v_dispatch.id
    )
  then
    raise exception 'Airwallex settlement review guards are incomplete'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_airwallex_settlement_reviews (
    observation_id,
    dispatch_id,
    review_actor_pseudonym,
    confirmation_hash,
    justification
  )
  values (
    v_observation.id,
    v_dispatch.id,
    v_actor,
    v_confirmation_hash,
    v_justification
  )
  returning * into v_review;

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
    v_dispatch.dispatch_key,
    'airwallex_settlement_reviewed',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'observation_key', v_key,
      'review_key', v_review.review_key,
      'amount_minor', v_observation.amount_minor,
      'currency', v_observation.currency,
      'value_date', v_observation.value_date
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_settlement_reviewed',
    'replayed', false,
    'review', jsonb_build_object(
      'key', v_review.review_key,
      'observation_key', v_key
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_airwallex_settlement_decide(
  p_observation_key text,
  p_decision text,
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
  v_key text := lower(btrim(coalesce(p_observation_key, '')));
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_confirmation_hash text;
  v_observation
    affiliate_private.affiliate_airwallex_settlement_observations%rowtype;
  v_review affiliate_private.affiliate_airwallex_settlement_reviews%rowtype;
  v_existing affiliate_private.affiliate_airwallex_settlement_decisions%rowtype;
  v_dispatch affiliate_private.affiliate_payout_dispatches%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_decision_row
    affiliate_private.affiliate_airwallex_settlement_decisions%rowtype;
  v_remaining integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Airwallex settlement mutation requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^aso_[0-9a-f]{24}$'
    or v_decision not in ('confirmed', 'quarantined')
    or v_confirmation <> case
      when v_decision = 'confirmed' then 'CONFIRM:' || v_key
      else 'QUARANTINE:' || v_key
    end
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Airwallex settlement decision'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  select observation.*
  into v_observation
  from affiliate_private.affiliate_airwallex_settlement_observations observation
  where observation.observation_key = v_key;
  if not found then
    raise exception 'Airwallex settlement observation is unavailable'
      using errcode = 'P0002';
  end if;

  select dispatch.*
  into v_dispatch
  from affiliate_private.affiliate_payout_dispatches dispatch
  where dispatch.id = v_observation.dispatch_id
  for update;
  if not found then
    raise exception 'Airwallex payout dispatch is unavailable'
      using errcode = 'P0002';
  end if;

  select review.*
  into v_review
  from affiliate_private.affiliate_airwallex_settlement_reviews review
  where review.observation_id = v_observation.id
    and review.dispatch_id = v_dispatch.id;
  if not found then
    raise exception 'Airwallex settlement requires an independent Finance review'
      using errcode = 'P0004';
  end if;
  if v_actor = v_review.review_actor_pseudonym then
    raise exception 'settlement review and decision require distinct Finance actors'
      using errcode = '42501';
  end if;

  v_confirmation_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:airwallex-settlement-decision:v1',
        v_actor,
        v_observation.proof_hash,
        v_review.confirmation_hash,
        v_decision,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  select decision.*
  into v_existing
  from affiliate_private.affiliate_airwallex_settlement_decisions decision
  where decision.observation_id = v_observation.id;
  if found then
    if v_existing.decision is distinct from v_decision
      or v_existing.confirmation_hash is distinct from v_confirmation_hash
      or v_existing.decision_actor_pseudonym is distinct from v_actor
      or v_existing.justification is distinct from v_justification
    then
      raise exception 'settlement observation already has another decision'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'airwallex_settlement_decided',
      'replayed', true,
      'decision', jsonb_build_object(
        'key', v_existing.decision_key,
        'status', v_existing.decision
      )
    );
  end if;

  -- A second evidence row makes the dispatch terminal before an operator can
  -- decide.  Re-check the locked dispatch even for quarantine so a stale
  -- review cannot overwrite the conflict reason with another terminal label.
  if v_dispatch.provider_state <> 'PAID'
    or v_dispatch.reconciliation_status <> 'pending'
    or (
      select count(*)
      from affiliate_private.affiliate_airwallex_settlement_observations
        decision_evidence
      where decision_evidence.dispatch_id = v_dispatch.id
        and decision_evidence.observation_kind = 'settlement_evidence'
    ) <> 1
  then
    raise exception 'Airwallex settlement decision guards are incomplete'
      using errcode = 'P0004';
  end if;

  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_dispatch.payout_item_id
  for update;
  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;

  if v_decision = 'quarantined' then
    insert into affiliate_private.affiliate_airwallex_settlement_decisions (
      observation_id,
      review_id,
      dispatch_id,
      decision,
      decision_actor_pseudonym,
      confirmation_hash,
      justification
    )
    values (
      v_observation.id,
      v_review.id,
      v_dispatch.id,
      'quarantined',
      v_actor,
      v_confirmation_hash,
      v_justification
    )
    returning * into v_decision_row;

    update affiliate_private.affiliate_payout_dispatches dispatch
    set
      reconciliation_status = 'exception',
      job_status = 'exception',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + interval '100 years',
      last_error_code = 'settlement_quarantined',
      updated_at = now()
    where dispatch.id = v_dispatch.id;
  else
    if v_observation.observation_kind <> 'settlement_evidence'
      or v_observation.provider_state <> 'PAID'
      or v_dispatch.provider_state <> 'PAID'
      or v_dispatch.reconciliation_status <> 'pending'
      or v_dispatch.provider_transfer_hash is null
      or v_item.status <> 'submitted'
      or v_item.provider_transfer_hash is distinct from
        v_dispatch.provider_transfer_hash
      or v_item.amount_minor is distinct from v_observation.amount_minor
      or v_item.currency is distinct from v_observation.currency
      or v_cycle.status <> 'submitted'
      or not v_cycle.live_execution
      or v_cycle.currency is distinct from v_observation.currency
      or v_item.allocation_entry_id is null
      or (
        select count(*)
        from
          affiliate_private.affiliate_airwallex_settlement_observations
            evidence
        where evidence.dispatch_id = v_dispatch.id
      ) <> 1
      or exists (
        select 1
        from affiliate_private.affiliate_airwallex_settlement_decisions decision
        where decision.dispatch_id = v_dispatch.id
      )
      or not exists (
        select 1
        from affiliate_private.affiliate_commission_entries allocation
        where allocation.id = v_item.allocation_entry_id
          and allocation.account_id = v_item.account_id
          and allocation.entry_kind = 'payout_allocation'
          and allocation.currency = v_observation.currency
          and allocation.currency_exponent = v_cycle.currency_exponent
          and allocation.amount_minor = v_observation.amount_minor
      )
    then
      raise exception 'Airwallex settlement confirmation guards are incomplete'
        using errcode = 'P0004';
    end if;

    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      entry_kind,
      related_entry_id,
      currency,
      currency_exponent,
      amount_minor
    )
    values (
      v_item.account_id,
      'payout_settlement',
      v_item.allocation_entry_id,
      v_observation.currency,
      v_cycle.currency_exponent,
      v_observation.amount_minor
    )
    returning * into v_entry;

    insert into affiliate_private.affiliate_commission_postings (
      entry_id,
      ledger_account,
      direction,
      amount_minor,
      currency
    )
    values
      (
        v_entry.id,
        'partner_payout_clearing',
        'debit',
        v_observation.amount_minor,
        v_observation.currency
      ),
      (
        v_entry.id,
        'partner_cash_settled',
        'credit',
        v_observation.amount_minor,
        v_observation.currency
      );

    insert into affiliate_private.affiliate_airwallex_settlement_decisions (
      observation_id,
      review_id,
      dispatch_id,
      decision,
      decision_actor_pseudonym,
      confirmation_hash,
      justification,
      settlement_entry_id
    )
    values (
      v_observation.id,
      v_review.id,
      v_dispatch.id,
      'confirmed',
      v_actor,
      v_confirmation_hash,
      v_justification,
      v_entry.id
    )
    returning * into v_decision_row;

    update affiliate_private.affiliate_payout_items item
    set status = 'settled', updated_at = now()
    where item.id = v_item.id
      and item.status = 'submitted'
      and item.amount_minor = v_observation.amount_minor
      and item.currency = v_observation.currency;
    get diagnostics v_remaining = row_count;
    if v_remaining <> 1 then
      raise exception 'payout item changed during settlement'
        using errcode = 'P0004';
    end if;

    update affiliate_private.affiliate_payout_dispatches dispatch
    set
      reconciliation_status = 'confirmed',
      job_status = 'settled',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + interval '100 years',
      last_error_code = null,
      updated_at = now()
    where dispatch.id = v_dispatch.id
      and dispatch.provider_state = 'PAID'
      and dispatch.reconciliation_status = 'pending';
    get diagnostics v_remaining = row_count;
    if v_remaining <> 1 then
      raise exception 'payout dispatch changed during settlement'
        using errcode = 'P0004';
    end if;

    select count(*)::integer
    into v_remaining
    from affiliate_private.affiliate_payout_items item
    where item.cycle_id = v_cycle.id
      and item.status <> 'settled';
    if v_remaining = 0 then
      update affiliate_private.affiliate_payout_cycles cycle
      set
        status = 'settled',
        settled_at = now(),
        updated_at = now()
      where cycle.id = v_cycle.id
        and cycle.status = 'submitted';
      get diagnostics v_remaining = row_count;
      if v_remaining <> 1 then
        raise exception 'payout cycle changed during settlement'
          using errcode = 'P0004';
      end if;
    end if;
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
    v_dispatch.dispatch_key,
    case
      when v_decision = 'confirmed'
        then 'airwallex_settlement_confirmed'
      else 'airwallex_settlement_quarantined'
    end,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'observation_key', v_observation.observation_key,
      'decision_key', v_decision_row.decision_key,
      'decision', v_decision_row.decision,
      'amount_minor', v_observation.amount_minor,
      'currency', v_observation.currency,
      'value_date', v_observation.value_date
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'airwallex_settlement_decided',
    'replayed', false,
    'decision', jsonb_build_object(
      'key', v_decision_row.decision_key,
      'status', v_decision_row.decision
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_airwallex_settlements(
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor text;
  v_items jsonb;
  v_total integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if p_limit not between 1 and 50 then
    raise exception 'invalid Airwallex settlement list limit'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();

  select count(*)::integer
  into v_total
  from affiliate_private.affiliate_airwallex_settlement_observations observation
  where observation.observation_kind = 'settlement_evidence';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'observation_key', row_data.observation_key,
        'review_key', row_data.review_key,
        'dispatch_key', row_data.dispatch_key,
        'stage', row_data.stage,
        'amount_minor', row_data.amount_minor,
        'currency', row_data.currency,
        'value_date', row_data.value_date,
        'observed_at', row_data.observed_at,
        'can_review', row_data.can_review,
        'can_decide', row_data.can_decide
      )
      order by row_data.observed_at desc, row_data.observation_key
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      observation.observation_key,
      review.review_key,
      dispatch.dispatch_key,
      observation.amount_minor,
      observation.currency,
      observation.value_date,
      observation.observed_at,
      case
        when dispatch.reconciliation_status = 'exception' then 'exception'
        when decision.decision = 'confirmed' then 'confirmed'
        when decision.decision = 'quarantined' then 'quarantined'
        when review.id is null then 'needs_review'
        when review.review_actor_pseudonym = v_actor
          then 'awaiting_independent_decision'
        else 'needs_decision'
      end as stage,
      (
        review.id is null
        and decision.id is null
        and dispatch.provider_state = 'PAID'
        and dispatch.reconciliation_status = 'pending'
        and (
          select count(*)
          from affiliate_private.affiliate_airwallex_settlement_observations
            evidence
          where evidence.dispatch_id = dispatch.id
        ) = 1
      ) as can_review,
      (
        review.id is not null
        and review.review_actor_pseudonym <> v_actor
        and decision.id is null
        and dispatch.provider_state = 'PAID'
        and dispatch.reconciliation_status = 'pending'
      ) as can_decide
    from affiliate_private.affiliate_airwallex_settlement_observations observation
    join affiliate_private.affiliate_payout_dispatches dispatch
      on dispatch.id = observation.dispatch_id
    left join affiliate_private.affiliate_airwallex_settlement_reviews review
      on review.observation_id = observation.id
    left join affiliate_private.affiliate_airwallex_settlement_decisions decision
      on decision.observation_id = observation.id
    where observation.observation_kind = 'settlement_evidence'
    order by observation.observed_at desc, observation.id
    limit p_limit
  ) row_data;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function
public.partners_service_airwallex_settlement_observe(
  p_dispatch_key text,
  p_provider_transfer_id text,
  p_settlement_reference text,
  p_proof_hash text,
  p_amount_minor bigint,
  p_currency text,
  p_value_date date,
  p_observed_at timestamptz,
  p_worker_id text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_service_airwallex_settlement_observe(
      p_dispatch_key,
      p_provider_transfer_id,
      p_settlement_reference,
      p_proof_hash,
      p_amount_minor,
      p_currency,
      p_value_date,
      p_observed_at,
      p_worker_id
    );
$$;

create or replace function
public.admin_partners_airwallex_settlements(
  p_limit integer default 25
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_airwallex_settlements(p_limit);
$$;

create or replace function
public.admin_partners_airwallex_settlement_review(
  p_observation_key text,
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
    affiliate_private.admin_partners_airwallex_settlement_review(
      p_observation_key,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_airwallex_settlement_decide(
  p_observation_key text,
  p_decision text,
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
    affiliate_private.admin_partners_airwallex_settlement_decide(
      p_observation_key,
      p_decision,
      p_confirmation,
      p_justification
    );
$$;

revoke all on function
  affiliate_private.guard_airwallex_settlement_decision()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_airwallex_post_settlement_dispatch()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_airwallex_settled_payout_item()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_airwallex_settled_payout_cycle()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.assert_payout_settlement_semantics()
from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.partners_service_airwallex_settlement_observe(
    text, text, text, text, bigint, text, date, timestamptz, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_airwallex_settlement_observe(
    text, text, text, text, bigint, text, date, timestamptz, text
  )
to service_role;
revoke all on function
  public.partners_service_airwallex_settlement_observe(
    text, text, text, text, bigint, text, date, timestamptz, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_airwallex_settlement_observe(
    text, text, text, text, bigint, text, date, timestamptz, text
  )
to service_role;

revoke all on function
  affiliate_private.admin_partners_airwallex_settlements(integer)
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_airwallex_settlements(integer)
to authenticated;
revoke all on function
  public.admin_partners_airwallex_settlements(integer)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_airwallex_settlements(integer)
to authenticated;

revoke all on function
  affiliate_private.admin_partners_airwallex_settlement_review(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_airwallex_settlement_review(
    text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_airwallex_settlement_review(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_airwallex_settlement_review(
    text, text, text
  )
to authenticated;

revoke all on function
  affiliate_private.admin_partners_airwallex_settlement_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_airwallex_settlement_decide(
    text, text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_airwallex_settlement_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_airwallex_settlement_decide(
    text, text, text, text
  )
to authenticated;
