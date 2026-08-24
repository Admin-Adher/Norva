-- Install the bounded rollout control plane and statement-cache guard before
-- any potentially long concurrent index build.  This migration never calls
-- validation/contract and never enables a feature flag.
begin;
set local lock_timeout='2s';
set local statement_timeout='5min';

-- Phase 3 online rollout control plane.  This migration defines the bounded
-- operations but invokes none of them.  All six provider-access flags remain
-- OFF and candidate generations remain impossible until an explicit contract.

-- Existing-table expansion, queue storage/FKs and the flag fence are installed
-- by the immediately preceding short units.  This long transaction now only
-- defines functions and new control-plane inventory objects.

-- Sources created after this migration are queued atomically with their
-- genesis head.  Existing sources are discovered in bounded batches below.
create or replace function public.norva_bootstrap_source_catalog_generation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_generation_id uuid;
  v_queued integer := 0;
begin
  v_generation_id := public.norva_ensure_source_catalog_head(new.id, new.user_id);
  -- Serialize a concurrent source insert with contract.  Before contract the
  -- trigger is the UUID-before/after-cursor safety net; after contract there
  -- is no legacy row to backfill, so no permanently-pending queue row is made.
  perform 1
  from public.cloud_catalog_generation_rollout rollout
  where rollout.singleton and rollout.contracted_at is null
  for key share;
  if not found then
    return new;
  end if;
  insert into public.cloud_catalog_generation_backfill_sources (
    source_id, user_id, active_generation_id
  ) values (new.id, new.user_id, v_generation_id)
  on conflict (source_id) do nothing;
  get diagnostics v_queued = row_count;
  if v_queued = 1 then
    update public.cloud_catalog_generation_rollout rollout
    set backfill_completed_at = null,
        updated_at = clock_timestamp()
    where rollout.singleton;
  end if;
  return new;
end
$function$;

-- Canonical index matching intentionally ignores spelling, qualification and
-- tablespace details from pg_get_indexdef.  It proves the relation OID,
-- ordered heap attnums, btree/default opclasses, attribute collations, and the
-- absence of expressions, predicates, or INCLUDE columns directly in catalogs.
create or replace function public.norva_catalog_generation_index_is_canonical(
  p_index_oid oid,
  p_table_oid oid,
  p_column_names name[],
  p_require_ready boolean default true
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from pg_catalog.pg_index index_state
    join pg_catalog.pg_class index_class
      on index_class.oid = index_state.indexrelid
    join pg_catalog.pg_am access_method
      on access_method.oid = index_class.relam
    where index_state.indexrelid = p_index_oid
      and index_state.indrelid = p_table_oid
      and index_class.relkind = 'i'
      and access_method.amname = 'btree'
      and index_state.indisunique
      and index_state.indislive
      and index_state.indimmediate
      and not index_state.indnullsnotdistinct
      and not index_state.indisclustered
      and not index_state.indisreplident
      and index_class.reloptions is null
      and (not p_require_ready
        or (index_state.indisvalid and index_state.indisready))
      and index_state.indnkeyatts = cardinality(p_column_names)
      and index_state.indnatts = index_state.indnkeyatts
      and index_state.indexprs is null
      and index_state.indpred is null
      and not exists (
        select 1
        from pg_catalog.unnest(p_column_names) with ordinality
          as expected(column_name, ordinal)
        left join pg_catalog.pg_attribute attribute_state
          on attribute_state.attrelid = p_table_oid
         and attribute_state.attname = expected.column_name
         and not attribute_state.attisdropped
        left join pg_catalog.pg_opclass opclass_state
          on opclass_state.oid = index_state.indclass[expected.ordinal - 1]
        where attribute_state.attnum is null
           or index_state.indkey[expected.ordinal - 1]
                <> attribute_state.attnum
           or index_state.indcollation[expected.ordinal - 1]
                <> attribute_state.attcollation
           or index_state.indoption[expected.ordinal - 1] <> 0
           or opclass_state.oid is null
           or not opclass_state.opcdefault
           or opclass_state.opcmethod <> index_class.relam
      )
  )
$function$;

create or replace function public.norva_catalog_generation_constraint_is_canonical(
  p_constraint_oid oid,
  p_table_oid oid,
  p_constraint_type text,
  p_key_columns name[],
  p_referenced_table_oid oid,
  p_referenced_columns name[],
  p_check_kind text,
  p_update_action text,
  p_delete_action text,
  p_match_type text
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_constraint pg_catalog.pg_constraint%rowtype;
  v_expression text;
begin
  select constraint_state.* into v_constraint
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.oid = p_constraint_oid;
  if not found
     or v_constraint.conrelid <> p_table_oid
     or v_constraint.contype::text <> p_constraint_type
     or v_constraint.condeferrable
     or v_constraint.condeferred
     or v_constraint.conparentid <> 0
     or cardinality(v_constraint.conkey) <> cardinality(p_key_columns)
     or exists (
       select 1
       from pg_catalog.unnest(p_key_columns) with ordinality
         as expected(column_name, ordinal)
       left join pg_catalog.pg_attribute attribute_state
         on attribute_state.attrelid = p_table_oid
        and attribute_state.attname = expected.column_name
        and not attribute_state.attisdropped
       where attribute_state.attnum is null
          or v_constraint.conkey[expected.ordinal]
               <> attribute_state.attnum
     ) then
    return false;
  end if;

  if p_constraint_type = 'f' then
    if v_constraint.confrelid is distinct from p_referenced_table_oid
       or v_constraint.confupdtype::text is distinct from p_update_action
       or v_constraint.confdeltype::text is distinct from p_delete_action
       or v_constraint.confmatchtype::text is distinct from p_match_type
       or cardinality(v_constraint.confkey)
            <> cardinality(p_referenced_columns)
       or exists (
         select 1
         from pg_catalog.unnest(p_referenced_columns) with ordinality
           as expected(column_name, ordinal)
         left join pg_catalog.pg_attribute attribute_state
           on attribute_state.attrelid = p_referenced_table_oid
          and attribute_state.attname = expected.column_name
          and not attribute_state.attisdropped
         where attribute_state.attnum is null
            or v_constraint.confkey[expected.ordinal]
                 <> attribute_state.attnum
       ) then
      return false;
    end if;
    return v_constraint.conbin is null;
  end if;

  if p_constraint_type in ('p', 'u') then
    return v_constraint.conindid <> 0
      and v_constraint.convalidated
      and public.norva_catalog_generation_index_is_canonical(
        v_constraint.conindid,
        p_table_oid,
        p_key_columns,
        true
      );
  end if;

  if p_constraint_type <> 'c'
     or p_check_kind not in (
       'request_fingerprint', 'generation_required', 'ingest_lease'
     ) then
    return false;
  end if;
  v_expression := pg_catalog.regexp_replace(
    pg_catalog.pg_get_expr(v_constraint.conbin, v_constraint.conrelid),
    '[[:space:]]+', '', 'g'
  );
  return case p_check_kind
    when 'request_fingerprint' then
      v_expression = '((request_fingerprintISNULL)OR(request_fingerprint~''^[0-9a-f]{64}$''::text))'
    when 'generation_required' then
      v_expression = '(generation_idISNOTNULL)'
    when 'ingest_lease' then
      v_expression = '(((ingest_job_idISNULL)AND(ingest_attemptISNULL)AND(ingest_lease_ownerISNULL))OR((ingest_job_idISNOTNULL)AND((ingest_attempt>=1)AND(ingest_attempt<=25))AND(btrim(ingest_lease_owner)<>''''::text)AND(length(ingest_lease_owner)<=160)))'
    else false
  end;
end
$function$;

create or replace function public.norva_catalog_generation_indexes_ready()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (select count(*) = 11
     and coalesce(bool_and(
       case
         when online_index.oid is not null then
           public.norva_catalog_generation_index_is_canonical(
             online_index.oid,
             expected.table_regclass::oid,
             expected.column_names,
             true
           )
         when attached_constraint.oid is not null then
           attached_constraint.contype::text = expected.constraint_type
           and public.norva_catalog_generation_index_is_canonical(
             attached_constraint.conindid,
             expected.table_regclass::oid,
             expected.column_names,
             true
           )
         else false
       end
     ), false)
  from public.cloud_catalog_generation_contract_indexes expected
  left join pg_catalog.pg_class online_index
    on online_index.relname = expected.online_index_name
   and online_index.relnamespace = 'public'::regnamespace
  left join pg_catalog.pg_constraint attached_constraint
    on attached_constraint.conrelid = expected.table_regclass
   and attached_constraint.conname = expected.attached_constraint_name);
end
$function$;

create or replace function public.norva_catalog_generation_indexes_online_ready()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (select count(*) = 11
     and coalesce(bool_and(
       online_index.oid is not null
       and public.norva_catalog_generation_index_is_canonical(
         online_index.oid,
         expected.table_regclass::oid,
         expected.column_names,
         true
       )
     ), false)
  from public.cloud_catalog_generation_contract_indexes expected
  left join pg_catalog.pg_class online_index
    on online_index.relname = expected.online_index_name
   and online_index.relnamespace = 'public'::regnamespace
  left join pg_catalog.pg_constraint attached_constraint
    on attached_constraint.conrelid = expected.table_regclass
   and attached_constraint.conname = expected.attached_constraint_name);
end
$function$;

create or replace function public.norva_catalog_generation_indexes_attached()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (select count(*) = 11
     and coalesce(bool_and(
       attached_constraint.oid is not null
       and attached_constraint.contype::text = expected.constraint_type
       and online_index.oid is null
       and public.norva_catalog_generation_index_is_canonical(
         attached_constraint.conindid,
         expected.table_regclass::oid,
         expected.column_names,
         true
       )
     ), false)
  from public.cloud_catalog_generation_contract_indexes expected
  left join pg_catalog.pg_class online_index
    on online_index.relname = expected.online_index_name
   and online_index.relnamespace = 'public'::regnamespace
  left join pg_catalog.pg_constraint attached_constraint
    on attached_constraint.conrelid = expected.table_regclass
   and attached_constraint.conname = expected.attached_constraint_name);
end
$function$;

create or replace function public.norva_catalog_generation_constraints_canonical(
  p_require_validated boolean default false
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (select count(*) = 28
     and coalesce(bool_and(
       public.norva_catalog_generation_constraint_is_canonical(
         constraint_state.oid,
         expected.table_regclass::oid,
         expected.constraint_type,
         expected.key_columns,
         expected.referenced_table_regclass::oid,
         expected.referenced_columns,
         expected.check_kind,
         expected.update_action,
         expected.delete_action,
         expected.match_type
       )
       and (not p_require_validated or constraint_state.convalidated)
     ), false)
  from public.cloud_catalog_generation_contract_constraints expected
  left join pg_catalog.pg_constraint constraint_state
    on constraint_state.conrelid = expected.table_regclass
   and constraint_state.conname = expected.constraint_name);
end
$function$;

create or replace function public.norva_assert_catalog_generation_contract_constraint(
  p_constraint_name name,
  p_require_validated boolean default false
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_expected record;
  v_constraint pg_catalog.pg_constraint%rowtype;
begin
  select expected.* into v_expected
  from public.cloud_catalog_generation_contract_constraints expected
  where expected.constraint_name = p_constraint_name;
  if not found then
    raise exception 'catalog generation constraint is not allowlisted: %',
      p_constraint_name using errcode = '22023';
  end if;
  select constraint_state.* into v_constraint
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid = v_expected.table_regclass
    and constraint_state.conname = v_expected.constraint_name;
  if not found
     or not public.norva_catalog_generation_constraint_is_canonical(
       v_constraint.oid,
       v_expected.table_regclass::oid,
       v_expected.constraint_type,
       v_expected.key_columns,
       v_expected.referenced_table_regclass::oid,
       v_expected.referenced_columns,
       v_expected.check_kind,
       v_expected.update_action,
       v_expected.delete_action,
       v_expected.match_type
     )
     or (p_require_validated and not v_constraint.convalidated) then
    raise exception 'catalog generation constraint definition drifted: %',
      p_constraint_name
      using errcode = '55000', detail = 'reason=constraint_definition_drift';
  end if;
end
$function$;

create or replace function public.norva_catalog_generation_legacy_blockers_canonical()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (
    select count(*) = 10 and not exists (
      select 1
      from public.cloud_catalog_generation_contract_legacy_constraints expected
      where (
        select count(*)
        from pg_catalog.pg_constraint constraint_state
        where constraint_state.conrelid = expected.table_regclass
          and constraint_state.contype::text = expected.constraint_type
          and public.norva_catalog_generation_constraint_is_canonical(
            constraint_state.oid,
            expected.table_regclass::oid,
            expected.constraint_type,
            expected.key_columns,
            expected.referenced_table_regclass::oid,
            expected.referenced_columns,
            null,
            expected.update_action,
            expected.delete_action,
            expected.match_type
          )
      ) <> 1
    )
    from public.cloud_catalog_generation_contract_legacy_constraints
  );
end
$function$;

create or replace function public.norva_catalog_generation_legacy_blocking_constraint_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  select count(*)::integer into v_count
  from public.cloud_catalog_generation_contract_legacy_constraints expected
  join pg_catalog.pg_constraint constraint_state
    on constraint_state.conrelid = expected.table_regclass
   and constraint_state.contype::text = expected.constraint_type
   and public.norva_catalog_generation_constraint_is_canonical(
     constraint_state.oid,
     expected.table_regclass::oid,
     expected.constraint_type,
     expected.key_columns,
     expected.referenced_table_regclass::oid,
     expected.referenced_columns,
     null,
     expected.update_action,
     expected.delete_action,
     expected.match_type
   );
  return v_count;
end
$function$;

create or replace function public.norva_catalog_generation_legacy_blocking_index_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  -- Count every live UNIQUE object on a generation table whose actual
  -- uniqueness keys omit generation_id, except for the small structural
  -- allowlist of surrogate identities that remain intentionally global.  This
  -- deliberately ignores names, opclasses, predicates and INCLUDE columns:
  -- a partial/non-default/expression/reordered homonym can still reject some
  -- A+B rows and must make both the pre-contract and post-contract gates fail.
  with target(table_oid) as (
    values
      ('public.cloud_media_items'::regclass::oid),
      ('public.cloud_title_variants'::regclass::oid),
      ('public.cloud_live_logical_channels'::regclass::oid),
      ('public.cloud_live_variants'::regclass::oid),
      ('public.catalog_series_episode_memberships'::regclass::oid),
      ('public.catalog_series_inventory_state'::regclass::oid)
  ), safe_global_identity(table_oid, key_columns) as (
    values
      ('public.cloud_media_items'::regclass::oid, array['id']::name[]),
      ('public.cloud_title_variants'::regclass::oid, array['id']::name[]),
      ('public.cloud_title_variants'::regclass::oid,
        array['user_id','title_id','id']::name[]),
      ('public.cloud_live_logical_channels'::regclass::oid,
        array['id']::name[]),
      ('public.cloud_live_variants'::regclass::oid, array['id']::name[])
  )
  select count(*)::integer into v_count
  from pg_catalog.pg_index index_state
  join target on target.table_oid = index_state.indrelid
  join pg_catalog.pg_attribute generation_attribute
    on generation_attribute.attrelid = index_state.indrelid
   and generation_attribute.attname = 'generation_id'
   and not generation_attribute.attisdropped
  where index_state.indisunique
    and index_state.indislive
    and not exists (
      select 1
      from pg_catalog.generate_series(
        0, index_state.indnkeyatts - 1
      ) key_position
      where index_state.indkey[key_position] = generation_attribute.attnum
    )
    and not exists (
      select 1
      from safe_global_identity safe
      where safe.table_oid = index_state.indrelid
        and public.norva_catalog_generation_index_is_canonical(
          index_state.indexrelid,
          safe.table_oid,
          safe.key_columns,
          true
        )
    );
  return v_count;
end
$function$;

-- Operator-only two-step repair guard for a crashed concurrent build.  It
-- takes a session advisory lock that the flag/validate/contract paths honor,
-- proves the allowlisted name, caller-supplied OID and exact index shape, and
-- refuses a valid index.  REINDEX INDEX CONCURRENTLY must then be issued as
-- the next autocommit statement in the same session, followed by the finish
-- call.  REINDEX is race-safe if an external owner replaces the object after
-- prepare: unlike DROP, it cannot delete a newly-valid homonym.
create or replace function public.norva_prepare_catalog_generation_invalid_index_repair(
  p_online_index_name name,
  p_expected_index_oid oid
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_expected record;
  v_index_oid oid;
  v_indisvalid boolean;
  v_lock_key bigint := pg_catalog.hashtextextended(
    'catalog-generation-index-repair-v1', 0
  );
begin
  if not pg_catalog.pg_try_advisory_lock(v_lock_key) then
    raise exception 'catalog generation index repair is already running'
      using errcode = '55P03';
  end if;
  begin
    if not public.norva_catalog_generation_flags_all_off() then
      raise exception 'all six provider lifecycle flags must be off for index repair'
        using errcode = '55000';
    end if;
    if not exists (
      select 1
      from public.cloud_catalog_generation_rollout rollout
      where rollout.singleton
        and rollout.phase <> 'contracted'
        and rollout.contracted_at is null
    ) then
      raise exception 'contracted catalog indexes can never use crash repair'
        using errcode = '55000';
    end if;

    select expected.* into v_expected
    from public.cloud_catalog_generation_contract_indexes expected
    where expected.online_index_name = p_online_index_name;
    if not found then
      raise exception 'catalog generation index is not in the repair allowlist'
        using errcode = '22023';
    end if;
    select index_class.oid, index_state.indisvalid
      into v_index_oid, v_indisvalid
    from pg_catalog.pg_class index_class
    join pg_catalog.pg_index index_state
      on index_state.indexrelid = index_class.oid
    where index_class.relnamespace = 'public'::regnamespace
      and index_class.relname = p_online_index_name;
    if not found or v_index_oid is distinct from p_expected_index_oid then
      raise exception 'catalog generation repair OID changed or index is absent'
        using errcode = '40001', detail = 'reason=index_oid_changed';
    end if;
    if v_indisvalid then
      raise exception 'refusing to repair an already-valid catalog generation index'
        using errcode = '55000', detail = 'reason=index_reindex_valid_refusal';
    end if;
    if exists (
      select 1 from pg_catalog.pg_constraint constraint_state
      where constraint_state.conindid = v_index_oid
    ) then
      raise exception 'refusing to reindex a contract-attached catalog generation index'
        using errcode = '55000', detail = 'reason=index_reindex_attached_refusal';
    end if;
    if not public.norva_catalog_generation_index_is_canonical(
      v_index_oid,
      v_expected.table_regclass::oid,
      v_expected.column_names,
      false
    ) then
      raise exception 'invalid catalog generation index definition drifted'
        using errcode = '55000', detail = 'reason=index_definition_drift';
    end if;
    return jsonb_build_object(
      'prepared', true,
      'indexName', p_online_index_name,
      'indexOid', v_index_oid,
      'repairStatement', format(
        'REINDEX INDEX CONCURRENTLY public.%I', p_online_index_name
      )
    );
  exception when others then
    perform pg_catalog.pg_advisory_unlock(v_lock_key);
    raise;
  end;
end
$function$;

create or replace function public.norva_finish_catalog_generation_invalid_index_repair()
returns boolean
language sql
volatile
security definer
set search_path = ''
as $function$
  select pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(
    'catalog-generation-index-repair-v1', 0
  ))
$function$;

create or replace function public.norva_catalog_generation_backfill_ready()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- Completion is a durable control-plane proof.  The bounded worker only
  -- marks a queue row complete after all six indexed per-source stages have
  -- no remaining legacy row, while discovery_complete is set only after the
  -- trigger-backed coverage backstop succeeds.  Repeating global catalogue
  -- NULL scans here would turn each validation/contract call into O(table).
  select exists (
      select 1
      from public.cloud_catalog_generation_rollout rollout
      where rollout.singleton
        and rollout.discovery_complete
        and rollout.backfill_completed_at is not null
    )
    and not exists (
      select 1
      from public.cloud_catalog_generation_backfill_sources queue
      where queue.state <> 'complete'
    )
$function$;

create or replace function public.norva_assert_catalog_generation_composite_fks()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  -- The seven ADD CONSTRAINT operations live in independent short migrations
  -- after the concurrent unique indexes.  Validation is deliberately DDL-free
  -- except for one or two VALIDATE CONSTRAINT statements per operator call.
  if (
    select count(*) <> 7
       or not coalesce(bool_and(
         public.norva_catalog_generation_constraint_is_canonical(
           constraint_state.oid,
           expected.table_regclass::oid,
           expected.constraint_type,
           expected.key_columns,
           expected.referenced_table_regclass::oid,
           expected.referenced_columns,
           expected.check_kind,
           expected.update_action,
           expected.delete_action,
           expected.match_type
         )
       ), false)
    from public.cloud_catalog_generation_contract_constraints expected
    left join pg_catalog.pg_constraint constraint_state
      on constraint_state.conrelid = expected.table_regclass
     and constraint_state.conname = expected.constraint_name
    where expected.ordinal between 22 and 28
  ) then
    raise exception 'catalog generation composite constraint definition drifted'
      using errcode = '55000', detail = 'reason=constraint_definition_drift';
  end if;
end
$function$;

create or replace function public.norva_validate_catalog_generation_constraints(
  p_limit integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(1, least(2, coalesce(p_limit, 1)));
  v_constraint record;
  v_validated integer := 0;
  v_remaining integer := 0;
  v_statement_timeout_ms bigint := 0;
begin
  select setting::bigint into v_statement_timeout_ms
  from pg_catalog.pg_settings
  where name = 'statement_timeout';
  if coalesce(v_statement_timeout_ms, 0) <= 0
     or v_statement_timeout_ms > 1800000 then
    raise exception 'validation requires statement_timeout between 1ms and 30min'
      using errcode = '55000',
        detail = 'reason=bounded_statement_timeout_required';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('catalog-generation-index-repair-v1', 0)
  ) then
    raise exception 'catalog generation index repair is running'
      using errcode = '55P03';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('catalog-generation-validate-v1', 0)
  ) then
    raise exception 'catalog generation validation is already running'
      using errcode = '55P03';
  end if;
  if not public.norva_catalog_generation_flags_all_off() then
    raise exception 'all provider lifecycle flags must remain off during validation'
      using errcode = '55000';
  end if;
  if not public.norva_catalog_generation_backfill_ready() then
    raise exception 'catalog generation backfill is incomplete'
      using errcode = '55000';
  end if;
  if not public.norva_catalog_generation_indexes_online_ready() then
    raise exception 'catalog generation concurrent indexes are not ready'
      using errcode = '55000';
  end if;
  perform public.norva_assert_catalog_generation_composite_fks();

  if not public.norva_catalog_generation_constraints_canonical(false) then
    raise exception 'catalog generation constraint plan has missing or drifted definitions'
      using errcode = '55000', detail = 'reason=constraint_definition_drift';
  end if;

  perform set_config('lock_timeout', '2s', true);
  for v_constraint in
    select expected.table_name, expected.constraint_name
    from public.cloud_catalog_generation_contract_constraints expected
    join pg_catalog.pg_constraint constraint_state
      on constraint_state.conrelid = expected.table_regclass
     and constraint_state.conname = expected.constraint_name
    where not constraint_state.convalidated
    order by expected.ordinal
    limit v_limit
  loop
    execute format(
      'alter table public.%I validate constraint %I',
      v_constraint.table_name,
      v_constraint.constraint_name
    );
    v_validated := v_validated + 1;
    update public.cloud_catalog_generation_rollout rollout
    set validation_completed_count = rollout.validation_completed_count + 1,
        validation_last_constraint = v_constraint.constraint_name,
        updated_at = clock_timestamp()
    where rollout.singleton;
  end loop;

  select count(*) into v_remaining
  from public.cloud_catalog_generation_contract_constraints expected
  join pg_catalog.pg_constraint constraint_state
    on constraint_state.conrelid = expected.table_regclass
   and constraint_state.conname = expected.constraint_name
  where not constraint_state.convalidated;

  if v_remaining = 0 then
    update public.cloud_catalog_generation_rollout rollout
    set phase = 'validated',
        constraints_validated_at = coalesce(
          rollout.constraints_validated_at, clock_timestamp()
        ),
        updated_at = clock_timestamp()
    where rollout.singleton and rollout.contracted_at is null;
  end if;
  return jsonb_build_object(
    'validated', v_validated,
    'limit', v_limit,
    'remaining', v_remaining,
    'readyToContract', v_remaining = 0
  );
end
$function$;

create or replace function public.norva_contract_catalog_generation_rollout(
  p_expected_caller_protocol text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_rollout public.cloud_catalog_generation_rollout%rowtype;
  v_nonterminal_transitions integer := 0;
  v_nonterminal_jobs integer := 0;
  v_open_generations integer := 0;
  v_generation_nullable_count integer := 0;
  v_writer_inventory_count integer := 0;
  v_missing_writer_signatures integer := 0;
  v_legacy_writer_execute_count integer := 0;
  v_legacy_transition_execute_count integer := 0;
  v_statement_timeout_ms bigint := 0;
  v_writer record;
  v_legacy_constraint record;
begin
  select setting::bigint into v_statement_timeout_ms
  from pg_catalog.pg_settings
  where name = 'statement_timeout';
  if coalesce(v_statement_timeout_ms, 0) <= 0
     or v_statement_timeout_ms > 300000 then
    raise exception 'contract requires statement_timeout between 1ms and 5min'
      using errcode = '55000',
        detail = 'reason=bounded_statement_timeout_required';
  end if;
  if p_expected_caller_protocol is distinct from
       'catalog-generation-writer-v2-live-clear-batch' then
    raise exception 'catalog generation writer v2 protocol proof is required'
      using errcode = '55000';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('catalog-generation-contract-v1', 0)
  ) then
    raise exception 'catalog generation contract is already running'
      using errcode = '55P03';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('catalog-generation-index-repair-v1', 0)
  ) then
    raise exception 'catalog generation index repair is running'
      using errcode = '55P03';
  end if;
  perform set_config('lock_timeout', '2s', true);
  select rollout.* into v_rollout
  from public.cloud_catalog_generation_rollout rollout
  where rollout.singleton
  for update;

  select count(*) into v_writer_inventory_count
  from public.cloud_catalog_generation_contract_legacy_writers writer
  where writer.caller_protocol = p_expected_caller_protocol;
  if v_writer_inventory_count <> 4 then
    raise exception 'catalog generation writer contract inventory is incomplete: %/4',
      v_writer_inventory_count using errcode = '55000';
  end if;
  if pg_catalog.to_regprocedure(
       'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)'
     ) is null
     or not coalesce(pg_catalog.has_function_privilege(
       'service_role',
       pg_catalog.to_regprocedure(
         'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text,text)'
       ),
       'EXECUTE'
     ), false)
     or pg_catalog.to_regprocedure(
       'public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer,text,bigint,text)'
     ) is null
     or not coalesce(pg_catalog.has_function_privilege(
       'service_role',
       pg_catalog.to_regprocedure(
         'public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer,text,bigint,text)'
       ),
       'EXECUTE'
     ), false) then
    raise exception 'atomic transition or snapshot-fenced fallback caller signature is unavailable'
      using errcode = '55000';
  end if;
  if v_rollout.phase = 'contracted' and v_rollout.contracted_at is not null then
    if v_rollout.contract_caller_protocol is distinct from
         p_expected_caller_protocol then
      raise exception 'catalog generation contract caller protocol mismatch'
        using errcode = '55000';
    end if;
    select count(*) into v_missing_writer_signatures
    from public.cloud_catalog_generation_contract_legacy_writers writer
    where pg_catalog.to_regprocedure(writer.replacement_signature) is null
       or not coalesce(pg_catalog.has_function_privilege(
         'service_role',
         pg_catalog.to_regprocedure(writer.replacement_signature),
         'EXECUTE'
       ), false);
    if v_missing_writer_signatures <> 0 then
      raise exception 'catalog generation replacement writer regressed: %',
        v_missing_writer_signatures using errcode = '55000';
    end if;
    select count(*) into v_legacy_writer_execute_count
    from public.cloud_catalog_generation_contract_legacy_writers writer
    where pg_catalog.to_regprocedure(writer.legacy_signature) is not null
      and coalesce(pg_catalog.has_function_privilege(
        'service_role',
        pg_catalog.to_regprocedure(writer.legacy_signature),
        'EXECUTE'
      ), false);
    if v_legacy_writer_execute_count <> 0 then
      raise exception 'catalog generation legacy writer privilege regressed: %',
        v_legacy_writer_execute_count using errcode = '55000';
    end if;
    select count(*) into v_legacy_transition_execute_count
    from pg_catalog.unnest(array[
      'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)'::text,
      'public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)'::text,
      'public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer)'::text
    ]) legacy(signature)
    where pg_catalog.to_regprocedure(legacy.signature) is not null
      and coalesce(pg_catalog.has_function_privilege(
        'service_role', pg_catalog.to_regprocedure(legacy.signature), 'EXECUTE'
      ), false);
    if v_legacy_transition_execute_count <> 0 then
      raise exception 'legacy two-step transition writer privilege regressed: %',
        v_legacy_transition_execute_count using errcode = '55000';
    end if;
    if not public.norva_catalog_generation_indexes_attached()
       or not public.norva_catalog_generation_constraints_canonical(true)
       or not public.norva_title_gc_indexes_ready()
       or not public.norva_catalog_title_projection_indexes_ready() then
      raise exception 'contracted catalog generation metadata drifted'
        using errcode = '55000', detail = 'reason=contract_metadata_drift';
    end if;
    if public.norva_catalog_generation_legacy_blocking_constraint_count() <> 0
       or public.norva_catalog_generation_legacy_blocking_index_count() <> 0 then
      raise exception 'generation-unaware legacy blocker regressed after contract'
        using errcode = '55000', detail = 'reason=legacy_blocker_regressed';
    end if;
    select count(*) into v_generation_nullable_count
    from pg_catalog.pg_attribute attribute_state
    where (attribute_state.attrelid, attribute_state.attname) in (
      ('public.cloud_media_items'::regclass, 'generation_id'),
      ('public.cloud_title_variants'::regclass, 'generation_id'),
      ('public.cloud_live_logical_channels'::regclass, 'generation_id'),
      ('public.cloud_live_variants'::regclass, 'generation_id'),
      ('public.catalog_series_episode_memberships'::regclass, 'generation_id'),
      ('public.catalog_series_inventory_state'::regclass, 'generation_id')
    ) and not attribute_state.attnotnull;
    if v_generation_nullable_count <> 0 then
      raise exception 'contracted generation columns became nullable: %',
        v_generation_nullable_count using errcode = '55000';
    end if;
    return jsonb_build_object(
      'contracted', true,
      'contractedAt', v_rollout.contracted_at,
      'idempotent', true,
      'legacyWritersExecutable', v_legacy_writer_execute_count,
      'legacyTransitionWritersExecutable', v_legacy_transition_execute_count
    );
  end if;

  select count(*) into v_missing_writer_signatures
  from public.cloud_catalog_generation_contract_legacy_writers writer
  where pg_catalog.to_regprocedure(writer.legacy_signature) is null
     or pg_catalog.to_regprocedure(writer.replacement_signature) is null
     or not coalesce(pg_catalog.has_function_privilege(
       'service_role',
       pg_catalog.to_regprocedure(writer.replacement_signature),
       'EXECUTE'
     ), false);
  if v_missing_writer_signatures <> 0 then
    raise exception 'catalog generation replacement writer gate failed: %',
      v_missing_writer_signatures using errcode = '55000';
  end if;
  if pg_catalog.to_regprocedure(
       'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer)'
     ) is null then
    raise exception 'legacy transition/fallback signature inventory is incomplete'
      using errcode = '55000';
  end if;
  if v_rollout.phase <> 'validated'
     or v_rollout.constraints_validated_at is null then
    raise exception 'catalog generation constraints are not fully validated'
      using errcode = '55000';
  end if;
  if not public.norva_catalog_generation_flags_all_off() then
    raise exception 'all six provider lifecycle flags must be off at contract'
      using errcode = '55000';
  end if;
  if not public.norva_catalog_generation_backfill_ready()
     or not public.norva_catalog_generation_indexes_online_ready()
     or not public.norva_title_gc_indexes_ready()
     or not public.norva_catalog_title_projection_indexes_ready() then
    raise exception 'catalog generation backfill or indexes regressed'
      using errcode = '55000';
  end if;
  if not public.norva_catalog_generation_constraints_canonical(true) then
    raise exception 'catalog generation contract constraints are invalid or drifted'
      using errcode = '55000', detail = 'reason=constraint_definition_drift';
  end if;
  if not public.norva_catalog_generation_legacy_blockers_canonical()
     or public.norva_catalog_generation_legacy_blocking_constraint_count() <> 10
     or public.norva_catalog_generation_legacy_blocking_index_count() <> 8 then
    raise exception 'generation-unaware legacy blocker inventory drifted'
      using errcode = '55000', detail = 'reason=legacy_blocker_drift';
  end if;

  select count(*) into v_nonterminal_transitions
  from public.cloud_source_transitions transition
  where transition.state not in ('completed', 'failed', 'cancelled');
  select count(*) into v_nonterminal_jobs
  from public.cloud_source_credential_transition_jobs job
  where job.state in ('pending', 'processing');
  select count(*) into v_open_generations
  from public.cloud_source_catalog_generations generation
  where generation.state in ('building', 'ready', 'purging');
  if v_nonterminal_transitions <> 0 or v_nonterminal_jobs <> 0
     or v_open_generations <> 0 then
    raise exception 'catalog generation contract requires no in-flight work'
      using errcode = '55000',
        detail = format(
          'transitions=%s jobs=%s generations=%s',
          v_nonterminal_transitions, v_nonterminal_jobs, v_open_generations
        );
  end if;

  -- Acquire every traffic-table metadata lock in one canonical order before
  -- the first DDL.  lock_timeout is 2s and the caller-enforced statement
  -- timeout caps the complete contract transaction; any failure rolls back
  -- all metadata and counters atomically.
  lock table
    public.catalog_series_episode_memberships,
    public.catalog_series_inventory_state,
    public.cloud_live_logical_channels,
    public.cloud_live_variants,
    public.cloud_media_items,
    public.cloud_title_variants
  in access exclusive mode;

  -- Validated generation_required checks make these metadata-only on PG15.
  execute 'alter table public.cloud_media_items alter column generation_id set not null';
  execute 'alter table public.cloud_title_variants alter column generation_id set not null';
  execute 'alter table public.cloud_live_logical_channels alter column generation_id set not null';
  execute 'alter table public.cloud_live_variants alter column generation_id set not null';
  execute 'alter table public.catalog_series_episode_memberships alter column generation_id set not null';
  execute 'alter table public.catalog_series_inventory_state alter column generation_id set not null';

  -- Discover legacy blockers structurally, so a renamed UNIQUE/PK/FK cannot
  -- survive a name-based IF EXISTS no-op and silently keep A/B mutually
  -- exclusive.  FK rows are ordered before the unique keys they reference.
  for v_legacy_constraint in
    select expected.table_name, constraint_state.conname
    from public.cloud_catalog_generation_contract_legacy_constraints expected
    join pg_catalog.pg_constraint constraint_state
      on constraint_state.conrelid = expected.table_regclass
     and constraint_state.contype::text = expected.constraint_type
     and public.norva_catalog_generation_constraint_is_canonical(
       constraint_state.oid,
       expected.table_regclass::oid,
       expected.constraint_type,
       expected.key_columns,
       expected.referenced_table_regclass::oid,
       expected.referenced_columns,
       null,
       expected.update_action,
       expected.delete_action,
       expected.match_type
     )
    order by expected.ordinal
  loop
    execute format(
      'alter table public.%I drop constraint %I',
      v_legacy_constraint.table_name,
      v_legacy_constraint.conname
    );
  end loop;

  if public.norva_catalog_generation_legacy_blocking_constraint_count() <> 0
     or public.norva_catalog_generation_legacy_blocking_index_count() <> 0 then
    raise exception 'generation-unaware legacy blockers remain after contract drop'
      using errcode = '55000', detail = 'reason=legacy_blocker_remaining';
  end if;

  execute $ddl$
    alter table public.cloud_media_items
      add constraint cloud_media_items_generation_natural_uidx unique using index cloud_media_items_generation_natural_online_uidx,
      add constraint cloud_media_items_generation_identity_uidx unique using index cloud_media_items_generation_identity_online_uidx
  $ddl$;
  execute $ddl$
    alter table public.cloud_title_variants
      add constraint cloud_title_variants_generation_natural_uidx unique using index cloud_title_variants_generation_natural_online_uidx,
      add constraint cloud_title_variants_generation_identity_uidx unique using index cloud_title_variants_generation_identity_online_uidx
  $ddl$;
  execute $ddl$
    alter table public.cloud_live_logical_channels
      add constraint cloud_live_logical_channels_generation_natural_uidx unique using index cloud_live_logical_generation_natural_online_uidx,
      add constraint cloud_live_logical_channels_generation_identity_uidx unique using index cloud_live_logical_generation_identity_online_uidx
  $ddl$;
  execute $ddl$
    alter table public.cloud_live_variants
      add constraint cloud_live_variants_generation_natural_uidx unique using index cloud_live_variants_generation_natural_online_uidx
  $ddl$;
  execute $ddl$
    alter table public.catalog_series_episode_memberships
      add constraint catalog_series_episode_memberships_pkey primary key using index catalog_series_memberships_generation_pk_online_uidx,
      add constraint catalog_series_episode_memberships_variant_episode_uidx unique using index catalog_series_memberships_variant_online_uidx
  $ddl$;
  execute $ddl$
    alter table public.catalog_series_inventory_state
      add constraint catalog_series_inventory_state_pkey primary key using index catalog_series_inventory_generation_pk_online_uidx,
      add constraint catalog_series_inventory_state_variant_uidx unique using index catalog_series_inventory_variant_online_uidx
  $ddl$;

  if not public.norva_catalog_generation_indexes_attached() then
    raise exception 'catalog generation attached index metadata drifted'
      using errcode = '55000', detail = 'reason=index_definition_drift';
  end if;

  -- All compatibility writers stay executable throughout expand.  The exact
  -- caller marker plus a complete replacement-signature inventory is the only
  -- boundary allowed to revoke them.
  for v_writer in
    select writer.legacy_signature
    from public.cloud_catalog_generation_contract_legacy_writers writer
    order by writer.ordinal
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      v_writer.legacy_signature
    );
  end loop;
  select count(*) into v_legacy_writer_execute_count
  from public.cloud_catalog_generation_contract_legacy_writers writer
  where coalesce(pg_catalog.has_function_privilege(
    'service_role',
    pg_catalog.to_regprocedure(writer.legacy_signature),
    'EXECUTE'
  ), false);
  if v_legacy_writer_execute_count <> 0 then
    raise exception 'catalog generation legacy writer revoke failed: %',
      v_legacy_writer_execute_count using errcode = '55000';
  end if;

  execute $ddl$
    revoke all on function
      public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text),
      public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint),
      public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer)
    from public, anon, authenticated, service_role
  $ddl$;
  select count(*) into v_legacy_transition_execute_count
  from pg_catalog.unnest(array[
    'public.norva_create_credential_transition(uuid,uuid,text,text,bigint,text,jsonb,text)'::text,
    'public.norva_bind_credential_transition_account_affinity(uuid,uuid,text,bigint)'::text,
    'public.norva_claim_source_direct_fallback_lease(uuid,uuid,text,integer)'::text
  ]) legacy(signature)
  where coalesce(pg_catalog.has_function_privilege(
    'service_role', pg_catalog.to_regprocedure(legacy.signature), 'EXECUTE'
  ), false);
  if v_legacy_transition_execute_count <> 0 then
    raise exception 'legacy two-step transition writer revoke failed: %',
      v_legacy_transition_execute_count using errcode = '55000';
  end if;

  update public.cloud_catalog_generation_rollout rollout
  set phase = 'contracted',
      contracted_at = clock_timestamp(),
      contract_caller_protocol = p_expected_caller_protocol,
      updated_at = clock_timestamp()
  where rollout.singleton;
  return jsonb_build_object(
    'contracted', true,
    'contractedAt', clock_timestamp(),
    'idempotent', false,
    'revokedLegacyWriters', v_writer_inventory_count,
    'legacyWritersExecutable', v_legacy_writer_execute_count,
    'legacyTransitionWritersExecutable', v_legacy_transition_execute_count
  );
end
$function$;

/* Grants are applied once all later definitions exist, immediately before the
   single final COMMIT.
revoke all on function
  public.norva_catalog_generation_flags_all_off(),
  public.norva_catalog_generation_index_is_canonical(oid,oid,name[],boolean),
  public.norva_catalog_generation_indexes_ready(),
  public.norva_catalog_generation_indexes_online_ready(),
  public.norva_catalog_generation_indexes_attached(),
  public.norva_catalog_generation_constraint_is_canonical(oid,oid,text,name[],oid,name[],text,text,text,text),
  public.norva_catalog_generation_constraints_canonical(boolean),
  public.norva_assert_catalog_generation_contract_constraint(name,boolean),
  public.norva_catalog_generation_legacy_blockers_canonical(),
  public.norva_catalog_generation_legacy_blocking_constraint_count(),
  public.norva_catalog_generation_legacy_blocking_index_count(),
  public.norva_prepare_catalog_generation_invalid_index_repair(name,oid),
  public.norva_finish_catalog_generation_invalid_index_repair(),
  public.norva_catalog_generation_backfill_ready(),
  public.norva_assert_catalog_generation_composite_fks(),
  public.norva_catalog_generation_flag_contract_guard(),
  public.norva_catalog_generation_guard_begin_statement(),
  public.norva_catalog_generation_write_guard()
from public, anon, authenticated, service_role;

revoke all on function
  public.norva_discover_catalog_generation_backfill_sources(integer),
  public.norva_backfill_catalog_generation_batch(text,integer,integer),
  public.norva_retry_catalog_generation_backfill_source(uuid),
  public.norva_validate_catalog_generation_constraints(integer),
  public.norva_contract_catalog_generation_rollout(text)
from public, anon, authenticated, service_role;

grant execute on function
  public.norva_discover_catalog_generation_backfill_sources(integer),
  public.norva_backfill_catalog_generation_batch(text,integer,integer),
  public.norva_retry_catalog_generation_backfill_source(uuid),
  public.norva_validate_catalog_generation_constraints(integer),
  public.norva_contract_catalog_generation_rollout(text)
to service_role;

notify pgrst, 'reload schema';

commit;
*/

create or replace function public.norva_catalog_generation_flags_all_off()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select count(*) = 6 and coalesce(bool_and(not flag.enabled), false)
  from public.admin_feature_flags flag
  where flag.key in (
    'provider_access_v1_enabled',
    'provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled',
    'provider_access_visibility_v1_enabled',
    'provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  )
$function$;

create or replace function public.norva_discover_catalog_generation_backfill_sources(
  p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(1, least(100, coalesce(p_limit, 50)));
  v_inspected integer := 0;
  v_inserted integer := 0;
  v_complete boolean := false;
  v_cursor uuid;
  v_next_cursor uuid;
begin
  select rollout.discovery_cursor into v_cursor
  from public.cloud_catalog_generation_rollout rollout
  where rollout.singleton and rollout.contracted_at is null
  for update;
  if not found then
    raise exception 'catalog generation rollout is already contracted'
      using errcode = '55000';
  end if;
  if not public.norva_catalog_generation_flags_all_off() then
    raise exception 'all provider lifecycle flags must remain off during backfill'
      using errcode = '55000';
  end if;
  -- Keyset over every source, including rows already queued by the concurrent
  -- source bootstrap trigger.  This bounds inspected rows and lets the cursor
  -- advance without an O(n^2) NOT EXISTS rescan.
  with candidates as materialized (
    select source.id, source.user_id
    from public.cloud_sources source
    where v_cursor is null or source.id > v_cursor
    order by source.id
    limit v_limit
  ), inserted as (
    insert into public.cloud_catalog_generation_backfill_sources (
      source_id, user_id
    )
    select candidate.id, candidate.user_id
    from candidates candidate
    on conflict (source_id) do nothing
    returning source_id
  )
  select count(candidate.id)::integer,
         count(inserted.source_id)::integer,
         (array_agg(candidate.id order by candidate.id desc))[1]
    into v_inspected, v_inserted, v_next_cursor
  from candidates candidate
  left join inserted on inserted.source_id = candidate.id;

  -- The only global backstop scan runs when the keyset reaches its end.  It
  -- proves queue coverage; new sources on either side of the UUID cursor are
  -- queued atomically by trg_cloud_sources_catalog_generation_bootstrap.
  if v_inspected < v_limit then
    select not exists (
      select 1
      from public.cloud_sources source
      where not exists (
        select 1
        from public.cloud_catalog_generation_backfill_sources queued
        where queued.source_id = source.id
          and queued.user_id = source.user_id
      )
    ) into v_complete;
  end if;
  update public.cloud_catalog_generation_rollout rollout
  set phase = case when rollout.phase = 'expanded' then 'backfilling' else rollout.phase end,
      discovery_cursor = coalesce(v_next_cursor, rollout.discovery_cursor),
      discovery_complete = v_complete,
      discovered_sources = rollout.discovered_sources + v_inspected,
      backfill_started_at = coalesce(rollout.backfill_started_at, clock_timestamp()),
      backfill_completed_at = case
        when v_complete and not exists (
          select 1
          from public.cloud_catalog_generation_backfill_sources pending
          where pending.state <> 'complete'
        ) then coalesce(rollout.backfill_completed_at, clock_timestamp())
        else rollout.backfill_completed_at
      end,
      updated_at = clock_timestamp()
  where rollout.singleton;

  return jsonb_build_object(
    'inspected', v_inspected,
    'inserted', v_inserted,
    'limit', v_limit,
    'discoveryComplete', v_complete,
    'cursor', coalesce(v_next_cursor, v_cursor)
  );
end
$function$;

create or replace function public.norva_backfill_catalog_generation_batch(
  p_worker text,
  p_limit integer default 250,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker text := btrim(coalesce(p_worker, ''));
  v_limit integer := greatest(1, least(500, coalesce(p_limit, 250)));
  v_lease_seconds integer := greatest(30, least(600, coalesce(p_lease_seconds, 120)));
  v_queue public.cloud_catalog_generation_backfill_sources%rowtype;
  v_generation_id uuid;
  v_rows integer := 0;
  v_has_more boolean := false;
  v_has_resolvable boolean := false;
  v_next_stage text;
  v_next_state text := 'pending';
  v_error_code text;
  v_now timestamptz := clock_timestamp();
  v_completed_now boolean := false;
begin
  if v_worker = '' or length(v_worker) > 160 or v_worker ~ '[[:cntrl:]]' then
    raise exception 'invalid catalog generation backfill worker'
      using errcode = '22023';
  end if;
  if not public.norva_catalog_generation_flags_all_off() then
    raise exception 'all provider lifecycle flags must remain off during backfill'
      using errcode = '55000';
  end if;
  -- Every stage lookup is bounded by a canonical online index whose leading
  -- keys are (source_id, generation_id).  Refuse to run on a partially applied
  -- rollout instead of degrading to repeated heap scans.
  if not public.norva_catalog_generation_indexes_online_ready() then
    raise exception 'catalog generation concurrent indexes are required for backfill'
      using errcode = '55000', detail = 'reason=backfill_indexes_not_ready';
  end if;
  perform 1
  from public.cloud_catalog_generation_rollout rollout
  where rollout.singleton and rollout.contracted_at is null
  for key share;
  if not found then
    raise exception 'catalog generation rollout is already contracted'
      using errcode = '55000';
  end if;

  select queue.* into v_queue
  from public.cloud_catalog_generation_backfill_sources queue
  where queue.state = 'pending'
     or (queue.state = 'processing' and queue.lease_until <= v_now)
  order by
    case when queue.state = 'processing' then 0 else 1 end,
    queue.updated_at,
    queue.source_id
  for update skip locked
  limit 1;
  if not found then
    return jsonb_build_object(
      'claimed', false,
      'limit', v_limit
    );
  end if;

  v_generation_id := public.norva_ensure_source_catalog_head(
    v_queue.source_id, v_queue.user_id
  );
  if v_queue.active_generation_id is not null
     and v_queue.active_generation_id is distinct from v_generation_id then
    update public.cloud_catalog_generation_backfill_sources queue
    set state = 'failed',
        last_error_code = 'source_owner_mismatch',
        lease_owner = null,
        lease_token = null,
        lease_until = null,
        updated_at = v_now
    where queue.source_id = v_queue.source_id;
    raise exception 'catalog generation backfill head changed unexpectedly'
      using errcode = '40001';
  end if;
  update public.cloud_catalog_generation_backfill_sources queue
  set state = 'processing',
      active_generation_id = v_generation_id,
      lease_owner = v_worker,
      lease_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => v_lease_seconds),
      attempt_count = queue.attempt_count + 1,
      last_error_code = null,
      updated_at = v_now
  where queue.source_id = v_queue.source_id;

  perform set_config(
    'norva.catalog_online_backfill_generation', v_generation_id::text, true
  );
  v_next_stage := v_queue.stage;

  if v_queue.stage = 'cloud_media_items' then
    with target as (
      select item.ctid
      from public.cloud_media_items item
      where item.source_id = v_queue.source_id
        and item.user_id = v_queue.user_id
        and item.generation_id is null
      order by item.generation_id, item.id
      for update skip locked
      limit v_limit
    )
    update public.cloud_media_items item
    set generation_id = v_generation_id
    from target
    where item.ctid = target.ctid;
    get diagnostics v_rows = row_count;
    select exists (
      select 1 from public.cloud_media_items item
      where item.source_id = v_queue.source_id
        and item.user_id = v_queue.user_id and item.generation_id is null
    ) into v_has_more;
    if not v_has_more then v_next_stage := 'cloud_title_variants'; end if;
  elsif v_queue.stage = 'cloud_title_variants' then
    with target as (
      select variant.ctid
      from public.cloud_title_variants variant
      where variant.source_id = v_queue.source_id
        and variant.user_id = v_queue.user_id
        and variant.generation_id is null
      order by variant.generation_id, variant.id
      for update skip locked
      limit v_limit
    )
    update public.cloud_title_variants variant
    set generation_id = v_generation_id
    from target
    where variant.ctid = target.ctid;
    get diagnostics v_rows = row_count;
    select exists (
      select 1 from public.cloud_title_variants variant
      where variant.source_id = v_queue.source_id
        and variant.user_id = v_queue.user_id and variant.generation_id is null
    ) into v_has_more;
    if not v_has_more then v_next_stage := 'cloud_live_logical_channels'; end if;
  elsif v_queue.stage = 'cloud_live_logical_channels' then
    with target as (
      select channel.ctid
      from public.cloud_live_logical_channels channel
      where channel.source_id = v_queue.source_id
        and channel.user_id = v_queue.user_id
        and channel.generation_id is null
      order by channel.generation_id, channel.id
      for update skip locked
      limit v_limit
    )
    update public.cloud_live_logical_channels channel
    set generation_id = v_generation_id
    from target
    where channel.ctid = target.ctid;
    get diagnostics v_rows = row_count;
    select exists (
      select 1 from public.cloud_live_logical_channels channel
      where channel.source_id = v_queue.source_id
        and channel.user_id = v_queue.user_id and channel.generation_id is null
    ) into v_has_more;
    if not v_has_more then v_next_stage := 'cloud_live_variants'; end if;
  elsif v_queue.stage = 'cloud_live_variants' then
    with target as (
      select variant.ctid
      from public.cloud_live_variants variant
      where variant.source_id = v_queue.source_id
        and variant.user_id = v_queue.user_id
        and variant.generation_id is null
      order by
        variant.generation_id, variant.logical_id, variant.stream_id, variant.label
      for update skip locked
      limit v_limit
    )
    update public.cloud_live_variants variant
    set generation_id = v_generation_id
    from target
    where variant.ctid = target.ctid;
    get diagnostics v_rows = row_count;
    select exists (
      select 1 from public.cloud_live_variants variant
      where variant.source_id = v_queue.source_id
        and variant.user_id = v_queue.user_id and variant.generation_id is null
    ) into v_has_more;
    if not v_has_more then
      v_next_stage := 'catalog_series_episode_memberships';
    end if;
  elsif v_queue.stage = 'catalog_series_episode_memberships' then
    with target as (
      select membership.ctid, parent.generation_id
      from public.catalog_series_episode_memberships membership
      join public.cloud_title_variants parent
        on parent.id = membership.parent_variant_id
       and parent.source_id = membership.source_id
       and parent.user_id = membership.user_id
      where membership.source_id = v_queue.source_id
        and membership.user_id = v_queue.user_id
        and membership.generation_id is null
        and parent.generation_id = v_generation_id
      order by
        membership.generation_id, membership.parent_series_id, membership.episode_id
      for update of membership skip locked
      limit v_limit
    )
    update public.catalog_series_episode_memberships membership
    set generation_id = target.generation_id
    from target
    where membership.ctid = target.ctid;
    get diagnostics v_rows = row_count;
    select exists (
      select 1 from public.catalog_series_episode_memberships membership
      where membership.source_id = v_queue.source_id
        and membership.user_id = v_queue.user_id
        and membership.generation_id is null
    ) into v_has_more;
    if v_has_more then
      select exists (
        select 1
        from public.catalog_series_episode_memberships membership
        join public.cloud_title_variants parent
          on parent.id = membership.parent_variant_id
         and parent.source_id = membership.source_id
         and parent.user_id = membership.user_id
        where membership.source_id = v_queue.source_id
          and membership.user_id = v_queue.user_id
          and membership.generation_id is null
          and parent.generation_id = v_generation_id
      ) into v_has_resolvable;
      if v_rows = 0 and not v_has_resolvable then
        v_next_state := 'failed';
        v_error_code := 'parent_generation_missing';
      end if;
    else
      v_next_stage := 'catalog_series_inventory_state';
    end if;
  elsif v_queue.stage = 'catalog_series_inventory_state' then
    with target as (
      select inventory.ctid, parent.generation_id
      from public.catalog_series_inventory_state inventory
      join public.cloud_title_variants parent
        on parent.id = inventory.parent_variant_id
       and parent.source_id = inventory.source_id
       and parent.user_id = inventory.user_id
      where inventory.source_id = v_queue.source_id
        and inventory.user_id = v_queue.user_id
        and inventory.generation_id is null
        and parent.generation_id = v_generation_id
      order by inventory.generation_id, inventory.parent_series_id
      for update of inventory skip locked
      limit v_limit
    )
    update public.catalog_series_inventory_state inventory
    set generation_id = target.generation_id
    from target
    where inventory.ctid = target.ctid;
    get diagnostics v_rows = row_count;
    select exists (
      select 1 from public.catalog_series_inventory_state inventory
      where inventory.source_id = v_queue.source_id
        and inventory.user_id = v_queue.user_id
        and inventory.generation_id is null
    ) into v_has_more;
    if v_has_more then
      select exists (
        select 1
        from public.catalog_series_inventory_state inventory
        join public.cloud_title_variants parent
          on parent.id = inventory.parent_variant_id
         and parent.source_id = inventory.source_id
         and parent.user_id = inventory.user_id
        where inventory.source_id = v_queue.source_id
          and inventory.user_id = v_queue.user_id
          and inventory.generation_id is null
          and parent.generation_id = v_generation_id
      ) into v_has_resolvable;
      if v_rows = 0 and not v_has_resolvable then
        v_next_state := 'failed';
        v_error_code := 'parent_generation_missing';
      end if;
    else
      v_next_stage := 'complete';
      v_next_state := 'complete';
      v_completed_now := true;
    end if;
  else
    v_next_stage := 'complete';
    v_next_state := 'complete';
  end if;

  update public.cloud_catalog_generation_backfill_sources queue
  set stage = v_next_stage,
      state = v_next_state,
      lease_owner = null,
      lease_token = null,
      lease_until = null,
      rows_backfilled = queue.rows_backfilled + v_rows,
      last_batch_rows = v_rows,
      last_error_code = v_error_code,
      completed_at = case when v_next_state = 'complete' then v_now else null end,
      updated_at = v_now
  where queue.source_id = v_queue.source_id;

  if v_completed_now then
    update public.cloud_catalog_generation_rollout rollout
    set completed_sources = rollout.completed_sources + 1,
        backfill_completed_at = case when rollout.discovery_complete and not exists (
          select 1
          from public.cloud_catalog_generation_backfill_sources pending
          where pending.source_id <> v_queue.source_id
            and pending.state <> 'complete'
        ) then v_now else rollout.backfill_completed_at end,
        updated_at = v_now
    where rollout.singleton;
  end if;

  return jsonb_build_object(
    'claimed', true,
    'sourceId', v_queue.source_id,
    'generationId', v_generation_id,
    'stageBefore', v_queue.stage,
    'stageAfter', v_next_stage,
    'state', v_next_state,
    'rowsBackfilled', v_rows,
    'limit', v_limit,
    'errorCode', v_error_code,
    'guardValidationCount', coalesce(nullif(current_setting(
      'norva.catalog_guard_validation_count', true
    ), '')::integer, 0)
  );
end
$function$;

create or replace function public.norva_retry_catalog_generation_backfill_source(
  p_source_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_changed integer := 0;
begin
  if not public.norva_catalog_generation_flags_all_off() then
    raise exception 'all provider lifecycle flags must remain off during backfill'
      using errcode = '55000';
  end if;
  update public.cloud_catalog_generation_backfill_sources queue
  set state = 'pending',
      last_error_code = 'operator_retry',
      updated_at = clock_timestamp()
  where queue.source_id = p_source_id and queue.state = 'failed';
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end
$function$;

create table public.cloud_catalog_generation_contract_indexes (
  ordinal smallint primary key,
  table_regclass regclass not null,
  online_index_name name not null unique,
  attached_constraint_name name not null unique,
  constraint_type text not null check (constraint_type in ('p', 'u')),
  column_names name[] not null check (cardinality(column_names) between 1 and 8)
);

insert into public.cloud_catalog_generation_contract_indexes(
  ordinal, table_regclass, online_index_name, attached_constraint_name,
  constraint_type, column_names
)
values
  (1, 'public.cloud_media_items'::regclass,
    'cloud_media_items_generation_natural_online_uidx',
    'cloud_media_items_generation_natural_uidx', 'u',
    array['source_id','generation_id','item_type','external_id']::name[]),
  (2, 'public.cloud_title_variants'::regclass,
    'cloud_title_variants_generation_natural_online_uidx',
    'cloud_title_variants_generation_natural_uidx', 'u',
    array['source_id','generation_id','item_type','external_id']::name[]),
  (3, 'public.cloud_live_logical_channels'::regclass,
    'cloud_live_logical_generation_natural_online_uidx',
    'cloud_live_logical_channels_generation_natural_uidx', 'u',
    array['source_id','generation_id','logical_id']::name[]),
  (4, 'public.cloud_live_variants'::regclass,
    'cloud_live_variants_generation_natural_online_uidx',
    'cloud_live_variants_generation_natural_uidx', 'u',
    array['source_id','generation_id','logical_id','stream_id','label']::name[]),
  (5, 'public.cloud_media_items'::regclass,
    'cloud_media_items_generation_identity_online_uidx',
    'cloud_media_items_generation_identity_uidx', 'u',
    array['source_id','generation_id','id']::name[]),
  (6, 'public.cloud_title_variants'::regclass,
    'cloud_title_variants_generation_identity_online_uidx',
    'cloud_title_variants_generation_identity_uidx', 'u',
    array['source_id','generation_id','id']::name[]),
  (7, 'public.cloud_live_logical_channels'::regclass,
    'cloud_live_logical_generation_identity_online_uidx',
    'cloud_live_logical_channels_generation_identity_uidx', 'u',
    array['source_id','generation_id','id']::name[]),
  (8, 'public.catalog_series_episode_memberships'::regclass,
    'catalog_series_memberships_generation_pk_online_uidx',
    'catalog_series_episode_memberships_pkey', 'p',
    array['source_id','generation_id','parent_series_id','episode_id']::name[]),
  (9, 'public.catalog_series_episode_memberships'::regclass,
    'catalog_series_memberships_variant_online_uidx',
    'catalog_series_episode_memberships_variant_episode_uidx', 'u',
    array['user_id','generation_id','parent_variant_id','episode_id']::name[]),
  (10, 'public.catalog_series_inventory_state'::regclass,
    'catalog_series_inventory_generation_pk_online_uidx',
    'catalog_series_inventory_state_pkey', 'p',
    array['source_id','generation_id','parent_series_id']::name[]),
  (11, 'public.catalog_series_inventory_state'::regclass,
    'catalog_series_inventory_variant_online_uidx',
    'catalog_series_inventory_state_variant_uidx', 'u',
    array['user_id','generation_id','parent_variant_id']::name[]);

create table public.cloud_catalog_generation_contract_constraints (
  ordinal smallint primary key,
  table_regclass regclass not null,
  table_name name not null,
  constraint_name name not null unique,
  constraint_type text not null check (constraint_type in ('c', 'f')),
  key_columns name[] not null,
  referenced_table_regclass regclass,
  referenced_columns name[],
  check_kind text check (
    check_kind is null or check_kind in (
      'request_fingerprint', 'generation_required', 'ingest_lease'
    )
  ),
  update_action text check (update_action is null or update_action in ('a','r','c','n','d')),
  delete_action text check (delete_action is null or delete_action in ('a','r','c','n','d')),
  match_type text check (match_type is null or match_type in ('s','f','p')),
  check (
    (constraint_type = 'c' and check_kind is not null
      and referenced_table_regclass is null and referenced_columns is null
      and update_action is null and delete_action is null and match_type is null)
    or
    (constraint_type = 'f' and check_kind is null
      and referenced_table_regclass is not null and referenced_columns is not null
      and update_action is not null and delete_action is not null and match_type is not null)
  )
);

insert into public.cloud_catalog_generation_contract_constraints(
  ordinal, table_regclass, table_name, constraint_name, constraint_type,
  key_columns, referenced_table_regclass, referenced_columns, check_kind,
  update_action, delete_action, match_type
)
values
  (1,'public.cloud_source_transitions'::regclass,'cloud_source_transitions',
    'cloud_source_transitions_request_fingerprint_ck','c',array['request_fingerprint']::name[],
    null,null,'request_fingerprint',null,null,null),
  (2,'public.cloud_media_items'::regclass,'cloud_media_items',
    'cloud_media_items_generation_required_ck','c',array['generation_id']::name[],
    null,null,'generation_required',null,null,null),
  (3,'public.cloud_media_items'::regclass,'cloud_media_items',
    'cloud_media_items_generation_fk','f',array['source_id','generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['source_id','id']::name[],null,'c','r','s'),
  (4,'public.cloud_media_items'::regclass,'cloud_media_items',
    'cloud_media_items_ingest_lease_ck','c',array['ingest_job_id','ingest_attempt','ingest_lease_owner']::name[],
    null,null,'ingest_lease',null,null,null),
  (5,'public.cloud_title_variants'::regclass,'cloud_title_variants',
    'cloud_title_variants_generation_required_ck','c',array['generation_id']::name[],
    null,null,'generation_required',null,null,null),
  (6,'public.cloud_title_variants'::regclass,'cloud_title_variants',
    'cloud_title_variants_generation_fk','f',array['source_id','generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['source_id','id']::name[],null,'c','r','s'),
  (7,'public.cloud_title_variants'::regclass,'cloud_title_variants',
    'cloud_title_variants_ingest_lease_ck','c',array['ingest_job_id','ingest_attempt','ingest_lease_owner']::name[],
    null,null,'ingest_lease',null,null,null),
  (8,'public.cloud_live_logical_channels'::regclass,'cloud_live_logical_channels',
    'cloud_live_logical_channels_generation_required_ck','c',array['generation_id']::name[],
    null,null,'generation_required',null,null,null),
  (9,'public.cloud_live_logical_channels'::regclass,'cloud_live_logical_channels',
    'cloud_live_logical_channels_generation_fk','f',array['source_id','generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['source_id','id']::name[],null,'c','r','s'),
  (10,'public.cloud_live_logical_channels'::regclass,'cloud_live_logical_channels',
    'cloud_live_logical_channels_ingest_lease_ck','c',array['ingest_job_id','ingest_attempt','ingest_lease_owner']::name[],
    null,null,'ingest_lease',null,null,null),
  (11,'public.cloud_live_variants'::regclass,'cloud_live_variants',
    'cloud_live_variants_generation_required_ck','c',array['generation_id']::name[],
    null,null,'generation_required',null,null,null),
  (12,'public.cloud_live_variants'::regclass,'cloud_live_variants',
    'cloud_live_variants_generation_fk','f',array['source_id','generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['source_id','id']::name[],null,'c','r','s'),
  (13,'public.cloud_live_variants'::regclass,'cloud_live_variants',
    'cloud_live_variants_ingest_lease_ck','c',array['ingest_job_id','ingest_attempt','ingest_lease_owner']::name[],
    null,null,'ingest_lease',null,null,null),
  (14,'public.catalog_series_episode_memberships'::regclass,'catalog_series_episode_memberships',
    'catalog_series_episode_memberships_generation_required_ck','c',array['generation_id']::name[],
    null,null,'generation_required',null,null,null),
  (15,'public.catalog_series_episode_memberships'::regclass,'catalog_series_episode_memberships',
    'catalog_series_episode_memberships_generation_fk','f',array['source_id','generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['source_id','id']::name[],null,'c','r','s'),
  (16,'public.catalog_series_episode_memberships'::regclass,'catalog_series_episode_memberships',
    'catalog_series_episode_memberships_ingest_lease_ck','c',array['ingest_job_id','ingest_attempt','ingest_lease_owner']::name[],
    null,null,'ingest_lease',null,null,null),
  (17,'public.catalog_series_inventory_state'::regclass,'catalog_series_inventory_state',
    'catalog_series_inventory_state_generation_required_ck','c',array['generation_id']::name[],
    null,null,'generation_required',null,null,null),
  (18,'public.catalog_series_inventory_state'::regclass,'catalog_series_inventory_state',
    'catalog_series_inventory_state_generation_fk','f',array['source_id','generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['source_id','id']::name[],null,'c','r','s'),
  (19,'public.catalog_series_inventory_state'::regclass,'catalog_series_inventory_state',
    'catalog_series_inventory_state_ingest_lease_ck','c',array['ingest_job_id','ingest_attempt','ingest_lease_owner']::name[],
    null,null,'ingest_lease',null,null,null),
  (20,'public.cloud_source_transitions'::regclass,'cloud_source_transitions',
    'cloud_source_transitions_candidate_generation_fk','f',array['user_id','candidate_catalog_generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['user_id','id']::name[],null,'c','r','s'),
  (21,'public.cloud_source_transitions'::regclass,'cloud_source_transitions',
    'cloud_source_transitions_previous_generation_fk','f',array['old_source_id','previous_catalog_generation_id']::name[],
    'public.cloud_source_catalog_generations'::regclass,array['source_id','id']::name[],null,'c','r','s'),
  (22,'public.cloud_title_variants'::regclass,'cloud_title_variants',
    'cloud_title_variants_generation_media_item_fk','f',array['source_id','generation_id','media_item_id']::name[],
    'public.cloud_media_items'::regclass,array['source_id','generation_id','id']::name[],null,'c','c','s'),
  (23,'public.cloud_live_variants'::regclass,'cloud_live_variants',
    'cloud_live_variants_generation_logical_channel_fk','f',array['source_id','generation_id','logical_channel_id']::name[],
    'public.cloud_live_logical_channels'::regclass,array['source_id','generation_id','id']::name[],null,'c','c','s'),
  (24,'public.cloud_live_variants'::regclass,'cloud_live_variants',
    'cloud_live_variants_generation_media_item_fk','f',array['source_id','generation_id','media_item_id']::name[],
    'public.cloud_media_items'::regclass,array['source_id','generation_id','id']::name[],null,'c','c','s'),
  (25,'public.catalog_series_episode_memberships'::regclass,'catalog_series_episode_memberships',
    'catalog_series_memberships_gen_parent_id_fk','f',array['source_id','generation_id','parent_variant_id']::name[],
    'public.cloud_title_variants'::regclass,array['source_id','generation_id','id']::name[],null,'c','c','s'),
  (26,'public.catalog_series_episode_memberships'::regclass,'catalog_series_episode_memberships',
    'catalog_series_memberships_gen_parent_natural_fk','f',array['source_id','generation_id','parent_item_type','parent_series_id']::name[],
    'public.cloud_title_variants'::regclass,array['source_id','generation_id','item_type','external_id']::name[],null,'c','c','s'),
  (27,'public.catalog_series_inventory_state'::regclass,'catalog_series_inventory_state',
    'catalog_series_inventory_gen_parent_id_fk','f',array['source_id','generation_id','parent_variant_id']::name[],
    'public.cloud_title_variants'::regclass,array['source_id','generation_id','id']::name[],null,'c','c','s'),
  (28,'public.catalog_series_inventory_state'::regclass,'catalog_series_inventory_state',
    'catalog_series_inventory_gen_parent_natural_fk','f',array['source_id','generation_id','parent_item_type','parent_series_id']::name[],
    'public.cloud_title_variants'::regclass,array['source_id','generation_id','item_type','external_id']::name[],null,'c','c','s');

-- Structural inventory of the generation-unaware blockers retired only by
-- contract.  Names are intentionally absent: a renamed legacy constraint is
-- discovered and dropped by its exact table/type/attnums/reference semantics.
create table public.cloud_catalog_generation_contract_legacy_constraints (
  ordinal smallint primary key,
  table_regclass regclass not null,
  table_name name not null,
  constraint_type text not null check (constraint_type in ('f','p','u')),
  key_columns name[] not null,
  referenced_table_regclass regclass,
  referenced_columns name[],
  update_action text,
  delete_action text,
  match_type text,
  check (
    (constraint_type = 'f' and referenced_table_regclass is not null
      and referenced_columns is not null and update_action is not null
      and delete_action is not null and match_type is not null)
    or
    (constraint_type in ('p','u') and referenced_table_regclass is null
      and referenced_columns is null and update_action is null
      and delete_action is null and match_type is null)
  )
);

insert into public.cloud_catalog_generation_contract_legacy_constraints(
  ordinal, table_regclass, table_name, constraint_type, key_columns,
  referenced_table_regclass, referenced_columns,
  update_action, delete_action, match_type
)
values
  (1,'public.catalog_series_episode_memberships'::regclass,
    'catalog_series_episode_memberships','f',
    array['source_id','parent_item_type','parent_series_id']::name[],
    'public.cloud_title_variants'::regclass,
    array['source_id','item_type','external_id']::name[],'a','c','s'),
  (2,'public.catalog_series_inventory_state'::regclass,
    'catalog_series_inventory_state','f',
    array['source_id','parent_item_type','parent_series_id']::name[],
    'public.cloud_title_variants'::regclass,
    array['source_id','item_type','external_id']::name[],'a','c','s'),
  (3,'public.catalog_series_episode_memberships'::regclass,
    'catalog_series_episode_memberships','p',
    array['source_id','parent_series_id','episode_id']::name[],null,null,null,null,null),
  (4,'public.catalog_series_episode_memberships'::regclass,
    'catalog_series_episode_memberships','u',
    array['user_id','parent_variant_id','episode_id']::name[],null,null,null,null,null),
  (5,'public.catalog_series_inventory_state'::regclass,
    'catalog_series_inventory_state','p',
    array['source_id','parent_series_id']::name[],null,null,null,null,null),
  (6,'public.catalog_series_inventory_state'::regclass,
    'catalog_series_inventory_state','u',
    array['user_id','parent_variant_id']::name[],null,null,null,null,null),
  (7,'public.cloud_media_items'::regclass,'cloud_media_items','u',
    array['source_id','item_type','external_id']::name[],null,null,null,null,null),
  (8,'public.cloud_title_variants'::regclass,'cloud_title_variants','u',
    array['source_id','item_type','external_id']::name[],null,null,null,null,null),
  (9,'public.cloud_live_logical_channels'::regclass,
    'cloud_live_logical_channels','u',array['source_id','logical_id']::name[],
    null,null,null,null,null),
  (10,'public.cloud_live_variants'::regclass,'cloud_live_variants','u',
    array['source_id','logical_id','stream_id','label']::name[],
    null,null,null,null,null);

-- Rolling callers keep these historical signatures usable until contract.
-- Every row names the service-executable fenced/bounded replacement that must
-- exist before the explicit caller-protocol proof can retire the old RPC.
create table public.cloud_catalog_generation_contract_legacy_writers (
  ordinal smallint primary key,
  legacy_signature text not null unique check (
    legacy_signature ~ '^public\.[a-z0-9_]+\([a-z0-9_,]+\)$'
  ),
  replacement_signature text not null unique check (
    replacement_signature ~ '^public\.[a-z0-9_]+\([a-z0-9_,]+\)$'
  ),
  caller_protocol text not null check (
    caller_protocol = 'catalog-generation-writer-v2-live-clear-batch'
  )
);

insert into public.cloud_catalog_generation_contract_legacy_writers (
  ordinal, legacy_signature, replacement_signature, caller_protocol
)
values
  (
    1,
    'public.fanout_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean)',
    'public.norva_fanout_file_tracks_to_users_fenced(text,text,text,jsonb,jsonb,boolean,boolean)',
    'catalog-generation-writer-v2-live-clear-batch'
  ),
  (
    2,
    'public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb)',
    'public.record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamptz,jsonb,uuid,bigint,bigint,bigint,bigint)',
    'catalog-generation-writer-v2-live-clear-batch'
  ),
  (
    3,
    'public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz)',
    'public.record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamptz,uuid,bigint,bigint,bigint,bigint)',
    'catalog-generation-writer-v2-live-clear-batch'
  ),
  (
    4,
    'public.norva_clear_catalog_generation_live_materialization(uuid,uuid,uuid,bigint,bigint,bigint,bigint)',
    'public.norva_clear_catalog_generation_live_materialization_batch(uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer)',
    'catalog-generation-writer-v2-live-clear-batch'
  );

alter table public.cloud_catalog_generation_contract_indexes
  enable row level security;
alter table public.cloud_catalog_generation_contract_constraints
  enable row level security;
alter table public.cloud_catalog_generation_contract_legacy_constraints
  enable row level security;
alter table public.cloud_catalog_generation_contract_legacy_writers
  enable row level security;
revoke all on table
  public.cloud_catalog_generation_contract_indexes,
  public.cloud_catalog_generation_contract_constraints,
  public.cloud_catalog_generation_contract_legacy_constraints,
  public.cloud_catalog_generation_contract_legacy_writers
from public, anon, authenticated, service_role;
grant select on table
  public.cloud_catalog_generation_contract_indexes,
  public.cloud_catalog_generation_contract_constraints,
  public.cloud_catalog_generation_contract_legacy_constraints,
  public.cloud_catalog_generation_contract_legacy_writers
to service_role;

-- The credential-transition flag is not merely expected to remain OFF: its
-- write boundary rejects activation before the catalog schema is contracted.
create or replace function public.norva_catalog_generation_flag_contract_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_active_refresh_ready boolean := false;
begin
  if new.key in (
       'provider_access_v1_enabled',
       'provider_access_auto_detection_v1_enabled',
       'provider_access_notifications_v1_enabled',
       'provider_access_visibility_v1_enabled',
       'provider_credential_transition_v1_enabled',
       'provider_replacement_v1_enabled'
     )
     and new.enabled
     and (tg_op = 'INSERT' or not coalesce(old.enabled, false))
     and not pg_catalog.pg_try_advisory_xact_lock(
       pg_catalog.hashtextextended('catalog-generation-index-repair-v1', 0)
     ) then
    raise exception 'catalog generation index repair blocks flag activation'
      using errcode = '55P03';
  end if;
  if new.key in (
       'provider_credential_transition_v1_enabled',
       'provider_replacement_v1_enabled'
     )
     and new.enabled
     and (tg_op = 'INSERT' or not coalesce(old.enabled, false))
     and not exists (
       select 1
       from public.cloud_catalog_generation_rollout rollout
       where rollout.singleton and rollout.phase = 'contracted'
         and rollout.contracted_at is not null
     ) then
    raise exception 'catalog generation rollout must be contracted before activation'
      using errcode = '55000';
  end if;
  if new.key in (
       'provider_credential_transition_v1_enabled',
       'provider_replacement_v1_enabled'
     )
     and new.enabled
     and (tg_op = 'INSERT' or not coalesce(old.enabled, false))
     and not public.norva_title_gc_indexes_ready() then
    raise exception 'candidate title GC indexes must be exact before activation'
      using errcode = '55000', detail = 'reason=title_gc_index_drift';
  end if;
  if new.key in (
       'provider_credential_transition_v1_enabled',
       'provider_replacement_v1_enabled'
     )
     and new.enabled
     and (tg_op = 'INSERT' or not coalesce(old.enabled, false))
     and not public.norva_catalog_title_projection_indexes_ready() then
    raise exception 'catalog title projection indexes must be exact before activation'
      using errcode = '55000', detail = 'reason=title_projection_index_drift';
  end if;
  if new.key in (
       'provider_credential_transition_v1_enabled',
       'provider_replacement_v1_enabled'
     )
     and new.enabled
     and (tg_op = 'INSERT' or not coalesce(old.enabled, false))
     and not public.norva_catalog_title_active_payload_indexes_ready() then
    raise exception 'active title payload index must be exact before activation'
      using errcode = '55000', detail = 'reason=title_projection_index_drift';
  end if;
  if new.key in (
       'provider_credential_transition_v1_enabled',
       'provider_replacement_v1_enabled'
     )
     and new.enabled
     and (tg_op = 'INSERT' or not coalesce(old.enabled, false)) then
    if pg_catalog.to_regprocedure(
         'public.norva_active_catalog_refresh_contract_ready()'
       ) is not null then
      execute 'select public.norva_active_catalog_refresh_contract_ready()'
      into v_active_refresh_ready;
    end if;
    if not coalesce(v_active_refresh_ready,false) then
      raise exception 'active catalog refresh worker v3 is not ready'
        using errcode = '55000',
          detail = 'reason=active_catalog_refresh_worker_v3_not_ready';
    end if;
  end if;
  return new;
end
$function$;

-- The trigger was installed under a short SHARE ROW EXCLUSIVE fence before
-- this definition transaction; CREATE OR REPLACE preserves the function OID.

-- One statement-level read snapshots the rollout/flag gates and seeds a nonce.
-- Row-level generation validation is cached against this nonce and context.
create or replace function public.norva_catalog_generation_guard_begin_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_nonce uuid := gen_random_uuid();
  v_enabled boolean := false;
  v_contracted boolean := false;
begin
  select exists (
    select 1 from public.admin_feature_flags flag
    where flag.key in (
      'provider_credential_transition_v1_enabled',
      'provider_replacement_v1_enabled'
    ) and flag.enabled
  ), rollout.contracted_at is not null
  into v_enabled, v_contracted
  from public.cloud_catalog_generation_rollout rollout
  where rollout.singleton;
  perform set_config('norva.catalog_guard_nonce', v_nonce::text, true);
  perform set_config(
    'norva.catalog_guard_transition_enabled', v_enabled::text, true
  );
  perform set_config(
    'norva.catalog_guard_rollout_contracted', v_contracted::text, true
  );
  perform set_config('norva.catalog_guard_validation_count', '0', true);
  perform set_config('norva.catalog_guard_head_lookup_count', '0', true);
  return null;
end
$function$;

-- All six statement guards were installed atomically per table during expand.
-- Replacing their function above keeps the same OID; only assert catalog
-- identity here so the control-plane transaction never reacquires traffic
-- table locks.
do $statement_guards$
begin
  if not public.norva_catalog_expand_trigger_is_exact('public.cloud_media_items','trg_cloud_media_items_generation_guard_statement','public.norva_catalog_generation_guard_begin_statement()'::regprocedure,30)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_title_variants','trg_cloud_title_variants_generation_guard_statement','public.norva_catalog_generation_guard_begin_statement()'::regprocedure,30)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_live_logical_channels','trg_cloud_live_logical_generation_guard_statement','public.norva_catalog_generation_guard_begin_statement()'::regprocedure,30)
     or not public.norva_catalog_expand_trigger_is_exact('public.cloud_live_variants','trg_cloud_live_variants_generation_guard_statement','public.norva_catalog_generation_guard_begin_statement()'::regprocedure,30)
     or not public.norva_catalog_expand_trigger_is_exact('public.catalog_series_episode_memberships','trg_catalog_series_memberships_generation_guard_statement','public.norva_catalog_generation_guard_begin_statement()'::regprocedure,30)
     or not public.norva_catalog_expand_trigger_is_exact('public.catalog_series_inventory_state','trg_catalog_series_inventory_generation_guard_statement','public.norva_catalog_generation_guard_begin_statement()'::regprocedure,30) then
    raise exception 'catalog generation statement guard drift' using errcode='55000';
  end if;
end
$statement_guards$;

create or replace function public.norva_catalog_generation_write_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_nonce uuid;
  v_generation_id uuid;
  v_generation_state text;
  v_generation_config_revision bigint;
  v_head_generation_id uuid;
  v_job_id uuid;
  v_attempt integer;
  v_lease_owner text;
  v_config_revision bigint;
  v_head_revision bigint;
  v_source_visibility_epoch bigint;
  v_user_visibility_epoch bigint;
  v_delete_proof jsonb;
  v_new_row jsonb;
  v_generation_fence_enforced boolean := false;
  v_rollout_contracted boolean := false;
  v_visible boolean := false;
  v_job_valid boolean := false;
  v_manifest_sealing boolean := false;
  v_cache_key text;
  v_cache_name text;
  v_cache jsonb;
  v_head_cache_name text;
  v_head_cache jsonb;
  v_validation_count integer := 0;
  v_head_lookup_count integer := 0;
  v_owner_user_id uuid;
  v_owner_source_id uuid;
  v_online_backfill boolean := false;
begin
  begin
    v_nonce := nullif(current_setting('norva.catalog_guard_nonce', true), '')::uuid;
  exception when others then
    v_nonce := null;
  end;
  if v_nonce is null then
    -- Defensive fallback for restored schemas where a statement trigger was
    -- temporarily absent.  Normal execution always takes the trigger path.
    v_nonce := gen_random_uuid();
    select exists (
      select 1 from public.admin_feature_flags flag
      where flag.key in (
        'provider_credential_transition_v1_enabled',
        'provider_replacement_v1_enabled'
      ) and flag.enabled
    ), rollout.contracted_at is not null
    into v_generation_fence_enforced, v_rollout_contracted
    from public.cloud_catalog_generation_rollout rollout
    where rollout.singleton;
    perform set_config('norva.catalog_guard_nonce', v_nonce::text, true);
    perform set_config(
      'norva.catalog_guard_transition_enabled',
      v_generation_fence_enforced::text,
      true
    );
    perform set_config(
      'norva.catalog_guard_rollout_contracted',
      v_rollout_contracted::text,
      true
    );
    perform set_config('norva.catalog_guard_validation_count', '0', true);
    perform set_config('norva.catalog_guard_head_lookup_count', '0', true);
  else
    v_generation_fence_enforced := coalesce(nullif(current_setting(
      'norva.catalog_guard_transition_enabled', true
    ), '')::boolean, false);
    v_rollout_contracted := coalesce(nullif(current_setting(
      'norva.catalog_guard_rollout_contracted', true
    ), '')::boolean, false);
  end if;

  if tg_op = 'DELETE' then
    v_generation_id := old.generation_id;
    v_job_id := old.ingest_job_id;
    v_attempt := old.ingest_attempt;
    v_lease_owner := old.ingest_lease_owner;
    v_owner_user_id := old.user_id;
    v_owner_source_id := old.source_id;
  else
    v_owner_user_id := new.user_id;
    v_owner_source_id := new.source_id;
    if new.generation_id is null then
      if v_generation_fence_enforced then
        raise exception 'explicit catalog generation is required'
          using errcode = '22004';
      end if;
      v_head_cache_name := 'norva.catalog_guard_head_' || pg_catalog.md5(
        new.user_id::text || ':' || new.source_id::text
      );
      begin
        v_head_cache := nullif(current_setting(v_head_cache_name, true), '')::jsonb;
      exception when others then
        v_head_cache := null;
      end;
      if v_head_cache ->> 'nonce' is not distinct from v_nonce::text then
        new.generation_id := (v_head_cache ->> 'generationId')::uuid;
      else
        new.generation_id := public.norva_ensure_source_catalog_head(
          new.source_id, new.user_id
        );
        perform set_config(
          v_head_cache_name,
          jsonb_build_object(
            'nonce', v_nonce,
            'generationId', new.generation_id
          )::text,
          true
        );
        v_head_lookup_count := coalesce(nullif(current_setting(
          'norva.catalog_guard_head_lookup_count', true
        ), '')::integer, 0) + 1;
        perform set_config(
          'norva.catalog_guard_head_lookup_count',
          v_head_lookup_count::text,
          true
        );
      end if;
    end if;
    v_new_row := to_jsonb(new);
    v_generation_id := new.generation_id;
    v_job_id := new.ingest_job_id;
    v_attempt := new.ingest_attempt;
    v_lease_owner := new.ingest_lease_owner;
  end if;

  if tg_op = 'DELETE' and v_generation_id is null
     and not v_generation_fence_enforced and not v_rollout_contracted then
    return old;
  end if;
  if tg_op = 'UPDATE' and new.generation_id is distinct from old.generation_id
     and not (
       old.generation_id is null
       and not v_generation_fence_enforced
       and not v_rollout_contracted
     ) then
    raise exception 'catalog row generation is immutable' using errcode = '23514';
  end if;

  -- Preserve the pre-contract compatibility path while making cross-generation
  -- links fail closed.  Validated composite FKs become the durable second line
  -- of defence before contract.
  if tg_op <> 'DELETE' and tg_relid = 'public.cloud_title_variants'::regclass
     and nullif(v_new_row->>'media_item_id','') is not null and not exists (
       select 1 from public.cloud_media_items parent
       where parent.id=(v_new_row->>'media_item_id')::uuid
         and parent.source_id=new.source_id
         and (parent.generation_id=new.generation_id
           or (parent.generation_id is null and not v_rollout_contracted
             and not v_generation_fence_enforced))
     ) then
    raise exception 'title variant media item crosses catalog generation'
      using errcode='23514';
  end if;
  if tg_op <> 'DELETE' and tg_relid = 'public.cloud_live_variants'::regclass then
    if nullif(v_new_row->>'logical_channel_id','') is not null and not exists (
      select 1 from public.cloud_live_logical_channels parent
      where parent.id=(v_new_row->>'logical_channel_id')::uuid
        and parent.source_id=new.source_id
        and (parent.generation_id=new.generation_id
          or (parent.generation_id is null and not v_rollout_contracted
            and not v_generation_fence_enforced))
    ) then
      raise exception 'live variant logical channel crosses catalog generation'
        using errcode='23514';
    end if;
    if nullif(v_new_row->>'media_item_id','') is not null and not exists (
      select 1 from public.cloud_media_items parent
      where parent.id=(v_new_row->>'media_item_id')::uuid
        and parent.source_id=new.source_id
        and (parent.generation_id=new.generation_id
          or (parent.generation_id is null and not v_rollout_contracted
            and not v_generation_fence_enforced))
    ) then
      raise exception 'live variant media item crosses catalog generation'
        using errcode='23514';
    end if;
  end if;
  if tg_op <> 'DELETE'
     and tg_relid in ('public.catalog_series_episode_memberships'::regclass,
                      'public.catalog_series_inventory_state'::regclass)
     and not exists (
       select 1 from public.cloud_title_variants parent
       where parent.id=(v_new_row->>'parent_variant_id')::uuid
         and parent.source_id=new.source_id
         and (parent.generation_id=new.generation_id
           or (parent.generation_id is null and not v_rollout_contracted
             and not v_generation_fence_enforced))
     ) then
    raise exception 'series parent variant crosses catalog generation'
      using errcode='23514';
  end if;

  v_cache_key := pg_catalog.md5(
    v_owner_user_id::text || ':' || v_owner_source_id::text || ':'
    || v_generation_id::text || ':' || coalesce(v_job_id::text, '') || ':'
    || coalesce(v_attempt::text, '') || ':' || coalesce(v_lease_owner, '')
  );
  v_cache_name := 'norva.catalog_guard_context_' || v_cache_key;
  begin
    v_cache := nullif(current_setting(v_cache_name, true), '')::jsonb;
  exception when others then
    v_cache := null;
  end;
  if v_cache ->> 'nonce' is distinct from v_nonce::text then
    select jsonb_build_object(
      'nonce', v_nonce,
      'generationId', generation.id,
      'state', generation.state,
      'generationConfigRevision', generation.config_revision,
      'manifestSealing', generation.manifest_sealing,
      'headGenerationId', head.active_generation_id,
      'headRevision', head.head_revision,
      'sourceConfigRevision', lifecycle.config_revision,
      'sourceVisibilityEpoch', lifecycle.visibility_epoch,
      'userVisibilityEpoch', coalesce(epoch.visibility_epoch, 1),
      'visible', public.norva_source_catalog_visible_internal(
        generation.source_id, generation.user_id
      ),
      'jobValid', exists (
        select 1
        from public.cloud_source_credential_transition_jobs job
        join public.cloud_source_transitions transition
          on transition.id = job.transition_id
         and transition.user_id = job.user_id
        where job.id = v_job_id
          and job.catalog_generation_id = generation.id
          and job.job_kind = 'build_candidate_generation'
          and job.state = 'processing'
          and job.lease_until > now()
          and job.lease_sequence = v_attempt
          and job.lease_owner = v_lease_owner
          and transition.state = 'importing'
      )
    ) into v_cache
    from public.cloud_source_catalog_generations generation
    left join public.cloud_source_catalog_heads head
      on head.source_id = generation.source_id
     and head.user_id = generation.user_id
    left join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = generation.source_id
     and lifecycle.user_id = generation.user_id
    left join public.cloud_user_catalog_visibility_epochs epoch
      on epoch.user_id = generation.user_id
    where generation.id = v_generation_id
      and generation.source_id = v_owner_source_id
      and generation.user_id = v_owner_user_id;
    if v_cache is null then
      raise exception 'catalog generation not found' using errcode = '23503';
    end if;
    perform set_config(v_cache_name, v_cache::text, true);
    v_validation_count := coalesce(nullif(current_setting(
      'norva.catalog_guard_validation_count', true
    ), '')::integer, 0) + 1;
    perform set_config(
      'norva.catalog_guard_validation_count',
      v_validation_count::text,
      true
    );
  end if;

  v_generation_state := v_cache ->> 'state';
  v_generation_config_revision := (v_cache ->> 'generationConfigRevision')::bigint;
  v_head_generation_id := nullif(v_cache ->> 'headGenerationId', '')::uuid;
  v_head_revision := nullif(v_cache ->> 'headRevision', '')::bigint;
  v_config_revision := nullif(v_cache ->> 'sourceConfigRevision', '')::bigint;
  v_source_visibility_epoch := nullif(
    v_cache ->> 'sourceVisibilityEpoch', ''
  )::bigint;
  v_user_visibility_epoch := nullif(
    v_cache ->> 'userVisibilityEpoch', ''
  )::bigint;
  v_visible := coalesce((v_cache ->> 'visible')::boolean, false);
  v_job_valid := coalesce((v_cache ->> 'jobValid')::boolean, false);
  v_manifest_sealing := coalesce(
    (v_cache ->> 'manifestSealing')::boolean, false
  );
  if v_manifest_sealing then
    raise exception 'catalog generation is sealed for manifest snapshot'
      using errcode = '40001', detail = 'reason=manifest_sealing';
  end if;
  v_online_backfill := tg_op = 'UPDATE'
    and old.generation_id is null
    and current_setting('norva.catalog_online_backfill_generation', true)
      is not distinct from v_generation_id::text
    and not v_generation_fence_enforced
    and not v_rollout_contracted;

  if v_generation_state = 'active' then
    if v_head_generation_id is distinct from v_generation_id then
      raise exception 'active catalog row does not match source head'
        using errcode = '23514';
    end if;
    if (v_generation_fence_enforced
        and v_generation_config_revision is distinct from v_config_revision)
       or (not v_visible and not v_online_backfill) then
      raise exception 'active catalog write snapshot is stale or invisible'
        using errcode = '40001';
    end if;
    if tg_op = 'DELETE' and v_generation_fence_enforced then
      begin
        v_delete_proof := current_setting('norva.catalog_delete_proof', true)::jsonb;
      exception when others then
        v_delete_proof := null;
      end;
      if (v_delete_proof ->> 'headRevision')::bigint is distinct from v_head_revision
         or (v_delete_proof ->> 'configRevision')::bigint is distinct from v_config_revision
         or (v_delete_proof ->> 'sourceVisibilityEpoch')::bigint
              is distinct from v_source_visibility_epoch
         or (v_delete_proof ->> 'userVisibilityEpoch')::bigint
              is distinct from v_user_visibility_epoch then
        raise exception 'active catalog delete proof is stale or missing'
          using errcode = '40001';
      end if;
    elsif tg_op <> 'DELETE' and v_generation_fence_enforced then
      if new.write_head_revision is distinct from v_head_revision
         or new.write_config_revision is distinct from v_config_revision
         or new.write_source_visibility_epoch is distinct from v_source_visibility_epoch
         or new.write_user_visibility_epoch is distinct from v_user_visibility_epoch then
        raise exception 'active catalog write proof is stale or missing'
          using errcode = '40001';
      end if;
      new.write_head_revision := null;
      new.write_config_revision := null;
      new.write_source_visibility_epoch := null;
      new.write_user_visibility_epoch := null;
    elsif tg_op <> 'DELETE' then
      new.write_head_revision := null;
      new.write_config_revision := null;
      new.write_source_visibility_epoch := null;
      new.write_user_visibility_epoch := null;
    end if;
    if tg_op <> 'DELETE' then
      new.ingest_job_id := null;
      new.ingest_attempt := null;
      new.ingest_lease_owner := null;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'DELETE' and (
       new.write_head_revision is not null
       or new.write_config_revision is not null
       or new.write_source_visibility_epoch is not null
       or new.write_user_visibility_epoch is not null
     ) then
    raise exception 'candidate generation cannot carry an active write proof'
      using errcode = '23514';
  end if;
  if v_generation_state = 'purging' then
    if tg_op = 'DELETE'
       and current_setting('norva.catalog_purge_generation', true)
         is not distinct from v_generation_id::text then
      return old;
    end if;
    raise exception 'catalog generation is closed for purge'
      using errcode = '42501';
  end if;
  if not v_rollout_contracted or not v_generation_fence_enforced then
    raise exception 'candidate catalog writes require contracted rollout and enabled flag'
      using errcode = '55000';
  end if;
  if v_generation_state <> 'building' or not v_job_valid then
    raise exception 'catalog generation write lease is invalid or closed'
      using errcode = '42501';
  end if;
  if tg_op <> 'DELETE'
     and tg_relid = 'public.cloud_title_variants'::regclass
     and not exists (
       select 1
       from public.cloud_source_catalog_generation_candidate_titles projection
       where projection.generation_id = v_generation_id
         and projection.title_id = (v_new_row ->> 'title_id')::uuid
         and projection.source_id = v_owner_source_id
         and projection.user_id = v_owner_user_id
     ) then
    raise exception 'candidate title variant has no generation title projection'
      using errcode = '23503',
        detail = 'reason=candidate_title_projection_missing';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$function$;

-- Per-file concurrent-index gates.  Each standalone migration calls the
-- preflight immediately before its one CIC statement and the postcondition
-- immediately after it.  Exact invalid artifacts stop with the REINDEX-only
-- operator reason; wrong-shape homonyms are never accepted or repaired.
create or replace function public.norva_preflight_catalog_generation_online_index(
  p_online_index_name name
) returns void
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_expected record;
  v_index_oid oid;
  v_lock_key bigint := pg_catalog.hashtextextended(
    'catalog-generation-index-repair-v1', 0
  );
  v_lock_held boolean := false;
begin
  -- Preliminary checks avoid taking a session lock for malformed requests.
  select expected.* into v_expected
  from public.cloud_catalog_generation_contract_indexes expected
  where expected.online_index_name=p_online_index_name;
  if not found then raise exception 'catalog generation index is not allowlisted' using errcode='22023'; end if;
  if not public.norva_catalog_generation_flags_all_off() then
    raise exception 'all six provider lifecycle flags must be off for concurrent index build'
      using errcode='55000';
  end if;
  if not exists (
    select 1 from public.cloud_catalog_generation_rollout rollout
    where rollout.singleton and rollout.phase<>'contracted'
      and rollout.contracted_at is null
  ) then raise exception 'catalog generation rollout is already contracted' using errcode='55000'; end if;
  if not pg_catalog.pg_try_advisory_lock(v_lock_key) then
    raise exception 'catalog generation index build or contract is already running'
      using errcode = '55P03';
  end if;
  v_lock_held := true;
  begin
    -- Recheck every mutable gate while holding the session lock that spans the
    -- preflight/CIC/postcondition autocommits.  Contract and flag activation
    -- take the same key transaction-locally and therefore fail closed.
    if not public.norva_catalog_generation_flags_all_off()
       or not exists (
         select 1 from public.cloud_catalog_generation_rollout rollout
         where rollout.singleton and rollout.phase <> 'contracted'
           and rollout.contracted_at is null
       ) then
      raise exception 'catalog generation rollout changed during index preflight'
        using errcode = '55000';
    end if;
    v_index_oid:=pg_catalog.to_regclass(
      'public.'||pg_catalog.quote_ident(p_online_index_name::text)
    );
    if v_index_oid is not null and not public.norva_catalog_generation_index_is_canonical(
      v_index_oid,v_expected.table_regclass::oid,v_expected.column_names,false
    ) then
      raise exception 'catalog generation online index homonym has the wrong definition: %',p_online_index_name using errcode='55000',detail='reason=index_definition_drift';
    end if;
    if v_index_oid is not null and not public.norva_catalog_generation_index_is_canonical(
      v_index_oid,v_expected.table_regclass::oid,v_expected.column_names,true
    ) then
      raise exception 'catalog generation online index is invalid; prepare and REINDEX INDEX CONCURRENTLY before retry: %',p_online_index_name using errcode='55000',detail='reason=invalid_concurrent_index';
    end if;
    perform pg_catalog.set_config(
      'norva.catalog_online_index_lock', p_online_index_name::text, false
    );
  exception when others then
    if v_lock_held then perform pg_catalog.pg_advisory_unlock(v_lock_key); end if;
    perform pg_catalog.set_config('norva.catalog_online_index_lock', '', false);
    raise;
  end;
end
$function$;

create or replace function public.norva_assert_catalog_generation_online_index(
  p_online_index_name name
) returns void
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_expected record;
  v_index_oid oid;
  v_lock_key bigint := pg_catalog.hashtextextended(
    'catalog-generation-index-repair-v1', 0
  );
begin
  if current_setting('norva.catalog_online_index_lock', true)
       is distinct from p_online_index_name::text then
    raise exception 'catalog generation index session lock proof is missing'
      using errcode = '55000', detail = 'reason=index_session_lock_missing';
  end if;
  if not public.norva_catalog_generation_flags_all_off() then
    raise exception 'all six provider lifecycle flags must remain off after concurrent index build' using errcode='55000';
  end if;
  if not exists (
    select 1 from public.cloud_catalog_generation_rollout rollout
    where rollout.singleton and rollout.phase <> 'contracted'
      and rollout.contracted_at is null
  ) then
    raise exception 'catalog generation rollout contracted during index build'
      using errcode='55000';
  end if;
  select expected.* into v_expected from public.cloud_catalog_generation_contract_indexes expected where expected.online_index_name=p_online_index_name;
  if not found then raise exception 'catalog generation index is not allowlisted' using errcode='22023'; end if;
  v_index_oid:=pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(p_online_index_name::text));
  if v_index_oid is null or not public.norva_catalog_generation_index_is_canonical(
    v_index_oid,v_expected.table_regclass::oid,v_expected.column_names,true
  ) then raise exception 'catalog generation online index postcondition failed: %',p_online_index_name using errcode='55000'; end if;
  if not pg_catalog.pg_advisory_unlock(v_lock_key) then
    raise exception 'catalog generation index session lock was lost'
      using errcode = '55000', detail = 'reason=index_session_lock_missing';
  end if;
  perform pg_catalog.set_config('norva.catalog_online_index_lock', '', false);
end
$function$;

revoke all on function
  public.norva_catalog_generation_flags_all_off(),
  public.norva_catalog_generation_index_is_canonical(oid,oid,name[],boolean),
  public.norva_catalog_generation_indexes_ready(),
  public.norva_catalog_generation_indexes_online_ready(),
  public.norva_catalog_generation_indexes_attached(),
  public.norva_catalog_generation_constraint_is_canonical(oid,oid,text,name[],oid,name[],text,text,text,text),
  public.norva_catalog_generation_constraints_canonical(boolean),
  public.norva_assert_catalog_generation_contract_constraint(name,boolean),
  public.norva_catalog_generation_legacy_blockers_canonical(),
  public.norva_catalog_generation_legacy_blocking_constraint_count(),
  public.norva_catalog_generation_legacy_blocking_index_count(),
  public.norva_prepare_catalog_generation_invalid_index_repair(name,oid),
  public.norva_finish_catalog_generation_invalid_index_repair(),
  public.norva_catalog_generation_backfill_ready(),
  public.norva_assert_catalog_generation_composite_fks(),
  public.norva_catalog_generation_flag_contract_guard(),
  public.norva_catalog_generation_guard_begin_statement(),
  public.norva_catalog_generation_write_guard(),
  public.norva_preflight_catalog_generation_online_index(name),
  public.norva_assert_catalog_generation_online_index(name)
from public, anon, authenticated, service_role;

revoke all on function
  public.norva_discover_catalog_generation_backfill_sources(integer),
  public.norva_backfill_catalog_generation_batch(text,integer,integer),
  public.norva_retry_catalog_generation_backfill_source(uuid),
  public.norva_validate_catalog_generation_constraints(integer),
  public.norva_contract_catalog_generation_rollout(text)
from public, anon, authenticated, service_role;

grant execute on function
  public.norva_discover_catalog_generation_backfill_sources(integer),
  public.norva_backfill_catalog_generation_batch(text,integer,integer),
  public.norva_retry_catalog_generation_backfill_source(uuid),
  public.norva_validate_catalog_generation_constraints(integer),
  public.norva_contract_catalog_generation_rollout(text)
to service_role;

notify pgrst, 'reload schema';

commit;
