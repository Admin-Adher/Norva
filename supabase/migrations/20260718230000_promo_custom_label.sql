-- Libellé de badge personnalisé pour les promos (2026-07-18, suite du Lot 8).
--
-- Demande produit : l'événement « Autre » doit pouvoir être NOMMÉ (événement
-- propre à Norva, ex. « Norva Days ») — ce libellé devient le badge affiché sur
-- la page de vente. Le libellé est accepté pour tout événement (il PRIME alors
-- sur le libellé standard du badge), mais l'UI admin ne le propose que pour
-- « Autre ».
--
-- admin_billing_promo_set gagne p_label — SIGNATURE ÉTENDUE ⇒ DROP de
-- l'ancienne (surcharge ambiguë PostgREST) ⇒ ⚠ NOTIFY pgrst requis.
-- admin_billing_prices ré-émise (signature inchangée) avec promo_label.
-- Idempotent. supabase_admin.

alter table public.billing_prices
  add column if not exists promo_label text;
comment on column public.billing_prices.promo_label is
  'Libellé personnalisé du badge promo (2..24 caractères). Prioritaire sur le libellé standard de l''événement ; pensé pour promo_event=''other'' (événement propre à Norva).';

create or replace function public.admin_billing_prices()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'plan', plan, 'period', period, 'amount_cents', amount_cents,
            'promo_amount_cents', promo_amount_cents, 'promo_event', promo_event,
            'promo_label', promo_label, 'promo_ends_at', promo_ends_at,
            'promo_active', (promo_amount_cents is not null and (promo_ends_at is null or promo_ends_at > now())),
            'updated_at', updated_at) order by plan, period), '[]'::jsonb)
          from public.billing_prices);
end; $$;
revoke all on function public.admin_billing_prices() from public, anon, authenticated;
grant execute on function public.admin_billing_prices() to authenticated, service_role;

drop function if exists public.admin_billing_promo_set(text, text, int, text, timestamptz);

create or replace function public.admin_billing_promo_set(
  p_plan text, p_period text,
  p_amount_cents int default null, p_event text default null,
  p_ends_at timestamptz default null, p_label text default null
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
           promo_label = null, updated_at = now()
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
         promo_ends_at = p_ends_at, promo_label = v_label, updated_at = now()
   where plan = p_plan and period = p_period;
  return jsonb_build_object('ok', true, 'plan', p_plan, 'period', p_period,
    'promo', jsonb_build_object('amount_cents', p_amount_cents, 'event', p_event,
                                'ends_at', p_ends_at, 'label', v_label));
end; $$;
revoke all on function public.admin_billing_promo_set(text, text, int, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.admin_billing_promo_set(text, text, int, text, timestamptz, text) to authenticated, service_role;
