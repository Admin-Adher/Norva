-- A source must never become READY while its active generation still contains
-- rows from an older catalog_version. Discovery already prunes these rows, but
-- a statement timeout or an isolate loss can strand a safe superset. Finalize
-- therefore gets a second, bounded, generation-fenced prune gate.

create index concurrently if not exists cloud_media_items_generation_catalog_version_id_idx
  on public.cloud_media_items (source_id, generation_id, catalog_version, id);

do $index_postcondition$
declare
  v_class pg_catalog.pg_class%rowtype;
  v_index pg_catalog.pg_index%rowtype;
  v_source_attnum smallint;
  v_generation_attnum smallint;
  v_version_attnum smallint;
  v_id_attnum smallint;
  v_uuid_opclass oid;
  v_int8_opclass oid;
begin
  select index_class.* into v_class
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_namespace namespace_state
    on namespace_state.oid = index_class.relnamespace
  where namespace_state.nspname = 'public'
    and index_class.relname = 'cloud_media_items_generation_catalog_version_id_idx';
  if not found then
    raise exception 'catalog ready prune index is missing' using errcode = '55000';
  end if;
  select index_state.* into v_index
  from pg_catalog.pg_index index_state
  where index_state.indexrelid = v_class.oid;
  select attnum into strict v_source_attnum from pg_catalog.pg_attribute
    where attrelid = 'public.cloud_media_items'::regclass and attname = 'source_id' and not attisdropped;
  select attnum into strict v_generation_attnum from pg_catalog.pg_attribute
    where attrelid = 'public.cloud_media_items'::regclass and attname = 'generation_id' and not attisdropped;
  select attnum into strict v_version_attnum from pg_catalog.pg_attribute
    where attrelid = 'public.cloud_media_items'::regclass and attname = 'catalog_version' and not attisdropped;
  select attnum into strict v_id_attnum from pg_catalog.pg_attribute
    where attrelid = 'public.cloud_media_items'::regclass and attname = 'id' and not attisdropped;
  select opclass_state.oid into strict v_uuid_opclass
  from pg_catalog.pg_opclass opclass_state
  join pg_catalog.pg_am access_method on access_method.oid = opclass_state.opcmethod
  where access_method.amname = 'btree' and opclass_state.opcdefault
    and opclass_state.opcintype = 'uuid'::regtype;
  select opclass_state.oid into strict v_int8_opclass
  from pg_catalog.pg_opclass opclass_state
  join pg_catalog.pg_am access_method on access_method.oid = opclass_state.opcmethod
  where access_method.amname = 'btree' and opclass_state.opcdefault
    and opclass_state.opcintype = 'bigint'::regtype;
  if v_class.relkind <> 'i'
     or coalesce(pg_catalog.cardinality(v_class.reloptions), 0) <> 0
     or v_index.indexrelid is null
     or v_index.indrelid <> 'public.cloud_media_items'::regclass
     or v_index.indisunique or v_index.indisprimary
     or not v_index.indisvalid or not v_index.indisready or not v_index.indislive
     or not v_index.indimmediate or v_index.indnullsnotdistinct
     or v_index.indnkeyatts <> 4 or v_index.indnatts <> 4
     or v_index.indkey[0] <> v_source_attnum
     or v_index.indkey[1] <> v_generation_attnum
     or v_index.indkey[2] <> v_version_attnum
     or v_index.indkey[3] <> v_id_attnum
     or v_index.indclass[0] <> v_uuid_opclass
     or v_index.indclass[1] <> v_uuid_opclass
     or v_index.indclass[2] <> v_int8_opclass
     or v_index.indclass[3] <> v_uuid_opclass
     or v_index.indcollation[0] <> 0 or v_index.indcollation[1] <> 0
     or v_index.indcollation[2] <> 0 or v_index.indcollation[3] <> 0
     or v_index.indexprs is not null or v_index.indpred is not null
     or exists (
       select 1 from pg_catalog.unnest(v_index.indoption) option_state
       where option_state <> 0
     )
     or (
       select access_method.amname <> 'btree'
       from pg_catalog.pg_am access_method
       where access_method.oid = v_class.relam
     ) then
    raise exception 'catalog ready prune index homonym has noncanonical shape'
      using errcode = '55000';
  end if;
end
$index_postcondition$;

create or replace function public.norva_prune_catalog_generation_before_ready(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_head_revision bigint,
  p_config_revision bigint,
  p_source_visibility_epoch bigint,
  p_user_visibility_epoch bigint,
  p_limit integer
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source public.cloud_sources%rowtype;
  v_catalog_version bigint;
  v_expected_total bigint;
  v_current_rows bigint;
  v_deleted integer := 0;
  v_write_snapshot jsonb;
begin
  perform public.norva_credential_require_service_role();
  if p_limit < 1 or p_limit > 500 then
    raise exception 'ready prune batch limit invalid' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.cloud_sources source
    where source.id = p_source_id
      and source.user_id = p_user_id
      and source.deleted_at is null
  ) then
    raise exception 'source not found for ready prune' using errcode = 'P0002';
  end if;

  -- Catalog payload triggers serialize on the account epoch before touching
  -- owner snapshots or source state. Preserve that global order here so this
  -- RPC cannot deadlock with deletion, promotion, or another catalog writer.
  perform public.norva_lock_catalog_background_owner_epoch(p_user_id);

  select source.* into v_source
  from public.cloud_sources source
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.deleted_at is null
  for update;

  if not found then
    raise exception 'source not found for ready prune' using errcode = 'P0002';
  end if;

  if coalesce((v_source.config_hint #>> '{syncCursor,active}')::boolean, false) then
    raise exception 'catalog discovery is active during ready prune' using errcode = '40001';
  end if;

  perform public.norva_set_catalog_delete_proof(
    p_source_id,
    p_user_id,
    p_generation_id,
    p_head_revision,
    p_config_revision,
    p_source_visibility_epoch,
    p_user_visibility_epoch
  );

  if v_source.config_hint #>> '{syncProgress,counts,total}' ~ '^[0-9]{1,19}$' then
    v_expected_total := (v_source.config_hint #>> '{syncProgress,counts,total}')::bigint;
  end if;
  if v_source.config_hint #>> '{syncProgress,catalogVersion}' ~ '^[0-9]{1,19}$' then
    v_catalog_version := (v_source.config_hint #>> '{syncProgress,catalogVersion}')::bigint;
  end if;

  -- Discovery must durably bind finalization to the exact version it completed.
  -- Never infer identity from max(catalog_version), row-count coincidence, or
  -- wall-clock ordering. A pre-deployment run without this proof must restart
  -- discovery under the new contract instead of guessing which inventory wins.
  if v_catalog_version is null or v_expected_total is null then
    raise exception 'catalog version proof missing during ready prune'
      using errcode = '55000';
  end if;

  select count(*) into v_current_rows
  from public.cloud_media_items item
  where item.source_id = p_source_id
    and item.user_id = p_user_id
    and item.generation_id = p_generation_id
    and item.catalog_version = v_catalog_version;

  if v_expected_total is null or v_current_rows is distinct from v_expected_total then
    raise exception 'catalog version row-count proof failed during ready prune'
      using errcode = '55000',
            detail = format('catalog_version=%s current_rows=%s expected_total=%s',
              v_catalog_version, v_current_rows, v_expected_total);
  end if;

  with doomed as (
    select item.id
    from public.cloud_media_items item
    where item.source_id = p_source_id
      and item.user_id = p_user_id
      and item.generation_id = p_generation_id
      and item.catalog_version is distinct from v_catalog_version
    order by item.id
    limit p_limit
    for update skip locked
  )
  delete from public.cloud_media_items item
  using doomed
  where item.id = doomed.id;

  get diagnostics v_deleted = row_count;

  -- Catalog deletes intentionally bump the global visibility epoch. Return the
  -- post-write snapshot so the same legitimate worker can fence its next batch
  -- with N+1; it must not keep writing under the now-stale epoch N.
  v_write_snapshot := public.norva_get_catalog_write_snapshot(p_source_id, p_user_id);

  return jsonb_build_object(
    'catalogVersion', v_catalog_version,
    'deletedRows', v_deleted,
    'complete', v_deleted = 0,
    'writeSnapshot', v_write_snapshot
  );
end
$function$;

revoke all on function public.norva_prune_catalog_generation_before_ready(
  uuid, uuid, uuid, bigint, bigint, bigint, bigint, integer
) from public, anon, authenticated;

grant execute on function public.norva_prune_catalog_generation_before_ready(
  uuid, uuid, uuid, bigint, bigint, bigint, bigint, integer
) to service_role;
