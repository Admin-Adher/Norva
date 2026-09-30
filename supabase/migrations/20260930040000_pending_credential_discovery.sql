-- Discover the durable pending repair after navigation or on another device.
create or replace function public.norva_get_pending_credential_transition(
  p_source_id uuid, p_user_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare v_id uuid;
begin
  perform public.norva_credential_require_service_role();
  select id into v_id from public.cloud_source_transitions
  where user_id = p_user_id and old_source_id = p_source_id
    and transition_kind = 'credential'
    and state not in ('completed','failed','cancelled')
  order by created_at desc limit 1;
  if v_id is null then return null; end if;
  return public.norva_credential_transition_result(v_id,p_user_id);
end
$function$;
revoke all on function public.norva_get_pending_credential_transition(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_get_pending_credential_transition(uuid,uuid) to service_role;
