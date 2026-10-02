begin;
set local lock_timeout='3s';
alter table public.admin_alert_delivery_state add column if not exists healthy_since timestamptz;
notify pgrst, 'reload schema';
commit;
