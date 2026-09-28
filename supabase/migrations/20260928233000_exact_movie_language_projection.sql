begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
set local search_path='';

-- The catalogue-wide projection is deliberately scoped before execution. A
-- per-file intake must also bind its variant inside the SQL function: an outer
-- WHERE on a SET search_path SQL function cannot be pushed through its boundary.
do $migration$
declare body text; definition text; anchor text;
begin
 select prosrc into strict body from pg_proc
 where oid='public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text)'::regprocedure;
 body:=rtrim(body,E';\n ')||' and v.id=p_variant_id';
 execute format('create function public.cloud_catalog_owned_audio_declarations_exact_movie(p_user_id uuid,p_source_id uuid,p_variant_id uuid)
 returns table(user_id uuid,source_id uuid,item_type text,title_id uuid,variant_id uuid,language text)
 language sql stable security invoker set search_path='''' as %L',
 replace(body,'p_item_type','''movie'''));
 definition:=pg_get_functiondef('public.catalog_movie_audio_identified(uuid,uuid,uuid)'::regprocedure);
 anchor:='public.cloud_catalog_owned_audio_declarations_scoped(v.user_id,v.source_id,''movie'')';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
   raise exception 'Movie intake projection drift';
 end if;
 execute replace(definition,anchor,
   'public.cloud_catalog_owned_audio_declarations_exact_movie(v.user_id,v.source_id,v.id)');
end $migration$;
revoke all on function public.cloud_catalog_owned_audio_declarations_exact_movie(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.cloud_catalog_owned_audio_declarations_exact_movie(uuid,uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
