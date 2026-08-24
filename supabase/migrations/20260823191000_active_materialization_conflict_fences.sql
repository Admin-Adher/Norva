-- See 20260823190500: every active physical writer must preserve its checked
-- proof on the INSERT .. ON CONFLICT DO UPDATE path.
do $migration$
declare
  v_proc regprocedure;
  v_definition text;
  v_legacy text :=
    'write_head_revision=excluded.write_head_revision,' || E'\n' ||
    '        write_config_revision=excluded.write_config_revision,' || E'\n' ||
    '        write_source_visibility_epoch=excluded.write_source_visibility_epoch,' || E'\n' ||
    '        write_user_visibility_epoch=excluded.write_user_visibility_epoch';
  v_fixed text :=
    'write_head_revision=p_head_revision,' || E'\n' ||
    '        write_config_revision=p_config_revision,' || E'\n' ||
    '        write_source_visibility_epoch=p_source_visibility_epoch,' || E'\n' ||
    '        write_user_visibility_epoch=p_user_visibility_epoch';
begin
  foreach v_proc in array array[
    'public.norva_upsert_active_catalog_title_variants(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)'::regprocedure,
    'public.norva_upsert_active_catalog_live_materialization(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb)'::regprocedure
  ] loop
    select pg_get_functiondef(v_proc) into v_definition;
    if position(v_fixed in v_definition) > 0 then
      continue;
    end if;
    if position(v_legacy in v_definition) = 0 then
      raise exception 'active materialization conflict-fence function % does not match the expected pre-fix definition', v_proc
        using errcode = '55000';
    end if;
    execute replace(v_definition,v_legacy,v_fixed);
  end loop;
end
$migration$;
