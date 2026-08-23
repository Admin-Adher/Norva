-- Claim the next bounded account-deletion step.  This is deliberately a
-- short PostgreSQL transaction: revision is the authority, not the lease or
-- any Edge isolate.  A second scheduler receives a different revision and
-- its later RPC is rejected as STALE.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.norva_claim_account_deletion_workflows(
  p_batch integer default 10
) returns table(user_id uuid, state text, revision bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform public.norva_credential_require_service_role();
  if p_batch is null or p_batch not between 1 and 100 then
    raise exception 'account deletion workflow claim batch is invalid' using errcode='22023';
  end if;
  return query
  with candidates as materialized (
    select workflow.user_id
    from public.cloud_account_deletion_workflows workflow
    where workflow.state in (
      'stopping','draining','purging_analytics','archiving_legal','purging_product'
    )
    order by workflow.updated_at, workflow.user_id
    for update skip locked
    limit p_batch
  ), claimed as (
    update public.cloud_account_deletion_workflows workflow
    set revision = workflow.revision + 1,
        updated_at = clock_timestamp()
    from candidates
    where workflow.user_id = candidates.user_id
    returning workflow.user_id, workflow.state, workflow.revision
  )
  select claimed.user_id, claimed.state, claimed.revision from claimed;
end
$function$;

revoke all on function public.norva_claim_account_deletion_workflows(integer)
from public, anon, authenticated;
grant execute on function public.norva_claim_account_deletion_workflows(integer)
to service_role;
commit;
