-- Provider-correct, idempotent trial-ending reminders.
--
-- The 20260708120000 sender addressed every `trialing` projection with copy that
-- said the user would never be charged automatically. That is false for the
-- Revolut card-backed trial, and store trials must be left to their store. This
-- replacement therefore has two explicit cohorts only:
--   * revolut       -> auto-renew/cancel-before-renewal copy;
--   * manual/system -> manual-subscribe/no-automatic-charge copy.
-- RevenueCat/Play/Apple and unknown providers are deliberately not selected.
--
-- One immutable row per (user, trial instance, offset) prevents duplicate J-3
-- or J-1 sends after retries/manual cron runs. The projection marker is also
-- latched before queueing the email: it is the CAS marker used by the retired
-- Edge J-2 path, so even an accidentally stale Edge deployment cannot race this
-- transaction and send another trial reminder.

create table if not exists public.cloud_trial_reminder_deliveries (
  user_id uuid not null references auth.users(id) on delete cascade,
  trial_ends_at timestamptz not null,
  days_before smallint not null check (days_before in (1, 3)),
  provider text not null check (provider in ('revolut', 'manual', 'system')),
  queued_at timestamptz not null default clock_timestamp(),
  primary key (user_id, trial_ends_at, days_before)
);

comment on table public.cloud_trial_reminder_deliveries is
  'Transactional dedup ledger for provider-correct DB trial reminders; one row per user/trial/offset.';

alter table public.cloud_trial_reminder_deliveries enable row level security;
revoke all on table public.cloud_trial_reminder_deliveries from public, anon, authenticated;
grant select, insert, update, delete on table public.cloud_trial_reminder_deliveries to service_role;

create or replace function public.norva_send_trial_ending_reminders(p_days_before int)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  r record;
  v_claimed_user_id uuid;
  v_count integer := 0;
  v_when text;
  v_subject text;
  v_heading text;
  v_intro text;
  v_cta_label text;
  v_cta_url text;
  v_footer text;
begin
  -- Only the two scheduled offsets are part of the public contract. A typo or
  -- manual call cannot create an unexpected lifecycle campaign.
  if p_days_before not in (1, 3) then
    return 0;
  end if;

  -- Do not burn a dedup key while the transport is deliberately dormant.
  if not exists (
    select 1
    from vault.decrypted_secrets s
    where s.name = 'resend_api_key'
      and nullif(btrim(s.decrypted_secret), '') is not null
  ) then
    return 0;
  end if;

  v_when := case when p_days_before = 1 then 'tomorrow' else 'in 3 days' end;

  for r in
    select e.user_id, e.provider, e.trial_ends_at, u.email
    from public.cloud_entitlement_projection e
    join auth.users u on u.id = e.user_id
    where e.status = 'trialing'
      and e.provider in ('revolut', 'manual', 'system')
      and e.trial_ends_at is not null
      and (e.trial_ends_at at time zone 'UTC')::date =
          (clock_timestamp() at time zone 'UTC')::date + p_days_before
      and nullif(btrim(u.email::text), '') is not null
      and not exists (
        select 1
        from public.admin_internal_accounts a
        where a.user_id = e.user_id
      )
    order by e.trial_ends_at, e.user_id
    for update of e skip locked
  loop
    v_claimed_user_id := null;
    insert into public.cloud_trial_reminder_deliveries (
      user_id, trial_ends_at, days_before, provider
    ) values (
      r.user_id, r.trial_ends_at, p_days_before, r.provider
    )
    on conflict (user_id, trial_ends_at, days_before) do nothing
    returning user_id into v_claimed_user_id;

    if v_claimed_user_id is null then
      continue;
    end if;

    -- Belt-and-suspenders exclusion under the row lock: if the account became
    -- internal after the candidate query, discard the claim and never queue.
    if exists (
      select 1 from public.admin_internal_accounts a where a.user_id = r.user_id
    ) then
      delete from public.cloud_trial_reminder_deliveries d
      where d.user_id = r.user_id
        and d.trial_ends_at = r.trial_ends_at
        and d.days_before = p_days_before;
      continue;
    end if;

    -- The old Edge J-2 flow claims this same marker. Latch it inside the locked
    -- transaction before pg_net is queued, so Edge can never win a concurrent CAS.
    update public.cloud_entitlement_projection e
    set trial_reminder_email_at = coalesce(e.trial_reminder_email_at, clock_timestamp())
    where e.user_id = r.user_id
      and e.status = 'trialing'
      and e.trial_ends_at = r.trial_ends_at;

    if r.provider = 'revolut' then
      v_subject := 'Your Norva free trial ends ' || v_when;
      v_heading := case when p_days_before = 1 then 'Your trial ends tomorrow' else 'Your trial ends in 3 days' end;
      v_intro := 'Your Norva free trial ends ' || v_when ||
        '. Your subscription will renew automatically when the trial ends, so your access continues without interruption. ' ||
        'Nothing to do if you want to keep watching. You can cancel before renewal and you will not be charged.';
      v_cta_label := 'Manage my plan';
      v_cta_url := 'https://norva.tv/subscription.html';
      v_footer := 'Cancel anytime from Settings before the trial ends. Questions? support@norva.tv.';
    else
      v_subject := 'Your Norva trial access ends ' || v_when;
      v_heading := case when p_days_before = 1 then 'Your trial access ends tomorrow' else 'Your trial access ends in 3 days' end;
      v_intro := 'Your Norva trial access ends ' || v_when ||
        '. This trial will not renew automatically and no automatic charge will be made. ' ||
        'Choose a plan if you would like to keep watching after it ends.';
      v_cta_label := 'See plans';
      v_cta_url := 'https://norva.tv/subscribe.html';
      v_footer := 'No automatic charge will be made for this trial. Questions? support@norva.tv.';
    end if;

    perform public.norva_send_branded_email(
      r.email::text,
      v_subject,
      v_heading,
      v_intro,
      v_cta_label,
      v_cta_url,
      v_footer
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke all on function public.norva_send_trial_ending_reminders(int)
  from public, anon, authenticated;
grant execute on function public.norva_send_trial_ending_reminders(int)
  to service_role;

-- cron.schedule is an upsert by job name: this replaces the existing definitions
-- without ever creating a second J-3/J-1 job.
select cron.schedule(
  'norva-trial-ending-3d',
  '0 9 * * *',
  'select public.norva_send_trial_ending_reminders(3);'
);
select cron.schedule(
  'norva-trial-ending-1d',
  '15 9 * * *',
  'select public.norva_send_trial_ending_reminders(1);'
);
