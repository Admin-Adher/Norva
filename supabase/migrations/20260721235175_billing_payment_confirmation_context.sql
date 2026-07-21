-- Customer-facing payment confirmations need stable transaction context, not a
-- legal "receipt"/"invoice" claim.  Expose the already-authoritative ledger
-- cadence and the transactionally-created outbox timestamp to the delivery
-- worker.  No provider payment identifier is returned to the email renderer.

drop function if exists public.claim_billing_receipt_deliveries(integer, integer, integer);

create function public.claim_billing_receipt_deliveries(
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
  billing_period text,
  confirmed_at timestamptz,
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
         c.plan_label, c.amount_cents, c.currency,
         case when l.bill_period in ('monthly', 'annual') then l.bill_period else null end,
         c.created_at, c.period_end, c.attempt_count
  from claimed c
  left join public.cloud_billing_ledger l on l.pi_id = c.ledger_pi_id
  order by c.next_attempt_at, c.created_at;
end
$function$;

revoke all on function public.claim_billing_receipt_deliveries(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_billing_receipt_deliveries(integer, integer, integer)
  to service_role;
