-- Account-wide deletion orchestration.  The provider subgraph remains owned by
-- 82780/82781; this row is the durable, account-level contract that an Edge
-- adapter and a future bounded reaper can observe and resume.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table if not exists public.cloud_account_deletion_workflows (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state text not null default 'requested' check (state in (
    'requested','stopping','draining','purging_analytics','archiving_legal',
    'purging_product','ready_to_finalize','finalizing','completed',
    'failed_retryable'
  )),
  revision bigint not null default 0 check (revision >= 0),
  requested_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  last_error_code text check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  analytics_checkpoint jsonb not null default '{}'::jsonb check (
    jsonb_typeof(analytics_checkpoint) = 'object'
  ),
  product_checkpoint jsonb not null default '{}'::jsonb check (
    jsonb_typeof(product_checkpoint) = 'object'
  )
);
alter table public.cloud_account_deletion_workflows enable row level security;
revoke all on table public.cloud_account_deletion_workflows
from public, anon, authenticated, service_role;

create or replace function public.norva_begin_account_deletion_workflow(
  p_user_id uuid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_provider jsonb;
begin
  perform public.norva_credential_require_service_role();
  perform 1 from auth.users account where account.id = p_user_id for update;
  if not found then
    raise exception 'account deletion user is unavailable' using errcode = 'P0002';
  end if;

  -- This is the account-first fence.  It is idempotent and publishes the
  -- provider stop/drain work before an Edge caller can return 202.
  v_provider := public.norva_begin_provider_account_deletion_prepare(p_user_id);
  insert into public.cloud_account_deletion_workflows(user_id,state)
  values (p_user_id,'stopping')
  on conflict (user_id) do update
    set state = case
      when public.cloud_account_deletion_workflows.state = 'failed_retryable'
        then 'stopping'
      else public.cloud_account_deletion_workflows.state
    end,
    revision = public.cloud_account_deletion_workflows.revision + 1,
    last_error_code = null,
    updated_at = clock_timestamp()
  returning * into v_workflow;

  return jsonb_build_object(
    'contract','account-deletion-workflow-v1',
    'state',v_workflow.state,
    'revision',v_workflow.revision,
    'providerState',v_provider ->> 'state',
    'providerPhase',v_provider ->> 'phase',
    'readyToFinalize',v_workflow.state = 'ready_to_finalize'
  );
end
$function$;

create or replace function public.norva_get_account_deletion_workflow_status(
  p_user_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_provider public.cloud_provider_account_delete_preparations%rowtype;
begin
  perform public.norva_credential_require_service_role();
  select * into v_workflow
  from public.cloud_account_deletion_workflows
  where user_id = p_user_id;
  if not found then
    raise exception 'account deletion workflow was not requested' using errcode = 'P0002';
  end if;
  select * into v_provider
  from public.cloud_provider_account_delete_preparations
  where user_id = p_user_id;
  return jsonb_build_object(
    'contract','account-deletion-workflow-v1',
    'state',v_workflow.state,
    'revision',v_workflow.revision,
    'lastErrorCode',v_workflow.last_error_code,
    'providerState',v_provider.state,
    'providerPhase',v_provider.phase,
    'providerReady',coalesce(v_provider.state = 'ready',false),
    'readyToFinalize',v_workflow.state = 'ready_to_finalize'
  );
end
$function$;

revoke all on function
  public.norva_begin_account_deletion_workflow(uuid),
  public.norva_get_account_deletion_workflow_status(uuid)
from public, anon, authenticated;
grant execute on function
  public.norva_begin_account_deletion_workflow(uuid),
  public.norva_get_account_deletion_workflow_status(uuid)
to service_role;

commit;
