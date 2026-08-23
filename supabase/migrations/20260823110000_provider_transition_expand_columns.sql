begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
alter table public.cloud_source_transitions
  add column if not exists request_fingerprint text,
  add column if not exists candidate_catalog_generation_id uuid,
  add column if not exists previous_catalog_generation_id uuid;
do $assert$
begin
  if not (
    public.norva_catalog_expand_column_is_exact('public.cloud_source_transitions','request_fingerprint','text')
    and public.norva_catalog_expand_column_is_exact('public.cloud_source_transitions','candidate_catalog_generation_id','uuid')
    and public.norva_catalog_expand_column_is_exact('public.cloud_source_transitions','previous_catalog_generation_id','uuid')
  ) then raise exception 'provider transition expand column drift' using errcode = '55000'; end if;
end
$assert$;
commit;
