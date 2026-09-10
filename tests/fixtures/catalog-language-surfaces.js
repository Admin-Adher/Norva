/* Offline acceptance: real page renderers and app detail markup, synthetic metadata only. */
window.CatalogLanguageQA = (() => {
    const poster = '/img/norva-media-placeholder.png';
    const definitions = [
        ['Bandit', 'AL ▎PRIME VIDEO', 'sq'],
        ['Japan Malayalam Dubbed 2023', 'ASIA ▎MALAYALAM DUBBED', 'ml'],
        ['AR ▎ Example Film', 'AR ▎FOREIGN', 'fr'],
        ['Example Nordic', 'SCANDINAVIA', 'nordic'],
        ['Example Unlabelled', '', null]
    ];
    let surface, items, chosen, controller, appMarkup;
    const noop = () => {};
    function records(kind) {
        return definitions.map(([name, category, expected], index) => ({
            id: `surface-${index}`, stream_id: String(index), series_id: String(index), sourceId: 'qa-source',
            item_type: kind, name, title: name, raw_title: name, category_name: category,
            metadata: {categoryName:category}, cover:poster, stream_icon:poster, poster_url:poster,
            expected, audio_language_validation_status:index === 2 ? 'probed' : 'not_analyzed',
            audio_tracks_scope:'file', audio_tracks:index === 2 ? [{index:1,lang:'fr'}] : [],
            audio_probed_at:index === 2 ? '2026-09-10T10:00:00Z' : null
        }));
    }
    function page(kind, host) {
        const page = Object.create(kind === 'movie' ? MoviesPage.prototype : SeriesPage.prototype);
        Object.assign(page, {
            pageEl:host, container:document.getElementById('qa-grid'), favoriteIds:new Set(),
            getPreferences:() => ({}), _isTvMode:() => false, isBrokenItem:() => false,
            getItemYear:() => '', getMovieRatingText:() => '', getSeriesRatingText:() => '',
            getWatchStatus:() => ({status:'unwatched'}), getMovieWatchState:() => ({status:'unwatched'}),
            isGroupStarted:() => false, cleanMovieTitle:name => name, groupDuplicates:false,
            getMovieDisplayTitle:item => item.name, getSeriesDisplayTitle:item => item.name,
            getMoviePoster:() => poster, getSeriesPoster:() => poster,
            getMovieBackdrop:() => '', getSeriesBackdrop:() => '',
            getMovieOverview:() => '', getSeriesOverview:() => '',
            getMovieDuration:() => '', getMovieGenres:() => [], getSeriesGenres:() => [], getSeriesYear:() => '',
            getCategoryName:item => item.category_name, beginFicheIntent:() => 1, isFicheIntentCurrent:() => true,
            syncDetailFavoriteButton:noop, syncDownloadButton:noop, loadRating:noop,
            renderMoreLikeThis:noop, renderFicheExtras:noop, cancelNextEpisodePrompt:noop,
            _ensureTvEpisodeCount:() => null, hasAlternateSeriesVersion:() => false,
            toggleFavorite:noop, openGroup:group => {chosen=group.representative;}
        });
        return page;
    }
    async function mount(next = 'movies') {
        surface = next; chosen = null;
        const host = document.getElementById('qa-host');
        host.innerHTML = '<div id="qa-grid"></div>';
        const grid = document.getElementById('qa-grid');
        const kind = /series/.test(surface) ? 'series' : 'movie';
        items = records(kind);
        controller = page(kind, host);
        if (surface === 'movies' || surface === 'series') {
            grid.className = kind === 'movie' ? 'movies-grid' : 'series-grid';
            items.forEach(item => grid.appendChild(controller.buildCard({representative:item,items:[item]})));
        } else if (surface === 'home') {
            const home = Object.create(HomePage.prototype);
            Object.assign(home, {contentPreferences:{}, displayTitle:item => item.title,
                posterFromItem:() => poster, resolveImageUrl:value => value, cardMeta:() => ''});
            grid.className = 'horizontal-scroll';
            grid.innerHTML = items.map((item,index) => home.createRailCard(item,0,index)).join('');
        } else if (surface === 'genres') {
            GenreRails.render(grid, [{id:'qa-genre',title:'Catalogue',items}], {onItemClick:item => {chosen=item;}});
        } else {
            appMarkup ||= new DOMParser().parseFromString(await (await fetch('/app.html')).text(), 'text/html');
            const panel = appMarkup.getElementById(kind === 'movie' ? 'movie-details' : 'series-details').cloneNode(true);
            host.appendChild(panel);
            controller.detailsPanel = panel;
            controller.versionsList = panel.querySelector(`.${kind}-versions-list`);
            controller.versionSummary = panel.querySelector(`.${kind}-versions-toolbar .hint`);
            const item = items[1], group = {representative:item,items:[item]};
            if (kind === 'movie') controller.showMovieDetails(group,item);
            else {
                controller.seasonsContainer = panel.querySelector('#series-seasons');
                window.API = {proxy:{xtream:{seriesInfo:async () => ({episodes:{}})}}};
                await controller.showSeriesDetailsV2(item,{group,manualPick:true});
            }
        }
        return surface;
    }
    function verify() {
        const host = document.getElementById('qa-host');
        if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('page horizontal overflow: '+surface);
        if (surface.endsWith('-detail')) {
            const meta = host.querySelector(surface === 'movie-detail' ? '#movie-detail-meta' : '#series-meta');
            const expected = MediaUtils.catalogLanguageInfo(items[1]).text;
            if (!meta.textContent.includes(expected)) throw Error('single detail lacks qualified language');
            if (host.querySelector('.version-language-status')) throw Error('single detail needs no version switcher');
            for (const pill of meta.children) {
                if (pill.scrollWidth > pill.clientWidth + 1 || pill.scrollHeight > pill.clientHeight + 1) throw Error('clipped detail language');
            }
        } else {
            const badges = [...host.querySelectorAll('.catalog-language-badge')];
            if (badges.length !== 5) throw Error('five catalogue badges');
            if (host.querySelectorAll('.language-badge-status').length !== 3) throw Error('three qualified supplier hints');
            badges.forEach((badge,index) => {
                const expected = MediaUtils.catalogLanguageInfo(items[index]);
                if (badge.getAttribute('aria-label') !== expected.text) throw Error('accessible provenance missing');
                if (index === 2 && (badge.querySelector('.language-badge-status') || !badge.textContent.includes(MediaUtils.languageDisplayFull('fr')))) throw Error('AR file must stay observed French');
                const box = badge.closest('.movie-poster,.series-poster,.card-image').getBoundingClientRect();
                for (const text of badge.querySelectorAll('.language-badge-label,.language-badge-status')) {
                    const rect = text.getBoundingClientRect();
                    if (text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1) throw Error('clipped badge '+surface);
                    if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1 || rect.left < box.left - 1 || rect.right > box.right + 1) throw Error('badge outside poster '+surface);
                }
            });
            if (surface !== 'home') {
                host.querySelector('.movie-card,.series-card,.dashboard-card').click();
                if (chosen !== items[0]) throw Error('wrong card opened');
            }
        }
        return {surface,locale:NorvaI18n.language,width:innerWidth,badges:surface.endsWith('-detail') ? 1 : 5};
    }
    return {mount,verify};
})();
