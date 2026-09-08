'use strict';
// Offline acceptance fixture: real SPA markup, CSS and methods; no account or media requests.
window.fixtureReady = false;
window.fixtureErrors = [];
addEventListener('error', e => fixtureErrors.push(e.message));
addEventListener('unhandledrejection', e => fixtureErrors.push(String(e.reason)));
(async () => {
    const [markup, appSource] = await Promise.all(['/app.html', '/js/app.js'].map(url => fetch(url).then(r => r.text())));
    const original = new DOMParser().parseFromString(markup, 'text/html');
    const start = appSource.indexOf('    initMobileCatalogControls() {');
    const end = appSource.indexOf('    /** Reconcile native local downloads', start);
    if (start < 0 || end < start) throw Error('Catalog fixture cannot find the actual app methods');
    const CatalogShell = new Function(`return class { ${appSource.slice(start, end)} }`)();
    let control;
    const tick = () => new Promise(resolve => setTimeout(resolve, 40));
    const assert = (condition, message) => { if (!condition) throw Error(message); };
    window.contextFixture = {
        async prepare(locale = 'fr', kind = 'movies') {
            document.querySelectorAll('.filter-bar.mobile-open .mobile-filter-close').forEach(button => button.click());
            control?.destroy();
            document.body.classList.remove('catalog-filter-open');
            NorvaI18n.setPreference(locale);
            const mount = document.getElementById('app-fixture'); mount.replaceChildren();
            document.getElementById('rating-fixture').replaceChildren();
            for (const pageKind of ['movies', 'series']) {
                const page = original.getElementById('page-' + pageKind).cloneNode(true);
                page.classList.toggle('active', pageKind === kind);
                if (pageKind !== kind) page.style.display = 'none';
                page.querySelectorAll('img').forEach(img => { if (!img.getAttribute('src')) img.remove(); });
                mount.append(page);
            }
            const prefix = kind === 'movies' ? 'movie' : 'series';
            const rating = document.getElementById(prefix + '-title-rating');
            document.getElementById('rating-fixture').append(rating);
            const seasonCount = document.createElement('span');
            seasonCount.id = 'fixture-season-count';
            seasonCount.setAttribute('data-i18n', 'ui_season_count');
            seasonCount.setAttribute('data-i18n-args', '{"count":1}');
            seasonCount.textContent = '1 seasons';
            mount.append(seasonCount);
            let revision = 0;
            control = TitleRatingControl.fromIds({rootId:prefix+'-title-rating',upId:prefix+'-thumb-up',downId:prefix+'-thumb-down',statusId:prefix+'-rating-status',retryId:prefix+'-rating-retry',
                getApi: () => ({ getExact: async () => ({rating:0}), set: async intent => ({rating:intent.rating,revision:++revision}) }) });
            await control.load({sourceId:'fixture-source',itemId:'fixture-title',itemType:kind==='movies'?'movie':'series'});
            const shell = new CatalogShell(); shell.initMobileCatalogControls();
            const page = Object.create((kind === 'movies' ? MoviesPage : SeriesPage).prototype);
            const audio = document.getElementById(kind + '-audio');
            page.applyFacetOptions(audio, NorvaI18n.t('ui_web_54186a20c3e8', {defaultValue:'Any language'}), [
                {value:'es',label:'Spanish · 1 movies',count:1}, {value:'catalog-pt',label:'Portuguese · 1,201 movies',count:1201},
            ], '', kind);
            const source = document.getElementById(kind+'-source-select');
            source.append(new Option('Fixture source','fixture-source'));
            const categories = new MultiSelect({btnId:kind+'-category-btn',panelId:kind+'-category-panel',searchId:kind+'-category-search',listId:kind+'-category-list',allLabel:NorvaI18n.t('ui_web_fe3b58f14752')});
            categories.setOptions([{value:'comedie',label:GenreTaxonomy.label('comedie')}]);
            NorvaI18n.translate(document);
            this.kind=kind; this.prefix=prefix; this.source=source; this.categories=categories; this.audio=audio;
            await tick();
            return {locale,kind,up:document.getElementById(prefix+'-thumb-up').textContent.trim(),down:document.getElementById(prefix+'-thumb-down').textContent.trim()};
        },
        async verify(locale, kind) {
            const labels = await this.prepare(locale,kind);
            assert(document.documentElement.dir === (locale==='ar'?'rtl':'ltr'), 'wrong text direction');
            for (const suffix of ['up','down']) {
                const button = document.getElementById(this.prefix+'-thumb-'+suffix), label = button.querySelector('.title-rating-choice-label');
                const b=button.getBoundingClientRect(), l=label.getBoundingClientRect();
                assert(b.height>=44 && b.width>=44,'small touch target '+suffix);
                assert(label.scrollWidth<=label.clientWidth+1, 'clipped rating label '+suffix);
                assert(l.left>=b.left-1 && l.right<=b.right+1 && l.bottom<=b.bottom+1, 'rating label outside button '+suffix);
                assert(b.left>=-1 && b.right<=innerWidth+1, 'rating outside viewport '+suffix);
                button.click(); await control._saveLoop?.promise; await tick(); NorvaI18n.translate(document);
                assert(button.getAttribute('aria-pressed')==='true','rating not selected');
                assert(button.title === NorvaI18n.t(suffix==='up'?'ui_web_daac3bde7c99':'ui_web_c198943da380'), 'selected action lost');
                button.click(); await control._saveLoop?.promise; await tick();
                assert(button.getAttribute('aria-pressed')==='false','rating not cleared');
            }
            const open=document.getElementById(kind+'-mobile-filters-btn');
            if (innerWidth<=1024) {
                open.click(); await tick();
                const sheet=document.getElementById(kind+'-filter-bar');
                assert(sheet.getAttribute('aria-hidden')==='false'&&!sheet.inert,'inaccessible filter sheet');
                for (const [index,key] of ['ui_catalog_section','ui_languages_section','ui_display_section'].entries()) {
                    const heading=sheet.querySelectorAll('.mobile-filter-section-title')[index];
                    assert(heading.textContent===NorvaI18n.t(key),'untranslated filter heading');
                }
                // Both source/category orders preserve their stable values and selections.
                this.source.value='fixture-source'; this.source.dispatchEvent(new Event('change'));
                this.categories.setSelected(['comedie']);
                this.source.value=''; this.source.dispatchEvent(new Event('change')); this.categories.setSelected([]);
                assert(this.source.value===''&&this.categories.getSelected().size===0,'source/categories reset');
                this.categories.setSelected(['comedie']); this.source.value='fixture-source';
                this.categories.setSelected([]); this.source.value='';
                assert(this.source.value===''&&this.categories.getSelected().size===0,'categories/source reset');
                this.audio.value='catalog-pt'; this.audio.dispatchEvent(new Event('change'));
                assert(this.audio.value==='catalog-pt','language query changed');
                sheet.querySelector('.mobile-filter-close').click(); await tick();
                assert(open.getAttribute('aria-expanded')==='false','filter sheet did not close');
            }
            assert(NorvaI18n.t('ui_season_count',{count:1})!== 'ui_season_count','plural key missing');
            assert(document.getElementById('fixture-season-count').textContent===NorvaI18n.t('ui_season_count',{count:1}),'DOM plural count untranslated');
            assert(GenreTaxonomy.displayGenre('Crime')===NorvaI18n.t('ui_web_22611ceccd0b'),'untranslated detail genre');
            if(locale==='fr')assert(NorvaI18n.t('ui_video_count',{count:1})==='1 vidéo','singular video');
            if(locale==='fr') {assert(NorvaI18n.t('ui_season_count',{count:1})==='1 saison','singular season');assert(this.audio.options[1].text==='Espagnol · 1','English language leaked');}
            assert(document.documentElement.scrollWidth<=innerWidth+1,'horizontal page overflow');
            assert(!fixtureErrors.length,fixtureErrors.join('; '));
            return {...labels,passed:true,width:innerWidth};
        }
    };
    fixtureReady = true;
})().catch(e => { fixtureErrors.push(String(e)); fixtureReady='error'; });
