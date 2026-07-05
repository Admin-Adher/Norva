# Movies/Series filters empty on large accounts — audit + fix (2026-07-05)

## Symptom
On the Movies (and Series) page the three browse filters — **Audio**, **Subtitles**, **Categories** —
showed only their "Any …" / "No categories found" placeholder, **despite catalogues of hundreds of
thousands of titles**. The bigger the catalogue, the emptier the filters — the opposite of expected.

## Root causes (both scale-related, verified against the live DB)
All three filters read from `cloud_titles` (scoped to the user, `variant_count > 0`) via the
`norva-catalog` edge. The data was there; the **live computation** failed at scale.

| Filter | Endpoint | Cause |
|---|---|---|
| Categories | `/media-genre-summary` → `cloud_genre_bucket_counts` | Hard **"big-account guard"**: `if catalog_item_estimate > 60000 then return;` → returned nothing above 60k items. The 335k / 181k-movie accounts got `[]`; only the 59k account worked. |
| Audio / Subtitles | `/media-language-facets` | **25 `count(exact)` probes** (15 audio + 10 subtitle), one per language, on every load. Each materialised every matching row (~1.3s over 335k) → the endpoint didn't return → both dropdowns empty. The data existed (French audio 12,447 · English 22,083 · French subs 82…). |

Live measurements (account `7bdab1df…`, 334,604 browsable movies): genre group-by **4.6s**, one
audio-facet `count(exact)` **1.3s**. `/media-genre-summary` and `/media-language-facets` are both
CDN-cached 60s and run as `service_role` (120s statement_timeout) — so neither is timeout-bound; the
guard + the 25-count design were simply the wrong shape.

## Fix

### Phase 1 — restore the filters (shipped, PR #173)
- **Genres**: raised the guard ceiling `60000 → 1000000` (`cloud_genre_bucket_counts`). The group-by
  is ~4.6s and cached 60s — acceptable interim. The picker returns its real buckets immediately
  (14 for the 335k account, 13 for the 181k account).
- **Facets**: `present()` in `listLanguageFacets` now does an **existence check** (`select id … limit 1`)
  instead of `count(exact)` — stops at the first match / empty GIN bitmap, ~ms per facet.

### Phase 2 — precomputed per-user facet summary (scalable)
`cloud_catalog_facet_summary(user_id, item_type, genre_bucket_counts jsonb, audio_langs text[],
version_tags text[], refreshed_at)` — one small row per (user, item_type):
- **`cloud_refresh_facet_summary(user, item_type)`** recomputes it (two scans: genre counts + a
  combined unnest of `audio_languages` + `version_languages` distinct tags).
- **`cloud_refresh_all_facet_summaries(limit)`** refreshes combos missing or > 30 min stale.
- Cron **`norva-facet-summary-refresh`** (`7-59/15 * * * *`) keeps it fresh at sync cadence.
- The edge (`listGenreSummary`, `listLanguageFacets`) reads this row and derives the menus with pure
  set math — **an instant single-row read at any catalogue size** — and **falls back to the live
  path when the summary is missing** (new user), so a filter is never wrongly empty.

RLS-on / no policy (service_role reads; the cron/postgres writes). `cloud_genre_bucket_counts` stays
as the per-source (Manage Content) fallback and for un-summarised users.

## Verify
```sql
-- genres populate for a big account
select count(*) from cloud_genre_bucket_counts('<uuid>','movie');   -- was 0, now 14
-- summary content
select item_type, cardinality(audio_langs), cardinality(version_tags),
       (select count(*) from jsonb_object_keys(genre_bucket_counts))
from cloud_catalog_facet_summary where user_id='<uuid>';
```
