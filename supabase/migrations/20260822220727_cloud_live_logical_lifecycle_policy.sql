begin;
set local lock_timeout='2s'; set local statement_timeout='15s';
drop policy if exists "cloud_live_logical_channels_select_own" on public.cloud_live_logical_channels;
create policy "cloud_live_logical_channels_select_own" on public.cloud_live_logical_channels for select to authenticated
using (user_id=(select auth.uid()) and public.norva_source_catalog_visible(source_id,user_id));
do $assert$ begin if not public.norva_provider_access_foundation_policy_is_exact('public.cloud_live_logical_channels','cloud_live_logical_channels_select_own','r','e1aa3c97babf17d80d236269212b84c920239a68a4388cb210a0e02d5f19270d','e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') then raise exception 'cloud_live_logical lifecycle policy drift' using errcode='55000'; end if; end $assert$;
commit;
