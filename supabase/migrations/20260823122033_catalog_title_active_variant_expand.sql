begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

alter table public.cloud_title_variants
  add column if not exists projection_refresh_run_id uuid;
alter table public.cloud_live_variants
  add column if not exists projection_refresh_run_id uuid;
alter table public.cloud_media_items
  add column if not exists projection_refresh_run_id uuid;
alter table public.cloud_live_logical_channels
  add column if not exists projection_refresh_run_id uuid;
alter table public.cloud_source_catalog_generation_categories
  add column if not exists projection_refresh_run_id uuid;

-- PostgreSQL expands `item.*` when a view is created, not when it is read.
-- Refresh the active-catalog view immediately after adding the marker so
-- routines returning SETOF cloud_media_items retain the exact row contract.
create or replace view public.cloud_catalog_visible_media_items
with (security_invoker = true, security_barrier = true)
as
select item.*
from public.cloud_media_items item
join public.cloud_catalog_visible_sources source
  on source.id = item.source_id and source.user_id = item.user_id
left join public.cloud_source_catalog_heads head
  on head.source_id = item.source_id and head.user_id = item.user_id
where item.generation_id is null
   or head.active_generation_id = item.generation_id;

do $assert$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.cloud_title_variants'::regclass
      and attribute.attname = 'projection_refresh_run_id'
      and attribute.atttypid = 'uuid'::regtype
      and attribute.attnum > 0 and not attribute.attisdropped
      and not attribute.attnotnull and not attribute.atthasdef
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.cloud_live_variants'::regclass
      and attribute.attname = 'projection_refresh_run_id'
      and attribute.atttypid = 'uuid'::regtype
      and attribute.attnum > 0 and not attribute.attisdropped
      and not attribute.attnotnull and not attribute.atthasdef
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.cloud_media_items'::regclass
      and attribute.attname = 'projection_refresh_run_id'
      and attribute.atttypid = 'uuid'::regtype
      and attribute.attnum > 0 and not attribute.attisdropped
      and not attribute.attnotnull and not attribute.atthasdef
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.cloud_live_logical_channels'::regclass
      and attribute.attname = 'projection_refresh_run_id'
      and attribute.atttypid = 'uuid'::regtype
      and attribute.attnum > 0 and not attribute.attisdropped
      and not attribute.attnotnull and not attribute.atthasdef
  ) or not exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.cloud_source_catalog_generation_categories'::regclass
      and attribute.attname = 'projection_refresh_run_id'
      and attribute.atttypid = 'uuid'::regtype
      and attribute.attnum > 0 and not attribute.attisdropped
      and not attribute.attnotnull and not attribute.atthasdef
  ) then
    raise exception 'active catalog refresh marker column drift'
      using errcode = '55000';
  end if;
end
$assert$;

commit;
