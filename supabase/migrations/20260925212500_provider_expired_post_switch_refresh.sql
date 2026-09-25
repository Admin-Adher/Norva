begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Public reads stay hidden. Only the leased verification of the active
-- credential candidate may refresh a source hidden by Provider Access.
create or replace function public.norva_source_post_switch_refresh_allowed(
  p_source_id uuid, p_user_id uuid, p_generation_id uuid,
  p_job_id uuid, p_worker text, p_lease_sequence integer
) returns boolean
language sql stable security definer set search_path = ''
as $function$
  select public.norva_source_catalog_visible_internal(p_source_id,p_user_id)
    or exists (
      select 1
      from public.cloud_sources source
      join public.cloud_source_lifecycle lifecycle
        on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
      join public.cloud_source_provider_access access
        on access.source_id=source.id and access.user_id=source.user_id
      join public.cloud_source_catalog_heads head
        on head.source_id=source.id and head.user_id=source.user_id
      join public.cloud_source_catalog_generations generation
        on generation.id=head.active_generation_id
        and generation.source_id=source.id and generation.user_id=source.user_id
      join public.cloud_source_transitions transition
        on transition.id=generation.transition_id and transition.user_id=source.user_id
      join public.cloud_source_credential_transition_jobs job
        on job.transition_id=transition.id and job.user_id=source.user_id
        and job.source_id=source.id and job.catalog_generation_id=generation.id
      where source.id=p_source_id and source.user_id=p_user_id
        and source.enabled and source.deleted_at is null
        and lifecycle.lifecycle_state='active' and lifecycle.catalog_visibility='visible'
        and generation.id=p_generation_id and generation.state='active'
        and generation.config_revision=lifecycle.config_revision
        and transition.transition_kind='credential' and transition.state='committing'
        and transition.old_source_id=source.id
        and transition.candidate_catalog_generation_id=generation.id
        and job.id=p_job_id and job.job_kind='post_switch_verify'
        and job.expected_source_revision=lifecycle.config_revision
        and job.state='processing' and job.lease_owner=p_worker
        and job.lease_sequence=p_lease_sequence and job.lease_until>now()
        and (access.provider_access_status in ('expired_confirmed','access_unavailable_confirmed')
          or (access.provider_access_status='restoring'
            and access.provider_access_hidden_at is not null
            and (access.provider_access_restored_at is null
              or access.provider_access_restored_at<access.provider_access_hidden_at)))
    )
$function$;
revoke all on function public.norva_source_post_switch_refresh_allowed(uuid,uuid,uuid,uuid,text,integer)
  from public,anon,authenticated,service_role;

-- Preserve all later account locks, payload optimizations and PT409 mappings.
-- Fail closed if a writer no longer has precisely the expected visibility
-- predicate. Its existing lease/head/epoch/run fences are left intact.
do $patch$
declare v_name text; v_oid oid; v_body text; v_new text;
begin
  foreach v_name in array array[
    'norva_begin_active_catalog_title_projection_refresh',
    'norva_lock_active_catalog_refresh_lease',
    'norva_upsert_active_catalog_title_payloads',
    'norva_upsert_active_catalog_title_variants',
    'norva_confirm_active_catalog_title_projection_batch',
    'norva_complete_active_catalog_title_refresh_action',
    'norva_reconcile_active_catalog_title_projection_batch',
    'norva_mark_active_catalog_title_projection_refreshed'
  ] loop
    select p.oid into strict v_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=v_name;
    v_body:=pg_get_functiondef(v_oid);
    if (select count(*) from regexp_matches(v_body,
      'public\.norva_source_catalog_visible_internal\(\s*p_source_id,\s*p_user_id\s*\)','g'))<>1
      or position('p_job_id uuid' in v_body)=0
      or position('p_lease_sequence integer' in v_body)=0 then
      raise exception 'post-switch writer contract drift: %',v_name using errcode='55000';
    end if;
    v_new:=regexp_replace(v_body,
      'public\.norva_source_catalog_visible_internal\(\s*p_source_id,\s*p_user_id\s*\)',
      'public.norva_source_post_switch_refresh_allowed(p_source_id,p_user_id,p_generation_id,p_job_id,p_worker,p_lease_sequence)');
    execute v_new;
  end loop;
end
$patch$;

-- Row triggers require the same current job/run as the enclosing writer.
-- Merely hiding a source or setting a session variable grants no write access.
create or replace function public.norva_hidden_refresh_context_allowed(
  p_source_id uuid, p_user_id uuid, p_generation_id uuid
) returns boolean
language plpgsql stable security definer set search_path = ''
as $function$
declare v_context jsonb; v_setting text;
begin
  foreach v_setting in array array[
    'norva.catalog_active_variant_refresh','norva.catalog_active_inventory_prune',
    'norva.catalog_candidate_title_write'
  ] loop
    begin
      v_context:=nullif(current_setting(v_setting,true),'')::jsonb;
      if (v_context->>'sourceId')::uuid=p_source_id
        and (v_context->>'userId')::uuid=p_user_id
        and (v_context->>'generationId')::uuid=p_generation_id
        and public.norva_source_post_switch_refresh_allowed(
          p_source_id,p_user_id,p_generation_id,(v_context->>'jobId')::uuid,
          v_context->>'worker',(v_context->>'leaseSequence')::integer)
        and exists (
          select 1 from public.cloud_source_catalog_generations generation
          join public.cloud_source_credential_transition_jobs job
            on job.catalog_generation_id=generation.id and job.transition_id=generation.transition_id
          where generation.id=p_generation_id and generation.source_id=p_source_id
            and generation.user_id=p_user_id
            and generation.transition_id=(v_context->>'transitionId')::uuid
            and generation.title_projection_refresh_run_id=(v_context->>'refreshRunId')::uuid
            and job.id=(v_context->>'jobId')::uuid
            and job.title_projection_refresh_run_id=generation.title_projection_refresh_run_id
        ) then return true;
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      null;
    end;
  end loop;
  return false;
end
$function$;
revoke all on function public.norva_hidden_refresh_context_allowed(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;

do $row_guard$
declare
  v_body text:=pg_get_functiondef('public.norva_catalog_generation_write_guard()'::regprocedure);
  v_old text:='(not v_visible and not v_online_backfill)';
  v_new text:='(not v_visible and not v_online_backfill and not public.norva_hidden_refresh_context_allowed(v_owner_source_id,v_owner_user_id,v_generation_id))';
begin
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then
    raise exception 'catalog row visibility guard drift' using errcode='55000';
  end if;
  execute replace(v_body,v_old,v_new);
end
$row_guard$;

-- A newly discovered title needs an FK shell even while hidden. Bind the
-- shell-only mirror suppression to the same worker lease as the payload RPC.
do $title_context$
declare v_body text; v_old text; v_new text;
begin
  select pg_get_functiondef(p.oid) into strict v_body from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname='norva_upsert_active_catalog_title_payloads';
  v_old:=E'''refreshRunId'',p_refresh_run_id\n      )::text';
  v_new:=E'''refreshRunId'',p_refresh_run_id,''transitionId'',v_transition_id,''jobId'',p_job_id,''worker'',p_worker,''leaseSequence'',p_lease_sequence\n      )::text';
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then
    raise exception 'active title writer context drift' using errcode='55000';
  end if;
  execute replace(v_body,v_old,v_new);
  v_body:=pg_get_functiondef('public.cloud_titles_mirror_to_catalog()'::regprocedure);
  v_old:='(select count(*) from jsonb_object_keys(v_context)) <> 9';
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1
    or (select count(*) from regexp_matches(v_body,
      'public\.norva_source_catalog_visible_internal\(\s*generation.source_id,\s*generation.user_id\s*\)','g'))<>1 then
    raise exception 'active title mirror context drift' using errcode='55000';
  end if;
  v_body:=replace(v_body,v_old,'(select count(*) from jsonb_object_keys(v_context)) <> 13');
  execute regexp_replace(v_body,
    'public\.norva_source_catalog_visible_internal\(\s*generation.source_id,\s*generation.user_id\s*\)',
    '(public.norva_source_catalog_visible_internal(generation.source_id,generation.user_id) or public.norva_hidden_refresh_context_allowed(generation.source_id,generation.user_id,generation.id))');
end
$title_context$;

-- Operator repair for this specific pre-refresh failure. A replacement job is
-- appended; the dead job and its failure evidence remain immutable. Partial
-- refreshes need their own recovery protocol and are deliberately rejected.
create or replace function public.norva_retry_unstarted_credential_refresh(
  p_transition_id uuid, p_user_id uuid, p_dead_job_id uuid,
  p_expected_transition_revision bigint, p_expected_source_revision bigint,
  p_reason text
) returns uuid
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_id uuid;
  v_key text:='credential-refresh-retry:'||p_dead_job_id::text;
begin
  perform public.norva_credential_require_service_role();
  if p_reason is null or length(btrim(p_reason))<12 or length(p_reason)>240
    or p_reason ~ '[[:cntrl:]]|://|@' then
    raise exception 'bounded operator reason required' using errcode='22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select * into v_transition from public.cloud_source_transitions
  where id=p_transition_id and user_id=p_user_id for update;
  if not found or v_transition.transition_kind<>'credential'
    or v_transition.state<>'committing' or v_transition.revision is distinct from p_expected_transition_revision then
    raise exception 'unstarted refresh transition CAS failed' using errcode='PT409';
  end if;
  select * into v_job from public.cloud_source_credential_transition_jobs
  where id=p_dead_job_id and transition_id=p_transition_id and user_id=p_user_id for update;
  if not found or v_job.state<>'dead' or v_job.job_kind<>'post_switch_verify'
    or v_job.last_error_code is distinct from 'catalog_unhealthy'
    or v_job.title_projection_refresh_run_id is not null
    or v_job.expected_source_revision<>p_expected_source_revision
    or v_job.catalog_generation_id is distinct from v_transition.candidate_catalog_generation_id
    or not exists (
      select 1 from public.cloud_sources source
      join public.cloud_source_lifecycle lifecycle
        on lifecycle.source_id=source.id and lifecycle.user_id=source.user_id
      join public.cloud_source_catalog_heads head
        on head.source_id=source.id and head.user_id=source.user_id
      join public.cloud_source_catalog_generations generation on generation.id=head.active_generation_id
      join public.cloud_source_transition_secrets secret
        on secret.transition_id=p_transition_id and secret.user_id=source.user_id
      where source.id=v_transition.old_source_id and source.user_id=p_user_id
        and source.enabled and source.deleted_at is null
        and lifecycle.lifecycle_state='active' and lifecycle.catalog_visibility='visible'
        and lifecycle.config_revision=p_expected_source_revision
        and generation.id=v_job.catalog_generation_id and generation.state='active'
        and generation.transition_id=p_transition_id
        and generation.title_projection_refresh_run_id is null
        and secret.swap_applied_at is not null and secret.compensation_started_at is null
        and source.config_ciphertext=secret.candidate_config_ciphertext
    ) then
    raise exception 'unstarted refresh job CAS failed' using errcode='PT409';
  end if;
  select (payload->>'replacementJobId')::uuid into v_id
  from public.cloud_source_lifecycle_events
  where user_id=p_user_id and idempotency_key=v_key and transition_id=p_transition_id;
  if found then return v_id; end if;
  if exists(select 1 from public.cloud_source_credential_transition_jobs
    where transition_id=p_transition_id and job_kind='post_switch_verify'
      and state in ('pending','processing')) then
    raise exception 'unstarted refresh already has an active job' using errcode='PT409';
  end if;
  insert into public.cloud_source_credential_transition_jobs(
    user_id,transition_id,source_id,catalog_generation_id,expected_source_revision,job_kind
  ) values(p_user_id,p_transition_id,v_job.source_id,v_job.catalog_generation_id,
    p_expected_source_revision,'post_switch_verify') returning id into v_id;
  insert into public.cloud_source_lifecycle_events(
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values(p_user_id,v_job.source_id,p_transition_id,'credential_refresh_retry_requested',v_key,
    jsonb_build_object('deadJobId',p_dead_job_id,'replacementJobId',v_id,'reason',p_reason),'service_role');
  return v_id;
end
$function$;
revoke all on function public.norva_retry_unstarted_credential_refresh(uuid,uuid,uuid,bigint,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.norva_retry_unstarted_credential_refresh(uuid,uuid,uuid,bigint,bigint,text)
  to service_role;
commit;
