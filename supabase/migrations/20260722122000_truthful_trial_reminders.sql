-- Keep trial-ending emails aligned with the real automatic-renewal contract.
-- The 20260708 function incorrectly said that customers were never charged
-- automatically even though both supported billing rails renew unless cancelled.

create or replace function public.norva_send_trial_ending_reminders(p_days_before int)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  r record;
  n int := 0;
  v_when text;
  v_subject text;
  v_heading text;
  v_date text;
  v_price text;
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

  for r in
    select
      u.email,
      e.trial_ends_at,
      e.mrr_cents,
      e.bill_period,
      upper(coalesce(e.billing_currency, 'USD')) as billing_currency
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
    v_date := to_char(r.trial_ends_at at time zone 'UTC', 'FMMonth FMDD, YYYY');
    v_price := case
      when coalesce(r.mrr_cents, 0) > 0 then
        (case when r.billing_currency = 'USD' then 'US$' else r.billing_currency || ' ' end)
        || to_char(r.mrr_cents::numeric / 100, 'FM999999990.00')
        || case when r.bill_period = 'annual' then '/year' else '/month' end
      else 'the price shown when you started your trial'
    end;
    v_intro := 'Your Norva free trial ends on ' || v_date ||
      '. Unless you cancel before then, your selected plan will start automatically at ' ||
      v_price || ' and renew until cancelled.';

    perform public.norva_send_branded_email(
      r.email,
      v_subject,
      v_heading,
      v_intro,
      'Manage your plan', 'https://norva.tv/subscription.html',
      'You can manage or cancel your subscription online at any time from Norva Settings.');
    n := n + 1;
  end loop;
  return n;
end;
$function$;

revoke all on function public.norva_send_trial_ending_reminders(int) from public, anon, authenticated;
grant execute on function public.norva_send_trial_ending_reminders(int) to service_role;

notify pgrst, 'reload schema';
