begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

alter table public.cloud_source_transition_secrets
  add column if not exists candidate_account_affinity_hash text,
  add column if not exists previous_account_affinity_hash text;

do $constraints$
declare
  v_name name;
  v_expected text;
  v_actual text;
begin
  foreach v_name in array array[
    'cloud_source_transition_secrets_candidate_affinity_ck'::name,
    'cloud_source_transition_secrets_previous_affinity_ck'::name
  ] loop
    v_expected := case v_name
      when 'cloud_source_transition_secrets_candidate_affinity_ck' then
        'CHECK (((candidate_account_affinity_hash IS NULL) OR (candidate_account_affinity_hash ~ ''^[0-9a-f]{64}$''::text))) NOT VALID'
      else
        'CHECK (((previous_account_affinity_hash IS NULL) OR (previous_account_affinity_hash ~ ''^[0-9a-f]{64}$''::text))) NOT VALID'
    end;
    select pg_catalog.pg_get_constraintdef(constraint_state.oid, false)
      into v_actual
    from pg_catalog.pg_constraint constraint_state
    where constraint_state.conrelid = 'public.cloud_source_transition_secrets'::regclass
      and constraint_state.conname = v_name;
    if found and v_actual <> v_expected then
      raise exception 'transition secret affinity constraint % drift', v_name using errcode='55000';
    end if;
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.cloud_source_transition_secrets'::regclass
      and conname='cloud_source_transition_secrets_candidate_affinity_ck'
  ) then
    alter table public.cloud_source_transition_secrets
      add constraint cloud_source_transition_secrets_candidate_affinity_ck
      check (candidate_account_affinity_hash is null
        or candidate_account_affinity_hash ~ '^[0-9a-f]{64}$') not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.cloud_source_transition_secrets'::regclass
      and conname='cloud_source_transition_secrets_previous_affinity_ck'
  ) then
    alter table public.cloud_source_transition_secrets
      add constraint cloud_source_transition_secrets_previous_affinity_ck
      check (previous_account_affinity_hash is null
        or previous_account_affinity_hash ~ '^[0-9a-f]{64}$') not valid;
  end if;
end
$constraints$;

do $postcondition$
declare
  v_column name;
begin
  foreach v_column in array array[
    'candidate_account_affinity_hash'::name,
    'previous_account_affinity_hash'::name
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute attribute_state
      where attribute_state.attrelid='public.cloud_source_transition_secrets'::regclass
        and attribute_state.attname=v_column and not attribute_state.attisdropped
        and attribute_state.atttypid='pg_catalog.text'::regtype
        and attribute_state.atttypmod=-1 and not attribute_state.attnotnull
        and not attribute_state.atthasdef and attribute_state.attidentity=''
        and attribute_state.attgenerated=''
    ) then
      raise exception 'transition secret affinity column % drift', v_column using errcode='55000';
    end if;
  end loop;
  if (select count(*) from pg_catalog.pg_constraint
      where conrelid='public.cloud_source_transition_secrets'::regclass
        and conname in ('cloud_source_transition_secrets_candidate_affinity_ck',
          'cloud_source_transition_secrets_previous_affinity_ck')
        and contype='c' and not convalidated and not condeferrable) <> 2 then
    raise exception 'transition secret affinity constraints postcondition failed' using errcode='55000';
  end if;
end
$postcondition$;
commit;
