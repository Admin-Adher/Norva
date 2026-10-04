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
    async function verifyRestoration(kind) {
        // Load after DOMContentLoaded: exercise App's real restoration without
        // booting an account or connecting this offline fixture to production.
        if (typeof App === 'undefined') await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/js/app.js'; script.onload = resolve; script.onerror = reject;
            document.head.append(script);
        });
        const page = mount(kind);
        const pageName = kind === 'movie' ? 'movies' : 'series';
        const idField = kind === 'movie' ? 'stream_id' : 'series_id';
        const fresh = ['selected-source', 'other-source'].map((sourceId, index) => ({
            sourceId, [idField]: 'same-id', stream_id: 'same-id', series_id: 'same-id',
            name: 'Jasper Mall', raw_title: 'Jasper Mall', container_extension: 'mkv',
            overview: 'Synopsis localisé actuel', poster_url: 'https://example.invalid/current.jpg',
            year: 2020, metadata: { genres: ['Documentary'] },
            audio_tracks_scope: 'file', audio_tracks: [{ index: 1, lang: index ? 'fr' : 'en' }],
            audio_languages: [index ? 'fr' : 'en'], audio_language_validation_status: 'verified',
        }));
        let fetches = 0;
        window.API = { media: { page: async params => {
            fetches++;
            if (params.sourceId !== 'selected-source' || params.externalId !== 'same-id'
                || params.q !== undefined || params.type !== kind) throw Error('restoration uses name instead of exact identity');
            return { items: fresh };
        } } };
        const app = Object.create(App.prototype);
        app.pages = { [pageName]: page }; app.currentPage = pageName; app._navigationToken = 1;
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('restoration timed out')), 6000);
            app.forgetOpenFiche = () => { clearTimeout(timeout); reject(Error('restoration discarded')); };
            const show = (item, group) => {
                page.currentMovieVersions = group.items;
                page.currentSeriesGroup = group;
                choose(item); clearTimeout(timeout); resolve();
            };
            page.showMovieDetails = (group, item) => show(item, group);
            page.showSeriesDetailsV2 = async (item, group) => show(item, group);
            app.restoreOpenFiche(pageName, { type: kind, sourceId: 'selected-source', id: 'same-id',
                title: 'Ancien titre traduit', series: { ...fresh[0], audio_languages: [] },
                group: { items: [{ ...fresh[0], audio_tracks: [], audio_language_validation_status: 'pending' }] } });
        });
        if (fetches !== 1 || selected.sourceId !== 'selected-source') throw Error('restored source or fresh fetch');
        if (selected.overview !== 'Synopsis localisé actuel' || selected.year !== 2020
            || selected.poster_url !== 'https://example.invalid/current.jpg') throw Error('restored editorial metadata missing');
        const buttons = [...document.querySelectorAll('#qa-versions button')];
        const active = buttons.find(button => button.classList.contains('active'));
        if (buttons.length !== 2 || !active) throw Error('restored versions');
        if (active.querySelector('.version-headline')?.textContent !== MediaUtils.languageDisplayFull('en')) {
            throw Error('restored audio still stale');
        }
    }
    let recoveryFixture;
    const turn = () => new Promise(resolve => setTimeout(resolve, 35));
    function mountPlaybackRecovery({ single = false, holdClose = false, lookupFails = false, closeFails = false } = {}) {
        const host = document.getElementById('qa-host');
        host.innerHTML = `<section id="qa-recovery-watch" class="watch-video-section" style="position:relative;min-height:360px">
            <div id="watch-error" class="watch-error hidden"></div></section>
            <section id="qa-recovery-details" class="movie-versions-section" hidden>
            <h2>Example Film</h2><p class="hint">Offline recovery fixture · no media connection</p>
            <p id="qa-recovery-summary"></p><div id="qa-recovery-versions" class="movie-versions-list"></div>
            <p id="qa-recovery-started" role="status" aria-live="polite"></p></section>`;
        const items = ['failed-file', 'english-copy', 'french-copy'].slice(0, single ? 1 : 3).map((id, index) => ({
            id, stream_id: id, sourceId: 'qa-source', item_type: 'movie', title: 'Example Film',
            name: 'Example Film', tmdb_id: 1234567, year: 2025, container_extension: index ? 'mp4' : 'mkv',
            audio_tracks_scope: 'file', audio_tracks: [{ index: index + 1, lang: index === 2 ? 'fr' : 'en' }],
            audio_language_validation_status: 'verified', subtitle_tracks_scope: 'file',
            subtitle_tracks: [{ index: index + 4, lang: 'fr' }],
        }));
        const owner = { id: 'fixture-owner' };
        // An auth session's expiry is a stable claim, not a rolling clock.
        // Recomputing it during capture would invalidate the recovery scope
        // every second and make normal human-paced clicks look like logout.
        const session = { user: owner, expires_at: Math.floor(Date.now() / 1000) + 3600 };
        const app = { currentUser: owner, currentPage: 'watch', pages: {},
            navigateTo(page) { this.currentPage = page; }, showToast() {} };
        window.app = app;
        window.NorvaAuth = { getSession: () => session };
        window.NorvaCloud = { catalogVisibility: { epoch: () => 1 } };
        window.NorvaPlaybackRefusals?.reset();
        let release;
        const close = holdClose ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
        const evidence = { closed: 0, catalogueLookups: 0, plays: [], retries: [], items, app, release: () => release?.() };
        window.API = { media: { page: async params => {
            evidence.catalogueLookups++;
            if (!evidence.closed) throw Error('catalogue opened before old session closed');
            if (params.sourceId !== 'qa-source' || params.externalId !== 'failed-file' || params.q) throw Error('lookup lost exact file');
            if (lookupFails) throw Error('fixture catalogue unavailable');
            return { items };
        } } };
        const movies = Object.create(MoviesPage.prototype);
        Object.assign(movies, {
            app, sources: [{ id: 'qa-source', config_revision: '1', active_generation_id: 'fixture-generation' }],
            detailsPanel: document.getElementById('qa-recovery-details'),
            versionsList: document.getElementById('qa-recovery-versions'), versionSummary: document.getElementById('qa-recovery-summary'),
            getPreferences: () => ({}), getSourceName: () => 'Source personnelle',
            getMovieWatchState: () => ({ status: 'unwatched', data: {} }), isBrokenItem: () => false,
            _isTvMode: () => false, _loadPanelExtras() {},
            prepareForPlaybackSession: async () => { if (!evidence.closed) throw Error('overlapping media session'); },
            // Only the surrounding artwork is replaced. The owned-file lookup,
            // recovery state, version renderer, focus and actions are production methods.
            showMovieDetails(group, selected, options = {}) {
                this.currentMovie = selected; this.currentMovieGroup = group; this.currentMovieVersions = options.versions || group.items;
                document.getElementById('qa-recovery-watch').hidden = true;
                this.detailsPanel.hidden = false; this.renderMovieVersions(selected);
                if (options.focusVersions) this._focusVersionsList();
            },
            async playMovie(movie, options) {
                evidence.plays.push({ file: movie.stream_id, position: options.resumeTime, preferences: options.playbackPreferences });
                document.getElementById('qa-recovery-started').textContent = `Fixture: ${movie.stream_id} · ${options.resumeTime}s`;
            }
        });
        app.pages.movies = movies;
        const watch = Object.create(WatchPage.prototype);
        Object.assign(watch, {
            app, content: { id: 'failed-file', type: 'movie', sourceId: 'qa-source', title: 'Example Film' },
            _playbackAttemptId: 1, _fileRefusalScope: window.NorvaPlaybackRefusals?.capture(app),
            hasCurrentMedia: () => false, clearDeferredPlaybackError() {}, hideLoading() {}, updateTranscodeStatus() {},
            trackProduct() {}, clearPlaybackErrorRefreshTimer() {}, getResumeSnapshotPosition: () => 300,
            releasePlaybackPipelineForRetry: async () => { await close; if (closeFails) throw Error('fixture close not acknowledged'); evidence.closed++; },
            waitForProviderSlotRelease: async () => {},
            retryPlaybackInPlace: () => { evidence.retries.push('failed-file'); }
        });
        app.pages.watch = watch;
        watch.showPlaybackError('PROVIDER_FILE_REFUSED', { immediate: true });
        evidence.movies = movies; evidence.watch = watch;
        recoveryFixture = evidence;
        return evidence;
    }

    async function verifyPlaybackRecovery() {
        const assert = (condition, message) => { if (!condition) throw Error(message); };
        let fixture = mountPlaybackRecovery({ holdClose: true });
        const actions = [...document.querySelectorAll('#watch-error button')];
        assert(actions.length === 3, 'refused file needs three explicit actions');
        for (const button of actions) {
            const rect = button.getBoundingClientRect();
            assert(rect.height >= 44 && rect.width >= 44, 'recovery action touch target');
            assert(button.scrollHeight <= button.clientHeight + 1, 'recovery action label clipped');
        }
        document.getElementById('watch-error-versions-btn').click();
        assert(actions.every(button => button.disabled), 'overlapping recovery action enabled');
        document.getElementById('watch-error-refresh-btn').click();
        assert(fixture.retries.length === 0 && fixture.catalogueLookups === 0, 'work before exact close');
        fixture.release(); await turn();
        assert(fixture.app.currentPage === 'movies' && fixture.catalogueLookups === 1, 'catalogue recovery navigation');
        let buttons = [...document.querySelectorAll('#qa-recovery-versions button')];
        assert(buttons.length === 3 && buttons.includes(document.activeElement), 'version focus not restored');
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert(fixture.movies.playbackRecoveryCurrent(), 'human-paced selection lost a stable authentication scope');
        const other = buttons.find(button => fixture.movies.currentMovieVersions[Number(button.dataset.index)].stream_id === 'english-copy');
        other.click();
        assert(fixture.plays.length === 0, 'version selection silently started playback');
        document.querySelector('[data-recovery-action="cancel"]').click(); await turn();
        assert(fixture.plays.length === 0 && document.activeElement?.classList.contains('movie-version-item'), 'cancel changed playback or lost focus');
        document.querySelector(`#qa-recovery-versions [data-index="${fixture.movies.currentMovieVersions.findIndex(item => item.stream_id === 'english-copy')}"]`).click();
        document.querySelector('[data-recovery-action="resume"]').click(); await turn();
        assert(fixture.plays.length === 1 && fixture.plays[0].file === 'english-copy' && fixture.plays[0].position === 300, 'explicit resume selection');
        assert(!fixture.plays[0].preferences, 'old file track indices copied');

        fixture = mountPlaybackRecovery();
        document.getElementById('watch-error-refresh-btn').click();
        assert(fixture.retries.length === 1 && fixture.retries[0] === 'failed-file' && fixture.plays.length === 0, 'retry changed file');
        document.getElementById('watch-error-back-btn').click(); await turn();
        assert(fixture.app.currentPage === 'movies' && fixture.plays.length === 0, 'back to details started playback');
        buttons = [...document.querySelectorAll('#qa-recovery-versions button')];
        buttons.find(button => fixture.movies.currentMovieVersions[Number(button.dataset.index)].stream_id === 'french-copy').click();
        document.querySelector('[data-recovery-action="start"]').click(); await turn();
        assert(fixture.plays[0]?.file === 'french-copy' && fixture.plays[0]?.position === 0, 'explicit start from beginning');

        fixture = mountPlaybackRecovery({ single: true });
        document.getElementById('watch-error-versions-btn').click(); await turn();
        assert(fixture.movies._playbackRecovery.keys.size === 1 && fixture.plays.length === 0, 'single-version recovery');
        assert(document.querySelector('.movie-version-recovery [role="status"]')?.textContent, 'missing no-other-version message');
        assert(document.querySelectorAll('#qa-recovery-versions button').length === 0, 'invented alternative');

        for (const failure of [{ lookupFails: true }, { closeFails: true }]) {
            fixture = mountPlaybackRecovery(failure);
            document.getElementById('watch-error-versions-btn').click(); await turn();
            assert(fixture.app.currentPage === 'watch' && fixture.plays.length === 0, 'failed hand-off navigated or played');
            assert(!document.getElementById('watch-error-versions-btn').disabled, 'failed hand-off cannot retry');
            assert(document.getElementById('watch-error-version-status').textContent, 'failed hand-off lacks accessible status');
        }
        assert(document.documentElement.scrollWidth <= innerWidth + 1, 'recovery horizontal overflow');
        mountPlaybackRecovery();
        return { scenarios: 8, providerRequests: 0, explicitAlternativeChoices: 2 };
    }
    async function mountNativePlaybackRecovery() {
        const fixture = mountPlaybackRecovery();
        fixture.app.currentPage = 'movies';
        document.getElementById('qa-recovery-watch').hidden = true;
        document.getElementById('qa-recovery-details').hidden = false;
        fixture.nativeLaunches = []; fixture.nativeResolutions = [];
        window.NorvaTVCloud = { playVideoJson: payload => fixture.nativeLaunches.push(JSON.parse(payload)) };
        if (!window.__norvaStandaloneBooted) await new Promise((resolve, reject) => {
            const script = document.createElement('script'); script.src = '/js/utils/standalone.js';
            script.onload = resolve; script.onerror = reject; document.head.append(script);
        });
        Object.assign(fixture.watch, {
            activeCloudPlaybackSessionIds: new Set(),
            stopCloudPlaybackSessions: async () => { fixture.closed++; },
            _fetchServerResumeInfo: async () => ({ answered: true, position: 300 })
        });
        fixture.watch.content = null;
        await fixture.watch.play({ id: 'failed-file', sourceId: 'qa-source', type: 'movie', title: 'Example Film' }, async () => {
            fixture.nativeResolutions.push('failed-file');
            const error = new Error('Fixture typed file refusal'); error.code = 'PROVIDER_FILE_REFUSED'; throw error;
        });
        await turn();
        return fixture;
    }

    async function verifyNativePlaybackRecovery() {
        let fixture = await mountNativePlaybackRecovery();
        let overlay = document.querySelector('.norva-modal-overlay');
        if (!overlay || overlay.getAttribute('aria-modal') !== 'true') throw Error('missing native pre-launch dialog');
        const actions = [...overlay.querySelectorAll('[data-native-recovery-action]')];
        if (actions.length !== 3 || !overlay.contains(document.activeElement)) throw Error('native pre-launch action focus');
        if (!document.getElementById('qa-host').inert && !document.getElementById('qa-host').parentElement.inert) throw Error('native recovery background interactive');
        if (fixture.nativeLaunches.length || fixture.nativeResolutions.length !== 1) throw Error('initial refusal launched native activity');
        actions.find(action => action.dataset.nativeRecoveryAction === 'retry').click(); await turn();
        if (fixture.nativeResolutions.length !== 2 || fixture.nativeLaunches.length) throw Error('pre-native retry changed file or launched activity');
        overlay = document.querySelector('.norva-modal-overlay');
        overlay.querySelector('[data-native-recovery-action="versions"]').click(); await turn();
        if (document.querySelector('.norva-modal-overlay') || fixture.movies.currentMovieVersions?.length !== 3 || fixture.nativeLaunches.length) throw Error('native refusal did not open owned version list');
        fixture = await mountNativePlaybackRecovery();
        if (window.__norvaHandleBack() !== 'handled') throw Error('native hardware Back not consumed');
        await turn();
        if (document.querySelector('.norva-modal-overlay') || fixture.nativeLaunches.length) throw Error('Back should dismiss native prelaunch recovery');
        fixture = await mountNativePlaybackRecovery();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await turn();
        if (document.querySelector('.norva-modal-overlay') || fixture.nativeLaunches.length) throw Error('Escape should dismiss native prelaunch recovery');
        mountPlaybackRecovery();
        return { scenarios: 4, providerRequests: 0, nativeLaunches: 0 };
    }
    return { mount, verify, verifyRestoration, mountPlaybackRecovery, verifyPlaybackRecovery, mountNativePlaybackRecovery, verifyNativePlaybackRecovery,
        get recovery() { return recoveryFixture; }, get lastChoice() { return lastChoice?.stream_id ?? null; } };
})();
