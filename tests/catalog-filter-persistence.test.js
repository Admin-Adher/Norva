'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function fakeClassList() {
    const values = new Set();
    return {
        add: (...names) => names.forEach(name => values.add(name)),
        remove: (...names) => names.forEach(name => values.delete(name)),
        toggle: (name, force) => {
            if (force === true) values.add(name);
            else if (force === false) values.delete(name);
            else if (values.has(name)) values.delete(name);
            else values.add(name);
        },
        contains: (name) => values.has(name)
    };
}

function loadPage(relativePath, className) {
    const saves = [];
    const favoriteButton = { classList: fakeClassList() };
    const context = {
        window: {},
        document: {
            getElementById: () => favoriteButton
        },
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        MediaUtils: {
            escapeHtml: (value) => String(value),
            saveFilters: (pageKey, filters) => saves.push({
                pageKey,
                filters: JSON.parse(JSON.stringify(filters))
            })
        }
    };
    vm.runInNewContext(read(relativePath), context, { filename: relativePath });
    return { Page: context.window[className], saves, context, favoriteButton };
}

class FakeSelect {
    constructor(html = '<option value="">Any</option>') {
        this._innerHTML = '';
        this._value = '';
        this.options = [];
        this.classList = fakeClassList();
        this.innerHTML = html;
    }

    get innerHTML() {
        return this._innerHTML;
    }

    set innerHTML(html) {
        this._innerHTML = html;
        this.options = [];
        const optionPattern = /<option value="([^"]*)">([^<]*)<\/option>/g;
        let match;
        while ((match = optionPattern.exec(html))) {
            this.options.push({ value: match[1], text: match[2] });
        }
        this.value = this.options[0]?.value || '';
    }

    get value() {
        return this._value;
    }

    set value(value) {
        const next = String(value ?? '');
        this._value = this.options.some(option => option.value === next) ? next : '';
    }
}

function controlsFor(pageType) {
    const controls = {
        sortSelect: { value: 'year' },
        genreSelect: { value: 'Drama' },
        yearSelect: { value: '2020' },
        ratingSelect: { value: '7' },
        watchedSelect: { value: 'inprogress' },
        addedSelect: { value: '30' },
        audioSelect: { value: 'fr' },
        subtitleSelect: { value: 'en' },
        searchInput: { value: 'dante' },
        groupDuplicates: false,
        showFavoritesOnly: true,
        categoryMulti: { getSelected: () => new Set(['drame']) }
    };
    if (pageType === 'movies') controls.durationSelect = { value: '120' };
    else controls.statusSelect = { value: 'ongoing' };
    return controls;
}

for (const spec of [
    {
        key: 'movies',
        file: 'public/js/pages/MoviesPage.js',
        className: 'MoviesPage'
    },
    {
        key: 'series',
        file: 'public/js/pages/SeriesPage.js',
        className: 'SeriesPage'
    }
]) {
    test(`${spec.className} restores saved language after async facets arrive`, () => {
        const { Page } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        const audio = new FakeSelect('<option value="">Any Audio</option>');
        const facets = [
            { value: 'en', label: 'English' },
            { value: 'fr', label: 'French' }
        ];

        page.applyFacetOptions(audio, 'Any Audio', facets, 'fr');
        assert.equal(audio.value, 'fr');

        // The same facet payload can be reused after a hard-refresh restore.
        audio.value = '';
        page.applyFacetOptions(audio, 'Any Audio', facets, 'fr');
        assert.equal(audio.value, 'fr');
    });

    test(`${spec.className} keeps the current language over an older saved value`, () => {
        const { Page } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        const audio = new FakeSelect(
            '<option value="">Any Audio</option>' +
            '<option value="en">English (old count)</option>' +
            '<option value="fr">French (old count)</option>'
        );
        audio.value = 'en';

        page.applyFacetOptions(audio, 'Any Audio', [
            { value: 'en', label: 'English' },
            { value: 'fr', label: 'French' }
        ], 'fr');

        assert.equal(audio.value, 'en');
    });

    test(`${spec.className} keeps every hydrated language while a facet refresh is pending`, () => {
        const { Page } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        const audio = new FakeSelect(
            '<option value="">Any Audio</option>' +
            '<option value="en">English</option>' +
            '<option value="fr">French</option>'
        );
        audio.value = 'fr';
        const before = audio.innerHTML;

        page.applyFacetOptions(audio, 'Any Audio', [], 'fr');

        assert.equal(audio.value, 'fr');
        assert.equal(audio.innerHTML, before);
        assert.deepEqual(audio.options.map(option => option.value), ['', 'en', 'fr']);
    });

    test(`${spec.className} wires both saved audio and subtitles through facet loading`, async () => {
        const { Page, context } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        page.audioSelect = new FakeSelect('<option value="">Any Audio</option>');
        page.subtitleSelect = new FakeSelect('<option value="">Any Subtitles</option>');
        page.savedFilters = { audio: 'fr', subtitle: 'en' };
        page.isCloudPagedMode = () => true;
        context.API = {
            media: {
                languageFacets: async () => ({
                    audio: [{ value: 'fr', label: 'French' }],
                    subtitles: [{ value: 'en', label: 'English' }]
                })
            }
        };

        await page.populateLanguageFacets();

        assert.equal(page.audioSelect.value, 'fr');
        assert.equal(page.subtitleSelect.value, 'en');
    });

    test(`${spec.className} restores every static control and toggle`, () => {
        const { Page, favoriteButton } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        Object.assign(page, {
            savedFilters: {
                sort: 'year',
                year: '2020',
                rating: '7',
                watched: 'inprogress',
                added: '30',
                duration: '120',
                status: 'ongoing',
                audio: 'fr',
                subtitle: 'en',
                search: 'dante'
            },
            sortSelect: { value: 'default' },
            yearSelect: { value: '' },
            ratingSelect: { value: '' },
            watchedSelect: { value: '' },
            addedSelect: { value: '' },
            durationSelect: { value: '' },
            statusSelect: { value: '' },
            audioSelect: { value: '' },
            subtitleSelect: { value: '' },
            searchInput: { value: '' },
            groupDuplicates: false,
            showFavoritesOnly: true,
            groupToggleBtn: { classList: fakeClassList() }
        });

        page.applyFiltersToUI();

        assert.equal(page.sortSelect.value, 'year');
        assert.equal(page.yearSelect.value, '2020');
        assert.equal(page.ratingSelect.value, '7');
        assert.equal(page.watchedSelect.value, 'inprogress');
        assert.equal(page.addedSelect.value, '30');
        assert.equal(page.audioSelect.value, 'fr');
        assert.equal(page.subtitleSelect.value, 'en');
        assert.equal(page.searchInput.value, 'dante');
        assert.equal(page.groupToggleBtn.classList.contains('active'), false);
        assert.equal(favoriteButton.classList.contains('active'), true);
        if (spec.key === 'movies') assert.equal(page.durationSelect.value, '120');
        else assert.equal(page.statusSelect.value, 'ongoing');
    });

    test(`${spec.className} persists the complete content-filter state and refreshes its snapshot`, () => {
        const { Page, saves } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        Object.assign(page, controlsFor(spec.key));

        page.persistFilters();

        assert.equal(saves.length, 1);
        assert.equal(saves[0].pageKey, spec.key);
        assert.equal(saves[0].filters.audio, 'fr');
        assert.equal(saves[0].filters.subtitle, 'en');
        assert.deepEqual(saves[0].filters.categories, ['drame']);
        assert.deepEqual(JSON.parse(JSON.stringify(page.savedFilters)), saves[0].filters);
    });

    test(`${spec.className} keeps missing saved categories provisional until a complete response`, () => {
        const { Page, saves } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        page.savedFilters = {
            categories: ['drame', 'deleted-category']
        };
        let options = [{ value: 'drame' }, { value: 'action' }];
        let selected = new Set();
        page.categoryMulti = {
            options,
            setOptions: (values) => {
                options = values;
                page.categoryMulti.options = values;
                const available = new Set(values.map(value => value.value));
                selected = new Set([...selected].filter(value => available.has(value)));
            },
            setSelected: (values) => {
                const available = new Set(options.map(value => value.value));
                selected = new Set(values.filter(value => available.has(value)));
            },
            getSelected: () => new Set(selected)
        };

        page.restoreSavedCategories(options);

        assert.deepEqual([...selected], ['drame', 'deleted-category']);
        assert.equal(page._categoriesRestored, false);
        assert.deepEqual(
            JSON.parse(JSON.stringify(page.savedFilters.categories)),
            ['drame', 'deleted-category']
        );
        assert.equal(saves.length, 0);

        const complete = [
            { value: 'drame' },
            { value: 'action' },
            { value: 'deleted-category' }
        ];
        page.categoryMulti.setOptions(complete);
        page.restoreSavedCategories(complete);
        assert.deepEqual([...selected], ['drame', 'deleted-category']);
        assert.equal(page._categoriesRestored, true);
    });

    test(`${spec.className} treats a pending dynamic genre as an active filter`, () => {
        const { Page } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        Object.assign(page, controlsFor(spec.key), {
            sortSelect: { value: 'default' },
            genreSelect: { value: '' },
            yearSelect: { value: '' },
            ratingSelect: { value: '' },
            watchedSelect: { value: '' },
            addedSelect: { value: '' },
            audioSelect: { value: '' },
            subtitleSelect: { value: '' },
            searchInput: { value: '' },
            showFavoritesOnly: false,
            savedFilters: {}
        });
        if (spec.key === 'movies') page.durationSelect = { value: '' };
        else page.statusSelect = { value: '' };
        page.categoryMulti = { getSelected: () => new Set() };

        page.savedFilters.genre = 'Drama';
        page._genreFilterHydrated = false;
        assert.equal(page.hasActiveFilters(), true);
        page._genreFilterHydrated = true;
        assert.equal(page.hasActiveFilters(), false);
    });

    test(`${spec.className} preserves a saved language while its facet request is pending`, async () => {
        const { Page, context, saves } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        let resolveFacets;
        context.API = {
            media: {
                languageFacets: () => new Promise(resolve => { resolveFacets = resolve; })
            }
        };
        Object.assign(page, controlsFor(spec.key), {
            audioSelect: new FakeSelect('<option value="">Any Audio</option>'),
            subtitleSelect: new FakeSelect('<option value="">Any Subtitles</option>'),
            savedFilters: { audio: 'fr', subtitle: '' },
            isCloudPagedMode: () => true
        });

        const pending = page.populateLanguageFacets();
        assert.equal(page.audioSelect.value, 'fr');
        page.sortSelect.value = 'rating';
        page.persistFilters();
        assert.equal(saves.at(-1).filters.audio, 'fr');
        resolveFacets({ audio: [], subtitles: [] });
        await pending;
        assert.equal(page.audioSelect.value, 'fr');
    });

    test(`${spec.className} preserves dynamic genre and categories during initial hydration`, () => {
        const { Page, saves } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        Object.assign(page, controlsFor(spec.key), {
            savedFilters: { genre: 'Drama', categories: ['drame'] },
            genreSelect: { value: '' },
            categoryMulti: { getSelected: () => new Set() },
            _genreFilterHydrated: false,
            _categoriesRestored: false
        });

        page.persistFilters();
        assert.equal(saves.at(-1).filters.genre, 'Drama');
        assert.deepEqual(saves.at(-1).filters.categories, ['drame']);

        page.genreSelect.value = '';
        page._genreFilterHydrated = true;
        page._categoriesRestored = true;
        page.persistFilters();
        assert.equal(saves.at(-1).filters.genre, '');
        assert.deepEqual(saves.at(-1).filters.categories, []);
    });

    test(`${spec.className} routes a provisionally restored language to the filtered grid`, () => {
        const { Page, context } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        context.window.GenreRails = {};
        Object.assign(page, {
            savedFilters: { audio: 'fr' },
            audioSelect: new FakeSelect('<option value="">Any Audio</option>'),
            subtitleSelect: new FakeSelect('<option value="">Any Subtitles</option>'),
            sortSelect: { value: 'default' },
            genreSelect: { value: '' },
            yearSelect: { value: '' },
            ratingSelect: { value: '' },
            watchedSelect: { value: '' },
            addedSelect: { value: '' },
            searchInput: { value: '' },
            showFavoritesOnly: false,
            categoryMulti: { getSelected: () => new Set() },
            isCloudPagedMode: () => true,
            _isTvMode: () => false
        });
        if (spec.key === 'movies') page.durationSelect = { value: '' };
        else page.statusSelect = { value: '' };

        page.applyFacetOptions(page.audioSelect, 'Any Audio', [], 'fr');

        assert.equal(page.audioSelect.value, 'fr');
        assert.equal(page.isLanguageFilterActive(), true);
        assert.equal(page.shouldShowRails(), false);
    });

    test(`${spec.className} Clear all cannot resurrect pending dynamic filters`, () => {
        const { Page, saves } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        const emptySelect = () => ({
            value: '',
            querySelector: () => ({ value: '' })
        });
        Object.assign(page, {
            savedFilters: { genre: 'Drama', categories: ['drame'], audio: 'fr' },
            sortSelect: { value: 'year', querySelector: () => ({ value: 'default' }) },
            genreSelect: emptySelect(),
            yearSelect: emptySelect(),
            ratingSelect: emptySelect(),
            watchedSelect: emptySelect(),
            addedSelect: emptySelect(),
            audioSelect: { value: 'fr', querySelector: () => ({ value: '' }) },
            subtitleSelect: emptySelect(),
            searchInput: { value: 'dante' },
            showFavoritesOnly: true,
            groupDuplicates: true,
            categoryMulti: {
                selected: new Set(['drame']),
                setSelected(values) { this.selected = new Set(values); },
                getSelected() { return new Set(this.selected); }
            },
            onFiltersChanged: Page.prototype.onFiltersChanged,
            renderActiveFilterChips: () => {},
            isCloudPagedMode: () => false,
            shouldShowRails: () => false,
            filterAndRender: () => {}
        });
        if (spec.key === 'movies') page.durationSelect = emptySelect();
        else page.statusSelect = emptySelect();

        page.resetFilters();

        const saved = saves.at(-1).filters;
        assert.equal(page._genreFilterHydrated, true);
        assert.equal(page._categoriesRestored, true);
        assert.equal(saved.genre, '');
        assert.deepEqual(saved.categories, []);
        assert.equal(saved.audio, '');
        assert.equal(saved.search, '');
    });

    test(`${spec.className} Back clears a provisionally restored category permanently`, () => {
        const { Page, saves } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        Object.assign(page, controlsFor(spec.key), {
            activeBucket: 'drame',
            activeBucketLangKey: 'pending',
            savedFilters: { categories: ['drame'] },
            _genreFilterHydrated: true,
            _categoriesRestored: false,
            categoryMulti: {
                selected: new Set(['drame']),
                setSelected(values) { this.selected = new Set(values); },
                getSelected() { return new Set(this.selected); }
            },
            bucketObserver: { disconnect: () => {} },
            onFiltersChanged() { this.persistFilters(); }
        });

        page.closeBucket();

        assert.equal(page._categoriesRestored, true);
        assert.deepEqual(saves.at(-1).filters.categories, []);
    });

    test(`${spec.className} forwards restored Newest and language filters together`, () => {
        const { Page } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        Object.assign(page, {
            sourceSelect: { value: '' },
            audioSelect: { value: 'fr' },
            subtitleSelect: { value: '' },
            yearSelect: { value: '' },
            ratingSelect: { value: '' },
            addedSelect: { value: '' },
            sortSelect: { value: 'year' },
            searchInput: { value: '' },
            _isTvMode: () => false
        });

        const params = page.currentLanguageParams();

        assert.equal(params.audio, 'fr');
        assert.equal(params.sort, 'year');
    });

    test(`${spec.className} forwards restored Recently Added with a language filter`, () => {
        const { Page } = loadPage(spec.file, spec.className);
        const page = Object.create(Page.prototype);
        Object.assign(page, {
            sourceSelect: { value: '' },
            audioSelect: { value: 'fr' },
            subtitleSelect: { value: '' },
            yearSelect: { value: '' },
            ratingSelect: { value: '' },
            addedSelect: { value: '30' },
            sortSelect: { value: 'added' },
            searchInput: { value: '' },
            _isTvMode: () => false
        });

        const params = page.currentLanguageParams();

        assert.equal(params.audio, 'fr');
        assert.equal(params.sort, 'added');
        assert.equal(params.addedDays, '30');
    });
}

test('MoviesPage persists and restores the selected provider scope', () => {
    const { Page, saves } = loadPage('public/js/pages/MoviesPage.js', 'MoviesPage');
    const page = Object.create(Page.prototype);
    Object.assign(page, {
        sourceSelect: new FakeSelect(
            '<option value="">All Sources</option>' +
            '<option value="900001">AtlasPro</option>'
        ),
        savedFilters: {},
        categoryMulti: { getSelected: () => new Set() },
        groupDuplicates: true,
        showFavoritesOnly: false,
        _genreFilterHydrated: true,
        _categoriesRestored: true
    });
    page.sourceSelect.value = '900001';

    page.persistFilters();
    assert.equal(saves.at(-1).filters.source, '900001');

    page.sourceSelect.value = '';
    page.savedFilters = saves.at(-1).filters;
    page.applyFiltersToUI();
    assert.equal(page.sourceSelect.value, '900001');
});

test('MoviesPage sends all selected categories as one OR bucket', () => {
    const { Page, context } = loadPage('public/js/pages/MoviesPage.js', 'MoviesPage');
    context.window.GenreTaxonomy = {
        label: (bucket) => ({ action: 'Action', drame: 'Drama' }[bucket] || bucket)
    };
    const page = Object.create(Page.prototype);
    let opened;
    Object.assign(page, {
        currentBucketViewKey: () => 'filters',
        openBucket: (rail) => { opened = rail; }
    });

    page.openGenreBucket(['action', 'drame', 'action']);

    assert.equal(opened.curation.bucket, 'action,drame');
    assert.equal(opened.title, 'Action + Drama');
});

test('MoviesPage routes cloud TV categories through genre-items', () => {
    const { Page } = loadPage('public/js/pages/MoviesPage.js', 'MoviesPage');
    const page = Object.create(Page.prototype);
    let opened;
    Object.assign(page, {
        categoryMulti: { getSelected: () => new Set(['action', 'drame']) },
        persistFilters: () => {},
        renderActiveFilterChips: () => {},
        isCloudPagedMode: () => true,
        _isTvMode: () => true,
        openGenreBucket: (buckets) => { opened = [...buckets]; },
        isLanguageFilterActive: () => false
    });

    page.onFiltersChanged();
    assert.deepEqual(opened, ['action', 'drame']);
});

test('MoviesPage scopes cloud categories and removes hidden profile genres', async () => {
    const { Page, context, saves } = loadPage('public/js/pages/MoviesPage.js', 'MoviesPage');
    let request;
    context.API = {
        media: {
            genreSummary: async (params) => {
                request = params;
                return {
                    hidden: ['horreur'],
                    genres: [
                        { bucket: 'horreur', label: 'Horror', count: 42 },
                        { bucket: 'jeunesse', label: 'Kids', count: 21, hidden: true },
                        { bucket: 'action', label: 'Action', count: 10 }
                    ]
                };
            }
        }
    };
    const page = Object.create(Page.prototype);
    let options = [];
    Object.assign(page, {
        sourceSelect: { value: '900001' },
        sources: [{ id: 900001, cloudId: '11111111-1111-4111-8111-111111111111' }],
        savedFilters: { categories: ['horreur', 'jeunesse', 'action'] },
        categoryMulti: { setOptions: (next) => { options = next; } },
        restoreSavedCategories: () => {}
    });

    await page.loadCloudCategories();

    assert.deepEqual(JSON.parse(JSON.stringify(request)), {
        type: 'movie',
        source: '11111111-1111-4111-8111-111111111111'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(options)), [
        { value: 'action', label: 'Action · 10' }
    ]);
    assert.deepEqual(page.savedFilters.categories, ['action']);
    assert.deepEqual(saves.at(-1).filters.categories, ['action']);
});

test('MoviesPage forwards the selected provider to genre item queries', () => {
    const { Page } = loadPage('public/js/pages/MoviesPage.js', 'MoviesPage');
    const page = Object.create(Page.prototype);
    Object.assign(page, {
        sourceSelect: { value: '900001' },
        sources: [{ id: 900001, cloudId: '11111111-1111-4111-8111-111111111111' }],
        audioSelect: { value: '' },
        subtitleSelect: { value: '' },
        yearSelect: { value: '' },
        ratingSelect: { value: '' },
        addedSelect: { value: '' },
        sortSelect: { value: 'default' },
        searchInput: { value: '' }
    });

    assert.deepEqual(JSON.parse(JSON.stringify(page.currentLanguageParams())), {
        source: '11111111-1111-4111-8111-111111111111'
    });
});

test('SeriesPage forwards the selected cloud provider using the catalog source parameter', () => {
    const { Page } = loadPage('public/js/pages/SeriesPage.js', 'SeriesPage');
    const page = Object.create(Page.prototype);
    Object.assign(page, {
        sourceSelect: { value: '900001' },
        sources: [{ id: 900001, cloudId: '11111111-1111-4111-8111-111111111111' }],
        audioSelect: { value: 'fr' },
        subtitleSelect: { value: '' },
        yearSelect: { value: '' },
        ratingSelect: { value: '' },
        addedSelect: { value: '' },
        sortSelect: { value: 'default' },
        searchInput: { value: '' }
    });

    assert.deepEqual(JSON.parse(JSON.stringify(page.currentLanguageParams())), {
        source: '11111111-1111-4111-8111-111111111111',
        audio: 'fr'
    });
    assert.equal(page.currentLanguageParams().sourceId, undefined);
});

test('SeriesPage keeps an already-cloud source UUID unchanged', () => {
    const { Page } = loadPage('public/js/pages/SeriesPage.js', 'SeriesPage');
    const page = Object.create(Page.prototype);
    Object.assign(page, {
        sourceSelect: { value: '22222222-2222-4222-8222-222222222222' },
        sources: [],
        audioSelect: { value: '' },
        subtitleSelect: { value: '' },
        yearSelect: { value: '' },
        ratingSelect: { value: '' },
        addedSelect: { value: '' },
        sortSelect: { value: 'default' },
        searchInput: { value: '' }
    });

    assert.deepEqual(JSON.parse(JSON.stringify(page.currentLanguageParams())), {
        source: '22222222-2222-4222-8222-222222222222'
    });
});

test('MoviesPage flat TV params never reinterpret a genre bucket as a source id', () => {
    const { Page } = loadPage('public/js/pages/MoviesPage.js', 'MoviesPage');
    const page = Object.create(Page.prototype);
    Object.assign(page, {
        categoryMulti: { getSelected: () => new Set(['action']) },
        sourceSelect: { value: '' },
        sortSelect: { value: 'default' },
        searchInput: { value: '' },
        yearSelect: { value: '' },
        ratingSelect: { value: '' },
        addedSelect: { value: '' },
        audioSelect: { value: '' },
        subtitleSelect: { value: '' },
        cloudPageSize: 120,
        _isTvMode: () => true
    });

    const params = page.cloudPageParams(0);
    assert.equal(params.sourceId, '');
    assert.equal(params.categoryId, '');
});

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key)
    };
}

function loadMediaUtils(storage) {
    const window = {};
    // mediaUtils is a browser IIFE. Supplying localStorage as a lexical binding
    // lets the persistence helpers run without a browser test dependency.
    const factory = new Function('window', 'localStorage', `${read('public/js/utils/mediaUtils.js')}\nreturn window.MediaUtils;`);
    return factory(window, storage);
}

test('catalog filters are isolated by cloud account', () => {
    const storage = createStorage({
        'norva-cloud-session': JSON.stringify({ user: { id: 'account-a' } })
    });
    const MediaUtils = loadMediaUtils(storage);

    MediaUtils.saveFilters('movies', { audio: 'fr' });
    storage.setItem('norva-cloud-session', JSON.stringify({ user: { id: 'account-b' } }));
    assert.equal(MediaUtils.loadFilters('movies'), null);
    MediaUtils.saveFilters('movies', { audio: 'en' });

    storage.setItem('norva-cloud-session', JSON.stringify({ user: { id: 'account-a' } }));
    assert.deepEqual(MediaUtils.loadFilters('movies'), { audio: 'fr' });
});

test('legacy browser-global filters migrate once into the signed-in account', () => {
    const storage = createStorage({
        'norva-cloud-session': JSON.stringify({ user: { id: 'account-a' } }),
        'norva-filters-series': JSON.stringify({ year: '2020', audio: 'fr' })
    });
    const MediaUtils = loadMediaUtils(storage);

    assert.deepEqual(MediaUtils.loadFilters('series'), { year: '2020', audio: 'fr' });
    assert.equal(storage.getItem('norva-filters-series'), null);
    assert.equal(
        storage.getItem('norva-filters-v2-user-account-a-series'),
        JSON.stringify({ year: '2020', audio: 'fr' })
    );
});
