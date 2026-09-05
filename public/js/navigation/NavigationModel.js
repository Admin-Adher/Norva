/**
 * Norva navigation model.
 *
 * This is the single policy module for routes, actions, visibility gates and
 * projection order. Platform adapters render it; pages only react to intents.
 */
(function exposeNavigationModel(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.NorvaNavigationModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createNavigationModelApi() {
    'use strict';

    const ICON_VERSION = 'sharp-core-1';

    const assetIcon = (name) => Object.freeze({
        kind: 'asset',
        src: `/img/icons/norva-${name}.svg?v=${ICON_VERSION}`,
    });

    const DEFAULT_ROUTES = Object.freeze([
        {
            key: 'home',
            i18nKey: 'ui_home',
            label: (globalThis.NorvaI18n?.t("ui_web_3a78695388b3", { defaultValue: "Home" }) ?? 'Home'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_3a78695388b3", { defaultValue: "Home" }) ?? 'Home'),
            gate: 'always',
            icon: assetIcon('home'),
            continuity: true,
            transition: {
                title: (globalThis.NorvaI18n?.t("ui_web_a431a105dd81", { defaultValue: "Opening Home" }) ?? 'Opening Home'),
                detail: (globalThis.NorvaI18n?.t("ui_web_51d9672e53bb", { defaultValue: "Bringing back your picks and progress." }) ?? 'Bringing back your picks and progress.'),
            },
        },
        {
            key: 'live',
            i18nKey: 'ui_live',
            label: (globalThis.NorvaI18n?.t("ui_web_d451ef69d283", { defaultValue: "Live TV" }) ?? 'Live TV'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_d451ef69d283", { defaultValue: "Live TV" }) ?? 'Live TV'),
            gate: 'catalog',
            icon: assetIcon('live-tv'),
            catalog: true,
            continuity: true,
            transition: {
                title: (globalThis.NorvaI18n?.t("ui_web_8f280db38bd8", { defaultValue: "Preparing Live TV" }) ?? 'Preparing Live TV'),
                detail: (globalThis.NorvaI18n?.t("ui_web_5c4a8703bd09", { defaultValue: "Loading channels and guide information." }) ?? 'Loading channels and guide information.'),
            },
        },
        {
            key: 'movies',
            i18nKey: 'ui_movies',
            label: (globalThis.NorvaI18n?.t("ui_web_dff924b69f96", { defaultValue: "Movies" }) ?? 'Movies'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_dff924b69f96", { defaultValue: "Movies" }) ?? 'Movies'),
            gate: 'catalog',
            icon: assetIcon('movies'),
            catalog: true,
            continuity: true,
            transition: {
                title: (globalThis.NorvaI18n?.t("ui_web_319b8d9da10a", { defaultValue: "Opening Movies" }) ?? 'Opening Movies'),
                detail: (globalThis.NorvaI18n?.t("ui_web_5d1fac67a474", { defaultValue: "Restoring your catalogue and filters." }) ?? 'Restoring your catalogue and filters.'),
            },
        },
        {
            key: 'series',
            i18nKey: 'ui_series',
            label: (globalThis.NorvaI18n?.t("ui_web_a8295e08ff7a", { defaultValue: "Series" }) ?? 'Series'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_a8295e08ff7a", { defaultValue: "Series" }) ?? 'Series'),
            gate: 'catalog',
            icon: assetIcon('series'),
            catalog: true,
            continuity: true,
            transition: {
                title: (globalThis.NorvaI18n?.t("ui_web_a8384d6ea43d", { defaultValue: "Opening Series" }) ?? 'Opening Series'),
                detail: (globalThis.NorvaI18n?.t("ui_web_5d1fac67a474", { defaultValue: "Restoring your catalogue and filters." }) ?? 'Restoring your catalogue and filters.'),
            },
        },
        {
            key: 'settings',
            i18nKey: 'ui_settings',
            label: (globalThis.NorvaI18n?.t("ui_web_74a883a037bc", { defaultValue: "Settings" }) ?? 'Settings'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_74a883a037bc", { defaultValue: "Settings" }) ?? 'Settings'),
            gate: 'always',
            icon: assetIcon('settings'),
            continuity: true,
            transition: {
                title: (globalThis.NorvaI18n?.t("ui_web_e862eaaabfbb", { defaultValue: "Opening Settings" }) ?? 'Opening Settings'),
                detail: (globalThis.NorvaI18n?.t("ui_web_d81fe465f0ee", { defaultValue: "Loading this screen without moving your place." }) ?? 'Loading this screen without moving your place.'),
            },
        },
        {
            key: 'admin',
            label: (globalThis.NorvaI18n?.t("ui_web_c1c224b03cd9", { defaultValue: "Admin" }) ?? 'Admin'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_c1c224b03cd9", { defaultValue: "Admin" }) ?? 'Admin'),
            gate: 'admin',
            platforms: Object.freeze(['web']),
            icon: assetIcon('account'),
        },
        {
            key: 'partners',
            label: (globalThis.NorvaI18n?.t("ui_web_5dab502bfba3", { defaultValue: "Partners" }) ?? 'Partners'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_5dab502bfba3", { defaultValue: "Partners" }) ?? 'Partners'),
            gate: 'internal',
            continuity: true,
        },
        {
            key: 'watch',
            label: (globalThis.NorvaI18n?.t("ui_web_a71e75732446", { defaultValue: "Watch" }) ?? 'Watch'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_a71e75732446", { defaultValue: "Watch" }) ?? 'Watch'),
            gate: 'internal',
        },
    ]);

    const DEFAULT_ACTIONS = Object.freeze([
        {
            key: 'search',
            i18nKey: 'ui_search',
            label: (globalThis.NorvaI18n?.t("ui_web_49c266baaaa7", { defaultValue: "Search" }) ?? 'Search'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_49c266baaaa7", { defaultValue: "Search" }) ?? 'Search'),
            gate: 'vod-catalog',
            icon: Object.freeze({
                kind: 'svg',
                body: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
            }),
        },
        {
            key: 'downloads',
            i18nKey: 'ui_downloads',
            label: (globalThis.NorvaI18n?.t("ui_web_d5fdc1af021e", { defaultValue: "Downloads" }) ?? 'Downloads'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_d5fdc1af021e", { defaultValue: "Downloads" }) ?? 'Downloads'),
            gate: 'vod-catalog-or-local',
            platforms: Object.freeze(['phone']),
            icon: Object.freeze({
                kind: 'svg',
                body: '<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/>',
            }),
        },
        {
            key: 'account',
            label: (globalThis.NorvaI18n?.t("ui_web_d696a35bdd18", { defaultValue: "Profile" }) ?? 'Profile'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_1e50ce34d4c6", { defaultValue: "Account and settings" }) ?? 'Account and settings'),
            gate: 'always',
            icon: Object.freeze({
                kind: 'avatar',
                src: '/img/avatars/placeholder.svg',
            }),
        },
        {
            key: 'logout',
            i18nKey: 'ui_sign_out',
            label: (globalThis.NorvaI18n?.t("ui_web_49616145514e", { defaultValue: "Log out" }) ?? 'Log out'),
            ariaLabel: (globalThis.NorvaI18n?.t("ui_web_49616145514e", { defaultValue: "Log out" }) ?? 'Log out'),
            gate: 'authenticated',
            icon: assetIcon('logout'),
        },
    ]);

    const DEFAULT_PROJECTIONS = Object.freeze({
        web: Object.freeze([
            'home',
            'live',
            'movies',
            'series',
            // Android tablets use the wide header projection. The native-phone
            // platform gate keeps this action unavailable in ordinary browsers.
            Object.freeze({ key: 'downloads', id: 'nav-downloads' }),
        ]),
        phone: Object.freeze([
            'home',
            'live',
            'movies',
            'series',
            Object.freeze({ key: 'search', id: 'nav-search-bottom' }),
            Object.freeze({ key: 'downloads', id: 'nav-downloads-bottom' }),
            Object.freeze({
                key: 'account',
                id: 'nav-account',
                iconId: 'nav-account-img',
            }),
        ]),
        tv: Object.freeze([
            'home',
            'live',
            'movies',
            'series',
            'settings',
            Object.freeze({ key: 'logout', id: 'logout-btn' }),
        ]),
    });

    function freezeDeep(value) {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
        Object.freeze(value);
        Object.values(value).forEach(freezeDeep);
        return value;
    }

    function normalizeProjectionItem(item) {
        return typeof item === 'string' ? { key: item } : { ...item };
    }

    function escapeAttribute(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function escapeText(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Resolve the two VOD actions without confusing server reachability with
     * actual catalogue or device capability.
     *
     * Unknown health preserves Search's last reliable state. Downloads never
     * depends on that stale server state: a local transfer or saved title keeps
     * the native library reachable even when every provider is paused/offline.
     */
    function resolveMediaActionVisibility({
        catalogKnown = false,
        moviesAvailable = false,
        seriesAvailable = false,
        hasLocalDownloads = false,
        previousSearchVisible = false,
    } = {}) {
        const vodAvailable = Boolean(catalogKnown && (moviesAvailable || seriesAvailable));
        return Object.freeze({
            search: catalogKnown ? vodAvailable : Boolean(previousSearchVisible),
            downloads: vodAvailable || Boolean(hasLocalDownloads),
            vodAvailable,
        });
    }

    class NavigationModel {
        constructor({ routes = [], actions = [], projections = {} } = {}) {
            this._entries = new Map();
            this._projections = new Map();

            for (const [kind, definitions] of [['route', routes], ['action', actions]]) {
                for (const definition of definitions) {
                    const key = String(definition?.key || '').trim();
                    if (!key) throw new Error(`Navigation ${kind} is missing a key`);
                    if (this._entries.has(key)) throw new Error(`Duplicate navigation key: ${key}`);
                    const entry = freezeDeep({
                        gate: 'always',
                        label: key,
                        ariaLabel: definition.ariaLabel || definition.label || key,
                        ...definition,
                        key,
                        kind,
                        target: definition.target || key,
                    });
                    this._entries.set(key, entry);
                }
            }

            for (const [projection, rawItems] of Object.entries(projections)) {
                const seen = new Set();
                const items = rawItems.map((rawItem) => {
                    const item = normalizeProjectionItem(rawItem);
                    if (!this._entries.has(item.key)) {
                        throw new Error(`Unknown navigation key "${item.key}" in ${projection} projection`);
                    }
                    if (seen.has(item.key)) {
                        throw new Error(`Duplicate navigation key "${item.key}" in ${projection} projection`);
                    }
                    seen.add(item.key);
                    return freezeDeep(item);
                });
                this._projections.set(projection, Object.freeze(items));
            }
        }

        entry(key) {
            return this._entries.get(key) || null;
        }

        hasKey(key) {
            return this._entries.has(key);
        }

        projectionNames() {
            return [...this._projections.keys()];
        }

        projectionItems(projection) {
            const items = this._projections.get(projection);
            if (!items) throw new Error(`Unknown navigation projection: ${projection}`);
            return [...items];
        }

        keysFor(projection) {
            return this.projectionItems(projection).map((item) => item.key);
        }

        intentForKey(key) {
            const entry = this.entry(key);
            if (!entry) return null;
            return freezeDeep({ key: entry.key, kind: entry.kind, target: entry.target });
        }

        catalogPageNames() {
            return [...this._entries.values()]
                .filter((entry) => entry.kind === 'route' && entry.catalog)
                .map((entry) => entry.target);
        }

        continuityPageNames() {
            return [...this._entries.values()]
                .filter((entry) => entry.kind === 'route' && entry.continuity)
                .map((entry) => entry.target);
        }

        isCatalogPage(pageName) {
            const entry = this.entry(pageName);
            return Boolean(entry?.kind === 'route' && entry.catalog);
        }

        allowsPlatform(key, platform) {
            const entry = this.entry(key);
            if (!entry) return false;
            return !entry.platforms || entry.platforms.includes(platform);
        }

        transitionFor(pageName) {
            return this.entry(pageName)?.transition || null;
        }

        mediaActionVisibility(state) {
            return resolveMediaActionVisibility(state);
        }

        renderProjection(projection, { currentPage = 'home' } = {}) {
            return this.projectionItems(projection)
                .map((item) => this.renderLink(item, currentPage))
                .join('\n');
        }

        renderLink(item, currentPage) {
            const entry = this.entry(item.key);
            if (!entry) return '';
            const isCurrent = entry.kind === 'route' && entry.target === currentPage;
            const isHidden = entry.gate !== 'always';
            const classes = ['nav-link'];
            if (isCurrent) classes.push('active');
            if (entry.gate === 'catalog' && isHidden) classes.push('catalog-nav-hidden');

            const attributes = [];
            if (item.id) attributes.push(`id="${escapeAttribute(item.id)}"`);
            attributes.push('href="#"');
            attributes.push(`data-nav-key="${escapeAttribute(entry.key)}"`);
            attributes.push(`data-nav-kind="${escapeAttribute(entry.kind)}"`);
            attributes.push(entry.kind === 'route'
                ? `data-page="${escapeAttribute(entry.target)}"`
                : `data-action="${escapeAttribute(entry.target)}"`);
            attributes.push(`data-nav-gate="${escapeAttribute(entry.gate)}"`);
            attributes.push(`class="${classes.join(' ')}"`);
            attributes.push(`aria-label="${escapeAttribute(entry.ariaLabel)}"`);
            if (entry.i18nKey) attributes.push(`data-i18n-aria-label="${escapeAttribute(entry.i18nKey)}"`);
            if (isCurrent) attributes.push('aria-current="page"');
            if (isHidden) attributes.push('hidden', 'aria-hidden="true"', 'tabindex="-1"');
            if (isHidden && entry.gate !== 'catalog') attributes.push('style="display:none"');

            const labelAttributes = entry.i18nKey ? ` data-i18n="${escapeAttribute(entry.i18nKey)}"` : '';
            return `<a ${attributes.join(' ')}>${this.renderIcon(entry.icon, item)}<span${labelAttributes}>${escapeText(entry.label)}</span></a>`;
        }

        renderIcon(icon, item) {
            if (!icon) return '<span class="nav-icon" aria-hidden="true"></span>';
            if (icon.kind === 'asset') {
                return `<span class="nav-icon"><img class="icon norva-ui-icon" src="${escapeAttribute(icon.src)}" alt=""></span>`;
            }
            if (icon.kind === 'avatar') {
                const id = item.iconId ? ` id="${escapeAttribute(item.iconId)}"` : '';
                return `<span class="nav-icon"><img${id} class="nav-account-avatar" src="${escapeAttribute(icon.src)}" alt=""></span>`;
            }
            if (icon.kind === 'svg') {
                return `<span class="nav-icon"><svg class="icon norva-ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon.body}</svg></span>`;
            }
            return `<span class="nav-icon" aria-hidden="true">${escapeText(icon.text)}</span>`;
        }
    }

    function createDefaultNavigationModel() {
        return new NavigationModel({
            routes: DEFAULT_ROUTES,
            actions: DEFAULT_ACTIONS,
            projections: DEFAULT_PROJECTIONS,
        });
    }

    return Object.freeze({
        NavigationModel,
        createDefaultNavigationModel,
        resolveMediaActionVisibility,
        DEFAULT_ROUTES,
        DEFAULT_ACTIONS,
        DEFAULT_PROJECTIONS,
    });
}));
