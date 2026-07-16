-- =============================================================================
-- Fiche + Finance + Funnel : rendre le CRM 100 % Revolut-aware (rail web actuel).
-- =============================================================================
-- Suite du fix G2/G3 (20260716130000, qui a traité refresh_admin_dashboard +
-- snapshot_admin_metrics). Ici on ferme les DERNIERS points aveugles au rail
-- Revolut, plus deux bugs découverts pendant l'audit post-migration :
--
--   (0) BUG SILENCIEUX — cloud_stancer_payments.provider n'autorise PAS 'revolut'.
--       Les tables cloud_entitlement_projection/_events ont été whitelistées pour
--       'revolut' (20260711160000/170000) mais PAS le ledger cross-rail. Résultat :
--       le journaling des charges Revolut (norva-revolut-billing) viole la contrainte
--       et échoue en silence (try/catch). La 1ʳᵉ conversion (cventis, ~2026-07-19)
--       ne serait PAS journalisée → invisible dans collected/conversions/funnel.
--
--   (1) FICHE CLIENT — admin_user_billing.mapping lisait cloud_stancer_customers
--       (rail mort). Un abonné Revolut renvoyait mapping=null → « Plan facturé » et
--       « Carte » vides. Désormais coalesce(cloud_revolut_customers, stancer) +
--       card_brand. Re-ajoute aussi is_internal (perdu au 20260705110000 → le
--       bouton « marquer interne » de la fiche affichait un état faux) et un flag
--       refundable précis (revolut + capturé + order_id) pour le bouton Rembourser.
--
--   (2) FUNNEL WEB — norva_funnel_daily tirait checkout_open du ledger, où les
--       trial_setup Revolut n'atterrissent jamais (seules les charges capturées le
--       sont). On ajoute une branche depuis cloud_revolut_orders (trial_setup +
--       resubscribe) → les 20 checkouts abandonnés de cventis deviennent visibles.
--
--   (3) admin_finance — RÉGRESSION : le re-emit cross-rail (20260705110000) a PERDU
--       l'exclusion des comptes internes (ajoutée en 20260704010000). La page Finance
--       recompte donc les comptes de test (projethorizon2030). On la restaure ET on
--       rend paying/trialers/renewals rail-agnostiques (coalesce revolut/stancer/proj).
--
-- 100 % additif / re-emission verbatim des définitions LIVE avec éditions chirurgicales.
-- =============================================================================

-- ── (0) Whitelist 'revolut' sur le ledger cross-rail ────────────────────────────────
alter table public.cloud_stancer_payments
  drop constraint if exists cloud_stancer_payments_provider_check;
alter table public.cloud_stancer_payments
  add constraint cloud_stancer_payments_provider_check
  check (provider in ('stancer','revolut','google_play','apple_app_store','web','stripe','revenuecat','system','manual'));

-- ── (1) admin_user_billing : mapping rail-agnostic + is_internal + refundable ────────
-- Base : re-emission verbatim de 20260705130000 (refundable) avec 3 éditions.
create or replace function public.admin_user_billing(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'is_internal', (p_user_id in (select user_id from admin_internal_accounts)),
    'projection', (select to_jsonb(t) from (
      select status, provider, plan_code, trial_ends_at, trial_consumed_at, current_period_end,
             dunning_stage, dunning_last_at, last_event_at, mrr_cents, bill_period,
             welcome_email_at, trial_reminder_email_at, winback_email_at
      from cloud_entitlement_projection where user_id = p_user_id
    ) t),
    -- Rail-agnostic : Revolut (rail web actuel) vit dans cloud_revolut_customers ; le
    -- rail Stancer retiré gardait sa propre map. Un user est sur UN seul rail → coalesce
    -- prend celui qui existe (Revolut prioritaire si les deux, inoffensif). mapping=null
    -- si aucun des deux (compte gratuit / rail mobile) → la fiche bascule sur la projection.
    'mapping', (select to_jsonb(t) from (
      select coalesce(rc.plan, sc.plan)                       as plan,
             coalesce(rc.period, sc.period)                   as period,
             coalesce(rc.amount_cents, sc.amount_cents)       as amount_cents,
             coalesce(rc.card_last4, sc.card_last4)           as card_last4,
             coalesce(rc.card_exp, sc.card_exp)               as card_exp,
             rc.card_brand                                    as card_brand,
             coalesce(rc.discount_next_pct, sc.discount_next_pct)   as discount_next_pct,
             coalesce(rc.save_offer_used_at, sc.save_offer_used_at) as save_offer_used_at
      from (select p_user_id as uid) one
      left join cloud_revolut_customers rc on rc.user_id = one.uid
      left join cloud_stancer_customers sc on sc.user_id = one.uid
      where rc.user_id is not null or sc.user_id is not null
    ) t),
    -- refundable : précis pour le rail Revolut (le seul avec route /admin/refund).
    -- Il faut un order_id (pour appeler POST /orders/{id}/refund) + un paiement capturé.
    'payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select pi_id, kind, amount, currency, coalesce(provider, 'stancer') as provider, status,
             (coalesce(provider, 'stancer') = 'revolut' and order_id is not null and status = 'captured') as refundable,
             created_at, updated_at
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

-- ── (2) norva_funnel_daily : checkout_open Revolut depuis cloud_revolut_orders ───────
-- Base : re-emission verbatim de 20260704010000 avec UNE branche union en plus.
create or replace view public.norva_funnel_daily as
select day, stage, count(distinct user_id)::int as users
from (
  select created_at::date as day, 'signup' as stage, user_id
    from public.cloud_entitlement_projection
  union all
  select first_at::date, 'source_added', user_id
    from (select user_id, min(created_at) as first_at from public.cloud_sources group by user_id) s
  union all
  select first_at::date, 'first_play', user_id
    from (select user_id, min(created_at) as first_at from public.cloud_watch_history group by user_id) w
  union all
  select created_at::date, 'checkout_open', user_id
    from public.cloud_stancer_payments where kind in ('trial_setup', 'resubscribe')
  union all
  -- Rail Revolut : les trial_setup/resubscribe vivent dans cloud_revolut_orders, jamais
  -- dans le ledger (seules les charges capturées y sont journalisées). Sans ça, tous les
  -- checkouts web (dont les 20 abandons de cventis) seraient invisibles dans le funnel.
  select created_at::date, 'checkout_open', user_id
    from public.cloud_revolut_orders where kind in ('trial_setup', 'resubscribe')
  union all
  select trial_consumed_at::date, 'trial_start', user_id
    from public.cloud_entitlement_projection where trial_consumed_at is not null
  union all
  select updated_at::date, 'trial_convert', user_id
    from public.cloud_stancer_payments where kind = 'first_charge' and status = 'captured'
  union all
  select updated_at::date, 'renewal', user_id
    from public.cloud_stancer_payments where kind = 'renewal' and status = 'captured'
  union all
  select created_at::date, 'cancel', user_id
    from public.cloud_cancel_feedback where action = 'cancelled'
  union all
  select created_at::date, 'save', user_id
    from public.cloud_cancel_feedback where action = 'saved'
  union all
  select updated_at::date, 'winback_return', user_id
    from public.cloud_stancer_payments
    where kind = 'resubscribe' and status in ('captured', 'authorized', 'to_capture')
) stages
where user_id not in (select user_id from public.admin_internal_accounts)
group by day, stage;
revoke all on public.norva_funnel_daily from anon, authenticated;

-- ── (3) admin_finance : restaure exclusion interne + rend les rails coalescés ────────
-- Base : re-emission de 20260705110000 (cross-rail, blocs by_rail/collected_by_rail)
-- avec (a) le CTE internal + filtres réintroduits, (b) coalesce revolut/stancer/proj.
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
    'by_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select provider,
             count(*)::int as n,
             coalesce(sum(mrr_cents), 0)::bigint as mrr_cents,
             count(*) filter (where mrr_cents is null)::int as unknown_n
      from paying group by 1
    ) t),
    'dunning', (select coalesce(jsonb_agg(row_to_json(t) order by t.stage), '[]'::jsonb) from (
      select coalesce(dunning_stage, 0) as stage, count(*)::int as n
      from cloud_entitlement_projection
      where status in ('past_due', 'grace') and user_id not in (select user_id from internal) group by 1
    ) t),
    'collected_30d_cents', (select coalesce(sum(amount), 0) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    'collected_30d_n', (select count(*) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    'collected_by_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.cents desc), '[]'::jsonb) from (
      select coalesce(provider, 'stancer') as provider, count(*)::int as n, coalesce(sum(amount), 0)::bigint as cents
      from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
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
    'discounts_pending', (select
        (select count(*) from cloud_revolut_customers where discount_next_pct is not null and user_id not in (select user_id from internal))
      + (select count(*) from cloud_stancer_customers where discount_next_pct is not null and user_id not in (select user_id from internal))),
    'recent_payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select sp.pi_id, sp.user_id, u.email::text as email, sp.kind, sp.amount, sp.currency,
             coalesce(sp.provider, 'stancer') as provider,
             sp.status, coalesce(sp.updated_at, sp.created_at) as at
      from cloud_stancer_payments sp left join auth.users u on u.id = sp.user_id
      where sp.user_id not in (select user_id from internal)
      order by coalesce(sp.updated_at, sp.created_at) desc limit 50
    ) t)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_finance() from public, anon;
grant execute on function public.admin_finance() to authenticated;
