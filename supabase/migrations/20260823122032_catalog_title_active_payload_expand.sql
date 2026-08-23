begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Metadata-only expand on PostgreSQL 15.  Keep the traffic-table locks bounded
-- and commit before the concurrent index scan starts in the next unit.
alter table public.cloud_source_catalog_generations
  add column if not exists title_projection_refresh_run_id uuid;
alter table public.cloud_source_catalog_generations
  add column if not exists title_projection_inventory_completed_at timestamptz;
alter table public.cloud_source_catalog_generations
  add column if not exists title_projection_refreshed_at timestamptz;
alter table public.cloud_source_catalog_generation_candidate_titles
  add column if not exists post_switch_refreshed boolean not null default false;
alter table public.cloud_source_credential_transition_jobs
  add column if not exists title_projection_refresh_run_id uuid;
alter table public.cloud_source_credential_transition_jobs
  add column if not exists title_inventory_observed_count bigint;
alter table public.cloud_source_credential_transition_jobs
  add column if not exists title_pruned_variant_count bigint;
alter table public.cloud_source_credential_transition_jobs
  add column if not exists title_inventory_completed_at timestamptz;
alter table public.cloud_source_credential_transition_jobs
  add column if not exists title_prune_completed_at timestamptz;

create or replace function public.norva_catalog_title_active_payload_indexes_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.norva_catalog_title_projection_index_is_exact(
    'cloud_source_candidate_titles_unrefreshed_idx',
    'public.cloud_source_catalog_generation_candidate_titles',
    array['generation_id','title_id'],
    array[0,0]::smallint[],
    '(NOT post_switch_refreshed)',
    true
  )
  and public.norva_catalog_title_projection_index_is_exact(
    'cloud_title_variants_projection_refresh_pending_idx',
    'public.cloud_title_variants',
    array['generation_id','item_type','id'],
    array[0,0,0]::smallint[],
    '(projection_refresh_run_id IS NULL)',
    true
  )
  and public.norva_catalog_title_projection_index_is_exact(
    'cloud_live_variants_projection_refresh_pending_idx',
    'public.cloud_live_variants',
    array['generation_id','id'],
    array[0,0]::smallint[],
    '(projection_refresh_run_id IS NULL)',
    true
  )
  and public.norva_catalog_title_projection_index_is_exact(
    'cloud_media_items_projection_refresh_pending_idx',
    'public.cloud_media_items',
    array['generation_id','item_type','id'],
    array[0,0,0]::smallint[],
    '(projection_refresh_run_id IS NULL)',
    true
  )
  and public.norva_catalog_title_projection_index_is_exact(
    'cloud_live_logical_projection_refresh_pending_idx',
    'public.cloud_live_logical_channels',
    array['generation_id','id'],
    array[0,0]::smallint[],
    '(projection_refresh_run_id IS NULL)',
    true
  )
  and public.norva_catalog_title_projection_index_is_exact(
    'cloud_source_generation_categories_refresh_pending_idx',
    'public.cloud_source_catalog_generation_categories',
    array['generation_id','category_kind','provider_category_id'],
    array[0,0,0]::smallint[],
    '(projection_refresh_run_id IS NULL)',
    true
  )
$function$;

revoke all on function
  public.norva_catalog_title_active_payload_indexes_ready()
from public, anon, authenticated, service_role;

do $assert$
begin
  if not exists (
       select 1
       from pg_catalog.pg_attribute attribute
       where attribute.attrelid =
         'public.cloud_source_catalog_generations'::regclass
         and attribute.attname = 'title_projection_refresh_run_id'
         and attribute.atttypid = 'uuid'::regtype
         and attribute.attnum > 0 and not attribute.attisdropped
         and not attribute.attnotnull and not attribute.atthasdef
     )
     or not exists (
       select 1
       from pg_catalog.pg_attribute attribute
       where attribute.attrelid =
         'public.cloud_source_catalog_generations'::regclass
         and attribute.attname = 'title_projection_inventory_completed_at'
         and attribute.atttypid = 'timestamptz'::regtype
         and attribute.attnum > 0 and not attribute.attisdropped
         and not attribute.attnotnull and not attribute.atthasdef
     )
     or not exists (
       select 1
       from pg_catalog.pg_attribute attribute
       where attribute.attrelid =
         'public.cloud_source_catalog_generations'::regclass
         and attribute.attname = 'title_projection_refreshed_at'
         and attribute.atttypid = 'timestamptz'::regtype
         and attribute.attnum > 0 and not attribute.attisdropped
         and not attribute.attnotnull and not attribute.atthasdef
     )
     or not exists (
       select 1
       from pg_catalog.pg_attribute attribute
       join pg_catalog.pg_attrdef default_value
         on default_value.adrelid = attribute.attrelid
        and default_value.adnum = attribute.attnum
       where attribute.attrelid =
         'public.cloud_source_catalog_generation_candidate_titles'::regclass
         and attribute.attname = 'post_switch_refreshed'
         and attribute.atttypid = 'boolean'::regtype
         and attribute.attnum > 0 and not attribute.attisdropped
         and attribute.attnotnull and attribute.atthasdef
         and pg_catalog.pg_get_expr(
           default_value.adbin, default_value.adrelid
         ) = 'false'
     )
     or (
       select count(*)
       from pg_catalog.pg_attribute attribute
       where attribute.attrelid =
         'public.cloud_source_credential_transition_jobs'::regclass
         and attribute.attname in (
           'title_projection_refresh_run_id',
           'title_inventory_observed_count','title_pruned_variant_count',
           'title_inventory_completed_at','title_prune_completed_at'
         )
         and attribute.attnum > 0 and not attribute.attisdropped
         and not attribute.attnotnull and not attribute.atthasdef
         and (
           (attribute.attname = 'title_projection_refresh_run_id'
             and attribute.atttypid = 'uuid'::regtype)
           or (attribute.attname in (
                 'title_inventory_observed_count','title_pruned_variant_count'
               ) and attribute.atttypid = 'bigint'::regtype)
           or (attribute.attname in (
                 'title_inventory_completed_at','title_prune_completed_at'
               ) and attribute.atttypid = 'timestamptz'::regtype)
         )
     ) <> 5
     then
    raise exception 'active catalog title payload expand drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
