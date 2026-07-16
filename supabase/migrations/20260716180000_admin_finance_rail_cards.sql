-- =============================================================================
-- Finance CRM : vue par rail complète (cartes Revolut·web vs Google Play·mobile).
-- =============================================================================
-- Le CRM affichait déjà MRR/encaissé par rail, mais 4 angles morts empêchaient de
-- comprendre d'où viennent (viendront) les chiffres :
--   1. by_rail ne comptait que les PAYANTS → les essais n'avaient pas de rail
--      (page vide avant la 1ʳᵉ conversion, aucun pipeline visible par canal) ;
--   2. conversions_7d global → impossible d'arbitrer web vs store ;
--   3. collected_by_rail ignorait les remboursements (kind='refund') ;
--   4. upcoming global → mélange les renouvellements prélevés par NOTRE cron
--      (Revolut) et ceux gérés par Google (Play).
--
-- Re-emission de admin_finance() (base : 20260716140000) avec :
--   • by_rail : + trialing_n + mrr_trial_cents (full outer join payants × essais) ;
--   • + conversions_by_rail (7 j, par provider — le ledger porte la colonne) ;
--   • collected_by_rail : + refunded_cents ;
--   • + upcoming_by_rail (essais <48 h + renouvellements <7 j, par provider) ;
--   • lectures du ledger basculées sur cloud_billing_ledger (nom réel post-20260716170000 ;
--     la vue de compat cloud_stancer_payments continue de marcher, mais le nouveau code
--     vise la table). Le net estimé après commission store se calcule côté front.
-- Purement additif : aucune clé existante ne change de définition.
-- =============================================================================

create or replace function public.admin_finance()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  with internal as (
    select user_id from public.admin_internal_accounts
  ), paying as (
    select p.user_id, p.status, coalesce(p.provider, 'stancer') as provider, coalesce(p.plan_code, 'plus') as plan_code,
           coalesce(rc.period, sc.period, p.bill_period) as period,
           coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) as amount_cents,
           case when coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) is null then null
                when coalesce(rc.period, sc.period, p.bill_period) = 'annual' then round(coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) / 12.0)
                else coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_revolut_customers rc on rc.user_id = p.user_id
    left join cloud_stancer_customers sc on sc.user_id = p.user_id
    where p.status in ('active', 'past_due', 'grace', 'cancelled_at_period_end')
      and p.user_id not in (select user_id from internal)
  ), trialers as (
    select p.user_id, coalesce(p.plan_code, 'plus') as plan_code, coalesce(p.provider, 'stancer') as provider, p.trial_ends_at,
           coalesce(rc.period, sc.period, p.bill_period) as period,
           coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) as amount_cents,
           case when coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) is null then null
                when coalesce(rc.period, sc.period, p.bill_period) = 'annual' then round(coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) / 12.0)
                else coalesce(rc.amount_cents, sc.amount_cents, p.mrr_cents) end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_revolut_customers rc on rc.user_id = p.user_id
    left join cloud_stancer_customers sc on sc.user_id = p.user_id
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
      'active', (select count(*) from paying where status = 'active'),
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
    -- Vue rail COMPLÈTE : payants ET essais (un rail avec 0 payant mais des essais en
    -- cours doit exister — c'est le pipeline de revenu du canal).
    'by_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select coalesce(pr.provider, tr.provider) as provider,
             coalesce(pr.n, 0)::int as n,
             coalesce(pr.mrr_cents, 0)::bigint as mrr_cents,
             coalesce(pr.unknown_n, 0)::int as unknown_n,
             coalesce(tr.n, 0)::int as trialing_n,
             coalesce(tr.mrr_cents, 0)::bigint as mrr_trial_cents
      from (select provider, count(*)::int as n,
                   coalesce(sum(mrr_cents), 0)::bigint as mrr_cents,
                   count(*) filter (where mrr_cents is null)::int as unknown_n
            from paying group by 1) pr
      full outer join (select provider, count(*)::int as n,
                              coalesce(sum(mrr_cents), 0)::bigint as mrr_cents
                       from trialers group by 1) tr on tr.provider = pr.provider
    ) t),
    'dunning', (select coalesce(jsonb_agg(row_to_json(t) order by t.stage), '[]'::jsonb) from (
      select coalesce(dunning_stage, 0) as stage, count(*)::int as n
      from cloud_entitlement_projection
      where status in ('past_due', 'grace') and user_id not in (select user_id from internal) group by 1
    ) t),
    'collected_30d_cents', (select coalesce(sum(amount), 0) from cloud_billing_ledger
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    'collected_30d_n', (select count(*) from cloud_billing_ledger
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    -- Encaissé + remboursé 30 j par rail (le net encaissé du canal = cents - refunded_cents).
    'collected_by_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.cents desc), '[]'::jsonb) from (
      select coalesce(provider, 'stancer') as provider,
             count(*) filter (where kind in ('first_charge', 'renewal') and status = 'captured')::int as n,
             coalesce(sum(amount) filter (where kind in ('first_charge', 'renewal') and status = 'captured'), 0)::bigint as cents,
             coalesce(sum(amount) filter (where kind = 'refund'), 0)::bigint as refunded_cents
      from cloud_billing_ledger
      where updated_at > now() - interval '30 days'
        and ((kind in ('first_charge', 'renewal') and status = 'captured') or kind = 'refund')
        and user_id not in (select user_id from internal)
      group by 1
    ) t),
    -- Conversions 7 j par rail : LA métrique d'arbitrage web vs store.
    'conversions_by_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.n desc), '[]'::jsonb) from (
      select coalesce(provider, 'stancer') as provider, count(distinct user_id)::int as n
      from cloud_billing_ledger
      where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'
        and user_id not in (select user_id from internal)
      group by 1
    ) t),
    'upcoming', jsonb_build_object(
      'trial_charges_48h_n', (select count(*) from trialers where trial_ends_at < now() + interval '48 hours'),
      'trial_charges_48h_cents', (select coalesce(sum(amount_cents), 0) from trialers where trial_ends_at < now() + interval '48 hours'),
      'renewals_7d_n', (select count(*) from cloud_entitlement_projection p2
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days'
          and p2.user_id not in (select user_id from internal)),
      'renewals_7d_cents', (select coalesce(sum(coalesce(rc2.amount_cents, sc2.amount_cents, p2.mrr_cents)), 0)
        from cloud_entitlement_projection p2
        left join cloud_revolut_customers rc2 on rc2.user_id = p2.user_id
        left join cloud_stancer_customers sc2 on sc2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days'
          and p2.user_id not in (select user_id from internal))
    ),
    -- À venir PAR RAIL : Revolut = prélevé par NOTRE cron ; Play/Apple = géré par le store.
    'upcoming_by_rail', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select provider,
             count(*) filter (where u.kind = 'trial')::int as trial_48h_n,
             coalesce(sum(u.cents) filter (where u.kind = 'trial'), 0)::bigint as trial_48h_cents,
             count(*) filter (where u.kind = 'renewal')::int as renewals_7d_n,
             coalesce(sum(u.cents) filter (where u.kind = 'renewal'), 0)::bigint as renewals_7d_cents
      from (
        select t2.provider, 'trial'::text as kind, t2.amount_cents as cents
        from trialers t2 where t2.trial_ends_at < now() + interval '48 hours'
        union all
        select coalesce(p2.provider, 'stancer'), 'renewal', coalesce(rc2.amount_cents, sc2.amount_cents, p2.mrr_cents)
        from cloud_entitlement_projection p2
        left join cloud_revolut_customers rc2 on rc2.user_id = p2.user_id
        left join cloud_stancer_customers sc2 on sc2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days'
          and p2.user_id not in (select user_id from internal)
      ) u group by 1
    ) t),
    'funnel_30d', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select stage, sum(users)::int as users from public.norva_funnel_daily
      where day > (now() - interval '30 days')::date group by stage
    ) t),
    'conversions_7d', (select count(distinct user_id) from cloud_billing_ledger
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
    'discounts_pending', (select
        (select count(*) from cloud_revolut_customers where discount_next_pct is not null and user_id not in (select user_id from internal))
      + (select count(*) from cloud_stancer_customers where discount_next_pct is not null and user_id not in (select user_id from internal))),
    'recent_payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select sp.pi_id, sp.user_id, u.email::text as email, sp.kind, sp.amount, sp.currency,
             coalesce(sp.provider, 'stancer') as provider,
             sp.status, coalesce(sp.updated_at, sp.created_at) as at
      from cloud_billing_ledger sp left join auth.users u on u.id = sp.user_id
      where sp.user_id not in (select user_id from internal)
      order by coalesce(sp.updated_at, sp.created_at) desc limit 50
    ) t)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_finance() from public, anon;
grant execute on function public.admin_finance() to authenticated;
