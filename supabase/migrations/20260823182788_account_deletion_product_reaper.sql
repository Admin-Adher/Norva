-- Bounded product reaper.  It discovers only direct public FKs to auth.users
-- from PostgreSQL's catalog, deletes at most one relation/batch per call, and
-- refuses to mark READY while any non-workflow direct user row remains.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

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
  v_product_context jsonb;
begin
  begin v_provider_context := current_setting('norva.provider_account_delete_batch',true)::jsonb;
  exception when others then v_provider_context := null; end;
  if p_user_id is not null and v_provider_context is not null and exists (
    select 1 from public.cloud_provider_account_delete_preparations preparation
    where preparation.user_id=p_user_id and preparation.state='processing'
      and preparation.lease_owner=v_provider_context->>'worker'
      and preparation.lease_sequence=(v_provider_context->>'leaseSequence')::integer
      and preparation.lease_until > now()
  ) then return true; end if;
  begin v_analytics_context := current_setting('norva.account_delete_analytics_batch',true)::jsonb;
  exception when others then v_analytics_context := null; end;
  if p_user_id is not null and v_analytics_context is not null and exists (
    select 1 from public.cloud_account_deletion_workflows workflow
    where workflow.user_id=p_user_id and workflow.state='purging_analytics'
      and workflow.revision=(v_analytics_context->>'revision')::bigint
  ) then return true; end if;
  begin v_product_context := current_setting('norva.account_delete_product_batch',true)::jsonb;
  exception when others then return false; end;
  return p_user_id is not null and v_product_context is not null and exists (
    select 1 from public.cloud_account_deletion_workflows workflow
    where workflow.user_id=p_user_id and workflow.state='purging_product'
      and workflow.revision=(v_product_context->>'revision')::bigint
  );
end
$function$;

create or replace function public.norva_purge_account_deletion_product_batch(
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
  v_relation regclass;
  v_column name;
  v_deleted integer := 0;
  v_has_rows boolean;
  v_constraint record;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'account deletion product batch limit is invalid' using errcode='22023';
  end if;
  perform 1 from auth.users account where account.id=p_user_id for key share;
  if not found then raise exception 'account deletion user is unavailable' using errcode='P0002'; end if;
  select * into v_workflow from public.cloud_account_deletion_workflows
  where user_id=p_user_id for update;
  if not found or v_workflow.state <> 'purging_product'
     or v_workflow.revision <> p_expected_revision then
    raise exception 'account deletion product batch is stale' using errcode='40001';
  end if;
  perform set_config('norva.account_delete_product_batch',
    jsonb_build_object('userId',p_user_id,'revision',v_workflow.revision)::text,true);

  -- The two durable control rows are intentionally retained until the final
  -- guarded Auth transaction.  Every other public direct FK must be empty.
  for v_constraint in
    select constraint_state.conrelid::regclass as relation_name,
      attribute.attname as column_name
    from pg_catalog.pg_constraint constraint_state
    join pg_catalog.pg_class relation_state on relation_state.oid=constraint_state.conrelid
    join pg_catalog.pg_namespace namespace_state on namespace_state.oid=relation_state.relnamespace
    join pg_catalog.pg_attribute attribute on attribute.attrelid=constraint_state.conrelid
      and attribute.attnum=constraint_state.conkey[1] and not attribute.attisdropped
    where constraint_state.contype='f'
      and constraint_state.confrelid='auth.users'::regclass
      and namespace_state.nspname='public'
      and cardinality(constraint_state.conkey)=1
      and constraint_state.conrelid not in (
        'public.cloud_account_deletion_workflows'::regclass,
        'public.cloud_provider_account_delete_preparations'::regclass
      )
    order by relation_state.relname,constraint_state.conname
  loop
    execute format('select exists (select 1 from %s where %I = $1)',
      v_constraint.relation_name,v_constraint.column_name)
    into v_has_rows using p_user_id;
    if v_has_rows then
      v_relation:=v_constraint.relation_name; v_column:=v_constraint.column_name;
      exit;
    end if;
  end loop;
  if v_relation is null then
    update public.cloud_account_deletion_workflows
    set state='ready_to_finalize',revision=revision+1,updated_at=clock_timestamp()
    where user_id=p_user_id returning * into v_workflow;
    return jsonb_build_object('contract','account-deletion-product-reaper-v1',
      'state',v_workflow.state,'revision',v_workflow.revision,
      'deletedRows',0,'complete',true,'readyToFinalize',true);
  end if;
  execute format(
    'with selected as materialized (select ctid from %s where %I=$1 order by ctid for update skip locked limit $2), deleted as (delete from %s target using selected where target.ctid=selected.ctid returning 1) select count(*)::integer from deleted',
    v_relation,v_column,v_relation
  ) into v_deleted using p_user_id,p_limit;
  update public.cloud_account_deletion_workflows
  set product_checkpoint=jsonb_build_object('relation',v_relation::text,'column',v_column::text),
      revision=revision+1,updated_at=clock_timestamp()
  where user_id=p_user_id returning * into v_workflow;
  return jsonb_build_object('contract','account-deletion-product-reaper-v1',
    'state',v_workflow.state,'revision',v_workflow.revision,
    'relation',v_relation::text,'deletedRows',v_deleted,
    'complete',false,'readyToFinalize',false);
end
$function$;

revoke all on function public.norva_purge_account_deletion_product_batch(uuid,bigint,integer)
from public,anon,authenticated;
grant execute on function public.norva_purge_account_deletion_product_batch(uuid,bigint,integer)
to service_role;
commit;
