import { classifyOpsSourceError } from "./source-sync-error.mjs";

// The management view is intentionally wider than a catalog source: Settings
// needs lifecycle and Provider Access state even when a catalog is hidden. Keep
// the Edge select explicit so a future database column is private by default.
export const SOURCE_MANAGEMENT_PUBLIC_FIELDS = Object.freeze([
  "id",
  "source_type",
  "display_name",
  "config_hint",
  "sync_status",
  "sync_error",
  "catalog_version",
  "last_synced_at",
  "created_at",
  "updated_at",
  "auto_refresh_state",
  "auto_refresh_next_at",
  "deleted_at",
  "enabled",
  "lifecycle_state",
  "catalog_visibility",
  "replacement_root_id",
  "replaces_source_id",
  "replaced_by_source_id",
  "config_revision",
  "visibility_epoch",
  "activated_at",
  "hidden_at",
  "rollback_until",
  "purge_after",
  "user_visibility_epoch",
  "provider_access_status",
  "provider_access_started_on",
  "provider_access_expires_on",
  "provider_access_expiry_source",
  "provider_access_manual_override",
  "provider_access_reminders_enabled",
  "provider_access_last_checked_at",
  "provider_access_last_confirmed_active_at",
  "provider_access_last_detected_at",
  "provider_access_hidden_at",
  "provider_access_restored_at",
  "catalog_visible",
]);

export const SOURCE_MANAGEMENT_PUBLIC_SELECT = SOURCE_MANAGEMENT_PUBLIC_FIELDS.join(",");

// Catalog consumers (paired TVs included) never need rollback relationships,
// hidden-source timestamps, or the wider Settings lifecycle envelope. Select
// only columns present on the canonical visibility projection so adding a new
// source column remains private by default.
export const SOURCE_CATALOG_PUBLIC_FIELDS = Object.freeze([
  "id",
  "source_type",
  "display_name",
  "config_hint",
  "sync_status",
  "sync_error",
  "catalog_version",
  "last_synced_at",
  "created_at",
  "updated_at",
  "auto_refresh_state",
  "auto_refresh_next_at",
  "enabled",
  "lifecycle_state",
  "catalog_visibility",
  "config_revision",
  "visibility_epoch",
  "user_visibility_epoch",
  "provider_access_status",
  "provider_access_expires_on",
  "provider_access_reminders_enabled",
]);

export const SOURCE_CATALOG_PUBLIC_SELECT = SOURCE_CATALOG_PUBLIC_FIELDS.join(",");

const MAX_CATALOG_COUNT = 10_000_000;
const PUBLIC_PROGRESS_STATES = new Set([
  "pending",
  "running",
  "done",
  "skipped",
  "syncing",
  "ready",
  "success",
  "complete",
  "completed",
  "error",
]);
const PUBLIC_PROGRESS_STAGES = new Set([
  "pending",
  "connecting",
  "discovering",
  "discovered",
  "importing",
  "materializing",
  "building_live_channels",
  "building_live_variants",
  "building_titles",
  "finalizing",
  "unchanged",
  "ready",
  "complete",
  "error",
]);
const PUBLIC_PROGRESS_STEPS = [
  "connect",
  "channels",
  "movies",
  "series",
  "categories",
  "import",
  "finalize",
];
const PUBLIC_FINALIZE_PHASES = new Set([
  "live",
  "live_channels",
  "live_variants",
  "titles",
  "complete",
]);
const PUBLIC_SOURCE_CONNECTION_CODES = new Set([
  "PROVIDER_BUSY",
  "PROVIDER_ACCOUNT_BUSY",
  "PROVIDER_CONNECT_TIMEOUT",
  "PROVIDER_RESPONSE_TIMEOUT",
  "PROVIDER_DNS_FAILURE",
  "PROVIDER_TLS_FAILURE",
  "PROVIDER_CONNECTION_RESET",
  "PROVIDER_NETWORK_UNREACHABLE",
  "PROVIDER_REQUEST_FAILED",
  "PROVIDER_DIRECT_FALLBACK_RETRYABLE",
  "M3U_SYNC_BUSY",
  "M3U_SYNC_BACKOFF",
  "M3U_SYNC_QUARANTINED",
  "M3U_SYNC_UNAVAILABLE",
  "SOURCE_CONFIG_REVISION_CHANGED",
]);
const PUBLIC_SOURCE_CONNECTION_STATUSES = new Set([
  400,
  401,
  403,
  404,
  408,
  409,
  429,
  458,
  500,
  502,
  503,
  504,
]);
const PUBLIC_AUTO_REFRESH_ACTIONS = new Set([
  "renew_access",
  "update_login",
  "check_provider",
  "toggle_source",
]);
const PUBLIC_AUTO_REFRESH_ERROR_KINDS = new Set([
  "expired",
  "auth",
  "not_found",
  "m3u_quarantined",
]);

const PUBLIC_SYNC_ERRORS = Object.freeze({
  busy: {
    code: "PROVIDER_BUSY",
    message: "The TV service account is busy. Try again shortly.",
  },
  expired: {
    code: "PROVIDER_ACCESS_EXPIRED",
    message: "The TV service access is expired or inactive.",
  },
  auth: {
    code: "PROVIDER_CREDENTIALS_REJECTED",
    message: "The TV service rejected the saved credentials.",
  },
  not_found: {
    code: "PROVIDER_ENDPOINT_NOT_FOUND",
    message: "The TV service address or account endpoint is no longer available.",
  },
  infra: {
    code: "PROVIDER_TEMPORARILY_UNAVAILABLE",
    message: "The TV service is temporarily unavailable.",
  },
  unknown: {
    code: "SOURCE_SYNC_FAILED",
    message: "The TV service could not be refreshed.",
  },
});

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ""),
  );
}

function boundedInteger(value, max = MAX_CATALOG_COUNT) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(max, Math.floor(number)));
}

function firstBounded(values, max = MAX_CATALOG_COUNT) {
  for (const value of values) {
    const bounded = boundedInteger(value, max);
    if (bounded !== null) return bounded;
  }
  return null;
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

function publicHost(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2_048 || /[\u0000-\u001f\s]/.test(raw)) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.host.toLowerCase();
    return host && host.length <= 255 ? host : null;
  } catch (_) {
    return null;
  }
}

function publicEnum(value, allowed) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function publicCountRecord(value) {
  const source = record(value);
  return compact({
    live: boundedInteger(source.live),
    movies: boundedInteger(source.movies),
    series: boundedInteger(source.series),
    total: boundedInteger(source.total),
  });
}

function publicLastSync(value) {
  const source = record(value);
  const liveCatalog = record(source.liveCatalog ?? source.live_catalog);
  const live = firstBounded([source.live, source.channels, source.liveChannels, liveCatalog.channels]);
  const movies = firstBounded([source.movies, source.vod, source.vodMovies]);
  const series = firstBounded([source.series, source.tvSeries]);
  const suppliedTotal = boundedInteger(source.total);
  const knownCounts = [live, movies, series].filter((entry) => entry !== null);
  const total = suppliedTotal ?? (knownCounts.length ? knownCounts.reduce((sum, entry) => sum + entry, 0) : null);
  return compact({
    live,
    movies,
    series,
    total: total === null ? null : Math.min(MAX_CATALOG_COUNT, total),
    liveCategories: boundedInteger(source.liveCategories),
    movieCategories: boundedInteger(source.movieCategories),
    seriesCategories: boundedInteger(source.seriesCategories),
    syncedAt: publicTimestamp(source.syncedAt ?? source.synced_at),
  });
}

function publicProgress(value) {
  const source = record(value);
  const rawSteps = record(source.steps);
  const counts = publicCountRecord(source.counts);
  const categories = publicCountRecord(source.categories);
  const steps = {};
  for (const name of PUBLIC_PROGRESS_STEPS) {
    const rawStep = record(rawSteps[name]);
    const step = compact({
      status: publicEnum(rawStep.status, PUBLIC_PROGRESS_STATES),
      count: boundedInteger(rawStep.count),
    });
    if (Object.keys(step).length) steps[name] = step;
  }

  return compact({
    status: publicEnum(source.status, PUBLIC_PROGRESS_STATES),
    stage: publicEnum(source.stage, PUBLIC_PROGRESS_STAGES),
    percent: boundedInteger(source.percent, 100),
    startedAt: publicTimestamp(source.startedAt ?? source.started_at),
    updatedAt: publicTimestamp(source.updatedAt ?? source.updated_at),
    counts: Object.keys(counts).length ? counts : null,
    categories: Object.keys(categories).length ? categories : null,
    steps: Object.keys(steps).length ? steps : null,
    liveReady: source.liveReady === true ? true : null,
    browseReady: source.browseReady === true ? true : null,
    usable: source.usable === true ? true : null,
  });
}

function publicFinalizeCursor(value) {
  const source = record(value);
  const phase = publicEnum(source.phase, PUBLIC_FINALIZE_PHASES);
  const offset = boundedInteger(source.offset, 1_000_000);
  const rawAfterId = typeof source.afterId === "string" ? source.afterId.trim() : "";
  const afterId = rawAfterId && rawAfterId.length <= 128 && /^[a-z0-9_.-]+$/i.test(rawAfterId)
    ? rawAfterId
    : null;
  return compact({ phase, offset, afterId });
}

export function publicSourceSyncError(value) {
  if (typeof value !== "string" || !value.trim()) return { code: null, message: null };
  const kind = classifyOpsSourceError(value);
  return PUBLIC_SYNC_ERRORS[kind] ?? PUBLIC_SYNC_ERRORS.unknown;
}

export function sanitizeSourceConfigHint(value) {
  const source = record(value);
  const safe = compact({
    serverHost: publicHost(source.serverHost ?? source.server_host),
    playlistHost: publicHost(source.playlistHost ?? source.playlist_host),
    hasPassword: source.hasPassword === true || source.has_password === true ? true : null,
    estimatedItems: boundedInteger(source.estimatedItems ?? source.estimated_items),
    lastSync: publicLastSync(source.lastSync ?? source.last_sync),
    syncProgress: publicProgress(source.syncProgress ?? source.sync_progress),
    finalizeCursor: publicFinalizeCursor(source.finalizeCursor ?? source.finalize_cursor),
  });
  for (const key of ["lastSync", "syncProgress", "finalizeCursor"]) {
    if (safe[key] && Object.keys(safe[key]).length === 0) delete safe[key];
  }
  return safe;
}

export function sanitizeSourceValidation(value) {
  const source = record(value);
  return compact({
    serverHost: publicHost(source.serverHost ?? source.serverUrl ?? source.server_url),
    playlistHost: publicHost(source.playlistHost ?? source.playlistUrl ?? source.playlist_url),
    estimatedItems: boundedInteger(source.estimatedItems ?? source.estimated_items),
  });
}

export function sanitizeSourceConnectionResult(value) {
  const source = record(value);
  const checkedAt = publicTimestamp(source.checkedAt ?? source.checked_at);
  if (source.success === true) {
    return compact({ success: true, status: "reachable", checkedAt });
  }

  const suppliedStatus = boundedInteger(source.status, 599);
  const status = suppliedStatus !== null && PUBLIC_SOURCE_CONNECTION_STATUSES.has(suppliedStatus)
    ? suppliedStatus
    : 502;
  const suppliedCode = typeof source.code === "string" ? source.code.trim().toUpperCase() : "";
  const code = status === 458
    ? "PROVIDER_BUSY"
    : status === 504
      ? "PROVIDER_RESPONSE_TIMEOUT"
      : PUBLIC_SOURCE_CONNECTION_CODES.has(suppliedCode)
        ? suppliedCode
        : "PROVIDER_REQUEST_FAILED";
  const error = code === "PROVIDER_BUSY" || code === "PROVIDER_ACCOUNT_BUSY"
    ? "This TV service is busy. Wait a few seconds, then try again."
    : code === "M3U_SYNC_BUSY"
      ? "A source operation is already in progress."
      : code === "M3U_SYNC_BACKOFF"
        ? "This source is cooling down after a failed synchronization attempt."
        : code === "M3U_SYNC_QUARANTINED"
          ? "Disable and enable this source before trying again."
          : code === "M3U_SYNC_UNAVAILABLE"
            ? "Source synchronization is temporarily unavailable."
    : code === "PROVIDER_CONNECT_TIMEOUT" || code === "PROVIDER_RESPONSE_TIMEOUT"
      ? "The TV service did not respond before the connection timed out."
      : code === "PROVIDER_DNS_FAILURE"
        ? "The TV service address could not be resolved."
        : code === "PROVIDER_TLS_FAILURE"
          ? "The TV service could not establish a secure connection."
          : code === "PROVIDER_CONNECTION_RESET"
            ? "The TV service closed the network connection unexpectedly."
            : code === "PROVIDER_NETWORK_UNREACHABLE"
              ? "The network route to the TV service is unavailable."
              : status === 401 || status === 403
                ? "The TV service refused these login details."
                : "Norva could not reach this TV service.";

  return compact({ success: false, code, status, error, checkedAt });
}

export function sanitizeSourceAutoRefreshState(value) {
  const source = record(value);
  const terminalStatus = boundedInteger(source.terminalHttpStatus, 599);
  return compact({
    actionRequired: source.actionRequired === true ? true : null,
    actionRequiredReason: publicEnum(
      source.actionRequiredReason,
      PUBLIC_AUTO_REFRESH_ACTIONS,
    )?.toUpperCase(),
    terminalHttpStatus: terminalStatus !== null
        && PUBLIC_SOURCE_CONNECTION_STATUSES.has(terminalStatus)
      ? terminalStatus
      : null,
    terminalErrorKind: publicEnum(
      source.terminalErrorKind,
      PUBLIC_AUTO_REFRESH_ERROR_KINDS,
    ),
    terminalFailureCount: boundedInteger(source.terminalFailureCount, 20),
    suspended: source.suspended === true ? true : null,
  });
}

export function sanitizeSource(sourceValue) {
  const source = record(sourceValue);
  const safe = {};
  for (const field of SOURCE_MANAGEMENT_PUBLIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) safe[field] = source[field];
  }
  safe.config_hint = sanitizeSourceConfigHint(source.config_hint ?? source.configHint);
  safe.auto_refresh_state = sanitizeSourceAutoRefreshState(
    source.auto_refresh_state ?? source.autoRefreshState,
  );
  const publicError = publicSourceSyncError(source.sync_error ?? source.syncError);
  safe.sync_error = publicError.message;
  safe.sync_error_code = publicError.code;
  return safe;
}

export function sanitizeCatalogSource(sourceValue) {
  const source = record(sourceValue);
  const safe = {};
  for (const field of SOURCE_CATALOG_PUBLIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) safe[field] = source[field];
  }
  safe.config_hint = sanitizeSourceConfigHint(source.config_hint ?? source.configHint);
  safe.auto_refresh_state = sanitizeSourceAutoRefreshState(
    source.auto_refresh_state ?? source.autoRefreshState,
  );
  const publicError = publicSourceSyncError(source.sync_error ?? source.syncError);
  safe.sync_error = publicError.message;
  safe.sync_error_code = publicError.code;
  // This sanitizer is only used after selecting from
  // cloud_catalog_visible_sources, so this value is derived rather than trusted
  // from a caller/provider payload.
  safe.catalog_visible = true;
  return safe;
}
