/* Offline acceptance: real page renderers and app detail markup, synthetic metadata only. */
window.CatalogLanguageQA = (() => {
    const poster = '/img/norva-media-placeholder.png';
    const definitions = [
        ['Bandit', 'AL ▎PRIME VIDEO', 'sq'],
        ['Japan Malayalam Dubbed 2023', 'ASIA ▎MALAYALAM DUBBED', 'ml'],
        ['AR ▎ Example Film', 'AR ▎FOREIGN', 'fr'],
        ['Example Nordic', 'SCANDINAVIA', 'nordic'],
        ['Example Unlabelled', '', null],
        ['IN ▎ The Blind', 'ASIA ▎ENGLISH HINDI DUBBED', 'hi'],
        ['IN ▎ Blink Twice', 'ASIA ▎HINDI', ['en','hi','ta','te']],
        ['TL ▎ Bring Her Back', 'ASIA ▎TELUGU', ['en','te']],
        ['Example Selection', '', 'te'],
        ['EN ▎ In Her Place', 'EN ▎CINEMA MOVIES', 'en']
    ];
    let surface, items, chosen, controller, appMarkup;
    const noop = () => {};
    function records(kind) {
        return definitions.map(([name, category, expected], index) => ({
            id: `surface-${index}`, stream_id: String(index), series_id: String(index), sourceId: 'qa-source',
            item_type: kind, name, title: name, raw_title: name, category_name: category,
            metadata: {categoryName:category}, cover:poster, stream_icon:poster, poster_url:poster,
            expected, audio_language_validation_status:index === 2 || Array.isArray(expected) ? 'probed' : 'not_analyzed',
            audio_tracks_scope:'file', audio_tracks:index === 7 ? [null,'en','te',null].map((lang,n)=>({index:n+1,lang}))
                : index === 2 ? [{index:1,lang:'fr'}]
                : Array.isArray(expected) ? expected.map((lang,n)=>({index:n+1,lang})) : [],
            audio_probed_at:index === 2 || Array.isArray(expected) ? '2026-09-10T10:00:00Z' : null,
            ...(index === 8 ? {providerAudioLanguages:['te'],providerAudioLanguageStatus:'provider_declared'} : {}),
            ...(index === 9 ? {audio_language_validation_status:'pending',audio_tracks:undefined,
                codec_profile:{audioTracks:[{index:1,language:'her',title:'Audio 1',codec:'aac'}]}} : {})
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
    async function mount(next = 'movies', detailIndex = 1) {
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
            // Editorial artwork may belong to the group representative. Its
            // provider category must never label the selected file instead.
            const item = items[detailIndex], group = {representative:kind === 'movie'
                ? {...item, category_name:'TR | QA OTHER VERSION'} : item,items:[item]};
            chosen = item;
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
        const pendingView = MediaUtils.catalogLanguageInfo(items[9]);
        const qualifiedEnglish = NorvaI18n.t('ui_web_38fc9a457587',{p0:MediaUtils.languageDisplayFull('en')});
        if (pendingView.headline !== qualifiedEnglish || pendingView.audioSource !== 'provider-label') throw Error('unaccepted tag hides or overstates supplier language');
        if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('page horizontal overflow: '+surface);
        if (surface.endsWith('-detail')) {
            const meta = host.querySelector(surface === 'movie-detail' ? '#movie-detail-meta' : '#series-meta');
            const expected = MediaUtils.catalogLanguageInfo(chosen).text;
            if (!meta.textContent.includes(expected)) throw Error('single detail lacks language');
            if (surface === 'movie-detail') {
                if (meta.textContent.includes('TR | QA OTHER VERSION')) throw Error('sibling provider category leaked');
                if (chosen.category_name && !meta.textContent.includes(chosen.category_name)) throw Error('selected provider category missing');
            }
            if (host.querySelector('.version-language-status')) throw Error('single detail needs no version switcher');
            for (const pill of meta.children) {
                if (pill.scrollWidth > pill.clientWidth + 1 || pill.scrollHeight > pill.clientHeight + 1) throw Error('clipped detail language');
            }
        } else {
            const badges = [...host.querySelectorAll('.catalog-language-badge')];
            if (badges.length !== items.length) throw Error('catalogue badge count');
            if (host.querySelector('.language-badge-status')) throw Error('internal provenance leaked');
            if (items.filter(item => MediaUtils.catalogLanguageInfo(item).languageStatus).length !== 6) throw Error('internal provenance lost');
            badges.forEach((badge,index) => {
                const expected = MediaUtils.catalogLanguageInfo(items[index]);
                if (badge.getAttribute('aria-label') !== expected.accessibleHeadline) throw Error('accessible language wrong');
                if (expected.languageStatus && badge.outerHTML.includes(expected.languageStatus)) throw Error('internal provenance exposed');
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
        return {surface,locale:NorvaI18n.language,width:innerWidth,badges:surface.endsWith('-detail') ? 1 : items.length};
    }
    return {mount,verify};
})();
