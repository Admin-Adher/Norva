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

**Gate status (2026-06-26 — Phase 1 COMPLETE, all gates shipped):** the read-flip is
live (`NORVA_CATALOG_READ_SOURCE=catalog_titles`) and the write path now **thins
itself in pure SQL** — no edge-function rewrite was needed. `cloud_titles.metadata`
holds heavy title metadata for **0 tmdb-matched rows**; it lives **once** in
`catalog_titles` and is served back by `applyCatalogOverlay`. **Measured result:
cloud_titles 58 MB → 22 MB, DB 288 MB → 238 MB (−50 MB / −17%), with 100% of
`genre_category` preserved.**

| Step | Action | Status / reversibility |
|---|---|---|
| 1.1 ✅ | **Global mirror.** Statement-level AFTER INSERT/UPDATE trigger on `cloud_titles` mirrors metadata → `catalog_titles`. Migration `20260625120000`. | ✅ done |
| 1.2 ✅ | **Reconcile** + **1.3 ✅ mirror clean** (`catalog_mirror_diff()` all 0). | ✅ done |
| 1.4 ✅ | **Read-flip** `NORVA_CATALOG_READ_SOURCE=catalog_titles` on `norva-catalog` (Gate 0). | ✅ unset to roll back |
| 2A ✅ | **Genre trigger → preserve-unless-present** (`20260626083903`). Each denormalised genre column updates only when its source key is in the new metadata, else preserved — so thinning + the revalidate/search-match accumulators never wipe `genre_category`/`genre_payload` (the per-user, non-overlaid `cloud_genre_summary` keys). | ✅ re-derive from metadata |
| 2B ✅ | **Self-thinning mirror trigger** (`20260626085352`). After mirroring, replaces `cloud_titles.metadata` with `'{}'`. `pg_trigger_depth()=1` + heavy-content + EXISTS-on-catalog guards make it recursion-terminating and gap-safe. **No TS rewrite** — supersedes the old 1.5/1.6 plan; the metadata columns are **kept** (reversible) rather than dropped. | ✅ revert to mirror-only + re-project |
| 3 ✅ | **One-time backfill + VACUUM FULL.** Thinned 32,947 mirrored valid-tmdb rows to `'{}'`; `VACUUM FULL` on `cloud_titles` + `catalog_titles` via temporary pg_cron jobs (VACUUM can't run inside `execute_sql`'s txn). | ✅ re-project from cache |

**Why pure-SQL instead of the original 1.5/1.6 (TS rewrite + drop columns):** lower
risk (no untestable edge-function change; the trigger logic was validated on a
synthetic row before touching live data — the test caught both a NOT-NULL violation
and a statement-trigger recursion bug), and **reversible** — the columns stay, so the
flip is not a one-way door.

**Validation before backfill (synthetic row):** full-metadata write → cloud thinned to
`{}`, catalog keeps full metadata, genre cols derived; accumulator rewrite (no
`categoryName`) → `genre_category` **preserved**, `genre_payload` refreshed; no
stack-depth (recursion terminates at depth 2).

### Rollback runbook (Gate 3 is reversible)
The full metadata lives in `catalog_titles` (the superset). To un-thin:
1. Revert the mirror trigger to **mirror-only** (re-apply `cloud_titles_mirror_to_catalog()`
   without step 2) so the refill is not immediately re-thinned.
2. `update public.cloud_titles ct set metadata = c.metadata from public.catalog_titles c
   where c.item_type=ct.item_type and c.provider_tmdb_id=ct.provider_tmdb_id
   and ct.metadata='{}'::jsonb and c.metadata <> '{}'::jsonb;`
3. (optional) unset `NORVA_CATALOG_READ_SOURCE` → per-user reads again.

**Flag dependency:** thinning relies on the read-flip being ON (overlay refills metadata).
If a title ever renders with no overview/i18n, the flag is off — set it or run the
re-project above. All thinned rows were EXISTS-guarded against `catalog_titles`, so the
cache can always serve them.

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
