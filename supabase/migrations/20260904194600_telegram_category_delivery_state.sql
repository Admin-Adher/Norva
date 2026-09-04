begin;
create table public.admin_alert_delivery_state (
  category text not null check(category in ('infrastructure','catalogue','finance','partners','support','growth')),
  channel text not null check(channel in ('telegram','email')),
  key text not null,
  details text not null,
  last_alerted_at timestamptz not null,
  primary key(category,channel,key)
);
alter table public.admin_alert_delivery_state enable row level security;
revoke all on public.admin_alert_delivery_state from public,anon,authenticated;
grant all on public.admin_alert_delivery_state to service_role;
-- Existing incidents were delivered by the legacy Telegram bot. Preserve their
-- cooldowns; new recoveries go to the relevant category. No email ack is invented.
insert into public.admin_alert_delivery_state(category,channel,key,details,last_alerted_at)
select case when key like 'partners_%' then 'partners'
  when key ~ '^(sources_|lid_|gateway_|relay_)' then 'catalogue'
  when key ~ '^(billing_|revolut_|vat_)' then 'finance'
  when key like 'support_%' then 'support' else 'infrastructure' end,
  'telegram',key,coalesce(details,key),last_alerted_at from public.admin_alert_state
on conflict do nothing;
notify pgrst, 'reload schema';
commit;
