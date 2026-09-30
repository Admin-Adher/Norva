-- A copy RPC commits its cursor before the Edge job checkpoints. Recover that
-- durable cursor on retry instead of recopying rows or consuming failure budget.
-- The existing owner/generation/job/lease checks execute BEFORE this branch.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $migration$
declare
  v_signature text := 'public.norva_copy_credential_generation_episode_state(uuid,uuid,uuid,uuid,text,integer,bigint,integer)';
  v_definition text;
  v_anchor text := E'  if not found or v_copy.state <> ''pending''\n     or v_copy.revision <> p_expected_copy_revision then';
  v_replacement text := E'  if found and p_expected_copy_revision >= 0\n     and v_copy.revision > p_expected_copy_revision\n     and v_copy.state in (''pending'', ''complete'') then\n    return jsonb_build_object(\n      ''generationId'', p_generation_id,\n      ''copyRevision'', v_copy.revision,\n      ''membershipsProcessed'', 0,\n      ''inventoryRowsProcessed'', 0,\n      ''complete'', v_copy.state = ''complete'',\n      ''replayed'', true\n    );\n  end if;\n';
begin
  v_definition := pg_get_functiondef(v_signature::regprocedure);
  if strpos(v_definition, '''replayed'', true') > 0 then return; end if;
  if strpos(v_definition, v_anchor) = 0 then
    raise exception 'episode copy checkpoint contract drift' using errcode = '55000';
  end if;
  execute replace(v_definition, v_anchor, v_replacement || v_anchor);
end
$migration$;
commit;
