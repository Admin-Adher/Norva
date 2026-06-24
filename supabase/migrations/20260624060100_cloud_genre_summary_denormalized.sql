-- Switch cloud_genre_summary to the denormalised genre_category / genre_payload
-- columns (added + backfilled in 20260624060000). Same signature and return shape,
-- so the norva-catalog edge function's db.rpc("cloud_genre_summary", ...) call is
-- unchanged — no redeploy. The GROUP BY now reads two narrow inline columns instead
-- of detoasting the metadata JSONB of every title, taking the aggregation from
-- ~5.7s (statement-timeout territory) to ~150ms.
--
-- Apply order on prod: this migration runs AFTER the one-time backfill of the new
-- columns, so the grouping keys are already populated when the RPC starts reading
-- them.

create or replace function public.cloud_genre_summary(
  p_user_id uuid,
  p_item_type text,
  p_source_id uuid default null
)
returns table(category_name text, genres jsonb, n bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    t.genre_category as category_name,
    t.genre_payload  as genres,
    count(*)         as n
  from public.cloud_titles t
  where t.user_id = p_user_id
    and t.item_type = p_item_type
    and (
      p_source_id is null
      or exists (
        select 1
        from public.cloud_title_variants v
        where v.title_id = t.id
          and v.source_id = p_source_id
      )
    )
  group by 1, 2
$$;

revoke execute on function public.cloud_genre_summary(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function public.cloud_genre_summary(uuid, text, uuid) to service_role;
