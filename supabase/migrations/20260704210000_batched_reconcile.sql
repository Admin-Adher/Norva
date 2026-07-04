-- Batched reconcile — generalization to all accounts.
--
-- Two accounts have huge catalogues (570k / 273k media items), so the one-shot
-- norva_backfill_media_identity(null) / norva_refresh_posters_from_catalog(null) would be
-- a single multi-hundred-thousand-row UPDATE (statement timeout + giant transaction). Both
-- are made batch-bounded (p_limit): idempotent, so repeated cron runs chip away at the
-- backlog — the same drain pattern as the search-match cron. NULL limit = unbounded (the
-- old behaviour, kept for a scoped/small account).
--
-- The earlier migrations created 1-arg versions of these functions. Adding a 2nd arg with
-- a default creates a NEW overload rather than replacing them, so a 1-arg call becomes
-- ambiguous ("function ... is not unique"). Drop the 1-arg versions first.
drop function if exists norva_reconcile_catalog(uuid);
drop function if exists norva_backfill_media_identity(uuid);
drop function if exists norva_refresh_posters_from_catalog(uuid);

create or replace function norva_backfill_media_identity(p_user_id uuid, p_limit int default null)
returns integer
language plpgsql
as $$
declare
  v_touched integer;
begin
  with cand as (
    select mi.id, ct.identity_key, ct.provider_tmdb_id, ct.poster_url
    from cloud_media_items mi
    join cloud_title_variants v on v.media_item_id = mi.id
    join cloud_titles ct on ct.id = v.title_id
    where (p_user_id is null or mi.user_id = p_user_id)
      and (
        mi.dedup_key is distinct from ct.identity_key
        or (ct.provider_tmdb_id is not null and (mi.metadata->>'providerTmdbId') is null)
        or (ct.provider_tmdb_id is not null and ct.poster_url is not null and mi.poster_url is distinct from ct.poster_url)
      )
    limit p_limit
  ),
  upd as (
    update cloud_media_items mi set
      dedup_key = c.identity_key,
      metadata = case
        when c.provider_tmdb_id is not null and (mi.metadata->>'providerTmdbId') is null
          then jsonb_set(coalesce(mi.metadata, '{}'::jsonb), '{providerTmdbId}', to_jsonb(c.provider_tmdb_id))
        else mi.metadata
      end,
      poster_url = case
        when c.provider_tmdb_id is not null and c.poster_url is not null then c.poster_url
        else mi.poster_url
      end
    from cand c
    where mi.id = c.id
    returning 1
  )
  select count(*) into v_touched from upd;
  return v_touched;
end $$;

create or replace function norva_refresh_posters_from_catalog(p_user_id uuid, p_limit int default null)
returns integer
language plpgsql
as $$
declare
  v_touched integer;
begin
  with cand as (
    select ct.id, cat.poster_url, coalesce(cat.backdrop_url, ct.backdrop_url) as backdrop_url
    from cloud_titles ct
    join catalog_titles cat on cat.item_type = ct.item_type and cat.provider_tmdb_id = ct.provider_tmdb_id
    where ct.provider_tmdb_id is not null
      and cat.poster_url is not null
      and (p_user_id is null or ct.user_id = p_user_id)
      and ct.poster_url is distinct from cat.poster_url
    limit p_limit
  ),
  upd as (
    update cloud_titles ct set
      poster_url   = c.poster_url,
      backdrop_url = c.backdrop_url,
      updated_at   = now()
    from cand c
    where ct.id = c.id
    returning 1
  )
  select count(*) into v_touched from upd;
  return v_touched;
end $$;

-- Reconcile now takes a batch size (default 25k) passed to the two heavy backfills.
-- Canonicalize stays whole (dup groups are few even globally). Repeated runs drain the
-- backlog; a run is a no-op once everything is reconciled.
create or replace function norva_reconcile_catalog(p_user_id uuid, p_limit int default 25000)
returns jsonb
language plpgsql
as $$
declare
  v_merged   integer;
  v_posters  integer;
  v_touched  integer;
begin
  v_merged  := norva_canonicalize_titles_for_user(p_user_id);
  v_posters := norva_refresh_posters_from_catalog(p_user_id, p_limit);
  v_touched := norva_backfill_media_identity(p_user_id, p_limit);
  return jsonb_build_object(
    'titles_merged', v_merged,
    'posters_refreshed', v_posters,
    'media_rows_reconciled', v_touched
  );
end $$;
