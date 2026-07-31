-- Resolve the blank-replay Supabase security-advisor findings without making
-- function lookup depend on an invoker-controlled role search_path.

create schema if not exists extensions;
revoke create on schema extensions from public;

do $migration$
declare
  v_schema text;
  v_version text;
begin
  select n.nspname
    into v_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  if v_schema is null then
    raise exception 'required extension pg_trgm is unavailable';
  elsif v_schema <> 'extensions' then
    alter extension pg_trgm set schema extensions;
  end if;

  select n.nspname
    into v_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'unaccent';
  if v_schema is null then
    raise exception 'required extension unaccent is unavailable';
  elsif v_schema <> 'extensions' then
    alter extension unaccent set schema extensions;
  end if;

  -- The self-host restore historically installed these optional operational
  -- extensions in public. pgstattuple is relocatable. http is not, but owns
  -- types/functions only; DROP ... RESTRICT fails closed if a non-extension
  -- object ever acquires a dependency, and recreation preserves its version.
  select n.nspname
    into v_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pgstattuple';
  if v_schema is not null and v_schema <> 'extensions' then
    alter extension pgstattuple set schema extensions;
  end if;

  select n.nspname, e.extversion
    into v_schema, v_version
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'http';
  if v_schema = 'public' then
    drop extension http restrict;
    execute format(
      'create extension http with schema extensions version %L',
      v_version
    );
  elsif v_schema is not null and v_schema <> 'extensions' then
    raise exception 'http extension is installed in unexpected schema %',
      v_schema;
  end if;
end
$migration$;

-- The historical SQL body explicitly named public.unaccent. Rewrite only that
-- resolved dependency after relocating the extension and fail on definition
-- drift rather than silently installing a broken normalizer.
do $migration$
declare
  v_definition text;
  v_fixed text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.norva_norm(text)'::regprocedure
  ) into v_definition;
  v_fixed := replace(
    v_definition,
    'public.unaccent',
    'extensions.unaccent'
  );
  if v_fixed = v_definition
     or strpos(v_fixed, 'public.unaccent') > 0 then
    raise exception 'norva_norm unaccent definition drifted';
  end if;
  execute v_fixed;
end
$migration$;

alter function public.safe_numeric(text)
  set search_path = pg_catalog, public, extensions;
alter function public.cmi_set_sort_cols()
  set search_path = pg_catalog, public, extensions;
alter function public.safe_bigint(text)
  set search_path = pg_catalog, public, extensions;
alter function public.norva_html_escape(text)
  set search_path = pg_catalog, public, extensions;
alter function public.catalog_titles_keep_best()
  set search_path = pg_catalog, public, extensions;
alter function public.catalog_media_items_keep_best()
  set search_path = pg_catalog, public, extensions;
alter function public.propagate_media_item_years(uuid, uuid, uuid[])
  set search_path = pg_catalog, public, extensions;
alter function public.is_admin()
  set search_path = pg_catalog, public, extensions;
alter function public.norva_classify_buckets(text, jsonb)
  set search_path = pg_catalog, public, extensions;
alter function public.norva_norm(text)
  set search_path = pg_catalog, public, extensions;
alter function public.norva_refresh_posters_from_catalog(uuid, integer)
  set search_path = pg_catalog, public, extensions;
alter function public.list_media_items_deduped(
  uuid, text, uuid, text, text, integer, integer, numeric, bigint, text,
  integer, integer
)
  set search_path = pg_catalog, public, extensions;
alter function public.norva_backfill_media_identity(uuid, integer)
  set search_path = pg_catalog, public, extensions;
alter function public.norva_canonicalize_titles_for_user(uuid, integer)
  set search_path = pg_catalog, public, extensions;
alter function public.norva_reconcile_catalog(uuid, integer)
  set search_path = pg_catalog, public, extensions;
alter function public.whitelist_subtitle_candidates(uuid, integer)
  set search_path = pg_catalog, public, extensions;

-- This broken diagnostic exists only on the restored self-host schema. It is
-- absent from versioned code and fails plpgsql_check ("arabe" is not an array
-- literal). Remove only the exact historical probe; definition drift fails
-- closed instead of deleting an unknown routine.
do $migration$
declare
  v_probe regprocedure :=
    to_regprocedure('public._norva_probe(text,jsonb)');
  v_definition text;
begin
  if v_probe is not null then
    select pg_catalog.pg_get_functiondef(v_probe)
      into v_definition;
    if strpos(lower(v_definition), 'return ''ok: ''') = 0
      or strpos(lower(v_definition), 'return ''threw: ''') = 0
      or strpos(v_definition, 'buckets := buckets || ''arabe''') = 0
    then
      raise exception 'historical _norva_probe definition drifted';
    end if;
    drop function public._norva_probe(text, jsonb);
  end if;
end
$migration$;

-- service_role already has SELECT on both underlying provider tables. Execute
-- the admin-only view with the caller's permissions and RLS semantics.
alter view public.admin_provider_overview
  set (security_invoker = true);

-- pg_trgm's similarity() function and % operator are used by this already
-- fixed-path search routine. Include the relocated extension schema explicitly.
alter function public.search_media_items(
  uuid, text, text, integer, boolean
)
  set search_path = pg_catalog, public, extensions;
