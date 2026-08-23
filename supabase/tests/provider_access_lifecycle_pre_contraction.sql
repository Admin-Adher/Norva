-- Historical migration acceptance harness: run only after
-- 20260823179920_catalog_generation_flag_gate.sql.  The raw fixture is loaded
-- by the orchestrator at its declared pre-20260823120000 boundary; loading it
-- here would incorrectly require modern write guards to accept legacy rows.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.no_plan();

select extensions.ok(
  to_regprocedure(
    'public.norva_contract_catalog_generation_rollout(text)'
  ) is null,
  'the contraction function is absent at the pre-contraction boundary'
);

select extensions.is(
  (select count(*)::integer from public.cloud_sources
   where id = '22222222-2222-2222-2222-222222222222'),
  1,
  'the unchanged historical source fixture is present'
);

select extensions.is(
  (select count(*)::integer from public.cloud_media_items
   where source_id = '22222222-2222-2222-2222-222222222222'),
  2,
  'the two historical media rows are retained before contraction'
);

select extensions.is(
  (select count(*)::integer from public.cloud_title_variants
   where source_id = '22222222-2222-2222-2222-222222222222'),
  1,
  'the historical title variant is retained before contraction'
);

select extensions.is(
  (select count(*)::integer from public.cloud_live_logical_channels
   where source_id = '22222222-2222-2222-2222-222222222222'),
  1,
  'the historical logical live channel is retained before contraction'
);

select extensions.is(
  (select count(*)::integer from public.cloud_live_variants
   where source_id = '22222222-2222-2222-2222-222222222222'),
  1,
  'the historical live variant is retained before contraction'
);

select extensions.is(
  (select count(*)::integer from public.catalog_series_episode_memberships
   where source_id = '22222222-2222-2222-2222-222222222222'),
  1,
  'the historical series membership is retained before contraction'
);

select extensions.is(
  (select count(*)::integer from public.catalog_series_inventory_state
   where source_id = '22222222-2222-2222-2222-222222222222'),
  1,
  'the historical series inventory is retained before contraction'
);

select extensions.is(
  (select count(*)::integer from public.cloud_source_catalog_generations
   where source_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'legacy rows have not received a generation before durable backfill'
);

select extensions.is(
  (select count(*)::integer from public.cloud_source_catalog_heads
   where source_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'legacy source has no generation head before durable backfill'
);

select extensions.is(
  (select count(*)::integer from public.admin_feature_flags
   where key in (
     'provider_access_v1_enabled',
     'provider_access_auto_detection_v1_enabled',
     'provider_access_notifications_v1_enabled',
     'provider_access_visibility_v1_enabled',
     'provider_credential_transition_v1_enabled',
     'provider_replacement_v1_enabled'
   ) and not enabled),
  6,
  'all provider access flags are off before contraction'
);

select * from extensions.finish();
rollback;
