-- Admin dashboard — precomputed snapshot cache.
--
-- The per-source / per-panel aggregations join 550k+ cloud_titles and run fine as service-role
-- but exceed the `authenticated` role's 8s statement_timeout when called via PostgREST (error
-- 57014). Fix: a pg_cron job runs the heavy queries (no user timeout) into a single-row cache;
-- the admin RPCs just read the cache → instant, no timeout, and scales as the catalogue grows.

create table if not exists public.admin_dashboard_cache (
  id           smallint primary key default 1,
  overview     jsonb,
  sources      jsonb,
  coverage     jsonb,
  cron         jsonb,
  refreshed_at timestamptz,
  constraint admin_cache_one_row check (id = 1)
);
alter table public.admin_dashboard_cache enable row level security;  -- read only via the gated RPCs

-- Compute everything once and upsert the single cache row. Runs from pg_cron (postgres role) and
-- raises its own statement_timeout so it always completes regardless of the caller.
create or replace function public.refresh_admin_dashboard()
returns timestamptz
language plpgsql
security definer
set search_path = public, cron
as $$
declare ov jsonb; src jsonb; cov jsonb; crn jsonb;
begin
  set local statement_timeout to '180s';

  select jsonb_build_object(
    'users_total',        (select count(*) from auth.users),
    'users_active_7d',    (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'sources_total',      (select count(*) from cloud_sources),
    'sources_error',      (select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
    'sources_incomplete', (select count(*) from cloud_sources s
                             where exists (select 1 from cloud_media_items m where m.source_id = s.id)
                               and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)),
    'titles_movie',       (select count(*) from cloud_titles where item_type = 'movie'  and variant_count > 0),
    'titles_series',      (select count(*) from cloud_titles where item_type = 'series' and variant_count > 0),
    'identities_active',  (select count(*) from provider_identities where status = 'active'),
    'gensubs_ready',      (select count(*) from catalog_generated_subtitles where status = 'ready'),
    'gensubs_processing', (select count(*) from catalog_generated_subtitles where status = 'processing'),
    'gensubs_failed',     (select count(*) from catalog_generated_subtitles where status = 'failed'),
    'cron_active',        (select count(*) from cron.job where active),
    'cron_paused',        (select count(*) from cron.job where not active),
    'cron_fails_24h',     (select count(*) from cron.job_run_details
                             where status <> 'succeeded' and start_time > now() - interval '24 hours')
  ) into ov;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into src from (
    select s.id as source_id, u.email::text as owner_email,
           coalesce(s.display_name, left(s.id::text, 8)) as display_name,
           s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
           (select count(*) from cloud_media_items m where m.source_id = s.id) as media_items,
           (select count(*) from cloud_title_variants v where v.source_id = s.id) as variants,
           (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id
              where v.source_id = s.id and t2.item_type = 'movie'  and t2.variant_count > 0) as movie_titles,
           (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id
              where v.source_id = s.id and t2.item_type = 'series' and t2.variant_count > 0) as series_titles,
           (exists (select 1 from cloud_media_items m where m.source_id = s.id)
              and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)) as incomplete,
           pi.id as identity_id, pi.display_name::text as identity_name
    from cloud_sources s
    left join auth.users u on u.id = s.user_id
    left join catalog_provider_identities cpi
           on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2
                                  where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    order by s.created_at
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into cov from (
    select u.email::text as owner_email, coalesce(s.display_name, left(s.id::text, 8)) as panel, ct.item_type,
           count(*) as total,
           count(*) filter (where ct.audio_languages <> '{}') as audio_resolved,
           count(*) filter (where ct.audio_probed_at is not null) as probed,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as probed_24h,
           count(*) filter (where ct.subtitle_probed_at is not null) as subtitle_probed,
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array'
                              and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
    from cloud_titles ct
    join cloud_title_variants v on v.id = ct.default_variant_id
    join cloud_sources s on s.id = v.source_id
    left join auth.users u on u.id = s.user_id
    where ct.variant_count > 0
    group by u.email, s.display_name, s.id, ct.item_type
    order by u.email, ct.item_type, count(*) desc
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into crn from (
    select j.jobid, j.jobname, j.schedule, j.active, lr.start_time as last_run, lr.status as last_status,
           coalesce((select count(*) from cron.job_run_details d
                       where d.jobid = j.jobid and d.status <> 'succeeded'
                         and d.start_time > now() - interval '24 hours'), 0) as fails_24h
    from cron.job j
    left join lateral (select d.start_time, d.status from cron.job_run_details d
                       where d.jobid = j.jobid order by d.start_time desc limit 1) lr on true
    order by j.jobid
  ) t;

  insert into public.admin_dashboard_cache (id, overview, sources, coverage, cron, refreshed_at)
       values (1, ov, src, cov, crn, now())
  on conflict (id) do update
     set overview = excluded.overview, sources = excluded.sources, coverage = excluded.coverage,
         cron = excluded.cron, refreshed_at = excluded.refreshed_at;
  return now();
end;
$$;
revoke execute on function public.refresh_admin_dashboard() from public;

-- Rewire the read RPCs to serve the cache (instant, no timeout). Return jsonb (arrays/object) —
-- PostgREST hands the JSON value straight to the client, which already expects arrays/object.
drop function if exists public.admin_overview();
drop function if exists public.admin_sources();
drop function if exists public.admin_enrichment_coverage();
drop function if exists public.admin_cron_health();

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select overview || jsonb_build_object('refreshed_at', refreshed_at)
                     from public.admin_dashboard_cache where id = 1), '{}'::jsonb);
end; $$;

create or replace function public.admin_sources() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select sources from public.admin_dashboard_cache where id = 1), '[]'::jsonb);
end; $$;

create or replace function public.admin_enrichment_coverage() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select coverage from public.admin_dashboard_cache where id = 1), '[]'::jsonb);
end; $$;

create or replace function public.admin_cron_health() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select cron from public.admin_dashboard_cache where id = 1), '[]'::jsonb);
end; $$;

grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_sources() to authenticated;
grant execute on function public.admin_enrichment_coverage() to authenticated;
grant execute on function public.admin_cron_health() to authenticated;
