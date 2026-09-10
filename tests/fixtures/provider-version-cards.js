/* Offline QA fixture: actual Movie/Series renderers, no account or provider I/O. */
window.ProviderVersionCardsQA = (() => {
    const definitions = [
        ['ALB', 'AL | PRIME VIDEO', ['fr']], ['ALB', 'AL | DISNEY+', null],
        ['AR', 'AR | FOREIGN', ['fr']], ['DE', 'GERMANY', ['de']],
        ['FR', 'FR | DISNEY+', null], ['GR', 'GREECE', null],
        ['HU', 'SCANDINAVIA', null], ['IN', 'ASIA| HINDI', null],
        ['NL', 'NL | DISNEY+', null], ['PL', 'POLAND', ['fr']],
        ['RU', 'RUSSIA', ['fr', 'ru']], ['SO', 'SOMALIA', null]
    ];
    let controller, selected, lastChoice, currentKind;
    const entries = kind => definitions.map(([prefix, category, audio], index) => ({
        id: `qa-${index}`, stream_id: String(index), series_id: String(index), sourceId: 'qa-source',
        item_type: kind, raw_title: `${prefix} ▎ Example Film`, title: 'Example Film',
        metadata: { categoryName: category }, container_extension: prefix === 'SO' ? 'mp4' : 'mkv',
        audio_language_validation_status: audio ? 'probed' : 'not_analyzed',
        audio_tracks_scope: 'file', audio_tracks: audio ? audio.map((lang, n) => ({index:n + 1,lang})) : [],
        audio_probed_at: audio ? '2026-09-10T10:00:00Z' : null,
        subtitle_tracks_scope: 'file', subtitle_tracks: prefix === 'PL' ? [{index:2,lang:'pl'}]
            : prefix === 'RU' ? ['en', 'fr', 'ru'].map((lang,n) => ({index:n + 3,lang})) : []
    }));
    function mount(kind = 'movie') {
        currentKind = kind;
        lastChoice = null;
        const host = document.getElementById('qa-host');
        host.innerHTML = `<section id="${kind === 'movie' ? 'movie' : 'series'}-versions-section" class="${kind}-versions-section">
            <div class="movie-versions-toolbar"><h3>Versions</h3><p class="hint" id="qa-summary"></p></div>
            <div id="qa-versions" class="${kind}-versions-list"></div></section>`;
        const items = entries(kind);
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
        if (buttons.length !== 12) throw Error('version count');
        if (document.querySelectorAll('.version-language-status').length !== 7) throw Error('seven qualified hints');
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
        const hintButton = buttons.find(button => button.querySelector('.version-language-status'));
        const list = currentKind === 'movie' ? controller.currentMovieVersions : controller._orderedVersions;
        const expected = list[Number(hintButton.dataset.index)];
        hintButton.focus();
        if (document.activeElement !== hintButton) throw Error('button not keyboard focusable');
        hintButton.click();
        if (lastChoice !== expected) throw Error('wrong version selected');
        const active = document.querySelector('#qa-versions button.active');
        if (!active || !active.querySelector('.version-language-status')) throw Error('selection not reflected');
        return { kind:currentKind, buttons:12, qualified:7, selected:lastChoice.stream_id,
            locale:NorvaI18n.language, width:innerWidth };
    }
    return { mount, verify, get lastChoice() { return lastChoice?.stream_id ?? null; } };
})();
