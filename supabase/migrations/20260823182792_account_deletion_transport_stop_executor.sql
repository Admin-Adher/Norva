begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Extends the existing transport-stop claim with only opaque account affinity
-- hashes. The gateway never receives credentials, source URLs or user IDs.
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
declare v_claim jsonb; v_affinities jsonb;
begin
  perform public.norva_credential_require_service_role();
  v_claim := public.norva_claim_provider_transport_stop_action(
    p_user_id,p_worker,p_lease_seconds
  );
  if v_claim->>'state' <> 'processing' then return v_claim; end if;
  select coalesce(jsonb_agg(affinity.affinity_hash order by affinity.affinity_hash),'[]'::jsonb)
    into v_affinities
  from public.cloud_source_provider_account_affinities affinity
  where affinity.user_id=p_user_id;
  return v_claim || jsonb_build_object('affinityHashes',v_affinities);
end
$function$;

revoke all on function public.norva_claim_account_deletion_transport_stop(uuid,text,integer)
from public,anon,authenticated;
grant execute on function public.norva_claim_account_deletion_transport_stop(uuid,text,integer)
to service_role;
commit;
