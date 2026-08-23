begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
alter table public.catalog_series_episode_memberships
  add column if not exists generation_id uuid,
  add column if not exists ingest_job_id uuid,
  add column if not exists ingest_attempt integer,
  add column if not exists ingest_lease_owner text,
  add column if not exists write_head_revision bigint,
  add column if not exists write_config_revision bigint,
  add column if not exists write_source_visibility_epoch bigint,
  add column if not exists write_user_visibility_epoch bigint;
do $assert$
begin
  if not (select bool_and(public.norva_catalog_expand_column_is_exact('public.catalog_series_episode_memberships', expected.column_name, expected.type_name)) from (values
    ('generation_id'::name,'uuid'::regtype),('ingest_job_id','uuid'),('ingest_attempt','integer'),('ingest_lease_owner','text'),
    ('write_head_revision','bigint'),('write_config_revision','bigint'),('write_source_visibility_epoch','bigint'),('write_user_visibility_epoch','bigint')
  ) expected(column_name,type_name)) then raise exception 'catalog_series_episode_memberships expand column drift' using errcode = '55000'; end if;
end
$assert$;
commit;
