-- Run in a transaction on a disposable/restorable catalogue with a validated
-- duplicate movie. The rehearsal runner supplies norva.test_catalog_user_id.
create function pg_temp.assert_true(value boolean,message text) returns void
language plpgsql as $$begin if value is distinct from true then raise exception '%',message; end if; end$$;
select pg_temp.assert_true(not has_function_privilege('anon','public.norva_merge_validated_tmdb_group(uuid,text,text)','EXECUTE'),'anonymous merge access');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.norva_canonicalize_titles_for_user(uuid,integer)','EXECUTE'),'user merge access');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.norva_catalog_tmdb_merge_audit','SELECT'),'audit privacy');

create temporary table merge_test_context as
select current_setting('norva.test_catalog_user_id')::uuid user_id,'movie'::text item_type,'527774'::text tmdb_id;
create temporary table merge_test_titles as
select t.* from public.cloud_titles t join merge_test_context c
on t.user_id=c.user_id and t.item_type=c.item_type and t.provider_tmdb_id=c.tmdb_id;
create temporary table merge_test_variants as
select v.id,v.title_id,to_jsonb(v) payload,
  exists(select 1 from public.cloud_catalog_visible_title_variants x where x.id=v.id) visible
from public.cloud_title_variants v where v.title_id in (select id from merge_test_titles);
create temporary table merge_test_observations as
select o.variant_id,o.file_external_id,to_jsonb(o) payload
from public.cloud_title_file_language_observations o where o.variant_id in (select id from merge_test_variants);
select pg_temp.assert_true((select count(distinct title_id)>1 from merge_test_variants where visible),'fixture must have separate visible cards');

-- A legacy scoped writer can skip rows; detect it and roll back the entire
-- group instead of claiming a successful merge or losing unprocessed files.
select set_config('norva.legacy_catalog_writer_fenced','on',true);
select set_config('norva.catalog_merge_debug','off',true);
create temporary table merge_test_rejected as
select public.norva_merge_validated_tmdb_group(user_id,item_type,tmdb_id) result from merge_test_context;
select pg_temp.assert_true((select result->>'state'='retry' and result->>'sqlstate'='PT409' from merge_test_rejected),'stale writer must be reported');
select pg_temp.assert_true(not exists(select 1 from merge_test_variants b full join public.cloud_title_variants v on v.id=b.id
  where b.id is not null and to_jsonb(v) is distinct from b.payload),'rejected group must preserve every version');
select set_config('norva.legacy_catalog_writer_fenced','off',true);
select set_config('norva.catalog_merge_debug','on',true);

create temporary table merge_test_result as
select public.norva_merge_validated_tmdb_group(user_id,item_type,tmdb_id) result from merge_test_context;
set constraints all immediate;
select pg_temp.assert_true((select result->>'state'='merged' from merge_test_result),'validated group must merge');
select pg_temp.assert_true((select count(distinct v.title_id)=1 from public.cloud_catalog_visible_title_variants v
  join merge_test_variants b on b.id=v.id where b.visible),'one visible card');
select pg_temp.assert_true((select count(*) from public.cloud_title_variants where id in(select id from merge_test_variants))=(select count(*) from merge_test_variants),'all versions retained');
select pg_temp.assert_true(not exists(select 1 from merge_test_variants b join public.cloud_title_variants v on v.id=b.id
  where not b.visible and to_jsonb(v) is distinct from b.payload),'hidden generation bytes unchanged');
select pg_temp.assert_true(not exists(select 1 from merge_test_variants b join public.cloud_title_variants v on v.id=b.id
  where (to_jsonb(v)-array['title_id','updated_at']) is distinct from (b.payload-array['title_id','updated_at'])),'file identity and language payloads unchanged');
select pg_temp.assert_true((select count(*) from public.cloud_title_file_language_observations where variant_id in(select id from merge_test_variants))=(select count(*) from merge_test_observations),'observations retained');
select pg_temp.assert_true(not exists(select 1 from merge_test_observations b left join public.cloud_title_file_language_observations o
  on o.variant_id=b.variant_id and o.file_external_id=b.file_external_id
  where (to_jsonb(o)-array['title_id','updated_at']) is distinct from (b.payload-array['title_id','updated_at'])),'exact audio and subtitle evidence unchanged');
select pg_temp.assert_true(not exists(select 1 from public.cloud_title_file_language_observations o
  join public.cloud_title_variants v on v.id=o.variant_id where v.id in(select id from merge_test_variants)
  and o.title_id<>v.title_id),'observations follow their exact variant');
select pg_temp.assert_true((select count(*) from public.cloud_titles where id in(select id from merge_test_titles))=(select count(*) from merge_test_titles),'historical title parents retained');
select pg_temp.assert_true((select public.norva_merge_validated_tmdb_group(user_id,item_type,tmdb_id)->>'state'='noop' from merge_test_context),'second call idempotent');
select jsonb_build_object('test','validated-movie-merge','result',(select result from merge_test_result),
  'retainedVariants',(select count(*) from merge_test_variants),'hiddenUnchanged',(select count(*) from merge_test_variants where not visible),
  'retainedObservations',(select count(*) from merge_test_observations),'status','passed');

-- Real series fixture: keep every episode and its exact parent variant.
create temporary table series_test_context as
select t.user_id,'series'::text item_type,t.provider_tmdb_id tmdb_id,array_agg(t.id) title_ids
from public.cloud_titles t
where t.item_type='series' and t.provider_tmdb_id='245927'
  and exists(select 1 from public.cloud_catalog_visible_title_variants v where v.title_id=t.id and v.user_id=t.user_id)
group by t.user_id,t.provider_tmdb_id having count(*)>1
  and bool_and(t.match_status='provider_verified' and t.metadata#>>'{tmdbValidation,valid}'='true')
limit 1;
select pg_temp.assert_true((select count(*)=1 from series_test_context),'series duplicate fixture');
create temporary table series_test_variants as
select v.id,v.title_id,to_jsonb(v) payload from public.cloud_title_variants v
where exists(select 1 from series_test_context c where v.title_id=any(c.title_ids));
create temporary table series_test_episodes as
select e.source_id,e.generation_id,e.parent_series_id,e.episode_id,to_jsonb(e) payload
from public.catalog_series_episode_memberships e where e.parent_variant_id in(select id from series_test_variants);
create temporary table series_test_inventory as
select i.source_id,i.generation_id,i.parent_series_id,to_jsonb(i) payload
from public.catalog_series_inventory_state i where i.parent_variant_id in(select id from series_test_variants);
create temporary table series_test_result as
select public.norva_merge_validated_tmdb_group(user_id,item_type,tmdb_id) result from series_test_context;
set constraints all immediate;
select pg_temp.assert_true((select result->>'state'='merged' from series_test_result),'series group must merge');
select pg_temp.assert_true((select count(*) from public.cloud_title_variants where id in(select id from series_test_variants))=(select count(*) from series_test_variants),'series variants retained');
select pg_temp.assert_true((select count(*) from public.catalog_series_episode_memberships where parent_variant_id in(select id from series_test_variants))=(select count(*) from series_test_episodes),'episode count retained');
select pg_temp.assert_true(not exists(select 1 from series_test_episodes b left join public.catalog_series_episode_memberships e
  using(source_id,generation_id,parent_series_id,episode_id)
  where (to_jsonb(e)-array['parent_title_id','updated_at']) is distinct from (b.payload-array['parent_title_id','updated_at'])),'episode file identities unchanged');
select pg_temp.assert_true(not exists(select 1 from series_test_inventory b left join public.catalog_series_inventory_state i
  using(source_id,generation_id,parent_series_id)
  where (to_jsonb(i)-array['parent_title_id','updated_at']) is distinct from (b.payload-array['parent_title_id','updated_at'])),'inventory state retained');
select pg_temp.assert_true(not exists(select 1 from public.catalog_series_episode_memberships e
  join public.cloud_catalog_visible_title_variants v on v.id=e.parent_variant_id and v.generation_id=e.generation_id
  where v.id in(select id from series_test_variants) and e.parent_title_id<>v.title_id),'series membership points at visible canonical title');
select jsonb_build_object('test','validated-series-merge','result',(select result from series_test_result),
  'episodesRetained',(select count(*) from series_test_episodes),'versionsRetained',(select count(*) from series_test_variants),'status','passed');

-- Contradictory years and incomplete validation must never be bulk merged.
create temporary table review_test_context as
select t.user_id,t.item_type,t.provider_tmdb_id tmdb_id,array_agg(t.id) title_ids
from public.cloud_titles t
where t.item_type='movie' and t.provider_tmdb_id='451499'
  and exists(select 1 from public.cloud_catalog_visible_title_variants v where v.title_id=t.id and v.user_id=t.user_id)
group by t.user_id,t.item_type,t.provider_tmdb_id having count(distinct t.release_year)>1 limit 1;
select pg_temp.assert_true((select count(*)=1 from review_test_context),'review fixture');
create temporary table review_test_before as select v.id,to_jsonb(v) payload from public.cloud_title_variants v
where exists(select 1 from review_test_context c where v.title_id=any(c.title_ids));
create temporary table review_test_result as
select public.norva_merge_validated_tmdb_group(user_id,item_type,tmdb_id) result from review_test_context;
select pg_temp.assert_true((select result->>'state'='review' from review_test_result),'ambiguous group requires review');
select pg_temp.assert_true(not exists(select 1 from review_test_before b left join public.cloud_title_variants v on v.id=b.id
  where to_jsonb(v) is distinct from b.payload),'ambiguous files unchanged');
select jsonb_build_object('test','ambiguous-group-exclusion','result',(select result from review_test_result),'status','passed');

select public.norva_canonicalize_titles_for_user(null,25);
set constraints all immediate;
select pg_temp.assert_true(not exists(select 1 from public.norva_catalog_tmdb_merge_audit where state='retry'),'bounded maintenance batch succeeds');
select jsonb_build_object('test','bounded-maintenance-batch','groups',(select count(*) from public.norva_catalog_tmdb_merge_audit where state='merged'),
  'variantsMoved',(select sum(variants_moved) from public.norva_catalog_tmdb_merge_audit where state='merged'),'status','passed');
