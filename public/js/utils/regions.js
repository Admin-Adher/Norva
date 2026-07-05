/**
 * Norva content regions — the single source of truth for the "Your region" setting.
 *
 * Each entry normalises an IPTV/streaming market to an ISO-3166-1 alpha-2 country (or a
 * curated market *bundle*) and carries everything the rest of the app needs:
 *   - `code`            canonical id (uppercase; passes CONTENT_REGION_PATTERN in cloudApi)
 *   - `name`            English display name
 *   - `flag`            emoji flag / globe
 *   - `tmdbRegion`      ISO-3166 region for TMDB `region=` (Phase 3)
 *   - `languages`       associated content languages (ISO-639-1), most-relevant first
 *   - `defaultLanguage` the single best synopsis-language guess for this region (Phase 2)
 *   - `kind`            'country' | 'bundle'
 *
 * Exposed as `window.NorvaRegions` (browser) and as a CommonJS module (tests).
 * Legacy stored values (FR, US, IN, MAGHREB, LUSOPHONE, INTERNATIONAL) all resolve here,
 * plus common aliases (UK→GB, UAE→AE, …), so no saved preference breaks.
 */
(function (root) {
    'use strict';

    // ── Countries (curated ~50 top IPTV/streaming markets) ────────────────────────────
    const COUNTRIES = [
        // Western Europe
        ['FR', 'France', '🇫🇷', 'fr', ['fr']],
        ['GB', 'United Kingdom', '🇬🇧', 'en', ['en']],
        ['DE', 'Germany', '🇩🇪', 'de', ['de']],
        ['ES', 'Spain', '🇪🇸', 'es', ['es']],
        ['IT', 'Italy', '🇮🇹', 'it', ['it']],
        ['PT', 'Portugal', '🇵🇹', 'pt', ['pt']],
        ['NL', 'Netherlands', '🇳🇱', 'nl', ['nl']],
        ['BE', 'Belgium', '🇧🇪', 'fr', ['fr', 'nl']],
        ['IE', 'Ireland', '🇮🇪', 'en', ['en']],
        ['CH', 'Switzerland', '🇨🇭', 'de', ['de', 'fr', 'it']],
        ['AT', 'Austria', '🇦🇹', 'de', ['de']],
        // Nordics
        ['SE', 'Sweden', '🇸🇪', 'sv', ['sv']],
        ['NO', 'Norway', '🇳🇴', 'no', ['no']],
        ['DK', 'Denmark', '🇩🇰', 'da', ['da']],
        ['FI', 'Finland', '🇫🇮', 'fi', ['fi']],
        // Central / Eastern Europe
        ['PL', 'Poland', '🇵🇱', 'pl', ['pl']],
        ['GR', 'Greece', '🇬🇷', 'el', ['el']],
        ['RU', 'Russia', '🇷🇺', 'ru', ['ru']],
        ['UA', 'Ukraine', '🇺🇦', 'uk', ['uk', 'ru']],
        ['RO', 'Romania', '🇷🇴', 'ro', ['ro']],
        ['HU', 'Hungary', '🇭🇺', 'hu', ['hu']],
        ['CZ', 'Czechia', '🇨🇿', 'cs', ['cs']],
        ['BG', 'Bulgaria', '🇧🇬', 'bg', ['bg']],
        ['RS', 'Serbia', '🇷🇸', 'sr', ['sr']],
        ['HR', 'Croatia', '🇭🇷', 'hr', ['hr']],
        ['AL', 'Albania', '🇦🇱', 'sq', ['sq']],
        ['TR', 'Turkey', '🇹🇷', 'tr', ['tr']],
        // Americas
        ['US', 'United States', '🇺🇸', 'en', ['en']],
        ['CA', 'Canada', '🇨🇦', 'en', ['en', 'fr']],
        ['BR', 'Brazil', '🇧🇷', 'pt', ['pt']],
        ['MX', 'Mexico', '🇲🇽', 'es', ['es']],
        ['AR', 'Argentina', '🇦🇷', 'es', ['es']],
        // Middle East & North Africa
        ['SA', 'Saudi Arabia', '🇸🇦', 'ar', ['ar']],
        ['AE', 'United Arab Emirates', '🇦🇪', 'ar', ['ar', 'en']],
        ['EG', 'Egypt', '🇪🇬', 'ar', ['ar']],
        ['MA', 'Morocco', '🇲🇦', 'ar', ['ar', 'fr']],
        ['DZ', 'Algeria', '🇩🇿', 'ar', ['ar', 'fr']],
        ['TN', 'Tunisia', '🇹🇳', 'ar', ['ar', 'fr']],
        ['IR', 'Iran', '🇮🇷', 'fa', ['fa']],
        ['IL', 'Israel', '🇮🇱', 'he', ['he']],
        // Sub-Saharan Africa
        ['NG', 'Nigeria', '🇳🇬', 'en', ['en']],
        ['ZA', 'South Africa', '🇿🇦', 'en', ['en']],
        // South & East Asia, Pacific
        ['IN', 'India', '🇮🇳', 'hi', ['hi', 'en', 'ta', 'te', 'ml', 'kn']],
        ['PK', 'Pakistan', '🇵🇰', 'ur', ['ur']],
        ['BD', 'Bangladesh', '🇧🇩', 'bn', ['bn']],
        ['CN', 'China', '🇨🇳', 'zh', ['zh']],
        ['JP', 'Japan', '🇯🇵', 'ja', ['ja']],
        ['KR', 'South Korea', '🇰🇷', 'ko', ['ko']],
        ['PH', 'Philippines', '🇵🇭', 'tl', ['tl', 'en']],
        ['ID', 'Indonesia', '🇮🇩', 'id', ['id']],
        ['TH', 'Thailand', '🇹🇭', 'th', ['th']],
        ['VN', 'Vietnam', '🇻🇳', 'vi', ['vi']],
        ['AU', 'Australia', '🇦🇺', 'en', ['en']]
    ].map(([code, name, flag, defaultLanguage, languages]) => ({
        code, name, flag, defaultLanguage, languages, tmdbRegion: code, kind: 'country'
    }));

    // ── Market bundles (pseudo-regions kept from the legacy list) ─────────────────────
    const BUNDLES = [
        { code: 'MAGHREB', name: 'Maghreb', flag: '🌍', tmdbRegion: 'MA', defaultLanguage: 'ar', languages: ['ar', 'fr'], kind: 'bundle' },
        { code: 'LUSOPHONE', name: 'Lusophone', flag: '🌎', tmdbRegion: 'PT', defaultLanguage: 'pt', languages: ['pt'], kind: 'bundle' },
        { code: 'NORDIC', name: 'Nordic', flag: '❄️', tmdbRegion: 'SE', defaultLanguage: 'en', languages: ['sv', 'no', 'da', 'fi', 'is'], kind: 'bundle' },
        { code: 'INTERNATIONAL', name: 'International', flag: '🌐', tmdbRegion: 'US', defaultLanguage: 'en', languages: ['en'], kind: 'bundle' }
    ];

    const ALL = COUNTRIES.concat(BUNDLES);
    const BY_CODE = ALL.reduce((m, r) => { m[r.code] = r; return m; }, {});

    // Aliases → canonical code (legacy / common IPTV spellings).
    const ALIASES = {
        UK: 'GB', GBR: 'GB', ENGLAND: 'GB',
        UAE: 'AE', EMIRATES: 'AE',
        USA: 'US', AMERICA: 'US',
        KSA: 'SA',
        SCANDINAVIA: 'NORDIC', SCANDINAVIAN: 'NORDIC', NORDICS: 'NORDIC',
        LUSO: 'LUSOPHONE', PORTUGUESE: 'LUSOPHONE',
        MAGHREBI: 'MAGHREB', ARABIC: 'MAGHREB',
        INTL: 'INTERNATIONAL', WORLD: 'INTERNATIONAL', GLOBAL: 'INTERNATIONAL'
    };

    const CANONICAL = ALL.map(r => r.code); // for a stable list ordering fallback

    function rawNormalize(value) {
        return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    }

    /** Canonical region code for any stored/legacy/alias value, or '' if unknown. */
    function normalize(value) {
        const raw = rawNormalize(value);
        if (!raw) return '';
        if (BY_CODE[raw]) return raw;
        if (ALIASES[raw]) return ALIASES[raw];
        // A bare 2-letter ISO country we don't curate still normalises to itself so a
        // stored preference is never silently dropped (cloudApi validates the shape).
        if (/^[A-Z]{2}$/.test(raw)) return raw;
        return '';
    }

    function byCode(code) {
        return BY_CODE[normalize(code)] || null;
    }

    function label(code) {
        const r = byCode(code);
        return r ? r.name : (normalize(code) || 'International');
    }

    function flag(code) {
        const r = byCode(code);
        return r ? r.flag : '🌐';
    }

    /** Best single synopsis-language guess for a region (feeds resolveContentLang). */
    function defaultLanguage(code) {
        const r = byCode(code);
        return (r && r.defaultLanguage) || 'en';
    }

    function tmdbRegion(code) {
        const r = byCode(code);
        return (r && r.tmdbRegion) || normalize(code) || '';
    }

    /** Countries A-Z, then bundles (in declared order) — for the picker list. */
    function list() {
        const countries = COUNTRIES.slice().sort((a, b) => a.name.localeCompare(b.name));
        return countries.concat(BUNDLES);
    }

    /** Filter the list by a free-text query over name + code (case/diacritic-insensitive). */
    function search(query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return list();
        const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const nq = norm(q);
        return list().filter(r => norm(r.name).includes(nq) || r.code.toLowerCase().includes(nq));
    }

    /**
     * Best region for the browser's locales. Prefers an explicit country subtag
     * (`fr-CA` → CA) that we curate; else maps the primary language to a region; else
     * falls back to INTERNATIONAL.
     */
    function inferFromLocale(locales) {
        const list0 = Array.isArray(locales) && locales.length ? locales
            : (typeof navigator !== 'undefined'
                ? (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''])
                : []);
        for (const loc of list0) {
            const parts = String(loc || '').split(/[-_]/).filter(Boolean);
            if (parts.length > 1) {
                const country = normalize(parts[parts.length - 1]);
                if (country && BY_CODE[country]) return country;
            }
        }
        // No usable country subtag — map the primary language to a representative region.
        for (const loc of list0) {
            const lang = String(loc || '').split(/[-_]/)[0].toLowerCase();
            const region = LANGUAGE_TO_REGION[lang];
            if (region) return region;
        }
        return 'INTERNATIONAL';
    }

    // Primary-language → representative region (only where a locale carries no country).
    const LANGUAGE_TO_REGION = {
        fr: 'FR', en: 'US', de: 'DE', es: 'ES', it: 'IT', pt: 'PT', nl: 'NL', pl: 'PL',
        el: 'GR', ru: 'RU', uk: 'UA', ro: 'RO', hu: 'HU', cs: 'CZ', bg: 'BG', sr: 'RS',
        hr: 'HR', sq: 'AL', tr: 'TR', sv: 'SE', no: 'NO', da: 'DK', fi: 'FI',
        ar: 'MAGHREB', fa: 'IR', he: 'IL', hi: 'IN', ur: 'PK', bn: 'BD', zh: 'CN',
        ja: 'JP', ko: 'KR', th: 'TH', vi: 'VN', id: 'ID', tl: 'PH'
    };

    const NorvaRegions = {
        COUNTRIES, BUNDLES, ALL, CANONICAL,
        list, search, byCode, normalize, label, flag,
        defaultLanguage, tmdbRegion, inferFromLocale
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = NorvaRegions;
    if (root) root.NorvaRegions = NorvaRegions;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
