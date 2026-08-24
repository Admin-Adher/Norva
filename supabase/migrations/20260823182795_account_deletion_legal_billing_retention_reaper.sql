-- The retention policy remains an explicit, operator-provisioned legal decision.
-- Once a record has reached its policy-derived retention_until, deleting that
-- isolated archive row is a bounded, crash-safe service operation.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create index if not exists legal_billing_archive_retention_until_idx
  on public.legal_billing_archive(retention_until);

create or replace function public.norva_purge_expired_legal_billing_archive(
  p_limit integer default 500
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_deleted integer := 0;
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'legal billing retention purge batch limit is invalid' using errcode='22023';
  end if;
  with selected as materialized (
    select archive.legal_record_id
    from public.legal_billing_archive archive
    where archive.retention_until <= clock_timestamp()
    order by archive.retention_until,archive.legal_record_id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from public.legal_billing_archive archive
    using selected
    where archive.legal_record_id=selected.legal_record_id
    returning archive.legal_record_id
  ) select count(*)::integer into v_deleted from deleted;
  return jsonb_build_object('contract','legal-billing-retention-reaper-v1',
    'deletedRows',v_deleted,'complete',v_deleted < p_limit);
end
$function$;

revoke all on function public.norva_purge_expired_legal_billing_archive(integer)
from public, anon, authenticated;
grant execute on function public.norva_purge_expired_legal_billing_archive(integer)
to service_role;

commit;
