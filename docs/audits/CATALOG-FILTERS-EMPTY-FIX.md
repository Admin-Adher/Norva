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

## Addendum (2026-07-05, THE ACTUAL FIX) — a swallowed ReferenceError in the wrapper

The expiry-routing theory below was *also* a wrong turn. A full A→Z browser probe nailed it:

```
CODE api.js : NOUVEAU ✓        _hasCloudUserAccount()=true   user.id present   token valid (45 min)
USER endpoint direct : audio=15        ← NorvaCloud.home.languageFacets works
WRAPPER (app)        : audio=0         ← API.media.languageFacets returns empty
WRAPPER's error signature == DEVICE endpoint's == "Missing bearer token"
```

Everything pointed to `cloudHomeApi()` returning the device API — yet `_hasCloudUserAccount()` was
`true`. The resolution: **`cloudHomeApi` is defined *inside* the `CloudAdapter` IIFE**
(`const CloudAdapter = (() => { … function cloudHomeApi(){…} … return { cloudHomeApi, … } })()`) and is
only reachable as `CloudAdapter.cloudHomeApi`. But the **file-scope** wrappers
`API.media.languageFacets` / `reportObservedLanguages` called **bareword `cloudHomeApi()`**, which is
out of scope at file level → **`ReferenceError` → caught by the wrapper's own `try/catch` → returns
`{audio:[],subtitles:[]}`**. The endpoint was therefore *never even reached* (no request in the edge
logs, no visible error) — which is exactly what every earlier trace showed. The in-IIFE callers
(rails/genre) worked because they're inside the closure. The IIFE's own return block even documents the
trap: *"exposed so the file-scope API.media wrappers can reach the IIFE-internal caches (otherwise
they'd throw a swallowed ReferenceError)."*

**Fix:** call `CloudAdapter.cloudHomeApi()` (the exposed handle) from the two file-scope wrappers,
exactly like the neighbouring `clearRailCache: () => CloudAdapter.clearRailCache()`.

> **Lesson:** a `try/catch` that maps *all* failures to a benign empty value will hide a
> `ReferenceError` (a scope/typo bug) as if it were a data-empty state. Scope the catch to the awaited
> call, not the synchronous lookup — or at least don't swallow synchronous throws silently.

---

## Addendum (2026-07-05, TRULY FINAL) — the client-side other half (a wrong turn: routing was fine)

Even after the SQL/edge fix below, the menus were STILL empty. A two-layer browser probe split it cleanly:

```
WRAPPER api.js      : audio=0  | subs=0        ← API.media.languageFacets()
DIRECT endpoint     : audio=15 | subs=1        ← NorvaCloud.home.languageFacets()
```

So the **edge was fixed** (direct call = 15) but the **`api.js` wrapper** returned empty. Cause:
`API.media.languageFacets` routes through `cloudHomeApi()` = `hasUserSession() ? NorvaCloud.home :
NorvaCloud.device.home`, and `hasUserSession()` (→ `_hasCloudUserSession`) returns **false when the
access token is within 30 s of / past expiry** (`expires_at > now + 30`). So the facets call fell back
to the **device** endpoint (`/device/media-language-facets`) — which has no device token for a
logged-in user → **401 → swallowed → empty**. The working sibling calls (genre rails/summary) go
through `API.request` (user token + auto-refresh on 401), so they never hit this.

**Fix:** route the `cloud{Sources,Media,Live,Home}Api()` helpers by whether a user *account* session
exists (`_hasCloudUserAccount()`, **expiry-agnostic**) instead of by token freshness. `requestToBase`
already refreshes an expired token on the first 401, so a logged-in user must always use the user
endpoints; the device endpoints are only for pure browse-tier clients. `_hasCloudUserSession`
(expiry-aware) still gates cloud-vs-local mode.

> **Lesson:** don't pick user-vs-device edge endpoints from an expiry-aware session check — a
> momentarily-lapsed token then silently downgrades a logged-in user to the tokenless device path.

---

## Addendum (2026-07-05, FINAL) — the actual root cause of the empty Audio/Subtitles menus

The two addenda below (cache-buster, PWA) were **wrong turns** — kept here honestly. The build
content-hashes every asset and the service worker is network-first, so the client always had the
current code. A live diagnostic run from the user's own browser cracked it:

```
cloud=true | compte=adrien.hernandez@outlook.com | audio=0 | sous-titres=0
{"audio":[],"subtitles":[]}
```

A clean `200` with empty arrays — for an account whose `cloud_catalog_facet_summary` row holds **70
audio ISO codes** and `version_tags {multi,vostfr}`. Not auth, not user-id, not RLS (Categories,
same user, worked).

**Root cause:** `listLanguageFacets` read the summary's `audio_langs` / `version_tags` (Postgres
`text[]`) through supabase-js and gated the whole block on `Array.isArray(audio_langs) ||
Array.isArray(version_tags)`. Those `text[]` columns were **not surfaced as JS arrays**, so the guard
was false → the summary block was skipped → the live `.or()` fallback also returned nothing → both
menus empty. **Genres never hit this** because `listGenreSummary` reads a **jsonb** column
(`genre_bucket_counts`) *and* has an RPC fallback (`cloud_genre_bucket_counts`). That's the exact
"Categories work, Audio/Subtitles don't" split the user saw.

**Fix (migration `20260705110000`):** compute the facets in SQL and return **JSONB** —
`cloud_language_facets(user, item_type)` reads the summary (live distinct-tag scan as fallback) and
applies the same audio/subtitle taxonomy in Postgres. The edge now just calls the RPC and returns its
`{audio, subtitles}`. jsonb deserialises reliably (like `genre_bucket_counts`), so the menus can't
silently empty again. Verified live: adrien → **15 audio + French**; jeremy → 15 + Arabic & French;
horizon → 15 + French.

> **Lesson:** never gate logic on `Array.isArray()` of a Postgres `text[]` read through PostgREST/
> supabase-js — do the set math in SQL and return jsonb, or the read silently no-ops.

---

## Addendum (2026-07-05, later) — why Audio/Subtitles were STILL empty after PR #175 (a wrong turn)

PR #175 fixed `api.js languageFacets` (never cache an empty result; bump the localStorage key
to `norva-facets2`) — but the menus **stayed empty and the edge logs showed the
`media-language-facets` endpoint was still never called.**

**Root cause: a dead-on-arrival deploy.** The app shell versions every script with a query
string (`<script src="/js/api.js?v=67">`) — that query string is the browser/CDN cache key.
PR #175 changed `api.js`'s **content** but **did not bump `?v=67`**, so every browser (and
Cloudflare's edge) kept serving the **old** `api.js?v=67` with the empty-caching bug. The fix
shipped to the repo but never reached a single browser.

**Fix:** bump the cache-buster so the corrected file actually loads.
- `public/app.html`: `api.js?v=67 → ?v=68`
- `public/cloud-link.html`: `api.js?v=26 → ?v=27`

The backend was already correct — verified live: the reference account's
`cloud_catalog_facet_summary` holds 70 audio ISO codes (all 15 whitelisted facets present)
and `version_tags = {multi, vostfr}`, and `listLanguageFacets` derives **15 audio languages +
French subtitles** from it. This is purely making the client load the code that consumes them.

> **Rule going forward:** editing any `public/js/**` file that the shell loads with `?v=N`
> is only half the change — the matching `?v=` in `app.html` (and any other shell) MUST be
> bumped in the same commit, or the deploy is a no-op for returning users.

## Addendum (2026-07-05) — anime → Adult Animation (classifier)

The **Adult Animation** rail was permanently empty (0 titles) while **Kids Animation** held
everything (reference account: 802 movies), because the classifier lumped Japanese anime in
with Western kids cartoons. Product intent: anime is a distinct audience and belongs in the
Adult Animation rail.

**Change:** a new `ANIME_MARKERS = [anime, manga, انمي, مانجا]` signal. Anime/manga wording
(`anime`; `animé/animée/animés` all normalise to contain `anime`; `manga`) → `animation_adult`;
general/Western animation that only shares the `anim…` stem (`animation`, `animación`,
`animação`, `animazione`, `cartoon`, `dessin`, `DreamWorks`…) stays `animation_kids`. An explicit
kids marker still wins (kids anime → Kids). Applied to **all three** classifier ports that must
agree — `_shared/genre-taxonomy.ts`, `public/js/utils/GenreTaxonomy.js`, and the SQL
`norva_classify_buckets` (migration `20260705100000`) — with new parity fixtures in
`tests/genre-taxonomy-parity`.

Existing rows were re-classified in place (scoped to anime-category rows, ~5,618 updated across
all users) and the facet summaries refreshed. Verified live (reference account):

| bucket | movies before | movies after |
|---|---|---|
| animation_kids | 802 | 289 |
| animation_adult | 0 | 513 |

Series similarly: adult 989 / kids 208. `GenreTaxonomy.js` cache-buster bumped `?v=3 → ?v=4`
so browsers pick up the mirrored change.
