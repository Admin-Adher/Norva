-- An initialized run rejected before its first provider page is still empty.
-- Reissue it with a new job/run identity while retaining all failure evidence.
-- Any accepted digest, page checkpoint or inventory progress blocks this RPC.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

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
  v_generation public.cloud_source_catalog_generations%rowtype;
  v_new_run uuid;
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
    or v_job.last_error_code is null or v_job.last_error_code not in ('catalog_unhealthy','internal_error')
    or v_job.expected_source_revision is distinct from p_expected_source_revision
    or v_job.catalog_generation_id is distinct from v_transition.candidate_catalog_generation_id
  then
    raise exception 'unstarted refresh job CAS failed' using errcode='PT409';
  end if;
  select (payload->>'replacementJobId')::uuid into v_id
  from public.cloud_source_lifecycle_events
  where user_id=p_user_id and idempotency_key=v_key and transition_id=p_transition_id;
  if found then return v_id; end if;
  if not exists (
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
        and generation.title_projection_refresh_run_id is not distinct from v_job.title_projection_refresh_run_id
        and generation.title_projection_inventory_completed_at is null
        and generation.title_projection_refreshed_at is null
        and secret.swap_applied_at is not null and secret.compensation_started_at is null
        and source.config_ciphertext=secret.candidate_config_ciphertext
    ) then
    raise exception 'unstarted refresh job CAS failed' using errcode='PT409';
  end if;
  select * into strict v_generation from public.cloud_source_catalog_generations
  where id=v_job.catalog_generation_id and user_id=p_user_id for update;
  if v_job.title_projection_refresh_run_id is not null then
    -- No manifest was ever bound and no page can have been written through
    -- the guarded writer protocol. Preserve the old job and ledger verbatim.
    if v_job.checkpoint_revision<>1 or not exists (
      select 1 from public.cloud_source_catalog_title_refresh_checkpoints checkpoint
      where checkpoint.job_id=v_job.id
        and checkpoint.refresh_run_id=v_job.title_projection_refresh_run_id
        and checkpoint.transition_id=p_transition_id and checkpoint.user_id=p_user_id
        and checkpoint.source_id=v_job.source_id and checkpoint.generation_id=v_generation.id
        and checkpoint.checkpoint_revision=1
        and checkpoint.progress=jsonb_build_object('version',1,'catalogVersion',v_generation.revision,
          'action','live_categories','actionComplete',false,'cursor','','spoolToken','',
          'contentSha256','','processedCategories',0,'processedItems',0,'observedItems',0,'categoryCount',0)
    ) or (select count(*) from public.cloud_source_catalog_title_refresh_actions action
      where action.job_id=v_job.id and action.refresh_run_id=v_job.title_projection_refresh_run_id
        and action.state='started' and action.catalog_version is null
        and action.category_count is null and action.observed_count is null
        and action.active_row_count is null and action.pruned_count is null
        and action.content_sha256 is null and action.checkpoint_revision is null
        and not action.inventory_complete and not action.prune_complete and not action.prune_safe)<>3 then
      raise exception 'refresh already has provider progress' using errcode='PT409';
    end if;
    v_new_run:=gen_random_uuid();
  end if;
  if exists(select 1 from public.cloud_source_credential_transition_jobs
    where transition_id=p_transition_id and job_kind='post_switch_verify'
      and state in ('pending','processing')) then
    raise exception 'unstarted refresh already has an active job' using errcode='PT409';
  end if;
  insert into public.cloud_source_credential_transition_jobs(
    user_id,transition_id,source_id,catalog_generation_id,expected_source_revision,job_kind,title_projection_refresh_run_id
  ) values(p_user_id,p_transition_id,v_job.source_id,v_job.catalog_generation_id,
    p_expected_source_revision,'post_switch_verify',v_new_run) returning id into v_id;
  if v_new_run is not null then
    update public.cloud_source_catalog_generations set title_projection_refresh_run_id=v_new_run,
      revision=revision+1,updated_at=clock_timestamp()
    where id=v_generation.id and title_projection_refresh_run_id=v_job.title_projection_refresh_run_id
      and revision=v_generation.revision;
    if not found then raise exception 'empty refresh generation changed' using errcode='PT409'; end if;
  end if;
  insert into public.cloud_source_lifecycle_events(
    user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor
  ) values(p_user_id,v_job.source_id,p_transition_id,'credential_refresh_retry_requested',v_key,
    jsonb_build_object('deadJobId',p_dead_job_id,'replacementJobId',v_id,'previousRefreshRunId',v_job.title_projection_refresh_run_id,'replacementRefreshRunId',v_new_run,'reason',p_reason),'service_role');
  return v_id;
end
$function$;
revoke all on function public.norva_retry_unstarted_credential_refresh(uuid,uuid,uuid,bigint,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.norva_retry_unstarted_credential_refresh(uuid,uuid,uuid,bigint,bigint,text)
  to service_role;
commit;
