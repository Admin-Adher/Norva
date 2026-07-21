-- Account-deletion email delivery safety after the base outbox migration.
-- Resend idempotency keys expire after 24 hours, so a delivery whose provider
-- outcome may be ambiguous must never be replayed beyond a conservative 23-hour
-- window. Expired rows are quarantined for explicit operator review.

alter table public.cloud_account_deletion_email_outbox
  add column if not exists transport_started_at timestamptz;

comment on column public.cloud_account_deletion_email_outbox.transport_started_at is
  'Start of the Resend idempotency safety window. Rows older than 23 hours are quarantined and require manual reconciliation.';

create index if not exists cloud_account_deletion_email_transport_window_idx
  on public.cloud_account_deletion_email_outbox (transport_started_at)
  where state in ('ready', 'processing');

-- Older workers persisted the provider response verbatim. It is not needed for
-- reconciliation (status, provider id and bounded error are separate columns),
-- so erase it once before the allow-listed worker takes over.
update public.cloud_account_deletion_email_outbox
set resend_response = '{}'::jsonb,
    updated_at = clock_timestamp()
where resend_response is not null
  and resend_response <> '{}'::jsonb;

-- Conservatively anchor pre-migration attempts at deletion confirmation. This
-- prevents an old ambiguous lease from receiving a fresh 24-hour window merely
-- because this hardening migration was installed later.
update public.cloud_account_deletion_email_outbox o
set transport_started_at = coalesce(o.transport_started_at, o.deletion_confirmed_at, o.updated_at),
    updated_at = clock_timestamp()
where o.attempt_count > 0
  and o.transport_started_at is null;

update public.cloud_account_deletion_email_outbox o
set state = 'dead_letter',
    last_error = 'idempotency_window_expired_manual_review',
    resend_response = '{}'::jsonb,
    exhausted_at = clock_timestamp(),
    lease_token = null,
    lease_expires_at = null,
    updated_at = clock_timestamp()
where o.state in ('ready', 'processing')
  and o.transport_started_at <= clock_timestamp() - interval '23 hours';

create or replace function public.claim_account_deletion_email_deliveries(
  p_batch integer default 5,
  p_lease_seconds integer default 90,
  p_max_attempts integer default 12
) returns table (
  delivery_key text,
  lease_token uuid,
  recipient_email text,
  request_from text,
  request_reply_to text,
  request_subject text,
  request_html text,
  request_text text,
  request_tags jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  -- A previously attempted row outside Resend's idempotency lifetime is not a
  -- retry candidate. Preserve it as a manual-review quarantine instead.
  update public.cloud_account_deletion_email_outbox o
  set state = 'dead_letter',
      last_error = 'idempotency_window_expired_manual_review',
      resend_response = '{}'::jsonb,
      exhausted_at = v_now,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.state in ('ready', 'processing')
    and o.transport_started_at <= v_now - interval '23 hours';

  return query
  with due as (
    select o.account_key
    from public.cloud_account_deletion_email_outbox o
    where o.deletion_confirmed_at is not null
      and o.next_attempt_at <= v_now
      and (o.transport_started_at is null
           or o.transport_started_at > v_now - interval '23 hours')
      and (
        (o.state = 'ready'
          and o.attempt_count < greatest(1, least(coalesce(p_max_attempts, 12), 30)))
        or (o.state = 'processing' and o.lease_expires_at <= v_now)
      )
    order by o.next_attempt_at, o.created_at
    limit greatest(1, least(coalesce(p_batch, 5), 25))
    for update skip locked
  ), claimed as (
    update public.cloud_account_deletion_email_outbox o
    set state = 'processing',
        lease_token = gen_random_uuid(),
        lease_expires_at = v_now + make_interval(
          secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))
        ),
        transport_started_at = coalesce(o.transport_started_at, v_now),
        attempt_count = o.attempt_count + 1,
        updated_at = v_now
    from due
    where o.account_key = due.account_key
    returning o.*
  )
  select c.delivery_key, c.lease_token, c.recipient_email, c.request_from,
         c.request_reply_to, c.request_subject, c.request_html, c.request_text,
         c.request_tags, c.attempt_count
  from claimed c
  order by c.next_attempt_at, c.created_at;
end
$function$;

create or replace function public.fail_account_deletion_email_delivery(
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
  v_transport_started_at timestamptz;
  v_terminal boolean;
  v_idempotency_window_terminal boolean := false;
  v_delay_seconds integer;
  v_changed integer;
begin
  select o.attempt_count, o.transport_started_at
  into v_attempt, v_transport_started_at
  from public.cloud_account_deletion_email_outbox o
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token
  for update;
  if not found then return 'lease_lost'; end if;

  v_delay_seconds := greatest(
    coalesce(p_retry_after_seconds, 0),
    least(21600, round(30 * power(2::numeric, greatest(v_attempt - 1, 0)))::integer)
      + floor(random() * 16)::integer
  );
  v_idempotency_window_terminal := v_transport_started_at is not null
    and v_now + make_interval(secs => v_delay_seconds)
      >= v_transport_started_at + interval '23 hours';
  v_terminal := not coalesce(p_retryable, false)
    or v_attempt >= greatest(1, least(coalesce(p_max_attempts, 12), 30))
    or v_idempotency_window_terminal;

  update public.cloud_account_deletion_email_outbox o
  set state = case when v_terminal then 'dead_letter' else 'ready' end,
      resend_response = coalesce(p_response, '{}'::jsonb),
      last_http_status = p_http_status,
      last_error = case
        when v_idempotency_window_terminal then 'idempotency_window_expired_manual_review'
        else left(coalesce(nullif(p_error, ''), 'delivery_failed'), 1000)
      end,
      exhausted_at = case when v_terminal then v_now else null end,
      next_attempt_at = case when v_terminal then o.next_attempt_at
                             else v_now + make_interval(secs => v_delay_seconds) end,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where o.delivery_key = p_delivery_key
    and o.state = 'processing'
    and o.lease_token = p_lease_token;
  get diagnostics v_changed = row_count;
  if v_changed <> 1 then return 'lease_lost'; end if;
  return case when v_terminal then 'dead_letter' else 'retry_scheduled' end;
end
$function$;

revoke all on function public.claim_account_deletion_email_deliveries(integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.fail_account_deletion_email_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_account_deletion_email_deliveries(integer, integer, integer)
  to service_role;
grant execute on function public.fail_account_deletion_email_delivery(text, uuid, integer, text, jsonb, boolean, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
