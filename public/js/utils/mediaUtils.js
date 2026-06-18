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

    const LANGUAGE_LABELS = {
        fr: 'FR',
        en: 'EN',
        es: 'ES',
        original: 'VO'
    };

    const LANGUAGE_ALIASES = {
        french: 'fr',
        francais: 'fr',
        francaise: 'fr',
        fra: 'fr',
        fre: 'fr',
        truefrench: 'fr',
        vff: 'fr',
        vfq: 'fr',
        vf: 'fr',
        english: 'en',
        anglais: 'en',
        eng: 'en',
        en: 'en',
        spanish: 'es',
        espagnol: 'es',
        spa: 'es',
        es: 'es',
        vo: 'original',
        vost: 'original',
        vostfr: 'original',
        original: 'original'
    };

    const TITLE_AUDIO_SIGNALS = [
        { tag: 'TRUEFRENCH', re: /\btrue[\s._-]*french\b/i, language: 'fr' },
        { tag: 'VFF', re: /\bvff\b/i, language: 'fr' },
        { tag: 'VFQ', re: /\bvfq\b/i, language: 'fr' },
        { tag: 'VF', re: /\bvf\b/i, language: 'fr' },
        { tag: 'FR', re: /(^|[^a-z])fr([^a-z]|$)/i, language: 'fr' },
        { tag: 'VOSTFR', re: /\bvost[\s._-]*fr\b/i, language: 'original' },
        { tag: 'VO', re: /\bvo\b/i, language: 'original' },
        { tag: 'EN', re: /(^|[^a-z])en([^a-z]|$)|\beng(lish)?\b/i, language: 'en' },
        { tag: 'ES', re: /(^|[^a-z])es([^a-z]|$)|\bspa(nish)?\b/i, language: 'es' }
    ];

    const TITLE_SUBTITLE_SIGNALS = [
        { tag: 'VOSTFR', re: /\bvost[\s._-]*fr\b/i, language: 'fr' },
        { tag: 'SUBFR', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*fr\b/i, language: 'fr' },
        { tag: 'FRSUB', re: /\bfr[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'fr' },
        { tag: 'SUBEN', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(en|eng|english)\b/i, language: 'en' },
        { tag: 'SUBES', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(es|spa|spanish)\b/i, language: 'es' }
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
        const signals = parseTitleLanguageSignals(raw);
        let language = signals.primaryTag;
        const lower = stripDiacritics(raw).toLowerCase();
        const ordered = [...LANG_TAGS].sort((a, b) => b.length - a.length);
        if (!language) {
            for (const tag of ordered) {
                const re = new RegExp(`(^|[^a-z])${tag}([^a-z]|$)`, 'i');
                if (re.test(lower)) { language = tag.toUpperCase(); break; }
            }
        }
        return {
            quality,
            qualityScore,
            language,
            audioSignals: signals.audio,
            subtitleSignals: signals.subtitles,
            hasMulti: signals.hasMulti,
            languageSummary: signals.summary
        };
    }

    function normalizeLanguagePreference(value, kind = 'audio') {
        const raw = stripDiacritics(String(value || '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (!raw || raw === 'nopreference' || raw === 'any') return '';
        if (kind === 'subtitle' && ['none', 'off', 'nosubtitles', 'disabled'].includes(raw)) return 'none';
        return LANGUAGE_ALIASES[raw] || raw;
    }

    function migrateLegacyLanguagePreference(value) {
        const legacy = normalizeLanguagePreference(value);
        if (!legacy) return { preferredAudioLanguage: '', preferredSubtitleLanguage: '' };
        const raw = stripDiacritics(String(value || '')).toLowerCase();
        if (raw.includes('vostfr')) {
            return { preferredAudioLanguage: 'original', preferredSubtitleLanguage: 'fr' };
        }
        if (raw.includes('vo') || legacy === 'original') {
            return { preferredAudioLanguage: 'original', preferredSubtitleLanguage: '' };
        }
        if (raw.includes('multi')) {
            return { preferredAudioLanguage: '', preferredSubtitleLanguage: '' };
        }
        return { preferredAudioLanguage: legacy, preferredSubtitleLanguage: '' };
    }

    function normalizeContentPreferences(prefs = {}) {
        const legacy = migrateLegacyLanguagePreference(prefs.preferredLanguage || '');
        return {
            ...prefs,
            preferredAudioLanguage: normalizeLanguagePreference(
                prefs.preferredAudioLanguage || legacy.preferredAudioLanguage || '',
                'audio'
            ),
            preferredSubtitleLanguage: normalizeLanguagePreference(
                prefs.preferredSubtitleLanguage || legacy.preferredSubtitleLanguage || '',
                'subtitle'
            ),
            strictLanguageMatching: Boolean(prefs.strictLanguageMatching)
        };
    }

    function parseTitleLanguageSignals(name) {
        const raw = stripDiacritics(String(name || '')).toLowerCase();
        const audio = [];
        const subtitles = [];
        const pushUnique = (list, entry) => {
            if (!list.some(item => item.language === entry.language && item.tag === entry.tag)) list.push(entry);
        };
        TITLE_AUDIO_SIGNALS.forEach(signal => {
            if (signal.re.test(raw)) pushUnique(audio, { language: signal.language, tag: signal.tag, confidence: 'probable' });
        });
        TITLE_SUBTITLE_SIGNALS.forEach(signal => {
            if (signal.re.test(raw)) pushUnique(subtitles, { language: signal.language, tag: signal.tag, confidence: 'probable' });
        });
        const hasMulti = /\bmulti\b/i.test(raw);
        const primaryTag = subtitles.find(item => item.tag === 'VOSTFR')?.tag
            || audio.find(item => item.language === 'fr')?.tag
            || audio[0]?.tag
            || (hasMulti ? 'MULTI' : null);
        const summary = subtitles.find(item => item.tag === 'VOSTFR')
            ? 'VOSTFR'
            : audio.find(item => item.language === 'fr')?.tag
                || audio[0]?.tag
                || (hasMulti ? 'MULTI (unverified)' : '');
        return { audio, subtitles, hasMulti, primaryTag, summary };
    }

    function languageDisplay(code) {
        const normalized = normalizeLanguagePreference(code);
        return LANGUAGE_LABELS[normalized] || String(code || '').toUpperCase();
    }

    function codecProfileFromItem(item = {}) {
        const data = item.data || {};
        const variant = item.defaultVariant || item.default_variant || item.variant || {};
        return firstRecord(
            item.codecProfile,
            item.codec_profile,
            data.codecProfile,
            data.codec_profile,
            variant.codecProfile,
            variant.codec_profile,
            item.playbackHint?.codecProfile,
            item.playback_hint?.codec_profile
        );
    }

    function languageArrayFromValue(value) {
        if (value === undefined || value === null || value === '') return [];
        if (Array.isArray(value)) return value.flatMap(languageArrayFromValue);
        if (typeof value === 'object') {
            return languageArrayFromValue(value.language || value.lang || value.iso_639_1 || value.iso639 || value.code || value.name || value.english_name || value.title);
        }
        return String(value)
            .split(/[,/|;]/)
            .map(part => normalizeLanguagePreference(part))
            .filter(Boolean);
    }

    function collectStructuredLanguages(item = {}, keys = []) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        const profile = codecProfileFromItem(item);
        const records = [item, data, metadata, profile];
        const languages = [];
        for (const record of records) {
            if (!record || typeof record !== 'object') continue;
            for (const key of keys) {
                languages.push(...languageArrayFromValue(record[key]));
            }
        }
        return [...new Set(languages)];
    }

    function tracksFromCodecProfile(item = {}, kind = 'audio') {
        const profile = codecProfileFromItem(item);
        if (!profile || typeof profile !== 'object') return null;
        const tracks = kind === 'audio'
            ? (profile.audioTracks || profile.audio_tracks)
            : (profile.subtitles || profile.subtitleTracks || profile.subtitle_tracks);
        return Array.isArray(tracks) ? tracks : null;
    }

    function evaluateRequestedLanguage(item, requested, kind = 'audio') {
        const language = normalizeLanguagePreference(requested, kind);
        if (!language) return { requested: '', state: 'unknown', confidence: 'none', source: 'none', tag: null };
        if (kind === 'subtitle' && language === 'none') {
            return { requested: 'none', state: 'confirmed', confidence: 'confirmed', source: 'user', tag: null };
        }

        const structuredKeys = kind === 'audio'
            ? ['audioLanguages', 'audio_languages', 'audioLangs', 'audio_langs', 'spokenLanguages', 'spoken_languages']
            : ['subtitleLanguages', 'subtitle_languages', 'subtitlesLanguages', 'subtitles_languages'];
        const structured = collectStructuredLanguages(item, structuredKeys);
        if (structured.length) {
            return structured.includes(language)
                ? { requested: language, state: 'confirmed', confidence: 'confirmed', source: 'provider', tag: null }
                : { requested: language, state: 'confirmed_absent', confidence: 'absent', source: 'provider', tag: null };
        }

        const tracks = tracksFromCodecProfile(item, kind);
        if (Array.isArray(tracks)) {
            const trackLanguages = tracks.flatMap(track => languageArrayFromValue(track.language || track.lang || track.title || track.label));
            return trackLanguages.includes(language)
                ? { requested: language, state: 'confirmed', confidence: 'confirmed', source: 'probe', tag: null }
                : { requested: language, state: 'confirmed_absent', confidence: 'absent', source: 'probe', tag: null };
        }

        const signals = parseTitleLanguageSignals(item.name || item.title || item.raw_title || item.rawTitle || '');
        const tagList = kind === 'audio' ? signals.audio : signals.subtitles;
        const matchedTag = tagList.find(signal => signal.language === language);
        if (matchedTag) {
            return { requested: language, state: 'unknown', confidence: 'probable', source: 'title_tag', tag: matchedTag.tag };
        }

        return { requested: language, state: 'unknown', confidence: signals.hasMulti ? 'ambiguous' : 'unknown', source: signals.hasMulti ? 'multi_tag' : 'none', tag: signals.hasMulti ? 'MULTI' : null };
    }

    function languageStateScore(result, weights, strict) {
        if (!result?.requested) return 0;
        if (result.state === 'confirmed') return weights.confirmed;
        if (result.state === 'confirmed_absent') return strict ? -100000 : weights.absent;
        if (result.confidence === 'probable') return weights.probable;
        if (result.confidence === 'ambiguous') return weights.ambiguous;
        return weights.unknown;
    }

    function analyzeLanguageCompatibility(item, prefs = {}) {
        const normalizedPrefs = normalizeContentPreferences(prefs);
        const audio = evaluateRequestedLanguage(item, normalizedPrefs.preferredAudioLanguage, 'audio');
        const subtitle = evaluateRequestedLanguage(item, normalizedPrefs.preferredSubtitleLanguage, 'subtitle');
        const strict = normalizedPrefs.strictLanguageMatching;
        let score = 0;
        score += languageStateScore(audio, {
            confirmed: 900,
            probable: 450,
            ambiguous: 30,
            unknown: 60,
            absent: -600
        }, strict);
        score += languageStateScore(subtitle, {
            confirmed: 700,
            probable: 350,
            ambiguous: 20,
            unknown: 50,
            absent: -500
        }, strict);
        if (audio.requested === 'original' && subtitle.requested === 'fr' && subtitle.confidence === 'probable') {
            score += 180;
        }
        return { audio, subtitle, score, preferences: normalizedPrefs };
    }

    function scoreVersionLanguage(item, prefs = {}) {
        return analyzeLanguageCompatibility(item, prefs).score;
    }

    function scoreTitleForPreferences(item, prefs = {}) {
        const variants = Array.isArray(item.variants) && item.variants.length
            ? item.variants
            : [item.defaultVariant || item.default_variant || item];
        const scores = variants.map(variant => scoreVersionLanguage({ ...item, ...variant, data: { ...(item.data || {}), ...(variant.data || {}) } }, prefs));
        return scores.length ? Math.max(...scores) : 0;
    }

    function versionLanguageBadge(item, prefs = {}) {
        const analysis = analyzeLanguageCompatibility(item, prefs);
        const candidates = [];
        let audioCandidate = '';
        let subtitleCandidate = '';
        const hasRequestedLanguage = Boolean(analysis.audio.requested || (analysis.subtitle.requested && analysis.subtitle.requested !== 'none'));
        if (analysis.audio.requested) {
            if (analysis.audio.state === 'confirmed') audioCandidate = `Audio ${languageDisplay(analysis.audio.requested)} confirme`;
            else if (analysis.audio.confidence === 'probable') audioCandidate = `Audio ${languageDisplay(analysis.audio.requested)} probable`;
            else if (analysis.audio.state === 'confirmed_absent') audioCandidate = `Audio ${languageDisplay(analysis.audio.requested)} absent`;
        }
        if (analysis.subtitle.requested && analysis.subtitle.requested !== 'none') {
            if (analysis.subtitle.state === 'confirmed') subtitleCandidate = `Sous-titres ${languageDisplay(analysis.subtitle.requested)} confirmes`;
            else if (analysis.subtitle.confidence === 'probable') subtitleCandidate = `Sous-titres ${languageDisplay(analysis.subtitle.requested)} probables`;
            else if (analysis.subtitle.state === 'confirmed_absent') subtitleCandidate = `Sous-titres ${languageDisplay(analysis.subtitle.requested)} absents`;
        }
        if (analysis.audio.requested === 'original' && subtitleCandidate) {
            candidates.push(subtitleCandidate, audioCandidate);
        } else {
            candidates.push(audioCandidate, subtitleCandidate);
        }
        const firstCandidate = candidates.filter(Boolean)[0];
        if (firstCandidate) return firstCandidate;
        const parsed = parseVersionInfo(item.name || item.title || item.raw_title || item.rawTitle);
        if (parsed.languageSummary) return parsed.languageSummary;
        return hasRequestedLanguage ? 'Langue non verifiee' : '';
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
     * Order group versions by user preference (language compatibility > quality > source order).
     * Unknown language data stays eligible; confirmed/probable matches are boosted.
     */
    function orderVersionsByPreference(items, prefs = {}) {
        const normalizedPrefs = normalizeContentPreferences(prefs);
        const prefQuality = normalizedPrefs.preferredQuality || 'highest';

        const qualityTarget = { '4k': 5, '1080p': 3, '720p': 2 }[prefQuality] || null;

        return [...items].map(item => {
            const v = parseVersionInfo(item.name);
            let score = scoreVersionLanguage(item, normalizedPrefs);
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
        if (v.languageSummary || v.language) parts.push(v.languageSummary || v.language);
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

    // === Image helpers ===

    const DEFAULT_IMAGE_FALLBACK = '/img/norva-media-placeholder.png';

    function safeImageUrl(value, fallback = DEFAULT_IMAGE_FALLBACK) {
        const fallbackUrl = fallback || DEFAULT_IMAGE_FALLBACK;
        const raw = String(value || '').trim();
        if (!raw) return fallbackUrl;
        if (/^(data|blob):/i.test(raw)) return raw;
        if (/^(\.?\.?\/|#)/.test(raw)) return raw;
        if (!/^https?:\/\//i.test(raw)) return fallbackUrl;
        if (/\/image\?url=/i.test(raw)) return raw;

        if (window.API?.isCloudMode?.() && window.NorvaCloud?.imageUrl) {
            return window.NorvaCloud.imageUrl(raw) || fallbackUrl;
        }

        if (window.location?.protocol === 'https:' && raw.toLowerCase().startsWith('http://')) {
            return `/api/proxy/image?url=${encodeURIComponent(raw)}`;
        }

        return raw;
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
        normalizeLanguagePreference, normalizeContentPreferences, migrateLegacyLanguagePreference,
        analyzeLanguageCompatibility, scoreVersionLanguage, scoreTitleForPreferences,
        orderVersionsByPreference, versionLabel, versionLanguageBadge,
        saveFilters, loadFilters, escapeHtml, tmdbPosterUrl, parseDurationToSeconds,
        playbackHintFromItem, safeImageUrl
    };
})();

window.MediaUtils = MediaUtils;
