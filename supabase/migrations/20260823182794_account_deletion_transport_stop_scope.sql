begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The gateway scope belongs to the stop action, not to a live source row. A
-- source deletion may cascade its affinity after the action is claimed; using
-- a fresh lookup at that point could turn a real gateway stop into an empty
-- scope and incorrectly produce a receipt. Keep only opaque SHA-256 values.
alter table public.cloud_provider_transport_stop_actions
  add column if not exists gateway_affinity_hashes jsonb;
alter table public.cloud_provider_transport_stop_actions
  add column if not exists gateway_affinity_epoch bigint;
alter table public.cloud_provider_transport_stop_actions
  drop constraint if exists cloud_provider_transport_stop_actions_gateway_affinity_scope_ck;
alter table public.cloud_provider_transport_stop_actions
  add constraint cloud_provider_transport_stop_actions_gateway_affinity_scope_ck check (
    (gateway_affinity_hashes is null and gateway_affinity_epoch is null)
    or (jsonb_typeof(gateway_affinity_hashes) = 'array'
        and gateway_affinity_epoch is not null and gateway_affinity_epoch >= 1)
  );

create or replace function public.norva_claim_account_deletion_transport_stop(
  p_user_id uuid,
  p_worker text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_claim jsonb; v_action public.cloud_provider_transport_stop_actions%rowtype; v_affinities jsonb;
begin
  perform public.norva_credential_require_service_role();
  v_claim := public.norva_claim_provider_transport_stop_action(p_user_id,p_worker,p_lease_seconds);
  if v_claim->>'state' <> 'processing' then return v_claim; end if;
  select action.* into v_action from public.cloud_provider_transport_stop_actions action
  where action.user_id=p_user_id for update;
  if v_action.user_id is null or v_action.state <> 'processing'
     or v_action.lease_owner is distinct from btrim(p_worker)
     or v_action.deletion_epoch <> (v_claim->>'deletionEpoch')::bigint then
    raise exception 'account deletion transport stop scope claim is stale' using errcode='40001';
  end if;
  if v_action.gateway_affinity_hashes is null
     or v_action.gateway_affinity_epoch is distinct from v_action.deletion_epoch then
    select coalesce(jsonb_agg(affinity.affinity_hash order by affinity.affinity_hash),'[]'::jsonb)
      into v_affinities
    from public.cloud_source_provider_account_affinities affinity
    where affinity.user_id=p_user_id;
    if exists (select 1 from jsonb_array_elements_text(v_affinities) value
               where value !~ '^[0-9a-f]{64}$') then
      raise exception 'account deletion transport scope is malformed' using errcode='55000';
    end if;
    update public.cloud_provider_transport_stop_actions action
    set gateway_affinity_hashes=v_affinities,gateway_affinity_epoch=action.deletion_epoch,
        revision=action.revision+1,updated_at=clock_timestamp()
    where action.user_id=p_user_id returning * into v_action;
  end if;
  return jsonb_build_object('contract','provider-transport-stop-v1','state','processing',
    'deletionEpoch',v_action.deletion_epoch,'revision',v_action.revision,
    'leaseSequence',v_action.lease_sequence,'leaseUntil',v_action.lease_until,
    'affinityHashes',v_action.gateway_affinity_hashes);
end
$function$;

create or replace function public.norva_revalidate_account_deletion_transport_stop(
  p_user_id uuid,p_worker text,p_expected_deletion_epoch bigint,
  p_expected_lease_sequence integer,p_expected_revision bigint
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_preparation public.cloud_provider_account_delete_preparations%rowtype;
  v_action public.cloud_provider_transport_stop_actions%rowtype;
  v_workflow public.cloud_account_deletion_workflows%rowtype;
begin
  perform public.norva_credential_require_service_role();
  if nullif(btrim(p_worker),'') is null or length(btrim(p_worker)) > 160
     or p_expected_deletion_epoch is null or p_expected_deletion_epoch < 0
     or p_expected_lease_sequence is null or p_expected_lease_sequence < 0
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'account deletion transport stop revalidation arguments are invalid' using errcode='22023';
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  select preparation.* into v_preparation from public.cloud_provider_account_delete_preparations preparation
  where preparation.user_id=p_user_id for share;
  select action.* into v_action from public.cloud_provider_transport_stop_actions action
  where action.user_id=p_user_id for update;
  select workflow.* into v_workflow from public.cloud_account_deletion_workflows workflow
  where workflow.user_id=p_user_id for share;
  if v_preparation.user_id is null or v_action.user_id is null or v_workflow.user_id is null
     or v_preparation.state in ('ready','dead') or v_workflow.state not in ('stopping','draining')
     or v_action.deletion_epoch <> v_preparation.deletion_epoch
     or v_action.deletion_epoch <> p_expected_deletion_epoch
     or v_action.gateway_affinity_epoch <> v_action.deletion_epoch
     or v_action.gateway_affinity_hashes is null
     or v_action.state <> 'processing' or v_action.lease_owner is distinct from btrim(p_worker)
     or v_action.lease_sequence <> p_expected_lease_sequence or v_action.revision <> p_expected_revision
     or v_action.lease_until <= clock_timestamp() then
    raise exception 'account deletion transport stop revalidation is stale' using errcode='40001';
  end if;
  return jsonb_build_object('contract','account-deletion-transport-stop-revalidate-v2',
    'state','processing','deletionEpoch',v_action.deletion_epoch,
    'leaseSequence',v_action.lease_sequence,'revision',v_action.revision,
    'affinityHashes',v_action.gateway_affinity_hashes);
end
$function$;

revoke all on function public.norva_claim_account_deletion_transport_stop(uuid,text,integer),
  public.norva_revalidate_account_deletion_transport_stop(uuid,text,bigint,integer,bigint)
from public,anon,authenticated;
grant execute on function public.norva_claim_account_deletion_transport_stop(uuid,text,integer),
  public.norva_revalidate_account_deletion_transport_stop(uuid,text,bigint,integer,bigint)
to service_role;
commit;
