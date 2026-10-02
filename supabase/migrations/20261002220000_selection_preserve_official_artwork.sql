-- A same-identity cache refresh must not downgrade existing official artwork
-- to a provider image. Identity, ownership and publication fences are unchanged.
begin;
set local lock_timeout='3s';
create function public.norva_selection_preferred_editorial_image(p_existing text,p_candidate text)
returns text language sql immutable set search_path='' as $f$
 with images as (select public.norva_selection_editorial_image(p_existing) existing,
   public.norva_selection_editorial_image(p_candidate) candidate)
 select case
   when candidate ~* '^https?://image[.]tmdb[.]org/' then candidate
   when existing ~* '^https?://image[.]tmdb[.]org/' then existing
   else coalesce(candidate,existing) end from images;
$f$;
revoke all on function public.norva_selection_preferred_editorial_image(text,text) from public,anon,authenticated;
grant execute on function public.norva_selection_preferred_editorial_image(text,text) to service_role;
do $upgrade$
declare d text; routine regprocedure; prefix text; field text; needle text; expected int;
begin
 for routine,prefix,expected in select * from (values
   ('public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid)'::regprocedure,'x.c_',2),
   ('public.norva_refresh_selection_shared_editorial_from_cache(integer)'::regprocedure,'c.',1)
 ) inputs loop
   select pg_get_functiondef(routine) into d;
   foreach field in array array['poster_url','backdrop_url'] loop
     needle:=format('coalesce(public.norva_selection_editorial_image(%s%s),public.norva_selection_editorial_image(t.%s))',prefix,field,field);
     if (length(d)-length(replace(d,needle,'')))/length(needle)<>expected then
       raise exception 'Selection artwork preference contract drift: % %',routine,field using errcode='55000'; end if;
     d:=replace(d,needle,format('public.norva_selection_preferred_editorial_image(t.%s,%s%s)',field,prefix,field));
   end loop;
   execute d;
 end loop;
end $upgrade$;
notify pgrst,'reload schema';
commit;
