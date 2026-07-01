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
// Public exports: driveXtreamSyncToReady, freshSyncCursor, detectXtreamChange.
// Everything else is private to this module.
// ─────────────────────────────────────────────────────────────────────────────
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = { sourceConfigKey: string; mediaGatewayUrl: string; mediaGatewayToken: string };

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

const DISCOVER_TYPES: { type: "live" | "movie" | "series"; action: string }[] = [
  { type: "live", action: "get_live_streams" },
  { type: "movie", action: "get_vod_streams" },
  { type: "series", action: "get_series" },
];
const DISCOVER_CONCURRENCY = 14;
// Work budget per isolate. Kept well under the runtime's background wall-clock so
// the self-invoke (which spawns the next isolate) always lands before recycle.
const SYNC_DRIVE_BUDGET_MS = 90_000;
const SYNC_MAX_CONTINUATIONS = 160;
// Layer 3 prune safety: a healthy refresh removes only a few vanished titles. If a completed run
// would delete more than this fraction of the catalogue, treat the discovery as untrustworthy
// (provider outage / soft-expiry returning a thin list) and KEEP the prior items instead.
const PRUNE_MAX_REMOVE_FRACTION = 0.5;

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
    await db.from("cloud_import_notifications")
      .upsert([{ user_id: userId, source_id: sourceId, kind, payload }], { onConflict: "source_id,kind", ignoreDuplicates: true });
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
    await db.rpc("norva_resolve_provider_identity", {
      p_source_id: sourceId,
      p_provider_key: providerKey,
      p_display_name: name,
    });
  } catch (_) { /* best-effort */ }
}

export function freshSyncCursor(startedAt: string, extra: JsonRecord = {}): JsonRecord {
  return {
    v: 1,
    active: true,
    phase: "discover",
    deleted: false,
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
async function appendSourceItems(sourceId: string, userId: string, rows: JsonRecord[], db: SupabaseClient, runVersion: number | null = null): Promise<number> {
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
    const payload = runVersion == null ? chunk : chunk.map((r) => ({ ...r, catalog_version: runVersion }));
    const res = await withDbRetry(
      () => db.from("cloud_media_items").upsert(payload, { onConflict: "source_id,item_type,external_id", ignoreDuplicates: true, count: "exact" }),
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
          () => db.from("cloud_media_items").update({ catalog_version: runVersion })
            .eq("source_id", sourceId).eq("user_id", userId).eq("item_type", itemType).in("external_id", ids),
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
async function countSeenByType(sourceId: string, userId: string, version: number, db: SupabaseClient) {
  const out: Record<string, number> = { live: 0, movie: 0, series: 0 };
  for (const t of ["live", "movie", "series"]) {
    const { count, error } = await db
      .from("cloud_media_items")
      .select("id", { count: "exact", head: true })
      .eq("source_id", sourceId).eq("user_id", userId).eq("item_type", t).eq("catalog_version", version);
    if (error) throwDb(error, "Unable to count discovered catalog items");
    out[t] = count || 0;
  }
  return { live: out.live, movie: out.movie, series: out.series };
}

// Total rows currently held for the source (any version). seenTotal subtracted from this gives the
// count that WOULD be pruned — used to refuse an implausibly-large removal. NB: named distinctly from
// the finalize-side countSourceItems(…, progress) above — a duplicate top-level `function` name is a
// SyntaxError in a Deno ES module (boots the whole function to 503), which esbuild does NOT flag.
async function countSourceItemsTotal(sourceId: string, userId: string, db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from("cloud_media_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId).eq("user_id", userId);
  if (error) throwDb(error, "Unable to count catalog items");
  return count || 0;
}

// Delete the rows a healthy run did NOT re-see (provider-removed titles), via the batched RPC.
async function pruneStaleSourceItems(sourceId: string, userId: string, version: number, db: SupabaseClient): Promise<number> {
  let removed = 0;
  for (let guard = 0; guard < 5000; guard++) {
    const { data, error } = await db.rpc("prune_stale_source_items", {
      p_source: sourceId, p_user: userId, p_version: version, p_limit: 2000,
    });
    if (error) throwDb(error, "Unable to prune removed catalog items");
    const n = Number(Array.isArray(data) ? data[0] : data) || 0;
    removed += n;
    if (n < 2000) return removed;
  }
  return removed;
}

// Clear a source's items in bounded chunks. Uses a server-side batched-delete RPC (subquery LIMIT)
// rather than SELECT-ids → .delete().in('id', [...]): a 2000-element IN list builds a ~74KB request
// URL that PostgREST/proxy rejects, which made clearing a large catalogue (100k+ rows) fail
// deterministically and strand the whole sync. The RPC deletes a chunk in ~0.7s incl. FK cascades.
async function deleteSourceItems(sourceId: string, userId: string, db: SupabaseClient) {
  for (let guard = 0; guard < 5000; guard++) {
    const { data, error } = await db.rpc("delete_source_items_batch", {
      p_source: sourceId, p_user: userId, p_limit: 2000,
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
): Promise<JsonRecord> {
  const runtimeConfig = await getRuntimeConfig(db);
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = stringOr(config.username, "");
  const password = stringOr(config.password, "");
  if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");
  const fetchCatalog = (action: string, params?: Record<string, string>) =>
    fetchProviderMetadata(runtimeConfig, { serverUrl, username, password, action, params, timeoutMs: 25000 }).catch(() => []);
  const [liveCats, vodCats, seriesCats] = await Promise.all([
    fetchCatalog("get_live_categories"),
    fetchCatalog("get_vod_categories"),
    fetchCatalog("get_series_categories"),
  ]);
  const maps: Record<string, Map<string, string>> = {
    live: categoryMap(liveCats),
    movie: categoryMap(vodCats),
    series: categoryMap(seriesCats),
  };
  const sig = emptySig();
  let liveCount = 0, movieCount = 0, seriesCount = 0;
  for (const def of DISCOVER_TYPES) {
    const ids = [...maps[def.type].keys()];
    const targets: (Record<string, string> | undefined)[] = ids.length ? ids.map((id) => ({ category_id: id })) : [undefined];
    for (let i = 0; i < targets.length; i += DISCOVER_CONCURRENCY) {
      const slices = await Promise.all(targets.slice(i, i + DISCOVER_CONCURRENCY).map((p) => fetchCatalog(def.action, p)));
      for (const slice of slices) {
        if (!Array.isArray(slice) || !slice.length) continue;
        for (const raw of slice) {
          if (!isRecord(raw)) continue;
          const ext = stringOr(raw.stream_id ?? raw.series_id ?? raw.id, "");
          if (!ext) continue;
          updateSig(sig, def.type, ext, Number(raw.added));
          if (def.type === "live") liveCount++;
          else if (def.type === "movie") movieCount++;
          else seriesCount++;
        }
      }
    }
  }
  const contentSignature = finalizeSig(sig);
  const providerKey = await providerKeyFromCategoryMaps(maps);
  await recordProviderIdentity(db, sourceId, userId, providerKey);
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
  const deadline = Date.now() + SYNC_DRIVE_BUDGET_MS;
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) { console.error("[xtream-sync] sync driver load failed", sourceId, error.message); return; }
  if (!source) return;
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
  };

  try {
    // Watchdog revival: this isolate is restarting a source the watchdog found
    // stalled or errored (status != "syncing"). Clear the error AND reset the
    // continuation budget FIRST, so a discovery that previously exhausted the
    // budget (or hit a non-503 error) gets a fresh run instead of immediately
    // re-tripping the cap just below.
    if (String(source.sync_status) !== "syncing") {
      cursor.attempts = 0;
      await db.from("cloud_sources").update({ sync_status: "syncing", sync_error: null }).eq("id", sourceId).eq("user_id", userId);
    }
    // Global admission control: cap concurrent heavy imports (see admitHeavyImport). The
    // source is "syncing" now, so deferring here parks it for the 1-min watchdog — checked
    // BEFORE the attempts increment so a queued source never burns its continuation budget.
    if (!(await admitHeavyImport(db, sourceId, source.created_at ? String(source.created_at) : null, heavyImportBudget()))) {
      return; // queued — resumed when an older import finishes
    }
    cursor.attempts = (Number(cursor.attempts) || 0) + 1;
    if (Number(cursor.attempts) > SYNC_MAX_CONTINUATIONS) {
      throw new HttpError(500, "Catalog sync exceeded its continuation budget");
    }

    const runtimeConfig = await getRuntimeConfig(db);
    const config = await decryptSourceConfig(String(source.config_ciphertext), runtimeConfig);
    const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
    const username = stringOr(config.username, "");
    const password = stringOr(config.password, "");
    if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");
    // A provider error here used to be silently swallowed to [] — which let a rate-limited /
    // expired account look like a legitimately-empty catalogue and decimate it. Count the failures
    // so the Layer 3 prune can refuse to run on an unhealthy discovery (cursor.fetchErrors).
    const fetchCatalog = (action: string, params?: Record<string, string>) =>
      fetchProviderMetadata(runtimeConfig, { serverUrl, username, password, action, params, timeoutMs: 25000 })
        .catch(() => { cursor.fetchErrors = (Number(cursor.fetchErrors) || 0) + 1; return []; });

    const [liveCats, vodCats, seriesCats] = await Promise.all([
      fetchCatalog("get_live_categories"),
      fetchCatalog("get_vod_categories"),
      fetchCatalog("get_series_categories"),
    ]);
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
      await deleteSourceItems(sourceId, userId, db);
      cursor.deleted = true;
      await enqueueImportNotification(db, userId, sourceId, "import_started");
      await persist(discoverStartedPatch);
      if (superseded) return;
    }

    const counts = recordOrEmpty(cursor.counts);
    let liveCount = Number(counts.live) || 0;
    let movieCount = Number(counts.movies) || 0;
    let seriesCount = Number(counts.series) || 0;
    let typeIdx = Number(cursor.typeIdx) || 0;
    let catIdx = Number(cursor.catIdx) || 0;
    // Snapshot the walk position so we can tell, at the end of this isolate,
    // whether real progress was made (and reset the continuation budget if so).
    const startTypeIdx = typeIdx;
    const startCatIdx = catIdx;

    const targetsFor = (type: string): (Record<string, string> | undefined)[] => {
      const ids = asStringArray(cats[type]);
      return ids.length ? ids.map((id) => ({ category_id: id })) : [undefined];
    };
    const totalTargets = DISCOVER_TYPES.reduce((sum, d) => sum + targetsFor(d.type).length, 0);
    const completedTargets = () => {
      let done = catIdx;
      for (let i = 0; i < typeIdx; i++) done += targetsFor(DISCOVER_TYPES[i].type).length;
      return done;
    };

    let sincePersist = 0;
    while (Date.now() < deadline && typeIdx < DISCOVER_TYPES.length) {
      const def = DISCOVER_TYPES[typeIdx];
      const targets = targetsFor(def.type);
      if (catIdx >= targets.length) { typeIdx++; catIdx = 0; continue; }
      const batch = targets.slice(catIdx, catIdx + DISCOVER_CONCURRENCY);
      const slices = await Promise.all(batch.map((p) => fetchCatalog(def.action, p)));
      const rawRows: JsonRecord[] = [];
      for (const slice of slices) {
        if (!Array.isArray(slice) || !slice.length) continue;
        const r = xtreamRows(sourceId, userId, slice as JsonRecord[], def.type, nameMaps[def.type]);
        for (const row of r) rawRows.push(row);
      }
      // Collapse cross-category duplicates before counting/signing/upserting.
      const batchRows = dedupeByConflictKey(rawRows);
      for (const row of batchRows) {
        updateSig(sig, def.type, stringOr(row.external_id, ""), Number(recordOrEmpty(row.metadata).added));
      }
      if (batchRows.length) {
        // Count only rows the upsert ACTUALLY inserted — a stream already imported
        // from another category in a prior iteration is dropped (ignoreDuplicates),
        // so cross-category duplicates no longer inflate the "found" counts/totalVod.
        const insertedNow = await appendSourceItems(sourceId, userId, batchRows, db, cursor.runVersion ? Number(cursor.runVersion) : null);
        if (def.type === "live") liveCount += insertedNow;
        else if (def.type === "movie") movieCount += insertedNow;
        else seriesCount += insertedNow;
      }
      catIdx += batch.length;
      if (catIdx >= targets.length) { typeIdx++; catIdx = 0; }
      cursor.typeIdx = typeIdx;
      cursor.catIdx = catIdx;
      cursor.counts = { live: liveCount, movies: movieCount, series: seriesCount };
      cursor.sig = sig;
      sincePersist++;
      if (sincePersist >= 4 || Date.now() >= deadline) {
        sincePersist = 0;
        const percent = Math.max(18, Math.min(57, 18 + Math.round((39 * completedTargets()) / Math.max(1, totalTargets))));
        await persist({
          stage: "discovering",
          percent,
          counts: { live: liveCount, movies: movieCount, series: seriesCount, total: liveCount + movieCount + seriesCount },
        });
      }
      if (superseded) return;
    }

    // Real progress this isolate → reset the continuation budget so only a
    // genuinely stuck (zero-progress) loop can ever trip SYNC_MAX_CONTINUATIONS.
    // A healthy large import self-invokes hundreds of times and must never
    // self-abort just for being big.
    if (typeIdx !== startTypeIdx || catIdx !== startCatIdx) cursor.attempts = 0;

    if (typeIdx < DISCOVER_TYPES.length) {
      await persist(null);
      if (superseded) return;
      await selfInvokeSyncStep(sourceId);
      return;
    }

    // Layer 3: recompute authoritative per-type totals from the table (DO UPDATE inflates the
    // running counts via cross-category re-touches), then decide whether it's safe to prune.
    if (cursor.runVersion) {
      const seen = await countSeenByType(sourceId, userId, Number(cursor.runVersion), db);
      liveCount = seen.live; movieCount = seen.movie; seriesCount = seen.series;
    }
    const total = liveCount + movieCount + seriesCount;

    if (total <= 0) {
      // A versioned REFRESH that re-saw nothing (provider down / rate-limited) must not nuke the
      // prior catalogue nor flip to "error" (which the 1-min watchdog would re-hammer). If we still
      // hold items from a previous run, keep serving them and finish quietly without touching the
      // signature. Only a genuinely empty FIRST sync (no prior items) is a real failure.
      if (cursor.runVersion) {
        const existing = await countSourceItemsTotal(sourceId, userId, db);
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
      const totalHeld = await countSourceItemsTotal(sourceId, userId, db);
      const wouldRemove = Math.max(0, totalHeld - total);
      const fetchErrors = Number(cursor.fetchErrors) || 0;
      const removeFraction = wouldRemove / Math.max(1, totalHeld);
      const healthy = fetchErrors === 0 && removeFraction <= PRUNE_MAX_REMOVE_FRACTION;
      if (healthy) {
        if (wouldRemove > 0) {
          // Single-flight guard, re-checked immediately before the DELETE: a force re-sync that
          // started while we finished discovery would be re-stamping rows with ITS runVersion, and
          // pruning "version != ours" would delete those fresh rows. Bail if we no longer own the
          // cursor — the superseding run will prune at its own completion.
          const { data: guardFresh } = await db
            .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
          if (stringOr(recordOrEmpty(recordOrEmpty(guardFresh?.config_hint).syncCursor).startedAt, myRun) !== myRun) return;
          const removed = await pruneStaleSourceItems(sourceId, userId, Number(cursor.runVersion), db);
          console.log("[xtream-sync] Layer3 pruned removed titles", sourceId, "removed", removed);
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
    await recordProviderIdentity(db, sourceId, userId, providerKey);
    await db
      .from("cloud_sources")
      .update({
        config_hint: compactRecord(finalHint),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);

    // "What's new" feed: record a capped event when the catalogue grew.
    await maybeRecordContentEvent(db, userId, sourceId, previousSignature, {
      contentSignature,
      live: liveCount,
      movies: movieCount,
      series: seriesCount,
      total,
    });
    // Discovery done → kick the self-continuing finalize driver so a huge
    // catalogue materialises to "ready" hands-off (the client's ~160-call loop
    // can't finish one); idempotent with the client poll if the app is open.
    await selfInvokeFinalize(sourceId, stringOrNull(cursor.country));
  } catch (err) {
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
    const message = err instanceof Error ? err.message : "Source sync failed";
    console.error("[xtream-sync] sync driver failed", sourceId, message);
    const failedAt = new Date().toISOString();
    const { data: fresh } = await db
      .from("cloud_sources").select("config_hint").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    const freshHint = recordOrEmpty(fresh?.config_hint);
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: failedAt,
        config_hint: compactRecord({
          ...freshHint,
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
  const response = await fetchWithTimeout(url, timeoutMs);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed", payload);
  return payload;
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
): Promise<any> {
  const timeoutMs = args.timeoutMs ?? 25000;
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    try {
      return await requestGatewayMetadata(runtimeConfig, args, Math.max(timeoutMs + 10000, 45000));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[xtream-sync] gateway metadata unavailable, falling back to direct", args.action, status);
    }
  }
  return fetchJson(
    xtreamApiUrl({ serverUrl: args.serverUrl, username: args.username, password: args.password, action: args.action }, args.params ?? {}),
    timeoutMs,
  );
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

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "NorvaCloud/1.0" },
    });
  } catch (error) {
    throw new HttpError(502, "Unable to reach IPTV provider", error instanceof Error ? error.message : undefined);
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
