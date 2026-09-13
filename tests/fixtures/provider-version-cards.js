/* Offline QA fixture: actual Movie/Series renderers, no account or provider I/O. */
window.ProviderVersionCardsQA = (() => {
    const definitions = [
        ['ALB', 'AL | PRIME VIDEO', ['fr']], ['ALB', 'AL | DISNEY+', null],
        ['AR', 'AR | FOREIGN', ['fr']], ['DE', 'GERMANY', ['de']],
        ['FR', 'FR | DISNEY+', null], ['GR', 'GREECE', null],
        ['HU', 'SCANDINAVIA', null], ['IN', 'ASIA| HINDI', null],
        ['NL', 'NL | DISNEY+', null], ['PL', 'POLAND', ['fr']],
        ['RU', 'RUSSIA', ['fr', 'ru']], ['SO', 'SOMALIA', null],
        ['EN', 'EN ▎CINEMA MOVIES', null]
    ];
    let controller, selected, lastChoice, currentKind;
    const entries = kind => definitions.map(([prefix, category, audio], index) => ({
        id: `qa-${index}`, stream_id: String(index), series_id: String(index), sourceId: 'qa-source',
        item_type: kind, raw_title: `${prefix} ▎ Example Film`, title: 'Example Film',
        metadata: { categoryName: category }, container_extension: prefix === 'SO' ? 'mp4' : 'mkv',
        codec_profile: index === 1 ? { container:'mpegts', probeSource:'gateway_probe', probedAt:new Date().toISOString() } : null,
        audio_language_validation_status: audio ? 'probed' : 'not_analyzed',
        audio_tracks_scope: 'file', audio_tracks: audio ? audio.map((lang, n) => ({index:n + 1,lang})) : [],
        audio_probed_at: audio ? '2026-09-10T10:00:00Z' : null,
        subtitle_tracks_scope: 'file', subtitle_tracks: prefix === 'PL' ? [{index:2,lang:'pl'}]
            : prefix === 'RU' ? ['en', 'fr', 'ru'].map((lang,n) => ({index:n + 3,lang})) : [],
        ...(index === 12 ? {audio_language_validation_status:'pending',audio_tracks:undefined,
            codec_profile:{audioTracks:[{index:1,language:'her',title:'Audio 1',codec:'aac'}]}} : {})
    }));
    function mount(kind = 'movie') {
        currentKind = kind;
        lastChoice = null;
        const host = document.getElementById('qa-host');
        host.innerHTML = `<section id="${kind === 'movie' ? 'movie' : 'series'}-versions-section" class="${kind}-versions-section">
            <div class="movie-versions-toolbar"><h3>Versions</h3><p class="hint" id="qa-summary"></p></div>
            <div id="qa-versions" class="${kind}-versions-list"></div></section>`;
        // Exercise the actual rail -> group -> version conversion, with a
        // deliberately contradictory parent. No sibling may inherit its proof.
        const rawItems = entries(kind);
        const home = Object.create(HomePage.prototype);
        home.displayTitle = () => 'Example Film';
        const parent = {title:'Example Film', sourceId:'qa-source', category_name:'SCANDINAVIA',
            metadata:{categoryName:'SCANDINAVIA'}, audio_tracks_scope:'file',
            audio_tracks:[{index:1,lang:'an'}], audio_language_validation_status:'probed',
            defaultVariant:{audio_languages:['an'],audio_languages_scope:'file',audio_language_validation_status:'probed'},
            variants:rawItems};
        const items = home.buildHomeMediaGroup(parent, kind).items;
        selected = items[0];
        controller = Object.create(kind === 'movie' ? MoviesPage.prototype : SeriesPage.prototype);
        Object.assign(controller, {
            versionsList: document.getElementById('qa-versions'), versionSummary: document.getElementById('qa-summary'),
            getSourceName: () => 'Source personnelle', getPreferences: () => ({}),
            currentMovieVersions: items, currentMovie: selected, currentMovieGroup: {items},
            currentSeriesGroup: {items}, currentSeries: selected,
            getMovieWatchState: () => ({status:'unwatched'}), isBrokenItem: () => false,
            isSameSeriesVersion: (a, b) => a?.series_id === b?.series_id && a?.sourceId === b?.sourceId,
            showMovieDetails: (_group, item) => choose(item), showSeriesDetailsV2: item => choose(item)
        });
        render();
        return controller;
    }
    function render() {
        if (currentKind === 'movie') controller.renderMovieVersions(selected);
        else controller.renderSeriesVersions(selected);
    }
    function choose(item) {
        lastChoice = item;
        selected = item;
        controller.currentMovie = item;
        controller.currentSeries = item;
        render();
    }
    function verify() {
        const buttons = [...document.querySelectorAll('#qa-versions button')];
        if (buttons.length !== 13) throw Error('version count');
        if (document.querySelector('.version-language-status')) throw Error('internal provenance exposed');
        const versions = currentKind === 'movie' ? controller.currentMovieVersions : controller._orderedVersions;
        const exactTs = versions.find(v=>v.stream_id==='1');
        if (!MediaUtils.versionDescriptor(exactTs).meta.includes('MPEG-TS')) throw Error('exact TS format hidden');
        if (exactTs.container_extension !== 'mkv') throw Error('provider identity changed');
        if (versions.filter(item => MediaUtils.versionDescriptor(item,{providerLanguageHints:true}).languageStatus).length !== 8) throw Error('internal provenance lost');
        const pendingVersion = versions.find(v=>v.stream_id==='12');
        const pendingView = MediaUtils.versionDescriptor(pendingVersion,{providerLanguageHints:true});
        if (pendingView.headline !== MediaUtils.languageDisplayFull('en')
            || pendingView.audioSource !== 'provider-label') throw Error('pending tag hides language or loses internal provenance');
        const somaliView = MediaUtils.versionDescriptor(versions.find(v=>v.stream_id==='11'),{providerLanguageHints:true});
        if (somaliView.headline !== MediaUtils.languageDisplayFull('so') || !somaliView.languageConfirmationStatus) throw Error('Somali confirmation status lost or exposed');
        const providerMention = NorvaI18n.t('ui_web_38fc9a457587',{p0:'QA'}).replace('QA','').replace(/^[\s·]+/,'');
        const confirmMention = NorvaI18n.t('ui_web_provider_language_to_confirm',{language:'QA'}).replace('QA','').replace(/^[\s·]+/,'');
        if ([providerMention,confirmMention].some(text => document.getElementById('qa-versions').outerHTML.includes(text))) throw Error('internal qualification exposed');
        if (pendingVersion.codec_profile.audioTracks[0].language !== 'her') throw Error('raw file tag changed');
        if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('horizontal overflow');
        for (const button of buttons) {
            const rect = button.getBoundingClientRect();
            if (rect.height < 44 || rect.width < 44) throw Error('small target');
            for (const node of button.querySelectorAll('.version-headline,.version-language-status')) {
                const box = node.getBoundingClientRect();
                if (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1) throw Error('clipped qualifier or headline');
                if (box.bottom > rect.bottom + 1 || box.left < rect.left - 1 || box.right > rect.right + 1) throw Error('label outside card');
            }
        }
        const arabicFile = buttons.find(button => {
            const list = currentKind === 'movie' ? controller.currentMovieVersions : controller._orderedVersions;
            return list[Number(button.dataset.index)].stream_id === '2';
        });
        if (arabicFile.querySelector('.version-headline').textContent !== MediaUtils.languageDisplayFull('fr')) throw Error('AR file must stay French');
        if (arabicFile.querySelector('.version-language-status')) throw Error('observed audio has supplier qualifier');
        const hintButton = buttons.find(button => MediaUtils.versionDescriptor(versions[Number(button.dataset.index)],{providerLanguageHints:true}).languageStatus);
        const list = currentKind === 'movie' ? controller.currentMovieVersions : controller._orderedVersions;
        const expected = list[Number(hintButton.dataset.index)];
        hintButton.focus();
        if (document.activeElement !== hintButton) throw Error('button not keyboard focusable');
        hintButton.click();
        if (lastChoice !== expected) throw Error('wrong version selected');
        const active = document.querySelector('#qa-versions button.active');
        if (!active || Number(active.dataset.index) !== versions.indexOf(expected)) throw Error('selection not reflected');
        return { kind:currentKind, buttons:13, internalHints:8, selected:lastChoice.stream_id,
            locale:NorvaI18n.language, width:innerWidth };
    }
    return { mount, verify, get lastChoice() { return lastChoice?.stream_id ?? null; } };
})();
