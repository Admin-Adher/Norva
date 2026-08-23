-- Post-contraction acceptance harness.  It deliberately performs no raw
-- catalogue write: all legacy rows were loaded before the generation fences
-- and were converted by the durable rollout.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select extensions.no_plan();

select extensions.ok(
  to_regprocedure(
    'public.norva_contract_catalog_generation_rollout(text)'
  ) is not null,
  'the contraction function is installed'
);

select extensions.ok(
  exists (
    select 1 from public.cloud_catalog_generation_rollout rollout
    where rollout.singleton
      and rollout.phase = 'contracted'
      and rollout.contracted_at is not null
      and rollout.contract_caller_protocol =
        'catalog-generation-writer-v2-live-clear-batch'
  ),
  'the catalog-generation rollout is terminally contracted'
);

select extensions.ok(
  public.norva_catalog_generation_constraints_canonical(true)
  and public.norva_catalog_generation_indexes_attached(),
  'the contracted generation metadata is canonical'
);

select extensions.is(
  (select count(*)::integer from public.cloud_source_catalog_generations generation
   where generation.source_id = '22222222-2222-2222-2222-222222222222'
     and generation.state = 'active'),
  1,
  'the historical source has one active generation after backfill'
);

select extensions.ok(
  exists (
    select 1
    from public.cloud_source_catalog_heads head
    join public.cloud_source_catalog_generations generation
      on generation.id = head.active_generation_id
    where head.source_id = '22222222-2222-2222-2222-222222222222'
      and generation.state = 'active'
  ),
  'the historical source head points at the active generation'
);

select extensions.is(
  (select count(*)::integer from public.cloud_catalog_generation_backfill_sources queue
   where queue.source_id = '22222222-2222-2222-2222-222222222222'
     and queue.state = 'complete'),
  1,
  'the historical source backfill reached its terminal state'
);

select extensions.is(
  (select count(*)::integer from public.cloud_media_items
   where source_id = '22222222-2222-2222-2222-222222222222'),
  2,
  'historical media rows survive the contract'
);

select extensions.is(
  (select count(*)::integer from public.cloud_title_variants
   where source_id = '22222222-2222-2222-2222-222222222222'),
  1,
  'historical title variants survive the contract'
);

select extensions.is(
  (select count(*)::integer from public.cloud_live_variants
   where source_id = '22222222-2222-2222-2222-222222222222'),
  1,
  'historical live variants survive the contract'
);

select extensions.is(
  (
    select count(*)::integer
    from pg_attribute attribute_state
    where (attribute_state.attrelid, attribute_state.attname) in (
      ('public.cloud_media_items'::regclass, 'generation_id'),
      ('public.cloud_title_variants'::regclass, 'generation_id'),
      ('public.cloud_live_logical_channels'::regclass, 'generation_id'),
      ('public.cloud_live_variants'::regclass, 'generation_id'),
      ('public.catalog_series_episode_memberships'::regclass, 'generation_id'),
      ('public.catalog_series_inventory_state'::regclass, 'generation_id')
    ) and attribute_state.attnotnull
  ),
  6,
  'all six physical catalog generation fences are not null'
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
  'all provider access flags remain off after contraction'
);

select * from extensions.finish();
rollback;
