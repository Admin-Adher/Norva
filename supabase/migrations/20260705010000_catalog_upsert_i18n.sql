-- On-demand localized-synopsis population for the GLOBAL title cache.
--
-- Phase 3 of the VOD i18n architecture (docs/roadmap/VOD-I18N-AND-REGIONS.md, C.3).
-- When a user viewing a fiche in language X opens a title whose metadata.i18n is
-- missing X, norva-catalog's getTmdbMeta already fetches that title from TMDB in X;
-- this RPC lets the edge persist the localized {title, overview} it got back into the
-- shared catalog_titles row so every future viewer (any user) is served the synopsis
-- in X with no further TMDB call. Scales with real demand, not catalogue size.
--
-- Guarantees:
--   * Idempotent — only fills i18n[lang] when ABSENT; never overwrites an existing
--     translation (the enrichment's full-translations pull stays authoritative).
--   * PK-scoped — matches on the (item_type, provider_tmdb_id) primary key, so the
--     update is a single index probe, never a scan.
--   * Validated — a 2-letter lang and at least one non-empty field, else a no-op.
--   * SECURITY DEFINER so the edge's service-role client (already RLS-exempt) and any
--     future reviewed caller share one audited write path.

create or replace function public.catalog_upsert_i18n(
  p_item_type        text,
  p_provider_tmdb_id text,
  p_lang             text,
  p_title            text,
  p_overview         text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry jsonb;
begin
  -- Language must be a bare ISO-639-1 code; anything else is rejected outright so a
  -- malformed key can never land in the shared i18n map.
  if p_lang is null or p_lang !~ '^[a-z]{2}$' then
    return;
  end if;

  v_entry := jsonb_strip_nulls(jsonb_build_object(
    'title',    nullif(btrim(coalesce(p_title, '')), ''),
    'overview', nullif(btrim(coalesce(p_overview, '')), '')
  ));

  -- Nothing localized to store (both fields blank) → no-op.
  if v_entry = '{}'::jsonb then
    return;
  end if;

  update public.catalog_titles c
     set metadata = jsonb_set(
           -- Ensure the 'i18n' object exists before setting i18n[lang]; jsonb_set
           -- can only create the LAST path element, not intermediate parents.
           case when c.metadata ? 'i18n'
                then c.metadata
                else coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('i18n', '{}'::jsonb)
           end,
           array['i18n', p_lang],
           v_entry,
           true),
         updated_at = now()
   where c.item_type = p_item_type
     and c.provider_tmdb_id = p_provider_tmdb_id
     -- Only fill gaps: never clobber a translation we already have.
     and (c.metadata #> array['i18n', p_lang]) is null;
end;
$$;

comment on function public.catalog_upsert_i18n(text, text, text, text, text) is
  'Phase 3 VOD i18n: idempotently fill catalog_titles.metadata.i18n[lang] on demand '
  'from the edge (norva-catalog getTmdbMeta). Fills gaps only; never overwrites.';

-- Lock the write path to the edge only. New functions grant EXECUTE to PUBLIC by
-- default, which would let any authenticated (or anon) client call this via PostgREST
-- and inject text into the SHARED synopsis cache — so revoke PUBLIC and grant solely to
-- service_role (the key norva-catalog's db client uses).
revoke all on function public.catalog_upsert_i18n(text, text, text, text, text) from public;
grant execute on function public.catalog_upsert_i18n(text, text, text, text, text)
  to service_role;
