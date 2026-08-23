begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
create or replace view public.cloud_catalog_visible_media_items
with (security_invoker = true, security_barrier = true)
as
select item.*
from public.cloud_media_items item
join public.cloud_catalog_visible_sources source
  on source.id = item.source_id and source.user_id = item.user_id
left join public.cloud_source_catalog_heads head
  on head.source_id = item.source_id and head.user_id = item.user_id
where item.generation_id is null
   or head.active_generation_id = item.generation_id;
alter view public.cloud_catalog_visible_media_items owner to postgres;
do $assert$
begin
  if not public.norva_catalog_expand_view_is_exact('public.cloud_catalog_visible_media_items','8ceac8d1d6118fa8fa57917456a912b07520cbbf51385c47b2ef9d6a6f2db201') then
    raise exception 'cloud_catalog_visible_media_items definition drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
