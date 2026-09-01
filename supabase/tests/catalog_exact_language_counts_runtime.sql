begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
create extension if not exists pgtap with schema extensions;
set local search_path = public,extensions;
grant usage on schema extensions to service_role;
grant execute on all functions in schema extensions to service_role;
select extensions.plan(12);

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '98620000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','exact-facets-a@invalid.test','',now(),
  '{}','{}',now(),now()
),(
  '98620000-0000-4000-8000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','exact-facets-b@invalid.test','',now(),
  '{}','{}',now(),now()
);

insert into public.cloud_sources(
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '98620000-0000-4000-8000-000000000101',
  '98620000-0000-4000-8000-000000000001',
  'xtream','Exact facets A1','cipher','{}','ready',1,true,now()
),(
  '98620000-0000-4000-8000-000000000102',
  '98620000-0000-4000-8000-000000000001',
  'xtream','Exact facets A2','cipher','{}','ready',1,true,now()
),(
  '98620000-0000-4000-8000-000000000103',
  '98620000-0000-4000-8000-000000000001',
  'xtream','Exact facets hidden','cipher','{}','ready',1,true,now()
),(
  '98620000-0000-4000-8000-000000000104',
  '98620000-0000-4000-8000-000000000002',
  'xtream','Exact facets B','cipher','{}','ready',1,true,now()
);

do $fixture$
declare
  v_generation_a1 uuid;
  v_generation_a2 uuid;
  v_generation_hidden uuid;
  v_generation_b uuid;
begin
  select active_generation_id into strict v_generation_a1
  from public.cloud_source_catalog_heads
  where source_id='98620000-0000-4000-8000-000000000101';
  select active_generation_id into strict v_generation_a2
  from public.cloud_source_catalog_heads
  where source_id='98620000-0000-4000-8000-000000000102';
  select active_generation_id into strict v_generation_hidden
  from public.cloud_source_catalog_heads
  where source_id='98620000-0000-4000-8000-000000000103';
  select active_generation_id into strict v_generation_b
  from public.cloud_source_catalog_heads
  where source_id='98620000-0000-4000-8000-000000000104';

  insert into public.cloud_titles(
    id,user_id,item_type,identity_key,identity_source,match_status,title,
    metadata,created_at,updated_at
  ) values (
    '98620000-0000-4000-8000-000000000201',
    '98620000-0000-4000-8000-000000000001','movie',
    'exact:a:shared','normalized','unmatched','Exact shared A','{}',now(),now()
  ),(
    '98620000-0000-4000-8000-000000000202',
    '98620000-0000-4000-8000-000000000001','movie',
    'exact:a:second','normalized','unmatched','Exact second A','{}',now(),now()
  ),(
    '98620000-0000-4000-8000-000000000203',
    '98620000-0000-4000-8000-000000000001','movie',
    'exact:a:hidden','normalized','unmatched','Exact hidden A','{}',now(),now()
  ),(
    '98620000-0000-4000-8000-000000000204',
    '98620000-0000-4000-8000-000000000002','movie',
    'exact:b:only','normalized','unmatched','Exact B','{}',now(),now()
  );

  insert into public.cloud_title_variants(
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id
  ) values (
    '98620000-0000-4000-8000-000000000301',
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000201',
    '98620000-0000-4000-8000-000000000101','movie','a1-shared',
    'Exact shared A1',v_generation_a1
  ),(
    '98620000-0000-4000-8000-000000000302',
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000201',
    '98620000-0000-4000-8000-000000000102','movie','a2-shared',
    'Exact shared A2',v_generation_a2
  ),(
    '98620000-0000-4000-8000-000000000303',
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000202',
    '98620000-0000-4000-8000-000000000101','movie','a1-second',
    'Exact second A',v_generation_a1
  ),(
    '98620000-0000-4000-8000-000000000304',
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000203',
    '98620000-0000-4000-8000-000000000103','movie','a-hidden',
    'Exact hidden A',v_generation_hidden
  ),(
    '98620000-0000-4000-8000-000000000305',
    '98620000-0000-4000-8000-000000000002',
    '98620000-0000-4000-8000-000000000204',
    '98620000-0000-4000-8000-000000000104','movie','b-only',
    'Exact B',v_generation_b
  );

  insert into public.cloud_title_file_language_observations(
    user_id,title_id,variant_id,file_external_id,
    audio_languages,subtitle_languages,audio_observed,subtitle_observed
  ) values (
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000201',
    '98620000-0000-4000-8000-000000000301','a1-shared-main',
    array['fr','ja'],array['en','fr'],true,true
  ),(
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000201',
    '98620000-0000-4000-8000-000000000301','a1-shared-duplicate',
    array['fr'],array[]::text[],true,false
  ),(
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000201',
    '98620000-0000-4000-8000-000000000302','a2-shared',
    array['fr'],array['en'],true,true
  ),(
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000202',
    '98620000-0000-4000-8000-000000000303','a1-second-main',
    array['fr','en'],array['en'],true,true
  ),(
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000202',
    '98620000-0000-4000-8000-000000000303','a1-second-subtitle-only',
    array[]::text[],array['it'],false,true
  ),(
    '98620000-0000-4000-8000-000000000001',
    '98620000-0000-4000-8000-000000000203',
    '98620000-0000-4000-8000-000000000304','a-hidden',
    array['es'],array['es'],true,true
  ),(
    '98620000-0000-4000-8000-000000000002',
    '98620000-0000-4000-8000-000000000204',
    '98620000-0000-4000-8000-000000000305','b-only',
    array['de'],array['fr'],true,true
  );
end
$fixture$;

set constraints all immediate;

-- The row was written while its active generation was visible.  Hide the
-- source afterwards to prove that the runtime view, not the raw observation,
-- controls the all-source union.
update public.cloud_sources
set enabled=false
where id='98620000-0000-4000-8000-000000000103';

insert into public.cloud_catalog_facet_summary(
  user_id,item_type,audio_lang_counts,subtitle_lang_counts,refreshed_at
) values (
  '98620000-0000-4000-8000-000000000001','movie',
  '{"zz": 7}'::jsonb,'{"zz": 8}'::jsonb,now()
);

select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;

select extensions.is(
  public.cloud_exact_language_counts(
    '98620000-0000-4000-8000-000000000001','movie'
  ),
  '{"audio":{"zz":7},"subtitles":{"zz":8}}'::jsonb,
  'a fresh summary remains the constant-time fast path'
);

update public.cloud_catalog_facet_summary
set refreshed_at='epoch'::timestamptz
where user_id='98620000-0000-4000-8000-000000000001'
  and item_type='movie';

select extensions.is(
  public.cloud_exact_language_counts(
    '98620000-0000-4000-8000-000000000001','movie'
  )->'audio',
  '{"en":1,"fr":2,"ja":1}'::jsonb,
  'stale summaries fall back to exact visible all-source audio counts'
);
select extensions.is(
  public.cloud_exact_language_counts(
    '98620000-0000-4000-8000-000000000001','movie'
  )->'subtitles',
  '{"en":2,"fr":1,"it":1}'::jsonb,
  'subtitle-only evidence stays independent from audio completion'
);
select extensions.ok(
  not (public.cloud_exact_language_counts(
    '98620000-0000-4000-8000-000000000001','movie'
  )->'audio' ? 'de'),
  'an unobserved audio list cannot become an exact audio facet'
);
select extensions.ok(
  not (public.cloud_exact_language_counts(
    '98620000-0000-4000-8000-000000000001','movie'
  )->'audio' ? 'es'),
  'a disabled source cannot leak into all-source facets'
);
select extensions.is(
  public.cloud_exact_language_counts(
    '98620000-0000-4000-8000-000000000002','movie'
  )->'audio',
  '{"de":1}'::jsonb,
  'another tenant receives only its own exact audio evidence'
);
select extensions.is(
  public.cloud_exact_language_counts_by_source(
    '98620000-0000-4000-8000-000000000001','movie',
    '98620000-0000-4000-8000-000000000101'
  )->'audio',
  '{"en":1,"fr":2,"ja":1}'::jsonb,
  'source-scoped counts preserve distinct-title semantics'
);
select extensions.is(
  public.cloud_exact_language_counts_by_source(
    '98620000-0000-4000-8000-000000000001','movie',
    '98620000-0000-4000-8000-000000000104'
  ),
  '{"audio":{},"subtitles":{}}'::jsonb,
  'a source owned by another tenant cannot cross the facet boundary'
);
select extensions.throws_ok(
  $$select public.cloud_exact_language_counts(
    '98620000-0000-4000-8000-000000000001','invalid'
  )$$,
  '22023','invalid exact language facet arguments',
  'invalid media types fail closed'
);
select extensions.ok(
  has_function_privilege(
    'service_role','public.cloud_exact_language_counts(uuid,text)','EXECUTE'
  ),
  'the Edge service role can execute the exact facet RPC'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated','public.cloud_exact_language_counts(uuid,text)','EXECUTE'
  ),
  'authenticated clients cannot execute the internal exact facet RPC'
);
select extensions.ok(
  not has_function_privilege(
    'anon','public.cloud_exact_language_counts(uuid,text)','EXECUTE'
  ),
  'anonymous clients cannot execute the internal exact facet RPC'
);

select * from extensions.finish();
rollback;
