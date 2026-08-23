begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
create or replace view public.cloud_catalog_visible_live_variants
with (security_invoker = true, security_barrier = true)
as
select variant.*
from public.cloud_live_variants variant
join public.cloud_catalog_visible_sources source
  on source.id = variant.source_id and source.user_id = variant.user_id
left join public.cloud_source_catalog_heads head
  on head.source_id = variant.source_id and head.user_id = variant.user_id
where variant.generation_id is null
   or head.active_generation_id = variant.generation_id;
alter view public.cloud_catalog_visible_live_variants owner to postgres;
do $assert$
begin
  if not public.norva_catalog_expand_view_is_exact('public.cloud_catalog_visible_live_variants','e79da2e5a1fc4ab7e5a117532164a2c2fdd15b55c7c739efc6e0528e72193fad') then
    raise exception 'cloud_catalog_visible_live_variants definition drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
