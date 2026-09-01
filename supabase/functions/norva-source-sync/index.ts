import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildLiveMaterializationPlan,
  clearLiveMaterialization,
  fetchLiveChannelIdMap,
  materializeLiveChunk,
  refreshMaterializedLiveCatalog,
  upsertLiveChannelRows,
  upsertLiveVariantRows,
} from "../_shared/live-materialization.ts";
import { refreshVodTitleProjection, validateTmdbCandidate, searchTmdbMatch } from "../_shared/vod-title-projection.ts";
import { TMDB_SEARCH_POLICY_VERSION } from "../_shared/tmdb-search-policy.mjs";
import { backfillProviderOverviews } from "../_shared/provider-overview-backfill.ts";
import { classifyOpsSourceError, formatSourceSyncError } from "../_shared/source-sync-error.mjs";
import {
  buildProviderDirectFallbackSnapshot,
  createSourceDirectFallbackLeaseRunner,
  directFallbackLeaseTtlSeconds,
  ProviderDirectFallbackLeaseError,
  providerDirectFallbackLeaseOwner,
  withSourceDirectFallbackLease,
} from "../_shared/provider-direct-fallback-lease.mjs";
import {
  BoundedProviderResponseError,
  fetchBoundedProviderJson,
  fetchBoundedProviderText,
} from "../_shared/bounded-provider-response.mjs";
import type { LiveCatalogItem } from "../_shared/live-catalog.ts";
import { getEntitlementDecision, planFeatureEntitled, realPlanCode } from "../_shared/entitlements.ts";
import { driveXtreamSyncToReady, freshSyncCursor, detectXtreamChange, enqueueImportNotification } from "../_shared/xtream-sync.ts";
import {
  adoptActiveCatalogUserVisibilityEpoch,
  assertActiveCatalogGenerationCurrent,
  type ActiveCatalogGeneration,
  catalogGenerationRpcFence,
  isCatalogGenerationSuperseded,
  readActiveCatalogGenerationSnapshot,
  withCatalogGenerationRows,
} from "../_shared/catalog-generation.ts";
import { isStaleDatabaseConflict } from "../_shared/database-conflict.ts";

type JsonRecord = Record<string, unknown>;
type RuntimeConfig = {
  sourceConfigKey: string;
  mediaGatewayUrl: string;
  mediaGatewayToken: string;
  relayBaseUrl: string;
  relayTokenSecret: string;
};
type SeriesInventoryTransport = "gateway" | "relay" | "direct";
type SeriesInventoryMetadataResult = {
  payload: unknown;
  transport: SeriesInventoryTransport;
};
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
const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva.tv",
  "https://www.norva.tv",
  "https://app.norva.tv",
  "https://norva-web.pages.dev",
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
const ENV_MEDIA_GATEWAY_URL = (Deno.env.get("NORVA_MEDIA_GATEWAY_URL") ?? "").replace(/\/+$/, "");
const ENV_MEDIA_GATEWAY_TOKEN = Deno.env.get("NORVA_MEDIA_GATEWAY_TOKEN") ?? "";
const ENV_RELAY_BASE_URL = (Deno.env.get("NORVA_RELAY_BASE_URL") ?? "").replace(/\/+$/, "");
const ENV_RELAY_TOKEN_SECRET = Deno.env.get("RELAY_TOKEN_SECRET") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const catalogVisibilityEpochs = new WeakMap<Request, string>();

let runtimeConfigCache: { value: RuntimeConfig; expiresAt: number } | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  try {
    const url = new URL(req.url);
    const segments = routeSegments(url.pathname);
    if (req.method === "GET" && segments[0] === "health") {
      return json(req, {
        ok: true,
        service: "norva-source-sync",
        version: 15,
        liveMaterialization: true,
        syncProgress: true,
        catalogFinalize: true,
        catalogFinalizeBatches: true,
        liveFinalizeBatches: true,
        yearBackfill: true,
        dynamicEnrichmentFleet: true,
        enrichmentFleetCycle: 12,
        seriesEpisodeInventory: true,
        exactEpisodeAudioPipeline: true,
        seriesPriorityCycleV2: true,
        episodeProbeBatchCanary: "4/5",
        exactTailDrainSafe: true,
        cloudAutoRefreshClaimProtocol: 1,
        tmdbSearchPolicy: TMDB_SEARCH_POLICY_VERSION,
      });
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
      // Dynamic audio/subtitle fleet.  Unlike the historical jobs, this route
      // contains no account or source allow-list: the database queue reconciles
      // every active ready source on every tick, including catalogues uploaded
      // by users who register after this code is deployed.
      if (segments[1] === "enrichment-fleet") {
        const limit = boundedInt(url.searchParams.get("limit"), 8, 1, 8);
        const dryRun = url.searchParams.get("dryRun") === "1";
        return json(req, await cronEnrichmentFleet(supabase, limit, dryRun));
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
        const { data: src } = await supabase.from("cloud_catalog_visible_sources").select("user_id").eq("id", segments[2]).maybeSingle();
        if (!src) return json(req, { error: "source not found" }, 404);
        const responseSnapshot = await readCatalogAccessSnapshot(segments[2], String(src.user_id), supabase, false);
        const result = await finalizeCloudSource(segments[2], String(src.user_id), supabase, {
          country: url.searchParams.get("country"),
          phase: stringOr(url.searchParams.get("phase"), "live"),
          offset: Number(url.searchParams.get("offset")) || 0,
          afterId: stringOr(url.searchParams.get("afterId"), ""),
          limit: Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1500)),
        });
        // A successful finalize batch may itself advance the account-wide cache
        // epoch (for example, a bounded stale-version prune). Re-adopt only that
        // monotone field while proving generation/config/source authority stayed
        // identical, then perform the exact response-boundary assertion.
        await adoptActiveCatalogUserVisibilityEpoch(
          supabase,
          segments[2],
          String(src.user_id),
          responseSnapshot,
        );
        await assertCatalogSnapshotCurrent(segments[2], String(src.user_id), responseSnapshot, supabase);
        catalogVisibilityEpochs.set(req, responseSnapshot.userVisibilityEpoch);
        return json(req, result);
      }
      // Resumable-discovery continuation. driveXtreamSyncToReady self-invokes this
      // between isolates to import an "8K"-scale catalogue across several short
      // background runs; kicks the next step and returns immediately.
      if (segments[1] === "sync-step" && segments[2]) {
        const { data: src } = await supabase.from("cloud_catalog_visible_sources").select("user_id, source_type").eq("id", segments[2]).maybeSingle();
        if (!src) return json(req, { error: "source not found" }, 404);
        if (String(src.source_type) === "xtream") {
          runInBackground(driveXtreamSyncToReady(segments[2], String(src.user_id), supabase));
        }
        return json(req, { ok: true, started: true, sourceId: segments[2] });
      }
      // Watchdog: re-kick discovery chains whose isolate died silently (heartbeat
      // went stale), so a big import always finishes even if the chain breaks.
      if (segments[1] === "resume-stuck") {
        return json(req, await cronResumeStuck(supabase));
      }
      // Backfill release_year from TMDB for unverified titles. One batch per call
      // (cursor-resumable); drive it in a loop until {done:true}.
      if (segments[1] === "backfill-years") {
        const limit = boundedInt(url.searchParams.get("limit"), 300, 1, 1000);
        const reset = url.searchParams.get("reset") === "1";
        const concurrency = boundedInt(url.searchParams.get("conc"), 15, 1, 50);
        return json(req, await cronBackfillYears(supabase, limit, reset, concurrency));
      }
      // Re-validate unverified titles against every language (multi-lang matching).
      if (segments[1] === "revalidate") {
        const limit = boundedInt(url.searchParams.get("limit"), 150, 1, 500);
        const reset = url.searchParams.get("reset") === "1";
        const concurrency = boundedInt(url.searchParams.get("conc"), 12, 1, 30);
        return json(req, await cronRevalidate(supabase, limit, reset, concurrency));
      }
      // Search-match titles that have no provider TMDB id (TMDB search + confirm).
      // Caps raised for backlog burn-down: ~459k browsable titles were never
      // attempted at the old 300/run cap (~65 days to clear). A run at limit=1000,
      // conc=15 is ~1.2k TMDB calls in ~35s (well under the 120s cron timeout and
      // TMDB's ~50 req/s), so the nightly schedule clears the backlog in days.
      if (segments[1] === "search-match") {
        const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 1500);
        const reset = url.searchParams.get("reset") === "1";
        const concurrency = boundedInt(url.searchParams.get("conc"), 8, 1, 30);
        // Optional ?user=<uuid> — re-enrich one account's backlog first (no global cursor).
        const userParam = (url.searchParams.get("user") || "").trim();
        const userId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userParam) ? userParam : null;
        return json(req, await cronSearchMatch(supabase, limit, reset, concurrency, userId));
      }
      // Pre-warm the GLOBAL catalog_titles i18n: fill validated matches (metadata.tmdb) that
      // still lack any localized synopsis — one full-translations pull per title covers every
      // language TMDB has. Cheap + self-draining (a title leaves the gap set the moment i18n
      // is written); attempt-stamped so unmatchable/absent titles aren't re-pulled tightly.
      if (segments[1] === "prewarm-i18n") {
        const limit = boundedInt(url.searchParams.get("limit"), 100, 1, 500);
        const concurrency = boundedInt(url.searchParams.get("conc"), 8, 1, 20);
        return json(req, await cronPrewarmI18n(supabase, limit, concurrency));
      }
      return json(req, { error: "not_found" }, 404);
    }
    if (req.method === "POST" && segments[0] === "sources" && segments[2] === "sync") {
      const user = await requireUser(req, supabase);
      const force = url.searchParams.get("force") === "1";
      const responseSnapshot = await readCatalogAccessSnapshot(segments[1], user.id, supabase, false);
      const result = await syncCloudSource(segments[1], user.id, supabase, url.searchParams.get("country"), { force });
      await assertCatalogSnapshotCurrent(segments[1], user.id, responseSnapshot, supabase);
      catalogVisibilityEpochs.set(req, responseSnapshot.userVisibilityEpoch);
      return json(req, result);
    }
    if (req.method === "POST" && segments[0] === "sources" && segments[2] === "finalize") {
      const user = await requireUser(req, supabase);
      const responseSnapshot = await readCatalogAccessSnapshot(segments[1], user.id, supabase, false);
      const result = await finalizeCloudSource(segments[1], user.id, supabase, {
        country: url.searchParams.get("country"),
        phase: stringOr(url.searchParams.get("phase"), "live"),
        offset: boundedInt(url.searchParams.get("offset"), 0, 0, 1_000_000),
        // Keyset cursor for the titles phase — the client threads it back from each
        // response so it resumes the same forward walk the background driver uses
        // (and cooperates with it) instead of re-scanning by OFFSET.
        afterId: stringOr(url.searchParams.get("afterId"), ""),
        limit: boundedInt(url.searchParams.get("limit"), 1000, 1, 2000),
      });
      await assertCatalogSnapshotCurrent(segments[1], user.id, responseSnapshot, supabase);
      catalogVisibilityEpochs.set(req, responseSnapshot.userVisibilityEpoch);
      return json(req, result);
    }
    // Admin/service re-sync: force a full re-sync of ANY source by id (service-token auth,
    // NOT a user JWT). Looks up the source's owner so it re-syncs under the correct user —
    // powers the admin dashboard "re-sync" action + one-off ops (e.g. a sync that stalled
    // mid-finalize during an incident). driveXtreamSyncToReady runs the whole chain in the
    // background; this returns immediately.
    if (req.method === "POST" && segments[0] === "admin" && segments[1] === "resync") {
      const expected = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
      const provided = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
      // Accept EITHER the service backfill token (SQL/ops) OR an admin user JWT (dashboard button):
      // app_metadata.role='admin' is server-set, so verifying it here is a real authorization check.
      let authed = Boolean(expected) && provided === expected;
      if (!authed && provided) {
        const { data: au } = await supabase.auth.getUser(provided);
        authed = ((au?.user?.app_metadata as Record<string, unknown> | undefined)?.role) === "admin";
      }
      if (!authed) throw new HttpError(401, "Unauthorized");
      const sourceId = segments[2];
      if (!sourceId) throw new HttpError(400, "Missing source id");
      const { data: src } = await supabase.from("cloud_sources").select("user_id").eq("id", sourceId).maybeSingle();
      if (!src) throw new HttpError(404, "Source not found");
      const responseSnapshot = await readCatalogAccessSnapshot(sourceId, String(src.user_id), supabase, false);
      const result = await syncCloudSource(sourceId, String(src.user_id), supabase, url.searchParams.get("country"), { force: true });
      await assertCatalogSnapshotCurrent(sourceId, String(src.user_id), responseSnapshot, supabase);
      catalogVisibilityEpochs.set(req, responseSnapshot.userVisibilityEpoch);
      return json(req, { adminResync: true, sourceId, ...(result as JsonRecord) });
    }
    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = publicErrorCode(error);
    const message = status >= 500
      ? "Catalog synchronization is temporarily unavailable"
      : error instanceof Error ? error.message : "Unexpected error";
    // Never return or log arbitrary provider/gateway/SQL payloads carried by
    // HttpError.details. Only the stable machine code may cross this boundary.
    console.error("[norva-source-sync]", status, code ?? "UNCLASSIFIED");
    return json(req, { error: message, ...(code ? { code } : {}) }, status);
  }
});

const SOURCE_SYNC_PUBLIC_ERROR_CODES = new Set([
  "SOURCE_CATALOG_NOT_VISIBLE",
  "SOURCE_CATALOG_CHANGED",
  "CATALOG_VISIBILITY_UNAVAILABLE",
  "PROVIDER_DIRECT_FALLBACK_RETRYABLE",
]);

function publicErrorCode(error: unknown): string | null {
  if (!(error instanceof HttpError) || !isRecord(error.details)) return null;
  const code = error.details.code;
  return typeof code === "string" && SOURCE_SYNC_PUBLIC_ERROR_CODES.has(code) ? code : null;
}

async function requireUser(req: Request, db: SupabaseClient) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Missing bearer token");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid bearer token", error?.message);
  return { id: data.user.id, email: data.user.email ?? undefined };
}

async function sourceCatalogVisible(sourceId: string, userId: string, db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc("norva_source_catalog_visible", {
    p_source_id: sourceId,
    p_user_id: userId,
  });
  if (error) {
    throw new HttpError(503, "Catalog visibility is temporarily unavailable", {
      code: "CATALOG_VISIBILITY_UNAVAILABLE",
    });
  }
  return data === true;
}

async function assertCatalogVisible(sourceId: string, userId: string, db: SupabaseClient): Promise<void> {
  if (!(await sourceCatalogVisible(sourceId, userId, db))) {
    throw new HttpError(409, "This catalog is not currently available", {
      code: "SOURCE_CATALOG_NOT_VISIBLE",
    });
  }
}

async function readCatalogAccessSnapshot(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  changedDuringOperation: boolean,
): Promise<CatalogAccessSnapshot> {
  try {
    return await readActiveCatalogGenerationSnapshot(db, sourceId, userId);
  } catch (error) {
    throw new HttpError(409, changedDuringOperation
      ? "Catalog access changed while background work was running"
      : "This catalog is not currently available", {
      code: changedDuringOperation ? "SOURCE_CATALOG_CHANGED" : "SOURCE_CATALOG_NOT_VISIBLE",
      cause: isCatalogGenerationSuperseded(error) ? "generation_superseded" : "snapshot_unavailable",
    });
  }
}

async function assertCatalogSnapshotCurrent(
  sourceId: string,
  userId: string,
  expected: CatalogAccessSnapshot,
  db: SupabaseClient,
): Promise<void> {
  try {
    await assertActiveCatalogGenerationCurrent(db, sourceId, userId, expected);
  } catch (_) {
    throw new HttpError(409, "Catalog access changed while background work was running", {
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
  for (const flag of ["liveReady", "browseReady", "usable"]) {
    if (current[flag] === true || patch[flag] === true) merged[flag] = true;
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
  await assertCatalogVisible(sourceId, userId, db);
  const accessSnapshot = await readCatalogAccessSnapshot(sourceId, userId, db, false);
  if (!source.config_ciphertext) throw new HttpError(400, "Source has no managed cloud configuration");

  // Previously-imported catalogue fingerprint, for change-detection.
  const previousSignature = recordOrEmpty(source.config_hint).contentSignature;
  const startedAt = new Date().toISOString();
  const baseHint = recordOrEmpty(source.config_hint);

  // Detection-only (cron): never mutate the catalogue, materialization, signature
  // or sync_status — stream the provider and compare its signature against our
  // last full import, surfacing the app-closed "what's new" signal on growth.
  // Memory-safe (only the running fingerprint is held, never the rows).
  if (opts.rawOnly) {
    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    let result: JsonRecord | null = null;
    if (source.source_type === "xtream") {
      result = await detectXtreamChange(sourceId, userId, config, db, previousSignature, {
        configCiphertext: String(source.config_ciphertext),
        configRevision: accessSnapshot.configRevision,
      });
    } else if (source.source_type === "m3u") {
      result = await syncM3uSource(
        sourceId,
        userId,
        config,
        db,
        country,
        accessSnapshot,
        async () => {},
        { previousSignature, force: false, rawOnly: true },
      ) as unknown as JsonRecord;
    }
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    if (!result) return { sourceId, status: "detected", changed: false };
    if (result.changed) {
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      await maybeRecordContentEvent(db, userId, sourceId, previousSignature, result);
    }
    // Persist the provider identity (additive). Existing sources acquire providerKey on
    // the next detect tick — no full re-sync needed — so the cross-user dedup activates
    // on its own. Read-merge-write to avoid clobbering a concurrent syncProgress writer.
    const detectedKey = stringOr(result.providerKey, "");
    if (detectedKey && detectedKey !== stringOr(recordOrEmpty(source.config_hint).providerKey, "")) {
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      await patchSourceConfigHint(db, sourceId, (hint) => ({ ...hint, providerKey: detectedKey }));
    }
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    return { sourceId, status: "detected", changed: Boolean(result.changed), ...result };
  }

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

  if (source.source_type === "xtream") {
    // Idempotent re-sync: if a discovery chain is already in flight, join it
    // instead of restarting (a restart wipes + re-imports and the two
    // generations deadlock each other). Only force=1 forces a clean restart.
    const cur = recordOrEmpty(baseHint.syncCursor);
    const heartbeat = Date.parse(stringOr(cur.heartbeatAt, "")) || 0;
    const inDiscovery = cur.active === true && stringOr(cur.phase, "") === "discover";
    if (!opts.force && inDiscovery && String(source.sync_status) === "syncing") {
      if (Date.now() - heartbeat < 75_000) {
        await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
        return { sourceId, status: "syncing", started: false, joined: true };
      }
      // Heartbeat went stale → the chain died mid-run; resume without wiping.
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      runInBackground(driveXtreamSyncToReady(sourceId, userId, db));
      return { sourceId, status: "syncing", started: true, resumed: true };
    }

    // "8K"-scale catalogues can't be discovered + imported + materialized in one
    // edge isolate. Reset the resumable cursor, then drive discovery in the
    // background (it self-continues across isolates to the finalize-pending
    // handoff). Return immediately so the caller/route isn't held open.
    const cursor = freshSyncCursor(startedAt, { country, force: Boolean(opts.force), previousSignature });
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    await db
      .from("cloud_sources")
      .update({
        sync_status: "syncing",
        sync_error: null,
        last_synced_at: startedAt,
        config_hint: compactRecord({ ...baseHint, syncProgress: progress, syncCursor: cursor }),
      })
      .eq("id", sourceId)
      .eq("user_id", userId);
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    runInBackground(driveXtreamSyncToReady(sourceId, userId, db));
    return { sourceId, status: "syncing", started: true };
  }

  await db
    .from("cloud_sources")
    .update({
      sync_status: "syncing",
      sync_error: null,
      last_synced_at: startedAt,
      config_hint: compactRecord({ ...baseHint, syncProgress: progress }),
    })
    .eq("id", sourceId)
    .eq("user_id", userId);
  await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);

  const reportProgress: SyncProgressReporter = async (patch: JsonRecord) => {
    progress = mergeSyncProgress(progress, compactRecord({ ...patch, status: "syncing", updatedAt: new Date().toISOString() }));
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
  };

  try {
    const config = await decryptSourceConfig(source.config_ciphertext, await getRuntimeConfig(db));
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    const syncOpts = { previousSignature, force: opts.force, rawOnly: false };
    const result = source.source_type === "m3u"
      ? await syncM3uSource(sourceId, userId, config, db, country, accessSnapshot, reportProgress, syncOpts)
      : { total: 0 };
    const resultRecord = result as JsonRecord;
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);

    if (source.source_type === "m3u" && Number(result.total ?? 0) <= 0) {
      throw new HttpError(422, "No playable catalog items were imported from this source");
    }

    const syncedAt = new Date().toISOString();
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
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

    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    await maybeRecordContentEvent(db, userId, sourceId, previousSignature, resultRecord);
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    return { sourceId, status: "ready", ...result };
  } catch (error) {
    if (isCatalogAccessGuardError(error)) throw error;
    // Provider/DB errors can themselves be the observable side of a cutover.
    // Re-check before writing an error status against the superseded source.
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    const message = formatSourceSyncError(error, "Source sync failed");
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

// ── Release-year backfill ────────────────────────────────────────────────────

const CATALOG_BACKGROUND_LEASE_SECONDS = 180;
const CATALOG_BACKGROUND_EMPTY_PAGE_MAX = 16;
const CATALOG_BACKGROUND_PAGE_LIMIT = 100;
const CATALOG_BACKGROUND_DRAIN_DEADLINE_MS = 45_000;

type CatalogBackgroundMode = "year_pending" | "revalidate_pending" | "search_pending";
type CatalogBackgroundItem = {
  id: string;
  userId: string;
  itemType: "movie" | "series";
  providerTmdbId: string | null;
  title: string;
  originalTitle: string | null;
  releaseYear: number | null;
  metadata: JsonRecord;
  posterUrl: string | null;
  backdropUrl: string | null;
  storageKind: "global" | "projection";
  visibilityEpoch: string;
  payloadUpdatedAt: string;
  bestGenerationId: string | null;
  displayGenerationId: string | null;
};

type CatalogBackgroundClaim = {
  worker: string;
  leaseSequence: number;
  checkpointRevision: string;
  retryBefore: string;
};

type CatalogBackgroundBatch = {
  items: CatalogBackgroundItem[];
  complete: boolean;
  ackRequired: boolean;
  pageDigest: string | null;
  checkpointRevision: string;
  emptyTransitions: number;
};

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrThrow(value: unknown, label: string): string {
  const text = typeof value === "string" ? value : "";
  if (!UUID_TEXT.test(text)) throw new HttpError(503, `Invalid ${label} from catalog background selector`);
  return text.toLowerCase();
}

function nullableUuidOrThrow(value: unknown, label: string): string | null {
  return value === null || value === undefined || value === "" ? null : uuidOrThrow(value, label);
}

function bigintProofOrThrow(value: unknown, label: string): string {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value : "";
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(text)) {
    throw new HttpError(503, `Invalid ${label} from catalog background selector`);
  }
  return text;
}

function backgroundProjectionUnavailable(): HttpError {
  return new HttpError(503, "Catalog background projection is temporarily unavailable", {
    code: "CATALOG_VISIBILITY_UNAVAILABLE",
  });
}

function normalizeCatalogBackgroundItem(value: unknown): CatalogBackgroundItem {
  if (!isRecord(value)) throw backgroundProjectionUnavailable();
  const storageKind = value.storageKind;
  const itemType = value.itemType;
  if (storageKind !== "global" && storageKind !== "projection") throw backgroundProjectionUnavailable();
  if (itemType !== "movie" && itemType !== "series") throw backgroundProjectionUnavailable();
  const displayGenerationId = nullableUuidOrThrow(value.displayGenerationId, "display generation proof");
  if (storageKind === "projection" && !displayGenerationId) throw backgroundProjectionUnavailable();
  const releaseYear = value.releaseYear === null || value.releaseYear === undefined
    ? null
    : Number(value.releaseYear);
  if (releaseYear !== null && (!Number.isInteger(releaseYear) || releaseYear < 1900 || releaseYear > 2100)) {
    throw backgroundProjectionUnavailable();
  }
  const payloadUpdatedAt = typeof value.payloadUpdatedAt === "string" ? value.payloadUpdatedAt : "";
  if (!payloadUpdatedAt || !Number.isFinite(Date.parse(payloadUpdatedAt))) throw backgroundProjectionUnavailable();
  return {
    id: uuidOrThrow(value.id, "title id"),
    userId: uuidOrThrow(value.userId, "title owner"),
    itemType,
    providerTmdbId: stringOrNull(value.providerTmdbId),
    title: stringOr(value.title, ""),
    originalTitle: stringOrNull(value.originalTitle),
    releaseYear,
    metadata: recordOrEmpty(value.metadata),
    posterUrl: stringOrNull(value.posterUrl),
    backdropUrl: stringOrNull(value.backdropUrl),
    storageKind,
    visibilityEpoch: bigintProofOrThrow(value.visibilityEpoch, "visibility epoch"),
    payloadUpdatedAt,
    bestGenerationId: nullableUuidOrThrow(value.bestGenerationId, "best generation proof"),
    displayGenerationId,
  };
}

function positiveIntegerOrThrow(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new HttpError(503, `Invalid ${label} from catalog background selector`);
  }
  return number;
}

function normalizeCatalogBackgroundClaim(
  value: unknown,
  mode: CatalogBackgroundMode,
  worker: string,
): CatalogBackgroundClaim {
  if (!isRecord(value) || value.contract !== "catalog-title-background-mode-v1"
      || value.mode !== mode || value.worker !== worker) throw backgroundProjectionUnavailable();
  const retryBefore = typeof value.retryBefore === "string" ? value.retryBefore : "";
  if (!retryBefore || !Number.isFinite(Date.parse(retryBefore))) throw backgroundProjectionUnavailable();
  return {
    worker,
    leaseSequence: positiveIntegerOrThrow(value.leaseSequence, "background lease sequence"),
    checkpointRevision: bigintProofOrThrow(value.checkpointRevision, "background checkpoint revision"),
    retryBefore,
  };
}

function normalizeCatalogBackgroundClaimPage(
  value: unknown,
  mode: CatalogBackgroundMode,
  requestedLimit: number,
): CatalogBackgroundBatch {
  if (!isRecord(value) || value.contract !== "catalog-title-background-mode-v1"
      || value.mode !== mode || !Array.isArray(value.items)
      || typeof value.complete !== "boolean") throw backgroundProjectionUnavailable();
  const returnedTitles = Number(value.returnedTitles);
  if (!Number.isInteger(returnedTitles) || returnedTitles !== value.items.length
      || returnedTitles < 0 || returnedTitles > requestedLimit) {
    throw backgroundProjectionUnavailable();
  }
  const ackRequired = value.ackRequired === true;
  const pageDigest = typeof value.pageDigest === "string" ? value.pageDigest : null;
  if (returnedTitles > 0 && (!ackRequired || !pageDigest || !/^[0-9a-f]{64}$/.test(pageDigest))) {
    throw backgroundProjectionUnavailable();
  }
  if (returnedTitles === 0 && (ackRequired || pageDigest !== null)) {
    throw backgroundProjectionUnavailable();
  }
  if (value.complete && returnedTitles > 0) throw backgroundProjectionUnavailable();
  if (value.byteCount !== undefined) {
    const byteCount = Number(value.byteCount);
    if (!Number.isInteger(byteCount) || byteCount < 2 || byteCount > 2_097_152) {
      throw backgroundProjectionUnavailable();
    }
  }
  return {
    items: value.items.map((item) => normalizeCatalogBackgroundItem(item)),
    complete: value.complete,
    ackRequired,
    pageDigest,
    checkpointRevision: bigintProofOrThrow(value.checkpointRevision, "background checkpoint revision"),
    emptyTransitions: 0,
  };
}

async function claimCatalogBackgroundMode(
  db: SupabaseClient,
  mode: CatalogBackgroundMode,
  retryBefore: string,
): Promise<CatalogBackgroundClaim | null> {
  const worker = `edge-${mode}-${crypto.randomUUID()}`;
  const { data, error } = await db.rpc("norva_claim_catalog_title_background_mode", {
    p_mode: mode,
    p_worker: worker,
    p_lease_seconds: CATALOG_BACKGROUND_LEASE_SECONDS,
    p_retry_before: retryBefore,
  });
  if (error) {
    if (String(error.code ?? "") === "55P03") return null;
    throw backgroundProjectionUnavailable();
  }
  return normalizeCatalogBackgroundClaim(data, mode, worker);
}

async function selectCatalogBackgroundBatch(
  db: SupabaseClient,
  mode: CatalogBackgroundMode,
  maxItems: number,
  claim: CatalogBackgroundClaim,
): Promise<CatalogBackgroundBatch> {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 500) {
    throw new Error("invalid catalog background item bound");
  }
  let checkpointRevision = claim.checkpointRevision;
  for (let emptyTransitions = 0; emptyTransitions < CATALOG_BACKGROUND_EMPTY_PAGE_MAX; emptyTransitions += 1) {
    const { data, error } = await db.rpc("norva_select_catalog_title_background_claim_page", {
      p_mode: mode,
      p_worker: claim.worker,
      p_expected_lease_sequence: claim.leaseSequence,
      p_expected_revision: checkpointRevision,
      p_limit: maxItems,
    });
    if (error) throw backgroundProjectionUnavailable();
    const page = normalizeCatalogBackgroundClaimPage(data, mode, maxItems);
    page.emptyTransitions = emptyTransitions;
    checkpointRevision = page.checkpointRevision;
    if (page.items.length > 0 || page.complete) return page;
  }
  return {
    items: [],
    complete: false,
    ackRequired: false,
    pageDigest: null,
    checkpointRevision,
    emptyTransitions: CATALOG_BACKGROUND_EMPTY_PAGE_MAX,
  };
}

function isCatalogBackgroundCasConflict(error: unknown): boolean {
  return isRecord(error) && isStaleDatabaseConflict(error);
}

async function applyCatalogBackgroundResult(
  db: SupabaseClient,
  mode: CatalogBackgroundMode,
  item: CatalogBackgroundItem,
  expectedVisibilityEpoch: string,
  result: JsonRecord,
): Promise<{ visibilityEpoch: string; matched: boolean; visibleChanged: boolean } | null> {
  const { data, error } = await db.rpc("norva_apply_catalog_title_background_result", {
    p_mode: mode,
    p_user_id: item.userId,
    p_title_id: item.id,
    p_storage_kind: item.storageKind,
    p_expected_visibility_epoch: expectedVisibilityEpoch,
    p_expected_payload_updated_at: item.payloadUpdatedAt,
    p_expected_display_generation_id: item.displayGenerationId,
    p_result: result,
  });
  if (error) {
    if (isCatalogBackgroundCasConflict(error)) return null;
    throw backgroundProjectionUnavailable();
  }
  if (!isRecord(data) || data.contract !== "catalog-title-background-writer-v3"
      || data.mode !== mode || data.titleId !== item.id
      || data.storageKind !== item.storageKind || data.applied !== true
      || typeof data.matched !== "boolean" || typeof data.visibleChanged !== "boolean") {
    throw backgroundProjectionUnavailable();
  }
  return {
    visibilityEpoch: bigintProofOrThrow(data.visibilityEpoch, "writer visibility epoch"),
    matched: data.matched,
    visibleChanged: data.visibleChanged,
  };
}

async function applyCatalogBackgroundOutcomes(
  db: SupabaseClient,
  mode: CatalogBackgroundMode,
  items: CatalogBackgroundItem[],
  outcomes: Array<JsonRecord | null>,
  concurrency: number,
): Promise<{
  applied: number;
  matched: number;
  visibleChanged: number;
  stale: number;
  processedTitleIds: string[];
}> {
  const groups = new Map<string, Array<{ item: CatalogBackgroundItem; outcome: JsonRecord | null }>>();
  for (let index = 0; index < items.length; index += 1) {
    const group = groups.get(items[index].userId) ?? [];
    group.push({ item: items[index], outcome: outcomes[index] ?? null });
    groups.set(items[index].userId, group);
  }
  const queues = [...groups.values()];
  const summary = {
    applied: 0,
    matched: 0,
    visibleChanged: 0,
    stale: 0,
    processedTitleIds: [] as string[],
  };
  let next = 0;
  const worker = async () => {
    while (next < queues.length) {
      const queue = queues[next++];
      let rollingEpoch: string | null = null;
      for (const entry of queue) {
        if (!entry.outcome) continue;
        const written = await applyCatalogBackgroundResult(
          db,
          mode,
          entry.item,
          rollingEpoch ?? entry.item.visibilityEpoch,
          entry.outcome,
        );
        if (!written) {
          summary.stale += 1;
          continue;
        }
        rollingEpoch = written.visibilityEpoch;
        summary.applied += 1;
        summary.processedTitleIds.push(entry.item.id);
        if (written.matched) summary.matched += 1;
        if (written.visibleChanged) summary.visibleChanged += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queues.length) }, worker));
  return summary;
}

type CatalogBackgroundAck = {
  complete: boolean;
  checkpointRevision: string;
  acknowledgedTitles: number;
  remainingTitles: number;
};

function normalizeCatalogBackgroundAck(
  value: unknown,
  mode: CatalogBackgroundMode,
  expectedAcknowledged: number,
): CatalogBackgroundAck {
  if (!isRecord(value) || value.contract !== "catalog-title-background-mode-v1"
      || value.mode !== mode || typeof value.complete !== "boolean") {
    throw backgroundProjectionUnavailable();
  }
  const acknowledgedTitles = Number(value.acknowledgedTitles);
  const remainingTitles = Number(value.remainingTitles);
  if (!Number.isInteger(acknowledgedTitles) || acknowledgedTitles !== expectedAcknowledged
      || !Number.isInteger(remainingTitles) || remainingTitles < 0 || remainingTitles > 500) {
    throw backgroundProjectionUnavailable();
  }
  return {
    complete: value.complete,
    checkpointRevision: bigintProofOrThrow(value.checkpointRevision, "background checkpoint revision"),
    acknowledgedTitles,
    remainingTitles,
  };
}

async function ackCatalogBackgroundBatch(
  db: SupabaseClient,
  mode: CatalogBackgroundMode,
  claim: CatalogBackgroundClaim,
  batch: CatalogBackgroundBatch,
  processedTitleIds: string[],
): Promise<CatalogBackgroundAck> {
  if (!batch.ackRequired || !batch.pageDigest || processedTitleIds.length < 1) {
    throw new Error("invalid catalog background acknowledgement attempt");
  }
  const { data, error } = await db.rpc("norva_ack_catalog_title_background_claim_page", {
    p_mode: mode,
    p_worker: claim.worker,
    p_expected_lease_sequence: claim.leaseSequence,
    p_expected_revision: batch.checkpointRevision,
    p_expected_page_digest: batch.pageDigest,
    p_processed_title_ids: processedTitleIds,
  });
  if (error) throw backgroundProjectionUnavailable();
  return normalizeCatalogBackgroundAck(data, mode, processedTitleIds.length);
}

// Provider VOD/series lists carry no release year, and many cloud_titles rows are
// "provider_unverified" (TMDB id known, details never fetched) so their
// release_year is null — leaving blanks on the browse grid even after the
// read-time projection in norva-catalog. The durable v4 mode checkpoint walks
// those rows and fills release_year from TMDB: one fetch per distinct
// movie/series id, fanned out to every row that shares it. Resumable +
// idempotent — a found year is written only where release_year is still null.
function tmdbApiKey() {
  return stringOr(
    Deno.env.get("NORVA_TMDB_API_KEY") ?? Deno.env.get("TMDB_API_KEY") ?? Deno.env.get("TMDB_READ_TOKEN"),
    "",
  );
}

// number → year found; null → TMDB has no date (don't retry); "error" → transient.
async function fetchTmdbYear(apiKey: string, itemType: string, tmdbId: string): Promise<number | null | "error"> {
  const endpoint = itemType === "series" ? "tv" : "movie";
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}`);
  const headers: Record<string, string> = {};
  if (apiKey.startsWith("eyJ")) headers.Authorization = `Bearer ${apiKey}`;
  else url.searchParams.set("api_key", apiKey);
  const language = stringOr(Deno.env.get("NORVA_TMDB_LANGUAGE"), "en-US");
  if (language) url.searchParams.set("language", language);
  try {
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return null;            // no such title → stop retrying
    if (!res.ok) return "error";                    // rate-limited / 5xx → retry later
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    const date = String((body?.release_date ?? body?.first_air_date) ?? "");
    const match = date.match(/(19|20)\d{2}/);
    if (!match) return null;                         // matched, but TMDB has no date
    const year = Number(match[0]);
    return Number.isFinite(year) && year >= 1900 && year <= 2100 ? year : null;
  } catch (_) {
    return "error";
  }
}

async function cronBackfillYears(db: SupabaseClient, limit: number, reset: boolean, concurrency: number) {
  const apiKey = tmdbApiKey();
  if (!apiKey) return { error: "tmdb_key_missing", done: true };
  const retryBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const claim = await claimCatalogBackgroundMode(db, "year_pending", retryBefore);
  if (!claim) return { scanned: 0, distinct: 0, found: 0, updated: 0, stale: 0, busy: true, done: false };
  const startedAt = Date.now();
  let remaining = limit;
  let checkpointRevision = claim.checkpointRevision;
  let scanned = 0;
  let distinctFetched = 0;
  let found = 0;
  let updated = 0;
  let stale = 0;
  let acknowledgedTitles = 0;
  let retryPending = 0;
  let tmdbFailureHalted = false;
  let emptyTransitions = 0;
  let done = false;

  while (remaining > 0 && Date.now() - startedAt < CATALOG_BACKGROUND_DRAIN_DEADLINE_MS) {
    claim.checkpointRevision = checkpointRevision;
    const selected = await selectCatalogBackgroundBatch(
      db,
      "year_pending",
      Math.min(CATALOG_BACKGROUND_PAGE_LIMIT, remaining),
      claim,
    );
    checkpointRevision = selected.checkpointRevision;
    emptyTransitions += selected.emptyTransitions;
    const rows = selected.items;
    if (!rows.length) {
      done = selected.complete;
      break;
    }
    scanned += rows.length;
    remaining -= rows.length;

    const distinct = new Map<string, { itemType: "movie" | "series"; tmdbId: string }>();
    for (const row of rows) {
      const tmdbId = stringOr(row.providerTmdbId, "");
      if (!tmdbId) continue;
      const key = `${row.itemType}:${tmdbId}`;
      if (!distinct.has(key)) distinct.set(key, { itemType: row.itemType, tmdbId });
    }
    const entries = [...distinct.values()];
    distinctFetched += entries.length;
    const yearByKey = new Map<string, number | null | "error">();
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const entry = entries[next++];
        const year = await fetchTmdbYear(apiKey, entry.itemType, entry.tmdbId);
        yearByKey.set(`${entry.itemType}:${entry.tmdbId}`, year);
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), entries.length) }, worker));
    found += [...yearByKey.values()].filter((year) => typeof year === "number").length;

    const outcomes = rows.map((row): JsonRecord | null => {
      const year = yearByKey.get(`${row.itemType}:${stringOr(row.providerTmdbId, "")}`);
      return year === undefined || year === "error" ? null : { releaseYear: year };
    });
    const applied = await applyCatalogBackgroundOutcomes(
      db, "year_pending", rows, outcomes, concurrency,
    );
    updated += applied.matched;
    stale += applied.stale;
    if (!applied.processedTitleIds.length) {
      retryPending = rows.length;
      break;
    }
    const acknowledged = await ackCatalogBackgroundBatch(
      db, "year_pending", claim, selected, applied.processedTitleIds,
    );
    checkpointRevision = acknowledged.checkpointRevision;
    acknowledgedTitles += acknowledged.acknowledgedTitles;
    retryPending = acknowledged.remainingTitles;
    if (acknowledged.complete) {
      done = true;
      break;
    }
    if (acknowledged.remainingTitles > 0) break;
  }

  return {
    scanned,
    distinct: distinctFetched,
    found,
    updated,
    stale,
    acknowledged: acknowledgedTitles,
    retryPending,
    busy: false,
    done,
    resetDeferred: reset,
    checkpointRevision,
    emptyTransitions,
    budgetExhausted: !done && remaining > 0
      && Date.now() - startedAt >= CATALOG_BACKGROUND_DRAIN_DEADLINE_MS,
  };
}

// Re-validate titles that have a provider TMDB id but didn't pass the original
// (single-language) sanity check — now scored against EVERY language
// (alternative_titles + translations). Matches are promoted to provider_verified
// and get their i18n stored. Cursor-resumable; drive it like the year backfill.
async function cronRevalidate(db: SupabaseClient, limit: number, reset: boolean, concurrency: number) {
  const apiKey = tmdbApiKey();
  if (!apiKey) return { error: "tmdb_key_missing", done: true };
  const retryBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const claim = await claimCatalogBackgroundMode(db, "revalidate_pending", retryBefore);
  if (!claim) return { scanned: 0, revalidated: 0, stale: 0, busy: true, done: false };
  const startedAt = Date.now();
  let remaining = limit;
  let checkpointRevision = claim.checkpointRevision;
  let scanned = 0;
  let revalidated = 0;
  let stale = 0;
  let acknowledgedTitles = 0;
  let retryPending = 0;
  let emptyTransitions = 0;
  let done = false;

  while (remaining > 0 && Date.now() - startedAt < CATALOG_BACKGROUND_DRAIN_DEADLINE_MS) {
    claim.checkpointRevision = checkpointRevision;
    const selected = await selectCatalogBackgroundBatch(
      db, "revalidate_pending", Math.min(CATALOG_BACKGROUND_PAGE_LIMIT, remaining), claim,
    );
    checkpointRevision = selected.checkpointRevision;
    emptyTransitions += selected.emptyTransitions;
    const rows = selected.items;
    if (!rows.length) {
      done = selected.complete;
      break;
    }
    scanned += rows.length;
    remaining -= rows.length;
    const outcomes: Array<JsonRecord | null> = Array.from({ length: rows.length }, () => null);
    let next = 0;
    const worker = async () => {
      // A TMDB outage must not let every worker spend the full three-attempt
      // budget on every remaining title. Stop distributing new work on the
      // first thrown request: at most the already-running concurrency cohort
      // finishes, keeping the page inside the checkpoint lease. Null outcomes
      // remain durably inflight and are retried by a later invocation.
      while (!tmdbFailureHalted && next < rows.length) {
        const index = next++;
        const row = rows[index];
        const tmdbId = stringOr(row.providerTmdbId, "");
        if (!tmdbId) continue;
        try {
          const validation = await validateTmdbCandidate(apiKey, {
            itemType: row.itemType,
            tmdbId,
            title: stringOr(row.originalTitle ?? row.title, ""),
            year: row.releaseYear != null ? String(row.releaseYear) : null,
          });
          outcomes[index] = validation.valid ? {
            matched: true,
            title: validation.title || row.title,
            originalTitle: row.originalTitle,
            releaseYear: row.releaseYear ?? (validation.year ? Number(validation.year) : null),
            posterUrl: row.posterUrl || validation.posterUrl,
            backdropUrl: row.backdropUrl || validation.backdropUrl,
            metadata: {
              ...row.metadata,
              tmdb: validation.details,
              i18n: validation.i18n,
              tmdbValidation: {
                valid: true,
                title: validation.title,
                year: validation.year,
                confidence: validation.confidence,
                reason: validation.reason,
              },
              revalidatedAt: new Date().toISOString(),
            },
          } : { matched: false };
        } catch (_) {
          tmdbFailureHalted = true;
          // Transient TMDB failure remains durably inflight.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows.length) }, worker));
    const applied = await applyCatalogBackgroundOutcomes(
      db, "revalidate_pending", rows, outcomes, concurrency,
    );
    revalidated += applied.matched;
    stale += applied.stale;
    if (!applied.processedTitleIds.length) {
      retryPending = rows.length;
      break;
    }
    const acknowledged = await ackCatalogBackgroundBatch(
      db, "revalidate_pending", claim, selected, applied.processedTitleIds,
    );
    checkpointRevision = acknowledged.checkpointRevision;
    acknowledgedTitles += acknowledged.acknowledgedTitles;
    retryPending = acknowledged.remainingTitles;
    if (acknowledged.complete) {
      done = true;
      break;
    }
    if (acknowledged.remainingTitles > 0) break;
  }

  return {
    scanned,
    revalidated,
    stale,
    acknowledged: acknowledgedTitles,
    retryPending,
    tmdbFailureHalted,
    busy: false,
    done,
    resetDeferred: reset,
    checkpointRevision,
    emptyTransitions,
    budgetExhausted: !done && remaining > 0
      && Date.now() - startedAt >= CATALOG_BACKGROUND_DRAIN_DEADLINE_MS,
  };
}

// Pre-warm the GLOBAL catalog_titles.i18n for validated matches that still lack any
// localized synopsis (Phase 4). Enrichment already localises matched titles from TMDB
// translations, so this only fills the residual gaps; the on-demand path (norva-catalog
// getTmdbMeta) covers the long tail as it's browsed. ONE full-translations pull per title
// covers every language TMDB has — far cheaper and broader than per-language fetches, and
// it stores the localized title too (from translations, trustworthy). Bounded + attempt-
// stamped so an unmatchable id or a title TMDB has no translations for isn't re-pulled tightly.
async function cronPrewarmI18n(db: SupabaseClient, limit: number, concurrency: number) {
  const apiKey = tmdbApiKey();
  if (!apiKey) return { error: "tmdb_key_missing", done: true };

  const retryBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const { data: rows, error } = await db.rpc("catalog_i18n_prewarm_candidates", {
    p_limit: limit,
    p_retry_before: retryBefore,
  });
  if (error) throw new HttpError(500, "prewarm candidate select failed", error.message);

  const candidates = Array.isArray(rows) ? rows as JsonRecord[] : [];
  const scanned = candidates.length;
  if (!scanned) return { scanned: 0, localized: 0, done: true };

  const stampAttempted = async (itemType: string, tmdbId: string) => {
    await db.from("catalog_titles").update({ i18n_attempted_at: new Date().toISOString() })
      .eq("item_type", itemType).eq("provider_tmdb_id", tmdbId);
  };

  let next = 0;
  let localized = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const row = candidates[next++];
      const itemType: "movie" | "series" = row.item_type === "series" ? "series" : "movie";
      const tmdbId = stringOr(row.provider_tmdb_id, "");
      if (!/^\d+$/.test(tmdbId)) continue;
      try {
        const validation = await validateTmdbCandidate(apiKey, {
          itemType,
          tmdbId,
          title: stringOr(row.title, ""),
          year: row.release_year != null ? String(row.release_year) : null,
        });
        if (validation.valid && validation.i18n && Object.keys(validation.i18n).length) {
          const { error: upErr } = await db.rpc("catalog_upsert_i18n_map", {
            p_item_type: itemType,
            p_provider_tmdb_id: tmdbId,
            p_i18n: validation.i18n,
          });
          if (upErr) continue;             // transient DB error → leave unstamped, retry next run
          localized += 1;                  // success — the RPC already stamped i18n_attempted_at
          continue;
        }
        // No usable localization (unconfident id, or TMDB has no translations) → stamp so the
        // 90-day window keeps the cron from re-pulling it every run.
        await stampAttempted(itemType, tmdbId);
      } catch (_) {
        // A TMDB hiccup must not abort the batch; stamp to avoid a tight retry loop.
        await stampAttempted(itemType, tmdbId).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), candidates.length) }, worker));

  return { scanned, localized, done: scanned < limit };
}

// Search-based matching for UNMATCHED titles (no provider TMDB id): find the title
// on TMDB by name+year and, when it confirms strongly, set the id + verify +
// localize it. Cursor-resumable; drive it like the other backfills. New ids can
// duplicate an existing tmdb: title — run the dedupe migration afterwards.
async function cronSearchMatch(db: SupabaseClient, limit: number, reset: boolean, concurrency: number, userId: string | null = null) {
  const apiKey = tmdbApiKey();
  if (!apiKey) return { error: "tmdb_key_missing", done: true };
  // The v4 checkpoint is intentionally global and durable. A one-off focused
  // selector would bypass its pinned owner/snapshot proof, so focused requests
  // fail closed until they have their own durable scheduling scope.
  if (userId) {
    return {
      error: "focused_mode_requires_durable_scope",
      focused: true,
      scanned: 0,
      matched: 0,
      stale: 0,
      done: false,
    };
  }

  const retryBefore = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const claim = await claimCatalogBackgroundMode(db, "search_pending", retryBefore);
  if (!claim) return { scanned: 0, matched: 0, stale: 0, busy: true, focused: false, done: false };
  const startedAt = Date.now();
  let remaining = limit;
  let checkpointRevision = claim.checkpointRevision;
  let scanned = 0;
  let matched = 0;
  let stale = 0;
  let acknowledgedTitles = 0;
  let retryPending = 0;
  let emptyTransitions = 0;
  let done = false;

  while (remaining > 0 && Date.now() - startedAt < CATALOG_BACKGROUND_DRAIN_DEADLINE_MS) {
    claim.checkpointRevision = checkpointRevision;
    const selected = await selectCatalogBackgroundBatch(
      db, "search_pending", Math.min(CATALOG_BACKGROUND_PAGE_LIMIT, remaining), claim,
    );
    checkpointRevision = selected.checkpointRevision;
    emptyTransitions += selected.emptyTransitions;
    const rows = selected.items;
    if (!rows.length) {
      done = selected.complete;
      break;
    }
    scanned += rows.length;
    remaining -= rows.length;
    const outcomes: Array<JsonRecord | null> = Array.from({ length: rows.length }, () => null);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const index = next++;
        const row = rows[index];
        const title = stringOr(row.originalTitle ?? row.title, "");
        if (!title) continue;
        try {
          const match = await searchTmdbMatch(
            apiKey,
            row.itemType,
            title,
            row.releaseYear != null ? String(row.releaseYear) : null,
            row.posterUrl,
          );
          outcomes[index] = match ? {
            matched: true,
            providerTmdbId: match.tmdbId,
            title: match.title || row.title,
            originalTitle: row.originalTitle,
            posterUrl: match.posterUrl || row.posterUrl,
            backdropUrl: match.backdropUrl || row.backdropUrl,
            releaseYear: match.year ? Number(match.year) : row.releaseYear,
            metadata: {
              ...row.metadata,
              tmdb: match.details,
              i18n: match.i18n,
              tmdbValidation: {
                valid: true,
                title: match.title,
                year: match.year,
                confidence: match.confidence,
                reason: match.reason,
              },
              searchMatchedAt: new Date().toISOString(),
            },
          } : { matched: false };
        } catch (_) { /* transient TMDB failure remains durably inflight */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows.length) }, worker));
    const applied = await applyCatalogBackgroundOutcomes(
      db, "search_pending", rows, outcomes, concurrency,
    );
    matched += applied.matched;
    stale += applied.stale;
    if (!applied.processedTitleIds.length) {
      retryPending = rows.length;
      break;
    }
    const acknowledged = await ackCatalogBackgroundBatch(
      db, "search_pending", claim, selected, applied.processedTitleIds,
    );
    checkpointRevision = acknowledged.checkpointRevision;
    acknowledgedTitles += acknowledged.acknowledgedTitles;
    retryPending = acknowledged.remainingTitles;
    if (acknowledged.complete) {
      done = true;
      break;
    }
    if (acknowledged.remainingTitles > 0) break;
  }

  // Match-driven merge and grid propagation remain in the separate reconcile
  // pipeline; this worker commits only the durable matching outcome.
  return {
    scanned,
    matched,
    stale,
    acknowledged: acknowledgedTitles,
    retryPending,
    busy: false,
    done,
    focused: false,
    resetDeferred: reset,
    checkpointRevision,
    emptyTransitions,
    budgetExhausted: !done && remaining > 0
      && Date.now() - startedAt >= CATALOG_BACKGROUND_DRAIN_DEADLINE_MS,
  };
}

// Dynamic, source-backed catalogue/audio maintenance fleet. Claims are durable
// in Postgres; provider work is backgrounded after the cron response.
type EnrichmentFleetClaim = {
  source_id: string;
  user_id: string;
  claim_token: string;
  failure_count?: number;
  dispatch_count?: number;
};

function enrichmentFleetSummary(payload: unknown): JsonRecord {
  const body = recordOrEmpty(payload);
  // The fleet always dispatches one explicit dimension (fallthrough=false).
  // Persist only that dimension's top-level counters/cursor. Summing `tried`
  // or borrowing a nested result would make one scheduler completion appear
  // to have attempted rows that belonged to another lane.
  const processed = Math.max(0, Number(body.processed) || 0);
  const attempted = Math.max(0, Number(body.attempted) || 0);
  const candidates = Math.max(0, Number(body.candidates) || 0);
  const deferred = Math.max(0, Number(body.deferred) || 0);
  const failed = Math.max(0, Number(body.failed) || 0);
  const backpressured = Math.max(0, Number(body.backpressured) || 0);
  const skipped = stringOrNull(body.skipped ?? body.stoppedAt);
  // A partial final page can contain only failed/deferred rows. The raw worker
  // then reports hasMore=false because candidates < batchLimit, but the lane is
  // not exhausted: those exact files still have durable retry work. Preserve
  // hasMore as a compatibility signal for the current SQL scheduler so lane 11
  // cannot put the whole source to sleep for six hours.
  const pendingTail = processed === 0
    && skipped === null
    && (
      candidates > 0
      || attempted > 0
      || deferred > 0
      || failed > 0
      || backpressured > 0
    );
  const hasMore = body.hasMore === true || pendingTail;
  return compactRecord({
    mode: stringOrNull(body.mode),
    itemType: stringOrNull(body.itemType),
    attempted,
    processed,
    candidates,
    updated: Math.max(0, Number(body.updated ?? body.persisted) || 0),
    persisted: Math.max(0, Number(body.persisted) || 0),
    resolved: Math.max(0, Number(body.resolved) || 0),
    deferred,
    registeredEpisodes: Math.max(0, Number(body.registeredEpisodes) || 0),
    failed,
    backpressured,
    batchLimit: Math.max(0, Number(body.batchLimit) || 0),
    openUntil: stringOrNull(body.openUntil ?? body.open_until),
    nextRetryAt: stringOrNull(body.nextRetryAt ?? body.next_retry_at),
    failureClass: stringOrNull(body.failureClass ?? body.failure_class),
    probeHealth: isRecord(body.probeHealth) ? body.probeHealth : null,
    lastId: processed > 0 ? stringOrNull(body.lastId) : null,
    skipped,
    paused: body.paused === true,
    hasMore,
    pendingTail,
    exhausted: body.exhausted === true || (
      processed === 0
      && !hasMore
      && skipped === null
    ),
  });
}

function enrichmentFleetNextDelay(summary: JsonRecord, lane: number): number {
  const skipped = stringOr(summary.skipped, "");
  if (summary.paused === true) return 30 * 60;
  if (skipped === "episode-audio-scan-disabled") return 30;
  if (skipped === "live-session" || skipped === "pregen-active") return 5 * 60;
  if (skipped === "provider-inventory-backoff") return 30;
  // The provider circuit belongs to file probes, not to the source-wide
  // scheduler. Rotate through the remaining lanes so the metadata-only series
  // inventory can continue. Probe workers re-check the same durable circuit
  // before opening a provider connection, so this does not bypass anti-ban.
  if ((skipped === "circuit_open" || skipped === "circuit-open") && lane < 11) return 30;
  if (skipped === "circuit_open" || skipped === "circuit-open") return 60 * 60;
  // An empty explicit lane must rotate promptly: drained media/speech lanes
  // must not postpone synopsis recovery by hours. The final (provider overview)
  // lane requests a 6h rest; finish_catalog_enrichment_source clamps that to 30s
  // whenever any earlier lane in this same sweep reported work/hasMore.
  if ((skipped === "exhausted" || summary.exhausted === true) && lane < 11) return 30;
  if (skipped === "exhausted") return 6 * 60 * 60;
  if (summary.exhausted === true) return 6 * 60 * 60;
  // A successful bounded lane releases both the user and provider leases.
  // Thirty seconds makes it eligible for the next minute tick without ever
  // allowing two jobs for that account/provider to overlap.
  if (Number(summary.processed) > 0) return 30;
  return 5 * 60;
}

async function finishEnrichmentFleetClaim(
  db: SupabaseClient,
  claim: EnrichmentFleetClaim,
  success: boolean,
  delaySeconds: number,
  result: JsonRecord,
  releaseLeases = true,
) {
  const { error } = await db.rpc("finish_catalog_enrichment_source", {
    p_source_id: claim.source_id,
    p_claim_token: claim.claim_token,
    p_success: success,
    p_next_delay_seconds: delaySeconds,
    p_release_leases: releaseLeases,
    p_result: result,
  });
  if (error) {
    console.error("[enrichment-fleet] unable to finish claim", claim.source_id, error.message);
  }
}

async function runProviderOverviewFleetLane(
  db: SupabaseClient,
  claim: EnrichmentFleetClaim,
) {
  const accessSnapshot = await readCatalogAccessSnapshot(claim.source_id, claim.user_id, db, false);
  const { data: source, error } = await db
    .from("cloud_sources")
    .select("source_type,config_ciphertext")
    .eq("id", claim.source_id)
    .eq("user_id", claim.user_id)
    .maybeSingle();
  if (error) throw new Error(`Unable to load synopsis source: ${error.message}`);
  if (!source) throw new Error("Synopsis source no longer exists");
  if (String(source.source_type) !== "xtream") {
    return {
      mode: "provider-overview",
      processed: 0,
      updated: 0,
      skipped: "unsupported-source",
      hasMore: false,
      exhausted: true,
    };
  }

  // Cross-account fan-out is allowed only after the server-derived stream-id
  // identity is present. A provisional source still runs this lane, but its
  // claim/cache/record RPCs are keyed only by source_id and never consult
  // owner-editable source hints.
  const { data: verifiedIdentity, error: identityError } = await db
    .from("catalog_source_provider_identities")
    .select("identity_id")
    .eq("source_id", claim.source_id)
    .eq("user_id", claim.user_id)
    .maybeSingle();
  if (identityError) throw new Error(`Unable to verify synopsis provider identity: ${identityError.message}`);
  const identityScope = verifiedIdentity?.identity_id ? "verified" : "source";

  if (!source.config_ciphertext) throw new Error("Xtream source has no managed cloud configuration");
  const runtimeConfig = await getRuntimeConfig(db);
  const config = await decryptSourceConfig(String(source.config_ciphertext), runtimeConfig);
  await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = typeof config.username === "string" && config.username.trim() ? config.username : "";
  const password = typeof config.password === "string" && config.password.length ? config.password : "";
  if (!username || !password) throw new Error("Xtream source credentials are incomplete");
  const directFallbackSnapshot = await buildProviderDirectFallbackSnapshot({
    serverUrl,
    username,
    configCiphertext: String(source.config_ciphertext),
    configRevision: accessSnapshot.configRevision,
  });
  const runDirectFallback = createSourceDirectFallbackLeaseRunner({
    db,
    sourceId: claim.source_id,
    userId: claim.user_id,
    ownerScope: "provider-overview",
    ...directFallbackSnapshot,
  });

  const result = await backfillProviderOverviews({
    db,
    userId: claim.user_id,
    sourceId: claim.source_id,
    generation: accessSnapshot,
    limit: 4,
    concurrency: 2,
    identityScope,
    assertSourceCurrent: () => assertCatalogSnapshotCurrent(
      claim.source_id,
      claim.user_id,
      accessSnapshot,
      db,
    ),
    fetchVodInfo: async (externalId) => {
      await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      const payload = await fetchProviderMetadata(runtimeConfig, {
        serverUrl,
        username,
        password,
        action: "get_vod_info",
        params: { vod_id: externalId },
        timeoutMs: 12_000,
      }, { runDirectFallback });
      await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      return payload;
    },
  });
  await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
  return result;
}

async function recordSeriesInventoryOutcome(
  db: SupabaseClient,
  claim: EnrichmentFleetClaim,
  generation: CatalogAccessSnapshot,
  parentSeriesId: string,
  success: boolean,
  episodeCount: number | null,
  retryAt: string,
  details: JsonRecord,
) {
  const { error } = await db.rpc("record_catalog_series_inventory_outcome", {
    p_user: claim.user_id,
    p_source: claim.source_id,
    ...catalogGenerationRpcFence(generation),
    p_parent_series_id: parentSeriesId,
    p_success: success,
    p_episode_count: episodeCount,
    p_retry_at: retryAt,
    p_details: details,
  });
  if (error) {
    if (isCatalogGenerationSuperseded(error)) throw error;
    console.warn(
      "[enrichment-fleet] unable to record series inventory outcome",
      claim.source_id,
      parentSeriesId,
      error.message,
    );
  }
}

async function providerInventoryBackoffState(
  db: SupabaseClient,
  claim: EnrichmentFleetClaim,
): Promise<{ blocked: boolean; nextRetryAt: string | null; failureClass: string | null }> {
  try {
    const { data, error } = await db.rpc("catalog_provider_inventory_backoff_state", {
      p_user: claim.user_id,
      p_source: claim.source_id,
    });
    if (error) return { blocked: false, nextRetryAt: null, failureClass: null };
    const row = (Array.isArray(data) ? data[0] : data) as JsonRecord | null;
    return {
      blocked: row?.blocked === true,
      nextRetryAt: stringOrNull(row?.next_retry_at),
      failureClass: stringOrNull(row?.failure_class),
    };
  } catch (_) {
    // A bookkeeping outage must not strand series discovery. The viewer guard
    // and gateway transport remain authoritative.
    return { blocked: false, nextRetryAt: null, failureClass: null };
  }
}

async function recordProviderInventoryOutcome(
  db: SupabaseClient,
  claim: EnrichmentFleetClaim,
  values: {
    success: boolean;
    status?: number | null;
    code?: string | null;
    transport?: SeriesInventoryTransport | null;
    retryAt?: string | null;
  },
) {
  try {
    const { error } = await db.rpc("record_catalog_provider_inventory_outcome", {
      p_user: claim.user_id,
      p_source: claim.source_id,
      p_success: values.success,
      p_status: values.status ?? null,
      p_code: values.code ?? null,
      p_transport: values.transport ?? null,
      p_retry_at: values.retryAt ?? null,
    });
    if (error) {
      console.warn(
        "[enrichment-fleet] provider inventory retry state unavailable",
        sanitizedProviderCode(error.code) ?? "rpc_failed",
      );
    }
  } catch (_) { /* best-effort provider-specific retry state */ }
}

async function discardEnrichmentSeriesInfoCacheWrite(
  db: SupabaseClient,
  serverHost: string,
  seriesId: string,
  writeMarker: string,
): Promise<void> {
  try {
    await db
      .from("cloud_series_info_cache")
      .delete()
      .eq("server_host", serverHost)
      .eq("series_id", seriesId)
      .eq("fetched_at", writeMarker)
      .eq("updated_at", writeMarker);
  } catch (_) {
    // Best effort. Visibility guards still prevent any subsequent user-facing use.
  }
}

async function runSeriesInventoryFleetLane(
  db: SupabaseClient,
  claim: EnrichmentFleetClaim,
) {
  try {
    const { data: enabled, error } = await db.rpc("feature_flag", {
      p_key: "episode_audio_scan_enabled",
    });
    if (error || enabled !== true) {
      return {
        mode: "series-inventory",
        itemType: "series",
        processed: 0,
        skipped: "episode-audio-scan-disabled",
        hasMore: false,
      };
    }
  } catch (_) {
    return {
      mode: "series-inventory",
      itemType: "series",
      processed: 0,
      skipped: "episode-audio-scan-disabled",
      hasMore: false,
    };
  }

  const accessSnapshot = await readCatalogAccessSnapshot(claim.source_id, claim.user_id, db, false);

  const { data: source, error: sourceError } = await db
    .from("cloud_sources")
    .select("source_type,config_ciphertext")
    .eq("id", claim.source_id)
    .eq("user_id", claim.user_id)
    .maybeSingle();
  if (sourceError) throw new Error(`Unable to load series inventory source: ${sourceError.message}`);
  if (!source) throw new Error("Series inventory source no longer exists");
  if (String(source.source_type) !== "xtream") {
    return {
      mode: "series-inventory",
      itemType: "series",
      processed: 0,
      skipped: "unsupported-source",
      hasMore: false,
      exhausted: true,
    };
  }
  if (!source.config_ciphertext) {
    throw new Error("Xtream source has no managed cloud configuration");
  }

  const runtimeConfig = await getRuntimeConfig(db);
  if (!runtimeConfig.mediaGatewayUrl || !runtimeConfig.mediaGatewayToken) {
    return {
      mode: "series-inventory",
      itemType: "series",
      processed: 0,
      skipped: "media-gateway-unavailable",
      hasMore: false,
    };
  }
  const config = await decryptSourceConfig(String(source.config_ciphertext), runtimeConfig);
  await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
  const serverUrl = normalizeBaseUrl(stringOr(config.serverUrl, ""));
  const username = typeof config.username === "string" && config.username.trim() ? config.username : "";
  const password = typeof config.password === "string" && config.password.length ? config.password : "";
  if (!serverUrl || !username || !password) {
    throw new Error("Xtream source credentials are incomplete");
  }
  let serverHost = "";
  try {
    serverHost = new URL(serverUrl).host;
  } catch (_) {
    throw new Error("Xtream source host is invalid");
  }
  const accountKey = `${serverHost}/${username}`;
  const directFallbackSnapshot = await buildProviderDirectFallbackSnapshot({
    serverUrl,
    username,
    configCiphertext: String(source.config_ciphertext),
    configRevision: accessSnapshot.configRevision,
  });
  const providerBusy = async (): Promise<"busy" | "idle" | "unavailable"> => {
    try {
      const { data, error } = await db.rpc("provider_account_busy", {
        p_key: accountKey,
      });
      if (error) return "unavailable";
      return data === true ? "busy" : "idle";
    } catch (_) {
      return "unavailable";
    }
  };
  const initialAvailability = await providerBusy();
  if (initialAvailability !== "idle") {
    return {
      mode: "series-inventory",
      itemType: "series",
      processed: 0,
      skipped: initialAvailability === "busy"
        ? "provider-account-busy"
        : "provider-guard-unavailable",
      hasMore: false,
    };
  }
  const inventoryBackoff = await providerInventoryBackoffState(db, claim);
  if (inventoryBackoff.blocked) {
    return {
      mode: "series-inventory",
      itemType: "series",
      processed: 0,
      skipped: "provider-inventory-backoff",
      nextRetryAt: inventoryBackoff.nextRetryAt,
      failureClass: inventoryBackoff.failureClass,
      // Deferred work is not evidence that this sweep did work. Otherwise
      // cycle_had_work keeps a blocked source on a permanent 30-second loop.
      hasMore: false,
    };
  }

  const limit = 2;
  const { data: candidateRows, error: candidateError } = await db.rpc(
    "catalog_series_inventory_candidates",
    {
      p_user: claim.user_id,
      p_source: claim.source_id,
      p_limit: limit,
    },
  );
  if (candidateError) {
    throw new Error(`Unable to load series inventory candidates: ${candidateError.message}`);
  }
  const candidates = (Array.isArray(candidateRows) ? candidateRows : [])
    .map((row) => stringOr((row as JsonRecord)?.parent_series_id, ""))
    .filter(Boolean);
  let processed = 0;
  let registeredEpisodes = 0;
  let failed = 0;
  let skipped: string | null = null;

  for (const parentSeriesId of candidates) {
    await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
    const availability = await providerBusy();
    if (availability !== "idle") {
      skipped = availability === "busy"
        ? "provider-account-busy"
        : "provider-guard-unavailable";
      break;
    }
    processed += 1;
    try {
      await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      const inventoryResult = await fetchSeriesInventoryMetadata(
        runtimeConfig,
        {
          serverUrl,
          username,
          password,
          parentSeriesId,
          userId: claim.user_id,
          sourceId: claim.source_id,
          db,
          ...directFallbackSnapshot,
        },
      );
      await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      const payload = recordOrEmpty(stripSeriesInventoryCredentials(
        inventoryResult.payload,
      ));
      const episodes = payload.episodes;
      if (!Array.isArray(episodes) && !isRecord(episodes)) {
        throw new Error("Provider returned no authoritative episode inventory");
      }
      await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      const { data: episodeCount, error: registerError } = await db.rpc(
        "register_catalog_series_episodes",
        {
          p_user_id: claim.user_id,
          p_source_id: claim.source_id,
          ...catalogGenerationRpcFence(accessSnapshot),
          p_parent_series_id: parentSeriesId,
          p_payload: payload,
        },
      );
      if (registerError) {
        throw new Error(`Episode registry rejected the provider payload: ${registerError.message}`);
      }
      const count = Math.max(0, Number(episodeCount) || 0);
      if (count <= 0) {
        throw new Error("Provider returned an empty or non-authoritative episode inventory");
      }
      await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      const nowIso = new Date().toISOString();
      const { error: cacheError } = await db.from("cloud_series_info_cache").upsert(
        {
          server_host: serverHost,
          series_id: parentSeriesId,
          payload,
          fetched_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "server_host,series_id" },
      );
      if (cacheError) {
        console.warn("[enrichment-fleet] series-info cache write deferred", cacheError.message);
      } else {
        try {
          await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
        } catch (guardError) {
          await discardEnrichmentSeriesInfoCacheWrite(db, serverHost, parentSeriesId, nowIso);
          throw guardError;
        }
      }
      try {
        await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
        await db.rpc("hydrate_catalog_episode_file_tracks", {
          p_user_id: claim.user_id,
          p_source_id: claim.source_id,
          ...catalogGenerationRpcFence(accessSnapshot),
          p_parent_series_id: parentSeriesId,
          p_episode_ids: null,
        });
      } catch (_) { /* best-effort cache reuse */ }
      await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      await recordSeriesInventoryOutcome(
        db,
        claim,
        accessSnapshot,
        parentSeriesId,
        true,
        count,
        new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        {
          method: "series-info-v2",
          transport: inventoryResult.transport,
          status: "registered",
        },
      );
      await recordProviderInventoryOutcome(db, claim, {
        success: true,
        transport: inventoryResult.transport,
      });
      registeredEpisodes += count;
    } catch (error) {
      if (isCatalogAccessGuardError(error)) {
        skipped = "source-catalog-changed";
        break;
      }
      try {
        await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      } catch (guardError) {
        if (isCatalogAccessGuardError(guardError)) {
          skipped = "source-catalog-changed";
          break;
        }
        throw guardError;
      }
      const failure = classifySeriesInventoryFailure(error);
      // Viewer and local background work always outrank inventory. A race can
      // happen after provider_account_busy() and must rotate the lane without
      // poisoning the parent series' retry history.
      if (failure.failureClass === "viewer_priority" || failure.failureClass === "background_busy") {
        await recordProviderInventoryOutcome(db, claim, {
          success: false,
          status: failure.status || null,
          code: failure.code,
          transport: failure.transport,
          retryAt: new Date(Date.now() + failure.retryMs).toISOString(),
        });
        skipped = failure.failureClass === "viewer_priority"
          ? "provider-account-busy"
          : "provider-background-busy";
        break;
      }
      failed += 1;
      const retryAt = new Date(Date.now() + failure.retryMs).toISOString();
      const providerScopedFailure = (
        failure.failureClass === "authentication"
        || failure.failureClass === "forbidden"
        || failure.failureClass === "rate_limited"
        || failure.failureClass === "transient"
      );
      // 404/410 and malformed payloads are specific to one parent series.
      // They already have exact catalog_series_inventory_state and must not
      // postpone unrelated series on the same provider account.
      if (providerScopedFailure) {
        await recordProviderInventoryOutcome(db, claim, {
          success: false,
          status: failure.status || null,
          code: failure.code,
          transport: failure.transport,
          retryAt,
        });
      }
      await recordSeriesInventoryOutcome(
        db,
        claim,
        accessSnapshot,
        parentSeriesId,
        false,
        null,
        retryAt,
        {
          method: "series-info-v2",
          status: "retry",
          transport: failure.transport,
          failureClass: failure.failureClass,
          providerStatus: failure.status || null,
          providerCode: failure.code,
        },
      );
      // One provider-level refusal predicts the same result for the rest of the
      // batch. Stop immediately instead of multiplying rate-limit/auth failures.
      if (providerScopedFailure) {
        skipped = failure.failureClass === "rate_limited"
          ? "provider-backpressure"
          : "provider-metadata-failed";
        break;
      }
    }
  }
  return {
    mode: "series-inventory",
    itemType: "series",
    candidates: candidates.length,
    processed,
    updated: registeredEpisodes,
    registeredEpisodes,
    failed,
    skipped,
    hasMore: skipped === null && candidates.length >= limit,
  };
}

async function runEnrichmentFleetClaim(
  db: SupabaseClient,
  claim: EnrichmentFleetClaim,
  backfillToken: string,
) {
  const controller = new AbortController();
  // Series coverage is far behind movies, so the twelve-lane cycle gives every
  // exact-file series stage two turns without raising provider concurrency:
  // inventory (5,9), header probe (2,7), then speech LID (6,10). Each claim
  // still owns the same per-user/provider leases and every provider operation
  // stays sequential. Movie Whisper keeps three turns (1,4,8), with one
  // untagged lane, while movie probe, subtitles and overview retain one each.
  //
  // Compared with the previous 1/1/1 series allocation this doubles the
  // structural ceiling of inventory, episode probes and episode LID. It does
  // not enlarge an individual provider batch, so viewer pre-emption continues
  // to be checked between every file/series rather than only between claims.
  const lane = Math.max(0, Number(claim.dispatch_count) || 0) % 12;
  const subtitleProbe = lane === 3;
  const seriesInventory = lane === 5 || lane === 9;
  const episodeProbe = lane === 2 || lane === 7;
  const episodeSpeech = lane === 6 || lane === 10;
  const speechVerification = lane === 1 || lane === 4 || lane === 8;
  const providerOverview = lane === 11;
  // Progressive episode-probe canary: one of the two lanes moves from four to
  // five files (+12.5% per full cycle). The worker accepts up to six, allowing
  // a later promotion without ever increasing per-provider concurrency.
  const episodeProbeLimit = episodeProbe ? (lane === 7 ? 5 : 4) : 0;
  // Fast language detection still owns a provider connection and is therefore
  // sequential within one source. Two files per claim materially improve
  // throughput while the 540s request budget and 1200s distributed lease keep
  // a slow/silent multi-track file from overlapping the next provider job.
  const timeout = setTimeout(
    () => controller.abort(),
    (speechVerification || episodeSpeech)
      ? 540_000
      : (episodeProbe ? 390_000 : 105_000),
  );
  // Raw probes currently find a usable container tag for nearly every file,
  // hence two tagged lanes. Keep one dedicated untagged lane so generic
  // "Audio 2" tracks cannot starve behind that much larger backlog.
  const speechTarget = speechVerification
    ? (lane === 4 ? "untagged" : "tagged")
    : undefined;
  let responseReceived = false;
  let localLane = false;
  let accessSnapshot: CatalogAccessSnapshot | null = null;
  try {
    // The legacy SQL claim queue predates replacement staging. Re-check the
    // centralized predicate under the lease before any local provider call or
    // playback-worker dispatch. Hidden claims are released normally and delayed
    // so they cannot monopolize the bounded fleet batch.
    if (!(await sourceCatalogVisible(claim.source_id, claim.user_id, db))) {
      await finishEnrichmentFleetClaim(
        db,
        claim,
        true,
        24 * 60 * 60,
        { skipped: "source_not_catalog_visible" },
      );
      return;
    }
    accessSnapshot = await readCatalogAccessSnapshot(claim.source_id, claim.user_id, db, false);
    if (seriesInventory) {
      localLane = true;
      const result = await runSeriesInventoryFleetLane(db, claim);
      const summary = enrichmentFleetSummary(result);
      await finishEnrichmentFleetClaim(
        db,
        claim,
        true,
        enrichmentFleetNextDelay(summary, lane),
        summary,
      );
      return;
    }
    if (providerOverview) {
      localLane = true;
      const result = await runProviderOverviewFleetLane(db, claim);
      const summary = enrichmentFleetSummary(result);
      await finishEnrichmentFleetClaim(
        db,
        claim,
        true,
        enrichmentFleetNextDelay(summary, lane),
        summary,
      );
      return;
    }

    await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
    const response = await fetch(
      `${trimTrailingSlash(SUPABASE_URL)}/functions/v1/norva-playback/audio-backfill`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${backfillToken}`,
          apikey: SUPABASE_SERVICE_KEY,
          "X-Norva-Enrichment-Dispatcher": "dynamic-v1",
        },
        body: JSON.stringify({
          userId: claim.user_id,
          sourceId: claim.source_id,
          type: episodeProbe || episodeSpeech ? "episode" : "movie",
          mode: speechVerification || episodeSpeech ? "whisper" : "probe",
          speechTarget,
          target: subtitleProbe ? "subtitle" : undefined,
          fileScope: true,
          // Every path stays sequential inside a provider account. The real
          // episode canary completed 14 probes / 72 tracks without one unknown
          // or provider failure, so cheap exact probes use the existing
          // four-file safety budget. Episode speech stays one-at-a-time.
          limit: episodeProbe ? episodeProbeLimit : episodeSpeech ? 1 : speechVerification ? 2 : 4,
          concurrency: 1,
          // Lanes are explicit and individually bounded. fallthrough would
          // append a 15-series + 10-subtitle + Whisper chain after an empty
          // primary queue, defeating this request's four-file safety budget.
          fallthrough: false,
        }),
        signal: controller.signal,
      },
    );
    responseReceived = true;
    const payload = await response.json().catch(() => ({}));
    await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
    if (!response.ok) {
      throw new Error(`audio-backfill ${response.status}: ${stringOr(recordOrEmpty(payload).error, "request failed")}`);
    }
    const summary = enrichmentFleetSummary(payload);
    await finishEnrichmentFleetClaim(
      db,
      claim,
      true,
      enrichmentFleetNextDelay(summary, lane),
      summary,
    );
  } catch (error) {
    if (!isCatalogAccessGuardError(error) && accessSnapshot) {
      try {
        await assertCatalogSnapshotCurrent(claim.source_id, claim.user_id, accessSnapshot, db);
      } catch (guardError) {
        if (isCatalogAccessGuardError(guardError)) {
          await finishEnrichmentFleetClaim(
            db,
            claim,
            true,
            24 * 60 * 60,
            { skipped: "source_not_catalog_visible" },
            localLane || responseReceived,
          );
          return;
        }
        throw guardError;
      }
    }
    if (isCatalogAccessGuardError(error)) {
      await finishEnrichmentFleetClaim(
        db,
        claim,
        true,
        24 * 60 * 60,
        { skipped: "source_not_catalog_visible" },
        localLane || responseReceived,
      );
      return;
    }
    const failures = Math.max(0, Number(claim.failure_count) || 0) + 1;
    const retrySeconds = Math.min(6 * 60 * 60, 5 * 60 * Math.pow(2, Math.min(failures - 1, 6)));
    const message = error instanceof Error ? error.message : "audio-backfill failed";
    console.error("[enrichment-fleet] source failed", claim.source_id, message);
    await finishEnrichmentFleetClaim(
      db,
      claim,
      false,
      retrySeconds,
      { error: message.slice(0, 500), failureCount: failures },
      // Abort/network errors do not prove the remote worker stopped: fetch
      // cancellation is not propagated into norva-playback. Keep both global
      // leases until expiry so an orphan cannot overlap the next tick. A
      // completed HTTP error response or local synopsis lane is safe to release.
      localLane || responseReceived,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// Claim a bounded, fair batch and return immediately. The actual provider work
// runs under EdgeRuntime.waitUntil, exactly like the existing refresh driver, so
// pg_net never holds a cron worker for a long container probe.
async function cronEnrichmentFleet(db: SupabaseClient, limit: number, dryRun = false) {
  const backfillToken = Deno.env.get("NORVA_BACKFILL_TOKEN") ?? "";
  if (!backfillToken) {
    throw new HttpError(503, "NORVA_BACKFILL_TOKEN is not configured");
  }

  if (dryRun) {
    // Prove the exact RPC signature is deployed, not merely that a table with
    // the expected name exists.
    const { data: schema, error } = await db.rpc("catalog_enrichment_fleet_preflight");
    if (error) throw new HttpError(503, "Dynamic enrichment schema is not ready", error);

    // Authenticate against the real playback maintenance route without
    // claiming work or opening a provider connection. An authorized empty body
    // deterministically reaches validation and returns 400 Missing userId;
    // 401 proves the two workers disagree on NORVA_BACKFILL_TOKEN.
    const probeController = new AbortController();
    const probeTimeout = setTimeout(() => probeController.abort(), 8_000);
    try {
      const response = await fetch(
        `${trimTrailingSlash(SUPABASE_URL)}/functions/v1/norva-playback/audio-backfill`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${backfillToken}`,
            apikey: SUPABASE_SERVICE_KEY,
            "X-Norva-Enrichment-Dispatcher": "preflight",
          },
          body: "{}",
          signal: probeController.signal,
        },
      );
      const payload = recordOrEmpty(await response.json().catch(() => ({})));
      if (response.status !== 400 || !stringOr(payload.error, "").includes("Missing userId")) {
        throw new HttpError(503, "Playback backfill authentication preflight failed", {
          status: response.status,
          error: stringOrNull(payload.error),
        });
      }
    } finally {
      clearTimeout(probeTimeout);
    }
    return { ok: true, dryRun: true, dispatcher: "dynamic-v1", schema };
  }

  const { data, error } = await db.rpc("claim_catalog_enrichment_sources", {
    p_limit: limit,
    p_lease_seconds: 1200,
  });
  if (error) throw new HttpError(500, "Unable to claim enrichment sources", error);

  const claims = (Array.isArray(data) ? data : [])
    .map((row) => row as EnrichmentFleetClaim)
    .filter((row) => row.source_id && row.user_id && row.claim_token);
  if (claims.length) {
    runInBackground(Promise.all(
      claims.map((claim) => runEnrichmentFleetClaim(db, claim, backfillToken)),
    ));
  }
  return {
    ok: true,
    claimed: claims.length,
    sources: claims.map((claim) => claim.source_id),
  };
}

type CloudAutoRefreshClaim = {
  sourceId: string;
  userId: string;
  sourceType: "xtream" | "m3u";
  leaseSequence: number;
};

function normalizeCloudAutoRefreshClaim(value: unknown): CloudAutoRefreshClaim | null {
  if (!isRecord(value)) return null;
  const sourceId = stringOr(value.source_id ?? value.sourceId, "");
  const userId = stringOr(value.user_id ?? value.userId, "");
  const sourceType = stringOr(value.source_type ?? value.sourceType, "");
  const leaseSequence = Number(value.lease_sequence ?? value.leaseSequence);
  if (!UUID_TEXT.test(sourceId) || !UUID_TEXT.test(userId)
      || !["xtream", "m3u"].includes(sourceType)
      || !Number.isSafeInteger(leaseSequence) || leaseSequence < 1) return null;
  return { sourceId, userId, sourceType: sourceType as "xtream" | "m3u", leaseSequence };
}

function cloudAutoRefreshFailure(error: unknown) {
  const rawStatus = isRecord(error) ? Number(error.status) : Number.NaN;
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : null;
  const classified = classifyOpsSourceError(formatSourceSyncError(error, "Source refresh failed"));
  if (status !== null && [401, 403, 404].includes(status)) {
    const errorKind = status === 404
      ? "not_found"
      : classified === "expired" ? "expired" : "auth";
    return { outcome: "action_required", httpStatus: status, errorKind } as const;
  }
  const errorKind = ["busy", "infra"].includes(classified) ? classified : "unknown";
  return { outcome: "transient_failure", httpStatus: null, errorKind } as const;
}

async function settleCloudAutoRefreshClaim(
  db: SupabaseClient,
  claim: CloudAutoRefreshClaim,
  worker: string,
  outcome: "success" | "not_entitled" | "transient_failure" | "action_required",
  errorKind: string | null = null,
  httpStatus: number | null = null,
) {
  const { data, error } = await db.rpc("norva_settle_cloud_auto_refresh_source", {
    p_source_id: claim.sourceId,
    p_user_id: claim.userId,
    p_worker: worker,
    p_expected_lease_sequence: claim.leaseSequence,
    p_outcome: outcome,
    p_observed_at: new Date().toISOString(),
    p_http_status: httpStatus,
    p_error_kind: errorKind,
  });
  if (error) {
    // A lost lease means a newer claim/config generation owns the continuation.
    // Never repair or overwrite it from the stale worker.
    if (isStaleDatabaseConflict(error)) return null;
    throw new Error(`Unable to settle cloud auto refresh: ${error.message}`);
  }
  return data;
}

// Premium per-user background refresh. PostgreSQL owns fair due selection and
// a monotone lease fence; the Edge worker owns only the bounded provider I/O.
async function cronRefreshDue(db: SupabaseClient) {
  const SCAN_LIMIT = 8;
  const worker = `cloud-auto-refresh:${crypto.randomUUID()}`;
  let toSync: CloudAutoRefreshClaim | null = null;
  let scanned = 0;
  let notEntitled = 0;

  // Claim one row at a time so a non-entitled owner is durably rescheduled and
  // the same tick can continue to the next oldest due source. Bounded scanning
  // prevents one Edge request from becoming an unbounded entitlement sweep.
  for (let scan = 0; scan < SCAN_LIMIT && !toSync; scan++) {
    const { data, error } = await db.rpc("norva_claim_cloud_auto_refresh_sources", {
      p_worker: worker,
      p_limit: 1,
      p_lease_seconds: 720,
    });
    if (error) return { ok: false, error: error.message };
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) break;
    const claim = normalizeCloudAutoRefreshClaim(row);
    if (!claim) return { ok: false, error: "Invalid cloud auto refresh claim" };
    scanned++;

    let entitled = false;
    try {
      const decision = await getEntitlementDecision(db, claim.userId, { autoStartTrial: false });
      entitled = planFeatureEntitled(realPlanCode(decision), "auto_refresh_background");
    } catch (_) { entitled = false; }
    if (!entitled) {
      await settleCloudAutoRefreshClaim(db, claim, worker, "not_entitled");
      notEntitled++;
      continue;
    }
    toSync = claim;
  }

  // Drive the heavy syncs in the background so pg_net gets a fast response rather
  // than holding the connection open for the whole scan. PostgreSQL settles the
  // next window and rejects a completion from any stale lease generation.
  if (toSync) {
    const job = toSync;
    runInBackground((async () => {
      try {
        // Detection-only refresh: fetch the provider and compare its signature
        // against our last full import. It never imports or materializes.
        await syncCloudSource(job.sourceId, job.userId, db, null, { force: false, rawOnly: true });
        await settleCloudAutoRefreshClaim(db, job, worker, "success");
      } catch (error) {
        const failure = cloudAutoRefreshFailure(error);
        await settleCloudAutoRefreshClaim(
          db,
          job,
          worker,
          failure.outcome,
          failure.errorKind,
          failure.httpStatus,
        );
      }
    })());
  }

  return { ok: true, scanned, locked: toSync ? 1 : 0, skipped: 0, notEntitled };
}

// Watchdog for the resumable discovery chain. An isolate can occasionally be
// recycled mid-step without erroring or self-invoking (e.g. killed during a
// backoff), leaving a source "syncing" with an active discover cursor and a stale
// heartbeat. This re-kicks those so a big import always finishes — even app-closed.
async function cronResumeStuck(db: SupabaseClient) {
  // A finalize chain reports progress every batch (~4s), so 60s of silence means the
  // background isolate was torn down and the chain broke — revive it within ~1-2 min
  // (this cron runs every minute). (30s was tried but exhausted pg_cron's worker pool —
  // "job startup timeout" — so the watchdog itself stopped firing reliably; 1 min is the
  // stable sweet spot, still 2x faster than the old 2 min.) Discovery heartbeats less
  // often, so keep its threshold conservative to avoid double-driving a still-live import.
  const now = Date.now();
  const staleFinalizeIso = new Date(now - 60_000).toISOString();
  const staleDiscoverIso = new Date(now - 120_000).toISOString();
  // Include "error" so a finalize that tripped a non-terminal failure isn't stranded:
  // if it has a finalize cursor (it was mid-build), the watchdog resumes it from there
  // (finalizeCloudSource resets sync_status back to "syncing" on its first batch). A 60s
  // staleness gate keeps this to ~one retry/min for a genuinely broken source.
  const { data, error } = await db
    .from("cloud_catalog_visible_sources")
    .select("id,user_id,sync_status,config_hint")
    .in("sync_status", ["syncing", "error"])
    .eq("source_type", "xtream")
    .is("deleted_at", null) // never resurrect a source the user removed (soft-deleted, being reaped)
    .eq("enabled", true)    // a disabled source is paused — don't resume it
    // Oldest-first so the highest-priority queued import (the one admitHeavyImport will
    // admit next) is among the ≤5 we re-kick — slots free up to the front of the queue.
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) return { ok: false, error: error.message };
  const resumed: string[] = [];
  const finalizingStages = new Set(["materializing", "building_titles", "building_live_channels", "building_live_variants", "finalizing"]);
  const finalizePhases = new Set(["live", "live_channels", "live_variants", "titles", "complete"]);
  for (const src of (data ?? [])) {
    const hint = recordOrEmpty(src.config_hint);
    const cursor = recordOrEmpty(hint.syncCursor);
    const progress = recordOrEmpty(hint.syncProgress);
    const finalizeCursor = recordOrEmpty(hint.finalizeCursor);
    const isError = String(src.sync_status) === "error";
    // Resume discovery even when the source errored: a large/slow discovery that
    // exhausted its continuation budget — or hit any non-503 error — still carries
    // an active discover cursor and must be picked back up, not stranded behind a
    // "Repair login" card. driveXtreamSyncToReady resets the budget on revival.
    const inDiscovery = cursor.active === true && stringOr(cursor.phase, "") === "discover";
    // A finalize is resumable when it's actively in a finalize stage, OR it errored but
    // still carries a finalize cursor (so we know where to pick the build back up).
    const inFinalize = !inDiscovery
      && (finalizingStages.has(stringOr(progress.stage, "")) || (isError && finalizePhases.has(stringOr(finalizeCursor.phase, ""))));
    if (!inDiscovery && !inFinalize) continue;
    // Runs that entered finalization before the durable catalogue-version proof
    // was deployed can have a complete finalize cursor but no authoritative
    // {catalogVersion, counts.total} binding.  The READY prune must never infer
    // that identity from the rows already present.  Restart the non-destructive
    // discovery walk instead: it stamps a fresh runVersion on every item it
    // actually sees, persists the exact total, and then hands back to the same
    // finalize cursor.  The previously active catalogue remains visible during
    // the walk, so this is both fail-closed and transparent to the user.
    const catalogVersion = Number(progress.catalogVersion);
    const expectedTotal = Number(recordOrEmpty(progress.counts).total);
    const missingFinalizeProof = inFinalize && (
      !Number.isSafeInteger(catalogVersion) || catalogVersion <= 0 ||
      !Number.isSafeInteger(expectedTotal) || expectedTotal < 0
    );
    // Single-flight gate: a live finalize worker forward-dates this lease before every
    // batch. While it's unexpired a worker IS alive — even if its last progress write is
    // old because the batch is slow under load — so don't stack a duplicate finalizer.
    // That duplicate-herd is exactly what saturated Postgres and broke logins. An
    // expired/absent lease means the worker died: fall through and resume it.
    const finalizeLease = recordOrEmpty(hint.finalizeLease);
    const leaseUntil = stringOr(finalizeLease.until, "");
    if (inFinalize && leaseUntil && leaseUntil > new Date(now).toISOString()) continue;
    // Recent activity (heartbeat / startedAt for discovery, progress updatedAt for
    // finalize) → still alive; only re-kick a genuinely stalled run.
    const lastSeen = inDiscovery
      ? (stringOr(cursor.heartbeatAt, "") || stringOr(cursor.startedAt, ""))
      : stringOr(progress.updatedAt, "");
    const staleIso = inDiscovery ? staleDiscoverIso : staleFinalizeIso;
    if (lastSeen && lastSeen > staleIso) continue;
    if (inDiscovery || missingFinalizeProof) {
      runInBackground(driveXtreamSyncToReady(String(src.id), String(src.user_id), db));
    }
    else runInBackground(driveFinalizeToReady(db, String(src.id), String(src.user_id), null));
    resumed.push(String(src.id));
    if (resumed.length >= 5) break;
  }
  return { ok: true, scanned: (data ?? []).length, resumed };
}

// Service-authed entry point to finish a source's materialization without a user
// session. Looks up the owning user and drives the resumable finalize phases in
// the background, returning immediately.
async function cronFinalizeSource(db: SupabaseClient, sourceId: string, country: string | null) {
  const { data: source, error } = await db
    .from("cloud_catalog_visible_sources")
    .select("id,user_id")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!source) return { ok: false, error: "source not found" };
  runInBackground(driveFinalizeToReady(db, sourceId, String(source.user_id), country));
  return { ok: true, started: true, sourceId };
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
    const { count, error } = await db.from("cloud_catalog_visible_sources")
      .select("id", { count: "exact", head: true })
      .eq("sync_status", "syncing")
      .eq("source_type", "xtream")
      .is("deleted_at", null) // a removed (soft-deleted) source must not hold an import slot ahead of others
      .lt("created_at", createdAt)
      .neq("id", sourceId);
    if (error) return false;     // fail CLOSED — defer; watchdog retries
    return (count ?? 0) < max;
  } catch (_) {
    return false;                // fail CLOSED
  }
}

// Walk the resumable finalize phases (live → titles → complete) to completion.
// Bounded by a wall-clock budget; the {phase, offset} cursor is persisted so a
// fresh isolate resumes where the last left off, and the driver self-invokes the
// next isolate at the budget — a huge catalogue (~200 batches) finishes
// hands-off, app-closed, without the client's ~160-call ceiling.
function isTransientFinalizeError(error: unknown): boolean {
  const details = isRecord(error) ? error : {};
  const message = error instanceof Error ? error.message : String(details.message ?? error);
  const diagnostic = `${message} ${JSON.stringify(details)}`;
  return (error instanceof HttpError && error.status === 503)
    || /resource|timeout|timing out|upstream server|compute|deadlock|lock|statement|canceling|57014/i.test(diagnostic);
}

async function driveFinalizeToReady(db: SupabaseClient, sourceId: string, userId: string, country: string | null) {
  if (!(await sourceCatalogVisible(sourceId, userId, db))) return;
  const accessSnapshot = await readCatalogAccessSnapshot(sourceId, userId, db, false);
  // Self-hosted Edge begins wall-clock termination around 60 seconds. Finish
  // the current bounded statement, persist the cursor and hand off from a fresh
  // isolate before that boundary instead of dying with a four-minute lease.
  const runBudgetMs = boundedInt(Deno.env.get("NORVA_FINALIZE_RUN_BUDGET_MS"), 45_000, 15_000, 50_000);
  const deadline = Date.now() + runBudgetMs;
  const { data: src0 } = await db.from("cloud_sources").select("config_hint,sync_status,created_at").eq("id", sourceId).maybeSingle();
  if (src0 && String(src0.sync_status) === "ready") return; // already done

  // Global admission control (discovery + finalize share ONE budget): defer if too many
  // older imports run ahead. Deferring just returns — the source stays "syncing" with its
  // finalize cursor, so the 1-min watchdog resumes it the instant a slot frees. See
  // admitHeavyImport for the deterministic-priority / fail-closed semantics.
  if (!(await admitHeavyImport(db, sourceId, src0?.created_at ? String(src0.created_at) : null, heavyImportBudget()))) return;

  // Single-flight lease (anti-herd): one finalize worker per source. The every-minute
  // watchdog + the self-invoke chain would otherwise stack concurrent finalizers whose
  // batches slow each other past the 60s staleness gate, snowballing into a Postgres-
  // saturating herd — the failure that starved GoTrue's connections and locked users
  // out. We forward-date a lease before each batch; the watchdog skips a source whose
  // lease is still fresh, and the lease auto-expires if this isolate dies, so a
  // genuinely-dead finalize is still revived after the TTL.
  const leaseTtlMs = boundedInt(Deno.env.get("NORVA_FINALIZE_LEASE_TTL_MS"), 240_000, 30_000, 900_000);
  const leaseToken = crypto.randomUUID();
  if (!(await claimFinalizeLease(db, sourceId, userId, leaseToken, leaseTtlMs))) return;
  await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
  await stampFinalizeLease(db, sourceId, leaseTtlMs); // cover the first batch immediately

  const fc = recordOrEmpty(recordOrEmpty(src0?.config_hint).finalizeCursor);
  let phase = stringOr(fc.phase, "live");
  let offset = Number(fc.offset) || 0;
  let afterId = stringOr(fc.afterId, "");
  let guard = 0;
  // Throttle between batches so this background finalize never monopolises the shared
  // DB: the per-batch title upserts fire several heavy triggers, and run back-to-back
  // they saturate Postgres so live browse queries (normally ~tens of ms) time out. A
  // pause between batches keeps the finalize's duty-cycle well under 100%, leaving slots
  // for foreground traffic — a huge provider can finish in the background without ever
  // making the app feel slow. Tunable via env without a redeploy (0 disables).
  const longThrottleMs = boundedInt(Deno.env.get("NORVA_FINALIZE_THROTTLE_MS"), 2500, 0, 30000);
  const firstSliceThrottleMs = boundedInt(Deno.env.get("NORVA_FINALIZE_FIRST_SLICE_THROTTLE_MS"), 150, 0, 5000);
  let firstSliceReady = recordOrEmpty(recordOrEmpty(src0?.config_hint).syncProgress).browseReady === true
    || recordOrEmpty(recordOrEmpty(src0?.config_hint).syncProgress).usable === true;
  while (Date.now() < deadline && guard++ < 400) {
    try {
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    } catch (guardError) {
      if (isCatalogAccessGuardError(guardError)) return;
      throw guardError;
    }
    let result: JsonRecord;
    try {
      // Smaller titles batch: the per-batch cloud_titles/title_variant upserts must finish
      // inside the authenticator's 8s statement_timeout even under concurrent read load AND
      // a re-walk that re-fires the keep-best / mirror triggers on already-built rows. The
      // upsert of 500 rows measured ~6.4s under load — too close to the ceiling — so 300
      // buys headroom; the cost is just more (cheap) self-invocations.
      const batchLimit = phase === "titles" ? 300 : 1500;
      result = await finalizeCloudSource(sourceId, userId, db, { country, phase, offset, afterId, limit: batchLimit }) as unknown as JsonRecord;
    } catch (e) {
      if (isCatalogAccessGuardError(e)) return;
      // Transient contention/compute spike → continue in a fresh isolate; a real
      // error (e.g. 422 no items) surfaces and stops the chain. A statement timeout
      // surfaces as a PLAIN Error (not HttpError), so match the message regardless of
      // type — otherwise a timed-out batch wrongly stops the whole finalize.
      const transient = isTransientFinalizeError(e);
      console.error("[cron] finalize batch failed", sourceId, transient ? "(transient)" : "", e);
      // PostgREST can time out before PostgreSQL has finished cancelling the
      // statement. Keep the durable claim until its TTL instead of launching a
      // successor into locks still held by the abandoned query. The watchdog
      // resumes once both the DB statement and this lease are guaranteed stale.
      return;
    }
    // finalizeCloudSource owns a fresh per-batch snapshot and may legitimately
    // advance the account cache epoch through a fenced visible write or prune.
    // Join that monotone epoch before continuing the long-lived driver, while
    // the helper still rejects any generation/config/source-authority change.
    await adoptActiveCatalogUserVisibilityEpoch(db, sourceId, userId, accessSnapshot);
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    if (String(result.status) === "ready") {
      await patchSourceConfigHint(db, sourceId, (hint) => { delete hint.finalizeCursor; delete hint.finalizeLease; return hint; });
      await releaseFinalizeLease(db, sourceId, userId, leaseToken);
      return;
    }
    phase = stringOr(result.nextPhase, "complete");
    offset = Number(result.nextOffset) || 0;
    afterId = stringOr(result.nextAfterId, afterId);
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    if (!(await renewFinalizeLease(db, sourceId, userId, leaseToken, leaseTtlMs))) return;
    await patchSourceConfigHint(db, sourceId, (hint) => {
      hint.finalizeCursor = { phase, offset, afterId };
      // Refresh the single-flight lease before the next batch (folded into the cursor
      // write so it adds no extra round-trip): keeps the watchdog from double-driving us.
      hint.finalizeLease = { until: new Date(Date.now() + leaseTtlMs).toISOString() };
      // Drop the now-dead discovery cursor (cats + sig maps, ~13 KB) if a source reached
      // finalize before that cleanup deployed — otherwise every heartbeat re-writes it for
      // nothing. Discovery is long done here; its signature lives in contentSignature.
      delete hint.syncCursor;
      return hint;
    });
    if (result.browseReady === true || result.usable === true) firstSliceReady = true;
    const throttleMs = firstSliceReady ? longThrottleMs : firstSliceThrottleMs;
    if (throttleMs > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, throttleMs));
  }
  // Budget/guard hit before ready → continue in a fresh isolate.
  await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
  await releaseFinalizeLease(db, sourceId, userId, leaseToken);
  await selfInvokeFinalize(sourceId, country);
}

async function pruneCatalogGenerationBeforeReady(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  generation: CatalogAccessSnapshot,
) {
  const { data, error } = await db.rpc("norva_prune_catalog_generation_before_ready", {
    p_source_id: sourceId,
    p_user_id: userId,
    ...catalogGenerationRpcFence(generation),
    p_limit: 200,
  });
  if (error) throwDb(error, "Unable to prove catalog prune before ready");
  const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  const returned = recordOrEmpty(result.writeSnapshot ?? result.write_snapshot);
  const nextSnapshot = {
    generationId: stringOr(returned.generationId ?? returned.generation_id, ""),
    headRevision: String(returned.headRevision ?? returned.head_revision ?? ""),
    configRevision: String(returned.configRevision ?? returned.config_revision ?? ""),
    sourceVisibilityEpoch: String(
      returned.sourceVisibilityEpoch ?? returned.source_visibility_epoch ?? "",
    ),
    userVisibilityEpoch: String(
      returned.userVisibilityEpoch ?? returned.user_visibility_epoch ?? "",
    ),
  };
  if (
    !nextSnapshot.generationId || !nextSnapshot.headRevision ||
    !nextSnapshot.configRevision || !nextSnapshot.sourceVisibilityEpoch ||
    !nextSnapshot.userVisibilityEpoch ||
    nextSnapshot.generationId !== generation.generationId ||
    nextSnapshot.headRevision !== generation.headRevision ||
    nextSnapshot.configRevision !== generation.configRevision ||
    nextSnapshot.sourceVisibilityEpoch !== generation.sourceVisibilityEpoch
  ) {
    throw new HttpError(409, "Catalog access changed during ready prune", {
      code: "SOURCE_CATALOG_CHANGED",
    });
  }
  // This is the sole allowed self-induced fence advance: the delete batch bumped
  // the user visibility epoch and the same transaction returned its exact value.
  generation.userVisibilityEpoch = nextSnapshot.userVisibilityEpoch;
  return {
    catalogVersion: Number(result.catalogVersion) || 0,
    deletedRows: Math.max(0, Number(result.deletedRows) || 0),
    complete: result.complete === true,
  };
}

// Read-merge-write a single config_hint mutation (preserves concurrent writers'
// fields like syncProgress).
async function patchSourceConfigHint(db: SupabaseClient, sourceId: string, mutate: (hint: JsonRecord) => JsonRecord) {
  const { data } = await db.from("cloud_sources").select("config_hint").eq("id", sourceId).maybeSingle();
  const hint = mutate(recordOrEmpty(data?.config_hint));
  await db.from("cloud_sources").update({ config_hint: compactRecord(hint) }).eq("id", sourceId);
}

// Forward-date the finalize single-flight lease so the watchdog treats this worker as
// alive across a (possibly slow) batch. Best-effort: a write hiccup just means the
// watchdog might resume sooner — it never blocks the finalize itself.
async function stampFinalizeLease(db: SupabaseClient, sourceId: string, ttlMs: number) {
  try {
    await patchSourceConfigHint(db, sourceId, (hint) => {
      hint.finalizeLease = { until: new Date(Date.now() + ttlMs).toISOString() };
      return hint;
    });
  } catch (_) { /* best-effort heartbeat */ }
}

async function claimFinalizeLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
  ttlMs: number,
) {
  const { data, error } = await db.rpc("norva_claim_source_finalize_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_ttl_seconds: Math.max(30, Math.ceil(ttlMs / 1000)),
  });
  return !error && data === true;
}

async function renewFinalizeLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
  ttlMs: number,
) {
  const { data, error } = await db.rpc("norva_renew_source_finalize_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
    p_ttl_seconds: Math.max(30, Math.ceil(ttlMs / 1000)),
  });
  return !error && data === true;
}

async function releaseFinalizeLease(
  db: SupabaseClient,
  sourceId: string,
  userId: string,
  leaseToken: string,
) {
  await db.rpc("norva_release_source_finalize_lease", {
    p_source_id: sourceId,
    p_user_id: userId,
    p_lease_token: leaseToken,
  });
}

// Kick a fresh finalize isolate (resumes from the persisted finalize cursor).
async function selfInvokeFinalize(sourceId: string, country: string | null) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const q = country ? `?country=${encodeURIComponent(country)}` : "";
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/norva-source-sync/cron/finalize/${encodeURIComponent(sourceId)}${q}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "content-type": "application/json" },
    });
  } catch (error) {
    console.error("[norva-source-sync] self-invoke finalize failed", sourceId, error);
  }
}

type FinalizeCloudSourceOptions = {
  country: string | null;
  phase: string;
  offset: number;
  afterId?: string;
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
  const versionedCatalog = stringOr(source.source_type, "") === "xtream";
  await assertCatalogVisible(sourceId, userId, db);
  const accessSnapshot = await readCatalogAccessSnapshot(sourceId, userId, db, false);

  const baseHint = recordOrEmpty(source.config_hint);
  const existingProgress = recordOrEmpty(baseHint.syncProgress);
  const startedAt = stringOr(existingProgress.startedAt ?? source.last_synced_at, new Date().toISOString());
  const phase = normalizeFinalizePhase(options.phase);
  const batchLimit = Math.max(1, Math.min(2000, options.limit || 1000));
  const batchOffset = Math.max(0, options.offset || 0);
  const batchAfterId = stringOr(options.afterId, "");
  const counts = await countSourceItems(sourceId, userId, db, accessSnapshot, existingProgress);
  await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
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
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    await writeSourceSyncProgress(db, sourceId, userId, baseHint, progress);
  };

  await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
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

    const config: JsonRecord = source.config_ciphertext
      ? await decryptSourceConfig(String(source.config_ciphertext), await getRuntimeConfig(db)).catch(() => ({} as JsonRecord))
      : {};
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);

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

    if (phase === "live" || phase === "live_channels" || phase === "live_variants") {
      const totalVod = counts.movies + counts.series;
      // Keep each live slice inside both the Edge lifetime and PostgreSQL's
      // statement timeout. Channel/variant writes are further bounded to 100
      // rows in live-materialization.ts. Generation guards are intentionally
      // expensive per row, so keep the whole slice inside the 90-second Edge budget.
      const LIVE_CHUNK = 10;
      if (batchOffset === 0) {
        await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
        const cleared = await clearLiveMaterialization(db, sourceId, userId, accessSnapshot);
        if (!cleared.complete) {
          return {
            sourceId, status: "syncing", phase: "live",
            nextPhase: "live", nextOffset: 0, limit: LIVE_CHUNK, totalVod, ...result,
            liveCatalog: {
              rawLive: counts.live,
              clearing: true,
              deletedRows: cleared.deletedRows,
              callerProtocol: cleared.callerProtocol,
            },
          };
        }
      }
      if (counts.live <= 0) {
        await reportProgress({
          liveReady: true,
          ...(totalVod <= 0 ? { browseReady: true, usable: true } : {}),
        });
        return {
          sourceId, status: "syncing", phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0, limit: batchLimit, totalVod, liveReady: true,
          ...(totalVod <= 0 ? { browseReady: true, usable: true } : {}),
          ...result,
          liveCatalog: { rawLive: 0, logicalChannels: 0, liveVariants: 0, skipped: true },
        };
      }
      // Materialise the live catalogue in bounded chunks: a 50k+ channel list
      // can't be loaded + name-parsed whole in one isolate (it exceeds the edge
      // compute limit). Walk live rows by offset, clearing once at the start;
      // channels/variants merge across chunks by their logical/stream keys.
      const liveChunk = await loadSourceItems(sourceId, userId, db, accessSnapshot, {
        itemTypes: ["live"], offset: batchOffset, limit: LIVE_CHUNK,
      });
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      if (!liveChunk.length) {
        await reportProgress({
          stage: "building_titles",
          percent: 86,
          liveReady: true,
          ...(totalVod <= 0 ? { browseReady: true, usable: true } : {}),
          steps: { finalize: { status: "running" } },
        });
        return {
          sourceId, status: "syncing", phase: "live",
          nextPhase: totalVod > 0 ? "titles" : "complete",
          nextOffset: 0, limit: batchLimit, totalVod, liveReady: true,
          ...(totalVod <= 0 ? { browseReady: true, usable: true } : {}),
          ...result,
          liveCatalog: { rawLive: counts.live, done: true },
        };
      }
      const mat = await materializeLiveChunk(db, {
        sourceId, userId, rows: liveChunk,
        country: options.country || stringOr(config.country, "FR"),
        generation: accessSnapshot,
      });
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      const nextOffset = batchOffset + liveChunk.length;
      await reportProgress({
        stage: "building_live_channels",
        percent: Math.max(76, Math.min(85, 76 + Math.round((9 * nextOffset) / Math.max(1, counts.live)))),
        liveReady: true,
        steps: { finalize: { status: "running" } },
      });
      return {
        sourceId, status: "syncing", phase: "live",
        nextPhase: "live", nextOffset, limit: LIVE_CHUNK, totalVod, liveReady: true, ...result,
        liveCatalog: { ...mat, rawLive: counts.live, offset: nextOffset },
      };
    }

    if (phase === "titles") {
      const totalVod = counts.movies + counts.series;
      // `totalVod` counts the freshly discovered version, while the physical
      // generation may still be a safe superset if discovery's prune timed out.
      // Once the logical offset is saturated, remove old versions in bounded,
      // generation-fenced batches before walking any remaining current rows.
      if (versionedCatalog && batchOffset >= totalVod) {
        const prune = await pruneCatalogGenerationBeforeReady(
          db,
          sourceId,
          userId,
          accessSnapshot,
        );
        await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
        if (!prune.complete) {
          await reportProgress({
            stage: "finalizing",
            percent: 100,
            liveReady: true,
            browseReady: true,
            usable: true,
            steps: { finalize: { status: "running" } },
          });
          return {
            sourceId,
            status: "syncing",
            phase: "titles",
            nextPhase: "titles",
            nextOffset: batchOffset,
            nextAfterId: batchAfterId,
            totalVod,
            liveReady: true,
            browseReady: true,
            usable: true,
            readyPrune: prune,
            ...result,
          };
        }
      }
      const rows = await loadSourceItems(sourceId, userId, db, accessSnapshot, {
        itemTypes: ["movie", "series"],
        afterId: batchAfterId,
        limit: batchLimit,
      });
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      const sourceType = stringOr(source.source_type, "");
      const rcTitles = await getRuntimeConfig(db);
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      const titleProjection = await refreshVodTitleProjection({
        sourceId,
        userId,
        rows,
        db,
        generation: accessSnapshot,
        xtreamConfig: sourceType === "xtream" && config.serverUrl && config.username && config.password
          ? {
            serverUrl: normalizeBaseUrl(stringOr(config.serverUrl, "")),
            username: typeof config.username === "string" && config.username.trim() ? config.username : "",
            password: typeof config.password === "string" && config.password.length ? config.password : "",
          }
          : null,
        mediaGatewayUrl: rcTitles.mediaGatewayUrl,
        mediaGatewayToken: rcTitles.mediaGatewayToken,
        directFallbackLease: {
          db,
          sourceId,
          userId,
          ownerScope: "source-sync-title-projection",
          configCiphertext: String(source.config_ciphertext ?? ""),
          configRevision: accessSnapshot.configRevision,
        },
        vodInfoLimit: boundedInt(Deno.env.get("NORVA_VOD_INFO_FINALIZE_LIMIT"), 0, 0, 1000),
        // Onboarding B: keep inline enrichment small so the user is released fast; the
        // scheduled enrichment crons + the cross-user reuse + the header bar fill the rest.
        // Defer TMDB validation to the background crons — at huge-catalogue scale
        // it's hundreds of inline lookups; titles still appear from provider data.
        tmdbValidateLimit: boundedInt(Deno.env.get("NORVA_TMDB_VALIDATE_FINALIZE_LIMIT"), 0, 0, 1000),
        assertSourceCurrent: () => assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db),
      });
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      const nextOffset = Math.min(totalVod, batchOffset + rows.length);
      const nextAfterId = rows.length ? String((rows[rows.length - 1] as { id?: unknown }).id ?? batchAfterId) : batchAfterId;
      // Keyset done: a page shorter than the effective page size is the last one.
      // Cap the comparison at PostgREST's 1000-row response limit, so a caller that
      // passes batchLimit >= 1000 (e.g. /cron/finalize-step's 1500 default) never
      // reads a capped 1000-row page as "short" and stops after a single batch.
      const pageCap = Math.min(batchLimit, 1000);
      const done = rows.length === 0 || rows.length < pageCap;
      // "Usable" = onboarding-complete FOR THE USER: the live phase is already done (titles
      // only runs after it) AND the first block of movies/series is built — enough to fill
      // Home + the first grid pages. Past this the catalogue is navigable; the rest of a
      // huge VOD long-tail (which can take hours/days) is a SILENT background top-up, not a
      // bar to make the user wait on. Threshold env-tunable; 0 disables (legacy behaviour).
      const thresholds = titleUnlockThresholds(totalVod);
      const browseReady = nextOffset >= thresholds.browse;
      const usable = nextOffset >= thresholds.usable;
      // The user-facing bar fills toward the USABLE threshold (minutes), not the whole 272k
      // walk (hours): 86→99 over the first block, then pinned at 100 once usable. The walk
      // keeps advancing nextOffset internally — the offset advances 1:1 with titles built —
      // but the user already sees "ready" and the remaining work is a background top-up.
      // (An explicit built-count COUNT(*) here was the wrong tool: ~6s under concurrent
      // upsert load + autovacuum, which blew the 8s batch budget and froze the cursor.)
      await reportProgress({
        stage: done ? "finalizing" : "building_titles",
        percent: usable ? 100 : titleFinalizePercent(nextOffset, thresholds.usable),
        liveReady: true,
        ...(browseReady ? { browseReady: true } : {}),
        ...(usable ? { usable: true } : {}),
        steps: { finalize: { status: usable ? "done" : "running" } },
      });
      return {
        sourceId,
        status: "syncing",
        phase: "titles",
        nextPhase: done ? "complete" : "titles",
        nextOffset,
        nextAfterId,
        limit: batchLimit,
        totalVod,
        done,
        liveReady: true,
        browseReady,
        usable,
        ...result,
        titleProjection,
      };
    }

    if (phase !== "complete") throw new HttpError(400, "Invalid catalog finalization phase");

    // Re-check under the source-row lock immediately before READY. This second
    // gate closes the gap between the titles boundary and the terminal commit.
    if (versionedCatalog) {
      const readyPrune = await pruneCatalogGenerationBeforeReady(
        db,
        sourceId,
        userId,
        accessSnapshot,
      );
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      if (!readyPrune.complete) {
        await reportProgress({
          stage: "finalizing",
          percent: 100,
          liveReady: true,
          browseReady: true,
          usable: true,
          steps: { finalize: { status: "running" } },
        });
        return {
          sourceId,
          status: "syncing",
          phase: "complete",
          nextPhase: "complete",
          nextOffset: batchOffset,
          nextAfterId: batchAfterId,
          liveReady: true,
          browseReady: true,
          usable: true,
          readyPrune,
          ...result,
        };
      }
    }

    // Safety net: the client-driven "titles" phase can stop early and leave
    // verified titles without playable variants (vanishing from genre rails).
    // Deterministically materialise any missing variants before marking ready.
    try {
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
      await db.rpc("heal_cloud_title_variants", {
        p_user_id: userId,
        p_source_id: sourceId,
        ...catalogGenerationRpcFence(accessSnapshot),
      });
      await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    } catch (healError) {
      if (isCatalogAccessGuardError(healError)) throw healError;
      console.warn("[norva-source-sync] variant heal failed:", healError instanceof Error ? healError.message : healError);
    }

    const syncedAt = new Date().toISOString();
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
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

    // Import reached READY → notify once (first import only; the queue's unique(source_id,kind)
    // makes a later refresh's completion a no-op). The digest cron resolves name + counts at send time.
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    await enqueueImportNotification(db, userId, sourceId, "import_completed");

    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    return { sourceId, status: "ready", ...result };
  } catch (error) {
    if (isCatalogAccessGuardError(error)) throw error;
    await assertCatalogSnapshotCurrent(sourceId, userId, accessSnapshot, db);
    const message = formatSourceSyncError(error, "Source finalization failed");
    // Default to RESUMABLE: the titles grind is long and a mid-finalize source has a lot
    // built (cursor + tens of thousands of variants). Keep it "syncing" for ANY non-terminal
    // failure — a statement timeout, a deadlock, an isolate torn down mid-batch, or an
    // unexpected non-Error throw (which surfaces as the generic "Source finalization failed"
    // and must NOT be mistaken for terminal) — so the self-invoke chain AND the watchdog
    // resume it from the cursor. Only a genuine TERMINAL error (a 4xx that won't change on
    // retry: no items / not found / bad request, but never 429 rate-limit) marks it errored.
    // Flipping to "error" on a transient blip used to strand a 26%-built catalogue forever,
    // because the watchdog skips errored sources.
    const terminal = error instanceof HttpError
      && error.status >= 400 && error.status < 500 && error.status !== 429;
    if (terminal) {
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
      // Terminal finalize failure (4xx, non-429) → notify once.
      await enqueueImportNotification(db, userId, sourceId, "import_failed", { error: message });
    }
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
  if (phase === "complete") return 99;
  return 74;
}

function liveFinalizePercent(phase: string, offset: number, total: number) {
  const ratio = total ? Math.max(0, Math.min(1, offset / total)) : 1;
  if (phase === "live_channels") return Math.max(76, Math.min(80, Math.round(76 + ratio * 4)));
  return Math.max(80, Math.min(86, Math.round(80 + ratio * 6)));
}

function titleUnlockThresholds(totalVod: number) {
  const browse = boundedInt(Deno.env.get("NORVA_BROWSE_TITLE_THRESHOLD"), 80, 0, 200000);
  const usable = boundedInt(Deno.env.get("NORVA_USABLE_TITLE_THRESHOLD"), 2000, 0, 200000);
  return {
    browse: browse > 0 ? Math.min(totalVod, browse) : totalVod,
    usable: usable > 0 ? Math.min(totalVod, usable) : totalVod,
  };
}

function titleFinalizePercent(built: number, totalVod: number) {
  if (!totalVod) return 99;
  const ratio = Math.max(0, Math.min(1, built / totalVod));
  // Wide band (86→99): on a huge catalogue the titles phase is by far the longest part
  // of the finalize (hundreds of thousands of items), so it gets the largest share of
  // the bar. A narrow band made the percent appear frozen for the whole phase. The
  // "complete" phase then lands it on 100 via completedSyncProgress.
  return Math.max(86, Math.min(99, Math.round(86 + ratio * 13)));
}

async function countRowsByType(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
  itemType: string,
) {
  const { count, error } = await db
    .from("cloud_media_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("generation_id", generation.generationId)
    .eq("item_type", itemType);
  if (error) throwDb(error, `Unable to count ${itemType} catalog items`);
  return count ?? 0;
}

async function countRowsInTable(
  table: string,
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
) {
  const { count, error } = await db
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("user_id", userId)
    .eq("generation_id", generation.generationId);
  if (error) throwDb(error, `Unable to count ${table}`);
  return count ?? 0;
}

async function existingLiveMaterializationCounts(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
) {
  const [logicalChannels, liveVariants] = await Promise.all([
    countRowsInTable("cloud_live_logical_channels", sourceId, userId, db, generation),
    countRowsInTable("cloud_live_variants", sourceId, userId, db, generation),
  ]);
  return { logicalChannels, liveVariants };
}

async function countSourceItems(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
  progress: JsonRecord = {},
) {
  // Prefer the counts the import already persisted (instant): an exact count(*)
  // over a huge source can exceed the 8s statement budget on a busy DB. Fall back
  // to counting only when no trustworthy persisted total exists (e.g. legacy rows).
  const persisted = recordOrEmpty(progress.counts);
  const pLive = Number(persisted.live), pMovies = Number(persisted.movies), pSeries = Number(persisted.series);
  let live: number, movies: number, series: number;
  if (Number(persisted.total) > 0 && [pLive, pMovies, pSeries].every(Number.isFinite)) {
    live = pLive || 0; movies = pMovies || 0; series = pSeries || 0;
  } else {
    [live, movies, series] = await Promise.all([
      countRowsByType(sourceId, userId, db, generation, "live"),
      countRowsByType(sourceId, userId, db, generation, "movie"),
      countRowsByType(sourceId, userId, db, generation, "series"),
    ]);
  }
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
  afterId?: string;
  limit?: number;
};

async function loadSourceItems(
  sourceId: string,
  userId: string,
  db: SupabaseClient,
  generation: CatalogAccessSnapshot,
  options: LoadSourceItemsOptions = {},
): Promise<LiveCatalogItem[]> {
  const rows: LiveCatalogItem[] = [];
  const pageSize = options.limit ? Math.max(1, Math.min(2000, options.limit)) : 1000;
  const maxRows = options.limit ? pageSize : Number.POSITIVE_INFINITY;
  // Keyset mode (WHERE id > afterId, ORDER BY id): constant-time regardless of
  // position — used by the titles finalize so it doesn't slow down as OFFSET would
  // scan+skip ever more rows on a huge catalogue. Offset mode kept for other callers.
  const keyset = typeof options.afterId === "string";
  let afterId = options.afterId || "";
  for (let offset = Math.max(0, options.offset ?? 0); rows.length < maxRows; offset += pageSize) {
    let query = db
      .from("cloud_media_items")
      .select("id,source_id,generation_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .eq("generation_id", generation.generationId);
    const itemTypes = (options.itemTypes || []).filter(Boolean);
    if (itemTypes.length === 1) query = query.eq("item_type", itemTypes[0]);
    else if (itemTypes.length > 1) query = query.in("item_type", itemTypes);

    if (keyset) {
      query = query.order("id", { ascending: true }).limit(pageSize);
      if (afterId) query = query.gt("id", afterId);
    } else {
      query = query
        .order("item_type", { ascending: true })
        .order("external_id", { ascending: true })
        .range(offset, offset + pageSize - 1);
    }

    const { data, error } = await query;
    if (error) throwDb(error, "Unable to load imported catalog items");
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...data as LiveCatalogItem[]);
    if (keyset) afterId = String((data[data.length - 1] as { id?: unknown }).id ?? "");
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

async function syncM3uSource(
  sourceId: string,
  userId: string,
  config: JsonRecord,
  db: SupabaseClient,
  country: string | null,
  expectedSnapshot: CatalogAccessSnapshot,
  reportProgress: SyncProgressReporter = async () => {},
  opts: { previousSignature?: unknown; force?: boolean; rawOnly?: boolean } = {},
) {
  const playlistUrl = stringOr(config.playlistUrl, "");
  await reportProgress({
    stage: "connecting",
    percent: 10,
    steps: { connect: { status: "running" } },
  });
  await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  const playlist = await fetchText(playlistUrl, 30000, 20_000_000);
  await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
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
    await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    return { live: rows.length, total: rows.length, contentSignature, changed, detectOnly: true };
  }

  if (!opts.force && opts.previousSignature && contentSignatureEquals(contentSignature, opts.previousSignature)) {
    await reportProgress({
      stage: "unchanged",
      percent: 100,
      counts: { live: rows.length, movies: 0, series: 0, total: rows.length },
      steps: { import: { status: "done", count: rows.length }, finalize: { status: "done" } },
    });
    await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
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
  await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  const savedRows = await replaceSourceItems(sourceId, userId, rows, db, expectedSnapshot);
  await reportProgress({
    stage: "finalizing",
    percent: 86,
    steps: { import: { status: "done", count: savedRows.length }, finalize: { status: "running" } },
  });
  await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  const liveCatalog = await refreshMaterializedLiveCatalog(db, {
    sourceId,
    userId,
    rows: savedRows,
    country: country || stringOr(config.country, "FR"),
    generation: expectedSnapshot,
  });
  await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  return { live: rows.length, total: rows.length, liveCatalog, contentSignature };
}

async function replaceSourceItems(
  sourceId: string,
  userId: string,
  rows: JsonRecord[],
  db: SupabaseClient,
  expectedSnapshot: CatalogAccessSnapshot,
): Promise<LiveCatalogItem[]> {
  const savedRows: LiveCatalogItem[] = [];
  await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  for (let guard = 0; guard < 100; guard += 1) {
    const { data, error } = await db.rpc("norva_delete_catalog_generation_items_batch", {
      p_source_id: sourceId,
      p_user_id: userId,
      ...catalogGenerationRpcFence(expectedSnapshot),
      p_limit: 2000,
    });
    if (error) throwDb(error, "Unable to clear old catalog items");
    const removed = Number(Array.isArray(data) ? data[0] : data) || 0;
    if (removed < 2000) break;
    if (guard === 99) throw new Error("Catalog generation clear exceeded its bounded batch budget");
  }
  for (let index = 0; index < rows.length; index += 500) {
    await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
    const chunk = withCatalogGenerationRows(rows.slice(index, index + 500), expectedSnapshot);
    if (!chunk.length) continue;
    const { data, error } = await db
      .from("cloud_media_items")
      .upsert(chunk, { onConflict: "source_id,generation_id,item_type,external_id" })
      .select("id,source_id,generation_id,item_type,external_id,parent_external_id,title,subtitle,poster_url,metadata,playback_hint,available");
    if (error) throwDb(error, "Unable to save cloud catalog items");
    if (Array.isArray(data)) savedRows.push(...data as LiveCatalogItem[]);
  }
  await assertCatalogSnapshotCurrent(sourceId, userId, expectedSnapshot, db);
  return savedRows;
}

async function getRuntimeConfig(db: SupabaseClient): Promise<RuntimeConfig> {
  if (runtimeConfigCache && runtimeConfigCache.expiresAt > Date.now()) return runtimeConfigCache.value;
  let sourceConfigKey = ENV_SOURCE_CONFIG_KEY;
  let mediaGatewayUrl = ENV_MEDIA_GATEWAY_URL;
  let mediaGatewayToken = ENV_MEDIA_GATEWAY_TOKEN;
  let relayBaseUrl = ENV_RELAY_BASE_URL;
  let relayTokenSecret = ENV_RELAY_TOKEN_SECRET;
  if (
    !sourceConfigKey
    || !mediaGatewayUrl
    || !mediaGatewayToken
    || !relayBaseUrl
    || !relayTokenSecret
  ) {
    const { data, error } = await db
      .from("cloud_runtime_config")
      .select("key, value")
      .in("key", [
        "NORVA_SOURCE_CONFIG_KEY",
        "NORVA_MEDIA_GATEWAY_URL",
        "NORVA_MEDIA_GATEWAY_TOKEN",
        "NORVA_RELAY_BASE_URL",
        "RELAY_TOKEN_SECRET",
      ]);
    if (error) console.warn("[norva-source-sync] runtime config unavailable", error.message);
    for (const item of data ?? []) {
      if (typeof item.value !== "string" || !item.value) continue;
      if (item.key === "NORVA_SOURCE_CONFIG_KEY" && !sourceConfigKey) sourceConfigKey = item.value;
      else if (item.key === "NORVA_MEDIA_GATEWAY_URL" && !mediaGatewayUrl) mediaGatewayUrl = item.value.replace(/\/+$/, "");
      else if (item.key === "NORVA_MEDIA_GATEWAY_TOKEN" && !mediaGatewayToken) mediaGatewayToken = item.value;
      else if (item.key === "NORVA_RELAY_BASE_URL" && !relayBaseUrl) relayBaseUrl = item.value.replace(/\/+$/, "");
      else if (item.key === "RELAY_TOKEN_SECRET" && !relayTokenSecret) relayTokenSecret = item.value;
    }
  }
  const value = {
    sourceConfigKey,
    mediaGatewayUrl,
    mediaGatewayToken,
    relayBaseUrl,
    relayTokenSecret,
  };
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
    throw boundedProviderHttpError(error, "JSON");
  }
}

function stripSeriesInventoryCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSeriesInventoryCredentials);
  if (isRecord(value)) {
    const safe: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      // Xtream commonly embeds the full /series/USER/PASS/... URL here.
      if (key.toLowerCase() === "direct_source") continue;
      safe[key] = stripSeriesInventoryCredentials(child);
    }
    return safe;
  }
  return value;
}

function sanitizedProviderCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) ? code : null;
}

function seriesInventoryTransportError(
  error: unknown,
  transport: SeriesInventoryTransport,
): HttpError {
  const status = error instanceof HttpError ? error.status : 502;
  const rawDetails = error instanceof HttpError ? recordOrEmpty(error.details) : {};
  const upstreamStatus = Number(rawDetails.upstreamStatus ?? rawDetails.upstream_status);
  const boundedUpstreamStatus = Number.isInteger(upstreamStatus) &&
      upstreamStatus >= 100 && upstreamStatus <= 599
    ? upstreamStatus
    : null;
  // Gateway/relay may wrap the authoritative provider status in a 502. Use the
  // upstream status for fallback and backoff decisions so a provider 401/403/
  // 429 is never retried from a second egress IP as if infrastructure failed.
  const effectiveStatus = boundedUpstreamStatus ?? status;
  return new HttpError(
    effectiveStatus,
    error instanceof Error ? error.message : "Series inventory transport failed",
    {
      transport,
      code: sanitizedProviderCode(rawDetails.code),
      gatewayStatus: status,
      upstreamStatus: boundedUpstreamStatus,
    },
  );
}

function classifySeriesInventoryFailure(error: unknown): {
  status: number;
  code: string | null;
  transport: SeriesInventoryTransport | null;
  failureClass:
    | "viewer_priority"
    | "background_busy"
    | "authentication"
    | "forbidden"
    | "rate_limited"
    | "transient"
    | "item_unavailable"
    | "invalid_response";
  retryMs: number;
} {
  const status = error instanceof HttpError ? error.status : 0;
  const details = error instanceof HttpError ? recordOrEmpty(error.details) : {};
  const code = sanitizedProviderCode(details.code);
  const transportValue = stringOrNull(details.transport);
  const transport: SeriesInventoryTransport | null = (
      transportValue === "gateway" || transportValue === "relay" || transportValue === "direct"
    )
    ? transportValue
    : null;
  if (status === 409 || code === "account_busy" || code === "viewer_preempted") {
    return { status, code, transport, failureClass: "viewer_priority", retryMs: 60_000 };
  }
  if (code === "background_busy") {
    return { status, code, transport, failureClass: "background_busy", retryMs: 2 * 60_000 };
  }
  if (status === 401) {
    return { status, code, transport, failureClass: "authentication", retryMs: 24 * 3600_000 };
  }
  if (status === 403) {
    return { status, code, transport, failureClass: "forbidden", retryMs: 24 * 3600_000 };
  }
  if (status === 429) {
    return { status, code, transport, failureClass: "rate_limited", retryMs: 60 * 60_000 };
  }
  if (status === 408 || status === 502 || status === 503 || status === 504 || status >= 500) {
    return { status, code, transport, failureClass: "transient", retryMs: 15 * 60_000 };
  }
  if (status === 404 || status === 410) {
    return { status, code, transport, failureClass: "item_unavailable", retryMs: 24 * 3600_000 };
  }
  return { status, code, transport, failureClass: "invalid_response", retryMs: 6 * 3600_000 };
}

async function fetchSeriesInventoryMetadata(
  runtimeConfig: RuntimeConfig,
  args: {
    serverUrl: string;
    username: string;
    password: string;
    parentSeriesId: string;
    userId: string;
    sourceId: string;
    db: SupabaseClient;
    expectedProviderAccountAffinityHash: string;
    expectedConfigRevision: string;
    expectedConfigCiphertextHash: string;
  },
): Promise<SeriesInventoryMetadataResult> {
  const providerUrl = xtreamApiUrl(
    {
      serverUrl: args.serverUrl,
      username: args.username,
      password: args.password,
      action: "get_series_info",
    },
    { series_id: args.parentSeriesId },
  );
  // The interactive series route and playback both originate from the sticky
  // media-gateway IP. Inventory must use the same order; a relay-first 401/403
  // is a provider-origin refusal and historically prevented the known-good
  // gateway fallback from ever running.
  if (runtimeConfig.mediaGatewayUrl && runtimeConfig.mediaGatewayToken) {
    try {
      return {
        payload: await requestGatewayMetadata(
          runtimeConfig,
          {
            serverUrl: args.serverUrl,
            username: args.username,
            password: args.password,
            action: "get_series_info",
            params: { series_id: args.parentSeriesId },
          },
          45_000,
        ),
        transport: "gateway",
      };
    } catch (error) {
      const wrapped = seriesInventoryTransportError(error, "gateway");
      if (![404, 405, 502, 503, 504].includes(wrapped.status)) throw wrapped;
      console.warn(
        "[norva-source-sync] gateway series inventory unavailable, falling back",
        wrapped.status,
      );
    }
  }
  if (runtimeConfig.relayBaseUrl && runtimeConfig.relayTokenSecret) {
    try {
      const token = await signSeriesInventoryRelayToken(runtimeConfig.relayTokenSecret, {
        sid: `series-inventory-${args.parentSeriesId}`,
        uid: args.userId,
        url: providerUrl,
        ttlSeconds: 120,
      });
      const { response, value: payload } = await fetchBoundedProviderJson(
        `${runtimeConfig.relayBaseUrl}/series-info/${token}`,
        {
          timeoutMs: 30_000,
          maxBytes: 32 * 1024 * 1024,
          headers: { "User-Agent": "NorvaCloud/1.0" },
        },
      );
      if (!response.ok) {
        throw new HttpError(response.status, "Relay refused the series inventory request");
      }
      return { payload, transport: "relay" };
    } catch (error) {
      const wrapped = seriesInventoryTransportError(error, "relay");
      if (![404, 405, 502, 503, 504].includes(wrapped.status)) throw wrapped;
      console.warn(
        "[norva-source-sync] relay series inventory unavailable, falling back",
        wrapped.status,
      );
    }
  }
  try {
    return {
      payload: await withSourceDirectFallbackLease({
        db: args.db,
        sourceId: args.sourceId,
        userId: args.userId,
        owner: providerDirectFallbackLeaseOwner("series-inventory"),
        ttlSeconds: directFallbackLeaseTtlSeconds(20_000),
        expectedProviderAccountAffinityHash: args.expectedProviderAccountAffinityHash,
        expectedConfigRevision: args.expectedConfigRevision,
        expectedConfigCiphertextHash: args.expectedConfigCiphertextHash,
      }, () => fetchJson(providerUrl, 20_000)),
      transport: "direct",
    };
  } catch (error) {
    if (error instanceof ProviderDirectFallbackLeaseError) {
      throw seriesInventoryTransportError(
        new HttpError(error.status, error.message, error.details),
        "direct",
      );
    }
    throw seriesInventoryTransportError(error, "direct");
  }
}

async function signSeriesInventoryRelayToken(
  secret: string,
  claims: { sid: string; uid: string; url: string; ttlSeconds: number },
): Promise<string> {
  const payload = JSON.stringify({
    v: 1,
    sid: claims.sid,
    uid: claims.uid,
    url: claims.url,
    ua: "VLC/3.0.20 LibVLC/3.0.20",
    exp: Math.floor(Date.now() / 1000) + claims.ttlSeconds,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
  return `${base64Url(encoder.encode(payload))}.${base64Url(signature)}`;
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
    try {
      return await requestGatewayMetadata(runtimeConfig, args, Math.max(timeoutMs + 10000, 45000));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      if (![404, 405, 502, 503, 504].includes(status)) throw error;
      console.warn("[norva-source-sync] gateway metadata unavailable, falling back to direct", args.action, status);
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
    if (!response.ok) throw new HttpError(response.status, "Media gateway refused the metadata request");
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new HttpError(aborted ? 504 : 502, "Unable to reach media gateway", error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs: number, maxBytes: number) {
  try {
    const { response, value: text } = await fetchBoundedProviderText(url, {
      timeoutMs,
      maxBytes,
      headers: { "User-Agent": "NorvaCloud/1.0" },
    });
    if (!response.ok) throw new HttpError(response.status, "IPTV provider request failed");
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw boundedProviderHttpError(error, "playlist");
  }
}

function boundedProviderHttpError(error: unknown, payloadType: string) {
  if (error instanceof BoundedProviderResponseError && error.kind === "too_large") {
    return new HttpError(413, `Provider ${payloadType} payload is too large`);
  }
  if (error instanceof BoundedProviderResponseError && error.kind === "timeout") {
    return new HttpError(504, "IPTV provider response deadline exceeded");
  }
  return new HttpError(502, "Unable to reach IPTV provider");
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
    "Access-Control-Expose-Headers": "x-norva-visibility-epoch",
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
      ...catalogVisibilityEpochHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function catalogVisibilityEpochHeaders(req: Request) {
  const epoch = catalogVisibilityEpochs.get(req);
  return epoch ? { "X-Norva-Visibility-Epoch": epoch } : {};
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
