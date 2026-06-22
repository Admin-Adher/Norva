// Curated, mass-market genre taxonomy for Norva.
//
// IPTV providers expose messy, language-prefixed "categories" (e.g.
// "AR: MOVIES Dubbed أفلام مدبلجة", "Séries ANIMÉES POUR ADULTES",
// "Séries APPLE TV+"). This module maps a title — using the real TMDB
// genres we already enrich PLUS the provider category wording — onto a
// small, friendly set of genre buckets used for Netflix-style browsing.
//
// IMPORTANT: this file is mirrored, almost line for line, by the browser
// module public/js/utils/GenreTaxonomy.js. Keep the two IN SYNC.

export interface GenreBucket {
  id: string;
  label: string; // French, mass-market
}

// Display order for rails / pickers. "autres" is the safety net and is
// intentionally last so nothing ever disappears.
export const GENRE_BUCKETS: GenreBucket[] = [
  { id: "action", label: "Action" },
  { id: "aventure", label: "Aventure" },
  { id: "comedie", label: "Comédie" },
  { id: "drame", label: "Drame" },
  { id: "scifi", label: "Science-fiction & Fantastique" },
  { id: "horreur", label: "Horreur" },
  { id: "thriller", label: "Thriller & Policier" },
  { id: "romance", label: "Romance" },
  { id: "familial", label: "Familial" },
  { id: "animation_kids", label: "Dessins animés (enfants)" },
  { id: "animation_adult", label: "Animation (adultes)" },
  { id: "kdrama", label: "K-Drama" },
  { id: "telerealite", label: "Téléréalité" },
  { id: "documentaires", label: "Documentaires" },
  { id: "arabe", label: "Films & séries arabes" },
  { id: "autres", label: "Autres" },
];

export const BUCKET_ORDER: string[] = GENRE_BUCKETS.map((b) => b.id);
const BUCKET_LABEL = new Map(GENRE_BUCKETS.map((b) => [b.id, b.label] as const));
export function bucketLabel(id: string): string {
  return BUCKET_LABEL.get(id) ?? "Autres";
}

// Normalise latin text (strip accents/case/punctuation) while preserving
// Arabic letters so Arabic keywords still match. Mirrors normalizeGenre() in
// norva-catalog/index.ts but keeps the Arabic block.
function norm(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

// TMDB genre name (normalised, EN + FR) -> bucket id.
const TMDB_GENRE_TO_BUCKET: Record<string, string> = {
  "action": "action",
  "action adventure": "action",
  "war": "action",
  "war politics": "action",
  "western": "action",
  "guerre": "action",
  "adventure": "aventure",
  "aventure": "aventure",
  "comedy": "comedie",
  "comedie": "comedie",
  "drama": "drame",
  "drame": "drame",
  "history": "drame",
  "histoire": "drame",
  "soap": "drame",
  "science fiction": "scifi",
  "sci fi fantasy": "scifi",
  "fantasy": "scifi",
  "fantastique": "scifi",
  "horror": "horreur",
  "horreur": "horreur",
  "thriller": "thriller",
  "crime": "thriller",
  "mystery": "thriller",
  "mystere": "thriller",
  "romance": "romance",
  "family": "familial",
  "familial": "familial",
  "kids": "familial",
  "music": "familial",
  "musique": "familial",
  "tv movie": "familial",
  "telefilm": "familial",
  "animation": "animation_kids",
  "reality": "telerealite",
  "documentary": "documentaires",
  "documentaire": "documentaires",
};

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

const ADULT_MARKERS = ["adulte", "adult", "mature", "18", "ecchi", "hentai", "seinen", "بالغين"];
const ANIM_MARKERS = ["animation", "anime", "anim", "dessin", "cartoon", "manga", "رسوم", "انمي", "كرتون"];
const KIDS_MARKERS = ["enfant", "kids", "kid", "jeunesse", "junior", "disney", "pixar", "اطفال", "طفال"];
const KDRAMA_MARKERS = ["k drama", "kdrama", "korean", "coreen", "coreenne", "coree", "كوري"];
const REALITY_MARKERS = ["reality", "tele realite", "telerealite", "emission", "real tv", "الواقع"];
const ARABIC_MARKERS = ["arabe", "arabic", "arab", "algerien", "egyptien", "syrien", "libanais", "khaliji", "ramadan"];

function isArabicCategory(catN: string): boolean {
  if (hasAny(catN, ARABIC_MARKERS)) return true;
  // "AR:" / "AR " prefix becomes "ar " after normalisation.
  if (/^ar(\s|$)/.test(catN)) return true;
  // Any Arabic-script letters → an Arabic-language grouping.
  if (/[\u0600-\u06ff]/.test(catN)) return true;
  return false;
}
const isAnimation = (catN: string) => hasAny(catN, ANIM_MARKERS);
const isAdult = (catN: string) => hasAny(catN, ADULT_MARKERS);
const isKids = (catN: string) => hasAny(catN, KIDS_MARKERS);
const isKDrama = (catN: string) => hasAny(catN, KDRAMA_MARKERS);
const isReality = (catN: string) => hasAny(catN, REALITY_MARKERS);

// Genre keywords inside the provider category name -> bucket. Ordered: first
// match wins for single-bucket classification.
const CATEGORY_GENRE_KEYWORDS: Array<[string[], string]> = [
  [["horreur", "horror", "epouvante"], "horreur"],
  [["thriller", "policier", "polar", "suspense", "crime"], "thriller"],
  [["science fiction", "sci fi", "scifi", "fantastique", "fantasy"], "scifi"],
  [["romance", "romantique"], "romance"],
  [["documentaire", "documentary", "docu"], "documentaires"],
  [["comedie", "comedy", "humour"], "comedie"],
  [["aventure", "adventure"], "aventure"],
  [["action", "guerre"], "action"],
  [["drame", "drama"], "drame"],
  [["familial", "family", "famille"], "familial"],
];

function categoryGenreKeyword(catN: string): string | null {
  for (const [needles, bucket] of CATEGORY_GENRE_KEYWORDS) {
    if (hasAny(catN, needles)) return bucket;
  }
  return null;
}

function coerceGenres(tmdbGenres: unknown): string[] {
  if (!Array.isArray(tmdbGenres)) return [];
  return tmdbGenres
    .map((g) =>
      typeof g === "string"
        ? g
        : (g && typeof g === "object" ? String((g as Record<string, unknown>).name ?? "") : "")
    )
    .filter(Boolean);
}

/**
 * Every bucket a title belongs to (MULTI — a title can appear in several
 * rails, like Netflix). Uses TMDB genres first, then enriches with
 * category-derived buckets that TMDB cannot express (kids vs adult animation,
 * K-Drama, Arabic, reality). Returns ids in display order. Never empty:
 * unclassifiable titles return ["autres"].
 */
export function classifyTitleBuckets(categoryName: unknown, tmdbGenres: unknown): string[] {
  const buckets = new Set<string>();
  const catN = norm(categoryName);

  for (const g of coerceGenres(tmdbGenres)) {
    const b = TMDB_GENRE_TO_BUCKET[norm(g)];
    if (b) buckets.add(b);
  }

  // Animation refinement: TMDB "Animation" defaults to kids; if the provider
  // wording says it's for adults, move it to the adult bucket.
  if (buckets.has("animation_kids") && isAdult(catN)) {
    buckets.delete("animation_kids");
    buckets.add("animation_adult");
  }

  // Category-derived buckets (added on top — multi-membership).
  if (isAnimation(catN)) buckets.add(isAdult(catN) && !isKids(catN) ? "animation_adult" : "animation_kids");
  if (isKDrama(catN)) buckets.add("kdrama");
  if (isReality(catN)) buckets.add("telerealite");
  if (isArabicCategory(catN)) buckets.add("arabe");
  const kw = categoryGenreKeyword(catN);
  if (kw) buckets.add(kw);

  if (buckets.size === 0) buckets.add("autres");
  return BUCKET_ORDER.filter((id) => buckets.has(id));
}

/**
 * A SINGLE bucket for a provider CATEGORY (used by Manage Content, where we
 * hide/show whole provider categories and have only the name to go on).
 * Prefers a real genre over a language grouping, per product intent (an
 * Arabic action section lands in Action, not just "Arabe").
 */
export function classifyCategoryBucket(categoryName: unknown): string {
  const catN = norm(categoryName);
  if (isAnimation(catN)) return isAdult(catN) && !isKids(catN) ? "animation_adult" : "animation_kids";
  if (isKDrama(catN)) return "kdrama";
  if (isReality(catN)) return "telerealite";
  const kw = categoryGenreKeyword(catN);
  if (kw) return kw;
  if (isArabicCategory(catN)) return "arabe";
  return "autres";
}
