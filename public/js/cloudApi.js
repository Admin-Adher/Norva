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
    const DEFAULT_PARTNERS_API_URL = 'https://api.norva.tv/functions/v1/norva-partners';
    const DEFAULT_PARTNERS_DEVICE_API_URL = 'https://api.norva.tv/functions/v1/norva-partners-device';
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

    function partnersBase() {
        const configured = window.NORVA_PARTNERS_API_URL || DEFAULT_PARTNERS_API_URL;
        return configured.replace(/\/+$/, '');
    }

    function partnersDeviceBase() {
        const configured = window.NORVA_PARTNERS_DEVICE_API_URL || DEFAULT_PARTNERS_DEVICE_API_URL;
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
        // The region reorganizes the LIVE catalog (categories/channels are fetched
        // per region). Announce the change so the app can drop the previous region's
        // cached channels and re-render, instead of stranding stale content until a
        // manual reload. Fired on the local write (already effective), before the
        // best-effort profile save below. All three callers are deliberate user
        // actions (prompt Yes/Apply, Settings), so this never fires on a silent boot.
        try {
            document.dispatchEvent(new CustomEvent('norva:content-region-changed', { detail: { region: normalized } }));
        } catch (_) { /* noop — non-DOM contexts */ }

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
        // Account-scoped functions such as Norva Partners deliberately opt out:
        // their CORS contract does not accept a profile header and financial
        // programme state must never depend on the currently selected viewer.
        if (!options.skipProfile) {
            const activeProfileId = getActiveProfileId();
            if (activeProfileId) headers['x-norva-profile-id'] = activeProfileId;
        }

        const _trLabel = method + ' ' + String(path).split('?')[0];
        const _trT0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        NorvaTrace.log('net → ' + _trLabel);
        const send = () => fetch(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : JSON.stringify(body),
            ...(options.signal ? { signal: options.signal } : {}),
            // keepalive lets a small write (the history exit flush on pagehide /
            // backgrounding) outlive the page instead of being cancelled with it.
            // Scoped to callers that opt in; history payloads are ~1-2 KB (<<64 KB cap).
            ...(options.keepalive ? { keepalive: true } : {})
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

        // The server silently served the DEFAULT profile because the requested one is LOCKED by
        // the plan (post-downgrade). Surface it once — without this, the displayed profile and
        // the profile actually read/written diverge with zero signal (sync audit 2026-07-17 P2).
        try {
            if (response.headers.get('x-norva-profile-fallback') === 'locked' && !requestToBase._profileFallbackToasted) {
                requestToBase._profileFallbackToasted = true;
                window.NorvaModal?.toast?.('This profile is locked by your current plan — showing the main profile instead.', { tone: 'warn' });
            }
        } catch (_) { /* purely informative */ }

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

    // Analytics surface is deliberately derived from the trusted app shell
    // rather than accepted from arbitrary page state. The backend still applies
    // its own allow-list and resolves the account behind a paired-device token.
    function paywallSurface() {
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        if (/NorvaTV-AndroidTV/i.test(ua)) return 'android_tv';
        if (/Tizen|SamsungBrowser.*TV|Samsung.*SmartTV/i.test(ua)) return 'samsung_tv';
        if (/NorvaTV-/i.test(ua) || (typeof window !== 'undefined' && (window.NorvaTVCloud || window.NodeCastNative))) {
            return 'mobile_android';
        }
        return 'web';
    }
    // Pick (path, token) for a route that exists in both scopes, by session mode.
    const dualGet = (userPath, params = {}) => isDeviceOnly()
        ? request('GET', `/device${userPath}${query(params)}`, null, { token: getDeviceToken() })
        : request('GET', `${userPath}${query(params)}`);
    const dualMutate = (method, userPath, body) => isDeviceOnly()
        ? request(method, `/device${userPath}`, body, { token: getDeviceToken() })
        : request(method, userPath, body);

    // A provider item id is only unique inside its source. Keep the exact lookup in
    // one helper so web, phone and paired TV always send the complete compatibility
    // proof the backend uses to resolve the canonical cloud_titles identity.
    async function getExactRating(params = {}) {
        const sourceId = String(params.sourceId ?? params.source_id ?? '');
        const itemId = String(params.itemId ?? params.item_id ?? '');
        const itemType = String(params.itemType ?? params.item_type ?? '');
        if (!sourceId || !itemId || !itemType) return { rating: 0 };
        return dualGet('/ratings', { sourceId, itemId, itemType });
    }

    const PARTNERS_CONTRACT_VERSION = '2026-07-29';
    const PARTNERS_SCHEMA_VERSION = 1;
    const PARTNERS_VISIBILITY_REASONS = new Set([
        'disabled',
        'invite_only',
        'available',
        'existing_account'
    ]);
    const PARTNERS_ELIGIBILITY_REASONS = new Set([
        'disabled',
        'country_required',
        'country_not_supported',
        'subdivision_not_supported',
        'not_allowlisted',
        'account_blocked',
        'account_attention_required',
        'eligible'
    ]);
    const PARTNERS_ACCOUNT_STATUSES = new Set([
        'invited',
        'pending_verification',
        'active',
        'held',
        'suspended',
        'closed'
    ]);
    const PARTNERS_VERIFICATION_STATUSES = new Set([
        'not_started',
        'pending',
        'verified',
        'failed',
        'expired'
    ]);
    const PARTNERS_CONTRACT_STATUSES = new Set([
        'not_accepted',
        'accepted',
        'expired'
    ]);
    const PARTNERS_LINK_STATUSES = new Set([
        'none',
        'active',
        'revoked'
    ]);
    const PARTNERS_KYC_LEVELS = new Set([
        'identity_age_country',
        'identity_age_country_capacity'
    ]);
    const PARTNERS_NEXT_ACTIONS = new Set([
        'start_verification',
        'await_verification',
        'accept_terms',
        'activate_account',
        'share_link',
        'contact_support',
        'none'
    ]);
    const PARTNERS_HISTORY_FILTERS = new Set([
        'all',
        'pending',
        'available',
        'held',
        'paid',
        'reversed'
    ]);
    const PARTNERS_HISTORY_TYPES = new Set([
        'commission_pending',
        'commission_available',
        'commission_held',
        'commission_paid',
        'commission_reversed'
    ]);
    const PARTNERS_REPORTING_REASONS = new Set([
        'available',
        'no_financial_activity',
        'multiple_currencies'
    ]);
    const PARTNERS_SHARE_URL_PATTERN = /^https:\/\/norva\.tv\/r\/[A-Za-z0-9_-]{32}$/;
    const PARTNERS_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
    const PARTNERS_CURSOR_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
    const PARTNERS_TV_RELAY_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{43}\.[0-9a-f]{64}$/;
    const PARTNERS_PUBLIC_ERROR_CODES = new Set([
        'authentication_required',
        'invalid_access_token',
        'cors_origin_denied',
        'cors_preflight_denied',
        'invalid_content_type',
        'invalid_request',
        'payload_too_large',
        'invalid_query',
        'route_not_found',
        'method_not_allowed',
        'business_accounts_not_supported',
        'idempotency_key_required',
        'partners_action_not_allowed',
        'provider_not_configured',
        'provider_temporarily_unavailable',
        'kyc_billing_unavailable',
        'referral_not_configured',
        'tv_relay_not_configured',
        'tv_relay_not_found',
        'rate_limited',
        'idempotency_key_reused',
        'request_in_progress',
        'partners_temporarily_unavailable'
    ]);
    const PARTNERS_CONSENT_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
    const PARTNERS_REFERRAL_CLAIM_STATES = new Set([
        'absent',
        'attributed',
        'already_attributed',
        'ineligible',
        'expired',
        'invalid',
        'authentication_required',
        'temporarily_unavailable'
    ]);
    // Revolut destinations are provisioned by Finance. The generic token
    // mutation deliberately remains narrower.
    const PARTNERS_PAYOUT_READ_PROVIDERS = new Set([
        'wise',
        'revolut',
        'stripe_connect'
    ]);
    const PARTNERS_PAYOUT_TOKEN_WRITE_PROVIDERS = new Set([
        'wise',
        'stripe_connect'
    ]);
    const PARTNERS_PAYOUT_PROFILE_STATUSES = new Set([
        'active',
        'disabled',
        'verification_required'
    ]);
    const PARTNERS_FISCAL_STATUSES = new Set([
        'missing',
        'pending',
        'verified',
        'rejected',
        'expired'
    ]);
    const PARTNERS_PAYOUT_READINESS_REASONS = new Set([
        'account_not_active',
        'kyc_not_verified',
        'fiscal_profile_required',
        'provider_not_configured',
        'payouts_not_live'
    ]);

    function partnersContractError() {
        const error = new Error('Norva Partners is temporarily unavailable.');
        error.code = 'partners_contract_invalid';
        return error;
    }

    function partnersClientError(code) {
        const error = new Error('Norva Partners is unavailable for this session.');
        error.code = code;
        return error;
    }

    function normalizePartnersRequestError(raw) {
        const publicError = raw?.payload?.error;
        const code = typeof publicError?.code === 'string'
            && PARTNERS_PUBLIC_ERROR_CODES.has(publicError.code)
            ? publicError.code
            : 'partners_temporarily_unavailable';
        const error = partnersClientError(code);
        if (Number.isSafeInteger(raw?.status)) error.status = raw.status;
        return error;
    }

    function isPlainRecord(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
            && Object.prototype.toString.call(value) === '[object Object]';
    }

    function hasExactKeys(value, expected) {
        if (!isPlainRecord(value)) return false;
        const actual = Object.keys(value).sort();
        const wanted = expected.slice().sort();
        return actual.length === wanted.length
            && actual.every((key, index) => key === wanted[index]);
    }

    function isBoundedString(value, { nullable = false, pattern = null, max = 128 } = {}) {
        if (nullable && value === null) return true;
        return typeof value === 'string'
            && value.length > 0
            && value.length <= max
            && (!pattern || pattern.test(value));
    }

    function isIsoTimestamp(value, nullable = false) {
        if (nullable && value === null) return true;
        return isBoundedString(value, { max: 64 }) && Number.isFinite(Date.parse(value));
    }

    function isTrustedDiditHostedUrl(value) {
        if (!isBoundedString(value, { max: 2048 })) return false;
        try {
            const url = new URL(value);
            return url.protocol === 'https:'
                && url.hostname === 'verify.didit.me'
                && !url.username
                && !url.password;
        } catch (_) {
            return false;
        }
    }

    function validatePayoutThresholds(value) {
        if (!isPlainRecord(value)) return false;
        const entries = Object.entries(value);
        return entries.length >= 1
            && entries.length <= 32
            && entries.every(([currency, amount]) => (
                /^[A-Z]{3}$/.test(currency)
                && Number.isSafeInteger(amount)
                && amount > 0
            ));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function validatePartnersBootstrap(payload, expectedJurisdiction = {}) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'correlationId', 'data'])) invalid();
        if (payload.version !== PARTNERS_CONTRACT_VERSION
            || !isBoundedString(payload.correlationId, { max: 128 })
            || !hasExactKeys(payload.data, [
                'schema_version',
                'flags',
                'visibility',
                'eligibility',
                'program',
                'policy',
                'allowlist',
                'account'
            ])) invalid();

        const data = payload.data;
        if (data.schema_version !== PARTNERS_SCHEMA_VERSION) invalid();
        if (!hasExactKeys(data.flags, [
            'partners_enabled',
            'partners_invite_only',
            'partners_shadow_mode',
            'partners_payouts_live',
            'partners_tv_relay_enabled'
        ]) || Object.values(data.flags).some((flag) => typeof flag !== 'boolean')) invalid();

        if (!hasExactKeys(data.visibility, ['visible', 'reason'])
            || typeof data.visibility.visible !== 'boolean'
            || !PARTNERS_VISIBILITY_REASONS.has(data.visibility.reason)) invalid();
        if (!hasExactKeys(data.eligibility, ['eligible', 'reason'])
            || typeof data.eligibility.eligible !== 'boolean'
            || !PARTNERS_ELIGIBILITY_REASONS.has(data.eligibility.reason)) invalid();

        if (data.program !== null) {
            const program = data.program;
            if (!hasExactKeys(program, [
                'version_key',
                'commission_rate_bps',
                'attribution_window_days',
                'maturation_days',
                'payout_thresholds',
                'effective_from',
                'effective_until'
            ])
                || !isBoundedString(program.version_key, { max: 128 })
                || program.commission_rate_bps !== 2000
                || program.attribution_window_days !== 30
                || program.maturation_days !== 45
                || !validatePayoutThresholds(program.payout_thresholds)
                || !isIsoTimestamp(program.effective_from)
                || !isIsoTimestamp(program.effective_until, true)) invalid();
        }

        if (data.policy !== null) {
            const policy = data.policy;
            if (!hasExactKeys(policy, [
                'country_code',
                'subdivision_code',
                'individual_available',
                'minimum_age',
                'capacity_required',
                'kyc_level',
                'payout_currencies',
                'terms_version',
                'disclosure_version'
            ])
                || !isBoundedString(policy.country_code, { pattern: /^[A-Z]{2}$/, max: 2 })
                || !isBoundedString(policy.subdivision_code, {
                    nullable: true,
                    pattern: /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
                    max: 12
                })
                || typeof policy.individual_available !== 'boolean'
                || !Number.isSafeInteger(policy.minimum_age)
                || policy.minimum_age < 18
                || policy.minimum_age > 99
                || typeof policy.capacity_required !== 'boolean'
                || !PARTNERS_KYC_LEVELS.has(policy.kyc_level)
                || (policy.capacity_required !== (policy.kyc_level === 'identity_age_country_capacity'))
                || !Array.isArray(policy.payout_currencies)
                || policy.payout_currencies.length > 32
                || policy.payout_currencies.some((currency) => !/^[A-Z]{3}$/.test(currency))
                || new Set(policy.payout_currencies).size !== policy.payout_currencies.length
                || !isBoundedString(policy.terms_version, { max: 128 })
                || !isBoundedString(policy.disclosure_version, { max: 128 })) invalid();
        }

        if (!hasExactKeys(data.allowlist, ['required', 'included'])
            || typeof data.allowlist.required !== 'boolean'
            || typeof data.allowlist.included !== 'boolean') invalid();

        if (!hasExactKeys(data.account, [
            'exists',
            'status',
            'account_type',
            'verification_status',
            'contract_status',
            'link_status'
        ])
            || typeof data.account.exists !== 'boolean') invalid();

        if (data.account.exists) {
            if (!PARTNERS_ACCOUNT_STATUSES.has(data.account.status)
                || data.account.account_type !== 'individual'
                || !PARTNERS_VERIFICATION_STATUSES.has(data.account.verification_status)
                || !PARTNERS_CONTRACT_STATUSES.has(data.account.contract_status)
                || !PARTNERS_LINK_STATUSES.has(data.account.link_status)) invalid();
        } else if (data.account.status !== null
            || data.account.account_type !== null
            || data.account.verification_status !== null
            || data.account.contract_status !== null
            || data.account.link_status !== null) invalid();

        if ((data.visibility.reason === 'existing_account') !== data.account.exists) invalid();
        if (['account_blocked', 'account_attention_required'].includes(data.eligibility.reason)
            && !data.account.exists) invalid();
        if (data.allowlist.required !== data.flags.partners_invite_only) invalid();
        if (data.visibility.reason === 'available' && !data.flags.partners_enabled) invalid();
        if (data.account.link_status === 'active'
            && (data.account.status !== 'active'
                || data.account.verification_status !== 'verified'
                || data.account.contract_status !== 'accepted')) invalid();

        // A newly discovered programme must match the jurisdiction requested by
        // this client. Existing partner accounts are intentionally exempt: the
        // RPC returns their authoritative stored jurisdiction, which may differ
        // from the device's current location.
        if (!data.account.exists && data.policy !== null) {
            if (expectedJurisdiction.countryCode
                && data.policy.country_code !== expectedJurisdiction.countryCode) invalid();
            if (expectedJurisdiction.subdivisionCode
                && data.policy.subdivision_code !== null
                && data.policy.subdivision_code !== expectedJurisdiction.subdivisionCode) invalid();
        }

        const visibilityExpected = data.visibility.reason === 'available'
            || data.visibility.reason === 'existing_account';
        if (data.visibility.visible !== visibilityExpected) invalid();
        if (data.eligibility.eligible !== (data.eligibility.reason === 'eligible')) invalid();
        if (data.visibility.reason === 'existing_account' && !data.account.exists) invalid();
        if (data.eligibility.eligible && (
            !data.flags.partners_enabled
            || !data.visibility.visible
            || data.program === null
            || data.policy === null
            || data.policy.individual_available !== true
            || (data.allowlist.required && !data.allowlist.included)
        )) invalid();

        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersActionAccount(value) {
        if (!hasExactKeys(value, [
            'exists',
            'status',
            'verification_status',
            'contract_status',
            'link_status'
        ])
            || value.exists !== true
            || !PARTNERS_ACCOUNT_STATUSES.has(value.status)
            || !PARTNERS_VERIFICATION_STATUSES.has(value.verification_status)
            || !PARTNERS_CONTRACT_STATUSES.has(value.contract_status)
            || !PARTNERS_LINK_STATUSES.has(value.link_status)) {
            throw partnersContractError();
        }
        if (value.link_status === 'active'
            && (value.status !== 'active'
                || value.verification_status !== 'verified'
                || value.contract_status !== 'accepted')) {
            throw partnersContractError();
        }
        return value;
    }

    function validatePartnersAction(payload, expectedAction, { linkRequired = false } = {}) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'correlationId', 'data'])
            || payload.version !== PARTNERS_CONTRACT_VERSION
            || !isBoundedString(payload.correlationId, { max: 128 })) invalid();
        const expectedKeys = [
            'schema_version',
            'action',
            'replayed',
            'account',
            'next_action',
            ...(linkRequired ? ['link'] : [])
        ];
        if (!hasExactKeys(payload.data, expectedKeys)) invalid();
        const data = payload.data;
        if (data.schema_version !== PARTNERS_SCHEMA_VERSION
            || data.action !== expectedAction
            || typeof data.replayed !== 'boolean'
            || !PARTNERS_NEXT_ACTIONS.has(data.next_action)) invalid();
        validatePartnersActionAccount(data.account);
        if (linkRequired) {
            if (!hasExactKeys(data.link, ['status', 'share_url', 'rotated_at'])
                || data.link.status !== 'active'
                || !isBoundedString(data.link.share_url, {
                    pattern: PARTNERS_SHARE_URL_PATTERN,
                    max: 128
                })
                || !isIsoTimestamp(data.link.rotated_at)) invalid();
        }
        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersDashboard(payload, expectedStatus) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'correlationId', 'data'])
            || payload.version !== PARTNERS_CONTRACT_VERSION
            || !isBoundedString(payload.correlationId, { max: 128 })
            || !hasExactKeys(payload.data, [
                'schema_version',
                'account',
                'link',
                'reporting',
                'history'
            ])) invalid();
        const data = payload.data;
        if (data.schema_version !== PARTNERS_SCHEMA_VERSION
            || !hasExactKeys(data.account, [
                'exists',
                'status',
                'verification_status',
                'contract_status',
                'link_status',
                'country_code',
                'subdivision_code',
                'created_at',
                'updated_at'
            ])
            || typeof data.account.exists !== 'boolean') invalid();
        if (data.account.exists) {
            if (!PARTNERS_ACCOUNT_STATUSES.has(data.account.status)
                || !PARTNERS_VERIFICATION_STATUSES.has(data.account.verification_status)
                || !PARTNERS_CONTRACT_STATUSES.has(data.account.contract_status)
                || !PARTNERS_LINK_STATUSES.has(data.account.link_status)
                || !isBoundedString(data.account.country_code, { pattern: /^[A-Z]{2}$/, max: 2 })
                || !isBoundedString(data.account.subdivision_code, {
                    nullable: true,
                    pattern: /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
                    max: 12
                })
                || !isIsoTimestamp(data.account.created_at)
                || !isIsoTimestamp(data.account.updated_at)) invalid();
        } else if (data.account.status !== null
            || data.account.verification_status !== null
            || data.account.contract_status !== null
            || data.account.link_status !== null
            || data.account.country_code !== null
            || data.account.subdivision_code !== null
            || data.account.created_at !== null
            || data.account.updated_at !== null) invalid();

        if (data.link !== null) {
            if (!hasExactKeys(data.link, ['status', 'share_url', 'created_at'])
                || data.link.status !== 'active'
                || !isBoundedString(data.link.share_url, {
                    pattern: PARTNERS_SHARE_URL_PATTERN,
                    max: 128
                })
                || !isIsoTimestamp(data.link.created_at)) invalid();
        }
        if ((data.account.link_status === 'active') !== (data.link !== null)) invalid();

        if (!hasExactKeys(data.reporting, [
            'available',
            'reason',
            'currency',
            'clicks',
            'referrals',
            'pending_minor',
            'available_minor',
            'paid_minor',
            'currencies'
        ]) || typeof data.reporting.available !== 'boolean') invalid();
        const reporting = data.reporting;
        const nullableNonNegativeInteger = (value) => value === null
            || (Number.isSafeInteger(value) && value >= 0);
        if (typeof reporting.reason !== 'string'
            || !PARTNERS_REPORTING_REASONS.has(reporting.reason)
            || !isBoundedString(reporting.currency, {
                nullable: true,
                pattern: /^[A-Z]{3}$/,
                max: 3
            })
            || !nullableNonNegativeInteger(reporting.clicks)
            || !nullableNonNegativeInteger(reporting.referrals)
            || !nullableNonNegativeInteger(reporting.pending_minor)
            || !nullableNonNegativeInteger(reporting.available_minor)
            || !nullableNonNegativeInteger(reporting.paid_minor)
            || !Array.isArray(reporting.currencies)
            || reporting.currencies.length > 32) invalid();
        for (const balance of reporting.currencies) {
            if (!hasExactKeys(balance, [
                'currency',
                'pending_minor',
                'available_minor',
                'paid_minor',
                'payout_destination_ready'
            ])
                || !/^[A-Z]{3}$/.test(balance.currency)
                || !Number.isSafeInteger(balance.pending_minor)
                || balance.pending_minor < 0
                || !Number.isSafeInteger(balance.available_minor)
                || balance.available_minor < 0
                || !Number.isSafeInteger(balance.paid_minor)
                || balance.paid_minor < 0
                || typeof balance.payout_destination_ready !== 'boolean') invalid();
        }
        if (new Set(reporting.currencies.map((balance) => balance.currency)).size
            !== reporting.currencies.length) invalid();
        if (!Number.isSafeInteger(reporting.clicks)
            || reporting.clicks < 0
            || !Number.isSafeInteger(reporting.referrals)
            || reporting.referrals < 0) invalid();
        if (reporting.available && reporting.reason === 'available') {
            if (reporting.currencies.length !== 1
                || reporting.currency === null
                || reporting.pending_minor === null
                || reporting.available_minor === null
                || reporting.paid_minor === null
                || reporting.currencies[0].currency !== reporting.currency
                || reporting.currencies[0].pending_minor !== reporting.pending_minor
                || reporting.currencies[0].available_minor !== reporting.available_minor
                || reporting.currencies[0].paid_minor !== reporting.paid_minor) invalid();
        } else if (reporting.available && reporting.reason === 'multiple_currencies') {
            if (reporting.currencies.length < 2
                || reporting.currency !== null
                || reporting.pending_minor !== null
                || reporting.available_minor !== null
                || reporting.paid_minor !== null) invalid();
        } else if (
            reporting.available
            || reporting.reason === 'available'
            || reporting.reason === 'multiple_currencies'
            || reporting.currency !== null
            || reporting.pending_minor !== null
            || reporting.available_minor !== null
            || reporting.paid_minor !== null
            || reporting.currencies.length !== 0
        ) invalid();

        if (!hasExactKeys(data.history, ['status', 'items', 'next_cursor'])
            || data.history.status !== expectedStatus
            || !PARTNERS_HISTORY_FILTERS.has(data.history.status)
            || !Array.isArray(data.history.items)
            || data.history.items.length > 50
            || (data.history.next_cursor !== null
                && !isBoundedString(data.history.next_cursor, {
                    pattern: PARTNERS_CURSOR_PATTERN,
                    max: 256
                }))) invalid();
        for (const item of data.history.items) {
            if (!hasExactKeys(item, ['type', 'occurred_at'])
                || !PARTNERS_HISTORY_TYPES.has(item.type)
                || !isIsoTimestamp(item.occurred_at)) invalid();
            const expectedType = expectedStatus === 'all'
                ? null
                : `commission_${expectedStatus}`;
            if (expectedType !== null && item.type !== expectedType) invalid();
        }
        if (reporting.reason === 'no_financial_activity'
            && (data.history.items.length !== 0
                || data.history.next_cursor !== null)) invalid();

        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersKycSession(payload) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'correlationId', 'data'])
            || payload.version !== PARTNERS_CONTRACT_VERSION
            || !isBoundedString(payload.correlationId, { max: 128 })
            || !hasExactKeys(payload.data, [
                'schema_version',
                'action',
                'replayed',
                'verification'
            ])) invalid();
        const data = payload.data;
        if (data.schema_version !== PARTNERS_SCHEMA_VERSION
            || data.action !== 'kyc_session_created'
            || typeof data.replayed !== 'boolean'
            || !hasExactKeys(data.verification, [
                'provider',
                'status',
                'url',
                'expires_at'
            ])
            || data.verification.provider !== 'didit'
            || data.verification.status !== 'pending'
            || !isTrustedDiditHostedUrl(data.verification.url)
            || !isIsoTimestamp(data.verification.expires_at, true)) invalid();
        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersReferralClaim(payload) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'claimed', 'state'])
            || payload.version !== 1
            || typeof payload.claimed !== 'boolean'
            || !PARTNERS_REFERRAL_CLAIM_STATES.has(payload.state)
            || payload.claimed !== (
                payload.state === 'attributed'
                || payload.state === 'already_attributed'
            )) invalid();
        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersPayoutProfileValue(profile) {
        return hasExactKeys(profile, ['provider', 'display_masked', 'currency', 'status'])
            && PARTNERS_PAYOUT_READ_PROVIDERS.has(profile.provider)
            && isBoundedString(profile.display_masked, { max: 64 })
            && profile.display_masked.length >= 4
            && !looksLikeRawPayoutIdentifier(profile.display_masked)
            && /^[A-Z]{3}$/.test(profile.currency)
            && PARTNERS_PAYOUT_PROFILE_STATUSES.has(profile.status);
    }

    function looksLikeRawPayoutIdentifier(value) {
        const text = String(value || '');
        const compact = text.replace(/[- ]/g, '').toUpperCase();
        return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)
            || /^\d{6,34}$/.test(text.replace(/[-:/. ]/g, ''))
            || /^[^@\s]+@[^@\s]+$/.test(text);
    }

    function validatePartnersPayoutProfile(payload) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'correlationId', 'data'])
            || payload.version !== PARTNERS_CONTRACT_VERSION
            || !isBoundedString(payload.correlationId, { max: 128 })
            || !hasExactKeys(payload.data, [
                'schema_version',
                'account',
                'fiscal',
                'profile',
                'profiles',
                'readiness'
            ])) invalid();
        const data = payload.data;
        if (data.schema_version !== PARTNERS_SCHEMA_VERSION
            || !hasExactKeys(data.account, ['id', 'status'])
            || !/^prt_[0-9a-f]{24}$/.test(data.account.id)
            || !PARTNERS_ACCOUNT_STATUSES.has(data.account.status)
            || (data.fiscal !== null && (
                !hasExactKeys(data.fiscal, ['status', 'country_code'])
                || !PARTNERS_FISCAL_STATUSES.has(data.fiscal.status)
                || !/^[A-Z]{2}$/.test(data.fiscal.country_code)
            ))
            || (data.profile !== null && !validatePartnersPayoutProfileValue(data.profile))
            || !Array.isArray(data.profiles)
            || data.profiles.length > 32
            || data.profiles.some((profile) => !validatePartnersPayoutProfileValue(profile))
            || new Set(data.profiles.map((profile) => profile.currency)).size !== data.profiles.length
            || ((data.profile === null) !== (data.profiles.length === 0))
            || (data.profile !== null && !data.profiles.some((profile) =>
                profile.provider === data.profile.provider
                && profile.display_masked === data.profile.display_masked
                && profile.currency === data.profile.currency
                && profile.status === data.profile.status
            ))
            || !hasExactKeys(data.readiness, ['ready', 'payouts_live', 'reason'])
            || typeof data.readiness.ready !== 'boolean'
            || typeof data.readiness.payouts_live !== 'boolean'
            || (data.readiness.reason !== null
                && !PARTNERS_PAYOUT_READINESS_REASONS.has(data.readiness.reason))) invalid();
        if (data.readiness.ready !== (
            data.readiness.reason === null
            && data.readiness.payouts_live
            && data.account.status === 'active'
            && data.fiscal?.status === 'verified'
            && data.profile?.status === 'active'
        )) invalid();
        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersPayoutProfileSaved(payload) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'correlationId', 'data'])
            || payload.version !== PARTNERS_CONTRACT_VERSION
            || !isBoundedString(payload.correlationId, { max: 128 })
            || !hasExactKeys(payload.data, [
                'schema_version',
                'action',
                'replayed',
                'profile'
            ])
            || payload.data.schema_version !== PARTNERS_SCHEMA_VERSION
            || payload.data.action !== 'payout_profile_saved'
            || typeof payload.data.replayed !== 'boolean'
            || !validatePartnersPayoutProfileValue(payload.data.profile)
            || payload.data.profile.status !== 'active') invalid();
        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersTvEnvelope(payload, validator) {
        const invalid = () => { throw partnersContractError(); };
        if (!hasExactKeys(payload, ['version', 'correlationId', 'data'])
            || payload.version !== PARTNERS_CONTRACT_VERSION
            || !isBoundedString(payload.correlationId, { max: 128 })
            || !isPlainRecord(payload.data)
            || typeof validator !== 'function') invalid();
        validator(payload.data, invalid);
        return deepFreeze(cloneJson(payload));
    }

    function validatePartnersTvAvailability(payload) {
        return validatePartnersTvEnvelope(payload, (data, invalid) => {
            if (!hasExactKeys(data, ['schema_version', 'availability'])
                || data.schema_version !== PARTNERS_SCHEMA_VERSION
                || !hasExactKeys(data.availability, ['enabled', 'reason'])
                || typeof data.availability.enabled !== 'boolean'
                || !['available', 'feature_disabled', 'not_configured']
                    .includes(data.availability.reason)
                || data.availability.enabled !== (data.availability.reason === 'available')) invalid();
        });
    }

    function validatePartnersTvRelayCreate(payload) {
        return validatePartnersTvEnvelope(payload, (data, invalid) => {
            if (!hasExactKeys(data, ['schema_version', 'action', 'relay'])
                || data.schema_version !== PARTNERS_SCHEMA_VERSION
                || data.action !== 'tv_relay_created'
                || !hasExactKeys(data.relay, [
                    'status',
                    'relay_token',
                    'handoff_url',
                    'expires_at',
                    'poll_after_seconds'
                ])
                || data.relay.status !== 'pending'
                || data.relay.poll_after_seconds !== 3
                || !PARTNERS_TV_RELAY_TOKEN_PATTERN.test(data.relay.relay_token)
                || !isIsoTimestamp(data.relay.expires_at)
                || !isTrustedPartnersTvHandoff(
                    data.relay.handoff_url,
                    data.relay.relay_token
                )) invalid();
        });
    }

    function validatePartnersTvRelayStatus(payload) {
        return validatePartnersTvEnvelope(payload, (data, invalid) => {
            if (!hasExactKeys(data, ['schema_version', 'relay'])
                || data.schema_version !== PARTNERS_SCHEMA_VERSION
                || !hasExactKeys(data.relay, [
                    'status',
                    'destination',
                    'poll_after_seconds'
                ])
                || !['pending', 'consumed', 'expired'].includes(data.relay.status)
                || data.relay.poll_after_seconds !== 3
                || (data.relay.status === 'consumed'
                    ? data.relay.destination !== 'partners'
                    : data.relay.destination !== null)) invalid();
        });
    }

    function validatePartnersTvRelayConsumed(payload) {
        return validatePartnersTvEnvelope(payload, (data, invalid) => {
            if (!hasExactKeys(data, [
                'schema_version',
                'action',
                'replayed',
                'relay'
            ])
                || data.schema_version !== PARTNERS_SCHEMA_VERSION
                || data.action !== 'tv_relay_consumed'
                || typeof data.replayed !== 'boolean'
                || !hasExactKeys(data.relay, ['status', 'destination'])
                || data.relay.status !== 'consumed'
                || data.relay.destination !== 'partners') invalid();
        });
    }

    function isTrustedPartnersTvHandoff(value, relayToken) {
        if (typeof value !== 'string' || value.length > 2048) return false;
        try {
            const url = new URL(value);
            return url.protocol === 'https:'
                && /^(?:[a-z0-9-]+\.)*norva\.tv$/.test(url.hostname)
                && !url.username
                && !url.password
                && !url.search
                && url.pathname !== '/'
                && url.hash === `#relay=${encodeURIComponent(relayToken)}`;
        } catch (_) {
            return false;
        }
    }

    function partnersRequireUserSession() {
        if (!getToken() || isDeviceOnly()) {
            throw partnersClientError('partners_user_session_required');
        }
    }

    function partnersRequireDeviceSession() {
        if (!isDeviceOnly() || !getDeviceToken()) {
            throw partnersClientError('partners_device_session_required');
        }
    }

    function partnersIdempotencyKey(value) {
        const key = String(value || '').trim();
        if (!PARTNERS_IDEMPOTENCY_PATTERN.test(key)) {
            throw partnersClientError('partners_idempotency_key_invalid');
        }
        return key;
    }

    async function partnersPost(path, body, idempotencyKey, validator) {
        partnersRequireUserSession();
        const safeIdempotencyKey = partnersIdempotencyKey(idempotencyKey);
        let payload;
        try {
            payload = await requestToBase(
                partnersBase(),
                'POST',
                path,
                body,
                {
                    skipProfile: true,
                    headers: { 'Idempotency-Key': safeIdempotencyKey }
                }
            );
        } catch (error) {
            throw normalizePartnersRequestError(error);
        }
        return validator(payload);
    }

    async function partnersDeviceRequest(method, path, body, {
        idempotencyKey,
        signal,
        validator
    } = {}) {
        partnersRequireDeviceSession();
        const headers = {};
        if (idempotencyKey !== undefined) {
            headers['Idempotency-Key'] = partnersIdempotencyKey(idempotencyKey);
        }
        let payload;
        try {
            payload = await requestToBase(
                partnersDeviceBase(),
                method,
                path,
                body,
                {
                    token: getDeviceToken(),
                    signal,
                    skipProfile: true,
                    headers
                }
            );
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            throw normalizePartnersRequestError(error);
        }
        return validator(payload);
    }

    async function partnersBootstrap({ countryCode, subdivisionCode, signal } = {}) {
        partnersRequireUserSession();
        const country = String(countryCode || '').trim().toUpperCase();
        const subdivision = String(subdivisionCode || '').trim().toUpperCase();
        if ((country && !/^[A-Z]{2}$/.test(country))
            || (subdivision && !country)
            || (subdivision && (
                subdivision.length > 12
                || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(subdivision)
            ))
            || (country
                && subdivision.includes('-')
                && subdivision.split('-')[0] !== country)) {
            throw partnersClientError('partners_jurisdiction_invalid');
        }
        const suffix = query({
            countryCode: country || undefined,
            subdivisionCode: subdivision || undefined
        });
        let payload;
        try {
            payload = await requestToBase(
                partnersBase(),
                'GET',
                `/bootstrap${suffix}`,
                null,
                { signal, skipProfile: true }
            );
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            throw normalizePartnersRequestError(error);
        }
        return validatePartnersBootstrap(payload, {
            countryCode: country || null,
            subdivisionCode: subdivision || null
        });
    }

    async function partnersApply({
        countryCode,
        subdivisionCode,
        accountType = 'individual',
        idempotencyKey
    } = {}) {
        const country = String(countryCode || '').trim().toUpperCase();
        const subdivision = String(subdivisionCode || '').trim().toUpperCase();
        if (accountType !== 'individual'
            || !/^[A-Z]{2}$/.test(country)
            || (subdivision && (
                subdivision.length > 12
                || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(subdivision)
                || (subdivision.includes('-') && subdivision.split('-')[0] !== country)
            ))) {
            throw partnersClientError(
                accountType === 'individual'
                    ? 'partners_jurisdiction_invalid'
                    : 'business_accounts_not_supported'
            );
        }
        return partnersPost('/applications', {
            accountType: 'individual',
            countryCode: country,
            ...(subdivision ? { subdivisionCode: subdivision } : {})
        }, idempotencyKey, (payload) => validatePartnersAction(payload, 'application_submitted'));
    }

    function partnersAcceptTerms({ termsVersion, disclosureVersion, idempotencyKey } = {}) {
        if (!isBoundedString(termsVersion, {
            pattern: /^[a-z0-9][a-z0-9._-]{2,63}$/,
            max: 64
        }) || !isBoundedString(disclosureVersion, {
            pattern: /^[a-z0-9][a-z0-9._-]{2,63}$/,
            max: 64
        })) {
            throw partnersClientError('partners_terms_invalid');
        }
        return partnersPost('/activate', {
            termsVersion,
            disclosureVersion
        }, idempotencyKey, (payload) => validatePartnersAction(payload, 'terms_accepted'));
    }

    function partnersRotateLink({ idempotencyKey } = {}) {
        return partnersPost(
            '/links',
            {},
            idempotencyKey,
            (payload) => validatePartnersAction(payload, 'link_rotated', { linkRequired: true })
        );
    }

    function partnersStartKyc({
        language = 'en',
        consentVersion,
        capacityConfirmed,
        idempotencyKey
    } = {}) {
        const safeLanguage = String(language || '').trim().toLowerCase();
        const safeConsentVersion = String(consentVersion || '').trim();
        if (!/^[a-z]{2}$/.test(safeLanguage)
            || !PARTNERS_CONSENT_VERSION_PATTERN.test(safeConsentVersion)
            || capacityConfirmed !== true) {
            throw partnersClientError('partners_kyc_consent_invalid');
        }
        return partnersPost('/kyc/sessions', {
            language: safeLanguage,
            consentVersion: safeConsentVersion,
            consentGranted: true,
            capacityConfirmed: true
        }, idempotencyKey, validatePartnersKycSession);
    }

    async function partnersClaimReferral({ signal } = {}) {
        partnersRequireUserSession();
        let payload;
        try {
            payload = await requestToBase(
                window.location.origin,
                'POST',
                '/api/partners/claim',
                {},
                { signal, skipProfile: true }
            );
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            const status = Number(error?.status) || 0;
            if (status === 401) {
                return deepFreeze({
                    version: 1,
                    claimed: false,
                    state: 'authentication_required'
                });
            }
            if (status === 429 || status >= 500) {
                return deepFreeze({
                    version: 1,
                    claimed: false,
                    state: 'temporarily_unavailable'
                });
            }
            throw partnersContractError();
        }
        return validatePartnersReferralClaim(payload);
    }

    async function partnersPayoutProfile({ signal } = {}) {
        partnersRequireUserSession();
        let payload;
        try {
            payload = await requestToBase(
                partnersBase(),
                'GET',
                '/payout-profile',
                null,
                { signal, skipProfile: true }
            );
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            throw normalizePartnersRequestError(error);
        }
        return validatePartnersPayoutProfile(payload);
    }

    function partnersSaveTokenizedPayoutProfile({
        provider,
        beneficiaryTokenRef,
        displayMasked,
        currency,
        idempotencyKey
    } = {}) {
        const safeProvider = String(provider || '').trim();
        const safeToken = String(beneficiaryTokenRef || '');
        const safeMask = String(displayMasked || '');
        const safeCurrency = String(currency || '').trim().toUpperCase();
        if (!PARTNERS_PAYOUT_TOKEN_WRITE_PROVIDERS.has(safeProvider)
            || safeToken.length < 8
            || safeToken.length > 255
            || /[\s\u0000-\u001f\u007f]/u.test(safeToken)
            || looksLikeRawPayoutIdentifier(safeToken)
            || safeMask !== safeMask.trim()
            || safeMask.length < 4
            || safeMask.length > 64
            || /[\u0000-\u001f\u007f]/u.test(safeMask)
            || looksLikeRawPayoutIdentifier(safeMask)
            || !/^[A-Z]{3}$/.test(safeCurrency)) {
            throw partnersClientError('partners_payout_profile_invalid');
        }
        return partnersPost('/payout-profile', {
            provider: safeProvider,
            beneficiaryTokenRef: safeToken,
            displayMasked: safeMask,
            currency: safeCurrency
        }, idempotencyKey, validatePartnersPayoutProfileSaved);
    }

    function partnersDeviceAvailability({ signal } = {}) {
        return partnersDeviceRequest(
            'GET',
            '/availability',
            null,
            { signal, validator: validatePartnersTvAvailability }
        );
    }

    function partnersDeviceCreateRelay({ idempotencyKey, signal } = {}) {
        return partnersDeviceRequest(
            'POST',
            '/relays',
            {},
            {
                idempotencyKey,
                signal,
                validator: validatePartnersTvRelayCreate
            }
        );
    }

    function partnersDeviceRelayStatus({ relayToken, signal } = {}) {
        const safeRelayToken = String(relayToken || '');
        if (!PARTNERS_TV_RELAY_TOKEN_PATTERN.test(safeRelayToken)) {
            throw partnersClientError('partners_tv_relay_invalid');
        }
        return partnersDeviceRequest(
            'POST',
            '/relays/status',
            { relayToken: safeRelayToken },
            { signal, validator: validatePartnersTvRelayStatus }
        );
    }

    function partnersConsumeTvRelay({ relayToken, idempotencyKey } = {}) {
        const safeRelayToken = String(relayToken || '');
        if (!PARTNERS_TV_RELAY_TOKEN_PATTERN.test(safeRelayToken)) {
            throw partnersClientError('partners_tv_relay_invalid');
        }
        return partnersPost(
            '/tv-relays/consume',
            { relayToken: safeRelayToken },
            idempotencyKey,
            validatePartnersTvRelayConsumed
        );
    }

    async function partnersDashboard({ limit = 25, status = 'all', cursor, signal } = {}) {
        partnersRequireUserSession();
        const safeLimit = Number(limit);
        const safeStatus = String(status || 'all');
        const safeCursor = cursor == null || cursor === '' ? null : String(cursor);
        if (!Number.isSafeInteger(safeLimit)
            || safeLimit < 1
            || safeLimit > 50
            || !PARTNERS_HISTORY_FILTERS.has(safeStatus)
            || (safeCursor !== null && !PARTNERS_CURSOR_PATTERN.test(safeCursor))) {
            throw partnersClientError('partners_dashboard_query_invalid');
        }
        let payload;
        try {
            payload = await requestToBase(
                partnersBase(),
                'GET',
                `/dashboard${query({
                    limit: safeLimit,
                    status: safeStatus,
                    cursor: safeCursor || undefined
                })}`,
                null,
                { signal, skipProfile: true }
            );
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            throw normalizePartnersRequestError(error);
        }
        return validatePartnersDashboard(payload, safeStatus);
    }

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

        // Norva Partners is a separate user-JWT surface. Every response is
        // validated against an exact schema and no financial data is persisted
        // in the browser.
        partners: Object.freeze({
            bootstrap: partnersBootstrap,
            apply: partnersApply,
            acceptTerms: partnersAcceptTerms,
            rotateLink: partnersRotateLink,
            startKyc: partnersStartKyc,
            claimReferral: partnersClaimReferral,
            payoutProfile: partnersPayoutProfile,
            saveTokenizedPayoutProfile: partnersSaveTokenizedPayoutProfile,
            dashboard: partnersDashboard,
            consumeTvRelay: partnersConsumeTvRelay,
            device: Object.freeze({
                availability: partnersDeviceAvailability,
                createRelay: partnersDeviceCreateRelay,
                relayStatus: partnersDeviceRelayStatus
            })
        }),

        profile: {
            get: () => cachedGet('profile', PROFILE_TTL_MS, () => request('GET', '/profile')).then(rememberProfileRegion),
            save: async (profile) => {
                const saved = rememberProfileRegion(await request('PUT', '/profile', profile));
                invalidateCache('profile');
                return saved;
            }
        },

        // Enregistrement du token FCM de l'appareil (app Android) auprès du
        // backend — norva-cloud upsert dans cloud_push_tokens. Chemin DIRECT :
        // ne pas passer par API.request/CloudAdapter, qui ne route que les
        // endpoints catalogue (c'était le bug historique : « Cloud API route
        // not mapped » avalé en silence → zéro appareil enregistré).
        push: {
            register: (token, platform) => request('POST', '/push-token', { token, platform: platform || 'android' })
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
            trialEligibility: () => cachedGet('trialEligibility', PROFILES_TTL_MS, () => request('GET', '/billing/trial-eligibility')),

            // Sticky account-level paywall assignment. No variant is accepted
            // from the client: norva-cloud claims it server-side from user_id (or
            // the account behind a paired device token), so Web/mobile/TV cannot
            // drift into different experiment arms.
            paywallExperiment: () => {
                return isDeviceOnly()
                    ? request('GET', '/device/experiments/paywall', null, { token: getDeviceToken() })
                    : request('GET', '/experiments/paywall');
            },
            recordPaywallExposure: ({ placement = 'subscribe' } = {}) => {
                const body = { placement, surface: paywallSurface() };
                return isDeviceOnly()
                    ? request('POST', '/device/experiments/paywall/exposure', body, { token: getDeviceToken() })
                    : request('POST', '/experiments/paywall/exposure', body);
            },
            paywallSurface
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
            getExact: getExactRating,
            set: (body) => dualMutate('POST', '/ratings', body)
        },

        history: {
            list: (params = {}) => cachedGet('hist:' + JSON.stringify(params || {}), HISTORY_TTL_MS,
                () => request('GET', `/history${query(params)}`)),
            // Targeted single-title lookup is the authoritative cross-device
            // resume read. Never cache it in one tab: another device cannot
            // invalidate this process-local cache and would otherwise leave a
            // just-saved position stale for up to HISTORY_TTL_MS.
            getItem: (params = {}) => request('GET', `/history${query(params)}`),
            save: (item) => request('POST', '/history', item, { keepalive: true }).then((r) => { invalidateCache('hist'); return r; }),
            remove: (id) => request('DELETE', `/history/${encodeURIComponent(id)}`).then((r) => { invalidateCache('hist'); return r; }),
            // Keyed removal (sourceId+itemId+itemType) — one round-trip, immune to the stale
            // list-then-find that missed rows written by another device (same fix as favorites).
            removeByKeys: (params = {}) => request('DELETE', `/history${query(params)}`).then((r) => { invalidateCache('hist'); return r; })
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
            expireSession: (id, options = {}) => playbackSessionRequest(
                'POST',
                `/playback/sessions/${encodeURIComponent(id)}/expire`,
                null,
                options
            ),
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
            // Reserved for the future device-only TV relay contract. Keeping an
            // explicit, empty namespace prevents user financial methods from
            // being reused with a paired-screen token.
            partners: Object.freeze({}),
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
                // Same authoritative uncached read for paired TVs: a phone/web
                // save cannot invalidate the TV process's local cache.
                getItem: (params = {}) => request(
                    'GET',
                    `/device/history${query(params)}`,
                    null,
                    { token: getDeviceToken() }
                ),
                save: (item) => request('POST', '/device/history', item, { token: getDeviceToken(), keepalive: true }).then((r) => { invalidateCache('hist'); return r; }),
                remove: (id) => request('DELETE', `/device/history/${encodeURIComponent(id)}`, null, { token: getDeviceToken() }).then((r) => { invalidateCache('hist'); return r; }),
                removeByKeys: (params = {}) => request('DELETE', `/device/history${query(params)}`, null, { token: getDeviceToken() }).then((r) => { invalidateCache('hist'); return r; })
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
