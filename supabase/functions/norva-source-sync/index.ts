import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildLiveMaterializationPlan,
  clearLiveMaterialization,
  fetchLiveChannelIdMap,
  refreshMaterializedLiveCatalog,
  upsertLiveChannelRows,
  upsertLiveVariantRows,
} from "../_shared/live-materialization.ts";
import { refreshVodTitleProjection } from "../_shared/vod-title-projection.ts";
import type { LiveCatalogItem } from "../_shared/live-catalog.ts";
import { getEntitlementDecision, planFeatureEntitled, realPlanCode } from "../_shared/entitlements.ts";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = { sourceConfigKey: string };

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
const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva.tv",
  "https://www.norva.tv",
  "https://norva-eight.vercel.app",
  "https://norva-pgkk.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:4173",
];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ??
  "";
const ENV_SOURCE_CONFIG_KEY = Deno.env.get("NORVA_SOURCE_CONFIG_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "health") {
      return json(req, { ok: true, service: "norva-source-sync", version: 7, liveMaterialization: true, syncProgress: true, catalogFinalize: true, catalogFinalizeBatches: true, liveFinalizeBatches: true });
    }
    // Premium per-user background refresh (pg_cron → here). Drives a small batch
    // of due, entitled sources through the same sync state machine — locked,
    // backed-off and change-detection-cheap. Dormant until a user is actually
    // entitled to auto_refresh_background.
    //
    // Authorized by a dedicated cron secret that lives only in Vault (single
    // source of truth — never in this repo, an env var, or the pg_cron command).
    // pg_cron pulls it from Vault and sends it as the bearer; here we verify it
    // via a service_role-only SECURITY DEFINER function that returns just a
    // boolean, so the secret never leaves the database. The service key still
    // works as an admin fallback for manual triggering.
    if (req.method === "POST" && segments[0] === "cron") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      let authorized = SUPABASE_SERVICE_KEY !== "" && token === SUPABASE_SERVICE_KEY;
      if (!authorized && token) {
        const { data: ok } = await supabase.rpc("norva_verify_cron_secret", { presented: token });
        authorized = ok === true;
      }
      if (!authorized) {
        return json(req, { error: "forbidden" }, 403);
      }
      if (segments[1] === "refresh-due") {
        return json(req, await cronRefreshDue(supabase));
      }
      // Service-authed finalize drivers (no user session), for recovering a
      // source whose client-side finalize was interrupted:
      //  • /cron/finalize/:id       — best-effort budget-bounded loop in ONE
      //    isolate. Fine for small sources; a big catalogue can exhaust the
      //    isolate's CPU mid-rebuild, so prefer the stepper below for those.
      //  • /cron/finalize-step/:id  — runs exactly ONE finalize batch and returns
      //    the next {nextPhase, nextOffset}. Call it in a loop (each call a fresh
      //    isolate, like the client) to materialize a large source reliably.
      if (segments[1] === "finalize" && segments[2]) {
        return json(req, await cronFinalizeSource(supabase, segments[2], url.searchParams.get("country")));
      }
      if (segments[1] === "finalize-step" && segments[2]) {
        const { data: src } = await supabase.from("cloud_sources").select("user_id").eq("id", segments[2]).maybeSingle();
        if (!src) return json(req, { error: "source not found" }, 404);
        const result = await finalizeCloudSource(segments[2], String(src.user_id), supabase, {
          country: url.searchParams.get("country"),
          phase: stringOr(url.searchParams.get("phase"), "live"),
          offset: Number(url.searchParams.get("offset")) || 0,
          limit: Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1500)),
        });
        return json(req, result);
      }
      return json(req, { error: "not_found" }, 404);
    }
    if (req.method === "POST" && segments[0] === "sources" && segments[2] === "sync") {
      const user = await requireUser(req, supabase);
      const force = url.searchParams.get("force") === "1";
      const result = await syncCloudSource(segments[1], user.id, supabase, url.searchParams.get("country"), { force });
      return json(req, result);
    }
    if (req.method === "POST" && segments[0] === "sources" && segments[2] === "finalize") {
      const user = await requireUser(req, supabase);
      const result = await finalizeCloudSource(segments[1], user.id, supabase, {
        country: url.searchParams.get("country"),
        phase: stringOr(url.searchParams.get("phase"), "live"),
        offset: boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000),
        limit: boundedInt(url.searchParams.get("limit"), 1000, 1, 2000),
      });
      return json(req, result);
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    const details = error instanceof HttpError ? error.details : undefined;
    console.error("[norva-source-sync]", status, message, details ?? "");
    return json(req, { error: message, details }, status);
  }
});

async function requireUser(req: Request, db: SupabaseClient) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid bearer token", error?.message);
  return { id: data.user.id, email: data.user.email ?? undefined };
}

type SyncProgressReporter = (progress: JsonRecord) => Promise<void>;

function syncProgressSteps(status: "pending" | "running" | "done" | "error" | "skipped" = "pending") {
  return {
    connect: { status },
    channels: { status },
    movies: { status },
    series: { status },
    categories: { status },
    import: { status },
    finalize: { status },
  };
}

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

function catalogCountsFromSyncResult(result: JsonRecord) {
  const live = Number(result.live ?? result.channels ?? 0) || 0;
  const movies = Number(result.movies ?? result.vod ?? 0) || 0;
  const series = Number(result.series ?? 0) || 0;
  const liveCategories = Number(result.liveCategories ?? 0) || 0;
  const movieCategories = Number(result.movieCategories ?? 0) || 0;
  const seriesCategories = Number(result.seriesCategories ?? 0) || 0;
  return {
    live,
    movies,
    series,
    total: Number(result.total ?? (live + movies + series)) || 0,
    categories: {
      live: liveCategories,
      movies: movieCategories,
      series: seriesCategories,
      total: liveCategories + movieCategories + seriesCategories,
    },
  };
}

function completedSyncProgress(result: JsonRecord, startedAt: string, syncedAt: string) {
  const counts = catalogCountsFromSyncResult(result);
  return compactRecord({
    status: "ready",
    stage: "ready",
    percent: 100,
    startedAt,
    updatedAt: syncedAt,
    counts: {
      live: counts.live,
      movies: counts.movies,
      series: counts.series,
      total: counts.total,
    },
    categories: counts.categories,
    steps: {
      connect: { status: "done" },
      channels: { status: "done", count: counts.live },
      movies: { status: "done", count: counts.movies },
      series: { status: "done", count: counts.series },
      categories: { status: "done", count: counts.categories.total },
      import: { status: "done", count: counts.total },
      finalize: { status: "done" },
    },
  });
}

async function writeSourceSyncProgress(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  baseHint: JsonRecord,
  progress: JsonRecord,
) {
  const { error } = await db
    .from("cloud_sources")
    .update({
      config_hint: compactRecord({
        ...baseHint,
        syncProgress: progress,
      }),
    })
    .eq("id", sourceId)
    .eq("user_id", userId);
  if (error) console.warn("[norva-source-sync] Unable to update source sync progress", error.message);
}

async function syncCloudSource(sourceId: string, userId: string, db: SupabaseClient, country: string | null = null, opts: { force?: boolean; rawOnly?: boolean } = {}) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!source) throw new HttpError(404, "Source not found");
  if (!source.config_ciphertext) throw new HttpError(400, "Source has no managed cloud configuration");

  // Previously-imported catalogue fingerprint, for change-detection skips.
  const previousSignature = recordOrEmpty(source.config_hint).contentSignature;

  const startedAt = new Date().toISOString();
  const baseHint = recordOrEmpty(source.config_hint);
  let progress: JsonRecord = compactRecord({
    status: "syncing",
    stage: "connecting",
    percent: 4,
    startedAt,
    updatedAt: startedAt,
    counts: { live: 0, movies: 0, series: 0, total: 0 },
    categories: { live: 0, movies: 0, series: 0, total: 0 },
    steps: {
      ...syncProgressSteps("pending"),
      connect: { status: "running" },
    },
  });
  const reportProgress: SyncProgressReporter = async (patch: JsonRecord) => {
    // Detection-only refreshes must leave the visible sync progress completely
    // untouched — they're invisible background checks, not a user-facing sync.
    if (opts.rawOnly) return;
    progress = mergeSyncProgress(progress, compactRecord({ ...patch, status: "syncing", updatedAt: new Date().toISOString() }));
    await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
  };

  // Background (rawOnly) refreshes don't flip the source to "syncing" up front —
  // an unchanged catalogue must stay cleanly "ready", and a changed one only
  // moves to the finalize-pending state once the raw import has actually landed.
  if (!opts.rawOnly) {
    await db
      .from("cloud_sources")
      .update({
        sync_status: "syncing",
        sync_error: null,
        last_synced_at: startedAt,
        config_hint: compactRecord({
          ...baseHint,
          syncProgress: progress,
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
  }

  try {
    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    const syncOpts = { previousSignature, force: opts.force, rawOnly: opts.rawOnly };
    const result = source.source_type === "xtream"
      ? await syncXtreamSource(sourceId, userId, config, db, country, reportProgress, syncOpts)
      : source.source_type === "m3u"
        ? await syncM3uSource(sourceId, userId, config, db, country, reportProgress, syncOpts)
        : { total: 0 };

    const resultRecord = result as JsonRecord;

    if (opts.rawOnly) {
      // Detection-only (cron): never mutate the catalogue, materialization,
      // signature or sync_status here — only surface the app-closed "what's new"
      // signal when the provider catalogue has grown since our last full import.
      // The real import + materialization is left to the client on next open.
      if (resultRecord.changed) {
        await maybeRecordContentEvent(db, userId, sourceId, previousSignature, resultRecord);
      }
      return { sourceId, status: "detected", changed: Boolean(resultRecord.changed), ...result };
    }

    if ((source.source_type === "xtream" || source.source_type === "m3u") && Number(result.total ?? 0) <= 0) {
      throw new HttpError(422, "No playable catalog items were imported from this source");
    }

    const syncedAt = new Date().toISOString();

    const { error: updateError } = await db
      .from("cloud_sources")
      .update({
        sync_status: "ready",
        sync_error: null,
        last_synced_at: syncedAt,
        config_hint: compactRecord({
          ...recordOrEmpty(source.config_hint),
          contentSignature: resultRecord.contentSignature ?? previousSignature,
          lastSync: { ...result, syncedAt },
          syncProgress: completedSyncProgress(result, startedAt, syncedAt),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    if (updateError) throwDb(updateError, "Unable to update source sync status");

    // "What's new" feed: record a capped event when the catalogue grew.
    await maybeRecordContentEvent(db, userId, sourceId, previousSignature, resultRecord);

    return { sourceId, status: "ready", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source sync failed";
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: new Date().toISOString(),
        config_hint: compactRecord({
          ...baseHint,
          syncProgress: mergeSyncProgress(progress, {
            status: "error",
            stage: "error",
            percent: Number(progress.percent ?? 0) || 0,
            updatedAt: new Date().toISOString(),
            error: message,
          }),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    throw error;
  }
}

// Run a promise to completion after the HTTP response is sent. Supabase exposes
// EdgeRuntime.waitUntil to keep the isolate alive for background work; fall back
// to a detached promise where it isn't present.
function runInBackground(task: Promise<unknown>) {
  const safe = task.catch((e) => console.error("[cron] background task failed", e));
  try {
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er?.waitUntil) { er.waitUntil(safe); return; }
  } catch (_) { /* ignore — fall through to detached */ }
  void safe;
}

// Premium per-user background refresh — the step-5 state machine. Picks a small
// batch of DUE sources, ENFORCES the auto_refresh_background entitlement (skips
// anyone who isn't premium), and takes a compare-and-set lock so overlapping
// ticks can never double-run. Per source it runs a DETECTION-ONLY refresh in the
// background: fetch the provider catalogue and compare its signature against our
// last full import. That's the wall-clock-safe, app-closed "is there new content?"
// signal premium pays for — on a change it records a capped "what's new" event
// (surfaced in-app on open). It deliberately does NOT import or materialize here:
// the full delete+rebuild+materialization overruns a single isolate on big
// catalogues, so the proven client-driven, batched import/finalize still runs on
// the next open. We return the HTTP response at once (work runs in the
// background); on success the next window is scheduled, on a provider error it
// backs off exponentially. Locking also pushes the due window out by the lock
// TTL, so a source isn't re-picked mid-run — and if the isolate dies first, the
// lock self-frees after that same TTL and the source is retried on a later tick.
async function cronRefreshDue(db: SupabaseClient) {
  const CADENCE_MS = 6 * 60 * 60 * 1000;   // premium cadence: every 6h
  const LOCK_TTL_MS = 12 * 60 * 1000;      // a stuck/crashed run frees after 12 min
  const BATCH = 1;                          // sources kicked per tick — kept at 1 so a
                                            // background sync owns the isolate's budget
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const staleIso = new Date(nowMs - LOCK_TTL_MS).toISOString();
  const asMs = (v: unknown) => { const m = new Date(String(v ?? "")).getTime(); return Number.isFinite(m) ? m : 0; };

  const { data: due, error } = await db
    .from("cloud_sources")
    .select("id,user_id,source_type,auto_refresh_state,auto_refresh_next_at")
    .in("source_type", ["xtream", "m3u"])
    .or(`auto_refresh_next_at.is.null,auto_refresh_next_at.lte.${nowIso}`)
    .order("auto_refresh_next_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) return { ok: false, error: error.message };

  const schedule = (id: string, nextMs: number, state: JsonRecord) =>
    db.from("cloud_sources")
      .update({ auto_refresh_next_at: new Date(nextMs).toISOString(), auto_refresh_state: state })
      .eq("id", id); // a state without lockedAt releases the lock

  const toSync: { id: string; userId: string; state: JsonRecord }[] = [];
  let skipped = 0, notEntitled = 0;

  for (const src of (due ?? [])) {
    const id = String(src.id);
    const userId = String(src.user_id);
    const state = isRecord(src.auto_refresh_state) ? src.auto_refresh_state : {};

    // Backing off after a recent provider error → leave it alone this tick.
    if (asMs(state.backoffUntil) > nowMs) { skipped++; continue; }

    // ENFORCE premium. Non-entitled → push the next window out a full cadence so
    // we don't re-check it every tick.
    let entitled = false;
    try {
      const decision = await getEntitlementDecision(db, userId, { autoStartTrial: false });
      entitled = planFeatureEntitled(realPlanCode(decision), "auto_refresh_background");
    } catch (_) { entitled = false; }
    if (!entitled) { await schedule(id, nowMs + CADENCE_MS, { attempts: 0 }); notEntitled++; continue; }

    // Compare-and-set lock: only proceed if no fresh lock is held (another tick
    // holding it → update matches 0 rows → skip, no double-run). We also push the
    // due window out by the lock TTL so this source isn't re-picked while its
    // background sync runs.
    const { data: locked } = await db
      .from("cloud_sources")
      .update({
        auto_refresh_state: { ...state, lockedAt: nowIso },
        auto_refresh_next_at: new Date(nowMs + LOCK_TTL_MS).toISOString(),
      })
      .eq("id", id)
      .or(`auto_refresh_state->>lockedAt.is.null,auto_refresh_state->>lockedAt.lt.${staleIso}`)
      .select("id");
    if (!locked || !locked.length) { skipped++; continue; }

    toSync.push({ id, userId, state });
  }

  // Drive the heavy syncs in the background so pg_net gets a fast response rather
  // than holding the connection open for the whole import. Each job reschedules
  // itself (next window on success, exponential backoff on a provider error).
  if (toSync.length) {
    runInBackground((async () => {
      for (const job of toSync) {
        try {
          // Detection-only refresh: fetch the provider and compare its signature
          // against our last full import. On a change, a capped "what's new" event
          // is recorded (the app-closed premium signal). Wall-clock-safe — it never
          // imports or materializes; the client does that on next open.
          await syncCloudSource(job.id, job.userId, db, null, { force: false, rawOnly: true });
          await schedule(job.id, Date.now() + CADENCE_MS, { attempts: 0 });
        } catch (_) {
          const attempts = (Number(job.state.attempts) || 0) + 1;
          const backoff = Math.min(CADENCE_MS, 5 * 60 * 1000 * Math.pow(2, Math.min(attempts, 6)));
          await schedule(job.id, Date.now() + backoff, { attempts, backoffUntil: new Date(Date.now() + backoff).toISOString() });
        }
      }
    })());
  }

  return { ok: true, due: (due ?? []).length, locked: toSync.length, skipped, notEntitled };
}

// Service-authed entry point to finish a source's materialization without a user
// session. Looks up the owning user and drives the resumable finalize phases in
// the background, returning immediately.
async function cronFinalizeSource(db: SupabaseClient, sourceId: string, country: string | null) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("id,user_id")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!source) return { ok: false, error: "source not found" };
  runInBackground(driveFinalizeToReady(db, sourceId, String(source.user_id), country));
  return { ok: true, started: true, sourceId };
}

// Walk the resumable finalize phases (live → live_channels → live_variants →
// titles → complete) to completion, bounded by a wall-clock budget so a single
// invocation never overruns the isolate. Each phase is the same batched step the
// client drives; if the budget is hit before "ready", the source is left
// mid-finalize and a later call (or the client on open) resumes from there.
async function driveFinalizeToReady(db: SupabaseClient, sourceId: string, userId: string, country: string | null) {
  const deadline = Date.now() + 120_000;
  let phase = "live";
  let offset = 0;
  let guard = 0;
  while (Date.now() < deadline && guard++ < 400) {
    let result: JsonRecord;
    try {
      result = await finalizeCloudSource(sourceId, userId, db, { country, phase, offset, limit: 1500 }) as unknown as JsonRecord;
    } catch (e) {
      console.error("[cron] finalize batch failed", sourceId, e);
      return;
    }
    if (String(result.status) === "ready") return;
    phase = stringOr(result.nextPhase, "complete");
    offset = Number(result.nextOffset) || 0;
  }
  console.warn("[cron] finalize budget/guard hit before ready", sourceId, phase, offset);
}

type FinalizeCloudSourceOptions = {
  country: string | null;
  phase: string;
  offset: number;
  limit: number;
};

async function finalizeCloudSource(sourceId: string, userId: string, db: SupabaseClient, options: FinalizeCloudSourceOptions) {
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throwDb(error, "Unable to load source");
  if (!source) throw new HttpError(404, "Source not found");

  const baseHint = recordOrEmpty(source.config_hint);
  const existingProgress = recordOrEmpty(baseHint.syncProgress);
  const startedAt = stringOr(existingProgress.startedAt ?? source.last_synced_at, new Date().toISOString());
  const phase = normalizeFinalizePhase(options.phase);
  const batchLimit = Math.max(1, Math.min(2000, options.limit || 1000));
  const batchOffset = Math.max(0, options.offset || 0);
  const counts = await countSourceItems(sourceId, userId, db, existingProgress);
  let progress: JsonRecord = compactRecord({
    ...existingProgress,
    status: "syncing",
    stage: finalizePhaseStage(phase),
    percent: Math.max(74, Number(existingProgress.percent ?? 0) || 0),
    startedAt,
    updatedAt: new Date().toISOString(),
  });
  const reportProgress: SyncProgressReporter = async (patch: JsonRecord) => {
    progress = mergeSyncProgress(progress, compactRecord({ ...patch, status: "syncing", updatedAt: new Date().toISOString() }));
    await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
  };

  await db
    .from("cloud_sources")
    .update({ sync_status: "syncing", sync_error: null })
    .eq("id", sourceId)
    .eq("user_id", userId);

  try {
    if (counts.total <= 0) throw new HttpError(422, "No imported catalog items were found for this source");
    await reportProgress({
      stage: finalizePhaseStage(phase),
      percent: finalizePhasePercent(phase, batchOffset, counts),
      counts: {
        live: counts.live,
        movies: counts.movies,
        series: counts.series,
        total: counts.total,
      },
      categories: counts.categories,
      steps: {
        connect: { status: "done" },
        channels: { status: "done", count: counts.live },
        movies: { status: "done", count: counts.movies },
        series: { status: "done", count: counts.series },
        categories: { status: "done", count: counts.categories.total },
        import: { status: "done", count: counts.total },
        finalize: { status: "running" },
      },
    });

    const config = source.config_ciphertext
      ? await decryptSourceConfig(String(source.config_ciphertext), await getRuntimeConfig(db)).catch(() => ({}))
      : {};

    const result = {
      live: counts.live,
      movies: counts.movies,
      series: counts.series,
      liveCategories: counts.categories.live,
      movieCategories: counts.categories.movies,
      seriesCategories: counts.categories.series,
      total: counts.total,
      recoveredFromImportedItems: true,
    };

    if (phase === "live") {
      const existingLiveCatalog = await existingLiveMaterializationCounts(sourceId, userId, db);
      if (counts.live <= 0) {
        const totalVod = counts.movies + counts.series;
        return {
          sourceId,
          status: "syncing",
          phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0,
          limit: batchLimit,
          totalVod,
          ...result,
          liveCatalog: { rawLive: 0, logicalChannels: 0, liveVariants: 0, skipped: true },
        };
      }
      const liveCatalogComplete = existingLiveCatalog.logicalChannels > 0 && existingLiveCatalog.liveVariants > 0;
      if (liveCatalogComplete) {
        await reportProgress({
          stage: "building_titles",
          percent: 86,
          steps: { finalize: { status: "running" } },
        });
        const totalVod = counts.movies + counts.series;
        return {
          sourceId,
          status: "syncing",
          phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0,
          limit: batchLimit,
          totalVod,
          ...result,
          liveCatalog: { ...existingLiveCatalog, rawLive: counts.live, reused: true },
        };
      }

      await reportProgress({
        stage: "building_live_channels",
        percent: 76,
        steps: { finalize: { status: "running" } },
      });
      await clearLiveMaterialization(db, sourceId, userId);
      const livePlan = buildLiveMaterializationPlan({
        sourceId,
        userId,
        rows: await loadSourceItems(sourceId, userId, db, { itemTypes: ["live"] }),
        country: options.country || stringOr(config.country, "FR"),
      });
      await reportProgress({
        stage: "building_live_channels",
        percent: 76,
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "live",
        nextPhase: livePlan.channelRows.length > 0 ? "live_channels" : "titles",
        nextOffset: 0,
        limit: batchLimit,
        totalLiveChannels: livePlan.channelRows.length,
        totalLiveVariants: livePlan.variantRows.length,
        totalVod: counts.movies + counts.series,
        ...result,
        liveCatalog: {
          rawLive: livePlan.rawLive,
          logicalChannels: livePlan.channelRows.length,
          liveVariants: livePlan.variantRows.length,
          reset: true,
        },
      };
    }

    if (phase === "live_channels") {
      const livePlan = buildLiveMaterializationPlan({
        sourceId,
        userId,
        rows: await loadSourceItems(sourceId, userId, db, { itemTypes: ["live"] }),
        country: options.country || stringOr(config.country, "FR"),
      });
      const insertedChannels = await upsertLiveChannelRows(db, livePlan.channelRows, batchOffset, batchLimit);
      const nextOffset = Math.min(livePlan.channelRows.length, batchOffset + insertedChannels.length);
      const done = insertedChannels.length < batchLimit || nextOffset >= livePlan.channelRows.length;
      await reportProgress({
        stage: done ? "building_live_variants" : "building_live_channels",
        percent: done ? 80 : liveFinalizePercent("live_channels", nextOffset, livePlan.channelRows.length),
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "live_channels",
        nextPhase: done ? "live_variants" : "live_channels",
        nextOffset: done ? 0 : nextOffset,
        limit: batchLimit,
        totalLiveChannels: livePlan.channelRows.length,
        totalLiveVariants: livePlan.variantRows.length,
        totalVod: counts.movies + counts.series,
        done,
        ...result,
        liveCatalog: {
          rawLive: livePlan.rawLive,
          logicalChannels: nextOffset,
          liveVariants: 0,
        },
      };
    }

    if (phase === "live_variants") {
      const livePlan = buildLiveMaterializationPlan({
          sourceId,
          userId,
        rows: await loadSourceItems(sourceId, userId, db, { itemTypes: ["live"] }),
          country: options.country || stringOr(config.country, "FR"),
      });
      const channelIdByLogicalId = await fetchLiveChannelIdMap(db, sourceId, userId);
      const insertedVariants = await upsertLiveVariantRows(db, livePlan.variantRows, channelIdByLogicalId, batchOffset, batchLimit);
      const nextOffset = Math.min(livePlan.variantRows.length, batchOffset + insertedVariants);
      const done = insertedVariants < batchLimit || nextOffset >= livePlan.variantRows.length;
      await reportProgress({
        stage: done ? "building_titles" : "building_live_variants",
        percent: done ? 86 : liveFinalizePercent("live_variants", nextOffset, livePlan.variantRows.length),
        steps: { finalize: { status: "running" } },
      });
      const totalVod = counts.movies + counts.series;
      return {
        sourceId,
        status: "syncing",
        phase: "live_variants",
        nextPhase: totalVod > 0 ? "titles" : "complete",
        nextOffset: done ? 0 : nextOffset,
        limit: batchLimit,
        totalVod,
        totalLiveChannels: livePlan.channelRows.length,
        totalLiveVariants: livePlan.variantRows.length,
        done,
        ...result,
        liveCatalog: {
          rawLive: livePlan.rawLive,
          logicalChannels: livePlan.channelRows.length,
          liveVariants: nextOffset,
        },
      };
    }

    if (phase === "titles") {
      const totalVod = counts.movies + counts.series;
      const rows = await loadSourceItems(sourceId, userId, db, {
        itemTypes: ["movie", "series"],
        offset: batchOffset,
        limit: batchLimit,
      });
      const sourceType = stringOr(source.source_type, "");
      const titleProjection = await refreshVodTitleProjection({
        sourceId,
        userId,
        rows,
        db,
        xtreamConfig: sourceType === "xtream" && config.serverUrl && config.username && config.password
          ? {
            serverUrl: normalizeBaseUrl(stringOr(config.serverUrl, "")),
            username: stringOr(config.username, ""),
            password: stringOr(config.password, ""),
          }
          : null,
        vodInfoLimit: boundedInt(Deno.env.get("NORVA_VOD_INFO_FINALIZE_LIMIT"), 0, 0, 1000),
        tmdbValidateLimit: boundedInt(Deno.env.get("NORVA_TMDB_VALIDATE_FINALIZE_LIMIT"), 40, 0, 1000),
      });
      const nextOffset = Math.min(totalVod, batchOffset + rows.length);
      const done = rows.length < batchLimit || nextOffset >= totalVod;
      await reportProgress({
        stage: done ? "finalizing" : "building_titles",
        percent: done ? 96 : titleFinalizePercent(nextOffset, totalVod),
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "titles",
        nextPhase: done ? "complete" : "titles",
        nextOffset,
        limit: batchLimit,
        totalVod,
        done,
        ...result,
        titleProjection,
      };
    }

    if (phase !== "complete") throw new HttpError(400, "Invalid catalog finalization phase");

    // Safety net: the client-driven "titles" phase can stop early and leave
    // verified titles without playable variants (vanishing from genre rails).
    // Deterministically materialise any missing variants before marking ready.
    try {
      await db.rpc("heal_cloud_title_variants", { p_user_id: userId, p_source_id: sourceId });
    } catch (healError) {
      console.warn("[norva-source-sync] variant heal failed:", healError instanceof Error ? healError.message : healError);
    }

    const syncedAt = new Date().toISOString();
    const { error: updateError } = await db
      .from("cloud_sources")
      .update({
        sync_status: "ready",
        sync_error: null,
        last_synced_at: syncedAt,
        config_hint: compactRecord({
          ...baseHint,
          lastSync: { ...result, syncedAt },
          syncProgress: completedSyncProgress(result, startedAt, syncedAt),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    if (updateError) throwDb(updateError, "Unable to update source sync status");

    return { sourceId, status: "ready", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source finalization failed";
    const failedAt = new Date().toISOString();
    await db
      .from("cloud_sources")
      .update({
        sync_status: "error",
        sync_error: message,
        last_synced_at: failedAt,
        config_hint: compactRecord({
          ...baseHint,
          syncProgress: mergeSyncProgress(progress, {
            status: "error",
            stage: "error",
            percent: Number(progress.percent ?? 0) || 0,
            updatedAt: failedAt,
            error: message,
          }),
        }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    throw error;
  }
}

function normalizeFinalizePhase(value: string) {
  const phase = String(value || "").trim().toLowerCase();
  if (
    phase === "live" ||
    phase === "live_channels" ||
    phase === "live_variants" ||
    phase === "titles" ||
    phase === "complete"
  ) return phase;
  return "live";
}

function finalizePhaseStage(phase: string) {
  if (phase === "live_channels") return "building_live_channels";
  if (phase === "live_variants") return "building_live_variants";
  if (phase === "titles") return "building_titles";
  if (phase === "complete") return "finalizing";
  return "materializing";
}

function finalizePhasePercent(phase: string, offset: number, counts: { live: number; movies: number; series: number }) {
  if (phase === "live_channels") return liveFinalizePercent("live_channels", offset, counts.live);
  if (phase === "live_variants") return liveFinalizePercent("live_variants", offset, counts.live);
  if (phase === "titles") return titleFinalizePercent(offset, counts.movies + counts.series);
  if (phase === "complete") return 96;
  return 74;
}

function liveFinalizePercent(phase: string, offset: number, total: number) {
  const ratio = total ? Math.max(0, Math.min(1, offset / total)) : 1;
  if (phase === "live_channels") return Math.max(76, Math.min(80, Math.round(76 + ratio * 4)));
  return Math.max(80, Math.min(86, Math.round(80 + ratio * 6)));
}

function titleFinalizePercent(offset: number, totalVod: number) {
  if (!totalVod) return 96;
  const ratio = Math.max(0, Math.min(1, offset / totalVod));
  return Math.max(86, Math.min(95, Math.round(86 + ratio * 9)));
}

async function countRowsByType(sourceId: string, userId: string, db: SupabaseClient, itemType: string) {
  const { count, error } = await db
    .from("cloud_media_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("item_type", itemType);
  if (error) throwDb(error, `Unable to count ${itemType} catalog items`);
  return count ?? 0;
}

async function countRowsInTable(table: string, sourceId: string, userId: string, db: SupabaseClient) {
  const { count, error } = await db
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId);
  if (error) throwDb(error, `Unable to count ${table}`);
  return count ?? 0;
}

async function existingLiveMaterializationCounts(sourceId: string, userId: string, db: SupabaseClient) {
  const [logicalChannels, liveVariants] = await Promise.all([
    countRowsInTable("cloud_live_logical_channels", sourceId, userId, db),
    countRowsInTable("cloud_live_variants", sourceId, userId, db),
  ]);
  return { logicalChannels, liveVariants };
}

async function countSourceItems(sourceId: string, userId: string, db: SupabaseClient, progress: JsonRecord = {}) {
  const [live, movies, series] = await Promise.all([
    countRowsByType(sourceId, userId, db, "live"),
    countRowsByType(sourceId, userId, db, "movie"),
    countRowsByType(sourceId, userId, db, "series"),
  ]);
  const categories = recordOrEmpty(progress.categories);
  return {
    live,
    movies,
    series,
    total: live + movies + series,
    categories: {
      live: Number(categories.live ?? 0) || 0,
      movies: Number(categories.movies ?? 0) || 0,
      series: Number(categories.series ?? 0) || 0,
      total: Number(categories.total ?? 0) || 0,
    },
  };
}

type LoadSourceItemsOptions = {
  itemTypes?: string[];
  offset?: number;
  limit?: number;
};

async function loadSourceItems(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  options: LoadSourceItemsOptions = {},
): Promise<LiveCatalogItem[]> {
  const rows: LiveCatalogItem[] = [];
  const pageSize = options.limit ? Math.max(1, Math.min(2000, options.limit)) : 1000;
  const startOffset = Math.max(0, options.offset ?? 0);
  const maxRows = options.limit ? pageSize : Number.POSITIVE_INFINITY;
  for (let offset = startOffset; rows.length < maxRows; offset += pageSize) {
    let query = db
      .from("cloud_media_items")
      .select("id,source_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .order("item_type", { ascending: true })
      .order("external_id", { ascending: true });
    const itemTypes = (options.itemTypes || []).filter(Boolean);
    if (itemTypes.length === 1) query = query.eq("item_type", itemTypes[0]);
    else if (itemTypes.length > 1) query = query.in("item_type", itemTypes);

    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throwDb(error, "Unable to load imported catalog items");
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...data as LiveCatalogItem[]);
    if (data.length < pageSize) break;
    if (options.limit) break;
  }
  return Number.isFinite(maxRows) ? rows.slice(0, maxRows) : rows;
}

function catalogCountsFromRows(rows: LiveCatalogItem[]) {
  const categorySets = {
    live: new Set<string>(),
    movies: new Set<string>(),
    series: new Set<string>(),
  };
  let live = 0;
  let movies = 0;
  let series = 0;
  for (const row of rows) {
    const type = String(row.item_type || "");
    const category = stringOr(row.parent_external_id, "");
    if (type === "live") {
      live += 1;
      if (category) categorySets.live.add(category);
    } else if (type === "movie") {
      movies += 1;
      if (category) categorySets.movies.add(category);
    } else if (type === "series") {
      series += 1;
      if (category) categorySets.series.add(category);
    }
  }
  return {
    live,
    movies,
    series,
    total: live + movies + series,
    categories: {
      live: categorySets.live.size,
      movies: categorySets.movies.size,
      series: categorySets.series.size,
      total: categorySets.live.size + categorySets.movies.size + categorySets.series.size,
    },
  };
}

async function syncXtreamSource(
  sourceId: string,
  userId: string,
  config: JsonRecord,
  db: SupabaseClient,
  country: string | null = null,
  reportProgress: SyncProgressReporter = async () => {},
  opts: { previousSignature?: unknown; force?: boolean; rawOnly?: boolean } = {},
) {
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = stringOr(config.username, "");
  const password = stringOr(config.password, "");
  await reportProgress({
    stage: "connecting",
    percent: 10,
    steps: { connect: { status: "running" } },
  });
  if (!username || !password) throw new HttpError(400, "Xtream credentials are incomplete");

  await reportProgress({
    stage: "discovering",
    percent: 18,
    steps: {
      connect: { status: "done" },
      channels: { status: "running" },
      movies: { status: "running" },
      series: { status: "running" },
      categories: { status: "running" },
    },
  });
  const [live, vod, series, liveCategories, vodCategories, seriesCategories] = await Promise.all([
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_live_streams" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_vod_streams" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_series" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_live_categories" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_vod_categories" }), 25000).catch(() => []),
    fetchJson(xtreamApiUrl({ serverUrl, username, password, action: "get_series_categories" }), 25000).catch(() => []),
  ]);
  const liveCategoryMap = categoryMap(liveCategories);
  const vodCategoryMap = categoryMap(vodCategories);
  const seriesCategoryMap = categoryMap(seriesCategories);
  const liveCount = Array.isArray(live) ? live.length : 0;
  const movieCount = Array.isArray(vod) ? vod.length : 0;
  const seriesCount = Array.isArray(series) ? series.length : 0;
  const categoryCount = liveCategoryMap.size + vodCategoryMap.size + seriesCategoryMap.size;
  await reportProgress({
    stage: "discovered",
    percent: 42,
    counts: {
      live: liveCount,
      movies: movieCount,
      series: seriesCount,
      total: liveCount + movieCount + seriesCount,
    },
    categories: {
      live: liveCategoryMap.size,
      movies: vodCategoryMap.size,
      series: seriesCategoryMap.size,
      total: categoryCount,
    },
    steps: {
      channels: { status: "done", count: liveCount },
      movies: { status: "done", count: movieCount },
      series: { status: "done", count: seriesCount },
      categories: { status: "done", count: categoryCount },
      import: { status: "running" },
    },
  });

  const rows = [
    ...xtreamRows(sourceId, userId, Array.isArray(live) ? live : [], "live", liveCategoryMap),
    ...xtreamRows(sourceId, userId, Array.isArray(vod) ? vod : [], "movie", vodCategoryMap),
    ...xtreamRows(sourceId, userId, Array.isArray(series) ? series : [], "series", seriesCategoryMap),
  ];

  // Change-detection: if the provider catalogue is byte-for-byte the same set we
  // last fully imported, skip the delete+rebuild+projection. The fetch above is
  // the only unavoidable cost; everything below is the expensive part we avoid.
  const contentSignature = await computeContentSignature(rows);

  if (opts.rawOnly) {
    // Detection-only (cron) path: report whether the provider catalogue moved
    // since our last full import, WITHOUT mutating anything (no delete/rebuild,
    // no materialization, no signature write). The actual import stays with the
    // client on next open; this only powers the app-closed "what's new" signal.
    const changed = Boolean(opts.previousSignature) && !contentSignatureEquals(contentSignature, opts.previousSignature);
    return { live: liveCount, movies: movieCount, series: seriesCount, total: rows.length, contentSignature, changed, detectOnly: true };
  }

  if (!opts.force && opts.previousSignature && contentSignatureEquals(contentSignature, opts.previousSignature)) {
    await reportProgress({
      stage: "unchanged",
      percent: 100,
      steps: {
        import: { status: "done", count: rows.length },
        finalize: { status: "done" },
      },
    });
    return {
      live: liveCount,
      movies: movieCount,
      series: seriesCount,
      liveCategories: liveCategoryMap.size,
      movieCategories: vodCategoryMap.size,
      seriesCategories: seriesCategoryMap.size,
      total: rows.length,
      contentSignature,
      skipped: true,
    };
  }

  await reportProgress({
    stage: "importing",
    percent: 58,
    steps: { import: { status: "running", count: rows.length } },
  });
  const savedRows = await replaceSourceItems(sourceId, userId, rows, db);
  await reportProgress({
    stage: "materializing",
    percent: 74,
    steps: { import: { status: "done", count: savedRows.length }, finalize: { status: "running" } },
  });
  const liveCatalog = await refreshMaterializedLiveCatalog(db, { sourceId, userId, rows: savedRows, country: country || stringOr(config.country, "FR") });
  await reportProgress({
    stage: "building_titles",
    percent: 86,
    steps: { finalize: { status: "running" } },
  });
  const titleProjection = await refreshVodTitleProjection({
    sourceId,
    userId,
    rows: savedRows,
    db,
    xtreamConfig: { serverUrl, username, password },
    vodInfoLimit: boundedInt(Deno.env.get("NORVA_VOD_INFO_SYNC_LIMIT"), 120, 0, 1000),
  });
  await reportProgress({
    stage: "finalizing",
    percent: 96,
    steps: { finalize: { status: "running" } },
  });
  return {
    live: liveCount,
    movies: movieCount,
    series: seriesCount,
    liveCategories: liveCategoryMap.size,
    movieCategories: vodCategoryMap.size,
    seriesCategories: seriesCategoryMap.size,
    total: rows.length,
    liveCatalog,
    titleProjection,
    contentSignature,
  };
}

// Cheap change-detection fingerprint of a freshly-fetched catalogue. Per item
// type we keep the count, the newest provider `added` timestamp, and a hash of
// the sorted external ids — so additions/removals flip the hash and the count.
// A sync whose signature matches the last completed one can skip the heavy
// delete+rebuild+projection entirely (the existing data is already correct).
async function computeContentSignature(rows: JsonRecord[]): Promise<JsonRecord> {
  const byType = new Map<string, { count: number; maxAdded: number; ids: string[] }>();
  for (const row of rows) {
    const type = stringOr(row.item_type, "");
    const ext = stringOr(row.external_id, "");
    if (!type || !ext) continue;
    let bucket = byType.get(type);
    if (!bucket) { bucket = { count: 0, maxAdded: 0, ids: [] }; byType.set(type, bucket); }
    bucket.count += 1;
    bucket.ids.push(ext);
    const meta = isRecord(row.metadata) ? row.metadata : {};
    const added = Number(meta.added);
    if (Number.isFinite(added) && added > bucket.maxAdded) bucket.maxAdded = added;
  }
  const signature: JsonRecord = {};
  for (const [type, bucket] of byType) {
    bucket.ids.sort();
    signature[type] = {
      count: bucket.count,
      maxAdded: bucket.maxAdded,
      idsHash: await sha256Hex(bucket.ids.join(",")),
    };
  }
  return signature;
}

// Two signatures are "the same catalogue" when every type matches on count +
// id-set hash. maxAdded is informational only (some providers jitter it), so it
// is deliberately excluded from the equality to avoid false "changed" results.
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

async function syncM3uSource(
  sourceId: string,
  userId: string,
  config: JsonRecord,
  db: SupabaseClient,
  country: string | null = null,
  reportProgress: SyncProgressReporter = async () => {},
  opts: { previousSignature?: unknown; force?: boolean; rawOnly?: boolean } = {},
) {
  const playlistUrl = stringOr(config.playlistUrl, "");
  await reportProgress({
    stage: "connecting",
    percent: 10,
    steps: { connect: { status: "running" } },
  });
  const playlist = await fetchText(playlistUrl, 30000, 20_000_000);
  await reportProgress({
    stage: "discovered",
    percent: 42,
    steps: {
      connect: { status: "done" },
      channels: { status: "running" },
      movies: { status: "skipped" },
      series: { status: "skipped" },
      categories: { status: "running" },
    },
  });
  const items = parseM3u(playlist).slice(0, 20000);
  const rows = await Promise.all(items.map(async (item) => ({
    user_id: userId,
    source_id: sourceId,
    item_type: "live",
    external_id: item.tvgId || await sha256Hex(item.url),
    parent_external_id: item.group || null,
    title: item.title,
    subtitle: item.group || null,
    poster_url: item.logo || null,
    backdrop_url: null,
    metadata: compactRecord({ tvgId: item.tvgId, group: item.group }),
    playback_hint: compactRecord({ sourceType: "m3u", targetUrl: item.url }),
    available: true,
  })));

  const categoryCount = new Set(rows.map((row) => stringOr(row.parent_external_id, "")).filter(Boolean)).size;

  // Change-detection (same as Xtream): skip the rebuild when the playlist's
  // channel set is unchanged since the last completed import.
  const contentSignature = await computeContentSignature(rows);

  if (opts.rawOnly) {
    // Detection-only (cron) path — see the matching note in syncXtreamSource.
    const changed = Boolean(opts.previousSignature) && !contentSignatureEquals(contentSignature, opts.previousSignature);
    return { live: rows.length, total: rows.length, contentSignature, changed, detectOnly: true };
  }

  if (!opts.force && opts.previousSignature && contentSignatureEquals(contentSignature, opts.previousSignature)) {
    await reportProgress({
      stage: "unchanged",
      percent: 100,
      counts: { live: rows.length, movies: 0, series: 0, total: rows.length },
      steps: { import: { status: "done", count: rows.length }, finalize: { status: "done" } },
    });
    return { live: rows.length, total: rows.length, contentSignature, skipped: true };
  }

  await reportProgress({
    stage: "importing",
    percent: 62,
    counts: { live: rows.length, movies: 0, series: 0, total: rows.length },
    categories: { live: categoryCount, movies: 0, series: 0, total: categoryCount },
    steps: {
      channels: { status: "done", count: rows.length },
      categories: { status: "done", count: categoryCount },
      import: { status: "running", count: rows.length },
    },
  });
  const savedRows = await replaceSourceItems(sourceId, userId, rows, db);
  await reportProgress({
    stage: "finalizing",
    percent: 86,
    steps: { import: { status: "done", count: savedRows.length }, finalize: { status: "running" } },
  });
  const liveCatalog = await refreshMaterializedLiveCatalog(db, { sourceId, userId, rows: savedRows, country: country || stringOr(config.country, "FR") });
  return { live: rows.length, total: rows.length, liveCatalog, contentSignature };
}

async function replaceSourceItems(sourceId: string, userId: string, rows: JsonRecord[], db: SupabaseClient): Promise<LiveCatalogItem[]> {
  const savedRows: LiveCatalogItem[] = [];
  await db.from("cloud_media_items").delete().eq("source_id", sourceId).eq("user_id", userId);
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (!chunk.length) continue;
    const { data, error } = await db
      .from("cloud_media_items")
      .upsert(chunk, { onConflict: "source_id,item_type,external_id" })
      .select("id,source_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available");
    if (error) throwDb(error, "Unable to save cloud catalog items");
    if (Array.isArray(data)) savedRows.push(...data as LiveCatalogItem[]);
  }
  return savedRows;
}

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) return runtimeConfigCache.value;
  let sourceConfigKey = ENV_SOURCE_CONFIG_KEY;
  if (!sourceConfigKey) {
    const { data, error } = await db
      .from("cloud_runtime_config")
      .select("value")
      .eq("key", "NORVA_SOURCE_CONFIG_KEY")
      .maybeSingle();
    if (error) console.warn("[norva-source-sync] runtime config unavailable", error.message);
    if (typeof data?.value === "string") sourceConfigKey = data.value;
  }
  const value = { sourceConfigKey };
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

async function fetchText(url: string, timeoutMs: number, maxBytes: number) {
  const response = await fetchWithTimeout(url, timeoutMs);
  if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
  const text = await response.text();
  if (text.length > maxBytes) throw new HttpError(413, "Playlist is too large for this cloud import");
  return text;
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

function parseM3u(playlist: string) {
  const lines = playlist.split(/\r?\n/);
  const items: Array<{ title: string; url: string; tvgId: string; logo: string; group: string }> = [];
  let pending: { title: string; tvgId: string; logo: string; group: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      pending = {
        title: line.includes(",") ? line.slice(line.indexOf(",") + 1).trim() : "Norva channel",
        tvgId: attr(line, "tvg-id") || attr(line, "tvg-name"),
        logo: attr(line, "tvg-logo"),
        group: attr(line, "group-title"),
      };
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pending && /^https?:\/\//i.test(line)) {
      items.push({ ...pending, url: line });
      pending = null;
    }
  }

  return items;
}

function attr(value: string, name: string) {
  const match = value.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1]?.trim() ?? "";
}

function xtreamApiUrl(config: {
  serverUrl: string;
  username: string;
  password: string;
  action?: string;
}) {
  const url = new URL(`${normalizeBaseUrl(config.serverUrl)}/player_api.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  if (config.action) url.searchParams.set("action", config.action);
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

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin");
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowAll = allowed.includes("*");
  const allowOrigin = origin && (allowAll || allowed.includes(origin) || isLocalOrigin(origin)) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-norva-profile-id",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function isLocalOrigin(origin: string) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function routeSegments(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "norva-source-sync") parts.shift();
  return parts;
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
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

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
