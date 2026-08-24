set lock_timeout = '2s';
set statement_timeout = '30min';
select public.norva_catalog_title_projection_cic_preflight(
  'idx_cloud_titles_projection_year_desc','public.cloud_titles',
  array['user_id','item_type','release_year','id'],
  array[0,0,1,0]::smallint[],null
);
create index concurrently if not exists idx_cloud_titles_projection_year_desc
  on public.cloud_titles(
    user_id,item_type,release_year desc nulls last,id
  );
select public.norva_catalog_title_projection_cic_assert(
  'idx_cloud_titles_projection_year_desc','public.cloud_titles',
  array['user_id','item_type','release_year','id'],
  array[0,0,1,0]::smallint[],null
);
reset lock_timeout;
reset statement_timeout;
