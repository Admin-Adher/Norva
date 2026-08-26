do $migration$
declare
  v_definition text;
  v_old text := $old$
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
$old$;
  v_new text := $new$
    elsif tg_op <> 'DELETE' and v_generation_fence_enforced then
      if tg_op = 'UPDATE'
         and new.write_head_revision is null
         and new.write_config_revision is null
         and new.write_source_visibility_epoch is null
         and new.write_user_visibility_epoch is null
         and coalesce((v_cache ->> 'activeUpsertInsertProof')::boolean, false) then
        -- INSERT .. ON CONFLICT runs the active-row guard twice. The INSERT
        -- phase validated and stripped the proof; this UPDATE phase may reuse
        -- it only through the same per-statement nonce-bound generation cache.
        null;
      elsif new.write_head_revision is distinct from v_head_revision
         or new.write_config_revision is distinct from v_config_revision
         or new.write_source_visibility_epoch is distinct from v_source_visibility_epoch
         or new.write_user_visibility_epoch is distinct from v_user_visibility_epoch then
        raise exception 'active catalog write proof is stale or missing'
          using errcode = '40001';
      end if;
      if tg_op = 'INSERT' then
        v_cache := v_cache || jsonb_build_object('activeUpsertInsertProof', true);
        perform set_config(v_cache_name, v_cache::text, true);
      end if;
      new.write_head_revision := null;
      new.write_config_revision := null;
      new.write_source_visibility_epoch := null;
      new.write_user_visibility_epoch := null;
$new$;
begin
  select pg_get_functiondef(
    'public.norva_catalog_generation_write_guard()'::regprocedure
  ) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'catalog generation guard definition drifted; refusing upsert proof patch'
      using errcode = '55000';
  end if;
  if length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'catalog generation guard proof block is ambiguous'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_old, v_new);
end
$migration$;

revoke all on function public.norva_catalog_generation_write_guard()
  from public, anon, authenticated;
