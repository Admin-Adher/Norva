-- Cockpit sparklines on REAL data: a daily metrics journal.
--
-- Most cockpit KPIs are point-in-time counts with no stored history, so a real
-- sparkline needs a per-day record. This adds:
--   * admin_metrics_daily      — one row per (day, metric)
--   * snapshot_admin_metrics() — writes TODAY's value for every cockpit metric
--                                (scheduled daily; also called by refresh)
--   * a backfill of the metrics that ARE derivable from existing timestamps
--     (signups, active users, sources/titles growth, cron failures, cash) so
--     sparklines are real from day one instead of empty.
--   * admin_metric_sparks(days) — dense per-metric arrays for the frontend.
-- Metrics with no historical source (MRR, live status counts, identities…) start
-- accumulating from today — their sparkline is short/flat until history builds,
-- which is honest (real readings, just few of them).

create table if not exists public.admin_metrics_daily (
  day    date  not null,
  metric text  not null,
  value  numeric not null default 0,
  primary key (day, metric)
);
alter table public.admin_metrics_daily enable row level security;
-- No policies → only SECURITY DEFINER RPCs (below) can read/write. Service role bypasses RLS.

-- ── snapshot: today's value for every cockpit metric ────────────────────────────
create or replace function public.snapshot_admin_metrics()
returns void language plpgsql security definer set search_path = public, cron as $$
declare t date := current_date;
begin
  insert into admin_metrics_daily(day, metric, value) values
    (t,'users_total',        (select count(*) from auth.users)),
    (t,'users_active_24h',   (select count(distinct user_id) from cloud_watch_history where updated_at > now()-interval '24 hours')),
    (t,'users_active_7d',    (select count(distinct user_id) from cloud_watch_history where updated_at > now()-interval '7 days')),
    (t,'users_watching_7d',  (select count(distinct user_id) from cloud_watch_history where updated_at > now()-interval '7 days')),
    (t,'users_new_7d',       (select count(*) from auth.users where created_at > now()-interval '7 days')),
    (t,'users_new_30d',      (select count(*) from auth.users where created_at > now()-interval '30 days')),
    (t,'logins_24h',         (select count(distinct user_id) from auth.refresh_tokens where created_at > now()-interval '24 hours')),
    (t,'mrr_cents',          (select coalesce(sum(case when c.period='annual' then round(c.amount_cents/12.0) else c.amount_cents end),0)
                                from cloud_entitlement_projection p join cloud_stancer_customers c on c.user_id=p.user_id
                                where p.status in ('active','past_due','grace','cancelled_at_period_end'))),
    (t,'trialing',           (select count(*) from cloud_entitlement_projection where status='trialing')),
    (t,'active_paying',      (select count(*) from cloud_entitlement_projection where status='active')),
    (t,'past_due',           (select count(*) from cloud_entitlement_projection where status in ('past_due','grace'))),
    (t,'conversions_7d',     (select count(distinct user_id) from cloud_stancer_payments where kind='first_charge' and status='captured' and updated_at > now()-interval '7 days')),
    (t,'collected_30d_cents',(select coalesce(sum(amount),0) from cloud_stancer_payments where status='captured' and kind in ('first_charge','renewal') and updated_at > now()-interval '30 days')),
    (t,'sources_total',      (select count(*) from cloud_sources)),
    (t,'sources_incomplete', (select count(*) from cloud_sources s
                                left join (select source_id, count(*) n from cloud_media_items where item_type in ('movie','series') group by 1) mc on mc.source_id=s.id
                                left join (select source_id, count(*) n from cloud_title_variants group by 1) vc on vc.source_id=s.id
                                where coalesce(mc.n,0)>0 and coalesce(vc.n,0)=0)),
    (t,'sources_error',      (select count(*) from cloud_sources where sync_status='sync_error' or sync_error is not null)),
    (t,'identities_active',  (select count(*) from provider_identities where status='active')),
    (t,'titles_movie',       (select count(*) from cloud_titles where variant_count>0 and item_type='movie')),
    (t,'titles_series',      (select count(*) from cloud_titles where variant_count>0 and item_type='series')),
    (t,'gensubs_ready',      (select count(*) from catalog_generated_subtitles where status='ready')),
    (t,'gensubs_processing', (select count(*) from catalog_generated_subtitles where status='processing')),
    (t,'gensubs_failed',     (select count(*) from catalog_generated_subtitles where status='failed')),
    (t,'cron_active',        (select count(*) from cron.job where active)),
    (t,'cron_paused',        (select count(*) from cron.job where not active)),
    (t,'cron_fails_24h',     (select count(*) from cron.job_run_details where status='failed' and start_time > now()-interval '24 hours'))
  on conflict (day, metric) do update set value = excluded.value;
end; $$;
revoke all on function public.snapshot_admin_metrics() from public, anon, authenticated;

-- ── sparks RPC: dense arrays (null where no reading) for the last N days ─────────
create or replace function public.admin_metric_sparks(p_days int default 14)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; d int := greatest(5, least(60, coalesce(p_days,14)));
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  with days as (select gs::date as day from generate_series(current_date-(d-1), current_date, interval '1 day') gs),
  metrics as (select distinct metric from admin_metrics_daily)
  select coalesce(jsonb_object_agg(metric, arr), '{}'::jsonb) into v from (
    select m.metric,
           jsonb_agg(md.value order by dd.day) as arr   -- null entries stay null → frontend fills
    from metrics m
    cross join days dd
    left join admin_metrics_daily md on md.metric=m.metric and md.day=dd.day
    group by m.metric
  ) x;
  return jsonb_build_object('days', d, 'series', v);
end; $$;
revoke all on function public.admin_metric_sparks(int) from public, anon;
grant execute on function public.admin_metric_sparks(int) to authenticated;

-- ── backfill the derivable metrics (real history from existing timestamps) ───────
do $$
declare from_d date := current_date - 29;   -- 30-day window
begin
  -- signups-derived
  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'users_total', (select count(*) from auth.users u where u.created_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'users_new_7d', (select count(*) from auth.users u where u.created_at::date > dd.day-7 and u.created_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'users_new_30d', (select count(*) from auth.users u where u.created_at::date > dd.day-30 and u.created_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  -- watch-activity-derived (active / watching)
  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'users_active_24h', (select count(distinct w.user_id) from cloud_watch_history w where w.updated_at::date = dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'users_active_7d', (select count(distinct w.user_id) from cloud_watch_history w where w.updated_at::date > dd.day-7 and w.updated_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'users_watching_7d', (select count(distinct w.user_id) from cloud_watch_history w where w.updated_at::date > dd.day-7 and w.updated_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  -- real logins/day from refresh_tokens (retained window only; grows forward)
  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'logins_24h', (select count(distinct r.user_id) from auth.refresh_tokens r where r.created_at::date = dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  where exists (select 1 from auth.refresh_tokens r2 where r2.created_at::date = dd.day)
  on conflict (day, metric) do nothing;

  -- sources cumulative
  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'sources_total', (select count(*) from cloud_sources s where s.created_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  -- titles cumulative (ONE scan → per-type daily new via CTE, then cumulative)
  with newt as (
    select created_at::date as d, item_type, count(*) as n
    from cloud_titles
    where variant_count>0 and item_type in ('movie','series') and created_at is not null
    group by 1,2
  )
  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'titles_'||it.t,
         coalesce((select sum(n) from newt where newt.item_type=it.t and newt.d <= dd.day), 0)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  cross join (values ('movie'),('series')) it(t)
  on conflict (day, metric) do nothing;

  -- cron failures / day
  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'cron_fails_24h', (select count(*) from cron.job_run_details j where j.status='failed' and j.start_time::date = dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  -- cash collected (rolling 30d) + conversions (rolling 7d)
  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'collected_30d_cents', (select coalesce(sum(amount),0) from cloud_stancer_payments p
      where p.status='captured' and p.kind in ('first_charge','renewal') and p.updated_at::date > dd.day-30 and p.updated_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;

  insert into admin_metrics_daily(day, metric, value)
  select dd.day, 'conversions_7d', (select count(distinct p.user_id) from cloud_stancer_payments p
      where p.kind='first_charge' and p.status='captured' and p.updated_at::date > dd.day-7 and p.updated_at::date <= dd.day)
  from (select gs::date as day from generate_series(from_d, current_date, interval '1 day') gs) dd
  on conflict (day, metric) do nothing;
end $$;

-- seed today's full snapshot (covers the non-backfillable metrics too)
select public.snapshot_admin_metrics();

-- daily cron @ 00:07 UTC (cron.schedule upserts by name → idempotent)
select cron.schedule('norva-snapshot-metrics', '7 0 * * *', $$select public.snapshot_admin_metrics()$$);
