-- Run in a single rollback-only test session. Every writable object is pg_temp.
-- Install the temporary provider parser first. Split at FUNCTIONS UNDER TEST;
-- then install temporary copies of the reconciliation/effective functions.
create temp table cloud_titles(id uuid primary key,user_id uuid,item_type text);
create temp table cloud_title_variants(id uuid primary key,user_id uuid,title_id uuid,source_id uuid,
  item_type text,metadata jsonb,external_id text,raw_title text);
create temp view cloud_catalog_visible_title_variants as select * from pg_temp.cloud_title_variants;
create temp table cloud_catalog_provider_language_hints(variant_id uuid primary key,user_id uuid,
  title_id uuid,source_id uuid,item_type text,language text);
create temp table cloud_title_file_language_observations(user_id uuid,title_id uuid,variant_id uuid,
  file_external_id text,audio_observed boolean,audio_languages text[]);

insert into pg_temp.cloud_titles values
  ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','movie'),
  ('10000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000002','movie');
insert into pg_temp.cloud_title_variants values
  ('20000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','movie','{"categoryName":"SCANDINAVIA"}','file-dk','DK | Land of Mine'),
  ('20000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','movie','{"categoryName":"EXYU"}','file-dutch','EXYU | Dutch'),
  ('20000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','movie','{"categoryName":"SCANDINAVIA"}','file-se','SE | Example'),
  ('20000000-0000-0000-0000-000000000004','b0000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000003','movie','{"categoryName":"SCANDINAVIA"}','file-dk','DK | Other owner');
insert into pg_temp.cloud_catalog_provider_language_hints
  select id,user_id,title_id,source_id,item_type,case external_id when 'file-dutch' then 'nl' else 'en' end
  from pg_temp.cloud_title_variants where external_id<>'file-se';

-- FUNCTIONS UNDER TEST
do $test$
declare owner_id uuid:='a0000000-0000-0000-0000-000000000001'; report jsonb;
  original_metadata jsonb; after_id uuid;
begin
  select jsonb_agg(to_jsonb(v) order by id) into original_metadata from pg_temp.cloud_title_variants v;
  begin
    perform pg_temp.cloud_catalog_reconcile_provider_language_hints(null,null,1);
    raise exception 'owner guard failed';
  exception when raise_exception then
    if sqlerrm='owner guard failed' then raise; end if;
  end;
  begin
    perform pg_temp.cloud_catalog_reconcile_provider_language_hints(owner_id,null,2001);
    raise exception 'batch guard failed';
  exception when raise_exception then
    if sqlerrm='batch guard failed' then raise; end if;
  end;
  report:=pg_temp.cloud_catalog_reconcile_provider_language_hints(owner_id,null,1);
  if report->>'scanned'<>'1' or report->>'changed'<>'1' then raise exception 'first bounded batch failed: %',report; end if;
  after_id:=(report->>'after')::uuid;
  report:=pg_temp.cloud_catalog_reconcile_provider_language_hints(owner_id,after_id,1000);
  if report->>'scanned'<>'2' or report->>'changed'<>'2' or report->>'removed'<>'0' then
    raise exception 'continued batch failed: %',report;
  end if;
  report:=pg_temp.cloud_catalog_reconcile_provider_language_hints(owner_id,(report->>'after')::uuid,1000);
  if report->>'scanned'<>'0' then raise exception 'cursor crossed into another owner'; end if;
  report:=pg_temp.cloud_catalog_reconcile_provider_language_hints(owner_id,null,1000);
  if report->>'scanned'<>'3' or report->>'changed'<>'0' or report->>'removed'<>'0' then
    raise exception 'reconciliation is not idempotent: %',report;
  end if;
  if (select language from pg_temp.cloud_catalog_provider_language_hints where variant_id='20000000-0000-0000-0000-000000000004')<>'en' then
    raise exception 'other owner changed';
  end if;
  if original_metadata is distinct from (select jsonb_agg(to_jsonb(v) order by id) from pg_temp.cloud_title_variants v) then
    raise exception 'raw catalogue was rewritten';
  end if;
  if (select array_agg(language order by language) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,null))<>array['da','exyu','sv'] then
    raise exception 'effective language union incorrect';
  end if;
  if pg_temp.catalog_provider_language_alias('exyu') is not null
    or public.norva_canonical_language_code('exyu') is not null then
    raise exception 'EXYU was promoted to a canonical audio language';
  end if;
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'exyu'))<>1
    or (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie','30000000-0000-0000-0000-000000000002','exyu'))<>0
    or exists(select 1 from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,null) where language in ('hr','sr','bs')) then
    raise exception 'regional catalogue facet invented audio or leaked across sources';
  end if;
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'series',null,null))<>0 then
    raise exception 'item type leaked';
  end if;
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie','30000000-0000-0000-0000-000000000002','da'))<>0 then
    raise exception 'source scope leaked';
  end if;
  insert into pg_temp.cloud_title_file_language_observations
    select user_id,title_id,id,external_id,true,array['und'] from pg_temp.cloud_title_variants where id='20000000-0000-0000-0000-000000000001';
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'da'))<>1 then
    raise exception 'und placeholder hid supplier Danish';
  end if;
  update pg_temp.cloud_title_file_language_observations set audio_languages=array['und','de'];
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'da'))<>0
    or (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'de'))<>1 then
    raise exception 'accepted German did not override supplier';
  end if;
  update pg_temp.cloud_title_file_language_observations set audio_languages=array['hz'];
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'hz'))<>1 then
    raise exception 'real rare language was dropped';
  end if;
  update pg_temp.cloud_title_file_language_observations set file_external_id='unrelated-file';
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'da'))<>1
    or (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'hz'))<>0 then
    raise exception 'observation crossed exact-file identity';
  end if;
  update pg_temp.cloud_title_file_language_observations set file_external_id='file-dk',user_id='b0000000-0000-0000-0000-000000000002';
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'da'))<>1 then
    raise exception 'foreign-owner observation blocked hint';
  end if;
  -- A regional token cannot become an observed language, but still supplies the
  -- catalogue fallback. A real English observation must replace that fallback.
  insert into pg_temp.cloud_title_file_language_observations
    select user_id,title_id,id,external_id,true,array['exyu'] from pg_temp.cloud_title_variants where id='20000000-0000-0000-0000-000000000002';
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'exyu'))<>1 then
    raise exception 'noncanonical regional observation hid catalogue fallback';
  end if;
  update pg_temp.cloud_title_file_language_observations set audio_languages=array['en']
    where variant_id='20000000-0000-0000-0000-000000000002' and user_id=owner_id;
  if (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'exyu'))<>0
    or (select count(*) from pg_temp.cloud_catalog_effective_audio_languages(owner_id,'movie',null,'en'))<>1 then
    raise exception 'observed English did not override regional EXYU fallback';
  end if;
  if (select language from pg_temp.cloud_catalog_provider_language_hints where variant_id='20000000-0000-0000-0000-000000000002')<>'exyu' then
    raise exception 'observation comparison mutated regional hint storage';
  end if;
end
$test$;
select jsonb_build_object('reconciliation','passed','owner_scope','passed','idempotence','passed',
  'raw_evidence_unchanged','passed','placeholder_fallback','passed','observed_priority','passed',
  'exact_file_identity','passed','rare_languages','passed','regional_catalogue_facet','passed',
  'regional_noncanonical','passed','observed_english_over_region','passed');
