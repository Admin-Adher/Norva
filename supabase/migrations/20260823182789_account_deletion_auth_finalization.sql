begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create table if not exists public.cloud_account_deletion_finalizations (
  finalization_key uuid primary key default gen_random_uuid(),
  account_key text not null unique check (account_key ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('claimed','completed')),
  claimed_at timestamptz not null default clock_timestamp(),
  lease_until timestamptz not null,
  completed_at timestamptz,
  check ((state='claimed' and completed_at is null) or (state='completed' and completed_at is not null))
);
alter table public.cloud_account_deletion_finalizations enable row level security;
revoke all on table public.cloud_account_deletion_finalizations
from public,anon,authenticated,service_role;
alter table public.cloud_account_deletion_workflows
  add column if not exists finalization_key uuid,
  add column if not exists finalization_lease_until timestamptz;

create or replace function public.norva_claim_account_deletion_finalizations(
  p_batch integer default 5,
  p_lease_seconds integer default 120
) returns table (user_id uuid, finalization_key uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_now timestamptz := clock_timestamp();
begin
  perform public.norva_credential_require_service_role();
  if p_batch is null or p_batch not between 1 and 25
     or p_lease_seconds is null or p_lease_seconds not between 30 and 300 then
    raise exception 'account deletion finalization claim arguments are invalid' using errcode='22023';
  end if;
  return query
  with candidates as (
    select workflow.user_id
    from public.cloud_account_deletion_workflows workflow
    where workflow.state='ready_to_finalize'
       or (workflow.state='finalizing' and workflow.finalization_lease_until <= v_now)
    order by workflow.updated_at,workflow.user_id
    for update skip locked limit p_batch
  ), claimed as (
    update public.cloud_account_deletion_workflows workflow
    set state='finalizing',finalization_key=gen_random_uuid(),
        finalization_lease_until=v_now + make_interval(secs=>p_lease_seconds),
        revision=revision+1,updated_at=v_now
    from candidates where workflow.user_id=candidates.user_id
    returning workflow.user_id,workflow.finalization_key,workflow.finalization_lease_until
  ), tombstoned as (
    insert into public.cloud_account_deletion_finalizations(
      finalization_key,account_key,state,claimed_at,lease_until
    )
    select claimed.finalization_key,encode(extensions.digest(claimed.user_id::text,'sha256'), 'hex'),
      'claimed',v_now,claimed.finalization_lease_until
    from claimed
    on conflict (account_key) do update
      set finalization_key=excluded.finalization_key,state='claimed',
          claimed_at=excluded.claimed_at,lease_until=excluded.lease_until,completed_at=null
    returning finalization_key
  )
  select claimed.user_id,claimed.finalization_key
  from claimed join tombstoned using (finalization_key);
end
$function$;

create or replace function public.norva_complete_account_deletion_finalization(
  p_finalization_key uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_account_key text;
begin
  perform public.norva_credential_require_service_role();
  select account_key into v_account_key
  from public.cloud_account_deletion_finalizations
  where finalization_key=p_finalization_key for update;
  if not found then raise exception 'account deletion finalization is unavailable' using errcode='P0002'; end if;
  if exists (select 1 from auth.users account
             where encode(extensions.digest(account.id::text,'sha256'),'hex')=v_account_key) then
    raise exception 'account deletion finalization requires Auth absence' using errcode='55000';
  end if;
  update public.cloud_account_deletion_finalizations
  set state='completed',completed_at=coalesce(completed_at,clock_timestamp()),lease_until=clock_timestamp()
  where finalization_key=p_finalization_key;
  return true;
end
$function$;

create or replace function public.norva_account_deletion_product_ready(
  p_user_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare v_constraint record; v_has_rows boolean;
begin
  if p_user_id is null then return false; end if;
  for v_constraint in
    select constraint_state.conrelid::regclass as relation_name,attribute.attname as column_name
    from pg_catalog.pg_constraint constraint_state
    join pg_catalog.pg_class relation_state on relation_state.oid=constraint_state.conrelid
    join pg_catalog.pg_namespace namespace_state on namespace_state.oid=relation_state.relnamespace
    join pg_catalog.pg_attribute attribute on attribute.attrelid=constraint_state.conrelid
      and attribute.attnum=constraint_state.conkey[1] and not attribute.attisdropped
    where constraint_state.contype='f' and constraint_state.confrelid='auth.users'::regclass
      and namespace_state.nspname='public' and cardinality(constraint_state.conkey)=1
      and constraint_state.conrelid not in (
        'public.cloud_account_deletion_workflows'::regclass,
        'public.cloud_provider_account_delete_preparations'::regclass
      )
  loop
    execute format('select exists (select 1 from %s where %I=$1)',
      v_constraint.relation_name,v_constraint.column_name)
    into v_has_rows using p_user_id;
    if v_has_rows then return false; end if;
  end loop;
  return true;
end
$function$;

create or replace function public.norva_provider_transition_account_delete_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_delete_fence text; v_owner_fence text;
begin
  select * into v_preparation from public.cloud_provider_account_delete_preparations
  where user_id=old.id for update;
  if not found or v_preparation.state <> 'ready' or v_preparation.phase <> 'ready'
     or not public.norva_provider_account_delete_proof_ready(old.id) then
    raise exception 'provider account deletion preparation is incomplete'
      using errcode='55000',detail='reason=provider_account_delete_not_prepared';
  end if;
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id=old.id for update;
  if not found or v_workflow.state <> 'finalizing'
     or v_workflow.finalization_key is null
     or v_workflow.finalization_lease_until <= clock_timestamp() then
    raise exception 'account deletion is not ready for Auth finalization'
      using errcode='55000',detail='reason=account_deletion_not_ready_to_finalize';
  end if;
  if not public.norva_account_deletion_product_ready(old.id) then
    raise exception 'account deletion product purge is incomplete'
      using errcode='55000',detail='reason=account_deletion_product_not_ready';
  end if;
  v_delete_fence:=coalesce(current_setting('norva.provider_transition_deleted_users',true),'|');
  v_owner_fence:=coalesce(current_setting('norva.catalog_background_owner_deleted_users',true),'|');
  perform set_config('norva.provider_transition_deleted_users',v_delete_fence||old.id::text||'|',true);
  perform set_config('norva.catalog_background_owner_deleted_users',v_owner_fence||old.id::text||'|',true);
  return old;
end
$function$;

revoke all on function public.norva_claim_account_deletion_finalizations(integer,integer),
  public.norva_complete_account_deletion_finalization(uuid)
from public,anon,authenticated;
grant execute on function public.norva_claim_account_deletion_finalizations(integer,integer),
  public.norva_complete_account_deletion_finalization(uuid) to service_role;
commit;
