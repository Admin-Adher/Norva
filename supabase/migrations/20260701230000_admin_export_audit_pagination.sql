-- CRM audit priorities #2 and #5 + cleanup.
--
-- (1) admin_users_export — CSV export source. Same filters as admin_users_page (search incl. UUID,
--     segment) but returns up to 10 000 rows in one call (bounded: beyond that, export should move
--     server-side/chunked — documented threshold). Per-row work stays indexed lookups.
-- (2) admin_audit_feed gains keyset pagination (p_before on created_at) for a "Charger plus" UI —
--     scales regardless of depth (no OFFSET). The 2-arg version must be DROPPED first: CREATE OR
--     REPLACE with a different signature would create an overload and make PostgREST calls ambiguous.
-- (3) drop admin_audit_log — superseded by admin_events (0 rows, 0 code references).

create or replace function public.admin_users_export(
  p_search text default null,
  p_tag_id uuid default null,
  p_limit  int  default 10000
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lim    int  := greatest(1, least(10000, coalesce(p_limit, 10000)));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_uuid   uuid := null;
  v_rows   jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           (u.email_confirmed_at is not null)                as email_confirmed,
           u.created_at,
           u.last_sign_in_at,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count,
           (select coalesce(string_agg(tg.label, '|' order by tg.label), '')
              from public.admin_client_tags ctg join public.admin_tags tg on tg.id = ctg.tag_id
              where ctg.user_id = u.id) as tags
    from auth.users u
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
      and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
    order by u.created_at desc
    limit v_lim
  ) t;
  return v_rows;
end;
$$;
revoke all on function public.admin_users_export(text, uuid, int) from public, anon;
grant execute on function public.admin_users_export(text, uuid, int) to authenticated;

drop function if exists public.admin_audit_feed(int, text);
create or replace function public.admin_audit_feed(
  p_limit  int  default 60,
  p_kind   text default null,
  p_before timestamptz default null
) returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select e.id, e.kind, e.summary, e.actor, e.created_at, e.user_id,
           u.email::text as client_email
    from public.admin_events e
    left join auth.users u on u.id = e.user_id
    where (p_kind is null or e.kind = p_kind)
      and (p_before is null or e.created_at < p_before)
    order by e.created_at desc
    limit greatest(1, least(200, coalesce(p_limit, 60)))
  ) t;
  return v_rows;
end; $$;
revoke all on function public.admin_audit_feed(int, text, timestamptz) from public, anon;
grant execute on function public.admin_audit_feed(int, text, timestamptz) to authenticated;

drop table if exists public.admin_audit_log;
