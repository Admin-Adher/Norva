/**
 * DOM adapters for the Norva navigation model.
 *
 * The model owns policy. These adapters own platform projection and translate
 * DOM activation into one stable route/action intent.
 */
(function exposeNavigationAdapters(root, factory) {
    const modelApi = root?.NorvaNavigationModel
        || (typeof require === 'function' ? require('./NavigationModel.js') : null);
    const api = factory(modelApi);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.NorvaNavigationAdapters = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createNavigationAdaptersApi(modelApi) {
    'use strict';

    if (!modelApi) throw new Error('Norva navigation model must load before its adapters');

    class NavigationProjectionAdapter {
        constructor(rootElement, model, projection) {
            this.root = rootElement || null;
            this.model = model;
            this.projection = projection;
            this._intentHandler = null;
            this._clickHandler = null;
        }

        mount({ currentPage = 'home' } = {}) {
            if (!this.root) return this;
            this.root.dataset.navigationProjection = this.projection;
            this.root.innerHTML = this.model.renderProjection(this.projection, { currentPage });
            globalThis.NorvaI18n?.translate(this.root);
            return this;
        }

        bind(intentHandler) {
            this._intentHandler = typeof intentHandler === 'function' ? intentHandler : null;
            if (!this.root || this._clickHandler) return this;
            this._clickHandler = (event) => {
                const link = event.target?.closest?.('[data-nav-key]');
                if (!link || !this.root.contains(link)) return;
                const intent = this.model.intentForKey(link.dataset.navKey);
                if (!intent || !this._intentHandler) return;
                event.preventDefault();
                this._intentHandler({
                    ...intent,
                    projection: this.projection,
                    element: link,
                    originalEvent: event,
                });
            };
            this.root.addEventListener('click', this._clickHandler);
            return this;
        }

        links() {
            return this.root ? [...this.root.querySelectorAll('[data-nav-key]')] : [];
        }

        routeLinks() {
            return this.links().filter((link) => link.dataset.navKind === 'route');
        }

        findByKey(key) {
            return this.links().find((link) => link.dataset.navKey === key) || null;
        }

        setVisible(key, visible) {
            const link = this.findByKey(key);
            if (!link) return false;
            const show = Boolean(visible);
            const entry = this.model.entry(key);
            link.hidden = !show;
            link.style.display = show ? '' : 'none';
            link.setAttribute('aria-hidden', show ? 'false' : 'true');
            link.tabIndex = show ? 0 : -1;
            if (entry?.gate === 'catalog') {
                link.classList.toggle('catalog-nav-hidden', !show);
            }
            return true;
        }

        syncCurrent(pageName) {
            for (const link of this.links()) {
                const isCurrent = link.dataset.navKind === 'route'
                    && link.dataset.page === pageName;
                link.classList.toggle('active', isCurrent);
                if (isCurrent) link.setAttribute('aria-current', 'page');
                else link.removeAttribute('aria-current');
            }
            return this;
        }

        activeLink() {
            return this.links().find((link) => link.classList.contains('active')) || null;
        }
    }

    class WebNavigationAdapter extends NavigationProjectionAdapter {
        constructor(rootElement, model) {
            super(rootElement, model, 'web');
        }
    }

    class PhoneNavigationAdapter extends NavigationProjectionAdapter {
        constructor(rootElement, model) {
            super(rootElement, model, 'phone');
        }
    }

    class TvNavigationAdapter extends NavigationProjectionAdapter {
        constructor(rootElement, model) {
            super(rootElement, model, 'tv');
        }

        railLinks() {
            return this.links();
        }

        homeLink() {
            return this.findByKey('home');
        }
    }

    class NavigationController {
        constructor({ model, document: documentRef, userAgent = '', search = '' } = {}) {
            this.model = model;
            this.document = documentRef || null;
            this.userAgent = String(userAgent || '');
            this.search = String(search || '');
            this._adapters = new Map();
            let tvQuery = false;
            try { tvQuery = new URLSearchParams(this.search).has('tv'); } catch (_) { /* noop */ }
            this.isTvShell = /NorvaTV-AndroidTV/i.test(this.userAgent) || tvQuery;
            this.isNativePhoneShell = /NorvaTV-AndroidPhone/i.test(this.userAgent);
            this.platform = this.isTvShell
                ? 'tv'
                : (this.isNativePhoneShell ? 'phone' : 'web');
        }

        mount({ currentPage = 'home' } = {}) {
            if (!this.document) return this;
            const primaryRoot = this.document.querySelector('[data-navigation-root="primary"]');
            const phoneRoot = this.document.querySelector('[data-navigation-root="phone"]');
            const primary = this.isTvShell
                ? new TvNavigationAdapter(primaryRoot, this.model)
                : new WebNavigationAdapter(primaryRoot, this.model);
            primary.mount({ currentPage });
            this._adapters.set(primary.projection, primary);

            const phone = new PhoneNavigationAdapter(phoneRoot, this.model);
            phone.mount({ currentPage });
            this._adapters.set('phone', phone);
            return this;
        }

        bind(intentHandler) {
            for (const adapter of this._adapters.values()) adapter.bind(intentHandler);
            return this;
        }

        getAdapter(projection) {
            return this._adapters.get(projection) || null;
        }

        adapters() {
            return [...this._adapters.values()];
        }

        findAll(key) {
            return this.adapters()
                .map((adapter) => adapter.findByKey(key))
                .filter(Boolean);
        }

        setVisible(key, visible) {
            const platformVisible = Boolean(visible)
                && this.model.allowsPlatform(key, this.platform);
            let changed = false;
            for (const adapter of this._adapters.values()) {
                changed = adapter.setVisible(key, platformVisible) || changed;
            }
            return changed;
        }

        setCatalogAvailability(visibilityForPage) {
            let anyVisible = false;
            for (const pageName of this.model.catalogPageNames()) {
                const visible = Boolean(visibilityForPage(pageName));
                this.setVisible(pageName, visible);
                anyVisible = anyVisible || visible;
            }
            return anyVisible;
        }

        syncCurrent(pageName) {
            for (const adapter of this._adapters.values()) adapter.syncCurrent(pageName);
            return this;
        }
    }

    function createNavigationController(options = {}) {
        const model = options.model || modelApi.createDefaultNavigationModel();
        return new NavigationController({ ...options, model });
    }

    return Object.freeze({
        NavigationProjectionAdapter,
        WebNavigationAdapter,
        PhoneNavigationAdapter,
        TvNavigationAdapter,
        NavigationController,
        createNavigationController,
    });
}));
