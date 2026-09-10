begin;
set local lock_timeout='2s';
set local statement_timeout='20s';
-- Live rollout: apply only AFTER the bounded hint backfill has reached EOF.
-- Keeping this cutover separate prevents partial membership during backfill.
create or replace function public.cloud_catalog_visible_title_ids_by_source_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_audio_language text default null,p_subtitle_language text default null
) returns table(title_id uuid) language sql stable security invoker set search_path='' as $f$
  select title_id from public.cloud_catalog_provider_title_ids_by_source_languages(
    p_user_id,p_item_type,p_source_id,p_audio_language,p_subtitle_language)
$f$;
revoke all on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
