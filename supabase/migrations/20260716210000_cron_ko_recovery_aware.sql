-- =============================================================================
-- Crons KO « recovery-aware » — un échec auto-réparé ne crie plus « À traiter ».
-- =============================================================================
-- Constat (2026-07-16) : le deadlock UNIQUE de norva-enrich-titles-from-catalog
-- (15/07 20:03, corrigé le matin même par 20260716120000_enrich_titles_skip_locked)
-- a affiché « 1 cron KO / À traiter » au Cockpit et au Moteur pendant 24 h alors
-- que le job s'était relancé sans erreur depuis. Même philosophie que les emails
-- d'alerte ops (recovery-aware, 20260716…) : l'état d'alerte doit refléter l'état
-- COURANT, pas l'historique.
--
-- Ajout : overview.cron_ko = nombre de jobs ACTIFS dont le DERNIER run est
-- 'failed' (= encore cassés maintenant). cron_fails_24h (volume brut d'échecs
-- 24 h) est conservé tel quel comme contexte — le front l'affiche en « récupéré »
-- quand cron_ko = 0. Les lignes du panneau crons portent déjà last_status +
-- fails_24h → le front distingue KO/récupéré par job sans autre champ.
--
-- refresh_admin_dashboard() est ré-émise depuis 20260716130000 (rail Revolut)
-- avec CETTE SEULE addition.

create or replace function public.refresh_admin_dashboard()
 returns timestamp with time zone
 language plpgsql
 security definer
 set search_path to 'public', 'cron'
as $function$
declare ov jsonb; src jsonb; cov jsonb; crn jsonb;
begin
  set local statement_timeout to '180s';
  set local work_mem to '64MB';

  with tc as (
    select v.source_id, t2.item_type, count(*)::bigint as n
    from cloud_titles t2
    join cloud_title_variants v on v.id = t2.default_variant_id
    where t2.variant_count > 0 and t2.item_type in ('movie','series')
    group by 1, 2
  ), vc as (
    select source_id, count(*)::bigint as n from cloud_title_variants group by 1
  ), mc as (
    select source_id, count(*)::bigint as n,
           count(*) filter (where item_type in ('movie','series'))::bigint as n_ms
    from cloud_media_items group by 1
  ), tt as (
    select item_type, count(*)::bigint as n
    from cloud_titles where variant_count > 0 and item_type in ('movie','series')
    group by 1
  ), src_rows as (
    select s.id as source_id, s.user_id as user_id, u.email::text as owner_email,
           coalesce(s.display_name, left(s.id::text, 8)) as display_name,
           s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
           coalesce(mc.n, 0)  as media_items,
           coalesce(vc.n, 0)  as variants,
           coalesce(tcm.n, 0) as movie_titles,
           coalesce(tcs.n, 0) as series_titles,
           (coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0) as incomplete,
           pi.id as identity_id, pi.display_name::text as identity_name,
           (s.user_id in (select user_id from public.admin_enrichment_accounts)) as is_driver
    from cloud_sources s
    left join auth.users u on u.id = s.user_id
    left join mc on mc.source_id = s.id
    left join vc on vc.source_id = s.id
    left join tc tcm on tcm.source_id = s.id and tcm.item_type = 'movie'
    left join tc tcs on tcs.source_id = s.id and tcs.item_type = 'series'
    left join catalog_provider_identities cpi on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2 where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    where s.user_id in (select user_id from public.admin_enrichment_accounts)
       or s.sync_status = 'sync_error' or s.sync_error is not null
       or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
           and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))
    order by (s.user_id in (select user_id from public.admin_enrichment_accounts)) desc, s.created_at
    limit 300
  )
  select
    jsonb_build_object(
      'users_total',(select count(*) from auth.users),
      'users_active_7d',(select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'users_active_24h',(select count(*) from auth.users where last_sign_in_at > now() - interval '24 hours'),
      'users_active_30d',(select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
      'users_new_7d',(select count(*) from auth.users where created_at > now() - interval '7 days'),
      'users_new_30d',(select count(*) from auth.users where created_at > now() - interval '30 days'),
      'users_watching_24h',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '24 hours'),
      'users_watching_7d',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '7 days'),
      'sources_total',(select count(*) from cloud_sources),
      'sources_error',(select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
      'sources_incomplete',(select count(*) from cloud_sources s
          left join mc on mc.source_id = s.id
          left join vc on vc.source_id = s.id
          where coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0),
      'titles_movie',(select coalesce((select n from tt where item_type = 'movie'), 0)),
      'titles_series',(select coalesce((select n from tt where item_type = 'series'), 0)),
      'identities_active',(select count(*) from provider_identities where status = 'active'),
      'gensubs_ready',(select count(*) from catalog_generated_subtitles where status = 'ready'),
      'gensubs_processing',(select count(*) from catalog_generated_subtitles where status = 'processing'),
      'gensubs_failed',(select count(*) from catalog_generated_subtitles where status = 'failed'),
      'tmdb_year_backlog',(select count(*) from cloud_titles where release_year is null and provider_tmdb_id is not null),
      'tmdb_unmatched',(select count(*) from cloud_titles where match_status = 'unmatched'),
      'tmdb_unverified',(select count(*) from cloud_titles where match_status in ('provider_unverified','weak') and provider_tmdb_id is not null and provider_tmdb_id <> '0'),
      'cron_active',(select count(*) from cron.job where active),
      'cron_paused',(select count(*) from cron.job where not active),
      'cron_fails_24h',(select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '24 hours'),
      'cron_ko',(select count(*) from cron.job j
          where j.active
            and (select d.status from cron.job_run_details d
                  where d.jobid = j.jobid order by d.start_time desc limit 1) = 'failed'),
      'billing_mrr_cents',(select coalesce(sum(case when coalesce(c.period, p.bill_period) = 'annual' then round(coalesce(c.amount_cents, p.mrr_cents) / 12.0) else coalesce(c.amount_cents, p.mrr_cents) end), 0)
          from cloud_entitlement_projection p left join cloud_stancer_customers c on c.user_id = p.user_id
          where p.status in ('active','past_due','grace','cancelled_at_period_end')
            and p.user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_trialing',(select count(*) from cloud_entitlement_projection
          where status = 'trialing' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_active',(select count(*) from cloud_entitlement_projection
          where status = 'active' and provider <> 'system'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_past_due',(select count(*) from cloud_entitlement_projection
          where status in ('past_due','grace') and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cancel_pending',(select count(*) from cloud_entitlement_projection
          where status = 'cancelled_at_period_end' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_collected_30d_cents',(select coalesce(sum(amount), 0) from cloud_stancer_payments
          where status = 'captured' and kind in ('first_charge','renewal') and updated_at > now() - interval '30 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_conversions_7d',(select count(distinct user_id) from cloud_stancer_payments
          where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cron_fails_24h',(select count(*) from cron.job_run_details d join cron.job j on j.jobid = d.jobid
          where j.jobname in ('norva-revolut-billing','norva-lifecycle') and d.status = 'failed' and d.start_time > now() - interval '24 hours'),
      'support_open',(select count(*) from cloud_support_tickets where status <> 'closed'),
      'support_needs_reply',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user'),
      'support_stale_24h',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user' and last_message_at < now() - interval '24 hours')
    ),
    (select coalesce(jsonb_agg(row_to_json(sr) order by sr.is_driver desc, sr.created_at), '[]'::jsonb) from src_rows sr)
  into ov, src;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into cov from (
    select u.email::text as owner_email, coalesce(pi.display_name, s.display_name, left(s.id::text, 8)) as panel, ct.item_type,
           count(*) as total,
           count(*) filter (where ct.audio_languages <> '{}') as resolved,
           round(100.0 * count(*) filter (where ct.audio_languages <> '{}') / nullif(count(*), 0), 1) as resolved_pct,
           count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}') as never_probed,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as probed_24h,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours' and ct.audio_languages <> '{}') as resolved_24h,
           case when count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') > 0
                then ceil(count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}')::numeric / count(*) filter (where ct.audio_probed_at > now() - interval '24 hours'))
                else null end as eta_days,
           count(*) filter (where ct.subtitle_probed_at is not null) as subtitle_probed,
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array' and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
    from cloud_titles ct join cloud_title_variants v on v.id = ct.default_variant_id join cloud_sources s on s.id = v.source_id
    left join auth.users u on u.id = s.user_id
    left join catalog_provider_identities cpi on cpi.provider_key = s.config_hint->>'providerKey'
    left join provider_identities pi on pi.id = cpi.identity_id
    where ct.variant_count > 0
      and ct.user_id in (select user_id from public.admin_enrichment_accounts)
    group by u.email, coalesce(pi.id::text, s.id::text), coalesce(pi.display_name, s.display_name, left(s.id::text, 8)), ct.item_type
    order by u.email, ct.item_type, count(*) desc
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into crn from (
    select j.jobid, j.jobname, j.schedule, j.active,
           case when j.schedule ~ '6-23' then 'jour'
                when j.schedule ~ '0-5' then 'nuit'
                when j.schedule ~ '^\S+ \* \* \* \*$' then 'continu'
                else '—' end as window,
           case when j.jobname ~ 'stancer|billing' then 'billing'
                when j.jobname ~ 'lifecycle' then 'lifecycle'
                when j.jobname ~ 'whisper' then 'whisper'
                when j.jobname ~ 'reaper|prewarm|prune|series-info|dashboard|vac|history|alert' then 'maintenance'
                when j.jobname ~ 'auto-refresh|resume-stuck' then 'sync'
                when j.jobname ~ 'series' then 'séries'
                when j.jobname ~ 'subtitle|pregen' then 'sous-titres'
                when j.jobname ~ 'audio|langs' then 'audio films'
                when j.jobname ~ 'enrich|origlang|revalidate|backfill-years|search-match|tmdb' then 'tmdb'
                when j.jobname ~ 'notify|digest' then 'notif'
                else 'autre' end as kind,
           lr.start_time as last_run, lr.status as last_status,
           coalesce((select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '24 hours'), 0) as fails_24h
    from cron.job j
    left join lateral (select d.start_time, d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) lr on true
    order by (case when j.jobname ~ 'stancer|billing|lifecycle' then 0 when j.schedule ~ '6-23' then 1 when j.schedule ~ '0-5' then 2 else 3 end), j.jobname
  ) t;

  insert into public.admin_dashboard_cache (id, overview, sources, coverage, cron, refreshed_at)
       values (1, ov, src, cov, crn, now())
  on conflict (id) do update set overview = excluded.overview, sources = excluded.sources, coverage = excluded.coverage, cron = excluded.cron, refreshed_at = excluded.refreshed_at;
  return now();
end; $function$;
