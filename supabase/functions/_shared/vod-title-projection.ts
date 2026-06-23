import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

type ProjectionRow = {
  id?: string;
  user_id?: string;
  source_id?: string;
  item_type?: string;
  external_id?: string;
  title?: string;
  subtitle?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  metadata?: JsonRecord | null;
  playback_hint?: JsonRecord | null;
};

type XtreamConfig = {
  serverUrl: string;
  username: string;
  password: string;
};

type ProjectionOptions = {
  sourceId: string;
  userId: string;
  rows: ProjectionRow[];
  db: SupabaseClient;
  xtreamConfig?: XtreamConfig | null;
  vodInfoLimit?: number;
  tmdbValidateLimit?: number;
};

const encoder = new TextEncoder();
const DEFAULT_VOD_INFO_LIMIT = 120;
const DEFAULT_TMDB_VALIDATE_LIMIT = 120;

export async function refreshVodTitleProjection(options: ProjectionOptions) {
  const rows = options.rows.filter((row) =>
    (row.item_type === "movie" || row.item_type === "series") &&
    stringOr(row.external_id, "") &&
    stringOr(row.title, "")
  );
  if (!rows.length) return { titles: 0, variants: 0, providerTmdbIds: 0, vodInfoFetched: 0 };

  const vodInfoByExternalId = options.xtreamConfig
    ? await loadVodInfoIds(options.xtreamConfig, rows, boundedInt(options.vodInfoLimit, DEFAULT_VOD_INFO_LIMIT, 0, 1000))
    : new Map<string, ProviderIds>();
  const providerIdsByExternalId = collectProviderIds(rows, vodInfoByExternalId);
  const tmdbValidationById = await validateProviderTmdbIds(rows, providerIdsByExternalId, options.tmdbValidateLimit);

  const titleRowsByKey = new Map<string, JsonRecord>();
  const variantRows: JsonRecord[] = [];
  const syncedAt = new Date().toISOString();
  let providerTmdbIds = 0;

  for (const row of rows) {
    const metadata = recordOrEmpty(row.metadata);
    const playbackHint = recordOrEmpty(row.playback_hint);
    const externalId = stringOr(row.external_id, "");
    const title = stringOr(row.title, "Norva");
    const itemType = row.item_type === "series" ? "series" : "movie";
    const releaseYear = extractYear(title, metadata.year ?? metadata.releaseYear ?? metadata.release_date);
    const providerIds = providerIdsByExternalId.get(externalId) ?? { tmdbId: null, imdbId: null };
    const tmdbValidation = providerIds.tmdbId ? tmdbValidationById.get(tmdbValidationKey(itemType, providerIds.tmdbId)) : null;
    const trustedTmdbId = tmdbValidation?.valid ? providerIds.tmdbId : null;
    const trustedIds = { tmdbId: trustedTmdbId, imdbId: providerIds.imdbId };
    // Dedup identity binds to the PROVIDER's id whenever it's real, so a film's
    // localized + quality variants ("Le roi lion" / "El rey leon" / "the dark
    // knight rises p 2") collapse onto ONE canonical title — even when our en-US
    // title-confidence check didn't pass. Validation (trustedTmdbId) still gates
    // whether we trust TMDB *metadata*; it must never split identity. cleanId()
    // maps the "0" no-match sentinel to null, so those fall through to norm:.
    const identity = identityForTitle(itemType, title, releaseYear, providerIds);
    if (providerIds.tmdbId) providerTmdbIds += 1;

    if (!titleRowsByKey.has(identity.key)) {
      titleRowsByKey.set(identity.key, {
        user_id: options.userId,
        item_type: itemType,
        identity_key: identity.key,
        identity_source: identity.source,
        provider_tmdb_id: providerIds.tmdbId || null,
        provider_imdb_id: providerIds.imdbId || null,
        match_status: matchStatusFor(providerIds, trustedIds, tmdbValidation),
        title: tmdbValidation?.valid && tmdbValidation.title ? tmdbValidation.title : cleanDisplayTitle(title),
        original_title: title,
        release_year: tmdbValidation?.valid && tmdbValidation.year ? Number(tmdbValidation.year) : releaseYear ? Number(releaseYear) : null,
        poster_url: stringOrNull(row.poster_url) || tmdbValidation?.posterUrl || null,
        backdrop_url: stringOrNull(row.backdrop_url) || tmdbValidation?.backdropUrl || null,
        metadata: compactRecord({
          categoryName: row.subtitle || metadata.categoryName,
          providerIds,
          tmdb: tmdbValidation?.valid ? tmdbValidation.details : undefined,
          // Per-language { title, overview } so the read path can serve each user
          // their own language (the catalogue's configured language stays the
          // default on the row's title/overview columns).
          i18n: tmdbValidation?.valid ? tmdbValidation.i18n : undefined,
          tmdbValidation: tmdbValidation ? {
            valid: tmdbValidation.valid,
            title: tmdbValidation.title,
            year: tmdbValidation.year,
            confidence: tmdbValidation.confidence,
            reason: tmdbValidation.reason,
          } : undefined,
          projectionVersion: 3,
          syncedAt,
        }),
        synced_at: syncedAt,
      });
    }

    const observedTtff = observedTtffMs(metadata, playbackHint);
    const compatibility = compatibilitySeed(playbackHint, metadata, title);
    const version = parseVersionInfo(title, metadata);
    variantRows.push({
      user_id: options.userId,
      source_id: options.sourceId,
      media_item_id: row.id || null,
      item_type: itemType,
      external_id: externalId,
      raw_title: title,
      label: variantLabel(version),
      language: version.language,
      quality: version.quality,
      resolution: version.resolution,
      container_extension: stringOr(playbackHint.container ?? metadata.container, itemType === "movie" ? "mp4" : ""),
      poster_url: stringOrNull(row.poster_url),
      playback_hint: compactRecord({
        ...playbackHint,
        providerTmdbId: providerIds.tmdbId || undefined,
        trustedTmdbId: trustedIds.tmdbId || undefined,
        providerImdbId: providerIds.imdbId || undefined,
      }),
      codec_profile: recordOrEmpty(metadata.codecProfile ?? metadata.codec_profile),
      compatibility_tier: compatibility.tier,
      playback_cost_score: playbackCostScore(compatibility.tier, observedTtff),
      last_observed_ttff_ms: observedTtff,
      metadata: compactRecord({
        ...metadata,
        categoryName: row.subtitle || metadata.categoryName,
        identityKey: identity.key,
        identitySource: identity.source,
        providerTmdbId: providerIds.tmdbId || undefined,
        trustedTmdbId: trustedIds.tmdbId || undefined,
        providerImdbId: providerIds.imdbId || undefined,
        tmdbValidation: tmdbValidation ? {
          valid: tmdbValidation.valid,
          confidence: tmdbValidation.confidence,
          reason: tmdbValidation.reason,
        } : undefined,
      }),
    });
  }

  const titleRows = [...titleRowsByKey.values()];
  const titleIdByKey = new Map<string, string>();
  for (let index = 0; index < titleRows.length; index += 500) {
    const chunk = titleRows.slice(index, index + 500);
    const { data, error } = await options.db
      .from("cloud_titles")
      .upsert(chunk, { onConflict: "user_id,item_type,identity_key" })
      .select("id,identity_key");
    if (error) throw error;
    for (const title of data ?? []) {
      if (typeof title.identity_key === "string" && typeof title.id === "string") {
        titleIdByKey.set(title.identity_key, title.id);
      }
    }
  }

  for (const variant of variantRows) {
    const key = stringOr(recordOrEmpty(variant.metadata).identityKey, "");
    const titleId = titleIdByKey.get(key);
    if (titleId) variant.title_id = titleId;
  }

  const savedVariants = variantRows.filter((variant) => variant.title_id);
  for (let index = 0; index < savedVariants.length; index += 500) {
    const chunk = savedVariants.slice(index, index + 500);
    const { error } = await options.db
      .from("cloud_title_variants")
      .upsert(chunk, { onConflict: "source_id,item_type,external_id" });
    if (error) throw error;
  }

  // Push the resolved release_year onto the grid rows (cloud_media_items) so the
  // browse page can sort/paginate by year server-side. The BEFORE trigger already
  // set a title-parsed year on insert; this fills the TMDB-matched ones. Best
  // effort — a sync must never fail over a sort denormalization.
  try {
    await options.db.rpc("propagate_media_item_years", { p_user: options.userId, p_source: options.sourceId });
  } catch (error) {
    console.warn("[vod-title-projection] year propagation skipped:", error instanceof Error ? error.message : error);
  }

  return {
    titles: titleRows.length,
    variants: savedVariants.length,
    providerTmdbIds,
    vodInfoFetched: vodInfoByExternalId.size,
  };
}

type ProviderIds = { tmdbId: string | null; imdbId: string | null };

type TmdbValidation = {
  valid: boolean;
  title: string | null;
  year: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  confidence: number;
  i18n?: Record<string, { title?: string; overview?: string }>;
  reason: string;
  details?: JsonRecord;
};

function collectProviderIds(rows: ProjectionRow[], vodInfoByExternalId: Map<string, ProviderIds>) {
  const idsByExternalId = new Map<string, ProviderIds>();
  for (const row of rows) {
    const externalId = stringOr(row.external_id, "");
    if (!externalId) continue;
    const ids = mergeProviderIds(extractProviderIds(row.metadata), extractProviderIds(row.playback_hint), vodInfoByExternalId.get(externalId));
    idsByExternalId.set(externalId, ids);
  }
  return idsByExternalId;
}

function matchStatusFor(providerIds: ProviderIds, trustedIds: ProviderIds, validation: TmdbValidation | null | undefined) {
  if (validation?.valid) return "provider_verified";
  if (providerIds.tmdbId && !trustedIds.tmdbId && validation?.valid === false) return "weak";
  if (providerIds.tmdbId || providerIds.imdbId) return "provider_unverified";
  return "unmatched";
}

function mergeProviderIds(...ids: Array<ProviderIds | undefined>): ProviderIds {
  for (const item of ids) {
    if (item?.tmdbId || item?.imdbId) {
      return { tmdbId: item.tmdbId || null, imdbId: item.imdbId || null };
    }
  }
  return { tmdbId: null, imdbId: null };
}

function extractProviderIds(value: unknown): ProviderIds {
  const record = recordOrEmpty(value);
  const nested = recordOrEmpty(record.info ?? record.movie_data ?? record.movieData);
  const tmdbId = cleanId(
    record.tmdb_id ?? record.tmdbId ?? record.tmdb ??
    record.providerTmdbId ?? record.provider_tmdb_id ??
    nested.tmdb_id ?? nested.tmdbId ?? nested.tmdb,
  );
  const imdbId = cleanId(
    record.imdb_id ?? record.imdbId ?? record.imdb ??
    record.providerImdbId ?? record.provider_imdb_id ??
    nested.imdb_id ?? nested.imdbId ?? nested.imdb,
  );
  return { tmdbId, imdbId };
}

async function loadVodInfoIds(config: XtreamConfig, rows: ProjectionRow[], limit: number) {
  const result = new Map<string, ProviderIds>();
  if (limit <= 0) return result;
  const candidates = rows
    .filter((row) => row.item_type === "movie")
    .sort((a, b) => Number(recordOrEmpty(b.metadata).added || 0) - Number(recordOrEmpty(a.metadata).added || 0))
    .slice(0, limit);

  const concurrency = 4;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      const row = candidates[index];
      if (!row) return;
      const externalId = stringOr(row.external_id, "");
      if (!externalId) continue;
      try {
        const payload = await fetchJson(xtreamApiUrl(config, "get_vod_info", { vod_id: externalId }), 8000);
        const ids = extractProviderIds(payload);
        if (ids.tmdbId || ids.imdbId) result.set(externalId, ids);
      } catch (_) {
        // Provider metadata is an optimization. The raw item still imports.
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}

async function validateProviderTmdbIds(rows: ProjectionRow[], idsByExternalId: Map<string, ProviderIds>, limitOverride?: number) {
  const apiKey = stringOr(Deno.env.get("NORVA_TMDB_API_KEY") ?? Deno.env.get("TMDB_API_KEY") ?? Deno.env.get("TMDB_READ_TOKEN"), "");
  const limit = limitOverride === undefined
    ? boundedInt(Deno.env.get("NORVA_TMDB_VALIDATE_LIMIT"), DEFAULT_TMDB_VALIDATE_LIMIT, 0, 1000)
    : boundedInt(limitOverride, DEFAULT_TMDB_VALIDATE_LIMIT, 0, 1000);
  const validations = new Map<string, TmdbValidation>();
  if (!apiKey || limit <= 0) return validations;

  const candidates: Array<{ key: string; itemType: "movie" | "series"; tmdbId: string; title: string; year: string | null }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const externalId = stringOr(row.external_id, "");
    const itemType = row.item_type === "series" ? "series" : row.item_type === "movie" ? "movie" : "";
    const ids = externalId ? idsByExternalId.get(externalId) : null;
    if (!itemType || !ids?.tmdbId) continue;
    const key = tmdbValidationKey(itemType, ids.tmdbId);
    if (seen.has(key)) continue;
    seen.add(key);
    const metadata = recordOrEmpty(row.metadata);
    const title = stringOr(row.title, "");
    candidates.push({
      key,
      itemType,
      tmdbId: ids.tmdbId,
      title,
      year: extractYear(title, metadata.year ?? metadata.releaseYear ?? metadata.release_date),
    });
    if (candidates.length >= limit) break;
  }

  const concurrency = 4;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      const candidate = candidates[index];
      if (!candidate) return;
      try {
        validations.set(candidate.key, await validateTmdbCandidate(apiKey, candidate));
      } catch (_) {
        // TMDB validation is defensive. A temporary API failure must not block sync.
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return validations;
}

export async function validateTmdbCandidate(
  apiKey: string,
  candidate: { itemType: "movie" | "series"; tmdbId: string; title: string; year: string | null },
): Promise<TmdbValidation> {
  const details = await fetchTmdbDetails(apiKey, candidate.itemType, candidate.tmdbId);

  // Per-language titles + overviews from TMDB translations (plus country
  // alternative titles). Used BOTH to validate (a localized provider title must
  // match the film in ITS language, not only en/fr) and to store i18n so the read
  // path can later serve each user their own language.
  const translations = Array.isArray(recordOrEmpty(details.translations).translations)
    ? recordOrEmpty(details.translations).translations as JsonRecord[]
    : [];
  const i18n: Record<string, { title?: string; overview?: string }> = {};
  for (const entry of translations) {
    const rec = recordOrEmpty(entry);
    const lang = stringOr(rec.iso_639_1, "").toLowerCase();
    const data = recordOrEmpty(rec.data);
    const locTitle = stringOr(data.title ?? data.name, "");
    const locOverview = stringOr(data.overview, "");
    if (!lang || (!locTitle && !locOverview)) continue;
    i18n[lang] = compactRecord({ title: locTitle || undefined, overview: locOverview || undefined });
  }
  const altTitles = (Array.isArray(recordOrEmpty(details.alternative_titles).titles)
    ? recordOrEmpty(details.alternative_titles).titles as JsonRecord[]
    : []).map((t) => stringOr(recordOrEmpty(t).title, "")).filter(Boolean);
  const translationTitles = translations
    .map((t) => { const d = recordOrEmpty(recordOrEmpty(t).data); return stringOr(d.title ?? d.name, ""); })
    .filter(Boolean);

  const titleCandidates = uniqueStrings([
    details.title,
    details.name,
    details.original_title,
    details.original_name,
    ...altTitles,
    ...translationTitles,
  ]);

  const releaseDate = stringOr(details.release_date ?? details.first_air_date, "");
  const year = releaseDate.match(/(19|20)\d{2}/)?.[0] ?? null;
  // Display title = the candidate that best matches the PROVIDER title, across
  // every language — so a French catalogue keeps "La Momie", a Spanish one "La
  // momia" (the provider's language is the user's). i18n carries all the other
  // languages for the read path; validation passes if ANY language matches.
  const ranked = titleCandidates
    .map((cand) => ({ cand, score: titleConfidence(candidate.title, cand, candidate.year, year) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const title = best?.cand || stringOr(details.title ?? details.name ?? details.original_title ?? details.original_name, "");
  const confidence = best?.score ?? 0;
  const valid = confidence >= 0.58;
  return {
    valid,
    title: title || null,
    year,
    posterUrl: tmdbImageUrl(details.poster_path),
    backdropUrl: tmdbImageUrl(details.backdrop_path, "w780"),
    confidence,
    i18n: Object.keys(i18n).length ? i18n : undefined,
    reason: valid ? "title_year_sanity_check_passed" : "title_year_sanity_check_failed",
    details: compactRecord({
      id: details.id,
      title,
      overview: details.overview,
      vote_average: details.vote_average,
      runtime: details.runtime,
      number_of_seasons: details.number_of_seasons,
      status: details.status,
      genres: Array.isArray(details.genres) ? details.genres.map((genre) => recordOrEmpty(genre).name).filter(Boolean) : undefined,
      poster_path: details.poster_path,
      backdrop_path: details.backdrop_path,
      release_date: details.release_date,
      first_air_date: details.first_air_date,
      matched: valid,
      confidence,
    }),
  };
}

async function fetchTmdbDetails(apiKey: string, itemType: "movie" | "series", tmdbId: string) {
  const endpoint = itemType === "series" ? "tv" : "movie";
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}/${encodeURIComponent(tmdbId)}`);
  const language = stringOr(Deno.env.get("NORVA_TMDB_LANGUAGE"), "en-US");
  if (language) url.searchParams.set("language", language);
  // One call returns the canonical details plus every localized title/overview
  // (translations) and country title variants — feeding both multi-language
  // validation and the i18n store.
  url.searchParams.set("append_to_response", "alternative_titles,translations");
  const headers: Record<string, string> = {};
  if (apiKey.startsWith("eyJ")) headers.Authorization = `Bearer ${apiKey}`;
  else url.searchParams.set("api_key", apiKey);
  const payload = await fetchJsonWithHeaders(url.toString(), 8000, headers);
  return recordOrEmpty(payload);
}

function titleConfidence(providerTitle: string, tmdbTitle: string, providerYear: string | null, tmdbYear: string | null) {
  const provider = normalizeTitle(providerTitle, providerYear);
  const tmdb = normalizeTitle(tmdbTitle, tmdbYear);
  if (!provider || !tmdb) return 0;
  const titleScore = provider === tmdb
    ? 1
    : provider.includes(tmdb) || tmdb.includes(provider)
      ? 0.82
      : tokenOverlap(provider, tmdb);
  const yearScore = providerYear && tmdbYear
    ? Math.abs(Number(providerYear) - Number(tmdbYear)) <= 1 ? 1 : 0
    : 0.65;
  return Number((titleScore * 0.78 + yearScore * 0.22).toFixed(3));
}

function tokenOverlap(a: string, b: string) {
  const left = new Set(a.split(/\s+/).filter(Boolean));
  const right = new Set(b.split(/\s+/).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.max(left.size, right.size);
}

function uniqueStrings(values: unknown[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = stringOr(value, "");
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    result.push(text);
  }
  return result;
}

function tmdbImageUrl(path: unknown, size = "w500") {
  const value = stringOr(path, "");
  return value ? `https://image.tmdb.org/t/p/${size}${value}` : null;
}

function tmdbValidationKey(itemType: string, tmdbId: string) {
  return `${itemType}:${tmdbId}`;
}

function identityForTitle(itemType: string, title: string, year: string | null, ids: ProviderIds) {
  if (ids.tmdbId) return { key: `tmdb:${ids.tmdbId}`, source: "provider_tmdb" };
  if (ids.imdbId) return { key: `imdb:${ids.imdbId}`, source: "provider_imdb" };
  const slug = normalizeTitle(title, year);
  return { key: `norm:${itemType}:${slug || shaFallback(title)}:${year || ""}`, source: "normalized" };
}

function normalizeTitle(value: string, year: string | null = null) {
  let text = stripDiacritics(value)
    .toLowerCase()
    .replace(/[\[({][^\])}]*[\])}]/g, " ")
    .replace(/\b(4k|uhd|2160p|1080p|720p|fhd|hd|sd|multi|vostfr|vost|vf|vff|truefrench|subt?\s*ar|sub|dub)\b/gi, " ");
  if (year) text = text.replace(new RegExp(`(^|\\s)${year}(?=\\s|$)`, "g"), " ");
  return text
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDisplayTitle(value: string) {
  return String(value || "Norva")
    .replace(/\s+\b(4K|UHD|2160p|1080p|720p|FHD|HD|SD|MULTI|VOSTFR|VOST|VF|SUBT AR|SUB AR)\b\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(title: string, explicit: unknown): string | null {
  const maxYear = new Date().getFullYear() + 1;
  const plausible = (value: string | null | undefined): string | null => {
    const n = value ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(n) && n >= 1900 && n <= maxYear ? String(n) : null;
  };
  const fromExplicit = plausible(String(explicit ?? "").match(/(19|20)\d{2}/)?.[0]);
  if (fromExplicit) return fromExplicit;
  const fromBracket = plausible(String(title || "").match(/[\[(]\s*((19|20)\d{2})\s*[\])]/)?.[1]);
  if (fromBracket) return fromBracket;
  // A trailing bare number is often part of the title ("Demon Lord 2099") — only
  // accept it as a release year when it's plausible (not in the future).
  return plausible(String(title || "").trim().match(/(?:^|\s)((19|20)\d{2})$/)?.[1]);
}

function parseVersionInfo(title: string, metadata: JsonRecord) {
  const raw = String(title || "");
  const normalized = stripDiacritics(raw).toUpperCase();
  const language = normalized.match(/\b(VOSTFR|TRUEFRENCH|MULTI|VFQ|VFF|VF|VO|SUBT?\s*AR)\b/)?.[1]?.replace(/\s+/g, "_") || null;
  const resolution = normalized.match(/\b(2160P|1080P|720P|480P)\b/)?.[1] || null;
  const quality = normalized.includes("4K") || normalized.includes("UHD") || resolution === "2160P"
    ? "4K"
    : normalized.includes("FHD") || resolution === "1080P"
      ? "FHD"
      : normalized.includes("HD") || resolution === "720P"
        ? "HD"
        : stringOrNull(metadata.quality);
  return { language, quality, resolution };
}

function compatibilitySeed(playbackHint: JsonRecord, metadata: JsonRecord, title: string) {
  const profile = recordOrEmpty(metadata.codecProfile ?? metadata.codec_profile);
  const video = String(profile.videoCodec ?? profile.video_codec ?? "").toLowerCase();
  const audio = String(profile.audioCodec ?? profile.audio_codec ?? "").toLowerCase();
  if (video && !["h264", "avc1"].includes(video)) return { tier: "video_transcode" };
  if (audio && !["aac", "mp3"].includes(audio)) return { tier: "audio_transcode" };
  if (video === "h264" && (audio === "aac" || audio === "mp3")) return { tier: "direct" };
  const container = String(playbackHint.container ?? metadata.container ?? "").toLowerCase();
  if (container === "mp4" && !/\b(4k|uhd|hevc|h265|x265)\b/i.test(title)) return { tier: "direct" };
  if (/\b(4k|uhd|hevc|h265|x265)\b/i.test(title)) return { tier: "video_transcode" };
  if (container === "mkv") return { tier: "remux" };
  return { tier: "unknown" };
}

function playbackCostScore(tier: string, observedTtff: number | null) {
  if (observedTtff !== null) return Math.max(1, Math.min(999, Math.round(observedTtff / 10)));
  if (tier === "direct") return 100;
  if (tier === "remux") return 250;
  if (tier === "audio_transcode") return 380;
  if (tier === "video_transcode") return 650;
  return 500;
}

function observedTtffMs(...records: JsonRecord[]) {
  for (const record of records) {
    const value = record.lastObservedTtffMs ?? record.last_observed_ttff_ms ?? record.ttffMs ?? record.time_to_first_frame_ms;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.round(number);
  }
  return null;
}

function variantLabel(version: { language: string | null; quality: string | null; resolution: string | null }) {
  return [version.quality, version.language].filter(Boolean).join(" ") || version.resolution || "Default";
}

async function fetchJson(url: string, timeoutMs: number) {
  return fetchJsonWithHeaders(url, timeoutMs, { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20" });
}

async function fetchJsonWithHeaders(url: string, timeoutMs: number, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Provider metadata refused ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function xtreamApiUrl(config: XtreamConfig, action: string, extra: Record<string, string>) {
  const url = new URL(`${trimTrailingSlash(config.serverUrl)}/player_api.php`);
  url.searchParams.set("username", config.username);
  url.searchParams.set("password", config.password);
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}

function compactRecord(record: JsonRecord) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringOr(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function stringOrNull(value: unknown) {
  const string = stringOr(value, "");
  return string || null;
}

function cleanId(value: unknown) {
  const string = stringOr(value, "");
  if (!string) return null;
  const match = string.match(/tt\d+|\d+/i);
  if (!match) return null;
  // "0" / "00" / "tt0"… is the provider "no match" sentinel, never a real id —
  // treating it as an id would collapse every unmatched title into one.
  if (/^(tt)?0+$/i.test(match[0])) return null;
  return match[0];
}

function stripDiacritics(value: string) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function shaFallback(value: string) {
  // Deterministic, cheap fallback only for pathological titles.
  let hash = 2166136261;
  const bytes = encoder.encode(value);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function boundedInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
