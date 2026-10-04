/**
 * A short, local hint for the version picker, never a playback access decision.
 * No persistence, network calls, provider credentials, URLs or title-wide keys.
 */
(function () {
    'use strict';
    const TTL_MS = 10 * 60 * 1000;
    const MAX_ENTRIES = 64;
    const entries = new Map();
    let context = null;
    let currentUser = null;

    const scalar = value => typeof value === 'string' || typeof value === 'number'
        ? String(value).trim() : '';
    const identifier = value => {
        const text = scalar(value);
        // A file/source identifier is not a URL, title or provider credential.
        return /^[a-zA-Z0-9_-]{1,160}$/.test(text) ? text : '';
    };

    function reset() {
        entries.clear();
        context = null;
        currentUser = null;
    }

    function capture(app = window.app) {
        let owner = '';
        let expires = '';
        let epoch = '';
        try {
            const session = window.NorvaAuth?.getSession?.();
            owner = identifier(session?.user?.id);
            expires = scalar(session?.expires_at);
            epoch = scalar(window.NorvaCloud?.catalogVisibility?.epoch?.());
        } catch (_) { /* Missing authority means no advisory. */ }
        const user = app?.currentUser;
        if (!owner || user?.device || identifier(user?.id) !== owner || app?._signOutInFlight
            || !/^\d+$/.test(expires) || Number(expires) * 1000 <= Date.now()
            || !/^(?:\d+|v2\.[1-9]\d*\.[1-9]\d*)$/.test(epoch)) {
            reset();
            return null;
        }
        if (!context || currentUser !== user || context.owner !== owner
            || context.expires !== expires || context.epoch !== epoch) {
            entries.clear();
            currentUser = user;
            context = Object.freeze({ owner, expires, epoch });
        }
        return context;
    }

    function fileKey(item, app) {
        if (!item || typeof item !== 'object') return null;
        const requestedSource = identifier(item.cloudSourceId ?? item.cloud_source_id
            ?? item.sourceId ?? item.source_id);
        const file = identifier(item.stream_id ?? item.streamId ?? item.itemId
            ?? item.item_id ?? item.external_id ?? item.externalId ?? item.id);
        const type = scalar(item.itemType ?? item.item_type ?? item.type ?? 'movie').toLowerCase();
        if (!requestedSource || !file || !['movie', 'episode'].includes(type)) return null;
        const sources = app?.pages?.movies?.sources;
        const source = Array.isArray(sources) ? sources.find(candidate => [
            candidate?.id, candidate?.cloudId, candidate?.cloud_id
        ].some(id => identifier(id) === requestedSource)) : null;
        if (source && (source.enabled === false || source.deleted_at || source.catalog_visible === false)) return null;
        const sourceId = identifier(source?.cloudId ?? source?.cloud_id ?? requestedSource);
        const revision = identifier(source?.config_revision ?? source?.configRevision
            ?? item.sourceConfigRevision ?? item.source_config_revision ?? item.configRevision ?? item.config_revision);
        const generation = identifier(source?.active_generation_id ?? source?.activeGenerationId
            ?? item.active_generation_id ?? item.activeGenerationId ?? item.generation_id ?? item.generationId);
        // The authenticated catalog visibility epoch above is mandatory even
        // when a legacy item omits its additional source revision/generation.
        return { exact: JSON.stringify([sourceId, type, file, revision, generation]),
            file: JSON.stringify([sourceId, type, file]) };
    }

    function prune() {
        const now = Date.now();
        for (const [key, entry] of entries) {
            if (now < entry.at || now - entry.at >= TTL_MS) entries.delete(key);
        }
    }

    function markRefused(item, app = window.app, expectedContext = undefined) {
        const scope = capture(app);
        if (!scope || (expectedContext !== undefined && expectedContext !== scope)) return false;
        const key = fileKey(item, app);
        if (!key) return false;
        prune();
        entries.delete(key.exact);
        entries.set(key.exact, { at: Date.now(), file: key.file });
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
        return true;
    }

    function has(item, app = window.app) {
        if (!capture(app)) return false;
        const key = fileKey(item, app);
        prune();
        return Boolean(key && entries.has(key.exact));
    }

    function clear(item, app = window.app, expectedContext = undefined) {
        const scope = capture(app);
        if (!scope || (expectedContext !== undefined && expectedContext !== scope)) return false;
        const key = fileKey(item, app);
        if (!key) return false;
        let removed = false;
        for (const [exact, entry] of entries) {
            if (entry.file === key.file) { entries.delete(exact); removed = true; }
        }
        return removed;
    }

    function languageGroup(item, preferences) {
        const analyze = window.MediaUtils?.analyzeLanguageCompatibility;
        if (typeof analyze !== 'function') return null;
        try {
            const result = analyze(item, preferences);
            const fields = lane => [lane?.requested || '', lane?.state || '', lane?.confidence || ''];
            return JSON.stringify([fields(result.audio), fields(result.subtitle)]);
        } catch (_) { return null; }
    }

    function order(orderedItems, preferences = {}, app = window.app) {
        const result = Array.isArray(orderedItems) ? [...orderedItems] : [];
        if (!capture(app)) return result;
        // Input is already preference ordered. Reorder only contiguous equal
        // language-compatibility groups; never promote a different audio/sub
        // preference, drop a copy, or replace the caller's explicit selection.
        for (let start = 0; start < result.length;) {
            const group = languageGroup(result[start], preferences);
            let end = start + 1;
            if (group !== null) {
                while (end < result.length && languageGroup(result[end], preferences) === group) end++;
                const slice = result.slice(start, end);
                result.splice(start, end - start,
                    ...slice.filter(item => !has(item, app)), ...slice.filter(item => has(item, app)));
            }
            start = end;
        }
        return result;
    }

    // Cross-tab sign-out/account changes invalidate even a reused user object.
    window.addEventListener?.('storage', event => {
        if (event.key === null || ['norva-cloud-session', 'norva-cloud-device-token',
            'norva-cloud-device-id'].includes(event.key)) reset();
    });
    window.NorvaPlaybackRefusals = Object.freeze({ capture, markRefused, has, clear, order, reset });
})();
