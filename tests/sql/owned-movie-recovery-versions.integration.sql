begin;
set local request.jwt.claim.role='service_role';
create temp table qa_results(label text);
create function pg_temp.assert(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Assertion failed: %',label; end if;
 insert into qa_results values(label); end $$;
create function pg_temp.reject(statement text,code text,label text) returns void language plpgsql as $$
begin
 begin execute statement; exception when others then
  if sqlstate=code then insert into qa_results values(label);return; end if;
  raise exception 'Unexpected state % for %',sqlstate,label;
 end;
 raise exception 'Expected rejection: %',label;
end $$;
create function pg_temp.id(n integer) returns uuid language sql immutable as $$
 select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.row(id integer,owner integer default 1,tmdb text default '123',status text default 'matched')
returns jsonb language sql immutable as $$select jsonb_build_object(
 'id',pg_temp.id(id),'user_id',pg_temp.id(owner),'item_type','movie','variant_count',1,
 'provider_tmdb_id',tmdb,'match_status',status,'metadata',jsonb_build_object('tmdb',jsonb_build_object('id',tmdb),
 'tmdbValidation',jsonb_build_object('valid',true)))$$;
create function pg_temp.read_ids(anchor integer default 10,lim integer default 64) returns jsonb language sql stable as $$
 select public.norva_get_owned_movie_recovery_title_ids(pg_temp.id(1),pg_temp.id(anchor),7,lim)->'titleIds'
$$;
insert into public.cloud_titles values
 (pg_temp.id(10),pg_temp.id(1),'movie','123','anchor'),
 (pg_temp.id(11),pg_temp.id(1),'movie','123','alternate'),
 (pg_temp.id(12),pg_temp.id(2),'movie','123','other-owner'),
 (pg_temp.id(13),pg_temp.id(1),'series','123','series'),
 (pg_temp.id(14),pg_temp.id(1),'movie','999','different'),
 (pg_temp.id(15),pg_temp.id(1),'movie','123','hidden');
insert into public.fixture_hydration values
 (pg_temp.id(1),pg_temp.id(10),pg_temp.row(10),true),
 (pg_temp.id(1),pg_temp.id(11),pg_temp.row(11),true),
 (pg_temp.id(2),pg_temp.id(12),pg_temp.row(12,2),true),
 (pg_temp.id(1),pg_temp.id(13),pg_temp.row(13)||'{"item_type":"series"}',true),
 (pg_temp.id(1),pg_temp.id(14),pg_temp.row(14,1,'999'),true),
 (pg_temp.id(1),pg_temp.id(15),pg_temp.row(15),false);
select pg_temp.assert(pg_temp.read_ids()=jsonb_build_array(pg_temp.id(10),pg_temp.id(11)),'owned visible validated movie only; anchor first');
select pg_temp.assert(public.norva_get_owned_movie_recovery_title_ids(pg_temp.id(1),pg_temp.id(10),7)->>'contract'='owned-movie-recovery-v1','contract version');
select pg_temp.reject('select public.norva_get_owned_movie_recovery_title_ids(pg_temp.id(1),pg_temp.id(10),6)','PT409','stale epoch');
select pg_temp.reject('select public.norva_get_owned_movie_recovery_title_ids(pg_temp.id(2),pg_temp.id(10),7)','PT409','foreign anchor');
select pg_temp.reject('select pg_temp.read_ids(15)','PT409','invisible anchor');
select pg_temp.reject('select pg_temp.read_ids(13)','PT409','series anchor');
select pg_temp.reject('select pg_temp.read_ids(10,0)','22023','zero bound');
select pg_temp.reject('select pg_temp.read_ids(10,65)','22023','oversized bound');
select pg_temp.reject('select public.norva_get_owned_movie_recovery_title_ids(null,pg_temp.id(10),7)','22023','missing owner');
select pg_temp.reject('select pg_temp.read_ids(10,1)','54000','overflow is explicit, never silently no alternatives');
update public.fixture_hydration set payload=jsonb_set(payload,'{metadata,tmdbValidation,valid}','false') where id=pg_temp.id(10);
select pg_temp.assert(pg_temp.read_ids()=jsonb_build_array(pg_temp.id(10)),'unvalidated anchor remains exact file only');
update public.fixture_hydration set payload=pg_temp.row(10) where id=pg_temp.id(10);
update public.fixture_hydration set payload=jsonb_set(payload,'{metadata,tmdb,id}','"999"') where id=pg_temp.id(11);
select pg_temp.assert(pg_temp.read_ids()=jsonb_build_array(pg_temp.id(10)),'conflicting evidence ID rejected');
update public.fixture_hydration set payload=pg_temp.row(11)||'{"match_status":"pending"}' where id=pg_temp.id(11);
select pg_temp.assert(pg_temp.read_ids()=jsonb_build_array(pg_temp.id(10)),'pending association rejected');
update public.fixture_hydration set payload=pg_temp.row(11)||jsonb_build_object('overlay_generation_id',pg_temp.id(30),'display_generation_id',pg_temp.id(31),'overlay_catalog_metadata',pg_temp.row(11)->'metadata') where id=pg_temp.id(11);
select pg_temp.assert(pg_temp.read_ids()=jsonb_build_array(pg_temp.id(10)),'mismatched projection generation rejected');
update public.fixture_hydration set payload=pg_temp.row(11)||jsonb_build_object('metadata','{}'::jsonb,'overlay_generation_id',pg_temp.id(30),'display_generation_id',pg_temp.id(30),'overlay_catalog_metadata',pg_temp.row(11)->'metadata') where id=pg_temp.id(11);
select pg_temp.assert(jsonb_array_length(pg_temp.read_ids())=2,'current projection trust survives thin metadata');
update public.fixture_hydration set payload=jsonb_set(payload,'{overlay_catalog_metadata}','{}') where id=pg_temp.id(11);
select pg_temp.assert(jsonb_array_length(pg_temp.read_ids())=1,'current projection missing evidence cannot inherit shell validation');
update public.fixture_hydration set payload=pg_temp.row(11)||jsonb_build_object('metadata','{}'::jsonb,'overlay_generation_id',pg_temp.id(30),'display_generation_id',pg_temp.id(30),'overlay_catalog_metadata',pg_temp.row(11)->'metadata') where id=pg_temp.id(11);
update public.fixture_hydration set payload=jsonb_set(payload,'{overlay_catalog_metadata,tmdbValidation,valid}','"true"') where id=pg_temp.id(11);
select pg_temp.assert(jsonb_array_length(pg_temp.read_ids())=1,'string true is not verified evidence');
update public.fixture_hydration set payload=pg_temp.row(11) where id=pg_temp.id(11);
insert into public.cloud_catalog_visible_sources values(pg_temp.id(1),pg_temp.id(20));
insert into public.cloud_source_catalog_heads values(pg_temp.id(1),pg_temp.id(20),pg_temp.id(30));
insert into public.cloud_source_catalog_generation_candidate_titles values
 (pg_temp.id(16),pg_temp.id(1),pg_temp.id(20),pg_temp.id(30),'movie','123'),
 (pg_temp.id(17),pg_temp.id(1),pg_temp.id(20),pg_temp.id(31),'movie','123'),
 (pg_temp.id(18),pg_temp.id(1),pg_temp.id(21),pg_temp.id(30),'movie','123');
insert into public.fixture_hydration select pg_temp.id(1),pg_temp.id(n),pg_temp.row(n),true from generate_series(16,18) n;
select pg_temp.assert(pg_temp.read_ids()=jsonb_build_array(pg_temp.id(10),pg_temp.id(11),pg_temp.id(16)),'only active visible source projection enters candidates');
insert into public.cloud_source_catalog_generation_candidate_titles select pg_temp.id(16),pg_temp.id(1),pg_temp.id(20),pg_temp.id(30),'movie','123' from generate_series(1,80);
select pg_temp.assert(jsonb_array_length(pg_temp.read_ids())=3,'duplicate projections do not consume bounded slots');
insert into public.selection_shared_visible_enrollments values(pg_temp.id(1),pg_temp.id(22),pg_temp.id(40));
insert into public.selection_shared_titles values(pg_temp.id(40),'movie','123','shared-movie');
insert into public.fixture_hydration select pg_temp.id(1),public.norva_selection_shared_uuid('title:'||pg_temp.id(1)||':movie:shared-movie'),
 pg_temp.row(19)||jsonb_build_object('id',public.norva_selection_shared_uuid('title:'||pg_temp.id(1)||':movie:shared-movie')),true;
select pg_temp.assert(jsonb_array_length(pg_temp.read_ids())=4,'visible Selection virtual title accepted through hydration');
update public.fixture_hydration set payload=payload||jsonb_build_object('display_generation_id',pg_temp.id(30),'overlay_generation_id',null) where id=public.norva_selection_shared_uuid('title:'||pg_temp.id(1)||':movie:shared-movie');
select pg_temp.assert(jsonb_array_length(pg_temp.read_ids())=4,'Selection display generation without physical overlay uses its validated published metadata');
delete from public.selection_shared_visible_enrollments;
select pg_temp.assert(jsonb_array_length(pg_temp.read_ids())=3,'unenrolled Selection title excluded');
insert into public.fixture_control values('epoch','8');
select pg_temp.reject('select pg_temp.read_ids()','PT409','hydration epoch mismatch');
delete from public.fixture_control;
insert into public.fixture_control values('contract','wrong');
select pg_temp.reject('select pg_temp.read_ids()','PT409','hydration protocol mismatch');
delete from public.fixture_control;
update public.fixture_hydration set payload=jsonb_set(payload,'{user_id}',to_jsonb(pg_temp.id(2))) where id=pg_temp.id(11);
select pg_temp.reject('select pg_temp.read_ids()','PT409','malformed cross-owner hydration fails closed');
update public.fixture_hydration set payload=pg_temp.row(11) where id=pg_temp.id(11);
select pg_temp.assert(not has_function_privilege('anon','public.norva_get_owned_movie_recovery_title_ids(uuid,uuid,bigint,integer)','execute'),'anonymous cannot execute');
select pg_temp.assert(not has_function_privilege('authenticated','public.norva_get_owned_movie_recovery_title_ids(uuid,uuid,bigint,integer)','execute'),'authenticated cannot choose another owner');
select pg_temp.assert(has_function_privilege('service_role','public.norva_get_owned_movie_recovery_title_ids(uuid,uuid,bigint,integer)','execute'),'service role can execute');
select pg_temp.assert((select provolatile='s' and prosecdef from pg_proc where oid='public.norva_get_owned_movie_recovery_title_ids(uuid,uuid,bigint,integer)'::regprocedure),'stable security-definer reader');
insert into public.cloud_titles select pg_temp.id(100+n),pg_temp.id(1),'movie','123','overflow-'||n from generate_series(1,65) n;
select pg_temp.reject('select pg_temp.read_ids()','54000','distinct candidate overflow remains explicit despite projection duplicates');
select jsonb_build_object('passed',count(*),'fixture','bounded RPC contract; canonical hydrator modeled','customerRows',0,'providerRequests',0) from qa_results;
rollback;
