begin;
set local lock_timeout='2s'; set local statement_timeout='15s';
drop policy if exists "cloud_titles_owner_select" on public.cloud_titles;
create policy "cloud_titles_owner_select" on public.cloud_titles for select to authenticated
using (user_id=(select auth.uid()) and exists (
  select 1 from public.cloud_title_variants variant
  where variant.title_id=cloud_titles.id and variant.user_id=cloud_titles.user_id
    and public.norva_source_catalog_visible(variant.source_id,variant.user_id)
));
do $assert$ begin if not public.norva_provider_access_foundation_policy_is_exact('public.cloud_titles','cloud_titles_owner_select','r','1f1dfba168d24ad510f4d4adf1f5ca4da0aeb55f8cc23d9863086ad083ed5cb4','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') then raise exception 'cloud_titles lifecycle policy drift' using errcode='55000'; end if; end $assert$;
commit;
