-- Standalone: Supabase CLI 2.115 flushes CREATE INDEX CONCURRENTLY outside
-- its migration transaction pipeline.  Keep this file idempotent and never
-- wrap it in BEGIN/COMMIT.
set lock_timeout = '2s';
set statement_timeout = '30min';

do $preflight$
declare
  v_index oid := pg_catalog.to_regclass('public.provider_account_activity_raw_key_idx');
  v_table_attnum smallint;
  v_exact boolean;
  v_valid boolean;
begin
  if v_index is null then return; end if;
  select attribute_state.attnum into strict v_table_attnum
  from pg_catalog.pg_attribute attribute_state
  where attribute_state.attrelid = 'public.provider_account_activity'::regclass
    and attribute_state.attname = 'account_key'
    and not attribute_state.attisdropped;
  select
    index_state.indrelid = 'public.provider_account_activity'::regclass
    and index_class.relkind = 'i'
    and access_method.amname = 'btree'
    and index_state.indnatts = 1 and index_state.indnkeyatts = 1
    and pg_catalog.cardinality(index_state.indkey::smallint[]) = 1
    and (index_state.indkey::smallint[])[0] = v_table_attnum
    and index_state.indexprs is null
    and pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid, false)
      = '(account_key !~ ''^[0-9a-f]{64}$''::text)'
    and pg_catalog.cardinality(index_state.indclass::oid[]) = 1
    and (index_state.indclass::oid[])[0] = (
      select operator_class.oid
      from pg_catalog.pg_opclass operator_class
      join pg_catalog.pg_am operator_method on operator_method.oid=operator_class.opcmethod
      where operator_class.opcnamespace='pg_catalog'::regnamespace
        and operator_class.opcname='text_ops' and operator_method.amname='btree'
    )
    and pg_catalog.cardinality(index_state.indcollation::oid[]) = 1
    and (index_state.indcollation::oid[])[0] = (
      select attribute_state.attcollation
      from pg_catalog.pg_attribute attribute_state
      where attribute_state.attrelid = index_state.indrelid
        and attribute_state.attnum = v_table_attnum
    )
    and pg_catalog.cardinality(index_state.indoption::smallint[]) = 1
    and (index_state.indoption::smallint[])[0] = 0
    and coalesce(pg_catalog.cardinality(index_class.reloptions), 0) = 0
    and not index_state.indisunique and not index_state.indisprimary
    and index_state.indisready and index_state.indislive,
    index_state.indisvalid
  into strict v_exact, v_valid
  from pg_catalog.pg_index index_state
  join pg_catalog.pg_class index_class on index_class.oid = index_state.indexrelid
  join pg_catalog.pg_am access_method on access_method.oid = index_class.relam
  where index_state.indexrelid = v_index;
  if not v_exact then
    raise exception 'provider_account_activity_raw_key_idx homonym has the wrong definition'
      using errcode = '55000';
  end if;
  if not v_valid then
    raise exception 'provider_account_activity_raw_key_idx is invalid; operator must REINDEX INDEX CONCURRENTLY then retry'
      using errcode = '55000', detail = 'reason=invalid_concurrent_index';
  end if;
end
$preflight$;

create index concurrently if not exists provider_account_activity_raw_key_idx
  on public.provider_account_activity(account_key)
  where account_key !~ '^[0-9a-f]{64}$';

do $postcondition$
declare
  v_index oid := pg_catalog.to_regclass('public.provider_account_activity_raw_key_idx');
  v_table_attnum smallint;
begin
  select attribute_state.attnum into strict v_table_attnum
  from pg_catalog.pg_attribute attribute_state
  where attribute_state.attrelid = 'public.provider_account_activity'::regclass
    and attribute_state.attname = 'account_key'
    and not attribute_state.attisdropped;
  if v_index is null or not exists (
    select 1
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_class on index_class.oid = index_state.indexrelid
    join pg_catalog.pg_am access_method on access_method.oid = index_class.relam
    where index_state.indexrelid = v_index
      and index_state.indrelid = 'public.provider_account_activity'::regclass
      and index_class.relkind = 'i' and access_method.amname = 'btree'
      and index_state.indnatts = 1 and index_state.indnkeyatts = 1
      and pg_catalog.cardinality(index_state.indkey::smallint[]) = 1
      and (index_state.indkey::smallint[])[0] = v_table_attnum
      and index_state.indexprs is null
      and pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid, false)
        = '(account_key !~ ''^[0-9a-f]{64}$''::text)'
      and pg_catalog.cardinality(index_state.indclass::oid[]) = 1
      and (index_state.indclass::oid[])[0] = (
        select operator_class.oid
        from pg_catalog.pg_opclass operator_class
        join pg_catalog.pg_am operator_method on operator_method.oid=operator_class.opcmethod
        where operator_class.opcnamespace='pg_catalog'::regnamespace
          and operator_class.opcname='text_ops' and operator_method.amname='btree'
      )
      and pg_catalog.cardinality(index_state.indcollation::oid[]) = 1
      and (index_state.indcollation::oid[])[0] = (
        select attribute_state.attcollation
        from pg_catalog.pg_attribute attribute_state
        where attribute_state.attrelid = index_state.indrelid
          and attribute_state.attnum = v_table_attnum
      )
      and pg_catalog.cardinality(index_state.indoption::smallint[]) = 1
      and (index_state.indoption::smallint[])[0] = 0
      and coalesce(pg_catalog.cardinality(index_class.reloptions), 0) = 0
      and not index_state.indisunique and not index_state.indisprimary
      and index_state.indisready and index_state.indisvalid and index_state.indislive
  ) then
    raise exception 'provider_account_activity_raw_key_idx postcondition failed'
      using errcode = '55000';
  end if;
end
$postcondition$;

reset lock_timeout;
reset statement_timeout;
