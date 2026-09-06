import {
  sanitizeCodecProfile,
  sanitizeMediaMetadata,
  sanitizePlaybackHint,
} from "./cloud-public-view.mjs";
import { publicProviderAudioLanguages } from "./selection-provider-languages.mjs";

// Catalog reads combine rows from RPCs, materialized views, and provider-global
// overlays. Keep their public representation here so a newly-added database or
// provider field stays private until it is deliberately selected below.

const MEDIA_SCALAR_FIELDS = Object.freeze([
  "id",
  "title_id",
  "titleId",
  "source_id",
  "sourceId",
  "media_item_id",
  "mediaItemId",
  "item_type",
  "itemType",
  "type",
  "external_id",
  "externalId",
  "item_id",
  "itemId",
  "parent_external_id",
  "parentExternalId",
  "name",
  "title",
  "original_title",
  "originalTitle",
  "raw_title",
  "rawTitle",
  "subtitle",
  "label",
  "language",
  "quality",
  "resolution",
  "container_extension",
  "containerExtension",
  "overview",
  "description",
  "year",
  "release_year",
  "poster_url",
  "posterUrl",
  "stream_icon",
  "backdrop_url",
  "backdropUrl",
  "category_id",
  "categoryId",
  "category_name",
  "categoryName",
  "rating",
  "vote_average",
  "voteAverage",
  "runtime",
  "runtimeMinutes",
  "provider_tmdb_id",
  "providerTmdbId",
  "provider_imdb_id",
  "providerImdbId",
  "match_status",
  "matchStatus",
  "default_variant_id",
  "defaultVariantId",
  "exposed_variant_count",
  "exposedVariantCount",
  "variant_count",
  "variantCount",
  "playback_cost_score",
  "playbackCostScore",
  "last_observed_ttff_ms",
  "lastObservedTtffMs",
  "added",
  "added_at",
  "created_at",
  "updated_at",
  "available",
  "audio_tracks_scope",
  "audioTracksScope",
  "audio_probed_at",
  "audioProbedAt",
  "audio_languages_scope",
  "audioLanguagesScope",
  "audio_languages_observed",
  "audioLanguagesObserved",
  "audio_language_validation_status",
  "audioLanguageValidationStatus",
  "audio_language_verified_at",
  "audioLanguageVerifiedAt",
  "subtitle_tracks_scope",
  "subtitleTracksScope",
  "subtitle_probed_at",
  "subtitleProbedAt",
  "subtitle_languages_scope",
  "subtitleLanguagesScope",
  "subtitle_languages_observed",
  "subtitleLanguagesObserved",
  "compatibility_tier",
  "compatibilityTier",
]);

const LIVE_SCALAR_FIELDS = Object.freeze([
  ...MEDIA_SCALAR_FIELDS,
  "logical_id",
  "logicalId",
  "logical_key",
  "logicalKey",
  "stream_id",
  "streamId",
  "raw",
  "rank",
  "health_rank",
  "healthRank",
  "lcn",
  "num",
  "section",
  "group_id",
  "groupId",
  "group_name",
  "groupName",
]);

const ENVELOPE_FIELDS = Object.freeze([
  "contract",
  "type",
  "country",
  "source",
  "sourceId",
  "materialized",
  "syncedAt",
  "count",
  "films",
  "total",
  "limit",
  "offset",
  "hasMore",
  "rawCount",
]);

const RAIL_FIELDS = Object.freeze(["id", "title", "itemType", "source"]);
const CURATION_FIELDS = Object.freeze([
  "kind",
  "metric",
  "bucket",
  "genre",
  "anchorTitleId",
  "anchorTitle",
]);
const GROUP_FIELDS = Object.freeze([
  "id",
  "category_id",
  "categoryId",
  "name",
  "category_name",
  "categoryName",
  "priority",
  "defaultCollapsed",
  "count",
]);

const METADATA_SCALAR_FIELDS = Object.freeze([
  "categoryId",
  "category_id",
  "categoryName",
  "category_name",
  "group",
  "groupId",
  "group_id",
  "groupName",
  "group_name",
  "country",
  "section",
  "lcn",
  "logical",
  "materialized",
  "syncedAt",
  "title",
  "subtitle",
  "overview",
  "description",
  "plot",
  "year",
  "releaseDate",
  "release_date",
  "rating",
  "voteAverage",
  "vote_average",
  "runtime",
  "runtimeMinutes",
  "duration",
  "durationSeconds",
  "duration_seconds",
  "container",
  "containerExtension",
  "container_extension",
  "providerTmdbId",
  "provider_tmdb_id",
  "providerImdbId",
  "provider_imdb_id",
  "sourceCategoryId",
  "sourceCategoryName",
  "sourceId",
  "source_id",
  "titleId",
  "title_id",
  "backdrop",
  "backdropUrl",
  "backdrop_url",
  "poster",
  "posterUrl",
  "poster_url",
  "added",
  "addedAt",
  "added_at",
]);

const TMDB_FIELDS = Object.freeze([
  "id",
  "title",
  "name",
  "original_title",
  "original_name",
  "original_language",
  "overview",
  "tagline",
  "poster_path",
  "backdrop_path",
  "release_date",
  "first_air_date",
  "last_air_date",
  "vote_average",
  "vote_count",
  "popularity",
  "runtime",
  "number_of_seasons",
  "number_of_episodes",
  "status",
]);

const VERIFICATION_FIELDS = Object.freeze([
  "status",
  "source",
  "method",
  "model",
  "language",
  "detectedLanguage",
  "detected_language",
  "confidence",
  "verified",
  "verifiedAt",
  "verified_at",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicScalar(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, depth > 0 ? 4_000 : 12_000);
  return undefined;
}

function pick(value, fields) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const selected = publicScalar(source[field], 1);
    if (selected !== undefined) result[field] = selected;
  }
  return result;
}

function publicStringList(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((entry) => typeof entry === "string" ? entry.trim().slice(0, 160) : "")
    .filter(Boolean);
}

function publicTracks(value, kind) {
  if (!Array.isArray(value)) return [];
  const profile = sanitizeCodecProfile(kind === "subtitle"
    ? { subtitles: value }
    : { audioTracks: value });
  return kind === "subtitle" ? (profile.subtitles ?? []) : (profile.audioTracks ?? []);
}

function publicImageUrl(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2_048 || /[\u0000-\u001f]/.test(raw)) return null;
  // Root-relative Norva artwork is allowed, but protocol-relative URLs and
  // provider playback paths are not local assets. Parse against a fixed local
  // origin before accepting so `//host/...` and credentialed query/path forms
  // cannot bypass the absolute-URL checks below.
  if (raw.startsWith("/")) {
    if (raw.startsWith("//") || raw.includes("\\")) return null;
    try {
      const local = new URL(raw, "https://norva.invalid");
      if (local.origin !== "https://norva.invalid") return null;
      for (const key of local.searchParams.keys()) {
        if (/(?:^|[_-])(?:token|access[_-]?token|password|passwd|username|user|credential|authorization|auth|secret|api[_-]?key|key)(?:$|[_-])/i.test(key)) {
          return null;
        }
      }
      if (/\/(?:live|movie|series)\/[^/]+\/[^/]+\//i.test(local.pathname)) return null;
      if (/\/(?:get|player_api)\.php$/i.test(local.pathname)) return null;
      return raw;
    } catch (_) {
      return null;
    }
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    for (const key of url.searchParams.keys()) {
      if (/(?:^|[_-])(?:token|access[_-]?token|password|passwd|username|user|credential|authorization|auth|secret|api[_-]?key|key)(?:$|[_-])/i.test(key)) {
        return null;
      }
    }
    if (/\/(?:live|movie|series)\/[^/]+\/[^/]+\//i.test(url.pathname)) return null;
    if (/\/(?:get|player_api)\.php$/i.test(url.pathname)) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function applyPublicImages(result, source) {
  for (const key of [
    "poster",
    "poster_url",
    "posterUrl",
    "stream_icon",
    "backdrop",
    "backdrop_url",
    "backdropUrl",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const image = publicImageUrl(source[key]);
    if (image) result[key] = image;
    else delete result[key];
  }
}

function sanitizeGenres(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map((entry) => {
    if (typeof entry === "string") return entry.trim().slice(0, 160);
    if (!isRecord(entry)) return null;
    return pick(entry, ["id", "name"]);
  }).filter((entry) => typeof entry === "string" ? Boolean(entry) : entry && Object.keys(entry).length);
}

function sanitizeTmdb(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, TMDB_FIELDS);
  const genres = sanitizeGenres(source.genres);
  if (genres.length) result.genres = genres;
  const episodeRunTime = Array.isArray(source.episode_run_time)
    ? source.episode_run_time.slice(0, 16).map(Number).filter(Number.isFinite)
    : [];
  if (episodeRunTime.length) result.episode_run_time = episodeRunTime;
  return result;
}

function sanitizeI18n(value) {
  const source = isRecord(value) ? value : {};
  const result = {};
  for (const [language, translation] of Object.entries(source).slice(0, 64)) {
    if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language) || !isRecord(translation)) continue;
    const selected = pick(translation, ["title", "name", "overview", "description"]);
    if (Object.keys(selected).length) result[language] = selected;
  }
  return result;
}

export function sanitizeCatalogMetadata(value) {
  const source = isRecord(value) ? value : {};
  const result = {
    ...sanitizeMediaMetadata(source),
    ...pick(source, METADATA_SCALAR_FIELDS),
  };
  applyPublicImages(result, source);
  const genres = sanitizeGenres(source.genres);
  if (genres.length) result.genres = genres;
  const tmdb = sanitizeTmdb(source.tmdb);
  if (Object.keys(tmdb).length) result.tmdb = tmdb;
  const i18n = sanitizeI18n(source.i18n);
  if (Object.keys(i18n).length) result.i18n = i18n;
  const codecProfile = sanitizeCodecProfile(source.codecProfile ?? source.codec_profile);
  if (Object.keys(codecProfile).length) result.codecProfile = codecProfile;
  return result;
}

function sanitizeVerification(value) {
  return pick(value, VERIFICATION_FIELDS);
}

export function sanitizeCatalogVariant(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, MEDIA_SCALAR_FIELDS);
  applyPublicImages(result, source);
  const providerAudio = publicProviderAudioLanguages(source);
  if (providerAudio.length) {
    result.provider_audio_languages = providerAudio;
    result.providerAudioLanguages = providerAudio;
    result.provider_audio_language_status = 'provider_declared';
    result.providerAudioLanguageStatus = 'provider_declared';
  }

  const hint = sanitizePlaybackHint(source.playback_hint ?? source.playbackHint);
  if (Object.keys(hint).length) {
    result.playback_hint = hint;
    result.playbackHint = hint;
  }
  const codecProfile = sanitizeCodecProfile(source.codec_profile ?? source.codecProfile);
  if (Object.keys(codecProfile).length) {
    result.codec_profile = codecProfile;
    result.codecProfile = codecProfile;
  }

  for (const [snake, camel] of [
    ["audio_languages", "audioLanguages"],
    ["audio_verified_languages", "audioVerifiedLanguages"],
    ["subtitle_languages", "subtitleLanguages"],
  ]) {
    const list = publicStringList(source[snake] ?? source[camel]);
    if (list.length) {
      result[snake] = list;
      result[camel] = list;
    }
  }
  const audioTracks = publicTracks(source.audio_tracks ?? source.audioTracks, "audio");
  if (audioTracks.length) {
    result.audio_tracks = audioTracks;
    result.audioTracks = audioTracks;
  }
  const subtitleTracks = publicTracks(source.subtitle_tracks ?? source.subtitleTracks, "subtitle");
  if (subtitleTracks.length) {
    result.subtitle_tracks = subtitleTracks;
    result.subtitleTracks = subtitleTracks;
  }
  const verification = sanitizeVerification(
    source.audio_language_verification ?? source.audioLanguageVerification,
  );
  if (Object.keys(verification).length) {
    result.audio_language_verification = verification;
    result.audioLanguageVerification = verification;
  }
  const metadata = sanitizeCatalogMetadata(source.metadata);
  if (Object.keys(metadata).length) result.metadata = metadata;
  return result;
}

export function sanitizeCatalogMediaItem(value) {
  const source = isRecord(value) ? value : {};
  const result = sanitizeCatalogVariant(source);
  const genres = sanitizeGenres(source.genres);
  if (genres.length) result.genres = genres;
  const versionLanguages = publicStringList(source.version_languages ?? source.versionLanguages);
  if (versionLanguages.length) {
    result.version_languages = versionLanguages;
    result.versionLanguages = versionLanguages;
  }
  const tmdb = sanitizeTmdb(source.tmdb);
  if (Object.keys(tmdb).length) result.tmdb = tmdb;
  const data = sanitizeCatalogMetadata(source.data);
  if (Object.keys(data).length) result.data = data;

  const defaultVariant = sanitizeCatalogVariant(source.default_variant ?? source.defaultVariant);
  if (Object.keys(defaultVariant).length) {
    result.default_variant = defaultVariant;
    result.defaultVariant = defaultVariant;
  }
  if (Array.isArray(source.variants)) {
    result.variants = source.variants.slice(0, 64).map(sanitizeCatalogVariant);
  }
  return result;
}

function sanitizeCuration(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, CURATION_FIELDS);
  const genres = sanitizeGenres(source.genres);
  if (genres.length) result.genres = genres;
  return result;
}

function sanitizeRail(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, RAIL_FIELDS);
  const curation = sanitizeCuration(source.curation);
  if (Object.keys(curation).length) result.curation = curation;
  result.items = Array.isArray(source.items)
    ? source.items.map(sanitizeCatalogMediaItem)
    : [];
  return result;
}

export function sanitizeCatalogMediaPayload(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, ENVELOPE_FIELDS);
  if (source.contract === 'norva.home.rails.v1' && source.liveOnly === true) result.liveOnly = true;
  if (Array.isArray(source.items)) result.items = source.items.map(sanitizeCatalogMediaItem);
  if (Array.isArray(source.rails)) result.rails = source.rails.map(sanitizeRail);
  return result;
}

export function sanitizeLiveVariant(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, LIVE_SCALAR_FIELDS);
  applyPublicImages(result, source);
  const hint = sanitizePlaybackHint(source.playback_hint ?? source.playbackHint);
  if (Object.keys(hint).length) {
    result.playback_hint = hint;
    result.playbackHint = hint;
  }
  const metadata = sanitizeCatalogMetadata(source.metadata);
  if (Object.keys(metadata).length) result.metadata = metadata;
  return result;
}

export function sanitizeLiveChannel(value) {
  const source = isRecord(value) ? value : {};
  const result = sanitizeLiveVariant(source);
  const defaultVariant = sanitizeLiveVariant(source.default_variant ?? source.defaultVariant);
  if (Object.keys(defaultVariant).length) {
    result.default_variant = defaultVariant;
    result.defaultVariant = defaultVariant;
  }
  if (Array.isArray(source.variant_preview)) {
    result.variant_preview = source.variant_preview.slice(0, 64).map(sanitizeLiveVariant);
  }
  if (Array.isArray(source.variants)) {
    result.variants = source.variants.slice(0, 64).map(sanitizeLiveVariant);
  }
  return result;
}

function sanitizeLiveGroup(value) {
  return pick(value, GROUP_FIELDS);
}

export function sanitizeLiveCatalogPayload(value) {
  const source = isRecord(value) ? value : {};
  const result = pick(source, ENVELOPE_FIELDS);
  if (isRecord(source.channel)) result.channel = sanitizeLiveChannel(source.channel);
  if (Array.isArray(source.channels)) result.channels = source.channels.map(sanitizeLiveChannel);
  if (Array.isArray(source.variants)) result.variants = source.variants.map(sanitizeLiveVariant);
  if (Array.isArray(source.groups)) result.groups = source.groups.map(sanitizeLiveGroup);
  return result;
}
