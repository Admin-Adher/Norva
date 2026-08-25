\set ON_ERROR_STOP on

begin;

create temporary table owner_row_count_test_context (
  snapshot_id uuid primary key default gen_random_uuid(),
  building_snapshot_id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null
) on commit drop;

insert into owner_row_count_test_context (user_id,source_id,generation_id)
select generation.user_id,generation.source_id,generation.id
from public.cloud_source_catalog_generations generation
join public.cloud_title_variants variant
  on variant.user_id = generation.user_id
 and variant.source_id = generation.source_id
 and variant.generation_id = generation.id
where generation.state = 'active'
group by generation.user_id,generation.source_id,generation.id
having count(distinct variant.title_id) >= 2
order by generation.user_id,generation.source_id,generation.id
limit 1;

do $assert$
begin
  if (select count(*) from owner_row_count_test_context) <> 1 then
    raise exception 'row-count integration fixture requires one active generation with two titles';
  end if;
end
$assert$;

insert into public.cloud_catalog_background_owner_snapshots (
  id,user_id,snapshot_kind,state,build_visibility_epoch,
  applied_visibility_epoch,row_count,completed_at,activated_at
)
select snapshot_id,user_id,'baseline','active',1,1,0,now(),now()
from owner_row_count_test_context;

insert into public.cloud_catalog_background_owner_snapshot_sources (
  snapshot_id,user_id,source_id,generation_id
)
select snapshot_id,user_id,source_id,generation_id
from owner_row_count_test_context;

insert into public.cloud_catalog_background_owner_snapshot_rows (
  snapshot_id,user_id,title_id,is_present,
  owner_source_id,owner_generation_id,storage_kind,
  item_type,provider_tmdb_id,match_status,title,original_title,
  release_year,poster_url,backdrop_url,catalog_metadata,
  payload_updated_at,year_backfill_attempted_at,
  revalidate_attempted_at,search_match_attempted_at
)
select context.snapshot_id,context.user_id,title.id,true,
  context.source_id,context.generation_id,'global',
  title.item_type,title.provider_tmdb_id,title.match_status,title.title,
  title.original_title,title.release_year,title.poster_url,title.backdrop_url,
  title.metadata,title.updated_at,title.year_backfill_attempted_at,
  title.revalidate_attempted_at,title.search_match_attempted_at
from owner_row_count_test_context context
join public.cloud_title_variants variant
  on variant.user_id = context.user_id
 and variant.source_id = context.source_id
 and variant.generation_id = context.generation_id
join public.cloud_titles title
  on title.id = variant.title_id and title.user_id = variant.user_id
order by title.id
limit 2;

do $assert$
declare
  v_count bigint;
begin
  select snapshot.row_count into v_count
  from public.cloud_catalog_background_owner_snapshots snapshot
  join owner_row_count_test_context context on context.snapshot_id = snapshot.id;
  if v_count <> 2 then
    raise exception 'statement insert delta mismatch: expected 2, got %',v_count;
  end if;
end
$assert$;

update public.cloud_catalog_background_owner_snapshot_rows owner_row
set is_present = false
where owner_row.snapshot_id = (
  select snapshot_id from owner_row_count_test_context
);

do $assert$
declare
  v_count bigint;
begin
  select snapshot.row_count into v_count
  from public.cloud_catalog_background_owner_snapshots snapshot
  join owner_row_count_test_context context on context.snapshot_id = snapshot.id;
  if v_count <> 0 then
    raise exception 'statement update decrement mismatch: expected 0, got %',v_count;
  end if;
end
$assert$;

update public.cloud_catalog_background_owner_snapshot_rows owner_row
set is_present = true
where (owner_row.snapshot_id,owner_row.title_id) = (
  select candidate.snapshot_id,candidate.title_id
  from public.cloud_catalog_background_owner_snapshot_rows candidate
  join owner_row_count_test_context context
    on context.snapshot_id = candidate.snapshot_id
  order by candidate.title_id
  limit 1
);

do $assert$
declare
  v_count bigint;
begin
  select snapshot.row_count into v_count
  from public.cloud_catalog_background_owner_snapshots snapshot
  join owner_row_count_test_context context on context.snapshot_id = snapshot.id;
  if v_count <> 1 then
    raise exception 'statement update increment mismatch: expected 1, got %',v_count;
  end if;
end
$assert$;

delete from public.cloud_catalog_background_owner_snapshot_rows owner_row
where owner_row.snapshot_id = (
  select snapshot_id from owner_row_count_test_context
);

do $assert$
declare
  v_count bigint;
begin
  select snapshot.row_count into v_count
  from public.cloud_catalog_background_owner_snapshots snapshot
  join owner_row_count_test_context context on context.snapshot_id = snapshot.id;
  if v_count <> 0 then
    raise exception 'statement delete delta mismatch: expected 0, got %',v_count;
  end if;
end
$assert$;

insert into public.cloud_catalog_background_owner_snapshots (
  id,user_id,snapshot_kind,state,build_visibility_epoch,
  applied_visibility_epoch,row_count
)
select building_snapshot_id,user_id,'baseline','building',1,1,0
from owner_row_count_test_context;

insert into public.cloud_catalog_background_owner_snapshot_sources (
  snapshot_id,user_id,source_id,generation_id
)
select building_snapshot_id,user_id,source_id,generation_id
from owner_row_count_test_context;

insert into public.cloud_catalog_background_owner_snapshot_rows (
  snapshot_id,user_id,title_id,is_present,
  owner_source_id,owner_generation_id,storage_kind,
  item_type,provider_tmdb_id,match_status,title,original_title,
  release_year,poster_url,backdrop_url,catalog_metadata,
  payload_updated_at,year_backfill_attempted_at,
  revalidate_attempted_at,search_match_attempted_at
)
select context.building_snapshot_id,context.user_id,title.id,true,
  context.source_id,context.generation_id,'global',
  title.item_type,title.provider_tmdb_id,title.match_status,title.title,
  title.original_title,title.release_year,title.poster_url,title.backdrop_url,
  title.metadata,title.updated_at,title.year_backfill_attempted_at,
  title.revalidate_attempted_at,title.search_match_attempted_at
from owner_row_count_test_context context
join public.cloud_title_variants variant
  on variant.user_id = context.user_id
 and variant.source_id = context.source_id
 and variant.generation_id = context.generation_id
join public.cloud_titles title
  on title.id = variant.title_id and title.user_id = variant.user_id
order by title.id
limit 2;

do $assert$
declare
  v_count bigint;
begin
  select snapshot.row_count into v_count
  from public.cloud_catalog_background_owner_snapshots snapshot
  join owner_row_count_test_context context
    on context.building_snapshot_id = snapshot.id;
  if v_count <> 0 then
    raise exception 'building snapshot counter must remain builder-owned, got %',v_count;
  end if;
end
$assert$;

rollback;

select 'CATALOG_BACKGROUND_OWNER_ROW_COUNT_INTEGRATION_PASS' as result;
