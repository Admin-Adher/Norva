-- Promotions sur les tarifs web (2026-07-18, suite du Lot 7 billing_prices).
--
-- Modèle : le prix de BASE reste amount_cents ; une promo est un
-- promo_amount_cents optionnel qui PRIME tant qu'il est rempli (et que
-- promo_ends_at, optionnel, n'est pas passé — l'échéance auto-désactive la
-- promo sans intervention). promo_event (catalogue fermé d'événements mondiaux)
-- détermine le badge affiché sur la page de vente.
--
--   • _shared/prices.ts calcule le prix EFFECTIF (promo active sinon base) —
--     tous les lecteurs edge héritent sans changement.
--   • GET norva-revolut/prices expose { prices (effectifs), promos } → badge +
--     prix barré sur subscribe/checkout.
--   • Rail web uniquement — les promos Play se font dans la Play Console
--     (Google est marchand de référence).
--
-- Idempotent. supabase_admin. ⚠ NOTIFY pgrst requis (admin_billing_promo_set
-- nouvelle ; admin_billing_prices ré-émise, signature inchangée).

alter table public.billing_prices
  add column if not exists promo_amount_cents int check (promo_amount_cents between 100 and 99999),
  add column if not exists promo_event text,
  add column if not exists promo_ends_at timestamptz;
comment on column public.billing_prices.promo_amount_cents is
  'Prix promo (cents). Quand rempli (et promo_ends_at non passé), PRIME sur amount_cents pour les nouveaux checkouts. NULL = pas de promo.';
comment on column public.billing_prices.promo_event is
  'Événement du catalogue (black_friday, christmas, eid, lunar_new_year…) → badge sur la page de vente.';
comment on column public.billing_prices.promo_ends_at is
  'Fin de promo optionnelle : passée cette date, la promo est ignorée partout (auto-désactivation, rien à faire).';

-- ── Lecture admin : ré-émission avec les champs promo (signature inchangée) ──
create or replace function public.admin_billing_prices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'plan', plan, 'period', period, 'amount_cents', amount_cents,
            'promo_amount_cents', promo_amount_cents, 'promo_event', promo_event,
            'promo_ends_at', promo_ends_at,
            'promo_active', (promo_amount_cents is not null and (promo_ends_at is null or promo_ends_at > now())),
            'updated_at', updated_at) order by plan, period), '[]'::jsonb)
          from public.billing_prices);
end; $$;
revoke all on function public.admin_billing_prices() from public, anon, authenticated;
grant execute on function public.admin_billing_prices() to authenticated, service_role;

-- ── Écriture promo ───────────────────────────────────────────────────────────
-- p_amount_cents NULL = retirer la promo (les 3 champs sont vidés).
-- Sinon : événement du catalogue obligatoire, montant borné et STRICTEMENT
-- inférieur au prix de base (une « promo » plus chère est une erreur de saisie),
-- échéance optionnelle dans le futur.
create or replace function public.admin_billing_promo_set(
  p_plan text, p_period text,
  p_amount_cents int default null, p_event text default null, p_ends_at timestamptz default null
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_base int;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_plan not in ('plus', 'family') or p_period not in ('monthly', 'annual') then
    raise exception 'invalid plan/period' using errcode = '22023';
  end if;
  select amount_cents into v_base from public.billing_prices where plan = p_plan and period = p_period;
  if v_base is null then raise exception 'price row not found' using errcode = '22023'; end if;

  if p_amount_cents is null then
    update public.billing_prices
       set promo_amount_cents = null, promo_event = null, promo_ends_at = null, updated_at = now()
     where plan = p_plan and period = p_period;
    return jsonb_build_object('ok', true, 'plan', p_plan, 'period', p_period, 'promo', null);
  end if;

  if p_amount_cents < 100 or p_amount_cents > 99999 then
    raise exception 'amount out of bounds (100..99999 cents)' using errcode = '22023';
  end if;
  if p_amount_cents >= v_base then
    raise exception 'promo must be below the base price' using errcode = '22023';
  end if;
  if p_event is null or p_event not in (
    'black_friday', 'cyber_monday', 'winter_sale', 'summer_sale', 'christmas',
    'new_year', 'lunar_new_year', 'eid', 'easter', 'halloween', 'valentines',
    'back_to_school', 'birthday', 'flash', 'other'
  ) then
    raise exception 'unknown promo event' using errcode = '22023';
  end if;
  if p_ends_at is not null and p_ends_at <= now() then
    raise exception 'promo end must be in the future' using errcode = '22023';
  end if;

  update public.billing_prices
     set promo_amount_cents = p_amount_cents, promo_event = p_event,
         promo_ends_at = p_ends_at, updated_at = now()
   where plan = p_plan and period = p_period;
  return jsonb_build_object('ok', true, 'plan', p_plan, 'period', p_period,
    'promo', jsonb_build_object('amount_cents', p_amount_cents, 'event', p_event, 'ends_at', p_ends_at));
end; $$;
revoke all on function public.admin_billing_promo_set(text, text, int, text, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_billing_promo_set(text, text, int, text, timestamptz) to authenticated, service_role;
