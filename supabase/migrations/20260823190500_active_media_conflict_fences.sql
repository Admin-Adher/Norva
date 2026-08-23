-- The active writer's BEFORE INSERT guard consumes its transient write proof.
-- PostgreSQL then uses that scrubbed NEW row as EXCLUDED for a conflict update,
-- so the UPDATE guard sees null fences even though the exact lease RPC already
-- checked all four values.  Rebind the checked RPC arguments on that path.
do $migration$
declare
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
  select pg_get_functiondef(
    'public.norva_upsert_active_catalog_media_items(uuid,uuid,uuid,uuid,uuid,text,integer,bigint,bigint,bigint,bigint,bigint,jsonb)'::regprocedure
  ) into v_definition;

  if position(v_fixed in v_definition) > 0 then
    return;
  end if;
  if position(v_legacy in v_definition) = 0 then
    raise exception 'active media conflict-fence function does not match the expected pre-fix definition'
      using errcode = '55000';
  end if;
  execute replace(v_definition,v_legacy,v_fixed);
end
$migration$;
