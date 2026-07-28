# Norva shared layouts

## App shell

- Shell source: `public/app.html`
- Runtime layout behavior: `public/js/app.js`
- Shared styles: `public/css/main.css`
- Page content controllers: `public/js/pages/*.js`
- Mobile: the top navbar remains the compact global-action bar; the `.bottom-nav` is the primary phone navigation. The bottom bar is hidden while `body.is-watching` is active.

The SPA mounts page controllers into these DOM containers:

| Mount | Controller |
|---|---|
| `#page-home` | `public/js/pages/HomePage.js` |
| `#page-live` | `public/js/pages/LivePage.js` |
| `#page-movies` | `public/js/pages/MoviesPage.js` |
| `#page-series` | `public/js/pages/SeriesPage.js` |
| `#page-settings` | `public/js/pages/Settings.js` |
| `#page-admin` | lazy `public/js/pages/AdminPage.js` |
| `#page-watch` | `public/js/pages/WatchPage.js` |

## Top navigation

- Source: `public/app.html`
- Description: global brand navigation, desktop/tablet page links, global search, companion-device discovery, notifications and profile switcher.
- State contract: page links use `data-page`; native-only actions use `data-action`; hidden catalogue entries are progressively revealed by source health.

Full layout source:

```html
<nav class="navbar">
  <div class="navbar-brand" id="navbar-brand-home" role="button" tabindex="0" aria-label="Go to Home">
    <span class="logo"><img src="/img/norva-app-icon.png" alt="Norva"></span>
    <span class="brand-text">Norva</span>
  </div>
  <button class="mobile-menu-toggle" id="mobile-menu-toggle" aria-label="Toggle menu">
    <span></span>
    <span></span>
    <span></span>
  </button>
  <div class="navbar-menu" id="navbar-menu">
    <a href="#" class="nav-link active" data-page="home">
      <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-home.svg" alt=""></span>
      <span>Home</span>
    </a>
    <a href="#" class="nav-link catalog-nav-hidden" data-page="live" hidden aria-hidden="true" tabindex="-1">
      <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-live-tv.svg" alt=""></span>
      <span>Live TV</span>
    </a>
    <a href="#" class="nav-link catalog-nav-hidden" data-page="movies" hidden aria-hidden="true" tabindex="-1">
      <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-movies.svg" alt=""></span>
      <span>Movies</span>
    </a>
    <a href="#" class="nav-link catalog-nav-hidden" data-page="series" hidden aria-hidden="true" tabindex="-1">
      <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-series.svg" alt=""></span>
      <span>Series</span>
    </a>
    <a href="#" class="nav-link" id="nav-downloads" data-action="downloads" hidden aria-hidden="true" tabindex="-1" style="display:none">
      <span class="nav-icon"><svg class="icon norva-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg></span>
      <span>Downloads</span>
    </a>
    <a href="#" class="nav-link" id="nav-admin" data-page="admin" hidden aria-hidden="true" tabindex="-1" style="display:none">
      <span class="nav-icon">⚙️</span>
      <span>Admin</span>
    </a>
    <a href="#" class="nav-link" data-page="settings">
      <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-settings.svg" alt=""></span>
      <span>Settings</span>
    </a>
  </div>
  <button class="nav-search-btn" id="nav-search" type="button" aria-label="Search">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
  </button>
  <button class="nav-devices-btn" id="nav-devices" type="button" aria-label="Devices" aria-haspopup="true" aria-expanded="false" hidden>
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M10 15v4"/><path d="M7 19h6"/><rect x="16" y="12" width="6" height="10" rx="2"/></svg>
    <span class="nav-devices-dot" id="nav-devices-dot" hidden></span>
  </button>
  <button class="nav-bell-btn" id="nav-bell" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false" hidden>
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
    <span class="nav-bell-dot" id="nav-bell-dot" hidden></span>
  </button>
  <button class="nav-profile" id="nav-profile" type="button" hidden aria-label="Switch profile">
    <img class="nav-profile-img" id="nav-profile-img" src="/img/avatars/placeholder.svg" alt="">
  </button>
</nav>
```

## Mobile bottom navigation

- Source: `public/app.html`
- Description: phone-only primary tab bar. It deliberately reuses `.nav-link` and `data-page`, so the same SPA router updates top and bottom active states.
- Non-route actions: Search opens a modal/sheet, Downloads opens the native offline activity, Profile opens the account sheet.

Full layout source:

```html
<nav class="bottom-nav" id="bottom-nav" aria-label="Primary">
  <a href="#" class="nav-link active" data-page="home">
    <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-home.svg" alt=""></span>
    <span>Home</span>
  </a>
  <a href="#" class="nav-link catalog-nav-hidden" data-page="live" hidden aria-hidden="true" tabindex="-1">
    <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-live-tv.svg" alt=""></span>
    <span>Live TV</span>
  </a>
  <a href="#" class="nav-link catalog-nav-hidden" data-page="movies" hidden aria-hidden="true" tabindex="-1">
    <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-movies.svg" alt=""></span>
    <span>Movies</span>
  </a>
  <a href="#" class="nav-link catalog-nav-hidden" data-page="series" hidden aria-hidden="true" tabindex="-1">
    <span class="nav-icon"><img class="icon norva-ui-icon" src="/img/icons/norva-series.svg" alt=""></span>
    <span>Series</span>
  </a>
  <a href="#" class="nav-link" id="nav-search-bottom" data-action="search" aria-label="Search">
    <span class="nav-icon"><svg class="icon norva-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
    <span>Search</span>
  </a>
  <a href="#" class="nav-link" id="nav-downloads-bottom" data-action="downloads" hidden aria-hidden="true" tabindex="-1" style="display:none">
    <span class="nav-icon"><svg class="icon norva-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg></span>
    <span>Downloads</span>
  </a>
  <a href="#" class="nav-link" id="nav-account" data-action="account" aria-label="Account and settings">
    <span class="nav-icon"><img id="nav-account-img" class="nav-account-avatar" src="/img/avatars/placeholder.svg" alt=""></span>
    <span>Profile</span>
  </a>
</nav>
```

Actual shared click dispatch from `public/js/app.js`:

```js
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
        if (link.dataset.external === 'true') return;
        // Downloads opens the NATIVE offline screen (not an SPA page) so
        // it works with no connectivity. Phone/tablet app only.
        if (link.dataset.action === 'search') {
            e.preventDefault();
            this.openSearch();
            return;
        }
        if (link.dataset.action === 'account') {
            e.preventDefault();
            this.openAccountSheet();
            return;
        }
        if (link.dataset.action === 'downloads') {
            e.preventDefault();
            document.getElementById('mobile-menu-toggle')?.classList.remove('active');
            document.getElementById('navbar-menu')?.classList.remove('active');
            try { window.NorvaTVCloud?.openDownloads?.(); } catch (_) { /* no bridge */ }
            return;
        }
        e.preventDefault();
        this.navigateTo(link.dataset.page);
    });
});
```

## Mobile account sheet

- Source: `public/js/app.js`
- Description: dynamically-created modal bottom sheet behind the Profile tab, with profile switch, ecosystem/devices, Settings, and sign-out actions.
- Accessibility contract: dialog role and `aria-modal`; explicit close control; backdrop closes the sheet.

Full source:

```js
// ---- Account sheet (mobile Profile tab) -------------------------------
// A bottom sheet that consolidates the account actions that were scattered
// before — profile switch (top-right avatar), Settings (bottom tab) and
// log out (hidden in the desktop hamburger) — into one reachable place.

openAccountSheet() {
    const sheet = document.getElementById('account-sheet') || this.buildAccountSheet();
    this.refreshAccountSheet(sheet);
    sheet.classList.add('active');
}

closeAccountSheet() {
    document.getElementById('account-sheet')?.classList.remove('active');
}

openScreensSettings() {
    if (this.currentPage !== 'settings') {
        this.navigateTo('settings');
    }
    // Settings.show() can still be completing its account/source refresh after the
    // page becomes visible. switchTab itself is synchronous, so one animation frame
    // is enough to select the permanent devices entry without flashing Advanced.
    requestAnimationFrame(() => this.pages.settings?.switchTab?.('screens'));
}

buildAccountSheet() {
    const overlay = document.createElement('div');
    overlay.id = 'account-sheet';
    overlay.className = 'modal-overlay account-sheet';
    overlay.innerHTML = `
        <div class="account-panel" role="dialog" aria-modal="true" aria-label="Account">
            <div class="account-head">
                <img id="account-avatar" class="account-avatar" src="/img/avatars/placeholder.svg" alt="">
                <div class="account-id">
                    <div id="account-name" class="account-name">Profile</div>
                    <div id="account-email" class="account-email"></div>
                </div>
                <button type="button" class="account-close" aria-label="Close">&times;</button>
            </div>
            <button type="button" class="account-row" data-act="switch">
                <img class="account-ic" src="/img/avatars/placeholder.svg" alt=""><span>Switch profile</span>
            </button>
            <button type="button" class="account-row" data-act="screens">
                <img class="account-ic account-ic-devices" src="/assets/landing/norva-icon-web-android.svg" alt="">
                <span class="account-row-copy">
                    <span class="account-row-title">Devices &amp; screens</span>
                    <span class="account-row-hint">Web, phone, tablet and TV</span>
                </span>
            </button>
            <button type="button" class="account-row" data-act="settings">
                <img class="account-ic" src="/img/icons/norva-settings.svg" alt=""><span>Settings</span>
            </button>
            <button type="button" class="account-row account-row-danger" data-act="logout">
                <img class="account-ic" src="/img/icons/norva-logout.svg" alt=""><span>Log out</span>
            </button>
        </div>`;
    // Tapping the dimmed backdrop (not the panel) closes the sheet.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.closeAccountSheet(); });
    overlay.querySelector('.account-close').addEventListener('click', () => this.closeAccountSheet());
    overlay.querySelectorAll('.account-row').forEach((row) => {
        row.addEventListener('click', () => {
            const act = row.dataset.act;
            this.closeAccountSheet();
            if (act === 'switch') window.NorvaProfiles?.openSwitcher?.();
            else if (act === 'screens') this.openScreensSettings();
            else if (act === 'settings') this.navigateTo('settings');
            else if (act === 'logout') this.signOut();
        });
    });
    document.body.appendChild(overlay);
    return overlay;
}

refreshAccountSheet(sheet) {
    const cur = (window.NorvaProfiles?.current?.()) || {};
    const avatar = sheet.querySelector('#account-avatar');
    const switchIc = sheet.querySelector('[data-act="switch"] .account-ic');
    const name = sheet.querySelector('#account-name');
    const email = sheet.querySelector('#account-email');
    const switchRow = sheet.querySelector('[data-act="switch"]');
    const screensRow = sheet.querySelector('[data-act="screens"]');
    if (avatar && cur.avatarUrl) avatar.src = cur.avatarUrl;
    if (switchIc && cur.avatarUrl) switchIc.src = cur.avatarUrl;
    if (name) name.textContent = cur.name || 'Profile';
    if (email) email.textContent = this.currentUser?.email || this.currentUser?.username || '';
    // Profile switching only exists in cloud mode.
    if (switchRow) switchRow.style.display = cur.isCloud ? '' : 'none';
    if (screensRow) {
        const cloudUser = Boolean(cur.isCloud || this.currentUser?.cloud || window.API?.isCloudMode?.());
        screensRow.style.display = cloudUser ? '' : 'none';
    }
}
```

## Notifications inbox

- Static trigger source: top-navigation markup in `public/app.html`.
- Dynamic surface source: `public/js/app.js`.
- Description: anchored web/mobile inbox (viewport-safe modal on TV) merging catalogue events and support replies, with unread count, deep links, focus entry/return, Escape/outside close, and a keyboard focus loop.

The complete rendering and interaction method:

```js
toggleNotifications() {
    const open = document.getElementById('norva-notif-panel');
    if (open) {
        if (this._closeNotifications) this._closeNotifications();
        else open.remove();
        document.getElementById('nav-bell')?.setAttribute('aria-expanded', 'false');
        return;
    }
    const bell = document.getElementById('nav-bell');
    const tv = this.isTvMode();
    const panel = document.createElement('div');
    panel.id = 'norva-notif-panel';
    const surface = tv ? document.createElement('section') : panel;
    if (tv) {
        // `modal-overlay active` is an intentional contract with tvNavigation:
        // arrows stay inside this panel and hardware Back clicks `.modal-close`.
        panel.className = 'modal-overlay active norva-notif-tv-overlay';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.dataset.restoreFocus = 'nav-bell';
        surface.className = 'norva-notif-panel norva-notif-tv-surface';
        panel.appendChild(surface);
    } else {
        panel.className = 'norva-notif-panel';
        panel.setAttribute('role', 'dialog');
    }
    panel.setAttribute('aria-label', 'Notifications');
    const events = this._notifEvents || [];
    const timeAgo = (iso) => {
        const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    };
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // Support entries are links straight into their ticket (support.html auto-expands
    // & scrolls ?ticket=); catalog entries stay informational.
    const here = location.pathname + location.search + location.hash;
    // Subtitle-ready events carry payload.watch ("movies/open:…") — render them as deep
    // links into the fiche (handled in-app below; the href keeps middle-click working).
    const watchRoute = (e) => {
        const w = e.kind !== 'support' && e.payload && typeof e.payload.watch === 'string' ? e.payload.watch : '';
        return /^(movies|series)\/open:/.test(w) ? w : '';
    };
    const item = (e) => e.kind === 'support'
        ? `<a class="norva-notif-item${e.seen_at ? '' : ' unread'}" href="/support.html?ticket=${encodeURIComponent(e.ticket_id)}&returnTo=${encodeURIComponent(here)}">
                <span class="norva-notif-kind">Support</span>
                <div class="norva-notif-summary">${esc(e.summary || 'Support replied')}</div>
                <div class="norva-notif-time">${esc(timeAgo(e.created_at))} · Open conversation</div>
            </a>`
        : watchRoute(e)
            ? `<a class="norva-notif-item${e.seen_at ? '' : ' unread'}" href="/app.html#${esc(watchRoute(e))}" data-watch="${esc(watchRoute(e))}">
                <span class="norva-notif-kind">New</span>
                <div class="norva-notif-summary">${esc(e.summary || 'New content')}</div>
                <div class="norva-notif-time">${esc(timeAgo(e.created_at))} · View details</div>
            </a>`
            : `<div class="norva-notif-item${e.seen_at ? '' : ' unread'}" role="article" tabindex="0">
                <span class="norva-notif-kind">Update</span>
                <div class="norva-notif-summary">${esc(e.summary || 'New content')}</div>
                <div class="norva-notif-time">${esc(timeAgo(e.created_at))}</div>
            </div>`;
    surface.innerHTML = `
        <div class="norva-notif-head">
            <div class="norva-notif-heading">
                <strong>Notifications</strong>
                <span>${events.length ? `${events.length} recent update${events.length === 1 ? '' : 's'}` : 'You are all caught up'}</span>
            </div>
            <button type="button" class="norva-notif-close modal-close" data-notif-close>Close</button>
        </div>
        <div class="norva-notif-list">
            ${events.length ? events.map(item).join('') : `
                <div class="norva-notif-empty">
                    <strong>Nothing new right now</strong>
                    <span>Support replies and catalogue updates will appear here.</span>
                </div>`}
        </div>`;
    document.body.appendChild(panel);
    let closed = false;
    const closePanel = ({ restoreFocus = true } = {}) => {
        if (closed) return;
        closed = true;
        panel.remove();
        bell?.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', closeOnOutside, true);
        document.removeEventListener('keydown', closeOnOutside, true);
        this._closeNotifications = null;
        if (restoreFocus && bell?.isConnected) {
            requestAnimationFrame(() => {
                try { bell.focus({ preventScroll: true }); } catch (_) { bell.focus?.(); }
            });
        }
    };
    this._closeNotifications = closePanel;
    surface.querySelector('[data-notif-close]')?.addEventListener('click', () => closePanel());
    // Watch deep links navigate IN-APP (a hash-only href would not reload the SPA): route to
    // the catalogue page and reuse the same openFicheFromRoute the boot deep link goes through.
    surface.querySelectorAll('[data-watch]').forEach((a) => a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const w = a.getAttribute('data-watch') || '';
        const page = w.split('/')[0];
        if (!this.pages?.[page]) return;
        this._openFicheRoute = w.slice(page.length + 1);
        closePanel({ restoreFocus: false });
        this.navigateTo(page);
        this.openFicheFromRoute(page);
    }));
    // Desktop/web remains a compact anchored popover. TV uses the viewport-safe
    // overlay CSS instead, because its bell sits at the bottom of the left rail.
    if (!tv) {
        try {
            const r = bell.getBoundingClientRect();
            const maxTop = Math.max(16, window.innerHeight - panel.offsetHeight - 16);
            panel.style.top = `${Math.max(16, Math.min(Math.round(r.bottom + 8), maxTop))}px`;
            panel.style.right = `${Math.max(16, Math.round(window.innerWidth - r.right))}px`;
        } catch (_) { /* default CSS position */ }
    }
    bell?.setAttribute('aria-expanded', 'true');
    // Focus is moved into the panel after layout. Combined with the TV modal scope
    // above, no D-pad move can leak behind it; close always restores the bell.
    requestAnimationFrame(() => {
        const first = surface.querySelector('a.norva-notif-item, .norva-notif-item[tabindex="0"], [data-notif-close]');
        try { first?.focus({ preventScroll: true }); } catch (_) { first?.focus?.(); }
    });
    // Opening the inbox marks the unseen entries read — each feed via its own mechanism:
    // catalog ids → contentEvents.markSeen (NEVER send it the synthetic support ids),
    // support → advance the shared 'norva-support-seen' watermark (server timestamps).
    const unseenIds = events.filter(e => !e.seen_at && e.kind !== 'support').map(e => e.id).filter(Boolean);
    if (unseenIds.length) window.NorvaCloud.contentEvents.markSeen(unseenIds);
    const unseenSupport = events.filter(e => e.kind === 'support' && !e.seen_at);
    if (unseenSupport.length) {
        const newest = unseenSupport.reduce((m, e) => (String(e.created_at || '') > m ? String(e.created_at) : m), '');
        try { if (newest) localStorage.setItem('norva-support-seen', newest); } catch (_) { /* private mode */ }
    }
    if (unseenIds.length || unseenSupport.length) {
        this._notifUnread = 0;
        const dot = document.getElementById('nav-bell-dot');
        if (dot) { dot.textContent = ''; dot.setAttribute('hidden', ''); }
        events.forEach(e => { e.seen_at = e.seen_at || new Date().toISOString(); });
    }
    // Dismiss on outside click / Escape. Tab is explicitly trapped for keyboard
    // parity; D-pad confinement comes from the modal scope above.
    const closeOnOutside = (ev) => {
        if (ev.type === 'keydown' && ev.key === 'Tab') {
            const focusable = [...surface.querySelectorAll('a[href], button:not([disabled]), [tabindex="0"]')]
                .filter(el => el.offsetParent || el.getClientRects().length);
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (ev.shiftKey && document.activeElement === first) {
                ev.preventDefault();
                last.focus();
            } else if (!ev.shiftKey && document.activeElement === last) {
                ev.preventDefault();
                first.focus();
            }
            return;
        }
        if (ev.type === 'keydown' && ev.key !== 'Escape') return;
        if (ev.type === 'click' && (surface.contains(ev.target) || bell?.contains(ev.target))) return;
        closePanel();
    };
    setTimeout(() => {
        document.addEventListener('click', closeOnOutside, true);
        document.addEventListener('keydown', closeOnOutside, true);
    }, 0);
}
```

The inbox data preparation lives immediately above this method in `refreshNotifications()` and `_fetchSupportReplies()`. Those methods merge recent catalogue events with support tickets; the layout method above owns all rendered markup and focus behavior.
