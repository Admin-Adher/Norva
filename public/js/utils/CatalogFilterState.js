/**
 * Pure catalogue filter-state normalization shared by Movies and Series.
 * Page controllers remain the adapters that read and write controls.
 */
(function exposeCatalogFilterState(root, factory) {
    const api = factory();
    if (root) root.CatalogFilterState = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function createCatalogFilterStateApi() {
    'use strict';

    function valueOr(value, fallback = '') {
        return value == null || value === '' ? fallback : value;
    }

    function unique(values) {
        return [...new Set((Array.isArray(values) ? values : []).filter(value => value != null && value !== ''))];
    }

    function create(input = {}) {
        const kind = input.kind === 'series' ? 'series' : 'movies';
        const selectedCategories = unique(input.selectedCategories);
        const pendingCategories = unique(input.pendingCategories);
        const categories = input.categoriesRestored === false && pendingCategories.length
            ? unique([...pendingCategories, ...selectedCategories])
            : selectedCategories;
        const genre = valueOr(input.liveGenre,
            input.genreHydrated === false ? valueOr(input.pendingGenre) : '');

        const state = {
            source: valueOr(input.source),
            sort: valueOr(input.sort, 'default'),
            genre,
            year: valueOr(input.year),
            rating: valueOr(input.rating),
            watched: valueOr(input.watched),
            added: valueOr(input.added),
        };
        if (kind === 'movies') state.duration = valueOr(input.duration);
        else state.status = valueOr(input.status);
        state.audio = valueOr(input.audio);
        state.subtitle = valueOr(input.subtitle);
        state.search = valueOr(input.search);
        state.group = Boolean(input.group);
        state.favoritesOnly = Boolean(input.favoritesOnly);
        state.categories = categories;
        return state;
    }

    function hasActive(state = {}) {
        return Boolean(
            (state.sort && state.sort !== 'default') ||
            state.genre || state.year || state.rating || state.watched || state.added ||
            state.duration || state.status || state.audio || state.subtitle ||
            state.search || state.favoritesOnly ||
            (Array.isArray(state.categories) && state.categories.length > 0)
        );
    }

    return Object.freeze({ create, hasActive });
});
