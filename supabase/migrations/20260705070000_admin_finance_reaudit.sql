-- Admin CRM re-audit (2026-07-05) — admin_finance correctness + forward-looking indexes (Lot D).
-- Findings #27, #28 (correctness) and #14 (scalability).
--
-- On #14: admin_finance() is a live aggregate granted to authenticated, run on each Finance open.
-- Current data is tiny (3 users / 6 payments / 96 watch rows) so it runs in microseconds — nowhere
-- near the 8s statement_timeout. Rather than fold it into the snapshot cache now (which would make
-- the finance figures stale and add cron/frontend plumbing for a non-existent load), we add the
-- indexes that will serve its heaviest scans as volume grows and keep it live. If the Finance page
-- ever approaches the timeout, the documented follow-up is to add a `finance` jsonb blob to
-- admin_dashboard_cache refreshed by the existing snapshot cron (see docs/ADMIN-DASHBOARD.md).

-- Indexes for the recent-payments expression sort and the captured-payment 30d/7d scans.
create index if not exists idx_stancer_payments_recent
  on public.cloud_stancer_payments ((coalesce(updated_at, created_at)) desc);
create index if not exists idx_stancer_payments_captured
  on public.cloud_stancer_payments (updated_at desc) where status = 'captured';

-- admin_finance() — full body reproduced from live with three surgical changes:
--   #27: 'active' count excludes provider='system' (comped) to match the cockpit's billing_active,
--        so the two "Actifs payants" headline numbers agree.
--   #28: upcoming counters gain a `> now()` floor — an already-past trial charge or renewal must not
--        be counted (or summed) as "à venir".
create or replace function public.admin_finance()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  with internal as (
    select user_id from public.admin_internal_accounts
  ), paying as (
    select p.user_id, p.status, p.provider, coalesce(p.plan_code, 'plus') as plan_code,
           c.period, c.amount_cents,
           case when c.amount_cents is null then null
                when c.period = 'annual' then round(c.amount_cents / 12.0)
                else c.amount_cents end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status in ('active', 'past_due', 'grace', 'cancelled_at_period_end')
      and p.user_id not in (select user_id from internal)
  ), trialers as (
    select p.user_id, coalesce(p.plan_code, 'plus') as plan_code, p.provider, p.trial_ends_at,
           c.period, c.amount_cents,
           case when c.amount_cents is null then null
                when c.period = 'annual' then round(c.amount_cents / 12.0)
                else c.amount_cents end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status = 'trialing'
      and p.user_id not in (select user_id from internal)
  )
  select jsonb_build_object(
    'refreshed_at', now(),
    'users_total', (select count(*) from auth.users where id not in (select user_id from internal)),
    'internal_excluded', (select count(*) from internal),
    'mrr_cents', (select coalesce(sum(mrr_cents), 0) from paying),
    'arr_cents', (select coalesce(sum(mrr_cents), 0) * 12 from paying),
    'mrr_trial_cents', (select coalesce(sum(mrr_cents), 0) from trialers),
    'mrr_unknown_n', (select count(*) from paying where mrr_cents is null),
    'counts', jsonb_build_object(
      'trialing', (select count(*) from trialers),
      'active', (select count(*) from paying where status = 'active' and provider <> 'system'),
      'past_due', (select count(*) from paying where status in ('past_due', 'grace')),
      'cancel_pending', (select count(*) from paying where status = 'cancelled_at_period_end'),
      'expired', (select count(*) from cloud_entitlement_projection
                   where status = 'expired' and user_id not in (select user_id from internal))
    ),
    'by_plan', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select plan_code, coalesce(period, '—') as period, coalesce(provider, '—') as provider,
             count(*)::int as n, coalesce(sum(mrr_cents), 0)::bigint as mrr_cents
      from paying group by 1, 2, 3
    ) t),
    'dunning', (select coalesce(jsonb_agg(row_to_json(t) order by t.stage), '[]'::jsonb) from (
      select coalesce(dunning_stage, 0) as stage, count(*)::int as n
      from cloud_entitlement_projection
      where status in ('past_due', 'grace') and user_id not in (select user_id from internal)
      group by 1
    ) t),
    'collected_30d_cents', (select coalesce(sum(amount), 0) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    'collected_30d_n', (select count(*) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    'upcoming', jsonb_build_object(
      'trial_charges_48h_n', (select count(*) from trialers where trial_ends_at > now() and trial_ends_at < now() + interval '48 hours'),
      'trial_charges_48h_cents', (select coalesce(sum(amount_cents), 0) from trialers where trial_ends_at > now() and trial_ends_at < now() + interval '48 hours'),
      'renewals_7d_n', (select count(*) from cloud_entitlement_projection p2
        join cloud_stancer_customers c2 on c2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end > now() and p2.current_period_end < now() + interval '7 days'
          and p2.user_id not in (select user_id from internal)),
      'renewals_7d_cents', (select coalesce(sum(c2.amount_cents), 0) from cloud_entitlement_projection p2
        join cloud_stancer_customers c2 on c2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end > now() and p2.current_period_end < now() + interval '7 days'
          and p2.user_id not in (select user_id from internal))
    ),
    'funnel_30d', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select stage, sum(users)::int as users from public.norva_funnel_daily
      where day > (now() - interval '30 days')::date group by stage
    ) t),
    'conversions_7d', (select count(distinct user_id) from cloud_stancer_payments
      where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'
        and user_id not in (select user_id from internal)),
    'cancel_reasons', (select coalesce(jsonb_agg(row_to_json(t) order by t.n desc), '[]'::jsonb) from (
      select reason, count(*)::int as n from cloud_cancel_feedback
      where action = 'cancelled' and user_id not in (select user_id from internal) group by 1
    ) t),
    'cancels_total', (select count(*) from cloud_cancel_feedback
      where action = 'cancelled' and user_id not in (select user_id from internal)),
    'saves_total', (select count(*) from cloud_cancel_feedback
      where action = 'saved' and user_id not in (select user_id from internal)),
    'discounts_pending', (select count(*) from cloud_stancer_customers
      where discount_next_pct is not null and user_id not in (select user_id from internal)),
    'recent_payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select sp.pi_id, sp.user_id, u.email::text as email, sp.kind, sp.amount, sp.currency,
             sp.status, coalesce(sp.updated_at, sp.created_at) as at
      from cloud_stancer_payments sp left join auth.users u on u.id = sp.user_id
      where sp.user_id not in (select user_id from internal)
      order by coalesce(sp.updated_at, sp.created_at) desc limit 50
    ) t)
  ) into v;
  return v;
end; $function$;
-- CREATE OR REPLACE preserves the existing ACL, but re-assert it explicitly (defense in depth vs
-- the grant drift closed in 20260705050000): authenticated + service_role only, never anon.
revoke all on function public.admin_finance() from public, anon, authenticated;
grant execute on function public.admin_finance() to authenticated, service_role;
