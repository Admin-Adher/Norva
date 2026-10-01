-- Run after the migration inside an uncommitted transaction, always ROLLBACK.
-- psql variables owner_a/owner_b must name two authorized, existing QA owners;
-- owner_a needs a completed Selection. No account or catalogue is committed.
select set_config('test.selection.owner_a', :'owner_a', true);
select set_config('test.selection.owner_b', :'owner_b', true);
set local request.jwt.claim.role='service_role';
do $test$
declare a uuid:=current_setting('test.selection.owner_a')::uuid;
  b uuid:=current_setting('test.selection.owner_b')::uuid;
  s uuid; ns uuid; h text; snap jsonb; rev text; fixture jsonb; ids uuid[]; old_ids uuid[];
  recipe_count integer; result jsonb; started timestamptz; before_count integer;
begin
  assert a<>b, 'two owners required';
  assert not has_table_privilege('authenticated','public.selection_title_recipes','SELECT');
  assert not has_table_privilege('anon','public.selection_title_recipes','INSERT');
  assert not has_function_privilege('authenticated',
    'public.norva_apply_selection_title_recipes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid[],text)','EXECUTE');
  select id into strict s from public.cloud_sources where user_id=a and enabled and deleted_at is null
    and public.norva_selection_source_identity_valid(id,user_id) limit 1;
  select revision into strict rev from public.selection_prepared_catalogs limit 1;
  select jsonb_agg(jsonb_build_object('raw',raw,'title',title,'variant',variant)),array_agg(id)
    into fixture,old_ids from (
      select m.id,to_jsonb(m) raw,to_jsonb(t) title,to_jsonb(v) variant
      from public.cloud_media_items m join public.cloud_title_variants v on v.media_item_id=m.id
        and v.user_id=a and v.source_id=s and v.generation_id=m.generation_id
      join public.cloud_titles t on t.id=v.title_id and t.user_id=a
      where m.user_id=a and m.source_id=s and m.item_type in ('movie','series') and m.available
      order by m.id limit 500
    ) entries;
  recipe_count:=public.norva_cache_selection_title_recipes(rev,fixture);
  assert recipe_count>0, 'qualified manifest coverage required';
  assert not exists(select 1 from public.selection_title_recipes where title ?| array['id','user_id','source_id']
    or variant ?| array['id','user_id','title_id','source_id','media_item_id','generation_id','last_success_at']);

  h:=encode(sha256(convert_to('norva-selection-enrolment-v1:4294967294:'||b::text,'UTF8')),'hex');
  ns:=(substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,4)||'fffffffe')::uuid;
  assert not exists(select 1 from public.cloud_sources where id=ns), 'reserved QA source exists';
  insert into public.cloud_sources select new_source.* from public.cloud_sources donor
    cross join lateral jsonb_populate_record(null::public.cloud_sources,to_jsonb(donor)||jsonb_build_object(
      'id',ns,'user_id',b,'name','Selection rollback probe','config_hint','{}'::jsonb,'sync_status','syncing')) new_source
    where donor.id=s and donor.user_id=a;
  snap:=public.norva_get_catalog_write_snapshot(ns,b);
  insert into public.cloud_media_items select new_item.* from public.cloud_media_items donor
    cross join lateral jsonb_populate_record(null::public.cloud_media_items,to_jsonb(donor)||jsonb_build_object(
      'id',gen_random_uuid(),'user_id',b,'source_id',ns,'generation_id',snap->>'generationId',
      'write_head_revision',snap->>'headRevision','write_config_revision',snap->>'configRevision',
      'write_source_visibility_epoch',snap->>'sourceVisibilityEpoch','write_user_visibility_epoch',snap->>'userVisibilityEpoch')) new_item
    where donor.id=any(old_ids) and donor.user_id=a;
  select array_agg(id order by id) into ids from public.cloud_media_items where source_id=ns and user_id=b;
  snap:=public.norva_get_catalog_write_snapshot(ns,b);
  before_count:=(select count(*) from public.cloud_title_variants where source_id=ns);
  -- Real server guards: a foreign member or stale source fence aborts before any write.
  begin
    perform public.norva_apply_selection_title_recipes(ns,b,(snap->>'generationId')::uuid,
      (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
      (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,array[old_ids[1]],rev);
    raise exception 'Foreign media accepted';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.norva_apply_selection_title_recipes(ns,b,(snap->>'generationId')::uuid,
      (snap->>'headRevision')::bigint+1,(snap->>'configRevision')::bigint,
      (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,ids,rev);
    raise exception 'Stale generation fence accepted';
  exception when sqlstate 'PT409' then null; end;
  assert (select count(*) from public.cloud_title_variants where source_id=ns)=before_count;
  -- Expiry is a cache miss, not authorization to copy old entries.
  update public.selection_title_recipes set expires_at=clock_timestamp()-interval '1 second' where revision=rev;
  result:=public.norva_apply_selection_title_recipes(ns,b,(snap->>'generationId')::uuid,
    (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
    (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,ids,rev);
  assert result->>'reused'='false';
  perform public.norva_cache_selection_title_recipes(rev,fixture);
  started:=clock_timestamp();
  result:=public.norva_apply_selection_title_recipes(ns,b,(snap->>'generationId')::uuid,
    (snap->>'headRevision')::bigint,(snap->>'configRevision')::bigint,
    (snap->>'sourceVisibilityEpoch')::bigint,(snap->>'userVisibilityEpoch')::bigint,ids,rev);
  assert result->>'reused'='true';
  assert (result->>'variants')::integer=recipe_count;
  assert not exists(select 1 from public.cloud_title_variants v
    left join public.cloud_media_items m on m.id=v.media_item_id
    left join public.cloud_titles t on t.id=v.title_id
    where v.source_id=ns and (v.user_id<>b or m.user_id<>b or t.user_id<>b or m.source_id<>ns
      or v.generation_id<>(snap->>'generationId')::uuid or v.media_item_id=any(old_ids)));
  raise notice 'cross-owner bind: % variants in % ms; ACL, foreign IDs, stale fence and expiry passed',
    recipe_count,round(extract(epoch from clock_timestamp()-started)*1000);
end $test$;
rollback;
