-- Norva Partners - provider-neutral payout settlement ledger invariants.
--
-- A payout allocation can be settled only once. Settlement entries must copy
-- the exact account, currency, exponent and amount of their allocation, then
-- post the canonical clearing debit and cash-settled credit. Provider-specific
-- evidence and maker-checker decisions remain responsible for authorizing the
-- transition before this deferred invariant is evaluated.

-- Keep the worker vocabulary provider-neutral while preserving the dedicated
-- RevenueCat TRANSFER heartbeat introduced before this migration.
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
    'revenuecat_transfer'
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

create unique index affiliate_payout_settlement_allocation_once_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where entry_kind = 'payout_settlement';

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

revoke all on function
  affiliate_private.assert_payout_settlement_semantics()
from public, anon, authenticated, service_role;
