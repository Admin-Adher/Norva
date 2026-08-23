begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace trigger trg_cloud_source_credential_job_affinity
before insert or update of state on public.cloud_source_credential_transition_jobs
for each row execute function public.norva_credential_job_affinity_guard();
do $postcondition$
declare v_state smallint; v_actual smallint[];
begin
  if not public.norva_provider_access_foundation_trigger_is_exact('public.cloud_source_credential_transition_jobs','trg_cloud_source_credential_job_affinity','public.norva_credential_job_affinity_guard()'::regprocedure,23) then
    raise exception 'credential job affinity trigger drift' using errcode='55000';
  end if;
  select attnum into strict v_state from pg_catalog.pg_attribute where attrelid='public.cloud_source_credential_transition_jobs'::regclass and attname='state' and not attisdropped;
  select tgattr::smallint[] into strict v_actual from pg_catalog.pg_trigger where tgrelid='public.cloud_source_credential_transition_jobs'::regclass and tgname='trg_cloud_source_credential_job_affinity';
  if pg_catalog.array_to_string(v_actual,',') is distinct from v_state::text then raise exception 'credential job affinity trigger column drift' using errcode='55000'; end if;
end
$postcondition$;
commit;
