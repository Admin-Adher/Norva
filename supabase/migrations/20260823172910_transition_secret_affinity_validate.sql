begin;
set local lock_timeout = '2s';
set local statement_timeout = '30min';
alter table public.cloud_source_transition_secrets
  validate constraint cloud_source_transition_secrets_candidate_affinity_ck;
alter table public.cloud_source_transition_secrets
  validate constraint cloud_source_transition_secrets_previous_affinity_ck;
do $postcondition$
begin
  if (select count(*) from pg_catalog.pg_constraint
      where conrelid='public.cloud_source_transition_secrets'::regclass
        and conname in ('cloud_source_transition_secrets_candidate_affinity_ck',
          'cloud_source_transition_secrets_previous_affinity_ck')
        and contype='c' and convalidated and not condeferrable) <> 2 then
    raise exception 'transition secret affinity validation postcondition failed' using errcode='55000';
  end if;
end
$postcondition$;
commit;
