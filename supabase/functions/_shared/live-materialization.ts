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
  const liveRows = input.rows.filter((row) => row.item_type === "live" && row.available !== false);
  await deleteSourceMaterialization(db, input.sourceId, input.userId);

  if (!liveRows.length) {
    return { rawLive: 0, logicalChannels: 0, liveVariants: 0 };
  }

  const catalog = buildLiveCatalog(liveRows, {
    country: input.country || "FR",
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
    metadata: recordOrEmpty(channel.metadata),
    synced_at: now,
  }));

  const insertedChannels = await insertRows(db, "cloud_live_logical_channels", channelRows, "id,logical_id");
  const channelIdByLogicalId = new Map(insertedChannels.map((row) => [String(row.logical_id), String(row.id)]));
  const variantRows = catalog.channels.flatMap((channel) => {
    const logicalId = stringValue(channel.logical_id ?? channel.id);
    const channelId = channelIdByLogicalId.get(logicalId);
    if (!channelId || !Array.isArray(channel.variants)) return [];
    return channel.variants.map((variantValue) => {
      const variant = recordOrEmpty(variantValue);
      const playbackHint = recordOrEmpty(variant.playback_hint ?? variant.playbackHint);
      const metadata = recordOrEmpty(variant.metadata);
      return {
        user_id: input.userId,
        source_id: input.sourceId,
        logical_channel_id: channelId,
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
  await insertRows(db, "cloud_live_variants", variantRows);

  return {
    rawLive: liveRows.length,
    logicalChannels: channelRows.length,
    liveVariants: variantRows.length,
  };
}

async function deleteSourceMaterialization(db: SupabaseLike, sourceId: string, userId: string) {
  const { error } = await db
    .from("cloud_live_logical_channels")
    .delete()
    .eq("source_id", sourceId)
    .eq("user_id", userId);
  if (error) throwDb(error, "Unable to clear live materialization");
}

async function insertRows(db: SupabaseLike, table: string, rows: JsonRecord[], selectColumns = "") {
  const inserted: JsonRecord[] = [];
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (!chunk.length) continue;
    const query = db.from(table).insert(chunk);
    const { data, error } = selectColumns ? await query.select(selectColumns) : await query;
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
