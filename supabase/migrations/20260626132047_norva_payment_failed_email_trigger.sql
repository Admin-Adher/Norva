-- Tier-1 revenue: when the billing webhook flags a payment problem (it sets
-- status='past_due' on RevenueCat BILLING_ISSUE, with a 72h grace window), email the
-- user to update their payment method. A DB trigger on the entitlement projection keeps
-- it consistent with the other emails (no webhook edit) and self-dedupes on the
-- transition into past_due. Dormant until the resend_api_key Vault secret is set.

create or replace function public.norva_notify_payment_failed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_email text;
begin
  if new.status <> 'past_due' then return new; end if;
  -- only on the transition INTO past_due (don't re-notify on repeated BILLING_ISSUE events)
  if tg_op = 'UPDATE' and old.status is not distinct from 'past_due' then return new; end if;
  select email into user_email from auth.users where id = new.user_id;
  if user_email is null then return new; end if;
  perform public.norva_send_branded_email(
    user_email,
    'Action needed: your Norva payment failed',
    'There was a problem with your payment',
    'We couldn''t process the payment for your Norva subscription. Your access stays active for a short grace period — please update your payment method to avoid any interruption.',
    'Update payment', 'https://norva.tv/app#settings',
    'Already fixed it? You can safely ignore this email.');
  return new;
end;
$$;
revoke all on function public.norva_notify_payment_failed() from public, anon, authenticated;

drop trigger if exists norva_payment_failed_trg on public.cloud_entitlement_projection;
create trigger norva_payment_failed_trg
  after insert or update of status on public.cloud_entitlement_projection
  for each row execute function public.norva_notify_payment_failed();