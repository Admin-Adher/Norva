begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select extensions.no_plan();

select extensions.ok(
  not has_table_privilege('service_role','public.cloud_source_provider_account_affinities','SELECT')
  and not has_table_privilege('authenticated','public.cloud_source_provider_account_affinities','SELECT')
  and has_function_privilege('service_role',
    'public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)','EXECUTE'),
  'opaque provider account affinity is table-private and service-bound'
);

select extensions.ok(
  pg_get_functiondef('public.provider_account_touch_by_source(uuid,text)'::regprocedure)
    like '%affinity.affinity_hash%'
  and pg_get_functiondef('public.provider_account_touch_by_user(uuid,text)'::regprocedure)
    like '%affinity.affinity_hash%'
  and pg_get_functiondef('public.provider_account_busy(text)'::regprocedure)
    like '%extensions.digest(p_key,''sha256'')%',
  'provider activity uses the opaque affinity after credential swap'
);

alter table public.provider_account_activity
  drop constraint provider_account_activity_opaque_key_ck;
insert into public.provider_account_activity(account_key,last_seen_at,kind)
values
  ('Provider.EXAMPLE:443/User',statement_timestamp(),'legacy-raw'),
  (encode(extensions.digest('Provider.EXAMPLE:443/User','sha256'),'hex'),
    statement_timestamp()-interval '1 minute','older-hash')
on conflict(account_key) do update set last_seen_at=excluded.last_seen_at,kind=excluded.kind;
select public.norva_migrate_provider_account_activity_affinities();
select extensions.ok(
  not exists(select 1 from public.provider_account_activity
    where account_key='Provider.EXAMPLE:443/User')
  and (select kind from public.provider_account_activity
    where account_key=encode(extensions.digest('Provider.EXAMPLE:443/User','sha256'),'hex'))='legacy-raw'
  and public.provider_account_busy('Provider.EXAMPLE:443/User'),
  'raw activity conversion is collision-safe, continuous and idempotent'
);

select extensions.is(
  (select count(*)::integer
   from pg_proc proc
   where proc.pronamespace='public'::regnamespace
     and proc.prorettype<>'trigger'::regtype
     and lower(proc.prosrc) ~ 'cloud_media_items|cloud_title_variants|cloud_live_logical_channels|cloud_live_variants|catalog_series_episode_memberships|catalog_series_inventory_state'
     and lower(proc.prosrc) not like '%generation_id%'
     and lower(proc.prosrc) not like '%cloud_source_catalog_heads%'
     and lower(proc.prosrc) not like '%cloud_catalog_visible_%'
     and (
       has_function_privilege('anon',proc.oid,'EXECUTE')
       or has_function_privilege('authenticated',proc.oid,'EXECUTE')
     )),
  0,
  'no unfenced physical-catalog routine is exposed to public Data API roles during rollout'
);

select extensions.ok(
  has_function_privilege('service_role','public.heal_cloud_title_variants(uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.propagate_media_item_years(uuid,uuid,uuid[])','EXECUTE')
  and has_function_privilege('service_role','public.norva_hydrate_source_category_names(uuid,text,integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.heal_cloud_title_variants(uuid,uuid)','EXECUTE'),
  'legacy writer overloads remain service-only during the caller rolling window'
);

select extensions.ok(
  has_function_privilege('service_role','public.heal_cloud_title_variants(uuid,uuid,uuid,bigint,bigint,bigint,bigint)','EXECUTE')
  and has_function_privilege('service_role','public.propagate_media_item_years(uuid,uuid,uuid[],uuid,bigint,bigint,bigint,bigint)','EXECUTE')
  and has_function_privilege('service_role','public.norva_hydrate_source_category_names(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,integer)','EXECUTE'),
  'current sync writer overloads require the complete generation fence'
);

select extensions.ok(
  has_function_privilege('service_role','public.register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb)','EXECUTE')
  and has_function_privilege('service_role','public.record_catalog_series_inventory_outcome(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,boolean,integer,timestamptz,jsonb)','EXECUTE')
  and has_function_privilege('service_role','public.hydrate_catalog_episode_file_tracks(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[])','EXECUTE')
  and has_function_privilege('service_role','public.hydrate_cloud_title_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text,text[])','EXECUTE'),
  'current series and language writers resolve only complete fenced overloads'
);

select extensions.ok(
  has_function_privilege('service_role','public.register_catalog_series_episodes(uuid,uuid,text,jsonb)','EXECUTE')
  and has_function_privilege('service_role','public.record_catalog_series_inventory_outcome(uuid,uuid,text,boolean,integer,timestamptz,jsonb)','EXECUTE')
  and has_function_privilege('service_role','public.hydrate_catalog_episode_file_tracks(uuid,uuid,text,text[])','EXECUTE')
  and has_function_privilege('service_role','public.hydrate_cloud_title_file_languages(uuid,uuid,text,text,text[])','EXECUTE')
  and not has_function_privilege('authenticated','public.register_catalog_series_episodes(uuid,uuid,text,jsonb)','EXECUTE'),
  'legacy series and language overloads remain service-only until explicit contract'
);

select extensions.ok(
  pg_get_functiondef('public.register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb)'::regprocedure)
    like '%on conflict (source_id,generation_id,parent_series_id,episode_id)%'
  and pg_get_functiondef('public.register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb)'::regprocedure)
    like '%existing.generation_id=p_generation_id%'
  and pg_get_functiondef('public.record_catalog_series_inventory_outcome(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,boolean,integer,timestamptz,jsonb)'::regprocedure)
    like '%on conflict (source_id,generation_id,parent_series_id)%',
  'series registry and inventory use generation-aware natural keys and reads'
);

select extensions.ok(
  pg_get_functiondef('public.hydrate_catalog_episode_file_tracks(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[])'::regprocedure)
    like '%membership.generation_id=p_generation_id%'
  and pg_get_functiondef('public.hydrate_cloud_title_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text,text[])'::regprocedure)
    like '%variant.generation_id=p_generation_id%'
  and pg_get_functiondef('public.recompute_cloud_title_file_languages(uuid,uuid)'::regprocedure)
    like '%head.active_generation_id=variant.generation_id%',
  'file-language hydration and title rollups cannot read hidden generations'
);

set local role service_role;
select extensions.throws_ok(
  $$select public.register_catalog_series_episodes(
    '10000000-0000-0000-0000-000000000001'::uuid,
    '10000000-0000-0000-0000-000000000002'::uuid,
    '10000000-0000-0000-0000-000000000003'::uuid,
    1,1,1,1,'series-1','{"episodes":[]}'::jsonb
  )$$,
  '40001',
  'catalog delete proof CAS failed',
  'a stale or foreign generation fence is rejected before series mutation'
);
reset role;

select extensions.ok(
  pg_get_functiondef('public.heal_cloud_title_variants(uuid,uuid,uuid,bigint,bigint,bigint,bigint)'::regprocedure)
    like '%on conflict (source_id,generation_id,item_type,external_id)%',
  'variant heal uses the generation-compatible conflict key'
);

select extensions.ok(
  pg_get_functiondef('public.propagate_media_item_years(uuid,uuid,uuid[],uuid,bigint,bigint,bigint,bigint)'::regprocedure)
    like '%item.generation_id=p_generation_id%'
  and pg_get_functiondef('public.propagate_media_item_years(uuid,uuid,uuid[],uuid,bigint,bigint,bigint,bigint)'::regprocedure)
    like '%write_head_revision=p_head_revision%',
  'year propagation cannot update another generation and carries ABA proof'
);

select extensions.ok(
  pg_get_functiondef('public.norva_hydrate_source_category_names(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,integer)'::regprocedure)
    like '%donor.generation_id=donor_head.active_generation_id%'
  and pg_get_functiondef('public.norva_hydrate_source_category_names(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,integer)'::regprocedure)
    like '%item.generation_id=p_generation_id%',
  'category hydration reads donor heads and writes only its fenced generation'
);

select extensions.ok(
  not has_function_privilege('anon','public.heal_cloud_title_variants(uuid,uuid,uuid,bigint,bigint,bigint,bigint)','EXECUTE')
  and not has_function_privilege('authenticated','public.heal_cloud_title_variants(uuid,uuid,uuid,bigint,bigint,bigint,bigint)','EXECUTE'),
  'fenced maintenance overloads remain service-only'
);

select extensions.ok(
  to_regprocedure('public.norva_complete_credential_transition(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)') is not null
  and position('state = ''completed''' in pg_get_functiondef(
    'public.norva_complete_credential_transition(uuid,uuid,uuid,text,integer,bigint,bigint,uuid)'::regprocedure))>0,
  'healthy post-switch completion boundary remains installed'
);

select extensions.ok(
  has_function_privilege('authenticated',
    'public.admin_enrichment_engine_health()','EXECUTE')
  and pg_get_functiondef(
    'public.admin_enrichment_engine_health()'::regprocedure)
      like '%affinity.affinity_hash as provider_account_key%'
  and pg_get_functiondef(
    'public.admin_enrichment_engine_health()'::regprocedure)
      like '%variant.generation_id = variant_head.active_generation_id%'
  and pg_get_functiondef(
    'public.admin_enrichment_engine_health()'::regprocedure)
      like '%membership_head.active_generation_id = membership.generation_id%'
  and pg_get_functiondef(
    'public.admin_enrichment_engine_health()'::regprocedure)
      not like '%config_hint->>''username''%',
  'admin health keeps its contract while using opaque affinity and active heads'
);

select extensions.ok(
  not has_function_privilege('service_role',
    'public.norva_reset_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer)',
    'EXECUTE')
  and has_function_privilege('service_role',
    'public.norva_clear_catalog_generation_live_materialization(uuid,uuid,uuid,bigint,bigint,bigint,bigint)',
    'EXECUTE')
  and has_function_privilege('service_role',
    'public.norva_clear_catalog_generation_live_materialization_batch(uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer)',
    'EXECUTE')
  and pg_get_functiondef(
    'public.norva_clear_catalog_generation_live_materialization_batch(uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer)'::regprocedure)
      like '%v_budget:=p_limit%'
  and pg_get_functiondef(
    'public.norva_clear_catalog_generation_live_materialization_batch(uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer)'::regprocedure)
      like '%limit v_budget%',
  'unused reset is disabled while both live-clear protocols coexist for rolling deployment'
);

select extensions.ok(
  pg_get_functiondef(
    'public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)'::regprocedure)
      like '%v_budget:=p_limit%'
  and pg_get_functiondef(
    'public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)'::regprocedure)
      like '%v_budget:=v_budget-v_count%'
  and pg_get_functiondef(
    'public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)'::regprocedure)
      not like '%count(*)%',
  'terminal generation purge uses one global budget and indexed existence probes'
);

select extensions.is(
  encode(extensions.digest(
    lower(btrim(' Provider.EXAMPLE:443 ')) || '/' || btrim(' UserCase '),
    'sha256'),'hex'),
  encode(extensions.digest('provider.example:443/UserCase','sha256'),'hex'),
  'legacy source affinity canonicalization matches Edge host and username trimming exactly'
);

select extensions.is(
  (select count(*)::integer
   from unnest(array[
     'finalize_catalog_file_audio_validation_job',
     'catalog_series_episode_coordinates_by_episode',
     'record_catalog_file_container_observation',
     'record_catalog_file_audio_whisper_outcome',
     'catalog_episode_probe_retry_state','record_catalog_episode_probe_outcome',
     'whitelist_subtitle_candidates','file_audio_tag_suspect_variants',
     'file_whisper_candidate_variants','whisper_candidate_titles',
     'audio_backfill_candidates','file_audio_backfill_candidates',
     'catalog_media_mirror_diff','fanout_episode_file_tracks_to_users',
     'fanout_detected_file_tracks_to_users','fanout_file_tracks_to_users',
     'refresh_catalog_file_audio_detection_provenance',
     'fill_user_audio_from_catalog','search_media_items',
     'list_media_items_deduped','merge_cloud_title_file_languages',
     'top_viewed_titles','upsert_cloud_title_rating_cas',
     'claim_catalog_enrichment_sources','record_provider_overview_outcome',
     'claim_provider_overview_candidates','norva_resolve_provider_identity'
   ]::text[]) required(name)
   where not exists (
     select 1 from pg_proc proc
     where proc.pronamespace='public'::regnamespace
       and proc.proname=required.name::name
       and has_function_privilege('service_role',proc.oid,'EXECUTE')
   )),
  0,
  'every literal and dynamic current product RPC name retains a service-executable signature'
);

select extensions.ok(
  not exists(select 1 from public.admin_feature_flags
    where key in ('provider_credential_transition_v1_enabled','provider_replacement_v1_enabled')
      and enabled)
  and pg_get_functiondef(
    'public.fanout_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean)'::regprocedure)
      like '%legacy catalog writer disabled after generation activation%'
  and pg_get_functiondef(
    'public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb)'::regprocedure)
      like '%legacy catalog writer disabled after generation activation%'
  and pg_get_functiondef(
    'public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz)'::regprocedure)
      like '%legacy catalog writer disabled after generation activation%',
  'rolling legacy writers are service-compatible only while both Phase 3 flags remain OFF'
);

select extensions.is(
  (select count(*)::integer from pg_proc proc
   where proc.pronamespace='public'::regnamespace
     and position('legacy catalog writer disabled after generation activation' in proc.prosrc)>0),
  3,
  'only the three rolling physical-writer signatures retain a flags-OFF guard'
);

select extensions.ok(
  pg_get_functiondef('public.norva_resolve_provider_identity(uuid,text,text,text)'::regprocedure)
    like '%cloud_catalog_visible_media_items%'
  and pg_get_functiondef('public.merge_cloud_title_file_languages(uuid,uuid,uuid,text,jsonb,jsonb,boolean,boolean)'::regprocedure)
    like '%cloud_catalog_visible_title_variants%'
  and pg_get_functiondef('public.claim_catalog_enrichment_sources(integer,integer)'::regprocedure)
    like '%cloud_catalog_visible_title_variants%'
  and pg_get_functiondef('public.record_catalog_episode_probe_outcome(uuid,uuid,uuid,text,boolean,integer,text,text,timestamptz)'::regprocedure)
    like '%cloud_catalog_visible_series_episode_memberships%'
  and pg_get_functiondef('public.upsert_cloud_title_rating_cas(uuid,uuid,uuid,uuid,text,text,smallint,uuid,bigint,boolean)'::regprocedure)
    like '%cloud_catalog_visible_title_variants%'
  and pg_get_functiondef('public.upsert_cloud_title_rating_cas(uuid,uuid,uuid,uuid,text,text,smallint,uuid,bigint,boolean)'::regprocedure)
    not like '%legacy catalog writer disabled after generation activation%',
  'logical-ledger writers retain exact signatures and read only active visible generations'
);

select extensions.ok(
  has_function_privilege('service_role',
    'public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb,uuid,bigint,bigint,bigint,bigint)','EXECUTE')
  and has_function_privilege('service_role',
    'public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint)','EXECUTE')
  and has_function_privilege('service_role',
    'public.norva_fanout_file_tracks_to_users_fenced(text,text,text,jsonb,jsonb,boolean,boolean)','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.norva_fanout_file_tracks_to_users_fenced(text,text,text,jsonb,jsonb,boolean,boolean)','EXECUTE'),
  'all three contracted physical-writer replacements are service-only'
);

select extensions.ok(
  pg_get_functiondef('public.norva_fanout_file_tracks_to_users_fenced(text,text,text,jsonb,jsonb,boolean,boolean)'::regprocedure)
    like '%head.active_generation_id=variant.generation_id%'
  and pg_get_functiondef('public.norva_fanout_file_tracks_to_users_fenced(text,text,text,jsonb,jsonb,boolean,boolean)'::regprocedure)
    like '%write_head_revision=v_owner.head_revision%'
  and pg_get_functiondef('public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb,uuid,bigint,bigint,bigint,bigint)'::regprocedure)
    like '%norva_set_catalog_delete_proof%'
  and pg_get_functiondef('public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint)'::regprocedure)
    like '%norva_set_catalog_delete_proof%',
  'physical-writer replacements carry atomic head/config/visibility proofs'
);

set local role service_role;
select extensions.throws_ok(
  $$select public.record_provider_overview_outcome(
    gen_random_uuid(),gen_random_uuid(),'x',null,null,null,'missing',null,'{}'::jsonb,
    gen_random_uuid(),1,1,1,1)$$,
  '40001','catalog delete proof CAS failed',
  'stale overview writer proof is rejected before any legacy body runs'
);
select extensions.throws_ok(
  $$select public.record_catalog_file_container_observation(
    gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'movie','x','mkv','mp4',
    '{}'::jsonb,gen_random_uuid(),clock_timestamp(),gen_random_uuid(),1,1,1,1)$$,
  '40001','catalog delete proof CAS failed',
  'stale container writer proof is rejected before any legacy body runs'
);
select extensions.throws_ok(
  $$select public.record_catalog_file_container_observation(
    gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'movie','x','mkv','mp4',
    '{}'::jsonb,null,null,gen_random_uuid(),1,1,1,1)$$,
  '22023','container observation item CAS is required',
  'container mismatch without the playback item CAS fails before catalog mutation'
);
reset role;

select * from extensions.finish();
rollback;
