-- Refresh stale posters from the global enriched catalogue.
--
-- Per-user cloud_titles / cloud_media_items posters can go STALE: TMDB rotates an
-- image and the stored path 404s (renders as a placeholder), while the global
-- catalog_titles row — maintained by the enrichment pipeline — holds the current
-- poster. Genre rails read cloud_titles.poster_url DIRECTLY (no read-time overlay),
-- so a stale poster there shows broken art. This syncs the per-user tables from the
-- authoritative catalogue for matched titles.
--
-- Idempotent: only rewrites rows whose poster actually differs. Pass NULL for all users.

create or replace function norva_refresh_posters_from_catalog(p_user_id uuid)
returns integer
language plpgsql
as $$
declare
  v_touched integer;
begin
  with upd as (
    update cloud_titles ct set
      poster_url   = cat.poster_url,
      backdrop_url = coalesce(cat.backdrop_url, ct.backdrop_url),
      updated_at   = now()
    from catalog_titles cat
    where cat.item_type = ct.item_type
      and cat.provider_tmdb_id = ct.provider_tmdb_id
      and ct.provider_tmdb_id is not null
      and cat.poster_url is not null
      and (p_user_id is null or ct.user_id = p_user_id)
      and ct.poster_url is distinct from cat.poster_url
    returning 1
  )
  select count(*) into v_touched from upd;
  return v_touched;
end $$;

-- Extend the media reconcile so it ALSO propagates the (now-fresh) title poster down
-- to matched cloud_media_items rows — keeping the flat grid's stored art current for
-- direct readers (mobile/TV) beyond the edge's read-time overlay.
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
      end,
      poster_url = case
        when ct.provider_tmdb_id is not null and ct.poster_url is not null
          then ct.poster_url
        else mi.poster_url
      end
    from cloud_title_variants v
    join cloud_titles ct on ct.id = v.title_id
    where v.media_item_id = mi.id
      and (p_user_id is null or mi.user_id = p_user_id)
      and (
        mi.dedup_key is distinct from ct.identity_key
        or (ct.provider_tmdb_id is not null and (mi.metadata->>'providerTmdbId') is null)
        or (ct.provider_tmdb_id is not null and ct.poster_url is not null and mi.poster_url is distinct from ct.poster_url)
      )
    returning 1
  )
  select count(*) into v_touched from upd;
  return v_touched;
end $$;

-- Fold the poster refresh into the periodic reconcile (canonicalize → refresh posters
-- from catalogue → propagate identity/poster to media).
create or replace function norva_reconcile_catalog(p_user_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_merged   integer;
  v_posters  integer;
  v_touched  integer;
begin
  v_merged  := norva_canonicalize_titles_for_user(p_user_id);
  v_posters := norva_refresh_posters_from_catalog(p_user_id);
  v_touched := norva_backfill_media_identity(p_user_id);
  return jsonb_build_object(
    'titles_merged', v_merged,
    'posters_refreshed', v_posters,
    'media_rows_reconciled', v_touched
  );
end $$;
