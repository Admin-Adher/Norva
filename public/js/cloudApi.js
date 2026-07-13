/**
 * Norva Cloud client.
 *
 * This client is intentionally thin: authentication remains owned by Supabase
 * Auth / product UI, while this wrapper gives every Norva surface the same
 * Cloud Core and Playback Session contract.
 */
(function () {
    'use strict';

    // --- Refresh tracer --------------------------------------------------------
    // Opt-in (enable with localStorage.norva_trace="1" then reload) timeline so a page
    // refresh reads end-to-end in the console: every cloud/catalog network round-trip,
    // cache HIT/MISS, the auth handshake, and the boot phases — each stamped with ms
    // since navigation start. Off by default → zero console noise and zero overhead in
    // production. The headline it makes obvious when on: a HARD refresh re-pays the
    // network for everything because the client caches below are in-memory (a
    // `new Map()`, wiped on reload), not persisted — so "cached in the DB" speeds the
    // server response but the browser still does the full round-trips each reload.
    const NorvaTrace = (function () {
        // Opt-in: silent (zero output, zero overhead) unless explicitly enabled with
        // localStorage.norva_trace="1" then reload. Keeps the production console clean.
        let enabled = false;
        try { enabled = localStorage.getItem('norva_trace') === '1'; } catch (_) { /* private mode */ }
        const t = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);
        const marks = [];
        const fmt = (ms) => '+' + (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's');
        function log(label, detail) {
            if (!enabled) return;
            const ms = t();
            marks.push({ ms, label, detail });
            const d = detail == null || detail === '' ? '' : ' — ' + (typeof detail === 'object' ? JSON.stringify(detail) : detail);
            try {
                console.log('%c[Norva ' + fmt(ms) + ']%c ' + label + '%c' + d,
                    'color:#6d8bff;font-weight:700', 'color:inherit', 'color:#8a93a6');
            } catch (_) { /* console unavailable */ }
        }
        function time(label, startDetail) {
            const s = t();
            if (startDetail !== false) log('→ ' + label, startDetail);
            return (detail) => log('← ' + label, '(' + Math.round(t() - s) + 'ms)' + (detail ? ' ' + detail : ''));
        }
        function summary() {
            if (!marks.length) return;
            try {
                console.groupCollapsed('%c[Norva] refresh timeline — ' + marks.length + ' events over ' + fmt(t()).slice(1),
                    'color:#6d8bff;font-weight:700');
                console.table(marks.map((m) => ({ at: fmt(m.ms), event: m.label, detail: m.detail == null ? '' : String(typeof m.detail === 'object' ? JSON.stringify(m.detail) : m.detail) })));
                console.groupEnd();
            } catch (_) { /* noop */ }
        }
        if (enabled) { try { console.log('%c[Norva] refresh trace ON (localStorage.norva_trace="1"). NorvaTrace.summary() for the table; remove the flag + reload to silence.', 'color:#8a93a6'); } catch (_) { /* noop */ } }
        return { log, time, summary, marks, get enabled() { return enabled; } };
    })();
    if (typeof window !== 'undefined') window.NorvaTrace = window.NorvaTrace || NorvaTrace;

    const DEFAULT_API_URL = 'https://api.norva.tv/functions/v1/norva-cloud';
    const DEFAULT_SOURCE_SYNC_URL = 'https://api.norva.tv/functions/v1/norva-source-sync';
    const DEFAULT_CATALOG_URL = 'https://api.norva.tv/functions/v1/norva-catalog';
    const DEFAULT_SERIES_INFO_URL = 'https://api.norva.tv/functions/v1/norva-series-info';
    const DEFAULT_PLAYBACK_URL = 'https://api.norva.tv/functions/v1/norva-playback';
    const DEFAULT_EDGE_URL = 'https://edge.norva.tv';
    const KEY_API_URL = 'norva-cloud-api-url';
    const KEY_SOURCE_SYNC_URL = 'norva-source-sync-url';
    const KEY_CATALOG_URL = 'norva-catalog-url';
    const KEY_SERIES_INFO_URL = 'norva-series-info-url';
    const KEY_PLAYBACK_URL = 'norva-playback-url';
    const KEY_EDGE_URL = 'norva-edge-url';
    const KEY_TOKEN = 'norva-cloud-token';
    const KEY_DEVICE_TOKEN = 'norva-cloud-device-token';
    const KEY_PREFERRED_CONTENT_REGION = 'norva-preferred-content-region';
    const KEY_PROFILE_CONTENT_REGION = 'norva-profile-preferred-content-region';
    const KEY_REGION_STATE = 'norva-content-region-state';
    const KEY_REGION_PROMPT_DISMISSED = 'norva-content-region-prompt-dismissed';
    const KEY_LEGACY_COUNTRY = 'norva-country';
    const CONTENT_REGION_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
    // The region catalogue lives in js/data/regions.js (window.NorvaRegions), loaded
    // before this file. Fall back to the legacy six if it's somehow absent so nothing
    // hard-crashes.
    const REGIONS_DATA = (typeof window !== 'undefined' && window.NorvaRegions) || null;
    const CONTENT_REGIONS = REGIONS_DATA
        ? REGIONS_DATA.list().map((r) => ({ key: r.code, label: r.name, flag: r.flag, kind: r.kind }))
        : [
            { key: 'FR', label: 'France' },
            { key: 'US', label: 'United States' },
            { key: 'IN', label: 'India' },
            { key: 'MAGHREB', label: 'Maghreb' },
            { key: 'LUSOPHONE', label: 'Lusophone' },
            { key: 'INTERNATIONAL', label: 'International' }
        ];
    const CONTENT_REGION_LABELS = CONTENT_REGIONS.reduce((labels, region) => {
        labels[region.key] = region.label;
        return labels;
    }, {});

    function apiBase() {
        const configured = localStorage.getItem(KEY_API_URL) || window.NORVA_CLOUD_API_URL || DEFAULT_API_URL;
        return configured.replace(/\/+$/, '');
    }

    function sourceSyncBase() {
        const configured = localStorage.getItem(KEY_SOURCE_SYNC_URL) || window.NORVA_SOURCE_SYNC_URL || DEFAULT_SOURCE_SYNC_URL;
        return configured.replace(/\/+$/, '');
    }

    function catalogBase() {
        const configured = localStorage.getItem(KEY_CATALOG_URL) || window.NORVA_CATALOG_URL || DEFAULT_CATALOG_URL;
        return configured.replace(/\/+$/, '');
    }

    function seriesInfoBase() {
        const configured = localStorage.getItem(KEY_SERIES_INFO_URL) || window.NORVA_SERIES_INFO_URL || DEFAULT_SERIES_INFO_URL;
        return configured.replace(/\/+$/, '');
    }

    function playbackBase() {
        const configured = localStorage.getItem(KEY_PLAYBACK_URL) || window.NORVA_PLAYBACK_URL || DEFAULT_PLAYBACK_URL;
        return configured.replace(/\/+$/, '');
    }

    function edgeBase() {
        const configured = localStorage.getItem(KEY_EDGE_URL) || window.NORVA_EDGE_URL || window.NORVA_RELAY_BASE_URL || DEFAULT_EDGE_URL;
        return configured ? configured.replace(/\/+$/, '') : '';
    }

    function getToken() {
        return localStorage.getItem(KEY_TOKEN) || window.NORVA_CLOUD_TOKEN || '';
    }

    function setToken(token) {
        if (token) localStorage.setItem(KEY_TOKEN, token);
        else {
            localStorage.removeItem(KEY_TOKEN);
            storageRemove(KEY_PROFILE_CONTENT_REGION);
        }
    }

    function getDeviceToken() {
        return localStorage.getItem(KEY_DEVICE_TOKEN) || window.NORVA_CLOUD_DEVICE_TOKEN || '';
    }

    function setDeviceToken(token) {
        if (token) localStorage.setItem(KEY_DEVICE_TOKEN, token);
        else localStorage.removeItem(KEY_DEVICE_TOKEN);
    }

    function isInvalidDeviceTokenResponse(status, payload, message) {
        if (status !== 401) return false;
        const text = `${payload?.error || ''} ${payload?.message || ''} ${payload?.code || ''} ${message || ''}`;
        return /invalid\s+(bearer\s+)?(device\s+)?token|device\s+token|expired\s+(device\s+)?token/i.test(text);
    }

    let deviceTokenInvalidRedirecting = false;
    function markInvalidDeviceToken(error, tokenUsed) {
        if (!tokenUsed || tokenUsed !== getDeviceToken()) return;
        setDeviceToken('');
        error.deviceTokenInvalid = true;
        // TV shell: a revoked/expired device token means this screen is no longer
        // linked to the account (e.g. the owner tapped "Revoke" on their phone).
        // Instead of leaving the TV stuck on a broken/empty app shell, send it
        // straight back to QR pairing. Once-guard prevents redirect storms from
        // concurrent failing calls. Gated on the TV user agent so phone/web keep
        // their existing in-place handling.
        if (!deviceTokenInvalidRedirecting && /NorvaTV-AndroidTV/i.test(navigator.userAgent || '')) {
            deviceTokenInvalidRedirecting = true;
            try { localStorage.removeItem('norva-cloud-device-id'); } catch (_) { /* noop */ }
            try { window.location.replace('/cloud-pair.html?device=tv&returnTo=%2Fapp.html%3Fpaired%3D1%23home'); } catch (_) { /* noop */ }
        }
    }

    // Public image CDNs that carry no provider identity — safe to serve straight
    // to the browser instead of streaming their bytes through the Supabase edge
    // (egress). TMDB hosts the bulk of VOD posters/backdrops, so this alone takes
    // the dominant image-egress driver to ~zero at scale. <img> needs no CORS and
    // a hotlink-blocked image just falls back to the placeholder. Provider-host
    // images stay proxied: it hides the upstream and upgrades http mixed-content.
    const DIRECT_IMAGE_CDN = /^https:\/\/(?:[a-z0-9-]+\.)?(?:tmdb\.org|themoviedb\.org)\//i;

    function proxyImageUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '';
        if (/\/image\?url=/i.test(raw)) return raw;
        if (DIRECT_IMAGE_CDN.test(raw)) return raw;
        const edge = edgeBase();
        if (edge) return `${edge}/image?url=${encodeURIComponent(raw)}`;
        return `${apiBase()}/image?url=${encodeURIComponent(raw)}`;
    }

    function setApiUrl(url) {
        if (url) localStorage.setItem(KEY_API_URL, url.replace(/\/+$/, ''));
        else localStorage.removeItem(KEY_API_URL);
    }

    function setEdgeUrl(url) {
        if (url) localStorage.setItem(KEY_EDGE_URL, url.replace(/\/+$/, ''));
        else localStorage.removeItem(KEY_EDGE_URL);
    }

    function storageGet(key) {
        try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
    }

    function storageSet(key, value) {
        try {
            if (value === undefined || value === null || value === '') localStorage.removeItem(key);
            else localStorage.setItem(key, String(value));
        } catch (e) { }
    }

    function storageRemove(key) {
        try { localStorage.removeItem(key); } catch (e) { }
    }

    function normalizeContentRegion(value) {
        // Alias-aware canonicalisation (USA→US, UK→GB, scandinavia→NORDIC…) so a legacy or
        // profile-stored value maps to a curated code — keeping the picker option, the
        // button label and the country= param consistent.
        if (REGIONS_DATA) {
            const canonical = REGIONS_DATA.normalize(value);
            return CONTENT_REGION_PATTERN.test(canonical) ? canonical : '';
        }
        const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
        return CONTENT_REGION_PATTERN.test(normalized) ? normalized : '';
    }

    function contentRegionLabel(region) {
        const normalized = normalizeContentRegion(region);
        return CONTENT_REGION_LABELS[normalized] || normalized || 'International';
    }

    function inferContentRegionFromLocale() {
        const locales = Array.isArray(navigator.languages) && navigator.languages.length
            ? navigator.languages
            : [navigator.language || ''];
        // Full region catalogue: prefer an explicit country subtag, else map the primary
        // language to a representative region (js/data/regions.js).
        if (REGIONS_DATA) return REGIONS_DATA.inferFromLocale(locales);
        // Legacy fallback (regions.js absent): the original FR/US/IN heuristic.
        for (const locale of locales) {
            const parts = String(locale || '').split(/[-_]/).filter(Boolean);
            const region = normalizeContentRegion(parts.length > 1 ? parts[parts.length - 1] : '');
            if (region === 'FR' || region === 'US' || region === 'IN') return region;
        }
        const language = String(locales[0] || '').split(/[-_]/)[0].toLowerCase();
        if (language === 'fr') return 'FR';
        if (['hi', 'ta', 'te', 'bn', 'mr', 'pa', 'gu', 'kn', 'ml'].includes(language)) return 'IN';
        if (language === 'en') return 'US';
        return 'INTERNATIONAL';
    }

    function rememberRegionState(state) {
        storageSet(KEY_REGION_STATE, JSON.stringify({
            region: state.region,
            status: state.status,
            source: state.source,
            suggestedRegion: state.suggestedRegion || '',
            updatedAt: new Date().toISOString()
        }));
    }

    function getStoredPreferredContentRegion() {
        const profile = normalizeContentRegion(storageGet(KEY_PROFILE_CONTENT_REGION));
        if (profile) return { region: profile, source: 'profile' };

        const local = normalizeContentRegion(storageGet(KEY_PREFERRED_CONTENT_REGION));
        if (local) return { region: local, source: 'local' };

        return null;
    }

    function getLegacyContentRegion() {
        return normalizeContentRegion(storageGet(KEY_LEGACY_COUNTRY));
    }

    function resolveContentRegion() {
        const preferred = getStoredPreferredContentRegion();
        if (preferred) {
            const resolved = {
                region: preferred.region,
                status: 'confirmed',
                source: preferred.source,
                suggestedRegion: '',
                label: contentRegionLabel(preferred.region)
            };
            rememberRegionState(resolved);
            return resolved;
        }

        const legacy = getLegacyContentRegion();
        if (legacy) {
            const resolved = {
                region: legacy,
                status: 'inferred',
                source: 'legacy',
                suggestedRegion: legacy,
                label: contentRegionLabel(legacy)
            };
            rememberRegionState(resolved);
            return resolved;
        }

        const suggestedRegion = inferContentRegionFromLocale();
        const resolved = {
            region: suggestedRegion,
            status: 'inferred',
            source: 'locale',
            suggestedRegion,
            label: contentRegionLabel(suggestedRegion)
        };
        rememberRegionState(resolved);
        return resolved;
    }

    function resolveCountry() {
        return resolveContentRegion().region;
    }

    // Active region code WITHOUT the rememberRegionState() localStorage write — safe to call
    // from hot paths (resolveLang / cache-key building) where the persisted state side effect
    // of resolveContentRegion() is unwanted.
    function activeRegionCode() {
        const preferred = getStoredPreferredContentRegion();
        if (preferred) return preferred.region;
        const legacy = getLegacyContentRegion();
        if (legacy) return legacy;
        return inferContentRegionFromLocale();
    }

    // Resolved SYNOPSIS language (2-letter) for localized titles/overviews — the axis the
    // three "taste" preferences now drive (VOD i18n Phase 2). A synopsis is read, so the
    // chain is subtitle → audio → region default → device locale → en. The catalog serves
    // metadata.i18n[lang] when available, else the catalogue default. Prefs are read from
    // the localStorage mirror of the server settings (kept fresh by API.settings.get()).
    function resolveLang() {
        const M = (typeof window !== 'undefined' && window.MediaUtils) || null;
        let subtitle = '';
        let audio = '';
        try {
            const s = JSON.parse(localStorage.getItem('norva-cloud-settings') || '{}') || {};
            // normalizeContentPreferences migrates the legacy single `preferredLanguage`
            // field into audio/subtitle, so a user who only set the old pref is honoured.
            const norm = (M && typeof M.normalizeContentPreferences === 'function') ? M.normalizeContentPreferences(s) : s;
            subtitle = norm.preferredSubtitleLanguage || '';
            audio = norm.preferredAudioLanguage || '';
        } catch (_) { /* fall through to region/locale */ }
        const regionLang = REGIONS_DATA ? REGIONS_DATA.defaultLanguage(activeRegionCode()) : '';
        const locale = (typeof navigator !== 'undefined' && navigator.language) || '';
        if (M && typeof M.resolveContentLanguage === 'function') {
            return M.resolveContentLanguage({ subtitle, audio, regionLang, locale });
        }
        // Fallback if MediaUtils isn't loaded yet (not expected at request time).
        const code = String(locale || 'en').toLowerCase().split('-')[0];
        return /^[a-z]{2}$/.test(code) ? code : 'en';
    }

    function rememberProfileRegion(profile) {
        const region = normalizeContentRegion(profile?.preferred_content_region ?? profile?.preferredContentRegion);
        if (region) {
            storageSet(KEY_PROFILE_CONTENT_REGION, region);
            rememberRegionState({ region, status: 'confirmed', source: 'profile' });
        } else {
            storageRemove(KEY_PROFILE_CONTENT_REGION);
        }
        return profile;
    }

    async function setPreferredContentRegion(region, options = {}) {
        const normalized = normalizeContentRegion(region);
        if (!normalized) throw new Error('Invalid content region');

        storageSet(KEY_PREFERRED_CONTENT_REGION, normalized);
        storageSet(KEY_LEGACY_COUNTRY, normalized);
        storageRemove(KEY_REGION_PROMPT_DISMISSED);
        rememberRegionState({ region: normalized, status: 'confirmed', source: 'local' });

        if (options.saveProfile !== false && getToken()) {
            try {
                const profile = await request('PUT', '/profile', {
                    preferredContentRegion: normalized,
                    confirmPreferredContentRegion: true,
                    locale: navigator.language || 'en-US'
                });
                rememberProfileRegion(profile);
            } catch (error) {
                console.warn('[NorvaCloud] Could not save preferred content region:', error);
                if (options.throwOnProfileError) throw error;
            }
        }

        return resolveContentRegion();
    }

    function clearPreferredContentRegion() {
        storageRemove(KEY_PREFERRED_CONTENT_REGION);
        storageRemove(KEY_PROFILE_CONTENT_REGION);
        storageRemove(KEY_LEGACY_COUNTRY);
        return resolveContentRegion();
    }

    function dismissRegionPrompt() {
        storageSet(KEY_REGION_PROMPT_DISMISSED, '1');
    }

    function shouldShowRegionPrompt() {
        if (getStoredPreferredContentRegion()) return false;
        if (storageGet(KEY_REGION_PROMPT_DISMISSED)) return false;
        const suggested = getLegacyContentRegion() || inferContentRegionFromLocale();
        return suggested && suggested !== 'INTERNATIONAL';
    }

    function maybeShowRegionPrompt() {
        if (!shouldShowRegionPrompt()) return;
        if (!document.body || document.getElementById('norva-region-prompt')) return;
        const pathname = window.location.pathname || '';
        // Suppress on auth/pairing surfaces — match both the .html paths and the
        // clean URLs Cloudflare Pages serves (e.g. "/account", "/login").
        if (/\/(login|cloud|account|cloud-pair|hub-connect)(\.html)?\/?$/i.test(pathname)) return;
        // On the app page, defer until a catalog actually exists: organizing regions
        // for an empty catalog is premature and stacks on top of the "connect your TV
        // service" onboarding. The App drives this from its catalog-ready flow
        // (App.maybeShowRegionPrompt), so bail here for both the DOMContentLoaded
        // auto-trigger and any early call until the catalog is ready. Detect the app
        // by path (window.app may not exist yet at DOMContentLoaded). Other pages
        // (no catalog concept) show as before.
        const onAppPage = /\/app(\.html)?\/?$/i.test(pathname);
        if (onAppPage && !(window.app && typeof window.app.isCatalogReady === 'function' && window.app.isCatalogReady())) return;

        const suggestion = resolveContentRegion();
        // TV gets a centered, larger-type card (corner cards get overscan-cropped and
        // 14px is unreadable at 10 feet); web/mobile keep the safe-area bottom card.
        const isTv = /NorvaTV-AndroidTV/.test(navigator.userAgent || '')
            || new URLSearchParams(location.search).has('tv');
        const prevFocus = document.activeElement;
        const label = contentRegionLabel(suggestion.region);

        const prompt = document.createElement('div');
        prompt.id = 'norva-region-prompt';
        // A real dialog: named for screen readers, and recognized by tvNavigation's
        // openModal() so the D-pad is trapped inside and Back/Escape dismisses it.
        prompt.setAttribute('role', 'dialog');
        prompt.setAttribute('aria-modal', 'true');
        prompt.setAttribute('aria-label', `Organize Norva for ${label}`);
        // A dimmed full-screen backdrop makes this "one thing at a time": it covers
        // the onboarding form, the trial pill and everything else, so nothing can
        // visually collide with the prompt. Mobile gets a bottom sheet (thumb-reachable,
        // native gesture affordance); TV keeps a centered card (corner cards get
        // overscan-cropped and 14px is unreadable at 10 feet).
        const backdrop = document.createElement('div');
        backdrop.id = 'norva-region-backdrop';
        backdrop.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:9998',
            'background:rgba(2,6,15,.62)',
            '-webkit-backdrop-filter:blur(2px)', 'backdrop-filter:blur(2px)',
            'display:flex', 'justify-content:center',
            isTv ? 'align-items:center' : 'align-items:flex-end',
            'padding:' + (isTv ? '24px' : '0'),
            'box-sizing:border-box',
            'opacity:0', 'transition:opacity .18s ease'
        ].join(';');

        prompt.style.cssText = [
            'position:relative',
            'box-sizing:border-box',
            'width:100%',
            isTv ? 'max-width:min(560px,90vw)' : 'max-width:560px',
            // Bottom sheet on mobile: rounded top only, flush to the bottom edge.
            isTv ? 'border-radius:16px' : 'border-radius:22px 22px 0 0',
            // Never taller than the viewport (scroll inside if it somehow is).
            'max-height:calc(100vh - env(safe-area-inset-top, 0px) - 24px)',
            'overflow:auto',
            // Map to the app's design tokens (dark theme) with a hex fallback for
            // surfaces that don't define them.
            'background:var(--color-bg-secondary, #121722)',
            'border:1px solid var(--color-border, #2b3448)',
            'box-shadow:0 -14px 60px rgba(0,0,0,.5)',
            'color:var(--color-text-primary, #f8fafc)',
            // Extra bottom padding on mobile clears the system nav bar (safe-area).
            isTv ? 'padding:22px' : 'padding:20px 18px calc(20px + env(safe-area-inset-bottom, 0px))',
            `font:${isTv ? '18px' : '15px'}/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif`,
            // Entrance: sheet slides up / card scales in (reset after mount).
            isTv ? 'transform:scale(.98)' : 'transform:translateY(14px)',
            'transition:transform .2s ease'
        ].join(';');
        // 44px minimum touch/remote targets throughout.
        const btnBase = 'min-height:44px;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer';
        prompt.innerHTML = `
            ${isTv ? '' : '<div aria-hidden="true" style="width:40px;height:4px;border-radius:999px;background:var(--color-border,#334155);margin:-6px auto 14px"></div>'}
            <button type="button" aria-label="Close" data-region-close class="modal-close" style="float:right;width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;color:var(--color-text-secondary,#94a3b8);font-size:24px;line-height:1;cursor:pointer;margin:-8px -8px 0 0">&times;</button>
            <strong style="display:block;font-size:${isTv ? 20 : 16}px;margin:0 40px 8px 0">Organize Norva for ${escapeHtml(label)}?</strong>
            <span style="display:block;color:var(--color-text-secondary,#aeb8cc);margin-bottom:14px">Norva uses this region to organize channels, logos and categories. You can change it at any time.</span>
            <div data-region-actions style="display:flex;gap:10px;flex-wrap:wrap">
                <button type="button" data-region-confirm style="flex:1 1 82px;border:0;background:var(--color-accent,#5b7cfa);color:white;${btnBase}">Yes</button>
                <button type="button" data-region-settings style="flex:2 1 180px;min-width:0;border:1px solid var(--color-border,#334155);background:var(--color-bg-tertiary,#1b2230);color:var(--color-text-primary,#dbe7ff);${btnBase}">Choose another region</button>
            </div>
            <div data-region-picker style="display:none;gap:10px;flex-wrap:wrap;margin-top:2px">
                <select data-region-select aria-label="Content region" style="flex:1 1 180px;min-width:0;min-height:44px;border:1px solid var(--color-border,#334155);border-radius:10px;background:var(--color-bg-tertiary,#1b2230);color:var(--color-text-primary,#f8fafc);padding:10px 12px;font-weight:700;cursor:pointer">
                    ${CONTENT_REGIONS.map((r) => `<option value="${escapeHtml(r.key)}">${r.flag ? escapeHtml(r.flag) + ' ' : ''}${escapeHtml(r.label)}</option>`).join('')}
                </select>
                <button type="button" data-region-apply style="flex:0 0 auto;border:0;background:var(--color-accent,#5b7cfa);color:white;${btnBase};padding:10px 16px">Confirm</button>
            </div>
        `;

        // Teardown removes the dialog and its key handler, and returns focus to
        // whatever opened it (keyboard/remote continuity). `dismiss` also records the
        // "not now" so the prompt doesn't nag again; confirming a region doesn't need
        // that flag (the region is already set).
        function onKey(e) {
            if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
                e.preventDefault();
                dismiss();
                return;
            }
            if (e.key === 'Tab') {
                const f = Array.from(prompt.querySelectorAll('button, select, [href], input, [tabindex]:not([tabindex="-1"])'))
                    .filter((el) => !el.disabled && el.offsetParent !== null);
                if (!f.length) return;
                const first = f[0];
                const last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }
        const teardown = () => {
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            try { if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus(); } catch (_) { /* noop */ }
        };
        const dismiss = () => { dismissRegionPrompt(); teardown(); };

        const closeBtn = prompt.querySelector('[data-region-close]');
        // .onclick (not addEventListener) so tvNavigation.closeTopModal() — which the
        // TV hardware Back button routes through — invokes it.
        if (closeBtn) closeBtn.onclick = dismiss;
        prompt.querySelector('[data-region-confirm]')?.addEventListener('click', async () => {
            await setPreferredContentRegion(suggestion.region);
            teardown();
        });
        // "Choose another region" reveals an inline picker inside the card and writes
        // the chosen region straight to the user's settings — no detour to Settings.
        // On TV, focusing the <select> + D-pad center opens tvNavigation's big
        // remote-friendly option list (openTvSelect).
        const actionsRow = prompt.querySelector('[data-region-actions]');
        const pickerRow = prompt.querySelector('[data-region-picker]');
        const regionSelect = prompt.querySelector('[data-region-select]');
        if (regionSelect) regionSelect.value = suggestion.region; // preselect the suggestion
        prompt.querySelector('[data-region-settings]')?.addEventListener('click', () => {
            if (actionsRow) actionsRow.style.display = 'none';
            if (pickerRow) pickerRow.style.display = 'flex';
            regionSelect?.focus();
        });
        prompt.querySelector('[data-region-apply]')?.addEventListener('click', async () => {
            const chosen = regionSelect?.value || suggestion.region;
            await setPreferredContentRegion(chosen);
            teardown();
        });

        backdrop.appendChild(prompt);
        document.body.appendChild(backdrop);
        // Tapping the dimmed backdrop (outside the sheet) dismisses — the standard
        // bottom-sheet affordance. Clicks inside the sheet don't bubble to here.
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
        // Escape/Back + Tab focus-trap for keyboard users (tvNavigation owns these on
        // TV; this covers web/desktop where tvNavigation is inactive).
        document.addEventListener('keydown', onKey, true);
        // Run the entrance animation and move focus into the dialog on the next tick
        // (setTimeout(0) so it lands even in WebViews that throttle animation frames).
        setTimeout(() => {
            backdrop.style.opacity = '1';
            prompt.style.transform = isTv ? 'scale(1)' : 'translateY(0)';
            try { (prompt.querySelector('[data-region-confirm]') || closeBtn)?.focus(); } catch (_) { /* noop */ }
        }, 0);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async function request(method, path, body, options = {}) {
        // Delegates to requestToBase so the session refresh-and-retry on 401
        // (see below) applies uniformly to every cloud call.
        return requestToBase(apiBase(), method, path, body, options);
    }

    // The source LIST rarely changes within a session, yet several pages re-fetch
    // it on every view (movies, series, live, home, source health) — fanning a
    // single navigation out into ~5 identical /sources round-trips, each paying
    // the edge function's cold-start. Cache it briefly and share one in-flight
    // request. (Live sync STATUS is read from the separate /sources/status
    // endpoint, which stays uncached, so this never staleness progress.)
    function cloneJson(d) { try { return d == null ? d : JSON.parse(JSON.stringify(d)); } catch (_) { return d; } }
    // Short-lived cache + in-flight dedup for idempotent GETs that several
    // surfaces request on the same navigation (sources, favorites, watch
    // history) — collapsing the duplicate round-trips that each pay the edge
    // function's cold-start. No staleness risk: short TTL + every entry is
    // invalidated the moment its data is mutated.
    const _getCache = new Map();      // key -> { at, data }
    const _getInFlight = new Map();   // key -> promise
    function cachedGet(cacheKey, ttlMs, fetchFn) {
        const hit = _getCache.get(cacheKey);
        if (hit && (Date.now() - hit.at) < ttlMs) { NorvaTrace.log('cache HIT (in-memory)', cacheKey + ' · age ' + Math.round((Date.now() - hit.at) / 1000) + 's'); return Promise.resolve(cloneJson(hit.data)); }
        if (_getInFlight.has(cacheKey)) { NorvaTrace.log('cache JOIN in-flight', cacheKey); return _getInFlight.get(cacheKey).then(cloneJson); }
        NorvaTrace.log('cache MISS → network', cacheKey);
        const p = Promise.resolve(fetchFn())
            .then((data) => { _getCache.set(cacheKey, { at: Date.now(), data }); return data; })
            .finally(() => { _getInFlight.delete(cacheKey); });
        _getInFlight.set(cacheKey, p);
        return p.then(cloneJson);
    }
    function invalidateCache(prefix) {
        for (const k of Array.from(_getCache.keys())) {
            if (k === prefix || k.indexOf(prefix + ':') === 0) _getCache.delete(k);
        }
    }
    const SOURCES_TTL_MS = 30 * 1000;
    const FAVORITES_TTL_MS = 30 * 1000;
    const HISTORY_TTL_MS = 20 * 1000;
    // Boot reads. Entitlements stays short (a purchase must reflect quickly; the
    // in-memory cache is dropped on every full reload anyway, so the purchase
    // flow's return-to-app always re-fetches). Profiles/profile change rarely and
    // are invalidated the moment they're mutated.
    const ENTITLEMENTS_TTL_MS = 30 * 1000;
    const PROFILES_TTL_MS = 60 * 1000;
    const PROFILE_TTL_MS = 60 * 1000;
    function invalidateSourcesCache() { invalidateCache('sources'); }
    function listSourcesCached() { return cachedGet('sources', SOURCES_TTL_MS, () => request('GET', '/sources')); }

    // One-shot cold-start aggregation. A fresh load otherwise fans out into ~7
    // separate norva-cloud calls (profile, profiles, entitlements, sources,
    // trial, …), each paying its own isolate cold-start + auth — the dominant
    // cause of slow first paint. boot() answers them from ONE /boot call and
    // seeds the per-section caches, so the individual getters fired during
    // startup resolve from cache instead of hitting the network.
    //
    // Each section is pre-registered as in-flight BEFORE /boot resolves, so a
    // getter called mid-boot dedups onto this one request. If /boot fails, or a
    // section comes back null (transient hiccup), that section transparently
    // falls back to its individual fetch — boot() is a pure speedup, never a
    // dependency.
    let _bootStarted = false;
    function boot() {
        if (_bootStarted) { NorvaTrace.log('boot() skipped — already started this session'); return Promise.resolve(null); }
        _bootStarted = true;
        const _bootDone = NorvaTrace.time('boot() — 1 call seeds sources+entitlements+profiles+profile+trial');
        const p = request('GET', '/boot');
        const seedSection = (cacheKey, pick, individualFetch) => {
            if (_getInFlight.has(cacheKey)) return; // a getter already owns this fetch
            const sp = p.then((bundle) => (bundle ? pick(bundle) : null), () => null)
                .then(async (value) => {
                    if (value != null) { _getCache.set(cacheKey, { at: Date.now(), data: value }); return value; }
                    const fresh = await individualFetch();
                    _getCache.set(cacheKey, { at: Date.now(), data: fresh });
                    return fresh;
                })
                .finally(() => { if (_getInFlight.get(cacheKey) === sp) _getInFlight.delete(cacheKey); });
            _getInFlight.set(cacheKey, sp);
        };
        seedSection('sources', (b) => b.sources, () => request('GET', '/sources'));
        seedSection('entitlements', (b) => b.entitlements, () => request('GET', '/entitlements'));
        seedSection('profiles', (b) => b.profiles, () => request('GET', '/profiles'));
        seedSection('profile', (b) => b.profile, () => request('GET', '/profile'));
        return p.then((bundle) => {
            if (bundle && bundle.trialEligibility != null) {
                _getCache.set('trialEligibility', { at: Date.now(), data: bundle.trialEligibility });
            }
            _bootDone(bundle ? 'bundle received' : 'null → sections fall back to individual fetches');
            return bundle;
        }).catch(() => { _bootDone('failed → sections fall back'); return null; });
    }

    // Active profile (Netflix-style "who's watching"). Stored per device and sent
    // on every cloud call as x-norva-profile-id so favorites / history / continue
    // watching are scoped to the chosen profile.
    const ACTIVE_PROFILE_KEY = 'norva-active-profile-id';
    function getActiveProfileId() {
        try { return localStorage.getItem(ACTIVE_PROFILE_KEY) || ''; } catch (_) { return ''; }
    }
    function setActiveProfileId(id) {
        const prev = getActiveProfileId();
        try {
            if (id) localStorage.setItem(ACTIVE_PROFILE_KEY, String(id));
            else localStorage.removeItem(ACTIVE_PROFILE_KEY);
        } catch (_) { /* ignore */ }
        // Switching profile invalidates the per-profile caches. The cache keys
        // are 'fav:' / 'hist:' (see favorites.list / history.list), NOT
        // 'favorites' / 'history' — use the real prefixes so a soft profile
        // switch actually drops the previous profile's data instead of leaking it.
        if (String(id || '') !== String(prev || '')) {
            invalidateCache('fav');
            invalidateCache('hist');
        }
    }

    async function sourceSyncRequest(id, opts = {}) {
        // force=1 → bypass the cloud's change-detection skip (hard refresh).
        const force = opts && opts.force ? '&force=1' : '';
        const path = `/sources/${encodeURIComponent(id)}/sync?country=${encodeURIComponent(resolveCountry())}${force}`;
        try {
            return await requestToBase(sourceSyncBase(), 'POST', path, {});
        } catch (error) {
            if ([404, 405, 502, 503, 504, 546].includes(error.status)) {
                return request('POST', path, {});
            }
            throw error;
        }
    }

    async function sourceFinalizeRequest(id, params = {}) {
        const path = `/sources/${encodeURIComponent(id)}/finalize${query({ country: resolveCountry(), ...params })}`;
        try {
            return await requestToBase(sourceSyncBase(), 'POST', path, {});
        } catch (error) {
            if ([404, 405, 502, 503, 504, 546].includes(error.status)) {
                return request('POST', path, {});
            }
            throw error;
        }
    }

    async function catalogRequest(path, params = {}, options = {}) {
        const route = `${path}${query({ country: resolveCountry(), lang: resolveLang(), ...params })}`;
        try {
            return await requestToBase(catalogBase(), 'GET', route, null, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request('GET', route, null, options);
            }
            throw error;
        }
    }

    async function catalogMutate(path, body, options = {}) {
        const route = `${path}${query({ country: resolveCountry(), lang: resolveLang() })}`;
        try {
            return await requestToBase(catalogBase(), 'POST', route, body, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request('POST', route, body, options);
            }
            throw error;
        }
    }

    async function seriesInfoRequest(id, seriesId, options = {}) {
        const route = `/sources/${encodeURIComponent(id)}/series-info?series_id=${encodeURIComponent(seriesId)}`;
        try {
            return await requestToBase(seriesInfoBase(), 'GET', route, null, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request('GET', route, null, options);
            }
            throw error;
        }
    }

    async function playbackRequest(session, options = {}) {
        try {
            return await requestToBase(playbackBase(), 'POST', '/playback/session', session, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request('POST', '/playback/sessions', session, options);
            }
            throw error;
        }
    }

    async function playbackSessionRequest(method, path, body, options = {}) {
        try {
            return await requestToBase(playbackBase(), method, path, body, options);
        } catch (error) {
            if (error.status === 404 || error.status === 405) {
                return request(method, path, body, options);
            }
            throw error;
        }
    }

    // Pull the deepest upstream detail out of an error payload so callers see
    // the real cause (e.g. the provider "401 Unauthorized" the cloud gateway
    // reports) instead of only the generic top-level "Media gateway refused the
    // session". The UI keys its friendly messages off this text.
    function extractUpstreamDetail(value, depth = 0) {
        if (!value || depth > 4) return '';
        if (typeof value === 'string') return value.trim();
        if (typeof value !== 'object') return '';
        const parts = [];
        for (const key of ['details', 'error', 'message', 'reason']) {
            const nested = extractUpstreamDetail(value[key], depth + 1);
            if (nested) parts.push(nested);
        }
        return parts.join(' ').trim();
    }

    // Supabase access tokens expire (~1h). When the tab has sat idle past that,
    // the cached token 401s mid-session and the app wrongly looks logged out —
    // the onboarding "enter your service details" screen (sources 401) or a
    // redirect to the landing page (entitlements 401). Transparently refresh the
    // session via NorvaAuth and retry. Deduped via a single in-flight promise so
    // the burst of calls that fire when the user returns can't race Supabase's
    // single-use refresh-token rotation (which would invalidate the session and
    // defeat the refresh).
    let _tokenRefreshInFlight = null;
    function refreshAccessToken() {
        if (_tokenRefreshInFlight) return _tokenRefreshInFlight;
        const auth = (typeof window !== 'undefined') ? window.NorvaAuth : null;
        if (!auth || typeof auth.refreshSession !== 'function') return Promise.resolve(null);
        _tokenRefreshInFlight = Promise.resolve()
            .then(() => auth.refreshSession())
            .then((session) => (session && session.access_token) ? session.access_token : null)
            .catch(() => null)
            .finally(() => { _tokenRefreshInFlight = null; });
        return _tokenRefreshInFlight;
    }

    async function requestToBase(baseUrl, method, path, body, options = {}) {
        // Only user-session calls (no explicit token) get the refresh-and-retry.
        // Device tokens ('' / device token) keep their own invalidation path.
        const usingUserToken = options.token === undefined;
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        let token = usingUserToken ? getToken() : options.token;
        if (token) headers.Authorization = `Bearer ${token}`;
        const activeProfileId = getActiveProfileId();
        if (activeProfileId) headers['x-norva-profile-id'] = activeProfileId;

        const _trLabel = method + ' ' + String(path).split('?')[0];
        const _trT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        NorvaTrace.log('net → ' + _trLabel);
        const send = () => fetch(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : JSON.stringify(body)
        });

        let response = await send();
        let _trRefreshed = false;

        if (response.status === 401 && usingUserToken && token) {
            const fresh = await refreshAccessToken();
            if (fresh && fresh !== token) {
                token = fresh;
                headers.Authorization = `Bearer ${token}`;
                _trRefreshed = true;
                response = await send();
            }
        }

        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
            ? await response.json().catch(() => ({}))
            : { error: await response.text().catch(() => '') };

        NorvaTrace.log('net ← ' + _trLabel, response.status + ' (' + Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - _trT0) + 'ms)' + (_trRefreshed ? ' [after 401→refresh]' : ''));

        if (!response.ok) {
            const baseMessage = payload.error || payload.message || `Norva responded with ${response.status}`;
            const detail = extractUpstreamDetail(payload.details);
            const message = detail && !baseMessage.includes(detail)
                ? `${baseMessage} — ${detail}`.slice(0, 400)
                : baseMessage;
            const error = new Error(message);
            error.status = response.status;
            error.payload = payload;
            if (isInvalidDeviceTokenResponse(response.status, payload, message)) {
                markInvalidDeviceToken(error, token);
            }
            throw error;
        }

        return payload;
    }

    // True when running as a QR-paired screen (a device token but NO signed-in user):
    // user-scope routes have no JWT and would 401, so the directly-called namespaces
    // (ratings, profiles) must hit their /device/* equivalents with the device token.
    function isDeviceOnly() {
        let hasUser = false;
        try {
            const s = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
            hasUser = Boolean(s && s.access_token && s.user && s.user.id);
        } catch (_) { hasUser = false; }
        return !hasUser && Boolean(getDeviceToken());
    }
    // Pick (path, token) for a route that exists in both scopes, by session mode.
    const dualGet = (userPath, params = {}) => isDeviceOnly()
        ? request('GET', `/device${userPath}${query(params)}`, null, { token: getDeviceToken() })
        : request('GET', `${userPath}${query(params)}`);
    const dualMutate = (method, userPath, body) => isDeviceOnly()
        ? request(method, `/device${userPath}`, body, { token: getDeviceToken() })
        : request(method, userPath, body);

    const NorvaCloud = {
        get apiUrl() { return apiBase(); },
        get edgeUrl() { return edgeBase(); },
        get token() { return getToken(); },
        get deviceToken() { return getDeviceToken(); },
        setToken,
        setDeviceToken,
        setApiUrl,
        setEdgeUrl,
        isConfigured: () => Boolean(apiBase()),
        imageUrl: proxyImageUrl,

        health: () => request('GET', '/health', null, { token: '' }),

        // Keep the edge functions warm so the next real call after a lull doesn't
        // pay a cold start (the main cause of the slow first catalog load after
        // inactivity). Cheapest touch on each function we use; best-effort.
        warmUp: () => {
            // Cheap /health ping only. The old warm-up ran a real /media-items catalog
            // query every 4 min, which on a loaded/bloated DB hung for the 150s edge limit
            // holding a connection — counter-productive. A cold start on the first real
            // call is far cheaper than a 150s hung warm-up.
            try { request('GET', '/health', null, { token: '' }).catch(() => {}); } catch (_) { /* noop */ }
        },

        // Aggregated cold-start fetch (see boot() above): one /boot call seeds the
        // profile / profiles / entitlements / sources caches so the launch
        // sequence makes a single norva-cloud round-trip instead of ~7.
        boot,

        profile: {
            get: () => cachedGet('profile', PROFILE_TTL_MS, () => request('GET', '/profile')).then(rememberProfileRegion),
            save: async (profile) => {
                const saved = rememberProfileRegion(await request('PUT', '/profile', profile));
                invalidateCache('profile');
                return saved;
            }
        },

        entitlements: {
            get: () => cachedGet('entitlements', ENTITLEMENTS_TTL_MS, () => request('GET', '/entitlements')),
            device: () => request('GET', '/device/entitlements', null, { token: getDeviceToken() }),
            // Conversion signal (observe-mode scaffold): record that the user
            // reached for a premium-gated feature. Best-effort, never throws.
            recordSignal: (feature, context = {}) => {
                try {
                    return request('POST', '/entitlements/signal', { feature, context }).catch(() => null);
                } catch (_) { return Promise.resolve(null); }
            },
            isSubscriptionError: (error) => {
                const payload = error?.payload || {};
                const details = payload.details || {};
                return error?.status === 402 && (
                    details.code === 'subscription_required' ||
                    payload.code === 'subscription_required'
                );
            }
        },

        // "What's new" feed — unseen new-content events for the in-app notification.
        contentEvents: {
            list: () => request('GET', '/content-events').catch(() => ({ events: [] })),
            // Inbox feed: seen + unseen history + unread count, WITHOUT marking seen.
            inbox: () => request('GET', '/content-events?all=1').catch(() => ({ events: [], unread: 0 })),
            markSeen: (ids) => {
                try { return request('POST', '/content-events/seen', { ids }).catch(() => null); }
                catch (_) { return Promise.resolve(null); }
            }
        },

        billing: {
            // Account-level trial eligibility (one trial per account across every
            // rail — keyed to trial_consumed_at). Lets the paywall show "Start
            // free trial" vs "Subscribe".
            trialEligibility: () => cachedGet('trialEligibility', PROFILES_TTL_MS, () => request('GET', '/billing/trial-eligibility'))
        },

        // Device-aware so a paired TV can list + pick the SAME profile as the phone
        // (favorites/history are per-profile, so the picker must reach the account's list).
        profiles: {
            list: () => cachedGet('profiles', PROFILES_TTL_MS, () => dualGet('/profiles')),
            create: (profile) => dualMutate('POST', '/profiles', profile).then((r) => { invalidateCache('profiles'); return r; }),
            update: (id, patch) => (isDeviceOnly()
                ? request('PATCH', `/device/profiles/${encodeURIComponent(id)}`, patch, { token: getDeviceToken() })
                : request('PATCH', `/profiles/${encodeURIComponent(id)}`, patch)).then((r) => { invalidateCache('profiles'); return r; }),
            remove: (id) => (isDeviceOnly()
                ? request('DELETE', `/device/profiles/${encodeURIComponent(id)}`, null, { token: getDeviceToken() })
                : request('DELETE', `/profiles/${encodeURIComponent(id)}`)).then((r) => { invalidateCache('profiles'); return r; }),
            getActiveId: getActiveProfileId,
            setActiveId: setActiveProfileId,
            avatarUrl: (avatarId) => '/img/avatars/' + encodeURIComponent(String(avatarId || 'avatar-01')) + '.png',
        },

        // Resolved synopsis language (subtitle → audio → region → locale → en). Used by the
        // catalog fetches (?lang=) and by the frontend caches so a language change re-fetches.
        contentLanguage: resolveLang,

        regions: {
            list: () => CONTENT_REGIONS.slice(),
            label: contentRegionLabel,
            flag: (code) => (REGIONS_DATA ? REGIONS_DATA.flag(code) : '🌐'),
            resolve: resolveContentRegion,
            active: () => resolveContentRegion().region,
            // Region → best synopsis language (feeds resolveContentLang, Phase 2) and the
            // TMDB region= param (Phase 3). Safe defaults when regions.js is absent.
            defaultLanguage: (code) => (REGIONS_DATA ? REGIONS_DATA.defaultLanguage(code) : 'en'),
            tmdbRegion: (code) => (REGIONS_DATA ? REGIONS_DATA.tmdbRegion(code) : String(code || '').toUpperCase()),
            setPreferred: setPreferredContentRegion,
            clearPreferred: clearPreferredContentRegion,
            rememberProfile: rememberProfileRegion,
            dismissPrompt: dismissRegionPrompt,
            maybeShowPrompt: maybeShowRegionPrompt
        },

        devices: {
            list: () => request('GET', '/devices'),
            create: (device) => request('POST', '/devices', device),
            heartbeat: (id) => request('PATCH', `/devices/${encodeURIComponent(id)}/heartbeat`),
            revoke: (id) => request('DELETE', `/devices/${encodeURIComponent(id)}`)
        },

        sources: {
            list: () => listSourcesCached(),
            create: (source) => request('POST', '/sources', source).then((r) => { invalidateSourcesCache(); return r; }),
            update: (id, patch) => request('PATCH', `/sources/${encodeURIComponent(id)}`, patch).then((r) => { invalidateSourcesCache(); return r; }),
            seriesInfo: (id, seriesId) => seriesInfoRequest(id, seriesId),
            shortEpg: (id, streamId, limit = 8) => request(
                'GET',
                `/sources/${encodeURIComponent(id)}/short-epg?stream_id=${encodeURIComponent(streamId)}&limit=${encodeURIComponent(limit)}`
            ),
            epg: (id, params = {}) => request(
                'GET',
                `/sources/${encodeURIComponent(id)}/epg${query(params)}`
            ),
            sync: (id, opts = {}) => sourceSyncRequest(id, opts).then((r) => { invalidateSourcesCache(); return r; }),
            finalize: (id, params = {}) => sourceFinalizeRequest(id, params).then((r) => { invalidateSourcesCache(); return r; }),
            remove: (id) => request('DELETE', `/sources/${encodeURIComponent(id)}`).then((r) => { invalidateSourcesCache(); return r; })
        },

        mediaItems: {
            list: (params = {}) => catalogRequest('/media-items', params),
            categories: (params = {}) => catalogRequest('/media-categories', params),
            enrichmentProgress: () => catalogRequest('/enrichment-progress'),
            upsert: (sourceId, items) => request('POST', '/media-items', { sourceId, items })
        },

        media: {
            // Live TMDB extras (videos/credits) for the fiches — proxied by the
            // edge so the TMDB key never reaches the browser; cached CDN-side.
            tmdbMeta: (params = {}) => catalogRequest('/tmdb-meta', params),
            // Per-episode TMDB data (stills / localized names / air dates) for one season.
            tmdbEpisodes: (params = {}) => catalogRequest('/tmdb-episodes', params),
            // Crowd-learned skip-intro markers, keyed on tmdbId+season.
            introMarkers: (params = {}) => catalogRequest('/intro-markers', params),
            introSignal: (body = {}) => catalogMutate('/intro-signal', body)
        },

        live: {
            logicalChannels: (params = {}) => catalogRequest('/live/logical-channels', params),
            variants: (channelId, params = {}) => catalogRequest(`/live/channel/${encodeURIComponent(channelId)}/variants`, params)
        },

        home: {
            rails: (params = {}) => catalogRequest('/home/rails', params),
            genreRails: (params = {}) => catalogRequest('/media-genre-rails', params),
            genreItems: (params = {}) => catalogRequest('/media-genre-items', params),
            genreSummary: (params = {}) => catalogRequest('/media-genre-summary', params),
            languageFacets: (params = {}) => catalogRequest('/media-language-facets', params),
            reportObservedLanguages: (body) => catalogMutate('/media-observed-languages', body)
        },

        favorites: {
            list: (params = {}) => cachedGet('fav:' + JSON.stringify(params || {}), FAVORITES_TTL_MS,
                () => request('GET', `/favorites${query(params)}`)),
            add: (favorite) => request('POST', '/favorites', favorite).then((r) => { invalidateCache('fav'); return r; }),
            remove: (id) => request('DELETE', `/favorites/${encodeURIComponent(id)}`).then((r) => { invalidateCache('fav'); return r; }),
            // Un-favorite by keys (source,item,type) in one round-trip — no list-then-find.
            removeByKeys: (params = {}) => request('DELETE', `/favorites${query(params)}`).then((r) => { invalidateCache('fav'); return r; })
        },

        // Thumbs up/down on a title (per profile). rating 1=up, -1=down, 0=clear.
        // Device-aware so a paired TV writes/reads its ratings too.
        ratings: {
            get: (params = {}) => dualGet('/ratings', params),
            set: (body) => dualMutate('POST', '/ratings', body)
        },

        history: {
            list: (params = {}) => cachedGet('hist:' + JSON.stringify(params || {}), HISTORY_TTL_MS,
                () => request('GET', `/history${query(params)}`)),
            save: (item) => request('POST', '/history', item).then((r) => { invalidateCache('hist'); return r; }),
            remove: (id) => request('DELETE', `/history/${encodeURIComponent(id)}`).then((r) => { invalidateCache('hist'); return r; })
        },

        pairing: {
            start: (device) => request('POST', '/pairing/start', device, { token: '' }),
            poll: (code, pairingSecret = '') => request(
                'GET',
                `/pairing/${encodeURIComponent(String(code).toUpperCase())}${pairingSecret ? `?secret=${encodeURIComponent(pairingSecret)}` : ''}`,
                null,
                { token: '' }
            ),
            approve: (code) => request('POST', '/pairing/approve', { code })
        },

        commands: {
            list: (params = {}) => request('GET', `/commands${query(params)}`),
            queue: (command) => request('POST', '/commands', command),
            update: (id, patch) => request('PATCH', `/commands/${encodeURIComponent(id)}`, patch)
        },

        playback: {
            createSession: (session) => playbackRequest(session),
            getSession: (id) => playbackSessionRequest('GET', `/playback/sessions/${encodeURIComponent(id)}`),
            expireSession: (id) => playbackSessionRequest('POST', `/playback/sessions/${encodeURIComponent(id)}/expire`),
            event: (event) => playbackSessionRequest('POST', '/playback/events', event),
            summary: (params = {}) => playbackSessionRequest('GET', `/telemetry/summary${query(params)}`),
            // Phase 3 AI subtitles (whisper transcript): read the cross-user cache state
            // for a title (status none|processing|ready|failed, VTT body when ready), and
            // trigger a background transcription the first viewer pays for, the rest reuse.
            generatedSubtitle: (params = {}) => playbackSessionRequest('GET', `/generated-subtitle${query(params)}`),
            requestGeneratedSubtitle: (body) => playbackSessionRequest('POST', '/generated-subtitle', body),
            // Per-viewer "email me when these AI subtitles are ready" opt-in/out (enabled:false removes it).
            notifyGeneratedSubtitle: (body) => playbackSessionRequest('POST', '/generated-subtitle-notify', body),
            // Phase 3b: available translation target languages (the gateway's installed Argos set).
            translateLangs: () => playbackSessionRequest('GET', '/generated-subtitle-langs'),
            // Seek-thumbnail storyboard: cache state (ready → sprite URL + tile grid);
            // pass enqueue:1 to trigger generation (deferred while the account watches).
            storyboard: (params = {}) => playbackSessionRequest('GET', `/storyboard${query(params)}`)
        },

        device: {
            me: () => request('GET', '/device/me', null, { token: getDeviceToken() }),
            // Self-unpair on logout: revoke this screen's own device token so the
            // account drops it and the pairing screen can't silently resume.
            unpairSelf: () => request('DELETE', '/device/me', null, { token: getDeviceToken() }),
            heartbeat: () => request('POST', '/device/heartbeat', {}, { token: getDeviceToken() }),
            commands: () => request('GET', '/device/commands', null, { token: getDeviceToken() }),
            acknowledgeCommand: (id) => request('PATCH', `/device/commands/${encodeURIComponent(id)}`, { status: 'acknowledged' }, { token: getDeviceToken() }),
            failCommand: (id, error) => request('PATCH', `/device/commands/${encodeURIComponent(id)}`, { status: 'failed', error }, { token: getDeviceToken() }),
            sources: {
                list: () => request('GET', '/device/sources', null, { token: getDeviceToken() }),
                seriesInfo: (id, seriesId) => seriesInfoRequest(id, seriesId, { token: getDeviceToken() }),
                shortEpg: (id, streamId, limit = 8) => request(
                    'GET',
                    `/device/sources/${encodeURIComponent(id)}/short-epg?stream_id=${encodeURIComponent(streamId)}&limit=${encodeURIComponent(limit)}`,
                    null,
                    { token: getDeviceToken() }
                ),
                epg: (id, params = {}) => request(
                    'GET',
                    `/device/sources/${encodeURIComponent(id)}/epg${query(params)}`,
                    null,
                    { token: getDeviceToken() }
                )
            },
            mediaItems: {
                list: (params = {}) => catalogRequest('/device/media-items', params, { token: getDeviceToken() }),
                categories: (params = {}) => catalogRequest('/device/media-categories', params, { token: getDeviceToken() })
            },
            live: {
                logicalChannels: (params = {}) => catalogRequest('/device/live/logical-channels', params, { token: getDeviceToken() }),
                variants: (channelId, params = {}) => catalogRequest(`/device/live/channel/${encodeURIComponent(channelId)}/variants`, params, { token: getDeviceToken() })
            },
            home: {
                rails: (params = {}) => catalogRequest('/device/home/rails', params, { token: getDeviceToken() }),
                genreRails: (params = {}) => catalogRequest('/device/media-genre-rails', params, { token: getDeviceToken() }),
                genreItems: (params = {}) => catalogRequest('/device/media-genre-items', params, { token: getDeviceToken() }),
                genreSummary: (params = {}) => catalogRequest('/device/media-genre-summary', params, { token: getDeviceToken() }),
                languageFacets: (params = {}) => catalogRequest('/device/media-language-facets', params, { token: getDeviceToken() }),
                reportObservedLanguages: (body) => catalogMutate('/device/media-observed-languages', body, { token: getDeviceToken() })
            },
            playback: {
                createSession: (session) => playbackRequest(session, { token: getDeviceToken() }),
                event: (event) => playbackSessionRequest('POST', '/playback/events', event, { token: getDeviceToken() }),
                summary: (params = {}) => playbackSessionRequest('GET', `/telemetry/summary${query(params)}`, null, { token: getDeviceToken() })
            },
            // Cross-device sync for QR-paired screens (TV): same cloud tables as the
            // account (JWT) scope, reached with the device token. Lets a paired TV read
            // and write the same favorites / Continue Watching / ratings as web/phone.
            favorites: {
                list: (params = {}) => cachedGet('fav:' + JSON.stringify(params || {}), FAVORITES_TTL_MS,
                    () => request('GET', `/device/favorites${query(params)}`, null, { token: getDeviceToken() })),
                add: (favorite) => request('POST', '/device/favorites', favorite, { token: getDeviceToken() }).then((r) => { invalidateCache('fav'); return r; }),
                removeByKeys: (params = {}) => request('DELETE', `/device/favorites${query(params)}`, null, { token: getDeviceToken() }).then((r) => { invalidateCache('fav'); return r; })
            },
            ratings: {
                get: (params = {}) => request('GET', `/device/ratings${query(params)}`, null, { token: getDeviceToken() }),
                set: (body) => request('POST', '/device/ratings', body, { token: getDeviceToken() })
            },
            history: {
                list: (params = {}) => cachedGet('hist:' + JSON.stringify(params || {}), HISTORY_TTL_MS,
                    () => request('GET', `/device/history${query(params)}`, null, { token: getDeviceToken() })),
                save: (item) => request('POST', '/device/history', item, { token: getDeviceToken() }).then((r) => { invalidateCache('hist'); return r; }),
                remove: (id) => request('DELETE', `/device/history/${encodeURIComponent(id)}`, null, { token: getDeviceToken() }).then((r) => { invalidateCache('hist'); return r; })
            }
        }
    };

    function query(params) {
        const search = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') search.set(key, value);
        });
        const stringified = search.toString();
        return stringified ? `?${stringified}` : '';
    }

    window.NorvaCloud = NorvaCloud;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => NorvaCloud.regions.maybeShowPrompt());
    } else {
        setTimeout(() => NorvaCloud.regions.maybeShowPrompt(), 0);
    }
})();
