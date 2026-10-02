-- Explicitly reviewed display fields remain stable during routine cache
-- maintenance. Newly available fields can still fill empty review fields.
begin;
set local lock_timeout='3s';
create or replace function public.norva_selection_preferred_editorial_image(p_existing text,p_candidate text)
returns text language sql immutable set search_path='' as $f$
 with images as (select public.norva_selection_editorial_image(p_existing) existing,
   public.norva_selection_editorial_image(p_candidate) candidate)
 select case
   when existing ~* '^https?://image[.]tmdb[.]org/' then existing
   when candidate ~* '^https?://image[.]tmdb[.]org/' then candidate
   else coalesce(candidate,existing) end from images;
$f$;
create function public.norva_selection_merge_editorial_fields(p_base jsonb,p_candidate jsonb,p_reviewed boolean)
returns jsonb language sql immutable parallel safe set search_path='' as $f$
 with fields as (select case when jsonb_typeof(p_base)='object' then p_base else '{}' end b,
   case when jsonb_typeof(p_candidate)='object' then p_candidate else '{}' end c),
 keys as(select jsonb_object_keys(b) k from fields union select jsonb_object_keys(c) from fields)
 select coalesce(jsonb_object_agg(k,case when p_reviewed and b->k not in ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb)
   then b->k else coalesce(c->k,b->k) end),'{}') from fields cross join keys;
$f$;
revoke all on function public.norva_selection_merge_editorial_fields(jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.norva_selection_merge_editorial_fields(jsonb,jsonb,boolean) to service_role;
create or replace function public.norva_merge_selection_editorial_metadata(p_base jsonb,p_public jsonb)
returns jsonb language sql immutable parallel safe set search_path='' as $f$
 with state as (select coalesce(p_base#>>'{tmdbValidation,valid}'='true'
   and nullif(p_base#>>'{tmdbSearchReview,reviewedAt}','') is not null,false) reviewed)
 select (case when jsonb_typeof(p_base)='object' then p_base else '{}' end) || jsonb_build_object(
   'tmdb',public.norva_selection_merge_editorial_fields(p_base->'tmdb',p_public->'tmdb',reviewed),
   'i18n',coalesce((select jsonb_object_agg(k,
     public.norva_selection_merge_editorial_fields(p_base->'i18n'->k,p_public->'i18n'->k,reviewed))
     from (select jsonb_object_keys(case when jsonb_typeof(p_base->'i18n')='object' then p_base->'i18n' else '{}' end) k
       union select jsonb_object_keys(case when jsonb_typeof(p_public->'i18n')='object' then p_public->'i18n' else '{}' end) k) langs),'{}'),
   'tmdbValidation',case when reviewed then p_base->'tmdbValidation'
     else coalesce(p_public->'tmdbValidation',p_base->'tmdbValidation','{}') end) from state;
$f$;
notify pgrst,'reload schema';
commit;
