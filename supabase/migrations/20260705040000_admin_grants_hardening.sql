-- Admin dashboard/CRM security hardening (audit 2026-07-05).
-- Defense-in-depth on the admin surface: lock the SECURITY DEFINER read/write RPCs and the
-- admin_* / cloud_support_* tables to the roles that actually need them. None of these was
-- exploitable on its own (the RPCs gate on is_admin(); the tables have RLS with no policy so
-- anon/authenticated get zero rows) — this removes the redundant standing grants so the
-- security no longer rests on a single control, matching the tighter posture already used on
-- cloud_runtime_config / provider_identities.

-- (1) refresh_admin_dashboard() — HIGH: SECURITY DEFINER, no is_admin gate, 180s/64MB full-DB
-- aggregate, was anon-callable → unauthenticated scriptable DoS. Already revoked live during the
-- audit; recorded here so it survives any future recreation. Only the pg_cron (postgres) and
-- service_role need it.
revoke execute on function public.refresh_admin_dashboard() from anon, authenticated;

-- (2) The four cache-read RPCs are is_admin()-gated, so anon EXECUTE was a dead grant. Bring
-- them in line with the rest of the admin_* functions: authenticated only.
do $$
declare fn text;
begin
  foreach fn in array array['admin_overview()','admin_sources()','admin_cron_health()','admin_enrichment_coverage()']
  loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

-- (3) Standing table grants → revoked from anon + authenticated. The admin RPCs are SECURITY
-- DEFINER (owned by postgres) so they keep full access; nothing else should touch these tables
-- directly. RLS-with-no-policy already denied rows — this drops the grant too (belt + braces).
do $$
declare t text;
begin
  foreach t in array array[
    'admin_dashboard_cache','admin_notes','admin_feature_flags','admin_tags','admin_client_tags',
    'admin_internal_accounts','admin_events','admin_alert_state','admin_enrichment_accounts',
    'cloud_support_tickets','cloud_support_messages']
  loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

-- (4) Last-admin protection for norva-admin (audit LOW): the edge already blocks an admin from
-- demoting/suspending THEIR OWN account, but two admins could demote each other. This lets the
-- edge refuse an action that would drop the active-admin count to zero. service_role only (the
-- edge's admin client); never exposed to the API roles.
create or replace function public.admin_count_active()
returns integer
language sql
security definer
set search_path = public, auth
stable
as $$
  select count(*)::int
  from auth.users u
  where (u.raw_app_meta_data->>'role') = 'admin'
    and (u.banned_until is null or u.banned_until < now());
$$;
comment on function public.admin_count_active() is
  'Audit 2026-07-05: active (non-banned) admin count, for norva-admin last-admin protection.';
revoke all on function public.admin_count_active() from public, anon, authenticated;
grant execute on function public.admin_count_active() to service_role;
