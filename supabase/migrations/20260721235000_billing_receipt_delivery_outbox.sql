-- Durable Revolut payment-receipt delivery.
--
-- A successful debit and its customer receipt are two different side effects.
-- The debit is authoritative in cloud_billing_ledger; this outbox is populated in
-- the SAME transaction as that ledger insert, then delivered independently by the
-- billing cron.  A Resend outage can therefore delay a receipt, never lose it and
-- never cause the payment cycle to be charged again.

alter table public.cloud_billing_ledger
  add column if not exists plan_code text,
  add column if not exists bill_period text,
  add column if not exists billing_period_end timestamptz;

alter table public.cloud_billing_ledger
  drop constraint if exists cloud_billing_ledger_plan_code_check,
  add constraint cloud_billing_ledger_plan_code_check
    check (plan_code is null or plan_code in ('plus', 'family')),
  drop constraint if exists cloud_billing_ledger_bill_period_check,
  add constraint cloud_billing_ledger_bill_period_check
    check (bill_period is null or bill_period in ('monthly', 'annual'));

comment on column public.cloud_billing_ledger.billing_period_end is
  'Exact customer-facing period end snapshotted by the billing worker for the receipt.';

create table if not exists public.cloud_billing_receipt_outbox (
  delivery_key       text primary key,
  ledger_pi_id       text not null unique
                     references public.cloud_billing_ledger(pi_id) on delete cascade,
  user_id            uuid not null references auth.users(id) on delete cascade,
  recipient_email    text not null,
  first_name         text,
  plan_label         text not null,
  amount_cents       integer not null check (amount_cents between 1 and 9999999),
  currency           text not null check (currency ~ '^[A-Z]{3}$'),
  period_end         timestamptz,
  request_from       text,
  request_subject    text,
  request_html       text,
  prepared_at        timestamptz,
  attempt_count      integer not null default 0 check (attempt_count >= 0),
  next_attempt_at    timestamptz not null default now(),
  lease_token        uuid,
  lease_expires_at   timestamptz,
  resend_email_id    text,
  resend_response    jsonb,
  last_http_status   integer,
  last_error         text,
  sent_at            timestamptz,
  exhausted_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint cloud_billing_receipt_outbox_delivery_key_check
    check (delivery_key ~ '^norva-receipt-[0-9a-f]{64}$'),
  constraint cloud_billing_receipt_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint cloud_billing_receipt_outbox_terminal_check check (
    not (sent_at is not null and exhausted_at is not null)
  ),
  constraint cloud_billing_receipt_outbox_request_check check (
    (request_from is null and request_subject is null and request_html is null and prepared_at is null)
    or (request_from is not null and request_subject is not null and request_html is not null and prepared_at is not null)
  )
);

create index if not exists cloud_billing_receipt_outbox_due_idx
  on public.cloud_billing_receipt_outbox (next_attempt_at, created_at)
  where sent_at is null and exhausted_at is null;

create index if not exists cloud_billing_receipt_outbox_exhausted_idx
  on public.cloud_billing_receipt_outbox (exhausted_at desc)
  where exhausted_at is not null;

alter table public.cloud_billing_receipt_outbox enable row level security;
revoke all on table public.cloud_billing_receipt_outbox from public, anon, authenticated;
grant all on table public.cloud_billing_receipt_outbox to service_role;

comment on table public.cloud_billing_receipt_outbox is
  'Service-only transactional outbox for receipts generated from captured Revolut ledger rows.';

-- Enqueue exactly once from the financial source of truth.  The immutable key is
-- a SHA-256 of the ledger payment id: deterministic, privacy-safe and below
-- Resend's Idempotency-Key length limit.
create or replace function public.norva_enqueue_billing_receipt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_email text;
  v_first_name text;
  v_plan_label text;
  v_discount_pct integer := 0;
begin
  if lower(coalesce(new.provider, '')) <> 'revolut'
     or lower(coalesce(new.status, '')) <> 'captured'
     or new.user_id is null
     or new.amount is null
     or new.amount <= 0 then
    return new;
  end if;

  select lower(btrim(u.email)),
         nullif(btrim(coalesce(
           u.raw_user_meta_data->>'display_name',
           u.raw_user_meta_data->>'name',
           ''
         )), '')
    into v_email, v_first_name
  from auth.users u
  where u.id = new.user_id;

  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    -- The payment remains authoritative.  Missing identity data is visible by
    -- the absence of an outbox row and must never roll back a captured debit.
    return new;
  end if;

  if v_first_name is not null then
    v_first_name := split_part(v_first_name, ' ', 1);
  end if;
  select coalesce(a.discount_pct, 0) into v_discount_pct
  from public.cloud_revolut_billing_attempts a
  where a.order_id = new.order_id
  limit 1;
  v_discount_pct := coalesce(v_discount_pct, 0);
  v_plan_label := case when new.plan_code = 'family' then 'Norva Family' else 'Norva' end
    || case when v_discount_pct > 0 then format(' (%s%% off applied)', v_discount_pct) else '' end;

  insert into public.cloud_billing_receipt_outbox (
    delivery_key, ledger_pi_id, user_id, recipient_email, first_name,
    plan_label, amount_cents, currency, period_end
  ) values (
    'norva-receipt-' || encode(digest(new.pi_id, 'sha256'), 'hex'),
    new.pi_id,
    new.user_id,
    v_email,
    v_first_name,
    v_plan_label,
    new.amount,
    upper(coalesce(nullif(new.currency, ''), 'USD')),
    new.billing_period_end
  ) on conflict (ledger_pi_id) do nothing;

  return new;
end
$function$;

revoke all on function public.norva_enqueue_billing_receipt()
  from public, anon, authenticated;

drop trigger if exists norva_enqueue_billing_receipt_trg
  on public.cloud_billing_ledger;
create trigger norva_enqueue_billing_receipt_trg
  after insert or update of status on public.cloud_billing_ledger
  for each row execute function public.norva_enqueue_billing_receipt();

-- Claim due rows with SKIP LOCKED. Every row owns a distinct lease token so an
-- acknowledgement can only mutate the exact delivery that performed the send.
create or replace function public.claim_billing_receipt_deliveries(
  p_batch integer default 10,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
) returns table (
  delivery_key text,
  lease_token uuid,
  recipient_email text,
  first_name text,
  plan_label text,
  amount_cents integer,
  currency text,
  period_end timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  return query
  with due as (
    select o.delivery_key
    from public.cloud_billing_receipt_outbox o
    where o.sent_at is null
      and o.exhausted_at is null
      and o.attempt_count < greatest(1, least(coalesce(p_max_attempts, 12), 30))
      and o.next_attempt_at <= v_now
      and (o.lease_expires_at is null or o.lease_expires_at <= v_now)
    order by o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch, 10), 25))
    for update skip locked
  ), claimed as (
    update public.cloud_billing_receipt_outbox o
    set lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(
          secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))
        ),
        attempt_count = o.attempt_count + 1,
        updated_at = v_now
    from due
    where o.delivery_key = due.delivery_key
    returning o.*
  )
  select c.delivery_key, c.lease_token, c.recipient_email, c.first_name,
         c.plan_label, c.amount_cents, c.currency, c.period_end,
         c.attempt_count
  from claimed c
  order by c.next_attempt_at, c.created_at;
end
$function$;

-- Freeze the exact Resend payload under the active lease before network I/O.
-- If Resend accepts a request but the SQL acknowledgement is lost, a later
-- deployment cannot change the sender/template behind the same idempotency key.
create or replace function public.prepare_billing_receipt_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_request_from text,
  p_request_subject text,
  p_request_html text
) returns table (
  recipient_email text,
  request_from text,
  request_subject text,
  request_html text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if nullif(btrim(p_request_from), '') is null
     or nullif(btrim(p_request_subject), '') is null
     or nullif(btrim(p_request_html), '') is null then
    raise exception 'complete receipt request is required';
  end if;

  return query
  update public.cloud_billing_receipt_outbox o
  set request_from = coalesce(o.request_from, btrim(p_request_from)),
      request_subject = coalesce(o.request_subject, p_request_subject),
      request_html = coalesce(o.request_html, p_request_html),
      prepared_at = coalesce(o.prepared_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  returning o.recipient_email, o.request_from, o.request_subject, o.request_html;
end
$function$;

-- A receipt is acknowledged ONLY with a successful Resend HTTP response and
-- the provider's immutable email id.
create or replace function public.complete_billing_receipt_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_resend_email_id text,
  p_http_status integer,
  p_response jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_changed integer;
begin
  if p_http_status not between 200 and 299
     or nullif(btrim(p_resend_email_id), '') is null then
    raise exception 'successful Resend status and email id are required';
  end if;

  update public.cloud_billing_receipt_outbox o
  set resend_email_id = btrim(p_resend_email_id),
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      lease_token = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

-- Recoverable provider/network failures use bounded exponential backoff plus
-- jitter. Invalid requests are dead-lettered immediately for operator review.
create or replace function public.fail_billing_receipt_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_http_status integer,
  p_error text,
  p_response jsonb default '{}'::jsonb,
  p_retryable boolean default true,
  p_retry_after_seconds integer default null,
  p_max_attempts integer default 12
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count into v_attempt
  from public.cloud_billing_receipt_outbox o
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  for update;

  if not found then return 'lease_lost'; end if;

  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_billing_receipt_outbox o
  set resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000),
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;

  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$;

revoke all on function public.claim_billing_receipt_deliveries(integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.prepare_billing_receipt_delivery(text, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_billing_receipt_delivery(text, uuid, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_billing_receipt_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  from public, anon, authenticated;

grant execute on function public.claim_billing_receipt_deliveries(integer, integer, integer)
  to service_role;
grant execute on function public.prepare_billing_receipt_delivery(text, uuid, text, text, text)
  to service_role;
grant execute on function public.complete_billing_receipt_delivery(text, uuid, text, integer, jsonb)
  to service_role;
grant execute on function public.fail_billing_receipt_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  to service_role;
