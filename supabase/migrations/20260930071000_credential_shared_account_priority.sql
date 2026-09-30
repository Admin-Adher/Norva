begin;
set local lock_timeout='2s';
-- The same provider login may be present on several authorized Norva owners.
-- Background work on one must not starve the other's connection verification.
create or replace function public.norva_credential_work_pending_for_owner(p_user_id uuid)
returns boolean language plpgsql stable security definer set search_path=''
as $function$
begin
 perform public.norva_credential_require_service_role();
 return exists(select 1 from public.cloud_source_credential_transition_jobs job
   where job.state in ('pending','processing')
     and job.job_kind in ('validate_candidate','build_candidate_generation','post_switch_verify','rollback_refresh')
     and (job.user_id=p_user_id or exists(
       select 1 from public.cloud_source_provider_account_affinities held
       join public.cloud_source_provider_account_affinities other on other.affinity_hash=held.affinity_hash
       where held.source_id=job.source_id and held.user_id=job.user_id and other.user_id=p_user_id)));
end
$function$;
revoke all on function public.norva_credential_work_pending_for_owner(uuid) from public,anon,authenticated;
grant execute on function public.norva_credential_work_pending_for_owner(uuid) to service_role;
commit;
