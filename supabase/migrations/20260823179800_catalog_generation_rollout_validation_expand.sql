begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
alter table public.cloud_catalog_generation_rollout
  add column if not exists validation_completed_count integer not null default 0,
  add column if not exists validation_last_constraint text,
  add column if not exists contract_caller_protocol text;
do $constraints$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_catalog_generation_rollout'::regclass and conname='cloud_catalog_generation_rollout_validation_count_ck') then
    alter table public.cloud_catalog_generation_rollout add constraint cloud_catalog_generation_rollout_validation_count_ck check (validation_completed_count between 0 and 128) not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_catalog_generation_rollout'::regclass and conname='cloud_catalog_generation_rollout_validation_last_ck') then
    alter table public.cloud_catalog_generation_rollout add constraint cloud_catalog_generation_rollout_validation_last_ck check (validation_last_constraint is null or (btrim(validation_last_constraint)<>'' and length(validation_last_constraint)<=160)) not valid;
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.cloud_catalog_generation_rollout'::regclass and conname='cloud_catalog_generation_rollout_caller_protocol_ck') then
    alter table public.cloud_catalog_generation_rollout add constraint cloud_catalog_generation_rollout_caller_protocol_ck check (contract_caller_protocol is null or contract_caller_protocol='catalog-generation-writer-v2-live-clear-batch') not valid;
  end if;
end
$constraints$;
alter table public.cloud_catalog_generation_rollout validate constraint cloud_catalog_generation_rollout_validation_count_ck;
alter table public.cloud_catalog_generation_rollout validate constraint cloud_catalog_generation_rollout_validation_last_ck;
alter table public.cloud_catalog_generation_rollout validate constraint cloud_catalog_generation_rollout_caller_protocol_ck;
do $postcondition$
declare v_column name;
begin
  foreach v_column in array array['validation_completed_count','validation_last_constraint','contract_caller_protocol']::name[] loop
    if not exists (
      select 1 from pg_catalog.pg_attribute attribute_state
      left join pg_catalog.pg_attrdef default_state on default_state.adrelid=attribute_state.attrelid and default_state.adnum=attribute_state.attnum
      where attribute_state.attrelid='public.cloud_catalog_generation_rollout'::regclass
        and attribute_state.attname=v_column and not attribute_state.attisdropped
        and attribute_state.atttypid=case when v_column='validation_completed_count' then 'pg_catalog.int4'::regtype else 'pg_catalog.text'::regtype end
        and attribute_state.atttypmod=-1
        and attribute_state.attnotnull=(v_column='validation_completed_count')
        and pg_catalog.pg_get_expr(default_state.adbin,default_state.adrelid) is not distinct from case when v_column='validation_completed_count' then '0' else null end
    ) then raise exception 'catalog rollout validation column % drift',v_column using errcode='55000'; end if;
  end loop;
  if (select count(*) from pg_catalog.pg_constraint constraint_state
      where constraint_state.conrelid='public.cloud_catalog_generation_rollout'::regclass
        and constraint_state.conname in (
          'cloud_catalog_generation_rollout_validation_count_ck',
          'cloud_catalog_generation_rollout_validation_last_ck',
          'cloud_catalog_generation_rollout_caller_protocol_ck'
        ) and constraint_state.contype='c' and constraint_state.convalidated)<>3 then
    raise exception 'catalog rollout validation constraints drift' using errcode='55000';
  end if;
  if exists (
    select 1
    from (values
      ('cloud_catalog_generation_rollout_validation_count_ck'::name,
       'CHECK (((validation_completed_count >= 0) AND (validation_completed_count <= 128)))'::text),
      ('cloud_catalog_generation_rollout_validation_last_ck'::name,
       'CHECK (((validation_last_constraint IS NULL) OR ((btrim(validation_last_constraint) <> ''''::text) AND (length(validation_last_constraint) <= 160))))'::text),
      ('cloud_catalog_generation_rollout_caller_protocol_ck'::name,
       'CHECK (((contract_caller_protocol IS NULL) OR (contract_caller_protocol = ''catalog-generation-writer-v2-live-clear-batch''::text)))'::text)
    ) expected(constraint_name,constraint_definition)
    left join pg_catalog.pg_constraint constraint_state
      on constraint_state.conrelid='public.cloud_catalog_generation_rollout'::regclass
     and constraint_state.conname=expected.constraint_name
    where constraint_state.oid is null
       or pg_catalog.pg_get_constraintdef(constraint_state.oid,false)
            is distinct from expected.constraint_definition
       or not constraint_state.convalidated or constraint_state.contype<>'c'
       or constraint_state.condeferrable or constraint_state.condeferred
  ) then raise exception 'catalog rollout validation CHECK definition drift' using errcode='55000'; end if;
end
$postcondition$;
commit;
