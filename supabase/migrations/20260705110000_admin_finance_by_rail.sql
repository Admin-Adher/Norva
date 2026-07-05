-- Cross-rail finance, part 2: teach admin_finance() to READ every rail's money.
--
-- Companion to 20260705100000_cross_rail_finance.sql (which added the columns).
-- Before this, every money aggregate in admin_finance() read Stancer-only tables,
-- so a google_play / apple_app_store subscriber counted as $0 MRR and never showed
-- up in "collected" or "renewals". Now:
--
--   * amount/period come from coalesce(cloud_stancer_customers.*, projection.*) —
--     Stancer keeps its own mapping, mobile rails read the price/cadence the
--     RevenueCat webhook stamps onto the projection (mrr_cents / bill_period).
--   * new `by_rail` block: MRR + subscriber count per provider.
--   * new `collected_by_rail` block: cash collected 30d per provider.
--   * recent_payments now carries `provider` (the payments ledger is cross-rail).
--   * renewals_7d switched from INNER JOIN cloud_stancer_customers (which silently
--     dropped mobile) to LEFT JOIN + coalesce, so mobile renewals are counted.
--
-- Everything else is a verbatim re-emission of admin_finance() from
-- 20260703240000_admin_finance_p0.sql.

create or replace function public.admin_finance()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  with paying as (
    select p.user_id, p.status, coalesce(p.provider, 'stancer') as provider, coalesce(p.plan_code, 'plus') as plan_code,
           coalesce(c.period, p.bill_period) as period,
           coalesce(c.amount_cents, p.mrr_cents) as amount_cents,
           case when coalesce(c.amount_cents, p.mrr_cents) is null then null
                when coalesce(c.period, p.bill_period) = 'annual' then round(coalesce(c.amount_cents, p.mrr_cents) / 12.0)
                else coalesce(c.amount_cents, p.mrr_cents) end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status in ('active', 'past_due', 'grace', 'cancelled_at_period_end')
  ), trialers as (
    select p.user_id, coalesce(p.plan_code, 'plus') as plan_code, coalesce(p.provider, 'stancer') as provider, p.trial_ends_at,
           coalesce(c.period, p.bill_period) as period,
           coalesce(c.amount_cents, p.mrr_cents) as amount_cents,
           case when coalesce(c.amount_cents, p.mrr_cents) is null then null
                when coalesce(c.period, p.bill_period) = 'annual' then round(coalesce(c.amount_cents, p.mrr_cents) / 12.0)
                else coalesce(c.amount_cents, p.mrr_cents) end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status = 'trialing'
  )
  select jsonb_build_object(
    'refreshed_at', now(),
    'users_total', (select count(*) from auth.users),
    'mrr_cents', (select coalesce(sum(mrr_cents), 0) from paying),
    'arr_cents', (select coalesce(sum(mrr_cents), 0) * 12 from paying),
    'mrr_trial_cents', (select coalesce(sum(mrr_cents), 0) from trialers),
    'mrr_unknown_n', (select count(*) from paying where mrr_cents is null),
    'counts', jsonb_build_object(
      'trialing', (select count(*) from trialers),
      'active', (select count(*) from paying where status = 'active'),
      'past_due', (select count(*) from paying where status in ('past_due', 'grace')),
      'cancel_pending', (select count(*) from paying where status = 'cancelled_at_period_end'),
      'expired', (select count(*) from cloud_entitlement_projection where status = 'expired')
    ),
    'by_plan', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select plan_code, coalesce(period, '—') as period, coalesce(provider, '—') as provider,
             count(*)::int as n, coalesce(sum(mrr_cents), 0)::bigint as mrr_cents
      from paying group by 1, 2, 3
    ) t),
    'by_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select provider,
             count(*)::int as n,
             coalesce(sum(mrr_cents), 0)::bigint as mrr_cents,
             count(*) filter (where mrr_cents is null)::int as unknown_n
      from paying group by 1
    ) t),
    'dunning', (select coalesce(jsonb_agg(row_to_json(t) order by t.stage), '[]'::jsonb) from (
      select coalesce(dunning_stage, 0) as stage, count(*)::int as n
      from cloud_entitlement_projection where status in ('past_due', 'grace') group by 1
    ) t),
    'collected_30d_cents', (select coalesce(sum(amount), 0) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'),
    'collected_30d_n', (select count(*) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'),
    'collected_by_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.cents desc), '[]'::jsonb) from (
      select coalesce(provider, 'stancer') as provider, count(*)::int as n, coalesce(sum(amount), 0)::bigint as cents
      from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
      group by 1
    ) t),
    'upcoming', jsonb_build_object(
      'trial_charges_48h_n', (select count(*) from trialers where trial_ends_at < now() + interval '48 hours'),
      'trial_charges_48h_cents', (select coalesce(sum(amount_cents), 0) from trialers where trial_ends_at < now() + interval '48 hours'),
      'renewals_7d_n', (select count(*) from cloud_entitlement_projection p2
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days'),
      'renewals_7d_cents', (select coalesce(sum(coalesce(c2.amount_cents, p2.mrr_cents)), 0)
        from cloud_entitlement_projection p2
        left join cloud_stancer_customers c2 on c2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days')
    ),
    'funnel_30d', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select stage, sum(users)::int as users from public.norva_funnel_daily
      where day > (now() - interval '30 days')::date group by stage
    ) t),
    'conversions_7d', (select count(distinct user_id) from cloud_stancer_payments
      where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'),
    'cancel_reasons', (select coalesce(jsonb_agg(row_to_json(t) order by t.n desc), '[]'::jsonb) from (
      select reason, count(*)::int as n from cloud_cancel_feedback where action = 'cancelled' group by 1
    ) t),
    'cancels_total', (select count(*) from cloud_cancel_feedback where action = 'cancelled'),
    'saves_total', (select count(*) from cloud_cancel_feedback where action = 'saved'),
    'discounts_pending', (select count(*) from cloud_stancer_customers where discount_next_pct is not null),
    'recent_payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select sp.pi_id, sp.user_id, u.email::text as email, sp.kind, sp.amount, sp.currency,
             coalesce(sp.provider, 'stancer') as provider,
             sp.status, coalesce(sp.updated_at, sp.created_at) as at
      from cloud_stancer_payments sp left join auth.users u on u.id = sp.user_id
      order by coalesce(sp.updated_at, sp.created_at) desc limit 50
    ) t)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_finance() from public, anon;
grant execute on function public.admin_finance() to authenticated;

-- admin_user_billing: expose the projection's rail price/cadence so the fiche can
-- render a mobile (Play/Apple) subscriber whose money lives on the projection, not
-- in cloud_stancer_customers. payments already carry provider (cross-rail ledger).
create or replace function public.admin_user_billing(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'projection', (select to_jsonb(t) from (
      select status, provider, plan_code, trial_ends_at, trial_consumed_at, current_period_end,
             dunning_stage, dunning_last_at, last_event_at, mrr_cents, bill_period,
             welcome_email_at, trial_reminder_email_at, winback_email_at
      from cloud_entitlement_projection where user_id = p_user_id
    ) t),
    'mapping', (select to_jsonb(t) from (
      select plan, period, amount_cents, card_last4, card_exp, discount_next_pct, save_offer_used_at
      from cloud_stancer_customers where user_id = p_user_id
    ) t),
    'payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select pi_id, kind, amount, currency, coalesce(provider, 'stancer') as provider, status, created_at, updated_at
      from cloud_stancer_payments where user_id = p_user_id
      order by coalesce(updated_at, created_at) desc limit 100
    ) t),
    'cancel_feedback', (select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb) from (
      select reason, action, offer, status_at, created_at
      from cloud_cancel_feedback where user_id = p_user_id
    ) t)
  );
end; $$;
revoke all on function public.admin_user_billing(uuid) from public, anon;
grant execute on function public.admin_user_billing(uuid) to authenticated;
