-- Tier-2 lifecycle: remind users 3 days before their free trial ends (anti-churn).
-- Matches on the exact day (trial_ends_at::date = today+3) so it fires once per trial
-- with NO dedup column needed. Dormant until resend_api_key Vault secret is set.
-- (Renewal/expiry reminders for paid subs are deferred until non-trial sub statuses
-- exist — today the only status is 'trialing' — to avoid mis-sending.)

create or replace function public.norva_send_trial_ending_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select u.email
    from public.cloud_entitlement_projection e
    join auth.users u on u.id = e.user_id
    where e.status = 'trialing'
      and e.trial_ends_at is not null
      and e.trial_ends_at::date = (current_date + 3)
      and u.email is not null
  loop
    perform public.norva_send_branded_email(
      r.email,
      'Your Norva free trial ends in 3 days',
      'Your trial ends soon',
      'Your Norva free trial ends in 3 days. Keep your catalogue, offline downloads and cross-device sync by subscribing before it expires.',
      'Manage my subscription', 'https://norva.tv/app#settings',
      'You can manage or cancel your subscription anytime from Settings.');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.norva_send_trial_ending_reminders() from public, anon, authenticated;

select cron.schedule('norva-trial-ending', '0 9 * * *', 'select public.norva_send_trial_ending_reminders();');