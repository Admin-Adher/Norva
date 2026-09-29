begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A generic PostgREST plan used to evaluate the source visibility predicate
-- once per channel (51k times for a large provider). Materialize the same
-- authorized source relation once; retain owner and generation joins unchanged.
create or replace view public.cloud_catalog_visible_live_logical_channels as
with visible_sources as materialized (
  select id, user_id from public.cloud_catalog_visible_sources
)
select channel.*
from public.cloud_live_logical_channels channel
join visible_sources source
  on source.id = channel.source_id and source.user_id = channel.user_id
left join public.cloud_source_catalog_heads head
  on head.source_id = channel.source_id and head.user_id = channel.user_id
where channel.generation_id is null or head.active_generation_id = channel.generation_id;

notify pgrst, 'reload schema';
commit;
