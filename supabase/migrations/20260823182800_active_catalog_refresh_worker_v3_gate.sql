begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A deployed v3 worker must heartbeat this singleton after it has verified the
-- exact checkpoint/prune RPC contract.  Keeping the marker private prevents a
-- database-only rollout from silently activating against an old Edge worker.
create table if not exists public.cloud_catalog_active_refresh_worker_capability (
  singleton boolean not null,
  worker_id text not null,
  worker_protocol text not null,
  contract_id text not null,
  registered_at timestamptz not null,
  expires_at timestamptz not null,
  constraint cloud_catalog_active_refresh_worker_capability_pkey
    primary key (singleton),
  constraint cloud_catalog_active_refresh_worker_capability_singleton_ck
    check (singleton),
  constraint cloud_catalog_active_refresh_worker_capability_worker_ck
    check (
      btrim(worker_id) <> '' and length(worker_id) <= 160
      and worker_id !~ '[[:cntrl:]]'
    ),
  constraint cloud_catalog_active_refresh_worker_capability_protocol_ck
    check (
      worker_protocol =
        'credential-transition-worker-v3-active-catalog-refresh'
    ),
  constraint cloud_catalog_active_refresh_worker_capability_contract_ck
    check (contract_id = 'active-catalog-refresh-checkpoint-prune-v1'),
  constraint cloud_catalog_active_refresh_worker_capability_expiry_ck
    check (
      expires_at > registered_at
      and expires_at <= registered_at + interval '15 minutes'
    )
);

alter table public.cloud_catalog_active_refresh_worker_capability
  enable row level security;
revoke all on table public.cloud_catalog_active_refresh_worker_capability
from public,anon,authenticated,service_role;

create or replace function public.norva_active_catalog_refresh_sql_contract_ready()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_action_columns integer := 0;
  v_checkpoint_columns integer := 0;
  v_guard_definition text;
  v_claim_definition text;
  v_begin_swap_definition text;
begin
  if pg_catalog.to_regclass(
       'public.cloud_source_catalog_title_refresh_actions'
     ) is null
     or pg_catalog.to_regclass(
       'public.cloud_source_catalog_title_refresh_checkpoints'
     ) is null
     or pg_catalog.to_regclass(
       'public.cloud_catalog_active_refresh_worker_capability'
     ) is null then
    return false;
  end if;

  select count(*)::integer into v_action_columns
  from (
    values
      ('refresh_run_id'::name,'uuid'::regtype,true,false),
      ('action_kind'::name,'text'::regtype,true,false),
      ('job_id'::name,'uuid'::regtype,true,false),
      ('transition_id'::name,'uuid'::regtype,true,false),
      ('user_id'::name,'uuid'::regtype,true,false),
      ('source_id'::name,'uuid'::regtype,true,false),
      ('generation_id'::name,'uuid'::regtype,true,false),
      ('baseline_count'::name,'bigint'::regtype,true,false),
      ('checkpoint_revision'::name,'bigint'::regtype,false,false),
      ('content_sha256'::name,'text'::regtype,false,false),
      ('catalog_version'::name,'bigint'::regtype,false,false),
      ('category_count'::name,'bigint'::regtype,false,false),
      ('observed_count'::name,'bigint'::regtype,false,false),
      ('active_row_count'::name,'bigint'::regtype,false,false),
      ('pruned_count'::name,'bigint'::regtype,false,false),
      ('inventory_complete'::name,'boolean'::regtype,true,true),
      ('prune_complete'::name,'boolean'::regtype,true,true),
      ('prune_safe'::name,'boolean'::regtype,true,true),
      ('state'::name,'text'::regtype,true,true),
      ('completed_at'::name,'timestamptz'::regtype,false,false),
      ('created_at'::name,'timestamptz'::regtype,true,true)
  ) expected(attname,atttypid,attnotnull,atthasdef)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid =
      'public.cloud_source_catalog_title_refresh_actions'::regclass
   and attribute.attname = expected.attname
   and attribute.atttypid = expected.atttypid
   and attribute.attnotnull = expected.attnotnull
   and attribute.atthasdef = expected.atthasdef
   and attribute.attnum > 0 and not attribute.attisdropped;

  select count(*)::integer into v_checkpoint_columns
  from (
    values
      ('job_id'::name,'uuid'::regtype,true,false),
      ('refresh_run_id'::name,'uuid'::regtype,true,false),
      ('transition_id'::name,'uuid'::regtype,true,false),
      ('user_id'::name,'uuid'::regtype,true,false),
      ('source_id'::name,'uuid'::regtype,true,false),
      ('generation_id'::name,'uuid'::regtype,true,false),
      ('checkpoint_revision'::name,'bigint'::regtype,true,false),
      ('head_revision'::name,'bigint'::regtype,true,false),
      ('config_revision'::name,'bigint'::regtype,true,false),
      ('source_visibility_epoch'::name,'bigint'::regtype,true,false),
      ('user_visibility_epoch'::name,'bigint'::regtype,true,false),
      ('progress'::name,'jsonb'::regtype,true,false),
      ('requeued_at'::name,'timestamptz'::regtype,false,false),
      ('created_at'::name,'timestamptz'::regtype,true,true),
      ('updated_at'::name,'timestamptz'::regtype,true,true)
  ) expected(attname,atttypid,attnotnull,atthasdef)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid =
      'public.cloud_source_catalog_title_refresh_checkpoints'::regclass
   and attribute.attname = expected.attname
   and attribute.atttypid = expected.atttypid
   and attribute.attnotnull = expected.attnotnull
   and attribute.atthasdef = expected.atthasdef
   and attribute.attnum > 0 and not attribute.attisdropped;

  if v_action_columns <> 21 or v_checkpoint_columns <> 15
     or (select count(*) from pg_catalog.pg_attribute attribute
         where attribute.attrelid =
           'public.cloud_source_catalog_title_refresh_actions'::regclass
           and attribute.attnum > 0 and not attribute.attisdropped) <> 21
     or (select count(*) from pg_catalog.pg_attribute attribute
         where attribute.attrelid =
           'public.cloud_source_catalog_title_refresh_checkpoints'::regclass
           and attribute.attnum > 0 and not attribute.attisdropped) <> 15 then
    return false;
  end if;

  if not coalesce((
       select bool_and(class.relrowsecurity)
       from pg_catalog.pg_class class
       where class.oid in (
         'public.cloud_source_catalog_title_refresh_actions'::regclass,
         'public.cloud_source_catalog_title_refresh_checkpoints'::regclass,
         'public.cloud_catalog_active_refresh_worker_capability'::regclass
       )
     ),false)
     or has_table_privilege(
       'service_role','public.cloud_source_catalog_title_refresh_actions','SELECT'
     )
     or has_table_privilege(
       'service_role','public.cloud_source_catalog_title_refresh_checkpoints','SELECT'
     )
     or has_table_privilege(
       'service_role','public.cloud_catalog_active_refresh_worker_capability','SELECT'
     )
     or has_table_privilege(
       'anon','public.cloud_catalog_active_refresh_worker_capability','SELECT'
     )
     or has_table_privilege(
       'authenticated','public.cloud_catalog_active_refresh_worker_capability','SELECT'
     ) then
    return false;
  end if;

  if not public.norva_catalog_title_active_payload_indexes_ready()
     or pg_catalog.to_regprocedure(
       'public.norva_claim_credential_transition_jobs(text,integer,integer,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_begin_active_catalog_title_projection_refresh(uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_checkpoint_active_catalog_title_refresh(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,boolean,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_upsert_active_catalog_media_items(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_upsert_active_catalog_refresh_categories(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_upsert_active_catalog_title_payloads(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_upsert_active_catalog_title_variants(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_confirm_active_catalog_title_projection_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_upsert_active_catalog_live_materialization(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_prune_active_catalog_refresh_action_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,text,bigint,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_reconcile_active_catalog_title_projection_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,integer)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_mark_active_catalog_title_projection_refreshed(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)'
     ) is null then
    return false;
  end if;

  if not has_function_privilege(
       'service_role',
       'public.norva_claim_credential_transition_jobs(text,integer,integer,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_begin_active_catalog_title_projection_refresh(uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_checkpoint_active_catalog_title_refresh(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,boolean,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_media_items(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_refresh_categories(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_title_payloads(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_title_variants(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_confirm_active_catalog_title_projection_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_upsert_active_catalog_live_materialization(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_prune_active_catalog_refresh_action_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,text,bigint,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_reconcile_active_catalog_title_projection_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,integer)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_mark_active_catalog_title_projection_refreshed(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_complete_active_catalog_title_refresh_action(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,text,bigint,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.norva_checkpoint_active_catalog_title_refresh(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,boolean,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_prune_active_catalog_refresh_action_batch(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,text,bigint,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_require_active_catalog_refresh_action(uuid,uuid,text,bigint)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_adopt_active_catalog_refresh_epoch(uuid,uuid,bigint,bigint)',
       'EXECUTE'
     ) then
    return false;
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.norva_catalog_generation_flag_contract_guard()'::regprocedure
  ) into v_guard_definition;
  select pg_catalog.pg_get_functiondef(
    'public.norva_claim_credential_transition_jobs(text,integer,integer,text)'::regprocedure
  ) into v_claim_definition;
  select pg_catalog.pg_get_functiondef(
    'public.norva_begin_credential_swap(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text)'::regprocedure
  ) into v_begin_swap_definition;
  if position(
       'norva_active_catalog_refresh_contract_ready' in v_guard_definition
     ) = 0
     or position(
       'credential-transition-worker-v3-active-catalog-refresh'
       in v_claim_definition
     ) = 0
     or position('post_switch_verify' in v_claim_definition) = 0
     or position(
       'norva_active_catalog_refresh_contract_ready'
       in v_begin_swap_definition
     ) = 0
     or not exists (
       select 1
       from pg_catalog.pg_trigger trigger_state
       where trigger_state.tgrelid =
         'public.admin_feature_flags'::regclass
         and trigger_state.tgname =
           'trg_catalog_generation_flag_contract_guard'
         and trigger_state.tgfoid =
           'public.norva_catalog_generation_flag_contract_guard()'::regprocedure
         and trigger_state.tgtype = 23
         and trigger_state.tgenabled = 'O'
         and not trigger_state.tgisinternal
     ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end
$function$;

create or replace function public.norva_active_catalog_refresh_contract_ready()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.norva_active_catalog_refresh_sql_contract_ready() then
    return false;
  end if;
  return exists (
    select 1
    from public.cloud_catalog_active_refresh_worker_capability capability
    where capability.singleton
      and capability.worker_protocol =
        'credential-transition-worker-v3-active-catalog-refresh'
      and capability.contract_id =
        'active-catalog-refresh-checkpoint-prune-v1'
      and capability.registered_at <= clock_timestamp()
      and capability.expires_at > clock_timestamp()
      and capability.expires_at <=
        capability.registered_at + interval '15 minutes'
  );
exception when others then
  return false;
end
$function$;

create or replace function public.norva_register_active_catalog_refresh_worker(
  p_worker text,
  p_worker_protocol text,
  p_contract_id text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
begin
  perform public.norva_credential_require_service_role();
  if nullif(btrim(p_worker),'') is null or length(p_worker) > 160
     or p_worker ~ '[[:cntrl:]]' then
    raise exception 'bounded active catalog refresh worker id is required'
      using errcode = '22023';
  end if;
  if p_worker_protocol is distinct from
       'credential-transition-worker-v3-active-catalog-refresh'
     or p_contract_id is distinct from
       'active-catalog-refresh-checkpoint-prune-v1' then
    raise exception 'unsupported active catalog refresh worker contract'
      using errcode = '22023';
  end if;
  if not public.norva_active_catalog_refresh_sql_contract_ready() then
    raise exception 'active catalog refresh SQL contract is incomplete'
      using errcode = '55000',
        detail = 'reason=active_catalog_refresh_sql_contract_not_ready';
  end if;
  v_expires_at := v_now + interval '10 minutes';
  insert into public.cloud_catalog_active_refresh_worker_capability (
    singleton,worker_id,worker_protocol,contract_id,registered_at,expires_at
  ) values (
    true,btrim(p_worker),p_worker_protocol,p_contract_id,v_now,v_expires_at
  )
  on conflict (singleton) do update set
    worker_id = excluded.worker_id,
    worker_protocol = excluded.worker_protocol,
    contract_id = excluded.contract_id,
    registered_at = excluded.registered_at,
    expires_at = excluded.expires_at;
  return jsonb_build_object(
    'contract','active-catalog-refresh-worker-registration-v1',
    'worker',btrim(p_worker),'workerProtocol',p_worker_protocol,
    'refreshContractId',p_contract_id,'registeredAt',v_now,
    'expiresAt',v_expires_at,'refreshBefore',v_now + interval '5 minutes',
    'ready',true
  );
end
$function$;

revoke all on function public.norva_active_catalog_refresh_sql_contract_ready()
from public,anon,authenticated,service_role;
revoke all on function public.norva_active_catalog_refresh_contract_ready()
from public,anon,authenticated,service_role;
revoke all on function public.norva_register_active_catalog_refresh_worker(
  text,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.norva_register_active_catalog_refresh_worker(
  text,text,text
) to service_role;

do $assert$
declare
  v_columns integer;
  v_constraints text[];
begin
  select count(*)::integer into v_columns
  from (
    values
      ('singleton'::name,'boolean'::regtype,true,false),
      ('worker_id'::name,'text'::regtype,true,false),
      ('worker_protocol'::name,'text'::regtype,true,false),
      ('contract_id'::name,'text'::regtype,true,false),
      ('registered_at'::name,'timestamptz'::regtype,true,false),
      ('expires_at'::name,'timestamptz'::regtype,true,false)
  ) expected(attname,atttypid,attnotnull,atthasdef)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid =
      'public.cloud_catalog_active_refresh_worker_capability'::regclass
   and attribute.attname = expected.attname
   and attribute.atttypid = expected.atttypid
   and attribute.attnotnull = expected.attnotnull
   and attribute.atthasdef = expected.atthasdef
   and attribute.attnum > 0 and not attribute.attisdropped;
  select array_agg(
    lower(regexp_replace(pg_catalog.pg_get_constraintdef(
      constraint_state.oid,true
    ),'\s+','','g')) order by constraint_state.conname
  ) into v_constraints
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid =
    'public.cloud_catalog_active_refresh_worker_capability'::regclass;
  if v_columns <> 6
     or (select count(*) from pg_catalog.pg_attribute attribute
         where attribute.attrelid =
           'public.cloud_catalog_active_refresh_worker_capability'::regclass
           and attribute.attnum > 0 and not attribute.attisdropped) <> 6
     or cardinality(v_constraints) <> 6
     or not v_constraints @> array[
       'primarykey(singleton)',
       'check(singleton)',
       'check(btrim(worker_id)<>''''::textandlength(worker_id)<=160andworker_id!~''[[:cntrl:]]''::text)',
       'check(worker_protocol=''credential-transition-worker-v3-active-catalog-refresh''::text)',
       'check(contract_id=''active-catalog-refresh-checkpoint-prune-v1''::text)',
       'check(expires_at>registered_atandexpires_at<=(registered_at+''00:15:00''::interval))'
     ]
     or not coalesce((
       select class.relrowsecurity
       from pg_catalog.pg_class class
       where class.oid =
         'public.cloud_catalog_active_refresh_worker_capability'::regclass
     ),false)
     or has_table_privilege(
       'service_role','public.cloud_catalog_active_refresh_worker_capability','SELECT'
     )
     or has_table_privilege(
       'anon','public.cloud_catalog_active_refresh_worker_capability','SELECT'
     )
     or has_table_privilege(
       'authenticated','public.cloud_catalog_active_refresh_worker_capability','SELECT'
     )
     or not has_function_privilege(
       'service_role',
       'public.norva_register_active_catalog_refresh_worker(text,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.norva_register_active_catalog_refresh_worker(text,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_register_active_catalog_refresh_worker(text,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_active_catalog_refresh_sql_contract_ready()',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.norva_active_catalog_refresh_contract_ready()',
       'EXECUTE'
     )
     or not public.norva_active_catalog_refresh_sql_contract_ready() then
    raise exception 'active catalog refresh worker v3 gate drift'
      using errcode = '55000';
  end if;
end
$assert$;

notify pgrst, 'reload schema';
commit;
