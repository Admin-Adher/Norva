(async () => {
    const check = (value, message) => { if (!value) throw Error(message); };
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
        const nativeFetch = window.fetch.bind(window);
        const source = await (await nativeFetch('/js/app.js')).text();
        const App = new Function(source.slice(source.indexOf('class App {'), source.indexOf('// Admin dialogs are created')) + ';return App;')();
        const row = (sourceId, id, at, type = 'movie') => ({ source_id: sourceId, item_id: id,
            item_type: type, progress: 60, duration: 600, watched_at: at, updated_at: at,
            data: { title: `${type === 'movie' ? 'Film' : 'Série'} ${id}`, sourceId, seriesId: `series-${id}`, titleId: `title-${id}`, poster: '/img/norva-media-placeholder.png' } });
        let history = [row('1', 'A', '2026-09-24T10:00:00Z'), row('2', 'B', '2026-09-25T10:00:00Z'),
            row('1', 'C', '2026-09-24T10:00:00Z', 'episode'), row('2', 'D', '2026-09-25T10:00:00Z', 'episode')];
        window.fetch = async (url, options = {}) => {
            if (!String(url).startsWith('/api/history')) return nativeFetch(url, options);
            if (options.method === 'POST') {
                const update = JSON.parse(options.body);
                history = history.map(item => item.item_id === update.id && item.source_id === update.sourceId
                    ? { ...item, progress: update.progress, watched_at: update.watchedAt, updated_at: update.watchedAt } : item);
                return new Response(JSON.stringify({ success: true }), { headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify(history), { headers: { 'content-type': 'application/json' } });
        };
        const app = Object.create(App.prototype);
        Object.assign(app, { currentPage: 'movies', currentUser: { id: 'fixture' }, pages: { home: { lastLoadedAt: 0 } } });
        const select = document.getElementById('proof-source');
        const movie = Object.create(MoviesPage.prototype), series = Object.create(SeriesPage.prototype);
        for (const [page, id] of [[movie, 'movie'], [series, 'series']]) {
            Object.assign(page, { app, sources: [{ id: '1' }, { id: '2' }], historyItems: history,
                sourceSelect: select, _watchStateRequestId: 0, startedSeriesIds: new Set(), watchState: new Map(),
                continueRow: document.getElementById(`proof-${id === 'movie' ? 'movies' : 'series'}`),
                continueList: document.getElementById(`proof-${id}-list`),
                updateContinueCompact() {}, _isTvMode: () => false, syncCurrentMovieWatchUi() {}, repaintEpisodeWatchState() {} });
            page.renderContinueWatching();
        }
        app.pages.movies = movie; app.pages.series = series; window.app = app;
        const first = page => page.continueList.firstElementChild;
        check(first(movie).dataset.itemId === 'B', 'Movie recency');
        check(first(series).dataset.historyKey.includes('D'), 'Episode recency');
        select.value = '1'; movie.renderContinueWatching(); series.renderContinueWatching();
        check(movie.continueList.children.length === 1 && first(movie).dataset.sourceId === '1', 'Movie source isolation');
        check(series.continueList.children.length === 1 && first(series).dataset.historyKey.startsWith('1:'), 'Series source isolation');
        select.value = '3'; movie.renderContinueWatching(); series.renderContinueWatching();
        check(movie.continueRow.classList.contains('hidden') && series.continueRow.classList.contains('hidden'), 'Empty source');
        select.value = ''; movie.renderContinueWatching(); series.renderContinueWatching();
        const focused = movie.continueList.children[1]; focused.focus();
        history = history.map(item => item.item_id === 'A' ? { ...item, progress: 61 } : item);
        movie.historyItems = history; movie.renderContinueWatching();
        check(document.activeElement.dataset.itemId === 'A', 'Focus retained after progress repaint');
        document.activeElement.blur();
        app.installHistoryRefreshListeners();
        window.__norvaNative.onProgress('1', 'movie', 'A', 120, 600, Date.now());
        for (let i = 0; i < 40 && first(movie).dataset.itemId !== 'A'; i++) await pause(100);
        check(first(movie).dataset.itemId === 'A', 'Native exit save moves latest title first');
        check(movie.continueList.scrollLeft === 0, 'Latest title visible at rail start');
        // Same endpoint used by the web player, then an episode return.
        app.currentPage = 'series';
        await API.request('POST', '/history', { id: 'C', sourceId: '1', type: 'episode', progress: 120, watchedAt: new Date().toISOString() });
        for (let i = 0; i < 40 && !first(series).dataset.historyKey.includes('C'); i++) await pause(100);
        check(first(series).dataset.historyKey.includes('C'), 'Web episode save moves latest episode first');
        select.addEventListener('change', () => { movie.renderContinueWatching(); series.renderContinueWatching(); });
        window.continueWatchingProof = { passed: true, checks: 10 };
        document.getElementById('proof-status').textContent = '10 vérifications réussies : ordre, sources, focus, retour Android et sauvegarde web.';
    } catch (error) {
        window.continueWatchingProof = { passed: false, error: String(error) };
        document.getElementById('proof-status').textContent = String(error);
    }
})();
