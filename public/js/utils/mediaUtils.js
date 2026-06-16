/**
 * Media utilities — title normalization, duplicate grouping, version
 * ranking and filter persistence shared by MoviesPage and SeriesPage.
 *
 * NOTE: normalization rules mirror server/services/mediaNormalizer.js —
 * keep both in sync when changing them.
 */

const MediaUtils = (() => {
    const LANG_TAGS = [
        'vostfr', 'vost', 'multi', 'truefrench', 'vff', 'vfq', 'vf', 'vo',
        'fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'ar', 'tr', 'pl', 'ru', 'sub', 'dub'
    ];

    const QUALITY_PATTERNS = [
        { re: /\b(4k|uhd|2160p?)\b/i, label: '4K', score: 5 },
        { re: /\b1440p?\b/i, label: '1440p', score: 4 },
        { re: /\b(fhd|1080p?)\b/i, label: '1080p', score: 3 },
        { re: /\b(hd|720p?)\b/i, label: '720p', score: 2 },
        { re: /\b(sd|480p?|360p?)\b/i, label: 'SD', score: 1 }
    ];

    const NOISE_WORDS = new Set([
        '4k', 'uhd', '2160p', '2160', '1440p', 'fhd', '1080p', '1080', 'hd', '720p', '720',
        'sd', '480p', '360p', 'hdr', 'hdr10', 'dolby', 'vision', 'hevc', 'h264', 'h265', 'x264', 'x265',
        'bluray', 'blu-ray', 'brrip', 'bdrip', 'webrip', 'web-dl', 'webdl', 'dvdrip', 'hdrip', 'cam', 'ts',
        ...LANG_TAGS
    ]);

    function stripDiacritics(str) {
        return String(str).normalize('NFD').replace(/[̀-ͯ]/g, '');
    }

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

    function normalizeTitle(name, knownYear = null) {
        if (!name) return '';
        let s = stripDiacritics(name).toLowerCase();
        s = s.replace(/[[{(][^\])}]*[\])}]/g, ' ');
        let changed = true;
        while (changed) {
            changed = false;
            const m = s.match(/^\s*([a-z0-9+]{1,10})\s*[-|:•»>]+\s*/);
            if (m && NOISE_WORDS.has(m[1])) {
                s = s.slice(m[0].length);
                changed = true;
            }
        }
        // Trailing year stripped only when it matches the actual release year
        s = s.replace(/(?:^|\s)((19|20)\d{2})\s*$/, (full, yTok) =>
            (!knownYear || yTok === String(knownYear)) ? ' ' : full);
        const tokens = s.split(/[^a-z0-9]+/).filter(t => t && !NOISE_WORDS.has(t));
        return tokens.join(' ').trim();
    }

    function computeDedupKey(name, year) {
        const y = extractYear(name, year);
        const slug = normalizeTitle(name, y);
        if (!slug) return null;
        return `${slug}|${y || ''}`;
    }

    function parseVersionInfo(name) {
        const raw = String(name || '');
        let quality = null, qualityScore = 0;
        for (const q of QUALITY_PATTERNS) {
            if (q.re.test(raw)) { quality = q.label; qualityScore = q.score; break; }
        }
        let language = null;
        const lower = stripDiacritics(raw).toLowerCase();
        const ordered = [...LANG_TAGS].sort((a, b) => b.length - a.length);
        for (const tag of ordered) {
            const re = new RegExp(`(^|[^a-z])${tag}([^a-z]|$)`, 'i');
            if (re.test(lower)) { language = tag.toUpperCase(); break; }
        }
        return { quality, qualityScore, language };
    }

    /**
     * Normalized search string (for accent/prefix-insensitive matching)
     */
    function searchableText(name) {
        return stripDiacritics(String(name || '')).toLowerCase();
    }

    /**
     * Group a list of items into deduplicated groups.
     * Grouping key priority: tmdb_id > dedup_key (server) > client-side key.
     * Each group: { key, items: [...], representative }
     */
    function groupItems(items, { idField = 'stream_id' } = {}) {
        const groups = new Map();

        for (const item of items) {
            let key;
            if (item.tmdb_id) {
                key = `t:${item.tmdb_id}`;
            } else {
                key = `k:${item.dedup_key || computeDedupKey(item.name, item.year) || `${item.sourceId}:${item[idField]}`}`;
            }
            let group = groups.get(key);
            if (!group) {
                group = { key, items: [] };
                groups.set(key, group);
            }
            group.items.push(item);
        }

        const result = [...groups.values()];
        for (const group of result) {
            group.representative = pickRepresentative(group.items);
        }
        return result;
    }

    /**
     * Pick the "best" item of a duplicate group for display:
     * prefer one with a poster, then highest quality, then highest rating.
     */
    function pickRepresentative(items) {
        if (items.length === 1) return items[0];
        const scored = items.map(item => {
            const v = parseVersionInfo(item.name);
            let score = 0;
            if (item.stream_icon || item.cover) score += 100;
            score += v.qualityScore * 10;
            score += parseFloat(item.rating) || 0;
            return { item, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored[0].item;
    }

    /**
     * Order group versions by user preference (language > quality > source order).
     * prefs: { preferredLanguage: 'vf'|'vostfr'|''..., preferredQuality: 'highest'|'4k'|'1080p'|'720p'|'lowest' }
     */
    function orderVersionsByPreference(items, prefs = {}) {
        const prefLang = (prefs.preferredLanguage || '').toUpperCase();
        const prefQuality = prefs.preferredQuality || 'highest';

        const qualityTarget = { '4k': 5, '1080p': 3, '720p': 2 }[prefQuality] || null;

        return [...items].map(item => {
            const v = parseVersionInfo(item.name);
            let score = 0;
            if (prefLang && v.language === prefLang) score += 1000;
            if (qualityTarget !== null) {
                // Closest to target wins; above target slightly preferred over below
                score += 100 - Math.abs(v.qualityScore - qualityTarget) * 20 + (v.qualityScore >= qualityTarget ? 5 : 0);
            } else if (prefQuality === 'lowest') {
                score += 100 - v.qualityScore * 10;
            } else {
                score += v.qualityScore * 10; // highest
            }
            if (item.stream_icon || item.cover) score += 1;
            return { item, score, version: v };
        }).sort((a, b) => b.score - a.score).map(s => s.item);
    }

    /**
     * Human-readable label for a version inside the picker:
     * "Source 2 · 4K · VF · mkv"
     */
    function versionLabel(item, sourceName) {
        const v = parseVersionInfo(item.name);
        const parts = [];
        if (sourceName) parts.push(sourceName);
        if (v.quality) parts.push(v.quality);
        if (v.language) parts.push(v.language);
        if (item.container_extension) parts.push(item.container_extension);
        return parts.join(' - ') || 'Version';
    }

    // === Filter persistence ===

    function saveFilters(pageKey, filters) {
        try {
            localStorage.setItem(`norva-filters-${pageKey}`, JSON.stringify(filters));
        } catch (e) { /* storage full/unavailable */ }
    }

    function loadFilters(pageKey) {
        try {
            const raw = localStorage.getItem(`norva-filters-${pageKey}`);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    // === Misc helpers ===

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * Parse "01:32:05", "42:10" or plain seconds into seconds (or null)
     */
    function parseDurationToSeconds(value) {
        if (value === null || value === undefined || value === '') return null;
        const str = String(value).trim();
        if (/^\d+(\.\d+)?$/.test(str)) {
            const n = parseFloat(str);
            return n > 0 ? n : null;
        }
        const parts = str.split(':').map(p => parseInt(p, 10));
        if (parts.some(isNaN)) return null;
        let seconds = 0;
        for (const part of parts) seconds = seconds * 60 + part;
        return seconds > 0 ? seconds : null;
    }

    function tmdbPosterUrl(tmdb, size = 'w342') {
        if (!tmdb || !tmdb.poster_path) return null;
        return `https://image.tmdb.org/t/p/${size}${tmdb.poster_path}`;
    }

    function playbackHintFromItem(item = {}, base = {}) {
        const variant = item.defaultVariant || item.default_variant || item.variant || {};
        const data = item.data || {};
        const rawType = firstValue(base.streamType, base.itemType, item.streamType, item.stream_type, item.itemType, item.item_type, item.type);
        const streamType = rawType === 'episode' ? 'series' : rawType;
        const codec = firstRecord(
            item.codecProfile,
            item.codec_profile,
            variant.codecProfile,
            variant.codec_profile,
            data.codecProfile,
            data.codec_profile,
            item.playbackHint?.codecProfile,
            item.playback_hint?.codec_profile
        );
        const hint = compactRecord({
            ...base,
            streamType,
            itemType: streamType,
            container: base.container || item.container_extension || item.containerExtension || data.containerExtension || variant.container_extension || variant.containerExtension,
            audioCodec: firstValue(item.audioCodec, item.audio_codec, codec.audioCodec, codec.audio_codec, codec.audio),
            audioProfile: firstValue(item.audioProfile, item.audio_profile, codec.audioProfile, codec.audio_profile),
            audioChannels: firstValue(item.audioChannels, item.audio_channels, codec.audioChannels, codec.audio_channels, codec.channels),
            audioMode: firstValue(item.audioMode, item.audio_mode, codec.audioMode, codec.audio_mode),
            videoCodec: firstValue(item.videoCodec, item.video_codec, codec.videoCodec, codec.video_codec, codec.video)
        });

        if (isSafeBrowserAudio(hint.audioCodec, hint.audioProfile, hint.audioChannels)) {
            hint.clientAudioPassthrough = true;
        }
        return hint;
    }

    function firstRecord(...values) {
        return values.find(value => value && typeof value === 'object' && !Array.isArray(value)) || {};
    }

    function firstValue(...values) {
        return values.find(value => value !== undefined && value !== null && value !== '') ?? '';
    }

    function compactRecord(record) {
        return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    }

    function normalizeCodecToken(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
    }

    function isSafeBrowserAudio(codecValue, profileValue, channelsValue) {
        const codec = normalizeCodecToken(codecValue);
        const profile = normalizeCodecToken(profileValue);
        const channels = parseInt(String(channelsValue || ''), 10);
        const combined = `${codec} ${profile}`;
        if (!codec) return false;
        if (Number.isFinite(channels) && channels > 2) return false;
        if (
            combined.includes('heaac') ||
            combined.includes('aache') ||
            combined.includes('sbr') ||
            combined.includes('mp4a.40.5') ||
            combined.includes('mp4a.40.29') ||
            codec.includes('eac3') ||
            codec.includes('e-ac3') ||
            codec.includes('ac3') ||
            codec.includes('dts') ||
            codec.includes('truehd') ||
            codec.includes('flac') ||
            codec.includes('pcm')
        ) return false;
        return codec.includes('aac') || codec.includes('mp4a.40.2') || codec.includes('mp3') || codec.includes('opus') || codec.includes('vorbis');
    }

    return {
        stripDiacritics, extractYear, normalizeTitle, computeDedupKey,
        parseVersionInfo, searchableText, groupItems, pickRepresentative,
        orderVersionsByPreference, versionLabel,
        saveFilters, loadFilters, escapeHtml, tmdbPosterUrl, parseDurationToSeconds,
        playbackHintFromItem
    };
})();

window.MediaUtils = MediaUtils;
