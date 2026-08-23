begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Reconciles the only intentional cross-transaction crash gap: Auth deletion
-- has succeeded but Edge died before acknowledging the durable tombstone.
create or replace function public.norva_reconcile_account_deletion_finalizations(
  p_batch integer default 25
) returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_completed integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_batch is null or p_batch not between 1 and 100 then
    raise exception 'account deletion finalization reconcile batch is invalid' using errcode='22023';
  end if;
  with candidates as (
    select finalization.finalization_key
    from public.cloud_account_deletion_finalizations finalization
    where finalization.state='claimed'
      and not exists (
        select 1 from auth.users account
        where encode(extensions.digest(account.id::text,'sha256'),'hex')=finalization.account_key
      )
    order by finalization.claimed_at,finalization.finalization_key
    for update skip locked limit p_batch
  ), completed as (
    update public.cloud_account_deletion_finalizations finalization
    set state='completed',completed_at=clock_timestamp(),lease_until=clock_timestamp()
    from candidates where finalization.finalization_key=candidates.finalization_key
    returning 1
  ) select count(*)::integer into v_completed from completed;
  return v_completed;
end
$function$;

revoke all on function public.norva_reconcile_account_deletion_finalizations(integer)
from public,anon,authenticated;
grant execute on function public.norva_reconcile_account_deletion_finalizations(integer)
to service_role;
commit;
