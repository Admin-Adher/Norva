-- Fiche refund button: expose a per-payment `refundable` flag so the CRM only offers
-- "Rembourser" on rows that actually carry an authoritative Stancer payment id
-- (provider_payment_id). The raw paym_ id stays server-side; only the boolean crosses.
-- Verbatim re-emission of admin_user_billing from 20260705110000 with that one addition.

create or replace function public.admin_user_billing(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'projection', (select to_jsonb(t) from (
      select status, provider, plan_code, trial_ends_at, trial_consumed_at, current_period_end,
             dunning_stage, dunning_last_at, last_event_at, mrr_cents, bill_period,
             welcome_email_at, trial_reminder_email_at, winback_email_at
      from cloud_entitlement_projection where user_id = p_user_id
    ) t),
    'mapping', (select to_jsonb(t) from (
      select plan, period, amount_cents, card_last4, card_exp, discount_next_pct, save_offer_used_at
      from cloud_stancer_customers where user_id = p_user_id
    ) t),
    'payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select pi_id, kind, amount, currency, coalesce(provider, 'stancer') as provider, status,
             (provider_payment_id is not null) as refundable,
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
