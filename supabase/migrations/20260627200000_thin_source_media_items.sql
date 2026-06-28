-- Phase 2 (dedup-plan.md) — per-user thinning (where the storage saving lands).
--
-- Once a source's grid + playback reads resolve the provider-global
-- catalog_media_items (NORVA_CATALOG_MEDIA_READ_SOURCE=catalog_media_items), the
-- heavy display/playback fields no longer need to live on every user's
-- cloud_media_items row. This nulls them on the per-user rows, keeping ONLY what
-- the per-user query still needs: membership, availability, and the sort columns
-- (title + added_at/rating_num/release_year — the grid sorts on them server-side).
--
-- SAFE: a field is thinned ONLY where the global already holds a non-empty value
-- for that exact file, so applyMediaCatalogOverlay / resolvePlaybackTarget can
-- always refill it. Reversible — un-thin by refilling from the global (SQL in
-- docs/roadmap/phase2-dedup-execution.md).
--
-- GATED ON SCALE — DO NOT RUN AT ONE USER PER PROVIDER. With a single owner the
-- global copy + a thinned per-user row together cost MORE than one full per-user
-- row; the saving only appears once several users share a provider host (global
-- stays 1x, each extra user's row is tiny). Run only with 2+ same-provider users
-- AND the read flag on AND catalog_media_mirror_diff clean.

create or replace function public.thin_source_media_items(p_source_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout to '300s'
as $$
declare v_host text; n int;
begin
  select s.config_hint->>'serverHost' into v_host from cloud_sources s where s.id = p_source_id;
  if coalesce(v_host,'') = '' then return 0; end if;

  update cloud_media_items m
     set poster_url    = case when nullif(g.poster_url, '')   is not null then null         else m.poster_url end,
         backdrop_url  = case when nullif(g.backdrop_url, '') is not null then null         else m.backdrop_url end,
         subtitle      = case when nullif(g.subtitle, '')     is not null then null         else m.subtitle end,
         metadata      = case when g.metadata      <> '{}'::jsonb         then '{}'::jsonb  else m.metadata end,
         playback_hint = case when g.playback_hint <> '{}'::jsonb         then '{}'::jsonb  else m.playback_hint end
    from catalog_media_items g
   where m.source_id = p_source_id
     and g.server_host = v_host and g.item_type = m.item_type and g.external_id = m.external_id
     and ( (nullif(g.poster_url, '')   is not null and m.poster_url   is not null)
        or (nullif(g.backdrop_url, '') is not null and m.backdrop_url is not null)
        or (nullif(g.subtitle, '')     is not null and m.subtitle     is not null)
        or (g.metadata      <> '{}'::jsonb and m.metadata      <> '{}'::jsonb)
        or (g.playback_hint <> '{}'::jsonb and m.playback_hint <> '{}'::jsonb) );
  get diagnostics n = row_count;
  return n;
end; $$;
revoke all on function public.thin_source_media_items(uuid) from anon, authenticated;
