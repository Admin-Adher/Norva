begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
create or replace view public.cloud_catalog_visible_live_logical_channels
with (security_invoker = true, security_barrier = true)
as
select channel.*
from public.cloud_live_logical_channels channel
join public.cloud_catalog_visible_sources source
  on source.id = channel.source_id and source.user_id = channel.user_id
left join public.cloud_source_catalog_heads head
  on head.source_id = channel.source_id and head.user_id = channel.user_id
where channel.generation_id is null
   or head.active_generation_id = channel.generation_id;
alter view public.cloud_catalog_visible_live_logical_channels owner to postgres;
do $assert$
begin
  if not public.norva_catalog_expand_view_is_exact('public.cloud_catalog_visible_live_logical_channels','6715916531816401f6599208e504664d067c792111c2714943549bfb3d607a55') then
    raise exception 'cloud_catalog_visible_live_logical_channels definition drift' using errcode = '55000';
  end if;
end
$assert$;
commit;
