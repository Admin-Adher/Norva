-- RevenueCat/store billing email producers.
--
-- RevenueCat already journals authoritative paid transactions into the shared
-- billing ledger, but the payment-confirmation outbox historically accepted
-- only provider='revolut'. Extend that SAME ledger trigger to the store rails;
-- the existing deterministic ledger key, durable lease and Resend idempotency
-- window continue to own exactly-once delivery.
--
-- RevenueCat represents a refund as CANCELLATION with
-- cancel_reason=CUSTOMER_SUPPORT. That event does not prove auto-renewal was
-- disabled, so it must create a refund confirmation without also creating a
-- cancellation confirmation. EXPIRATION remains the access-revocation signal.

create or replace function public.norva_enqueue_billing_receipt()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $function$
declare
  v_provider text := lower(btrim(coalesce(new.provider, '')));
  v_email text;
  v_first_name text;
  v_plan_code text;
  v_plan_label text;
  v_period_end timestamptz;
  v_discount_pct integer := 0;
begin
  if v_provider not in (
       'revolut', 'revenuecat', 'google_play', 'apple_app_store', 'web', 'stripe'
     )
     or lower(coalesce(new.status, '')) <> 'captured'
     or new.user_id is null
     or new.amount is null
     or new.amount <= 0 then
    return new;
  end if;

  -- Internal/pilot accounts may exercise a real sandbox or store webhook, but
  -- are deliberately excluded from every customer lifecycle communication.
  if exists (
    select 1 from public.admin_internal_accounts a where a.user_id = new.user_id
  ) then
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
  where u.id = new.user_id
    and u.deleted_at is null;

  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    -- Money remains authoritative even when the current account address cannot
    -- be used. Never roll back a provider payment because email is unavailable.
    return new;
  end if;

  -- Avoid a known permanent bounce/complaint/provider suppression locally. The
  -- underlying payment still remains in the immutable financial journal.
  if exists (
    select 1
    from public.cloud_email_suppressions s
    where s.email = v_email and s.active
  ) then
    return new;
  end if;

  if v_first_name is not null then
    v_first_name := split_part(v_first_name, ' ', 1);
  end if;

  v_plan_code := case
    when new.plan_code in ('plus', 'family') then new.plan_code
    else null
  end;
  v_period_end := new.billing_period_end;
  if v_plan_code is null or v_period_end is null then
    select coalesce(v_plan_code,
             case when p.plan_code in ('plus', 'family') then p.plan_code end),
           coalesce(v_period_end, p.current_period_end)
      into v_plan_code, v_period_end
    from public.cloud_entitlement_projection p
    where p.user_id = new.user_id;
  end if;

  -- Revolut promotions are Norva-owned. Store discounts and taxes are already
  -- reflected in RevenueCat's authoritative paid amount and must not be guessed.
  if v_provider = 'revolut' then
    select coalesce(a.discount_pct, 0) into v_discount_pct
    from public.cloud_revolut_billing_attempts a
    where a.order_id = new.order_id
    limit 1;
  end if;
  v_discount_pct := coalesce(v_discount_pct, 0);
  v_plan_label := case when v_plan_code = 'family' then 'Norva Family' else 'Norva' end
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
    v_period_end
  ) on conflict (ledger_pi_id) do nothing;

  return new;
end
$function$;

revoke all on function public.norva_enqueue_billing_receipt()
  from public, anon, authenticated;

comment on function public.norva_enqueue_billing_receipt() is
  'Exactly-once payment-confirmation producer for authoritative captured Revolut and RevenueCat/store ledger rows; excludes internal and suppressed recipients.';
comment on table public.cloud_billing_receipt_outbox is
  'Service-only transactional outbox for payment confirmations generated from authoritative captured cross-rail ledger rows.';

-- Replace the lifecycle normalization trigger so a store refund produces one
-- refund confirmation, not both refund and cancellation confirmations.
create or replace function public.norva_capture_lifecycle_billing_intent()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_source_id text := coalesce(nullif(btrim(new.provider_event_id), ''), new.id::text);
  v_raw_type text := upper(btrim(new.event_type));
  v_type text;
  v_payload jsonb := '{}'::jsonb;
  v_previous_status text := lower(coalesce(new.payload #>> '{_norva,previous_status}', ''));
  v_previous_plan text := lower(coalesce(new.payload #>> '{_norva,previous_plan}', ''));
  v_next_plan text := lower(coalesce(new.payload #>> '{_norva,next_plan}', ''));
  v_cancel_reason text := upper(btrim(coalesce(new.payload ->> 'cancel_reason', '')));
  v_refund_local_raw text;
  v_refund_usd_raw text;
  v_refund_cents integer;
  v_currency text;
begin
  -- Native Norva/Revolut events already carry their normalized contract.
  v_type := case v_raw_type
    when 'CANCELLATION_CONFIRMED' then 'cancellation_confirmed'
    when 'SUBSCRIPTION_RESUMED' then 'subscription_resumed'
    when 'PLAN_CHANGE_SCHEDULED' then 'plan_change_scheduled'
    when 'PLAN_CHANGE_APPLIED' then 'plan_change_applied'
    when 'PAYMENT_RECOVERED' then 'payment_recovered'
    when 'ACCESS_EXPIRED' then 'access_expired'
    when 'REFUND_CONFIRMED' then 'refund_confirmed'
    else null
  end;
  if v_type is not null then
    v_payload := case v_type
      when 'cancellation_confirmed' then jsonb_strip_nulls(jsonb_build_object(
        'effective_at', new.payload ->> 'effective_at'))
      when 'subscription_resumed' then jsonb_strip_nulls(jsonb_build_object(
        'renews_at', new.payload ->> 'renews_at'))
      when 'plan_change_scheduled' then jsonb_strip_nulls(jsonb_build_object(
        'plan_label', new.payload ->> 'plan_label',
        'effective_at', new.payload ->> 'effective_at'))
      when 'plan_change_applied' then jsonb_strip_nulls(jsonb_build_object(
        'plan_label', new.payload ->> 'plan_label'))
      when 'payment_recovered' then jsonb_strip_nulls(jsonb_build_object(
        'next_billing_at', new.payload ->> 'next_billing_at'))
      when 'refund_confirmed' then jsonb_strip_nulls(jsonb_build_object(
        'amount_cents', new.payload -> 'amount_cents',
        'currency', new.payload ->> 'currency',
        'reference', new.payload ->> 'reference'))
      else '{}'::jsonb
    end;
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, lower(new.provider), v_source_id, v_type, v_payload
    );
    return new;
  end if;

  if new.provider <> 'revenuecat' then return new; end if;

  -- RevenueCat's documented refund signal. The amount is optional in the email
  -- but, when present, it must be a bounded negative provider value converted
  -- to positive cents. No transaction/provider id is copied into the payload.
  if v_raw_type = 'CANCELLATION' and v_cancel_reason = 'CUSTOMER_SUPPORT' then
    v_currency := upper(btrim(coalesce(new.payload ->> 'currency', '')));
    if v_currency !~ '^[A-Z]{3}$' then v_currency := null; end if;
    v_refund_local_raw := new.payload ->> 'price_in_purchased_currency';
    v_refund_usd_raw := new.payload ->> 'price';
    if v_currency is not null
       and coalesce(v_refund_local_raw, '') ~ '^-?[0-9]+([.][0-9]+)?$'
       and v_refund_local_raw::numeric < 0 then
      v_refund_cents := round(abs(v_refund_local_raw::numeric) * 100)::integer;
    elsif coalesce(v_refund_usd_raw, '') ~ '^-?[0-9]+([.][0-9]+)?$'
       and v_refund_usd_raw::numeric < 0 then
      v_refund_cents := round(abs(v_refund_usd_raw::numeric) * 100)::integer;
      v_currency := 'USD';
    end if;
    if v_refund_cents not between 1 and 9999999 then v_refund_cents := null; end if;
    if v_refund_cents is null then v_currency := null; end if;
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'amount_cents', v_refund_cents,
      'currency', v_currency
    ));
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'refund_confirmed', v_payload
    );
    return new;
  end if;

  if v_raw_type in ('CANCELLATION','SUBSCRIPTION_PAUSED') then
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'effective_at', coalesce(
        new.payload #>> '{_norva,current_period_end}',
        new.payload ->> 'expiration_at_ms'
      )
    ));
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'cancellation_confirmed', v_payload
    );
  elsif v_raw_type = 'UNCANCELLATION' then
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'renews_at', coalesce(
        new.payload #>> '{_norva,current_period_end}',
        new.payload ->> 'expiration_at_ms'
      )
    ));
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'subscription_resumed', v_payload
    );
  elsif v_raw_type = 'PRODUCT_CHANGE' then
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'plan_label', coalesce(new.payload ->> 'new_product_id', 'your new Norva plan'),
      'effective_at', new.payload ->> 'expiration_at_ms'
    ));
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'plan_change_scheduled', v_payload
    );
  elsif v_raw_type = 'EXPIRATION' then
    perform public.norva_insert_lifecycle_billing_intent(
      new.user_id, 'revenuecat', v_source_id, 'access_expired', '{}'::jsonb
    );
  elsif v_raw_type in ('RENEWAL','INITIAL_PURCHASE','REFUND_REVERSED') then
    if v_previous_status in ('past_due','grace') then
      v_payload := jsonb_strip_nulls(jsonb_build_object(
        'next_billing_at', new.payload #>> '{_norva,current_period_end}'
      ));
      perform public.norva_insert_lifecycle_billing_intent(
        new.user_id, 'revenuecat', v_source_id, 'payment_recovered', v_payload
      );
    end if;
    if v_previous_status in ('active','cancelled_at_period_end')
       and v_previous_plan <> '' and v_next_plan <> '' and v_previous_plan <> v_next_plan then
      perform public.norva_insert_lifecycle_billing_intent(
        new.user_id, 'revenuecat', v_source_id, 'plan_change_applied',
        jsonb_build_object('plan_label', v_next_plan)
      );
    end if;
  end if;
  return new;
end
$function$;

revoke all on function public.norva_capture_lifecycle_billing_intent()
  from public, anon, authenticated;

comment on function public.norva_capture_lifecycle_billing_intent() is
  'Normalizes immutable billing events into exactly-once lifecycle email intents; RevenueCat CUSTOMER_SUPPORT cancellations become refund confirmations only.';

notify pgrst, 'reload schema';
