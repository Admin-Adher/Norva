/**
 * Media title normalizer
 * Computes stable dedup keys from messy IPTV titles and extracts
 * version metadata (quality, language) embedded in the names.
 *
 * NOTE: public/js/utils/mediaUtils.js contains a browser copy of this
 * logic — keep both in sync when changing normalization rules.
 */

// Language tags commonly embedded in IPTV titles
const LANG_TAGS = [
    'vostfr', 'vost', 'multi', 'truefrench', 'vff', 'vfq', 'vf', 'vo',
    'fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'ar', 'tr', 'pl', 'ru', 'sub', 'dub'
];

// Quality tags (order matters: first match wins, highest first)
const QUALITY_PATTERNS = [
    { re: /\b(4k|uhd|2160p?)\b/i, label: '4K', score: 5 },
    { re: /\b1440p?\b/i, label: '1440p', score: 4 },
    { re: /\b(fhd|1080p?)\b/i, label: '1080p', score: 3 },
    { re: /\b(hd|720p?)\b/i, label: '720p', score: 2 },
    { re: /\b(sd|480p?|360p?)\b/i, label: 'SD', score: 1 }
];

const NOISE_WORDS = [
    '4k', 'uhd', '2160p', '2160', '1440p', 'fhd', '1080p', '1080', 'hd', '720p', '720',
    'sd', '480p', '360p', 'hdr', 'hdr10', 'dolby', 'vision', 'hevc', 'h264', 'h265', 'x264', 'x265',
    'bluray', 'blu-ray', 'brrip', 'bdrip', 'webrip', 'web-dl', 'webdl', 'dvdrip', 'hdrip', 'cam', 'ts',
    ...LANG_TAGS
];

const NOISE_WORD_SET = new Set(NOISE_WORDS);

/**
 * Strip diacritics (é -> e, ñ -> n ...)
 */
function stripDiacritics(str) {
    return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Extract a release year from explicit field or from the title itself.
 * Only trusts years in parentheses/brackets or as the final token,
 * so "Blade Runner 2049" keeps its title intact.
 */
function extractYear(name, year) {
    if (year) {
        const m = String(year).match(/(19|20)\d{2}/);
        if (m) return m[0];
    }
    if (!name) return null;
    let m = name.match(/[([]\s*((19|20)\d{2})\s*[)\]]/);
    if (m) return m[1];
    m = name.trim().match(/(?:^|\s)((19|20)\d{2})$/);
    if (m) return m[1];
    return null;
}

/**
 * Normalize a title to a comparable slug:
 * - strips accents, case, punctuation
 * - removes bracketed tags, leading "FR -" style prefixes
 * - removes quality/language noise words and years
 */
function normalizeTitle(name, knownYear = null) {
    if (!name) return '';
    let s = stripDiacritics(String(name)).toLowerCase();

    // Remove bracketed segments entirely: [4K], {MULTI}, (VOSTFR), (2019)...
    s = s.replace(/[[{(][^\])}]*[\])}]/g, ' ');

    // Strip leading provider/lang/quality prefixes like "FR - ", "4K| ", "VF: "
    let changed = true;
    while (changed) {
        changed = false;
        const m = s.match(/^\s*([a-z0-9+]{1,10})\s*[-|:•»>]+\s*/);
        if (m && NOISE_WORD_SET.has(m[1])) {
            s = s.slice(m[0].length);
            changed = true;
        }
    }

    // Drop trailing standalone year — but only when it actually is the release
    // year, so titles like "Blade Runner 2049" (year 2017) stay intact
    s = s.replace(/(?:^|\s)((19|20)\d{2})\s*$/, (full, yTok) =>
        (!knownYear || yTok === String(knownYear)) ? ' ' : full);

    // Tokenize on non-alphanumerics, drop noise words
    const tokens = s.split(/[^a-z0-9]+/).filter(t => t && !NOISE_WORD_SET.has(t));
    return tokens.join(' ').trim();
}

/**
 * Stable dedup key for a movie/series item.
 */
function computeDedupKey(name, year) {
    const y = extractYear(name, year);
    const slug = normalizeTitle(name, y);
    if (!slug) return null;
    return `${slug}|${y || ''}`;
}

/**
 * Extract version metadata (quality + language) from a raw title.
 */
function parseVersionInfo(name) {
    const raw = String(name || '');
    let quality = null, qualityScore = 0;
    for (const q of QUALITY_PATTERNS) {
        if (q.re.test(raw)) { quality = q.label; qualityScore = q.score; break; }
    }
    let language = null;
    const lower = stripDiacritics(raw).toLowerCase();
    // Longest tags first so "vostfr" beats "vf"/"fr"
    const ordered = [...LANG_TAGS].sort((a, b) => b.length - a.length);
    for (const tag of ordered) {
        const re = new RegExp(`(^|[^a-z])${tag}([^a-z]|$)`, 'i');
        if (re.test(lower)) { language = tag.toUpperCase(); break; }
    }
    return { quality, qualityScore, language };
}

module.exports = { normalizeTitle, computeDedupKey, extractYear, parseVersionInfo, stripDiacritics };
