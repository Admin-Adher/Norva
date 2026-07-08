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
        // Returns { at, v, data } or null.
        //
        // opts.version: the catalog version the CALLER expects (e.g. the max
        // catalog_version across the account's sources). When both the caller and
        // the stored entry carry a version and they differ, the entry is treated as
        // a miss (and evicted) — so a completed re-sync or a background title
        // correction never paints pre-change content on a cold load. Omitting the
        // version keeps the old time-only behaviour, so existing callers are unaffected.
        read(k, opts) {
            try {
                const raw = localStorage.getItem(fullKey(k));
                if (!raw) return null;
                const rec = JSON.parse(raw);
                if (!rec || typeof rec.at !== 'number') return null;
                if (Date.now() - rec.at > MAX_AGE_MS) { localStorage.removeItem(fullKey(k)); return null; }
                const wantV = opts && opts.version != null ? String(opts.version) : null;
                if (wantV !== null && rec.v != null && String(rec.v) !== wantV) {
                    localStorage.removeItem(fullKey(k));
                    return null;
                }
                return rec;
            } catch (_) { return null; }
        },
        // opts.version stamps the catalog version this snapshot was built at, so a
        // later read with a newer expected version evicts it (see read()).
        write(k, data, opts) {
            const rec = { at: Date.now(), data };
            if (opts && opts.version != null) rec.v = String(opts.version);
            const payload = JSON.stringify(rec);
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
