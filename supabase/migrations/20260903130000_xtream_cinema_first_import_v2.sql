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
     or length(coalesce(p_progress ->> 'categoryPageCursor', '')) > 1024
     or length(coalesce(p_progress ->> 'itemCursor', '')) > 1024
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

alter table public.cloud_source_credential_transition_jobs
  alter column progress set default
  '{"action":"vod_categories","version":2,"typeIndex":0,"categoryOrdinal":0,"itemOffset":0,"categoryPageCursor":"","categoriesDone":false,"itemCursor":"","processedCategories":0,"processedItems":0}'::jsonb;

create or replace function public.norva_reset_credential_catalog_generation(
  p_transition_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_job_id uuid,
  p_worker text,
  p_expected_lease_sequence integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_job public.cloud_source_credential_transition_jobs%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  join public.cloud_source_transitions transition
    on transition.id = job.transition_id and transition.user_id = job.user_id
  join public.cloud_source_catalog_generations generation
    on generation.id = job.catalog_generation_id
  where job.id = p_job_id and job.transition_id = p_transition_id
    and job.user_id = p_user_id and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'build_candidate_generation'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_expected_lease_sequence
    and job.lease_until > now() and transition.state = 'importing'
    and generation.state = 'building'
  for update of job;
  if not found then raise exception 'generation reset lease CAS failed' using errcode = 'PT409'; end if;

  update public.cloud_live_variants set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_live_variants where generation_id = p_generation_id;
  update public.catalog_series_episode_memberships set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.catalog_series_episode_memberships where generation_id = p_generation_id;
  update public.catalog_series_inventory_state set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.catalog_series_inventory_state where generation_id = p_generation_id;
  update public.cloud_title_variants set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_title_variants where generation_id = p_generation_id;
  update public.cloud_live_logical_channels set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_live_logical_channels where generation_id = p_generation_id;
  update public.cloud_media_items set
    ingest_job_id = p_job_id, ingest_attempt = p_expected_lease_sequence,
    ingest_lease_owner = p_worker where generation_id = p_generation_id;
  delete from public.cloud_media_items where generation_id = p_generation_id;
  update public.cloud_source_credential_transition_jobs
  set progress = '{"action":"vod_categories","version":2,"typeIndex":0,"categoryOrdinal":0,"itemOffset":0,"categoryPageCursor":"","categoriesDone":false,"itemCursor":"","processedCategories":0,"processedItems":0}'::jsonb,
      checkpoint_revision = checkpoint_revision + 1
  where id = p_job_id;
  return jsonb_build_object(
    'transitionId', p_transition_id,
    'generationId', p_generation_id,
    'reset', true,
    'checkpointRevision', v_job.checkpoint_revision + 1
  );
end
$function$;

comment on function public.norva_credential_job_progress_safe(jsonb) is
  'Validates legacy v1 generation checkpoints and cinema-first v2 checkpoints without accepting credentials.';
