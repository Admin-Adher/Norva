-- Confirm this page's exact payload after at least one matching current-run
-- variant has been committed. Other variants of the same title may occur on
-- later pages or be removed by the final inventory prune. Requiring them all
-- here deadlocks the first page. Complete-inventory/prune proof still requires
-- every surviving variant to belong to this refresh before finalization.
begin;
set local lock_timeout='2s';
CREATE OR REPLACE FUNCTION public.norva_confirm_active_catalog_title_projection_batch(p_source_id uuid, p_user_id uuid, p_generation_id uuid, p_refresh_run_id uuid, p_job_id uuid, p_worker text, p_lease_sequence integer, p_head_revision bigint, p_config_revision bigint, p_source_visibility_epoch bigint, p_user_visibility_epoch bigint, p_titles jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_epoch bigint;
  v_expected integer;
  v_confirmed integer;
  v_generation_revision bigint;
  v_action text;
begin
  perform public.norva_credential_lock_account(p_user_id);
  perform public.norva_credential_require_service_role();
  if p_refresh_run_id is null or p_job_id is null
     or nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_lease_sequence is null or p_lease_sequence < 1
     or p_titles is null
     or jsonb_typeof(p_titles) <> 'array'
     or jsonb_array_length(p_titles) > 500
     or octet_length(p_titles::text) > 1048576
     or exists (
       select 1
       from jsonb_array_elements(p_titles) row(value)
       where jsonb_typeof(row.value) <> 'object'
          or (select count(*) from jsonb_object_keys(row.value)) <> 4
          or not (row.value ?& array[
            'itemType','identityKey','titleId','payloadUpdatedAt'
          ])
          or row.value ->> 'itemType' not in ('movie','series')
          or nullif(btrim(row.value ->> 'identityKey'),'') is null
          or nullif(row.value ->> 'titleId','') is null
          or nullif(row.value ->> 'payloadUpdatedAt','') is null
     ) then
    raise exception 'active title confirmation batch is invalid or oversized'
      using errcode = '22023';
  end if;
  begin
    perform (row.value ->> 'titleId')::uuid,
      (row.value ->> 'payloadUpdatedAt')::timestamptz
    from jsonb_array_elements(p_titles) row(value);
  exception when invalid_text_representation or datetime_field_overflow then
    raise exception 'active title confirmation proof is malformed'
      using errcode = '22023';
  end;
  select count(*)::integer into v_expected
  from jsonb_array_elements(p_titles);
  if v_expected is distinct from (
    select count(*)::integer
    from (
      select distinct row.value ->> 'itemType',
        row.value ->> 'identityKey',row.value ->> 'titleId'
      from jsonb_array_elements(p_titles) row(value)
    ) unique_row
  ) then
    raise exception 'active title confirmation contains duplicates'
      using errcode = '22023';
  end if;
  if v_expected > 0 then
    if (
      select count(distinct row.value ->> 'itemType')
      from jsonb_array_elements(p_titles) row(value)
    ) <> 1 then
      raise exception 'active title confirmation crosses provider actions'
        using errcode = '22023';
    end if;
    select case min(row.value ->> 'itemType')
      when 'movie' then 'vod_streams' else 'series_streams' end
    into v_action
    from jsonb_array_elements(p_titles) row(value);
  end if;

  select transition.* into v_transition
  from public.cloud_source_transitions transition
  where transition.user_id = p_user_id
    and transition.old_source_id = p_source_id
    and transition.candidate_catalog_generation_id = p_generation_id
    and transition.state = 'committing'
  for update;
  if not found then
    raise exception 'active title confirmation transition CAS failed'
      using errcode = 'PT409', detail = 'reason=credential_transition_changed';
  end if;
  select job.* into v_job
  from public.cloud_source_credential_transition_jobs job
  where job.id = p_job_id and job.transition_id = v_transition.id
    and job.user_id = p_user_id and job.source_id = p_source_id
    and job.catalog_generation_id = p_generation_id
    and job.job_kind = 'post_switch_verify'
    and job.state = 'processing' and job.lease_owner = p_worker
    and job.lease_sequence = p_lease_sequence and job.lease_until > now()
    and job.title_projection_refresh_run_id = p_refresh_run_id
  for update;
  if not found then
    raise exception 'active title confirmation job lease CAS failed'
      using errcode = 'PT409', detail = 'reason=credential_job_lease_changed';
  end if;
  if v_expected > 0 then
    perform public.norva_require_active_catalog_refresh_action(
      p_job_id,p_refresh_run_id,v_action,null
    );
  end if;
  select generation.* into v_generation
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id
    and generation.user_id = p_user_id
    and generation.source_id = p_source_id
    and generation.state = 'active'
    and generation.transition_id = v_transition.id
    and generation.title_projection_refresh_run_id = p_refresh_run_id
    and not generation.manifest_sealing
  for update;
  if not found then
    raise exception 'active title confirmation generation CAS failed'
      using errcode = 'PT409', detail = 'reason=catalog_generation_changed';
  end if;
  insert into public.cloud_user_catalog_visibility_epochs(
    user_id,visibility_epoch,updated_at
  ) values (p_user_id,1,now()) on conflict (user_id) do nothing;
  select epoch.visibility_epoch into v_epoch
  from public.cloud_user_catalog_visibility_epochs epoch
  where epoch.user_id = p_user_id for update;
  if v_epoch is distinct from p_user_visibility_epoch
     or v_generation.config_revision is distinct from p_config_revision
     or not exists (
       select 1
       from public.cloud_source_catalog_heads head
       join public.cloud_source_lifecycle lifecycle
         on lifecycle.source_id = head.source_id
        and lifecycle.user_id = head.user_id
       join public.cloud_source_transitions transition
         on transition.id = v_generation.transition_id
        and transition.user_id = v_generation.user_id
       where head.source_id = p_source_id and head.user_id = p_user_id
         and head.active_generation_id = p_generation_id
         and head.head_revision = p_head_revision
         and lifecycle.config_revision = p_config_revision
         and lifecycle.visibility_epoch = p_source_visibility_epoch
         and transition.state = 'committing'
         and public.norva_source_post_switch_refresh_allowed(p_source_id,p_user_id,p_generation_id,p_job_id,p_worker,p_lease_sequence)
     ) then
    raise exception 'active title confirmation snapshot CAS failed'
      using errcode = 'PT409', detail = 'reason=catalog_generation_changed';
  end if;
  with supplied as materialized (
    select row.value ->> 'itemType' as item_type,
      row.value ->> 'identityKey' as identity_key,
      (row.value ->> 'titleId')::uuid as title_id,
      (row.value ->> 'payloadUpdatedAt')::timestamptz as payload_updated_at
    from jsonb_array_elements(p_titles) row(value)
  ), confirmed as (
    update public.cloud_source_catalog_generation_candidate_titles projection
    set post_switch_refreshed = true
    from supplied
    where projection.generation_id = p_generation_id
      and projection.user_id = p_user_id
      and projection.source_id = p_source_id
      and projection.item_type = supplied.item_type
      and projection.identity_key = supplied.identity_key
      and projection.title_id = supplied.title_id
      and projection.updated_at = supplied.payload_updated_at
      and exists (
        select 1
        from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.source_id = p_source_id
          and variant.user_id = p_user_id
          and variant.title_id = supplied.title_id
          and variant.projection_refresh_run_id = p_refresh_run_id
      )

    returning projection.title_id
  ) select count(*)::integer into v_confirmed from confirmed;
  if v_confirmed <> v_expected then
    raise exception 'active title confirmation variant/payload proof mismatch'
      using errcode = 'PT409',
        detail = 'reason=post_switch_title_confirmation_mismatch';
  end if;
  select generation.revision into v_generation_revision
  from public.cloud_source_catalog_generations generation
  where generation.id = p_generation_id;
  return jsonb_build_object(
    'contract','catalog-title-active-confirm-v1',
    'generationId',p_generation_id,'refreshRunId',p_refresh_run_id,
    'jobId',p_job_id,'leaseSequence',p_lease_sequence,
    'headRevision',p_head_revision,'configRevision',p_config_revision,
    'sourceVisibilityEpoch',p_source_visibility_epoch,
    'visibilityEpoch',v_epoch,'generationRevision',v_generation_revision,
    'confirmedTitles',v_confirmed,'complete',true
  );
end
$function$;


commit;
