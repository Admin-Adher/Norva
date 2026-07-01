-- CRM depth: (1) Cockpit business KPIs (growth + activity) and clickable alerts, (2) Clients segment
-- filter + per-row tags.
--
-- (1) refresh_admin_dashboard: add growth/activity counts to the overview blob, and add `user_id` to
--     each sources entry so the Cockpit "alertes" (errored / incomplete sources) can link to the
--     owner's fiche (route client:<user_id>).
-- (2) admin_users_page: add p_tag_id filter (users carrying a given segment), return each row's tags,
--     and the tag catalog (all_tags) so the frontend can build the filter without a 2nd call.

create or replace function public.refresh_admin_dashboard()
returns timestamptz language plpgsql security definer set search_path = public, cron as $$
declare ov jsonb; src jsonb; cov jsonb; crn jsonb;
begin
  set local statement_timeout to '180s';
  select jsonb_build_object(
    'users_total',(select count(*) from auth.users),
    'users_active_7d',(select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'users_active_24h',(select count(*) from auth.users where last_sign_in_at > now() - interval '24 hours'),
    'users_active_30d',(select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
    'users_new_7d',(select count(*) from auth.users where created_at > now() - interval '7 days'),
    'users_new_30d',(select count(*) from auth.users where created_at > now() - interval '30 days'),
    'sources_total',(select count(*) from cloud_sources),
    'sources_error',(select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
    'sources_incomplete',(select count(*) from cloud_sources s
        where exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
          and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)),
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
    select s.id as source_id, s.user_id as user_id, u.email::text as owner_email, coalesce(s.display_name, left(s.id::text, 8)) as display_name,
           s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
           (select count(*) from cloud_media_items m where m.source_id = s.id) as media_items,
           (select count(*) from cloud_title_variants v where v.source_id = s.id) as variants,
           (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id where v.source_id = s.id and t2.item_type = 'movie' and t2.variant_count > 0) as movie_titles,
           (select count(*) from cloud_titles t2 join cloud_title_variants v on v.id = t2.default_variant_id where v.source_id = s.id and t2.item_type = 'series' and t2.variant_count > 0) as series_titles,
           (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
              and not exists (select 1 from cloud_title_variants v where v.source_id = s.id)) as incomplete,
           pi.id as identity_id, pi.display_name::text as identity_name,
           (s.user_id in (select user_id from public.admin_enrichment_accounts)) as is_driver
    from cloud_sources s left join auth.users u on u.id = s.user_id
    left join catalog_provider_identities cpi on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2 where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    where s.user_id in (select user_id from public.admin_enrichment_accounts)
       or s.sync_status = 'sync_error' or s.sync_error is not null
       or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
           and not exists (select 1 from cloud_title_variants v where v.source_id = s.id))
    order by (s.user_id in (select user_id from public.admin_enrichment_accounts)) desc, s.created_at
    limit 300
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
      and ct.user_id in (select user_id from public.admin_enrichment_accounts)
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
end; $$;

select public.refresh_admin_dashboard();

-- ── Clients: segment filter + per-row tags + tag catalog ──
drop function if exists public.admin_users_page(int, int, text, text);
create or replace function public.admin_users_page(
  p_limit  int  default 25,
  p_offset int  default 0,
  p_search text default null,
  p_sort   text default 'created_desc',
  p_tag_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lim    int    := greatest(1, least(100, coalesce(p_limit, 25)));
  v_off    int    := greatest(0, coalesce(p_offset, 0));
  v_search text   := nullif(btrim(coalesce(p_search, '')), '');
  v_total  bigint;
  v_rows   jsonb;
  v_alltags jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select count(*) into v_total
  from auth.users u
  where (v_search is null or u.email ilike '%' || v_search || '%')
    and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id));

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           u.created_at,
           u.last_sign_in_at,
           (u.email_confirmed_at is not null)                as email_confirmed,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.id in (select user_id from public.admin_enrichment_accounts)) as is_driver,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count,
           (select coalesce(jsonb_agg(jsonb_build_object('id',tg.id,'label',tg.label,'color',tg.color) order by tg.label), '[]'::jsonb)
              from public.admin_client_tags ctg join public.admin_tags tg on tg.id = ctg.tag_id where ctg.user_id = u.id) as tags
    from auth.users u
    where (v_search is null or u.email ilike '%' || v_search || '%')
      and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
    order by
      (case when p_sort = 'active_desc' then u.last_sign_in_at end) desc nulls last,
      (case when p_sort = 'email_asc'   then u.email           end) asc,
      (case when p_sort = 'created_asc' then u.created_at      end) asc,
      u.created_at desc
    limit v_lim offset v_off
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'color',color) order by label), '[]'::jsonb)
    into v_alltags from public.admin_tags;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows, 'all_tags', v_alltags);
end;
$$;

revoke all on function public.admin_users_page(int, int, text, text, uuid) from public, anon;
grant execute on function public.admin_users_page(int, int, text, text, uuid) to authenticated;
