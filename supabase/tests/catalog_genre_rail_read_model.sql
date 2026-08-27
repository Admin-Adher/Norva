begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
grant usage on schema extensions to service_role;
grant execute on all functions in schema extensions to service_role;
select extensions.plan(16);

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '98610000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','genre-rail-read-model@invalid.test','',now(),
  '{}','{}',now(),now()
),(
  '98610000-0000-4000-8000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','genre-rail-refresh@invalid.test','',now(),
  '{}','{}',now(),now()
);

insert into public.cloud_user_catalog_visibility_epochs(user_id,visibility_epoch,updated_at)
values ('98610000-0000-4000-8000-000000000001',7,now());

insert into public.cloud_sources(
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '98610000-0000-4000-8000-000000000201',
  '98610000-0000-4000-8000-000000000002',
  'xtream','Genre rail refresh fixture','cipher','{}',
  'ready',1,true,now()
);

do $fixture$
declare
  v_generation uuid;
begin
  select active_generation_id into strict v_generation
  from public.cloud_source_catalog_heads
  where source_id='98610000-0000-4000-8000-000000000201'
    and user_id='98610000-0000-4000-8000-000000000002';

  insert into public.cloud_titles(
    id,user_id,item_type,identity_key,identity_source,provider_tmdb_id,
    match_status,title,poster_url,genre_payload,metadata,created_at,updated_at
  ) values (
    '98610000-0000-4000-8000-000000000202',
    '98610000-0000-4000-8000-000000000002',
    'movie','provider_tmdb:9861','provider_tmdb','9861','unmatched',
    'Genre rail materialisation fixture','https://invalid.test/poster.jpg',
    '["Action","Adventure"]','{}',now()-interval '1 hour',now()
  );
  insert into public.cloud_title_variants(
    id,user_id,title_id,source_id,item_type,external_id,raw_title,generation_id,language
  ) values (
    '98610000-0000-4000-8000-000000000203',
    '98610000-0000-4000-8000-000000000002',
    '98610000-0000-4000-8000-000000000202',
    '98610000-0000-4000-8000-000000000201',
    'movie','9861','Genre rail materialisation fixture',v_generation,'VF'
  );

  insert into public.cloud_title_file_language_observations(
    user_id,title_id,variant_id,file_external_id,
    audio_languages,subtitle_languages,audio_observed,subtitle_observed
  ) values (
    '98610000-0000-4000-8000-000000000002',
    '98610000-0000-4000-8000-000000000202',
    '98610000-0000-4000-8000-000000000203',
    '9861-file',array['fr','en','und'],array['fr'],true,true
  );
end
$fixture$;
set constraints all immediate;
insert into public.cloud_user_catalog_visibility_epochs(user_id,visibility_epoch,updated_at)
values ('98610000-0000-4000-8000-000000000002',3,now())
on conflict(user_id) do update
set visibility_epoch=excluded.visibility_epoch,updated_at=excluded.updated_at;

insert into public.cloud_catalog_facet_summary(
  user_id,item_type,genre_rail_candidates,genre_rail_visibility_epoch,refreshed_at
) values (
  '98610000-0000-4000-8000-000000000001','movie',
  jsonb_build_object(
    'action',jsonb_build_array(jsonb_build_object(
      'id','98610000-0000-4000-8000-000000000101',
      'genreBuckets',jsonb_build_array('action','aventure'),
      'createdAt','2026-08-26T00:00:00Z'
    ))
  ),
  7,now()
);

select extensions.ok(
  (select active
   from cron.job
   where jobname='norva-facet-summary-refresh')
  and (select command =
       'set statement_timeout=''120s''; select public.cloud_refresh_all_facet_summaries(50);'
       from cron.job
       where jobname='norva-facet-summary-refresh'),
  'the repaired bounded facet worker is explicitly active'
);

select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;

select extensions.is(
  public.norva_get_genre_rail_candidates(
    '98610000-0000-4000-8000-000000000001','movie',7
  )->>'contract',
  'catalog-genre-rail-candidates-v1',
  'the service receives the versioned bounded read-model contract'
);
select extensions.is(
  public.norva_get_genre_rail_candidates(
    '98610000-0000-4000-8000-000000000001','movie',7
  )->>'visibilityEpoch',
  '7',
  'the response carries the exact visibility write fence'
);
select extensions.is(
  jsonb_array_length(public.norva_get_genre_rail_candidates(
    '98610000-0000-4000-8000-000000000001','movie',7
  ) #> '{candidates,action}'),
  1,
  'one summary probe returns the complete stored bucket payload'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.norva_get_genre_rail_candidates(uuid,text,bigint)',
    'EXECUTE'
  ),
  'authenticated clients cannot call the internal read model directly'
);
select public.cloud_refresh_facet_summary(
  '98610000-0000-4000-8000-000000000002','movie'
);
select public.cloud_refresh_genre_rail_candidates(
  '98610000-0000-4000-8000-000000000002','movie'
);
select extensions.is(
  public.norva_get_genre_rail_candidates(
    '98610000-0000-4000-8000-000000000002','movie',3
  ) #>> '{candidates,action,0,id}',
  '98610000-0000-4000-8000-000000000202',
  'the background refresh materialises the visible action candidate'
);
select extensions.is(
  (select genre_bucket_counts->>'action'
   from public.cloud_catalog_facet_summary
   where user_id='98610000-0000-4000-8000-000000000002'
     and item_type='movie'),
  '1',
  'the rail read model and facet count share the same visible-title set'
);
select extensions.is(
  (select audio_lang_counts
   from public.cloud_catalog_facet_summary
   where user_id='98610000-0000-4000-8000-000000000002'
     and item_type='movie'),
  '{"en": 1, "fr": 1}'::jsonb,
  'the index-first facet refresh counts exact visible audio languages'
);
select extensions.is(
  (select subtitle_lang_counts
   from public.cloud_catalog_facet_summary
   where user_id='98610000-0000-4000-8000-000000000002'
     and item_type='movie'),
  '{"fr": 1}'::jsonb,
  'the index-first facet refresh counts exact visible subtitle languages'
);
select extensions.is(
  (select version_tags
   from public.cloud_catalog_facet_summary
   where user_id='98610000-0000-4000-8000-000000000002'
     and item_type='movie'),
  array['vf']::text[],
  'the index-first facet refresh normalizes visible variant language tags'
);
select extensions.ok(
  (select genre_rail_refreshed_at is not null
   from public.cloud_catalog_facet_summary
   where user_id='98610000-0000-4000-8000-000000000002'
     and item_type='movie'),
  'rail freshness is tracked independently from language facets'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.cloud_refresh_genre_rail_candidates(uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.cloud_refresh_all_genre_rail_candidates(integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot invoke either rail refresh worker'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.cloud_refresh_facet_summary(uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'public.cloud_refresh_all_facet_summaries(integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot invoke either facet refresh worker'
);
reset role;
update public.cloud_user_catalog_visibility_epochs
set visibility_epoch=8,updated_at=now()
where user_id='98610000-0000-4000-8000-000000000001';
set local role service_role;

select extensions.throws_ok(
  $$select public.norva_get_genre_rail_candidates(
    '98610000-0000-4000-8000-000000000001','movie',7
  )$$,
  'PT409','catalog visibility epoch changed',
  'a caller carrying the previous visibility epoch is stale'
);
select extensions.throws_ok(
  $$select public.norva_get_genre_rail_candidates(
    '98610000-0000-4000-8000-000000000001','movie',8
  )$$,
  '55000','genre rail read model is not ready',
  'a stale materialisation cannot cross the new visibility epoch'
);

reset role;
update public.cloud_catalog_facet_summary
set genre_rail_visibility_epoch=8
where user_id='98610000-0000-4000-8000-000000000001' and item_type='movie';
set local role service_role;
select extensions.is(
  public.norva_get_genre_rail_candidates(
    '98610000-0000-4000-8000-000000000001','movie',8
  )->>'visibilityEpoch',
  '8',
  'a materialisation rebuilt under the current epoch becomes readable'
);

select * from extensions.finish();
rollback;
