\set ON_ERROR_STOP on

-- Run only in a disposable, empty database. Fixtures and function changes roll
-- back; no customer catalogue or viewing history is written by this test.
begin;
do $$ begin
  if current_database() not like 'norva_home_popularity_qa_%' then
    raise exception 'A disposable norva_home_popularity_qa_ database is required';
  end if;
end $$;

create function public.qa_uuid(value int) returns uuid language sql immutable
as $$ select lpad(to_hex(value),32,'0')::uuid $$;
create table public.cloud_sources (id uuid primary key,user_id uuid,visible boolean);
create table public.cloud_source_catalog_heads (source_id uuid,user_id uuid,active_generation_id uuid,primary key(source_id,user_id));
create table public.cloud_titles (id uuid primary key,user_id uuid,provider_tmdb_id text);
create table public.cloud_title_variants (id uuid primary key,user_id uuid,title_id uuid,source_id uuid,generation_id uuid,item_type text,external_id text);
create table public.cloud_watch_history (user_id uuid,source_id uuid,item_type text,item_id text,parent_item_id text);
create index cloud_title_variants_generation_natural_uidx on public.cloud_title_variants(source_id,generation_id,item_type,external_id);
create view public.cloud_catalog_visible_title_variants as
  select v.* from public.cloud_title_variants v
  join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id and s.visible
  left join public.cloud_source_catalog_heads h on h.source_id=v.source_id and h.user_id=v.user_id
  where v.generation_id is null or v.generation_id=h.active_generation_id;

insert into public.cloud_sources
select qa_uuid(s),qa_uuid(u),visible from (values
  (11,1,true),(12,1,true),(13,1,false),(14,1,false),(15,1,false),
  (21,2,true),(31,3,true)
) f(s,u,visible);
insert into public.cloud_source_catalog_heads
select qa_uuid(s),qa_uuid(u),qa_uuid(g) from (values
  (11,1,101),(13,1,131),(14,1,141),(15,1,151),(21,2,201),(31,3,301)
) f(s,u,g);
insert into public.cloud_titles
select qa_uuid(t),qa_uuid(u),tmdb from (values
  (1001,1,'A'),(1002,1,'B'),(1003,1,'STAGING'),(1004,1,'LEGACY'),
  (1005,1,'HIDDEN'),(1006,1,'DELETED'),(1007,1,'DISABLED'),
  (1008,1,'SERIES'),(1009,1,null),(1010,1,''),(1011,1,'0'),(1012,1,'tt000'),
  (2001,2,'A'),(2002,2,'B'),(3001,3,'FOREIGN')
) f(t,u,tmdb);
insert into public.cloud_title_variants
select qa_uuid(v),qa_uuid(u),qa_uuid(t),qa_uuid(s),case when g is null then null else qa_uuid(g) end,kind,external
from (values
  (1,1,1001,11,101,'movie','a'),(2,1,1001,11,101,'movie','a-alt'),
  (3,1,1002,11,101,'movie','b'),(4,1,1003,11,102,'movie','staging'),
  (5,1,1004,12,null,'movie','legacy'),(6,1,1005,13,131,'movie','hidden'),
  (7,1,1006,14,141,'movie','deleted'),(8,1,1007,15,151,'movie','disabled'),
  (9,1,1008,11,101,'series','show'),(10,1,1009,11,101,'movie','null'),
  (11,1,1010,11,101,'movie','empty'),(12,1,1011,11,101,'movie','zero'),
  (13,1,1012,11,101,'movie','ttzero'),
  (14,2,2001,21,201,'movie','a'),(15,2,2002,21,201,'movie','b'),
  (16,3,3001,31,301,'movie','foreign')
) f(v,u,t,s,g,kind,external);
insert into public.cloud_watch_history
select qa_uuid(u),qa_uuid(s),kind,item,parent from (values
  (1,11,'movie','a',null),(1,11,'movie','a-alt',null),
  (1,11,'movie','a','a'),(1,11,'movie','b',null),
  (1,11,'movie','staging',null),(1,12,'movie','legacy',null),
  (1,13,'movie','hidden',null),(1,14,'movie','deleted',null),
  (1,15,'movie','disabled',null),(1,11,'episode','episode-1','show'),
  (1,11,'episode','episode-2','show'),
  (1,11,'movie','null',null),(1,11,'movie','empty',null),
  (1,11,'movie','zero',null),(1,11,'movie','ttzero',null),
  (2,21,'movie','a',null),(2,21,'movie','b',null)
) f(u,s,kind,item,parent);

-- Original ranking serves as an independent reference for legitimate history.
create function public.qa_reference(kind text) returns table(provider_tmdb_id text,views bigint)
language sql as $$
  select t.provider_tmdb_id,count(distinct h.user_id)::bigint
  from public.cloud_watch_history h
  join public.cloud_catalog_visible_title_variants v
    on v.source_id=h.source_id and v.item_type=kind
   and v.external_id in (h.item_id,h.parent_item_id)
  join public.cloud_titles t on t.id=v.title_id
  where t.provider_tmdb_id is not null and t.provider_tmdb_id<>''
    and t.provider_tmdb_id!~'^(tt)?0+$'
  group by t.provider_tmdb_id
  order by count(distinct h.user_id) desc,t.provider_tmdb_id
$$;

\ir ../../supabase/migrations/20260909124314_home_popularity_generation_index.sql
-- Reapplying a release must preserve behavior and service-only ACLs.
\ir ../../supabase/migrations/20260909124314_home_popularity_generation_index.sql

do $$ declare result jsonb; begin
  select jsonb_agg(to_jsonb(t)) into result from public.top_viewed_titles('movie',200) t;
  if result <> '[{"provider_tmdb_id":"A","views":2},{"provider_tmdb_id":"B","views":2},{"provider_tmdb_id":"LEGACY","views":1}]'::jsonb then
    raise exception 'Distinct viewers, deterministic ties or visibility filtering regressed';
  end if;
  if exists ((select * from public.qa_reference('movie') except all select * from public.top_viewed_titles('movie',200))
    union all (select * from public.top_viewed_titles('movie',200) except all select * from public.qa_reference('movie'))) then
    raise exception 'Movie ranking differs from the original query';
  end if;
  if exists ((select * from public.qa_reference('series') except all select * from public.top_viewed_titles('series',200))
    union all (select * from public.top_viewed_titles('series',200) except all select * from public.qa_reference('series'))) then
    raise exception 'Series ranking differs from the original query';
  end if;
  if (select views from public.top_viewed_titles('series',200) where provider_tmdb_id='SERIES') <> 1 then
    raise exception 'Episodes must resolve their series parent and count one viewer';
  end if;
  if (select count(*) from public.top_viewed_titles('movie',0)) <> 1
    or (select count(*) from public.top_viewed_titles('movie',-10)) <> 1
    or (select count(*) from public.top_viewed_titles('movie',2)) <> 2 then
    raise exception 'Lower/result limit bounds regressed';
  end if;
  if exists(select * from public.top_viewed_titles('unknown',200)) then
    raise exception 'Unknown item types must not return another type';
  end if;
  if has_function_privilege('anon','public.top_viewed_titles(text,integer)','EXECUTE')
    or has_function_privilege('authenticated','public.top_viewed_titles(text,integer)','EXECUTE')
    or not has_function_privilege('service_role','public.top_viewed_titles(text,integer)','EXECUTE') then
    raise exception 'Popularity must remain service-role only';
  end if;
end $$;

-- A forged owner/source pair cannot contribute another user's catalogue title.
insert into public.cloud_watch_history values(qa_uuid(1),qa_uuid(31),'movie','foreign',null);
do $$ begin
  if exists(select * from public.top_viewed_titles('movie',200) where provider_tmdb_id='FOREIGN') then
    raise exception 'Foreign source history crossed the ownership fence';
  end if;
end $$;

-- A source's old active generation stops contributing in the same transaction.
update public.cloud_source_catalog_heads set active_generation_id=qa_uuid(102) where source_id=qa_uuid(11);
do $$ begin
  if (select views from public.top_viewed_titles('movie',200) where provider_tmdb_id='A') <> 1
    or not exists(select * from public.top_viewed_titles('movie',200) where provider_tmdb_id='STAGING') then
    raise exception 'Active generation changes were not reflected immediately';
  end if;
end $$;

-- Exercise the upper result cap with more than 200 distinct valid titles.
insert into public.cloud_titles select qa_uuid(10000+i),qa_uuid(2),'extra-'||i from generate_series(1,205) i;
insert into public.cloud_title_variants select qa_uuid(10000+i),qa_uuid(2),qa_uuid(10000+i),qa_uuid(21),qa_uuid(201),'movie','extra-'||i from generate_series(1,205) i;
insert into public.cloud_watch_history select qa_uuid(2),qa_uuid(21),'movie','extra-'||i,null from generate_series(1,205) i;
do $$ begin
  if (select count(*) from public.top_viewed_titles('movie',1000)) <> 200 then
    raise exception 'Upper result cap regressed';
  end if;
end $$;

set local role service_role;
select count(*)=1 as service_execution_ok from public.top_viewed_titles('movie',1);
reset role;
select 'HOME_POPULARITY_INTEGRATION_OK' as result;
rollback;
