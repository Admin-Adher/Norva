-- Trial-ending email reminders (anti-churn, transparent): nudge trialing users
-- 3 days AND 1 day before their free trial ends. The in-app surface is now an
-- ambient header chip (no prominent "manage/cancel" pill), so the real reminder
-- lives in email — matching how premium streaming apps handle trials.
--
-- One parameterized function fires per offset; matching on the exact day
-- (trial_ends_at::date = current_date + N) makes it fire once per trial per
-- offset with NO dedup column needed. Internal/test accounts are excluded.
-- Sends through public.norva_send_branded_email, which is live (resend_api_key
-- is set in Vault) and self-mutes if the key is ever removed.

create or replace function public.norva_send_trial_ending_reminders(p_days_before int)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
  v_when text;
  v_subject text;
  v_heading text;
  v_intro text;
begin
  if p_days_before is null or p_days_before < 0 then
    return 0;
  end if;

  v_when := case
    when p_days_before = 0 then 'today'
    when p_days_before = 1 then 'tomorrow'
    else 'in ' || p_days_before || ' days'
  end;
  v_subject := 'Your Norva free trial ends ' || v_when;
  v_heading := case when p_days_before <= 1 then 'Last day of your trial' else 'Your trial ends soon' end;
  v_intro := 'Your Norva free trial ends ' || v_when ||
    '. Subscribe before then to keep your catalogue, offline downloads and cross-device sync — '
    || 'you''re never charged automatically.';

  for r in
    select u.email
    from public.cloud_entitlement_projection e
    join auth.users u on u.id = e.user_id
    where e.status = 'trialing'
      and e.trial_ends_at is not null
      and e.trial_ends_at::date = (current_date + p_days_before)
      and coalesce(u.email, '') <> ''
      and not exists (
        select 1 from public.admin_internal_accounts a where a.user_id = e.user_id
      )
  loop
    perform public.norva_send_branded_email(
      r.email,
      v_subject,
      v_heading,
      v_intro,
      'See plans', 'https://norva.tv/subscribe.html',
      'You can manage or cancel anytime from Settings. You''re never charged automatically.');
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.norva_send_trial_ending_reminders(int) from public, anon, authenticated;

-- Two daily crons, staggered a few minutes apart. Each targets a different
-- offset, so a given trial gets at most one 3-day and one 1-day reminder.
select cron.schedule('norva-trial-ending-3d', '0 9 * * *',  'select public.norva_send_trial_ending_reminders(3);');
select cron.schedule('norva-trial-ending-1d', '15 9 * * *', 'select public.norva_send_trial_ending_reminders(1);');
