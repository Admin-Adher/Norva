-- A TMDB size endpoint alone is not an image. Common-cache maintenance must
-- not restore one over reviewed artwork or repeatedly publish a broken poster.
begin;
create function public.norva_selection_editorial_image(p_url text)
returns text language sql immutable set search_path='' as $f$
 select case when btrim(p_url) ~* '^https?://image[.]tmdb[.]org(/|$)'
   and btrim(p_url) !~* '^https?://image[.]tmdb[.]org/t/p/[a-z0-9_-]+/[a-z0-9._-]+[.](jpg|png|webp)([?#].*)?$'
   then null else nullif(btrim(p_url),'') end;
$f$;
revoke all on function public.norva_selection_editorial_image(text) from public,anon,authenticated;
grant execute on function public.norva_selection_editorial_image(text) to service_role;

-- Keep the existing ownership, file URL, confidence, rejection and generation
-- fences. Guard both the comparison and the write so retries stay no-ops.
do $guard$
declare definition text; routine regprocedure; prefix text; field text; needle text; expected int;
begin
 for routine,prefix,expected in select * from (values
   ('public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid)'::regprocedure,'x.c_',2),
   ('public.norva_refresh_selection_shared_editorial_from_cache(integer)'::regprocedure,'c.',1)
 ) inputs loop
   select pg_get_functiondef(routine) into definition;
   foreach field in array array['poster_url','backdrop_url'] loop
     needle:=format('coalesce(nullif(%s%s,''''),t.%s)',prefix,field,field);
     if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>expected then
       raise exception 'Selection artwork writer contract drift: % %',routine,field using errcode='55000';
     end if;
     definition:=replace(definition,needle,format('coalesce(public.norva_selection_editorial_image(%s%s),public.norva_selection_editorial_image(t.%s))',prefix,field,field));
   end loop;
   execute definition;
 end loop;
end $guard$;
-- Normalize already published endpoint-only artwork. This edits display fields
-- only; public file manifests, playback variants and private metadata stay intact.
do $cleanup$
declare released uuid; owner_id uuid;
begin
 for released in with changed as (
   update public.selection_shared_titles t set
     poster_url=public.norva_selection_editorial_image(t.poster_url),
     backdrop_url=public.norva_selection_editorial_image(t.backdrop_url)
   where exists(select 1 from public.selection_shared_releases r where r.id=t.release_id and r.published_at is not null)
     and (t.poster_url,t.backdrop_url) is distinct from
       (public.norva_selection_editorial_image(t.poster_url),public.norva_selection_editorial_image(t.backdrop_url))
   returning release_id
 ) select distinct release_id from changed loop
   update public.selection_shared_releases set editorial_updated_at=clock_timestamp() where id=released;
   for owner_id in select distinct user_id from public.selection_shared_visible_enrollments where release_id=released loop
     perform public.norva_bump_user_catalog_visibility_epoch(owner_id);
     delete from public.cloud_catalog_facet_summary where user_id=owner_id;
   end loop;
 end loop;
end $cleanup$;
notify pgrst,'reload schema';
commit;
