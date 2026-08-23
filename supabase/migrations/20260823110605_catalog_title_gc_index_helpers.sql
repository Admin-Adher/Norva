begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create or replace function public.norva_title_gc_index_is_exact(
  p_index_name text,
  p_table regclass,
  p_columns text[],
  p_require_online boolean default true
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(bool_and(
    index_class.relkind = 'i'
    and table_class.oid = p_table
    and access_method.amname = 'btree'
    and not index_catalog.indisunique
    and not index_catalog.indisprimary
    and not index_catalog.indisexclusion
    and index_catalog.indimmediate
    and not index_catalog.indisreplident
    and not index_catalog.indnullsnotdistinct
    and index_catalog.indislive
    and (
      not p_require_online
      or (index_catalog.indisvalid and index_catalog.indisready)
    )
    and index_catalog.indnkeyatts = cardinality(p_columns)
    and index_catalog.indnatts = cardinality(p_columns)
    and index_catalog.indexprs is null
    and index_catalog.indpred is null
    and coalesce(cardinality(index_class.reloptions), 0) = 0
    and array(select unnest(index_catalog.indkey)) = expected.attnums
    and array(select unnest(index_catalog.indcollation)) = expected.collations
    and array(select unnest(index_catalog.indoption)) =
      array_fill(0::smallint, array[cardinality(p_columns)])
    and not exists (
      select 1
      from unnest(index_catalog.indclass) opclass_entry(opclass_oid)
      join pg_opclass opclass on opclass.oid = opclass_entry.opclass_oid
      where not opclass.opcdefault
        or opclass.opcmethod <> access_method.oid
    )
  ), false)
  from pg_class index_class
  join pg_namespace namespace on namespace.oid = index_class.relnamespace
  join pg_index index_catalog on index_catalog.indexrelid = index_class.oid
  join pg_class table_class on table_class.oid = index_catalog.indrelid
  join pg_am access_method on access_method.oid = index_class.relam
  cross join lateral (
    select
      array_agg(attribute.attnum order by requested.ordinality)::smallint[]
        as attnums,
      array_agg(attribute.attcollation order by requested.ordinality)::oid[]
        as collations
    from unnest(p_columns) with ordinality requested(column_name, ordinality)
    join pg_attribute attribute
      on attribute.attrelid = p_table
     and attribute.attname = requested.column_name
     and attribute.attnum > 0
     and not attribute.attisdropped
  ) expected
  where namespace.nspname = 'public'
    and index_class.relname = p_index_name
    and cardinality(expected.attnums) = cardinality(p_columns)
$function$;

revoke all on function public.norva_title_gc_index_is_exact(
  text, regclass, text[], boolean
) from public, anon, authenticated, service_role;

commit;
