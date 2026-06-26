-- Tier-3 subscription-lifecycle emails: confirm/win-back as a user's billing
-- status changes. One trigger on the entitlement projection, a CASE per status,
-- each firing only on the actual transition INTO that status (so renewals, which
-- re-write status='active' unchanged, never re-send). Additive alongside the
-- Tier-1 payment-failed trigger (this one ignores past_due). Exception-guarded so
-- an email hiccup can never block a billing update. All sends go through the
-- shared norva_send_branded_email helper and stay DORMANT until the resend_api_key
-- Vault secret is set.
--
-- Statuses written by norva-billing-webhook (statusForEvent):
--   active                   INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE (paid)
--   cancelled_at_period_end  CANCELLATION (still entitled until current_period_end)
--   expired                  EXPIRATION
--   grace                    SUBSCRIPTION_PAUSED
--   past_due                 BILLING_ISSUE  -> handled by norva_notify_payment_failed
--   trialing                 (trial period) -> no lifecycle email here

create or replace function public.norva_notify_subscription_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_email text;
  ends_txt text := '';
begin
  begin
    -- Only act on a genuine change of the status value (an UPDATE that re-writes
    -- the same status — e.g. a renewal staying 'active' — must not re-send).
    if tg_op = 'UPDATE' and old.status is not distinct from new.status then
      return new;
    end if;

    -- past_due is owned by norva_notify_payment_failed; trialing has no email.
    if new.status not in ('active','cancelled_at_period_end','expired','grace') then
      return new;
    end if;

    select email into user_email from auth.users where id = new.user_id;
    if user_email is null then return new; end if;

    if new.status = 'active' then
      perform public.norva_send_branded_email(
        user_email,
        'Your Norva subscription is active',
        'You''re all set',
        'Your Norva subscription is active. Enjoy your full catalogue, offline downloads, and sync across the web, your phone and your TV.',
        'Open Norva', 'https://norva.tv/app',
        'Manage your subscription anytime from Settings.');

    elsif new.status = 'cancelled_at_period_end' then
      if new.current_period_end is not null then
        ends_txt := ' Your access stays active until '
          || to_char(new.current_period_end at time zone 'UTC', 'FMMonth FMDD, YYYY') || '.';
      end if;
      perform public.norva_send_branded_email(
        user_email,
        'Your Norva subscription was cancelled',
        'Your subscription is cancelled',
        'Your Norva subscription won''t renew.' || ends_txt
          || ' Changed your mind? You can reactivate anytime and keep everything just as it was.',
        'Reactivate my subscription', 'https://norva.tv/app#settings',
        'If you didn''t cancel this yourself, please contact support.');

    elsif new.status = 'expired' then
      perform public.norva_send_branded_email(
        user_email,
        'Your Norva subscription has ended',
        'We''d love to have you back',
        'Your Norva subscription has ended, so premium access is now switched off. Resubscribe to pick up right where you left off — your catalogue and settings are still saved.',
        'Resubscribe', 'https://norva.tv/app#settings',
        'Not ready yet? No problem — you can ignore this email.');

    elsif new.status = 'grace' then
      perform public.norva_send_branded_email(
        user_email,
        'Your Norva subscription is paused',
        'Your subscription is paused',
        'Your Norva subscription is currently paused, so premium features are on hold. You can resume anytime to get instant access again.',
        'Resume my subscription', 'https://norva.tv/app#settings',
        'If you didn''t request this, please contact support.');
    end if;
  exception when others then null;  -- email must never block a billing update
  end;
  return new;
end;
$$;
revoke all on function public.norva_notify_subscription_lifecycle() from public, anon, authenticated;

drop trigger if exists norva_subscription_lifecycle_trg on public.cloud_entitlement_projection;
create trigger norva_subscription_lifecycle_trg
  after insert or update of status on public.cloud_entitlement_projection
  for each row execute function public.norva_notify_subscription_lifecycle();