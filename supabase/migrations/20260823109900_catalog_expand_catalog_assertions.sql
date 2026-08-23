begin;
set local statement_timeout = '15s';

create or replace function public.norva_catalog_expand_column_is_exact(
  p_table regclass,
  p_column name,
  p_type regtype
) returns boolean
language sql
stable
set search_path = ''
as $function$
  select count(*) = 1 and bool_and(
    attribute_state.atttypid = p_type::oid
    and attribute_state.atttypmod = -1
    and not attribute_state.attnotnull
    and not attribute_state.atthasdef
    and attribute_state.attidentity = ''
    and attribute_state.attgenerated = ''
    and not attribute_state.attisdropped
  )
  from pg_catalog.pg_attribute attribute_state
  where attribute_state.attrelid = p_table
    and attribute_state.attname = p_column
$function$;

create or replace function public.norva_catalog_expand_constraint_is_exact(
  p_table regclass,
  p_name name,
  p_type text,
  p_keys name[],
  p_referenced_table regclass,
  p_referenced_keys name[],
  p_check_kind text,
  p_update_action text,
  p_delete_action text,
  p_match_type text,
  p_validated boolean
) returns boolean
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_constraint pg_catalog.pg_constraint%rowtype;
  v_expression text;
begin
  select constraint_state.* into v_constraint
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid = p_table
    and constraint_state.conname = p_name;
  if not found
     or v_constraint.contype::text <> p_type
     or v_constraint.convalidated is distinct from p_validated
     or v_constraint.condeferrable
     or v_constraint.condeferred
     or v_constraint.conparentid <> 0
     or v_constraint.coninhcount <> 0
     or not v_constraint.conislocal
     or cardinality(v_constraint.conkey) <> cardinality(p_keys)
     or exists (
       select 1
       from pg_catalog.unnest(p_keys) with ordinality expected(column_name, ordinal)
       left join pg_catalog.pg_attribute attribute_state
         on attribute_state.attrelid = p_table
        and attribute_state.attname = expected.column_name
        and not attribute_state.attisdropped
       where attribute_state.attnum is null
          or v_constraint.conkey[expected.ordinal] <> attribute_state.attnum
     ) then
    return false;
  end if;
  if p_type = 'f' then
    return v_constraint.confrelid = p_referenced_table
      and v_constraint.confupdtype::text = p_update_action
      and v_constraint.confdeltype::text = p_delete_action
      and v_constraint.confmatchtype::text = p_match_type
      and cardinality(v_constraint.confkey) = cardinality(p_referenced_keys)
      and not exists (
        select 1
        from pg_catalog.unnest(p_referenced_keys) with ordinality expected(column_name, ordinal)
        left join pg_catalog.pg_attribute attribute_state
          on attribute_state.attrelid = p_referenced_table
         and attribute_state.attname = expected.column_name
         and not attribute_state.attisdropped
        where attribute_state.attnum is null
           or v_constraint.confkey[expected.ordinal] <> attribute_state.attnum
      )
      and v_constraint.conbin is null;
  end if;
  if p_type <> 'c' or p_check_kind not in ('request_fingerprint','generation_required','ingest_lease') then
    return false;
  end if;
  v_expression := pg_catalog.regexp_replace(
    pg_catalog.pg_get_expr(v_constraint.conbin, v_constraint.conrelid),
    '[[:space:]]+', '', 'g'
  );
  return case p_check_kind
    when 'request_fingerprint' then v_expression = '((request_fingerprintISNULL)OR(request_fingerprint~''^[0-9a-f]{64}$''::text))'
    when 'generation_required' then v_expression = '(generation_idISNOTNULL)'
    when 'ingest_lease' then v_expression = '(((ingest_job_idISNULL)AND(ingest_attemptISNULL)AND(ingest_lease_ownerISNULL))OR((ingest_job_idISNOTNULL)AND((ingest_attempt>=1)AND(ingest_attempt<=25))AND(btrim(ingest_lease_owner)<>''''::text)AND(length(ingest_lease_owner)<=160)))'
    else false
  end;
end
$function$;

create or replace function public.norva_catalog_expand_trigger_is_exact(
  p_table regclass,
  p_name name,
  p_function regprocedure,
  p_tgtype integer
) returns boolean
language sql
stable
set search_path = ''
as $function$
  select count(*) = 1 and bool_and(
    trigger_state.tgfoid = p_function::oid
    and trigger_state.tgtype = p_tgtype
    and trigger_state.tgenabled = 'O'
    and not trigger_state.tgisinternal
    and trigger_state.tgconstraint = 0
    and trigger_state.tgnargs = 0
    and trigger_state.tgqual is null
  )
  from pg_catalog.pg_trigger trigger_state
  where trigger_state.tgrelid = p_table
    and trigger_state.tgname = p_name
$function$;

create or replace function public.norva_catalog_expand_view_is_exact(
  p_view regclass,
  p_definition_sha256 text
) returns boolean
language sql
stable
set search_path = ''
as $function$
  select count(*) = 1 and bool_and(
    view_state.relkind = 'v'
    and view_state.relnamespace = 'public'::regnamespace
    and view_state.relowner = 'postgres'::regrole
    and coalesce(cardinality(view_state.reloptions), 0) = 2
    and view_state.reloptions @> array['security_invoker=true','security_barrier=true']
    and encode(extensions.digest(pg_catalog.pg_get_viewdef(view_state.oid, false), 'sha256'), 'hex') = p_definition_sha256
  )
  from pg_catalog.pg_class view_state
  where view_state.oid = p_view::oid
$function$;

revoke all on function public.norva_catalog_expand_column_is_exact(regclass,name,regtype) from public, anon, authenticated, service_role;
revoke all on function public.norva_catalog_expand_constraint_is_exact(regclass,name,text,name[],regclass,name[],text,text,text,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.norva_catalog_expand_trigger_is_exact(regclass,name,regprocedure,integer) from public, anon, authenticated, service_role;
revoke all on function public.norva_catalog_expand_view_is_exact(regclass,text) from public, anon, authenticated, service_role;
commit;
