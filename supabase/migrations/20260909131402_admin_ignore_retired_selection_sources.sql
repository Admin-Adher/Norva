-- Retiring the general Selection feed intentionally leaves old media rows for
-- audit/recovery. Disabled sources carrying that server retirement marker are
-- no longer imports to repair. A plain disabled source, or a re-enabled retired
-- source, must still be monitored. Keep all other health and business metrics.
do $migration$
declare
  v_function text;
  v_definition text;
  v_patch record;
  v_old_count integer;
  v_new_count integer;
  v_guard text := $guard$not coalesce(
             s.enabled is false
             and s.config_hint->>'managedBy' = 'norva-cloud'
             and jsonb_typeof(s.config_hint#>'{selectionGeneralFeedRetirement,at}') = 'string'
             and nullif(btrim(s.config_hint#>>'{selectionGeneralFeedRetirement,at}'), '') is not null,
             false
           )$guard$;
begin
  foreach v_function in array array['public.refresh_admin_dashboard()', 'public.snapshot_admin_metrics()'] loop
    select pg_get_functiondef(v_function::regprocedure) into v_definition;
    if v_definition is null then
      raise exception 'missing source supervision function: %', v_function;
    end if;

    for v_patch in
      select * from (values
        ('public.refresh_admin_dashboard()',
         's.deleted_at is null and coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0',
         's.deleted_at is null and (' || v_guard || ') and coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0',
         2),
        ('public.refresh_admin_dashboard()',
         $old$(exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
            and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))$old$,
         '(' || v_guard || $new$ and exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
            and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))$new$,
         1),
        ('public.snapshot_admin_metrics()',
         's.deleted_at is null and coalesce(mc.n,0)>0 and coalesce(vc.n,0)=0',
         's.deleted_at is null and (' || v_guard || ') and coalesce(mc.n,0)>0 and coalesce(vc.n,0)=0',
         1)
      ) as patches(function_name, needle, replacement, expected_count)
      where function_name = v_function
    loop
      v_old_count := (length(v_definition) - length(replace(v_definition, v_patch.needle, ''))) / length(v_patch.needle);
      v_new_count := (length(v_definition) - length(replace(v_definition, v_patch.replacement, ''))) / length(v_patch.replacement);
      if v_old_count = v_patch.expected_count and v_new_count = 0 then
        v_definition := replace(v_definition, v_patch.needle, v_patch.replacement);
      elsif v_old_count = 0 and v_new_count = v_patch.expected_count then
        null; -- Already applied: preserve idempotent release/recovery.
      else
        raise exception 'unexpected source supervision definition: % (old %, new %, expected %)',
          v_function, v_old_count, v_new_count, v_patch.expected_count;
      end if;
    end loop;

    -- CREATE OR REPLACE from the live definition retains its owner, ACL, guards,
    -- security mode and every unrelated metric. No source/data row is modified.
    execute v_definition;
  end loop;
end;
$migration$;
