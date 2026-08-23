begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $ddl$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.cloud_source_credential_transition_actions'::regclass and conname = 'cloud_source_credential_actions_transition_owner_fk') then
    alter table public.cloud_source_credential_transition_actions add constraint cloud_source_credential_actions_transition_owner_fk foreign key (user_id, transition_id) references public.cloud_source_transitions(user_id, id) on update cascade on delete restrict not valid;
  end if;
end
$ddl$;
alter table public.cloud_source_credential_transition_actions validate constraint cloud_source_credential_actions_transition_owner_fk;
do $assert$
begin
  if not public.norva_catalog_expand_constraint_is_exact('public.cloud_source_credential_transition_actions','cloud_source_credential_actions_transition_owner_fk','f',array['user_id','transition_id']::name[],'public.cloud_source_transitions',array['user_id','id']::name[],null,'c','r','s',true) then
    raise exception 'transition action owner foreign key drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
