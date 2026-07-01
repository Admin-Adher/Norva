-- Système page — global admin audit feed. Returns recent admin_events across ALL clients (note/tag
-- actions + privileged norva-admin actions), joined to the acted-on client's email so each line links
-- to a fiche. is_admin()-gated, SECURITY DEFINER. Bounded limit → cheap.
create or replace function public.admin_audit_feed(p_limit int default 60, p_kind text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select e.id, e.kind, e.summary, e.actor, e.created_at, e.user_id,
           u.email::text as client_email
    from public.admin_events e
    left join auth.users u on u.id = e.user_id
    where p_kind is null or e.kind = p_kind
    order by e.created_at desc
    limit greatest(1, least(200, coalesce(p_limit, 60)))
  ) t;
  return v_rows;
end; $$;

revoke all on function public.admin_audit_feed(int, text) from public, anon;
grant execute on function public.admin_audit_feed(int, text) to authenticated;
