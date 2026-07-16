-- =============================================================================
-- Comptes internes = plan family, durée indéterminée (VIP permanent) — invariant.
-- =============================================================================
-- Sur demande du propriétaire : TOUS les comptes test internes doivent être en plan
-- `family` avec une période indéterminée (accès VIP permanent) et ne JAMAIS être
-- facturés. Le backfill d'origine (20260704010000 A2) l'a fait une fois mais :
--   • excluait le rail Stancer (désormais retiré/obsolète → l'exclusion ne sert plus) ;
--   • le toggle fiche (admin_internal_toggle) ne posait QUE le tag, sans accorder
--     l'entitlement VIP → un compte marqué interne après coup restait sur son rail
--     (ex. un trial Revolut continuait vers la conversion).
--
-- Ici on (1) re-backfill TOUS les comptes internes courants en system/active/family/2099
-- et (2) on rend l'invariant durable : marquer un compte interne accorde désormais
-- l'accès VIP family permanent + coupe toute facturation (rail 'system').
-- =============================================================================

-- ── (1) Backfill : tous les comptes internes → family / durée indéterminée ───────────
update public.cloud_entitlement_projection p
set status = 'active', plan_code = 'family', provider = 'system',
    current_period_end = '2099-01-01T00:00:00Z', trial_ends_at = null,
    mrr_cents = null, bill_period = null, last_event_at = now()
where p.user_id in (select user_id from public.admin_internal_accounts);

-- Comptes internes sans projection encore → en créer une VIP.
insert into public.cloud_entitlement_projection (user_id, status, provider, plan_code, current_period_end, last_event_at)
select a.user_id, 'active', 'system', 'family', '2099-01-01T00:00:00Z', now()
from public.admin_internal_accounts a
where not exists (select 1 from public.cloud_entitlement_projection p where p.user_id = a.user_id);

-- ── (2) admin_internal_toggle : marquer interne accorde le VIP family permanent ──────
-- Base : re-emission de 20260704010000 A3 avec l'octroi de l'entitlement VIP en plus.
create or replace function public.admin_internal_toggle(p_user_id uuid, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_on then
    insert into admin_internal_accounts (user_id, note) values (p_user_id, 'marqué depuis la fiche')
    on conflict (user_id) do nothing;
    -- Un compte interne = compte test du propriétaire → accès VIP permanent (family, durée
    -- indéterminée) ET plus aucune facturation (rail 'system'). Marquer interne coupe donc
    -- une éventuelle conversion de trial Revolut en cours.
    -- ⚠️ Ne PAS marquer interne un vrai client payant : ça écrase son abonnement réel en VIP.
    insert into public.cloud_entitlement_projection
      (user_id, status, provider, plan_code, current_period_end, trial_ends_at, mrr_cents, bill_period, last_event_at)
    values (p_user_id, 'active', 'system', 'family', '2099-01-01T00:00:00Z', null, null, null, now())
    on conflict (user_id) do update set
      status = 'active', provider = 'system', plan_code = 'family',
      current_period_end = '2099-01-01T00:00:00Z', trial_ends_at = null,
      mrr_cents = null, bill_period = null, last_event_at = now();
  else
    delete from admin_internal_accounts where user_id = p_user_id;
    -- On NE rétrograde PAS l'entitlement (éviter de couper l'accès par erreur) : l'admin
    -- ajuste le statut via le rail normal si le compte doit repasser payant.
  end if;
  insert into admin_events (user_id, kind, summary, actor)
  values (p_user_id, 'admin_action',
          case when p_on then 'Compte marqué INTERNE (VIP family permanent · exclu des stats)'
               else 'Compte retiré des comptes internes' end,
          nullif(auth.jwt() ->> 'email', ''));
  return jsonb_build_object('internal', p_on);
end; $$;
revoke all on function public.admin_internal_toggle(uuid, boolean) from public, anon;
grant execute on function public.admin_internal_toggle(uuid, boolean) to authenticated;
