-- Flat-grid dedup key + tmdb propagation for cloud_media_items.
--
-- The flat Movies/Series grid reads cloud_media_items (one row per provider entry),
-- so a film the provider lists twice shows as two cards. Each media item links to
-- exactly one cloud_titles row (via cloud_title_variants, verified 1:1), and after
-- canonicalization that title's identity_key is the film's single canonical identity
-- (`tmdb:<id>` when matched, else `norm:<title>`).
--
-- We denormalize that identity onto the media row as `dedup_key` so the grid can
-- DISTINCT ON it server-side (collapsing duplicates even across pages), and we
-- propagate the title's resolved tmdb id into metadata.providerTmdbId so the media
-- row enriches (poster/overview) and groups like its matched sibling instead of
-- rendering as an empty "ghost" card.

alter table cloud_media_items add column if not exists dedup_key text;

create index if not exists cloud_media_items_dedup_key_idx
  on cloud_media_items (user_id, item_type, dedup_key);

-- Backfill / reconcile a user's media rows from their linked titles. Idempotent:
-- only rewrites a row when its dedup_key is stale or its tmdb id is missing.
-- Pass NULL to process every user.
create or replace function norva_backfill_media_identity(p_user_id uuid)
returns integer
language plpgsql
as $$
declare
  v_touched integer;
begin
  with upd as (
    update cloud_media_items mi set
      dedup_key = ct.identity_key,
      metadata = case
        when ct.provider_tmdb_id is not null and (mi.metadata->>'providerTmdbId') is null
          then jsonb_set(coalesce(mi.metadata, '{}'::jsonb), '{providerTmdbId}', to_jsonb(ct.provider_tmdb_id))
        else mi.metadata
      end
    from cloud_title_variants v
    join cloud_titles ct on ct.id = v.title_id
    where v.media_item_id = mi.id
      and (p_user_id is null or mi.user_id = p_user_id)
      and (
        mi.dedup_key is distinct from ct.identity_key
        or (ct.provider_tmdb_id is not null and (mi.metadata->>'providerTmdbId') is null)
      )
    returning 1
  )
  select count(*) into v_touched from upd;
  return v_touched;
end $$;
