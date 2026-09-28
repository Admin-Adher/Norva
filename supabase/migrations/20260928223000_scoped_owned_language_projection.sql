begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
set local search_path='';

-- Preserve the declaration view as the reference contract. Runtime consumers
-- bind ownership before evaluating exact episode precedence once per scope.
do $migration$
declare definition text; anchor text; body text;
begin
 definition:=rtrim(pg_get_viewdef('public.cloud_catalog_owned_audio_declarations'::regclass,true), E';\n ');
 anchor:='public.cloud_catalog_xtream_series_episode_audio_evidence(v.user_id, v.source_id)';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
   raise exception 'Owned declaration precedence drift';
 end if;
 definition:=replace(definition,anchor,'scoped_episode_evidence');
 body:='with scoped_episode_evidence as materialized (
   select * from public.cloud_catalog_xtream_series_episode_audio_evidence(p_user_id,p_source_id)
   where p_item_type=''series''
 ) '||definition||'
 and v.user_id=p_user_id and v.item_type=p_item_type
 and (p_source_id is null or v.source_id=p_source_id)';
 execute format('create function public.cloud_catalog_owned_audio_declarations_scoped(p_user_id uuid,p_source_id uuid,p_item_type text)
 returns table(user_id uuid,source_id uuid,item_type text,title_id uuid,variant_id uuid,language text)
 language sql stable security invoker set search_path='''' as %L',body);

 definition:=pg_get_functiondef('public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text)'::regprocedure);
 anchor:='public.cloud_catalog_owned_audio_declarations d';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
   raise exception 'Effective language consumer drift';
 end if;
 execute replace(definition,anchor,'public.cloud_catalog_owned_audio_declarations_scoped(p_user_id,p_source_id,p_item_type) d');

 definition:=pg_get_functiondef('public.catalog_movie_audio_identified(uuid,uuid,uuid)'::regprocedure);
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
   raise exception 'Movie intake consumer drift';
 end if;
 execute replace(definition,anchor,'public.cloud_catalog_owned_audio_declarations_scoped(v.user_id,v.source_id,''movie'') d');
end $migration$;
revoke all on function public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text) to service_role;
-- No flag activation, ownership exception, or provider operation.
commit;
