begin;
set local lock_timeout='2s';

create or replace function public.norva_request_catalog_reader_window(p_user_id uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $f$
begin
 perform public.norva_credential_require_service_role();
 if not exists(select 1 from public.cloud_source_credential_transition_jobs j
   where j.user_id=p_user_id and j.job_kind='post_switch_verify' and j.state in ('pending','processing')) then return false; end if;
 perform 1 from public.cloud_user_catalog_visibility_epochs where user_id=p_user_id for update;
 if not found then return false; end if;
 -- Concurrent/repeated reads share the current window. Extending it on every
 -- catalogue poll can starve the very refresh that those reads are observing.
 insert into public.cloud_catalog_reader_windows as reader_window(user_id,expires_at)
 values(p_user_id,clock_timestamp()+interval '10 seconds')
 on conflict(user_id) do update set expires_at=excluded.expires_at
 where reader_window.expires_at<=clock_timestamp();
 return true;
end $f$;
revoke all on function public.norva_request_catalog_reader_window(uuid) from public,anon,authenticated,service_role;
grant execute on function public.norva_request_catalog_reader_window(uuid) to service_role;
commit;
