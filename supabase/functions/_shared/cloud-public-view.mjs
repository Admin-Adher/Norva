const PROFILE_FIELDS = Object.freeze([
  "display_name",
  "avatar_url",
  "locale",
  "preferred_content_region",
  "preferred_content_region_confirmed_at",
  "content_region_taxonomy_version",
  "created_at",
  "updated_at",
]);

export const CLOUD_PUBLIC_ERROR_CODES = Object.freeze([
  "DIRECT_CREDENTIAL_MUTATION_FORBIDDEN",
  "INVALID_REQUEST",
  "subscription_required",
  "profile_locked",
  "profile_unavailable",
  "SOURCE_CATALOG_NOT_VISIBLE",
  "SOURCE_CATALOG_CHANGED",
  "ambiguous_title_identity",
  "rating_identity_invalid",
  "rating_request_invalid",
  "rating_service_unavailable",
  "rating_source_not_found",
  "rating_storage_unavailable",
  "title_identity_unavailable",
  "PLAYBACK_CREATION_MOVED",
  "PROVIDER_BUSY",
  "PROVIDER_CONNECT_TIMEOUT",
  "PROVIDER_CONNECTION_RESET",
  "PROVIDER_DNS_FAILURE",
  "PROVIDER_DIRECT_FALLBACK_RETRYABLE",
  "PROVIDER_NETWORK_UNREACHABLE",
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_RESPONSE_TIMEOUT",
  "PROVIDER_TLS_FAILURE",
]);

const CLOUD_PUBLIC_ERROR_CODE_SET = new Set(CLOUD_PUBLIC_ERROR_CODES);
const CLOUD_PUBLIC_RETRYABLE_ERROR_CODE_SET = new Set([
  "PROVIDER_DIRECT_FALLBACK_RETRYABLE",
  "SOURCE_CATALOG_CHANGED",
]);

export const PROFILE_PUBLIC_SELECT = PROFILE_FIELDS.join(",");

const DEVICE_FIELDS = Object.freeze([
  "id",
  "device_type",
  "device_name",
  "platform",
  "app_version",
  "capabilities",
  "trusted",
  "revoked",
  "last_seen_at",
  "created_at",
  "updated_at",
]);

export const DEVICE_PUBLIC_SELECT = DEVICE_FIELDS.join(",");

const MEDIA_ITEM_FIELDS = Object.freeze([
  "id",
  "source_id",
  "item_type",
  "external_id",
  "parent_external_id",
  "title",
  "subtitle",
  "poster_url",
  "backdrop_url",
  "metadata",
  "playback_hint",
  "available",
  "created_at",
  "updated_at",
]);

export const MEDIA_ITEM_PUBLIC_SELECT = MEDIA_ITEM_FIELDS.join(",");

const FAVORITE_FIELDS = Object.freeze([
  "id",
  "profile_id",
  "source_id",
  "item_type",
  "item_id",
  "item_name",
  "item_meta",
  "created_at",
]);

export const FAVORITE_PUBLIC_SELECT = FAVORITE_FIELDS.join(",");

const WATCH_HISTORY_FIELDS = Object.freeze([
  "id",
  "profile_id",
  "source_id",
  "item_type",
  "item_id",
  "parent_item_id",
  "item_name",
  "progress_seconds",
  "duration_seconds",
  "completed",
  "data",
  "watched_at",
  "created_at",
  "updated_at",
]);

export const WATCH_HISTORY_PUBLIC_SELECT = WATCH_HISTORY_FIELDS.join(",");

const CONTENT_EVENT_FIELDS = Object.freeze([
  "id",
  "source_id",
  "kind",
  "summary",
  "payload",
  "created_at",
  "seen_at",
]);

// source_id is selected only so the Edge function can enforce the centralized
// visibility projection and bind a deep link to that exact source. The public
// sanitizer deliberately omits it from the response.
export const CONTENT_EVENT_PUBLIC_SELECT = CONTENT_EVENT_FIELDS.join(",");

const PLAYBACK_EVENT_FIELDS = Object.freeze([
  "id",
  "device_id",
  "playback_session_id",
  "source_id",
  "item_type",
  "item_id",
  "event_type",
  "position_seconds",
  "duration_seconds",
  "time_to_first_frame_ms",
  "playback_mode",
  "created_at",
]);

export const PLAYBACK_EVENT_PUBLIC_SELECT = PLAYBACK_EVENT_FIELDS.join(",");

const PAIRING_FIELDS = Object.freeze([
  "id",
  "approved_device_id",
  "code",
  "device_type",
  "device_name",
  "status",
  "expires_at",
  "created_at",
  "approved_at",
]);

export const PAIRING_PUBLIC_SELECT = PAIRING_FIELDS.join(",");

const CAST_COMMAND_FIELDS = Object.freeze([
  "id",
  "source_device_id",
  "target_device_id",
  "command",
  "payload",
  "status",
  "expires_at",
  "created_at",
  "delivered_at",
  "acknowledged_at",
]);

export const CAST_COMMAND_PUBLIC_SELECT = CAST_COMMAND_FIELDS.join(",");

const PLAYBACK_SESSION_FIELDS = Object.freeze([
  "id",
  "source_id",
  "device_id",
  "profile_id",
  "item_type",
  "item_id",
  "mode",
  "status",
  "stream_mime",
  "playback_hint",
  "error_code",
  "expires_at",
  "created_at",
  "updated_at",
  "native_heartbeat_at",
  "superseded_at",
]);

export const PLAYBACK_SESSION_PUBLIC_SELECT = PLAYBACK_SESSION_FIELDS.join(",");

const MEDIA_METADATA_FIELDS = Object.freeze([
  "categoryId",
  "category_id",
  "categoryName",
  "category_name",
  "group",
  "tvgId",
  "tvg_id",
  "rating",
  "added",
  "overview",
  "description",
  "year",
  "releaseDate",
  "release_date",
  "providerTmdbId",
  "provider_tmdb_id",
  "providerImdbId",
  "provider_imdb_id",
  "duration",
  "durationSeconds",
  "duration_seconds",
  "container",
  "containerExtension",
  "container_extension",
  "audioLanguages",
  "audio_languages",
  "subtitleLanguages",
  "subtitle_languages",
]);

const PLAYBACK_HINT_FIELDS = Object.freeze([
  "sourceType",
  "source_type",
  "streamId",
  "stream_id",
  "streamType",
  "stream_type",
  "itemType",
  "item_type",
  "audioSeriesId",
  "audio_series_id",
  "container",
  "containerExplicit",
  "container_explicit",
  "providerTmdbId",
  "provider_tmdb_id",
  "providerImdbId",
  "provider_imdb_id",
  "audioCodec",
  "audio_codec",
  "audioProfile",
  "audio_profile",
  "audioChannels",
  "audio_channels",
  "audioMode",
  "audio_mode",
  "audioStreamIndex",
  "audio_stream_index",
  "audioTrackCount",
  "audio_track_count",
  "subtitleTrackCount",
  "subtitle_track_count",
  "videoCodec",
  "video_codec",
  "videoStreamIndex",
  "video_stream_index",
  "durationSeconds",
  "duration_seconds",
]);

const CODEC_PROFILE_FIELDS = Object.freeze([
  "videoStreamIndex",
  "video_stream_index",
  "videoCodec",
  "video_codec",
  "videoProfile",
  "video_profile",
  "videoWidth",
  "video_width",
  "width",
  "videoHeight",
  "video_height",
  "height",
  "videoPixelFormat",
  "video_pixel_format",
  "pix_fmt",
  "audioCodec",
  "audio_codec",
  "audioProfile",
  "audio_profile",
  "audioChannels",
  "audio_channels",
  "channels",
  "audioChannelLayout",
  "audio_channel_layout",
  "channel_layout",
  "audioSampleRate",
  "audio_sample_rate",
  "sample_rate",
  "container",
  "durationSeconds",
  "duration_seconds",
  "duration",
  "bitRate",
  "bit_rate",
  "fileSizeBytes",
  "file_size_bytes",
  "metadataComplete",
  "metadata_complete",
]);

const TRACK_FIELDS = Object.freeze([
  "index",
  "order",
  "language",
  "lang",
  "inferredLanguage",
  "inferred_language",
  "title",
  "name",
  "codec",
  "codecName",
  "codec_name",
  "profile",
  "channels",
  "sampleRate",
  "sample_rate",
  "channelLayout",
  "channel_layout",
  "default",
  "subtitleType",
  "subtitle_type",
  "extractable",
  "burnInRequired",
  "burn_in_required",
  "unsupportedReason",
  "unsupported_reason",
]);

const FAVORITE_META_FIELDS = Object.freeze([
  "poster",
  "posterUrl",
  "poster_url",
  "type",
  "sourceType",
  "source_type",
  "streamId",
  "stream_id",
  "channelId",
  "channel_id",
]);

const HISTORY_DATA_FIELDS = Object.freeze([
  "title",
  "subtitle",
  "poster",
  "posterUrl",
  "poster_url",
  "backdrop",
  "backdropUrl",
  "backdrop_url",
  "sourceId",
  "source_id",
  "containerExtension",
  "container_extension",
  "durationHint",
  "duration_hint",
  "titleId",
  "title_id",
  "seriesId",
  "series_id",
  "currentSeason",
  "current_season",
  "currentEpisode",
  "current_episode",
  "progress",
  "duration",
]);

const NEXT_EPISODE_FIELDS = Object.freeze([
  "id",
  "season",
  "episode",
  "title",
  "containerExtension",
  "container_extension",
  "duration",
]);

const PLAYBACK_PREFERENCE_FIELDS = Object.freeze([
  "streamIndex",
  "stream_index",
  "language",
  "lang",
  "title",
  "codec",
  "channels",
  "enabled",
]);

const COMMAND_PAYLOAD_FIELDS = Object.freeze([
  "url",
  "playbackUrl",
  "playback_url",
  "title",
  "path",
  "route",
  "sourceId",
  "source_id",
  "itemId",
  "item_id",
  "itemType",
  "item_type",
  "currentTime",
  "current_time",
  "autoplay",
]);

const DEVICE_CAPABILITY_FIELDS = Object.freeze([
  "cloudPairing",
  "cloud_pairing",
  "cast",
  "receiver",
  "nativePlayback",
  "native_playback",
  "touch",
  "dpad",
]);

const CONTENT_EVENT_KINDS = new Set([
  "new_content",
  "subtitle_ready",
  "subtitle_empty",
  "subtitle_failed",
  "behavioral_lifecycle",
]);
const BEHAVIORAL_LIFECYCLE_JOURNEYS = new Set([
  "no_source",
  "import_unresolved",
  "catalog_ready_no_first_play",
  "continue_watching",
]);
const BEHAVIORAL_LIFECYCLE_DEEP_LINKS = new Set([
  "/app.html#settings/sources",
  "/app.html#home",
  "/app.html#home/resume",
]);
const BEHAVIORAL_LIFECYCLE_FAILURE_FAMILIES = new Set([
  "credentials", "missing_credentials", "endpoint_not_found", "timeout",
  "provider_busy", "rate_limited", "playlist_format", "invalid_input",
  "payload_too_large", "provider_unreachable", "infrastructure", "unknown",
]);
const BEHAVIORAL_LIFECYCLE_SOURCE_TYPES = new Set(["m3u", "xtream"]);
const CONTENT_ITEM_TYPES = new Set(["movie", "series", "episode", "live"]);
const SERIES_INFO_FIELDS = Object.freeze([
  "name",
  "title",
  "plot",
  "overview",
  "cast",
  "director",
  "genre",
  "releaseDate",
  "release_date",
  "first_air_date",
  "last_modified",
  "rating",
  "rating_5based",
  "youtube_trailer",
  "episode_run_time",
  "category_id",
  "tmdb_id",
  "provider_tmdb_id",
]);
const SERIES_INFO_IMAGE_FIELDS = Object.freeze([
  "cover",
  "cover_big",
  "movie_image",
  "stream_icon",
]);
const SERIES_EPISODE_FIELDS = Object.freeze([
  "id",
  "episode_num",
  "episodeNumber",
  "title",
  "name",
  "season",
  "added",
  "duration",
  "plot",
  "overview",
  "provider_tmdb_id",
  "providerTmdbId",
  "tmdb_id",
  "tmdb",
  "releaseDate",
  "release_date",
]);
const SERIES_EPISODE_INFO_FIELDS = Object.freeze([
  "plot",
  "overview",
  "releasedate",
  "releaseDate",
  "release_date",
  "rating",
  "duration",
  "duration_secs",
  "bitrate",
  "tmdb_id",
  "provider_tmdb_id",
]);
const SERIES_SEASON_FIELDS = Object.freeze([
  "id",
  "name",
  "season_number",
  "episode_count",
  "overview",
  "air_date",
]);
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicText(value, maxLength = 2_000) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(?:https?|ftp):\/\/[^\s<>{}\[\]"']+/gi, "[link]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[account]")
    .replace(/\b(?:Bearer\s+)?(?:re_|whsec_|sk_|sb_secret_)[A-Za-z0-9._-]{8,}\b/gi, "[credential]")
    .replace(/\b(username|user|password|passwd|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text) return null;
  if (text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

function publicTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Date(timestamp).toISOString();
  } catch (_) {
    return null;
  }
}

function publicNonNegativeInteger(value, max = 10_000_000) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(max, Math.floor(number)));
}

function publicIdentifier(value, maxLength = 128) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const identifier = String(value).trim();
  return identifier && identifier.length <= maxLength && /^[A-Za-z0-9._-]+$/.test(identifier)
    ? identifier
    : null;
}

function publicLanguage(value) {
  if (typeof value !== "string") return null;
  const language = value.trim();
  return /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})?$/.test(language) ? language : null;
}

function secretVariants(values) {
  const variants = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret.length < 3) continue;
    variants.push(secret.toLowerCase());
    try {
      variants.push(encodeURIComponent(secret).toLowerCase());
    } catch (_) { /* ignore malformed input */ }
  }
  return variants;
}

function containsKnownSecret(value, variants) {
  const normalized = String(value ?? "").toLowerCase();
  return variants.some((secret) => normalized.includes(secret));
}

function urlPathContainsKnownSecret(parsed, values) {
  const secrets = (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!secrets.length) return false;
  const segments = parsed.pathname.split("/").filter(Boolean);
  for (const rawSegment of segments) {
    const candidates = [rawSegment.toLowerCase()];
    try {
      candidates.push(decodeURIComponent(rawSegment).toLowerCase());
    } catch (_) { /* malformed escapes cannot match a decoded credential */ }
    if (candidates.some((candidate) => secrets.includes(candidate))) return true;
  }
  return false;
}

function publicHttpUrl(value, knownSecrets = []) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2_048 || /[\u0000-\u001f\s]/.test(raw)) return null;
  const secrets = secretVariants(knownSecrets);
  if (containsKnownSecret(raw, secrets)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    // Series artwork is display-only. Signed or credentialized query strings
    // must first be exchanged server-side for an opaque Norva reference.
    if (parsed.search) return null;
    if (urlPathContainsKnownSecret(parsed, knownSecrets)) return null;
    if (/\/(?:live|movie|series)\/[^/]+\/[^/]+\//i.test(parsed.pathname)) return null;
    if (/(?:player_api|xmltv|get)\.php$/i.test(parsed.pathname)) return null;
    if (/\.(?:m3u8?|ts|mkv|mp4|avi|mov|webm)$/i.test(parsed.pathname)) return null;
    parsed.hash = "";
    const href = parsed.href;
    return containsKnownSecret(href, secrets) ? null : href;
  } catch (_) {
    return null;
  }
}

function publicImageValue(value, knownSecrets = []) {
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry) => publicHttpUrl(entry, knownSecrets)).filter(Boolean);
  }
  return publicHttpUrl(value, knownSecrets);
}

function redactKnownSecrets(value, knownSecrets = []) {
  let text = value;
  for (const secret of secretVariants(knownSecrets)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), "[redacted]");
  }
  return text;
}

function publicPrimitive(value, maxText = 2_000, knownSecrets = []) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const text = publicText(value, maxText);
  return text ? redactKnownSecrets(text, knownSecrets) : undefined;
}

function pickPublicPrimitives(value, fields, maxText = 2_000, knownSecrets = []) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const entry = publicPrimitive(source[field], maxText, knownSecrets);
    if (entry !== undefined && entry !== null && entry !== "") result[field] = entry;
  }
  return result;
}

export function sanitizeCloudErrorDetails(value) {
  const source = isRecord(value) ? value : {};
  const code = typeof source.code === "string" ? source.code.trim() : "";
  const rawCorrelationId = source.correlationId ?? source.correlation_id;
  const correlationId = typeof rawCorrelationId === "string" ? rawCorrelationId.trim() : "";
  const publicCode = CLOUD_PUBLIC_ERROR_CODE_SET.has(code) ? code : "";
  return {
    ...(publicCode ? { code: publicCode } : {}),
    ...(CLOUD_PUBLIC_RETRYABLE_ERROR_CODE_SET.has(publicCode) ? { retryable: true } : {}),
    ...(/^[A-Za-z0-9_-]{1,80}$/.test(correlationId) ? { correlationId } : {}),
  };
}

function clonePublicValue(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, depth > 0 ? 2_000 : 8_192);
  return undefined;
}

function pick(value, fields) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const publicValue = clonePublicValue(source[field]);
    if (publicValue !== undefined) result[field] = publicValue;
  }
  return result;
}

function sanitizeTracks(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map((track) => pick(track, TRACK_FIELDS)).filter((track) => Object.keys(track).length);
}

export function sanitizeCodecProfile(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, CODEC_PROFILE_FIELDS);
  const audioTracks = sanitizeTracks(source.audioTracks ?? source.audio_tracks);
  const subtitles = sanitizeTracks(source.subtitles ?? source.subtitleTracks ?? source.subtitle_tracks);
  if (audioTracks.length) result.audioTracks = audioTracks;
  if (subtitles.length) result.subtitles = subtitles;
  return result;
}

export function sanitizePlaybackHint(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, PLAYBACK_HINT_FIELDS);
  const codecProfile = sanitizeCodecProfile(source.codecProfile ?? source.codec_profile);
  if (Object.keys(codecProfile).length) result.codecProfile = codecProfile;
  return result;
}

export function sanitizeMediaMetadata(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, MEDIA_METADATA_FIELDS);
  const codecProfile = sanitizeCodecProfile(source.codecProfile ?? source.codec_profile);
  if (Object.keys(codecProfile).length) result.codecProfile = codecProfile;
  return result;
}

function sanitizeContentEventWatchRoute(value, expectedSourceId) {
  if (typeof value !== "string" || !expectedSourceId) return null;
  const match = value.trim().match(/^(movies|series)\/open:([^:]+):([^:]+):([^:]*)$/);
  if (!match) return null;
  try {
    const sourceId = decodeURIComponent(match[2]);
    const itemId = decodeURIComponent(match[3]);
    const title = decodeURIComponent(match[4] || "");
    if (sourceId !== expectedSourceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)) {
      return null;
    }
    if (!publicIdentifier(itemId, 128)) return null;
    const safeTitle = publicText(title, 120) ?? "";
    return `${match[1]}/open:${encodeURIComponent(sourceId)}:${encodeURIComponent(itemId)}:${encodeURIComponent(safeTitle)}`;
  } catch (_) {
    return null;
  }
}

export function sanitizeContentEvent(value) {
  const source = isRecord(value) ? value : {};
  const id = typeof source.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source.id)
    ? source.id
    : null;
  if (!id) return null;

  const kind = typeof source.kind === "string" && CONTENT_EVENT_KINDS.has(source.kind.trim().toLowerCase())
    ? source.kind.trim().toLowerCase()
    : "new_content";
  const payloadSource = isRecord(source.payload) ? source.payload : {};
  const payload = {};
  if (kind === "new_content") {
    const byTypeSource = isRecord(payloadSource.byType ?? payloadSource.by_type)
      ? (payloadSource.byType ?? payloadSource.by_type)
      : {};
    const byType = {};
    for (const itemType of ["movie", "series", "live"]) {
      const count = publicNonNegativeInteger(byTypeSource[itemType], 1_000_000);
      if (count !== null) byType[itemType] = count;
    }
    if (Object.keys(byType).length) payload.byType = byType;
    const total = publicNonNegativeInteger(payloadSource.total, 3_000_000);
    if (total !== null) payload.total = total;
  } else if (kind === "behavioral_lifecycle") {
    const deliveryId = typeof payloadSource.delivery_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payloadSource.delivery_id)
      ? payloadSource.delivery_id
      : null;
    const journeyKey = typeof payloadSource.journey_key === "string" &&
        BEHAVIORAL_LIFECYCLE_JOURNEYS.has(payloadSource.journey_key)
      ? payloadSource.journey_key
      : null;
    const deepLink = typeof payloadSource.deep_link === "string" &&
        BEHAVIORAL_LIFECYCLE_DEEP_LINKS.has(payloadSource.deep_link)
      ? payloadSource.deep_link
      : null;
    if (!deliveryId || !journeyKey || !deepLink) return null;
    payload.deliveryId = deliveryId;
    payload.journeyKey = journeyKey;
    payload.title = publicText(payloadSource.title, 80) ?? "Norva";
    payload.body = publicText(payloadSource.body, 300) ?? "Open Norva to continue.";
    payload.ctaLabel = publicText(payloadSource.cta_label, 50) ?? "Open Norva";
    payload.deepLink = deepLink;
    if (journeyKey === "import_unresolved") {
      const failureFamily = typeof payloadSource.failure_family === "string"
        && BEHAVIORAL_LIFECYCLE_FAILURE_FAMILIES.has(payloadSource.failure_family)
        ? payloadSource.failure_family
        : null;
      const sourceType = typeof payloadSource.source_type === "string"
        && BEHAVIORAL_LIFECYCLE_SOURCE_TYPES.has(payloadSource.source_type)
        ? payloadSource.source_type
        : null;
      if (failureFamily) payload.failureFamily = failureFamily;
      if (sourceType) payload.sourceType = sourceType;
    }
  } else {
    const itemType = typeof payloadSource.itemType === "string"
      ? payloadSource.itemType.trim().toLowerCase()
      : typeof payloadSource.item_type === "string" ? payloadSource.item_type.trim().toLowerCase() : "";
    if (CONTENT_ITEM_TYPES.has(itemType)) payload.itemType = itemType;
    const subtitleKind = publicIdentifier(payloadSource.kind, 32);
    if (subtitleKind) payload.kind = subtitleKind;
    const language = publicLanguage(payloadSource.lang ?? payloadSource.language);
    if (language) payload.lang = language;
    const sourceId = typeof source.source_id === "string" ? source.source_id : "";
    const watch = sanitizeContentEventWatchRoute(payloadSource.watch, sourceId);
    if (watch) payload.watch = watch;
  }

  return {
    id,
    kind,
    summary: publicText(source.summary, 300) ?? "Catalog update",
    payload,
    created_at: publicTimestamp(source.created_at),
    seen_at: source.seen_at == null ? null : publicTimestamp(source.seen_at),
  };
}

function sanitizeSeriesInfoObject(value, knownSecrets) {
  const source = isRecord(value) ? value : {};
  const result = pickPublicPrimitives(source, SERIES_INFO_FIELDS, 8_000, knownSecrets);
  for (const field of SERIES_INFO_IMAGE_FIELDS) {
    const image = publicImageValue(source[field], knownSecrets);
    if (Array.isArray(image) ? image.length : image) result[field] = image;
  }
  const backdrop = publicImageValue(source.backdrop_path, knownSecrets);
  if (Array.isArray(backdrop) ? backdrop.length : backdrop) result.backdrop_path = backdrop;
  if (Array.isArray(source.genres)) {
    const genres = source.genres.slice(0, 24).map((genre) => {
      if (typeof genre === "string") return publicText(genre, 120);
      if (!isRecord(genre)) return null;
      const name = publicText(genre.name, 120);
      const id = publicNonNegativeInteger(genre.id, 10_000_000);
      return name ? { ...(id !== null ? { id } : {}), name } : null;
    }).filter(Boolean);
    if (genres.length) result.genres = genres;
  }
  return result;
}

function sanitizeSeriesEpisode(value, knownSecrets) {
  const source = isRecord(value) ? value : {};
  const id = publicIdentifier(source.id, 128);
  if (!id) return null;
  const result = pickPublicPrimitives(source, SERIES_EPISODE_FIELDS, 8_000, knownSecrets);
  result.id = id;
  const container = typeof source.container_extension === "string"
    ? source.container_extension.trim().toLowerCase()
    : "";
  if (/^[a-z0-9]{1,12}$/.test(container)) result.container_extension = container;
  for (const field of SERIES_INFO_IMAGE_FIELDS) {
    const image = publicImageValue(source[field], knownSecrets);
    if (Array.isArray(image) ? image.length : image) result[field] = image;
  }
  if (isRecord(source.info)) {
    const info = pickPublicPrimitives(source.info, SERIES_EPISODE_INFO_FIELDS, 8_000, knownSecrets);
    for (const field of SERIES_INFO_IMAGE_FIELDS) {
      const image = publicImageValue(source.info[field], knownSecrets);
      if (Array.isArray(image) ? image.length : image) info[field] = image;
    }
    if (Object.keys(info).length) result.info = info;
  }
  return result;
}

function sanitizeSeriesSeasons(value, knownSecrets) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((season) => {
    const source = isRecord(season) ? season : {};
    const result = pickPublicPrimitives(source, SERIES_SEASON_FIELDS, 8_000, knownSecrets);
    for (const field of ["cover", "cover_big"]) {
      const image = publicImageValue(source[field], knownSecrets);
      if (Array.isArray(image) ? image.length : image) result[field] = image;
    }
    return result;
  }).filter((season) => Object.keys(season).length);
}

export function sanitizeXtreamSeriesInfo(value, options = {}) {
  const source = isRecord(value) ? value : {};
  const knownSecrets = Array.isArray(options.knownSecrets) ? options.knownSecrets : [];
  const result = {};
  const info = sanitizeSeriesInfoObject(source.info, knownSecrets);
  if (Object.keys(info).length) result.info = info;
  const seasons = sanitizeSeriesSeasons(source.seasons, knownSecrets);
  if (seasons.length) result.seasons = seasons;

  const episodeGroups = isRecord(source.episodes) || Array.isArray(source.episodes)
    ? source.episodes
    : {};
  const episodes = {};
  let remaining = 5_000;
  for (const [rawSeason, rawEpisodes] of Object.entries(episodeGroups).slice(0, 100)) {
    if (remaining <= 0) break;
    const season = String(rawSeason).trim();
    if (!/^\d{1,3}$/.test(season) || !Array.isArray(rawEpisodes)) continue;
    const rows = rawEpisodes.slice(0, Math.min(500, remaining))
      .map((episode) => sanitizeSeriesEpisode(episode, knownSecrets))
      .filter(Boolean);
    if (rows.length) {
      episodes[season] = rows;
      remaining -= rows.length;
    }
  }
  if (Object.keys(episodes).length) result.episodes = episodes;
  const originalLanguage = publicLanguage(source.original_language ?? source.originalLanguage);
  if (originalLanguage) result.original_language = originalLanguage;
  return result;
}

function sanitizedEpgText(value, maxLength, knownSecrets = []) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim().slice(0, Math.max(4, maxLength * 2));
  if (!raw) return null;
  // Xtream commonly base64-encodes these two display fields. Sanitize the
  // decoded text and re-encode it so existing clients keep the same contract.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length >= 4) {
    try {
      const padded = raw.padEnd(Math.ceil(raw.length / 4) * 4, "=");
      const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const publicValue = publicText(decoded, maxLength);
      const safe = publicValue ? redactKnownSecrets(publicValue, knownSecrets) : null;
      if (safe) {
        const encoded = new TextEncoder().encode(safe);
        let binary = "";
        for (const byte of encoded) binary += String.fromCharCode(byte);
        return btoa(binary);
      }
    } catch (_) { /* plain provider text */ }
  }
  const publicValue = publicText(raw, maxLength);
  return publicValue ? redactKnownSecrets(publicValue, knownSecrets) : null;
}

export function sanitizeXtreamShortEpg(value, options = {}) {
  const source = isRecord(value) ? value : {};
  const knownSecrets = Array.isArray(options.knownSecrets) ? options.knownSecrets : [];
  const listings = Array.isArray(source.epg_listings) ? source.epg_listings : [];
  return {
    epg_listings: listings.slice(0, 24).map((listing) => {
      const row = isRecord(listing) ? listing : {};
      const start = publicNonNegativeInteger(row.start_timestamp ?? row.start, 9_999_999_999);
      const stop = publicNonNegativeInteger(
        row.stop_timestamp ?? row.end_timestamp ?? row.stop ?? row.end,
        9_999_999_999,
      );
      if (start === null || stop === null || stop <= start) return null;
      const safe = {
        start_timestamp: String(start),
        stop_timestamp: String(stop),
      };
      const title = sanitizedEpgText(row.title, 500, knownSecrets);
      const description = sanitizedEpgText(row.description, 4_000, knownSecrets);
      if (title) safe.title = title;
      if (description) safe.description = description;
      const language = publicLanguage(row.lang ?? row.language);
      if (language) safe.lang = language;
      return safe;
    }).filter(Boolean),
  };
}

export function sanitizeCloudProfile(value) {
  const profile = pick(value, PROFILE_FIELDS);
  if (!Object.prototype.hasOwnProperty.call(profile, "locale")) profile.locale = "fr-FR";
  return profile;
}

export function sanitizeCloudDevice(value) {
  const source = isRecord(value) ? value : {};
  const device = pick(source, DEVICE_FIELDS);
  const capabilities = pick(source.capabilities, DEVICE_CAPABILITY_FIELDS);
  if (Object.keys(capabilities).length) device.capabilities = capabilities;
  else delete device.capabilities;
  return device;
}

export function sanitizeMediaItem(value) {
  const source = isRecord(value) ? value : {};
  const item = pick(source, MEDIA_ITEM_FIELDS);
  item.metadata = sanitizeMediaMetadata(source.metadata);
  item.playback_hint = sanitizePlaybackHint(source.playback_hint ?? source.playbackHint);
  return item;
}

export function sanitizeFavorite(value) {
  const source = isRecord(value) ? value : {};
  const favorite = pick(source, FAVORITE_FIELDS);
  favorite.item_meta = pick(source.item_meta ?? source.itemMeta, FAVORITE_META_FIELDS);
  return favorite;
}

function sanitizePlaybackPreferences(value) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const key of ["audio", "subtitle"]) {
    const preference = pick(source[key], PLAYBACK_PREFERENCE_FIELDS);
    if (Object.keys(preference).length) result[key] = preference;
  }
  return result;
}

export function sanitizeHistoryData(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, HISTORY_DATA_FIELDS);
  const playbackPreferences = sanitizePlaybackPreferences(source.playbackPreferences ?? source.playback_preferences);
  if (Object.keys(playbackPreferences).length) result.playbackPreferences = playbackPreferences;
  const nextEpisode = pick(source.nextEpisode ?? source.next_episode, NEXT_EPISODE_FIELDS);
  if (Object.keys(nextEpisode).length) result.nextEpisode = nextEpisode;
  const codecProfile = sanitizeCodecProfile(source.codecProfile ?? source.codec_profile);
  if (Object.keys(codecProfile).length) result.codecProfile = codecProfile;
  return result;
}

export function sanitizeWatchHistory(value) {
  const source = isRecord(value) ? value : {};
  const history = pick(source, WATCH_HISTORY_FIELDS);
  history.data = sanitizeHistoryData(source.data);
  return history;
}

export function sanitizePlaybackEvent(value) {
  return pick(value, PLAYBACK_EVENT_FIELDS);
}

export function sanitizePairing(value) {
  return pick(value, PAIRING_FIELDS);
}

export function sanitizeCastCommandPayload(value) {
  return pick(value, COMMAND_PAYLOAD_FIELDS);
}

export function sanitizeCastCommand(value) {
  const source = isRecord(value) ? value : {};
  const command = pick(source, CAST_COMMAND_FIELDS);
  command.payload = source.status === "failed" ? {} : sanitizeCastCommandPayload(source.payload);
  return command;
}

export function sanitizeGatewaySession(value) {
  return pick(value, [
    "id",
    "playback_session_id",
    "mode",
    "status",
    "hls_url",
    "expires_at",
    "created_at",
    "updated_at",
  ]);
}

export function sanitizePlaybackSession(value) {
  const source = isRecord(value) ? value : {};
  const session = pick(source, PLAYBACK_SESSION_FIELDS);
  session.playback_hint = sanitizePlaybackHint(source.playback_hint ?? source.playbackHint);
  if (typeof source.error_code === "string" && /^[A-Z0-9_-]{1,80}$/i.test(source.error_code)) {
    session.error_code = source.error_code;
  } else {
    delete session.error_code;
  }
  if (Array.isArray(source.cloud_gateway_sessions)) {
    session.cloud_gateway_sessions = source.cloud_gateway_sessions.map(sanitizeGatewaySession);
  }
  return session;
}
