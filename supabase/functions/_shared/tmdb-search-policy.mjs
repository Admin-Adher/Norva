// Provider catalogues frequently prefix titles with a market/language token.
// Keep this policy pure so the Edge matcher and Node contract tests exercise the
// exact same cleanup and locale ordering.

const BOX_BAR_PREFIX = /^([A-Z0-9+_-]{2,12})\s+[▎▏▍▌│┃┆┊｜|]\s+/;
const DASH_PREFIX = /^((?:[A-Z]{2}|4K|8K|3D|2160P|1440P|1080P|720P|480P|360P|007)(?:-[A-Z0-9+]{1,6})*)(?: [-–—] | -[A-Z0-9+]{1,6}- )/;

// These are provider market labels, not always ISO language codes. Map only
// labels for which the catalogue convention is known; unknown 2-letter labels
// still make a useful TMDB language hint and always retain configured/en-US
// fallbacks.
const PREFIX_LOCALES = Object.freeze({
  EN: "en-US",
  FR: "fr-FR",
  FRQ: "fr-CA",
  ES: "es-ES",
  DE: "de-DE",
  TR: "tr-TR",
  NL: "nl-NL",
  AR: "ar-SA",
  PL: "pl-PL",
  IT: "it-IT",
  RU: "ru-RU",
  PT: "pt-PT",
  DK: "da-DK",
  SE: "sv-SE",
  SW: "sv-SE",
  GR: "el-GR",
  IR: "fa-IR",
  IN: "hi-IN",
  PK: "ur-PK",
  TA: "ta-IN",
  ML: "ml-IN",
  TL: "tl-PH",
  PJ: "pa-IN",
  ALB: "sq-AL",
  EXYU: "sr-RS",
  SRB: "sr-RS",
  SCAN: "en-US",
  MULTI: "en-US",
  SO: "so-SO",
});

export const TMDB_SEARCH_POLICY_VERSION = "promax-multilang-v2";

export function providerTitlePrefix(value) {
  const raw = String(value || "");
  const box = raw.match(BOX_BAR_PREFIX);
  if (box) return box[1].toUpperCase();
  const dash = raw.match(DASH_PREFIX);
  if (!dash) return null;
  const parts = dash[1].toUpperCase().split("-").filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (PREFIX_LOCALES[parts[index]] || /^[A-Z]{2}$/.test(parts[index])) return parts[index];
  }
  return parts[0] || null;
}

export function stripProviderSearchPrefix(value) {
  const raw = String(value || "");
  const withoutBox = raw.replace(BOX_BAR_PREFIX, "");
  return withoutBox === raw ? raw.replace(DASH_PREFIX, "") : withoutBox;
}

export function cleanTmdbSearchQuery(value) {
  return stripProviderSearchPrefix(value)
    .replace(/[\[({][^\])}]*[\])}]/g, " ")
    .replace(/\b(4k|uhd|2160p|1080p|720p|480p|fhd|hd|sd|multi|vostfr|vost|vff|vf|vo|truefrench|subt?\s*ar|sub|dub|dv)\b/gi, " ")
    .replace(/(?:^|\s)((?:19|20)\d{2})\s*$/, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tmdbSearchLocalesForTitle(value, configuredLanguage = "fr-FR") {
  const prefix = providerTitlePrefix(value);
  const inferred = prefix
    ? PREFIX_LOCALES[prefix] ?? (/^[A-Z]{2}$/.test(prefix) ? prefix.toLowerCase() : null)
    : null;
  const ordered = [inferred, configuredLanguage, "en-US"];
  const seen = new Set();
  return ordered.filter((locale) => {
    const normalized = String(locale || "").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
