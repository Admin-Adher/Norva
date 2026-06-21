/**
 * Persistent, stale-while-revalidate cache for the FIRST screen of each catalog
 * (Movies / Series / Live channels).
 *
 * Stored in localStorage so the first paint is instant even on a cold app
 * relaunch or page refresh — callers paint the cached page immediately, then
 * always refetch in the background and replace it. Entries are namespaced by
 * the signed-in user so one account never sees another's cached catalog, and
 * capped by age so nothing very stale is shown without a refresh.
 */
(function () {
    'use strict';
    const PREFIX = 'norva-cc:';
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

    function userScope() {
        try {
            const s = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
            if (s && s.user && s.user.id) return String(s.user.id).slice(0, 12);
            const dev = localStorage.getItem('norva-cloud-device-id');
            if (dev) return 'dev-' + String(dev).slice(0, 10);
        } catch (_) { /* fall through */ }
        return 'anon';
    }

    function fullKey(k) { return PREFIX + userScope() + ':' + k; }

    const NorvaCatalogCache = {
        // Returns { at, data } or null.
        read(k) {
            try {
                const raw = localStorage.getItem(fullKey(k));
                if (!raw) return null;
                const rec = JSON.parse(raw);
                if (!rec || typeof rec.at !== 'number') return null;
                if (Date.now() - rec.at > MAX_AGE_MS) { localStorage.removeItem(fullKey(k)); return null; }
                return rec;
            } catch (_) { return null; }
        },
        write(k, data) {
            const payload = JSON.stringify({ at: Date.now(), data });
            try {
                localStorage.setItem(fullKey(k), payload);
            } catch (_) {
                // Quota hit — drop all catalog cache and retry once.
                try { NorvaCatalogCache.clearAll(); localStorage.setItem(fullKey(k), payload); } catch (__) { /* give up */ }
            }
        },
        remove(k) { try { localStorage.removeItem(fullKey(k)); } catch (_) { /* best-effort */ } },
        clearAll() {
            try {
                Object.keys(localStorage)
                    .filter((x) => x.indexOf(PREFIX) === 0)
                    .forEach((x) => localStorage.removeItem(x));
            } catch (_) { /* best-effort */ }
        }
    };

    window.NorvaCatalogCache = NorvaCatalogCache;
})();
