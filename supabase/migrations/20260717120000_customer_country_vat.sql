-- =============================================================================
-- Pays client + socle TVA/OSS : colonnes, backfill historique, RPC admin.
-- =============================================================================
-- Sources de vérité DÉCIDÉES (2026-07-17) :
--   • Rail Play/Apple (RevenueCat)  → event.country_code (storefront — haute confiance).
--   • Rail web (Revolut Merchant)   → pays d'ÉMISSION de la carte (card_country_code
--     dans les payment details de l'order — proxy ~95 %, expats/néobanques assumés).
--   IP-géoloc : hors périmètre (add-on futur possible pour les comptes gratuits).
--
-- Trois écritures + un backfill :
--   1. cloud_entitlement_projection.country_code/country_source — le pays COURANT du
--      client (dernier événement gagne). Alimenté par norva-billing-webhook (store),
--      norva-revolut /confirm + norva-revolut-webhook (card).
--   2. cloud_revolut_customers.card_country — le pays de la carte sauvegardée (sert
--      aussi au cron de renouvellement pour stamper le ledger).
--   3. cloud_billing_ledger.country_code — le pays AU MOMENT de la transaction
--      (immuable, c'est la base des déclarations TVA/OSS — pas le pays courant).
--   4. Backfill depuis cloud_entitlement_events.payload (jsonb brut déjà journalisé) :
--      RC = payload->>'country_code' ; Revolut = chemins candidats multiples dans
--      payload->'order' (AUCUN échantillon en repo — extraction défensive, un chemin
--      inexistant rend NULL et le backfill saute la ligne sans casser).
--      ⚠ Couverture partielle par construction côté web : les conversions passées
--      uniquement par /confirm n'ont pas de ligne d'événement. Le bucket « Inconnu »
--      des vues admin sert de jauge de couverture.
--
-- TVA/OSS (préparation déclarations — voir docs à venir) :
--   • Les ventes Play/Apple ne sont PAS dans le périmètre TVA du marchand : le store
--     est fournisseur présumé (art. 9 bis du règlement d'exécution UE 282/2011) et
--     collecte/reverse la TVA UE. Seul le rail web direct (revolut) compte.
--   • admin_vat_report(p_year, p_quarter) → base par pays de consommation pour un
--     trimestre (cadence OSS), + cumul annuel ventilé FR / UE hors FR / hors UE /
--     inconnu pour suivre le seuil de 10 000 € (ventes transfrontalières B2C UE).
--     Montants en cents de la devise d'origine (usd) — la conversion EUR (taux BCE
--     du dernier jour du trimestre) se fait au moment de la déclaration.
--
-- Ré-émissions (verbatim depuis la DERNIÈRE version vivante + éditions chirurgicales) :
--   • admin_users_page   (base 20260705060000) : + p_country, + country_code/source
--     dans rows, + facette countries. Signature étendue ⇒ DROP de l'ancienne
--     (sinon surcharge ambiguë côté PostgREST).
--   • admin_users_export (base 20260703240000) : + p_country, + colonne pays. Idem DROP.
--   • admin_user_billing (base 20260716140000) : projection + country_code/source,
--     mapping + card_country.
--   • admin_finance      (base 20260716180000) : CTE paying/trialers + country_code,
--     nouvelles clés by_country + by_country_rail, recent_payments + country_code.
--   • refresh_admin_dashboard (base 20260716210000) : overview + billing_countries
--     (top 5), billing_countries_n, billing_country_unknown_n.
-- Chaque agrégat applique le prédicat canonique d'exclusion des comptes internes.
-- ACL : revoke public/anon/authenticated + grant authenticated/service_role partout
-- (les privilèges par défaut re-donnent EXECUTE à anon/authenticated à chaque CREATE).
-- =============================================================================

-- ── 1) Colonnes additives ────────────────────────────────────────────────────────

alter table public.cloud_entitlement_projection
  add column if not exists country_code text,
  add column if not exists country_source text;

alter table public.cloud_entitlement_projection
  drop constraint if exists cloud_entitlement_projection_country_code_check;
alter table public.cloud_entitlement_projection
  add constraint cloud_entitlement_projection_country_code_check
  check (country_code is null or country_code ~ '^[A-Z]{2}$');
alter table public.cloud_entitlement_projection
  drop constraint if exists cloud_entitlement_projection_country_source_check;
alter table public.cloud_entitlement_projection
  add constraint cloud_entitlement_projection_country_source_check
  check (country_source is null or country_source in ('store', 'card'));

comment on column public.cloud_entitlement_projection.country_code is
  'Pays courant du client (ISO 3166-1 alpha-2, dernier événement gagne). source=store : country_code RevenueCat (storefront Play/Apple). source=card : pays d''émission de la carte Revolut (proxy ~95 %).';

alter table public.cloud_revolut_customers
  add column if not exists card_country text;
comment on column public.cloud_revolut_customers.card_country is
  'Pays d''émission (ISO alpha-2) de la carte sauvegardée — copié sur le ledger par le cron de renouvellement.';

alter table public.cloud_billing_ledger
  add column if not exists country_code text;
comment on column public.cloud_billing_ledger.country_code is
  'Pays du client AU MOMENT de la transaction (base TVA/OSS). NB : la vue de compat cloud_stancer_payments (select * figé) ne porte PAS cette colonne — lire la table.';

-- Le rollup TVA et les vues pays scannent le ledger web par période.
create index if not exists idx_billing_ledger_provider_at
  on public.cloud_billing_ledger (provider, updated_at desc);

-- ── 2) Backfill historique depuis cloud_entitlement_events.payload ───────────────
-- Idempotent : ne touche que les lignes encore NULL.

-- 2a. Rail store (RevenueCat) → projection. Le payload est l'événement RC brut,
--     country_code au niveau racine.
with latest as (
  select distinct on (e.user_id) e.user_id, upper(e.payload->>'country_code') as cc
  from public.cloud_entitlement_events e
  where e.provider = 'revenuecat'
    and coalesce(e.payload->>'country_code', '') ~* '^[a-z]{2}$'
  order by e.user_id, e.created_at desc
)
update public.cloud_entitlement_projection p
   set country_code = l.cc, country_source = 'store'
  from latest l
 where p.user_id = l.user_id
   and p.country_code is null;

-- 2b. Rail web (Revolut) : le webhook stocke { event, order } ; le pays carte vit
--     dans les payment details de l'order. Chemins candidats (API legacy vs 2024-09) —
--     un chemin absent rend NULL, coalesce essaie le suivant.
with ev as (
  select e.user_id, e.created_at,
         e.payload->'order'->>'id' as order_id,
         upper(coalesce(
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].card_country_code') #>> '{}'
         )) as cc
  from public.cloud_entitlement_events e
  where e.provider = 'revolut'
), latest as (
  select distinct on (user_id) user_id, cc
  from ev
  where cc ~ '^[A-Z]{2}$'
  order by user_id, created_at desc
)
update public.cloud_entitlement_projection p
   set country_code = l.cc, country_source = 'card'
  from latest l
 where p.user_id = l.user_id
   and p.country_code is null;

-- 2c. Même extraction → cloud_revolut_customers.card_country.
with ev as (
  select e.user_id, e.created_at,
         upper(coalesce(
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].card_country_code') #>> '{}'
         )) as cc
  from public.cloud_entitlement_events e
  where e.provider = 'revolut'
), latest as (
  select distinct on (user_id) user_id, cc
  from ev
  where cc ~ '^[A-Z]{2}$'
  order by user_id, created_at desc
)
update public.cloud_revolut_customers c
   set card_country = l.cc
  from latest l
 where c.user_id = l.user_id
   and c.card_country is null;

-- 2d. Ledger, rail store : match transaction-précis (pi_id = 'rc_' || transaction_id).
update public.cloud_billing_ledger l
   set country_code = upper(e.payload->>'country_code')
  from public.cloud_entitlement_events e
 where l.country_code is null
   and e.provider = 'revenuecat'
   and coalesce(e.payload->>'country_code', '') ~* '^[a-z]{2}$'
   and l.pi_id = 'rc_' || coalesce(e.payload->>'transaction_id', e.payload->>'id');

-- 2e. Ledger, rail web : match order-précis via l'order re-fetché par le webhook…
with ev as (
  select e.payload->'order'->>'id' as order_id, e.created_at,
         upper(coalesce(
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.card_country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].payment_method.card.country_code') #>> '{}',
           jsonb_path_query_first(e.payload, '$.order.payments[*].card_country_code') #>> '{}'
         )) as cc
  from public.cloud_entitlement_events e
  where e.provider = 'revolut'
), latest as (
  select distinct on (order_id) order_id, cc
  from ev
  where cc ~ '^[A-Z]{2}$' and order_id is not null
  order by order_id, created_at desc
)
update public.cloud_billing_ledger l
   set country_code = x.cc
  from latest x
 where l.country_code is null
   and l.provider = 'revolut'
   and l.order_id = x.order_id;

-- 2f. …puis fallback par client (le pays de la carte sauvegardée).
update public.cloud_billing_ledger l
   set country_code = c.card_country
  from public.cloud_revolut_customers c
 where l.country_code is null
   and l.provider = 'revolut'
   and l.user_id = c.user_id
   and c.card_country ~ '^[A-Z]{2}$';

-- ── 3) admin_users_page : + p_country + country dans rows + facette countries ────
-- Base : re-emission verbatim de 20260705060000 avec les éditions pays. La signature
-- change (7ᵉ arg) ⇒ DROP obligatoire, sinon deux surcharges coexistent et l'appel
-- PostgREST par arguments nommés devient ambigu.
drop function if exists public.admin_users_page(integer, integer, text, text, uuid, text);

create or replace function public.admin_users_page(
  p_limit integer default 25,
  p_offset integer default 0,
  p_search text default null,
  p_sort text default 'created_desc',
  p_tag_id uuid default null,
  p_billing_status text default null,
  p_country text default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_lim    int    := greatest(1, least(100, coalesce(p_limit, 25)));
  v_off    int    := greatest(0, coalesce(p_offset, 0));
  v_search text   := nullif(btrim(coalesce(p_search, '')), '');
  v_bs     text   := nullif(btrim(coalesce(p_billing_status, '')), '');
  v_cc     text   := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_uuid   uuid   := null;
  v_total  bigint;
  v_rows   jsonb;
  v_alltags jsonb;
  v_countries jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;

  select count(*) into v_total
  from auth.users u
  left join public.cloud_entitlement_projection pr on pr.user_id = u.id
  where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
    and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
    and (v_bs is null
      or (v_bs = 'trialing'       and pr.status = 'trialing')
      or (v_bs = 'active'         and pr.status = 'active')
      or (v_bs = 'past_due'       and pr.status in ('past_due', 'grace'))
      or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
      or (v_bs = 'expired'        and pr.status = 'expired')
      or (v_bs = 'free'           and (pr.status is null or pr.status not in ('trialing','active','past_due','grace','cancelled_at_period_end','expired'))))
    and (v_bs is null or v_bs = 'free' or u.id not in (select user_id from public.admin_internal_accounts))
    and (v_cc is null or (v_cc = '??' and pr.country_code is null) or pr.country_code = v_cc);

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           u.created_at,
           u.last_sign_in_at,
           (u.email_confirmed_at is not null)                as email_confirmed,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.id in (select user_id from public.admin_enrichment_accounts)) as is_driver,
           (u.id in (select user_id from public.admin_internal_accounts)) as is_internal,
           pr.status                                         as billing_status,
           pr.plan_code                                      as plan_code,
           pr.country_code                                   as country_code,
           pr.country_source                                 as country_source,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count,
           (select coalesce(jsonb_agg(jsonb_build_object('id',tg.id,'label',tg.label,'color',tg.color) order by tg.label), '[]'::jsonb)
              from public.admin_client_tags ctg join public.admin_tags tg on tg.id = ctg.tag_id where ctg.user_id = u.id) as tags
    from auth.users u
    left join public.cloud_entitlement_projection pr on pr.user_id = u.id
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
      and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
      and (v_bs is null
        or (v_bs = 'trialing'       and pr.status = 'trialing')
        or (v_bs = 'active'         and pr.status = 'active')
        or (v_bs = 'past_due'       and pr.status in ('past_due', 'grace'))
        or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
        or (v_bs = 'expired'        and pr.status = 'expired')
        or (v_bs = 'free'           and (pr.status is null or pr.status not in ('trialing','active','past_due','grace','cancelled_at_period_end','expired'))))
      and (v_bs is null or v_bs = 'free' or u.id not in (select user_id from public.admin_internal_accounts))
      and (v_cc is null or (v_cc = '??' and pr.country_code is null) or pr.country_code = v_cc)
    order by
      (case when p_sort = 'active_desc' then u.last_sign_in_at end) desc nulls last,
      (case when p_sort = 'email_asc'   then u.email           end) asc,
      (case when p_sort = 'created_asc' then u.created_at      end) asc,
      u.created_at desc
    limit v_lim offset v_off
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'color',color) order by label), '[]'::jsonb)
    into v_alltags from public.admin_tags;

  -- Facette globale (comme all_tags) : pays connus uniquement — le front ajoute les
  -- options fixes « Tous » et « Inconnu » ('??').
  select coalesce(jsonb_agg(jsonb_build_object('country_code', cc, 'n', n) order by n desc, cc), '[]'::jsonb)
    into v_countries from (
      select pr.country_code as cc, count(*)::int as n
      from public.cloud_entitlement_projection pr
      where pr.country_code is not null
      group by 1
    ) t;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows,
                            'all_tags', v_alltags, 'countries', v_countries);
end;
$function$;
revoke all on function public.admin_users_page(integer, integer, text, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_users_page(integer, integer, text, text, uuid, text, text) to authenticated, service_role;

-- ── 4) admin_users_export : + p_country + colonne pays ───────────────────────────
-- Base : re-emission verbatim de 20260703240000. Signature étendue ⇒ DROP (cf. §3).
drop function if exists public.admin_users_export(text, uuid, text, int);

create or replace function public.admin_users_export(
  p_search text default null,
  p_tag_id uuid default null,
  p_billing_status text default null,
  p_limit  int  default 10000,
  p_country text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_lim    int  := greatest(1, least(10000, coalesce(p_limit, 10000)));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_bs     text := nullif(btrim(coalesce(p_billing_status, '')), '');
  v_cc     text := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_uuid   uuid := null;
  v_rows   jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           (u.email_confirmed_at is not null)                as email_confirmed,
           u.created_at,
           u.last_sign_in_at,
           pr.status                                         as billing_status,
           pr.plan_code                                      as plan_code,
           pr.country_code                                   as country_code,
           pr.country_source                                 as country_source,
           c.period                                          as billing_period,
           c.amount_cents                                    as amount_cents,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count,
           (select coalesce(string_agg(tg.label, '|' order by tg.label), '')
              from public.admin_client_tags ctg join public.admin_tags tg on tg.id = ctg.tag_id
              where ctg.user_id = u.id) as tags
    from auth.users u
    left join public.cloud_entitlement_projection pr on pr.user_id = u.id
    left join public.cloud_stancer_customers c on c.user_id = u.id
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
      and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
      and (v_bs is null
        or (v_bs = 'trialing'       and pr.status = 'trialing')
        or (v_bs = 'active'         and pr.status = 'active')
        or (v_bs = 'past_due'       and pr.status in ('past_due', 'grace'))
        or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
        or (v_bs = 'expired'        and pr.status = 'expired')
        or (v_bs = 'free'           and (pr.status is null or pr.status not in ('trialing','active','past_due','grace','cancelled_at_period_end','expired'))))
      and (v_cc is null or (v_cc = '??' and pr.country_code is null) or pr.country_code = v_cc)
    order by u.created_at desc
    limit v_lim
  ) t;
  return v_rows;
end;
$$;
revoke all on function public.admin_users_export(text, uuid, text, int, text) from public, anon, authenticated;
grant execute on function public.admin_users_export(text, uuid, text, int, text) to authenticated, service_role;

-- ── 5) admin_user_billing : projection + pays, mapping + card_country ────────────
-- Base : re-emission verbatim de 20260716140000 avec 2 éditions (projection, mapping).
create or replace function public.admin_user_billing(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'is_internal', (p_user_id in (select user_id from admin_internal_accounts)),
    'projection', (select to_jsonb(t) from (
      select status, provider, plan_code, trial_ends_at, trial_consumed_at, current_period_end,
             dunning_stage, dunning_last_at, last_event_at, mrr_cents, bill_period,
             country_code, country_source,
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
             rc.card_country                                  as card_country,
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
revoke all on function public.admin_user_billing(uuid) from public, anon, authenticated;
grant execute on function public.admin_user_billing(uuid) to authenticated, service_role;

-- ── 6) admin_finance : + by_country / by_country_rail / recent_payments.country ──
-- Base : re-emission verbatim de 20260716180000 (rail cards). Éditions : country_code
-- dans les CTE paying/trialers, 2 nouvelles clés, 1 colonne sur recent_payments.
create or replace function public.admin_finance()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  with internal as (
    select user_id from public.admin_internal_accounts
  ), paying as (
    select p.user_id, p.status, coalesce(p.provider, 'stancer') as provider, coalesce(p.plan_code, 'plus') as plan_code,
           p.country_code,
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
           p.country_code,
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
    -- Répartition par pays : payants ET essais. '??' = pays inconnu — jamais masqué,
    -- c'est la jauge de couverture du backfill.
    'by_country', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last, t.n desc), '[]'::jsonb) from (
      select coalesce(pr.country_code, tr.country_code) as country_code,
             coalesce(pr.n, 0)::int as n,
             coalesce(pr.mrr_cents, 0)::bigint as mrr_cents,
             coalesce(tr.n, 0)::int as trialing_n
      from (select coalesce(country_code, '??') as country_code, count(*)::int as n,
                   coalesce(sum(mrr_cents), 0)::bigint as mrr_cents
            from paying group by 1) pr
      full outer join (select coalesce(country_code, '??') as country_code, count(*)::int as n
                       from trialers group by 1) tr on tr.country_code = pr.country_code
    ) t),
    -- Croisement pays × rail (payants) : d'où vient le MRR, et par quel canal.
    'by_country_rail', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select coalesce(country_code, '??') as country_code, provider,
             count(*)::int as n, coalesce(sum(mrr_cents), 0)::bigint as mrr_cents
      from paying group by 1, 2
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
             sp.country_code,
             sp.status, coalesce(sp.updated_at, sp.created_at) as at
      from cloud_billing_ledger sp left join auth.users u on u.id = sp.user_id
      where sp.user_id not in (select user_id from internal)
      order by coalesce(sp.updated_at, sp.created_at) desc limit 50
    ) t)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_finance() from public, anon, authenticated;
grant execute on function public.admin_finance() to authenticated, service_role;

-- ── 7) admin_vat_report : base de déclaration TVA/OSS par trimestre ──────────────
-- Périmètre : rail web DIRECT uniquement (provider='revolut'). Les ventes Play/Apple
-- sont hors périmètre TVA du marchand (store = fournisseur présumé, art. 9 bis
-- règl. 282/2011). Montants en cents de la devise d'origine — la conversion EUR
-- (taux BCE du dernier jour de la période) appartient à la déclaration, pas au calcul.
-- Grèce : code ISO 'GR' ici ; le portail OSS l'affiche 'EL'. Monaco : 'MC' est traité
-- comme France par la TVA — compté domestique (ni transfrontalier UE, ni hors UE).
create or replace function public.admin_vat_report(p_year int default null, p_quarter int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_year    int := coalesce(p_year, extract(year from now())::int);
  v_quarter int := coalesce(p_quarter, extract(quarter from now())::int);
  v_start   timestamptz;
  v_end     timestamptz;
  v_eu constant text[] := array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
  v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_quarter < 1 or v_quarter > 4 then raise exception 'invalid quarter' using errcode = '22023'; end if;
  if v_year < 2020 or v_year > 2100 then raise exception 'invalid year' using errcode = '22023'; end if;
  v_start := make_timestamptz(v_year, (v_quarter - 1) * 3 + 1, 1, 0, 0, 0, 'UTC');
  v_end   := v_start + interval '3 months';

  with internal as (
    select user_id from public.admin_internal_accounts
  ), web as (
    select case when l.country_code = 'MC' then 'FR' else l.country_code end as country_code,
           lower(coalesce(l.currency, 'usd')) as currency, l.kind, l.amount,
           coalesce(l.updated_at, l.created_at) as at
    from cloud_billing_ledger l
    where l.provider = 'revolut'
      and ((l.kind in ('first_charge', 'renewal') and l.status = 'captured') or l.kind = 'refund')
      and l.user_id not in (select user_id from internal)
  )
  select jsonb_build_object(
    'year', v_year, 'quarter', v_quarter,
    'period_start', v_start, 'period_end', v_end,
    'rail', 'revolut',
    -- Lignes du trimestre, par pays de consommation (cadence de déclaration OSS).
    'rows', (select coalesce(jsonb_agg(row_to_json(t) order by t.gross_cents desc), '[]'::jsonb) from (
      select coalesce(w.country_code, '??') as country_code,
             coalesce(w.country_code = any (v_eu), false) as is_eu,
             upper(w.currency) as currency,
             count(*) filter (where w.kind <> 'refund')::int as n_tx,
             coalesce(sum(w.amount) filter (where w.kind <> 'refund'), 0)::bigint as gross_cents,
             coalesce(sum(w.amount) filter (where w.kind = 'refund'), 0)::bigint as refunded_cents,
             (coalesce(sum(w.amount) filter (where w.kind <> 'refund'), 0)
              - coalesce(sum(w.amount) filter (where w.kind = 'refund'), 0))::bigint as net_cents
      from web w where w.at >= v_start and w.at < v_end
      group by 1, 2, 3
    ) t),
    'totals', (select jsonb_build_object(
        'gross_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund'), 0),
        'refunded_cents', coalesce(sum(w.amount) filter (where w.kind = 'refund'), 0),
        'eu_cross_gross_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund'
            and w.country_code <> 'FR' and w.country_code = any (v_eu)), 0),
        'unknown_gross_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund' and w.country_code is null), 0),
        'unknown_n', count(*) filter (where w.kind <> 'refund' and w.country_code is null))
      from web w where w.at >= v_start and w.at < v_end),
    -- Cumul ANNUEL (année civile) — c'est l'assiette du seuil de 10 000 € de ventes
    -- transfrontalières B2C UE (année en cours ET année précédente).
    'year_summary', (select jsonb_build_object(
        'year', v_year,
        'eu_cross_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund'
            and w.country_code <> 'FR' and w.country_code = any (v_eu)
            and extract(year from w.at)::int = v_year), 0),
        'eu_cross_prev_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund'
            and w.country_code <> 'FR' and w.country_code = any (v_eu)
            and extract(year from w.at)::int = v_year - 1), 0),
        'fr_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund'
            and w.country_code = 'FR' and extract(year from w.at)::int = v_year), 0),
        'non_eu_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund'
            and w.country_code is not null and not (w.country_code = any (v_eu))
            and extract(year from w.at)::int = v_year), 0),
        'unknown_cents', coalesce(sum(w.amount) filter (where w.kind <> 'refund'
            and w.country_code is null and extract(year from w.at)::int = v_year), 0))
      from web w)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_vat_report(int, int) from public, anon, authenticated;
grant execute on function public.admin_vat_report(int, int) to authenticated, service_role;

-- ── 8) refresh_admin_dashboard : overview + billing_countries (Cockpit) ──────────
-- Base : re-emission verbatim de 20260716210000 (cron_ko recovery-aware) avec la
-- SEULE addition des 3 clés pays dans le blob overview.
create or replace function public.refresh_admin_dashboard()
 returns timestamp with time zone
 language plpgsql
 security definer
 set search_path to 'public', 'cron'
as $function$
declare ov jsonb; src jsonb; cov jsonb; crn jsonb;
begin
  set local statement_timeout to '180s';
  set local work_mem to '64MB';

  with tc as (
    select v.source_id, t2.item_type, count(*)::bigint as n
    from cloud_titles t2
    join cloud_title_variants v on v.id = t2.default_variant_id
    where t2.variant_count > 0 and t2.item_type in ('movie','series')
    group by 1, 2
  ), vc as (
    select source_id, count(*)::bigint as n from cloud_title_variants group by 1
  ), mc as (
    select source_id, count(*)::bigint as n,
           count(*) filter (where item_type in ('movie','series'))::bigint as n_ms
    from cloud_media_items group by 1
  ), tt as (
    select item_type, count(*)::bigint as n
    from cloud_titles where variant_count > 0 and item_type in ('movie','series')
    group by 1
  ), src_rows as (
    select s.id as source_id, s.user_id as user_id, u.email::text as owner_email,
           coalesce(s.display_name, left(s.id::text, 8)) as display_name,
           s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
           coalesce(mc.n, 0)  as media_items,
           coalesce(vc.n, 0)  as variants,
           coalesce(tcm.n, 0) as movie_titles,
           coalesce(tcs.n, 0) as series_titles,
           (coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0) as incomplete,
           pi.id as identity_id, pi.display_name::text as identity_name,
           (s.user_id in (select user_id from public.admin_enrichment_accounts)) as is_driver
    from cloud_sources s
    left join auth.users u on u.id = s.user_id
    left join mc on mc.source_id = s.id
    left join vc on vc.source_id = s.id
    left join tc tcm on tcm.source_id = s.id and tcm.item_type = 'movie'
    left join tc tcs on tcs.source_id = s.id and tcs.item_type = 'series'
    left join catalog_provider_identities cpi on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2 where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    where s.user_id in (select user_id from public.admin_enrichment_accounts)
       or s.sync_status = 'sync_error' or s.sync_error is not null
       or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
           and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))
    order by (s.user_id in (select user_id from public.admin_enrichment_accounts)) desc, s.created_at
    limit 300
  )
  select
    jsonb_build_object(
      'users_total',(select count(*) from auth.users),
      'users_active_7d',(select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'users_active_24h',(select count(*) from auth.users where last_sign_in_at > now() - interval '24 hours'),
      'users_active_30d',(select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
      'users_new_7d',(select count(*) from auth.users where created_at > now() - interval '7 days'),
      'users_new_30d',(select count(*) from auth.users where created_at > now() - interval '30 days'),
      'users_watching_24h',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '24 hours'),
      'users_watching_7d',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '7 days'),
      'sources_total',(select count(*) from cloud_sources),
      'sources_error',(select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
      'sources_incomplete',(select count(*) from cloud_sources s
          left join mc on mc.source_id = s.id
          left join vc on vc.source_id = s.id
          where coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0),
      'titles_movie',(select coalesce((select n from tt where item_type = 'movie'), 0)),
      'titles_series',(select coalesce((select n from tt where item_type = 'series'), 0)),
      'identities_active',(select count(*) from provider_identities where status = 'active'),
      'gensubs_ready',(select count(*) from catalog_generated_subtitles where status = 'ready'),
      'gensubs_processing',(select count(*) from catalog_generated_subtitles where status = 'processing'),
      'gensubs_failed',(select count(*) from catalog_generated_subtitles where status = 'failed'),
      'tmdb_year_backlog',(select count(*) from cloud_titles where release_year is null and provider_tmdb_id is not null),
      'tmdb_unmatched',(select count(*) from cloud_titles where match_status = 'unmatched'),
      'tmdb_unverified',(select count(*) from cloud_titles where match_status in ('provider_unverified','weak') and provider_tmdb_id is not null and provider_tmdb_id <> '0'),
      'cron_active',(select count(*) from cron.job where active),
      'cron_paused',(select count(*) from cron.job where not active),
      'cron_fails_24h',(select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '24 hours'),
      'cron_ko',(select count(*) from cron.job j
          where j.active
            and (select d.status from cron.job_run_details d
                  where d.jobid = j.jobid order by d.start_time desc limit 1) = 'failed'),
      'billing_mrr_cents',(select coalesce(sum(case when coalesce(c.period, p.bill_period) = 'annual' then round(coalesce(c.amount_cents, p.mrr_cents) / 12.0) else coalesce(c.amount_cents, p.mrr_cents) end), 0)
          from cloud_entitlement_projection p left join cloud_stancer_customers c on c.user_id = p.user_id
          where p.status in ('active','past_due','grace','cancelled_at_period_end')
            and p.user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_trialing',(select count(*) from cloud_entitlement_projection
          where status = 'trialing' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_active',(select count(*) from cloud_entitlement_projection
          where status = 'active' and provider <> 'system'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_past_due',(select count(*) from cloud_entitlement_projection
          where status in ('past_due','grace') and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cancel_pending',(select count(*) from cloud_entitlement_projection
          where status = 'cancelled_at_period_end' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_collected_30d_cents',(select coalesce(sum(amount), 0) from cloud_stancer_payments
          where status = 'captured' and kind in ('first_charge','renewal') and updated_at > now() - interval '30 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_conversions_7d',(select count(distinct user_id) from cloud_stancer_payments
          where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cron_fails_24h',(select count(*) from cron.job_run_details d join cron.job j on j.jobid = d.jobid
          where j.jobname in ('norva-revolut-billing','norva-lifecycle') and d.status = 'failed' and d.start_time > now() - interval '24 hours'),
      -- Pays : top 5 (payants + essais), nb de pays distincts, et le trou de
      -- couverture (clients facturés sans pays connu). Le MRR n'additionne que les
      -- lignes non-essai, avec la même formule amount/period que billing_mrr_cents.
      'billing_countries',(select coalesce(jsonb_agg(jsonb_build_object('country_code', t.cc, 'n', t.n, 'mrr_cents', t.mrr) order by t.n desc, t.cc), '[]'::jsonb) from (
          select p.country_code as cc, count(*)::int as n,
                 coalesce(sum(case when p.status = 'trialing' then 0
                                   when coalesce(c.period, p.bill_period) = 'annual' then round(coalesce(c.amount_cents, p.mrr_cents) / 12.0)
                                   else coalesce(c.amount_cents, p.mrr_cents) end), 0)::bigint as mrr
          from cloud_entitlement_projection p left join cloud_stancer_customers c on c.user_id = p.user_id
          where p.status in ('trialing','active','past_due','grace','cancelled_at_period_end')
            and p.country_code is not null
            and p.user_id not in (select user_id from public.admin_internal_accounts)
          group by 1 order by count(*) desc limit 5) t),
      'billing_countries_n',(select count(distinct country_code) from cloud_entitlement_projection
          where status in ('trialing','active','past_due','grace','cancelled_at_period_end')
            and country_code is not null
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_country_unknown_n',(select count(*) from cloud_entitlement_projection
          where status in ('trialing','active','past_due','grace','cancelled_at_period_end')
            and country_code is null
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'support_open',(select count(*) from cloud_support_tickets where status <> 'closed'),
      'support_needs_reply',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user'),
      'support_stale_24h',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user' and last_message_at < now() - interval '24 hours')
    ),
    (select coalesce(jsonb_agg(row_to_json(sr) order by sr.is_driver desc, sr.created_at), '[]'::jsonb) from src_rows sr)
  into ov, src;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into cov from (
    select u.email::text as owner_email, coalesce(pi.display_name, s.display_name, left(s.id::text, 8)) as panel, ct.item_type,
           count(*) as total,
           count(*) filter (where ct.audio_languages <> '{}') as resolved,
           round(100.0 * count(*) filter (where ct.audio_languages <> '{}') / nullif(count(*), 0), 1) as resolved_pct,
           count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}') as never_probed,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as probed_24h,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours' and ct.audio_languages <> '{}') as resolved_24h,
           case when count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') > 0
                then ceil(count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}')::numeric / count(*) filter (where ct.audio_probed_at > now() - interval '24 hours'))
                else null end as eta_days,
           count(*) filter (where ct.subtitle_probed_at is not null) as subtitle_probed,
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array' and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
    from cloud_titles ct join cloud_title_variants v on v.id = ct.default_variant_id join cloud_sources s on s.id = v.source_id
    left join auth.users u on u.id = s.user_id
    left join catalog_provider_identities cpi on cpi.provider_key = s.config_hint->>'providerKey'
    left join provider_identities pi on pi.id = cpi.identity_id
    where ct.variant_count > 0
      and ct.user_id in (select user_id from public.admin_enrichment_accounts)
    group by u.email, coalesce(pi.id::text, s.id::text), coalesce(pi.display_name, s.display_name, left(s.id::text, 8)), ct.item_type
    order by u.email, ct.item_type, count(*) desc
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into crn from (
    select j.jobid, j.jobname, j.schedule, j.active,
           case when j.schedule ~ '6-23' then 'jour'
                when j.schedule ~ '0-5' then 'nuit'
                when j.schedule ~ '^\S+ \* \* \* \*$' then 'continu'
                else '—' end as window,
           case when j.jobname ~ 'stancer|billing' then 'billing'
                when j.jobname ~ 'lifecycle' then 'lifecycle'
                when j.jobname ~ 'whisper' then 'whisper'
                when j.jobname ~ 'reaper|prewarm|prune|series-info|dashboard|vac|history|alert' then 'maintenance'
                when j.jobname ~ 'auto-refresh|resume-stuck' then 'sync'
                when j.jobname ~ 'series' then 'séries'
                when j.jobname ~ 'subtitle|pregen' then 'sous-titres'
                when j.jobname ~ 'audio|langs' then 'audio films'
                when j.jobname ~ 'enrich|origlang|revalidate|backfill-years|search-match|tmdb' then 'tmdb'
                when j.jobname ~ 'notify|digest' then 'notif'
                else 'autre' end as kind,
           lr.start_time as last_run, lr.status as last_status,
           coalesce((select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '24 hours'), 0) as fails_24h
    from cron.job j
    left join lateral (select d.start_time, d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) lr on true
    order by (case when j.jobname ~ 'stancer|billing|lifecycle' then 0 when j.schedule ~ '6-23' then 1 when j.schedule ~ '0-5' then 2 else 3 end), j.jobname
  ) t;

  insert into public.admin_dashboard_cache (id, overview, sources, coverage, cron, refreshed_at)
       values (1, ov, src, cov, crn, now())
  on conflict (id) do update set overview = excluded.overview, sources = excluded.sources, coverage = excluded.coverage, cron = excluded.cron, refreshed_at = excluded.refreshed_at;
  return now();
end; $function$;
