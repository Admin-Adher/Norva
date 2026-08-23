-- Standalone concurrent-index unit; never wrap CREATE INDEX CONCURRENTLY in a
-- transaction.  The session repair lock makes concurrent flag activation
-- fail with 55P03 from preflight through the exact postcondition.
set lock_timeout = '2s';
set statement_timeout = '30min';
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('catalog-generation-index-repair-v1', 0)
);
select public.norva_catalog_title_projection_cic_preflight(
  'cloud_source_candidate_titles_unrefreshed_idx',
  'public.cloud_source_catalog_generation_candidate_titles',
  array['generation_id','title_id'],array[0,0]::smallint[],
  '(NOT post_switch_refreshed)'
);
create index concurrently if not exists
  cloud_source_candidate_titles_unrefreshed_idx
  on public.cloud_source_catalog_generation_candidate_titles(
    generation_id,title_id
  ) where not post_switch_refreshed;
select public.norva_catalog_title_projection_cic_assert(
  'cloud_source_candidate_titles_unrefreshed_idx',
  'public.cloud_source_catalog_generation_candidate_titles',
  array['generation_id','title_id'],array[0,0]::smallint[],
  '(NOT post_switch_refreshed)'
);
do $unlock$
begin
  if not pg_catalog.pg_advisory_unlock(
    pg_catalog.hashtextextended('catalog-generation-index-repair-v1', 0)
  ) then
    raise exception 'catalog title active payload repair lock was not held'
      using errcode = '55000';
  end if;
end
$unlock$;
reset lock_timeout;
reset statement_timeout;
