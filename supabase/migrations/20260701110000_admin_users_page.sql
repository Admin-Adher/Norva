-- Admin dashboard — paginated Users section.
--
-- Unlike the Ops sections (precomputed into admin_dashboard_cache by a 5-min cron), the Users list
-- must be LIVE (search, sort, page). Scalability comes from bounding the work to one page:
--   • total  = count(*) over auth.users (+ optional email filter) — a single cheap count.
--   • rows   = LIMIT/OFFSET page; the only per-row aggregation is sources_count, an index lookup
--              on cloud_sources(user_id) run at most p_limit (≤100) times — NOT a full scan.
-- So cost is O(page size), independent of user count — safe for thousands/tens of thousands of users
-- within the authenticated role's 8s statement_timeout.
--
-- SECURITY DEFINER + is_admin() gate: reads auth.users (owner-only) but only for a verified admin
-- JWT (app_metadata.role='admin', server-set). Any other caller gets "not authorized".
create or replace function public.admin_users_page(
  p_limit  int  default 25,
  p_offset int  default 0,
  p_search text default null,
  p_sort   text default 'created_desc'   -- created_desc | created_asc | active_desc | email_asc
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
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select count(*) into v_total
  from auth.users u
  where v_search is null or u.email ilike '%' || v_search || '%';

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           u.created_at,
           u.last_sign_in_at,
           (u.email_confirmed_at is not null)                as email_confirmed,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.id in (select user_id from public.admin_enrichment_accounts)) as is_driver,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count
    from auth.users u
    where v_search is null or u.email ilike '%' || v_search || '%'
    order by
      (case when p_sort = 'active_desc' then u.last_sign_in_at end) desc nulls last,
      (case when p_sort = 'email_asc'   then u.email           end) asc,
      (case when p_sort = 'created_asc' then u.created_at      end) asc,
      u.created_at desc
    limit v_lim offset v_off
  ) t;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end;
$$;

revoke all on function public.admin_users_page(int, int, text, text) from public, anon;
grant execute on function public.admin_users_page(int, int, text, text) to authenticated;

comment on function public.admin_users_page is
  'Admin-only paginated user list (email, role, signup, last activity, sources count, driver flag). '
  'is_admin()-gated. O(page size) — cheap total count + bounded per-page aggregation, scalable.';
