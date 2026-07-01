-- Proactive ops alerting — the admin gets EMAILED when something breaks instead of having to open
-- the dashboard. A pg_cron sweep (every 15 min) POSTs norva-admin/ops-alert (backfill token), which:
--   • reads the cached overview counters (free) + pings gateway/relay (live),
--   • applies a 6h per-key cooldown via admin_alert_state (row deleted the moment a condition heals,
--     so a NEW occurrence alerts immediately),
--   • emails every admin (app_metadata.role='admin') through Resend.
-- Conditions: snapshot_stale (>20 min), sources_error, sources_incomplete, cron_fails_24h,
-- gateway_down, relay_down.

create table if not exists public.admin_alert_state (
  key             text primary key,
  last_alerted_at timestamptz not null default now(),
  details         text
);
alter table public.admin_alert_state enable row level security;  -- service-role only (no policies)

-- Admin recipients: emails of every app_metadata.role='admin' account. SECURITY DEFINER because it
-- reads auth.users; revoked from every client role — only the service role (edge) can call it, so
-- admin emails are not enumerable from the browser.
create or replace function public.admin_alert_recipients()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(u.email::text), '{}')
  from auth.users u
  where u.raw_app_meta_data ->> 'role' = 'admin' and u.email is not null;
$$;
revoke all on function public.admin_alert_recipients() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'norva-ops-alert') then
    perform cron.schedule(
      'norva-ops-alert',
      '*/15 * * * *',
      $job$
  select net.http_post(
    url:='https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-admin/ops-alert',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='norva_backfill_token')),
    body:='{}'::jsonb,
    timeout_milliseconds:=30000);
      $job$
    );
  end if;
end $$;
