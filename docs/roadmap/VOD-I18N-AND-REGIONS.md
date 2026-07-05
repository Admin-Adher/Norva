# VOD synopsis i18n + region/country catalogue — audit & redesign

_Last updated: 2026-07-05. Status: **Phases 1–2 shipped** (#167 region model + picker, #168
resolved synopsis language + cache lang-keying); Phases 3–5 (edge i18n population) next._

Goal: make the three "Your taste & recommendations" options — **Your region**, **Preferred
audio language**, **Preferred subtitle language** — drive the language of VOD **synopses**
(movies, series, and **episodes**) coherently and premium-grade, and massively expand the
**country** catalogue. This doc first pins the **real** current architecture (no
approximation), then lays out the design space.

---

## Part A — Current architecture (verified)

### A.1 The three preferences today

| Pref | Defined / normalised | What it drives today | Touches synopsis? |
|------|----------------------|----------------------|-------------------|
| **Region** | `CONTENT_REGIONS` hard-coded in `public/js/cloudApi.js` — **6 entries**: `FR, US, IN, MAGHREB, LUSOPHONE, INTERNATIONAL`. Dropdown in `public/app.html`. | Live TV order, logos, categories, recommendation ordering. | **No.** |
| **Preferred audio language** | `normalizeContentPreferences` → `preferredAudioLanguage` (`mediaUtils.js`). | Default **version pick** (`orderVersionsByPreference`) + the "Best for my languages" sort (`scoreVersionLanguage` / `analyzeLanguageCompatibility`). | **No.** |
| **Preferred subtitle language** | → `preferredSubtitleLanguage`. | Same as audio (sort + default pick nudge). | **No.** |

**Key gap:** none of the three prefs currently affect which **language** a synopsis is shown
in. Synopsis language is a *separate* "display language" (`?lang=`, see A.2), decoupled from
these prefs and limited to **fr/en**.

### A.2 Synopsis storage & serving (movies + series)

There is **no dedicated `overview`/`plot` column**. Synopses live in JSONB:

- **Canonical**: `cloud_titles.metadata.tmdb.overview` — one enrichment locale.
- **Per-language override (already exists!)**: `cloud_titles.metadata.i18n[lang] = { title,
  overview }`. The bones of multi-language are already in the schema.
- **Global cache**: `catalog_titles` (behind `NORVA_CATALOG_READ_SOURCE=catalog_titles`) —
  same metadata incl. `i18n`, shared across users (the ÷10–100 storage/enrichment win).
- **Serving** (`norva-catalog` `titleRailItem(title, variants, lang)`):
  ```
  loc            = metadata.i18n[lang]              // lang = ?lang= (validated 2-letter), null → default
  displayTitle   = loc.title    ?? title.title
  displayOverview = loc.overview ?? (tmdb.overview ?? metadata.overview)
  ```
- **Enrichment locale**: `norva-catalog` fetches TMDB with
  `language: lang2 === "fr" ? "fr-FR" : "en-US"` — **only two locales**. Initial sync
  (`norva-source-sync`) uses `NORVA_TMDB_LANGUAGE`, default `en-US`.
- **Rendering** (frontend): movie `displayMovie.tmdb?.overview || .overview || .description
  || .plot`; series `series.tmdb?.overview || …`.

### A.3 Episodes

- **Not stored** — there is **no episodes table** (only `enrichment_*`). Episodes are fetched
  **live** per season via `norva-catalog getSeasonEpisodes` (TMDB, `fr-FR`/`en-US`) merged
  with **provider** episode plots (series-info gateway).
- Rendering: `ep.plot || ep.info?.plot || ep.overview`; a missing plot is filled from TMDB
  (`te.overview`) **without** overwriting a real provider description.
- **Coherence risk**: the series overview comes from `cloud_titles.i18n` (one path) while the
  episode overviews come from a **live TMDB fetch** in a possibly-different locale → series
  and episodes can end up in different languages.

### A.4 Country / region catalogue

- **6 hard-coded** regions in `cloudApi.js`; a mix of countries (`FR/US/IN`) and market
  bundles (`MAGHREB/LUSOPHONE/INTERNATIONAL`). No ISO normalisation, no per-region **default
  language**, no localized names, no flags, no link to the synopsis-language chain.

### A.5 Summary of gaps

1. Synopsis language is **not** derived from the 3 prefs; it's a separate fr/en toggle.
2. Only **2 locales** enriched, though `metadata.i18n` can hold any language.
3. **No priority / fallback chain** for choosing a synopsis language.
4. **Series ↔ episode** synopsis languages can diverge (two different code paths).
5. Country list is **tiny (6)**, un-normalised, and not tied to language.

---

## Part B — Redesign space (brainstorm)

### B.1 Synopsis-language resolution — the priority chain

A synopsis is **read**, so the natural primary driver is the **subtitle** preference, then
audio, then region. Proposed resolved order (first non-empty wins):

```
resolvedContentLang =
     preferredSubtitleLanguage        // what you choose to READ
  ?? preferredAudioLanguage           // what you choose to HEAR
  ?? region.defaultLanguage           // e.g. FR→fr, US→en, MAGHREB→ar
  ?? title.original_language          // authentic
  ?? 'en'                             // universal floor
```

Alternatives to weigh: (a) a dedicated explicit "synopsis/interface language" pref that
defaults from region (clearer, one more control); (b) region-first (region as the master
locale). **Open decision #1.**

### B.2 Fallback when a translation is absent

Per title, resolve the overview by walking: `i18n[resolvedLang] → i18n[original_language] →
i18n['en'] → tmdb.overview → provider plot → "No summary available yet."` Never blank when
any text exists. Same chain for series and episodes.

### B.3 Series ↔ episode coherence

Both must resolve through the **same** `resolvedContentLang`. Episode overviews fetched (and
cached) in that language, not a hard-coded fr/en. **Open decision #3** covers whether to
cache episode i18n (new lightweight store) or keep live-fetch with the resolved lang.

### B.4 Population strategy (where translations come from)

- **On-demand lazy (recommended)**: when a user at `lang=X` opens a title lacking
  `i18n[X]`, fetch the TMDB overview in X once and write it to the **global** `catalog_titles`
  (deduped, rate-limited) so every user benefits. Scales with real demand, not catalogue size.
- **Pre-enrich top-N languages**: batch-fill the most-used languages for all titles.
  Predictable UX, heavy TMDB cost + storage. Could target only popular titles.
- Likely answer: **lazy on-demand into the global cache**, optionally pre-warming the top few
  languages for trending titles. **Open decision #3.**

### B.5 Storage & scale

- `metadata.i18n` already generalises to arbitrary languages — no schema change needed for
  titles. Episodes would need a small per-(title, season, lang) cache if we cache them.
- Writes go to the **global** `catalog_titles`, keeping it one-fetch-serves-all.
- TMDB rate/limits → a coalescing fetch + a `i18n_attempted_at`-style guard (mirrors the
  existing `*_attempted_at` enrichment pattern) to avoid re-fetching known-missing locales.

### B.6 Country catalogue expansion

Replace the 6 hard-coded regions with a **normalised country model**:

```
{ code: 'PT',                       // ISO 3166-1 alpha-2
  name: 'Portugal',                 // localized display
  flag: '🇵🇹',
  tmdbRegion: 'PT',                 // TMDB region param
  languages: ['pt'],                // associated content languages
  defaultLanguage: 'pt' }           // feeds B.1
```

- Drive the dropdown + the region→default-language link + TMDB region from **one data table**
  (`public/js/data/countries.js` or similar), searchable in the UI.
- Decide the scope: **full ISO-3166 (~200)** vs a **curated premium subset (~40 top IPTV
  markets)**; and whether to keep the **market bundles** (Maghreb, Lusophone, Nordic,
  International) as pseudo-regions alongside real countries. **Open decision #2.**
- Maintainability: a single generated table (codes, names, flags, languages) with a
  normaliser that accepts legacy values (`FR`, `INTERNATIONAL`) so no stored preference
  breaks.

---

## Open decisions (to settle before building)

1. **Synopsis-language driver** — subtitle-first chain (B.1), audio-first, a dedicated
   explicit pref, or region-first?
2. **Country model** — full ISO-3166 (~200) vs curated premium subset (~40); keep the market
   bundles or not; grouped vs searchable dropdown.
3. **Translation population** — lazy on-demand into the global cache (recommended) vs
   pre-enrich top-N languages; and whether to cache episode i18n or live-fetch in the
   resolved language.

---

## Part C — Resolved decisions & finalised architecture (2026-07-05)

**Decisions:** (1) synopsis language = **subtitle → audio → region → device locale → EN**
(best global default; a synopsis is read, and audio="Original" isn't a readable language);
(2) country model = **curated ~40 ISO-3166 countries + kept market bundles**; (3) population
= **hybrid** (lazy on-demand into the global cache + pre-warm of trending titles).

### C.1 Resolved content language

```
resolveContentLang(prefs, title, deviceLocale):
  1. prefs.preferredSubtitleLanguage        // concrete lang, not 'none'
  2. prefs.preferredAudioLanguage            // concrete lang, not 'original'/'none'
  3. region.defaultLanguage                  // FR→fr, US→en, MAGHREB→ar, LUSOPHONE→pt, INTERNATIONAL→en
  4. deviceLocale                            // navigator.language, 2-letter
  5. 'en'
```
Per-title availability fallback when serving (readability-first):
```
overview = i18n[resolvedLang] ?? i18n['en'] ?? i18n[originalLang] ?? tmdb.overview ?? providerPlot ?? null
```

### C.2 Country model — `public/js/data/regions.js`

One data table drives the dropdown, the TMDB region, and the region→language link:
```
{ code:'FR', name:'France', flag:'🇫🇷', tmdbRegion:'FR', languages:['fr'], defaultLanguage:'fr', kind:'country' }
{ code:'MAGHREB', name:'Maghreb', flag:'🌍', languages:['ar','fr'], defaultLanguage:'ar', kind:'bundle' }
```
~40 countries + the 4 bundles (Maghreb, Lusophone, Nordic, International). A normaliser
accepts legacy stored values (`FR`, `INTERNATIONAL`) so no saved preference breaks. Dropdown:
searchable, countries first, bundles grouped at the bottom.

### C.3 Population — hybrid

- **On-demand**: `norva-catalog`, when `i18n[resolvedLang]` is missing for a served title,
  lazily fetches the TMDB overview in that language and writes it to the **global**
  `catalog_titles.metadata.i18n[lang]` (deduped by an `i18n_attempted` guard, rate-limited).
- **Pre-warm**: a cron enriches the top ~500 trending titles × `{fr,en,es,ar,pt}` so popular
  fiches are already translated.

### C.4 Series ↔ episode coherence

Series and episode overviews both resolve through the **same** `resolvedContentLang`.
`getSeasonEpisodes` fetches in `resolvedLang` (not the hard-coded fr/en). v1 keeps the live
episode fetch (coherent with the series); an episode-i18n cache is a later optimisation.

### C.5 Phased implementation

| Phase | Scope | Surface | Risk | Status |
|-------|-------|---------|------|--------|
| **1** | `regions.js` (curated + bundles) + normaliser + searchable dropdown + region→defaultLanguage | Frontend | Low | ✅ **shipped (#167)** |
| **2** | `resolveContentLang` chain; propagate `?lang=` to all catalog fetches | Frontend | Low | ✅ **shipped (#168)** |
| **3** | `norva-catalog`: generalise serving locale (any lang, not fr/en) + lazy on-demand i18n → global cache | Edge | Med | ✅ **shipped (#169)** |
| **4** | Pre-warm cron (trending × top langs) + `i18n_attempted` guard | Edge + cron | Med | — |
| **5** | Episode-i18n cache (coherence itself landed in #169) | Edge | Low | — |

No titles schema change (`metadata.i18n` is already language-flexible); Phase 4 may add a
lightweight `i18n_attempted` guard.

### C.6 Phase 2 — as shipped (#168)

The resolution is a single pure helper, so the whole chain is one testable function and every
catalog fetch inherits it through the existing `?lang=` param.

- **`MediaUtils.resolveContentLanguage({ subtitle, audio, regionLang, locale })`** — pure,
  6 unit tests. `subtitle → audio → regionLang → locale → 'en'`, coercing each to a 2-letter
  ISO code and skipping the sentinels (`''`, `'none'`, `'original'` — the latter is not a
  readable language).
- **`cloudApi.resolveLang()`** now gathers the inputs and calls it: subtitle/audio prefs from
  the `localStorage['norva-cloud-settings']` mirror (kept fresh by `API.settings.get()` and
  the PUT handler), `regionLang` from `NorvaRegions.defaultLanguage(resolvedRegion)`, `locale`
  from `navigator.language`. It's exposed as `NorvaCloud.contentLanguage()`. Both catalog
  routes (`catalogRequest` / `catalogMutate`) already send `lang: resolveLang()`, so nothing
  else had to change to propagate it.
- **Cache correctness** — the resolved `lang` is folded into **both** cache layers:
  - the four in-memory maps (`mediaCache`, `pageCache`, `liveCatalogCache`, `homeRailCache`);
  - the persistent localStorage stale-while-revalidate cache (`NorvaCatalogCache`), whose
    per-page keys (`movies:default`, `series:default`, `home-dashboard:<pid>`) are now
    lang-scoped — otherwise a cold launch would first-paint the previous language.
  Changing the audio/subtitle preference also calls `API.media.clearCatalogCaches()`. The
  adversarial review caught two real bugs here: that persistent cache was **not** lang-keyed,
  and the exposed `clearCatalogCaches`/`clearRailCache` were **dead no-ops** (their bodies
  referenced IIFE-internal caches from file scope → swallowed `ReferenceError`) — both fixed.
- **Legacy prefs** — `resolveLang` routes the stored settings through
  `normalizeContentPreferences`, so a user who only set the old single `preferredLanguage`
  (before the audio/subtitle split) is still honoured.
- **Phase 2 makes the request ask for the right language; Phase 3 makes the answer exist and
  serves it.** (See C.7 for the reality check that reshaped Phase 3.)

### C.7 Phase 3 — as shipped (#169)

**Reality check first (grounded in the live DB, per the no-approximation rule).** The naive
plan was "generalise enrichment to fetch each language." The database says otherwise:

- `catalog_titles` = **90,539** rows; **39,017** already carry a **multi-language** `i18n`
  map — not fr/en, but **40+ languages** (`ar` 10,967 · `es` 24,663 · `pt` 23,255 · `zh`
  25,295 · `ko`, `ja`, `hi`, `fa`, `th`, `vi`…). The enrichment's `validateTmdbCandidate`
  already pulls **all** TMDB `translations` in one call, so the write side was *never*
  fr/en-limited. Median enriched title ≈ 15–20 languages.
- `cloud_titles` (the per-user default read source) holds **zero** i18n across all 574,998
  rows. Every localized synopsis lives **only** in `catalog_titles`. So the feature is dark
  unless `NORVA_CATALOG_READ_SOURCE=catalog_titles` overlays it (`applyCatalogOverlay`).

So Phase 3's real gaps were **(a)** the *serving* path still hard-coded `fr-FR : en-US`, and
**(b)** ~57% of titles (and specific missing langs on enriched ones) have no `i18n` yet.

**What shipped:**

1. **Generalised serving locale.** `tmdbLocale(lang2)` maps any validated 2-letter code to
   TMDB's best locale (bare ISO-639-1 for the long tail; `en-US`/`fr-FR`/`pt-BR`/`zh-CN`
   explicit). It replaces the `fr-FR : en-US` ternary in **`getTmdbMeta`** (movie/series live
   extras) and **`getTmdbEpisodes`** (per-season episode data). fr/en users are byte-identical;
   every other language now gets its own localized episode names/overviews, air dates and
   video-language trailers instead of English. This is the **immediate** win — it's a live
   TMDB proxy, *not* gated on the read-source flag.
2. **On-demand i18n population into the global cache.** `getTmdbMeta` already fetches the title
   from TMDB in the user's language; `persistCatalogI18n` piggybacks that response and, when
   TMDB returned a genuinely localized overview, writes the **overview** into
   `catalog_titles.metadata.i18n[lang]` via the new **`catalog_upsert_i18n`** RPC. So the
   titles users actually open get translated on real demand, once, for **everyone**.
   - **No poisoning**: TMDB returns an *empty* overview when a translation is absent (it never
     English-fills the `overview` field), so population is gated on a **non-empty overview** —
     a reliable "this translation genuinely exists" signal. Only the overview is stored: TMDB's
     `title` *silently* falls back to the original when a localized title is missing, so
     persisting it could file an English title under `i18n[lang]`. `displayTitle` already falls
     back to the base title, and the enrichment's full `translations` pull stays the
     authoritative source for genuinely localized titles.
   - **Idempotent + cheap**: the RPC matches the `(item_type, provider_tmdb_id)` **primary
     key** (single index probe) and fills `i18n[lang]` **only when absent** — never clobbers
     the authoritative translations. Naturally rate-limited by the 1-day CDN cache + the
     in-memory `tmdbMetaCache`; the write is bounded (≤1.5 s) so it never blocks the fiche.
3. **Series ↔ episode coherence (C.4).** `SeriesPage.enrichSeasonWithTmdb` used to compute its
   own legacy `preferredLanguage`, which *overrode* the resolved `?lang=`. Removed — episodes
   now inherit `cloudApi.resolveLang()`, the **same** chain the series overview uses, so a
   fiche and its episodes are always in one language.

**Visibility / rollout notes:**

- **#1 (serving locale)** takes effect the moment the edge deploys — no flag, no backfill.
- **#2 (on-demand i18n)** writes to the global cache immediately, but the localized synopsis
  only *appears* in rails/detail once `NORVA_CATALOG_READ_SOURCE=catalog_titles` is on (the
  read cutover is separately gated on `/catalog-mirror-verify` staying clean). Until then it
  silently warms the cache on real-demand titles so the flip lands already-populated.
- **Rollout order**: apply the `catalog_upsert_i18n` migration **before/with** the edge deploy.
  DDL isn't auto-applied (deliberate, reviewed step); the edge RPC call is best-effort, so a
  deploy that lands ahead of the migration degrades to a silent no-op, not an error.
- **Deferred to Phase 4/5**: a persistent `i18n_attempted` negative-cache guard (today the CDN
  + in-memory caches suffice) and an optional per-(title, season, lang) **episode** i18n store
  (episodes are live-fetched coherently for now).
