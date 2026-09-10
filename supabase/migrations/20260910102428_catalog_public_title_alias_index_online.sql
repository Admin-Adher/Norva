-- Standalone online index: never run this unit inside a transaction.
-- No table rewrite and no write-blocking index build on the live title cache.
set lock_timeout='2s';
set statement_timeout='10min';
create index concurrently if not exists catalog_titles_public_aliases_idx
on public.catalog_titles using gin (public.norva_public_title_aliases(metadata))
where metadata #>> '{tmdbValidation,valid}'='true'
  and provider_tmdb_id ~ '^[1-9][0-9]*$'
  and metadata #>> '{tmdb,id}'=provider_tmdb_id;
do $assert$
begin
  if not exists(select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid=i.indexrelid
    join pg_catalog.pg_am am on am.oid=c.relam
    where i.indexrelid='public.catalog_titles_public_aliases_idx'::regclass
      and i.indrelid='public.catalog_titles'::regclass and i.indisvalid and i.indisready
      and am.amname='gin' and i.indnatts=1
      and pg_catalog.pg_get_expr(i.indexprs,i.indrelid)='norva_public_title_aliases(metadata)'
      and pg_catalog.pg_get_expr(i.indpred,i.indrelid) like '%tmdbValidation,valid%'
      and pg_catalog.pg_get_expr(i.indpred,i.indrelid) like '%tmdb,id%') then
    raise exception 'Public title alias index is not ready' using errcode='55000';
  end if;
end;
$assert$;
reset lock_timeout;
reset statement_timeout;
