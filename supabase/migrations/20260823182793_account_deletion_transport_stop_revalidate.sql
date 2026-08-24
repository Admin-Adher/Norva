begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A lease only permits an external stop attempt.  This second, short CAS is
-- deliberately performed immediately before the Edge worker calls the gateway:
-- a delete retry, epoch bump, expired lease, or workflow progression between
-- claim and fetch must turn the worker into STALE before any external effect.
create or replace function public.norva_revalidate_account_deletion_transport_stop(
  p_user_id uuid,
  p_worker text,
  p_expected_deletion_epoch bigint,
  p_expected_lease_sequence integer,
  p_expected_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_action public.cloud_provider_transport_stop_actions%rowtype;
  v_workflow public.cloud_account_deletion_workflows%rowtype;
  v_affinities jsonb;
begin
  perform public.norva_credential_require_service_role();
  if nullif(btrim(p_worker),'') is null or length(btrim(p_worker)) > 160
     or p_expected_deletion_epoch is null or p_expected_deletion_epoch < 0
     or p_expected_lease_sequence is null or p_expected_lease_sequence < 0
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'account deletion transport stop revalidation arguments are invalid'
      using errcode = '22023';
  end if;

  perform public.norva_credential_lock_account(p_user_id);
  select preparation.* into v_preparation
  from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id = p_user_id for share;
  select action.* into v_action
  from public.cloud_provider_transport_stop_actions action
  where action.user_id = p_user_id for update;
  select workflow.* into v_workflow
  from public.cloud_account_deletion_workflows workflow
  where workflow.user_id = p_user_id for share;

  if v_preparation.user_id is null or v_action.user_id is null
     or v_workflow.user_id is null
     or v_preparation.state in ('ready','dead')
     or v_workflow.state not in ('stopping','draining')
     or v_action.deletion_epoch <> v_preparation.deletion_epoch
     or v_action.deletion_epoch <> p_expected_deletion_epoch
     or v_action.state <> 'processing'
     or v_action.lease_owner is distinct from btrim(p_worker)
     or v_action.lease_sequence <> p_expected_lease_sequence
     or v_action.revision <> p_expected_revision
     or v_action.lease_until <= clock_timestamp() then
    raise exception 'account deletion transport stop revalidation is stale'
      using errcode = '40001';
  end if;

  select coalesce(jsonb_agg(affinity.affinity_hash order by affinity.affinity_hash),'[]'::jsonb)
    into v_affinities
  from public.cloud_source_provider_account_affinities affinity
  where affinity.user_id = p_user_id;

  return jsonb_build_object(
    'contract','account-deletion-transport-stop-revalidate-v1',
    'state','processing','deletionEpoch',v_action.deletion_epoch,
    'leaseSequence',v_action.lease_sequence,'revision',v_action.revision,
    'affinityHashes',v_affinities
  );
end
$function$;

revoke all on function public.norva_revalidate_account_deletion_transport_stop(uuid,text,bigint,integer,bigint)
from public,anon,authenticated;
grant execute on function public.norva_revalidate_account_deletion_transport_stop(uuid,text,bigint,integer,bigint)
to service_role;
commit;
