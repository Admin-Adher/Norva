# VOD synopsis i18n + region/country catalogue — audit & redesign

_Last updated: 2026-07-05. Status: **architecture verified against live code + DB**; redesign
is an open brainstorm (decisions pending)._

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
