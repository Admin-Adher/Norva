-- Promos « N premières périodes » (décision produit 2026-07-18).
--
-- Politique actée : pour les ÉVÉNEMENTS (Black Friday, soldes…), la réduction ne
-- vaut que pour les N premières périodes facturées (conseillé : 3 en mensuel,
-- 1 en annuel), puis retour au prix de base — coût de promo borné, LTV
-- protégée, promos réutilisables à chaque événement. Le « à vie »
-- (grandfathering, comportement historique) reste disponible : promo_cycles
-- NULL — réservé aux gestes stratégiques (early-bird, membres fondateurs).
--
-- Mécanique :
--   • billing_prices.promo_cycles = durée de la promo en périodes (NULL = à vie).
--   • À l'engagement (checkout confirmé / webhook), le mapping client reçoit
--     amount_cents = prix promo, base_amount_cents = prix de base mémorisé,
--     promo_cycles_left = N.
--   • Le cron décompte à chaque encaissement ; à épuisement, amount_cents
--     rebascule sur base_amount_cents (le cycle suivant est au prix de base).
--   • Les abonnés promo existants (avant cette migration) restent « à vie » —
--     aucun contrat en cours n'est modifié.
--
-- admin_billing_promo_set gagne p_cycles — SIGNATURE ÉTENDUE ⇒ DROP de
-- l'ancienne ⇒ ⚠ NOTIFY pgrst requis (+ nouvelles colonnes lues via REST).
-- Idempotent. supabase_admin (cloud_revolut_customers : owner supabase_admin).

alter table public.billing_prices
  add column if not exists promo_cycles int check (promo_cycles between 1 and 24);
comment on column public.billing_prices.promo_cycles is
  'Durée de la promo en périodes facturées (1..24). NULL = réduction à vie (early-bird). Conseillé : 3 en mensuel, 1 en annuel.';

alter table public.cloud_revolut_customers
  add column if not exists base_amount_cents int,
  add column if not exists promo_cycles_left int;
comment on column public.cloud_revolut_customers.base_amount_cents is
  'Prix de base (cents) mémorisé pendant une promo « N périodes » — amount_cents y rebascule quand promo_cycles_left atteint 0.';
comment on column public.cloud_revolut_customers.promo_cycles_left is
  'Périodes restantes au prix promo (décrémenté par le cron à chaque encaissement). NULL = pas de promo limitée (prix courant définitif).';

-- ── Lecture admin : ré-émission avec promo_cycles (signature inchangée) ─────────
create or replace function public.admin_billing_prices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'plan', plan, 'period', period, 'amount_cents', amount_cents,
            'promo_amount_cents', promo_amount_cents, 'promo_event', promo_event,
            'promo_label', promo_label, 'promo_ends_at', promo_ends_at,
            'promo_cycles', promo_cycles,
            'promo_active', (promo_amount_cents is not null and (promo_ends_at is null or promo_ends_at > now())),
            'updated_at', updated_at) order by plan, period), '[]'::jsonb)
          from public.billing_prices);
end; $$;
revoke all on function public.admin_billing_prices() from public, anon, authenticated;
grant execute on function public.admin_billing_prices() to authenticated, service_role;

-- ── Écriture promo : signature étendue (p_cycles) ⇒ DROP ancienne ───────────────
drop function if exists public.admin_billing_promo_set(text, text, int, text, timestamptz, text);

create or replace function public.admin_billing_promo_set(
  p_plan text, p_period text,
  p_amount_cents int default null, p_event text default null,
  p_ends_at timestamptz default null, p_label text default null,
  p_cycles int default null
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_base int; v_label text;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_plan not in ('plus', 'family') or p_period not in ('monthly', 'annual') then
    raise exception 'invalid plan/period' using errcode = '22023';
  end if;
  select amount_cents into v_base from public.billing_prices where plan = p_plan and period = p_period;
  if v_base is null then raise exception 'price row not found' using errcode = '22023'; end if;

  if p_amount_cents is null then
    update public.billing_prices
       set promo_amount_cents = null, promo_event = null, promo_ends_at = null,
           promo_label = null, promo_cycles = null, updated_at = now()
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
  if p_cycles is not null and (p_cycles < 1 or p_cycles > 24) then
    raise exception 'cycles out of bounds (1..24, null = lifetime)' using errcode = '22023';
  end if;
  -- Libellé : optionnel, borné pour l'esthétique du badge, sans caractères de contrôle.
  v_label := nullif(btrim(coalesce(p_label, '')), '');
  if v_label is not null then
    if char_length(v_label) < 2 or char_length(v_label) > 24 then
      raise exception 'label must be 2..24 characters' using errcode = '22023';
    end if;
    if v_label ~ '[[:cntrl:]]' then
      raise exception 'invalid label' using errcode = '22023';
    end if;
  end if;

  update public.billing_prices
     set promo_amount_cents = p_amount_cents, promo_event = p_event,
         promo_ends_at = p_ends_at, promo_label = v_label,
         promo_cycles = p_cycles, updated_at = now()
   where plan = p_plan and period = p_period;
  return jsonb_build_object('ok', true, 'plan', p_plan, 'period', p_period,
    'promo', jsonb_build_object('amount_cents', p_amount_cents, 'event', p_event,
                                'ends_at', p_ends_at, 'label', v_label, 'cycles', p_cycles));
end; $$;
revoke all on function public.admin_billing_promo_set(text, text, int, text, timestamptz, text, int) from public, anon, authenticated;
grant execute on function public.admin_billing_promo_set(text, text, int, text, timestamptz, text, int) to authenticated, service_role;
