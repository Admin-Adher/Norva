-- Billing receipt privacy, deletion safety and bounded idempotency follow-up.
--
-- Financial ledger rows outlive an Auth identity for accounting/audit purposes.
-- The direct FK becomes nullable ON DELETE SET NULL while a one-way digest of the
-- random user UUID preserves pseudonymous correlation. Receipt requests are
-- minimized immediately after acceptance and deleted on a bounded schedule.
-- Resend keeps Idempotency-Key results for 24 hours; Norva uses a conservative
-- 23-hour replay window, then quarantines an unconfirmed request rather than risk
-- sending a duplicate after provider-side idempotency has expired.

alter table public.cloud_billing_ledger
  add column if not exists user_pseudonym text;

update public.cloud_billing_ledger l
set user_pseudonym = encode(
  extensions.digest(
    case when l.user_id is not null then l.user_id::text else 'ledger:' || l.pi_id end,
    'sha256'
  ),
  'hex'
)
where l.user_pseudonym is null;

alter table public.cloud_billing_ledger
  drop constraint if exists cloud_billing_ledger_user_id_fkey,
  drop constraint if exists cloud_stancer_payments_user_id_fkey;
alter table public.cloud_billing_ledger alter column user_id drop not null;
alter table public.cloud_billing_ledger
  add constraint cloud_billing_ledger_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null not valid;
alter table public.cloud_billing_ledger
  validate constraint cloud_billing_ledger_user_id_fkey;
alter table public.cloud_billing_ledger
  add constraint cloud_billing_ledger_user_pseudonym_check
    check (user_pseudonym ~ '^[0-9a-f]{64}$') not valid;
alter table public.cloud_billing_ledger
  validate constraint cloud_billing_ledger_user_pseudonym_check;
alter table public.cloud_billing_ledger alter column user_pseudonym set not null;

comment on column public.cloud_billing_ledger.user_pseudonym is
  'SHA-256 digest of the random Auth UUID (or stable ledger fallback for legacy null identities). Pseudonymous, not anonymous; retained with the financial ledger.';

-- `select *` views freeze their output columns when they are created. Refresh the
-- compatibility shim so existing finance readers can use the new pseudonymous
-- correlation without changing their table name.
create or replace view public.cloud_stancer_payments as
  select * from public.cloud_billing_ledger;
revoke all on public.cloud_stancer_payments from anon, authenticated;

create or replace function public.norva_fill_billing_ledger_pseudonym()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions
as $function$
begin
  if new.user_pseudonym is null then
    new.user_pseudonym := encode(
      digest(
        case when new.user_id is not null then new.user_id::text else 'ledger:' || new.pi_id end,
        'sha256'
      ),
      'hex'
    );
  end if;
  return new;
end
$function$;

revoke all on function public.norva_fill_billing_ledger_pseudonym()
  from public, anon, authenticated;
drop trigger if exists norva_fill_billing_ledger_pseudonym_trg
  on public.cloud_billing_ledger;
create trigger norva_fill_billing_ledger_pseudonym_trg
before insert or update of user_id, pi_id on public.cloud_billing_ledger
for each row execute function public.norva_fill_billing_ledger_pseudonym();

alter table public.cloud_billing_receipt_outbox
  add column if not exists user_pseudonym text,
  add column if not exists idempotency_started_at timestamptz,
  add column if not exists delivery_uncertain boolean not null default false,
  add column if not exists quarantined_at timestamptz;

update public.cloud_billing_receipt_outbox o
set user_pseudonym = l.user_pseudonym
from public.cloud_billing_ledger l
where l.pi_id = o.ledger_pi_id and o.user_pseudonym is null;

alter table public.cloud_billing_receipt_outbox
  drop constraint if exists cloud_billing_receipt_outbox_user_id_fkey;
alter table public.cloud_billing_receipt_outbox
  alter column user_id drop not null,
  alter column recipient_email drop not null;
alter table public.cloud_billing_receipt_outbox
  add constraint cloud_billing_receipt_outbox_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null not valid;
alter table public.cloud_billing_receipt_outbox
  validate constraint cloud_billing_receipt_outbox_user_id_fkey;
alter table public.cloud_billing_receipt_outbox
  add constraint cloud_billing_receipt_outbox_user_pseudonym_check
    check (user_pseudonym ~ '^[0-9a-f]{64}$') not valid;
alter table public.cloud_billing_receipt_outbox
  validate constraint cloud_billing_receipt_outbox_user_pseudonym_check;
alter table public.cloud_billing_receipt_outbox alter column user_pseudonym set not null;

alter table public.cloud_billing_receipt_outbox
  drop constraint if exists cloud_billing_receipt_outbox_request_check,
  add constraint cloud_billing_receipt_outbox_request_check check (
    -- Accepted: recipient, personalization and message content are erased.
    (sent_at is not null
      and recipient_email is null and first_name is null
      and request_subject is null and request_html is null and request_text is null)
    or
    -- Not prepared yet.
    (sent_at is null and recipient_email is not null
      and request_from is null and request_subject is null and request_html is null
      and prepared_at is null and request_text is null
      and request_reply_to is null and request_tags is null)
    or
    -- Frozen v1 rolling-deploy payload.
    (sent_at is null and recipient_email is not null
      and request_from is not null and request_subject is not null and request_html is not null
      and prepared_at is not null and request_text is null
      and request_reply_to is null and request_tags is null)
    or
    -- Current exact multipart payload and taxonomy.
    (sent_at is null and recipient_email is not null
      and request_from is not null and request_subject is not null and request_html is not null
      and prepared_at is not null and request_text is not null
      and request_reply_to is not null
      and request_tags = jsonb_build_array(
        jsonb_build_object('name', 'app', 'value', 'norva'),
        jsonb_build_object('name', 'category', 'value', 'transactional'),
        jsonb_build_object('name', 'flow', 'value', 'payment_receipt')
      ))
  ),
  add constraint cloud_billing_receipt_outbox_quarantine_check check (
    (quarantined_at is null)
    or (exhausted_at is not null and sent_at is null and delivery_uncertain)
  ),
  add constraint cloud_billing_receipt_outbox_uncertain_check check (
    not delivery_uncertain or idempotency_started_at is not null
  );

comment on column public.cloud_billing_receipt_outbox.quarantined_at is
  'Unconfirmed delivery whose 23-hour safe replay window elapsed. Never replay automatically with an expired Resend idempotency key.';

-- Provider error bodies are untrusted and can echo an address or credential.
-- Keep only the few fields needed for delivery operations, redact them again in
-- SQL (even if a rolling worker is old), and bound their size.
create or replace function public.norva_redact_billing_receipt_text(p_value text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $function$
  select left(
    regexp_replace(
      regexp_replace(
        p_value,
        '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}',
        '[email]',
        'gi'
      ),
      '(re_|whsec_)[A-Za-z0-9_-]{12,}',
      '[credential]',
      'g'
    ),
    500
  )
$function$;

create or replace function public.norva_safe_billing_receipt_provider_response(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $function$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', nullif(left(btrim(coalesce(p_value->>'id', '')), 200), ''),
    'name', public.norva_redact_billing_receipt_text(
      nullif(coalesce(p_value->>'name', p_value->>'type', p_value->>'code'), '')
    ),
    'message', public.norva_redact_billing_receipt_text(
      nullif(coalesce(p_value->>'message', p_value->>'error', p_value->>'response'), '')
    ),
    'status_code', case
      when coalesce(p_value->>'status_code', p_value->>'statusCode', '') ~ '^[0-9]{3}$'
        then (coalesce(p_value->>'status_code', p_value->>'statusCode'))::integer
      else null
    end
  ))
$function$;

revoke all on function public.norva_redact_billing_receipt_text(text),
  public.norva_safe_billing_receipt_provider_response(jsonb)
  from public, anon, authenticated;

update public.cloud_billing_receipt_outbox o
set resend_response = public.norva_safe_billing_receipt_provider_response(
      coalesce(o.resend_response, '{}'::jsonb)
    ),
    last_error = public.norva_redact_billing_receipt_text(o.last_error)
where o.resend_response is not null or o.last_error is not null;

create or replace function public.norva_fill_billing_receipt_pseudonym()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user_id uuid;
  v_pseudonym text;
begin
  select l.user_id, l.user_pseudonym
    into v_user_id, v_pseudonym
  from public.cloud_billing_ledger l
  where l.pi_id = new.ledger_pi_id;
  if v_pseudonym is null then
    raise exception 'billing receipt ledger identity is missing';
  end if;
  new.user_id := v_user_id;
  new.user_pseudonym := v_pseudonym;
  return new;
end
$function$;

revoke all on function public.norva_fill_billing_receipt_pseudonym()
  from public, anon, authenticated;
drop trigger if exists norva_fill_billing_receipt_pseudonym_trg
  on public.cloud_billing_receipt_outbox;
create trigger norva_fill_billing_receipt_pseudonym_trg
before insert or update of ledger_pi_id on public.cloud_billing_receipt_outbox
for each row execute function public.norva_fill_billing_receipt_pseudonym();

-- Replace the rich prepare RPC so taxonomy is complete and cross-product-safe.
drop function if exists public.prepare_billing_receipt_delivery(
  text, uuid, text, text, text, text, text, jsonb
);
create function public.prepare_billing_receipt_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_request_from text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_reply_to text,
  p_request_tags jsonb
) returns table (
  recipient_email text,
  request_from text,
  request_subject text,
  request_html text,
  request_text text,
  request_reply_to text,
  request_tags jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if nullif(btrim(p_request_from), '') is null
     or nullif(btrim(p_request_subject), '') is null
     or nullif(btrim(p_request_html), '') is null
     or nullif(btrim(p_request_text), '') is null
     or nullif(btrim(p_request_reply_to), '') is null
     or p_request_reply_to !~* '^[^@[:space:]]+@[^@[:space:]]+$'
     or p_request_tags is distinct from jsonb_build_array(
       jsonb_build_object('name', 'app', 'value', 'norva'),
       jsonb_build_object('name', 'category', 'value', 'transactional'),
       jsonb_build_object('name', 'flow', 'value', 'payment_receipt')
     ) then
    raise exception 'complete, valid receipt request is required';
  end if;

  return query
  update public.cloud_billing_receipt_outbox o
  set request_from = case when o.prepared_at is null then btrim(p_request_from) else o.request_from end,
      request_subject = case when o.prepared_at is null then p_request_subject else o.request_subject end,
      request_html = case when o.prepared_at is null then p_request_html else o.request_html end,
      request_text = case when o.prepared_at is null then p_request_text else o.request_text end,
      request_reply_to = case when o.prepared_at is null then lower(btrim(p_request_reply_to)) else o.request_reply_to end,
      request_tags = case when o.prepared_at is null then p_request_tags else o.request_tags end,
      prepared_at = coalesce(o.prepared_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  returning o.recipient_email, o.request_from, o.request_subject, o.request_html,
            o.request_text, o.request_reply_to, o.request_tags;
end
$function$;

revoke all on function public.prepare_billing_receipt_delivery(
  text, uuid, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.prepare_billing_receipt_delivery(
  text, uuid, text, text, text, text, text, jsonb
) to service_role;

create or replace function public.mark_billing_receipt_delivery_network_started(
  p_delivery_key text,
  p_lease_token uuid
) returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_started_at timestamptz;
begin
  update public.cloud_billing_receipt_outbox o
  set idempotency_started_at = coalesce(o.idempotency_started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
    and (o.idempotency_started_at is null
      or o.idempotency_started_at > clock_timestamp() - interval '23 hours')
  returning o.idempotency_started_at into v_started_at;
  return v_started_at;
end
$function$;

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
  v_max_attempts integer := greatest(1, least(coalesce(p_max_attempts, 12), 30));
begin
  -- A request that may have reached Resend is safe to replay only while its
  -- provider idempotency record is guaranteed to exist.
  update public.cloud_billing_receipt_outbox o
  set exhausted_at = v_now,
      quarantined_at = v_now,
      delivery_uncertain = true,
      lease_token = null,
      lease_expires_at = null,
      last_error = 'idempotency_window_expired_unconfirmed',
      updated_at = v_now
  where o.sent_at is null
    and o.exhausted_at is null
    and o.idempotency_started_at <= v_now - interval '23 hours'
    and (o.lease_expires_at is null or o.lease_expires_at <= v_now);

  -- Only explicit, acknowledged failures consume the nominal retry budget.
  update public.cloud_billing_receipt_outbox o
  set exhausted_at = v_now,
      last_error = coalesce(o.last_error, 'delivery_exhausted_maximum_recorded_failures'),
      updated_at = v_now
  where o.sent_at is null
    and o.exhausted_at is null
    and o.lease_token is null
    and not o.delivery_uncertain
    and o.attempt_count >= v_max_attempts;

  return query
  with due as (
    select o.delivery_key
    from public.cloud_billing_receipt_outbox o
    where o.sent_at is null
      and o.exhausted_at is null
      and o.next_attempt_at <= v_now
      and (o.idempotency_started_at is null
        or o.idempotency_started_at > v_now - interval '23 hours')
      and (
        (o.lease_token is null and (o.attempt_count < v_max_attempts or o.delivery_uncertain))
        or (o.lease_token is not null and o.lease_expires_at <= v_now)
      )
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
      resend_response = public.norva_safe_billing_receipt_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_http_status = p_http_status,
      last_error = null,
      sent_at = clock_timestamp(),
      exhausted_at = null,
      quarantined_at = null,
      delivery_uncertain = false,
      lease_token = null,
      lease_expires_at = null,
      recipient_email = null,
      first_name = null,
      request_subject = null,
      request_html = null,
      request_text = null,
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null;
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create or replace function public.fail_billing_receipt_delivery_v2(
  p_delivery_key text,
  p_lease_token uuid,
  p_http_status integer,
  p_error text,
  p_response jsonb default '{}'::jsonb,
  p_retryable boolean default true,
  p_retry_after_seconds integer default null,
  p_max_attempts integer default 12,
  p_ambiguous boolean default false
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_attempt integer;
  v_was_uncertain boolean;
  v_terminal boolean;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count, o.delivery_uncertain
    into v_attempt, v_was_uncertain
  from public.cloud_billing_receipt_outbox o
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  for update;
  if not found then return 'lease_lost'; end if;

  v_was_uncertain := coalesce(v_was_uncertain, false) or coalesce(p_ambiguous, false);
  v_terminal := not coalesce(p_retryable, false)
    or (not v_was_uncertain
      and v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30)));
  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );

  update public.cloud_billing_receipt_outbox o
  set resend_response = public.norva_safe_billing_receipt_provider_response(
        coalesce(p_response, '{}'::jsonb)
      ),
      last_http_status = p_http_status,
      last_error = public.norva_redact_billing_receipt_text(
        coalesce(nullif(p_error, ''), 'delivery_failed')
      ),
      delivery_uncertain = v_was_uncertain,
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

create or replace function public.prune_billing_receipt_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted integer;
begin
  delete from public.cloud_billing_receipt_outbox o
  where (o.sent_at is not null and o.sent_at < now() - interval '90 days')
     or (o.exhausted_at is not null and o.exhausted_at < now() - interval '30 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

revoke all on function public.mark_billing_receipt_delivery_network_started(text, uuid),
  public.claim_billing_receipt_deliveries(integer, integer, integer),
  public.complete_billing_receipt_delivery(text, uuid, text, integer, jsonb),
  public.fail_billing_receipt_delivery_v2(text, uuid, integer, text, jsonb, boolean, integer, integer, boolean),
  public.prune_billing_receipt_outbox()
  from public, anon, authenticated;
grant execute on function public.mark_billing_receipt_delivery_network_started(text, uuid),
  public.claim_billing_receipt_deliveries(integer, integer, integer),
  public.complete_billing_receipt_delivery(text, uuid, text, integer, jsonb),
  public.fail_billing_receipt_delivery_v2(text, uuid, integer, text, jsonb, boolean, integer, integer, boolean),
  public.prune_billing_receipt_outbox()
  to service_role;

do $cron_setup$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule(
      'norva-billing-receipt-prune',
      '10 4 * * *',
      'select public.prune_billing_receipt_outbox();'
    );
  end if;
exception when undefined_table or invalid_schema_name or insufficient_privilege then
  raise notice 'billing receipt prune cron unavailable; schedule it externally';
end
$cron_setup$;

notify pgrst, 'reload schema';
