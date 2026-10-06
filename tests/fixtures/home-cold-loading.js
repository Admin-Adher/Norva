/* Cold Home scheduling proof: actual layout/cards/hero, synthetic isolated API. */
window.ColdHomeQA = {
    async verify() {
        const oldApi = window.API, oldCache = window.NorvaCatalogCache;
        const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
        const primary = deferred(), series = deferred();
        const host = document.getElementById('qa-host');
        const poster = '/img/norva-media-placeholder.png';
        let loading, page;
        try {
            window.NorvaCatalogCache = {read: () => null, write() {}};
            window.API = {
                settings: {get: async () => ({})},
                request: async (_, path) => {
                    if (path.startsWith('/home/rails')) return primary.promise;
                    if (path.startsWith('/media/genre-rails')) return {rails: []};
                    if (path.startsWith('/channels/recent')) return path.includes('type=series') ? series.promise : [{
                        id:'cold-movie', sourceId:'synthetic', item_type:'movie', name:'Cold Home Film', title:'Cold Home Film',
                        poster_url:poster, backdrop_url:poster, description:'Synthetic synopsis.', audioLanguages:['en'],
                        audioLanguageValidationStatus:'probed'
                    }];
                    return [];
                }
            };
            host.innerHTML = '<section id="page-home"></section>';
            page = new HomePage({currentPage:'home', refreshSourceHealth:async () => ({state:'ready'})});
            for (const method of ['renderServiceHealth','renderEcosystemCard','renderImportRibbon','renderMyList','renderHistory']) page[method]=()=>{};
            page.renderFavoriteChannels=async()=>{};
            page.shouldShowSetupGate=()=>false;
            page.renderLayout();
            const start=performance.now();
            loading=page.loadDashboardData({skipCache:true});
            // The slow responses stay unresolved: readiness is causal, not an
            // assertion against production network timing or a raised timeout.
            const until=performance.now()+2000;
            while (!document.querySelector('#home-hero:not(.hidden) h1')?.textContent && performance.now()<until)
                await new Promise(r=>setTimeout(r,20));
            const title=document.querySelector('#home-hero:not(.hidden) h1')?.textContent;
            if(title!=='Cold Home Film') throw Error('ready movie held behind unresolved series');
            if(!document.querySelector('#home-rails .dashboard-card')) throw Error('real card absent');
            if(!document.getElementById('home-loading-state').classList.contains('is-hidden')) throw Error('loading state still hides usable Home');
            const firstPaintMs=Math.round(performance.now()-start);
            primary.resolve({rails:[]});series.resolve([]);await loading;
            if(document.querySelector('#home-hero h1')?.textContent!=='Cold Home Film') throw Error('late empty result erased movie');
            host.dataset.coldHomeProof=JSON.stringify({firstPaintMs,cacheEntries:0,seriesPendingAtPaint:true,realHero:true});
            return {firstPaintMs,cacheEntries:0,seriesPendingAtPaint:true,realHero:true};
        } finally {
            primary.resolve({rails:[]});series.resolve([]);
            if(loading) await loading;
            page?.cancelPendingLoad();page?.hide();
            window.API=oldApi;window.NorvaCatalogCache=oldCache;
        }
    }
};

