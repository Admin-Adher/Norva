-- Raw paywall analytics must be removed before auth.users.  This table keeps
-- only irreversible daily counters: it deliberately has no user, device,
-- source, session, address, IP, precise timestamp or stable pseudonym.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table if not exists public.account_deletion_paywall_daily_rollups (
  day date not null,
  event_type text not null,
  experiment_key text not null default '',
  experiment_variant text not null default '',
  placement text not null default '',
  surface text not null default '',
  plan_code text not null default '',
  event_count bigint not null check (event_count >= 0),
  primary key (
    day,event_type,experiment_key,experiment_variant,placement,surface,plan_code
  )
);
alter table public.account_deletion_paywall_daily_rollups enable row level security;
revoke all on table public.account_deletion_paywall_daily_rollups
from public, anon, authenticated, service_role;

-- The final Auth delete must not start a potentially unbounded analytics
-- cascade.  The deletion worker below removes both relations explicitly.
alter table public.paywall_funnel_events
  drop constraint if exists paywall_funnel_events_user_id_fkey;
alter table public.paywall_funnel_events
  add constraint paywall_funnel_events_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete restrict;
alter table public.paywall_experiment_assignments
  drop constraint if exists paywall_experiment_assignments_user_id_fkey;
alter table public.paywall_experiment_assignments
  add constraint paywall_experiment_assignments_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete restrict;

-- Extend the existing provider deletion trigger fence to the account-level
-- analytics batch.  The configuration is transaction-local and is checked
-- against a locked durable workflow revision, not trusted on its own.
create or replace function public.norva_provider_account_delete_batch_fenced(
  p_user_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_provider_context jsonb;
  v_analytics_context jsonb;
begin
  begin
    v_provider_context := current_setting(
      'norva.provider_account_delete_batch',true
    )::jsonb;
  exception when others then
    v_provider_context := null;
  end;
  if p_user_id is not null and v_provider_context is not null and exists (
    select 1
    from public.cloud_provider_account_delete_preparations preparation
    where preparation.user_id = p_user_id
      and preparation.state = 'processing'
      and preparation.lease_owner = v_provider_context ->> 'worker'
      and preparation.lease_sequence =
        (v_provider_context ->> 'leaseSequence')::integer
      and preparation.lease_until > now()
  ) then
    return true;
  end if;
  begin
    v_analytics_context := current_setting(
      'norva.account_delete_analytics_batch',true
    )::jsonb;
  exception when others then
    return false;
  end;
  return p_user_id is not null and v_analytics_context is not null and exists (
    select 1 from public.cloud_account_deletion_workflows workflow
    where workflow.user_id = p_user_id
      and workflow.state = 'purging_analytics'
      and workflow.revision = (v_analytics_context ->> 'revision')::bigint
  );
end
$function$;

create or replace function public.norva_purge_account_deletion_paywall_batch(
  p_user_id uuid,
  p_expected_revision bigint,
  p_limit integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_provider_state text;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_deleted integer := 0;
  v_next jsonb := '{}'::jsonb;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'account deletion analytics batch limit is invalid' using errcode = '22023';
  end if;
  perform 1 from auth.users account where account.id = p_user_id for key share;
  if not found then raise exception 'account deletion user is unavailable' using errcode = 'P0002'; end if;
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id = p_user_id for update;
  if not found or v_workflow.revision <> p_expected_revision
     or v_workflow.state not in ('stopping','purging_analytics') then
    raise exception 'account deletion analytics batch is stale' using errcode = '40001';
  end if;
  select state into v_provider_state
  from public.cloud_provider_account_delete_preparations where user_id = p_user_id;
  if v_provider_state is distinct from 'ready' then
    return jsonb_build_object('contract','account-deletion-paywall-v1',
      'state','draining','waitingForProviderDrain',true,
      'revision',v_workflow.revision,'deletedRows',0);
  end if;
  if v_workflow.state = 'stopping' then
    update public.cloud_account_deletion_workflows
    set state = 'purging_analytics', revision = revision + 1,
        updated_at = clock_timestamp()
    where user_id = p_user_id
    returning * into v_workflow;
  end if;
  perform set_config('norva.account_delete_analytics_batch',
    jsonb_build_object('userId',p_user_id,'revision',v_workflow.revision)::text,true);
  v_cursor_at := nullif(v_workflow.analytics_checkpoint ->> 'occurredAt','')::timestamptz;
  v_cursor_id := nullif(v_workflow.analytics_checkpoint ->> 'id','')::uuid;

  with selected as materialized (
    select event.*
    from public.paywall_funnel_events event
    where event.user_id = p_user_id
      and (v_cursor_at is null or (event.occurred_at,event.id) > (v_cursor_at,v_cursor_id))
    order by event.occurred_at,event.id
    for update skip locked
    limit p_limit
  ), rolled as (
    insert into public.account_deletion_paywall_daily_rollups(
      day,event_type,experiment_key,experiment_variant,placement,surface,plan_code,event_count
    )
    select (event.occurred_at at time zone 'UTC')::date,event.event_type,
      coalesce(event.experiment_key,''),coalesce(event.experiment_variant,''),
      coalesce(event.placement,''),coalesce(event.surface,''),coalesce(event.plan_code,''),count(*)
    from selected event
    group by 1,2,3,4,5,6,7
    on conflict (day,event_type,experiment_key,experiment_variant,placement,surface,plan_code)
    do update set event_count = public.account_deletion_paywall_daily_rollups.event_count + excluded.event_count
    returning 1
  ), deleted as (
    delete from public.paywall_funnel_events event
    using selected where event.id = selected.id
    returning selected.occurred_at,selected.id
  )
  select count(*)::integer,coalesce(jsonb_build_object(
    'occurredAt',(array_agg(deleted.occurred_at order by deleted.occurred_at desc,deleted.id desc))[1],
    'id',(array_agg(deleted.id order by deleted.occurred_at desc,deleted.id desc))[1]
  ),'{}'::jsonb) into v_deleted,v_next from deleted;

  update public.cloud_account_deletion_workflows
  set analytics_checkpoint = case when v_deleted > 0 then v_next else analytics_checkpoint end,
      revision = revision + 1,updated_at = clock_timestamp()
  where user_id = p_user_id
  returning * into v_workflow;
  return jsonb_build_object('contract','account-deletion-paywall-v1',
    'state',v_workflow.state,'revision',v_workflow.revision,
    'deletedRows',v_deleted,'complete',v_deleted < p_limit);
end
$function$;

revoke all on function public.norva_purge_account_deletion_paywall_batch(uuid,bigint,integer)
from public, anon, authenticated;
grant execute on function public.norva_purge_account_deletion_paywall_batch(uuid,bigint,integer)
to service_role;

commit;
