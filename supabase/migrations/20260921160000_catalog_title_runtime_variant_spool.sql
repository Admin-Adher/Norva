begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- A title's rollup, best variant, display owner and three language aggregates
-- read the same exact visible membership six times. Materialize that bounded
-- membership once while retaining the existing view's owner, source lifecycle
-- and active-generation fences. Every ordering/observation predicate stays in
-- the proven runtime body unchanged.
do $patch$
declare
  v_signature regprocedure := 'public.norva_visible_catalog_title_runtime(uuid,uuid)'::regprocedure;
  v_definition text;
  v_reference text := 'from public.cloud_catalog_visible_title_variants variant';
  v_anchor text := E'  select\n    best_variant.id,';
  v_scope text := $scope$  with visible_variants as materialized (
    select variant.id, variant.user_id, variant.title_id, variant.source_id,
      variant.generation_id, variant.language, variant.playback_cost_score,
      variant.last_observed_ttff_ms, variant.created_at,
      variant.audio_whisper_attempted_at
    from public.cloud_catalog_visible_title_variants variant
    where variant.title_id = p_title_id and variant.user_id = p_user_id
  )
$scope$;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into strict v_definition;
  if position('with visible_variants as materialized (' in v_definition) > 0 then
    if cardinality(string_to_array(v_definition, v_reference)) <> 2
       or cardinality(string_to_array(v_definition, 'from visible_variants variant')) <> 7 then
      raise exception 'catalog title runtime spool drift' using errcode = '55000';
    end if;
    return;
  end if;
  if cardinality(string_to_array(v_definition, v_reference)) <> 7
     or cardinality(string_to_array(v_definition, v_anchor)) <> 2 then
    raise exception 'catalog title runtime scoped lookup drift' using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_reference, 'from visible_variants variant');
  v_definition := replace(v_definition, v_anchor, v_scope || v_anchor);
  execute v_definition;
end
$patch$;

-- CREATE OR REPLACE retains ownership and grants; verify that this performance
-- change cannot turn the private runtime into a definer or public entry point.
do $assert$
declare
  v_function record;
begin
  select procedure.provolatile, procedure.prosecdef, procedure.prorows,
    procedure.proconfig, language.lanname
  into strict v_function
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_language language on language.oid = procedure.prolang
  where procedure.oid = 'public.norva_visible_catalog_title_runtime(uuid,uuid)'::regprocedure;
  if v_function.provolatile <> 's' or v_function.prosecdef
     or v_function.prorows <> 1 or v_function.lanname <> 'sql'
     or not (v_function.proconfig @> array['search_path=""'])
     or has_function_privilege('anon', 'public.norva_visible_catalog_title_runtime(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.norva_visible_catalog_title_runtime(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.norva_visible_catalog_title_runtime(uuid,uuid)', 'EXECUTE') then
    raise exception 'catalog title runtime security contract drift' using errcode = '55000';
  end if;
end
$assert$;

notify pgrst, 'reload schema';
commit;
