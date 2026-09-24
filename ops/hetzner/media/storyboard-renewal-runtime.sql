-- Run only after the renewal migration in a disposable schema-only database.
begin;
do $$ begin
 if current_database()<>'norva_media_cache_canary' then raise exception 'Disposable database required'; end if;
end $$;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $test$
declare u uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); n int;
begin
 if not (select relrowsecurity from pg_class where oid='public.catalog_storyboards'::regclass) then
  raise exception 'Storyboards RLS disabled';
 end if;
 if exists(select 1 from pg_policies where schemaname='public' and tablename='catalog_storyboards') then
  raise exception 'Unexpected storyboard client policy';
 end if;
 insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 values(u,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','storyboard-renewal@invalid.test','',now(),'{}','{}',now(),now());
 insert into public.cloud_sources(id,user_id,source_type,display_name,config_ciphertext,config_hint,sync_status,enabled)
 values(s,u,'m3u','Synthetic storyboard source','cipher','{}','ready',true);
 insert into public.catalog_storyboards(provider_key,item_type,external_id,status,job_id,sprite_path,job_user_id,job_source_id,job_container,job_duration)
 values('qa-storyboard','movie','42','processing',j,'qa/movie.jpg',u,s,'mkv',120);
 select count(*) into n from public.catalog_storyboards where job_id=j and job_user_id=u and job_source_id=s and job_duration=120;
 if n<>1 then raise exception 'Renewal context not persisted'; end if;
 update public.cloud_sources set enabled=false, deleted_at=now() where id=s;
 if exists(select 1 from public.catalog_storyboards b join public.cloud_sources c on c.id=b.job_source_id
   where b.job_id=j and c.user_id=b.job_user_id and c.enabled and c.deleted_at is null) then
  raise exception 'Soft-deleted source kept renewal eligibility';
 end if;
 begin
  update public.catalog_storyboards set job_user_id=gen_random_uuid() where job_id=j;
  raise exception 'Missing owner accepted';
 exception when foreign_key_violation then null;
 end;
 begin
  update public.catalog_storyboards set job_source_id=gen_random_uuid() where job_id=j;
  raise exception 'Missing source accepted';
 exception when foreign_key_violation then null;
 end;
 select count(*) into n from pg_constraint where conrelid='public.catalog_storyboards'::regclass
  and contype='f' and confdeltype='n' and (confrelid='auth.users'::regclass or confrelid='public.cloud_sources'::regclass);
 if n<>2 then raise exception 'Renewal FK delete action missing'; end if;
 raise notice 'STORYBOARD_RENEWAL_SCHEMA_PASS: RLS, no client policy, context persistence, soft deletion, owner/source FKs, SET NULL definitions';
end $test$;
rollback;
