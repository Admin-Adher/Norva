-- Admin charts data: real daily series for the CRM graphs (no fake data).
--
--   * users_daily  — distinct active users / day (cloud_watch_history) → Clients area chart
--   * system_daily — cron runs & failures / day (cron.job_run_details)  → Système bar chart
--   * users_split  — connected (signed in ≤7d) vs inactive               → Clients donut
--
-- One gap-filled series so days with zero activity still render a bar/point.

create or replace function public.admin_activity_series(p_days int default 14)
returns jsonb language plpgsql stable security definer set search_path = public, cron as $$
declare v jsonb; d int := greatest(5, least(30, coalesce(p_days, 14)));
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  with days as (
    select gs::date as day
    from generate_series(current_date - (d - 1), current_date, interval '1 day') gs
  ),
  active as (
    select updated_at::date as day, count(distinct user_id) as n
    from cloud_watch_history
    where updated_at >= current_date - (d - 1)
    group by 1
  ),
  crn as (
    select start_time::date as day, count(*) as runs,
           count(*) filter (where status = 'failed') as failed
    from cron.job_run_details
    where start_time >= current_date - (d - 1)
    group by 1
  ),
  tot as (
    select count(*)::int as total,
           count(*) filter (where last_sign_in_at > now() - interval '7 days')::int  as active7,
           count(*) filter (where last_sign_in_at > now() - interval '24 hours')::int as active1
    from auth.users
  )
  select jsonb_build_object(
    'refreshed_at', now(),
    'days', d,
    'users_daily', (select coalesce(jsonb_agg(
        jsonb_build_object('day', to_char(dd.day, 'YYYY-MM-DD'), 'active', coalesce(a.n, 0)) order by dd.day), '[]'::jsonb)
      from days dd left join active a on a.day = dd.day),
    'system_daily', (select coalesce(jsonb_agg(
        jsonb_build_object('day', to_char(dd.day, 'YYYY-MM-DD'), 'runs', coalesce(c.runs, 0), 'failed', coalesce(c.failed, 0)) order by dd.day), '[]'::jsonb)
      from days dd left join crn c on c.day = dd.day),
    'users_split', (select jsonb_build_object(
        'total', total, 'connected', active7, 'inactive', greatest(0, total - active7), 'active_24h', active1) from tot)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_activity_series(int) from public, anon;
grant execute on function public.admin_activity_series(int) to authenticated;
