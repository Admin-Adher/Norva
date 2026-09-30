-- SQL-language SECURITY DEFINER functions use an unselective cached plan here.
-- Preserve the complete physical proof, but plan it with the actual UUIDs.
begin;
set local lock_timeout='2s';
do $patch$
declare definition text; body text; query text; language_name text;
begin
 select pg_get_functiondef(proc.oid),proc.prosrc,lang.lanname
 into strict definition,body,language_name
 from pg_proc proc join pg_language lang on lang.oid=proc.prolang
 where proc.pronamespace='public'::regnamespace
   and proc.proname='norva_active_catalog_refresh_proof_is_current';
 if language_name<>'sql'
    or position('norva_catalog_title_active_payload_indexes_ready' in body)=0
    or position('channel.variant_preview' in body)=0
    or position('projection.post_switch_refreshed' in body)=0 then
  raise exception 'final refresh proof definition drift' using errcode='55000';
 end if;
 -- Parameter binding, never interpolation of runtime data. No predicate,
 -- count, preview, membership or owner/generation check is changed.
 query:=replace(replace(replace(replace(replace(body,
   'p_source_id','$1'),'p_user_id','$2'),'p_generation_id','$3'),
   'p_refresh_run_id','$4'),'p_job_id','$5');
 query:='declare proof boolean; begin execute '||quote_literal(query)||
   ' into proof using p_source_id,p_user_id,p_generation_id,p_refresh_run_id,p_job_id; return proof; end';
 execute replace(replace(definition,'LANGUAGE sql','LANGUAGE plpgsql'),body,query);
end $patch$;
commit;
