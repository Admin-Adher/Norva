begin;
create temp table norva_active_media_input(item_type text,parent_external_id text,subtitle text,metadata jsonb);
create temp table category_fixture(generation_id uuid,user_id uuid,source_id uuid,projection_refresh_run_id uuid,category_kind text,provider_category_id text,category_name text);
do $test$
declare p_generation_id uuid:=gen_random_uuid();p_user_id uuid:=gen_random_uuid();p_source_id uuid:=gen_random_uuid();p_refresh_run_id uuid:=gen_random_uuid();body text;stmt text;
begin
 insert into category_fixture values(p_generation_id,p_user_id,p_source_id,p_refresh_run_id,'live','fr','France'),
 (p_generation_id,p_user_id,p_source_id,p_refresh_run_id,'vod','fr','Films'),
 (p_generation_id,p_user_id,p_source_id,gen_random_uuid(),'live','old','Stale'),
 (p_generation_id,gen_random_uuid(),p_source_id,p_refresh_run_id,'live','foreign','Foreign'),
 (gen_random_uuid(),p_user_id,p_source_id,p_refresh_run_id,'live','othergen','Other generation'),
 (p_generation_id,p_user_id,gen_random_uuid(),p_refresh_run_id,'live','othersource','Other source');
 insert into norva_active_media_input values('live','fr',null,'{}'),('movie','fr',null,'{}'),
 ('live','fr','Own','{"categoryName":"Own"}'),('live','old',null,'{}'),('live','foreign',null,'{}'),('live','othergen',null,'{}'),('live','othersource',null,'{}');
 select prosrc into body from pg_proc where oid='public.norva_upsert_active_catalog_media_items(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)'::regprocedure;
 stmt:=substring(body from position('  update pg_temp.norva_active_media_input input' in body));
 stmt:=split_part(stmt,';',1);
 stmt:=replace(stmt,'public.cloud_source_catalog_generation_categories','pg_temp.category_fixture');
 stmt:=replace(replace(replace(replace(stmt,'p_generation_id','$1'),'p_user_id','$2'),'p_source_id','$3'),'p_refresh_run_id','$4');
 execute stmt using p_generation_id,p_user_id,p_source_id,p_refresh_run_id;
 if (select count(*) from norva_active_media_input where metadata->>'categoryName' in ('France','Films','Own'))<>3 then raise exception 'category label projection failed';end if;
 if (select count(*) from norva_active_media_input where metadata='{}')<>4 then raise exception 'category scope isolation failed';end if;
 if has_function_privilege('authenticated','public.norva_upsert_active_catalog_media_items(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)','execute') then raise exception 'writer ACL expanded';end if;
 raise notice 'category kind/run/owner/source/generation isolation and explicit labels passed';
end $test$;
rollback;
