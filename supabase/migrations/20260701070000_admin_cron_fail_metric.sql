-- Admin dashboard — cron failure metric: count only genuine failures.
--
-- cron_fails_24h (overview) and fails_24h (per job) used `status <> 'succeeded'`, which also
-- catches runs that were 'starting'/'running' at snapshot time — so a job merely executing during
-- the 5-min snapshot showed up as a phantom "failure". Count `status = 'failed'` instead. Only the
-- two failure counts change vs the previous refresh_admin_dashboard definition.

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
    'users_total',(select count(*) from auth.users),
    'users_active_7d',(select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'sources_total',(select count(*) from cloud_sources),
    'sources_error',(select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
    'sources_incomplete',(select count(*) from cloud_sources s where exists (select 1 from cloud_media_items m where m.source_id = s.id) and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)),
    'titles_movie',(select count(*) from cloud_titles where item_type = 'movie' and variant_count > 0),
    'titles_series',(select count(*) from cloud_titles where item_type = 'series' and variant_count > 0),
    'identities_active',(select count(*) from provider_identities where status = 'active'),
    'gensubs_ready',(select count(*) from catalog_generated_subtitles where status = 'ready'),
    'gensubs_processing',(select count(*) from catalog_generated_subtitles where status = 'processing'),
    'gensubs_failed',(select count(*) from catalog_generated_subtitles where status = 'failed'),
    'cron_active',(select count(*) from cron.job where active),
    'cron_paused',(select count(*) from cron.job where not active),
    'cron_fails_24h',(select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '24 hours')
  ) into ov;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into src from (
    select s.id as source_id, u.email::text as owner_email, coalesce(s.display_name, left(s.id::text, 8)) as display_name,
           s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
           (select count(*) from cloud_media_items m where m.source_id = s.id) as media_items,
           (select count(*) from cloud_title_variants v where v.source_id = s.id) as variants,
           (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id where v.source_id = s.id and t2.item_type = 'movie' and t2.variant_count > 0) as movie_titles,
           (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id where v.source_id = s.id and t2.item_type = 'series' and t2.variant_count > 0) as series_titles,
           (exists (select 1 from cloud_media_items m where m.source_id = s.id) and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)) as incomplete,
           pi.id as identity_id, pi.display_name::text as identity_name
    from cloud_sources s left join auth.users u on u.id = s.user_id
    left join catalog_provider_identities cpi on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2 where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    order by s.created_at
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into cov from (
    select u.email::text as owner_email, coalesce(s.display_name, left(s.id::text, 8)) as panel, ct.item_type,
           count(*) as total,
           count(*) filter (where ct.audio_languages <> '{}') as resolved,
           round(100.0 * count(*) filter (where ct.audio_languages <> '{}') / nullif(count(*), 0), 1) as resolved_pct,
           count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}') as never_probed,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as probed_24h,
           case when count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') > 0
                then ceil(count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}')::numeric / count(*) filter (where ct.audio_probed_at > now() - interval '24 hours'))
                else null end as eta_days,
           count(*) filter (where ct.subtitle_probed_at is not null) as subtitle_probed,
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array' and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
    from cloud_titles ct join cloud_title_variants v on v.id = ct.default_variant_id join cloud_sources s on s.id = v.source_id
    left join auth.users u on u.id = s.user_id
    where ct.variant_count > 0
    group by u.email, s.display_name, s.id, ct.item_type
    order by u.email, ct.item_type, count(*) desc
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into crn from (
    select j.jobid, j.jobname, j.schedule, j.active,
           case when j.schedule ~ '6-23' then 'jour' when j.schedule ~ '0-5' then 'nuit' else '—' end as window,
           case when j.jobname ~ 'whisper' then 'whisper'
                when j.jobname ~ 'series' then 'séries'
                when j.jobname ~ 'subtitle|pregen' then 'sous-titres'
                when j.jobname ~ 'audio|langs' then 'audio films'
                when j.jobname ~ 'enrich|origlang|revalidate|backfill-years|search-match|tmdb' then 'tmdb'
                when j.jobname ~ 'notify|digest' then 'notif'
                when j.jobname ~ 'reaper|prewarm|prune|series-info|dashboard|vac' then 'maintenance'
                else 'autre' end as kind,
           lr.start_time as last_run, lr.status as last_status,
           coalesce((select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '24 hours'), 0) as fails_24h
    from cron.job j
    left join lateral (select d.start_time, d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) lr on true
    order by (case when j.schedule ~ '6-23' then 0 when j.schedule ~ '0-5' then 1 else 2 end), j.jobname
  ) t;

  insert into public.admin_dashboard_cache (id, overview, sources, coverage, cron, refreshed_at)
       values (1, ov, src, cov, crn, now())
  on conflict (id) do update set overview = excluded.overview, sources = excluded.sources, coverage = excluded.coverage, cron = excluded.cron, refreshed_at = excluded.refreshed_at;
  return now();
end;
$$;
