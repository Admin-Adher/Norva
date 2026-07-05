-- Phase 4 of the VOD i18n architecture (docs/roadmap/VOD-I18N-AND-REGIONS.md, C.8):
-- a whole-map on-demand write path, a per-title "attempted" negative-cache marker, and
-- the bounded gap-fill candidate query the pre-warm cron drives.
--
-- Reality that shaped this (verified on the live DB): enrichment already writes a FULL
-- multi-language i18n map from TMDB `translations`, so 39,390 of 39,479 validated matches
-- are already localized — only ~89 validated gaps remain. The 51,250 rows with a numeric
-- id but no metadata.tmdb are UNVALIDATED (a matching problem, not an i18n one) and are
-- deliberately out of scope here. So Phase 4 is (1) a demand-driven full-map writer that
-- localises a title in EVERY language TMDB has from the one call getTmdbMeta already makes,
-- (2) a per-title attempt marker so the cron/on-demand paths stop re-pulling a title whose
-- translations were just fetched, and (3) a tiny gap-fill cron for the residual matches.

-- ── Per-title attempt marker ─────────────────────────────────────────────────────────
-- A dedicated scalar timestamptz — the codebase's proven pattern (cloud_titles.whisper_
-- attempted_at, revalidate_attempted_at) — NOT a metadata jsonb key (which would re-TOAST
-- the multi-KB row on every write and ride along on every rail read via applyCatalogOverlay).
-- Per-title (not per-lang) is correct here because ONE translations pull returns every
-- language TMDB has, so "attempted" is a whole-title fact, not a per-language one.
alter table public.catalog_titles
  add column if not exists i18n_attempted_at timestamptz;

comment on column public.catalog_titles.i18n_attempted_at is
  'Phase 4 VOD i18n: last time a full TMDB translations pull was attempted for this title. '
  'Set by catalog_upsert_i18n_map and the pre-warm cron; lets both skip a title re-pulled '
  'within the retry window. A real translation always wins the read via metadata.i18n[lang].';

-- Gap set for the cron: validated matches (metadata.tmdb) that still lack any i18n. The
-- partial index catalog_titles_i18n_gap_idx keeps the cron candidate scan AND the cron's
-- WHERE EXISTS guard off the 90k-row TOAST heap.
--
-- ⚠ The index is built OUT-OF-BAND (CREATE INDEX CONCURRENTLY via execute_sql — see
-- supabase/functions/ENRICHMENT_CRON_SETUP.md), NOT here. A plain in-migration build would
-- evaluate `metadata ? …` on every heap tuple → detoast all ~90k rows (~1-2 min) under a
-- write-blocking ShareLock that stalls the enrichment fleet + on-demand i18n writes, and can
-- exceed the 2-min statement_timeout and roll the migration back. Build it CONCURRENTLY,
-- off-peak, BEFORE enabling the norva-prewarm-i18n cron (until it exists the candidate RPC
-- and the guard fall back to a seq-scan detoast — correct but slow, so the cron stays off).

-- ── Whole-map gap-fill writer ────────────────────────────────────────────────────────
-- Merges a full {lang:{title,overview}} map into metadata.i18n GAP-FILL style: existing
-- language keys WIN (the enrichment's authoritative translations are never clobbered), new
-- languages are added. One statement, PK-scoped. Also stamps i18n_attempted_at. An empty /
-- non-object map only stamps the marker — it never re-TOASTs the metadata blob (the common
-- "TMDB has no translations for this title" case stays cheap).
create or replace function public.catalog_upsert_i18n_map(
  p_item_type        text,
  p_provider_tmdb_id text,
  p_i18n             jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_i18n is null or jsonb_typeof(p_i18n) <> 'object' or p_i18n = '{}'::jsonb then
    -- Nothing localised to store → only record the attempt (cheap; leaves metadata untouched).
    update public.catalog_titles c
       set i18n_attempted_at = now()
     where c.item_type = p_item_type and c.provider_tmdb_id = p_provider_tmdb_id;
    return;
  end if;

  -- Gap-fill merge: `p_i18n || existing` → existing lang keys override incoming ones. When
  -- that equals the stored i18n (the common case — the title is already fully localized and
  -- getTmdbMeta re-sends the same translations on a cold open), skip the metadata rewrite:
  -- `else c.metadata` passes the stored value through unchanged so heap_update REUSES its TOAST
  -- pointer (no multi-KB re-TOAST / dead-tuple churn on the hottest titles). i18n_attempted_at
  -- is a tiny scalar → always stamped so the negative cache still advances.
  update public.catalog_titles c
     set metadata = case
           when (p_i18n || coalesce(c.metadata->'i18n', '{}'::jsonb))
                is distinct from coalesce(c.metadata->'i18n', '{}'::jsonb)
           then jsonb_set(coalesce(c.metadata, '{}'::jsonb), array['i18n'],
                          p_i18n || coalesce(c.metadata->'i18n', '{}'::jsonb), true)
           else c.metadata
         end,
         i18n_attempted_at = now(),
         updated_at = case
           when (p_i18n || coalesce(c.metadata->'i18n', '{}'::jsonb))
                is distinct from coalesce(c.metadata->'i18n', '{}'::jsonb)
           then now() else c.updated_at
         end
   where c.item_type = p_item_type and c.provider_tmdb_id = p_provider_tmdb_id;
end;
$$;

comment on function public.catalog_upsert_i18n_map(text, text, jsonb) is
  'Phase 4 VOD i18n: gap-fill merge a full {lang:{title,overview}} map into '
  'catalog_titles.metadata.i18n (existing langs win) + stamp i18n_attempted_at. Empty map '
  'only stamps the marker, never re-TOASTs metadata.';

-- ── Bounded gap-fill candidate query for the cron ────────────────────────────────────
-- Returns validated matches still missing i18n and not attempted within the retry window,
-- ordered by PK, using catalog_titles_i18n_gap_idx. Bounded so a run is index-time.
create or replace function public.catalog_i18n_prewarm_candidates(
  p_limit        int         default 100,
  p_retry_before timestamptz default (now() - interval '90 days')
) returns table(item_type text, provider_tmdb_id text, title text, release_year int)
language sql
security definer
set search_path = public
stable
as $$
  select c.item_type, c.provider_tmdb_id, c.title, c.release_year
  from public.catalog_titles c
  where (c.metadata ? 'tmdb') and not (c.metadata ? 'i18n')
    and (c.i18n_attempted_at is null or c.i18n_attempted_at < p_retry_before)
  order by c.item_type, c.provider_tmdb_id
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

comment on function public.catalog_i18n_prewarm_candidates(int, timestamptz) is
  'Phase 4 VOD i18n: bounded gap-fill candidates for the pre-warm cron — validated matches '
  '(metadata.tmdb present) still missing i18n, not attempted within the retry window.';

-- Lock both to the edge's service_role (new functions default to PUBLIC EXECUTE, which would
-- let anon/authenticated poison the SHARED cache or scan it via PostgREST).
revoke all on function public.catalog_upsert_i18n_map(text, text, jsonb) from public;
grant execute on function public.catalog_upsert_i18n_map(text, text, jsonb) to service_role;
revoke all on function public.catalog_i18n_prewarm_candidates(int, timestamptz) from public;
grant execute on function public.catalog_i18n_prewarm_candidates(int, timestamptz) to service_role;
