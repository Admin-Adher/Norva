begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

insert into public.admin_feature_flags(key,enabled) values('selection_parallel_capture_enabled',false)
on conflict(key) do nothing;
create function public.selection_audio_parallel_capture_enabled()
returns boolean language sql stable security definer set search_path='' as $f$
  select public.selection_audio_capture_pipeline_enabled() and exists(
    select 1 from public.admin_feature_flags where key='selection_parallel_capture_enabled' and enabled)
$f$;
revoke all on function public.selection_audio_parallel_capture_enabled() from public,anon,authenticated;
grant execute on function public.selection_audio_parallel_capture_enabled() to service_role;

-- Preserve the installed bounded owner scan, exact-file uniqueness, eight
-- attempts, work-token CAS and terminal/quarantine history. Only the number of
-- independent live work leases changes; the shared advisory lock remains the
-- distributed arbiter. Gateway resource/host/account gates are still stricter.
do $patch$
declare d text; old text;
begin
  d:=pg_get_functiondef('public.claim_selection_audio_job()'::regprocedure);
  old:=$old$if exists(select 1 from public.catalog_selection_audio_jobs where state='running' and lease_until>v_now) then return null; end if;$old$;
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then
    raise exception 'Selection live-work admission block drifted';
  end if;
  execute replace(d,old,$new$if (select count(*) from public.catalog_selection_audio_jobs where state='running' and lease_until>v_now)
      >= (case when public.selection_audio_parallel_capture_enabled() then 2 else 1 end) then return null; end if;$new$);
end $patch$;
notify pgrst, 'reload schema';
commit;
