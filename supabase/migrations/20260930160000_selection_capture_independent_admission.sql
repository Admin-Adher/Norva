begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Selection has its own explicit, default-off admission. The legacy generic
-- capture flag is no longer a runtime prerequisite: ordinary capture now uses
-- a job-aware rollout. Do not activate either lane or change any existing flag.
-- Parallel work still requires the separate selection_parallel_capture_enabled
-- flag. Exact-file ownership, work leases and Gateway admission remain intact.
do $patch$
declare
  definition text;
  previous_expression text := $old$public.catalog_language_capture_pipeline_enabled()
    and exists(select 1 from public.admin_feature_flags where key='selection_capture_pipeline_enabled' and enabled)$old$;
  replacement_expression text := $new$exists(select 1 from public.admin_feature_flags where key='selection_capture_pipeline_enabled' and enabled)$new$;
begin
  definition := replace(pg_get_functiondef('public.selection_audio_capture_pipeline_enabled()'::regprocedure),chr(13),'');
  if (length(definition)-length(replace(definition,previous_expression,'')))/length(previous_expression) <> 1 then
    raise exception 'Selection capture admission expression drifted' using errcode='55000';
  end if;
  -- CREATE OR REPLACE from the installed definition retains function attributes,
  -- owner and ACL. Only the legacy predicate is removed, never an ownership gate.
  execute replace(definition,previous_expression,replacement_expression);
end $patch$;

notify pgrst, 'reload schema';
commit;
