begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

revoke all on function
  public.norva_provider_account_delete_batch_fenced(uuid),
  public.norva_provider_account_delete_fenced(uuid),
  public.norva_provider_account_delete_write_guard(),
  public.norva_provider_account_delete_rows_bounded(regclass,name,uuid,integer),
  public.norva_provider_account_delete_proof_ready(uuid),
  public.norva_provider_transition_account_delete_guard(),
  public.norva_provider_transition_source_delete_guard()
from public,anon,authenticated,service_role;

revoke all on function
  public.norva_get_provider_call_fence_snapshot(uuid,uuid),
  public.norva_acquire_provider_call_permit(uuid,uuid,bigint,bigint,text,integer,integer,integer,text,text,text,uuid,uuid,text,integer,uuid,uuid),
  public.norva_revalidate_provider_call_permit(uuid,text),
  public.norva_renew_provider_call_permit(uuid,text,timestamptz,integer),
  public.norva_release_provider_call_permit(uuid,text),
  public.norva_claim_provider_transport_stop_action(uuid,text,integer),
  public.norva_settle_provider_transport_stop_action(uuid,text,integer,bigint,text,text,text,integer),
  public.norva_begin_provider_account_deletion_prepare(uuid),
  public.norva_claim_provider_account_deletion_prepare(uuid,text,integer),
  public.norva_run_provider_account_deletion_prepare_batch(uuid,text,integer,bigint,integer),
  public.norva_checkpoint_provider_account_deletion_prepare(uuid,text,integer,bigint,integer),
  public.norva_settle_provider_account_deletion_prepare_failure(uuid,text,integer,bigint,text,boolean,integer)
from public,anon,authenticated;
grant execute on function
  public.norva_get_provider_call_fence_snapshot(uuid,uuid),
  public.norva_acquire_provider_call_permit(uuid,uuid,bigint,bigint,text,integer,integer,integer,text,text,text,uuid,uuid,text,integer,uuid,uuid),
  public.norva_revalidate_provider_call_permit(uuid,text),
  public.norva_renew_provider_call_permit(uuid,text,timestamptz,integer),
  public.norva_release_provider_call_permit(uuid,text),
  public.norva_claim_provider_transport_stop_action(uuid,text,integer),
  public.norva_settle_provider_transport_stop_action(uuid,text,integer,bigint,text,text,text,integer),
  public.norva_begin_provider_account_deletion_prepare(uuid),
  public.norva_claim_provider_account_deletion_prepare(uuid,text,integer),
  public.norva_run_provider_account_deletion_prepare_batch(uuid,text,integer,bigint,integer),
  public.norva_checkpoint_provider_account_deletion_prepare(uuid,text,integer,bigint,integer),
  public.norva_settle_provider_account_deletion_prepare_failure(uuid,text,integer,bigint,text,boolean,integer)
to service_role;

do $assert$
declare
  v_rpc regprocedure;
  v_rpc_source text;
  v_unclassified text;
begin
  if not (select relrowsecurity from pg_class where oid =
       'public.cloud_provider_account_delete_preparations'::regclass)
     or has_table_privilege(
       'service_role','public.cloud_provider_account_delete_preparations',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or not exists (
       select 1 from pg_trigger trigger_state
       where trigger_state.tgrelid = 'auth.users'::regclass
         and trigger_state.tgname =
           'trg_auth_users_provider_transition_guard'
         and trigger_state.tgenabled = 'O' and not trigger_state.tgisinternal
     )
     or not exists (
       select 1 from pg_trigger trigger_state
       where trigger_state.tgrelid = 'public.paywall_funnel_events'::regclass
         and trigger_state.tgname =
           'trg_aaa_provider_account_delete_write_guard'
         and trigger_state.tgenabled = 'O' and not trigger_state.tgisinternal
     )
     or has_function_privilege(
       'authenticated',
       'public.norva_begin_provider_account_deletion_prepare(uuid)','EXECUTE'
     ) then
    raise exception 'provider account-delete preparation contract drift'
      using errcode = '55000';
  end if;
  foreach v_rpc in array array[
    'public.norva_cancel_credential_transition(uuid,uuid,text,bigint,text,text)'::regprocedure,
    'public.norva_begin_credential_swap(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text)'::regprocedure,
    'public.norva_complete_credential_transition(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)'::regprocedure,
    'public.norva_restore_previous_credential_config(uuid,uuid,uuid,text,integer,bigint,bigint,bigint,text)'::regprocedure,
    'public.norva_finish_credential_compensation(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)'::regprocedure
  ] loop
    select lower(pg_get_functiondef(v_rpc::oid)) into v_rpc_source;
    if position('norva_credential_lock_account(p_user_id)' in v_rpc_source) = 0
       or position('norva_credential_lock_account(p_user_id)' in v_rpc_source)
          > position('from public.cloud_source_transitions' in v_rpc_source) then
      raise exception 'credential RPC account-first lock drift: %',v_rpc
        using errcode = '55000';
    end if;
  end loop;

  -- Exhaustive classifier: every volatile SECURITY DEFINER service routine
  -- with a user argument and credential/catalog mutation surface is either
  -- account-first or one of four row-trigger internals.  New RPCs cannot be
  -- added silently: this assertion fails their migration until classified.
  select pg_catalog.string_agg(
    procedure_state.oid::regprocedure::text, E'\n' order by procedure_state.oid
  ) into v_unclassified
  from pg_catalog.pg_proc procedure_state
  join pg_catalog.pg_namespace namespace_state
    on namespace_state.oid = procedure_state.pronamespace
  join pg_catalog.pg_language language_state
    on language_state.oid = procedure_state.prolang
  where namespace_state.nspname = 'public'
    and procedure_state.proname like 'norva_%'
    and procedure_state.provolatile = 'v'
    and procedure_state.prosecdef
    and language_state.lanname = 'plpgsql'
    and pg_catalog.pg_get_function_identity_arguments(procedure_state.oid)
      ~ '(^|, )p_user_id uuid'
    and procedure_state.prosrc ~
      'cloud_(source_|media_items|title_variants|live_variants|live_logical_channels|titles|catalog_background_owner)'
    and procedure_state.proname not in (
      'norva_mark_catalog_background_owner_stale',
      'norva_mark_catalog_background_owner_sync',
      'norva_sync_catalog_background_owner_title',
      'norva_ensure_source_catalog_head'
    )
    and position(
      'norva_credential_lock_account(p_user_id)'
      in procedure_state.prosrc
    ) = 0;
  if v_unclassified is not null then
    raise exception 'provider account-first RPC classification is incomplete'
      using errcode = '55000',detail = v_unclassified;
  end if;

  select lower(pg_catalog.pg_get_functiondef(
    'public.norva_provider_account_delete_write_guard()'::regprocedure
  )) into v_rpc_source;
  if position('for key share nowait' in v_rpc_source) = 0
     or position('for key share nowait' in v_rpc_source)
        > position('cloud_provider_account_delete_preparations' in v_rpc_source) then
    raise exception 'provider direct-DML account fence drifted'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
