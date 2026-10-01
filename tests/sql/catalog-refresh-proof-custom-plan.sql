-- Run in one rollback-only transaction after loading old and new proof bodies
-- as pg_temp.original_proof and pg_temp.optimized_proof, using pg_temp tables.
create temporary table proof_results (case_name text primary key);
create function pg_temp.assert_catalog_proof(
  p_case text, p_expected boolean, p_kind text default 'live',
  p_items bigint default 1, p_active bigint default 1
) returns void language plpgsql as $$
declare v_old boolean; v_new boolean;
begin
  v_old := pg_temp.original_proof(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',p_kind,9,1,p_items,p_active);
  v_new := pg_temp.optimized_proof(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',p_kind,9,1,p_items,p_active);
  if v_old is distinct from p_expected or v_new is distinct from p_expected then
    raise exception 'proof assertion failed: %',p_case;
  end if;
  insert into proof_results values(p_case);
end $$;

insert into cloud_source_catalog_generation_categories values
('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','live','00000000-0000-4000-8000-000000000004');
insert into cloud_media_items values
('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','live',9,'00000000-0000-4000-8000-000000000004');
insert into cloud_live_variants values
('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','HD','123');
insert into cloud_live_logical_channels values
('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004',1,'[{}]','123','{"stream_id":"123"}');
select pg_temp.assert_catalog_proof('valid live',true);
select pg_temp.assert_catalog_proof('wrong inventory count',false,'live',2,1);
select pg_temp.assert_catalog_proof('wrong active count',false,'live',1,2);
select pg_temp.assert_catalog_proof('unknown action',false,'invalid');
update cloud_source_catalog_generation_categories set projection_refresh_run_id=null;
select pg_temp.assert_catalog_proof('stale category',false);
update cloud_source_catalog_generation_categories set projection_refresh_run_id='00000000-0000-4000-8000-000000000004';
update cloud_media_items set catalog_version=8;
select pg_temp.assert_catalog_proof('wrong catalog version',false);
update cloud_media_items set catalog_version=9;
update cloud_live_variants set projection_refresh_run_id=null;
select pg_temp.assert_catalog_proof('stale live variant',false);
update cloud_live_variants set projection_refresh_run_id='00000000-0000-4000-8000-000000000004';
update cloud_live_variants set media_item_id='00000000-0000-4000-8000-000000000007';
select pg_temp.assert_catalog_proof('missing item membership',false);
update cloud_live_variants set media_item_id='00000000-0000-4000-8000-000000000005';
update cloud_live_logical_channels set variant_preview='[]';
select pg_temp.assert_catalog_proof('invalid preview cardinality',false);
update cloud_live_logical_channels set variant_preview='[{}]',default_stream_id='missing',default_variant='{"stream_id":"missing"}';
select pg_temp.assert_catalog_proof('missing default variant',false);
update cloud_live_logical_channels set default_stream_id='123',default_variant='{"stream_id":"123"}',variant_count=2;
select pg_temp.assert_catalog_proof('wrong channel count',false);
update cloud_live_logical_channels set variant_count=1,projection_refresh_run_id=null;
select pg_temp.assert_catalog_proof('stale channel',false);
update cloud_live_logical_channels set projection_refresh_run_id='00000000-0000-4000-8000-000000000004';
select pg_temp.assert_catalog_proof('restored live',true);

update cloud_source_catalog_generation_categories set category_kind='vod';
update cloud_media_items set item_type='movie';
insert into cloud_title_variants values
('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','movie','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005');
select pg_temp.assert_catalog_proof('valid vod',true,'vod');
update cloud_title_variants set media_item_id='00000000-0000-4000-8000-000000000007';
select pg_temp.assert_catalog_proof('missing vod membership',false,'vod');
update cloud_title_variants set media_item_id='00000000-0000-4000-8000-000000000005',projection_refresh_run_id=null;
select pg_temp.assert_catalog_proof('stale vod variant',false,'vod');
update cloud_title_variants set projection_refresh_run_id='00000000-0000-4000-8000-000000000004',item_type='series';
update cloud_source_catalog_generation_categories set category_kind='series';
update cloud_media_items set item_type='series';
select pg_temp.assert_catalog_proof('valid series',true,'series');
update cloud_media_items set projection_refresh_run_id=null;
select pg_temp.assert_catalog_proof('stale series inventory',false,'series');
select json_build_object('proofCasesPassed',count(*)) from proof_results;
