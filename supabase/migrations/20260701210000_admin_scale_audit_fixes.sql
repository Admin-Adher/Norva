-- CRM audit pass — scale & UX fixes surfaced by the full-dashboard review.
--
-- (1) admin_events needs a GLOBAL (created_at desc) index: admin_audit_feed orders the whole table
--     by created_at with no user filter, and the only existing index leads with user_id — at scale
--     the feed would seq-scan + sort. Cheap btree fixes it.
-- (2) admin_events retention: sync lifecycle events are bounded (once per source/kind) but note/tag/
--     admin-action events grow forever. Weekly prune keeps 180 days — enough history for a timeline,
--     bounded for scale. Guarded DO block so re-running the migration doesn't duplicate the job.
-- (3) admin_users_page: surface `banned` (a CRM list must show suspended accounts at a glance) and
--     accept a UUID as the search term (support workflows often start from an id in logs).
create index if not exists idx_admin_events_created on public.admin_events (created_at desc);

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'norva-admin-events-prune') then
    perform cron.schedule(
      'norva-admin-events-prune',
      '15 4 * * 0',  -- sunday 04:15 UTC
      $prune$ delete from public.admin_events where created_at < now() - interval '180 days' $prune$
    );
  end if;
end $$;

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
  v_uuid   uuid   := null;
  v_total  bigint;
  v_rows   jsonb;
  v_alltags jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- UUID search: an exact id (from logs/support tickets) finds the account directly.
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;

  select count(*) into v_total
  from auth.users u
  where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
    and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id));

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           u.created_at,
           u.last_sign_in_at,
           (u.email_confirmed_at is not null)                as email_confirmed,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.id in (select user_id from public.admin_enrichment_accounts)) as is_driver,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count,
           (select coalesce(jsonb_agg(jsonb_build_object('id',tg.id,'label',tg.label,'color',tg.color) order by tg.label), '[]'::jsonb)
              from public.admin_client_tags ctg join public.admin_tags tg on tg.id = ctg.tag_id where ctg.user_id = u.id) as tags
    from auth.users u
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
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
