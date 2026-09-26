-- Operator recovery after a repaired worker failed partway through a refresh.
-- Re-read every inventory in a distinct run; never reset or reuse old proof.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function public.norva_rebuild_failed_credential_refresh(
  p_transition_id uuid, p_user_id uuid, p_dead_job_id uuid,
  p_expected_transition_revision bigint, p_expected_source_revision bigint,
  p_expected_head_revision bigint, p_expected_checkpoint_revision bigint,
  p_expected_refresh_run_id uuid, p_reason text
) returns uuid
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_transition public.cloud_source_transitions%rowtype;
  v_job public.cloud_source_credential_transition_jobs%rowtype;
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_head public.cloud_source_catalog_heads%rowtype;
  v_lifecycle public.cloud_source_lifecycle%rowtype;
  v_source public.cloud_sources%rowtype;
  v_id uuid;
  v_new_run uuid := gen_random_uuid();
  v_key text := 'credential-refresh-rebuild:'||p_dead_job_id::text;
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
    or v_transition.state<>'committing'
    or v_transition.revision is distinct from p_expected_transition_revision then
    raise exception 'refresh rebuild transition CAS failed' using errcode='PT409';
  end if;
  select * into v_source from public.cloud_sources
    where id=v_transition.old_source_id and user_id=p_user_id for update;
  select * into v_lifecycle from public.cloud_source_lifecycle
    where source_id=v_transition.old_source_id and user_id=p_user_id for update;
  select * into v_job from public.cloud_source_credential_transition_jobs
    where id=p_dead_job_id and transition_id=p_transition_id and user_id=p_user_id for update;
  if not found or v_job.state<>'dead' or v_job.job_kind<>'post_switch_verify'
    or v_job.last_error_code is null or v_job.last_error_code not in ('catalog_unhealthy','internal_error')
    or v_job.expected_source_revision is distinct from p_expected_source_revision
    or v_job.catalog_generation_id is distinct from v_transition.candidate_catalog_generation_id
    or v_job.source_id is distinct from v_transition.old_source_id
    or v_job.checkpoint_revision is distinct from p_expected_checkpoint_revision
    or v_job.checkpoint_revision<=1 or p_expected_refresh_run_id is null
    or v_job.title_projection_refresh_run_id is distinct from p_expected_refresh_run_id
    or v_job.title_inventory_completed_at is not null or v_job.title_prune_completed_at is not null then
    raise exception 'refresh rebuild job CAS failed' using errcode='PT409';
  end if;
  select (payload->>'replacementJobId')::uuid into v_id
    from public.cloud_source_lifecycle_events
    where user_id=p_user_id and transition_id=p_transition_id and idempotency_key=v_key;
  if found then return v_id; end if;
  select * into v_head from public.cloud_source_catalog_heads
    where source_id=v_transition.old_source_id and user_id=p_user_id for update;
  select * into v_generation from public.cloud_source_catalog_generations
    where id=v_job.catalog_generation_id and user_id=p_user_id for update;
  if not found or v_source.id is null or v_lifecycle.source_id is null or v_head.source_id is null
    or not v_source.enabled or v_source.deleted_at is not null
    or v_lifecycle.lifecycle_state is distinct from 'active'
    or v_lifecycle.catalog_visibility is distinct from 'visible'
    or v_lifecycle.config_revision is distinct from p_expected_source_revision
    or p_expected_source_revision is distinct from v_transition.expected_source_revision+1
    or v_head.head_revision is distinct from p_expected_head_revision
    or v_head.active_generation_id is distinct from v_generation.id
    or v_generation.state is distinct from 'active'
    or v_generation.source_id is distinct from v_source.id
    or v_generation.transition_id is distinct from p_transition_id
    or v_generation.title_projection_refresh_run_id is distinct from p_expected_refresh_run_id
    or v_generation.title_projection_inventory_completed_at is not null
    or v_generation.title_projection_refreshed_at is not null
    or not exists (select 1 from public.cloud_source_transition_secrets secret
      where secret.transition_id=p_transition_id and secret.user_id=p_user_id
        and secret.swap_applied_at is not null and secret.compensation_started_at is null
        and secret.candidate_refresh_healthy_at is null and secret.cleared_at is null
        and secret.candidate_config_ciphertext=v_source.config_ciphertext)
    or not exists (select 1 from public.cloud_source_catalog_title_refresh_checkpoints checkpoint
      where checkpoint.job_id=v_job.id and checkpoint.refresh_run_id=p_expected_refresh_run_id
        and checkpoint.transition_id=p_transition_id and checkpoint.user_id=p_user_id
        and checkpoint.source_id=v_source.id and checkpoint.generation_id=v_generation.id
        and checkpoint.checkpoint_revision=p_expected_checkpoint_revision
        and checkpoint.head_revision=p_expected_head_revision
        and checkpoint.config_revision=p_expected_source_revision) then
    raise exception 'refresh rebuild snapshot CAS failed' using errcode='PT409';
  end if;
  if exists (select 1 from public.cloud_source_credential_transition_jobs
    where transition_id=p_transition_id and job_kind in ('post_switch_verify','rollback_refresh')
      and state in ('pending','processing')) then
    raise exception 'refresh rebuild already has active work' using errcode='PT409';
  end if;
  insert into public.cloud_source_credential_transition_jobs(
    user_id,transition_id,source_id,catalog_generation_id,expected_source_revision,
    job_kind,title_projection_refresh_run_id
  ) values(p_user_id,p_transition_id,v_source.id,v_generation.id,p_expected_source_revision,
    'post_switch_verify',v_new_run) returning id into v_id;
  update public.cloud_source_catalog_generations
    set title_projection_refresh_run_id=v_new_run,revision=revision+1,updated_at=clock_timestamp()
    where id=v_generation.id and revision=v_generation.revision
      and title_projection_refresh_run_id=p_expected_refresh_run_id;
  if not found then raise exception 'refresh rebuild generation CAS failed' using errcode='PT409'; end if;
  insert into public.cloud_source_lifecycle_events(
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values(p_user_id,v_source.id,p_transition_id,'credential_refresh_rebuild_requested',v_key,
    jsonb_build_object('deadJobId',p_dead_job_id,'replacementJobId',v_id,
      'previousRefreshRunId',p_expected_refresh_run_id,'replacementRefreshRunId',v_new_run,
      'previousCheckpointRevision',p_expected_checkpoint_revision,
      'sourceRevision',p_expected_source_revision,'headRevision',p_expected_head_revision,
      'reason',p_reason),'service_role');
  return v_id;
end
$function$;
revoke all on function public.norva_rebuild_failed_credential_refresh(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.norva_rebuild_failed_credential_refresh(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text)
  to service_role;
commit;
