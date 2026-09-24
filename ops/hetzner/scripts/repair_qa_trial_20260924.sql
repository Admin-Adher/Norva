-- One-time repair for the 2026-09-24 QA card check. The temporary hold was
-- authorised and then released, while the projection and billing mapping were
-- committed before the old partial-index conflict made event journaling fail.
-- Abort unless exactly one current, unfinalized order matches all three records.
do $repair$
declare
  v_order public.cloud_revolut_orders%rowtype;
  v_candidates integer;
  v_result text;
begin
  select count(*) into v_candidates
  from public.cloud_revolut_orders o
  join public.cloud_entitlement_projection p on p.user_id = o.user_id
  join public.cloud_revolut_customers c on c.user_id = o.user_id
  where o.created_at >= timestamptz '2026-09-24 06:20:00+00'
    and o.created_at < timestamptz '2026-09-24 06:30:00+00'
    and o.kind = 'trial_setup'
    and o.state = 'CANCELLED'
    and o.finalized_at is null
    and o.expired_at is null
    and o.superseded_at is null
    and p.status = 'trialing'
    and p.provider = 'revolut'
    and p.plan_code = o.plan
    and p.bill_period = o.period
    and p.trial_ends_at = o.first_charge_at
    and p.trial_consumed_at between o.created_at and o.updated_at
    and c.plan = o.plan
    and c.period = o.period
    and c.amount_cents = o.requested_amount_cents
    and c.revolut_customer_id is not null
    and c.payment_method_id is not null;
  if v_candidates <> 1 then
    raise exception 'QA trial repair requires exactly one verified candidate; found %', v_candidates;
  end if;

  select o.* into strict v_order
  from public.cloud_revolut_orders o
  join public.cloud_entitlement_projection p on p.user_id = o.user_id
  join public.cloud_revolut_customers c on c.user_id = o.user_id
  where o.created_at >= timestamptz '2026-09-24 06:20:00+00'
    and o.created_at < timestamptz '2026-09-24 06:30:00+00'
    and o.kind = 'trial_setup'
    and o.state = 'CANCELLED'
    and o.finalized_at is null
    and o.expired_at is null
    and o.superseded_at is null
    and p.status = 'trialing'
    and p.provider = 'revolut'
    and p.plan_code = o.plan
    and p.bill_period = o.period
    and p.trial_ends_at = o.first_charge_at
    and p.trial_consumed_at between o.created_at and o.updated_at
    and c.plan = o.plan
    and c.period = o.period
    and c.amount_cents = o.requested_amount_cents
    and c.revolut_customer_id is not null
    and c.payment_method_id is not null
  for update of o;

  insert into public.cloud_entitlement_events (
    user_id, provider, provider_event_id, event_type, payload, processed_at
  ) values (
    v_order.user_id,
    'revolut',
    'checkout:' || v_order.order_id || ':trial-started',
    'TRIAL_STARTED',
    jsonb_build_object(
      'order_id', v_order.order_id,
      'plan_label', v_order.plan,
      'bill_period', v_order.period,
      'first_charge_at', v_order.first_charge_at
    ),
    clock_timestamp()
  ) on conflict (provider, provider_event_id) do nothing;

  select public.finalize_revolut_checkout_order(
    v_order.order_id,
    v_order.user_id,
    'CANCELLED',
    jsonb_build_object(
      'result', 'trial_started',
      'kind', 'trial_setup',
      'remote_state', 'AUTHORISED',
      'hold_released', true,
      'source', 'verified_qa_repair_20260924',
      'first_charge_at', v_order.first_charge_at,
      'trial_ends_at', v_order.first_charge_at
    )
  ) into v_result;
  if v_result <> 'finalized' then
    raise exception 'QA trial repair finalization rejected: %', v_result;
  end if;
  raise notice 'QA trial event and order journal reconciled';
end
$repair$;
