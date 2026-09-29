-- Real signed Gateway cursor pairs exceed 1024 after safe packing.
-- Retain the 8192-byte total progress limit and all content/shape guards.
-- New Xtream candidate generations use a cinema-first v2 checkpoint:
-- Movies and Series pages alternate, then Live TV is imported last. Existing
-- v1 checkpoints remain valid and retain their historical numeric action order.

create or replace function public.norva_credential_job_progress_safe(
  p_progress jsonb
) returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $function$
declare
  v_key text;
  v_version integer;
  v_type_index integer;
  v_action text;
  v_expected_index integer;
begin
  if p_progress is null or jsonb_typeof(p_progress) <> 'object'
     or octet_length(p_progress::text) > 8192
     or not p_progress ?& array[
       'action','version','typeIndex','categoryOrdinal','itemOffset',
       'categoryPageCursor','categoriesDone','itemCursor',
       'processedCategories','processedItems'
     ]
     or coalesce(p_progress ->> 'version', '') !~ '^[12]$'
     or coalesce(p_progress ->> 'typeIndex', '') !~ '^[0-9]{1,2}$'
     or coalesce(p_progress ->> 'categoryOrdinal', '') !~ '^[0-9]{1,9}$'
     or coalesce(p_progress ->> 'itemOffset', '') !~ '^[0-9]{1,12}$'
     or coalesce(p_progress ->> 'processedCategories', '') !~ '^[0-9]{1,9}$'
     or coalesce(p_progress ->> 'processedItems', '') !~ '^[0-9]{1,15}$'
     or coalesce(jsonb_typeof(p_progress -> 'categoriesDone'),'') <> 'boolean'
     or length(coalesce(p_progress ->> 'categoryPageCursor', '')) > 4096
     or length(coalesce(p_progress ->> 'itemCursor', '')) > 4096
     or concat_ws('', p_progress ->> 'categoryPageCursor', p_progress ->> 'itemCursor')
       ~* '[[:cntrl:]]|://|@|password|username|access_token|api_key' then
    return false;
  end if;

  v_version := (p_progress ->> 'version')::integer;
  v_type_index := (p_progress ->> 'typeIndex')::integer;
  v_action := p_progress ->> 'action';
  v_expected_index := case
    when v_version = 1 then case v_action
      when 'live_categories' then 0 when 'vod_categories' then 1
      when 'series_categories' then 2 when 'live_streams' then 3
      when 'vod_streams' then 4 when 'series_streams' then 5
      when 'episode_state_copy' then 6 when 'complete' then 7 else -1 end
    when v_version = 2 then case v_action
      when 'vod_categories' then 0 when 'series_categories' then 1
      when 'live_categories' then 2 when 'cinema_streams' then 3
      when 'live_streams' then 4 when 'episode_state_copy' then 5
      when 'complete' then 6 else -1 end
    else -1
  end;
  if v_type_index <> v_expected_index
     or ((v_type_index >= 3) <> (p_progress ->> 'categoriesDone')::boolean)
     or (v_version = 1 and v_action in ('live_categories','vod_categories','series_categories')
       and coalesce(p_progress ->> 'itemCursor','') <> '')
     or (v_version = 1 and v_action in ('live_streams','vod_streams','series_streams')
       and coalesce(p_progress ->> 'categoryPageCursor','') <> '')
     or (v_version = 2 and v_action in ('vod_categories','series_categories','live_categories')
       and coalesce(p_progress ->> 'itemCursor','') <> '')
     or (v_version = 2 and v_action = 'live_streams'
       and coalesce(p_progress ->> 'categoryPageCursor','') <> '')
     or (v_action in ('episode_state_copy','complete')
       and (coalesce(p_progress ->> 'categoryPageCursor','') <> ''
         or coalesce(p_progress ->> 'itemCursor','') <> ''))
     or (v_version = 2 and v_action = 'cinema_streams'
       and ((p_progress ->> 'categoryOrdinal')::integer > 3
         or (p_progress ->> 'itemOffset')::integer > 1)) then
    return false;
  end if;

  for v_key in select jsonb_object_keys(p_progress) loop
    if v_key not in (
      'action', 'version', 'typeIndex', 'categoryOrdinal', 'itemOffset',
      'categoryPageCursor', 'categoriesDone', 'itemCursor',
      'processedCategories', 'processedItems'
    ) then return false; end if;
  end loop;
  return true;
end
$function$;
