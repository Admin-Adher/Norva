-- Run against a completed physical refresh; all fixture mutations roll back.
begin;
set local statement_timeout='15s';
do $test$
declare a public.cloud_source_catalog_title_refresh_actions%rowtype;
 args uuid[]; changed uuid[]; i integer; definition record;
begin
 select action.* into strict a
 from public.cloud_source_catalog_title_refresh_actions action
 where action.state='complete' and action.action_kind='series'
   and (select count(*) from public.cloud_source_catalog_title_refresh_actions x
        where x.refresh_run_id=action.refresh_run_id and x.state='complete')=3
 order by action.created_at desc limit 1;
 args:=array[a.source_id,a.user_id,a.generation_id,a.refresh_run_id,a.job_id];
 select p.prosecdef,p.provolatile,p.proconfig into definition from pg_proc p
 where p.oid='public.norva_active_catalog_refresh_proof_is_current(uuid,uuid,uuid,uuid,uuid)'::regprocedure;
 if not definition.prosecdef or definition.provolatile<>'s'
    or not ('search_path=""'=any(definition.proconfig)) then
  raise exception 'proof execution boundary changed';
 end if;
 if has_function_privilege('anon','public.norva_active_catalog_refresh_proof_is_current(uuid,uuid,uuid,uuid,uuid)','execute')
 or has_function_privilege('service_role','public.norva_active_catalog_refresh_proof_is_current(uuid,uuid,uuid,uuid,uuid)','execute') then
  raise exception 'private proof access widened';
 end if;
 if not public.norva_active_catalog_refresh_proof_is_current(args[1],args[2],args[3],args[4],args[5]) then
  raise exception 'complete physical proof rejected';
 end if;
 for i in 1..5 loop
  changed:=args;changed[i]:=gen_random_uuid();
  if public.norva_active_catalog_refresh_proof_is_current(changed[1],changed[2],changed[3],changed[4],changed[5]) then
   raise exception 'wrong proof coordinate accepted: %',i;
  end if;
 end loop;
 update public.cloud_source_catalog_title_refresh_actions
 set observed_count=observed_count+1
 where refresh_run_id=a.refresh_run_id and action_kind='series';
 if public.norva_active_catalog_refresh_proof_is_current(args[1],args[2],args[3],args[4],args[5]) then
  raise exception 'physical inventory count mismatch accepted';
 end if;
 raise notice 'Final proof: complete accepted; five coordinate mismatches and count drift rejected; ACL retained';
end $test$;
rollback;
