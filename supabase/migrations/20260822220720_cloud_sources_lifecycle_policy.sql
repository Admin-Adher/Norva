begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
drop policy if exists "cloud_sources_owner_all" on public.cloud_sources;
create policy "cloud_sources_owner_all" on public.cloud_sources for all to authenticated
using (user_id=(select auth.uid()) and public.norva_source_catalog_visible(id,user_id))
with check (user_id=(select auth.uid()));
do $assert$ begin
  if not public.norva_provider_access_foundation_policy_is_exact('public.cloud_sources','cloud_sources_owner_all','*','2b7e23c713f69910ce0b8c7359d1460fbdca8a96896df7fbbc00ad8a3c3b7a42','1b29cc1f6c0017f447260789db013ce3e4e626934472e2d6330af3984baee68b') then raise exception 'cloud_sources lifecycle policy drift' using errcode='55000'; end if;
end $assert$;
commit;
