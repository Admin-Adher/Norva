begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Exact language filtering must remain bounded when the viewer switches from a
-- concrete source to "All Sources".  The original helper required source_id =
-- p_source_id, so NULL could not express the visible union.  That sent Edge
-- back to an exact-count query over the full compatibility view; real Series
-- catalogues spent more than 55 seconds in that count and the UI retained the
-- previous source count with an empty grid.  A NULL source now means every
-- already-visible variant owned by the user.  A concrete source keeps the
-- original provider-local semantics unchanged.
create or replace function public.cloud_catalog_visible_title_ids_by_source_languages(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid,
  p_audio_language text default null,
  p_subtitle_language text default null
) returns table(title_id uuid)
language sql
stable
security invoker
set search_path = ''
as $function$
  select distinct variant.title_id
  from public.cloud_catalog_visible_title_variants variant
  where variant.user_id = p_user_id
    and (p_source_id is null or variant.source_id = p_source_id)
    and variant.item_type = p_item_type
    and p_item_type in ('movie', 'series')
    and (
      p_source_id is null
      or public.norva_source_catalog_visible(p_source_id, p_user_id)
    )
    and (
      nullif(lower(btrim(p_audio_language)), '') is null
      or exists (
        select 1
        from public.cloud_title_file_language_observations observation
        where observation.user_id = variant.user_id
          and observation.title_id = variant.title_id
          and observation.variant_id = variant.id
          and observation.audio_observed
          and nullif(lower(btrim(p_audio_language)), '') = any(observation.audio_languages)
      )
    )
    and (
      nullif(lower(btrim(p_subtitle_language)), '') is null
      or exists (
        select 1
        from public.cloud_title_file_language_observations observation
        where observation.user_id = variant.user_id
          and observation.title_id = variant.title_id
          and observation.variant_id = variant.id
          and observation.subtitle_observed
          and nullif(lower(btrim(p_subtitle_language)), '') = any(observation.subtitle_languages)
      )
    )
$function$;

revoke all on function public.cloud_catalog_visible_title_ids_by_source_languages(
  uuid, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.cloud_catalog_visible_title_ids_by_source_languages(
  uuid, text, uuid, text, text
) to service_role;

comment on function public.cloud_catalog_visible_title_ids_by_source_languages(
  uuid, text, uuid, text, text
) is 'Exact visible provider-file language title ids; a null source selects the visible all-source union.';

do $assert$
declare
  v_security_definer boolean;
  v_config text[];
begin
  select procedure_state.prosecdef, procedure_state.proconfig
    into v_security_definer, v_config
  from pg_proc procedure_state
  where procedure_state.oid =
    'public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text)'::regprocedure;

  if not found
     or coalesce(v_security_definer, true)
     or not ('search_path=""' = any(coalesce(v_config, '{}'::text[])))
     or not has_function_privilege(
       'service_role',
       'public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text)',
       'EXECUTE'
     ) then
    raise exception 'cloud catalog visible title language-id contract drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
