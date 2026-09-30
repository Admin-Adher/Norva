begin;
create temp table rollup_titles(id uuid primary key,default_variant_id uuid,variant_count int,last_observed_ttff_ms int,updated_at timestamptz);
create temp table rollup_variants(id uuid,title_id uuid,source_id uuid,user_id uuid,generation_id uuid,playback_cost_score int,last_observed_ttff_ms int,created_at timestamptz);
create temp table rollup_heads(source_id uuid,user_id uuid,active_generation_id uuid);
create temp table rollup_sources(id uuid,owner_id uuid,visible boolean);
create temp table visibility_calls(source_id uuid,user_id uuid);
create function pg_temp.rollup_visible(s uuid,u uuid) returns boolean language plpgsql as $$begin
 insert into pg_temp.visibility_calls values(s,u);
 return coalesce((select visible from pg_temp.rollup_sources where id=s and owner_id=u),false);
end$$;
do $patch$
declare body text;
begin
 select pg_get_functiondef('public.refresh_cloud_title_rollup(uuid)'::regprocedure) into body;
 body:=replace(replace(replace(replace(body,'public.cloud_title_variants','pg_temp.rollup_variants'),'public.cloud_source_catalog_heads','pg_temp.rollup_heads'),'public.cloud_titles','pg_temp.rollup_titles'),'public.norva_source_catalog_visible','pg_temp.rollup_visible');
 execute body;
 alter function public.refresh_cloud_title_rollup(uuid) security invoker; -- fixture temporary tables only
end $patch$;
do $test$
declare t uuid:=gen_random_uuid();s uuid:=gen_random_uuid();u uuid:=gen_random_uuid();g uuid:=gen_random_uuid();best uuid:=gen_random_uuid(); row_state record;
begin
 insert into rollup_titles values(t,null,0,null,now());
 insert into rollup_sources values(s,u,true);
 insert into rollup_heads values(s,u,g);
 insert into rollup_variants values
 (gen_random_uuid(),t,s,u,g,100,null,now()),
 (gen_random_uuid(),t,s,u,null,250,null,now()),
 (gen_random_uuid(),t,s,u,gen_random_uuid(),1,1,now()),
 (gen_random_uuid(),t,s,gen_random_uuid(),g,1,1,now()),
 (best,t,s,u,g,100,50,now());
 insert into rollup_variants select gen_random_uuid(),t,s,u,g,500,null,now() from generate_series(1,600);
 perform public.refresh_cloud_title_rollup(t);
 if (select count(*) from visibility_calls)<>2 then raise exception 'visibility must be evaluated once per distinct owner/source';end if;
 select * into row_state from rollup_titles where id=t;
 if row_state.variant_count<>603 or row_state.default_variant_id<>best or row_state.last_observed_ttff_ms<>50 then raise exception 'active/legacy ranking/count or owner-generation isolation failed';end if;
 update rollup_sources set visible=false;
 perform public.refresh_cloud_title_rollup(t);
 select * into row_state from rollup_titles where id=t;
 if row_state.variant_count<>0 or row_state.default_variant_id is not null or row_state.last_observed_ttff_ms is not null then raise exception 'hidden membership did not clear rollup';end if;
 perform public.refresh_cloud_title_rollup(null);
 if (select count(*) from visibility_calls)<>4 then raise exception 'visibility reused outside its own statement';end if;
 raise notice 'source visibility rollup: bounded calls, active, legacy, hidden, owner, generation and ranking passed';
end $test$;
rollback;
