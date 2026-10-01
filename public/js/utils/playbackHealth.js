/**
 * Shared playback health cache.
 * Tracks items that failed or recovered so browsers and Android standalone can
 * hide streams that the player has already proven unusable.
 */
const PlaybackHealth = {
    statuses: new Map(),
    context: null,

    syncContext() {
        const cloud = window.NorvaCloud;
        const next = [cloud?.token || '', cloud?.deviceToken || '', cloud?.catalogVisibility?.epoch?.() || ''];
        if (!this.context || next.some((value, index) => value !== this.context[index])) {
            this.statuses.clear();
            this.context = next;
        }
        return this.context;
    },

    key(sourceId, itemType, itemId) {
        return `${sourceId}:${itemType}:${itemId}`;
    },

    setStatus(entry) {
        if (!entry) return;
        this.syncContext();
        const sourceId = entry.source_id ?? entry.sourceId;
        const itemType = entry.item_type ?? entry.itemType;
        const itemId = entry.item_id ?? entry.itemId;
        if (sourceId == null || !itemType || itemId == null) return;

        const key = this.key(sourceId, itemType, itemId);
        const previous = this.statuses.get(key);
        const updatedAt = entry.updated_at || entry.updatedAt || null;
        const time = value => typeof value === 'number' ? value : Date.parse(value);
        if (previous && time(previous.updatedAt) > time(updatedAt)) return false;
        this.statuses.set(key, {
            status: entry.status || 'unknown',
            unavailable: typeof entry.unavailable === 'boolean' ? entry.unavailable : undefined,
            failures: entry.failures || 0,
            lastError: entry.last_error || entry.lastError || null,
            updatedAt,
            mode: entry.mode || entry.playback_mode || entry.playbackMode || 'unknown',
            modeReason: entry.mode_reason || entry.playback_mode_reason || entry.modeReason || null,
            modeCheckedAt: entry.mode_checked_at || entry.playback_mode_checked_at || entry.modeCheckedAt || null
        });
        return true;
    },

    async load(options = {}) {
        if (!window.API?.playbackStatus?.getAll) return [];
        const context = this.syncContext();
        const before = new Map(this.statuses);
        try {
            const entries = await API.playbackStatus.getAll(options);
            if (this.syncContext() !== context) return [];
            if (!Array.isArray(entries)) return [];
            const sourceFilter = options.sourceId != null ? String(options.sourceId) : null;
            const typeFilter = options.itemType || null;

            for (const key of [...this.statuses.keys()]) {
                const [sourceId, itemType] = key.split(':');
                if ((!sourceFilter || sourceId === sourceFilter) && (!typeFilter || itemType === typeFilter)
                    && this.statuses.get(key) === before.get(key)) {
                    this.statuses.delete(key);
                }
            }

            (entries || []).forEach(entry => {
                const key = this.key(entry.source_id ?? entry.sourceId, entry.item_type ?? entry.itemType, entry.item_id ?? entry.itemId);
                if (!this.statuses.has(key) || this.statuses.get(key) === before.get(key)) this.setStatus(entry);
            });
            return entries || [];
        } catch (err) {
            console.warn('[PlaybackHealth] Failed to load statuses:', err.message);
            return [];
        }
    },

    isBroken(sourceId, itemType, itemId) {
        this.syncContext();
        return this.statuses.get(this.key(sourceId, itemType, itemId))?.status === 'broken';
    },

    isUnavailable(sourceId, itemType, itemId) {
        this.syncContext();
        const entry = this.statuses.get(this.key(sourceId, itemType, itemId));
        return this.isUnavailableEntry(entry);
    },

    isUnavailableEntry(entry) {
        if (!entry || entry.status !== 'broken') return false;
        if (typeof entry.unavailable === 'boolean') return entry.unavailable;
        return !this.isTransientFailure(entry.lastError || entry.modeReason || '');
    },

    isTransientFailure(reason = '') {
        const text = String(reason || '').toLowerCase();
        // Hide-unavailable should remove titles proven dead, not wipe whole VOD
        // libraries after a temporary provider/account outage or single-slot limit.
        return /\b(401|403|429|458|500|502|503|504|timeout|timed out|econn|enotfound|dns|network|unreachable|refused|forbidden|unauthori[sz]ed|rate limit|too many requests|service unavailable|temporarily unavailable|provider busy|limited to one connection|connection|gateway|upstream_(?:unauthori[sz]ed|forbidden|rate_limit|network|timeout))\b/i.test(text);
    },

    getMode(sourceId, itemType, itemId) {
        this.syncContext();
        return this.statuses.get(this.key(sourceId, itemType, itemId))?.mode || 'unknown';
    },

    isDirectHls(sourceId, itemType, itemId) {
        return this.getMode(sourceId, itemType, itemId) === 'direct_hls';
    },

    async report({ sourceId, itemType, itemId, status, reason = '', sessionId = null }) {
        if (sourceId == null || !itemType || itemId == null || !status) return null;
        if (status === 'broken' && /empty src/i.test(String(reason))) return null;
        const context = this.syncContext();

        try {
            const result = await API.playbackStatus.report({ sourceId, itemType, itemId, status, reason, sessionId });
            if (this.syncContext() !== context) return null;
            if (result?.ignored || result?.persisted === false) return result;
            if (!result?.entry) throw new Error('Playback health was not acknowledged');
            const entry = result.entry;
            if (this.setStatus(entry)) window.dispatchEvent(new CustomEvent('playbackStatusChanged', { detail: entry }));
            return result;
        } catch (err) {
            console.warn('[PlaybackHealth] Failed to report status:', err.message);
            // A failed write is not evidence that this title is unavailable.
            return null;
        }
    }
};

window.PlaybackHealth = PlaybackHealth;
