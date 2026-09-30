begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- A disabled source is paused by norva-source-sync. Its historical syncing
-- status must not indefinitely postpone every deleted-source cleanup.
-- Keep the global yield for enabled imports, plus every existing source,
-- generation, account, lease and row-budget fence in the procedure body.
do $enabled_import_guard$
declare
  v_signature regprocedure := 'public.reap_deleted_sources()'::regprocedure;
  v_definition text;
  v_old constant text := E'  if exists (\n'
    || E'    select 1 from public.cloud_sources\n'
    || E'    where sync_status = ''syncing'' and deleted_at is null\n'
    || E'  ) then\n    return;\n  end if;';
  v_new constant text := E'  if exists (\n'
    || E'    select 1 from public.cloud_sources\n'
    || E'    where sync_status = ''syncing'' and deleted_at is null and enabled\n'
    || E'  ) then\n    return;\n  end if;';
  v_old_count integer;
  v_new_count integer;
begin
  select replace(pg_catalog.pg_get_functiondef(v_signature),chr(13),'')
    into v_definition;
  v_old_count := (length(v_definition)-length(replace(v_definition,v_old,'')))
    / length(v_old);
  v_new_count := (length(v_definition)-length(replace(v_definition,v_new,'')))
    / length(v_new);
  if v_old_count = 0 and v_new_count = 1 then
    return;
  end if;
  if v_old_count <> 1 or v_new_count <> 0 then
    raise exception 'source reaper enabled-import guard precondition drifted'
      using errcode = '55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$enabled_import_guard$;

commit;
