# Norva route map

## Router profile

Norva is a vanilla JavaScript SPA served from `public/app.html`. It does not use a framework router. `public/js/app.js` owns page registration, hash parsing, History API entries, active mount switching and controller lifecycle.

The URL contract is hash-based:

| URL/hash | Page mount | Controller | Shared layout | Notes |
|---|---|---|---|---|
| `/app.html#home` | `#page-home` | `public/js/pages/HomePage.js` | top nav + mobile bottom nav | Default route |
| `/app.html#live` | `#page-live` | `public/js/pages/LivePage.js` | top nav + mobile bottom nav | Catalogue-gated |
| `/app.html#movies` | `#page-movies` | `public/js/pages/MoviesPage.js` | top nav + mobile bottom nav | Catalogue-gated |
| `/app.html#movies/open:<sourceId>:<id>:<title>` | `#page-movies` | `public/js/pages/MoviesPage.js` | top nav + mobile bottom nav | Opens a movie detail sub-view |
| `/app.html#series` | `#page-series` | `public/js/pages/SeriesPage.js` | top nav + mobile bottom nav | Catalogue-gated |
| `/app.html#series/open:<sourceId>:<id>:<title>` | `#page-series` | `public/js/pages/SeriesPage.js` | top nav + mobile bottom nav | Opens a series detail sub-view |
| `/app.html#settings` | `#page-settings` | `public/js/pages/Settings.js` | top nav + mobile bottom nav | Settings tabs are local UI state, not hash routes |
| `/app.html#watch` | `#page-watch` | `public/js/pages/WatchPage.js` | full-screen watch layout | Adds `body.is-watching`; mobile bottom nav is hidden |
| `/app.html#admin` | `#page-admin` | lazy `public/js/pages/AdminPage.js` | top nav | Admin-only; controller is downloaded after server-side claim verification |
| `/app.html#admin/<subroute>` | `#page-admin` | lazy `public/js/pages/AdminPage.js` | top nav | Subroute is stashed before the root hash is normalized |

The bottom navigation also exposes actions that intentionally are not routes:

- `data-action="search"` opens the global catalogue search surface.
- `data-action="downloads"` calls `window.NorvaTVCloud.openDownloads()` to open the native offline screen.
- `data-action="account"` opens the mobile account sheet.

## Page registration

Actual source from `public/js/app.js`:

```js
this.currentPage = 'home';
this.pages = {};
this.currentUser = null;

// Initialize components
this.player = new VideoPlayer();
this.channelList = new ChannelList();
this.sourceManager = new SourceManager();
this.epgGuide = new EpgGuide();
this.liveGuideFusion = new LiveGuideFusion(this);

// Initialize page controllers
this.pages.home = new HomePage(this);
this.pages.live = new LivePage(this);
this.pages.movies = new MoviesPage(this);
this.pages.series = new SeriesPage(this);
this.pages.settings = new SettingsPage(this);
this.pages.watch = new WatchPage(this);
// AdminPage (76 KB) is admin-only: loaded on demand (ensureAdminPage) so
// every non-admin phone stops downloading/parsing it at boot.
this.pages.admin = null;
this.entitlement = null;
this.sourceHealthSummary = null;
this.catalogPages = new Set(['live', 'movies', 'series']);
```

## Initial hash resolution

Actual source from `public/js/app.js`:

```js
// Navigate to the page from URL hash, or default to home. Sub-routes use
// "#page/sub" (e.g. #admin/client:<id>): the page key is the first segment.
const hash = window.location.hash.slice(1); // Remove #
const hashKey = hash.split('/')[0];
// Stash the admin sub-route BEFORE navigateTo rewrites the hash to "#admin" —
// AdminPage.show() consumes it to restore the exact CRM view (fiche, ticket…).
this._adminSubRoute = hashKey === 'admin' ? hash.slice('admin/'.length) : '';
// Fiche deep link (subtitle-ready emails, bell entries): #movies/open:… or #series/open:…
// — stashed the same way, consumed by openFicheFromRoute after the page has landed.
this._openFicheRoute = ((hashKey === 'movies' || hashKey === 'series') && hash.slice(hashKey.length + 1).startsWith('open:'))
    ? hash.slice(hashKey.length + 1) : '';
// `in` (not truthiness): lazy pages register as null until loaded (this.pages.admin),
// which used to send a refresh on #admin back to home.
const requestedInitialPage = hashKey && (hashKey in this.pages) ? hashKey : 'home';
if (requestedInitialPage !== 'home') await healthReady;
const initialPage = this.guardCatalogPage(requestedInitialPage);
// Capture any fiche open before a refresh BEFORE navigating (applyPage may clear
// the stash), then re-open it once we've landed on its catalogue page.
const pendingFiche = this.readOpenFiche();
this.navigateTo(initialPage, true); // true = replace history (don't add)
this.restoreOpenFiche(initialPage, pendingFiche);
this.openFicheFromRoute(initialPage);
```

## Browser/native Back contract

Actual source from `public/js/app.js`:

```js
// Handle browser back/forward buttons. The browser has already moved the
// history pointer, so reflect the popped entry WITHOUT pushing a new one
// (applyPage, not navigateTo) — otherwise Back stacks duplicate entries.
window.addEventListener('popstate', (e) => {
    const page = e.state?.page || 'home';
    this._histIdx = (typeof e.state?.idx === 'number') ? e.state.idx : 0;
    if (this.currentPage === page) return; // already showing it; idx synced
    this.applyPage(page);
});
```

Each router entry carries a monotonic `idx`. The Android shell can therefore distinguish `idx > 0` (pop SPA history) from root `idx === 0` (exit or delegate native Back).

## Catalogue route guard

Actual source from `public/js/app.js`:

```js
isCatalogPage(pageName) {
    return this.catalogPages.has(pageName);
}

isCatalogReady(summary = this.sourceHealthSummary) {
    if (!summary) return false;
    return summary.state === 'ready' || Boolean(summary.ready?.length);
}

guardCatalogPage(pageName) {
    if (!this.isCatalogPage(pageName)) return pageName;
    // Allow a catalog page during sync once its own category has content.
    return (this.isCatalogReady() || this.catalogCategoryAvailable(pageName)) ? pageName : 'home';
}
```

`live`, `movies`, and `series` are redirected to Home until either the full catalogue is ready or that category has content during progressive sync.

## Route mutation and page lifecycle

Full router methods from `public/js/app.js`:

```js
navigateTo(pageName, replaceHistory = false) {
    const requestedPage = pageName;
    pageName = this.guardCatalogPage(pageName);
    if (pageName !== requestedPage) {
        replaceHistory = true;
    }

    // Don't navigate if already on this page
    if (this.currentPage === pageName && !replaceHistory) {
        return;
    }

    // Update browser history. A monotonic `idx` lets the native Back button
    // tell the root app entry (idx 0 → exit the app) from a step it can pop
    // (idx > 0 → history.back()), and keeps Back tied to real tab order.
    if (replaceHistory) {
        // Replace current history entry (used on initial load)
        this._histIdx = 0;
        history.replaceState({ page: pageName, idx: 0 }, '', `#${pageName}`);
    } else {
        // Add new history entry
        this._histIdx = (this._histIdx || 0) + 1;
        history.pushState({ page: pageName, idx: this._histIdx }, '', `#${pageName}`);
    }

    this.applyPage(pageName);
}

/**
 * Switch the visible page WITHOUT touching history. Used by navigateTo (after
 * it records history) and by the popstate handler — which must NOT re-push the
 * entry the browser just popped, or Back would stack duplicates and need
 * several presses to move one tab.
 */
applyPage(pageName) {
    pageName = this.guardCatalogPage(pageName);
    const tvRouteToken = this.beginTvRouteTransition(pageName);

    // Navigating to a page that doesn't own the open fiche abandons it — drop the
    // saved-fiche token so a later refresh doesn't resurrect a detail you closed.
    const openFiche = this.readOpenFiche();
    if (openFiche && this.fichePageFor(openFiche) !== pageName) this.forgetOpenFiche();

    // Remember where the outgoing page was scrolled (page-level scroller, e.g.
    // #page-home; Movies/Series grids save their own scroller in hide()).
    this._pageScroll = this._pageScroll || {};
    const prevPageEl = document.getElementById(`page-${this.currentPage}`);
    if (prevPageEl) this._pageScroll[this.currentPage] = prevPageEl.scrollTop || 0;

    // Update nav
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.page === pageName);
    });

    // Update pages
    document.querySelectorAll('.page').forEach(page => {
        page.classList.toggle('active', page.id === `page-${pageName}`);
    });

    // Notify page controllers
    if (this.pages[this.currentPage]?.hide) {
        this.pages[this.currentPage].hide();
    }

    this.currentPage = pageName;
    // Hide the mobile bottom tab bar while watching (full-screen video).
    document.body.classList.toggle('is-watching', pageName === 'watch');

    // Playback pages want hls.js in flight before any stream resolves.
    if (pageName === 'live' || pageName === 'watch') window.ensureHls?.();

    let showResult = null;
    if (pageName === 'admin' && !this.pages.admin) {
        // Lazy web-only route: re-verify the admin claim server-side BEFORE
        // even downloading AdminPage.js; APK shells and non-admins bounce home.
        showResult = this.checkIsAdmin()
            .then((ok) => {
                if (!ok) { this.navigateTo('home'); return null; }
                return this.ensureAdminPage();
            })
            .then((page) => { if (page && this.currentPage === 'admin') page.show?.(); })
            .catch((err) => console.error('[App] AdminPage load failed:', err));
    } else if (this.pages[pageName]?.show) {
        try {
            showResult = this.pages[pageName].show();
        } catch (err) {
            console.error(`[App] ${pageName} page failed to open:`, err);
        }
    }
    Promise.resolve(showResult)
        .catch((err) => console.error(`[App] ${pageName} page preparation failed:`, err))
        .finally(() => this.endTvRouteTransition(tvRouteToken));

    // Restore the incoming page's position (two passes: instant, and once
    // async content has had a beat to paint back at full height).
    const savedTop = this._pageScroll[pageName] || 0;
    if (savedTop > 0) {
        const restore = () => {
            const el = document.getElementById(`page-${pageName}`);
            if (el && Math.abs(el.scrollTop - savedTop) > 4 && el.scrollHeight > savedTop) {
                el.scrollTop = savedTop;
            }
        };
        requestAnimationFrame(restore);
        setTimeout(restore, 350);
    }

    // After the switch: the watch page is its own fullscreen player, so a movie
    // /episode must never play under a still-floating live mini. Run this LAST —
    // the page being left has already had hide() (which may have just docked the
    // mini), so stopping here undocks + kills it before the movie starts.
    if (pageName === 'watch') {
        try { this.exitLiveMini({ stop: true }); } catch (_) { /* noop */ }
    }
}
```

## Movie/series fiche deep-link resolver

Actual source from `public/js/app.js`:

```js
// Fiche deep link: "open:<sourceId>:<id>:<title>" (segments encodeURIComponent-encoded) —
// the URL shape the subtitle-ready email button and the bell entries carry. Opens the fiche
// via the same openByItem resolver the global search and the Home rails use (the title makes
// the sibling-versions lookup work, so the fiche arrives full, not sparse). Best-effort: a
// stale/foreign id just leaves the catalogue page open.
openFicheFromRoute(pageName) {
    const route = String(this._openFicheRoute || '');
    this._openFicheRoute = '';
    if (!route.startsWith('open:')) return;
    const dec = (s) => { try { return decodeURIComponent(s || ''); } catch (_) { return ''; } };
    const [rawSourceId, id, title] = route.slice('open:'.length).split(':').map(dec);
    const pageObj = this.pages?.[pageName];
    if (!rawSourceId || !id || typeof pageObj?.openByItem !== 'function') return;
    // The link carries the CLOUD source UUID; the catalog pages key on the LOCAL alias.
    const sourceId = window.API?.localSourceIdFor ? window.API.localSourceIdFor(rawSourceId) : rawSourceId;
    // Defer so the page's show()/DOM has settled (mirrors restoreOpenFiche).
    setTimeout(() => {
        const item = pageName === 'series'
            ? { sourceId, series_id: id, name: title, ...(title ? { tmdb: { name: title } } : {}) }
            : { sourceId, stream_id: id, name: title, ...(title ? { tmdb: { title } } : {}) };
        Promise.resolve(pageObj.openByItem(item)).catch(() => {});
    }, 200);
}
```

## Script load order

`public/app.html` loads shared components first, then page controllers, and finally the router:

```html
<script defer src="/js/components/NorvaModal.js?v=1"></script>
<script defer src="/js/components/MultiSelect.js?v=2"></script>
<script defer src="/js/components/RegionPicker.js?v=1"></script>
<script defer src="/js/components/VideoPlayer.js?v=41"></script>
<script defer src="/js/components/ChannelList.js?v=47"></script>
<script defer src="/js/components/SourceManager.js?v=36"></script>
<script defer src="/js/components/EpgGuide.js?v=13"></script>
<script defer src="/js/components/LiveGuideFusion.js?v=28"></script>
<script defer src="/js/pages/HomePage.js?v=53"></script>
<script defer src="/js/pages/LivePage.js?v=8"></script>
<script defer src="/js/pages/Guide.js?v=2"></script>
<script defer src="/js/pages/MoviesPage.js?v=52"></script>
<script defer src="/js/pages/SeriesPage.js?v=51"></script>
<script defer src="/js/pages/Settings.js?v=45"></script>
<script defer src="/js/pages/WatchPage.js?v=126"></script>
<script defer src="/js/app.js?v=53"></script>
```
