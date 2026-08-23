begin;
set local lock_timeout='2s'; set local statement_timeout='15s';
drop policy if exists "cloud_watch_history_owner_all" on public.cloud_watch_history;
create policy "cloud_watch_history_owner_all" on public.cloud_watch_history for all to authenticated
using (user_id=(select auth.uid()) and (source_id is null or public.norva_source_catalog_visible(source_id,user_id)))
with check (user_id=(select auth.uid()) and (source_id is null or public.norva_source_catalog_visible(source_id,user_id)));
do $assert$ begin if not public.norva_provider_access_foundation_policy_is_exact('public.cloud_watch_history','cloud_watch_history_owner_all','*','a7e3bbc09b6f48ad121357b911e33fd290f7941b46cb75f83f45196da6f4a6c0','a7e3bbc09b6f48ad121357b911e33fd290f7941b46cb75f83f45196da6f4a6c0') then raise exception 'cloud_watch_history lifecycle policy drift' using errcode='55000'; end if; end $assert$;
commit;
