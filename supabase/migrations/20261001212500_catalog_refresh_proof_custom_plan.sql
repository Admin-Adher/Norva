begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Plan against the current source and action. The SQL-language function used
-- a generic plan that exceeded the refresh RPC deadline on a 21k-channel
-- source; the unchanged proof takes under one second with bound parameters.
create or replace function public.norva_active_catalog_refresh_action_current(
  p_source_id uuid,
  p_user_id uuid,
  p_generation_id uuid,
  p_refresh_run_id uuid,
  p_action_kind text,
  p_catalog_version bigint,
  p_category_count bigint,
  p_observed_count bigint,
  p_active_count bigint
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $function$
begin
  return (select p_action_kind in ('live','vod','series')
    and p_category_count = (
      select count(*)::bigint
      from public.cloud_source_catalog_generation_categories category
      where category.generation_id = p_generation_id
        and category.user_id = p_user_id and category.source_id = p_source_id
        and category.category_kind = p_action_kind
        and category.projection_refresh_run_id = p_refresh_run_id
    )
    and not exists (
      select 1
      from public.cloud_source_catalog_generation_categories category
      where category.generation_id = p_generation_id
        and category.user_id = p_user_id and category.source_id = p_source_id
        and category.category_kind = p_action_kind
        and category.projection_refresh_run_id is distinct from p_refresh_run_id
      limit 1
    )
    and p_observed_count = (
      select count(*)::bigint
      from public.cloud_media_items item
      where item.generation_id = p_generation_id
        and item.user_id = p_user_id and item.source_id = p_source_id
        and item.item_type = case p_action_kind
          when 'vod' then 'movie' else p_action_kind end
        and item.catalog_version = p_catalog_version
        and item.projection_refresh_run_id = p_refresh_run_id
    )
    and not exists (
      select 1
      from public.cloud_media_items item
      where item.generation_id = p_generation_id
        and item.user_id = p_user_id and item.source_id = p_source_id
        and item.item_type = case p_action_kind
          when 'vod' then 'movie' else p_action_kind end
        and item.projection_refresh_run_id is distinct from p_refresh_run_id
      limit 1
    )
    and case when p_action_kind in ('vod','series') then
      p_active_count = (
        select count(*)::bigint
        from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.item_type = case p_action_kind
            when 'vod' then 'movie' else p_action_kind end
          and variant.projection_refresh_run_id = p_refresh_run_id
      )
      and p_active_count = p_observed_count
      and not exists (
        select 1 from public.cloud_title_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.item_type = case p_action_kind
            when 'vod' then 'movie' else p_action_kind end
          and variant.projection_refresh_run_id is distinct from p_refresh_run_id
        limit 1
      )
      and not exists (
        select 1 from public.cloud_media_items item
        where item.generation_id = p_generation_id
          and item.user_id = p_user_id and item.source_id = p_source_id
          and item.item_type = case p_action_kind
            when 'vod' then 'movie' else p_action_kind end
          and not exists (
            select 1 from public.cloud_title_variants variant
            where variant.generation_id = item.generation_id
              and variant.user_id = item.user_id
              and variant.source_id = item.source_id
              and variant.media_item_id = item.id
              and variant.projection_refresh_run_id = p_refresh_run_id
          )
        limit 1
      )
    else
      p_active_count = (
        select count(*)::bigint
        from public.cloud_live_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.projection_refresh_run_id = p_refresh_run_id
      )
      and p_active_count = p_observed_count
      and not exists (
        select 1 from public.cloud_live_variants variant
        where variant.generation_id = p_generation_id
          and variant.user_id = p_user_id and variant.source_id = p_source_id
          and variant.projection_refresh_run_id is distinct from p_refresh_run_id
        limit 1
      )
      and not exists (
        select 1 from public.cloud_media_items item
        where item.generation_id = p_generation_id
          and item.user_id = p_user_id and item.source_id = p_source_id
          and item.item_type = 'live'
          and not exists (
            select 1 from public.cloud_live_variants variant
            where variant.generation_id = item.generation_id
              and variant.user_id = item.user_id
              and variant.source_id = item.source_id
              and variant.media_item_id = item.id
              and variant.projection_refresh_run_id = p_refresh_run_id
          )
        limit 1
      )
      and not exists (
        select 1 from public.cloud_live_logical_channels channel
        where channel.generation_id = p_generation_id
          and channel.user_id = p_user_id and channel.source_id = p_source_id
          and (
            channel.projection_refresh_run_id is distinct from p_refresh_run_id
            or not exists (
              select 1 from public.cloud_live_variants variant
              where variant.generation_id = channel.generation_id
                and variant.user_id = channel.user_id
                and variant.source_id = channel.source_id
                and variant.logical_channel_id = channel.id
                and variant.projection_refresh_run_id = p_refresh_run_id
            )
            or channel.variant_count is distinct from (
              select count(distinct variant.label)::integer
              from public.cloud_live_variants variant
              where variant.generation_id = channel.generation_id
                and variant.user_id = channel.user_id
                and variant.source_id = channel.source_id
                and variant.logical_channel_id = channel.id
                and variant.projection_refresh_run_id = p_refresh_run_id
            )
            or jsonb_typeof(channel.variant_preview) <> 'array'
            or jsonb_array_length(channel.variant_preview) is distinct from
               channel.variant_count
            or channel.default_stream_id is null
            or channel.default_variant ->> 'stream_id' is distinct from
               channel.default_stream_id
            or not exists (
              select 1 from public.cloud_live_variants variant
              where variant.generation_id = channel.generation_id
                and variant.user_id = channel.user_id
                and variant.source_id = channel.source_id
                and variant.logical_channel_id = channel.id
                and variant.projection_refresh_run_id = p_refresh_run_id
                and variant.stream_id = channel.default_stream_id
            )
          )
        limit 1
      )
    end);
end
$function$;

commit;
