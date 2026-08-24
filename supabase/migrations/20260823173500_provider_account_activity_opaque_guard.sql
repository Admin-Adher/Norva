begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $install$
declare v_definition text;
begin
  select pg_catalog.pg_get_constraintdef(constraint_state.oid,false)
    into v_definition
  from pg_catalog.pg_constraint constraint_state
  where constraint_state.conrelid='public.provider_account_activity'::regclass
    and constraint_state.conname='provider_account_activity_opaque_key_ck';
  if found and v_definition not in (
    'CHECK (((account_key)::text ~ ''^[0-9a-f]{64}$''::text)) NOT VALID',
    'CHECK (((account_key)::text ~ ''^[0-9a-f]{64}$''::text))'
  ) then raise exception 'provider account activity opaque constraint drift' using errcode='55000'; end if;
  if not found then
    alter table public.provider_account_activity
      add constraint provider_account_activity_opaque_key_ck
      check (account_key ~ '^[0-9a-f]{64}$') not valid;
  end if;
end
$install$;

create or replace function public.norva_validate_provider_account_activity_affinities()
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='2s'
set statement_timeout='30min'
as $function$
begin
  if exists (select 1 from public.provider_account_activity where account_key !~ '^[0-9a-f]{64}$') then
    raise exception 'provider account activity raw keys remain'
      using errcode='55000', detail='reason=provider_account_activity_backfill_incomplete';
  end if;
  alter table public.provider_account_activity
    validate constraint provider_account_activity_opaque_key_ck;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid='public.provider_account_activity'::regclass
      and constraint_state.conname='provider_account_activity_opaque_key_ck'
      and constraint_state.contype='c' and constraint_state.convalidated
      and not constraint_state.condeferrable and not constraint_state.condeferred
  ) then raise exception 'provider account activity validation postcondition failed' using errcode='55000'; end if;
  return jsonb_build_object('validated',true,'remainingRawRows',0);
end
$function$;
revoke all on function public.norva_validate_provider_account_activity_affinities()
  from public,anon,authenticated,service_role;
grant execute on function public.norva_validate_provider_account_activity_affinities()
  to service_role;
commit;
