import { buildLiveCatalog, type LiveCatalogItem } from "./live-catalog.ts";

type JsonRecord = Record<string, unknown>;
type SupabaseLike = {
  from: (table: string) => any;
};
type DbError = { message?: string; details?: string; hint?: string };

export async function refreshMaterializedLiveCatalog(
  db: SupabaseLike,
  input: {
    userId: string;
    sourceId: string;
    rows: LiveCatalogItem[];
    country?: string;
  },
) {
  const plan = buildLiveMaterializationPlan(input);
  await clearLiveMaterialization(db, input.sourceId, input.userId);

  if (!plan.rawLive) {
    return { rawLive: 0, logicalChannels: 0, liveVariants: 0 };
  }

  const insertedChannels = await upsertLiveChannelRows(db, plan.channelRows);
  const channelIdByLogicalId = new Map(insertedChannels.map((row) => [String(row.logical_id), String(row.id)]));
  await upsertLiveVariantRows(db, plan.variantRows, channelIdByLogicalId);

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
  input: { userId: string; sourceId: string; rows: LiveCatalogItem[]; country?: string },
) {
  const plan = buildLiveMaterializationPlan(input);
  if (!plan.rawLive) return { rawLive: 0, logicalChannels: 0, liveVariants: 0 };
  const insertedChannels = await upsertLiveChannelRows(db, plan.channelRows);
  const channelIdByLogicalId = new Map(insertedChannels.map((row) => [String(row.logical_id), String(row.id)]));
  const liveVariants = await upsertLiveVariantRows(db, plan.variantRows, channelIdByLogicalId);
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

export async function clearLiveMaterialization(db: SupabaseLike, sourceId: string, userId: string) {
  const { error } = await db
    .from("cloud_live_logical_channels")
    .delete()
    .eq("source_id", sourceId)
    .eq("user_id", userId);
  if (error) throwDb(error, "Unable to clear live materialization");
}

export async function upsertLiveChannelRows(db: SupabaseLike, rows: JsonRecord[], offset = 0, limit = rows.length) {
  const slice = rows.slice(offset, offset + Math.max(0, limit));
  return await writeRows(db, "cloud_live_logical_channels", slice, {
    selectColumns: "id,logical_id",
    onConflict: "source_id,logical_id",
  });
}

export async function fetchLiveChannelIdMap(db: SupabaseLike, sourceId: string, userId: string) {
  const rows: JsonRecord[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("cloud_live_logical_channels")
      .select("id,logical_id")
      .eq("source_id", sourceId)
      .eq("user_id", userId)
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
  await writeRows(db, "cloud_live_variants", slice, {
    onConflict: "source_id,logical_id,stream_id,label",
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

function nullableNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function throwDb(error: DbError, message: string): never {
  throw new Error(`${message}: ${error.message || "database error"}`);
}
