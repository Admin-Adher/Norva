-- Supabase CLI 2.115 executes CREATE INDEX CONCURRENTLY outside its migration
-- transaction pipeline.  This file intentionally has no BEGIN/COMMIT.
set lock_timeout = '2s';
set statement_timeout = '30min';

do $preflight$
declare
  v_index pg_catalog.pg_index%rowtype;
  v_class pg_catalog.pg_class%rowtype;
  v_user_attnum smallint;
  v_id_attnum smallint;
  v_uuid_opclass oid;
begin
  select index_class.* into v_class
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_namespace namespace_state on namespace_state.oid=index_class.relnamespace
  where namespace_state.nspname='public' and index_class.relname='cloud_sources_user_id_id_uidx';
  if not found then return; end if;
  select index_state.* into v_index from pg_catalog.pg_index index_state where index_state.indexrelid=v_class.oid;
  select attnum into strict v_user_attnum from pg_catalog.pg_attribute where attrelid='public.cloud_sources'::regclass and attname='user_id' and not attisdropped;
  select attnum into strict v_id_attnum from pg_catalog.pg_attribute where attrelid='public.cloud_sources'::regclass and attname='id' and not attisdropped;
  select opclass_state.oid into strict v_uuid_opclass from pg_catalog.pg_opclass opclass_state join pg_catalog.pg_am access_method on access_method.oid=opclass_state.opcmethod where access_method.amname='btree' and opclass_state.opcdefault and opclass_state.opcintype='uuid'::regtype;
  if v_class.relkind <> 'i' or coalesce(cardinality(v_class.reloptions),0) <> 0
     or v_index.indexrelid is null or v_index.indrelid <> 'public.cloud_sources'::regclass
     or not v_index.indisunique or v_index.indisprimary or not v_index.indislive
     or not v_index.indimmediate or v_index.indnullsnotdistinct
     or v_index.indnkeyatts <> 2 or v_index.indnatts <> 2
     or v_index.indkey[0] <> v_user_attnum or v_index.indkey[1] <> v_id_attnum
     or v_index.indclass[0] <> v_uuid_opclass or v_index.indclass[1] <> v_uuid_opclass
     or v_index.indcollation[0] <> 0 or v_index.indcollation[1] <> 0
     or v_index.indexprs is not null or v_index.indpred is not null
     or exists (select 1 from pg_catalog.unnest(v_index.indoption) option_state where option_state <> 0)
     or (select access_method.amname <> 'btree' from pg_catalog.pg_am access_method where access_method.oid=v_class.relam) then
    raise exception 'cloud_sources_user_id_id_uidx homonym has noncanonical shape; operator inspection required'
      using errcode='55000';
  end if;
  if not v_index.indisvalid or not v_index.indisready then
    raise exception 'cloud_sources_user_id_id_uidx is invalid; run REINDEX INDEX CONCURRENTLY public.cloud_sources_user_id_id_uidx, then retry'
      using errcode = '55000';
  end if;
end
$preflight$;

create unique index concurrently if not exists cloud_sources_user_id_id_uidx
  on public.cloud_sources (user_id, id);

do $postcondition$
declare
  v_index pg_catalog.pg_index%rowtype;
  v_index_oid oid;
  v_user_attnum smallint;
  v_id_attnum smallint;
  v_uuid_opclass oid;
  v_class pg_catalog.pg_class%rowtype;
begin
  select index_class.* into v_class
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_namespace namespace_state on namespace_state.oid = index_class.relnamespace
  where namespace_state.nspname = 'public'
    and index_class.relname = 'cloud_sources_user_id_id_uidx';
  v_index_oid := v_class.oid;
  select index_state.* into v_index from pg_catalog.pg_index index_state where index_state.indexrelid=v_index_oid;
  select attnum into v_user_attnum from pg_catalog.pg_attribute where attrelid = 'public.cloud_sources'::regclass and attname = 'user_id' and not attisdropped;
  select attnum into v_id_attnum from pg_catalog.pg_attribute where attrelid = 'public.cloud_sources'::regclass and attname = 'id' and not attisdropped;
  select opclass_state.oid into strict v_uuid_opclass from pg_catalog.pg_opclass opclass_state join pg_catalog.pg_am access_method on access_method.oid=opclass_state.opcmethod where access_method.amname='btree' and opclass_state.opcdefault and opclass_state.opcintype='uuid'::regtype;
  if v_index_oid is null
     or v_class.relkind <> 'i' or coalesce(cardinality(v_class.reloptions),0) <> 0
     or v_index.indrelid <> 'public.cloud_sources'::regclass
     or not v_index.indisunique or v_index.indisprimary
     or not v_index.indisvalid or not v_index.indisready or not v_index.indislive
     or not v_index.indimmediate or v_index.indnullsnotdistinct
     or v_index.indnkeyatts <> 2 or v_index.indnatts <> 2
     or v_index.indkey[0] <> v_user_attnum or v_index.indkey[1] <> v_id_attnum
     or v_index.indclass[0] <> v_uuid_opclass or v_index.indclass[1] <> v_uuid_opclass
     or v_index.indcollation[0] <> 0 or v_index.indcollation[1] <> 0
     or v_index.indexprs is not null or v_index.indpred is not null
     or (select access_method.amname <> 'btree' from pg_catalog.pg_class index_class join pg_catalog.pg_am access_method on access_method.oid = index_class.relam where index_class.oid = v_index_oid)
     or exists (select 1 from pg_catalog.unnest(v_index.indoption) option_state where option_state <> 0) then
    raise exception 'cloud_sources_user_id_id_uidx canonical postcondition failed' using errcode = '55000';
  end if;
end
$postcondition$;

reset lock_timeout;
reset statement_timeout;
