begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- The original promotion result is persisted with replayed=false.  The v2
-- completed branch correctly validates the immutable candidate-head proof and
-- returns the same durable result, but previously propagated that historical
-- boolean.  Mark only the already-completed branch as a replay so Edge and
-- operators can distinguish a lost acknowledgement from a new cutover.
do $migration$
declare
  v_signature regprocedure:=
    'public.norva_promote_source_replacement_v2(uuid,uuid,text,bigint,bigint,bigint)'::regprocedure;
  v_definition text;
  v_old text:=E'    return v_result || jsonb_build_object(\n      ''candidateGenerationId'',v_transition.candidate_catalog_generation_id,\n      ''candidateHeadRevision'',v_proof.candidate_head_revision_after\n    );';
  v_new text:=E'    return v_result || jsonb_build_object(\n      ''candidateGenerationId'',v_transition.candidate_catalog_generation_id,\n      ''candidateHeadRevision'',v_proof.candidate_head_revision_after,\n      ''replayed'',true\n    );';
begin
  select replace(pg_get_functiondef(v_signature),chr(13),'') into v_definition;
  if position(v_new in v_definition)>0 then return; end if;
  if position(v_old in v_definition)=0 then
    raise exception 'replacement promotion replay patch precondition drifted'
      using errcode='55000';
  end if;
  execute replace(v_definition,v_old,v_new);
end
$migration$;

commit;
