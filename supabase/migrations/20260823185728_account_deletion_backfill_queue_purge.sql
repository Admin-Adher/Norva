-- The account-deletion worker removes catalog generations only in bounded
-- batches.  The backfill outbox has one row per source and holds a RESTRICT FK
-- to the active generation, so it must be drained explicitly before the
-- generation phase; changing the FK to CASCADE would hide that work.
set lock_timeout = '2s';
set statement_timeout = '60min';

create index concurrently if not exists norva_adk_backfill_source_idx
  on public.cloud_catalog_generation_backfill_sources(user_id,source_id);

do $index_contract$
declare v_columns text[];
begin
  select array_agg(attribute.attname::text order by key_column.ordinality)
    into v_columns
  from pg_catalog.pg_index index_state
  join pg_catalog.pg_class index_class on index_class.oid=index_state.indexrelid
  join pg_catalog.pg_namespace namespace_state
    on namespace_state.oid=index_class.relnamespace
  join lateral pg_catalog.unnest(index_state.indkey)
    with ordinality key_column(attnum,ordinality) on true
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid=index_state.indrelid and attribute.attnum=key_column.attnum
  where namespace_state.nspname='public'
    and index_class.relname='norva_adk_backfill_source_idx'
    and index_state.indrelid='public.cloud_catalog_generation_backfill_sources'::regclass
    and index_state.indisvalid and index_state.indisready and index_state.indislive
    and index_state.indpred is null and index_state.indexprs is null;
  if v_columns is distinct from array['user_id','source_id']::text[] then
    raise exception 'account deletion backfill keyset index drift' using errcode='55000';
  end if;
end
$index_contract$;

begin;
do $patch_prepare_worker$
declare
  v_definition text;
  v_old text := $old$
    elsif v_preparation.phase = 'generations' then
      update public.cloud_source_transitions transition
$old$;
  v_new text := $new$
    elsif v_preparation.phase = 'generations' then
      -- One queue row per source is still explicit durable work: remove it
      -- under the worker lease and keyset cursor before its RESTRICT FK can
      -- block the bounded generation delete below.
      v_count := public.norva_provider_account_delete_rows_bounded(
        'public.cloud_catalog_generation_backfill_sources',
        'user_id',p_user_id,v_budget
      );
      v_deleted := v_deleted + v_count; v_budget := v_budget - v_count;
      if v_budget <= 0
         or exists (
           select 1 from public.cloud_catalog_generation_backfill_sources
           where user_id = p_user_id
         ) then
        exit;
      end if;
      update public.cloud_source_transitions transition
$new$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.norva_run_provider_account_deletion_prepare_batch(uuid,text,integer,bigint,integer)'::regprocedure
  ) into v_definition;
  if position('public.cloud_catalog_generation_backfill_sources' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'account deletion worker generation phase drift'
        using errcode='55000';
    end if;
    v_definition := replace(v_definition,v_old,v_new);
    if position('One queue row per source' in v_definition) = 0 then
      raise exception 'account deletion worker patch did not converge'
        using errcode='55000';
    end if;
    execute v_definition;
  end if;
end
$patch_prepare_worker$;

do $patch_proof$
declare
  v_definition text;
  v_old text :=
    'and not exists (select 1 from public.cloud_source_catalog_generations where user_id = p_user_id)';
  v_new text :=
    'and not exists (select 1 from public.cloud_catalog_generation_backfill_sources where user_id = p_user_id)' || E'\n    ' ||
    'and not exists (select 1 from public.cloud_source_catalog_generations where user_id = p_user_id)';
begin
  select pg_catalog.pg_get_functiondef(
    'public.norva_provider_account_delete_proof_ready(uuid)'::regprocedure
  ) into v_definition;
  if position('cloud_catalog_generation_backfill_sources' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'account deletion terminal proof drift' using errcode='55000';
    end if;
    v_definition := replace(v_definition,v_old,v_new);
    if position('cloud_catalog_generation_backfill_sources' in v_definition) = 0 then
      raise exception 'account deletion terminal proof patch did not converge'
        using errcode='55000';
    end if;
    execute v_definition;
  end if;
end
$patch_proof$;
commit;
