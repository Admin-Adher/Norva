/**
 * Shared playback health cache.
 * Tracks items that failed or recovered so browsers and Android standalone can
 * hide streams that the player has already proven unusable.
 */
const PlaybackHealth = {
    statuses: new Map(),

    key(sourceId, itemType, itemId) {
        return `${sourceId}:${itemType}:${itemId}`;
    },

    setStatus(entry) {
        if (!entry) return;
        const sourceId = entry.source_id ?? entry.sourceId;
        const itemType = entry.item_type ?? entry.itemType;
        const itemId = entry.item_id ?? entry.itemId;
        if (sourceId == null || !itemType || itemId == null) return;

        this.statuses.set(this.key(sourceId, itemType, itemId), {
            status: entry.status || 'unknown',
            failures: entry.failures || 0,
            lastError: entry.last_error || entry.lastError || null,
            updatedAt: entry.updated_at || entry.updatedAt || null,
            mode: entry.mode || entry.playback_mode || entry.playbackMode || 'unknown',
            modeReason: entry.mode_reason || entry.playback_mode_reason || entry.modeReason || null,
            modeCheckedAt: entry.mode_checked_at || entry.playback_mode_checked_at || entry.modeCheckedAt || null
        });
    },

    async load(options = {}) {
        if (!window.API?.playbackStatus?.getAll) return [];
        try {
            const entries = await API.playbackStatus.getAll(options);
            if (!Array.isArray(entries)) return [];
            const sourceFilter = options.sourceId != null ? String(options.sourceId) : null;
            const typeFilter = options.itemType || null;

            for (const key of [...this.statuses.keys()]) {
                const [sourceId, itemType] = key.split(':');
                if ((!sourceFilter || sourceId === sourceFilter) && (!typeFilter || itemType === typeFilter)) {
                    this.statuses.delete(key);
                }
            }

            (entries || []).forEach(entry => this.setStatus(entry));
            return entries || [];
        } catch (err) {
            console.warn('[PlaybackHealth] Failed to load statuses:', err.message);
            return [];
        }
    },

    isBroken(sourceId, itemType, itemId) {
        return this.statuses.get(this.key(sourceId, itemType, itemId))?.status === 'broken';
    },

    getMode(sourceId, itemType, itemId) {
        return this.statuses.get(this.key(sourceId, itemType, itemId))?.mode || 'unknown';
    },

    isDirectHls(sourceId, itemType, itemId) {
        return this.getMode(sourceId, itemType, itemId) === 'direct_hls';
    },

    async report({ sourceId, itemType, itemId, status, reason = '' }) {
        if (sourceId == null || !itemType || itemId == null || !status) return null;
        if (status === 'broken' && /empty src/i.test(String(reason))) return null;

        const fallbackEntry = {
            source_id: sourceId,
            item_type: itemType,
            item_id: itemId,
            status,
            last_error: status === 'broken' ? reason : null,
            updated_at: Date.now()
        };

        try {
            const result = await API.playbackStatus.report({ sourceId, itemType, itemId, status, reason });
            const entry = result?.entry || fallbackEntry;
            this.setStatus(entry);
            window.dispatchEvent(new CustomEvent('playbackStatusChanged', { detail: entry }));
            return result;
        } catch (err) {
            console.warn('[PlaybackHealth] Failed to report status:', err.message);
            this.setStatus(fallbackEntry);
            window.dispatchEvent(new CustomEvent('playbackStatusChanged', { detail: fallbackEntry }));
            return null;
        }
    }
};

window.PlaybackHealth = PlaybackHealth;
