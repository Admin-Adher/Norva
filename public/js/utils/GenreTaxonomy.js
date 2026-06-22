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
        { id: 'aventure', label: 'Aventure' },
        { id: 'comedie', label: 'Comédie' },
        { id: 'drame', label: 'Drame' },
        { id: 'scifi', label: 'Science-fiction & Fantastique' },
        { id: 'horreur', label: 'Horreur' },
        { id: 'thriller', label: 'Thriller & Policier' },
        { id: 'romance', label: 'Romance' },
        { id: 'familial', label: 'Familial' },
        { id: 'animation_kids', label: 'Dessins animés (enfants)' },
        { id: 'animation_adult', label: 'Animation (adultes)' },
        { id: 'kdrama', label: 'K-Drama' },
        { id: 'telerealite', label: 'Téléréalité' },
        { id: 'documentaires', label: 'Documentaires' },
        { id: 'arabe', label: 'Films & séries arabes' },
        { id: 'autres', label: 'Autres' }
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

    function label(id) { return LABELS[id] || 'Autres'; }

    window.GenreTaxonomy = { BUCKETS, BUCKET_ORDER, classifyTitle, classifyCategory, label };
})();
