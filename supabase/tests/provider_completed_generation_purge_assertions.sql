-- Included in the real, rolled-back credential completion fixture.
reset role;
insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '93000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','phase3-other-owner@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);
insert into phase3_ctx
select 'purge-previous',jsonb_build_object('id',previous_catalog_generation_id)
from public.cloud_source_transitions
where id=(select (value->>'transitionId')::uuid from phase3_ctx where key='create2');
insert into phase3_ctx
select 'purge-visible-before',jsonb_build_object('count',count(*))
from public.cloud_catalog_visible_media_items
where source_id='93000000-0000-4000-8000-000000000102';
insert into phase3_ctx
select 'purge-titles-before',coalesce(jsonb_agg(to_jsonb(title) order by id),'[]'::jsonb)
from public.cloud_titles title where user_id='93000000-0000-4000-8000-000000000001';
insert into phase3_ctx
select 'purge-other-source-before',coalesce(jsonb_agg(to_jsonb(item) order by id),'[]'::jsonb)
from public.cloud_media_items item where source_id='93000000-0000-4000-8000-000000000101';
set local role service_role;
select extensions.throws_ok(format($sql$select public.norva_purge_cancelled_credential_generation_batch(%L,%L,10)$sql$,
  (select value->>'id' from phase3_ctx where key='purge-previous'),
  '93000000-0000-4000-8000-000000000002'),
  'PT409','terminal generation purge CAS failed','purge rejects a different owner');
select extensions.throws_ok(format($sql$select public.norva_purge_cancelled_credential_generation_batch(%L,%L,10)$sql$,
  (select value->>'generationId' from phase3_ctx where key='allocate2'),
  '93000000-0000-4000-8000-000000000001'),
  'PT409','terminal generation purge CAS failed','purge rejects the current active generation');
select extensions.throws_ok(format($sql$select public.norva_purge_cancelled_credential_generation_batch(%L,%L,0)$sql$,
  (select value->>'id' from phase3_ctx where key='purge-previous'),
  '93000000-0000-4000-8000-000000000001'),
  '22023','purge batch limit is invalid','purge requires a bounded positive budget');
select extensions.throws_ok(format($sql$select public.norva_purge_cancelled_credential_generation_batch(%L,%L,1001)$sql$,
  (select value->>'id' from phase3_ctx where key='purge-previous'),
  '93000000-0000-4000-8000-000000000001'),
  '22023','purge batch limit is invalid','purge rejects an oversized batch');
insert into phase3_ctx values('purge-one',public.norva_purge_cancelled_credential_generation_batch(
  (select (value->>'id')::uuid from phase3_ctx where key='purge-previous'),
  '93000000-0000-4000-8000-000000000001',1));
select extensions.ok((select (value->>'deletedRows')::integer<=1 and value->>'purgeMode'='superseded'
  from phase3_ctx where key='purge-one'),'completed renewal purges its previous generation within one-row budget');
do $drain$
declare v_result jsonb;
begin
  for i in 1..30 loop
    v_result:=public.norva_purge_cancelled_credential_generation_batch(
      (select (value->>'id')::uuid from phase3_ctx where key='purge-previous'),
      '93000000-0000-4000-8000-000000000001',10);
    if (v_result->>'deletedRows')::integer>10 then raise exception 'purge exceeded budget';end if;
    if (v_result->>'complete')::boolean then
      insert into phase3_ctx values('purge-final',v_result);return;
    end if;
  end loop;
  raise exception 'purge fixture did not complete';
end
$drain$;
select extensions.is((select state from public.cloud_source_catalog_generations where id=
  (select (value->>'id')::uuid from phase3_ctx where key='purge-previous')),'purged',
  'successful previous generation ends purged rather than failed');
insert into phase3_ctx values('purge-replay',public.norva_purge_cancelled_credential_generation_batch(
  (select (value->>'id')::uuid from phase3_ctx where key='purge-previous'),
  '93000000-0000-4000-8000-000000000001',10));
select extensions.ok((select (value->>'complete')::boolean and (value->>'replayed')::boolean
  and (value->>'deletedRows')::integer=0 from phase3_ctx where key='purge-replay'),
  'reclaimed cleanup job observes idempotent success after the last batch committed');
select extensions.is((select count(*)::integer from public.cloud_catalog_visible_media_items
  where source_id='93000000-0000-4000-8000-000000000102'),
  (select (value->>'count')::integer from phase3_ctx where key='purge-visible-before'),
  'cleanup preserves the complete current visible catalogue');
select extensions.is((select active_generation_id::text from public.cloud_source_catalog_heads
  where source_id='93000000-0000-4000-8000-000000000102'),
  (select value->>'generationId' from phase3_ctx where key='allocate2'),
  'cleanup never changes the active generation pointer');
select extensions.is((select coalesce(jsonb_agg(to_jsonb(title) order by id),'[]'::jsonb)
  from public.cloud_titles title where user_id='93000000-0000-4000-8000-000000000001'),
  (select value from phase3_ctx where key='purge-titles-before'),
  'cleanup preserves current and unrelated title shells byte for byte');
select extensions.is((select coalesce(jsonb_agg(to_jsonb(item) order by id),'[]'::jsonb)
  from public.cloud_media_items item where source_id='93000000-0000-4000-8000-000000000101'),
  (select value from phase3_ctx where key='purge-other-source-before'),
  'cleanup leaves another source untouched');
select extensions.ok(not has_function_privilege('authenticated',
  'public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)','execute'),
  'ordinary clients cannot invoke terminal cleanup');
reset role;
