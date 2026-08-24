begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Exact catalogue matcher shared by the existing-table concurrent selector
-- index and the generation-projection indexes.  Normalize vector lower bounds
-- through unnest; direct casts preserve PostgreSQL's zero-based vector bounds.
create or replace function public.norva_catalog_title_projection_index_is_exact(
  p_index_name text,
  p_table regclass,
  p_columns text[],
  p_indoptions smallint[],
  p_predicate text,
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
    and (
      (
        expected.poster_presence_markers = 0
        and index_catalog.indexprs is null
      )
      or (
        expected.poster_presence_markers = 1
        and index_catalog.indexprs is not null
        and regexp_replace(
          lower(pg_get_expr(index_catalog.indexprs, index_catalog.indrelid)),
          '[[:space:]()]', '', 'g'
        ) = 'poster_urlisnotnull'
      )
    )
    and coalesce(cardinality(index_class.reloptions), 0) = 0
    and array(select unnest(index_catalog.indkey)) = expected.attnums
    and array(select unnest(index_catalog.indcollation)) = expected.collations
    and array(select unnest(index_catalog.indoption)) = p_indoptions
    and (
      (p_predicate is null and index_catalog.indpred is null)
      or (
        p_predicate is not null
        and regexp_replace(
          lower(pg_get_expr(index_catalog.indpred, index_catalog.indrelid)),
          '\s+', '', 'g'
        ) = regexp_replace(lower(p_predicate), '\s+', '', 'g')
      )
    )
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
      array_agg(
        case when requested.column_name = '@poster_present'
          then 0 else attribute.attnum end
        order by requested.ordinality
      )::smallint[]
        as attnums,
      array_agg(
        case when requested.column_name = '@poster_present'
          then 0::oid else attribute.attcollation end
        order by requested.ordinality
      )::oid[] as collations,
      count(*) filter (
        where requested.column_name = '@poster_present'
      )::integer as poster_presence_markers,
      bool_and(
        requested.column_name = '@poster_present'
        or attribute.attnum is not null
      ) as resolved
    from unnest(p_columns) with ordinality requested(column_name, ordinality)
    left join pg_attribute attribute
      on attribute.attrelid = p_table
     and attribute.attname = requested.column_name
     and attribute.attnum > 0
     and not attribute.attisdropped
  ) expected
  where namespace.nspname = 'public'
    and index_class.relname = p_index_name
    and cardinality(p_columns) = cardinality(p_indoptions)
    and cardinality(expected.attnums) = cardinality(p_columns)
    and expected.resolved
    and expected.poster_presence_markers between 0 and 1
$function$;

revoke all on function public.norva_catalog_title_projection_index_is_exact(
  text, regclass, text[], smallint[], text, boolean
) from public, anon, authenticated, service_role;

create or replace function public.norva_catalog_title_projection_cic_preflight(
  p_index_name text,
  p_table regclass,
  p_columns text[],
  p_indoptions smallint[],
  p_predicate text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select count(*) from public.admin_feature_flags where key in (
      'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
      'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
      'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
    )) <> 6 or exists (
      select 1 from public.admin_feature_flags where key in (
        'provider_access_v1_enabled','provider_access_auto_detection_v1_enabled',
        'provider_access_notifications_v1_enabled','provider_access_visibility_v1_enabled',
        'provider_credential_transition_v1_enabled','provider_replacement_v1_enabled'
      ) and enabled
    ) then
    raise exception 'catalog title selector CIC requires all six rollout flags OFF'
      using errcode = '55000';
  end if;
  if to_regclass('public.' || quote_ident(p_index_name)) is not null
     and not public.norva_catalog_title_projection_index_is_exact(
       p_index_name, p_table, p_columns, p_indoptions, p_predicate, true
     ) then
    if public.norva_catalog_title_projection_index_is_exact(
      p_index_name, p_table, p_columns, p_indoptions, p_predicate, false
    ) then
      raise exception 'exact catalog title selector index % is invalid; operator must REINDEX INDEX CONCURRENTLY then retry',
        p_index_name using errcode = '55000';
    end if;
    raise exception 'catalog title selector index % homonym has wrong shape',
      p_index_name using errcode = '55000';
  end if;
end
$function$;

create or replace function public.norva_catalog_title_projection_cic_assert(
  p_index_name text,
  p_table regclass,
  p_columns text[],
  p_indoptions smallint[],
  p_predicate text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.norva_catalog_title_projection_index_is_exact(
    p_index_name, p_table, p_columns, p_indoptions, p_predicate, true
  ) then
    raise exception 'catalog title selector index % postcondition failed',
      p_index_name using errcode = '55000';
  end if;
end
$function$;

revoke all on function public.norva_catalog_title_projection_cic_preflight(
  text,regclass,text[],smallint[],text
) from public, anon, authenticated, service_role;
revoke all on function public.norva_catalog_title_projection_cic_assert(
  text,regclass,text[],smallint[],text
) from public, anon, authenticated, service_role;

commit;
