# Dedup → global-per-provider catalogue — phased execution plan + costing

Status: **2026-06-25 — planned.** Companion to
[`global-title-cache-design.md`](./global-title-cache-design.md) (the Phase-1
schema spec) and [`scaling-status.md`](./scaling-status.md) (live state). This
doc is the **execution plan + costing** for making catalogue storage scale with
*providers/content* instead of *users*, so the app is ready for worldwide
multi-provider before onboarding at scale.

## Why (the measured problem)

Catalogue rows are stored **per user**. Measured duplication (2 accounts, same
provider apdxes.xyz):

| Table | rows | distinct items | dup factor |
|---|---|---|---|
| `cloud_media_items` | 81 141 | 40 425 | **2.01** |
| `cloud_titles` | 37 672 | 19 199 | **1.96** |
| `cloud_title_variants` | 55 334 | 27 653 | **2.00** |

**dup factor = number of users.** Storage is **O(users × catalogue)** — linear in
users. Projection (same provider): ~100 users ≈ 13 GB (blows Pro's 8 GB), 10 000
users ≈ 1.3 TB. **Supabase Pro does not fix this** — it only buys runway; the
O(users × catalogue) growth eventually blows Pro too. The structural fix is
needed regardless of plan.

## Already built (WS1-3 — ~60% of Phase 1)

- `catalog_titles` **global** (PK `(item_type, provider_tmdb_id)`, no `user_id`),
  **dual-written** on every VOD sync — `_shared/vod-title-projection.ts:252`.
- **Read cutover** wired behind flag `NORVA_CATALOG_READ_SOURCE` (env var on the
  `norva-catalog` function, default `cloud_titles` = OFF). When `catalog_titles`,
  `applyCatalogOverlay` (`norva-catalog/index.ts:1186`) overwrites display
  metadata on every rail/grid — `:547`, `:765`, `:932`, `:1130`, plus
  `localizeMediaTitles` `:240`.
- **Mirror-verify harness** — `POST norva-playback/catalog-mirror-verify` → RPC
  `catalog_mirror_diff` (migration `20260624020000`). Reported clean.
- `catalog_file_tracks` **global** (file-level audio/sub, keyed
  `(server_host, item_type, external_id)`); `audio_languages` folded global via
  `merge_catalog_title_audio`.
- **Playback is already title-metadata-independent**: `resolvePlaybackTarget`
  (`norva-playback/index.ts:988`) reads only `cloud_media_items.playback_hint`
  (+`metadata` codec fallback) and the user's `cloud_sources` creds. The only
  irreducibly per-user input at playback is the **encrypted source credentials**.

---

## Phase 1 — Title-metadata dedup (finish WS1-3) · risk MEDIUM · ~1.5-2 sessions

**Target:** `catalog_titles` holds all heavy metadata (title/i18n/tmdb/poster/
genres) **once per tmdb id**; `cloud_titles` becomes a thin per-user link
(`user_id, identity_key, provider_tmdb_id, match_status, default_variant_id,
variant_count, audio_languages`).

**Gate status (2026-06-25):** mirror-verify is **NOT clean** — 16 046 compared,
per-field mismatches `title 185, original_title 27, release_year 106, poster 24,
backdrop 213, i18n 209, tmdb 210`, `cloud_only 0`, `catalog_only 724`. **Cause:**
the enrichment crons `UPDATE cloud_titles` per-user only — never `catalog_titles`
— so the global copy drifts after each re-enrichment. ⇒ **global enrichment
(step 1.1 below) is the real prerequisite; the flip is gated on it.** (The "0
mismatch" in the design doc was true at sync time, before cron drift.)

| Step | Action | Reversible |
|---|---|---|
| 1.1 | **Global enrichment (the real first step)**: make the 3 crons (`/cron/search-match`, `/cron/revalidate`, `/cron/backfill-years`) + `audio-backfill` **also write `catalog_titles` by tmdb id** (drop the hardcoded `userId` → global). Stops the drift. | ✅ (background only) |
| 1.2 | **Reconcile** the existing drift: one-shot re-upsert `catalog_titles` from `distinct on (item_type, provider_tmdb_id)` of `cloud_titles` (same logic as the foundation backfill). | ✅ |
| 1.3 | `catalog-mirror-verify` **clean** over a window (all `*_mismatch = 0`, `cloud_only = 0`) — the gate. | — |
| 1.4 | **Flip** `NORVA_CATALOG_READ_SOURCE=catalog_titles` on `norva-catalog`. | ✅ unset (instant) |
| 1.5 | `refreshVodTitleProjection`: stop writing metadata into `cloud_titles` (keep the link); metadata only into `catalog_titles`. Move the genre trigger onto `catalog_titles`. | ✅ while columns exist |
| 1.6 | **Drop** the metadata columns from `cloud_titles` + remove the per-user read fallback. | ⚠️ irreversible → last |

**Rewrite:** enrichment crons = the real work (go global — this is what keeps the
mirror clean); reads already handled (overlay); sync stops duplicating.
**Risk:** medium; the flip (1.4) rolls back via one secret; 1.6 is irreversible →
only after the flip is stable.
**Gain:** kills the N× metadata duplication (i18n alone is several KB/title). At
100 users / same provider: metadata **~17 MB (1×)** vs **~1.7 GB (100×)**.

## Phase 2 — Raw catalogue + variants dedup (per-provider) · risk HIGHER · ~2-3 sessions

*(Not in the original spec — the remaining structural piece, touches playback.)*

**Target:** `cloud_media_items` (raw) + `cloud_title_variants` become **global per
provider**. `playback_hint` is provider-derived (not user-derived — confirmed),
so it globalises to the `catalog_file_tracks` shape `(server_host, item_type,
external_id)`. Per-user keeps only `source→provider`, **availability**,
favorites/history, and the (already per-user) creds.

**Rewrite:** sync writes the raw catalogue globally; `resolvePlaybackTarget` reads
`playback_hint` from the **global** store (not per-user `cloud_media_items`) +
per-user creds. Titles with no tmdb (`norm:`/`imdb:` identity) stay per-user.
**Risk:** higher — touches the **playback** path (critical) → behind its own flag
+ a dedicated mirror-verify, like Phase 1.
**Gain:** removes the last big duplication. At 100 users: raw+variants
**~70 MB (1×)** vs **~7 GB (100×)**.

---

## Tests & guardrails (cross-cutting)

- **Mirror-verify** (exists) → extend per phase (titles ✅, then raw). Flip only
  when `clean: true` over a window.
- **Everything behind a flag** → instant rollback via env var (model:
  `NORVA_CATALOG_READ_SOURCE`).
- **Test with 2+ accounts on the same provider** (real overlap) in staging before
  each flip.
- Carried guardrails: `provider_tmdb_id='0'` sentinel never keyed/joined; parsed
  years capped `[1900, current_year+1]`; identity without tmdb stays per-user.

## Gain projection

| Scenario | Today — O(users × catalogue) | After Ph.1+2 — O(providers × catalogue) |
|---|---|---|
| 2 users | 273 MB | ~250 MB *(≈0 gain — one catalogue)* |
| **100 users / same provider** | **~13 GB → Pro blown** | **~few hundred MB** |
| 10 000 users | ~1.3 TB | ~1× catalogue + thin refs |
| New user of an existing provider | + the whole catalogue | **+ ~nothing** |

## Timing (important)

With **one** catalogue today the saving is **~0%** (measured) — the benefit only
lands with **real multi-user / multi-provider overlap**. So do this **before
scaling**, while it's quiet and reversible. Phase 1 is ready (flip + global
crons); Phase 2 is the real build to land before mass onboarding.

**Total ≈ 4-5 sessions**, staged, each testable + reversible behind a flag.

## Phase-1 flip runbook (the low-risk, already-built step)

1. Confirm mirror clean: `select * from catalog_mirror_diff(...)` (or
   `POST norva-playback/catalog-mirror-verify`, bearer `NORVA_BACKFILL_TOKEN`).
2. `supabase secrets set NORVA_CATALOG_READ_SOURCE=catalog_titles --project-ref oupsceccxsonaalhueff`
   (function-scoped: `norva-catalog` is the only reader).
3. Verify: load Home/Movies/Series — rails still render (now served from
   `catalog_titles` overlay). Re-run mirror-verify.
4. Rollback if needed: unset the secret (or set `cloud_titles`) → instant
   fallback to per-user reads.
