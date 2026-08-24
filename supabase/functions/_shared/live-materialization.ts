import { buildLiveCatalog, type LiveCatalogItem } from "./live-catalog.ts";
import {
  type CatalogGenerationWriteContext,
  catalogGenerationRpcFence,
  withCatalogGenerationRows,
} from "./catalog-generation.ts";

type JsonRecord = Record<string, unknown>;
type SupabaseLike = {
  from: (table: string) => any;
  rpc: (name: string, args?: JsonRecord) => PromiseLike<{ data?: unknown; error?: DbError | null }>;
};
type DbError = { code?: string; message?: string; details?: string; hint?: string };

export const LIVE_CLEAR_CALLER_PROTOCOL = "catalog-generation-writer-v2-live-clear-batch";
const LIVE_CLEAR_BATCH_SIZE = 1000;
const LIVE_CLEAR_MAX_BATCHES_PER_INVOCATION = 64;
const LIVE_CLEAR_BUDGET_MS = 20_000;

export class LiveMaterializationClearIncompleteError extends Error {
  readonly code = "LIVE_MATERIALIZATION_CLEAR_INCOMPLETE";
  readonly transient = true;
  readonly retryable = true;
  readonly deletedRows: number;
  readonly callerProtocol: string;

  constructor(result: { deletedRows: number; callerProtocol: string }) {
    super("Live materialization clear needs another bounded invocation");
    this.name = "LiveMaterializationClearIncompleteError";
    this.deletedRows = result.deletedRows;
    this.callerProtocol = result.callerProtocol;
  }
}

export async function refreshMaterializedLiveCatalog(
  db: SupabaseLike,
  input: {
    userId: string;
    sourceId: string;
    rows: LiveCatalogItem[];
    country?: string;
    generation: CatalogGenerationWriteContext;
  },
) {
  const plan = buildLiveMaterializationPlan(input);
  const cleared = await clearLiveMaterialization(db, input.sourceId, input.userId, input.generation);
  if (!cleared.complete) throw new LiveMaterializationClearIncompleteError(cleared);

  if (!plan.rawLive) {
    return { rawLive: 0, logicalChannels: 0, liveVariants: 0 };
  }

  const insertedChannels = await upsertLiveChannelRows(db, plan.channelRows, input.generation);
  const channelIdByLogicalId = new Map(insertedChannels.map((row) => [String(row.logical_id), String(row.id)]));
  await upsertLiveVariantRows(db, plan.variantRows, channelIdByLogicalId, input.generation);

  return {
    rawLive: plan.rawLive,
    logicalChannels: plan.channelRows.length,
    liveVariants: plan.variantRows.length,
  };
}

// Materialise ONE chunk of live rows (build its catalogue + upsert its channels
// and variants) without clearing. Lets the finalize stepper walk a huge channel
// list (50k+) in bounded slices instead of parsing it all in one isolate — which
// exceeds the edge compute limit. Channels that recur across chunks merge by
// logical_id; variants merge by (logical_id, stream_id, label).
export async function materializeLiveChunk(
  db: SupabaseLike,
  input: {
    userId: string;
    sourceId: string;
    rows: LiveCatalogItem[];
    country?: string;
    generation: CatalogGenerationWriteContext;
  },
) {
  const plan = buildLiveMaterializationPlan(input);
  if (!plan.rawLive) return { rawLive: 0, logicalChannels: 0, liveVariants: 0 };
  const insertedChannels = await upsertLiveChannelRows(db, plan.channelRows, input.generation);
  const channelIdByLogicalId = new Map(insertedChannels.map((row) => [String(row.logical_id), String(row.id)]));
  const liveVariants = await upsertLiveVariantRows(db, plan.variantRows, channelIdByLogicalId, input.generation);
  return { rawLive: plan.rawLive, logicalChannels: plan.channelRows.length, liveVariants };
}

export function buildLiveMaterializationPlan(
  input: {
    userId: string;
    sourceId: string;
    rows: LiveCatalogItem[];
    country?: string;
  },
) {
  const liveRows = input.rows.filter((row) => row.item_type === "live" && row.available !== false);
  if (!liveRows.length) {
    return { rawLive: 0, channelRows: [], variantRows: [] };
  }

  const country = String(input.country || "FR").toUpperCase();
  const catalog = buildLiveCatalog(liveRows, {
    country,
    sourceId: input.sourceId,
    includeVariants: true,
  });
  const now = new Date().toISOString();
  const channelRows = catalog.channels.map((channel) => ({
    user_id: input.userId,
    source_id: input.sourceId,
    logical_id: stringValue(channel.logical_id ?? channel.id),
    logical_key: stringValue(channel.logical_key),
    title: stringValue(channel.title ?? channel.name),
    lcn: nullableNumber(channel.lcn ?? channel.num),
    section: stringValue(channel.section, "other"),
    category_id: stringValue(channel.category_id ?? channel.group_id, "uncategorized"),
    category_name: stringValue(channel.category_name ?? channel.group_name, "Uncategorized"),
    poster_url: stringOrNull(channel.poster_url),
    stream_icon: stringOrNull(channel.stream_icon),
    default_stream_id: stringOrNull((recordOrEmpty(channel.default_variant).stream_id) ?? (recordOrEmpty(channel.defaultVariant).streamId)),
    variant_count: numberValue(channel.variant_count ?? channel.variantCount),
    default_variant: recordOrEmpty(channel.default_variant ?? channel.defaultVariant),
    variant_preview: arrayOrEmpty(channel.variant_preview),
    playback_hint: recordOrEmpty(channel.playback_hint ?? channel.playbackHint),
    metadata: { ...recordOrEmpty(channel.metadata), country },
    synced_at: now,
  }));

  const variantRows = catalog.channels.flatMap((channel) => {
    const logicalId = stringValue(channel.logical_id ?? channel.id);
    if (!Array.isArray(channel.variants)) return [];
    return channel.variants.map((variantValue) => {
      const variant = recordOrEmpty(variantValue);
      const playbackHint = recordOrEmpty(variant.playback_hint ?? variant.playbackHint);
      const metadata = { ...recordOrEmpty(variant.metadata), country };
      return {
        user_id: input.userId,
        source_id: input.sourceId,
        logical_id: logicalId,
        media_item_id: stringOrNull(variant.media_item_id ?? variant.mediaItemId),
        stream_id: stringValue(variant.stream_id ?? variant.streamId),
        external_id: stringValue(variant.external_id ?? variant.stream_id ?? variant.streamId),
        label: stringValue(variant.label, "HD"),
        rank: numberValue(variant.rank, 2),
        health_rank: numberValue(variant.healthRank ?? variant.health_rank, 1),
        title: stringValue(variant.title ?? variant.name),
        raw_title: stringOrNull(variant.raw),
        category_id: stringOrNull(variant.category_id),
        category_name: stringOrNull(variant.category_name),
        poster_url: stringOrNull(variant.poster_url),
        stream_icon: stringOrNull(variant.stream_icon),
        playback_hint: playbackHint,
        metadata,
        container_extension: stringOrNull(variant.container_extension),
        synced_at: now,
      };
    });
  });

  return {
    rawLive: liveRows.length,
    channelRows,
    variantRows,
  };
}

export async function clearLiveMaterialization(
  db: SupabaseLike,
  sourceId: string,
  userId: string,
  generation: CatalogGenerationWriteContext,
) {
  if (generation.kind !== "active") {
    throw new Error("BUILDING live materialization cannot be cleared outside its reset RPC");
  }
  const deadline = Date.now() + LIVE_CLEAR_BUDGET_MS;
  let deletedRows = 0;
  for (let batch = 0; batch < LIVE_CLEAR_MAX_BATCHES_PER_INVOCATION; batch += 1) {
    const { data, error } = await db.rpc("norva_clear_catalog_generation_live_materialization_batch", {
      p_source_id: sourceId,
      p_user_id: userId,
      ...catalogGenerationRpcFence(generation),
      p_limit: LIVE_CLEAR_BATCH_SIZE,
    });
    if (error) {
      if (batch === 0 && liveClearBatchRpcUnavailable(error)) {
        return await clearLiveMaterializationLegacyCompat(db, sourceId, userId, generation);
      }
      throwDb(error, "Unable to clear live materialization");
    }
    const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
    const deletedVariants = strictBatchCount(result.deletedVariants);
    const deletedChannels = strictBatchCount(result.deletedChannels);
    const deletedInBatch = strictBatchCount(result.deletedRows);
    if (
      typeof result.complete !== "boolean" ||
      deletedInBatch !== deletedVariants + deletedChannels ||
      deletedInBatch > LIVE_CLEAR_BATCH_SIZE ||
      (!result.complete && deletedInBatch === 0)
    ) {
      throw new Error("Invalid bounded live materialization clear result");
    }
    deletedRows += deletedInBatch;
    if (result.complete) {
      return { deletedRows, complete: true, callerProtocol: LIVE_CLEAR_CALLER_PROTOCOL };
    }
    if (Date.now() >= deadline) break;
  }
  // Every committed batch is resumable. Callers must checkpoint phase live/0
  // and run this exact generation-fenced RPC again before writing any of the
  // replacement materialization.
  return { deletedRows, complete: false, callerProtocol: LIVE_CLEAR_CALLER_PROTOCOL };
}

function liveClearBatchRpcUnavailable(error: DbError) {
  return ["42883", "PGRST202"].includes(String(error?.code ?? "").toUpperCase());
}

async function clearLiveMaterializationLegacyCompat(
  db: SupabaseLike,
  sourceId: string,
  userId: string,
  generation: Extract<CatalogGenerationWriteContext, { kind: "active" }>,
) {
  const { data, error } = await db.rpc("norva_clear_catalog_generation_live_materialization", {
    p_source_id: sourceId,
    p_user_id: userId,
    ...catalogGenerationRpcFence(generation),
  });
  if (error) throwDb(error, "Unable to clear live materialization");
  const result = recordOrEmpty(Array.isArray(data) ? data[0] : data);
  const deletedVariants = strictBatchCount(result.deletedVariants);
  const deletedChannels = strictBatchCount(result.deletedChannels);
  if (deletedVariants < 0 || deletedChannels < 0) {
    throw new Error("Invalid legacy live materialization clear result");
  }
  return {
    deletedRows: deletedVariants + deletedChannels,
    complete: true,
    callerProtocol: LIVE_CLEAR_CALLER_PROTOCOL,
    compatibilityFallback: "legacy-rpc-v1",
  };
}

export async function upsertLiveChannelRows(
  db: SupabaseLike,
  rows: JsonRecord[],
  generation: CatalogGenerationWriteContext,
  offset = 0,
  limit = rows.length,
) {
  const slice = rows.slice(offset, offset + Math.max(0, limit));
  const merged = await mergeExistingLiveChannelSummaries(db, slice, generation);
  return await writeRows(db, "cloud_live_logical_channels", withCatalogGenerationRows(merged, generation), {
    selectColumns: "id,logical_id",
    onConflict: "source_id,generation_id,logical_id",
  });
}

// buildLiveCatalog intentionally deduplicates variants by their display label.
// A bounded provider page can split the same logical channel across pages, so a
// page-local channel summary is not authoritative by itself. Merge the small
// per-label previews already persisted for this exact generation before every
// upsert. The preview cardinality is bounded by the finite quality-label space,
// while cloud_live_variants still retains every concrete stream row.
async function mergeExistingLiveChannelSummaries(
  db: SupabaseLike,
  rows: JsonRecord[],
  generation: CatalogGenerationWriteContext,
) {
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map((row) => stringValue(row.logical_id)).filter(Boolean))];
  const existingByLogicalId = new Map<string, JsonRecord>();
  for (let index = 0; index < ids.length; index += 250) {
    const { data, error } = await db
      .from("cloud_live_logical_channels")
      .select("logical_id,variant_preview")
      .eq("generation_id", generation.generationId)
      .in("logical_id", ids.slice(index, index + 250));
    if (error) throwDb(error, "Unable to load generation live channel summaries");
    for (const row of data ?? []) existingByLogicalId.set(stringValue(row.logical_id), row);
  }
  return rows.map((row) => {
    const existing = existingByLogicalId.get(stringValue(row.logical_id));
    if (!existing) return row;
    const preview = mergeLiveVariantPreviews(existing.variant_preview, row.variant_preview);
    const defaultVariant = pickDefaultLivePreview(preview);
    if (!defaultVariant) return row;
    return {
      ...row,
      default_stream_id: stringOrNull(defaultVariant.stream_id ?? defaultVariant.streamId),
      variant_count: preview.length,
      default_variant: defaultVariant,
      variant_preview: preview,
      playback_hint: recordOrEmpty(defaultVariant.playback_hint ?? defaultVariant.playbackHint),
      poster_url: stringOrNull(defaultVariant.poster_url) ?? row.poster_url,
      stream_icon: stringOrNull(defaultVariant.stream_icon) ?? row.stream_icon,
    };
  });
}

function mergeLiveVariantPreviews(existingValue: unknown, incomingValue: unknown) {
  const byLabel = new Map<string, JsonRecord>();
  for (const value of [...arrayOrEmpty(existingValue), ...arrayOrEmpty(incomingValue)]) {
    const variant = recordOrEmpty(value);
    const label = stringValue(variant.label);
    if (!label) continue;
    const current = byLabel.get(label);
    if (!current || compareLivePreview(variant, current) < 0) byLabel.set(label, variant);
  }
  return [...byLabel.values()].sort((left, right) =>
    compareLivePreview(left, right) || stringValue(left.label).localeCompare(stringValue(right.label))
  );
}

function pickDefaultLivePreview(variants: JsonRecord[]) {
  const healthy = variants.filter((variant) => livePreviewHealthRank(variant) < 3);
  const pool = (healthy.length ? healthy : variants).slice();
  pool.sort((left, right) =>
    (livePreviewHealthRank(left) - livePreviewHealthRank(right)) ||
    (livePreviewDefaultPreference(left) - livePreviewDefaultPreference(right)) ||
    (numberValue(left.rank) - numberValue(right.rank))
  );
  return pool[0] ?? null;
}

function compareLivePreview(left: JsonRecord, right: JsonRecord) {
  return (livePreviewHealthRank(left) - livePreviewHealthRank(right)) ||
    (numberValue(left.rank) - numberValue(right.rank));
}

function livePreviewHealthRank(variant: JsonRecord) {
  return numberValue(variant.healthRank ?? variant.health_rank, 1);
}

function livePreviewDefaultPreference(variant: JsonRecord) {
  const label = stringValue(variant.label);
  let preference = label.startsWith("HD") ? 0
    : label.startsWith("FHD") || label.startsWith("Super HD") ? 1
    : label.startsWith("SD") ? 2
    : label.startsWith("4K") ? 4
    : 1;
  if (/h265|hevc/i.test(label)) preference += 0.5;
  return preference;
}

export async function fetchLiveChannelIdMap(
  db: SupabaseLike,
  sourceId: string,
  userId: string,
  generation: CatalogGenerationWriteContext,
) {
  const rows: JsonRecord[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("cloud_live_logical_channels")
      .select("id,logical_id")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
      .eq("generation_id", generation.generationId)
      .range(offset, offset + 999);
    if (error) throwDb(error, "Unable to load live channel ids");
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return new Map(rows.map((row) => [String(row.logical_id), String(row.id)]));
}

export async function upsertLiveVariantRows(
  db: SupabaseLike,
  rows: JsonRecord[],
  channelIdByLogicalId: Map<string, string>,
  generation: CatalogGenerationWriteContext,
  offset = 0,
  limit = rows.length,
) {
  const slice = rows
    .slice(offset, offset + Math.max(0, limit))
    .map((row) => ({
      ...row,
      logical_channel_id: channelIdByLogicalId.get(String(row.logical_id)) || null,
    }))
    .filter((row) => row.logical_channel_id);
  await writeRows(db, "cloud_live_variants", withCatalogGenerationRows(slice, generation), {
    onConflict: "source_id,generation_id,logical_id,stream_id,label",
  });
  return slice.length;
}

async function insertRows(db: SupabaseLike, table: string, rows: JsonRecord[], selectColumns = "") {
  return await writeRows(db, table, rows, { selectColumns });
}

type WriteRowsOptions = {
  selectColumns?: string;
  onConflict?: string;
};

async function writeRows(db: SupabaseLike, table: string, rows: JsonRecord[], options: WriteRowsOptions = {}) {
  const inserted: JsonRecord[] = [];
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (!chunk.length) continue;
    const query = options.onConflict
      ? db.from(table).upsert(chunk, { onConflict: options.onConflict })
      : db.from(table).insert(chunk);
    const { data, error } = options.selectColumns ? await query.select(options.selectColumns) : await query;
    if (error) throwDb(error, `Unable to save ${table}`);
    if (Array.isArray(data)) inserted.push(...data);
  }
  return inserted;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function arrayOrEmpty(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function stringOrNull(value: unknown) {
  const text = stringValue(value);
  return text || null;
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function strictBatchCount(value: unknown) {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

function nullableNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function throwDb(error: DbError, message: string): never {
  throw new Error(`${message}: ${error.message || "database error"}`);
}
