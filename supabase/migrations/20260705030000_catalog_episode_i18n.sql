-- Phase 5 of the VOD i18n architecture (docs/roadmap/VOD-I18N-AND-REGIONS.md, C.9):
-- a persistent per-(series, season, lang) episode-metadata cache UNDER the two volatile tiers
-- getTmdbEpisodes already has (an in-isolate Map, 6h TTL; and a 1-day CDN cache). Today a
-- season's TMDB stills / localized names / overviews / air dates are re-fetched from TMDB on
-- every isolate recycle, cold CDN PoP, or age-out — and Phase 3 multiplied the distinct
-- (season, lang) keys by generalizing the locale beyond fr/en, so the re-fetch churn grew.
-- This L2 makes a season fetched ONCE (any user, any PoP, any language) serve every future
-- viewer with no further TMDB call, surviving isolate/CDN eviction.
--
-- Progressive enhancement ONLY: the client still degrades to the provider's own episode rows
-- when a key is absent, so this is a resilience / TMDB-cost tier, not a correctness dependency.
--
-- Only tv has episodes, so provider_tmdb_id here is unambiguously a TMDB tv id (no item_type
-- column needed). The addressable universe is small (~7.9k TMDB-matched series / ~15k seasons ×
-- the languages actually browsed), so no partitioning / pre-provisioning. Mirrors
-- cloud_series_info_cache: service-role only, RLS on, a plain full-row upsert straight from the
-- edge (no RPC — the write replaces the whole row, there is no shared gap-fill invariant).
create table if not exists public.catalog_episode_i18n (
  provider_tmdb_id text        not null,
  season           smallint    not null,
  lang             text        not null,
  episodes         jsonb       not null,
  fetched_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (provider_tmdb_id, season, lang),
  constraint catalog_episode_i18n_lang_chk check (lang ~ '^[a-z]{2}$')
);

comment on table public.catalog_episode_i18n is
  'Phase 5 VOD i18n: persistent L2 cache of one TMDB season''s episode metadata (stills, '
  'localized names/overviews, air dates, runtime, vote) per (provider_tmdb_id tv id, season, '
  'lang). Read-through/write-through by norva-catalog getTmdbEpisodes; progressive-enhancement '
  'only — the client degrades to provider episode rows when a key is absent.';

alter table public.catalog_episode_i18n enable row level security;
-- service_role bypasses RLS; anon/authenticated get no policy → no access (mirrors
-- cloud_series_info_cache). The edge's service-role client reads/writes it directly.
revoke all on public.catalog_episode_i18n from anon, authenticated;
