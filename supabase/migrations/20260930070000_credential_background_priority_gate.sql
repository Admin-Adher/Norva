begin;
set local lock_timeout='2s';
create or replace function public.norva_credential_work_pending_for_owner(p_user_id uuid)
returns boolean language plpgsql stable security definer set search_path=''
as $function$
begin
 perform public.norva_credential_require_service_role();
 return exists(select 1 from public.cloud_source_credential_transition_jobs job
   where job.user_id=p_user_id and job.state in ('pending','processing')
     and job.job_kind in ('validate_candidate','build_candidate_generation','post_switch_verify','rollback_refresh'));
end
$function$;
revoke all on function public.norva_credential_work_pending_for_owner(uuid) from public,anon,authenticated;
grant execute on function public.norva_credential_work_pending_for_owner(uuid) to service_role;
commit;
