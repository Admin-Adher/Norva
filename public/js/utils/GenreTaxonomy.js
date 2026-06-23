// Curated, mass-market genre taxonomy for Norva — BROWSER mirror of
// supabase/functions/_shared/genre-taxonomy.ts. Keep the two IN SYNC.
//
// Used client-side by:
//  - local (self-hosted hub) mode, to build genre rails from already-loaded
//    titles without a server round-trip;
//  - Manage Content, to group raw provider categories under genre headers.
(function () {
    'use strict';

    const BUCKETS = [
        { id: 'action', label: 'Action' },
        { id: 'aventure', label: 'Adventure' },
        { id: 'comedie', label: 'Comedy' },
        { id: 'drame', label: 'Drama' },
        { id: 'scifi', label: 'Sci-Fi & Fantasy' },
        { id: 'horreur', label: 'Horror' },
        { id: 'thriller', label: 'Thriller & Crime' },
        { id: 'romance', label: 'Romance' },
        { id: 'familial', label: 'Family' },
        { id: 'animation_kids', label: 'Kids Animation' },
        { id: 'animation_adult', label: 'Adult Animation' },
        { id: 'kdrama', label: 'K-Drama' },
        { id: 'telerealite', label: 'Reality TV' },
        { id: 'documentaires', label: 'Documentaries' },
        { id: 'arabe', label: 'Arabic' },
        { id: 'autres', label: 'Other' }
    ];
    const BUCKET_ORDER = BUCKETS.map((b) => b.id);
    const LABELS = {};
    BUCKETS.forEach((b) => { LABELS[b.id] = b.label; });

    function norm(value) {
        return String(value == null ? '' : value)
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
            .trim();
    }

    const TMDB_GENRE_TO_BUCKET = {
        'action': 'action', 'action adventure': 'action', 'war': 'action', 'war politics': 'action',
        'western': 'action', 'guerre': 'action',
        'adventure': 'aventure', 'aventure': 'aventure',
        'comedy': 'comedie', 'comedie': 'comedie',
        'drama': 'drame', 'drame': 'drame', 'history': 'drame', 'histoire': 'drame', 'soap': 'drame',
        'science fiction': 'scifi', 'sci fi fantasy': 'scifi', 'fantasy': 'scifi', 'fantastique': 'scifi',
        'horror': 'horreur', 'horreur': 'horreur',
        'thriller': 'thriller', 'crime': 'thriller', 'mystery': 'thriller', 'mystere': 'thriller',
        'romance': 'romance',
        'family': 'familial', 'familial': 'familial', 'kids': 'familial', 'music': 'familial',
        'musique': 'familial', 'tv movie': 'familial', 'telefilm': 'familial',
        'animation': 'animation_kids',
        'reality': 'telerealite',
        'documentary': 'documentaires', 'documentaire': 'documentaires'
    };

    function hasAny(haystack, needles) {
        for (let i = 0; i < needles.length; i++) if (haystack.indexOf(needles[i]) !== -1) return true;
        return false;
    }

    const ADULT_MARKERS = ['adulte', 'adult', 'mature', '18', 'ecchi', 'hentai', 'seinen', 'بالغين'];
    const ANIM_MARKERS = ['animation', 'anime', 'anim', 'dessin', 'cartoon', 'manga', 'رسوم', 'انمي', 'كرتون'];
    const KIDS_MARKERS = ['enfant', 'kids', 'kid', 'jeunesse', 'junior', 'disney', 'pixar', 'اطفال', 'طفال'];
    const KDRAMA_MARKERS = ['k drama', 'kdrama', 'korean', 'coreen', 'coreenne', 'coree', 'كوري'];
    const REALITY_MARKERS = ['reality', 'tele realite', 'telerealite', 'emission', 'real tv', 'الواقع'];
    const ARABIC_MARKERS = ['arabe', 'arabic', 'arab', 'algerien', 'egyptien', 'syrien', 'libanais', 'khaliji', 'ramadan'];

    function isArabicCategory(catN) {
        if (hasAny(catN, ARABIC_MARKERS)) return true;
        if (/^ar(\s|$)/.test(catN)) return true;
        if (/[\u0600-\u06ff]/.test(catN)) return true;
        return false;
    }
    const isAnimation = (catN) => hasAny(catN, ANIM_MARKERS);
    const isAdult = (catN) => hasAny(catN, ADULT_MARKERS);
    const isKids = (catN) => hasAny(catN, KIDS_MARKERS);
    const isKDrama = (catN) => hasAny(catN, KDRAMA_MARKERS);
    const isReality = (catN) => hasAny(catN, REALITY_MARKERS);

    const CATEGORY_GENRE_KEYWORDS = [
        [['horreur', 'horror', 'epouvante'], 'horreur'],
        [['thriller', 'policier', 'polar', 'suspense', 'crime'], 'thriller'],
        [['science fiction', 'sci fi', 'scifi', 'fantastique', 'fantasy'], 'scifi'],
        [['romance', 'romantique'], 'romance'],
        [['documentaire', 'documentary', 'docu'], 'documentaires'],
        [['comedie', 'comedy', 'humour'], 'comedie'],
        [['aventure', 'adventure'], 'aventure'],
        [['action', 'guerre'], 'action'],
        [['drame', 'drama'], 'drame'],
        [['familial', 'family', 'famille'], 'familial']
    ];

    function categoryGenreKeyword(catN) {
        for (let i = 0; i < CATEGORY_GENRE_KEYWORDS.length; i++) {
            if (hasAny(catN, CATEGORY_GENRE_KEYWORDS[i][0])) return CATEGORY_GENRE_KEYWORDS[i][1];
        }
        return null;
    }

    function coerceGenres(tmdbGenres) {
        if (!Array.isArray(tmdbGenres)) return [];
        return tmdbGenres
            .map((g) => (typeof g === 'string' ? g : (g && typeof g === 'object' ? String(g.name || '') : '')))
            .filter(Boolean);
    }

    // Every bucket a title belongs to (multi). Mirrors classifyTitleBuckets.
    function classifyTitle(categoryName, tmdbGenres) {
        const buckets = {};
        const add = (id) => { buckets[id] = true; };
        const catN = norm(categoryName);

        coerceGenres(tmdbGenres).forEach((g) => {
            const b = TMDB_GENRE_TO_BUCKET[norm(g)];
            if (b) add(b);
        });

        if (buckets.animation_kids && isAdult(catN)) {
            delete buckets.animation_kids;
            add('animation_adult');
        }

        if (isAnimation(catN)) add(isAdult(catN) && !isKids(catN) ? 'animation_adult' : 'animation_kids');
        if (isKDrama(catN)) add('kdrama');
        if (isReality(catN)) add('telerealite');
        if (isArabicCategory(catN)) add('arabe');
        const kw = categoryGenreKeyword(catN);
        if (kw) add(kw);

        const result = BUCKET_ORDER.filter((id) => buckets[id]);
        return result.length ? result : ['autres'];
    }

    // A single bucket for a provider CATEGORY (Manage Content). Mirrors
    // classifyCategoryBucket — prefers a real genre over a language grouping.
    function classifyCategory(categoryName) {
        const catN = norm(categoryName);
        if (isAnimation(catN)) return isAdult(catN) && !isKids(catN) ? 'animation_adult' : 'animation_kids';
        if (isKDrama(catN)) return 'kdrama';
        if (isReality(catN)) return 'telerealite';
        const kw = categoryGenreKeyword(catN);
        if (kw) return kw;
        if (isArabicCategory(catN)) return 'arabe';
        return 'autres';
    }

    function label(id) { return LABELS[id] || 'Other'; }

    // --- Hierarchical classification for Manage Content (frontend-only) ---
    // Maps a provider category to a theme → sub-category node, so Manage Content
    // can show a 2-3 level tree (theme header → sub-category group → provider
    // categories). The browse rails stay flat and don't use this.
    const THEME_LABELS = {
        genres: 'Genres', animation: 'Animation', entertainment: 'Entertainment',
        languages: 'Languages & Regions', platforms: 'Platforms', other: 'Other'
    };
    const THEME_ORDER = { genres: 0, animation: 1, entertainment: 2, languages: 3, platforms: 4, other: 5 };

    // Streaming networks/platforms detected from the category wording.
    const PLATFORMS = [
        [['apple tv', 'appletv'], 'apple_tv', 'Apple TV+'],
        [['netflix'], 'netflix', 'Netflix'],
        [['prime video', 'amazon prime', 'amazon'], 'prime', 'Prime Video'],
        [['disney'], 'disney', 'Disney+'],
        [['hbo'], 'hbo', 'HBO / Max'],
        [['paramount'], 'paramount', 'Paramount+'],
        [['hulu'], 'hulu', 'Hulu'],
        [['peacock'], 'peacock', 'Peacock'],
        [['canal plus', 'canal+'], 'canal', 'Canal+']
    ];
    function detectPlatform(catN) {
        for (let i = 0; i < PLATFORMS.length; i++) {
            if (hasAny(catN, PLATFORMS[i][0])) return { id: PLATFORMS[i][1], label: PLATFORMS[i][2], order: i };
        }
        return null;
    }

    function node(theme, subId, subLabel, subOrder) {
        return {
            theme: theme,
            themeLabel: THEME_LABELS[theme],
            themeOrder: THEME_ORDER[theme],
            subId: theme + ':' + subId,
            subLabel: subLabel,
            subOrder: subOrder || 0
        };
    }

    function classifyCategoryNode(categoryName) {
        const catN = norm(categoryName);

        // 1) Platform (Apple TV+, Netflix…) — wins, it's the most specific.
        const p = detectPlatform(catN);
        if (p) return node('platforms', 'platform_' + p.id, p.label, p.order);

        // 2) Animation → kids vs adult.
        if (isAnimation(catN)) {
            const adult = isAdult(catN) && !isKids(catN);
            return node('animation', adult ? 'adult' : 'kids', adult ? 'Adult Animation' : 'Kids Animation', adult ? 1 : 0);
        }

        // 3) Entertainment → reality vs TV shows.
        if (isReality(catN)) {
            const reality = hasAny(catN, ['reality', 'tele realite', 'telerealite', 'real tv', 'الواقع']);
            return node('entertainment', reality ? 'reality' : 'tvshows', reality ? 'Reality TV' : 'TV Shows', reality ? 0 : 1);
        }

        // 4) A real genre named in the category → Genres theme.
        const kw = categoryGenreKeyword(catN);
        if (kw) return node('genres', kw, label(kw), 0);

        // 5) Arabic / regional → Languages & Regions.
        if (isArabicCategory(catN)) return node('languages', 'arabic', 'Arabic Content', 0);

        // 6) Fallback.
        return node('other', 'other', 'Other', 0);
    }

    window.GenreTaxonomy = { BUCKETS, BUCKET_ORDER, classifyTitle, classifyCategory, classifyCategoryNode, label };
})();
