/**
 * Media utilities — title normalization, duplicate grouping, version
 * ranking and filter persistence shared by MoviesPage and SeriesPage.
 *
 * NOTE: normalization rules mirror server/services/mediaNormalizer.js —
 * keep both in sync when changing them.
 */

const MediaUtils = (() => {
    const LANG_TAGS = [
        'vostfr', 'vosten', 'vostes', 'vostar', 'vostde', 'vostit', 'vostpt',
        'vosttr', 'vostnl', 'vostru', 'vostpl', 'vosthi', 'vostjpn', 'vostkor',
        'vostzh', 'vost', 'subfr', 'suben', 'subes', 'subar', 'subde', 'subit',
        'subpt', 'subtr', 'subnl', 'subru', 'subpl', 'subhi', 'subjpn', 'subkor',
        'subzh', 'frsub', 'ensub', 'essub', 'arsub', 'desub', 'itsub', 'ptsub',
        'trsub', 'nlsub', 'rusub', 'plsub', 'hisub', 'jpnsub', 'korsub', 'zhsub',
        'multi', 'truefrench', 'vff', 'vfq', 'vf', 'vo',
        'fr', 'fre', 'fra', 'en', 'eng', 'es', 'spa', 'de', 'deu', 'ger',
        'it', 'ita', 'pt', 'por', 'br', 'nl', 'nld', 'dut', 'ar', 'ara',
        'tr', 'tur', 'pl', 'pol', 'ru', 'rus', 'hi', 'hin', 'ja', 'jpn',
        'jp', 'ko', 'kor', 'zh', 'zho', 'chi', 'cn', 'sub', 'subs', 'dub'
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
        ar: 'AR',
        de: 'DE',
        it: 'IT',
        pt: 'PT',
        tr: 'TR',
        nl: 'NL',
        ru: 'RU',
        pl: 'PL',
        hi: 'HI',
        ja: 'JA',
        ko: 'KO',
        zh: 'ZH',
        fa: 'FA',
        sq: 'SQ',
        el: 'EL',
        da: 'DA', no: 'NO', sv: 'SV', fi: 'FI', is: 'IS',
        original: 'VO'
    };

    // Full language names for the descriptive card badge ("French" not "FR").
    const LANGUAGE_NAMES = {
        fr: 'French', en: 'English', es: 'Spanish', ar: 'Arabic', de: 'German',
        it: 'Italian', pt: 'Portuguese', tr: 'Turkish', nl: 'Dutch', ru: 'Russian',
        pl: 'Polish', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
        fa: 'Persian', sq: 'Albanian', el: 'Greek',
        da: 'Danish', no: 'Norwegian', sv: 'Swedish', fi: 'Finnish', is: 'Icelandic',
        original: 'Original'
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
        castilian: 'es',
        castellano: 'es',
        arabic: 'ar',
        arabe: 'ar',
        ara: 'ar',
        ar: 'ar',
        german: 'de',
        allemand: 'de',
        deutsch: 'de',
        ger: 'de',
        deu: 'de',
        de: 'de',
        italian: 'it',
        italien: 'it',
        italiano: 'it',
        ita: 'it',
        it: 'it',
        portuguese: 'pt',
        portugais: 'pt',
        portugues: 'pt',
        portuguesebr: 'pt',
        brazilian: 'pt',
        brazilianportuguese: 'pt',
        br: 'pt',
        por: 'pt',
        pt: 'pt',
        dutch: 'nl',
        neerlandais: 'nl',
        nederlands: 'nl',
        nld: 'nl',
        dut: 'nl',
        nl: 'nl',
        turkish: 'tr',
        turc: 'tr',
        tur: 'tr',
        tr: 'tr',
        polish: 'pl',
        polonais: 'pl',
        pol: 'pl',
        pl: 'pl',
        russian: 'ru',
        russe: 'ru',
        rus: 'ru',
        ru: 'ru',
        hindi: 'hi',
        hin: 'hi',
        hi: 'hi',
        japanese: 'ja',
        japonais: 'ja',
        japan: 'ja',
        jpn: 'ja',
        jp: 'ja',
        ja: 'ja',
        korean: 'ko',
        coreen: 'ko',
        coréen: 'ko',
        kor: 'ko',
        ko: 'ko',
        chinese: 'zh',
        chinois: 'zh',
        mandarin: 'zh',
        zho: 'zh',
        chi: 'zh',
        cn: 'zh',
        zh: 'zh',
        persian: 'fa',
        farsi: 'fa',
        iranian: 'fa',
        per: 'fa',
        fas: 'fa',
        fa: 'fa',
        albanian: 'sq',
        shqip: 'sq',
        alb: 'sq',
        sq: 'sq',
        greek: 'el',
        grec: 'el',
        ell: 'el',
        gre: 'el',
        el: 'el',
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
        { tag: 'FR', re: /(^|[^a-z\s])fr([^a-z\s]|$)/i, language: 'fr' },
        { tag: 'VOSTFR', re: /\bvost[\s._-]*fr\b/i, language: 'original' },
        { tag: 'VOSTEN', re: /\bvost[\s._-]*(en|eng|english)\b/i, language: 'original' },
        { tag: 'VOSTES', re: /\bvost[\s._-]*(es|spa|spanish)\b/i, language: 'original' },
        { tag: 'VOSTAR', re: /\bvost[\s._-]*(ar|ara|arabic|arabe)\b/i, language: 'original' },
        { tag: 'VOSTDE', re: /\bvost[\s._-]*(de|deu|ger|german|deutsch)\b/i, language: 'original' },
        { tag: 'VOSTIT', re: /\bvost[\s._-]*(it|ita|italian|italiano)\b/i, language: 'original' },
        { tag: 'VOSTPT', re: /\bvost[\s._-]*(pt|por|br|portuguese|portugues)\b/i, language: 'original' },
        { tag: 'VOSTTR', re: /\bvost[\s._-]*(tr|tur|turkish)\b/i, language: 'original' },
        { tag: 'VOSTNL', re: /\bvost[\s._-]*(nl|nld|dut|dutch)\b/i, language: 'original' },
        { tag: 'VOSTRU', re: /\bvost[\s._-]*(ru|rus|russian)\b/i, language: 'original' },
        { tag: 'VOSTPL', re: /\bvost[\s._-]*(pl|pol|polish)\b/i, language: 'original' },
        { tag: 'VOSTHI', re: /\bvost[\s._-]*(hi|hin|hindi)\b/i, language: 'original' },
        { tag: 'VOSTJPN', re: /\bvost[\s._-]*(ja|jp|jpn|japanese)\b/i, language: 'original' },
        { tag: 'VOSTKOR', re: /\bvost[\s._-]*(ko|kor|korean)\b/i, language: 'original' },
        { tag: 'VOSTZH', re: /\bvost[\s._-]*(zh|zho|chi|cn|chinese|mandarin)\b/i, language: 'original' },
        { tag: 'VO', re: /\bvo\b/i, language: 'original' },
        // Audio language from a FREE-FORM TITLE: abbreviations only, each delimiter-guarded
        // (^|[^a-z\s])…([^a-z\s]|$). The spelled-out language NAMES (italian/english/spanish/…) were
        // removed here because they are common English title words — "The Italian Job"→it, "The English
        // Patient"→en, "Chinese Zodiac"→zh were systematic false positives. Full names still resolve from
        // the curated CATEGORY via scanLanguageMarkers (token-exact), and the VOST*/SUB* forms below keep
        // their full words because they are anchored to a vost/sub marker and so can't fire on a title word.
        { tag: 'EN', re: /(^|[^a-z\s])(en|eng)([^a-z\s]|$)/i, language: 'en' },
        { tag: 'ES', re: /(^|[^a-z\s])(es|spa)([^a-z\s]|$)/i, language: 'es' },
        { tag: 'AR', re: /(^|[^a-z\s])(ar|ara)([^a-z\s]|$)/i, language: 'ar' },
        { tag: 'DE', re: /(^|[^a-z\s])(de|deu|ger)([^a-z\s]|$)/i, language: 'de' },
        { tag: 'ITA', re: /(^|[^a-z\s])(ita)([^a-z\s]|$)/i, language: 'it' },
        { tag: 'PT', re: /(^|[^a-z\s])(pt|por|br)([^a-z\s]|$)/i, language: 'pt' },
        { tag: 'TR', re: /(^|[^a-z\s])(tr|tur)([^a-z\s]|$)/i, language: 'tr' },
        { tag: 'NL', re: /(^|[^a-z\s])(nl|nld|dut)([^a-z\s]|$)/i, language: 'nl' },
        { tag: 'RU', re: /(^|[^a-z\s])(ru|rus)([^a-z\s]|$)/i, language: 'ru' },
        { tag: 'PL', re: /(^|[^a-z\s])(pl|pol)([^a-z\s]|$)/i, language: 'pl' },
        { tag: 'HI', re: /(^|[^a-z\s])(hi|hin)([^a-z\s]|$)/i, language: 'hi' },
        { tag: 'JPN', re: /(^|[^a-z\s])(jp|jpn)([^a-z\s]|$)/i, language: 'ja' },
        { tag: 'KOR', re: /(^|[^a-z\s])(ko|kor)([^a-z\s]|$)/i, language: 'ko' },
        { tag: 'ZH', re: /(^|[^a-z\s])(zh|zho|cn)([^a-z\s]|$)/i, language: 'zh' }
    ];

    const TITLE_SUBTITLE_SIGNALS = [
        { tag: 'VOSTFR', re: /\bvost[\s._-]*fr\b/i, language: 'fr' },
        { tag: 'VOSTEN', re: /\bvost[\s._-]*(en|eng|english)\b/i, language: 'en' },
        { tag: 'VOSTES', re: /\bvost[\s._-]*(es|spa|spanish)\b/i, language: 'es' },
        { tag: 'VOSTAR', re: /\bvost[\s._-]*(ar|ara|arabic|arabe)\b/i, language: 'ar' },
        { tag: 'VOSTDE', re: /\bvost[\s._-]*(de|deu|ger|german|deutsch)\b/i, language: 'de' },
        { tag: 'VOSTIT', re: /\bvost[\s._-]*(it|ita|italian|italiano)\b/i, language: 'it' },
        { tag: 'VOSTPT', re: /\bvost[\s._-]*(pt|por|br|portuguese|portugues)\b/i, language: 'pt' },
        { tag: 'VOSTTR', re: /\bvost[\s._-]*(tr|tur|turkish)\b/i, language: 'tr' },
        { tag: 'VOSTNL', re: /\bvost[\s._-]*(nl|nld|dut|dutch)\b/i, language: 'nl' },
        { tag: 'VOSTRU', re: /\bvost[\s._-]*(ru|rus|russian)\b/i, language: 'ru' },
        { tag: 'VOSTPL', re: /\bvost[\s._-]*(pl|pol|polish)\b/i, language: 'pl' },
        { tag: 'VOSTHI', re: /\bvost[\s._-]*(hi|hin|hindi)\b/i, language: 'hi' },
        { tag: 'VOSTJPN', re: /\bvost[\s._-]*(ja|jp|jpn|japanese)\b/i, language: 'ja' },
        { tag: 'VOSTKOR', re: /\bvost[\s._-]*(ko|kor|korean)\b/i, language: 'ko' },
        { tag: 'VOSTZH', re: /\bvost[\s._-]*(zh|zho|chi|cn|chinese|mandarin)\b/i, language: 'zh' },
        { tag: 'SUBFR', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*fr\b/i, language: 'fr' },
        { tag: 'FRSUB', re: /\bfr[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'fr' },
        { tag: 'SUBEN', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(en|eng|english)\b/i, language: 'en' },
        { tag: 'SUBES', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(es|spa|spanish)\b/i, language: 'es' },
        { tag: 'SUBAR', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(ar|ara|arabic|arabe)\b/i, language: 'ar' },
        { tag: 'SUBDE', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(de|deu|ger|german|deutsch)\b/i, language: 'de' },
        { tag: 'SUBIT', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(it|ita|italian|italiano)\b/i, language: 'it' },
        { tag: 'SUBPT', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(pt|por|br|portuguese|portugues)\b/i, language: 'pt' },
        { tag: 'SUBTR', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(tr|tur|turkish)\b/i, language: 'tr' },
        { tag: 'SUBNL', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(nl|nld|dut|dutch)\b/i, language: 'nl' },
        { tag: 'SUBRU', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(ru|rus|russian)\b/i, language: 'ru' },
        { tag: 'SUBPL', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(pl|pol|polish)\b/i, language: 'pl' },
        { tag: 'SUBHI', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(hi|hin|hindi)\b/i, language: 'hi' },
        { tag: 'SUBJPN', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(ja|jp|jpn|japanese)\b/i, language: 'ja' },
        { tag: 'SUBKOR', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(ko|kor|korean)\b/i, language: 'ko' },
        { tag: 'SUBZH', re: /\b(sub|subs|st|subtitle|subtitles)[\s._-]*(zh|zho|chi|cn|chinese|mandarin)\b/i, language: 'zh' },
        { tag: 'ARSUB', re: /\b(ar|ara|arabic|arabe)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'ar' },
        { tag: 'DESUB', re: /\b(de|deu|ger|german|deutsch)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'de' },
        { tag: 'ITSUB', re: /\b(it|ita|italian|italiano)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'it' },
        { tag: 'PTSUB', re: /\b(pt|por|br|portuguese|portugues)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'pt' },
        { tag: 'TRSUB', re: /\b(tr|tur|turkish)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'tr' },
        { tag: 'NLSUB', re: /\b(nl|nld|dut|dutch)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'nl' },
        { tag: 'RUSUB', re: /\b(ru|rus|russian)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'ru' },
        { tag: 'PLSUB', re: /\b(pl|pol|polish)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'pl' },
        { tag: 'HISUB', re: /\b(hi|hin|hindi)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'hi' },
        { tag: 'JPNSUB', re: /\b(ja|jp|jpn|japanese)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'ja' },
        { tag: 'KORSUB', re: /\b(ko|kor|korean)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'ko' },
        { tag: 'ZHSUB', re: /\b(zh|zho|chi|cn|chinese|mandarin)[\s._-]*(sub|subs|st|subtitle|subtitles)\b/i, language: 'zh' }
    ];

    // IPTV VOD labels lead with a region/language prefix: "IR - …", "AR-SUBS - …",
    // "4K-AR - …", "IN-EN - …", "ES - …". The provider's CATEGORY name carries the
    // same convention ("IR - PERSIAN SUB/DUB", "أفلام أجنبية"). This is the most
    // reliable language signal we have, because the container itself is usually
    // untagged (lang = und). Map a region/language token -> ISO code.
    const REGION_PREFIX_LANG = {
        ir: 'fa', iran: 'fa', fa: 'fa', fas: 'fa', per: 'fa', persian: 'fa', farsi: 'fa',
        ar: 'ar', ara: 'ar', arab: 'ar', arabic: 'ar', arabe: 'ar',
        al: 'sq', alb: 'sq', albanian: 'sq', shqip: 'sq',
        gr: 'el', gre: 'el', ell: 'el', greek: 'el',
        es: 'es', spa: 'es', spanish: 'es', esp: 'es', lat: 'es', latino: 'es',
        pt: 'pt', por: 'pt', br: 'pt', bra: 'pt', portuguese: 'pt',
        de: 'de', ger: 'de', deu: 'de', german: 'de',
        fr: 'fr', fre: 'fr', fra: 'fr', vf: 'fr', vff: 'fr', vfq: 'fr', truefrench: 'fr', french: 'fr',
        en: 'en', eng: 'en', english: 'en', us: 'en', uk: 'en',
        it: 'it', ita: 'it', italian: 'it',
        tr: 'tr', tur: 'tr', turkish: 'tr',
        nl: 'nl', dut: 'nl', dutch: 'nl',
        dk: 'da', da: 'da', dan: 'da', danish: 'da', dansk: 'da', danske: 'da',
        no: 'no', nor: 'no', norwegian: 'no', norsk: 'no', norge: 'no',
        se: 'sv', sv: 'sv', swe: 'sv', swedish: 'sv', svensk: 'sv', svenskt: 'sv',
        fi: 'fi', fin: 'fi', finnish: 'fi', suomi: 'fi',
        is: 'is', isl: 'is', icelandic: 'is',
        ru: 'ru', rus: 'ru', russian: 'ru',
        pl: 'pl', pol: 'pl', polish: 'pl',
        in: 'hi', ind: 'hi', hi: 'hi', hin: 'hi', hindi: 'hi', // India -> Hindi (best-effort)
        jp: 'ja', jpn: 'ja', japanese: 'ja',
        kr: 'ko', kor: 'ko', korean: 'ko',
        cn: 'zh', zh: 'zh', chinese: 'zh', mandarin: 'zh'
    };
    const SUB_MARKERS = new Set(['sub', 'subs', 'subt', 'subbed', 'subtitle', 'subtitles', 'st', 'vost', 'vostfr']);
    const DUB_MARKERS = new Set(['dub', 'dubbed', 'dublado', 'doblado', 'doublage']);
    const PREFIX_QUALITY = new Set(['4k', '8k', 'uhd', '2160p', '1440p', '1080p', '720p', '480p', '360p', 'fhd', 'hd', 'sd', 'hdr', 'hdr10', 'sdr', 'dv']);
    // Arabic-script markers that mean "subtitled/translated".
    const RTL_SUB_RE = /مترجم|ترجمة|زیرنویس|زیرنویس‌دار/;

    // Parse the leading "XX - " (or "XX-YY - ") segment of an IPTV label/category
    // into a structured language hint. Returns null when there is no usable prefix.
    function parseLeadingRegionTag(name) {
        const raw = String(name || '');
        const m = raw.match(/^\s*([0-9a-z+][0-9a-z+À-ɏ\s._\-/]{0,24}?)\s*[-–—|:/]\s+/i);
        if (!m) return null;
        const seg = stripDiacritics(m[1]).toLowerCase();
        const tokens = seg.split(/[^a-z0-9]+/).filter(Boolean);
        if (!tokens.length || tokens.length > 5) return null;
        let audioLang = null, subLang = null, hasSub = false, hasDub = false, sawLangToken = false;
        for (const tok of tokens) {
            if (PREFIX_QUALITY.has(tok)) continue;
            if (SUB_MARKERS.has(tok)) { hasSub = true; continue; }
            if (DUB_MARKERS.has(tok)) { hasDub = true; continue; }
            const lang = REGION_PREFIX_LANG[tok];
            if (lang) {
                sawLangToken = true;
                // An explicit language token wins for audio (e.g. "IN-EN" -> English);
                // the first language also seeds the subtitle language.
                audioLang = lang;
                if (!subLang) subLang = lang;
            }
        }
        if (!sawLangToken) return null;
        return { audioLang, subLang, hasSub, hasDub };
    }

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
        const maxYear = new Date().getFullYear() + 1;
        const plausible = (v) => {
            const n = v ? parseInt(v, 10) : NaN;
            return (n >= 1900 && n <= maxYear) ? String(n) : null;
        };
        if (year) {
            const p = plausible(String(year).match(/(19|20)\d{2}/)?.[0]);
            if (p) return p;
        }
        if (!name) return null;
        const bracket = plausible(name.match(/[([]\s*((19|20)\d{2})\s*[)\]]/)?.[1]);
        if (bracket) return bracket;
        // A trailing bare number is often part of the title ("Demon Lord 2099") —
        // only accept it as a year when it's plausible (not in the future).
        return plausible(name.trim().match(/(?:^|\s)((19|20)\d{2})$/)?.[1]);
    }

    function normalizeTitle(name, knownYear = null) {
        if (!name) return '';
        // Strip a leading provider region/language/category prefix ("EN - ", "AR-SUBS - ", "DK ▎ ", plus
        // the digit-led quality prefixes "4K-AR - " / "8K-FR - " the "Strng IPTV 8K" panel emits) on the
        // RAW-CASED string FIRST — the head guard (two uppercase letters, sparing "IT"/"US"/"007 - "…, OR
        // a quality token 4K/8K/2160P…) is destroyed by toLowerCase(). Mirrors the server
        // vod-title-projection.normalizeTitle so the client-computed dedup key agrees with the server's,
        // collapsing cross-region/quality copies of one film. Falls back to the raw name if stripping empties it.
        const raw = String(name);
        const deprefixed = raw.replace(/^(?:[A-Z]{2}|4K|8K|3D|2160P|1440P|1080P|720P|480P|360P|007)(?:-[A-Z0-9+]{1,6})*(?: [-–—▎▏▍▌│┃┆┊｜|] | -[A-Z0-9+]{1,6}- )/, '');
        let s = stripDiacritics(deprefixed.length >= 2 ? deprefixed : raw).toLowerCase();
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

    // Human display form of a provider/scene release name:
    //   "[ Torrent911.me ] Guardians.Of.The.Galaxy.Vol.3.2023.Vostfr.Hdrip.X264"
    //   → "Guardians Of The Galaxy Vol 3 2023"
    // DISPLAY ONLY (unlike normalizeTitle, case is preserved and nothing is deduped).
    // Conservative on purpose: strips leading bracketed release-site ads, de-dots only
    // clearly dot-separated scene names, cuts at unambiguous rip/codec tokens, then pops
    // trailing language/version markers. Falls back to the input when cleaning would
    // empty the name (e.g. the film "[REC]").
    const HARD_RELEASE_TOKENS = /^(webrip|web-?dl|hdrip|brrip|bdrip|dvdrip|hdtv|hdlight|hdcam|camrip|hdts|blu-?ray|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|dts|10bit|8bit|2160p|1080p|720p|480p|4klight)$/i;
    const SOFT_RELEASE_TOKENS = /^(french|truefrench|vostfr|vost|vff|vfq|vf|vo|multi|subfrench|final|proper|repack|internal|extended|unrated|custom)$/i;
    function cleanReleaseName(value) {
        const raw = String(value || '').trim();
        if (!raw) return raw;
        let text = raw.replace(/^\s*(?:[\[(][^\])]{0,60}[\])]\s*)+/, '').trim();
        // Strip a leading provider region/language/category prefix ("FR - ", "AR-SUBS - ", "SOC - ",
        // the box-bar variants some panels use ("DK ▎ A Hijacking", "ALB ▎ Source Code"), and the
        // digit-led quality prefixes the "Strng IPTV 8K" panel emits ("4K-AR - La Bête", "4K-D+ - The
        // Muppet Show", "8K - …"). Head = two uppercase letters (so "007 - …"/"1917 - …" are never
        // mistaken for a prefix) OR a quality token 4K/8K/2160P… ("8 Mile"/"4Kids"/"2160 -" stay safe).
        // Mirrors the server cleanDisplayTitle — keep the two in sync.
        const deprefixed = text.replace(/^(?:[A-Z]{2}|4K|8K|3D|2160P|1440P|1080P|720P|480P|360P|007)(?:-[A-Z0-9+]{1,6})*(?: [-–—▎▏▍▌│┃┆┊｜|] | -[A-Z0-9+]{1,6}- )/, '').trim();
        if (deprefixed.length >= 2) text = deprefixed;
        // Strip a trailing second-script title providers append after the Latin name, e.g.
        // "Checkered Ninja 3 (2026) نينجاى شطرنجى 3" → "Checkered Ninja 3 (2026)" (the year-strip
        // below then drops the now-trailing "(2026)"). Cut at the first Arabic/Hebrew/Cyrillic/
        // Greek/CJK/Kana/Hangul/Thai character, but only when a Latin title remains in front, so a
        // natively non-Latin title is left untouched. Mirrors the server cleanDisplayTitle — keep in sync.
        const nlAt = text.search(/[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿Ѐ-ӿͰ-Ͽ぀-ヿ㐀-鿿가-힯฀-๿]/);
        if (nlAt > 0) {
            const head = text.slice(0, nlAt).replace(/[\s\-–—:|.،؛]+$/, '').trim();
            if (head.length >= 2 && /[A-Za-z]/.test(head)) text = head;
        }
        if (!/\s/.test(text) && /^\S+(?:\.\S+){3,}$/.test(text)) text = text.replace(/\./g, ' ');
        const tokens = text.split(/\s+/).filter(Boolean);
        let cut = tokens.length;
        for (let i = 1; i < tokens.length; i++) {   // never cut the leading token
            if (HARD_RELEASE_TOKENS.test(tokens[i])) { cut = i; break; }
        }
        const kept = tokens.slice(0, cut);
        while (kept.length > 1 && SOFT_RELEASE_TOKENS.test(kept[kept.length - 1])) kept.pop();
        const out = kept.join(' ')
            // Drop a trailing "(2012)" / "[2012]" — the year is shown separately on the card, so it's
            // redundant noise here. Only a BRACKETED year (never a bare trailing number) so real titles
            // like "1917", "2012", "Blade Runner 2049" keep their number.
            .replace(/\s*[[(](?:19|20)\d{2}[)\]]\s*$/, '')
            .replace(/[\s\-–—:|.]+$/g, '').trim();
        return out || raw;
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
                const re = new RegExp(`(^|[^a-z\\s])${tag}([^a-z\\s]|$)`, 'i');
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

    // Scan a curated, convention-following string (a provider CATEGORY name, never a
    // free-form film title) for language + sub/dub markers anywhere in the text.
    // e.g. "IR - PERSIAN SUB/DUB" -> { lang: 'fa', hasSub: true, hasDub: true }.
    function scanLanguageMarkers(text) {
        const seg = stripDiacritics(String(text || '')).toLowerCase();
        const tokens = seg.split(/[^a-z0-9]+/).filter(Boolean);
        let lang = null, hasSub = false, hasDub = false;
        for (const tok of tokens) {
            if (SUB_MARKERS.has(tok)) { hasSub = true; continue; }
            if (DUB_MARKERS.has(tok)) { hasDub = true; continue; }
            if (PREFIX_QUALITY.has(tok)) continue;
            const code = REGION_PREFIX_LANG[tok] || LANGUAGE_ALIASES[tok];
            if (code && code !== 'original' && !lang) lang = code; // first language wins
        }
        if (RTL_SUB_RE.test(String(text || ''))) hasSub = true;
        return { lang, hasSub, hasDub };
    }

    const langFullName = (code) => LANGUAGE_NAMES[code] || languageDisplayFull(code);

    // Phase 1 "track intelligence" — the cheap, instant, zero-network layer. The
    // container is usually untagged (lang=und) and burned-in subtitles are not a
    // track at all, but the version LABEL and the provider CATEGORY follow strict
    // IPTV conventions. Combine them with the demux result into a structured
    // description the player can show instead of "Default" / "Off".
    //
    //   deriveTrackIntel({ title, category, hasSubtitleStream, originalLanguage })
    //   -> { audio:    { code, name, isDub, confidence, source } | null,
    //        subtitle: { code, name, type:'soft'|'burned-in'|'none'|'unknown', confidence, source } | null }
    //
    // Burned-in rule: a subtitle language is signalled by the label/category, yet the
    // container exposes NO subtitle track => the text is hard-coded into the picture
    // (e.g. "AR-SUBS", "IR - PERSIAN SUB"). Surface it as 'burned-in', not "no track".
    function deriveTrackIntel(opts = {}) {
        const title = String(opts.title || '');
        const category = String(opts.category || '');
        const haveStreamKnown = typeof opts.hasSubtitleStream === 'boolean';
        const hasStream = opts.hasSubtitleStream === true;
        const origCode = normalizeLanguagePreference(opts.originalLanguage || '');

        const tInfo = parseVersionInfo(title);           // body-safe signals + leading prefix
        const tRegion = parseLeadingRegionTag(title);
        const cat = scanLanguageMarkers(category);       // curated category -> full scan
        const concrete = (list) => (list || [])
            .map((s) => (s && s.language && s.language !== 'original') ? s.language : null)
            .find(Boolean) || null;

        // ---- AUDIO ----
        let audioCode = concrete(tInfo.audioSignals) || cat.lang || null;
        const isOriginal = !audioCode && (tInfo.audioSignals || []).some((s) => s && s.language === 'original');
        let audio = null;
        if (audioCode) {
            audio = { code: audioCode, name: langFullName(audioCode), isDub: true, confidence: 'inferred', source: 'label' };
        } else if (isOriginal) {
            audio = (origCode && origCode !== 'und')
                ? { code: origCode, name: langFullName(origCode), isDub: false, confidence: 'inferred', source: 'original' }
                : { code: null, name: 'VO', isDub: false, confidence: 'inferred', source: 'original' };
        }

        // ---- SUBTITLES ----
        const titleSub = concrete(tInfo.subtitleSignals);
        const rtl = RTL_SUB_RE.test(title) || RTL_SUB_RE.test(category);
        const subSignalled = !!(titleSub || (tRegion && tRegion.hasSub) || cat.hasSub || rtl);
        let subCode = titleSub
            || (tRegion && tRegion.hasSub ? tRegion.subLang : null)
            || (cat.hasSub ? cat.lang : null)
            || (rtl ? (cat.lang || audioCode) : null)
            || null;

        let subtitle = null;
        if (subSignalled) {
            const type = hasStream ? 'soft' : (haveStreamKnown ? 'burned-in' : 'unknown');
            subtitle = {
                code: subCode || null,
                name: subCode ? langFullName(subCode) : null,
                type,
                confidence: 'inferred',
                source: titleSub ? 'label' : (cat.hasSub || rtl ? 'category' : 'label')
            };
        } else if (haveStreamKnown && !hasStream) {
            subtitle = { code: null, name: null, type: 'none', confidence: 'observed', source: 'probe' };
        }

        return { audio, subtitle };
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
            strictLanguageMatching: Boolean(prefs.strictLanguageMatching),
            preferredGenres: normalizeGenrePreferences(prefs.preferredGenres || prefs.favoriteGenres || prefs.preferredGenre || [])
        };
    }

    // Coerce a value to a plain 2-letter ISO-639-1 code, or '' for the special/empty
    // sentinels ('', 'none', 'original') and anything unusable.
    function twoLetterLang(value) {
        const v = String(value || '').toLowerCase().trim();
        if (!v || v === 'none' || v === 'original') return '';
        const code = v.split(/[-_]/)[0];
        return /^[a-z]{2}$/.test(code) ? code : '';
    }

    // The resolved SYNOPSIS language (VOD i18n Phase 2). A synopsis is *read*, so the
    // subtitle preference leads; then the audio preference (skipping "original", which is
    // not a readable language); then the region's default language; then the device
    // locale; then English as the universal floor. Returns a 2-letter ISO code.
    // opts: { subtitle, audio, regionLang, locale }.
    function resolveContentLanguage(opts = {}) {
        return twoLetterLang(opts.subtitle)
            || twoLetterLang(opts.audio)
            || twoLetterLang(opts.regionLang)
            || twoLetterLang(opts.locale)
            || 'en';
    }

    function normalizeGenrePreference(value) {
        const normalized = stripDiacritics(String(value || '').toLowerCase())
            .replace(/&/g, 'and')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const aliases = {
            scifi: 'science-fiction',
            'sci-fi': 'science-fiction',
            sciencefiction: 'science-fiction',
            'science-fiction': 'science-fiction',
            tvmovie: 'tv-movie',
            'tv-movie': 'tv-movie'
        };
        return aliases[normalized] || normalized;
    }

    function normalizeGenrePreferences(value) {
        const values = Array.isArray(value)
            ? value
            : String(value || '').split(/[,|;]/);
        return [...new Set(values.map(normalizeGenrePreference).filter(Boolean))];
    }

    function genreListFromItem(item = {}) {
        const data = item.data || {};
        const metadata = item.metadata || {};
        const raw = item.genres || data.genres || metadata.genres || [];
        if (Array.isArray(raw)) {
            return raw.map(genre => typeof genre === 'string'
                ? genre
                : (genre.name || genre.label || genre.title || '')
            ).map(normalizeGenrePreference).filter(Boolean);
        }
        return String(raw || '').split(/[,|;]/).map(normalizeGenrePreference).filter(Boolean);
    }

    function scoreGenrePreferences(item = {}, prefs = {}) {
        const preferredGenres = normalizeGenrePreferences(prefs.preferredGenres || prefs.favoriteGenres || prefs.preferredGenre || []);
        if (!preferredGenres.length) return 0;
        const genres = genreListFromItem(item);
        if (!genres.length) return 35;
        const matches = preferredGenres.filter(genre => genres.includes(genre)).length;
        if (matches) return 220 + matches * 120;
        return -25;
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
        // Leading "XX - " region/language prefix (the dominant IPTV-VOD convention,
        // and the only signal for languages the body never spells out, e.g. Persian).
        const region = parseLeadingRegionTag(name);
        if (region) {
            if (region.audioLang) pushUnique(audio, { language: region.audioLang, tag: 'PREFIX', confidence: 'region' });
            if (region.subLang && (region.hasSub || RTL_SUB_RE.test(String(name || '')))) {
                pushUnique(subtitles, { language: region.subLang, tag: 'PREFIXSUB', confidence: 'region' });
            }
        }
        const hasMulti = /\bmulti\b/i.test(raw);
        // A prefix-derived signal carries the internal tag 'PREFIX'/'PREFIXSUB' (a SOURCE marker,
        // not a user label) — surface the detected language name instead, so a card whose only
        // language signal is the leading prefix ("3D-DE - …") reads "German", never "PREFIX".
        const tagOf = (entry) => entry
            && (entry.tag === 'PREFIX' || entry.tag === 'PREFIXSUB' ? languageDisplayFull(entry.language) : entry.tag);
        const vostfr = subtitles.find(item => item.tag === 'VOSTFR');
        const frAudio = audio.find(item => item.language === 'fr');
        const primaryTag = (vostfr && 'VOSTFR') || tagOf(frAudio) || tagOf(audio[0]) || (hasMulti ? 'MULTI' : null);
        const summary = vostfr ? 'VOSTFR' : (tagOf(frAudio) || tagOf(audio[0]) || (hasMulti ? 'MULTI (unverified)' : ''));
        return { audio, subtitles, hasMulti, primaryTag, summary };
    }

    function languageDisplay(code) {
        const normalized = normalizeLanguagePreference(code);
        return LANGUAGE_LABELS[normalized] || String(code || '').toUpperCase();
    }

    function languageDisplayFull(code) {
        const normalized = normalizeLanguagePreference(code);
        return LANGUAGE_NAMES[normalized] || String(code || '').toUpperCase();
    }

    // Descriptive badge from the REAL detected languages (server audio_languages /
    // version_languages) — preferred over title-parsing. 1 lang -> full name ("French");
    // 2-3 -> "Multi: DE/EN/FR"; >3 -> "Multi". Falls back to version tags, then null.
    function audioLanguageBadge(audioLanguages, versionLanguages) {
        const audio = Array.isArray(audioLanguages)
            ? [...new Set(audioLanguages.map(c => String(c || '').toLowerCase().trim()).filter(Boolean))]
            : [];
        if (audio.length === 1) return languageDisplayFull(audio[0]);
        if (audio.length >= 2 && audio.length <= 3) return `Multi: ${audio.map(languageDisplay).join('/')}`;
        if (audio.length > 3) return 'Multi';
        const version = Array.isArray(versionLanguages) ? versionLanguages.map(t => String(t || '').toLowerCase()) : [];
        if (version.some(t => t === 'multi')) return 'Multi';
        if (version.some(t => /^(vf|vff|vfq|truefrench|french)$/.test(t))) return languageDisplayFull('fr');
        if (version.some(t => /^(en|eng|english)$/.test(t))) return languageDisplayFull('en');
        if (version.some(t => /^(es|spa|spanish)$/.test(t))) return languageDisplayFull('es');
        if (version.some(t => /^(ar|ara|arabic)$/.test(t))) return languageDisplayFull('ar');
        if (version.some(t => /^(de|deu|ger|german)$/.test(t))) return languageDisplayFull('de');
        if (version.some(t => /^(it|ita|italian)$/.test(t))) return languageDisplayFull('it');
        if (version.some(t => /^(pt|por|portuguese)$/.test(t))) return languageDisplayFull('pt');
        return null;
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

    // Distinct ISO audio languages from the title's REAL ffprobe probe (audio_tracks[].lang) — the
    // SAME per-stream signal the catalogue's audio filter matches on. Returns null when the title
    // was never probed (no audio_tracks), [] when probed but empty — so "absent" is only ever
    // claimed from a real probe, never from the inherited audio_languages aggregate (which
    // over-claims languages the user's own file may not have).
    function probedAudioLanguages(item = {}) {
        const raw = item.audio_tracks || item.audioTracks;
        if (!Array.isArray(raw)) return null;
        const langs = [];
        for (const track of raw) {
            const lang = String((track && (track.lang || track.language)) || '').toLowerCase().trim();
            if (/^[a-z]{2,3}$/.test(lang)) langs.push(lang);
        }
        return langs;
    }

    function evaluateRequestedLanguage(item, requested, kind = 'audio') {
        const language = normalizeLanguagePreference(requested, kind);
        if (!language) return { requested: '', state: 'unknown', confidence: 'none', source: 'none', tag: null };
        if (kind === 'subtitle' && language === 'none') {
            return { requested: 'none', state: 'confirmed', confidence: 'confirmed', source: 'user', tag: null };
        }

        // Real ffprobe probe wins (it mirrors the catalogue filter exactly): the title-level
        // audio_tracks first, then the per-variant codec-profile tracks. Only these can CONFIRM.
        if (kind === 'audio') {
            const probe = probedAudioLanguages(item);
            if (Array.isArray(probe)) {
                return probe.includes(language)
                    ? { requested: language, state: 'confirmed', confidence: 'confirmed', source: 'probe', tag: null }
                    : { requested: language, state: 'confirmed_absent', confidence: 'absent', source: 'probe', tag: null };
            }
        }

        const tracks = tracksFromCodecProfile(item, kind);
        if (Array.isArray(tracks)) {
            const trackLanguages = tracks.flatMap(track => languageArrayFromValue(track.language || track.lang || track.title || track.label));
            return trackLanguages.includes(language)
                ? { requested: language, state: 'confirmed', confidence: 'confirmed', source: 'probe', tag: null }
                : { requested: language, state: 'confirmed_absent', confidence: 'absent', source: 'probe', tag: null };
        }

        // Structured language lists. For AUDIO these are cloud_titles.audio_languages — inherited
        // from the global catalog cache by TMDB id, so it over-claims and can only ever be a soft
        // "likely" hint, NEVER a hard confirmation. (Subtitles keep confirm semantics — not inherited.)
        const structuredKeys = kind === 'audio'
            ? ['audioLanguages', 'audio_languages', 'audioLangs', 'audio_langs', 'spokenLanguages', 'spoken_languages']
            : ['subtitleLanguages', 'subtitle_languages', 'subtitlesLanguages', 'subtitles_languages'];
        const structured = collectStructuredLanguages(item, structuredKeys);
        if (structured.length) {
            if (kind === 'audio') {
                return structured.includes(language)
                    ? { requested: language, state: 'unknown', confidence: 'probable', source: 'provider_aggregate', tag: null }
                    : { requested: language, state: 'unknown', confidence: 'unknown', source: 'provider_aggregate', tag: null };
            }
            return structured.includes(language)
                ? { requested: language, state: 'confirmed', confidence: 'confirmed', source: 'provider', tag: null }
                : { requested: language, state: 'confirmed_absent', confidence: 'absent', source: 'provider', tag: null };
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
        const normalizedPrefs = normalizeContentPreferences(prefs);
        const variants = Array.isArray(item.variants) && item.variants.length
            ? item.variants
            : [item.defaultVariant || item.default_variant || item];
        const scores = variants.map(variant => scoreVersionLanguage({ ...item, ...variant, data: { ...(item.data || {}), ...(variant.data || {}) } }, normalizedPrefs));
        return (scores.length ? Math.max(...scores) : 0) + scoreGenrePreferences(item, normalizedPrefs);
    }

    function versionLanguageBadge(item, prefs = {}) {
        const analysis = analyzeLanguageCompatibility(item, prefs);
        const candidates = [];
        let audioCandidate = '';
        let subtitleCandidate = '';
        const hasRequestedLanguage = Boolean(analysis.audio.requested || (analysis.subtitle.requested && analysis.subtitle.requested !== 'none'));
        if (analysis.audio.requested) {
            if (analysis.audio.state === 'confirmed') audioCandidate = `Audio ${languageDisplay(analysis.audio.requested)} confirmed`;
            else if (analysis.audio.confidence === 'probable') audioCandidate = `Audio ${languageDisplay(analysis.audio.requested)} likely`;
            else if (analysis.audio.state === 'confirmed_absent') audioCandidate = `Audio ${languageDisplay(analysis.audio.requested)} unavailable`;
        }
        if (analysis.subtitle.requested && analysis.subtitle.requested !== 'none') {
            if (analysis.subtitle.state === 'confirmed') subtitleCandidate = `${languageDisplay(analysis.subtitle.requested)} subtitles confirmed`;
            else if (analysis.subtitle.confidence === 'probable') subtitleCandidate = `${languageDisplay(analysis.subtitle.requested)} subtitles likely`;
            else if (analysis.subtitle.state === 'confirmed_absent') subtitleCandidate = `${languageDisplay(analysis.subtitle.requested)} subtitles unavailable`;
        }
        if (analysis.audio.requested === 'original' && subtitleCandidate) {
            candidates.push(subtitleCandidate, audioCandidate);
        } else {
            candidates.push(audioCandidate, subtitleCandidate);
        }
        const firstCandidate = candidates.filter(Boolean)[0];
        if (firstCandidate) return firstCandidate;
        // A leading region/language prefix on THIS variant's raw title ("DK - ", "IR - ",
        // "NO - ") names the language of THIS dub — a per-variant signal. It outranks the
        // probed audio_languages, which is stored at the TITLE level and, when a provider
        // groups several different-language dubs under one title, leaks a sibling dub's
        // language (e.g. the French "Mon ninja et moi" stamping {fr} onto the whole Ternet
        // Ninja group, so the Danish/Norwegian/Persian panels wrongly read "French").
        const rawForPrefix = String(item.raw_title || item.rawTitle || item.name || item.title || '')
            .replace(/[▎▏▍▌│┃┆┊｜]/g, ' - '); // box-bar panels ("DK ▎ …") → hyphen so the prefix parser sees it
        // Only a DASH/BAR-separated leading code is the IPTV region convention ("DK - ", "IR - ").
        // A colon ("It: Chapter Two" → not Italian) or slash is normal title punctuation, not a
        // region prefix — never let it override the probed audio.
        const prefixLang = /^\s*[a-z0-9+]{2,6}\s*[-–—]\s+/i.test(rawForPrefix)
            ? parseLeadingRegionTag(rawForPrefix)?.audioLang
            : null;
        if (prefixLang) return languageDisplayFull(prefixLang);
        // Real detected languages outrank title-parsing (the crawl fills these).
        const detected = audioLanguageBadge(
            item.audioLanguages || item.audio_languages,
            item.versionLanguages || item.version_languages
        );
        if (detected) return detected;
        const parsed = parseVersionInfo(item.name || item.title || item.raw_title || item.rawTitle);
        if (parsed.languageSummary) return parsed.languageSummary;
        return hasRequestedLanguage ? 'Language not verified' : '';
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
            // The TMDB id is the strongest grouping signal — it merges the SAME film across
            // localized titles ("Lilo & Stitch" / "Lilo i Stitch" / "Lilo y Stitch"), which a
            // name slug never can. The Movies grid serializes it as provider_tmdb_id/
            // providerTmdbId (never a flat tmdb_id — only search/home-rail items hoist that),
            // so read every alias here or the t: branch is dead on the grid and localized
            // copies fragment. '0'/'tt0' are the provider's no-match sentinels — ignore them.
            const tid = item.tmdb_id || item.provider_tmdb_id || item.providerTmdbId
                || (item.tmdb && item.tmdb.id);
            if (tid && String(tid) !== '0' && String(tid) !== 'tt0') {
                key = `t:${tid}`;
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

        let result = [...groups.values()];
        for (const group of result) {
            group.representative = pickRepresentative(group.items);
        }

        // Second reconciliation pass: a provider sometimes stamps the SAME film with two
        // different tmdb ids (seen live: two "Hunger Games: Mockingjay - Part 2 (2015)"
        // records, ratings 6.898 vs 6.9). Those hash to two different `t:` keys above and
        // never merge, so one film shows as two cards. Fold groups whose representative
        // resolves to the SAME normalized title + year (the strict computeDedupKey). The year
        // is REQUIRED and must be equal and the normalized title must match exactly, so films
        // that differ in slug or year are never collapsed; cross-language titles ("La Ballade…"
        // vs "The Ballad…") differ in slug too and stay matched only by tmdb id, as before.
        const byTitleYear = new Map();
        let folded = false;
        for (const group of result) {
            const rep = group.representative || group.items[0];
            // The year gates the fold (below), so source it from wherever it lives: the item's
            // own `year`, else the matched tmdb release/air date. Global-search rows carry the
            // year ONLY on tmdb.release_date (no `.year`, no year in the display name), so
            // without this fallback the fold could never fire for them and provider-tmdb-split
            // films ("L'embrasement" ×2, "La révolte" ×3) stayed as separate rows.
            const tmdbYr = String(rep.tmdb?.release_date || rep.tmdb?.first_air_date || '').slice(0, 4);
            const repYear = rep.year || (/^(19|20)\d{2}$/.test(tmdbYr) ? Number(tmdbYr) : null);
            const tkey = computeDedupKey(rep.tmdb?.title || rep.name, repYear);
            // Require a real 4-digit year so a yearless title never becomes a merge magnet.
            if (!tkey || !/\|(19|20)\d{2}$/.test(tkey)) continue;
            const primary = byTitleYear.get(tkey);
            if (primary) {
                primary.items.push(...group.items);
                group._folded = true;
                folded = true;
            } else {
                byTitleYear.set(tkey, group);
            }
        }
        if (folded) {
            result = result.filter(g => !g._folded);
            for (const group of result) {
                if (group.items.length > 1) group.representative = pickRepresentative(group.items);
            }
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
            score += scoreGenrePreferences(item, normalizedPrefs);
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

    // Make a horizontal rail (`.horizontal-scroll`) feel natural with a mouse:
    // click-and-drag pans it like a touch swipe (and the click that follows a
    // drag is swallowed so it doesn't open a card). Touch keeps native momentum
    // scrolling; the wheel is left to the page so scrolling down past a rail
    // works normally. Idempotent per element.
    function enhanceRailScroll(scroller) {
        if (!scroller || scroller.dataset.railEnhanced === '1') return;
        scroller.dataset.railEnhanced = '1';

        let dragging = false, moved = false, startX = 0, startLeft = 0, pid = null;
        scroller.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch' || e.button !== 0) return;
            dragging = true; moved = false; pid = e.pointerId;
            startX = e.clientX; startLeft = scroller.scrollLeft;
        });
        scroller.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            if (!moved && Math.abs(dx) > 4) {
                moved = true;
                scroller.classList.add('rail-dragging');
                try { scroller.setPointerCapture(pid); } catch (_) { /* not critical */ }
            }
            if (moved) scroller.scrollLeft = startLeft - dx;
        });
        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            try { if (pid != null) scroller.releasePointerCapture(pid); } catch (_) { /* ignore */ }
            pid = null;
            scroller.classList.remove('rail-dragging');
            if (moved) {
                const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
                scroller.addEventListener('click', swallow, true);
                setTimeout(() => scroller.removeEventListener('click', swallow, true), 60);
            }
        };
        scroller.addEventListener('pointerup', endDrag);
        scroller.addEventListener('pointercancel', endDrag);
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

    /**
     * A directly-fetchable poster URL for native offline downloads. Prefers the
     * public TMDB CDN (absolute, no auth), else the raw provider image when it's
     * an absolute http(s) URL. Deliberately avoids safeImageUrl's cloud/edge
     * image proxy (which needs auth headers the native downloader can't send)
     * and relative proxy paths (which a native URL fetch can't resolve).
     */
    function downloadablePosterUrl(item) {
        const tmdb = tmdbPosterUrl(item && item.tmdb, 'w342');
        if (tmdb) return tmdb;
        const raw = String((item && (item.stream_icon || item.cover || item.poster)) || '').trim();
        return /^https?:\/\//i.test(raw) ? raw : '';
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

    /**
     * Decide the gateway processing mode for a LIVE channel/variant.
     *
     * H.264 feeds → "remux": the gateway copies the video stream untouched and
     * only transcodes audio (HE-AAC/AC3 → AAC). This is fast and light on the
     * shared gateway. H.265/HEVC feeds → "transcode": browsers (notably Chrome
     * over MSE) cannot decode copied HEVC, so the video must be re-encoded to
     * H.264. Providers tag HEVC feeds in the channel/variant name or quality
     * label (e.g. "TF1 [H265]", "FHD · H265", "FRANCE H265").
     */
    function liveGatewayMode(channel = {}) {
        const codecProfile = channel.codecProfile || channel.codec_profile || {};
        const text = [
            channel.name, channel.tvgName, channel.tvg_name, channel.title,
            channel.label, channel.qualityLabel, channel.quality,
            channel.group, channel.groupTitle, channel.group_title,
            channel.category, channel.categoryName, channel.category_name,
            channel.videoCodec, channel.video_codec,
            codecProfile.videoCodec, codecProfile.video_codec, codecProfile.video
        ].filter(Boolean).join(' ').toLowerCase();
        return /\b(h\.?265|hevc|x265)\b/.test(text) ? 'transcode' : 'remux';
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

    /**
     * Fullscreen YouTube trailer lightbox (fiches + billboard). youtube-nocookie
     * embed, closed by ✕ / backdrop click / Escape.
     */
    function openTrailerLightbox(youtubeKey, title = '') {
        if (!youtubeKey) return;
        document.getElementById('norva-trailer-lightbox')?.remove();
        const ov = document.createElement('div');
        ov.id = 'norva-trailer-lightbox';
        ov.className = 'trailer-lightbox';
        ov.innerHTML = `
            <div class="trailer-lightbox-inner">
                <button type="button" class="trailer-lightbox-close" aria-label="Close trailer">✕</button>
                <iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}?autoplay=1&rel=0&modestbranding=1"
                    title="${escapeHtml(title || 'Trailer')}"
                    allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
            </div>`;
        // Mutual refs: close() removes the key listener (fixes the leak where closing via
        // ✕/backdrop previously left the Escape handler attached forever); onKey also
        // handles the TV Back key.
        function close() { document.removeEventListener('keydown', onKey); ov.remove(); }
        function onKey(e) { if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') { e.preventDefault(); close(); } }
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        ov.querySelector('.trailer-lightbox-close').addEventListener('click', close);
        document.addEventListener('keydown', onKey);
        document.body.appendChild(ov);
        // Android TV: land the D-pad on the close button so the lightbox is dismissible by
        // remote (tvNavigation now scopes navigation to .trailer-lightbox and closes it on
        // Back — see openModal/closeTopModal there).
        if (document.documentElement.classList.contains('tv-mode')) {
            const closeBtn = ov.querySelector('.trailer-lightbox-close');
            if (closeBtn && !closeBtn.hasAttribute('tabindex')) closeBtn.setAttribute('tabindex', '-1');
            setTimeout(() => { try { closeBtn?.focus(); } catch (_) { /* noop */ } }, 40);
        }
    }

    /**
     * TMDB srcset for poster <img>s: the CDN serves the same path at several
     * widths, so small screens stop over-fetching and large ones stop upscaling.
     * Returns '' for non-TMDB URLs (single provider size — nothing to vary).
     */
    function tmdbSrcset(url) {
        const m = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w\d+(\/.+)$/.exec(String(url || ''));
        if (!m) return '';
        return `${m[1]}w185${m[2]} 185w, ${m[1]}w342${m[2]} 342w, ${m[1]}w500${m[2]} 500w`;
    }

    /**
     * "New" flag: true when a title was added within the last `days` (default 14).
     * Reads the provider `added`/`added_at` field (Xtream unix-seconds or ISO).
     * Returns false when the timestamp is missing/unparseable — no false NEWs.
     */
    function isRecentlyAdded(item, days = 14) {
        const raw = item?.added ?? item?.added_at ?? item?.data?.added ?? item?.metadata?.added;
        if (!raw) return false;
        let ms = 0;
        const num = parseInt(raw, 10);
        if (!isNaN(num) && num > 0) ms = num < 10000000000 ? num * 1000 : num;
        else ms = Date.parse(raw) || 0;
        if (!ms) return false;
        const now = Date.now();
        return ms <= now && (now - ms) < days * 86400000;
    }

    // Skeleton placeholder cards for loading rails/grids — same 160px footprint as
    // a real card so swapping in real content doesn't shift the layout. The shimmer
    // and reduced-motion handling live in CSS (.skeleton).
    function skeletonCards(count = 8) {
        const card =
            '<div class="skeleton-card" aria-hidden="true">' +
            '<div class="skeleton skeleton-poster"></div>' +
            '<div class="skeleton skeleton-line"></div>' +
            '<div class="skeleton skeleton-line short"></div>' +
            '</div>';
        return card.repeat(Math.max(1, count));
    }

    // ---- Version buttons (Movie + Series fiches) ------------------------------------
    // A title's "versions" are usually the SAME film re-imported across a provider's
    // regional catalogue sections (EN/AR/FR/Nordic/Netflix…) and across providers. The
    // useful axes when choosing a copy are the MARKET (language/edition) and the PROVIDER;
    // container/quality are secondary. versionDescriptor returns a two-tier label —
    //   { headline, meta, badge, tier }
    // headline leads with the axis that actually DIFFERS across the title's versions
    // (market by default; the provider when the market is constant but the provider isn't),
    // meta carries the quiet constants (provider · container), quality rides as a badge,
    // fluidity as a colour dot. Market names reuse the app's languageDisplayFull (English,
    // consistent with the rest of the UI) plus a small map for the non-ISO IPTV tokens.
    const VERSION_TIERS = {
        direct:          { key: 'direct',    label: 'Lecture directe', cls: 'tier-direct' },
        remux:           { key: 'remux',     label: 'Remux',           cls: 'tier-remux' },
        video_transcode: { key: 'transcode', label: 'Transcode',       cls: 'tier-transcode' },
        transcode:       { key: 'transcode', label: 'Transcode',       cls: 'tier-transcode' }
    };

    // Non-ISO market/platform tokens seen in the live catalogue that languageDisplayFull /
    // REGION_PREFIX_LANG don't cover. English labels, to match the rest of the UI.
    const MARKET_LABELS = {
        // Nordic / Scandinavian bundles + individual Nordic languages
        // (keys must be <=5 chars — the leading-token parser caps there; NORDIC/SCANDI as
        //  a leading prefix are covered by the category-keyword path below.)
        SC: 'Nordic', SCA: 'Nordic', SCAN: 'Nordic', SCAND: 'Nordic',
        SE: 'Swedish', DK: 'Danish', NO: 'Norwegian', FI: 'Finnish', IS: 'Icelandic',
        // Streaming platforms used as catalogue sections
        NF: 'Netflix', NFLX: 'Netflix', AMZ: 'Prime Video', DSNP: 'Disney+', DSN: 'Disney+',
        HBO: 'HBO Max', ATV: 'Apple TV+', PRMT: 'Paramount+', PCK: 'Peacock', MULTI: 'Multi',
        // French / Latin-American variants
        QFR: 'French (QC)', FRQ: 'French (QC)', QC: 'French (QC)', LAT: 'Latino', LA: 'Latino',
        // Balkans / Central & Eastern Europe
        EXYU: 'Ex-YU', HR: 'Croatian', SR: 'Serbian', BG: 'Bulgarian', RO: 'Romanian',
        HU: 'Hungarian', CZ: 'Czech', SK: 'Slovak', UA: 'Ukrainian',
        // Middle East / Mediterranean
        IL: 'Hebrew', KU: 'Kurdish', KD: 'Kurdish', MT: 'Maltese', MA: 'Moroccan', EG: 'Egyptian',
        // South Asian (Indian regionals + neighbours)
        UR: 'Urdu', PK: 'Urdu', TA: 'Tamil', TL: 'Telugu', ML: 'Malayalam', KN: 'Kannada',
        MR: 'Marathi', BN: 'Bengali', PB: 'Punjabi', GU: 'Gujarati',
        // South-East Asia / Africa
        PH: 'Filipino', TH: 'Thai', VN: 'Vietnamese', ID: 'Indonesian',
        SO: 'Somali', SOM: 'Somali', SW: 'Swahili', AF: 'Afghan'
    };
    // Tokens that precede a separator but are noise (category/quality/title words), never a market.
    const MARKET_REJECT = new Set([
        'THE', 'AND', 'NEW', 'TOP', 'VOD', 'TV', 'PPV', 'LIVE', 'HD', 'FHD', 'UHD', 'SD',
        '4K', '8K', 'DOC', 'DOCU', 'EX', 'SOC', 'SPT', 'STH', 'UNV', 'PJ', 'TM', 'TG', 'AS', 'KA'
    ]);
    const BAR_SEPARATORS = /[▎▏▍▌│┃┆┊｜•·・]/g;

    function versionTierInfo(item = {}) {
        const raw = String(item.compatibilityTier || item.compatibility_tier || '').toLowerCase();
        return VERSION_TIERS[raw] || null; // 'unknown'/absent -> no dot
    }

    function versionQuality(item = {}) {
        return item.quality || parseVersionInfo(item.raw_title || item.rawTitle || item.name || item.title || '').quality || null;
    }

    function versionRawTitle(item = {}) {
        return String(item.raw_title || item.rawTitle || item.name || item.title || '');
    }

    function leadingMarketToken(src) {
        const m = String(src).match(/^\s*([A-Za-z]{2,5}(?:[-/][A-Za-z]{2,4})?)\s*[-–—|:/]/);
        return m ? m[1].toUpperCase() : '';
    }

    // Human market label from the category text — platform/bundle keywords only.
    function versionCategoryMarket(item = {}) {
        const cat = String(item.category_name || item.subtitle
            || (item.metadata && item.metadata.categoryName) || '').toLowerCase();
        if (!cat) return '';
        if (/multi.?sub|(^|[^a-z])multi([^a-z]|$)/.test(cat)) return 'Multi';
        if (/netflix|nflx/.test(cat)) return 'Netflix';
        if (/prime|amazon/.test(cat)) return 'Prime Video';
        if (/disney/.test(cat)) return 'Disney+';
        if (/paramount/.test(cat)) return 'Paramount+';
        if (/apple\s?tv/.test(cat)) return 'Apple TV+';
        if (/hbo|hbomax/.test(cat)) return 'HBO Max'; // 'hbo' only — bare 'max' is too generic
        if (/nordic|scandinav/.test(cat)) return 'Nordic';
        return '';
    }

    // The version's MARKET (language / regional edition), humanised. Priority: non-ISO
    // market map -> language via the existing region parser (+ sub/dub nuance) -> compound
    // primary segment -> category platform -> the raw token if plausible. Null when nothing.
    // Memoised per item object (pure w.r.t. the item; called ~2n times per rendered version).
    const _marketMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
    function versionMarket(item) {
        if (!item || typeof item !== 'object') return null;
        if (_marketMemo && _marketMemo.has(item)) return _marketMemo.get(item);
        const result = computeVersionMarket(item);
        if (_marketMemo) _marketMemo.set(item, result);
        return result;
    }
    function computeVersionMarket(item = {}) {
        const src = versionRawTitle(item).replace(BAR_SEPARATORS, ' - ');
        const tok = leadingMarketToken(src);
        if (tok && MARKET_LABELS[tok]) return { label: MARKET_LABELS[tok] };
        const tag = parseLeadingRegionTag(src);
        if (tag && tag.audioLang) {
            let label = languageDisplayFull(tag.audioLang);
            if (tag.hasSub && !tag.hasDub) label += ' · ST';
            return { label };
        }
        if (tok && tok.includes('-')) {
            const prim = tok.split('-')[0];
            if (MARKET_LABELS[prim] && !MARKET_REJECT.has(prim)) return { label: MARKET_LABELS[prim] };
        }
        const catMarket = versionCategoryMarket(item);
        if (catMarket) return { label: catMarket };
        if (tok && !MARKET_REJECT.has(tok)) return { label: tok };
        return null;
    }

    function resolveVersionProvider(item, resolve) {
        const src = item.sourceId != null ? item.sourceId : item.source_id;
        return (typeof resolve === 'function' && src != null) ? String(resolve(src) || '') : '';
    }

    // The raw provider category, lightly de-decorated ("|EN| DOCUMENTARY" -> "EN
    // DOCUMENTARY"), used as the last-resort differentiator for true duplicates.
    function versionCategoryLabel(item = {}) {
        const raw = item.category_name || item.subtitle
            || (item.metadata && item.metadata.categoryName) || '';
        const s = String(raw).replace(/[★|]/g, ' ').replace(/\s+/g, ' ').trim();
        return s.length > 24 ? `${s.slice(0, 23).trim()}…` : s;
    }

    // opts: { siblings: item[], index: number, resolveSourceName: (sourceId)=>string }
    // Returns { headline, meta, badge, tier }.
    function versionDescriptor(item = {}, opts = {}) {
        item = item || {};
        const index = opts.index || 0;
        const resolve = opts.resolveSourceName;
        const rawSiblings = (Array.isArray(opts.siblings) && opts.siblings.length) ? opts.siblings : [item];
        const siblings = rawSiblings.filter(s => s && typeof s === 'object');
        const tier = versionTierInfo(item);

        const market = versionMarket(item);
        const marketLabel = market ? market.label : '';
        const provider = resolveVersionProvider(item, resolve);
        const container = String(item.container_extension || item.containerExtension || '').toUpperCase();
        const quality = versionQuality(item);

        const distinct = (fn) => new Set(siblings.map(fn).map(v => String(v || '')).filter(Boolean));
        const marketVaries = distinct(it => { const m = versionMarket(it); return m ? m.label : ''; }).size > 1;
        const providerVaries = distinct(it => resolveVersionProvider(it, resolve)).size > 1;

        // Lead with whichever axis actually distinguishes the versions.
        let headline;
        let metaParts;
        if (marketLabel && (marketVaries || !providerVaries)) {
            headline = marketLabel;
            metaParts = [provider, container];
        } else if (provider) {
            headline = provider;
            metaParts = [marketLabel, container];
        } else {
            headline = marketLabel || quality || `Version ${index + 1}`;
            metaParts = [container];
        }
        const badge = (quality && quality !== headline) ? quality : '';
        // Demote constants, but never repeat the headline in the meta line (e.g. an "NF"
        // market whose provider is also literally named "Netflix").
        let meta = metaParts.filter(p => p && p !== headline).join(' · ');

        // Never two identical buttons: if market+provider+container+quality all match a
        // sibling, disambiguate with the raw provider category.
        const sigOf = (it) => {
            const m = versionMarket(it);
            return [
                m ? m.label : '',
                resolveVersionProvider(it, resolve),
                String(it.container_extension || it.containerExtension || '').toUpperCase(),
                versionQuality(it) || ''
            ].join('|');
        };
        const mySig = sigOf(item);
        const collides = siblings.length > 1 && siblings.filter(s => sigOf(s) === mySig).length > 1;
        if (collides) {
            const cat = versionCategoryLabel(item);
            if (cat && cat !== headline) meta = meta ? `${meta} · ${cat}` : cat;
        }

        return { headline, meta, badge, tier };
    }

    return {
        skeletonCards,
        stripDiacritics, extractYear, normalizeTitle, computeDedupKey, cleanReleaseName,
        parseVersionInfo, deriveTrackIntel, scanLanguageMarkers, parseLeadingRegionTag, searchableText, groupItems, pickRepresentative,
        normalizeLanguagePreference, normalizeContentPreferences, migrateLegacyLanguagePreference,
        resolveContentLanguage,
        normalizeGenrePreference, normalizeGenrePreferences, scoreGenrePreferences,
        analyzeLanguageCompatibility, scoreVersionLanguage, scoreTitleForPreferences,
        orderVersionsByPreference, versionLabel, versionLanguageBadge, audioLanguageBadge,
        versionDescriptor,
        saveFilters, loadFilters, escapeHtml, tmdbPosterUrl, parseDurationToSeconds,
        playbackHintFromItem, liveGatewayMode, safeImageUrl, downloadablePosterUrl,
        enhanceRailScroll, openTrailerLightbox, tmdbSrcset, isRecentlyAdded
    };
})();

window.MediaUtils = MediaUtils;
