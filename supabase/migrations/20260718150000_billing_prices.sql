-- Tarifs web (rail Revolut) — source unique en base (2026-07-18).
--
-- Demande produit : pouvoir faire des promotions (Black Friday, Noël, soldes)
-- en changeant les prix à UN seul endroit, sans toucher au code. Avant cette
-- migration, la table de prix était dupliquée à 6 endroits (4 edge functions,
-- billing-config.js, data-attributes de subscribe.html).
--
-- Une seule vérité désormais : billing_prices (plan × period → amount_cents).
--   • Les edge la lisent via _shared/prices.ts (cache 60 s par isolate, repli
--     sur les tarifs historiques si la table est vide/inaccessible — le
--     checkout ne doit jamais casser pour un problème de lecture de tarifs).
--   • Le front l'affiche via GET norva-revolut/prices (public) ; les valeurs
--     statiques des pages restent en repli d'affichage.
--   • Les promos passent par admin_billing_price_set — carte « 💵 Tarifs web »
--     de l'onglet Finance.
--
-- Périmètre et garde-fous :
--   • Les abonnés EXISTANTS ne bougent pas : le cron de renouvellement débite
--     cloud_revolut_customers.amount_cents (prix verrouillé à la souscription).
--     Un changement de tarif ne s'applique qu'aux nouveaux checkouts et aux
--     changements de plan confirmés APRÈS le changement.
--   • Rail Play hors périmètre : Google est marchand de référence — les promos
--     mobiles se font via les offres de la Play Console.
--
-- Idempotent. À exécuter en supabase_admin. ⚠ NOTIFY pgrst requis
-- (2 fonctions neuves : admin_billing_prices, admin_billing_price_set).

create table if not exists public.billing_prices (
  plan         text not null check (plan in ('plus', 'family')),
  period       text not null check (period in ('monthly', 'annual')),
  -- Bornes anti-fausse-manip : 1,00 $ à 999,99 $ (un tarif à 1 cent ou à
  -- 10 000 $ est forcément une erreur de saisie).
  amount_cents int  not null check (amount_cents between 100 and 99999),
  updated_at   timestamptz not null default now(),
  primary key (plan, period)
);
comment on table public.billing_prices is
  'Tarifs web (USD cents), source unique — lue par les edge (_shared/prices.ts) et le front (GET norva-revolut/prices). Modifier via admin_billing_price_set (carte Finance). Les abonnés existants gardent leur prix (mapping cloud_revolut_customers).';

insert into public.billing_prices (plan, period, amount_cents) values
  ('plus',   'monthly', 499), ('plus',   'annual', 4199),
  ('family', 'monthly', 899), ('family', 'annual', 7599)
on conflict (plan, period) do nothing;

-- Verrouillage : lecture réservée au service_role (les edge) ; le front passe
-- par l'endpoint public de norva-revolut, jamais par PostgREST directement.
alter table public.billing_prices enable row level security;
revoke all on table public.billing_prices from public, anon, authenticated;
grant select on table public.billing_prices to service_role;

-- ── Lecture admin (carte Finance) ────────────────────────────────────────────
create or replace function public.admin_billing_prices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'plan', plan, 'period', period, 'amount_cents', amount_cents,
            'updated_at', updated_at) order by plan, period), '[]'::jsonb)
          from public.billing_prices);
end; $$;
revoke all on function public.admin_billing_prices() from public, anon, authenticated;
grant execute on function public.admin_billing_prices() to authenticated, service_role;

-- ── Écriture admin (promos) ──────────────────────────────────────────────────
create or replace function public.admin_billing_price_set(p_plan text, p_period text, p_amount_cents int)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_plan not in ('plus', 'family') or p_period not in ('monthly', 'annual') then
    raise exception 'invalid plan/period' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents > 99999 then
    raise exception 'amount out of bounds (100..99999 cents)' using errcode = '22023';
  end if;
  insert into public.billing_prices (plan, period, amount_cents, updated_at)
       values (p_plan, p_period, p_amount_cents, now())
  on conflict (plan, period) do update
    set amount_cents = excluded.amount_cents, updated_at = now();
  return jsonb_build_object('ok', true, 'plan', p_plan, 'period', p_period, 'amount_cents', p_amount_cents);
end; $$;
revoke all on function public.admin_billing_price_set(text, text, int) from public, anon, authenticated;
grant execute on function public.admin_billing_price_set(text, text, int) to authenticated, service_role;
