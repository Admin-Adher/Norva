-- Bound the live-channel summary lookup in a POST body instead of encoding up
-- to hundreds of base64 logical ids in a PostgREST query string. Large live
-- pages otherwise fail before their first materialization checkpoint with
-- HTTP 414 / "URI too long" and are retried forever by the watchdog.

create or replace function public.norva_get_generation_live_channel_summaries(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_logical_ids text[]
) returns table (
  logical_id text,
  variant_preview jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if p_source_id is null or p_user_id is null or p_generation_id is null
     or p_logical_ids is null
     or coalesce(cardinality(p_logical_ids),0) not between 1 and 500
     or exists (
       select 1 from unnest(p_logical_ids) value
       where nullif(btrim(value),'') is null
          or length(value) > 512
          or value ~ '[[:cntrl:]]'
     ) then
    raise exception 'invalid bounded live channel summary lookup'
      using errcode = '22023';
  end if;

  return query
  select channel.logical_id,channel.variant_preview
  from public.cloud_live_logical_channels channel
  where channel.source_id = p_source_id
    and channel.user_id = p_user_id
    and channel.generation_id = p_generation_id
    and channel.logical_id = any(p_logical_ids)
  order by channel.logical_id;
end
$function$;

revoke all on function public.norva_get_generation_live_channel_summaries(
  uuid,uuid,uuid,text[]
) from public,anon,authenticated,service_role;
grant execute on function public.norva_get_generation_live_channel_summaries(
  uuid,uuid,uuid,text[]
) to service_role;

do $assert$
begin
  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.norva_get_generation_live_channel_summaries(uuid,uuid,uuid,text[])',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.norva_get_generation_live_channel_summaries(uuid,uuid,uuid,text[])',
       'EXECUTE'
     ) then
    raise exception 'live channel summary lookup ACL invariant failed';
  end if;
end
$assert$;

notify pgrst, 'reload schema';
