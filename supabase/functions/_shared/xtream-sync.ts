// ─────────────────────────────────────────────────────────────────────────────
// Canonical Xtream sync engine (single source of truth).
//
// Extracted VERBATIM from norva-source-sync/index.ts — the canonical engine with
// Layer 3 (upsert-then-prune), the change-detection signature, providerKey, and
// the RPC-based batched delete. Both norva-source-sync and norva-cloud import the
// engine from here so the complex catalogue-sync logic lives in ONE place (editing
// one copy and forgetting the other is exactly what left Layer 3 dormant on the
// add-provider path).
//
// SELF-CONTAINED: this module carries its OWN private copies of every util,
// provider-helper, type and constant the engine needs, and imports ONLY from
// npm:@supabase/supabase-js@2. The self-invoke endpoints are HARD-CODED to
// norva-source-sync (which owns finalize + the watchdog), so the module needs no
// functionName parameter and the watchdog covers syncs kicked from either function.
//
// Public exports include the direct-sync engine, its cinema-first walk helper,
// change detection, and the generation-staging engine used by credential swaps.
// Everything else is private to this module.
// ─────────────────────────────────────────────────────────────────────────────
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  formatSourceSyncError,
  isTerminalSourceSyncStatus,
} from "./source-sync-error.mjs";
import {
  assertActiveCatalogGenerationCurrent,
  type ActiveCatalogGeneration,
  type BuildingCatalogGeneration,
  catalogGenerationFields,
  catalogGenerationRpcFence,
  isCatalogGenerationSuperseded,
  readActiveCatalogGenerationSnapshot,
  withCatalogGenerationRows,
} from "./catalog-generation.ts";
import { materializeLiveChunk } from "./live-materialization.ts";
import type { LiveCatalogItem } from "./live-catalog.ts";
import {
  projectVodTitleGenerationIsolated,
  refreshVodTitleProjection,
} from "./vod-title-projection.ts";
import {
  buildProviderDirectFallbackSnapshot,
  createSourceDirectFallbackLeaseRunner,
  ProviderDirectFallbackLeaseError,
} from "./provider-direct-fallback-lease.mjs";
import {
  BoundedProviderResponseError,
  fetchBoundedProviderJson,
} from "./bounded-provider-response.mjs";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = { sourceConfigKey: string; mediaGatewayUrl: string; mediaGatewayToken: string };
type CatalogAccessSnapshot = ActiveCatalogGeneration;
type DirectFallbackLeaseContext = {
  runDirectFallback: <T>(timeoutMs: number, operation: () => Promise<T>) => Promise<T>;
};

class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const encoder = new TextEncoder();

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";
const ENV_MEDIA_GATEWAY_URL = (Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "").replace(/\/+$/, "");
const ENV_MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;

type DiscoveryType = "live" | "movie" | "series";
type DiscoveryTarget = {
  type: DiscoveryType;
  action: string;
  params?: Record<string, string>;
};

// v1 cursors are already persisted in production. Their numeric typeIdx must
// keep its historical meaning until the in-flight walk completes.
const LEGACY_DISCOVER_TYPES: { type: DiscoveryType; action: string }[] = [
  { type: "live", action: "get_live_streams" },
  { type: "movie", action: "get_vod_streams" },
  { type: "series", action: "get_series" },
];
const CINEMA_DISCOVER_TYPES: Record<DiscoveryType, { type: DiscoveryType; action: string }> = {
  movie: { type: "movie", action: "get_vod_streams" },
  series: { type: "series", action: "get_series" },
  live: { type: "live", action: "get_live_streams" },
};
// The media gateway deliberately allows only one metadata operation per provider
// account. Keep the per-source walk serial so Norva never creates its own
// `background_busy` storm and mistakes rejected categories for empty ones.
const DISCOVER_CONCURRENCY = 1;
const GATEWAY_BUSY_RETRY_DELAYS_MS = [250, 750, 1500];
// Work budget per isolate. Kept well under the runtime's background wall-clock so
// the self-invoke (which spawns the next isolate) always lands before recycle.
const SYNC_DRIVE_BUDGET_MS = 90_000;
const SYNC_MAX_CONTINUATIONS = 160;
// Layer 3 prune safety: a healthy refresh removes only a few vanished titles. If a completed run
// would delete more than this fraction of the catalogue, treat the discovery as untrustworthy
// (provider outage / soft-expiry returning a thin list) and KEEP the prior items instead.
const PRUNE_MAX_REMOVE_FRACTION = 0.5;

async function readCatalogAccessSnapshot(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  changedDuringOperation: boolean,
): Promise<CatalogAccessSnapshot> {
  try {
    return await readActiveCatalogGenerationSnapshot(db, sourceId, userId);
  } catch (error) {
    throw new HttpError(409, changedDuringOperation
      ? "Catalog access changed while catalog discovery was running"
      : "This catalog is not currently available", {
      code: changedDuringOperation ? "SOURCE_CATALOG_CHANGED" : "SOURCE_CATALOG_NOT_VISIBLE",
      cause: isCatalogGenerationSuperseded(error) ? "generation_superseded" : "snapshot_unavailable",
    });
  }
}

async function assertCatalogSnapshotCurrent(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  expected: CatalogAccessSnapshot,
): Promise<void> {
  try {
    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, expected);
  } catch (_) {
    throw new HttpError(409, "Catalog access changed while catalog discovery was running", {
      code: "SOURCE_CATALOG_CHANGED",
    });
  }
}

function isCatalogAccessGuardError(error: unknown): boolean {
  if (isCatalogGenerationSuperseded(error)) return true;
  if (!(error instanceof HttpError) || !isRecord(error.details)) return false;
  return [
    "SOURCE_CATALOG_NOT_VISIBLE",
    "SOURCE_CATALOG_CHANGED",
    "CATALOG_VISIBILITY_UNAVAILABLE",
  ].includes(stringOr(error.details.code, ""));
}

// Import-lifecycle notification queue (Phase 1). The engine only ENQUEUES events here; a separate
// digest cron groups + sends them. unique(source_id, kind) is the idempotency guard, so even though
// the engine self-invokes across dozens of isolates this fires exactly once per source per kind —
// which also makes started/completed FIRST-IMPORT-ONLY (a later refresh's insert is a no-op). Always
// best-effort: a notification must never fail a sync.
export async function enqueueImportNotification(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  kind: "import_started" | "import_completed" | "import_failed",
  payload: JsonRecord = {},
): Promise<void> {
  try {
    // A replacement candidate is intentionally imported while hidden. Import
    // lifecycle mail/push/admin-feed rows are user-facing, so do not enqueue
    // them until the source is the active visible catalog. Treat a visibility
    // lookup failure as hidden (fail closed); notification loss is safer than
    // leaking staging activity and the sync itself must remain best-effort.
    const { data: catalogVisible, error: visibilityError } = await db.rpc(
      "norva_source_catalog_visible",
      { p_source_id: sourceId, p_user_id: userId },
    );
    if (visibilityError || catalogVisible !== true) return;

    // .select() → ignoreDuplicates returns ONLY newly-inserted rows (DO NOTHING doesn't return
    // conflicts), so we can mirror this exact-once lifecycle event into the admin CRM timeline
    // without duplicating it across the engine's self-invocations.
    const { data: ins } = await db.from("cloud_import_notifications")
      .upsert([{ user_id: userId, source_id: sourceId, kind, payload }], { onConflict: "source_id,kind", ignoreDuplicates: true })
      .select("id");
    if (ins && ins.length) {
      try {
        const summary = kind === "import_started" ? "Import démarré"
          : kind === "import_completed" ? "Import terminé" : "Import échoué";
        const evKind = kind === "import_failed" ? "sync_failed" : kind === "import_completed" ? "sync_done" : "sync_started";
        await db.from("admin_events").insert([{ user_id: userId, kind: evKind, summary, meta: { source_id: sourceId, ...payload }, actor: "système" }]);
      } catch (_) { /* best-effort admin timeline — never fail a sync */ }
    }
  } catch (_) { /* best-effort — never fail a sync over a notification */ }
}

// Admin-dashboard registry + canonical IDENTITY resolution. Called wherever the engine computes a
// providerKey (detect + discovery completion). The RPC keeps the providerKey -> name registry current
// (DO UPDATE only name/status/last_seen, so manual notes survive a re-add) AND resolves this source to a
// canonical provider_identity by STREAM-ID overlap — mirror-robust and taxonomy-independent, so two
// resellers of one panel (e.g. Opplex/Ferran) collapse to a single identity and a taxonomy-drift key
// change re-links instead of forking. All set math runs server-side, next to the data, under a single
// advisory lock so concurrent isolates can't mint duplicate identities. Best-effort; never blocks a sync.
export async function recordProviderIdentity(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  providerKey: string | null | undefined,
): Promise<void> {
  if (!providerKey) return;
  try {
    const { data } = await db.from("cloud_sources").select("display_name").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const name = stringOr((data as JsonRecord | null)?.display_name, providerKey);
    const { error: identityError } = await db.rpc("norva_resolve_provider_identity", {
      p_source_id: sourceId,
      p_provider_key: providerKey,
      p_display_name: name,
    });
    if (identityError) {
      console.warn("[provider-identity] resolver failed", sourceId, identityError.code ?? identityError.message);
      return;
    }
    // The resolver owns the whole lifecycle in one database transaction:
    // below 32 signals it upserts a server-only source-local candidate; at the
    // threshold it writes the verified source link and deletes that candidate
    // atomically. Never recreate the old two-step trust-boundary write here.
  } catch (_) { /* best-effort */ }
}

// Some Xtream mirrors return items whose category_id is absent from that
// mirror's categories endpoint. Reuse an unambiguous label from the exact same
// external item on another source that the server has already verified as the
// same provider identity. This is a database-only repair: it opens no provider
// connection and consumes no playback slot.
async function hydrateMirrorCategoryNames(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  generation: CatalogAccessSnapshot,
): Promise<void> {
  try {
    await Promise.all((["movie", "series"] as const).map(async (itemType) => {
      const { error } = await db.rpc("norva_hydrate_source_category_names", {
        p_source_id: sourceId,
        p_user_id: userId,
        ...catalogGenerationRpcFence(generation),
        p_item_type: itemType,
        p_limit: 2000,
      });
      if (error) {
        if (isCatalogGenerationSuperseded(error)) return;
        console.warn("[category-hydration] mirror repair failed", sourceId, itemType, error.code ?? error.message);
      }
    }));
  } catch (_) { /* best-effort */ }
}

// Category hydration is useful cleanup, never part of the sync handoff contract.
// Keep the edge isolate alive when supported; local/test runtimes safely fall
// back to a caught fire-and-forget promise.
function runCategoryHydrationInBackground(task: Promise<void>): void {
  const safe = task.catch((error) => {
    console.warn("[category-hydration] background repair failed", error instanceof Error ? error.message : error);
  });
  const runtime = (globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(safe);
}

export function freshSyncCursor(startedAt: string, extra: JsonRecord = {}): JsonRecord {
  return {
    v: 2,
    active: true,
    phase: "discover",
    deleted: false,
    order: "cinema_first",
    walkIdx: 0,
    // Retained as inert compatibility fields for older operational readers.
    typeIdx: 0,
    catIdx: 0,
    counts: { live: 0, movies: 0, series: 0 },
    sig: emptySig(),
    startedAt,
    attempts: 0,
    // Layer 3 (orphan root-fix): a unique, monotonic version for THIS run. Its presence opts the
    // run into upsert-then-prune (no upfront delete; prune only the rows not re-seen, and only after
    // a healthy discovery). Continuations reuse it; legacy cursors (pre-deploy) lack it and keep the
    // old delete-then-reimport path, so this is safe to ship mid-sync. fetchErrors gates the prune.
    runVersion: Date.now(),
    fetchErrors: 0,
    ...extra,
  };
}

function discoveryTargetsFor(cats: JsonRecord, type: DiscoveryType): DiscoveryTarget[] {
  const ids = asStringArray(cats[type]);
  const definition = CINEMA_DISCOVER_TYPES[type];
  return ids.length
    ? ids.map((categoryId) => ({ ...definition, params: { category_id: categoryId } }))
    : [{ ...definition }];
}

// New imports alternate one bounded Movies request with one bounded Series
// request, then append every Live TV request. This is intentionally a pure,
// exported helper so the persisted scheduling contract is executable in tests.
export function cinemaFirstDiscoveryWalk(cats: JsonRecord): DiscoveryTarget[] {
  const movies = discoveryTargetsFor(cats, "movie");
  const series = discoveryTargetsFor(cats, "series");
  const cinema: DiscoveryTarget[] = [];
  const cinemaLength = Math.max(movies.length, series.length);
  for (let index = 0; index < cinemaLength; index++) {
    if (index < movies.length) cinema.push(movies[index]);
    if (index < series.length) cinema.push(series[index]);
  }
  return [...cinema, ...discoveryTargetsFor(cats, "live")];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// Fast, synchronous, order-independent catalogue fingerprint that streams (so it
// works across isolates without holding every id). Per type we keep a count, the
// newest provider `added`, and a commutative XOR+sum of a cheap FNV-1a hash of
// each external id — additions/removals flip the combined hash and the count.
function fnv32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function emptySig(): JsonRecord {
  return {
    live: { count: 0, maxAdded: 0, xor: 0, add: 0 },
    movie: { count: 0, maxAdded: 0, xor: 0, add: 0 },
    series: { count: 0, maxAdded: 0, xor: 0, add: 0 },
  };
}

function updateSig(sig: JsonRecord, type: string, ext: string, added: number) {
  const bucket = recordOrEmpty(sig[type]);
  const h = fnv32(ext);
  bucket.count = (Number(bucket.count) || 0) + 1;
  bucket.xor = ((Number(bucket.xor) || 0) ^ h) >>> 0;
  bucket.add = ((Number(bucket.add) || 0) + h) >>> 0;
  if (Number.isFinite(added) && added > (Number(bucket.maxAdded) || 0)) bucket.maxAdded = added;
  sig[type] = bucket;
}

function finalizeSig(sig: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const type of ["live", "movie", "series"]) {
    const b = recordOrEmpty(sig[type]);
    const count = Number(b.count) || 0;
    if (!count) continue;
    out[type] = {
      count,
      maxAdded: Number(b.maxAdded) || 0,
      idsHash: `${((Number(b.xor) || 0) >>> 0).toString(16)}:${((Number(b.add) || 0) >>> 0).toString(16)}`,
    };
  }
  return out;
}

// A provider commonly lists the same stream in several categories; a single
// upsert command can't touch the same (source_id, item_type, external_id) twice
// ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so collapse
// duplicates within a batch (keeping the last) before upserting.
function dedupeByConflictKey(rows: JsonRecord[]): JsonRecord[] {
  const map = new Map<string, JsonRecord>();
  for (const row of rows) {
    map.set(`${stringOr(row.item_type, "")}:${stringOr(row.external_id, "")}`, row);
  }
  return [...map.values()];
}

const IMPORT_BATCH_SIZE = 250;

// Statement timeout / deadlock / lock / resource errors are transient contention
// on a busy DB — worth retrying or handing to a fresh isolate; a schema error is not.
function isTransientDbError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error ?? "").toLowerCase();
  return /timeout|deadlock|could not serialize|lock|connection|temporar|resource/.test(msg);
}

// A few quick retries to ride out a brief spike — kept short so a slow batch never
// holds the isolate long enough to overrun its wall-clock mid-retry. On a
// persistent transient failure, throw a tagged 503 so the driver can checkpoint
// and continue in a fresh isolate (where the DB may have recovered).
async function withDbRetry<T extends { error: unknown }>(op: () => PromiseLike<T>, label: string): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await op();
    if (!result.error) return result;
    lastError = result.error;
    if (!isTransientDbError(result.error)) break;
    await new Promise((r) => setTimeout(r, Math.min(2500, Math.round(500 * Math.pow(1.8, attempt)))));
  }
  if (isTransientDbError(lastError)) {
    throw new HttpError(503, label, { transient: true, db: (lastError as { message?: string })?.message });
  }
  throwDb(lastError as { message?: string }, label);
  throw lastError; // unreachable (throwDb throws) — satisfies the Promise<T> return type
}

// Incremental import: insert a batch of rows (no select-back; finalize reloads rows from the table,
// so peak memory stays tiny). Legacy runs delete the catalogue upfront so these are pure inserts;
// Layer 3 runs keep the catalogue and additionally stamp each row's catalog_version (see below).
// Small batches keep each statement well under the edge connection's 8s budget.
async function appendSourceItems(
  sourceId: string,
  userId: string,
  rows: JsonRecord[],
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
  runVersion: number | null = null,
): Promise<number> {
  // Returns rows ACTUALLY inserted. `ignoreDuplicates` => INSERT ... ON CONFLICT DO NOTHING, so a
  // stream already present (re-import or a cross-category dup) is skipped; `count:'exact'` counts
  // only real inserts (small batch, no row data back — peak memory stays tiny). Used for the cosmetic
  // progress count.
  //
  // Layer 3 (runVersion set): new rows carry catalog_version from the insert payload; already-present
  // rows are then marked seen-this-run by a TARGETED single-column UPDATE — deliberately NOT a full
  // ON CONFLICT DO UPDATE, so a re-seen title keeps the codec profile / enrichment that norva-playback
  // writes back into metadata + playback_hint instead of being clobbered with bare provider values.
  // Rows the run never re-sees keep their old/NULL version and are pruned at completion.
  let inserted = 0;
  for (let index = 0; index < rows.length; index += IMPORT_BATCH_SIZE) {
    const chunk = rows.slice(index, index + IMPORT_BATCH_SIZE);
    if (!chunk.length) continue;
    const payload = withCatalogGenerationRows(
      runVersion == null ? chunk : chunk.map((r) => ({ ...r, catalog_version: runVersion })),
      generation,
    );
    const res = await withDbRetry(
      () => db.from("cloud_media_items").upsert(payload, {
        onConflict: "source_id,generation_id,item_type,external_id",
        ignoreDuplicates: true,
        count: "exact",
      }),
      "Unable to save cloud catalog items",
    );
    const c = (res as { count?: number | null }).count;
    inserted += typeof c === "number" ? c : chunk.length;
    if (runVersion != null) {
      // Mark the whole batch as seen-this-run (new rows already are; re-seen rows get only their
      // catalog_version bumped, enrichment untouched). A discovery iteration is a single item_type,
      // and IMPORT_BATCH_SIZE (250) keeps the IN list far under the URL limit that broke the old
      // 2000-id delete.
      const itemType = stringOr(chunk[0].item_type, "");
      const ids = chunk.map((r) => stringOr(r.external_id, "")).filter(Boolean);
      if (itemType && ids.length) {
        await withDbRetry(
          () => db.from("cloud_media_items").update({
            catalog_version: runVersion,
            ...catalogGenerationFields(generation),
          })
            .eq("source_id", sourceId).eq("user_id", userId)
            .eq("generation_id", generation.generationId)
            .eq("item_type", itemType).in("external_id", ids),
          "Unable to mark seen catalog items",
        );
      }
    }
  }
  return inserted;
}

// Layer 3 completion helpers. Count the rows THIS run re-saw (catalog_version=runVersion), per type
// — the authoritative catalogue totals (DO UPDATE inflates the running count via cross-category
// touches, so we recompute from the table).
async function countSeenByType(
  sourceId: string,
  userId: string,
  version: number,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
) {
  const out: Record<string, number> = { live: 0, movie: 0, series: 0 };
  for (const t of ["live", "movie", "series"]) {
    const { count, error } = await db
      .from("cloud_media_items")
      .select("id", { count: "exact", head: true })
      .eq("source_id", sourceId).eq("user_id", userId)
      .eq("generation_id", generation.generationId)
      .eq("item_type", t).eq("catalog_version", version);
    if (error) throwDb(error, "Unable to count discovered catalog items");
    out[t] = count || 0;
  }
  return { live: out.live, movie: out.movie, series: out.series };
}

// Total rows currently held for the source (any version). seenTotal subtracted from this gives the
// count that WOULD be pruned — used to refuse an implausibly-large removal. NB: named distinctly from
// the finalize-side countSourceItems(…, progress) above — a duplicate top-level `function` name is a
// SyntaxError in a Deno ES module (boots the whole function to 503), which esbuild does NOT flag.
async function countSourceItemsTotal(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
): Promise<number> {
  const { count, error } = await db
    .from("cloud_media_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId).eq("user_id", userId)
    .eq("generation_id", generation.generationId);
  if (error) throwDb(error, "Unable to count catalog items");
  return count || 0;
}

// Clear a source's items in bounded chunks. Uses a server-side batched-delete RPC (subquery LIMIT)
// rather than SELECT-ids → .delete().in('id', [...]): a 2000-element IN list builds a ~74KB request
// URL that PostgREST/proxy rejects, which made clearing a large catalogue (100k+ rows) fail
// deterministically and strand the whole sync. The RPC deletes a chunk in ~0.7s incl. FK cascades.
async function deleteSourceItems(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
) {
  for (let guard = 0; guard < 5000; guard++) {
    const { data, error } = await db.rpc("norva_delete_catalog_generation_items_batch", {
      p_source_id: sourceId, p_user_id: userId,
      ...catalogGenerationRpcFence(generation),
      p_limit: 2000,
    });
    if (error) throwDb(error, "Unable to clear old catalog items");
    const n = Number(Array.isArray(data) ? data[0] : data) || 0;
    if (n < 2000) return;
  }
}

// Fire the next isolate. The /cron/sync-step route kicks driveXtreamSyncToReady
// in the background and returns immediately, so this await resolves fast and the
// current (near-budget) isolate can exit cleanly. HARD-CODED to norva-source-sync
// (which owns the cron routes + watchdog) regardless of which function imported
// the engine — so the chain is uniform and the watchdog covers it.
async function selfInvokeSyncStep(sourceId: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("[xtream-sync] cannot self-invoke sync-step: missing URL/service key", sourceId);
    return;
  }
  const url = `${SUPABASE_URL}/functions/v1/norva-source-sync/cron/sync-step/${encodeURIComponent(sourceId)}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "content-type": "application/json" },
    });
  } catch (error) {
    console.error("[xtream-sync] self-invoke sync-step failed", sourceId, error);
  }
}

// Kick a fresh finalize isolate (resumes from the persisted finalize cursor).
// HARD-CODED to norva-source-sync, which owns the finalize driver + cron routes.
async function selfInvokeFinalize(sourceId: string, country: string | null) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const q = country ? `?country=${encodeURIComponent(country)}` : "";
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/norva-source-sync/cron/finalize/${encodeURIComponent(sourceId)}${q}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "content-type": "application/json" },
    });
  } catch (error) {
    console.error("[xtream-sync] self-invoke finalize failed", sourceId, error);
  }
}

// Resolve the global heavy-import budget — discovery AND finalize share it, so it bounds
// total concurrent imports, not just finalizers. New env NORVA_MAX_CONCURRENT_IMPORTS;
// falls back to the legacy NORVA_MAX_CONCURRENT_FINALIZE so existing config keeps working.
function heavyImportBudget(): number {
  return boundedInt(Deno.env.get("NORVA_MAX_CONCURRENT_IMPORTS") ?? Deno.env.get("NORVA_MAX_CONCURRENT_FINALIZE"), 3, 0, 50);
}

// Global admission control for heavy imports (discovery + finalize). Bounds how many IPTV
// catalogues actively import at once so N simultaneous huge ("8K") providers can't saturate
// the shared Postgres — the exact failure that starved GoTrue's connections and 504'd login.
// Priority is deterministic by created_at: a source is admitted only when FEWER than `max`
// OLDER syncing xtream sources run ahead of it, so the oldest N always progress (no mutual-
// defer deadlock) and newer ones queue, resumed by the 1-min watchdog the instant a slot
// frees. Fails CLOSED — if we can't confirm we're under budget (a COUNT timeout under the
// very load this guards), we DEFER; backing off is the safe move and the watchdog retries.
// Re-checked on every continuation, so steady state converges to exactly `max` concurrent
// regardless of start-up races (a briefly over-admitted source self-corrects next batch).
async function admitHeavyImport(db: SupabaseClient, sourceId: string, createdAt: string | null, max: number): Promise<boolean> {
  if (max <= 0) return true;     // cap disabled (env 0)
  if (!createdAt) return true;   // no ordering key (shouldn't happen) → don't strand it
  try {
    const { count, error } = await db.from("cloud_sources")
      .select("id", { count: "exact", head: true })
      .eq("sync_status", "syncing")
      .eq("source_type", "xtream")
      .lt("created_at", createdAt)
      .neq("id", sourceId);
    if (error) return false;     // fail CLOSED — defer; watchdog retries
    return (count ?? 0) < max;
  } catch (_) {
    return false;                // fail CLOSED
  }
}

// Detection-only (cron): stream the provider catalogue and compute its signature
// without importing anything. Memory-safe — only the running fingerprint is held.
export async function detectXtreamChange(
  sourceId: string,
  userId: string,
  config: JsonRecord,
  db: SupabaseClient,
  previousSignature: unknown,
  sourceSnapshot: { configCiphertext: string; configRevision: string },
): Promise<JsonRecord> {
  const accessSnapshot = await readCatalogAccessSnapshot(db, sourceId, userId, false);
  const runtimeConfig = await getRuntimeConfig(db);
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = typeof config.username === "string" && config.username.trim() ? config.username : "";
  const password = typeof config.password === "string" && config.password.length ? config.password : "";
  if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");
  const directFallbackSnapshot = await buildProviderDirectFallbackSnapshot({
    serverUrl,
    username,
    configCiphertext: sourceSnapshot.configCiphertext,
    configRevision: sourceSnapshot.configRevision,
  });
  const runDirectFallback = createSourceDirectFallbackLeaseRunner({
    db,
    sourceId,
    userId,
    ownerScope: "xtream-detect",
    ...directFallbackSnapshot,
  });
  await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
  const fetchCatalog = async (action: string, params?: Record<string, string>) => {
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    let payload: unknown;
    try {
      payload = await fetchProviderMetadata(
        runtimeConfig,
        { serverUrl, username, password, action, params, timeoutMs: 25000 },
        { runDirectFallback },
      );
    } catch (error) {
      await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
      throw error;
    }
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    return payload;
  };
  const vodCats = await fetchCatalog("get_vod_categories");
  const seriesCats = await fetchCatalog("get_series_categories");
  const liveCats = await fetchCatalog("get_live_categories");
  const maps: Record<string, Map<string, string>> = {
    live: categoryMap(liveCats),
    movie: categoryMap(vodCats),
    series: categoryMap(seriesCats),
  };
  const sig = emptySig();
  let liveCount = 0, movieCount = 0, seriesCount = 0;
  const walk = cinemaFirstDiscoveryWalk({
    live: [...maps.live.keys()],
    movie: [...maps.movie.keys()],
    series: [...maps.series.keys()],
  });
  for (const target of walk) {
    const slice = await fetchCatalog(target.action, target.params);
    if (!Array.isArray(slice) || !slice.length) continue;
    for (const raw of slice) {
      if (!isRecord(raw)) continue;
      const ext = stringOr(raw.stream_id ?? raw.series_id ?? raw.id, "");
      if (!ext) continue;
      updateSig(sig, target.type, ext, Number(raw.added));
      if (target.type === "live") liveCount++;
      else if (target.type === "movie") movieCount++;
      else seriesCount++;
    }
  }
  const contentSignature = finalizeSig(sig);
  const providerKey = await providerKeyFromCategoryMaps(maps);
  await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
  await recordProviderIdentity(db, sourceId, userId, providerKey);
  await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
  const changed = Boolean(previousSignature) && !contentSignatureEquals(contentSignature, previousSignature);
  return { live: liveCount, movies: movieCount, series: seriesCount, total: liveCount + movieCount + seriesCount, contentSignature, changed, detectOnly: true, providerKey };
}

// Drive one isolate's worth of resumable discovery. Imports every category's
// stream slice incrementally from a persisted cursor (also accumulating the
// change-detection signature); when the wall-clock budget is hit before the
// catalogue is fully imported it checkpoints and self-invokes a fresh isolate.
// On completion it writes the new signature, records the "what's new" event and
// leaves the finalize-pending handoff state the client/cron stepper materializes.
export async function driveXtreamSyncToReady(sourceId: string, userId: string, db: SupabaseClient) {
  let accessSnapshot: CatalogAccessSnapshot;
  try {
    accessSnapshot = await readCatalogAccessSnapshot(db, sourceId, userId, false);
  } catch (error) {
    if (isCatalogAccessGuardError(error)) return;
    throw error;
  }
  const deadline = Date.now() + SYNC_DRIVE_BUDGET_MS;
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .eq("enabled", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) { console.error("[xtream-sync] sync driver load failed", sourceId, error.message); return; }
  if (!source) return;
  await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
  if (String(source.sync_status) === "ready") return; // a stale continuation raced past completion

  const baseHint = recordOrEmpty(source.config_hint);
  let cursor = recordOrEmpty(baseHint.syncCursor);
  if (!isRecord(baseHint.syncCursor)) cursor = freshSyncCursor(new Date().toISOString());
  let progress = recordOrEmpty(baseHint.syncProgress);
  const previousSignature = cursor.previousSignature ?? baseHint.contentSignature;

  // Single-flight: a fresh sync (syncCloudSource) stamps a new startedAt. If this
  // isolate sees a different one it has been superseded — stop writing so two
  // generations don't fight over the cursor and the same rows (which deadlocks
  // and statement-times-out under load). Self-invoke continuations keep the same
  // startedAt, so the chain is unaffected.
  const myRun = stringOr(cursor.startedAt, "");
  let superseded = false;

  const persist = async (progressPatch: JsonRecord | null) => {
    if (progressPatch) {
      progress = mergeSyncProgress(progress, compactRecord({ ...progressPatch, status: "syncing", updatedAt: new Date().toISOString() }));
    }
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    if (stringOr(recordOrEmpty(freshHint.syncCursor).startedAt, myRun) !== myRun) { superseded = true; return; }
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    cursor.heartbeatAt = new Date().toISOString();
    await db
      .from("cloud_sources")
      .update({
        config_hint: compactRecord({
          ...freshHint,
          syncProgress: progressPatch ? progress : freshHint.syncProgress,
          syncCursor: cursor,
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
  };

  try {
    // Watchdog revival: this isolate is restarting a source the watchdog found
    // stalled or errored (status != "syncing"). Clear the error AND reset the
    // continuation budget FIRST, so a discovery that previously exhausted the
    // budget (or hit a non-503 error) gets a fresh run instead of immediately
    // re-tripping the cap just below.
    if (String(source.sync_status) !== "syncing") {
      cursor.attempts = 0;
      await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
      await db.from("cloud_sources").update({ sync_status: "syncing", sync_error: null }).eq("id", sourceId).eq("user_id", userId);
    }
    // Global admission control: cap concurrent heavy imports (see admitHeavyImport). The
    // source is "syncing" now, so deferring here parks it for the 1-min watchdog — checked
    // BEFORE the attempts increment so a queued source never burns its continuation budget.
    if (!(await admitHeavyImport(db, sourceId, source.created_at ? String(source.created_at) : null, heavyImportBudget()))) {
      return; // queued — resumed when an older import finishes
    }
    const runtimeConfig = await getRuntimeConfig(db);
    const config = await decryptSourceConfig(String(source.config_ciphertext), runtimeConfig);
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
    const username = typeof config.username === "string" && config.username.trim() ? config.username : "";
    const password = typeof config.password === "string" && config.password.length ? config.password : "";
    if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");
    // Playback always wins on mono-account providers.  The foreground presence
    // ledger is updated before a playback session starts, so consult it before
    // the first provider request and park this durable cursor instead of
    // provoking a gateway 409 (which used to be persisted as a terminal source
    // failure).  A parked cursor consumes no continuation budget; the existing
    // watchdog resumes it after the viewer-presence window has drained.
    let accountBusy = false;
    try {
      const accountKey = `${new URL(serverUrl).host}/${username}`;
      let busyResult = await db.rpc("provider_account_busy_for_catalog_refresh", {
        p_key: accountKey,
      });
      // Rolling deploy safety: an older database must remain conservatively
      // blocked by the legacy fence until the scoped RPC is installed. This
      // fallback intentionally treats passive presence as busy for that brief
      // mixed-version window rather than letting catalogue I/O race playback.
      if (busyResult.error) {
        busyResult = await db.rpc("provider_account_busy", { p_key: accountKey });
      }
      accountBusy = !busyResult.error && busyResult.data === true;
    } catch (_) {
      // Fail open here: the media gateway remains the authoritative final race
      // fence and returns a bounded 409 without touching the provider account.
    }
    if (accountBusy) {
      await persist({
        stage: "waiting_for_provider",
        percent: Number(progress.percent ?? 0) || 4,
        note: "viewer_priority",
      });
      return;
    }

    cursor.attempts = (Number(cursor.attempts) || 0) + 1;
    if (Number(cursor.attempts) > SYNC_MAX_CONTINUATIONS) {
      throw new HttpError(500, "Catalog sync exceeded its continuation budget");
    }
    const directFallbackSnapshot = await buildProviderDirectFallbackSnapshot({
      serverUrl,
      username,
      configCiphertext: String(source.config_ciphertext),
      configRevision: accessSnapshot.configRevision,
    });
    const runDirectFallback = createSourceDirectFallbackLeaseRunner({
      db,
      sourceId,
      userId,
      ownerScope: "xtream-drive",
      ...directFallbackSnapshot,
    });
    // A provider error here used to be silently swallowed to [] — which let a rate-limited /
    // expired account look like a legitimately-empty catalogue and decimate it. Count the failures
    // so the Layer 3 prune can refuse to run on an unhealthy discovery (cursor.fetchErrors).
    const fetchCatalog = async (action: string, params?: Record<string, string>) => {
      try {
        await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
        const payload = await fetchProviderMetadata(
          runtimeConfig,
          { serverUrl, username, password, action, params, timeoutMs: 25000 },
          { runDirectFallback },
        );
        await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
        return payload;
      } catch (error) {
        if (isCatalogAccessGuardError(error)) throw error;
        await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
        cursor.fetchErrors = (Number(cursor.fetchErrors) || 0) + 1;
        throw error;
      }
    };

    const vodCats = await fetchCatalog("get_vod_categories");
    const seriesCats = await fetchCatalog("get_series_categories");
    const liveCats = await fetchCatalog("get_live_categories");
    const nameMaps: Record<string, Map<string, string>> = {
      live: categoryMap(liveCats),
      movie: categoryMap(vodCats),
      series: categoryMap(seriesCats),
    };

    if (!isRecord(cursor.cats)) {
      cursor.cats = {
        live: [...nameMaps.live.keys()].sort(),
        movie: [...nameMaps.movie.keys()].sort(),
        series: [...nameMaps.series.keys()].sort(),
      };
      cursor.catCounts = { live: nameMaps.live.size, movies: nameMaps.movie.size, series: nameMaps.series.size };
    }
    const cats = recordOrEmpty(cursor.cats);
    if (!isRecord(cursor.sig)) cursor.sig = emptySig();
    const sig = recordOrEmpty(cursor.sig);

    const discoverStartedPatch = {
      stage: "discovering",
      percent: 18,
      steps: {
        connect: { status: "done" },
        channels: { status: "running" },
        movies: { status: "running" },
        series: { status: "running" },
        categories: { status: "running" },
        // L'upsert en base se fait PENDANT la discovery (appendSourceItems inline) —
        // la milestone "Import catalog" doit vivre dès maintenant, pas rester
        // "Waiting" pendant toute la plus longue phase pour claquer à "Done" à 74.
        import: { status: "running" },
      },
    };
    if (cursor.runVersion) {
      // Layer 3: NO upfront delete. We upsert onto the live catalogue (stamping each row with
      // runVersion) and prune only the not-re-seen rows at the end, gated on a healthy discovery —
      // so a partial/rate-limited run can never empty the catalogue.
      if (!cursor.discoverStarted) {
        cursor.discoverStarted = true;
        await enqueueImportNotification(db, userId, sourceId, "import_started");
        await persist(discoverStartedPatch);
        if (superseded) return;
      }
    } else if (!cursor.deleted) {
      // Legacy path (pre-Layer-3 cursors, e.g. a sync already in flight at deploy time).
      await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
      await deleteSourceItems(sourceId, userId, db, accessSnapshot);
      cursor.deleted = true;
      await enqueueImportNotification(db, userId, sourceId, "import_started");
      await persist(discoverStartedPatch);
      if (superseded) return;
    }

    const counts = recordOrEmpty(cursor.counts);
    let liveCount = Number(counts.live) || 0;
    let movieCount = Number(counts.movies) || 0;
    let seriesCount = Number(counts.series) || 0;
    const cinemaFirst = Number(cursor.v) >= 2 && cursor.order === "cinema_first";
    const cinemaWalk = cinemaFirst ? cinemaFirstDiscoveryWalk(cats) : [];
    const legacyTargetsFor = (type: DiscoveryType): DiscoveryTarget[] => {
      const ids = asStringArray(cats[type]);
      const definition = LEGACY_DISCOVER_TYPES.find((entry) => entry.type === type)!;
      return ids.length
        ? ids.map((categoryId) => ({ ...definition, params: { category_id: categoryId } }))
        : [{ ...definition }];
    };
    let walkIdx = Number(cursor.walkIdx) || 0;
    let typeIdx = Number(cursor.typeIdx) || 0;
    let catIdx = Number(cursor.catIdx) || 0;
    const startWalkIdx = walkIdx;
    const startTypeIdx = typeIdx;
    const startCatIdx = catIdx;
    const totalTargets = cinemaFirst
      ? cinemaWalk.length
      : LEGACY_DISCOVER_TYPES.reduce((sum, definition) => sum + legacyTargetsFor(definition.type).length, 0);
    const completedTargets = () => {
      if (cinemaFirst) return walkIdx;
      let done = catIdx;
      for (let index = 0; index < typeIdx; index++) {
        done += legacyTargetsFor(LEGACY_DISCOVER_TYPES[index].type).length;
      }
      return done;
    };
    // Cadence de persistance adaptative (UX barre, audit 18/07) : l'ancien « tous
    // les 4 lots » = 56 catégories par écriture — un provider à 150 catégories
    // voyait ~3 sauts de ~15 % au lieu d'une progression continue. Viser ~3-4 %
    // par écriture, borné à [1..4] lots (le surcoût WAL reste négligeable, et les
    // petits providers qui écrivent chaque lot finissent en secondes de toute façon).
    const persistEvery = Math.max(1, Math.min(4, Math.round(totalTargets / 160)));

    const projectFirstCinemaBatch = async (itemType: "movie" | "series", batchRows: JsonRecord[]) => {
      const readyFlag = itemType === "movie" ? "moviesReady" : "seriesReady";
      if (!batchRows.length || progress[readyFlag] === true) return;
      // A provider category can contain tens of thousands of titles. Only read
      // back one bounded database batch for the early shelf projection; the
      // durable finalizer will project the full catalogue afterwards.
      const externalIds = batchRows
        .slice(0, IMPORT_BATCH_SIZE)
        .map((row) => stringOr(row.external_id, ""))
        .filter(Boolean);
      const { data: savedData, error: savedError } = await db
        .from("cloud_media_items")
        .select("id,user_id,source_id,generation_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,backdrop_url,metadata,playback_hint,available")
        .eq("source_id", sourceId)
        .eq("user_id", userId)
        .eq("generation_id", accessSnapshot.generationId)
        .eq("item_type", itemType)
        .in("external_id", externalIds);
      if (savedError) throw savedError;
      const savedRows = Array.isArray(savedData) ? savedData as LiveCatalogItem[] : [];
      if (!savedRows.length) return;
      await refreshVodTitleProjection({
        sourceId,
        userId,
        rows: savedRows,
        db,
        generation: accessSnapshot,
        xtreamConfig: null,
        mediaGatewayUrl: null,
        mediaGatewayToken: null,
        vodInfoLimit: 0,
        tmdbValidateLimit: 0,
        assertSourceCurrent: () => assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot),
      });
      await persist({
        stage: "discovering",
        [readyFlag]: true,
        browseReady: true,
        steps: { [itemType === "movie" ? "movies" : "series"]: { status: "running", count: savedRows.length } },
      });
    };

    const importDiscoveryTarget = async (target: DiscoveryTarget) => {
      // Deliberately one awaited provider request: DISCOVER_CONCURRENCY remains
      // one so alternate cinema batches never create `background_busy` pressure.
      const slice = await fetchCatalog(target.action, target.params);
      const rawRows: JsonRecord[] = [];
      if (Array.isArray(slice) && slice.length) {
        const r = xtreamRows(sourceId, userId, slice as JsonRecord[], target.type, nameMaps[target.type]);
        for (const row of r) rawRows.push(row);
      }
      const batchRows = dedupeByConflictKey(rawRows);
      for (const row of batchRows) {
        updateSig(sig, target.type, stringOr(row.external_id, ""), Number(recordOrEmpty(row.metadata).added));
      }
      if (batchRows.length) {
        // Count only rows the upsert ACTUALLY inserted — a stream already imported
        // from another category in a prior iteration is dropped (ignoreDuplicates),
        // so cross-category duplicates no longer inflate the "found" counts/totalVod.
        await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
        const insertedNow = await appendSourceItems(
          sourceId,
          userId,
          batchRows,
          db,
          accessSnapshot,
          cursor.runVersion ? Number(cursor.runVersion) : null,
        );
        await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
        if (target.type === "live") liveCount += insertedNow;
        else if (target.type === "movie") movieCount += insertedNow;
        else seriesCount += insertedNow;
        if (target.type === "movie" || target.type === "series") {
          await projectFirstCinemaBatch(target.type, batchRows);
        }
      }
    };

    let sincePersist = 0;
    const persistWalkProgress = async () => {
      sincePersist++;
      if (sincePersist < persistEvery && Date.now() < deadline) return;
      sincePersist = 0;
      const percent = Math.max(18, Math.min(66, 18 + Math.round((48 * completedTargets()) / Math.max(1, totalTargets))));
      const importedTotal = liveCount + movieCount + seriesCount;
      await persist({
        stage: "discovering",
        percent,
        counts: { live: liveCount, movies: movieCount, series: seriesCount, total: importedTotal },
        steps: { import: { status: "running", count: importedTotal } },
      });
    };

    if (cinemaFirst) {
      while (Date.now() < deadline && walkIdx < cinemaWalk.length) {
        await importDiscoveryTarget(cinemaWalk[walkIdx]);
        walkIdx += DISCOVER_CONCURRENCY;
        cursor.walkIdx = walkIdx;
        cursor.counts = { live: liveCount, movies: movieCount, series: seriesCount };
        cursor.sig = sig;
        await persistWalkProgress();
        if (superseded) return;
      }
    } else {
      // Backward-compatible v1 resume path. Never reinterpret a persisted
      // typeIdx/catIdx from a deployment that began with Live TV.
      while (Date.now() < deadline && typeIdx < LEGACY_DISCOVER_TYPES.length) {
        const definition = LEGACY_DISCOVER_TYPES[typeIdx];
        const targets = legacyTargetsFor(definition.type);
        if (catIdx >= targets.length) { typeIdx++; catIdx = 0; continue; }
        await importDiscoveryTarget(targets[catIdx]);
        catIdx += DISCOVER_CONCURRENCY;
        if (catIdx >= targets.length) { typeIdx++; catIdx = 0; }
        cursor.typeIdx = typeIdx;
        cursor.catIdx = catIdx;
        cursor.counts = { live: liveCount, movies: movieCount, series: seriesCount };
        cursor.sig = sig;
        await persistWalkProgress();
        if (superseded) return;
      }
    }

    if (cinemaFirst) {
      cursor.typeIdx = 0;
      cursor.catIdx = 0;
    } else {
      cursor.typeIdx = typeIdx;
      cursor.catIdx = catIdx;
    }

    // Real progress this isolate → reset the continuation budget so only a
    // genuinely stuck (zero-progress) loop can ever trip SYNC_MAX_CONTINUATIONS.
    // A healthy large import self-invokes hundreds of times and must never
    // self-abort just for being big.
    if (walkIdx !== startWalkIdx || typeIdx !== startTypeIdx || catIdx !== startCatIdx) cursor.attempts = 0;

    const discoveryIncomplete = cinemaFirst
      ? walkIdx < cinemaWalk.length
      : typeIdx < LEGACY_DISCOVER_TYPES.length;
    if (discoveryIncomplete) {
      await persist(null);
      if (superseded) return;
      await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
      await selfInvokeSyncStep(sourceId);
      return;
    }

    // Jalon UX (audit 18/07) : la fin de discovery enchaîne recomptage authoritaire
    // + prune Layer 3, potentiellement longs sur un gros catalogue — sans écriture,
    // la barre gelait au plafond discovery puis téléportait à 74.
    await persist({ stage: "importing", percent: 68, steps: { import: { status: "running" } } });
    if (superseded) return;

    // Layer 3: recompute authoritative per-type totals from the table (DO UPDATE inflates the
    // running counts via cross-category re-touches), then decide whether it's safe to prune.
    if (cursor.runVersion) {
      const seen = await countSeenByType(sourceId, userId, Number(cursor.runVersion), db, accessSnapshot);
      liveCount = seen.live; movieCount = seen.movie; seriesCount = seen.series;
    }
    const total = liveCount + movieCount + seriesCount;

    if (total <= 0) {
      // A versioned REFRESH that re-saw nothing (provider down / rate-limited) must not nuke the
      // prior catalogue nor flip to "error" (which the 1-min watchdog would re-hammer). If we still
      // hold items from a previous run, keep serving them and finish quietly without touching the
      // signature. Only a genuinely empty FIRST sync (no prior items) is a real failure.
      if (cursor.runVersion) {
        const existing = await countSourceItemsTotal(sourceId, userId, db, accessSnapshot);
        if (existing > 0) {
          console.warn("[xtream-sync] Layer3 refresh re-saw 0 items; kept prior catalogue", sourceId, "fetchErrors", Number(cursor.fetchErrors) || 0);
          const { data: keepFresh } = await db
            .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
          const keepHint = recordOrEmpty(keepFresh?.config_hint);
          if (stringOr(recordOrEmpty(keepHint.syncCursor).startedAt, myRun) !== myRun) return; // superseded
          await db.from("cloud_sources").update({
            sync_status: "ready",
            config_hint: compactRecord({
              ...keepHint,
              syncCursor: undefined,
              syncProgress: mergeSyncProgress(recordOrEmpty(keepHint.syncProgress), {
                status: "ready", stage: "ready", percent: 100, updatedAt: new Date().toISOString(),
                note: "refresh_no_items_kept_prior",
              }),
            }),
          }).eq("id", sourceId).eq("user_id", userId);
          return;
        }
      }
      throw new HttpError(422, "No playable catalog items were imported from this source");
    }

    if (cursor.runVersion) {
      // Second jalon avant le prune (le DELETE des titres disparus peut être long).
      await persist({ stage: "importing", percent: 71 });
      if (superseded) return;
      const totalHeld = await countSourceItemsTotal(sourceId, userId, db, accessSnapshot);
      const wouldRemove = Math.max(0, totalHeld - total);
      const fetchErrors = Number(cursor.fetchErrors) || 0;
      const removeFraction = wouldRemove / Math.max(1, totalHeld);
      const healthy = fetchErrors === 0 && removeFraction <= PRUNE_MAX_REMOVE_FRACTION;
      if (healthy) {
        if (wouldRemove > 0) {
          // Keep the old inventory as a safe superset through handoff. The
          // durable pre-READY gate owns this delete now: it persists the exact
          // catalogVersion, refreshes the post-delete epoch after every commit,
          // survives isolate loss, and is shared by both finalize engines.
          // Deleting here used to strand large sources because this discovery
          // isolate had no durable prune cursor across early termination.
          console.log("[xtream-sync] Layer3 deferred stale prune to ready gate", sourceId, "rows", wouldRemove);
        }
      } else {
        // Unsafe to prune — keep the prior items (the table is now a safe superset old+new). The
        // source still serves, Layer 1 hides any stale title-orphans, and the next HEALTHY run
        // prunes them. This is what stops a rate-limited account from emptying the catalogue.
        console.warn("[xtream-sync] Layer3 prune skipped", sourceId, JSON.stringify({ reason: fetchErrors ? "fetch_errors" : "implausible_removal", fetchErrors, wouldRemove, totalHeld }));
      }
    }

    const catCounts = recordOrEmpty(cursor.catCounts);
    const liveCats2 = Number(catCounts.live) || 0;
    const movieCats2 = Number(catCounts.movies) || 0;
    const seriesCats2 = Number(catCounts.series) || 0;
    const catTotal = liveCats2 + movieCats2 + seriesCats2;
    const contentSignature = finalizeSig(sig);
    cursor.active = false;
    cursor.phase = "imported";

    // Final config_hint write: persist the new signature + handoff progress.
    progress = mergeSyncProgress(progress, compactRecord({
      status: "syncing",
      stage: "materializing",
      percent: 74,
      updatedAt: new Date().toISOString(),
      // Durable identity of the exact logical inventory handed to finalize.
      // READY pruning must bind to this value; ordering versions by wall clock
      // is not a safe substitute for identifying the completed discovery run.
      catalogVersion: cursor.runVersion ? Number(cursor.runVersion) : undefined,
      counts: { live: liveCount, movies: movieCount, series: seriesCount, total },
      categories: { live: liveCats2, movies: movieCats2, series: seriesCats2, total: catTotal },
      steps: {
        connect: { status: "done" },
        channels: { status: "done", count: liveCount },
        movies: { status: "done", count: movieCount },
        series: { status: "done", count: seriesCount },
        categories: { status: "done", count: catTotal },
        import: { status: "done", count: total },
        finalize: { status: "running" },
      },
    }));
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    if (stringOr(recordOrEmpty(freshHint.syncCursor).startedAt, myRun) !== myRun) return; // superseded by a newer sync
    // Discovery is done (cursor.active=false) and its signature is now promoted to the
    // top-level contentSignature — so DROP the fat syncCursor (cats + per-item sig maps,
    // ~13 KB) instead of carrying it through the whole finalize and into the ready state.
    // It was re-written on every finalize heartbeat (every ~2.5s) for nothing, bloating WAL
    // and the login-critical cloud_sources row; compactRecord strips the undefined key.
    // Provider identity from the freshly-fetched category taxonomy (this isolate
    // re-fetches it at the top). Stable + mirror-invariant; only overwrite when we
    // actually computed one, so a transient empty fetch never drops a prior key.
    const providerKey = await providerKeyFromCategoryMaps(nameMaps);
    const finalHint: JsonRecord = { ...freshHint, contentSignature, syncProgress: progress, syncCursor: undefined };
    if (providerKey) finalHint.providerKey = providerKey;
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    await recordProviderIdentity(db, sourceId, userId, providerKey);
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    await db
      .from("cloud_sources")
      .update({
        config_hint: compactRecord(finalHint),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    runCategoryHydrationInBackground(hydrateMirrorCategoryNames(db, sourceId, userId, accessSnapshot));

    // "What's new" feed: record a capped event when the catalogue grew.
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    await maybeRecordContentEvent(db, userId, sourceId, previousSignature, {
      contentSignature,
      live: liveCount,
      movies: movieCount,
      series: seriesCount,
      total,
    });
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    // Discovery done → kick the self-continuing finalize driver so a huge
    // catalogue materialises to "ready" hands-off (the client's ~160-call loop
    // can't finish one); idempotent with the client poll if the app is open.
    await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    await selfInvokeFinalize(sourceId, stringOrNull(cursor.country));
  } catch (err) {
    // A promotion/config change is a successful stop condition for the stale
    // continuation. Never convert it into a source sync error or notification.
    if (isCatalogAccessGuardError(err)) return;
    try {
      await assertCatalogSnapshotCurrent(db, sourceId, userId, accessSnapshot);
    } catch (guardError) {
      if (isCatalogAccessGuardError(guardError)) return;
      throw guardError;
    }
    // A viewer can start in the narrow interval after the ledger preflight and
    // before the provider call.  The gateway rejects that background request
    // with 409.  This is scheduling, not a broken source: preserve the active
    // cursor, undo the attempt/fetch-error accounting and let the watchdog
    // retry after playback has drained.  Never emit import_failed for this path.
    if (isProviderViewerPriority(err)) {
      cursor.attempts = Math.max(0, (Number(cursor.attempts) || 0) - 1);
      cursor.fetchErrors = Math.max(0, (Number(cursor.fetchErrors) || 0) - 1);
      await persist({
        stage: "waiting_for_provider",
        percent: Number(progress.percent ?? 0) || 4,
        note: "viewer_priority",
      });
      return;
    }
    // Transient DB contention (timeout/lock/resource): don't fail the sync — the
    // cursor is checkpointed, so hand off to a fresh isolate where the DB may have
    // recovered. Bounded by the continuation cap so a real outage still surfaces.
    const transient = err instanceof HttpError && err.status === 503;
    if (transient && Number(cursor.attempts) < SYNC_MAX_CONTINUATIONS) {
      console.warn("[xtream-sync] transient sync error — continuing in a fresh isolate", sourceId);
      try { await persist(null); } catch (_) { /* ignore — the cursor's last checkpoint stands */ }
      await selfInvokeSyncStep(sourceId);
      return;
    }
    const message = formatSourceSyncError(err, "Source sync failed");
    console.error("[xtream-sync] sync driver failed", sourceId, message);
    const failedAt = new Date().toISOString();
    const terminal = isTerminalSourceSyncStatus(
      err instanceof HttpError ? err.status : null,
    );
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    const failedCursor = recordOrEmpty(freshHint.syncCursor);
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: failedAt,
        config_hint: compactRecord({
          ...freshHint,
          syncCursor: terminal ? compactRecord({
            ...failedCursor,
            active: false,
            terminalAt: failedAt,
            terminalStatus: err instanceof HttpError ? err.status : null,
          }) : freshHint.syncCursor,
          syncProgress: mergeSyncProgress(recordOrEmpty(freshHint.syncProgress), {
            status: "error",
            stage: "error",
            percent: Number(recordOrEmpty(freshHint.syncProgress).percent) || 0,
            updatedAt: failedAt,
            error: message,
          }),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    // Persistent failure (non-transient / continuation budget exhausted) → notify once.
    await enqueueImportNotification(db, userId, sourceId, "import_failed", { error: message });
  }
}

// Plain-language "what's new" summary from two signatures: the net per-type
// count increase since the last sync. Net-positive only (a churned catalogue
// that adds + removes equal amounts reads as "nothing new", which is the right
// conservative behaviour for a notification). Drives the free in-app feed.
function summarizeContentDelta(prev: unknown, next: unknown): { total: number; byType: JsonRecord; summary: string } {
  const labels: Record<string, string> = { movie: "movies", series: "shows", live: "channels" };
  const byType: JsonRecord = {};
  const parts: string[] = [];
  let total = 0;
  for (const type of ["movie", "series", "live"]) {
    const oldCount = isRecord(prev) && isRecord(prev[type]) ? Number(prev[type].count) || 0 : 0;
    const newCount = isRecord(next) && isRecord(next[type]) ? Number(next[type].count) || 0 : 0;
    const delta = newCount - oldCount;
    if (delta > 0) {
      byType[type] = delta;
      total += delta;
      parts.push(`${delta} new ${labels[type]}`);
    }
  }
  return { total, byType, summary: parts.join(" · ") };
}

// Record a one-per-source-per-day "what's new" event when a sync actually
// changed the catalogue. Best-effort and rate-capped; never blocks the sync.
async function maybeRecordContentEvent(
  db: SupabaseClient,
  userId: string,
  sourceId: string,
  previousSignature: unknown,
  result: JsonRecord,
) {
  try {
    if (!previousSignature || result.skipped) return; // first import / no change
    const delta = summarizeContentDelta(previousSignature, result.contentSignature);
    if (delta.total <= 0) return;
    const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await db
      .from("cloud_content_events")
      .select("id")
      .eq("user_id", userId)
      .eq("source_id", sourceId)
      .gt("created_at", since)
      .limit(1);
    if (recent && recent.length) return; // already notified today (free 1/day cap)
    await db.from("cloud_content_events").insert({
      user_id: userId,
      source_id: sourceId,
      kind: "new_content",
      summary: delta.summary,
      payload: { byType: delta.byType, total: delta.total },
    });
  } catch (_) {
    // observability feature — never let it break a sync
  }
}

function contentSignatureEquals(a: unknown, b: unknown): boolean {
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return false;
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (!isRecord(av) || !isRecord(bv)) return false;
    if (Number(av.count) !== Number(bv.count)) return false;
    if (stringOr(av.idsHash, "") !== stringOr(bv.idsHash, "")) return false;
  }
  return true;
}

function categoryMap(items: unknown) {
  const categories = new Map<string, string>();
  if (!Array.isArray(items)) return categories;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = stringOr(item.category_id ?? item.categoryId ?? item.id, "");
    const name = stringOr(item.category_name ?? item.categoryName ?? item.name, "");
    if (id && name) categories.set(id, name);
  }
  return categories;
}

// Stable, mirror-invariant provider identity. A reseller commonly hands out many
// URLs (DNS aliases / reverse-proxies) for ONE Xtream panel — same catalogue, same
// content IDs — so the hostname does NOT identify the provider. The category
// taxonomy does: it is byte-identical across every mirror and distinctive per panel,
// and (unlike the per-title idsHash) it does not drift as titles are added. We hash
// the sorted set of category NAMES (the human taxonomy is more stable than ids,
// which a panel can renumber). providerKey lets the cross-user caches collapse all
// mirrors of one panel into a single entry. See docs/PROVIDER-IDENTITY-DEDUP.md.
async function providerKeyFromCategoryMaps(maps: Record<string, Map<string, string>>): Promise<string> {
  const names = new Set<string>();
  for (const type of ["live", "movie", "series"]) {
    const m = maps[type];
    if (!m) continue;
    for (const name of m.values()) {
      const n = name.trim().toLowerCase();
      if (n) names.add(n);
    }
  }
  if (names.size === 0) return ""; // no taxonomy fetched → can't fingerprint; caller falls back to host
  const hex = await sha256Hex([...names].sort().join("\n"));
  return `x:${hex.slice(0, 24)}`;
}

function boundedProviderOverview(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringOrNull(value);
    if (!text || /^(?:n\/?a|none|null|undefined|no (?:description|overview|plot)(?: available)?)$/i.test(text)) continue;
    return text.slice(0, 4000);
  }
  return null;
}

function xtreamRows(
  sourceId: string,
  userId: string,
  items: JsonRecord[],
  itemType: "live" | "movie" | "series",
  categories: Map<string, string>,
) {
  const rows: JsonRecord[] = [];
  for (const item of items) {
    const streamId = stringOr(item.stream_id ?? item.series_id ?? item.id, "");
    const title = stringOr(item.name ?? item.title, "");
    if (!streamId || !title) continue;
    const rawContainer = stringOr(item.container_extension, "");
    const container = rawContainer || (itemType === "live" ? "ts" : "mp4");
    const containerExplicit = Boolean(rawContainer);
    const categoryId = stringOrNull(item.category_id);
    const categoryName = categoryId
      ? categories.get(categoryId) ?? stringOrNull(item.category_name)
      : stringOrNull(item.category_name);
    // Some providers include a synopsis directly in get_vod_streams/get_series.
    // Keep it as a per-user fallback: unmatched and never-scanned catalogues have
    // no TMDB identity yet, so dropping this text would make it unrecoverable.
    const providerOverview = itemType === "movie" || itemType === "series"
      ? boundedProviderOverview(item.plot, item.description, item.overview, item.desc)
      : null;
    rows.push({
      user_id: userId,
      source_id: sourceId,
      item_type: itemType,
      external_id: streamId,
      parent_external_id: categoryId,
      title,
      subtitle: categoryName,
      poster_url: stringOrNull(item.stream_icon ?? item.cover),
      backdrop_url: null,
      metadata: compactRecord({
        categoryId,
        categoryName,
        rating: item.rating,
        added: item.added,
        overview: providerOverview,
        providerTmdbId: stringOrNull(item.tmdb_id ?? item.tmdbId ?? item.tmdb),
        providerImdbId: stringOrNull(item.imdb_id ?? item.imdbId ?? item.imdb),
      }),
      playback_hint: compactRecord({
        sourceType: "xtream",
        streamId,
        streamType: itemType,
        container,
        containerExplicit,
        providerTmdbId: stringOrNull(item.tmdb_id ?? item.tmdbId ?? item.tmdb),
        providerImdbId: stringOrNull(item.imdb_id ?? item.imdbId ?? item.imdb),
      }),
      available: true,
    });
  }
  return rows;
}

type StagedCatalogItemType = "live" | "movie" | "series";
type StagedCatalogAction =
  | "get_live_categories"
  | "get_vod_categories"
  | "get_series_categories"
  | "get_live_streams"
  | "get_vod_streams"
  | "get_series";

export type XtreamMetadataPageRequest = {
  action: StagedCatalogAction;
  categoryId: null;
  cursor: string | null;
  spoolToken: string | null;
  maxItems: number;
};

export type XtreamMetadataPage = {
  items: unknown[];
  nextCursor: string | null;
  done: boolean;
  spoolToken?: string | null;
  pending?: boolean;
  retryAfterSeconds?: number;
};

type StagedCategory = { id: string; name: string; ordinal: number };
type StagedGatewayState = { pageCursor: string | null; spoolToken: string | null };
type StagedGenerationCursor = {
  version: 1 | 2;
  actionIndex: number;
  pageCursor: string | null;
  spoolToken: string | null;
  registeredCategoryCount: number;
  currentItemCount: number;
  processedCategories: number;
  processedItems: number;
  copyRevision: number;
  cinemaMovie: StagedGatewayState;
  cinemaSeries: StagedGatewayState;
  cinemaDoneMask: number;
  cinemaTurn: "movie" | "series";
};

const STAGED_CATEGORY_PAGE_SIZE = 100;
const STAGED_ITEM_PAGE_SIZE = 250;
const STAGED_CURSOR_TOKEN_MAX = 1024;
const STAGED_PACKED_CURSOR_MAX = 1024;
type StagedProgressAction = "live_categories" | "vod_categories" | "series_categories" |
  "live_streams" | "vod_streams" | "series_streams" | "cinema_streams";
type StagedActionDefinition = {
  action: StagedCatalogAction;
  progressAction: StagedProgressAction;
  kind: "categories" | "items";
  itemType: StagedCatalogItemType;
};
type StagedCinemaActionDefinition = {
  progressAction: "cinema_streams";
  kind: "cinema";
};

const STAGED_ACTIONS_V1: StagedActionDefinition[] = [
  { action: "get_live_categories", progressAction: "live_categories", kind: "categories", itemType: "live" },
  { action: "get_vod_categories", progressAction: "vod_categories", kind: "categories", itemType: "movie" },
  { action: "get_series_categories", progressAction: "series_categories", kind: "categories", itemType: "series" },
  { action: "get_live_streams", progressAction: "live_streams", kind: "items", itemType: "live" },
  { action: "get_vod_streams", progressAction: "vod_streams", kind: "items", itemType: "movie" },
  { action: "get_series", progressAction: "series_streams", kind: "items", itemType: "series" },
];
const STAGED_ACTIONS_V2: Array<StagedActionDefinition | StagedCinemaActionDefinition> = [
  { action: "get_vod_categories", progressAction: "vod_categories", kind: "categories", itemType: "movie" },
  { action: "get_series_categories", progressAction: "series_categories", kind: "categories", itemType: "series" },
  { action: "get_live_categories", progressAction: "live_categories", kind: "categories", itemType: "live" },
  { progressAction: "cinema_streams", kind: "cinema" },
  { action: "get_live_streams", progressAction: "live_streams", kind: "items", itemType: "live" },
];

function stagedActions(version: 1 | 2) {
  return version === 2 ? STAGED_ACTIONS_V2 : STAGED_ACTIONS_V1;
}

function stagedInventoryAction(itemType: StagedCatalogItemType): StagedCatalogAction {
  if (itemType === "movie") return "get_vod_streams";
  if (itemType === "series") return "get_series";
  return "get_live_streams";
}

function nextStagedGatewayState(previous: StagedGatewayState, page: XtreamMetadataPage): StagedGatewayState {
  let spoolToken = previous.spoolToken;
  if (page.spoolToken !== undefined) {
    const nextSpoolToken = cleanCursorToken(page.spoolToken);
    if (nextSpoolToken && spoolToken && nextSpoolToken !== spoolToken) {
      const previousDigest = gatewaySpoolContentDigest(spoolToken);
      const nextDigest = gatewaySpoolContentDigest(nextSpoolToken);
      if (!previousDigest || !nextDigest || previousDigest !== nextDigest) {
        throw new Error("Gateway spool identity changed while paging an action");
      }
    }
    // A null/omitted token never clears a durable build identity. A safe exact-
    // content rebuild may rotate buildId/expiry only when the digest is stable.
    if (nextSpoolToken) spoolToken = nextSpoolToken;
  }
  return { pageCursor: page.nextCursor, spoolToken };
}

function nextCinemaLane(cursor: StagedGenerationCursor): "movie" | "series" | null {
  const movieDone = (cursor.cinemaDoneMask & 1) !== 0;
  const seriesDone = (cursor.cinemaDoneMask & 2) !== 0;
  if (movieDone && seriesDone) return null;
  if (cursor.cinemaTurn === "movie" && !movieDone) return "movie";
  if (cursor.cinemaTurn === "series" && !seriesDone) return "series";
  return movieDone ? "series" : "movie";
}

// Every one of the six Xtream list actions is consumed exactly once as a
// gateway-owned bounded spool. Content actions are intentionally UNFILTERED:
// category endpoints are metadata only and cannot prove that orphaned or
// uncategorized provider rows do not exist.
export async function stageXtreamCredentialCatalogGeneration(input: {
  db: SupabaseClient;
  userId: string;
  sourceId: string;
  transitionId: string;
  generationId: string;
  jobId: string;
  leaseSequence: number;
  leaseOwner: string;
  cursor?: unknown;
  fetchMetadataPage: (request: XtreamMetadataPageRequest) => Promise<XtreamMetadataPage>;
  maxSlices?: number;
  deadlineMs?: number;
}) {
  const generation: BuildingCatalogGeneration = {
    kind: "building",
    generationId: input.generationId,
    transitionId: input.transitionId,
    jobId: input.jobId,
    attempt: input.leaseSequence,
    leaseOwner: input.leaseOwner,
  };
  catalogGenerationFields(generation);
  const cursor = stagedGenerationCursor(input.cursor);
  const actions = stagedActions(cursor.version);
  const maxSlices = boundedInt(input.maxSlices, 1, 1, 8);
  const deadline = Date.now() + boundedInt(input.deadlineMs, 20_000, 1_000, 60_000);
  let slices = 0;

  while (cursor.actionIndex < actions.length && slices < maxSlices && Date.now() < deadline) {
    const definition = actions[cursor.actionIndex];
    const cinemaLane = definition.kind === "cinema" ? nextCinemaLane(cursor) : null;
    if (definition.kind === "cinema" && !cinemaLane) {
      advanceStagedAction(cursor);
      continue;
    }
    const action = definition.kind === "cinema"
      ? stagedInventoryAction(cinemaLane!)
      : definition.action;
    const itemType = definition.kind === "cinema" ? cinemaLane! : definition.itemType;
    const kind = definition.kind === "categories" ? "categories" : "items";
    const gatewayState = definition.kind === "cinema"
      ? (cinemaLane === "movie" ? cursor.cinemaMovie : cursor.cinemaSeries)
      : { pageCursor: cursor.pageCursor, spoolToken: cursor.spoolToken };
    const maxItems = kind === "categories" ? STAGED_CATEGORY_PAGE_SIZE : STAGED_ITEM_PAGE_SIZE;
    const page = validateXtreamMetadataPage(
      await input.fetchMetadataPage({
        action,
        categoryId: null,
        cursor: gatewayState.pageCursor,
        spoolToken: gatewayState.spoolToken,
        maxItems,
      }),
      maxItems,
    );
    if (page.pending) {
      const checkpoint = stagedGenerationCheckpoint(cursor, false);
      return {
        done: false,
        pending: true,
        retryAfterSeconds: page.retryAfterSeconds ?? 2,
        nextCursor: checkpoint,
        checkpoint,
        counts: await stagedGenerationCounts(input.db, input.sourceId, input.userId, input.generationId),
        contentSignature: null,
      };
    }
    slices += 1;

    if (kind === "categories") {
      const categories = normalizeStagedCategories(page.items, cursor.registeredCategoryCount);
      const previousCategoryCount = cursor.registeredCategoryCount;
      await registerStagedCategories(input, generation, itemType, categories);
      cursor.registeredCategoryCount = await stagedCategoryCount(
        input,
        itemType,
        previousCategoryCount,
      );
      cursor.processedCategories += cursor.registeredCategoryCount - previousCategoryCount;
      if (page.done) {
        await markStagedCategoryListComplete(
          input,
          generation,
          itemType,
          cursor.registeredCategoryCount,
        );
      }
    } else {
      const rawItems = page.items.filter(isRecord) as JsonRecord[];
      if (rawItems.length !== page.items.length) throw new Error("Gateway metadata page contains invalid rows");
      const categoryNames = await stagedCategoryNames(input, itemType, rawItems);
      const rows = dedupeByConflictKey(
        xtreamRows(input.sourceId, input.userId, rawItems, itemType, categoryNames),
      );
      if (rows.length) {
        const { error } = await input.db
          .from("cloud_media_items")
          .upsert(withCatalogGenerationRows(rows, generation), {
            onConflict: "source_id,generation_id,item_type,external_id",
            ignoreDuplicates: true,
          });
        if (error) throw error;
        const externalIds = rows.map((row) => stringOr(row.external_id, "")).filter(Boolean);
        const { data: savedData, error: savedError } = await input.db
          .from("cloud_media_items")
          .select("id,user_id,source_id,generation_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,backdrop_url,metadata,playback_hint,available")
          .eq("source_id", input.sourceId)
          .eq("user_id", input.userId)
          .eq("generation_id", input.generationId)
          .eq("item_type", itemType)
          .in("external_id", externalIds);
        if (savedError) throw savedError;
        const savedRows = Array.isArray(savedData) ? savedData as LiveCatalogItem[] : [];
        if (itemType === "live") {
          await materializeLiveChunk(input.db, {
            userId: input.userId,
            sourceId: input.sourceId,
            rows: savedRows,
            generation,
          });
        } else {
          await projectVodTitleGenerationIsolated({
            mode: "building-generation",
            sourceId: input.sourceId,
            userId: input.userId,
            transitionId: input.transitionId,
            rows: savedRows,
            db: input.db,
            generation,
          });
        }
      }
      cursor.currentItemCount = await stagedTypeCount(
        input.db,
        input.sourceId,
        input.userId,
        input.generationId,
        itemType,
      );
      cursor.processedItems = (await stagedGenerationCounts(
        input.db,
        input.sourceId,
        input.userId,
        input.generationId,
      )).total;
      if (page.done) {
        await markStagedParentActionComplete(
          input,
          generation,
          itemType,
          cursor.currentItemCount,
        );
      }
    }

    const nextGatewayState = nextStagedGatewayState(gatewayState, page);
    if (definition.kind === "cinema") {
      if (cinemaLane === "movie") cursor.cinemaMovie = page.done ? { pageCursor: null, spoolToken: null } : nextGatewayState;
      else cursor.cinemaSeries = page.done ? { pageCursor: null, spoolToken: null } : nextGatewayState;
      if (page.done) cursor.cinemaDoneMask |= cinemaLane === "movie" ? 1 : 2;
      cursor.cinemaTurn = cinemaLane === "movie" ? "series" : "movie";
      if (cursor.cinemaDoneMask === 3) advanceStagedAction(cursor);
    } else {
      cursor.pageCursor = nextGatewayState.pageCursor;
      cursor.spoolToken = nextGatewayState.spoolToken;
      if (page.done) advanceStagedAction(cursor);
    }
  }

  // Lazy episode caches are copied mechanically from the previous active
  // generation after all provider inventories. The SQL RPC is bounded and
  // lease-fenced; cloned rows are excluded from catalog identity evidence.
  if (cursor.actionIndex === actions.length && slices < maxSlices && Date.now() < deadline) {
    const clone = await copyStagedLazySeriesCache(input, generation, cursor.copyRevision);
    cursor.copyRevision = clone.copyRevision;
    if (clone.done) cursor.actionIndex += 1;
    slices += 1;
  }

  const done = cursor.actionIndex > actions.length;
  const counts = await stagedGenerationCounts(input.db, input.sourceId, input.userId, input.generationId);
  const checkpoint = stagedGenerationCheckpoint(cursor, done);
  return {
    done,
    nextCursor: done ? null : checkpoint,
    checkpoint,
    counts,
    contentSignature: null,
  };
}

function stagedGenerationCursor(value: unknown): StagedGenerationCursor {
  if (value === undefined || value === null) {
    return {
      version: 2,
      actionIndex: 0,
      pageCursor: null,
      spoolToken: null,
      registeredCategoryCount: 0,
      currentItemCount: 0,
      processedCategories: 0,
      processedItems: 0,
      copyRevision: 0,
      cinemaMovie: { pageCursor: null, spoolToken: null },
      cinemaSeries: { pageCursor: null, spoolToken: null },
      cinemaDoneMask: 0,
      cinemaTurn: "movie",
    };
  }
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    throw new Error("Invalid staged catalog cursor");
  }
  const version = value.version as 1 | 2;
  const actions = stagedActions(version);
  const actionIndex = strictCheckpointInteger(value.typeIndex, actions.length + 1);
  const expectedAction = stagedProgressAction(version, actionIndex);
  if (value.action !== expectedAction) throw new Error("Staged catalog progress action is inconsistent");
  const categoryOrdinal = strictCheckpointInteger(value.categoryOrdinal, 999_999_999);
  const itemOffset = strictCheckpointInteger(value.itemOffset, 999_999_999_999);
  const processedCategories = strictCheckpointInteger(value.processedCategories, 999_999_999);
  const processedItems = strictCheckpointInteger(value.processedItems, 999_999_999_999_999);
  if (
    actionIndex < 0 || categoryOrdinal < 0 || itemOffset < 0 ||
    processedCategories < 0 || processedItems < 0 || typeof value.categoriesDone !== "boolean"
  ) {
    throw new Error("Invalid staged catalog cursor position");
  }
  const expectsCategoriesDone = actionIndex >= 3;
  if (value.categoriesDone !== expectsCategoriesDone) {
    throw new Error("Staged catalog category completion is inconsistent");
  }
  if (version === 2 && actionIndex === 3 && (categoryOrdinal > 3 || itemOffset > 1)) {
    throw new Error("Staged cinema cursor is inconsistent");
  }
  const emptyGateway = { pageCursor: null, spoolToken: null };
  const gatewayCursor = actionIndex < 3
    ? unpackStagedGatewayCursor(value.categoryPageCursor)
    : actionIndex < actions.length && !(version === 2 && actionIndex === 3)
      ? unpackStagedGatewayCursor(value.itemCursor)
      : emptyGateway;
  const cinemaMovie = version === 2 && actionIndex === 3
    ? unpackStagedGatewayCursor(value.categoryPageCursor)
    : emptyGateway;
  const cinemaSeries = version === 2 && actionIndex === 3
    ? unpackStagedGatewayCursor(value.itemCursor)
    : emptyGateway;
  return {
    version,
    actionIndex,
    pageCursor: gatewayCursor.pageCursor,
    spoolToken: gatewayCursor.spoolToken,
    registeredCategoryCount: actionIndex < 3 ? categoryOrdinal : 0,
    currentItemCount: actionIndex === actions.length ? 0 : itemOffset,
    processedCategories,
    processedItems,
    copyRevision: actionIndex === actions.length ? itemOffset : 0,
    cinemaMovie,
    cinemaSeries,
    cinemaDoneMask: version === 2 && actionIndex === 3 ? categoryOrdinal : 0,
    cinemaTurn: version === 2 && actionIndex === 3 && itemOffset === 1 ? "series" : "movie",
  };
}

function validateXtreamMetadataPage(value: unknown, maxItems: number): XtreamMetadataPage {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.done !== "boolean") {
    throw new Error("Gateway must return an explicit bounded metadata page");
  }
  if (value.items.length > maxItems) throw new Error("Gateway metadata page exceeds requested bound");
  if (value.pending === true) {
    if (value.items.length || value.done !== false || cleanCursorToken(value.nextCursor)) {
      throw new Error("Pending gateway metadata page must be empty and cursorless");
    }
    if (
      Object.prototype.hasOwnProperty.call(value, "spoolToken") &&
      cleanCursorToken(value.spoolToken)
    ) {
      throw new Error("Pending gateway metadata page must not replace the durable cursor");
    }
    const retryAfterSeconds = value.retryAfterSeconds === undefined
      ? undefined
      : strictCheckpointInteger(value.retryAfterSeconds, 60);
    if (retryAfterSeconds !== undefined && retryAfterSeconds < 1) {
      throw new Error("Pending gateway retry delay is invalid");
    }
    return {
      items: [],
      done: false,
      nextCursor: null,
      pending: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  if (value.pending !== undefined && value.pending !== false) {
    throw new Error("Gateway metadata pending marker is invalid");
  }
  const nextCursor = cleanCursorToken(value.nextCursor);
  const hasSpoolToken = Object.prototype.hasOwnProperty.call(value, "spoolToken");
  const spoolToken = hasSpoolToken ? cleanCursorToken(value.spoolToken) : undefined;
  if (!value.done && !nextCursor) throw new Error("Incomplete gateway page is missing a continuation cursor");
  if (value.done && nextCursor) throw new Error("Complete gateway page must not expose a continuation cursor");
  return {
    items: value.items,
    done: value.done,
    nextCursor,
    ...(hasSpoolToken ? { spoolToken } : {}),
    ...(value.pending === false ? { pending: false } : {}),
  };
}

function strictCheckpointInteger(value: unknown, max: number) {
  const parsed = typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : -1;
}

function normalizeStagedCategories(items: unknown[], ordinalBase: number): StagedCategory[] {
  const seen = new Set<string>();
  const categories: StagedCategory[] = [];
  for (const item of items) {
    const category = normalizeStagedCategory(item, ordinalBase + categories.length);
    if (!category.id || seen.has(category.id)) continue;
    seen.add(category.id);
    categories.push(category);
  }
  return categories;
}

function normalizeStagedCategory(value: unknown, ordinal: number): StagedCategory {
  if (!isRecord(value)) throw new Error("Gateway category row is invalid");
  const id = stringOr(value.id ?? value.category_id ?? value.categoryId, "").normalize("NFC").trim();
  const name = stringOr(value.name ?? value.category_name ?? value.categoryName, "").normalize("NFC").trim();
  if (!id || id.length > 128 || !name || name.length > 160 || /\p{Cc}/u.test(id + name)) {
    throw new Error("Gateway category row is invalid");
  }
  return { id, name, ordinal };
}

function cleanCursorToken(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("Gateway cursor token is invalid");
  const token = value.trim();
  if (!token || token.length > STAGED_CURSOR_TOKEN_MAX || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("Gateway cursor token is invalid");
  }
  return token;
}

function gatewaySpoolContentDigest(value: unknown) {
  const token = cleanCursorToken(value);
  if (!token) return null;
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(base64));
    const digest = isRecord(decoded) ? String(decoded.d ?? "").toLowerCase() : "";
    return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

function stagedProgressAction(version: 1 | 2, actionIndex: number) {
  const actions = stagedActions(version);
  if (actionIndex < actions.length) return actions[actionIndex].progressAction;
  if (actionIndex === actions.length) return "episode_state_copy";
  return "complete";
}

function packStagedGatewayCursor(pageCursor: string | null, spoolToken: string | null) {
  if (!pageCursor && !spoolToken) return "";
  const bytes = new TextEncoder().encode(JSON.stringify([spoolToken, pageCursor]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  // SQL rejects credential-looking cursor text. A delimiter every four base64url
  // characters makes those >=7-character words structurally impossible while
  // retaining a compact, reversible opaque checkpoint.
  const packed = encoded.match(/.{1,4}/g)?.join(".") ?? "";
  if (packed.length > STAGED_PACKED_CURSOR_MAX) throw new Error("Gateway continuation state exceeds checkpoint bound");
  return packed;
}

function unpackStagedGatewayCursor(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return { pageCursor: null, spoolToken: null };
  }
  const packed = cleanCursorToken(value);
  if (!packed || !/^[A-Za-z0-9_.-]+$/.test(packed)) throw new Error("Staged gateway checkpoint is invalid");
  try {
    const encoded = packed.replace(/\./g, "");
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded) || decoded.length !== 2) throw new Error("invalid shape");
    return {
      spoolToken: cleanCursorToken(decoded[0]),
      pageCursor: cleanCursorToken(decoded[1]),
    };
  } catch {
    throw new Error("Staged gateway checkpoint is invalid");
  }
}

function advanceStagedAction(cursor: StagedGenerationCursor) {
  cursor.actionIndex += 1;
  cursor.pageCursor = null;
  cursor.spoolToken = null;
  cursor.registeredCategoryCount = 0;
  cursor.currentItemCount = 0;
}

function stagedCategoryKind(itemType: StagedCatalogItemType): "live" | "vod" | "series" {
  return itemType === "movie" ? "vod" : itemType;
}

async function registerStagedCategories(
  input: {
    db: SupabaseClient;
    userId: string;
    transitionId: string;
    generationId: string;
    jobId: string;
  },
  generation: BuildingCatalogGeneration,
  itemType: StagedCatalogItemType,
  categories: StagedCategory[],
) {
  if (!categories.length) return;
  const categoryKind = stagedCategoryKind(itemType);
  const { error } = await input.db.rpc("norva_register_credential_generation_categories", {
    p_transition_id: input.transitionId,
    p_user_id: input.userId,
    p_generation_id: input.generationId,
    p_job_id: input.jobId,
    p_worker: generation.leaseOwner,
    p_expected_lease_sequence: generation.attempt,
    p_category_kind: categoryKind,
    // The fenced SQL writer owns idempotence and ordinal allocation. The
    // service role deliberately has no raw-table SELECT privilege here.
    p_categories: categories.map((category) => ({
      category_ordinal: category.ordinal,
      provider_category_id: category.id,
      category_name: category.name,
    })),
  });
  if (error) throw error;
}

async function markStagedCategoryListComplete(
  input: {
    db: SupabaseClient;
    userId: string;
    transitionId: string;
    generationId: string;
    jobId: string;
  },
  generation: BuildingCatalogGeneration,
  itemType: StagedCatalogItemType,
  expectedCount: number,
) {
  const { error } = await input.db.rpc("norva_mark_credential_category_list_complete", {
    p_transition_id: input.transitionId,
    p_user_id: input.userId,
    p_generation_id: input.generationId,
    p_job_id: input.jobId,
    p_worker: generation.leaseOwner,
    p_expected_lease_sequence: generation.attempt,
    p_category_kind: stagedCategoryKind(itemType),
    p_expected_category_count: expectedCount,
  });
  if (error) throw error;
}

async function markStagedParentActionComplete(
  input: {
    db: SupabaseClient;
    userId: string;
    transitionId: string;
    generationId: string;
    jobId: string;
  },
  generation: BuildingCatalogGeneration,
  itemType: StagedCatalogItemType,
  stagedItemCount: number,
) {
  const { error } = await input.db.rpc("norva_mark_credential_parent_action_complete", {
    p_transition_id: input.transitionId,
    p_user_id: input.userId,
    p_generation_id: input.generationId,
    p_job_id: input.jobId,
    p_worker: generation.leaseOwner,
    p_expected_lease_sequence: generation.attempt,
    p_category_kind: stagedCategoryKind(itemType),
    p_action: stagedInventoryAction(itemType),
    p_staged_item_count: stagedItemCount,
  });
  if (error) throw error;
}

async function stagedTypeCount(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  generationId: string,
  itemType: StagedCatalogItemType,
) {
  const { count, error } = await db
    .from("cloud_media_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("generation_id", generationId)
    .eq("item_type", itemType);
  if (error) throw error;
  return count ?? 0;
}

type StagedCategoryReadScope = {
  db: SupabaseClient;
  userId: string;
  transitionId: string;
  generationId: string;
};

const STAGED_CATEGORY_READ_PAGE_SIZE = 500;
const STAGED_CATEGORY_READ_MAX_ROWS = 1_000_000;

type StoredStagedCategory = {
  ordinal: number;
  id: string;
  name: string;
};

async function visitStagedCategories(
  input: StagedCategoryReadScope,
  itemType: StagedCatalogItemType,
  visitor?: (rows: StoredStagedCategory[]) => boolean | void,
  startOffset = 0,
) {
  if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > STAGED_CATEGORY_READ_MAX_ROWS) {
    throw new Error("Stored generation category offset is invalid");
  }
  let offset = startOffset;
  while (offset <= STAGED_CATEGORY_READ_MAX_ROWS) {
    const { data, error } = await input.db.rpc("norva_get_credential_generation_categories", {
      p_transition_id: input.transitionId,
      p_user_id: input.userId,
      p_generation_id: input.generationId,
      p_category_kind: stagedCategoryKind(itemType),
      p_offset: offset,
      p_limit: STAGED_CATEGORY_READ_PAGE_SIZE,
    });
    if (error) throw error;
    if (!Array.isArray(data) || data.length > STAGED_CATEGORY_READ_PAGE_SIZE) {
      throw new Error("Stored generation category page is invalid");
    }
    const rows = data.map((row) => {
      if (!isRecord(row)) throw new Error("Stored generation category row is invalid");
      const ordinal = strictCheckpointInteger(row.category_ordinal, STAGED_CATEGORY_READ_MAX_ROWS - 1);
      const id = stringOr(row.provider_category_id, "");
      const name = stringOr(row.category_name, "");
      if (ordinal < 0 || !id || id.length > 128 || !name || name.length > 160 || /\p{Cc}/u.test(id + name)) {
        throw new Error("Stored generation category row is invalid");
      }
      return { ordinal, id, name };
    });
    if (offset + rows.length > STAGED_CATEGORY_READ_MAX_ROWS) {
      throw new Error("Stored generation categories exceed the supported bound");
    }
    const keepReading = visitor?.(rows);
    offset += rows.length;
    if (keepReading === false || rows.length < STAGED_CATEGORY_READ_PAGE_SIZE) return offset;
    if (offset === STAGED_CATEGORY_READ_MAX_ROWS) {
      // One final empty page distinguishes an exactly-full bounded inventory
      // from an over-limit provider inventory without materializing it.
      continue;
    }
  }
  throw new Error("Stored generation categories exceed the supported bound");
}

async function stagedCategoryCount(
  input: StagedCategoryReadScope,
  itemType: StagedCatalogItemType,
  knownPrefixCount = 0,
) {
  // The checkpoint is an already-committed prefix. Resume at that offset so a
  // million-category inventory remains O(new rows), including register-before-
  // checkpoint crash replay. The fenced completion RPC verifies the final count.
  return await visitStagedCategories(input, itemType, undefined, knownPrefixCount);
}

async function stagedCategoryNames(
  input: StagedCategoryReadScope,
  itemType: StagedCatalogItemType,
  rawItems: JsonRecord[],
) {
  const ids = [...new Set(rawItems
    .map((item) => stringOr(item.category_id ?? item.categoryId, ""))
    .filter(Boolean))];
  if (!ids.length) return new Map<string, string>();
  const wanted = new Set(ids);
  const names = new Map<string, string>();
  await visitStagedCategories(input, itemType, (rows) => {
    for (const row of rows) {
      if (wanted.has(row.id)) names.set(row.id, row.name);
    }
    return names.size < wanted.size;
  });
  return names;
}

async function copyStagedLazySeriesCache(
  input: {
    db: SupabaseClient;
    userId: string;
    transitionId: string;
    generationId: string;
    jobId: string;
  },
  generation: BuildingCatalogGeneration,
  copyRevision: number,
) {
  const { data, error } = await input.db.rpc("norva_copy_credential_generation_episode_state", {
    p_transition_id: input.transitionId,
    p_user_id: input.userId,
    p_generation_id: input.generationId,
    p_job_id: input.jobId,
    p_worker: generation.leaseOwner,
    p_expected_lease_sequence: generation.attempt,
    p_expected_copy_revision: copyRevision,
    p_limit: 200,
  });
  if (error) throw error;
  const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  const nextRevision = strictCheckpointInteger(result.copyRevision, Number.MAX_SAFE_INTEGER);
  if (typeof result.complete !== "boolean" || nextRevision !== copyRevision + 1) {
    throw new Error("Invalid lazy series cache copy result");
  }
  return { done: result.complete, copyRevision: nextRevision };
}

function stagedGenerationCheckpoint(cursor: StagedGenerationCursor, done: boolean) {
  const actions = stagedActions(cursor.version);
  const action = done ? "complete" : stagedProgressAction(cursor.version, cursor.actionIndex);
  const current = cursor.actionIndex < actions.length ? actions[cursor.actionIndex] : null;
  const packedCursor = current && current.kind !== "cinema"
    ? packStagedGatewayCursor(cursor.pageCursor, cursor.spoolToken)
    : "";
  if (cursor.version === 1) {
    return {
      version: 1,
      action,
      typeIndex: cursor.actionIndex,
      categoryOrdinal: current?.kind === "categories" ? cursor.registeredCategoryCount : 0,
      itemOffset: cursor.actionIndex === actions.length
        ? cursor.copyRevision
        : current?.kind === "items"
          ? cursor.currentItemCount
          : 0,
      categoryPageCursor: current?.kind === "categories" ? packedCursor : "",
      categoriesDone: cursor.actionIndex >= 3,
      itemCursor: current?.kind === "items" ? packedCursor : "",
      processedCategories: cursor.processedCategories,
      processedItems: cursor.processedItems,
    };
  }
  const cinemaActive = current?.kind === "cinema";
  return {
    version: 2,
    action,
    typeIndex: cursor.actionIndex,
    categoryOrdinal: current?.kind === "categories"
      ? cursor.registeredCategoryCount
      : cinemaActive
        ? cursor.cinemaDoneMask
        : 0,
    itemOffset: cursor.actionIndex === actions.length
      ? cursor.copyRevision
      : cinemaActive
        ? cursor.cinemaTurn === "series" ? 1 : 0
      : current?.kind === "items"
        ? cursor.currentItemCount
        : 0,
    categoryPageCursor: cinemaActive
      ? packStagedGatewayCursor(cursor.cinemaMovie.pageCursor, cursor.cinemaMovie.spoolToken)
      : current?.kind === "categories" ? packedCursor : "",
    categoriesDone: cursor.actionIndex >= 3,
    itemCursor: cinemaActive
      ? packStagedGatewayCursor(cursor.cinemaSeries.pageCursor, cursor.cinemaSeries.spoolToken)
      : current?.kind === "items" ? packedCursor : "",
    processedCategories: cursor.processedCategories,
    processedItems: cursor.processedItems,
  };
}

async function stagedGenerationCounts(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  generationId: string,
) {
  const counts: Record<StagedCatalogItemType, number> = { live: 0, movie: 0, series: 0 };
  for (const itemType of ["live", "movie", "series"] as const) {
    const { count, error } = await db
      .from("cloud_media_items")
      .select("id", { count: "exact", head: true })
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .eq("generation_id", generationId)
      .eq("item_type", itemType);
    if (error) throw error;
    counts[itemType] = count ?? 0;
  }
  return {
    live: counts.live,
    movies: counts.movie,
    series: counts.series,
    total: counts.live + counts.movie + counts.series,
  };
}

// ── Provider-helper copies (verbatim from norva-source-sync) ─────────────────

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) return runtimeConfigCache.value;
  let sourceConfigKey = ENV_SOURCE_CONFIG_KEY;
  let mediaGatewayUrl = ENV_MEDIA_GATEWAY_URL;
  let mediaGatewayToken = ENV_MEDIA_GATEWAY_TOKEN;
  if (!sourceConfigKey || !mediaGatewayUrl || !mediaGatewayToken) {
    const { data, error } = await db
      .from("cloud_runtime_config")
      .select("key, value")
      .in("key", ["NORVA_SOURCE_CONFIG_KEY", "NORVA_MEDIA_GATEWAY_URL", "NORVA_MEDIA_GATEWAY_TOKEN"]);
    if (error) console.warn("[xtream-sync] runtime config unavailable", error.message);
    for (const item of data ?? []) {
      if (typeof item.value !== "string" || !item.value) continue;
      if (item.key === "NORVA_SOURCE_CONFIG_KEY" && !sourceConfigKey) sourceConfigKey = item.value;
      else if (item.key === "NORVA_MEDIA_GATEWAY_URL" && !mediaGatewayUrl) mediaGatewayUrl = item.value.replace(/\/+$/, "");
      else if (item.key === "NORVA_MEDIA_GATEWAY_TOKEN" && !mediaGatewayToken) mediaGatewayToken = item.value;
    }
  }
  const value = { sourceConfigKey, mediaGatewayUrl, mediaGatewayToken };
  runtimeConfigCache = { value, expiresAt: Date.now() + 30_000 };
  return value;
}

async function decryptSourceConfig(ciphertext: string, runtimeConfig: RuntimeConfig): Promise<JsonRecord> {
  if (!runtimeConfig.sourceConfigKey) throw new HttpError(503, "Norva Cloud source encryption is not configured");
  const [scheme, version, ivPart, dataPart] = ciphertext.split(".");
  if (scheme !== "aesgcm" || version !== "v1" || !ivPart || !dataPart) {
    throw new HttpError(500, "Unsupported source config format");
  }
  const key = await aesKey(runtimeConfig.sourceConfigKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(ivPart) },
    key,
    base64UrlToBytes(dataPart),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isRecord(parsed)) throw new HttpError(500, "Invalid source config payload");
  return parsed;
}

async function aesKey(secret: string) {
  let material = base64UrlToBytes(secret);
  if (material.byteLength !== 32) {
    material = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  }
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function fetchJson(url: string, timeoutMs: number) {
  try {
    const { response, value: payload } = await fetchBoundedProviderJson(url, {
      timeoutMs,
      maxBytes: 32 * 1024 * 1024,
      headers: { "User-Agent": "NorvaCloud/1.0" },
    });
    if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof BoundedProviderResponseError && error.kind === "too_large") {
      throw new HttpError(413, "Provider JSON payload is too large");
    }
    if (error instanceof BoundedProviderResponseError && error.kind === "timeout") {
      throw new HttpError(504, "IPTV provider response deadline exceeded");
    }
    throw new HttpError(502, "Unable to reach IPTV provider");
  }
}

// Fetch Xtream catalogue/VOD metadata, preferring the media gateway so the crawl
// reaches the provider from the SAME tolerated IP as streaming. A direct fetch
// from this Supabase edge runtime egresses a provider-BLOCKED datacenter IP —
// both a user_multi_ip trigger and, for blocked ranges, an outright sync failure
// (empty catalogue). Falls back to a direct fetch only on gateway-side problems
// (missing route / unreachable / timeout), never on provider-origin errors.
// deno-lint-ignore no-explicit-any
async function fetchProviderMetadata(
  runtimeConfig: RuntimeConfig,
  args: { serverUrl: string; username: string; password: string; action: string; params?: Record<string, string>; timeoutMs?: number },
  directFallback: DirectFallbackLeaseContext,
): Promise<any> {
  const timeoutMs = args.timeoutMs ?? 25000;
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestGatewayMetadata(runtimeConfig, args, Math.max(timeoutMs + 10000, 45000));
      } catch (error) {
        if (isGatewayBackgroundBusy(error)) {
          if (attempt < GATEWAY_BUSY_RETRY_DELAYS_MS.length) {
            await new Promise((resolve) => setTimeout(resolve, GATEWAY_BUSY_RETRY_DELAYS_MS[attempt]));
            continue;
          }
          throw new HttpError(503, "Media gateway is busy; retry catalog sync", { code: "background_busy" });
        }
        const status = error instanceof HttpError ? error.status : 502;
        if (![404, 405, 502, 503, 504].includes(status)) throw error;
        console.warn("[xtream-sync] gateway metadata unavailable, falling back to direct", args.action, status);
        break;
      }
    }
  }
  try {
    return await directFallback.runDirectFallback(timeoutMs, () => fetchJson(
      xtreamApiUrl({ serverUrl: args.serverUrl, username: args.username, password: args.password, action: args.action }, args.params ?? {}),
      timeoutMs,
    ));
  } catch (error) {
    if (error instanceof ProviderDirectFallbackLeaseError) {
      throw new HttpError(error.status, error.message, error.details);
    }
    throw error;
  }
}

function isGatewayBackgroundBusy(error: unknown) {
  if (!(error instanceof HttpError) || error.status !== 429) return false;
  const details = recordOrEmpty(error.details);
  const nested = recordOrEmpty(details.details);
  return stringOr(details.code ?? nested.code, "") === "background_busy";
}

function isProviderViewerPriority(error: unknown) {
  if (!(error instanceof HttpError) || error.status !== 409) return false;
  const details = recordOrEmpty(error.details);
  const nested = recordOrEmpty(details.details);
  const code = stringOr(details.code ?? nested.code, "").toLowerCase();
  if (["account_busy", "provider_account_busy", "viewer_preempted"].includes(code)) return true;
  const reason = stringOr(
    details.error ?? details.message ?? nested.error ?? nested.message,
    "",
  ).toLowerCase();
  return /\b(account|provider)[ _-]*busy\b|\bactive playback\b|\bviewer[ _-]*preempted\b/.test(reason);
}

async function requestGatewayMetadata(
  runtimeConfig: RuntimeConfig,
  args: { serverUrl: string; username: string; password: string; action: string; params?: Record<string, string> },
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${runtimeConfig.mediaGatewayUrl}/xtream/metadata`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.mediaGatewayToken}`,
      },
      body: JSON.stringify({
        serverUrl: args.serverUrl,
        username: args.username,
        password: args.password,
        action: args.action,
        params: args.params ?? {},
        userAgent: "VLC/3.0.20 LibVLC/3.0.20",
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new HttpError(response.status, "Media gateway refused the metadata request", payload);
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new HttpError(aborted ? 504 : 502, "Unable to reach media gateway", error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timer);
  }
}

function xtreamApiUrl(config: {
  serverUrl: string;
  username: string;
  password: string;
  action?: string;
}, params: Record<string, string> = {}) {
  const url = new URL(`${normalizeBaseUrl(config.serverUrl)}/player_api.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  if (config.action) url.searchParams.set("action", config.action);
  // Forward request params (e.g. category_id) so the direct fallback fetches the
  // same per-category slice the gateway does — never the full, OOM-prone list.
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.href;
}

function normalizeBaseUrl(value: string) {
  const trimmed = trimTrailingSlash(value.trim());
  assertHttpUrl(trimmed);
  return trimmed;
}

function assertHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported protocol");
  } catch {
    throw new HttpError(400, "URL must be a valid http(s) URL");
  }
}

// ── Private util copies (verbatim from norva-source-sync) ────────────────────

function mergeSyncProgress(current: JsonRecord, patch: JsonRecord) {
  const merged = compactRecord({
    ...current,
    ...patch,
    steps: {
      ...recordOrEmpty(current.steps),
      ...recordOrEmpty(patch.steps),
    },
    counts: {
      ...recordOrEmpty(current.counts),
      ...recordOrEmpty(patch.counts),
    },
    categories: {
      ...recordOrEmpty(current.categories),
      ...recordOrEmpty(patch.categories),
    },
  });
  if ("percent" in current || "percent" in patch) {
    merged.percent = Math.max(
      boundedProgressPercent(current.percent),
      boundedProgressPercent(patch.percent),
    );
  }
  for (const flag of ["moviesReady", "seriesReady", "liveReady", "browseReady", "usable"]) {
    if (current[flag] === true || patch[flag] === true) merged[flag] = true;
  }
  return merged;
}

function boundedProgressPercent(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compactRecord(value: JsonRecord) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function recordOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringOr(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function stringOrNull(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function throwDb(error: { message?: string; details?: string; hint?: string }, message: string): never {
  throw new HttpError(500, message, {
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}
