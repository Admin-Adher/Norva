# Global shared title cache — design (migration target)

Status: **design only.** Do not implement until there is meaningful cross-user
catalogue overlap. With one catalogue today the saving is 0% (measured), and the
read-path cutover is the highest-risk change in the system. Design now so the
migration is clean when the users arrive.

## Problem

`cloud_titles` is keyed per user (`user_id, item_type, identity_key`). The
enriched metadata it holds — TMDB details, `release_year`, posters, `i18n` (20-31
languages) — is a property of the **title**, identical for every user. With
N users whose catalogues overlap (same Spanish films across all Spanish users),
we store and TMDB-enrich the same title N times.

At scale this multiplies:
- **TMDB calls** (enrichment + revalidation + translations) by the overlap factor.
- **Storage** of heavy metadata (`i18n` alone is several KB/title).

The overlap factor for same-country IPTV is typically 10-100x, so a shared cache
divides both by roughly that.

## Target architecture

Split identity (per user) from metadata (global).

### `catalog_titles` (new, global — keyed by the title, not the user)
```
(item_type, provider_tmdb_id)  -- primary key
title_default            text         -- catalogue-default-language display title
original_title           text
release_year             int
poster_path              text         -- TMDB path; the relay builds the URL
backdrop_path            text
genres                   text[]
runtime                  int
vote_average             numeric
i18n                     jsonb         -- { <lang>: { title, overview } }
tmdb                     jsonb         -- full validated TMDB details
enriched_at              timestamptz
tmdb_synced_at           timestamptz   -- for TMDB *changes* API incremental refresh
```
Enriched **once** per (item_type, tmdb_id), shared by all users. No `user_id`.

### `cloud_titles` (kept, but thinned to a per-user link)
Keeps only what is user/provider-specific:
`user_id, item_type, identity_key, provider_tmdb_id, match_status,
default_variant_id, variant_count`. The heavy metadata columns move to
`catalog_titles`; reads join (or denormalize a hot subset).

`cloud_title_variants` is unchanged (already per source/stream).

## Read path

`titleRailItem` / `listGenreItems` / `listMediaItems` resolve metadata from
`catalog_titles` by `(item_type, provider_tmdb_id)`, serving `i18n[lang]` exactly
as today — the serve logic is already lang-aware (#4B), so only the **source** of
the i18n/title/poster changes.

## Enrichment path

`refreshVodTitleProjection` and the revalidation/year/translation work write to
`catalog_titles` keyed by tmdb id, guarded so a title is enriched only if missing
or stale. A user's sync then becomes: match provider items → tmdb id → ensure the
global title is enriched (cheap if another user already did it) → write the
thin per-user link + variants. This is where the 10-100x saving lands.

Add the **TMDB `changes` API** to refresh only titles whose `tmdb_synced_at` is
old, and **TMDB daily id exports** for bulk seeding — both operate on the global
table, once, for everyone.

## Migration (when triggered)

Additive and reversible, staged:
1. Create `catalog_titles` (no behaviour change).
2. **Dual-write**: enrichment writes both `cloud_titles` (as today) and
   `catalog_titles`.
3. **Backfill** `catalog_titles` from the distinct `(item_type, provider_tmdb_id)`
   already in `cloud_titles` (one row per title, dropping the per-user dupes).
4. **Read cutover**: switch the read path to `catalog_titles` behind a flag;
   verify against the current output.
5. Thin `cloud_titles` (drop the migrated metadata columns) once reads are stable.

## Trigger to implement

Run the overlap query (distinct titles vs total per-user title rows). When the
ratio is materially > 1 (i.e. real multi-user overlap), implement. Until then this
document is the spec; the read path is already structured to make step 4 small.

## Guardrails carried over from this session

- `provider_tmdb_id = '0'/''` is a no-match sentinel — never key or join on it.
- Parsed release years must be capped to `[1900, current_year + 1]`.
- Provider TMDB ids are trusted for identity; TMDB validation gates only whether
  TMDB *metadata* is trusted over the provider's.
