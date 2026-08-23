-- Durable dispatcher.  It never deletes Auth and never performs provider I/O:
-- those effects are separately fenced.  Its sole authority is advancing the
-- persisted state after the prerequisite has been observed in PostgreSQL.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.norva_advance_account_deletion_workflow(
  p_user_id uuid,
  p_expected_revision bigint,
  p_batch_size integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_provider_state text;
  v_result jsonb;
  v_deleted integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_batch_size is null or p_batch_size not between 1 and 5000 then
    raise exception 'account deletion workflow batch size is invalid' using errcode = '22023';
  end if;
  perform 1 from auth.users account where account.id = p_user_id for key share;
  if not found then raise exception 'account deletion user is unavailable' using errcode = 'P0002'; end if;
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id = p_user_id for update;
  if not found or v_workflow.revision <> p_expected_revision then
    raise exception 'account deletion workflow is stale' using errcode = '40001';
  end if;

  if v_workflow.state in ('stopping','draining') then
    select state into v_provider_state from public.cloud_provider_account_delete_preparations
    where user_id = p_user_id;
    if v_provider_state is distinct from 'ready' then
      update public.cloud_account_deletion_workflows
      set state='draining',revision=revision + 1,updated_at=clock_timestamp()
      where user_id=p_user_id returning * into v_workflow;
      return jsonb_build_object('contract','account-deletion-workflow-v1',
        'state',v_workflow.state,'revision',v_workflow.revision,
        'nextAction','provider_drain','readyToFinalize',false);
    end if;
    update public.cloud_account_deletion_workflows
    set state='purging_analytics',revision=revision + 1,updated_at=clock_timestamp()
    where user_id=p_user_id returning * into v_workflow;
    return jsonb_build_object('contract','account-deletion-workflow-v1',
      'state',v_workflow.state,'revision',v_workflow.revision,
      'nextAction','purge_analytics','readyToFinalize',false);
  end if;

  if v_workflow.state = 'purging_analytics' then
    if exists (select 1 from public.paywall_funnel_events where user_id=p_user_id) then
      return jsonb_build_object('contract','account-deletion-workflow-v1',
        'state',v_workflow.state,'revision',v_workflow.revision,
        'nextAction','purge_paywall_events','readyToFinalize',false);
    end if;
    with selected as materialized (
      select assignment.id from public.paywall_experiment_assignments assignment
      where assignment.user_id=p_user_id order by assignment.id
      for update skip locked limit p_batch_size
    ), deleted as (
      delete from public.paywall_experiment_assignments assignment
      using selected where assignment.id=selected.id returning assignment.id
    ) select count(*)::integer into v_deleted from deleted;
    if v_deleted > 0 then
      update public.cloud_account_deletion_workflows
      set revision=revision + 1,updated_at=clock_timestamp()
      where user_id=p_user_id returning * into v_workflow;
      return jsonb_build_object('contract','account-deletion-workflow-v1',
        'state',v_workflow.state,'revision',v_workflow.revision,
        'deletedAssignments',v_deleted,'nextAction','purge_experiment_assignments',
        'readyToFinalize',false);
    end if;
    update public.cloud_account_deletion_workflows
    set state='archiving_legal',revision=revision + 1,updated_at=clock_timestamp()
    where user_id=p_user_id returning * into v_workflow;
    return jsonb_build_object('contract','account-deletion-workflow-v1',
      'state',v_workflow.state,'revision',v_workflow.revision,
      'nextAction','archive_legal_billing','readyToFinalize',false);
  end if;

  if v_workflow.state = 'archiving_legal' then
    v_result := public.norva_archive_account_deletion_legal_billing(
      p_user_id,p_expected_revision,p_batch_size
    );
    select * into v_workflow from public.cloud_account_deletion_workflows
    where user_id=p_user_id for update;
    if not exists (select 1 from public.cloud_billing_ledger where user_id=p_user_id) then
      update public.cloud_account_deletion_workflows
      set state='purging_product',revision=revision + 1,updated_at=clock_timestamp()
      where user_id=p_user_id returning * into v_workflow;
    end if;
    return jsonb_build_object('contract','account-deletion-workflow-v1',
      'state',v_workflow.state,'revision',v_workflow.revision,
      'legalArchive',v_result,'nextAction',case when v_workflow.state='purging_product'
        then 'purge_product' else 'archive_legal_billing' end,'readyToFinalize',false);
  end if;

  return jsonb_build_object('contract','account-deletion-workflow-v1',
    'state',v_workflow.state,'revision',v_workflow.revision,
    'nextAction',case when v_workflow.state='purging_product' then 'purge_product' else null end,
    'readyToFinalize',v_workflow.state='ready_to_finalize');
end
$function$;

revoke all on function public.norva_advance_account_deletion_workflow(uuid,bigint,integer)
from public, anon, authenticated;
grant execute on function public.norva_advance_account_deletion_workflow(uuid,bigint,integer)
to service_role;

commit;
