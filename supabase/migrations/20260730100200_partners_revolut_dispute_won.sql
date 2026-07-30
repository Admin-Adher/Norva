-- Norva Partners: post-hardening immutable Revolut DISPUTE_WON counter-correction.
--
-- A won dispute is not revenue and must never create a second commission
-- accrual. This migration permits one correction fact per provider dispute and
-- one reinstatement entry tied to the exact automated chargeback reversal.
-- The service boundary accepts only hashed provider identities and is fixed to
-- the production Web rail.

alter table affiliate_private.affiliate_financial_facts
  drop constraint affiliate_financial_facts_event;
alter table affiliate_private.affiliate_financial_facts
  add constraint affiliate_financial_facts_event
  check (
    event_type in (
      'capture',
      'renewal',
      'refund',
      'chargeback',
      'chargeback_reversal',
      'transfer'
    )
  );

alter table affiliate_private.affiliate_financial_facts
  drop constraint affiliate_financial_facts_parent;
alter table affiliate_private.affiliate_financial_facts
  add constraint affiliate_financial_facts_parent
  check (
    (
      event_type in ('capture', 'renewal')
      and parent_transaction_hash is null
    )
    or (
      event_type in ('refund', 'chargeback', 'chargeback_reversal')
      and parent_transaction_hash is not null
    )
    or event_type = 'transfer'
  );

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_kind;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_kind
  check (
    entry_kind in (
      'accrual',
      'reversal',
      'manual_reversal',
      'reinstatement',
      'release',
      'recovery_offset',
      'payout_allocation',
      'payout_settlement'
    )
  );

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_attribution_scope;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_attribution_scope
  check (
    (
      entry_kind in (
        'accrual',
        'reversal',
        'manual_reversal',
        'reinstatement',
        'release'
      )
      and attribution_id is not null
    )
    or (
      entry_kind in (
        'recovery_offset',
        'payout_allocation',
        'payout_settlement'
      )
      and attribution_id is null
    )
  );

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_relation;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_relation
  check (
    (
      entry_kind = 'accrual'
      and fact_id is not null
      and related_entry_id is null
      and matures_at is not null
    )
    or (
      entry_kind in ('reversal', 'reinstatement', 'release')
      and fact_id is not null
      and related_entry_id is not null
      and matures_at is null
    )
    or (
      entry_kind = 'manual_reversal'
      and fact_id is null
      and related_entry_id is not null
      and matures_at is null
    )
    or (
      entry_kind in ('payout_allocation', 'recovery_offset')
      and fact_id is null
      and related_entry_id is null
      and matures_at is null
    )
    or (
      entry_kind = 'payout_settlement'
      and fact_id is null
      and related_entry_id is not null
      and matures_at is null
    )
  );

create unique index affiliate_commission_entries_reinstatement_once_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where entry_kind = 'reinstatement';

create table affiliate_private.affiliate_revolut_dispute_won_jobs (
  id                           uuid primary key default gen_random_uuid(),
  job_key                      text not null unique default (
    'crw_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  source_event_hash            text not null unique,
  payload_hash                 text not null,
  dispute_hash                 text not null,
  parent_order_hash            text not null,
  referred_user_id             uuid not null references auth.users(id)
    on delete restrict,
  currency                     text not null,
  gross_minor                  bigint not null,
  observed_at                  timestamptz not null,
  status                       text not null default 'pending',
  worker_id                    text,
  lease_token_hash             text,
  leased_until                 timestamptz,
  attempts                     integer not null default 0,
  next_attempt_at              timestamptz not null default now(),
  last_error_code              text,
  completed_at                 timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint affiliate_revolut_dispute_won_jobs_key
    check (job_key ~ '^crw_[0-9a-f]{24}$'),
  constraint affiliate_revolut_dispute_won_jobs_hashes
    check (
      source_event_hash ~ '^[0-9a-f]{64}$'
      and payload_hash ~ '^[0-9a-f]{64}$'
      and dispute_hash ~ '^[0-9a-f]{64}$'
      and parent_order_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_dispute_won_jobs_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_revolut_dispute_won_jobs_amount
    check (gross_minor between 1 and 9007199254740991),
  constraint affiliate_revolut_dispute_won_jobs_status
    check (
      status in ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')
    ),
  constraint affiliate_revolut_dispute_won_jobs_worker
    check (
      worker_id is null
      or worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    ),
  constraint affiliate_revolut_dispute_won_jobs_lease_hash
    check (
      lease_token_hash is null
      or lease_token_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_dispute_won_jobs_attempts
    check (attempts between 0 and 72),
  constraint affiliate_revolut_dispute_won_jobs_error
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'
    ),
  constraint affiliate_revolut_dispute_won_jobs_lease_state
    check (
      (status = 'leased') = (
        worker_id is not null
        and lease_token_hash is not null
        and leased_until is not null
      )
    ),
  constraint affiliate_revolut_dispute_won_jobs_completion
    check (
      (status in ('succeeded', 'dead_letter')) =
      (completed_at is not null)
    )
);

create index affiliate_revolut_dispute_won_jobs_lease_idx
  on affiliate_private.affiliate_revolut_dispute_won_jobs (
    next_attempt_at,
    created_at
  )
  where status in ('pending', 'retry', 'leased');

create index affiliate_revolut_dispute_won_jobs_referred_user_idx
  on affiliate_private.affiliate_revolut_dispute_won_jobs (
    referred_user_id
  );

create table affiliate_private.affiliate_revolut_dispute_won_conflicts (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null
    references affiliate_private.affiliate_revolut_dispute_won_jobs(id)
    on delete restrict,
  source_event_hash  text not null,
  payload_hash       text not null,
  observed_at        timestamptz not null,
  created_at         timestamptz not null default now(),
  constraint affiliate_revolut_dispute_won_conflicts_hashes
    check (
      source_event_hash ~ '^[0-9a-f]{64}$'
      and payload_hash ~ '^[0-9a-f]{64}$'
    ),
  unique (source_event_hash, payload_hash)
);

create index affiliate_revolut_dispute_won_conflicts_job_idx
  on affiliate_private.affiliate_revolut_dispute_won_conflicts (job_id);

alter table affiliate_private.affiliate_revolut_dispute_won_jobs
  enable row level security;
alter table affiliate_private.affiliate_revolut_dispute_won_conflicts
  enable row level security;
revoke all on table
  affiliate_private.affiliate_revolut_dispute_won_jobs,
  affiliate_private.affiliate_revolut_dispute_won_conflicts
  from public, anon, authenticated, service_role;

create trigger affiliate_revolut_dispute_won_conflicts_append_only
before update or delete
on affiliate_private.affiliate_revolut_dispute_won_conflicts
for each row execute function
  affiliate_private.reject_partners_finance_mutation();

create or replace function affiliate_private.partners_net_reversed_minor(
  p_accrual_entry_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  with automated_reversals as (
    select reversal.id, reversal.amount_minor
    from affiliate_private.affiliate_commission_entries reversal
    where reversal.related_entry_id = p_accrual_entry_id
      and reversal.entry_kind = 'reversal'
  ),
  reinstated as (
    select coalesce(sum(reinstatement.amount_minor), 0)::bigint as amount_minor
    from affiliate_private.affiliate_commission_entries reinstatement
    join automated_reversals reversal
      on reversal.id = reinstatement.related_entry_id
    where reinstatement.entry_kind = 'reinstatement'
  ),
  negative as (
    select
      coalesce((
        select sum(reversal.amount_minor) from automated_reversals reversal
      ), 0)::bigint
      + coalesce((
        select sum(manual.amount_minor)
        from affiliate_private.affiliate_commission_entries manual
        where manual.related_entry_id = p_accrual_entry_id
          and manual.entry_kind = 'manual_reversal'
      ), 0)::bigint as amount_minor
  )
  select greatest(negative.amount_minor - reinstated.amount_minor, 0)::bigint
  from negative cross join reinstated;
$$;

revoke all on function
  affiliate_private.partners_net_reversed_minor(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_net_reversed_minor(uuid)
  to service_role;

create or replace function
affiliate_private.partners_worker_revolut_dispute_won_ingest(
  p_source_event_hash text,
  p_payload_hash text,
  p_dispute_hash text,
  p_parent_order_hash text,
  p_referred_user_id uuid,
  p_currency text,
  p_gross_minor bigint,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source_hash text := lower(btrim(coalesce(p_source_event_hash, '')));
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_dispute_hash text := lower(btrim(coalesce(p_dispute_hash, '')));
  v_parent_order_hash text :=
    lower(btrim(coalesce(p_parent_order_hash, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_expected_source_hash text;
  v_observation
    affiliate_private.affiliate_financial_fact_observations%rowtype;
  v_loss affiliate_private.affiliate_financial_facts%rowtype;
  v_loss_lineage
    affiliate_private.affiliate_financial_fact_lineage_links%rowtype;
  v_origin affiliate_private.affiliate_financial_facts%rowtype;
  v_attribution affiliate_private.affiliate_attributions%rowtype;
  v_accrual affiliate_private.affiliate_commission_entries%rowtype;
  v_reversal affiliate_private.affiliate_commission_entries%rowtype;
  v_correction affiliate_private.affiliate_financial_facts%rowtype;
  v_reinstatement affiliate_private.affiliate_commission_entries%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_debits numeric := 0;
  v_credits numeric := 0;
  v_posting_count integer := 0;
  v_platform_recovery_credit numeric := 0;
  v_reversal_pending_minor bigint := 0;
  v_reversal_available_minor bigint := 0;
  v_reversal_clearing_minor bigint := 0;
  v_reversal_recovery_due_minor bigint := 0;
  v_recovery_due_outstanding_minor bigint := 0;
  v_recovery_cancel_minor bigint := 0;
  v_pending_restore_minor bigint := 0;
  v_available_restore_minor bigint := 0;
  v_release_precedes_reinstatement boolean := false;
  v_status text;
  v_replayed boolean := false;
begin
  if v_source_hash !~ '^[0-9a-f]{64}$'
    or v_payload_hash !~ '^[0-9a-f]{64}$'
    or v_dispute_hash !~ '^[0-9a-f]{64}$'
    or v_parent_order_hash !~ '^[0-9a-f]{64}$'
    or p_referred_user_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or p_gross_minor is null
    or p_gross_minor not between 1 and 9007199254740991
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or p_observed_at < now() - interval '2 years'
  then
    raise exception 'invalid Revolut dispute-won envelope'
      using errcode = '22023';
  end if;

  v_expected_source_hash := encode(
    extensions.digest(
      'billing:economic:v1:production:web:chargeback_reversal:'
        || v_dispute_hash,
      'sha256'
    ),
    'hex'
  );
  if v_source_hash <> v_expected_source_hash then
    raise exception 'Revolut dispute-won source identity mismatch'
      using errcode = 'P0003';
  end if;

  -- Serializes all deliveries for the same provider dispute without locking a
  -- synthetic row. Account/currency mutations take the shared balance lock
  -- later, after immutable lineage has been validated.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-dispute-won:' || v_dispute_hash,
      0
    )
  );

  select observation.*
  into v_observation
  from affiliate_private.affiliate_financial_fact_observations observation
  where observation.source_event_hash = v_source_hash;
  if found and v_observation.payload_hash <> v_payload_hash then
    raise exception 'Revolut dispute-won replay payload conflict'
      using errcode = 'P0003';
  end if;

  -- Match the immutable DISPUTE_LOST fact first by the provider dispute hash.
  -- All other proof fields must agree exactly; no nearest-order or cross-rail
  -- fallback is permitted.
  select fact.*
  into v_loss
  from affiliate_private.affiliate_financial_facts fact
  where fact.environment = 'production'
    and fact.rail = 'web'
    and fact.event_type = 'chargeback'
    and fact.transaction_hash = v_dispute_hash;
  if not found then
    raise exception 'prior Revolut chargeback fact is unavailable'
      using errcode = 'P0006';
  end if;
  if v_loss.parent_transaction_hash <> v_parent_order_hash
    or v_loss.referred_user_id is distinct from p_referred_user_id
    or v_loss.currency is distinct from v_currency
    or v_loss.gross_minor is distinct from p_gross_minor
    or v_loss.facts_status <> 'complete'
    or v_loss.attribution_id is null
    or p_observed_at < v_loss.occurred_at
  then
    raise exception 'prior Revolut chargeback proof conflicts'
      using errcode = 'P0003';
  end if;

  select lineage.*
  into v_loss_lineage
  from affiliate_private.affiliate_financial_fact_lineage_links lineage
  where lineage.child_fact_id = v_loss.id;
  if not found
    or v_loss_lineage.attribution_id is distinct from v_loss.attribution_id
  then
    raise exception 'prior Revolut chargeback lineage is unavailable'
      using errcode = 'P0006';
  end if;

  select entry.*
  into v_reversal
  from affiliate_private.affiliate_commission_entries entry
  where entry.fact_id = v_loss.id
    and entry.entry_kind = 'reversal';
  if not found then
    raise exception 'prior Revolut chargeback reversal is unavailable'
      using errcode = 'P0006';
  end if;

  select entry.*
  into v_accrual
  from affiliate_private.affiliate_commission_entries entry
  where entry.id = v_reversal.related_entry_id
    and entry.entry_kind = 'accrual'
  for update;
  if not found
    or v_accrual.fact_id is distinct from v_loss_lineage.parent_fact_id
    or v_accrual.account_id is distinct from v_reversal.account_id
    or v_accrual.attribution_id is distinct from v_reversal.attribution_id
    or v_accrual.attribution_id is distinct from v_loss.attribution_id
    or v_accrual.currency is distinct from v_reversal.currency
    or v_accrual.currency_exponent
      is distinct from v_reversal.currency_exponent
    or v_reversal.currency is distinct from v_currency
  then
    raise exception 'prior Revolut chargeback ledger lineage conflicts'
      using errcode = 'P0003';
  end if;

  select fact.*
  into v_origin
  from affiliate_private.affiliate_financial_facts fact
  where fact.id = v_accrual.fact_id;
  if not found
    or v_origin.environment is distinct from 'production'
    or v_origin.rail is distinct from 'web'
    or v_origin.event_type not in ('capture', 'renewal')
    or v_origin.transaction_hash is distinct from v_parent_order_hash
    or v_origin.referred_user_id is distinct from p_referred_user_id
    or v_origin.attribution_id is distinct from v_loss.attribution_id
    or v_origin.currency is distinct from v_loss.currency
    or v_origin.currency_exponent is distinct from v_loss.currency_exponent
    or v_origin.occurred_at > v_loss.occurred_at
    or v_reversal.created_at + interval '5 minutes' < v_loss.occurred_at
  then
    raise exception 'prior Revolut chargeback origin proof conflicts'
      using errcode = 'P0003';
  end if;

  select attribution.*
  into v_attribution
  from affiliate_private.affiliate_attributions attribution
  where attribution.id = v_loss.attribution_id;
  if not found
    or v_attribution.referred_user_id is distinct from p_referred_user_id
    or v_attribution.referrer_account_id is distinct from v_reversal.account_id
  then
    raise exception 'prior Revolut chargeback attribution conflicts'
      using errcode = 'P0003';
  end if;

  select
    coalesce(sum(posting.amount_minor)
      filter (where posting.direction = 'debit'), 0),
    coalesce(sum(posting.amount_minor)
      filter (where posting.direction = 'credit'), 0),
    count(*),
    coalesce(sum(posting.amount_minor) filter (
      where posting.ledger_account = 'platform_commission_recovery'
        and posting.direction = 'credit'
    ), 0),
    coalesce(sum(posting.amount_minor) filter (
      where posting.ledger_account = 'partner_commission_pending'
        and posting.direction = 'debit'
    ), 0),
    coalesce(sum(posting.amount_minor) filter (
      where posting.ledger_account = 'partner_commission_available'
        and posting.direction = 'debit'
    ), 0),
    coalesce(sum(posting.amount_minor) filter (
      where posting.ledger_account = 'partner_payout_clearing'
        and posting.direction = 'debit'
    ), 0),
    coalesce(sum(posting.amount_minor) filter (
      where posting.ledger_account = 'partner_recovery_due'
        and posting.direction = 'debit'
    ), 0)
  into
    v_debits,
    v_credits,
    v_posting_count,
    v_platform_recovery_credit,
    v_reversal_pending_minor,
    v_reversal_available_minor,
    v_reversal_clearing_minor,
    v_reversal_recovery_due_minor
  from affiliate_private.affiliate_commission_postings posting
  where posting.entry_id = v_reversal.id
    and posting.currency = v_reversal.currency;
  if v_posting_count < 2
    or v_debits <> v_reversal.amount_minor
    or v_credits <> v_reversal.amount_minor
    or v_platform_recovery_credit <> v_reversal.amount_minor
    or exists (
      select 1
      from affiliate_private.affiliate_commission_postings posting
      where posting.entry_id = v_reversal.id
        and (
          posting.currency <> v_reversal.currency
          or (
            posting.ledger_account = 'platform_commission_recovery'
            and posting.direction <> 'credit'
          )
          or (
            posting.ledger_account in (
              'partner_commission_pending',
              'partner_commission_available',
              'partner_payout_clearing',
              'partner_recovery_due'
            )
            and posting.direction <> 'debit'
          )
          or posting.ledger_account not in (
            'platform_commission_recovery',
            'partner_commission_pending',
            'partner_commission_available',
            'partner_payout_clearing',
            'partner_recovery_due'
          )
        )
    )
  then
    raise exception 'prior Revolut chargeback ledger is not authoritative'
      using errcode = '23514';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = v_reversal.account_id;
  if not found then
    raise exception 'prior Revolut Partner account is unavailable'
      using errcode = 'P0006';
  end if;

  perform affiliate_private.partners_balance_lock(
    v_reversal.account_id,
    v_reversal.currency
  );

  select fact.*
  into v_correction
  from affiliate_private.affiliate_financial_facts fact
  where fact.environment = 'production'
    and fact.rail = 'web'
    and fact.event_type = 'chargeback_reversal'
    and fact.transaction_hash = v_dispute_hash;

  if found then
    v_replayed := true;
    if v_correction.parent_transaction_hash is distinct from v_dispute_hash
      or v_correction.referred_user_id is distinct from p_referred_user_id
      or v_correction.attribution_id is distinct from v_loss.attribution_id
      or v_correction.facts_status is distinct from 'complete'
      or v_correction.currency is distinct from v_loss.currency
      or v_correction.currency_exponent
        is distinct from v_loss.currency_exponent
      or v_correction.gross_minor is distinct from v_loss.gross_minor
      or v_correction.discount_minor is distinct from v_loss.discount_minor
      or v_correction.tax_minor is distinct from v_loss.tax_minor
      or v_correction.eligible_minor is distinct from v_loss.eligible_minor
    then
      raise exception 'Revolut dispute-won correction fact conflicts'
        using errcode = 'P0003';
    end if;

    select entry.*
    into v_reinstatement
    from affiliate_private.affiliate_commission_entries entry
    where entry.fact_id = v_correction.id
      and entry.entry_kind = 'reinstatement';
    if not found then
      raise exception 'Revolut dispute-won reinstatement conflicts'
        using errcode = 'P0003';
    end if;
    select exists (
      select 1
      from affiliate_private.affiliate_commission_entries release
      where release.related_entry_id = v_accrual.id
        and release.entry_kind = 'release'
        and release.created_at <= v_reinstatement.created_at
    )
    into v_release_precedes_reinstatement;
    if v_reinstatement.related_entry_id is distinct from v_reversal.id
      or v_reinstatement.account_id is distinct from v_reversal.account_id
      or v_reinstatement.attribution_id
        is distinct from v_reversal.attribution_id
      or v_reinstatement.currency is distinct from v_reversal.currency
      or v_reinstatement.currency_exponent
        is distinct from v_reversal.currency_exponent
      or v_reinstatement.amount_minor is distinct from v_reversal.amount_minor
      or exists (
        select 1
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and (
            posting.currency <> v_reinstatement.currency
            or (
              posting.ledger_account = 'platform_commission_recovery'
              and posting.direction <> 'debit'
            )
            or (
              posting.ledger_account in (
                'partner_recovery_due',
                'partner_commission_pending',
                'partner_commission_available'
              )
              and posting.direction <> 'credit'
            )
            or posting.ledger_account not in (
              'platform_commission_recovery',
              'partner_recovery_due',
              'partner_commission_pending',
              'partner_commission_available'
            )
          )
      )
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and posting.direction = 'debit'
      ) <> v_reinstatement.amount_minor
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and posting.direction = 'credit'
      ) <> v_reinstatement.amount_minor
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and posting.ledger_account = 'partner_commission_pending'
          and posting.direction = 'credit'
      ) <> (
        case
          when v_release_precedes_reinstatement then 0
          else v_reversal_pending_minor
        end
      )
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'credit'
      ) > v_reversal_recovery_due_minor
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'credit'
      ) <> (
        v_reversal_available_minor
        + v_reversal_clearing_minor
        + v_reversal_recovery_due_minor
        + case
          when v_release_precedes_reinstatement
            then v_reversal_pending_minor
          else 0
        end
        - (
          select coalesce(sum(posting.amount_minor), 0)
          from affiliate_private.affiliate_commission_postings posting
          where posting.entry_id = v_reinstatement.id
            and posting.ledger_account = 'partner_recovery_due'
            and posting.direction = 'credit'
        )
      )
    then
      raise exception 'Revolut dispute-won reinstatement conflicts'
        using errcode = 'P0003';
    end if;
  else
    insert into affiliate_private.affiliate_financial_facts (
      transaction_hash,
      parent_transaction_hash,
      referred_user_id,
      attribution_id,
      rail,
      event_type,
      environment,
      facts_status,
      currency,
      currency_exponent,
      gross_minor,
      discount_minor,
      tax_minor,
      eligible_minor,
      occurred_at
    )
    values (
      v_dispute_hash,
      v_dispute_hash,
      p_referred_user_id,
      v_loss.attribution_id,
      'web',
      'chargeback_reversal',
      'production',
      'complete',
      v_loss.currency,
      v_loss.currency_exponent,
      v_loss.gross_minor,
      v_loss.discount_minor,
      v_loss.tax_minor,
      v_loss.eligible_minor,
      p_observed_at
    )
    returning * into v_correction;

    insert into affiliate_private.affiliate_financial_fact_lineage_links (
      child_fact_id,
      parent_fact_id,
      attribution_id
    )
    values (
      v_correction.id,
      v_loss.id,
      v_loss.attribution_id
    );

    select greatest(coalesce(sum(
      case
        when posting.direction = 'debit' then posting.amount_minor
        else -posting.amount_minor
      end
    ), 0), 0)::bigint
    into v_recovery_due_outstanding_minor
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = v_reversal.account_id
      and posting.currency = v_reversal.currency
      and posting.ledger_account = 'partner_recovery_due';

    v_recovery_cancel_minor := least(
      v_reversal_recovery_due_minor,
      v_recovery_due_outstanding_minor
    );
    select exists (
      select 1
      from affiliate_private.affiliate_commission_entries release
      where release.related_entry_id = v_accrual.id
        and release.entry_kind = 'release'
    )
    into v_release_precedes_reinstatement;
    v_pending_restore_minor := case
      when v_release_precedes_reinstatement then 0
      else v_reversal_pending_minor
    end;
    v_available_restore_minor :=
      v_reversal_available_minor
      + v_reversal_clearing_minor
      + v_reversal_recovery_due_minor
      + case
        when v_release_precedes_reinstatement
          then v_reversal_pending_minor
        else 0
      end
      - v_recovery_cancel_minor;
    v_status := case
      when v_available_restore_minor > 0 then 'available'
      when v_pending_restore_minor > 0 then 'pending'
      else 'recovery_cancelled'
    end;

    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      attribution_id,
      fact_id,
      entry_kind,
      related_entry_id,
      currency,
      currency_exponent,
      amount_minor
    )
    values (
      v_reversal.account_id,
      v_reversal.attribution_id,
      v_correction.id,
      'reinstatement',
      v_reversal.id,
      v_reversal.currency,
      v_reversal.currency_exponent,
      v_reversal.amount_minor
    )
    returning * into v_reinstatement;

    insert into affiliate_private.affiliate_commission_postings (
      entry_id,
      ledger_account,
      direction,
      amount_minor,
      currency
    )
    values (
      v_reinstatement.id,
      'platform_commission_recovery',
      'debit',
      v_reinstatement.amount_minor,
      v_reinstatement.currency
    );

    if v_recovery_cancel_minor > 0 then
      insert into affiliate_private.affiliate_commission_postings (
        entry_id,
        ledger_account,
        direction,
        amount_minor,
        currency
      )
      values (
        v_reinstatement.id,
        'partner_recovery_due',
        'credit',
        v_recovery_cancel_minor,
        v_reinstatement.currency
      );
    end if;
    if v_pending_restore_minor > 0 then
      insert into affiliate_private.affiliate_commission_postings (
        entry_id,
        ledger_account,
        direction,
        amount_minor,
        currency
      )
      values (
        v_reinstatement.id,
        'partner_commission_pending',
        'credit',
        v_pending_restore_minor,
        v_reinstatement.currency
      );
    end if;
    if v_available_restore_minor > 0 then
      insert into affiliate_private.affiliate_commission_postings (
        entry_id,
        ledger_account,
        direction,
        amount_minor,
        currency
      )
      values (
        v_reinstatement.id,
        'partner_commission_available',
        'credit',
        v_available_restore_minor,
        v_reinstatement.currency
      );
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
      'financial_fact',
      v_correction.fact_key,
      'chargeback_reversal_ingested',
      'service',
      v_account.user_pseudonym,
      'Authoritative Revolut DISPUTE_WON restored one prior automated '
        || 'chargeback commission reversal.',
      jsonb_build_object(
        'rail', 'web',
        'event_type', 'chargeback_reversal',
        'entry_key', v_reinstatement.entry_key,
        'amount_minor', v_reinstatement.amount_minor,
        'currency', v_reinstatement.currency,
        'status', v_status
      )
    );
  end if;

  if v_observation.id is not null
    and v_observation.fact_id <> v_correction.id
  then
    raise exception 'Revolut dispute-won source identity is already bound'
      using errcode = 'P0003';
  end if;
  if v_observation.id is null then
    insert into affiliate_private.affiliate_financial_fact_observations (
      fact_id,
      source_event_hash,
      payload_hash,
      observed_at
    )
    values (
      v_correction.id,
      v_source_hash,
      v_payload_hash,
      p_observed_at
    );
  end if;

  if v_status is null then
    select case
      when exists (
        select 1
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and posting.ledger_account = 'partner_commission_pending'
          and posting.direction = 'credit'
      ) then 'pending'
      when exists (
        select 1
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = v_reinstatement.id
          and posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'credit'
      ) then 'available'
      else 'recovery_cancelled'
    end
    into v_status;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'chargeback_reversal_ingested',
    'replayed', v_replayed,
    'fact', jsonb_build_object(
      'key', v_correction.fact_key,
      'status', v_correction.facts_status
    ),
    'ledger_entry', jsonb_build_object(
      'key', v_reinstatement.entry_key,
      'kind', 'reinstatement',
      'status', v_status,
      'amount_minor', v_reinstatement.amount_minor,
      'currency', v_reinstatement.currency
    )
  );
end;
$$;


-- Reopen a matured zero-release job after a later reinstatement restores value.
create or replace function
affiliate_private.partners_worker_maturation_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_until timestamptz;
  v_jobs jsonb;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or p_limit is null
    or p_limit not between 1 and 50
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 300
  then
    raise exception 'invalid maturation lease request'
      using errcode = '22023';
  end if;

  v_until := now() + make_interval(secs => p_lease_seconds);
  update affiliate_private.affiliate_maturation_jobs
  set
    status = 'dead_letter',
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    last_error_code = 'retry_exhausted',
    completed_at = now(),
    updated_at = now()
  where attempts >= 12
    and (
      status in ('pending', 'retry')
      or (status = 'leased' and leased_until <= now())
    );

  with candidates as (
    select j.id
    from affiliate_private.affiliate_maturation_jobs j
    join affiliate_private.affiliate_commission_entries accrual
      on accrual.id = j.accrual_entry_id
      and accrual.entry_kind = 'accrual'
    where j.available_at <= now()
      and (
        (j.status in ('pending', 'retry') and j.next_attempt_at <= now())
        or (j.status = 'leased' and j.leased_until <= now())
        or (
          j.status = 'succeeded'
          and not exists (
            select 1
            from affiliate_private.affiliate_commission_entries release
            where release.related_entry_id = accrual.id
              and release.entry_kind = 'release'
          )
          and accrual.amount_minor
            > affiliate_private.partners_net_reversed_minor(accrual.id)
        )
      )
      and (j.status = 'succeeded' or j.attempts < 12)
    order by j.available_at, j.created_at
    for update skip locked
    limit p_limit
  ),
  leased as (
    update affiliate_private.affiliate_maturation_jobs j
    set
      status = 'leased',
      worker_id = v_worker,
      lease_token_hash = v_token,
      leased_until = v_until,
      attempts = case
        when j.status = 'succeeded' then 1
        else j.attempts + 1
      end,
      completed_at = null,
      updated_at = now()
    from candidates c
    where j.id = c.id
    returning j.job_key, j.accrual_entry_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', l.job_key,
        'ledger_entry_key', e.entry_key
      )
      order by l.job_key
    ),
    '[]'::jsonb
  )
  into v_jobs
  from leased l
  join affiliate_private.affiliate_commission_entries e
    on e.id = l.accrual_entry_id;

  return jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_until,
    'jobs', v_jobs
  );
end;
$$;


create or replace function
affiliate_private.partners_worker_revolut_dispute_won_enqueue(
  p_source_event_hash text,
  p_payload_hash text,
  p_dispute_hash text,
  p_parent_order_hash text,
  p_referred_user_id uuid,
  p_currency text,
  p_gross_minor bigint,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source_hash text := lower(btrim(coalesce(p_source_event_hash, '')));
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_dispute_hash text := lower(btrim(coalesce(p_dispute_hash, '')));
  v_parent_order_hash text :=
    lower(btrim(coalesce(p_parent_order_hash, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_expected_source_hash text;
  v_job affiliate_private.affiliate_revolut_dispute_won_jobs%rowtype;
  v_replayed boolean := false;
  v_conflict boolean := false;
begin
  if v_source_hash !~ '^[0-9a-f]{64}$'
    or v_payload_hash !~ '^[0-9a-f]{64}$'
    or v_dispute_hash !~ '^[0-9a-f]{64}$'
    or v_parent_order_hash !~ '^[0-9a-f]{64}$'
    or p_referred_user_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or p_gross_minor is null
    or p_gross_minor not between 1 and 9007199254740991
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or p_observed_at < now() - interval '2 years'
  then
    raise exception 'invalid Revolut dispute-won queue envelope'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users users where users.id = p_referred_user_id
  ) then
    raise exception 'Revolut dispute-won user is unavailable'
      using errcode = 'P0002';
  end if;

  v_expected_source_hash := encode(
    extensions.digest(
      'billing:economic:v1:production:web:chargeback_reversal:'
        || v_dispute_hash,
      'sha256'
    ),
    'hex'
  );
  if v_source_hash <> v_expected_source_hash then
    raise exception 'Revolut dispute-won queue identity mismatch'
      using errcode = 'P0003';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-dispute-won-inbox:' || v_source_hash,
      0
    )
  );
  select job.*
  into v_job
  from affiliate_private.affiliate_revolut_dispute_won_jobs job
  where job.source_event_hash = v_source_hash
  for update;

  if found then
    v_replayed := true;
    if v_job.payload_hash <> v_payload_hash then
      v_conflict := true;
      insert into
        affiliate_private.affiliate_revolut_dispute_won_conflicts (
          job_id,
          source_event_hash,
          payload_hash,
          observed_at
        )
      values (
        v_job.id,
        v_source_hash,
        v_payload_hash,
        p_observed_at
      )
      on conflict (source_event_hash, payload_hash) do nothing;
      if v_job.status <> 'succeeded' then
        update affiliate_private.affiliate_revolut_dispute_won_jobs
        set
          status = 'dead_letter',
          worker_id = null,
          lease_token_hash = null,
          leased_until = null,
          last_error_code = 'payload_conflict',
          completed_at = now(),
          updated_at = now()
        where id = v_job.id
        returning * into v_job;
      end if;
    end if;
  else
    insert into affiliate_private.affiliate_revolut_dispute_won_jobs (
      source_event_hash,
      payload_hash,
      dispute_hash,
      parent_order_hash,
      referred_user_id,
      currency,
      gross_minor,
      observed_at
    )
    values (
      v_source_hash,
      v_payload_hash,
      v_dispute_hash,
      v_parent_order_hash,
      p_referred_user_id,
      v_currency,
      p_gross_minor,
      p_observed_at
    )
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'chargeback_reversal_queued',
    'replayed', v_replayed,
    'conflict', v_conflict,
    'job', jsonb_build_object(
      'key', v_job.job_key,
      'status', v_job.status
    )
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_revolut_dispute_won_jobs_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_until timestamptz;
  v_jobs jsonb;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or p_limit is null
    or p_limit not between 1 and 50
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 300
  then
    raise exception 'invalid dispute-won lease request'
      using errcode = '22023';
  end if;

  v_until := now() + make_interval(secs => p_lease_seconds);
  update affiliate_private.affiliate_revolut_dispute_won_jobs
  set
    status = 'dead_letter',
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    last_error_code = 'retry_exhausted',
    completed_at = now(),
    updated_at = now()
  where attempts >= 72
    and (
      status in ('pending', 'retry')
      or (status = 'leased' and leased_until <= now())
    );

  with candidates as (
    select job.id
    from affiliate_private.affiliate_revolut_dispute_won_jobs job
    where (
      (
        job.status in ('pending', 'retry')
        and job.next_attempt_at <= now()
      )
      or (
        job.status = 'leased'
        and job.leased_until <= now()
      )
    )
      and job.attempts < 72
    order by job.next_attempt_at, job.created_at
    for update skip locked
    limit p_limit
  ),
  leased as (
    update affiliate_private.affiliate_revolut_dispute_won_jobs job
    set
      status = 'leased',
      worker_id = v_worker,
      lease_token_hash = v_token,
      leased_until = v_until,
      attempts = job.attempts + 1,
      updated_at = now()
    from candidates candidate
    where job.id = candidate.id
    returning job.job_key
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('key', leased.job_key)
      order by leased.job_key
    ),
    '[]'::jsonb
  )
  into v_jobs
  from leased;

  return jsonb_build_object(
    'schema_version', 1,
    'leased_until', v_until,
    'jobs', v_jobs
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_revolut_dispute_won_job_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job_key text := lower(btrim(coalesce(p_job_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_error text := nullif(lower(btrim(coalesce(p_error_code, ''))), '');
  v_job affiliate_private.affiliate_revolut_dispute_won_jobs%rowtype;
  v_result jsonb;
  v_status text;
  v_delay_seconds integer;
begin
  if v_job_key !~ '^crw_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or v_outcome not in ('succeeded', 'retry', 'dead_letter')
    or (
      v_outcome in ('retry', 'dead_letter')
      and (v_error is null or v_error !~ '^[a-z][a-z0-9_]{2,63}$')
    )
  then
    raise exception 'invalid dispute-won completion request'
      using errcode = '22023';
  end if;

  select job.*
  into v_job
  from affiliate_private.affiliate_revolut_dispute_won_jobs job
  where job.job_key = v_job_key
  for update;
  if not found then
    raise exception 'dispute-won job is unavailable'
      using errcode = 'P0006';
  end if;
  if v_job.status <> 'leased'
    or v_job.worker_id <> v_worker
    or v_job.lease_token_hash <> v_token
    or v_job.leased_until <= now()
  then
    raise exception 'dispute-won job lease is unavailable'
      using errcode = 'P0004';
  end if;

  if v_outcome = 'retry' and v_job.attempts >= 72 then
    update affiliate_private.affiliate_revolut_dispute_won_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = coalesce(v_error, 'retry_exhausted'),
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'retry' then
    v_delay_seconds := least(
      3600,
      (30 * power(2::numeric, least(v_job.attempts, 7)))::integer
    );
    update affiliate_private.affiliate_revolut_dispute_won_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + make_interval(secs => v_delay_seconds),
      last_error_code = v_error,
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'dead_letter' then
    update affiliate_private.affiliate_revolut_dispute_won_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = v_error,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  else
    v_result :=
      affiliate_private.partners_worker_revolut_dispute_won_ingest(
        v_job.source_event_hash,
        v_job.payload_hash,
        v_job.dispute_hash,
        v_job.parent_order_hash,
        v_job.referred_user_id,
        v_job.currency,
        v_job.gross_minor,
        v_job.observed_at
      );
    if v_result ->> 'action' <> 'chargeback_reversal_ingested'
      or v_result #>> '{fact,status}' <> 'complete'
      or v_result #>> '{ledger_entry,kind}' <> 'reinstatement'
    then
      raise exception 'dispute-won apply response is invalid'
        using errcode = '55000';
    end if;
    update affiliate_private.affiliate_revolut_dispute_won_jobs
    set
      status = 'succeeded',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = null,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'chargeback_reversal_job_completed',
    'job', jsonb_build_object(
      'key', v_job.job_key,
      'status', v_status
    ),
    'result', v_result
  );
end;
$$;

create or replace function public.partners_worker_revolut_dispute_won_enqueue(
  p_source_event_hash text,
  p_payload_hash text,
  p_dispute_hash text,
  p_parent_order_hash text,
  p_referred_user_id uuid,
  p_currency text,
  p_gross_minor bigint,
  p_observed_at timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_revolut_dispute_won_enqueue(
    p_source_event_hash,
    p_payload_hash,
    p_dispute_hash,
    p_parent_order_hash,
    p_referred_user_id,
    p_currency,
    p_gross_minor,
    p_observed_at
  );
$$;

create or replace function
public.partners_worker_revolut_dispute_won_jobs_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_revolut_dispute_won_jobs_lease(
      p_worker_id,
      p_lease_token_hash,
      p_limit,
      p_lease_seconds
    );
$$;

create or replace function
public.partners_worker_revolut_dispute_won_job_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_revolut_dispute_won_job_complete(
      p_job_key,
      p_worker_id,
      p_lease_token_hash,
      p_outcome,
      p_error_code
    );
$$;

revoke all on function
  affiliate_private.partners_worker_revolut_dispute_won_ingest(
    text, text, text, text, uuid, text, bigint, timestamptz
  )
  from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.partners_worker_revolut_dispute_won_enqueue(
    text, text, text, text, uuid, text, bigint, timestamptz
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_dispute_won_enqueue(
    text, text, text, text, uuid, text, bigint, timestamptz
  )
  to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_dispute_won_jobs_lease(
    text, text, integer, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_dispute_won_jobs_lease(
    text, text, integer, integer
  )
  to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_dispute_won_job_complete(
    text, text, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_dispute_won_job_complete(
    text, text, text, text, text
  )
  to service_role;

revoke all on function public.partners_worker_revolut_dispute_won_enqueue(
  text, text, text, text, uuid, text, bigint, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.partners_worker_revolut_dispute_won_enqueue(
  text, text, text, text, uuid, text, bigint, timestamptz
) to service_role;
revoke all on function
  public.partners_worker_revolut_dispute_won_jobs_lease(
    text, text, integer, integer
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_dispute_won_jobs_lease(
    text, text, integer, integer
  )
  to service_role;
revoke all on function
  public.partners_worker_revolut_dispute_won_job_complete(
    text, text, text, text, text
  )
  from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_dispute_won_job_complete(
    text, text, text, text, text
  )
  to service_role;

create or replace function affiliate_private.partners_service_dashboard(
  p_user_id uuid,
  p_history_limit integer,
  p_history_cursor text,
  p_history_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := coalesce(p_history_limit, 25);
  v_status text := lower(btrim(coalesce(p_history_status, 'all')));
  v_cursor bigint := null;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_clicks bigint := 0;
  v_referrals bigint := 0;
  v_currency_count integer := 0;
  v_currency text := null;
  v_pending_minor bigint := null;
  v_available_minor bigint := null;
  v_paid_minor bigint := null;
  v_currency_balances jsonb := '[]'::jsonb;
  v_reporting_available boolean := false;
  v_reporting_reason text := 'no_financial_activity';
  v_items jsonb := '[]'::jsonb;
  v_candidate_count integer := 0;
  v_last_sequence bigint := null;
  v_next_cursor text := null;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  if v_limit not between 1 and 50 then
    raise exception 'history limit must be between 1 and 50'
      using errcode = '22023';
  end if;
  if v_status not in (
    'all',
    'pending',
    'available',
    'held',
    'paid',
    'restored',
    'reversed'
  ) then
    raise exception 'invalid history status' using errcode = '22023';
  end if;
  if p_history_cursor is not null then
    if p_history_cursor !~ '^history_[0-9]{20}$' then
      raise exception 'invalid history cursor' using errcode = '22023';
    end if;
    begin
      v_cursor := substring(p_history_cursor from 9)::bigint;
    exception
      when numeric_value_out_of_range then
        raise exception 'invalid history cursor' using errcode = '22023';
    end;
  end if;

  perform 1
  from auth.users u
  where u.id = p_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;

  select a.*
  into v_account
  from affiliate_private.affiliate_accounts a
  where a.user_id = p_user_id
    and a.status <> 'closed'
  order by a.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'account', jsonb_build_object(
        'exists', false,
        'status', null,
        'verification_status', null,
        'contract_status', null,
        'link_status', null,
        'country_code', null,
        'subdivision_code', null,
        'created_at', null,
        'updated_at', null
      ),
      'link', null,
      'reporting', jsonb_build_object(
        'available', false,
        'reason', 'no_financial_activity',
        'currency', null,
        'clicks', 0,
        'referrals', 0,
        'pending_minor', null,
        'available_minor', null,
        'paid_minor', null,
        'currencies', '[]'::jsonb
      ),
      'history', jsonb_build_object(
        'status', v_status,
        'items', '[]'::jsonb,
        'next_cursor', null
      )
    );
  end if;

  select l.*
  into v_link
  from affiliate_private.affiliate_links l
  where l.account_id = v_account.id
    and l.status = 'active'
  order by l.created_at desc
  limit 1;

  select count(*)::bigint
  into v_clicks
  from affiliate_private.affiliate_link_claims claim
  where claim.referrer_account_id = v_account.id;

  select count(*)::bigint
  into v_referrals
  from affiliate_private.affiliate_attributions attribution
  where attribution.referrer_account_id = v_account.id;

  with currency_balances as (
    select
      posting.currency,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_commission_pending'
            and posting.direction = 'credit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_commission_pending'
            and posting.direction = 'debit'
            then -posting.amount_minor
          else 0
        end
      ), 0)::bigint as pending_minor,
      affiliate_private.partners_account_payable_balance(
        v_account.id,
        posting.currency
      ) as available_minor,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_cash_settled'
            and posting.direction = 'credit'
            then posting.amount_minor
          when posting.ledger_account = 'partner_cash_settled'
            and posting.direction = 'debit'
            then -posting.amount_minor
          else 0
        end
      ), 0)::bigint as paid_minor,
      exists (
        select 1
        from affiliate_private.affiliate_payout_profiles profile
        join affiliate_private.affiliate_payout_provider_configs provider
          on provider.provider = profile.provider
          and provider.country_code = v_account.country_code
          and provider.currency = profile.currency
          and provider.status = 'active'
        where profile.account_id = v_account.id
          and profile.currency = posting.currency
          and profile.status = 'active'
      ) as payout_destination_ready
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = v_account.id
    group by posting.currency
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'currency', balance.currency,
          'pending_minor', balance.pending_minor,
          'available_minor', balance.available_minor,
          'paid_minor', balance.paid_minor,
          'payout_destination_ready',
            balance.payout_destination_ready
        )
        order by balance.currency
      ),
      '[]'::jsonb
    ),
    count(*)::integer,
    min(balance.currency)
  into v_currency_balances, v_currency_count, v_currency
  from currency_balances balance;

  if v_currency_count = 1 then
    v_reporting_available := true;
    v_reporting_reason := 'available';
    v_pending_minor :=
      (v_currency_balances -> 0 ->> 'pending_minor')::bigint;
    v_available_minor :=
      (v_currency_balances -> 0 ->> 'available_minor')::bigint;
    v_paid_minor :=
      (v_currency_balances -> 0 ->> 'paid_minor')::bigint;
  elsif v_currency_count > 1 then
    v_reporting_available := true;
    v_currency := null;
    v_reporting_reason := 'multiple_currencies';
  end if;

  with normalized as (
    select
      entry.sequence_no,
      entry.created_at,
      case entry.entry_kind
        when 'accrual' then 'pending'
        when 'release' then 'available'
        when 'payout_allocation' then 'held'
        when 'payout_settlement' then 'paid'
        when 'reinstatement' then 'restored'
        else 'reversed'
      end as activity_status,
      case entry.entry_kind
        when 'accrual' then 'commission_pending'
        when 'release' then 'commission_available'
        when 'payout_allocation' then 'commission_held'
        when 'payout_settlement' then 'commission_paid'
        when 'reinstatement' then 'commission_restored'
        else 'commission_reversed'
      end as activity_type
    from affiliate_private.affiliate_commission_entries entry
    where entry.account_id = v_account.id
      and (v_cursor is null or entry.sequence_no < v_cursor)
  ),
  candidates as (
    select n.*
    from normalized n
    where v_status = 'all' or n.activity_status = v_status
    order by n.sequence_no desc
    limit v_limit + 1
  ),
  page as (
    select c.*
    from candidates c
    order by c.sequence_no desc
    limit v_limit
  )
  select
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'type', p.activity_type,
          'occurred_at', p.created_at
        )
        order by p.sequence_no desc
      )
      from page p
    ), '[]'::jsonb),
    (select count(*) from candidates),
    (select min(p.sequence_no) from page p)
  into v_items, v_candidate_count, v_last_sequence;

  if v_candidate_count > v_limit and v_last_sequence is not null then
    v_next_cursor := 'history_'
      || lpad(v_last_sequence::text, 20, '0');
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'account',
      affiliate_private.partners_account_state(v_account)
      || jsonb_build_object(
        'country_code', v_account.country_code,
        'subdivision_code', v_account.subdivision_code,
        'created_at', v_account.created_at,
        'updated_at', v_account.updated_at
      ),
    'link',
      case
        when v_link.id is null then null
        else jsonb_build_object(
          'status', 'active',
          'share_url', 'https://norva.tv/r/' || v_link.public_code,
          'created_at', v_link.created_at
        )
      end,
    'reporting', jsonb_build_object(
      'available', v_reporting_available,
      'reason', v_reporting_reason,
      'currency', v_currency,
      'clicks', v_clicks,
      'referrals', v_referrals,
      'pending_minor', v_pending_minor,
      'available_minor', v_available_minor,
      'paid_minor', v_paid_minor,
      'currencies', v_currency_balances
    ),
    'history', jsonb_build_object(
      'status', v_status,
      'items', v_items,
      'next_cursor', v_next_cursor
    )
  );
end;
$$;



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
      ('reconciliation'::text)
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
        ('reconciliation'::text)
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



create or replace function affiliate_private.admin_partners_analytics(
  p_days integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days integer := coalesce(p_days, 30);
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_has_support boolean;
  v_has_risk boolean;
  v_has_finance boolean;
  v_payout_ready boolean;
  v_daily jsonb;
  v_funnel jsonb;
  v_activation jsonb;
  v_risk jsonb;
  v_financial jsonb;
  v_payout_timing jsonb;
  v_retention jsonb;
begin
  if v_days not between 1 and 365 then
    raise exception 'invalid analytics window'
      using errcode = '22023';
  end if;

  v_has_support :=
    affiliate_private.partners_has_capability('support');
  v_has_risk :=
    affiliate_private.partners_has_capability('risk');
  v_has_finance :=
    affiliate_private.partners_has_capability('finance');

  if not (v_has_support or v_has_risk or v_has_finance) then
    raise exception 'Partners Admin capability is required'
      using errcode = '42501';
  end if;

  -- Analytics windows are UTC half-open intervals. This avoids depending on
  -- the caller's session time zone and makes daily values deterministic.
  v_window_end := (
    date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
  ) + interval '1 day';
  v_window_start := v_window_end - make_interval(days => v_days);

  if v_has_support then
    with days as (
      select generate_series(
        v_window_start,
        v_window_end - interval '1 day',
        interval '1 day'
      ) as day
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'date', (d.day at time zone 'UTC')::date,
          'claims', (
            select count(*)
            from affiliate_private.affiliate_link_claims c
            where c.issued_at >= d.day
              and c.issued_at < d.day + interval '1 day'
          ),
          'attributions', (
            select count(*)
            from affiliate_private.affiliate_attributions a
            where a.attributed_at >= d.day
              and a.attributed_at < d.day + interval '1 day'
          ),
          'kyc_verified', (
            select count(*)
            from affiliate_private.affiliate_kyc_sessions s
            where s.verified_at >= d.day
              and s.verified_at < d.day + interval '1 day'
          ),
          'commission_entries', (
            select count(*)
            from affiliate_private.affiliate_commission_entries e
            where e.entry_kind = 'accrual'
              and e.created_at >= d.day
              and e.created_at < d.day + interval '1 day'
          )
        )
        order by d.day
      ),
      '[]'::jsonb
    )
    into v_daily
    from days d;

    with cohort_claims as (
      select c.id
      from affiliate_private.affiliate_link_claims c
      where c.issued_at >= v_window_start
        and c.issued_at < v_window_end
    ),
    cohort_attributions as (
      select a.id, a.referred_user_id
      from affiliate_private.affiliate_attributions a
      join cohort_claims c on c.id = a.claim_id
    ),
    first_paid as (
      select distinct on (f.referred_user_id)
        f.referred_user_id,
        f.attribution_id,
        f.occurred_at
      from affiliate_private.affiliate_financial_facts f
      where f.environment = 'production'
        and f.facts_status = 'complete'
        and f.event_type in ('capture', 'renewal')
        and f.attribution_id is not null
      order by f.referred_user_id, f.occurred_at, f.id
    ),
    counts as (
      select
        (select count(*) from cohort_claims) as claims,
        (select count(*) from cohort_attributions) as attributions,
        (
          select count(*)
          from cohort_attributions a
          join first_paid f
            on f.referred_user_id = a.referred_user_id
            and f.attribution_id = a.id
        ) as first_paid
    )
    select jsonb_build_object(
      'status', 'available',
      'cohort_basis', 'claim_issued_at',
      'observation_cutoff', now(),
      'clicks', jsonb_build_object(
        'status', 'unavailable',
        'reason', 'referral_click_events_not_recorded'
      ),
      'claims_issued', jsonb_build_object(
        'status', 'available',
        'value', c.claims
      ),
      'attributions_created', jsonb_build_object(
        'status', 'available',
        'value', c.attributions
      ),
      'first_paid_referrals', jsonb_build_object(
        'status', 'available',
        'value', c.first_paid,
        'definition',
          'first complete production capture or renewal for the referred user'
      ),
      'claim_to_attribution_percent', case
        when c.claims = 0 then jsonb_build_object(
          'status', 'unavailable',
          'reason', 'no_claims_in_window'
        )
        else jsonb_build_object(
          'status', 'available',
          'value', round(c.attributions::numeric * 100 / c.claims, 1)
        )
      end,
      'attribution_to_first_payment_percent', case
        when c.attributions = 0 then jsonb_build_object(
          'status', 'unavailable',
          'reason', 'no_attributions_in_window'
        )
        else jsonb_build_object(
          'status', 'available',
          'value', round(c.first_paid::numeric * 100 / c.attributions, 1)
        )
      end
    )
    into v_funnel
    from counts c;

    select jsonb_build_object(
      'status', 'available',
      'account_activation_events', jsonb_build_object(
        'status', 'available',
        'value', count(*) filter (
          where e.action = 'account_activated'
        )
      ),
      'distinct_accounts_activated', jsonb_build_object(
        'status', 'available',
        'value', count(distinct e.aggregate_key) filter (
          where e.action = 'account_activated'
        )
      ),
      'kyc_verified_sessions', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_kyc_sessions s
          where s.verified_at >= v_window_start
            and s.verified_at < v_window_end
        )
      )
    )
    into v_activation
    from affiliate_private.affiliate_events e
    where e.aggregate_type = 'account'
      and e.created_at >= v_window_start
      and e.created_at < v_window_end;
  else
    v_daily := '[]'::jsonb;
    v_funnel := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'support_capability_required'
    );
    v_activation := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'support_capability_required'
    );
  end if;

  if v_has_risk then
    v_risk := jsonb_build_object(
      'status', 'available',
      'kyc_terminal_sessions_in_window', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_kyc_sessions s
          where s.status in ('failed', 'expired')
            and s.updated_at >= v_window_start
            and s.updated_at < v_window_end
        )
      ),
      'blocked_activation_accounts_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_accounts a
          where a.status = 'pending_verification'
            and a.verification_status in ('failed', 'expired')
        )
      ),
      'account_holds_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_accounts a
          where a.status = 'held'
        )
      ),
      'account_suspensions_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_accounts a
          where a.status = 'suspended'
        )
      ),
      'attribution_holds_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_attributions a
          where a.status = 'held'
        )
      ),
      'attribution_blocks_current', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_attributions a
          where a.status = 'blocked'
        )
      ),
      'quarantined_financial_facts_in_window', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_financial_facts f
          where f.facts_status = 'quarantined'
            and f.created_at >= v_window_start
            and f.created_at < v_window_end
        )
      ),
      'quarantined_transfer_facts_total', jsonb_build_object(
        'status', 'available',
        'value', (
          select count(*)
          from affiliate_private.affiliate_financial_facts f
          where f.event_type = 'transfer'
            and f.facts_status = 'quarantined'
        )
      ),
      'transfer_entitlement', jsonb_build_object(
        'status', 'unavailable',
        'reason', 'authoritative_transfer_entitlement_contract_not_implemented'
      )
    );
  else
    v_risk := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'risk_capability_required'
    );
  end if;

  if v_has_finance then
    with financial_facts as (
      select
        f.id,
        f.rail,
        f.event_type,
        f.currency,
        f.currency_exponent,
        f.gross_minor,
        f.tax_minor,
        f.eligible_minor
      from affiliate_private.affiliate_financial_facts f
      where f.environment = 'production'
        and f.facts_status = 'complete'
        and f.attribution_id is not null
        and f.event_type in (
          'capture',
          'renewal',
          'refund',
          'chargeback',
          'chargeback_reversal'
        )
        and f.occurred_at >= v_window_start
        and f.occurred_at < v_window_end
    ),
    commission_to_fact as (
      select
        e.entry_kind,
        e.amount_minor,
        case
          when e.entry_kind = 'manual_reversal' then origin.fact_id
          else e.fact_id
        end as fact_id
      from affiliate_private.affiliate_commission_entries e
      left join affiliate_private.affiliate_commission_entries origin
        on origin.id = e.related_entry_id
        and e.entry_kind = 'manual_reversal'
      where e.entry_kind in (
        'accrual',
        'reversal',
        'manual_reversal',
        'reinstatement'
      )
    ),
    per_fact as (
      select
        f.id,
        f.rail,
        f.event_type,
        f.currency,
        f.currency_exponent,
        f.gross_minor,
        f.tax_minor,
        f.eligible_minor,
        coalesce(sum(c.amount_minor) filter (
          where c.entry_kind = 'accrual'
        ), 0) as commission_accrued_minor,
        coalesce(sum(c.amount_minor) filter (
          where c.entry_kind = 'reversal'
        ), 0) as commission_reversed_minor,
        coalesce(sum(c.amount_minor) filter (
          where c.entry_kind = 'manual_reversal'
        ), 0) as commission_manual_reversed_minor,
        coalesce(sum(c.amount_minor) filter (
          where c.entry_kind = 'reinstatement'
        ), 0) as commission_reinstated_minor,
        case
          when f.event_type in ('capture', 'renewal') then
            count(*) filter (where c.entry_kind = 'accrual') > 0
          when f.event_type = 'chargeback_reversal' then
            count(*) filter (where c.entry_kind = 'reinstatement') > 0
          else
            count(*) filter (where c.entry_kind = 'reversal') > 0
        end as commission_processed
      from financial_facts f
      left join commission_to_fact c on c.fact_id = f.id
      group by
        f.id,
        f.rail,
        f.event_type,
        f.currency,
        f.currency_exponent,
        f.gross_minor,
        f.tax_minor,
        f.eligible_minor
    ),
    grouped as (
      select
        p.rail,
        p.currency,
        p.currency_exponent,
        count(*) filter (
          where p.event_type in ('capture', 'renewal')
        ) as paid_event_count,
        count(*) filter (
          where p.event_type = 'refund'
        ) as refund_count,
        count(*) filter (
          where p.event_type = 'chargeback'
        ) as chargeback_count,
        count(*) filter (
          where p.event_type = 'chargeback_reversal'
        ) as chargeback_reversal_count,
        sum(p.gross_minor) filter (
          where p.event_type in ('capture', 'renewal')
        ) as paid_gross_minor,
        coalesce(sum(p.eligible_minor) filter (
          where p.event_type = 'refund'
        ), 0) as refunded_eligible_minor,
        coalesce(sum(p.eligible_minor) filter (
          where p.event_type = 'chargeback'
        ), 0) as chargeback_eligible_minor,
        coalesce(sum(p.eligible_minor) filter (
          where p.event_type = 'chargeback_reversal'
        ), 0) as chargeback_reinstated_eligible_minor,
        coalesce(sum(
          case
            when p.event_type in (
              'capture',
              'renewal',
              'chargeback_reversal'
            )
              then p.eligible_minor
            else -p.eligible_minor
          end
        ), 0) as net_eligible_revenue_minor,
        coalesce(sum(p.commission_accrued_minor), 0)
          as commission_accrued_minor,
        coalesce(sum(p.commission_reversed_minor), 0)
          as commission_reversed_minor,
        coalesce(sum(p.commission_manual_reversed_minor), 0)
          as commission_manual_reversed_minor,
        coalesce(sum(p.commission_reinstated_minor), 0)
          as commission_reinstated_minor,
        count(*) filter (where not p.commission_processed)
          as unprocessed_financial_fact_count
      from per_fact p
      group by p.rail, p.currency, p.currency_exponent
    )
    select jsonb_build_object(
      'status', 'available',
      'basis',
        'complete production attributed facts by occurred_at; '
        || 'commission entries observed at generation time',
      'rows', coalesce(jsonb_agg(
        jsonb_build_object(
          'rail', g.rail,
          'currency', g.currency,
          'currency_exponent', g.currency_exponent,
          'paid_event_count', g.paid_event_count,
          'refund_count', g.refund_count,
          'chargeback_count', g.chargeback_count,
          'chargeback_reversal_count', g.chargeback_reversal_count,
          'paid_gross_minor', g.paid_gross_minor,
          'refunded_eligible_minor', g.refunded_eligible_minor,
          'chargeback_eligible_minor', g.chargeback_eligible_minor,
          'chargeback_reinstated_eligible_minor',
            g.chargeback_reinstated_eligible_minor,
          'net_eligible_revenue_minor', g.net_eligible_revenue_minor,
          'commission_accrued_minor', g.commission_accrued_minor,
          'commission_reversed_minor', g.commission_reversed_minor,
          'commission_manual_reversed_minor',
            g.commission_manual_reversed_minor,
          'commission_reinstated_minor', g.commission_reinstated_minor,
          'net_partner_commission_minor',
            g.commission_accrued_minor
            - g.commission_reversed_minor
            - g.commission_manual_reversed_minor
            + g.commission_reinstated_minor,
          'unprocessed_financial_fact_count',
            g.unprocessed_financial_fact_count,
          'contribution_after_partner_commission_minor', case
            when g.unprocessed_financial_fact_count > 0
              then jsonb_build_object(
                'status', 'unavailable',
                'reason', 'commission_processing_incomplete'
              )
            else jsonb_build_object(
              'status', 'available',
              'value',
                g.net_eligible_revenue_minor
                - (
                  g.commission_accrued_minor
                  - g.commission_reversed_minor
                  - g.commission_manual_reversed_minor
                  + g.commission_reinstated_minor
                )
            )
          end
        )
        order by g.rail, g.currency, g.currency_exponent
      ), '[]'::jsonb),
      'gross_margin', jsonb_build_object(
        'status', 'unavailable',
        'reason',
          'provider_fees_fx_infrastructure_and_other_costs_not_modeled'
      ),
      'transfer_entitlement', jsonb_build_object(
        'status', 'unavailable',
        'reason', 'authoritative_transfer_entitlement_contract_not_implemented',
        'quarantined_fact_count', (
          select count(*)
          from affiliate_private.affiliate_financial_facts transfer
          where transfer.event_type = 'transfer'
            and transfer.facts_status = 'quarantined'
        )
      )
    )
    into v_financial
    from grouped g;

    select
      coalesce((select flag.enabled
        from public.admin_feature_flags flag
        where flag.key = 'partners_payouts_live'), false)
      and affiliate_private.release_gates_satisfied(
        array['payout_execution_adapter_verified']::text[]
      )
      and exists (
        select 1
        from affiliate_private.affiliate_payout_provider_configs provider
        where provider.status = 'active'
      )
    into v_payout_ready;

    if v_payout_ready then
      with first_settled as (
        select distinct on (item.account_id)
          item.account_id,
          item.amount_minor,
          cycle.currency,
          cycle.currency_exponent,
          cycle.settled_at
        from affiliate_private.affiliate_payout_items item
        join affiliate_private.affiliate_payout_cycles cycle
          on cycle.id = item.cycle_id
        where item.status = 'settled'
          and cycle.status = 'settled'
          and cycle.settled_at is not null
        order by item.account_id, cycle.settled_at, item.id
      ),
      first_activation as (
        select
          e.aggregate_key as account_key,
          min(e.created_at) as activated_at
        from affiliate_private.affiliate_events e
        where e.aggregate_type = 'account'
          and e.action = 'account_activated'
        group by e.aggregate_key
      ),
      first_accrual as (
        select
          e.account_id,
          min(e.created_at) as accrued_at
        from affiliate_private.affiliate_commission_entries e
        where e.entry_kind = 'accrual'
        group by e.account_id
      ),
      observed as (
        select
          settled.account_id,
          settled.amount_minor,
          settled.currency,
          settled.currency_exponent,
          settled.settled_at,
          activation.activated_at,
          accrual.accrued_at
        from first_settled settled
        left join first_activation activation
          on activation.account_key = settled.account_id::text
        left join first_accrual accrual
          on accrual.account_id = settled.account_id
        where settled.settled_at >= v_window_start
          and settled.settled_at < v_window_end
      ),
      summary as (
        select
          count(*) as first_payout_count,
          count(*) filter (
            where activated_at is not null
              and activated_at <= settled_at
          ) as activation_baseline_count,
          count(*) filter (
            where accrued_at is not null
              and accrued_at <= settled_at
          ) as accrual_baseline_count,
          percentile_cont(0.5) within group (
            order by extract(epoch from (settled_at - activated_at))
              / 86400.0
          ) filter (
            where activated_at is not null
              and activated_at <= settled_at
          ) as median_activation_days,
          percentile_cont(0.5) within group (
            order by extract(epoch from (settled_at - accrued_at))
              / 86400.0
          ) filter (
            where accrued_at is not null
              and accrued_at <= settled_at
          ) as median_accrual_days
        from observed
      ),
      currency_totals as (
        select
          o.currency,
          o.currency_exponent,
          count(*) as first_payout_count,
          sum(o.amount_minor) as first_payout_total_minor
        from observed o
        group by o.currency, o.currency_exponent
      )
      select jsonb_build_object(
        'status', 'available',
        'cohort_basis', 'first_settled_payout_at',
        'first_settled_payouts', jsonb_build_object(
          'status', 'available',
          'value', s.first_payout_count
        ),
        'by_currency', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'currency', totals.currency,
              'currency_exponent', totals.currency_exponent,
              'first_payout_count', totals.first_payout_count,
              'first_payout_total_minor', totals.first_payout_total_minor
            )
            order by totals.currency, totals.currency_exponent
          )
          from currency_totals totals
        ), '[]'::jsonb),
        'median_days_activation_to_first_settled_payout', case
          when s.activation_baseline_count = 0 then jsonb_build_object(
            'status', 'unavailable',
            'reason', 'no_eligible_first_payout_observations'
          )
          else jsonb_build_object(
            'status', 'available',
            'value', round(s.median_activation_days::numeric, 2),
            'sample_size', s.activation_baseline_count
          )
        end,
        'median_days_first_accrual_to_first_settled_payout', case
          when s.accrual_baseline_count = 0 then jsonb_build_object(
            'status', 'unavailable',
            'reason', 'no_eligible_first_payout_observations'
          )
          else jsonb_build_object(
            'status', 'available',
            'value', round(s.median_accrual_days::numeric, 2),
            'sample_size', s.accrual_baseline_count
          )
        end
      )
      into v_payout_timing
      from summary s;
    else
      v_payout_timing := jsonb_build_object(
        'status', 'unavailable',
        'reason', 'payout_operations_not_ready'
      );
    end if;

    v_retention := jsonb_build_object(
      'status', 'unavailable',
      'reason',
        'authoritative_entitlement_and_billing_interval_history_not_modeled'
    );
  else
    v_financial := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'finance_capability_required'
    );
    v_payout_timing := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'finance_capability_required'
    );
    v_retention := jsonb_build_object(
      'status', 'unavailable',
      'reason', 'finance_capability_required'
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'window_days', v_days,
    'window', jsonb_build_object(
      'timezone', 'UTC',
      'start', v_window_start,
      'end_exclusive', v_window_end
    ),
    'daily_status', case
      when v_has_support then jsonb_build_object('status', 'available')
      else jsonb_build_object(
        'status', 'unavailable',
        'reason', 'support_capability_required'
      )
    end,
    'daily', v_daily,
    'funnel', v_funnel,
    'activation', v_activation,
    'risk', v_risk,
    'financial', v_financial,
    'payout_timing', v_payout_timing,
    'retention', v_retention
  );
end;
$$;



create or replace function
affiliate_private.admin_partners_commission_reverse(
  p_entry_key text,
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
  v_entry_key text := lower(btrim(coalesce(p_entry_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_accrual affiliate_private.affiliate_commission_entries%rowtype;
  v_reversal affiliate_private.affiliate_commission_entries%rowtype;
  v_reversed bigint := 0;
  v_amount bigint := 0;
  v_recovery_route jsonb;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_capability('risk');
  if v_entry_key !~ '^led_[0-9a-f]{24}$'
    or v_confirmation <> 'REVERSE:' || v_entry_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual reversal'
      using errcode = '22023';
  end if;
  select e.*
  into v_accrual
  from affiliate_private.affiliate_commission_entries e
  where e.entry_key = v_entry_key
    and e.entry_kind = 'accrual'
  for update;
  if not found then
    raise exception 'accrual entry is unavailable'
      using errcode = 'P0002';
  end if;
  v_reversed :=
    affiliate_private.partners_net_reversed_minor(v_accrual.id);
  v_amount := greatest(v_accrual.amount_minor - v_reversed, 0);
  if v_amount = 0 then
    raise exception 'accrual has no reversible balance'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    attribution_id,
    entry_kind,
    related_entry_id,
    currency,
    currency_exponent,
    amount_minor
  )
  values (
    v_accrual.account_id,
    v_accrual.attribution_id,
    'manual_reversal',
    v_accrual.id,
    v_accrual.currency,
    v_accrual.currency_exponent,
    v_amount
  )
  returning * into v_reversal;
  v_recovery_route :=
    affiliate_private.partners_route_commission_recovery(
      v_reversal.id,
      v_accrual.account_id,
      v_accrual.currency,
      v_amount,
      not exists (
        select 1
        from affiliate_private.affiliate_commission_entries release
        where release.related_entry_id = v_accrual.id
          and release.entry_kind = 'release'
      )
    );
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'commission',
    v_reversal.entry_key,
    'manual_commission_reversal',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'origin_entry_key', v_accrual.entry_key,
      'amount_minor', v_amount,
      'currency', v_accrual.currency,
      'recovery_route', v_recovery_route
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'manual_commission_reversal',
    'ledger_entry', jsonb_build_object(
      'key', v_reversal.entry_key,
      'status', 'reversed',
      'recovery_route', v_recovery_route
    )
  );
end;
$$;



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
    'commission', 'correction', 'maturation', 'reconciliation', 'payout'
  )
    or v_status not in ('healthy', 'degraded', 'blocked')
    or jsonb_typeof(v_details) <> 'object'
    or v_details ?| array[
      'email', 'token', 'secret', 'payload', 'user_id', 'account_id'
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



create or replace function
affiliate_private.partners_worker_shadow_reconcile(
  p_worker_id text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_dry_run boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_run affiliate_private.affiliate_shadow_reconciliation_runs%rowtype;
  v_facts bigint := 0;
  v_entries bigint := 0;
  v_missing_entries bigint := 0;
  v_orphan_entries bigint := 0;
  v_amount_mismatches bigint := 0;
  v_missing_reversals bigint := 0;
  v_invalid_reversals bigint := 0;
  v_missing_reinstatements bigint := 0;
  v_invalid_reinstatements bigint := 0;
  v_dispute_won_failures bigint := 0;
  v_over_reversed bigint := 0;
  v_missing_releases bigint := 0;
  v_invalid_releases bigint := 0;
  v_conflicted_facts bigint := 0;
  v_mismatches bigint := 0;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or p_window_start is null
    or p_window_end is null
    or p_window_end <= p_window_start
    or p_window_end > p_window_start + interval '31 days'
    or p_window_end > now() + interval '5 minutes'
    or p_dry_run is null
  then
    raise exception 'invalid reconciliation window'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:reconcile:'
        || p_window_start::text
        || ':'
        || p_window_end::text,
      0
    )
  );

  select count(*)
  into v_facts
  from affiliate_private.affiliate_financial_facts f
  where f.environment = 'production'
    and f.facts_status = 'complete'
    and f.event_type in ('capture', 'renewal')
    and f.attribution_id is not null
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end;

  select count(*)
  into v_entries
  from affiliate_private.affiliate_commission_entries e
  join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  where e.entry_kind = 'accrual'
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end;

  select count(*)
  into v_missing_entries
  from affiliate_private.affiliate_financial_facts f
  join affiliate_private.affiliate_attributions a
    on a.id = f.attribution_id
  join affiliate_private.affiliate_accounts account
    on account.id = a.referrer_account_id
  where f.environment = 'production'
    and f.facts_status = 'complete'
    and f.event_type in ('capture', 'renewal')
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end
    and a.status in ('attributed', 'qualified')
    and account.status = 'active'
    and affiliate_private.partners_commission_minor(
      f.eligible_minor,
      a.commission_rate_bps
    ) > 0
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries e
      where e.fact_id = f.id
        and e.entry_kind = 'accrual'
    );

  select count(*)
  into v_orphan_entries
  from affiliate_private.affiliate_commission_entries e
  left join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  where e.entry_kind = 'accrual'
    and e.created_at >= p_window_start
    and e.created_at < p_window_end
    and (
      f.id is null
      or f.environment <> 'production'
      or f.facts_status <> 'complete'
      or f.event_type not in ('capture', 'renewal')
    );

  select count(*)
  into v_amount_mismatches
  from affiliate_private.affiliate_commission_entries e
  join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  join affiliate_private.affiliate_attributions a
    on a.id = e.attribution_id
  where e.entry_kind = 'accrual'
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end
    and e.amount_minor <> affiliate_private.partners_commission_minor(
      f.eligible_minor,
      a.commission_rate_bps
    );

  select count(*)
  into v_missing_reversals
  from affiliate_private.affiliate_financial_facts f
  where f.environment = 'production'
    and f.facts_status in ('complete', 'quarantined')
    and f.event_type in ('refund', 'chargeback')
    and f.occurred_at >= p_window_start
    and f.occurred_at < p_window_end
    and (
      f.attribution_id is not null
      or exists (
        select 1
        from affiliate_private.affiliate_financial_fact_lineage_links link
        where link.child_fact_id = f.id
      )
    )
    and exists (
      select 1
      from affiliate_private.affiliate_financial_facts origin
      where origin.environment = f.environment
        and origin.rail = f.rail
        and origin.transaction_hash = f.parent_transaction_hash
        and origin.event_type in ('capture', 'renewal')
        and (
          exists (
            select 1
            from affiliate_private.affiliate_commission_entries origin_entry
            where origin_entry.fact_id = origin.id
              and origin_entry.entry_kind = 'accrual'
          )
          or exists (
            select 1
            from affiliate_private.affiliate_commission_jobs origin_job
            where origin_job.fact_id = origin.id
              and origin_job.job_kind = 'accrual'
          )
        )
    )
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries e
      where e.fact_id = f.id
        and e.entry_kind = 'reversal'
    );

  select count(*)
  into v_invalid_reversals
  from affiliate_private.affiliate_commission_entries e
  join affiliate_private.affiliate_financial_facts f on f.id = e.fact_id
  join affiliate_private.affiliate_attributions a
    on a.id = e.attribution_id
  join affiliate_private.affiliate_commission_entries origin
    on origin.id = e.related_entry_id
  where e.entry_kind = 'reversal'
    and e.created_at >= p_window_start
    and e.created_at < p_window_end
    and (
      f.event_type not in ('refund', 'chargeback')
      or origin.entry_kind <> 'accrual'
      or origin.currency <> e.currency
      or origin.currency_exponent <> e.currency_exponent
      or e.amount_minor > affiliate_private.partners_commission_minor(
        f.eligible_minor,
        a.commission_rate_bps
      )
    );

  select count(*)
  into v_over_reversed
  from (
    select origin.id
    from affiliate_private.affiliate_commission_entries origin
    where origin.entry_kind = 'accrual'
      and exists (
        select 1
        from affiliate_private.affiliate_commission_entries negative
        where negative.related_entry_id = origin.id
          and negative.entry_kind in ('reversal', 'manual_reversal')
          and negative.created_at >= p_window_start
          and negative.created_at < p_window_end
      )
      and affiliate_private.partners_net_reversed_minor(origin.id)
        > origin.amount_minor
  ) excessive;

  select count(*)
  into v_missing_reinstatements
  from affiliate_private.affiliate_financial_facts correction
  where correction.environment = 'production'
    and correction.rail = 'web'
    and correction.event_type = 'chargeback_reversal'
    and correction.facts_status = 'complete'
    and correction.occurred_at >= p_window_start
    and correction.occurred_at < p_window_end
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries reinstatement
      where reinstatement.fact_id = correction.id
        and reinstatement.entry_kind = 'reinstatement'
    );

  select count(*)
  into v_invalid_reinstatements
  from affiliate_private.affiliate_commission_entries reinstatement
  join affiliate_private.affiliate_financial_facts correction
    on correction.id = reinstatement.fact_id
  left join affiliate_private.affiliate_commission_entries reversal
    on reversal.id = reinstatement.related_entry_id
  left join affiliate_private.affiliate_commission_entries accrual
    on accrual.id = reversal.related_entry_id
  left join affiliate_private.affiliate_financial_facts loss
    on loss.id = reversal.fact_id
  where reinstatement.entry_kind = 'reinstatement'
    and reinstatement.created_at >= p_window_start
    and reinstatement.created_at < p_window_end
    and (
      correction.event_type <> 'chargeback_reversal'
      or correction.environment <> 'production'
      or correction.rail <> 'web'
      or correction.facts_status <> 'complete'
      or reversal.id is null
      or reversal.entry_kind <> 'reversal'
      or accrual.id is null
      or accrual.entry_kind <> 'accrual'
      or loss.id is null
      or loss.event_type <> 'chargeback'
      or reinstatement.account_id is distinct from reversal.account_id
      or reinstatement.attribution_id is distinct from reversal.attribution_id
      or reinstatement.currency is distinct from reversal.currency
      or reinstatement.currency_exponent
        is distinct from reversal.currency_exponent
      or reinstatement.amount_minor is distinct from reversal.amount_minor
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reinstatement.id
          and posting.direction = 'debit'
      ) <> reinstatement.amount_minor
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reinstatement.id
          and posting.direction = 'credit'
      ) <> reinstatement.amount_minor
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reinstatement.id
          and posting.ledger_account = 'partner_commission_pending'
          and posting.direction = 'credit'
      ) <> (
        case
          when exists (
            select 1
            from affiliate_private.affiliate_commission_entries release
            where release.related_entry_id = accrual.id
              and release.entry_kind = 'release'
              and release.created_at <= reinstatement.created_at
          ) then 0
          else (
            select coalesce(sum(posting.amount_minor), 0)
            from affiliate_private.affiliate_commission_postings posting
            where posting.entry_id = reversal.id
              and posting.ledger_account = 'partner_commission_pending'
              and posting.direction = 'debit'
          )
        end
      )
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reinstatement.id
          and posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'credit'
      ) > (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reversal.id
          and posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'debit'
      )
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reinstatement.id
          and posting.ledger_account = 'partner_commission_available'
          and posting.direction = 'credit'
      ) <> (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reversal.id
          and posting.direction = 'debit'
          and posting.ledger_account in (
            'partner_commission_available',
            'partner_payout_clearing',
            'partner_recovery_due'
          )
      ) + case
        when exists (
          select 1
          from affiliate_private.affiliate_commission_entries release
          where release.related_entry_id = accrual.id
            and release.entry_kind = 'release'
            and release.created_at <= reinstatement.created_at
        ) then (
          select coalesce(sum(posting.amount_minor), 0)
          from affiliate_private.affiliate_commission_postings posting
          where posting.entry_id = reversal.id
            and posting.ledger_account = 'partner_commission_pending'
            and posting.direction = 'debit'
        )
        else 0
      end - (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = reinstatement.id
          and posting.ledger_account = 'partner_recovery_due'
          and posting.direction = 'credit'
      )
    );

  select
    (
      select count(*)
      from affiliate_private.affiliate_revolut_dispute_won_jobs job
      where job.status = 'dead_letter'
        and job.updated_at >= p_window_start
        and job.updated_at < p_window_end
    )
    + (
      select count(*)
      from affiliate_private.affiliate_revolut_dispute_won_conflicts conflict
      where conflict.created_at >= p_window_start
        and conflict.created_at < p_window_end
    )
  into v_dispute_won_failures;

  select count(*)
  into v_missing_releases
  from affiliate_private.affiliate_commission_entries accrual
  where accrual.entry_kind = 'accrual'
    and accrual.matures_at <= least(now(), p_window_end)
    and accrual.matures_at >= p_window_start
    and greatest(
      accrual.amount_minor
        - affiliate_private.partners_net_reversed_minor(accrual.id),
      0
    ) > 0
    and not exists (
      select 1
      from affiliate_private.affiliate_commission_entries release
      where release.related_entry_id = accrual.id
        and release.entry_kind = 'release'
    );

  select count(*)
  into v_invalid_releases
  from affiliate_private.affiliate_commission_entries release
  join affiliate_private.affiliate_commission_entries accrual
    on accrual.id = release.related_entry_id
  where release.entry_kind = 'release'
    and release.created_at >= p_window_start
    and release.created_at < p_window_end
    and (
      accrual.entry_kind <> 'accrual'
      or release.currency <> accrual.currency
      or release.currency_exponent <> accrual.currency_exponent
      or release.amount_minor <> greatest(
        accrual.amount_minor
          - greatest(
            coalesce((
              select sum(negative.amount_minor)
              from affiliate_private.affiliate_commission_entries negative
              where negative.related_entry_id = accrual.id
                and negative.entry_kind in ('reversal', 'manual_reversal')
                and negative.created_at <= release.created_at
            ), 0)
            - coalesce((
              select sum(reinstatement.amount_minor)
              from affiliate_private.affiliate_commission_entries reinstatement
              join affiliate_private.affiliate_commission_entries reversal
                on reversal.id = reinstatement.related_entry_id
              where reversal.related_entry_id = accrual.id
                and reversal.entry_kind = 'reversal'
                and reinstatement.entry_kind = 'reinstatement'
                and reinstatement.created_at <= release.created_at
            ), 0),
            0
          ),
        0
      )
    );

  select count(distinct c.fact_id)
  into v_conflicted_facts
  from affiliate_private.affiliate_financial_fact_conflicts c
  where c.observed_at >= p_window_start
    and c.observed_at < p_window_end;

  v_mismatches :=
    v_missing_entries
    + v_orphan_entries
    + v_amount_mismatches
    + v_missing_reversals
    + v_invalid_reversals
    + v_missing_reinstatements
    + v_invalid_reinstatements
    + v_dispute_won_failures
    + v_over_reversed
    + v_missing_releases
    + v_invalid_releases
    + v_conflicted_facts;

  insert into affiliate_private.affiliate_shadow_reconciliation_runs (
    worker_id,
    window_start,
    window_end,
    dry_run,
    status,
    facts_count,
    ledger_entries_count,
    mismatch_count
  )
  values (
    v_worker,
    p_window_start,
    p_window_end,
    p_dry_run,
    case when v_mismatches = 0 then 'clean' else 'mismatch' end,
    v_facts,
    v_entries,
    v_mismatches
  )
  returning * into v_run;

  return jsonb_build_object(
    'schema_version', 1,
    'run', jsonb_build_object(
      'key', v_run.run_key,
      'status', v_run.status,
      'facts', v_run.facts_count,
      'ledger_entries', v_run.ledger_entries_count,
      'mismatches', v_run.mismatch_count,
      'dry_run', v_run.dry_run
    )
  );
end;
$$;



create or replace function
affiliate_private.partners_worker_maturation_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job_key text := lower(btrim(coalesce(p_job_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_error text := nullif(lower(btrim(coalesce(p_error_code, ''))), '');
  v_job affiliate_private.affiliate_maturation_jobs%rowtype;
  v_accrual affiliate_private.affiliate_commission_entries%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_attribution affiliate_private.affiliate_attributions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_reversed bigint := 0;
  v_amount bigint := 0;
  v_status text;
  v_delay_seconds integer;
begin
  if v_job_key !~ '^mat_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or v_outcome not in ('succeeded', 'retry', 'dead_letter')
    or (
      v_outcome in ('retry', 'dead_letter')
      and (v_error is null or v_error !~ '^[a-z][a-z0-9_]{2,63}$')
    )
  then
    raise exception 'invalid maturation completion request'
      using errcode = '22023';
  end if;

  select j.*
  into v_job
  from affiliate_private.affiliate_maturation_jobs j
  where j.job_key = v_job_key
  for update;
  if not found then
    raise exception 'maturation job is unavailable'
      using errcode = 'P0006';
  end if;
  if v_job.status <> 'leased'
    or v_job.worker_id <> v_worker
    or v_job.lease_token_hash <> v_token
    or v_job.leased_until <= now()
  then
    raise exception 'maturation lease is unavailable'
      using errcode = 'P0004';
  end if;

  if v_outcome = 'retry' and v_job.attempts >= 12 then
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = coalesce(v_error, 'retry_exhausted'),
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'retry' then
    v_delay_seconds := least(
      3600,
      (30 * power(2::numeric, least(v_job.attempts, 7)))::integer
    );
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + make_interval(secs => v_delay_seconds),
      last_error_code = v_error,
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'dead_letter' then
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = v_error,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  else
    select e.*
    into v_accrual
    from affiliate_private.affiliate_commission_entries e
    where e.id = v_job.accrual_entry_id
      and e.entry_kind = 'accrual'
    for update;
    if not found or v_job.available_at > now() then
      raise exception 'accrual has not matured'
        using errcode = 'P0004';
    end if;

    select a.*
    into v_attribution
    from affiliate_private.affiliate_attributions a
    where a.id = v_accrual.attribution_id
    for update;
    select a.*
    into v_account
    from affiliate_private.affiliate_accounts a
    where a.id = v_accrual.account_id
    for update;

    if v_attribution.id is null
      or v_attribution.status not in ('attributed', 'qualified')
      or v_account.id is null
      or v_account.status <> 'active'
    then
      raise exception 'maturation is held for review'
        using errcode = 'P0004';
    end if;

    v_reversed :=
      affiliate_private.partners_net_reversed_minor(v_accrual.id);
    v_amount := greatest(v_accrual.amount_minor - v_reversed, 0);

    if v_amount > 0 then
      perform affiliate_private.partners_balance_lock(
        v_accrual.account_id,
        v_accrual.currency
      );
      insert into affiliate_private.affiliate_commission_entries (
        account_id,
        attribution_id,
        fact_id,
        entry_kind,
        related_entry_id,
        currency,
        currency_exponent,
        amount_minor
      )
      values (
        v_accrual.account_id,
        v_accrual.attribution_id,
        v_accrual.fact_id,
        'release',
        v_accrual.id,
        v_accrual.currency,
        v_accrual.currency_exponent,
        v_amount
      )
      on conflict (entry_kind, fact_id) do nothing
      returning * into v_entry;

      if v_entry.id is not null then
        insert into affiliate_private.affiliate_commission_postings (
          entry_id, ledger_account, direction, amount_minor, currency
        )
        values
          (
            v_entry.id,
            'partner_commission_pending',
            'debit',
            v_amount,
            v_accrual.currency
          ),
          (
            v_entry.id,
            'partner_commission_available',
            'credit',
            v_amount,
            v_accrual.currency
          );
        perform affiliate_private.partners_recovery_due_consume(
          v_accrual.account_id,
          v_accrual.currency
        );
      end if;
    end if;

    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'succeeded',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = null,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'maturation_job_completed',
    'job', jsonb_build_object(
      'key', v_job.job_key,
      'status', v_status
    ),
    'ledger_entry', case
      when v_entry.id is null then null
      else jsonb_build_object(
        'key', v_entry.entry_key,
        'status', 'available',
        'matures_at', null
      )
    end
  );
end;
$$;



create or replace function
affiliate_private.partners_worker_commission_job_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job_key text := lower(btrim(coalesce(p_job_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_token text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_error text := nullif(lower(btrim(coalesce(p_error_code, ''))), '');
  v_job affiliate_private.affiliate_commission_jobs%rowtype;
  v_fact affiliate_private.affiliate_financial_facts%rowtype;
  v_origin_fact affiliate_private.affiliate_financial_facts%rowtype;
  v_attribution affiliate_private.affiliate_attributions%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_origin_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_amount bigint;
  v_already_reversed bigint := 0;
  v_recovery_route jsonb;
  v_status text;
  v_delay_seconds integer;
begin
  if v_job_key !~ '^job_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_token !~ '^[0-9a-f]{64}$'
    or v_outcome not in ('succeeded', 'retry', 'dead_letter')
    or (
      v_outcome in ('retry', 'dead_letter')
      and (v_error is null or v_error !~ '^[a-z][a-z0-9_]{2,63}$')
    )
  then
    raise exception 'invalid commission completion request'
      using errcode = '22023';
  end if;

  select j.*
  into v_job
  from affiliate_private.affiliate_commission_jobs j
  where j.job_key = v_job_key
  for update;
  if not found then
    raise exception 'commission job is unavailable'
      using errcode = 'P0006';
  end if;
  if v_job.status <> 'leased'
    or v_job.worker_id <> v_worker
    or v_job.lease_token_hash <> v_token
    or v_job.leased_until <= now()
  then
    raise exception 'commission job lease is unavailable'
      using errcode = 'P0004';
  end if;

  if v_outcome = 'retry' and v_job.attempts >= 12 then
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = coalesce(v_error, 'retry_exhausted'),
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'retry' then
    v_delay_seconds := least(
      3600,
      (30 * power(2::numeric, least(v_job.attempts, 7)))::integer
    );
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + make_interval(secs => v_delay_seconds),
      last_error_code = v_error,
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  elsif v_outcome = 'dead_letter' then
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'dead_letter',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = v_error,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;
  else
    select f.*
    into v_fact
    from affiliate_private.affiliate_financial_facts f
    where f.id = v_job.fact_id;
    if not found
      or v_fact.facts_status <> 'complete'
      or v_fact.environment <> 'production'
      or v_fact.eligible_minor is null
      or v_fact.currency is null
      or v_fact.currency_exponent is null
    then
      raise exception 'commission fact is not executable'
        using errcode = 'P0004';
    end if;

    select a.*
    into v_attribution
    from affiliate_private.affiliate_attributions a
    where a.id = coalesce(
      v_fact.attribution_id,
      (
        select l.attribution_id
        from affiliate_private.affiliate_financial_fact_lineage_links l
        where l.child_fact_id = v_fact.id
      )
    )
    for update;
    if not found
      or (
        v_job.job_kind = 'accrual'
        and v_attribution.status not in ('attributed', 'qualified')
      )
    then
      raise exception 'attribution is not commissionable'
        using errcode = 'P0004';
    end if;

    select a.*
    into v_account
    from affiliate_private.affiliate_accounts a
    where a.id = v_attribution.referrer_account_id
    for update;
    if not found
      or (
        v_job.job_kind = 'accrual'
        and v_account.status <> 'active'
      )
    then
      raise exception 'Partner account is not commissionable'
        using errcode = 'P0004';
    end if;

    select p.*
    into v_program
    from affiliate_private.affiliate_program_versions p
    where p.id = v_attribution.program_version_id;
    if not found
      or v_program.commission_rate_bps
        <> v_attribution.commission_rate_bps
      or v_program.maturation_days <> 45
    then
      raise exception 'commission program snapshot is unavailable'
        using errcode = '55000';
    end if;

    v_amount := affiliate_private.partners_commission_minor(
      v_fact.eligible_minor,
      v_attribution.commission_rate_bps
    );

    if v_job.job_kind = 'accrual' then
      if v_fact.event_type not in ('capture', 'renewal') then
        raise exception 'accrual job has incompatible fact'
          using errcode = '55000';
      end if;

      if v_amount > 0 then
        insert into affiliate_private.affiliate_commission_entries (
          account_id,
          attribution_id,
          fact_id,
          entry_kind,
          currency,
          currency_exponent,
          amount_minor,
          matures_at
        )
        values (
          v_account.id,
          v_attribution.id,
          v_fact.id,
          'accrual',
          v_fact.currency,
          v_fact.currency_exponent,
          v_amount,
          v_fact.occurred_at
            + make_interval(days => v_program.maturation_days)
        )
        on conflict (entry_kind, fact_id) do nothing
        returning * into v_entry;

        if v_entry.id is null then
          select e.*
          into v_entry
          from affiliate_private.affiliate_commission_entries e
          where e.entry_kind = 'accrual'
            and e.fact_id = v_fact.id;
        else
          insert into affiliate_private.affiliate_commission_postings (
            entry_id, ledger_account, direction, amount_minor, currency
          )
          values
            (
              v_entry.id,
              'platform_commission_expense',
              'debit',
              v_amount,
              v_fact.currency
            ),
            (
              v_entry.id,
              'partner_commission_pending',
              'credit',
              v_amount,
              v_fact.currency
            );

          insert into affiliate_private.affiliate_maturation_jobs (
            accrual_entry_id,
            available_at,
            next_attempt_at
          )
          values (
            v_entry.id,
            v_entry.matures_at,
            v_entry.matures_at
          );
        end if;
      end if;
    else
      if v_fact.event_type not in ('refund', 'chargeback') then
        raise exception 'reversal job has incompatible fact'
          using errcode = '55000';
      end if;

      select f.*
      into v_origin_fact
      from affiliate_private.affiliate_financial_facts f
      where f.environment = v_fact.environment
        and f.rail = v_fact.rail
        and f.transaction_hash = v_fact.parent_transaction_hash
        and f.event_type in ('capture', 'renewal')
      order by f.created_at
      limit 1;
      select e.*
      into v_origin_entry
      from affiliate_private.affiliate_commission_entries e
      where e.fact_id = v_origin_fact.id
        and e.entry_kind = 'accrual'
      for update;
      if v_origin_entry.id is null then
        raise exception 'origin accrual is not ready'
          using errcode = 'P0004';
      end if;

      v_already_reversed :=
        affiliate_private.partners_net_reversed_minor(v_origin_entry.id);
      v_amount := least(
        v_amount,
        greatest(v_origin_entry.amount_minor - v_already_reversed, 0)
      );

      if v_amount > 0 then
        insert into affiliate_private.affiliate_commission_entries (
          account_id,
          attribution_id,
          fact_id,
          entry_kind,
          related_entry_id,
          currency,
          currency_exponent,
          amount_minor
        )
        values (
          v_account.id,
          v_attribution.id,
          v_fact.id,
          'reversal',
          v_origin_entry.id,
          v_fact.currency,
          v_fact.currency_exponent,
          v_amount
        )
        on conflict (entry_kind, fact_id) do nothing
        returning * into v_entry;

        if v_entry.id is not null then
          v_recovery_route :=
            affiliate_private.partners_route_commission_recovery(
              v_entry.id,
              v_account.id,
              v_fact.currency,
              v_amount,
              not exists (
                select 1
                from affiliate_private.affiliate_commission_entries release
                where release.related_entry_id = v_origin_entry.id
                  and release.entry_kind = 'release'
              )
            );
        end if;
      end if;
    end if;

    update affiliate_private.affiliate_commission_jobs
    set
      status = 'succeeded',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = null,
      completed_at = now(),
      updated_at = now()
    where id = v_job.id
    returning status into v_status;

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
      'commission',
      v_job.job_key,
      'commission_job_succeeded',
      'system',
      v_account.user_pseudonym,
      'Commission worker appended a balanced ledger transaction.',
      jsonb_build_object(
        'job_kind', v_job.job_kind,
        'entry_key', v_entry.entry_key,
        'amount_minor', coalesce(v_entry.amount_minor, 0),
        'currency', v_fact.currency,
        'recovery_route', v_recovery_route
      )
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'commission_job_completed',
    'job', jsonb_build_object(
      'key', v_job.job_key,
      'status', v_status
    ),
    'ledger_entry', case
      when v_entry.id is null then null
      else jsonb_build_object(
        'key', v_entry.entry_key,
        'status', case
          when v_entry.entry_kind = 'accrual' then 'pending'
          when v_entry.entry_kind = 'release' then 'available'
          else 'reversed'
        end,
        'matures_at', v_entry.matures_at
      )
    end
  );
end;
$$;


-- Correct already-published finance, reporting and operations routines without
-- mutating their original migrations. Restored commission is economically
-- available again, the correction worker is first-class, and all read models
-- expose the reinstatement instead of silently counting it as a reversal.
alter table affiliate_private.affiliate_worker_heartbeats
  drop constraint affiliate_worker_heartbeats_name;
alter table affiliate_private.affiliate_worker_heartbeats
  add constraint affiliate_worker_heartbeats_name
  check (
    worker_name in (
      'commission',
      'correction',
      'maturation',
      'reconciliation',
      'payout'
    )
  );

drop index if exists
  affiliate_private.affiliate_financial_facts_analytics_complete_idx;
create index affiliate_financial_facts_analytics_complete_idx
  on affiliate_private.affiliate_financial_facts (occurred_at)
  where environment = 'production'
    and facts_status = 'complete'
    and attribution_id is not null
    and event_type in (
      'capture',
      'renewal',
      'refund',
      'chargeback',
      'chargeback_reversal'
    );


-- Extend Finance remediation to the durable correction inbox.
create or replace function affiliate_private.admin_partners_job_retry(
  p_job_key text,
  p_job_type text,
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
  v_job_key text := lower(btrim(coalesce(p_job_key, '')));
  v_type text := lower(btrim(coalesce(p_job_type, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_type not in ('commission', 'correction', 'maturation')
    or (
      v_type = 'commission'
      and v_job_key !~ '^job_[0-9a-f]{24}$'
    )
    or (
      v_type = 'correction'
      and v_job_key !~ '^crw_[0-9a-f]{24}$'
    )
    or (
      v_type = 'maturation'
      and v_job_key !~ '^mat_[0-9a-f]{24}$'
    )
    or v_confirmation <> 'RETRY:' || v_job_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid job retry'
      using errcode = '22023';
  end if;
  if v_type = 'commission' then
    update affiliate_private.affiliate_commission_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      attempts = 0,
      next_attempt_at = now(),
      last_error_code = null,
      completed_at = null,
      updated_at = now()
    where job_key = v_job_key
      and status = 'dead_letter'
      and last_error_code is distinct from 'financial_fact_conflict';
  elsif v_type = 'correction' then
    update affiliate_private.affiliate_revolut_dispute_won_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      attempts = 0,
      next_attempt_at = now(),
      last_error_code = null,
      completed_at = null,
      updated_at = now()
    where job_key = v_job_key
      and status = 'dead_letter'
      and last_error_code not in (
        'payload_conflict',
        'invalid_financial_job'
      );
  else
    update affiliate_private.affiliate_maturation_jobs
    set
      status = 'retry',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      attempts = 0,
      next_attempt_at = now(),
      last_error_code = null,
      completed_at = null,
      updated_at = now()
    where job_key = v_job_key
      and status = 'dead_letter';
  end if;
  if not found then
    raise exception 'retryable dead-letter job is unavailable'
      using errcode = 'P0001';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_events (
    aggregate_type, aggregate_key, action, actor_type,
    actor_pseudonym, justification, after_state
  )
  values (
    'worker',
    v_job_key,
    'dead_letter_retried',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object('job_type', v_type, 'status', 'retry')
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'dead_letter_retried',
    'status', 'retry'
  );
end;
$$;


-- Expose correction queue health to Finance without provider identifiers.
create or replace function affiliate_private.admin_partners_finance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_currencies jsonb;
  v_last affiliate_private.affiliate_shadow_reconciliation_runs%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'currency', balances.currency,
        'pending_minor', balances.pending_minor,
        'available_minor', balances.available_minor,
        'payout_clearing_minor', balances.clearing_minor,
        'recovery_due_minor', balances.recovery_due_minor
      )
      order by balances.currency
    ),
    '[]'::jsonb
  )
  into v_currencies
  from (
    select
      p.currency,
      coalesce(sum(case
        when p.ledger_account = 'partner_commission_pending'
          then case when p.direction = 'credit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as pending_minor,
      coalesce(sum(case
        when p.ledger_account = 'partner_commission_available'
          then case when p.direction = 'credit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as available_minor,
      coalesce(sum(case
        when p.ledger_account = 'partner_payout_clearing'
          then case when p.direction = 'credit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as clearing_minor,
      coalesce(sum(case
        when p.ledger_account = 'partner_recovery_due'
          then case when p.direction = 'debit'
            then p.amount_minor else -p.amount_minor end
        else 0
      end), 0)::bigint as recovery_due_minor
    from affiliate_private.affiliate_commission_postings p
    group by p.currency
  ) balances;
  select r.*
  into v_last
  from affiliate_private.affiliate_shadow_reconciliation_runs r
  order by r.created_at desc
  limit 1;
  return jsonb_build_object(
    'schema_version', 1,
    'currencies', v_currencies,
    'queues', jsonb_build_object(
      'commission_pending', (
        select count(*) from affiliate_private.affiliate_commission_jobs
        where status = 'pending'
      ),
      'commission_retry', (
        select count(*) from affiliate_private.affiliate_commission_jobs
        where status = 'retry'
      ),
      'commission_dead_letter', (
        select count(*) from affiliate_private.affiliate_commission_jobs
        where status = 'dead_letter'
      ),
      'correction_pending', (
        select count(*)
        from affiliate_private.affiliate_revolut_dispute_won_jobs
        where status = 'pending'
      ),
      'correction_retry', (
        select count(*)
        from affiliate_private.affiliate_revolut_dispute_won_jobs
        where status = 'retry'
      ),
      'correction_dead_letter', (
        select count(*)
        from affiliate_private.affiliate_revolut_dispute_won_jobs
        where status = 'dead_letter'
      ),
      'maturation_due', (
        select count(*) from affiliate_private.affiliate_maturation_jobs
        where status in ('pending', 'retry') and available_at <= now()
      ),
      'maturation_dead_letter', (
        select count(*) from affiliate_private.affiliate_maturation_jobs
        where status = 'dead_letter'
      )
    ),
    'reconciliation', jsonb_build_object(
      'last_status', v_last.status,
      'last_run_at', v_last.created_at,
      'mismatches', v_last.mismatch_count
    )
  );
end;
$$;
