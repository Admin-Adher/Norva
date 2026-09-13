-- Synthetic data only. Definitions are copied from the live read-only schema
-- into an isolated network-less PostgreSQL instance by the proof runner.
create role anon;
create role authenticated;
create role service_role;
create table public.cloud_title_variants (
 id uuid primary key,user_id uuid,title_id uuid,source_id uuid,item_type text,external_id text,
 generation_id uuid,visible boolean default true
);
create view public.cloud_catalog_visible_title_variants as select * from public.cloud_title_variants where visible;
create table public.cloud_titles (
 id uuid primary key,user_id uuid,item_type text,title text,release_year int,poster_url text,
 genre_buckets text[] default '{drame}',rating_num numeric default 8,created_at timestamptz default now()
);
create table public.cloud_source_catalog_generation_candidate_titles (
 user_id uuid,title_id uuid,generation_id uuid,title text,release_year int,poster_url text,
 genre_buckets text[],rating_num numeric,catalog_created_at timestamptz
);
create table public.cloud_title_file_language_observations (
 user_id uuid,title_id uuid,variant_id uuid,file_external_id text,
 audio_observed boolean default false,audio_languages text[] default '{}',
 subtitle_observed boolean default false,subtitle_languages text[] default '{}'
);
create table public.cloud_catalog_provider_language_hints (
 variant_id uuid,user_id uuid,title_id uuid,source_id uuid,item_type text,language text
);
grant select on all tables in schema public to service_role;
create function public.fixture_uuid(n int) returns uuid language sql immutable as $$select ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
-- DEFINITIONS
-- MIGRATION
insert into public.cloud_titles(id,user_id,item_type,title,release_year)
select fixture_uuid(n),fixture_uuid(case when n=10 then 102 else 101 end),
 case when n in (8,9) then 'series' else 'movie' end,'Fixture '||n,2024 from generate_series(1,12) n;
insert into public.cloud_title_variants(id,user_id,title_id,source_id,item_type,external_id,visible)
select fixture_uuid(200+n),fixture_uuid(case when n=10 then 102 else 101 end),fixture_uuid(n),
 fixture_uuid(case when n=10 then 113 else 111 end),case when n=8 then 'series' else 'movie' end,
 'file-'||n,n<>7 from generate_series(1,12) n;
-- A known second-source sibling must not conceal the unknown copy of title 1.
insert into public.cloud_title_variants values(fixture_uuid(220),fixture_uuid(101),fixture_uuid(1),fixture_uuid(112),'movie','file-20',null,true);
insert into public.cloud_catalog_provider_language_hints
select id,user_id,title_id,source_id,item_type,'en' from public.cloud_title_variants where id in (fixture_uuid(203),fixture_uuid(220));
-- Accepted rare language, unknown+subtitle, stale file observation, invalid raw
-- language, and known sibling's subtitle that must not match unknown+subtitles.
insert into public.cloud_title_file_language_observations(user_id,title_id,variant_id,file_external_id,audio_observed,audio_languages,subtitle_observed,subtitle_languages)
select user_id,title_id,id,case when id=fixture_uuid(206) then 'stale-file' else external_id end,
 id in (fixture_uuid(204),fixture_uuid(206),fixture_uuid(211)),
 case when id=fixture_uuid(204) then '{hz}' when id=fixture_uuid(206) then '{fr}' when id=fixture_uuid(211) then '{und}' else '{}' end::text[],
 true,case when id in (fixture_uuid(205),fixture_uuid(220)) then '{fr}' else '{en}' end::text[]
from public.cloud_title_variants where id in (fixture_uuid(204),fixture_uuid(205),fixture_uuid(206),fixture_uuid(211),fixture_uuid(220));
create table fixture_checks(name text primary key);
create function public.fixture_assert(name text,ok boolean) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'FAILED: %',name; end if;
 insert into fixture_checks values(name);
end$$;
select fixture_assert('movie any unknown version',cloud_catalog_unidentified_audio_count(fixture_uuid(101),'movie',null)=6);
select fixture_assert('series isolation',cloud_catalog_unidentified_audio_count(fixture_uuid(101),'series',null)=1);
select fixture_assert('source without unknown',cloud_catalog_unidentified_audio_count(fixture_uuid(101),'movie',fixture_uuid(112))=0);
select fixture_assert('foreign source closed',cloud_catalog_unidentified_audio_count(fixture_uuid(101),'movie',fixture_uuid(113))=0);
select fixture_assert('other account isolated',cloud_catalog_unidentified_audio_count(fixture_uuid(102),'movie',null)=1);
select fixture_assert('absent account empty',cloud_catalog_unidentified_audio_count(fixture_uuid(999),'movie',null)=0);
select fixture_assert('invalid type empty',cloud_catalog_unidentified_audio_count(fixture_uuid(101),'live',null)=0);
select fixture_assert('unidentified title count deduplicated',(select count(*) from cloud_catalog_visible_title_ids_by_source_languages(fixture_uuid(101),'movie',null,'unidentified'))=6);
select fixture_assert('same file subtitles only',(select array_agg(title_id) from cloud_catalog_visible_title_ids_by_source_languages(fixture_uuid(101),'movie',null,'unidentified','fr'))=array[fixture_uuid(5)]);
select fixture_assert('ordinary catalog language unchanged',(select count(*) from cloud_catalog_visible_title_ids_by_source_languages(fixture_uuid(101),'movie',null,'catalog-en'))=2);
select fixture_assert('ordinary source filtering unchanged',(select count(*) from cloud_catalog_visible_title_ids_by_source_languages(fixture_uuid(101),'movie',fixture_uuid(112),'catalog-en'))=1);
select fixture_assert('strict observed language unchanged',(select count(*) from cloud_catalog_visible_title_ids_by_source_languages(fixture_uuid(101),'movie',null,'hz'))=1);
select fixture_assert('paged count',(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","limit":2,"sort":"name"}')->>'count')::int=6);
select fixture_assert('bounded first page',jsonb_array_length(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","limit":2,"sort":"name"}')->'titleIds')=2);
select fixture_assert('page two distinct',(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","limit":2,"offset":2,"sort":"name"}')->'titleIds')<>(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","limit":2,"sort":"name"}')->'titleIds'));
select fixture_assert('search composes',(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","search":"Fixture 5"}')->>'count')::int=1);
select fixture_assert('hidden genre fence',(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","hiddenBuckets":["drame"]}')->>'count')::int=0);
select fixture_assert('year fence',(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","yearMax":2020}')->>'count')::int=0);
select fixture_assert('rating fence',(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","minRating":9}')->>'count')::int=0);
select fixture_assert('preference sorting composes',(cloud_catalog_visible_title_language_page(fixture_uuid(101),'movie',null,'{"audio":"unidentified","sort":"lang-match","prefAudio":"en"}')->>'count')::int=6);
select fixture_assert('service only stable invoker',not exists(
 select 1 from pg_proc p where proname in ('cloud_catalog_unidentified_audio_variants','cloud_catalog_unidentified_audio_count','cloud_catalog_visible_title_ids_by_source_languages')
 and (prosecdef or provolatile<>'s' or has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or not has_function_privilege('service_role',p.oid,'execute'))));
-- Real service-role call, not just owner execution.
set role service_role;
select public.cloud_catalog_unidentified_audio_count(public.fixture_uuid(101),'movie',null);
reset role;
select jsonb_build_object('passed',true,'checks',(select jsonb_agg(name order by name) from fixture_checks),
 'definitions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid))) from pg_proc p
 join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('cloud_catalog_unidentified_audio_variants','cloud_catalog_unidentified_audio_count','cloud_catalog_visible_title_ids_by_source_languages')));
