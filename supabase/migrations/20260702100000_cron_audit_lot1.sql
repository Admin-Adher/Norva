-- Cron audit — Lot 1 (SQL only). Findings confirmed by adversarial verification (31-agent audit).
--
-- 1) refresh_admin_dashboard rewrite — the hot spot (avg ~31-37s, max 65.7s, every 5 min ≈ 12% of
--    total DB time). 89% of the cost was the `sources` blob: 4 correlated subqueries recomputed for
--    EACH source; with no index on cloud_titles.default_variant_id every count re-ran a full hash
--    join of cloud_titles (558k) × cloud_title_variants (707k) — up to 16 full joins per refresh,
--    spilling ~218 MB to temp disk per run (~80 GB/day). Fix: compute the aggregates ONCE in CTEs
--    (measured: the heavy join drops 15.7s → 2.1s, 7.5×) and join them to cloud_sources.
--    MANDATORY (verifier): COALESCE every joined count — a VOD source with 0 variants must yield
--    incomplete=true, not NULL (a LEFT JOIN miss would silently drop the very alert this flag
--    exists for). `set local work_mem='64MB'` removes the residual hash spills. The overview's
--    titles_movie/series come from one dedicated single scan (tt) instead of two, keeping the exact
--    original semantics (no reliance on the default_variant_id invariant). sources_incomplete is
--    derived from the same mc/vc aggregates (exact equivalence: exists(media VOD) ⇔ n_ms>0,
--    not exists(variants) ⇔ coalesce(vc.n,0)=0). The source-selection WHERE keeps its original
--    exists() form — the planner short-circuits it, measured ~0 cost. Expected: refresh ≈ 5-8s.
--
-- 2) Frequency */5 → '2-57/10' — half the runs, and the one heavy job no longer starts on the
--    :00/:30 minutes where up to 9-10 jobs fire together (578/1440 minutes have >3 simultaneous
--    starts; the 2026-06-28 'job startup timeout' incident was this pool saturation).
--
-- 3) cron.job_run_details: retention 7 days, weekly (the dashboard only reads 24h; no retention
--    existed → unbounded drift). NOTE: the planned (jobid, start_time desc) index is NOT possible —
--    cron.job_run_details is owned by supabase_admin ("must be owner of table"). The 7-day retention
--    keeps the table ≤ ~30k rows so the per-job lateral scans stay bounded without it.
--
-- 4) Enrichment candidate indexes (pure gain, no code change):
--    • idx_cloud_titles_whisper_pending — partial on the exact hardcoded predicate; the whisper
--      candidate scan walked 140 045 rows to find 4 (3.9s → ~1ms).
--    • idx_cloud_titles_audio_sweep — the account-wide audio/subtitle sweeps (super8k/jeremy crons)
--      had no usable index (~200k buffers/tick, ~30-50 min DB/day).
--    (No index on default_variant_id: the CTE rewrite hash-joins in bulk; it would be dead weight.)
--
-- 5) SQL guards on the chatty crons (the norva-origlang-backfill pattern — net.http_post ... WHERE
--    EXISTS): resume-stuck (1440 posts/day, measured 100% no-op), import-notify-digest (720/day,
--    100% no-op), auto-refresh-detect (~16 empty/day). Guards are exact/superset mirrors of each
--    edge handler's own candidate filter — a guard miss is impossible by construction (anti-drift
--    variants chosen: sync_status filter only for resume-stuck; settle omitted for digest).
--    ~2 160 edge invocations/day removed; when there IS work, behaviour is bit-identical.
--
-- 6) norva-generated-subtitle-reaper */30 → hourly (8-row table; safety net, ≤3h reap is fine).

-- ── 4) Indexes (live-applied with CONCURRENTLY via ops; IF NOT EXISTS keeps this re-runnable) ──
create index if not exists idx_cloud_titles_whisper_pending
  on public.cloud_titles (user_id, item_type, id)
  where audio_tracks @> '[{"lang":null}]'::jsonb;

create index if not exists idx_cloud_titles_audio_sweep
  on public.cloud_titles (user_id, item_type, audio_languages, id);

-- (no index on cron.job_run_details: table owned by supabase_admin — see header note 3)

-- ── 1) refresh_admin_dashboard rewrite ──
create or replace function public.refresh_admin_dashboard()
returns timestamptz language plpgsql security definer set search_path = public, cron as $$
declare ov jsonb; src jsonb; cov jsonb; crn jsonb;
begin
  set local statement_timeout to '180s';
  set local work_mem to '64MB';

  -- Overview + sources in ONE statement: the tc/vc/mc aggregates are computed once and shared
  -- (multi-referenced CTEs are materialized once), replacing the per-source correlated subqueries.
  with tc as (                       -- per-source titles by type (default-variant join, computed once)
    select v.source_id, t2.item_type, count(*)::bigint as n
    from cloud_titles t2
    join cloud_title_variants v on v.id = t2.default_variant_id
    where t2.variant_count > 0 and t2.item_type in ('movie','series')
    group by 1, 2
  ), vc as (                         -- per-source variants
    select source_id, count(*)::bigint as n from cloud_title_variants group by 1
  ), mc as (                         -- per-source media items (+ VOD-only count for `incomplete`)
    select source_id, count(*)::bigint as n,
           count(*) filter (where item_type in ('movie','series'))::bigint as n_ms
    from cloud_media_items group by 1
  ), tt as (                         -- global titles KPIs: one scan, exact original semantics
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
    -- Selection predicate kept in its original exists() form: short-circuited by the OR for driver
    -- sources, measured ~0 cost — and immune to any CTE-vs-exists edge divergence.
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
      'cron_active',(select count(*) from cron.job where active),
      'cron_paused',(select count(*) from cron.job where not active),
      'cron_fails_24h',(select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '24 hours')
    ),
    (select coalesce(jsonb_agg(row_to_json(sr) order by sr.is_driver desc, sr.created_at), '[]'::jsonb) from src_rows sr)
  into ov, src;

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
                when j.jobname ~ 'reaper|prewarm|prune|series-info|dashboard|vac|history|alert' then 'maintenance'
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

-- ── 3) job_run_details retention (weekly; the dashboard only reads the last 24h) ──
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'norva-cron-history-prune') then
    perform cron.schedule(
      'norva-cron-history-prune',
      '25 4 * * 0',
      $j$ delete from cron.job_run_details where end_time < now() - interval '7 days' $j$
    );
  end if;
end $$;

-- ── 2) + 6) Reschedules ──
do $$
declare v bigint;
begin
  select jobid into v from cron.job where jobname = 'admin-dashboard-refresh';
  if v is not null then perform cron.alter_job(v, schedule => '2-57/10 * * * *'); end if;
  select jobid into v from cron.job where jobname = 'norva-generated-subtitle-reaper';
  if v is not null then perform cron.alter_job(v, schedule => '0 * * * *'); end if;
end $$;

-- ── 5) SQL guards on the chatty crons (URL/headers/body/timeout identical — only the WHERE is new) ──
do $$
declare v bigint;
begin
  select jobid into v from cron.job where jobname = 'norva-resume-stuck-sync';
  if v is not null then
    perform cron.alter_job(v, command => $c$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/resume-stuck',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 5000)
  -- Anti-drift guard: exact copy of cronResumeStuck's own candidate SELECT
  -- (norva-source-sync/index.ts ~:904-905). No work => no POST (measured 100% no-ops in idle).
  where exists (
    select 1 from public.cloud_sources
    where source_type = 'xtream' and sync_status in ('syncing','error')
  );
  $c$);
  end if;

  select jobid into v from cron.job where jobname = 'norva-import-notify-digest';
  if v is not null then
    perform cron.alter_job(v, command => $c$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-import-notify/cron/digest',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
  -- Superset guard: pending rows regardless of the 60s settle (a too-fresh row costs at most one
  -- no-op POST, exactly like today; retry semantics preserved — failures stay 'pending').
  where exists (select 1 from public.cloud_import_notifications where status = 'pending');
  $c$);
  end if;

  select jobid into v from cron.job where jobname = 'norva-auto-refresh-detect';
  if v is not null then
    perform cron.alter_job(v, command => $c$
  select net.http_post(
    url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-source-sync/cron/refresh-due',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')
    ),
    timeout_milliseconds := 20000
  )
  -- Mirror of cronRefreshDue's due-source predicate (backoffUntil check omitted: proven redundant —
  -- its writer always sets auto_refresh_next_at at the same instant). Served by the partial index
  -- on auto_refresh_next_at.
  where exists (
    select 1 from public.cloud_sources
    where source_type in ('xtream','m3u')
      and (auto_refresh_next_at is null or auto_refresh_next_at <= now())
  );
  $c$);
  end if;
end $$;
