-- Run after the fixture, original sync, count triggers and new migration.
select public.norva_sync_catalog_background_owner_title(user_id,id) from public.cloud_titles;
create temp table original_versions as select snapshot_id,title_id,ctid::text physical_version from public.cloud_catalog_background_owner_snapshot_rows;
select public.norva_sync_catalog_background_owner_title(user_id,id) from public.cloud_titles;
select public.test_assert(not exists(select 1 from public.cloud_catalog_background_owner_snapshot_rows r join original_versions o using(snapshot_id,title_id) where r.ctid::text<>o.physical_version),'unchanged payload rewrote tuple');
select public.test_assert((select sum(row_count)=3 from public.cloud_catalog_background_owner_snapshots),'initial row counts');

update public.cloud_titles set title='Changed',metadata=metadata||'{"new":true}'::jsonb,
 revalidate_attempted_at='2026-10-02Z',updated_at='2026-10-02Z'
 where id='10000000-0000-0000-0000-000000000001';
select public.norva_sync_catalog_background_owner_title('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
select public.test_assert((select count(*)=2 from public.cloud_catalog_background_owner_snapshot_rows where title='Changed' and catalog_metadata->>'new'='true' and revalidate_attempted_at='2026-10-02Z'),'real payload/attempt change lost');
select public.test_assert((select r.ctid::text=o.physical_version from public.cloud_catalog_background_owner_snapshot_rows r join original_versions o using(snapshot_id,title_id) where r.user_id='20000000-0000-0000-0000-000000000002'),'other owner was modified');

-- Attempt timestamps drive retry eligibility even when the display is unchanged.
update public.cloud_titles set search_match_attempted_at='2026-10-02 08:30Z'
where id='10000000-0000-0000-0000-000000000001';
select public.norva_sync_catalog_background_owner_title('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
select public.test_assert((select count(*)=2 from public.cloud_catalog_background_owner_snapshot_rows where search_match_attempted_at='2026-10-02 08:30Z'),'timestamp-only change lost');
update public.cloud_titles set revalidate_attempted_at=null
where id='10000000-0000-0000-0000-000000000001';
select public.norva_sync_catalog_background_owner_title('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
select public.test_assert((select count(*)=2 from public.cloud_catalog_background_owner_snapshot_rows where user_id='20000000-0000-0000-0000-000000000001' and revalidate_attempted_at is null),'attempt reset to NULL lost');

insert into public.cloud_source_catalog_generation_candidate_titles
 select id,user_id,'50000000-0000-0000-0000-000000000001',item_type,provider_tmdb_id,
 match_status,'Projected',original_title,release_year,null,backdrop_url,metadata,updated_at,
 year_backfill_attempted_at,revalidate_attempted_at,search_match_attempted_at
 from public.cloud_titles where id='10000000-0000-0000-0000-000000000001';
select public.norva_sync_catalog_background_owner_title('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
select public.test_assert((select count(*)=2 from public.cloud_catalog_background_owner_snapshot_rows where storage_kind='projection' and title='Projected' and poster_url is null),'projection authority or NULL propagation failed');

delete from public.cloud_title_variants where user_id='20000000-0000-0000-0000-000000000001';
select public.norva_sync_catalog_background_owner_title('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
select public.test_assert((select count(*)=2 from public.cloud_catalog_background_owner_snapshot_rows where not is_present),'removal tombstones lost');
select public.test_assert((select sum(row_count)=1 from public.cloud_catalog_background_owner_snapshots),'removal row counts');
truncate original_versions;
insert into original_versions select snapshot_id,title_id,ctid::text from public.cloud_catalog_background_owner_snapshot_rows;
select public.norva_sync_catalog_background_owner_title('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
select public.test_assert(not exists(select 1 from public.cloud_catalog_background_owner_snapshot_rows r join original_versions o using(snapshot_id,title_id) where r.ctid::text<>o.physical_version),'unchanged tombstone rewrote tuple');

insert into public.cloud_title_variants values ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
select public.norva_sync_catalog_background_owner_title('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
select public.test_assert((select count(*)=3 from public.cloud_catalog_background_owner_snapshot_rows where is_present),'revival lost');
select public.test_assert((select sum(row_count)=3 from public.cloud_catalog_background_owner_snapshots),'revival row counts');
select 'OWNER_NOOP_ASSERTIONS_OK';
