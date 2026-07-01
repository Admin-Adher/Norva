-- Admin dashboard MVP — Ops (Health / Providers / Enrichment).
--
-- Access model: role lives in auth JWT `app_metadata.role` (server-set, non-spoofable). The
-- frontend calls these RPCs directly via PostgREST with the user's bearer token; each RPC is
-- SECURITY DEFINER (so it can read auth.users + the cron schema) and gates on is_admin() at the
-- top. A non-admin token → exception; the client-side nav gating is UX only, this is the real
-- enforcement. No edge function needed (works while edge deploys are down).

-- ── gate ─────────────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;
comment on function public.is_admin() is
  'True when the caller''s JWT carries app_metadata.role = admin. Gate for all admin RPCs.';

-- ── audit log (for future write actions) ─────────────────────────────────────
create table if not exists public.admin_audit_log (
  id          bigint generated always as identity primary key,
  actor       uuid,                 -- auth.uid() of the admin who acted
  action      text not null,        -- e.g. 'resync_source', 'grant_admin'
  target      text,                 -- free-form target id (source_id, user_id…)
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
alter table public.admin_audit_log enable row level security;
-- No policies → locked to service-role / SECURITY DEFINER writers only (never client-readable raw).

-- ── 1. Overview / health KPIs ────────────────────────────────────────────────
create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select jsonb_build_object(
    'users_total',       (select count(*) from auth.users),
    'users_active_7d',   (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'sources_total',     (select count(*) from cloud_sources),
    'sources_error',     (select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
    'sources_incomplete',(select count(*) from cloud_sources s
                            where exists (select 1 from cloud_media_items m where m.source_id = s.id)
                              and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)),
    'titles_movie',      (select count(*) from cloud_titles where item_type = 'movie'  and variant_count > 0),
    'titles_series',     (select count(*) from cloud_titles where item_type = 'series' and variant_count > 0),
    'identities_active', (select count(*) from provider_identities where status = 'active'),
    'gensubs_ready',     (select count(*) from catalog_generated_subtitles where status = 'ready'),
    'gensubs_processing',(select count(*) from catalog_generated_subtitles where status = 'processing'),
    'gensubs_failed',    (select count(*) from catalog_generated_subtitles where status = 'failed'),
    'cron_active',       (select count(*) from cron.job where active),
    'cron_paused',       (select count(*) from cron.job where not active),
    'cron_fails_24h',    (select count(*) from cron.job_run_details
                            where status <> 'succeeded' and start_time > now() - interval '24 hours'),
    'generated_at',      now()
  ) into result;
  return result;
end;
$$;

-- ── 2. Providers / sources (per-source ops, incomplete-sync detector) ────────
create or replace function public.admin_sources()
returns table(
  source_id uuid, owner_email text, display_name text,
  sync_status text, sync_error text, catalog_version int,
  created_at timestamptz, last_synced_at timestamptz,
  media_items bigint, variants bigint, movie_titles bigint, series_titles bigint,
  incomplete boolean, identity_id uuid, identity_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select s.id, u.email::text, coalesce(s.display_name, left(s.id::text, 8)),
           s.sync_status, s.sync_error, s.catalog_version,
           s.created_at, s.last_synced_at,
           (select count(*) from cloud_media_items m where m.source_id = s.id),
           (select count(*) from cloud_title_variants v where v.source_id = s.id),
           (select count(*) from cloud_titles t join cloud_title_variants v on v.id = t.default_variant_id
              where v.source_id = s.id and t.item_type = 'movie'  and t.variant_count > 0),
           (select count(*) from cloud_titles t join cloud_title_variants v on v.id = t.default_variant_id
              where v.source_id = s.id and t.item_type = 'series' and t.variant_count > 0),
           (exists (select 1 from cloud_media_items m where m.source_id = s.id)
              and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)),
           pi.id, pi.display_name::text
    from cloud_sources s
    left join auth.users u on u.id = s.user_id
    left join catalog_provider_identities cpi
           on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2
                                  where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    order by s.created_at;
end;
$$;

-- ── 3. Enrichment coverage per panel (movies + series, audio + subtitle) ─────
create or replace function public.admin_enrichment_coverage()
returns table(
  owner_email text, panel text, item_type text,
  total bigint, audio_resolved bigint, probed bigint, probed_24h bigint,
  subtitle_probed bigint, subtitle_found bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select u.email::text, coalesce(s.display_name, left(s.id::text, 8)), ct.item_type,
           count(*),
           count(*) filter (where ct.audio_languages <> '{}'),
           count(*) filter (where ct.audio_probed_at is not null),
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours'),
           count(*) filter (where ct.subtitle_probed_at is not null),
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array'
                              and jsonb_array_length(ct.subtitle_tracks) > 0)
    from cloud_titles ct
    join cloud_title_variants v on v.id = ct.default_variant_id
    join cloud_sources s on s.id = v.source_id
    left join auth.users u on u.id = s.user_id
    where ct.variant_count > 0
    group by u.email, s.display_name, s.id, ct.item_type
    order by u.email, ct.item_type, count(*) desc;
end;
$$;

-- ── 4. Cron fleet health (per job: schedule, last run, 24h fails) ────────────
create or replace function public.admin_cron_health()
returns table(
  jobid bigint, jobname text, schedule text, active boolean,
  last_run timestamptz, last_status text, fails_24h bigint
)
language plpgsql
stable
security definer
set search_path = public, cron
as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select j.jobid, j.jobname, j.schedule, j.active,
           lr.start_time, lr.status,
           coalesce((select count(*) from cron.job_run_details d
                       where d.jobid = j.jobid and d.status <> 'succeeded'
                         and d.start_time > now() - interval '24 hours'), 0)
    from cron.job j
    left join lateral (
      select d.start_time, d.status from cron.job_run_details d
      where d.jobid = j.jobid order by d.start_time desc limit 1
    ) lr on true
    order by j.jobid;
end;
$$;

-- Callable by authenticated users (the is_admin() gate inside does the real filtering).
grant execute on function public.is_admin() to authenticated, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_sources() to authenticated;
grant execute on function public.admin_enrichment_coverage() to authenticated;
grant execute on function public.admin_cron_health() to authenticated;
