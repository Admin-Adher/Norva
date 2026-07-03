-- Fuzzy / typo-tolerant global search (audit UX vs Netflix 2026-07-03, transversal gap).
-- Search was title-only ILIKE substring — "intersteller" matched nothing. pg_trgm
-- adds trigram similarity so near-misses rank in, while exact substring still wins.
-- (Applied live via MCP; committed for record.)
create extension if not exists pg_trgm;

create index if not exists cloud_media_items_title_trgm
  on public.cloud_media_items using gin (title gin_trgm_ops);

create or replace function public.search_media_items(
  p_user uuid,
  p_item_type text,
  p_q text,
  p_limit int default 24
) returns setof public.cloud_media_items
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.cloud_media_items t
  where t.user_id = p_user
    and t.item_type = p_item_type
    and (
      t.title ilike '%' || p_q || '%'
      or t.title % p_q                       -- trigram similarity (typo tolerance)
    )
  order by
    (t.title ilike '%' || p_q || '%') desc,  -- substring hits first
    similarity(t.title, p_q) desc,
    t.title
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function public.search_media_items(uuid, text, text, int) from anon, authenticated;
