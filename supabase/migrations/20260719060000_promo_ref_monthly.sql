-- Ancre marketing « 12 × mensuel » pour les promos ANNUELLES (demande produit).
--
-- Problème : une promo annuelle comparée au prix annuel de base paraît faible
-- (ex. 34,99 vs 41,99 = −17 %) parce que la base annuelle inclut DÉJÀ la remise
-- structurelle annuelle. Comparée à ce que paierait un abonné mensuel sur un an
-- (12 × 4,99 = 59,88), la même promo vaut −42 % — bien plus vendeur.
--
-- Cadre légal (L112-1-1 / Omnibus) : afficher 59,88 comme « ancien prix » barré
-- serait un FAUX prix de référence. En revanche, comparer deux offres ACTUELLES
-- (« vs facturation mensuelle ») est licite — c'est le framing SaaS standard du
-- badge « Save 30% ». Le front affiche donc l'ancre 12× mensuel UNIQUEMENT avec
-- le qualificatif « billed monthly / vs monthly billing », jamais en prix barré nu.
--
-- Mécanique : billing_prices.promo_ref_monthly (annuel seulement) ; l'edge
-- calcule promos.annual.ref_cents = 12 × base mensuelle du même plan (émis
-- seulement s'il dépasse la base annuelle — sinon l'ancre n'amplifie rien).
-- Purement AFFICHAGE : les montants facturés/stampés (checkout metadata,
-- mapping, cron) ne changent pas.
--
-- admin_billing_promo_set gagne p_ref_monthly — SIGNATURE ÉTENDUE ⇒ DROP de
-- l'ancienne 7 args ⇒ ⚠ NOTIFY pgrst requis (+ nouvelle colonne lue via REST).
-- Idempotent. supabase_admin.

alter table public.billing_prices
  add column if not exists promo_ref_monthly boolean not null default false;
comment on column public.billing_prices.promo_ref_monthly is
  'Annuel seulement : la promo se compare a 12 x le prix mensuel de base (affiche « vs monthly billing ») au lieu du prix annuel de base. Affichage uniquement.';

-- ── Lecture admin : ré-émission avec promo_ref_monthly (signature inchangée) ────
create or replace function public.admin_billing_prices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'plan', plan, 'period', period, 'amount_cents', amount_cents,
            'promo_amount_cents', promo_amount_cents, 'promo_event', promo_event,
            'promo_label', promo_label, 'promo_ends_at', promo_ends_at,
            'promo_cycles', promo_cycles, 'promo_ref_monthly', promo_ref_monthly,
            'promo_active', (promo_amount_cents is not null and (promo_ends_at is null or promo_ends_at > now())),
            'updated_at', updated_at) order by plan, period), '[]'::jsonb)
          from public.billing_prices);
end; $$;
revoke all on function public.admin_billing_prices() from public, anon, authenticated;
grant execute on function public.admin_billing_prices() to authenticated, service_role;

-- ── Écriture promo : signature étendue (p_ref_monthly) ⇒ DROP ancienne ──────────
drop function if exists public.admin_billing_promo_set(text, text, int, text, timestamptz, text, int);

create or replace function public.admin_billing_promo_set(
  p_plan text, p_period text,
  p_amount_cents int default null, p_event text default null,
  p_ends_at timestamptz default null, p_label text default null,
  p_cycles int default null, p_ref_monthly boolean default false
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_base int; v_label text; v_ref boolean;
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
           promo_label = null, promo_cycles = null, promo_ref_monthly = false, updated_at = now()
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
  v_ref := coalesce(p_ref_monthly, false);
  if v_ref and p_period <> 'annual' then
    raise exception 'ref-monthly anchor is annual-only' using errcode = '22023';
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
         promo_cycles = p_cycles, promo_ref_monthly = v_ref, updated_at = now()
   where plan = p_plan and period = p_period;
  return jsonb_build_object('ok', true, 'plan', p_plan, 'period', p_period,
    'promo', jsonb_build_object('amount_cents', p_amount_cents, 'event', p_event,
                                'ends_at', p_ends_at, 'label', v_label, 'cycles', p_cycles,
                                'ref_monthly', v_ref));
end; $$;
revoke all on function public.admin_billing_promo_set(text, text, int, text, timestamptz, text, int, boolean) from public, anon, authenticated;
grant execute on function public.admin_billing_promo_set(text, text, int, text, timestamptz, text, int, boolean) to authenticated, service_role;
