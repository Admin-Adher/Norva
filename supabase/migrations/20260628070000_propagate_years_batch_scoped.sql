-- Scale fix: make release_year propagation batch-scoped instead of whole-source.
--
-- propagate_media_item_years(p_user, p_source) ran inside refreshVodTitleProjection
-- on EVERY finalize titles batch and UPDATE-joined ALL of a source's cloud_media_items
-- (~216k for a huge provider) to cloud_titles on a JSONB-extracted field with no index
-- — an O(n)-per-batch / O(n²)-total scan. On a 217k-VOD catalogue it crossed the 8s
-- statement timeout, so every batch failed to commit and the finalize froze.
--
-- Add an optional p_item_ids array: when provided, the update is scoped to just the
-- batch's rows via the primary key (m.id = any(p_item_ids)) — a ~300-row lookup. When
-- null it falls back to the whole-source behaviour (backward compatible for any one-shot
-- caller). The projection now always passes the batch ids.
drop function if exists public.propagate_media_item_years(uuid, uuid);

create or replace function public.propagate_media_item_years(
  p_user uuid, p_source uuid, p_item_ids uuid[] default null
) returns void language sql as $$
  update cloud_media_items m set release_year = t.release_year
  from cloud_titles t
  where m.user_id = p_user and m.source_id = p_source and m.item_type in ('movie','series')
    and (p_item_ids is null or m.id = any(p_item_ids))
    and t.user_id = m.user_id and t.item_type = m.item_type
    and t.provider_tmdb_id = m.metadata->>'providerTmdbId'
    and t.provider_tmdb_id not in ('0','')
    and t.release_year is not null
    and m.release_year is distinct from t.release_year;
$$;
