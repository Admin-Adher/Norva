-- CRM audit priority #4 — bulk segment actions. With a segment (tag) selected in the Clients list,
-- the admin can apply ANOTHER tag to every client of the segment, or strip the segment tag from all.
-- One transaction; every affected client gets its own admin_events row (same kinds as the unit
-- toggle, suffixed "(groupé)") so fiche timelines and the audit journal stay complete. Bounded by the
-- segment's size; data-modifying CTEs always run to completion, so events can't desync from writes.
create or replace function public.admin_tag_bulk(p_tag uuid, p_action text, p_other uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text; v_count int := 0; v_label text; v_other_label text;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  v_email := nullif(auth.jwt() ->> 'email', '');
  select label into v_label from public.admin_tags where id = p_tag;
  if v_label is null then raise exception 'unknown tag' using errcode = 'P0002'; end if;

  if p_action = 'apply' then
    if p_other is null or p_other = p_tag then
      raise exception 'invalid target tag' using errcode = '22023';
    end if;
    select label into v_other_label from public.admin_tags where id = p_other;
    if v_other_label is null then raise exception 'unknown target tag' using errcode = 'P0002'; end if;
    with ins as (
      insert into public.admin_client_tags(user_id, tag_id, added_by)
      select ct.user_id, p_other, v_email from public.admin_client_tags ct where ct.tag_id = p_tag
      on conflict do nothing
      returning user_id
    ), ev as (
      insert into public.admin_events(user_id, kind, summary, actor)
      select user_id, 'tag_added', 'Tag ajouté (groupé) : ' || v_other_label, v_email from ins
    )
    select count(*) into v_count from ins;
  elsif p_action = 'remove' then
    with del as (
      delete from public.admin_client_tags where tag_id = p_tag
      returning user_id
    ), ev as (
      insert into public.admin_events(user_id, kind, summary, actor)
      select user_id, 'tag_removed', 'Tag retiré (groupé) : ' || v_label, v_email from del
    )
    select count(*) into v_count from del;
  else
    raise exception 'unknown action (apply|remove)' using errcode = '22023';
  end if;

  return jsonb_build_object('action', p_action, 'count', v_count);
end; $$;

revoke all on function public.admin_tag_bulk(uuid, text, uuid) from public, anon;
grant execute on function public.admin_tag_bulk(uuid, text, uuid) to authenticated;
