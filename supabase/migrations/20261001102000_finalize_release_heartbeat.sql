-- A released CAS claim must not leave a four-minute advisory heartbeat behind.
-- The watchdog may recover a missed continuation after its normal stale window.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create or replace function public.norva_release_source_finalize_lease(
  p_source_id uuid, p_user_id uuid, p_lease_token uuid
) returns boolean language plpgsql security definer set search_path='' as $f$
declare v_released boolean := false;
begin
  -- Same mutex/order as claim and renew: a successor cannot acquire the source
  -- between deleting our exact token and clearing our advisory heartbeat.
  perform 1 from public.cloud_user_catalog_visibility_epochs
    where user_id=p_user_id for update;
  delete from public.cloud_source_finalize_leases l
    where l.source_id=p_source_id and l.user_id=p_user_id and l.lease_token=p_lease_token
    returning true into v_released;
  if coalesce(v_released,false) then
    update public.cloud_sources set config_hint=coalesce(config_hint,'{}'::jsonb)-'finalizeLease'
      where id=p_source_id and user_id=p_user_id and config_hint ? 'finalizeLease';
  end if;
  return coalesce(v_released,false);
end $f$;
revoke all on function public.norva_release_source_finalize_lease(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_release_source_finalize_lease(uuid,uuid,uuid) to service_role;

-- This service-only admission aggregate already exists in production. Keep its
-- definition in migrations so a clean deployment retains the bounded policy.
create or replace function public.norva_active_source_finalize_lease_count()
returns integer language sql stable security definer set search_path='pg_catalog' as $f$
  select count(*)::integer from public.cloud_source_finalize_leases
    where lease_until>statement_timestamp();
$f$;
revoke all on function public.norva_active_source_finalize_lease_count() from public,anon,authenticated;
grant execute on function public.norva_active_source_finalize_lease_count() to service_role;
commit;
