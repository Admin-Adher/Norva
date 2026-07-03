-- ONE email system only: the norva-lifecycle edge cron (welcome, trial J-2 reminder,
-- dunning, win-back) is now the single sender for billing-lifecycle emails. The
-- 2026-06-26 DB-trigger/pg_cron generation overlapped it (double-welcome risk, J-3 vs
-- J-2 duplicate, competing past_due/status emails) — retire it.
--
-- Kept on purpose: the SECURITY email triggers (password changed / email changed /
-- new device, 20260626131841) and the shared helper norva_send_branded_email they use.

-- 1) Welcome-on-confirm trigger (overlapped norva-lifecycle's always-on runWelcome).
drop trigger if exists norva_send_welcome_email_trg on auth.users;
drop function if exists public.norva_send_welcome_email();

-- 2) Trial-ending J-3 daily cron (superseded by the J-2 renderTrialEnding window).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'norva-trial-ending') then
    perform cron.unschedule('norva-trial-ending');
  end if;
end $$;
drop function if exists public.norva_send_trial_ending_reminders();

-- 3) past_due email trigger (superseded by staged dunning in norva-lifecycle).
drop trigger if exists norva_payment_failed_trg on public.cloud_entitlement_projection;
drop function if exists public.norva_notify_payment_failed();

-- 4) Subscription status-change emails (superseded by receipt-on-charge + win-back).
drop trigger if exists norva_subscription_lifecycle_trg on public.cloud_entitlement_projection;
drop function if exists public.norva_notify_subscription_lifecycle();
