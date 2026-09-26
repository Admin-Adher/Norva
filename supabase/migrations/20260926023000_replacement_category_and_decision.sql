-- Use the generation being built as category owner, and read manual decision
-- results after the UPDATE statement so the stable getter sees the new row.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

do $migration$
declare
  v_signature regprocedure :=
    'public.norva_register_credential_generation_categories(uuid,uuid,uuid,uuid,text,integer,text,jsonb)'::regprocedure;
  v_definition text;
  v_old_select text := 'select p_generation_id, p_user_id, transition.old_source_id,';
  v_new_select text := 'select p_generation_id, p_user_id, generation.source_id,';
  v_old_from text := E'cross join public.cloud_source_transitions transition\n  where transition.id = p_transition_id and transition.user_id = p_user_id';
  v_new_from text := E'cross join public.cloud_source_catalog_generations generation\n  where generation.id = p_generation_id and generation.user_id = p_user_id\n    and generation.transition_id = p_transition_id';
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new_select in v_definition)>0 and position(v_new_from in v_definition)>0 then
    return;
  end if;
  if position(v_old_select in v_definition)=0 or position(v_old_from in v_definition)=0 then
    raise exception 'replacement category registration shape drifted' using errcode='55000';
  end if;
  execute replace(replace(v_definition,v_old_select,v_new_select),v_old_from,v_new_from);
end
$migration$;

do $migration$
declare
  v_signature regprocedure :=
    'public.norva_decide_ambiguous_credential_transition(uuid,uuid,text,text,bigint,text,text)'::regprocedure;
  v_definition text;
  v_old text := E'  returning public.norva_credential_transition_result(transition.id, p_user_id)\n  into v_result;';
  v_new text := E'  ;\n  v_result := public.norva_credential_transition_result(p_transition_id, p_user_id);';
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition)>0 then return; end if;
  if position(v_old in v_definition)=0 then
    raise exception 'manual credential decision response shape drifted' using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;

-- A consumed, classified credential candidate is cancelled by the replacement
-- handoff, not by the separate cancel action. Its immutable origin row proves
-- that the encrypted candidate has been copied and its off-head generation
-- can be cleaned. Preserve the independent active-head and owner fences.
do $migration$
declare
  v_signature regprocedure :=
    'public.norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)'::regprocedure;
  v_definition text;
  v_old text := E'        and exists (\n          select 1\n          from public.cloud_source_credential_transition_actions action\n          where action.transition_id = transition.id\n            and action.user_id = transition.user_id\n            and action.action_kind = ''cancel''\n        )';
  v_new text := E'        and (exists (\n          select 1\n          from public.cloud_source_credential_transition_actions action\n          where action.transition_id = transition.id\n            and action.user_id = transition.user_id\n            and action.action_kind = ''cancel''\n        ) or exists (\n          select 1 from public.cloud_source_replacement_origins origin\n          where origin.credential_transition_id = transition.id\n            and origin.user_id = transition.user_id\n        ) or (transition.transition_kind = ''replacement''\n          and transition.candidate_source_id = generation.source_id\n          and exists (\n            select 1 from public.cloud_source_lifecycle_events event\n            where event.transition_id = transition.id\n              and event.user_id = transition.user_id\n              and event.source_id = generation.source_id\n              and event.event_kind = ''replacement_cancelled''\n          )\n        ))';
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_new in v_definition)>0 then return; end if;
  if position(v_old in v_definition)=0 then
    raise exception 'consumed candidate cleanup shape drifted' using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;

commit;
