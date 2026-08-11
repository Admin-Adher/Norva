/**
 * Pure mapping from catalogue filter values to the existing server query contract.
 */
(function exposeCatalogQueryParams(root, factory) {
    const api = factory();
    if (root) root.CatalogQueryParams = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function createCatalogQueryParamsApi() {
    'use strict';

    function build(input = {}) {
        const params = {};
        if (input.source) params.source = input.source;
        if (input.audio) params.audio = input.audio;
        if (input.subtitle) params.subs = input.subtitle;
        if (input.year) params.year = input.year;
        if (input.rating) params.minRating = input.rating;
        if (input.added) params.addedDays = input.added;

        const sort = input.sort || '';
        if (sort && sort !== 'default') params.sort = sort;
        if (sort === 'lang-match') {
            const preferences = input.preferences || {};
            if (preferences.preferredAudioLanguage) {
                params.prefAudio = preferences.preferredAudioLanguage;
            }
            if (preferences.preferredSubtitleLanguage &&
                preferences.preferredSubtitleLanguage !== 'none') {
                params.prefSubs = preferences.preferredSubtitleLanguage;
            }
        }

        const search = String(input.search || '').trim();
        if (search) params.q = search;
        return params;
    }

    return Object.freeze({ build });
});
