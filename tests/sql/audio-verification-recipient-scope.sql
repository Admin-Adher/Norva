-- Schema-only, networkless clone. All synthetic rows roll back.
begin;
set local statement_timeout='30s';
set local request.jwt.claim.role='service_role';
create function pg_temp.uid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
create temp table checks(label text primary key);
create function pg_temp.ok(value boolean,label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'fixture_failed: %',label; end if; insert into checks values(label); end $$;

-- The prior recipient contract, including the canonical visible view.
create function pg_temp.reference(p_server_host text,p_external_id text)
returns table(user_id uuid,title_id uuid,variant_id uuid,external_id text) language sql as $$
 select distinct variant.user_id,variant.title_id,variant.id,variant.external_id
 from public.cloud_catalog_visible_title_variants variant
 join public.cloud_sources source on source.id=variant.source_id and source.user_id=variant.user_id and source.deleted_at is null
 left join public.catalog_source_provider_identities verified_identity on verified_identity.source_id=source.id and verified_identity.user_id=source.user_id
 where variant.item_type='movie' and variant.external_id=p_external_id and variant.title_id is not null
   and coalesce(verified_identity.identity_id::text,'source:'||source.id::text)=p_server_host
 order by variant.user_id,variant.title_id,variant.id
$$;
do $$declare d text; q text; begin
 d:=pg_get_functiondef('public.record_catalog_file_audio_verification(text,text,text,boolean,timestamptz,timestamptz,jsonb)'::regprocedure);
 q:=split_part(split_part(d,'for v_owner in',2),'    loop',1);
 if position('with recipient_sources as materialized' in q)=0 then raise exception 'scoped_recipient_query_missing'; end if;
 execute 'create function pg_temp.candidate(p_server_host text,p_external_id text) returns table(user_id uuid,title_id uuid,variant_id uuid,external_id text) language sql as '||quote_literal(q);
end $$;
create function pg_temp.equivalent(label text) returns void language plpgsql as $$
declare identity text; file text; begin
 foreach identity in array array[pg_temp.uid(501)::text,pg_temp.uid(502)::text,'source:'||pg_temp.uid(105)::text,'source:'||pg_temp.uid(101)::text,'source:'||pg_temp.uid(111)::text,'unknown',null] loop
  foreach file in array array['movie-file','legacy-file','shared-file','missing',null] loop
   if exists((select * from pg_temp.reference(identity,file) except all select * from pg_temp.candidate(identity,file))
     union all (select * from pg_temp.candidate(identity,file) except all select * from pg_temp.reference(identity,file))) then
     raise exception 'recipient_set_differs: %',label;
   end if;
  end loop;
 end loop;
 perform pg_temp.ok(true,label);
end $$;

-- Current production rows require a generation. Relax only this isolated,
-- rolled-back fixture to verify the canonical view's legacy branch as well.
alter table cloud_title_variants alter column generation_id drop not null;
alter table cloud_title_variants drop constraint cloud_title_variants_generation_required_ck;
set local session_replication_role=replica;
insert into auth.users(id) values(pg_temp.uid(1)),(pg_temp.uid(2));
insert into provider_identities(id) values(pg_temp.uid(501)),(pg_temp.uid(502));
insert into cloud_sources(id,user_id,source_type,display_name,sync_status,enabled)
select pg_temp.uid(n),pg_temp.uid(case when n in (103,110) then 2 else 1 end),'xtream','Synthetic recipient','ready',true from generate_series(101,111)n;
insert into cloud_source_lifecycle(source_id,user_id,replacement_root_id,config_revision,visibility_epoch)
select id,user_id,id,1,1 from cloud_sources;
insert into cloud_source_catalog_heads(source_id,user_id,active_generation_id,head_revision)
select id,user_id,pg_temp.uid(n+1000),1 from generate_series(101,111)n join cloud_sources on id=pg_temp.uid(n) where n not in (109,111);
insert into cloud_source_catalog_generations(id,user_id,source_id,config_revision,state)
select pg_temp.uid(n+1000),user_id,id,1,'active' from generate_series(101,111)n join cloud_sources on id=pg_temp.uid(n);
insert into catalog_source_provider_identities(source_id,user_id,identity_id,provider_key,verified_at)
select id,user_id,pg_temp.uid(case when n=104 then 502 else 501 end),'synthetic',now()
from generate_series(101,111)n join cloud_sources on id=pg_temp.uid(n) where n not in (105,111);
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
select pg_temp.uid(n+3000),user_id,'movie','synthetic-'||n,'normalized','Synthetic movie'
from generate_series(101,111)n join cloud_sources on id=pg_temp.uid(n);
insert into cloud_titles(id,user_id,item_type,identity_key,identity_source,title)
values(pg_temp.uid(4010),pg_temp.uid(1),'series','synthetic-series','normalized','Synthetic series');
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title,
 write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch)
select pg_temp.uid(n+2000),user_id,pg_temp.uid(n+3000),id,case when n=111 then null else pg_temp.uid(n+1000) end,'movie','movie-file','Synthetic movie',1,1,1,1
from generate_series(101,111)n join cloud_sources on id=pg_temp.uid(n) where n<>110;
insert into cloud_title_variants(id,user_id,title_id,source_id,generation_id,item_type,external_id,raw_title)
values(pg_temp.uid(4001),pg_temp.uid(1),pg_temp.uid(3101),pg_temp.uid(101),null,'movie','legacy-file','Legacy'),
 (pg_temp.uid(4002),pg_temp.uid(1),pg_temp.uid(3101),pg_temp.uid(101),pg_temp.uid(9999),'movie','movie-file','Old generation'),
 (pg_temp.uid(4003),pg_temp.uid(1),pg_temp.uid(4010),pg_temp.uid(101),pg_temp.uid(1101),'series','movie-file','Series excluded');
insert into selection_shared_releases(id,revision,manifest_sha256,published_at) values(pg_temp.uid(600),repeat('a',64),repeat('b',64),now());
insert into selection_shared_enrollments(source_id,user_id,generation_id,config_revision,release_id)
values(pg_temp.uid(110),pg_temp.uid(2),pg_temp.uid(1110),1,pg_temp.uid(600));
insert into selection_shared_variants(release_id,item_type,external_id,raw_title,identity_key)
values(pg_temp.uid(600),'movie','movie-file','Shared movie','shared-movie'),(pg_temp.uid(600),'movie','shared-file','Shared only','shared-only');
set local session_replication_role=origin;

select pg_temp.equivalent('initial_35_scope_file_combinations');
select pg_temp.ok(exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'movie-file') where variant_id=pg_temp.uid(2101)),'active_generation');
select pg_temp.ok(exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'movie-file') where user_id=pg_temp.uid(2) and variant_id=pg_temp.uid(2103)),'same_provider_separate_owner');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'movie-file') where variant_id in (pg_temp.uid(2104),pg_temp.uid(2105),pg_temp.uid(2109),pg_temp.uid(4002),pg_temp.uid(4003))),'foreign_private_unheaded_archived_and_series_excluded');
select pg_temp.ok((select count(*)=1 from pg_temp.candidate('source:'||pg_temp.uid(105)::text,'movie-file')),'private_source_only');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate('source:'||pg_temp.uid(101)::text,'movie-file')),'verified_identity_prevents_private_fallback');
select pg_temp.ok(exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'legacy-file') where variant_id=pg_temp.uid(4001)),'legacy_null_generation');
select pg_temp.ok(exists(select 1 from pg_temp.candidate('source:'||pg_temp.uid(111)::text,'movie-file') where variant_id=pg_temp.uid(2111)),'legacy_without_head');
select pg_temp.ok((select count(*)=1 from pg_temp.candidate(pg_temp.uid(501)::text,'shared-file') where user_id=pg_temp.uid(2)),'shared_virtual_recipient');

-- The canonical visibility contract remains authoritative through changes.
-- Seed the terminal fixture states directly; the lifecycle transition guards
-- are unchanged and are not the subject of this read-query equivalence test.
set local session_replication_role=replica;
update cloud_source_lifecycle set lifecycle_state='staging',catalog_visibility='hidden' where source_id=pg_temp.uid(106);
select pg_temp.equivalent('hidden_source_equivalence');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'movie-file') where variant_id=pg_temp.uid(2106)),'hidden_source_excluded');
update cloud_sources set deleted_at=now() where id=pg_temp.uid(107);
select pg_temp.equivalent('deleted_source_equivalence');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'movie-file') where variant_id=pg_temp.uid(2107)),'deleted_source_excluded');
update cloud_sources set enabled=false where id=pg_temp.uid(108);
select pg_temp.equivalent('disabled_source_equivalence');
update cloud_source_catalog_heads set active_generation_id=pg_temp.uid(9999) where source_id=pg_temp.uid(101);
select pg_temp.equivalent('head_replacement_equivalence');
select pg_temp.ok(exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'movie-file') where variant_id=pg_temp.uid(4002)),'new_active_generation_selected');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'movie-file') where variant_id=pg_temp.uid(2101)),'old_active_generation_excluded');
update cloud_source_catalog_heads set active_generation_id=pg_temp.uid(9999) where source_id=pg_temp.uid(110);
select pg_temp.equivalent('shared_head_changed_equivalence');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'shared-file')),'shared_head_fence');
update cloud_source_catalog_heads set active_generation_id=pg_temp.uid(1110) where source_id=pg_temp.uid(110);
update cloud_source_lifecycle set config_revision=2 where source_id=pg_temp.uid(110);
select pg_temp.equivalent('shared_config_changed_equivalence');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'shared-file')),'shared_config_fence');
update cloud_source_lifecycle set config_revision=1 where source_id=pg_temp.uid(110);
update selection_shared_releases set published_at=null where id=pg_temp.uid(600);
select pg_temp.equivalent('shared_unpublished_equivalence');
select pg_temp.ok(not exists(select 1 from pg_temp.candidate(pg_temp.uid(501)::text,'shared-file')),'shared_publication_fence');
set local session_replication_role=origin;
select jsonb_build_object('suite','audio-verification-recipient-scope','passed',count(*),'checks',jsonb_agg(label order by label)) from checks;
rollback;
