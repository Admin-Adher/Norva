begin;
set local lock_timeout='2s'; set local statement_timeout='15s';
drop policy if exists "cloud_favorites_owner_all" on public.cloud_favorites;
create policy "cloud_favorites_owner_all" on public.cloud_favorites for all to authenticated
using (user_id=(select auth.uid()) and public.norva_source_catalog_visible(source_id,user_id))
with check (user_id=(select auth.uid()) and public.norva_source_catalog_visible(source_id,user_id));
do $assert$ begin if not public.norva_provider_access_foundation_policy_is_exact('public.cloud_favorites','cloud_favorites_owner_all','*','e1aa3c97babf17d80d236269212b84c920239a68a4388cb210a0e02d5f19270d','e1aa3c97babf17d80d236269212b84c920239a68a4388cb210a0e02d5f19270d') then raise exception 'cloud_favorites lifecycle policy drift' using errcode='55000'; end if; end $assert$;
commit;
