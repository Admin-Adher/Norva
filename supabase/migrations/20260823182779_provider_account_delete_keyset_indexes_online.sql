-- Standalone online-index unit.  Supabase CLI 2.115 executes every CREATE
-- INDEX CONCURRENTLY below outside a migration transaction.  Each statement
-- is independently replayable; an interrupted run resumes through IF NOT
-- EXISTS without holding table write locks for the rest of the file.
set lock_timeout = '2s';
set statement_timeout = '60min';

-- CREATE INDEX CONCURRENTLY can leave an invalid catalog entry if its backend
-- is cancelled.  Quarantine only an exact-shape, table-owned invalid homonym;
-- the top-level concurrent drops below then make the replay self-healing.
do $repair_preflight$
declare
  v_expected record;
  v_index_oid oid;
  v_index_relation oid;
  v_index_owner oid;
  v_table_owner oid;
  v_index_columns text[];
  v_valid boolean;
  v_ready boolean;
  v_live boolean;
  v_predicate pg_node_tree;
  v_expressions pg_node_tree;
  v_access_method text;
  v_quarantine text;
begin
  for v_expected in
    select * from (values
      ('norva_adk_36a9098fc220_idx','public.catalog_series_episode_memberships'::regclass,array['generation_id','source_id','parent_series_id','episode_id']::text[]),
      ('norva_adk_356ae6f37e6b_idx','public.catalog_series_inventory_state'::regclass,array['generation_id','source_id','parent_series_id']::text[]),
      ('norva_adk_029f5ed82d38_idx','public.cloud_catalog_background_owner_build_jobs'::regclass,array['user_id','id']::text[]),
      ('norva_adk_253314ae39dc_idx','public.cloud_catalog_background_owner_snapshot_rows'::regclass,array['user_id','snapshot_id','title_id']::text[]),
      ('norva_adk_72ffafd1d34e_idx','public.cloud_catalog_background_owner_snapshot_sources'::regclass,array['user_id','snapshot_id','source_id']::text[]),
      ('norva_adk_b9ae82fcec50_idx','public.cloud_gateway_sessions'::regclass,array['user_id','id']::text[]),
      ('norva_adk_f84b1752619a_idx','public.cloud_live_logical_channels'::regclass,array['generation_id','id']::text[]),
      ('norva_adk_3c469a925c1b_idx','public.cloud_live_variants'::regclass,array['generation_id','id']::text[]),
      ('norva_adk_0c64e7194b8e_idx','public.cloud_media_items'::regclass,array['generation_id','id']::text[]),
      ('norva_adk_754c3e36f96c_idx','public.cloud_playback_sessions'::regclass,array['user_id','id']::text[]),
      ('norva_adk_92cf96fb5746_idx','public.cloud_relay_tokens'::regclass,array['user_id','id']::text[]),
      ('norva_adk_2846b553cabe_idx','public.cloud_source_catalog_generation_candidate_titles'::regclass,array['user_id','generation_id','title_id']::text[]),
      ('norva_adk_5107325c9c80_idx','public.cloud_source_catalog_generation_categories'::regclass,array['user_id','generation_id','category_kind','category_ordinal']::text[]),
      ('norva_adk_d3d366bec290_idx','public.cloud_source_catalog_generation_category_lists'::regclass,array['user_id','generation_id','category_kind']::text[]),
      ('norva_adk_d0e850642871_idx','public.cloud_source_catalog_generation_episode_copy'::regclass,array['user_id','generation_id']::text[]),
      ('norva_adk_daf52acce296_idx','public.cloud_source_catalog_generation_inventory_actions'::regclass,array['user_id','generation_id','action_kind']::text[]),
      ('norva_adk_7a1d21784cee_idx','public.cloud_source_catalog_generation_title_promotions'::regclass,array['user_id','generation_id']::text[]),
      ('norva_adk_54bb383a1e39_idx','public.cloud_source_catalog_heads'::regclass,array['user_id','source_id']::text[]),
      ('norva_adk_9da3c5730d12_idx','public.cloud_source_catalog_manifest_seal_progress'::regclass,array['user_id','generation_id']::text[]),
      ('norva_adk_06f31b9c86fd_idx','public.cloud_source_catalog_title_refresh_actions'::regclass,array['user_id','refresh_run_id','action_kind']::text[]),
      ('norva_adk_307bb3096fd7_idx','public.cloud_source_catalog_title_refresh_checkpoints'::regclass,array['user_id','job_id']::text[]),
      ('norva_adk_94822b63a498_idx','public.cloud_source_credential_transition_actions'::regclass,array['user_id','id']::text[]),
      ('norva_adk_dd56f9311951_idx','public.cloud_source_credential_transition_jobs'::regclass,array['user_id','id']::text[]),
      ('norva_adk_fb4c7abc3e32_idx','public.cloud_source_direct_fallback_leases'::regclass,array['user_id','affinity_hash']::text[]),
      ('norva_adk_7e83f1d4fb88_idx','public.cloud_source_lifecycle'::regclass,array['user_id','source_id']::text[]),
      ('norva_adk_06843b21346b_idx','public.cloud_source_lifecycle_events'::regclass,array['user_id','id']::text[]),
      ('norva_adk_39b47111ca31_idx','public.cloud_source_provider_access'::regclass,array['user_id','source_id']::text[]),
      ('norva_adk_1856d488679a_idx','public.cloud_title_overrides'::regclass,array['user_id','id']::text[]),
      ('norva_adk_0bb43efbf6fb_idx','public.cloud_title_rating_operations'::regclass,array['user_id','operation_id']::text[]),
      ('norva_adk_69a22c3e4994_idx','public.cloud_title_ratings'::regclass,array['user_id','id']::text[]),
      ('norva_adk_d484ff57e31b_idx','public.cloud_title_variants'::regclass,array['generation_id','id']::text[]),
      ('norva_adk_ae6f5449736b_idx','public.cloud_favorites'::regclass,array['user_id','id']::text[]),
      ('norva_source_reap_media_idx','public.cloud_media_items'::regclass,array['source_id','id']::text[]),
      ('norva_source_reap_title_variant_idx','public.cloud_title_variants'::regclass,array['source_id','id']::text[]),
      ('norva_source_reap_live_variant_idx','public.cloud_live_variants'::regclass,array['source_id','id']::text[]),
      ('norva_source_reap_live_logical_idx','public.cloud_live_logical_channels'::regclass,array['source_id','id']::text[]),
      ('norva_source_reap_title_override_idx','public.cloud_title_overrides'::regclass,array['source_id','id']::text[]),
      ('norva_source_reap_favorite_idx','public.cloud_favorites'::regclass,array['source_id','id']::text[])
      ,('norva_adk_0e52c3ee7f31_idx','public.catalog_enrichment_source_schedule'::regclass,array['user_id','source_id']::text[])
      ,('norva_adk_2f1fb6c12764_idx','public.catalog_file_audio_validation_jobs'::regclass,array['source_id','id']::text[])
      ,('norva_adk_47802fdaed02_idx','public.catalog_provider_inventory_backoff'::regclass,array['source_id']::text[])
      ,('norva_adk_a1cfb0c4de1a_idx','public.catalog_source_provider_identities'::regclass,array['user_id','source_id']::text[])
      ,('norva_adk_f16aa193fb32_idx','public.cloud_playback_events'::regclass,array['user_id','id']::text[])
      ,('norva_adk_b7f41c9c0b8a_idx','public.cloud_watch_history'::regclass,array['user_id','id']::text[])
      ,('norva_adk_variant_probe_idx','public.catalog_episode_probe_state'::regclass,array['variant_id','provider_identity_id','episode_id']::text[])
      ,('norva_adk_variant_audio_job_idx','public.catalog_file_audio_validation_jobs'::regclass,array['variant_id','id']::text[])
      ,('norva_adk_variant_language_obs_idx','public.cloud_title_file_language_observations'::regclass,array['variant_id','user_id','file_external_id']::text[])
      ,('norva_source_reap_playback_idx','public.cloud_playback_sessions'::regclass,array['source_id','id']::text[])
      ,('norva_source_reap_gateway_playback_idx','public.cloud_gateway_sessions'::regclass,array['playback_session_id','id']::text[])
      ,('norva_source_reap_fallback_idx','public.cloud_source_direct_fallback_leases'::regclass,array['source_id','affinity_hash']::text[])
      ,('norva_adk_playback_relay_idx','public.cloud_relay_tokens'::regclass,array['playback_session_id','id']::text[])
      ,('norva_adk_playback_event_idx','public.cloud_playback_events'::regclass,array['playback_session_id','id']::text[])
      ,('norva_adk_playback_paywall_idx','public.paywall_funnel_events'::regclass,array['playback_event_id','id']::text[])
    ) expected(index_name,relation_name,key_columns)
  loop
    -- A prior repair run may have committed the rename but crashed before the
    -- standalone concurrent DROP.  Only that exact invalid artifact is safe
    -- to remove.  A valid or wrong-shape `_invalid` index is user/catalog
    -- state, never repair scratch: fail closed before any top-level DROP runs.
    v_quarantine := v_expected.index_name || '_invalid';
    select index_class.oid,index_state.indrelid,index_class.relowner,
      table_class.relowner,index_state.indisvalid,index_state.indisready,
      index_state.indislive,index_state.indpred,index_state.indexprs,
      access_method.amname
    into v_index_oid,v_index_relation,v_index_owner,v_table_owner,
      v_valid,v_ready,v_live,v_predicate,v_expressions,v_access_method
    from pg_catalog.pg_class index_class
    join pg_catalog.pg_namespace namespace_state
      on namespace_state.oid = index_class.relnamespace
    left join pg_catalog.pg_index index_state
      on index_state.indexrelid = index_class.oid
    left join pg_catalog.pg_class table_class
      on table_class.oid = index_state.indrelid
    left join pg_catalog.pg_am access_method
      on access_method.oid = index_class.relam
    where namespace_state.nspname = 'public'
      and index_class.relname = v_quarantine;
    if found then
      select pg_catalog.array_agg(
        attribute.attname::text order by key_column.ordinality
      )
      into v_index_columns
      from pg_catalog.pg_index index_state
      join lateral pg_catalog.unnest(index_state.indkey)
        with ordinality key_column(attnum,ordinality) on true
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = index_state.indrelid
       and attribute.attnum = key_column.attnum
      where index_state.indexrelid = v_index_oid;
      if v_index_relation is distinct from v_expected.relation_name
         or v_index_owner is distinct from v_table_owner
         or v_access_method is distinct from 'btree'
         or v_predicate is not null or v_expressions is not null
         or v_index_columns is distinct from v_expected.key_columns
         or (v_valid is true and v_ready is true and v_live is true) then
        raise exception 'account-delete invalid-index quarantine is not repair scratch: %',
          v_quarantine using errcode = '55000';
      end if;
    end if;

    select index_class.oid,index_state.indrelid,index_class.relowner,
      table_class.relowner,index_state.indisvalid,index_state.indisready,
      index_state.indislive,index_state.indpred,index_state.indexprs,
      access_method.amname
    into v_index_oid,v_index_relation,v_index_owner,v_table_owner,
      v_valid,v_ready,v_live,v_predicate,v_expressions,v_access_method
    from pg_catalog.pg_class index_class
    join pg_catalog.pg_namespace namespace_state
      on namespace_state.oid = index_class.relnamespace
    left join pg_catalog.pg_index index_state
      on index_state.indexrelid = index_class.oid
    left join pg_catalog.pg_class table_class
      on table_class.oid = index_state.indrelid
    left join pg_catalog.pg_am access_method
      on access_method.oid = index_class.relam
    where namespace_state.nspname = 'public'
      and index_class.relname = v_expected.index_name;
    if not found then
      continue;
    end if;
    select pg_catalog.array_agg(attribute.attname::text order by key_column.ordinality)
    into v_index_columns
    from pg_catalog.pg_index index_state
    join lateral pg_catalog.unnest(index_state.indkey)
      with ordinality key_column(attnum,ordinality) on true
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = index_state.indrelid
     and attribute.attnum = key_column.attnum
    where index_state.indexrelid = v_index_oid;
    if v_index_relation is distinct from v_expected.relation_name
       or v_index_owner is distinct from v_table_owner
       or v_access_method is distinct from 'btree'
       or v_predicate is not null or v_expressions is not null
       or v_index_columns is distinct from v_expected.key_columns then
      raise exception 'account-delete index homonym is noncanonical: %',
        v_expected.index_name using errcode = '55000';
    end if;
    if not v_valid or not v_ready or not v_live then
      if to_regclass('public.' || v_quarantine) is not null then
        raise exception 'account-delete invalid-index quarantine collision: %',
          v_quarantine using errcode = '55000';
      end if;
      execute pg_catalog.format(
        'alter index public.%I rename to %I',
        v_expected.index_name,v_quarantine
      );
    end if;
  end loop;
end
$repair_preflight$;

drop index concurrently if exists public.norva_adk_36a9098fc220_idx_invalid;
drop index concurrently if exists public.norva_adk_356ae6f37e6b_idx_invalid;
drop index concurrently if exists public.norva_adk_029f5ed82d38_idx_invalid;
drop index concurrently if exists public.norva_adk_253314ae39dc_idx_invalid;
drop index concurrently if exists public.norva_adk_72ffafd1d34e_idx_invalid;
drop index concurrently if exists public.norva_adk_b9ae82fcec50_idx_invalid;
drop index concurrently if exists public.norva_adk_f84b1752619a_idx_invalid;
drop index concurrently if exists public.norva_adk_3c469a925c1b_idx_invalid;
drop index concurrently if exists public.norva_adk_0c64e7194b8e_idx_invalid;
drop index concurrently if exists public.norva_adk_754c3e36f96c_idx_invalid;
drop index concurrently if exists public.norva_adk_92cf96fb5746_idx_invalid;
drop index concurrently if exists public.norva_adk_2846b553cabe_idx_invalid;
drop index concurrently if exists public.norva_adk_5107325c9c80_idx_invalid;
drop index concurrently if exists public.norva_adk_d3d366bec290_idx_invalid;
drop index concurrently if exists public.norva_adk_d0e850642871_idx_invalid;
drop index concurrently if exists public.norva_adk_daf52acce296_idx_invalid;
drop index concurrently if exists public.norva_adk_7a1d21784cee_idx_invalid;
drop index concurrently if exists public.norva_adk_54bb383a1e39_idx_invalid;
drop index concurrently if exists public.norva_adk_9da3c5730d12_idx_invalid;
drop index concurrently if exists public.norva_adk_06f31b9c86fd_idx_invalid;
drop index concurrently if exists public.norva_adk_307bb3096fd7_idx_invalid;
drop index concurrently if exists public.norva_adk_94822b63a498_idx_invalid;
drop index concurrently if exists public.norva_adk_dd56f9311951_idx_invalid;
drop index concurrently if exists public.norva_adk_fb4c7abc3e32_idx_invalid;
drop index concurrently if exists public.norva_adk_7e83f1d4fb88_idx_invalid;
drop index concurrently if exists public.norva_adk_06843b21346b_idx_invalid;
drop index concurrently if exists public.norva_adk_39b47111ca31_idx_invalid;
drop index concurrently if exists public.norva_adk_1856d488679a_idx_invalid;
drop index concurrently if exists public.norva_adk_0bb43efbf6fb_idx_invalid;
drop index concurrently if exists public.norva_adk_69a22c3e4994_idx_invalid;
drop index concurrently if exists public.norva_adk_d484ff57e31b_idx_invalid;
drop index concurrently if exists public.norva_adk_ae6f5449736b_idx_invalid;
drop index concurrently if exists public.norva_source_reap_media_idx_invalid;
drop index concurrently if exists public.norva_source_reap_title_variant_idx_invalid;
drop index concurrently if exists public.norva_source_reap_live_variant_idx_invalid;
drop index concurrently if exists public.norva_source_reap_live_logical_idx_invalid;
drop index concurrently if exists public.norva_source_reap_title_override_idx_invalid;
drop index concurrently if exists public.norva_source_reap_favorite_idx_invalid;
drop index concurrently if exists public.norva_adk_0e52c3ee7f31_idx_invalid;
drop index concurrently if exists public.norva_adk_2f1fb6c12764_idx_invalid;
drop index concurrently if exists public.norva_adk_47802fdaed02_idx_invalid;
drop index concurrently if exists public.norva_adk_a1cfb0c4de1a_idx_invalid;
drop index concurrently if exists public.norva_adk_f16aa193fb32_idx_invalid;
drop index concurrently if exists public.norva_adk_b7f41c9c0b8a_idx_invalid;
drop index concurrently if exists public.norva_adk_variant_probe_idx_invalid;
drop index concurrently if exists public.norva_adk_variant_audio_job_idx_invalid;
drop index concurrently if exists public.norva_adk_variant_language_obs_idx_invalid;
drop index concurrently if exists public.norva_source_reap_playback_idx_invalid;
drop index concurrently if exists public.norva_source_reap_gateway_playback_idx_invalid;
drop index concurrently if exists public.norva_source_reap_fallback_idx_invalid;
drop index concurrently if exists public.norva_adk_playback_relay_idx_invalid;
drop index concurrently if exists public.norva_adk_playback_event_idx_invalid;
drop index concurrently if exists public.norva_adk_playback_paywall_idx_invalid;

create index concurrently if not exists norva_adk_36a9098fc220_idx on public.catalog_series_episode_memberships (generation_id,source_id,parent_series_id,episode_id);
create index concurrently if not exists norva_adk_356ae6f37e6b_idx on public.catalog_series_inventory_state (generation_id,source_id,parent_series_id);
create index concurrently if not exists norva_adk_029f5ed82d38_idx on public.cloud_catalog_background_owner_build_jobs (user_id,id);
create index concurrently if not exists norva_adk_253314ae39dc_idx on public.cloud_catalog_background_owner_snapshot_rows (user_id,snapshot_id,title_id);
create index concurrently if not exists norva_adk_72ffafd1d34e_idx on public.cloud_catalog_background_owner_snapshot_sources (user_id,snapshot_id,source_id);
create index concurrently if not exists norva_adk_b9ae82fcec50_idx on public.cloud_gateway_sessions (user_id,id);
create index concurrently if not exists norva_adk_f84b1752619a_idx on public.cloud_live_logical_channels (generation_id,id);
create index concurrently if not exists norva_adk_3c469a925c1b_idx on public.cloud_live_variants (generation_id,id);
create index concurrently if not exists norva_adk_0c64e7194b8e_idx on public.cloud_media_items (generation_id,id);
create index concurrently if not exists norva_adk_754c3e36f96c_idx on public.cloud_playback_sessions (user_id,id);
create index concurrently if not exists norva_adk_92cf96fb5746_idx on public.cloud_relay_tokens (user_id,id);
create index concurrently if not exists norva_adk_2846b553cabe_idx on public.cloud_source_catalog_generation_candidate_titles (user_id,generation_id,title_id);
create index concurrently if not exists norva_adk_5107325c9c80_idx on public.cloud_source_catalog_generation_categories (user_id,generation_id,category_kind,category_ordinal);
create index concurrently if not exists norva_adk_d3d366bec290_idx on public.cloud_source_catalog_generation_category_lists (user_id,generation_id,category_kind);
create index concurrently if not exists norva_adk_d0e850642871_idx on public.cloud_source_catalog_generation_episode_copy (user_id,generation_id);
create index concurrently if not exists norva_adk_daf52acce296_idx on public.cloud_source_catalog_generation_inventory_actions (user_id,generation_id,action_kind);
create index concurrently if not exists norva_adk_7a1d21784cee_idx on public.cloud_source_catalog_generation_title_promotions (user_id,generation_id);
create index concurrently if not exists norva_adk_54bb383a1e39_idx on public.cloud_source_catalog_heads (user_id,source_id);
create index concurrently if not exists norva_adk_9da3c5730d12_idx on public.cloud_source_catalog_manifest_seal_progress (user_id,generation_id);
create index concurrently if not exists norva_adk_06f31b9c86fd_idx on public.cloud_source_catalog_title_refresh_actions (user_id,refresh_run_id,action_kind);
create index concurrently if not exists norva_adk_307bb3096fd7_idx on public.cloud_source_catalog_title_refresh_checkpoints (user_id,job_id);
create index concurrently if not exists norva_adk_94822b63a498_idx on public.cloud_source_credential_transition_actions (user_id,id);
create index concurrently if not exists norva_adk_dd56f9311951_idx on public.cloud_source_credential_transition_jobs (user_id,id);
create index concurrently if not exists norva_adk_fb4c7abc3e32_idx on public.cloud_source_direct_fallback_leases (user_id,affinity_hash);
create index concurrently if not exists norva_adk_7e83f1d4fb88_idx on public.cloud_source_lifecycle (user_id,source_id);
create index concurrently if not exists norva_adk_06843b21346b_idx on public.cloud_source_lifecycle_events (user_id,id);
create index concurrently if not exists norva_adk_39b47111ca31_idx on public.cloud_source_provider_access (user_id,source_id);
create index concurrently if not exists norva_adk_1856d488679a_idx on public.cloud_title_overrides (user_id,id);
create index concurrently if not exists norva_adk_0bb43efbf6fb_idx on public.cloud_title_rating_operations (user_id,operation_id);
create index concurrently if not exists norva_adk_69a22c3e4994_idx on public.cloud_title_ratings (user_id,id);
create index concurrently if not exists norva_adk_d484ff57e31b_idx on public.cloud_title_variants (generation_id,id);
create index concurrently if not exists norva_adk_ae6f5449736b_idx on public.cloud_favorites (user_id,id);

-- Source reaping uses the same bounded, index-first shape.  Deleted rows are
-- themselves the durable cursor, so every retry starts at the next live key.
create index concurrently if not exists norva_source_reap_media_idx on public.cloud_media_items (source_id,id);
create index concurrently if not exists norva_source_reap_title_variant_idx on public.cloud_title_variants (source_id,id);
create index concurrently if not exists norva_source_reap_live_variant_idx on public.cloud_live_variants (source_id,id);
create index concurrently if not exists norva_source_reap_live_logical_idx on public.cloud_live_logical_channels (source_id,id);
create index concurrently if not exists norva_source_reap_title_override_idx on public.cloud_title_overrides (source_id,id);
create index concurrently if not exists norva_source_reap_favorite_idx on public.cloud_favorites (source_id,id);
create index concurrently if not exists norva_adk_0e52c3ee7f31_idx on public.catalog_enrichment_source_schedule (user_id,source_id);
create index concurrently if not exists norva_adk_2f1fb6c12764_idx on public.catalog_file_audio_validation_jobs (source_id,id);
create index concurrently if not exists norva_adk_47802fdaed02_idx on public.catalog_provider_inventory_backoff (source_id);
create index concurrently if not exists norva_adk_a1cfb0c4de1a_idx on public.catalog_source_provider_identities (user_id,source_id);
create index concurrently if not exists norva_adk_f16aa193fb32_idx on public.cloud_playback_events (user_id,id);
create index concurrently if not exists norva_adk_b7f41c9c0b8a_idx on public.cloud_watch_history (user_id,id);
create index concurrently if not exists norva_adk_variant_probe_idx on public.catalog_episode_probe_state (variant_id,provider_identity_id,episode_id);
create index concurrently if not exists norva_adk_variant_audio_job_idx on public.catalog_file_audio_validation_jobs (variant_id,id);
create index concurrently if not exists norva_adk_variant_language_obs_idx on public.cloud_title_file_language_observations (variant_id,user_id,file_external_id);
create index concurrently if not exists norva_source_reap_playback_idx on public.cloud_playback_sessions (source_id,id);
create index concurrently if not exists norva_source_reap_gateway_playback_idx on public.cloud_gateway_sessions (playback_session_id,id);
create index concurrently if not exists norva_source_reap_fallback_idx on public.cloud_source_direct_fallback_leases (source_id,affinity_hash);
create index concurrently if not exists norva_adk_playback_relay_idx on public.cloud_relay_tokens (playback_session_id,id);
create index concurrently if not exists norva_adk_playback_event_idx on public.cloud_playback_events (playback_session_id,id);
create index concurrently if not exists norva_adk_playback_paywall_idx on public.paywall_funnel_events (playback_event_id,id);

do $postcondition$
declare
  v_missing text;
begin
  with wanted(relation_name,filter_column) as (
    values
      ('public.catalog_series_episode_memberships'::regclass,'generation_id'),
      ('public.catalog_series_episode_memberships'::regclass,'source_id'),
      ('public.catalog_series_inventory_state'::regclass,'generation_id'),
      ('public.catalog_series_inventory_state'::regclass,'source_id'),
      ('public.catalog_episode_probe_state'::regclass,'variant_id'),
      ('public.catalog_enrichment_source_schedule'::regclass,'user_id'),
      ('public.catalog_file_audio_validation_jobs'::regclass,'source_id'),
      ('public.catalog_file_audio_validation_jobs'::regclass,'variant_id'),
      ('public.catalog_provider_inventory_backoff'::regclass,'source_id'),
      ('public.catalog_source_provider_identities'::regclass,'user_id'),
      ('public.cloud_catalog_background_owner_build_jobs'::regclass,'user_id'),
      ('public.cloud_catalog_background_owner_pointers'::regclass,'user_id'),
      ('public.cloud_catalog_background_owner_snapshot_rows'::regclass,'user_id'),
      ('public.cloud_catalog_background_owner_snapshot_sources'::regclass,'user_id'),
      ('public.cloud_catalog_background_owner_sync_fences'::regclass,'user_id'),
      ('public.cloud_catalog_background_owner_topology_revisions'::regclass,'user_id'),
      ('public.cloud_gateway_sessions'::regclass,'user_id'),
      ('public.cloud_gateway_sessions'::regclass,'playback_session_id'),
      ('public.cloud_favorites'::regclass,'user_id'),
      ('public.cloud_live_logical_channels'::regclass,'generation_id'),
      ('public.cloud_live_variants'::regclass,'generation_id'),
      ('public.cloud_media_items'::regclass,'generation_id'),
      ('public.cloud_playback_sessions'::regclass,'user_id'),
      ('public.cloud_playback_sessions'::regclass,'source_id'),
      ('public.cloud_playback_events'::regclass,'user_id'),
      ('public.cloud_playback_events'::regclass,'playback_session_id'),
      ('public.paywall_funnel_events'::regclass,'playback_event_id'),
      ('public.cloud_relay_tokens'::regclass,'user_id'),
      ('public.cloud_relay_tokens'::regclass,'playback_session_id'),
      ('public.cloud_source_access_cycles'::regclass,'user_id'),
      ('public.cloud_source_catalog_generation_candidate_titles'::regclass,'user_id'),
      ('public.cloud_source_catalog_generation_categories'::regclass,'user_id'),
      ('public.cloud_source_catalog_generation_category_lists'::regclass,'user_id'),
      ('public.cloud_source_catalog_generation_episode_copy'::regclass,'user_id'),
      ('public.cloud_source_catalog_generation_inventory_actions'::regclass,'user_id'),
      ('public.cloud_source_catalog_generation_title_promotions'::regclass,'user_id'),
      ('public.cloud_source_catalog_generations'::regclass,'user_id'),
      ('public.cloud_source_catalog_heads'::regclass,'user_id'),
      ('public.cloud_source_catalog_manifest_seal_progress'::regclass,'user_id'),
      ('public.cloud_source_catalog_title_refresh_actions'::regclass,'user_id'),
      ('public.cloud_source_catalog_title_refresh_checkpoints'::regclass,'user_id'),
      ('public.cloud_source_credential_transition_actions'::regclass,'user_id'),
      ('public.cloud_source_credential_transition_jobs'::regclass,'user_id'),
      ('public.cloud_source_direct_fallback_leases'::regclass,'user_id'),
      ('public.cloud_source_direct_fallback_leases'::regclass,'source_id'),
      ('public.cloud_source_identity_assessments'::regclass,'user_id'),
      ('public.cloud_source_lifecycle'::regclass,'user_id'),
      ('public.cloud_source_lifecycle_events'::regclass,'user_id'),
      ('public.cloud_source_provider_access'::regclass,'user_id'),
      ('public.cloud_source_transition_secrets'::regclass,'user_id'),
      ('public.cloud_source_transitions'::regclass,'user_id'),
      ('public.cloud_sources'::regclass,'user_id'),
      ('public.cloud_title_file_language_observations'::regclass,'user_id'),
      ('public.cloud_title_file_language_observations'::regclass,'variant_id'),
      ('public.cloud_title_overrides'::regclass,'user_id'),
      ('public.cloud_title_rating_operations'::regclass,'user_id'),
      ('public.cloud_title_ratings'::regclass,'user_id'),
      ('public.cloud_title_variants'::regclass,'generation_id'),
      ('public.cloud_titles'::regclass,'user_id')
      ,('public.cloud_watch_history'::regclass,'user_id')
      ,('public.cloud_media_items'::regclass,'source_id')
      ,('public.cloud_title_variants'::regclass,'source_id')
      ,('public.cloud_live_variants'::regclass,'source_id')
      ,('public.cloud_live_logical_channels'::regclass,'source_id')
      ,('public.cloud_title_overrides'::regclass,'source_id')
      ,('public.cloud_favorites'::regclass,'source_id')
  ), primary_keys as (
    select wanted.relation_name,wanted.filter_column,
      coalesce(array_agg(attribute.attname::text order by key_column.ordinality)
        filter (where attribute.attname is not null
          and attribute.attname::text <> wanted.filter_column),'{}'::text[]) as key_columns
    from wanted
    left join pg_catalog.pg_index primary_index
      on primary_index.indrelid = wanted.relation_name
     and primary_index.indisprimary
    left join lateral pg_catalog.unnest(primary_index.indkey)
      with ordinality key_column(attnum,ordinality) on true
    left join pg_catalog.pg_attribute attribute
      on attribute.attrelid = wanted.relation_name
     and attribute.attnum = key_column.attnum
    group by wanted.relation_name,wanted.filter_column
  )
  select pg_catalog.string_agg(primary_keys.relation_name::text,',')
  into v_missing
  from primary_keys
  where not exists (
    select 1
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_class
      on index_class.oid = index_state.indexrelid
    join pg_catalog.pg_am access_method
      on access_method.oid = index_class.relam
    where index_state.indrelid = primary_keys.relation_name
      and access_method.amname = 'btree'
      and index_state.indisvalid and index_state.indisready
      and index_state.indexprs is null and index_state.indpred is null
      and (
        select pg_catalog.array_agg(attribute.attname::text order by key_column.ordinality)
        from pg_catalog.unnest(index_state.indkey)
          with ordinality key_column(attnum,ordinality)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_state.indrelid
         and attribute.attnum = key_column.attnum
      )[1:1 + pg_catalog.cardinality(primary_keys.key_columns)]
        = array[primary_keys.filter_column]
          || primary_keys.key_columns
  );
  if v_missing is not null then
    raise exception 'provider account-delete keyset indexes are incomplete'
      using errcode = '55000',detail = 'relations=' || v_missing;
  end if;
end
$postcondition$;

reset lock_timeout;
reset statement_timeout;
