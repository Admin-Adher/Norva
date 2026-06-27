/**
 * Channel List Component
 * Handles the sidebar channel list
 */

// IPTV tag words ignored when ranking search matches ("FR| TF1 4K" matches "tf1")
const SEARCH_TAG_WORDS = new Set([
    'fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'ar', 'tr', 'uk', 'us', 'ca', 'be', 'ch', 'af',
    '4k', 'uhd', 'fhd', 'hd', 'sd', 'hevc', 'h265', 'h264', '50fps', '60fps',
    'vip', 'raw', 'backup', 'low', 'hq', 'fullhd'
]);

const CHANNEL_FAMILY_NOISE_WORDS = new Set([
    ...SEARCH_TAG_WORDS,
    'tv', 'superhd', 'ultrahd', 'multicam', 'multi', 'stereo', 'audio'
]);

const CONSOLIDATED_LIVE_GROUPS = {
    FAVORITES: 'Favorites',
    PRIMARY: 'Main channels',
    REGIONAL: 'Regional channels',
    MULTIPLEX: 'Multiplex & events'
};
const LIVE_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LAST_LIVE_CHANNEL_KEY = 'norva_last_live_channel_v1';

class ChannelList {
    constructor() {
        this.container = document.getElementById('channel-list');
        this.searchInput = document.getElementById('channel-search');
        this.sourceSelect = document.getElementById('source-select');
        this.showHiddenCheckbox = document.getElementById('show-hidden');
        this.toggleGroupsBtn = document.getElementById('toggle-groups');
        this.hideBrokenBtn = document.getElementById('live-hide-broken-btn');
        this.scanPlaybackBtn = document.getElementById('live-scan-playback-btn');
        this.scanStatusEl = document.getElementById('live-scan-status');
        this.contextMenu = document.getElementById('context-menu');

        this.channels = [];
        this.groups = [];
        this.hiddenItems = new Set(); // Set<"type:sourceId:itemId">
        this.hideBroken = false;
        this.collapsedGroups = new Set(); // Track collapsed groups
        this._userExpandedGroups = new Set(); // Track groups user has explicitly expanded
        this.favorites = []; // Array of favorite objects
        this.visibleFavorites = new Set(); // Set<"sourceId:channelId">
        this.currentChannel = null;
        this.sources = [];
        this.isLoading = false;
        this.renderedChannels = [];
        this._lastPlaybackRefreshAt = new Map();
        this._playbackScanRunId = 0;
        this.remoteSearchCache = new Map();
        this.remoteSearchSeq = 0;
        this.remoteSearchInFlight = null;
        this.liveHydrationRunId = 0;
        this.liveCacheDbPromise = null;
        this.pendingLiveResume = false;
        this.liveResumeInFlight = null;
        this._selectRequestSeq = 0;
        this._streamResolveQueue = Promise.resolve();

        this.loadCollapsedState();
        this.init();
    }

    getChannelFamilyKey(channelOrName) {
        const rawName = typeof channelOrName === 'string'
            ? channelOrName
            : (channelOrName?.name || '');
        if (!rawName) return '';

        const pipeParts = String(rawName).split('|').map(part => part.trim()).filter(Boolean);
        const candidateName = pipeParts.length > 1 ? pipeParts[pipeParts.length - 1] : String(rawName);
        const normalized = candidateName
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\([^)]*\)/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();

        const tokens = normalized
            .split(/\s+/)
            .filter(Boolean)
            .filter(token => !CHANNEL_FAMILY_NOISE_WORDS.has(token));

        return tokens.join(' ');
    }

    getChannelFamilyMembers(channel, options = {}) {
        if (!channel) return [];
        const {
            includeHidden = false,
            includeCurrent = true,
            sameSourceOnly = true
        } = options;

        const familyKey = this.getChannelFamilyKey(channel);
        if (!familyKey) return includeCurrent ? [channel] : [];

        return this.channels.filter(candidate => {
            if (!candidate) return false;
            if (!includeCurrent && candidate.id === channel.id && candidate.sourceId === channel.sourceId) return false;
            if (sameSourceOnly && String(candidate.sourceId) !== String(channel.sourceId)) return false;
            if (this.getChannelFamilyKey(candidate) !== familyKey) return false;

            const rawId = candidate.streamId || candidate.id;
            if (!includeHidden && this.isHidden('channel', candidate.sourceId, rawId)) return false;
            return true;
        });
    }

    getChannelFamilyLabel(channel) {
        const familyKey = this.getChannelFamilyKey(channel);
        return familyKey
            .split(' ')
            .filter(Boolean)
            .map(token => /^\d+$/.test(token) ? token : token.charAt(0).toUpperCase() + token.slice(1))
            .join(' ');
    }

    /**
     * Get proxied image URL to avoid mixed content errors on HTTPS
     * Only proxies HTTP URLs when on HTTPS page
     */
    getProxiedImageUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '/img/placeholder.png';
        if (raw.startsWith('/') || raw.startsWith('data:')) return raw;
        if (window.API?.isCloudMode?.() && window.NorvaCloud?.imageUrl && /^https?:\/\//i.test(raw)) {
            return window.NorvaCloud.imageUrl(raw);
        }
        // Only proxy if we're on HTTPS and the image is HTTP
        if (window.location.protocol === 'https:' && raw.startsWith('http://')) {
            return `/api/proxy/image?url=${encodeURIComponent(raw)}`;
        }
        return raw;
    }

    getChannelLogoFallback(channelOrName) {
        const label = typeof channelOrName === 'string'
            ? channelOrName
            : (channelOrName?.name || channelOrName?.title || 'TV');
        const clean = String(label || 'TV').replace(/\s+/g, ' ').trim();
        const initials = clean
            .split(/[^A-Za-z0-9]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(part => part.slice(0, 2).toUpperCase())
            .join('') || 'TV';
        const hue = Array.from(clean).reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
        const title = clean.length > 18 ? `${clean.slice(0, 17)}...` : clean;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue}, 82%, 58%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 70) % 360}, 78%, 46%)"/>
    </linearGradient>
  </defs>
  <rect width="96" height="96" rx="20" fill="#101522"/>
  <rect x="4" y="4" width="88" height="88" rx="18" fill="url(#g)" opacity=".22"/>
  <text x="48" y="46" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="24" font-weight="800" fill="#f8fbff">${this.escapeSvgText(initials)}</text>
  <text x="48" y="67" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="10" font-weight="700" fill="#cfd8ff">${this.escapeSvgText(title)}</text>
</svg>`;
        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    getChannelLogoErrorSrc(channelOrName) {
        return this.escapeHtml(this.getChannelLogoFallback(channelOrName));
    }

    getChannelLogoSrc(channel) {
        const raw = channel?.tvgLogo || channel?.stream_icon || channel?.poster_url || channel?.logo;
        // Working provider logo → use it as-is.
        if (raw && !this.isKnownBrokenLogoUrl(raw)) return this.getProxiedImageUrl(raw);
        // Dead host (aptvpix) or no logo → curated real logo for the country's
        // national channels, before falling back to a generated placeholder.
        const canon = this.getCanonicalLogo(channel);
        if (canon) return canon;
        return this.getChannelLogoFallback(channel);
    }

    /** Real curated logo for a known national channel (TF1, France 2, M6...), else null. */
    getCanonicalLogo(channel) {
        try {
            if (channel?.logo && /^https?:\/\//i.test(channel.logo) && !this.isKnownBrokenLogoUrl(channel.logo)) {
                return channel.logo;
            }
            if (!window.ChannelGrouping?.logoForName) return null;
            const country = window.app?.player?.getCountry?.() || 'FR';
            const name = channel?.canonicalName || channel?.name || channel?.title || '';
            return window.ChannelGrouping.logoForName(name, country) || null;
        } catch (_) { return null; }
    }

    isKnownBrokenLogoUrl(url) {
        try {
            const host = new URL(String(url || '')).hostname.toLowerCase();
            return host === 'aptvpix.net' || host.endsWith('.aptvpix.net');
        } catch (_) {
            return false;
        }
    }

    escapeSvgText(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Load collapsed state from localStorage
     */
    loadCollapsedState() {
        try {
            const saved = localStorage.getItem('norva_tv_collapsed_groups');
            const version = localStorage.getItem('norva_tv_collapsed_groups_version');
            if (saved && version === '2') {
                this.collapsedGroups = new Set(JSON.parse(saved));
                this._hasCollapsedState = true;
            } else {
                this.collapsedGroups = new Set();
                this._hasCollapsedState = false; // First load - will collapse all by default
            }
        } catch (err) {
            console.error('Error loading collapsed state:', err);
            this._hasCollapsedState = false;
        }
    }

    /**
     * Save collapsed state to localStorage
     */
    saveCollapsedState() {
        try {
            localStorage.setItem('norva_tv_collapsed_groups_version', '2');
            localStorage.setItem('norva_tv_collapsed_groups', JSON.stringify([...this.collapsedGroups]));
        } catch (err) {
            console.error('Error saving collapsed state:', err);
        }
    }

    /**
     * Toggle group collapsed state
     */
    toggleGroup(groupName) {
        if (this.collapsedGroups.has(groupName)) {
            this.collapsedGroups.delete(groupName);
            // Track that user explicitly expanded this group
            this._userExpandedGroups.add(groupName);
        } else {
            this.collapsedGroups.add(groupName);
            // User collapsed it, remove from expanded tracking
            this._userExpandedGroups.delete(groupName);
        }
        this.saveCollapsedState();
    }

    /**
     * Expand all groups
     */
    expandAll() {
        this.collapsedGroups.clear();
        this.saveCollapsedState();

        // Expand all and render channels for empty containers
        this.container.querySelectorAll('.group-header.collapsed').forEach(h => {
            h.classList.remove('collapsed');
            const groupName = h.dataset.group;
            const groupEl = h.closest('.channel-group');
            const channelsContainer = groupEl?.querySelector('.group-channels');
            if (channelsContainer && channelsContainer.children.length === 0) {
                this.renderGroupChannels(groupName, channelsContainer);
            }
        });

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.collapseAll;
            this.toggleGroupsBtn.title = 'Collapse All';
        }
    }

    /**
     * Collapse all groups
     */
    collapseAll() {
        this.container.querySelectorAll('.group-header').forEach(h => {
            const groupName = h.dataset.group;
            this.collapsedGroups.add(groupName);
            h.classList.add('collapsed');
        });
        this.saveCollapsedState();

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.expandAll;
            this.toggleGroupsBtn.title = 'Expand All';
        }
    }

    /**
     * Toggle between expand/collapse all
     */
    toggleAllGroups() {
        const allHeaders = this.container.querySelectorAll('.group-header');
        const allCollapsed = [...allHeaders].every(h => h.classList.contains('collapsed'));

        if (allCollapsed) {
            this.expandAll();
        } else {
            this.collapseAll();
        }
    }

    init() {
        // Search: flat ranked results mode (never mutates group collapse state)
        let searchTimeout;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.onSearchInput(), 150);
        });
        this.searchInput.addEventListener('keydown', (e) => this.handleSearchKeydown(e));
        this.searchInput.addEventListener('focus', () => {
            if (!this.searchInput.value.trim() && !document.documentElement.classList.contains('tv-mode')) {
                this.showZeroState();
            }
        });
        this.searchInput.addEventListener('blur', () => {
            // Delay so clicks on zero-state results land before restoring
            setTimeout(() => {
                if (this.zeroState && !this.searchInput.value.trim() &&
                    document.activeElement !== this.searchInput) {
                    this.exitSearchMode();
                }
            }, 200);
        });

        // "/" focuses the search from anywhere on the Live page
        document.addEventListener('keydown', (e) => {
            if (e.key !== '/') return;
            if (!document.getElementById('page-live')?.classList.contains('active')) return;
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
            e.preventDefault();

            // Sidebar may be collapsed (desktop) or a closed drawer (mobile):
            // open it first, otherwise the input can't take focus
            if (!this.searchInput.offsetParent) {
                document.getElementById('sidebar-expand-btn')?.click();
                document.getElementById('channel-toggle-btn')?.click();
            }
            setTimeout(() => {
                this.searchInput.focus();
                this.searchInput.select();
            }, 50);
        });

        // Source filter handler
        this.sourceSelect.addEventListener('change', () => this.loadChannels());

        // Show hidden toggle
        if (this.showHiddenCheckbox) {
            this.showHiddenCheckbox.addEventListener('change', () => this.render());
        }

        this.hideBrokenBtn?.addEventListener('click', () => {
            this.hideBroken = !this.hideBroken;
            this.hideBrokenBtn.classList.toggle('active', this.hideBroken);
            this.render();
            window.app?.liveGuideFusion?.render();
        });

        this.scanPlaybackBtn?.addEventListener('click', () => this.scanLivePlaybackModes());

        window.addEventListener('playbackStatusChanged', (event) => {
            const detail = event.detail || {};
            const itemType = detail.item_type || detail.itemType;
            if (itemType && itemType !== 'channel' && itemType !== 'live') return;
            const rawId = detail.item_id ?? detail.itemId;
            const srcId = detail.source_id ?? detail.sourceId;
            let changed = false;
            this.channels.forEach(channel => {
                if (String(channel.sourceId) === String(srcId) &&
                    String(channel.streamId || channel.id) === String(rawId)) {
                    channel.playbackStatus = detail.status || channel.playbackStatus || 'unknown';
                    channel.playbackMode = detail.mode || channel.playbackMode || 'unknown';
                    channel.playbackCheckedAt = detail.updated_at || detail.updatedAt || channel.playbackCheckedAt || null;
                    channel.playbackModeCheckedAt = detail.mode_checked_at || detail.modeCheckedAt || channel.playbackModeCheckedAt || null;
                    changed = true;
                }
            });
            // Surgically refresh just the affected channel's playback indicator.
            // A full this.render() here rebuilt the entire list on every play,
            // which caused the visible lag/flicker when selecting a channel.
            if (changed) this.refreshChannelPlaybackClasses(srcId, rawId);
            // LiveGuideFusion listens to this event too and updates its visible
            // rows without rebuilding the full guide.
        });

        // Context menu handlers
        document.addEventListener('click', (e) => {
            // Don't close if clicking inside context menu
            if (!this.contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        });

        this.contextMenu.querySelectorAll('.context-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent document click from firing
                this.handleContextAction(e);
            });
        });

        // Intersection Observer for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                this.renderNextBatch();
            }
        }, { rootMargin: '100px' });

        // Start EPG refresh timer (updates visible program info every 60 seconds)
        this.startEpgRefreshTimer();
    }

    /**
     * Start timer to refresh EPG info in visible channel items
     * Updates every 60 seconds to keep "Now Playing" program info current
     */
    startEpgRefreshTimer() {
        // Clear any existing timer
        if (this._epgRefreshTimer) {
            clearInterval(this._epgRefreshTimer);
        }

        // Refresh every 60 seconds
        this._epgRefreshTimer = setInterval(() => {
            this.updateVisibleEpgInfo();
        }, 60000);
    }

    /**
     * Update EPG info for visible channel items without full re-render
     * Only updates the program text, not the entire channel item
     */
    updateVisibleEpgInfo() {
        if (!window.app || !window.app.epgGuide) return;

        // Clear the cache so we get fresh data
        this.clearProgramInfoCache();

        // Find all visible channel items and update their program info
        const channelItems = this.container.querySelectorAll('.channel-item');
        channelItems.forEach(item => {
            const channelId = item.dataset.channelId;
            const sourceId = item.dataset.sourceId;
            const rendered = item.dataset.renderId
                ? this.renderedChannels.find(channel => channel._renderId === item.dataset.renderId)
                : null;

            // Find the channel data
            const channel = rendered || this.channels.find(c =>
                String(c.id) === String(channelId) &&
                String(c.sourceId) === String(sourceId)
            );

            if (channel) {
                const programInfo = this.getDisplayProgramInfo(channel);
                const programElement = item.querySelector('.channel-program');
                if (programElement) {
                    programElement.textContent = programInfo || '';
                }
            }
        });
    }

    // ... (loadSources, loadChannels, loadAllChannels, loadXtreamChannels, loadM3uChannels, loadHiddenItems, isHidden, loadFavorites, isFavorite, toggleFavorite methods remain same)

    /**
     * Get current program info string - cached for performance
     */
    getProgramInfo(channel) {
        try {
            if (!window.app || !window.app.epgGuide) return null;

            // Cache key: channel_id + current_minute (invalidate every minute)
            const currentMinute = Math.floor(Date.now() / 60000);
            const cacheKey = `${channel.tvgId || channel.name}:${currentMinute}`;

            if (this._programInfoCache && this._programInfoCache.has(cacheKey)) {
                return this._programInfoCache.get(cacheKey);
            }

            // Clear old cache entries if minute changed
            if (!this._lastCacheMinute || this._lastCacheMinute !== currentMinute) {
                this._programInfoCache = new Map();
                this._lastCacheMinute = currentMinute;
            }

            const program = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const result = program ? program.title : null;

            this._programInfoCache.set(cacheKey, result);
            return result;
        } catch (e) {
            console.warn("Error in getProgramInfo", e);
            return null;
        }
    }

    /**
     * Clear program info cache
     * Useful when EPG data has been updated
     */
    clearProgramInfoCache() {
        if (this._programInfoCache) {
            this._programInfoCache.clear();
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    getBrowseCountry() {
        const country = window.NorvaCloud?.regions?.active?.()
            || window.app?.player?.getCountry?.()
            || localStorage.getItem('norva-preferred-content-region')
            || localStorage.getItem('norva-country')
            || 'INTERNATIONAL';
        return String(country || 'INTERNATIONAL').toUpperCase();
    }

    getChannelItemId(channel) {
        return channel?.streamId || channel?.id;
    }

    isChannelVisibleInBrowse(channel, showHidden, { favoritesGroup = false } = {}) {
        if (!channel) return false;
        const rawChannelId = this.getChannelItemId(channel);
        const hidden = this.isHidden('channel', channel.sourceId, rawChannelId);
        if (!favoritesGroup && hidden && !showHidden) return false;
        if (this.hideBroken && this.shouldHideByPlayback(channel)) return false;
        return true;
    }

    shouldGroupStartCollapsed(groupName, isFavoritesGroup = false) {
        if (isFavoritesGroup || groupName === CONSOLIDATED_LIVE_GROUPS.PRIMARY) return false;
        if (groupName === CONSOLIDATED_LIVE_GROUPS.REGIONAL) return false;
        if (groupName === CONSOLIDATED_LIVE_GROUPS.MULTIPLEX) return true;
        return true;
    }

    cleanLogicalChannelName(name) {
        return String(name || '')
            .replace(/^[^|]*\|\s*/, '')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/\([^)]*\)/g, ' ')
            .replace(/\b(4k|uhd|hdr|fhd|full\s*hd|super\s*hd|superhd|hd|sd|h265|hevc|h264|avc|50fps|60fps)\b/gi, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    dedupeVariantList(variants = []) {
        const seen = new Set();
        const out = [];
        for (const variant of variants.slice().sort((a, b) => (a.rank - b.rank) || String(a.raw || '').localeCompare(String(b.raw || '')))) {
            const key = `${variant.label}:${variant.sourceId}:${variant.streamId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(variant);
        }
        return out;
    }

    makeLogicalChannel(entry, groupTitle, kind = 'generic') {
        const variants = this.dedupeVariantList(entry.variants || []);
        const defaultVariant = entry.defaultVariant || window.ChannelGrouping?.pickDefault?.(variants) || variants[0] || null;
        const base = defaultVariant?.channel || entry.channel || variants[0]?.channel;
        if (!base) return null;

        const name = entry.name || this.cleanLogicalChannelName(base.name) || base.name;
        const display = {
            ...base,
            name,
            num: entry.lcn ?? base.num ?? null,
            groupTitle,
            qualityGroup: {
                name,
                variants,
                defaultVariant
            },
            currentVariant: defaultVariant,
            _logicalChannel: variants.length > 1 || kind !== 'generic',
            _logicalKind: kind,
            _variantCount: variants.length,
            _sourceGroupTitle: base.groupTitle || groupTitle,
            _displayGroupTitle: groupTitle
        };

        const favoriteVariant = variants.find(variant =>
            variant.channel && this.isFavorite(variant.sourceId, variant.channel.id)
        );
        display._favoriteTargetId = favoriteVariant?.channel?.id || base.id;

        return display;
    }

    mergeExtraEntries(entries = [], groupTitle, kind) {
        const byKey = new Map();

        entries.forEach((entry, index) => {
            const base = entry.channel || entry.variants?.[0]?.channel;
            if (!base) return;
            const familyKey = this.getChannelFamilyKey(entry.name || base.name) || `${base.sourceId}:${base.id}`;
            const key = `${base.sourceId}:${entry.parentKey || ''}:${familyKey}`;
            if (!byKey.has(key)) {
                byKey.set(key, {
                    name: this.cleanLogicalChannelName(entry.name || base.name) || entry.name || base.name,
                    parentKey: entry.parentKey,
                    parentName: entry.parentName,
                    variants: [],
                    firstIndex: index
                });
            }
            byKey.get(key).variants.push(...(entry.variants || []));
        });

        return [...byKey.values()]
            .map(entry => {
                entry.variants = this.dedupeVariantList(entry.variants);
                entry.defaultVariant = window.ChannelGrouping?.pickDefault?.(entry.variants) || entry.variants[0] || null;
                return this.makeLogicalChannel(entry, groupTitle, kind);
            })
            .filter(Boolean)
            .sort((a, b) => {
                const parent = String(a._sourceGroupTitle || '').localeCompare(String(b._sourceGroupTitle || ''));
                return parent || String(a.name || '').localeCompare(String(b.name || ''));
            });
    }

    consolidateRawChannels(channels = [], groupTitle) {
        const byKey = new Map();
        const country = this.getBrowseCountry();

        channels.forEach((channel, index) => {
            const familyKey = this.getChannelFamilyKey(channel) || `${channel.sourceId}:${channel.id}`;
            const key = `${channel.sourceId}:${familyKey}`;
            if (!byKey.has(key)) byKey.set(key, { channel, members: [], firstIndex: index });
            byKey.get(key).members.push(channel);
        });

        return [...byKey.values()]
            .sort((a, b) => a.firstIndex - b.firstIndex)
            .map(bucket => {
                if (bucket.members.length <= 1 || !window.ChannelGrouping) {
                    return { ...bucket.channel, _variantCount: 1, _displayGroupTitle: groupTitle, _favoriteTargetId: bucket.channel.id };
                }

                const group = window.ChannelGrouping.variantsForChannel(bucket.channel, bucket.members, country);
                if (!group || !group.variants?.length) {
                    return { ...bucket.channel, _variantCount: bucket.members.length, _displayGroupTitle: groupTitle, _favoriteTargetId: bucket.channel.id };
                }
                return this.makeLogicalChannel({
                    name: this.cleanLogicalChannelName(group.name) || group.name,
                    variants: group.variants,
                    defaultVariant: group.defaultVariant
                }, groupTitle, 'generic');
            })
            .filter(Boolean);
    }

    buildBrowseModel(showHidden) {
        const groupedChannels = {};
        const groupMeta = {};
        const country = this.getBrowseCountry();

        const addGroup = (name, channels, meta = {}) => {
            const visible = (channels || []).filter(Boolean);
            if (!visible.length) return;
            groupedChannels[name] = visible;
            groupMeta[name] = {
                defaultCollapsed: this.shouldGroupStartCollapsed(name, name === CONSOLIDATED_LIVE_GROUPS.FAVORITES),
                ...meta
            };
        };

        const visibleChannels = this.channels.filter(channel =>
            this.isChannelVisibleInBrowse(channel, showHidden)
        );
        this.filteredChannels = visibleChannels;

        const favoriteChannels = this.channels
            .filter(channel => this.isFavorite(channel.sourceId, channel.id))
            .filter(channel => this.isChannelVisibleInBrowse(channel, showHidden, { favoritesGroup: true }));
        addGroup(
            CONSOLIDATED_LIVE_GROUPS.FAVORITES,
            this.consolidateRawChannels(favoriteChannels, CONSOLIDATED_LIVE_GROUPS.FAVORITES),
            { defaultCollapsed: false, priority: 0 }
        );

        if (window.ChannelGrouping?.group) {
            const model = window.ChannelGrouping.group(visibleChannels, country);
            const primary = (model.primary || [])
                .map(entry => this.makeLogicalChannel(entry, CONSOLIDATED_LIVE_GROUPS.PRIMARY, 'primary'))
                .filter(Boolean);
            addGroup(CONSOLIDATED_LIVE_GROUPS.PRIMARY, primary, { defaultCollapsed: false, priority: 1 });

            const otherByGroup = new Map();
            (model.other || []).forEach(channel => {
                const group = channel.groupTitle || 'Uncategorized';
                if (!otherByGroup.has(group)) otherByGroup.set(group, []);
                otherByGroup.get(group).push(channel);
            });

            [...otherByGroup.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([group, channels]) => {
                    addGroup(group, this.consolidateRawChannels(channels, group), { defaultCollapsed: true, priority: 10 });
                });

            addGroup(
                CONSOLIDATED_LIVE_GROUPS.REGIONAL,
                this.mergeExtraEntries(model.regional || [], CONSOLIDATED_LIVE_GROUPS.REGIONAL, 'regional'),
                { defaultCollapsed: false, priority: 90 }
            );
            addGroup(
                CONSOLIDATED_LIVE_GROUPS.MULTIPLEX,
                this.mergeExtraEntries(model.multiplex || [], CONSOLIDATED_LIVE_GROUPS.MULTIPLEX, 'multiplex'),
                { defaultCollapsed: true, priority: 100 }
            );
        } else {
            const rawByGroup = new Map();
            visibleChannels.forEach(channel => {
                const group = channel.groupTitle || 'Uncategorized';
                if (!rawByGroup.has(group)) rawByGroup.set(group, []);
                rawByGroup.get(group).push(channel);
            });
            [...rawByGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([group, channels]) => {
                addGroup(group, this.consolidateRawChannels(channels, group), { defaultCollapsed: true, priority: 10 });
            });
        }

        const sortedGroups = Object.keys(groupedChannels)
            .filter(groupName => groupedChannels[groupName].some(channel =>
                this.isChannelVisibleInBrowse(channel, showHidden, { favoritesGroup: groupName === CONSOLIDATED_LIVE_GROUPS.FAVORITES })
            ))
            .sort((a, b) => {
                const pa = groupMeta[a]?.priority ?? 50;
                const pb = groupMeta[b]?.priority ?? 50;
                if (pa !== pb) return pa - pb;
                return a.localeCompare(b);
            });

        return { groupedChannels, groupMeta, sortedGroups };
    }

    findRenderedChannel(channel, groupName) {
        return this.renderedChannels.find(rc =>
            rc.id === channel.id &&
            String(rc.sourceId) === String(channel.sourceId) &&
            rc._renderGroup === groupName
        );
    }

    isDisplayChannelFavorite(channel) {
        const favoriteId = channel?._favoriteTargetId || channel?.id;
        return this.isFavorite(channel?.sourceId, favoriteId);
    }

    isDisplayChannelActive(channel) {
        if (!channel || !this.currentChannel) return false;
        if (channel.id === this.currentChannel.id && String(channel.sourceId) === String(this.currentChannel.sourceId)) return true;
        return Boolean(channel.qualityGroup?.variants?.some(variant =>
            variant.channel?.id === this.currentChannel.id &&
            String(variant.sourceId) === String(this.currentChannel.sourceId)
        ));
    }

    getDisplayProgramInfo(channel) {
        const program = this.getProgramInfo(channel);
        const bits = [];
        if (channel?._variantCount > 1) bits.push(`${channel._variantCount} variants`);
        if (channel?.currentVariant?.label) bits.push(channel.currentVariant.label);
        if (program) bits.push(program);
        return bits.join(' - ');
    }

    buildChannelItemHtml(channel, groupName, { hidden = false, navActive = false } = {}) {
        const renderedChannel = this.findRenderedChannel(channel, groupName);
        const renderId = renderedChannel?._renderId || '';
        const renderGroup = renderedChannel?._renderGroup || groupName;
        const isActive = this.isDisplayChannelActive(channel);
        const isFavorite = this.isDisplayChannelFavorite(channel);
        const playbackClasses = this.getPlaybackClassNames(channel);
        const logicalClass = channel._logicalChannel ? `logical-channel logical-${channel._logicalKind || 'generic'}` : '';
        const lcn = channel.num != null ? String(channel.num).trim() : '';

        return `
          <div class="channel-item ${logicalClass} ${isActive ? 'active' : ''} ${navActive ? 'nav-active' : ''} ${hidden ? 'hidden' : ''} ${playbackClasses}"
               tabindex="-1"
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}"
               data-render-id="${renderId}"
               data-render-group="${renderGroup}"
               data-favorite-id="${channel._favoriteTargetId || channel.id}">
            ${lcn ? `<span class="channel-lcn">${this.escapeHtml(lcn)}</span>` : ''}
            <img class="channel-logo" src="${this.getChannelLogoSrc(channel)}"
                 alt="" onerror="this.onerror=null;this.src='${this.getChannelLogoErrorSrc(channel)}'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getDisplayProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
    }

    /**
     * Render channel list
     */
    render() {
        // Browse-mode renderer. Search uses renderSearchResults() (flat ranked
        // list) and never goes through here, so the group collapse state and
        // its localStorage persistence stay intact during a search.
        this.searchMode = false;
        this.zeroState = false;
        const showHidden = this.showHiddenCheckbox ? this.showHiddenCheckbox.checked : false;

        // Reset batching
        this.currentBatch = 0;
        this.batchSize = 100; // Number of groups to render per batch (increased to handle many hidden groups)
        this.container.innerHTML = ''; // Clear container

        const browseModel = this.buildBrowseModel(showHidden);
        this.groupedChannels = browseModel.groupedChannels;
        this.groupMeta = browseModel.groupMeta;
        this.sortedGroups = browseModel.sortedGroups;
        this.showHidden = showHidden;

        // Collapse noisy groups by default on first load. The consolidated
        // national lineup stays open so Live TV feels instantly browsable.
        if (!this._hasCollapsedState && this.sortedGroups.length > 0) {
            this.sortedGroups.forEach(groupName => {
                if (this.groupMeta?.[groupName]?.defaultCollapsed) {
                    this.collapsedGroups.add(groupName);
                } else {
                    this.collapsedGroups.delete(groupName);
                }
            });
            this._hasCollapsedState = true;
            this.saveCollapsedState();
        }

        // Build rendered channel list for navigation (matches visual order)
        this.renderedChannels = [];
        this.sortedGroups.forEach(groupName => {
            const channels = this.groupedChannels[groupName];
            const isFavoritesGroup = groupName === 'Favorites';

            const visibleChannels = channels.filter(channel => {
                return this.isChannelVisibleInBrowse(channel, this.showHidden, { favoritesGroup: isFavoritesGroup });
            });

            // Assign unique render IDs for linear navigation
            visibleChannels.forEach(ch => {
                // We clone the object for the rendered list to attach the unique ID
                // ensuring no side effects on the main channel object
                const renderedCh = {
                    ...ch,
                    _renderId: `rid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    _renderGroup: groupName // Track visual group for navigation
                };
                this.renderedChannels.push(renderedCh);
            });
        });

        // Empty State
        if (this.sortedGroups.length === 0) {
            this.container.innerHTML = `
        <div class="empty-state">
          <p>No channels loaded</p>
          <p class="hint">Connect your TV service to start watching.</p>
          <button type="button" class="btn btn-primary" id="live-empty-add-source">Add a source</button>
        </div>
      `;
            this.container.querySelector('#live-empty-add-source')?.addEventListener('click', () => {
                window.app?.navigateTo?.('settings');
                setTimeout(() => { document.querySelector('.tab[data-tab="sources"]')?.click(); }, 60);
            });
            return;
        }

        // Wrap container content in a specific list div to append to
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'channel-list-content';
        this.container.appendChild(this.listContainer);

        // Add loader element at bottom
        this.loader = document.createElement('div');
        this.loader.className = 'batch-loader';
        this.loader.innerHTML = '<div class="loading-spinner"></div>';
        this.loader.style.opacity = '0'; // Hide initially
        this.container.appendChild(this.loader);

        // Render initial batches - load just enough to fill visible area + buffer
        // Reduced from 10 to 2 to significantly speed up initial load time for large lists
        const maxInitialBatches = 2;
        for (let i = 0; i < maxInitialBatches; i++) {
            if (this.currentBatch * this.batchSize >= this.sortedGroups.length) break;
            this.renderNextBatch();
        }

        // Start observing loader for additional batches
        this.observer.observe(this.loader);

        // On first load, open the list AT the channel being watched (restored across a
        // refresh from localStorage) instead of pinned to the top — on a long lineup the
        // active row is highlighted but would otherwise be scrolled off-screen. Once only,
        // so it never fights the user once they start scrolling/browsing.
        if (!this._didInitialReveal) {
            this._didInitialReveal = true;
            setTimeout(() => this.revealCurrentChannel(), 60);
        }
    }

    // Scroll the list to the channel currently playing (or the last one played, restored
    // from localStorage after a refresh) and expand its group if it was collapsed by
    // default. Best-effort; called once per load from render().
    revealCurrentChannel(target = this.currentChannel || this.findLastLiveChannel()) {
        try {
            if (!target || !this.container || this.searchMode) return;
            const sel = `.channel-item[data-channel-id="${target.id}"][data-source-id="${target.sourceId}"]`;
            let item = this.container.querySelector(sel);
            // The row may live in a batch not yet rendered on a long lineup — render
            // forward until it exists (or we run out of groups).
            let safety = 0;
            while (!item && this.currentBatch * this.batchSize < this.sortedGroups.length && safety < 30) {
                this.renderNextBatch();
                item = this.container.querySelector(sel);
                safety++;
            }
            if (!item) return;
            // Expand its group if collapsed-by-default so the row is actually visible.
            const header = item.closest('.channel-group')?.querySelector('.group-header.collapsed');
            if (header) {
                header.classList.remove('collapsed');
                const gName = header.dataset.group;
                if (gName) { this.collapsedGroups.delete(gName); this.saveCollapsedState(); }
            }
            // Defer the scroll so the expand reflow lands first.
            requestAnimationFrame(() => { try { item.scrollIntoView({ block: 'center' }); } catch (_) {} });
        } catch (_) { /* best-effort — never break the list render */ }
    }

    /**
     * Render next batch of groups
     */
    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const groupsToRender = this.sortedGroups.slice(start, end);

        if (groupsToRender.length === 0) {
            // No more groups
            this.loader.style.display = 'none';
            return;
        }

        this.loader.style.opacity = '1';
        let html = '';

        for (const groupName of groupsToRender) {
            const channels = this.groupedChannels[groupName];
            if (channels.length === 0) continue;

            const isFavoritesGroup = groupName === 'Favorites';

            // Pre-filter visible channels for this group
            const visibleChannels = channels.filter(channel => {
                return this.isChannelVisibleInBrowse(channel, this.showHidden, { favoritesGroup: isFavoritesGroup });
            });

            // Skip group if no visible channels (derived visibility)
            if (visibleChannels.length === 0) continue;

            // Default new groups to collapsed (except Favorites)
            // This handles groups loaded via scroll that weren't in the initial collapse
            if (!this.collapsedGroups.has(groupName) &&
                !this._userExpandedGroups?.has(groupName) &&
                this.groupMeta?.[groupName]?.defaultCollapsed) {
                this.collapsedGroups.add(groupName);
            }

            html += `
        <div class="channel-group">
          <div class="group-header ${this.collapsedGroups.has(groupName) ? 'collapsed' : ''} ${isFavoritesGroup ? 'favorites-group' : ''}" data-group="${groupName}">
            <span class="group-toggle">${Icons.chevronDown}</span>
            <span class="group-name">${groupName}</span>
            <span class="group-count">${visibleChannels.length}</span>
          </div>
          <div class="group-channels">
      `;

            // Skip rendering channel items if group is collapsed (major performance optimization)
            // Channels will be rendered when user expands the group
            if (this.collapsedGroups.has(groupName)) {
                html += '</div></div>';
                continue;
            }


            for (const channel of visibleChannels) {
                // Check hidden again for styling (showHidden mode)
                const rawChannelId = this.getChannelItemId(channel);
                const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);
                const renderedChannel = this.findRenderedChannel(channel, groupName);
                const isRenderActive = this.currentRenderId && renderedChannel?._renderId === this.currentRenderId;
                html += this.buildChannelItemHtml(channel, groupName, {
                    hidden: channelHidden,
                    navActive: isRenderActive
                });
            }
            html += '</div></div>';
        }

        // Append to list container
        // Use temp div to parse HTML string
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        while (tempDiv.firstElementChild) {
            const groupEl = tempDiv.firstElementChild;
            this.attachGroupListeners(groupEl);
            this.listContainer.appendChild(groupEl);
        }

        this.currentBatch++;

        // Hide loader if we might be done (next batch check will confirm)
        if (end >= this.sortedGroups.length) {
            this.loader.style.display = 'none';
        }
    }

    attachGroupListeners(groupEl) {
        const header = groupEl.querySelector('.group-header');
        if (header) {
            header.addEventListener('click', () => {
                const groupName = header.dataset.group;
                const isCollapsed = header.classList.contains('collapsed');

                header.classList.toggle('collapsed');
                this.toggleGroup(groupName);

                // If expanding, render channels if they weren't rendered initially
                if (isCollapsed) {
                    const channelsContainer = groupEl.querySelector('.group-channels');
                    if (channelsContainer && channelsContainer.children.length === 0) {
                        // Channels weren't rendered - render them now
                        this.renderGroupChannels(groupName, channelsContainer);
                    }
                }
            });
            header.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'group', header.dataset));
        }

        groupEl.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.favoriteId || item.dataset.channelId);
                });
            }
        });
    }

    /**
     * Render channels for a specific group (called when expanding a collapsed group)
     */
    renderGroupChannels(groupName, container) {
        const channels = this.groupedChannels[groupName];
        if (!channels || channels.length === 0) return;

        const isFavoritesGroup = groupName === 'Favorites';

        // Filter visible channels
        const visibleChannels = channels.filter(channel => {
            return this.isChannelVisibleInBrowse(channel, this.showHidden, { favoritesGroup: isFavoritesGroup });
        });

        let html = '';
        for (const channel of visibleChannels) {
            const rawChannelId = this.getChannelItemId(channel);
            const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);
            html += this.buildChannelItemHtml(channel, groupName, { hidden: channelHidden });
        }

        container.innerHTML = html;

        // Attach listeners to the new channel items
        container.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.favoriteId || item.dataset.channelId);
                });
            }
        });
    }

    captureLiveFocusState() {
        const active = document.activeElement;
        if (!active || active === document.body) return null;
        if (active === this.searchInput) return { type: 'search' };

        const channelItem = active.closest?.('.channel-item');
        if (channelItem && this.container?.contains(channelItem)) {
            return {
                type: 'channel',
                channelId: channelItem.dataset.channelId || '',
                sourceId: channelItem.dataset.sourceId || '',
                renderId: channelItem.dataset.renderId || ''
            };
        }

        const groupHeader = active.closest?.('.group-header');
        if (groupHeader && this.container?.contains(groupHeader)) {
            return {
                type: 'group',
                groupName: groupHeader.dataset.group || ''
            };
        }

        return null;
    }

    findChannelElementFromFocusState(state) {
        if (!state) return null;
        const items = this.container?.querySelectorAll('.channel-item') || [];
        for (const item of items) {
            if (state.renderId && item.dataset.renderId === state.renderId) return item;
        }
        for (const item of items) {
            if (String(item.dataset.channelId) === String(state.channelId) &&
                String(item.dataset.sourceId) === String(state.sourceId)) {
                return item;
            }
        }
        return null;
    }

    restoreLiveFocusState(state) {
        if (!state) return false;
        let target = null;

        if (state.type === 'search') {
            target = this.searchInput;
        } else if (state.type === 'channel') {
            target = this.findChannelElementFromFocusState(state);
        } else if (state.type === 'group') {
            const headers = this.container?.querySelectorAll('.group-header') || [];
            target = [...headers].find(header => header.dataset.group === state.groupName) || null;
        }

        if (!target) return false;
        if (!target.hasAttribute('tabindex') &&
            !['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
            target.setAttribute('tabindex', '-1');
        }
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return true;
    }

    renderBrowsePreservingFocus() {
        const focusState = this.captureLiveFocusState();
        this.render();
        this.restoreLiveFocusState(focusState);
    }

    focusFirstVisibleChannel() {
        let item = this.container?.querySelector('.channel-item:not(.hidden)');
        if (!item) {
            const header = this.container?.querySelector('.group-header.collapsed');
            if (header) {
                const groupName = header.dataset.group;
                header.classList.remove('collapsed');
                this.collapsedGroups.delete(groupName);
                this._userExpandedGroups.add(groupName);
                this.saveCollapsedState();

                const channelsContainer = header.closest('.channel-group')?.querySelector('.group-channels');
                if (channelsContainer && channelsContainer.children.length === 0) {
                    this.renderGroupChannels(groupName, channelsContainer);
                }
                item = this.container?.querySelector('.channel-item:not(.hidden)');
            }
        }

        if (!item) return false;
        item.focus({ preventScroll: true });
        item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        return true;
    }

    // ============================================================
    // Search — flat ranked results with EPG "on now" matches,
    // keyboard navigation and a recents/favorites zero-state.
    // Browse state (scroll + collapsed groups) is fully restored on exit.
    // ============================================================

    normalizeSearchText(s) {
        return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ').trim();
    }

    /**
     * Pre-normalize channel names once per channel list (lazy)
     */
    ensureSearchIndex() {
        if (this._indexedChannels === this.channels && this._searchIndexSize === this.channels.length) return;
        for (const ch of this.channels) {
            ch._norm = this.normalizeSearchText(ch.name);
            ch._normStripped = ch._norm.split(' ').filter(t => !SEARCH_TAG_WORDS.has(t)).join(' ');
            ch._normGroup = this.normalizeSearchText(ch.groupTitle);
        }
        this._indexedChannels = this.channels;
        this._searchIndexSize = this.channels.length;
        this._recentKeys = new Set(this.getRecentChannels().map(r => `${r.sourceId}:${r.id}`));
    }

    // === Recently watched (for ranking bonus + zero-state) ===

    getRecentChannels() {
        try {
            return JSON.parse(localStorage.getItem('norva-recent-channels') || '[]');
        } catch (e) {
            return [];
        }
    }

    rememberRecentChannel(channel) {
        try {
            let recents = this.getRecentChannels()
                .filter(r => !(r.id === channel.id && r.sourceId === channel.sourceId));
            recents.unshift({ id: channel.id, sourceId: channel.sourceId, name: channel.name });
            recents = recents.slice(0, 8);
            localStorage.setItem('norva-recent-channels', JSON.stringify(recents));
            this._recentKeys?.add(`${channel.sourceId}:${channel.id}`);
        } catch (e) { /* storage unavailable */ }
    }

    // === Mode transitions ===

    onSearchInput() {
        const term = this.searchInput.value.trim();
        if (term.length >= 1) {
            if (!this.searchMode && !this.zeroState) {
                this._savedScrollTop = this.container.scrollTop;
            }
            this.zeroState = false;
            this.searchMode = true;
            this.renderSearchResults(term);
            this.scheduleRemoteSearch(term);
        } else if (document.activeElement === this.searchInput && !document.documentElement.classList.contains('tv-mode')) {
            this.showZeroState();
        } else {
            this.exitSearchMode();
        }
    }

    exitSearchMode({ restoreScroll = true } = {}) {
        if (!this.searchMode && !this.zeroState) return;
        this.searchMode = false;
        this.zeroState = false;
        this.selectedResultIndex = -1;
        this.render();
        if (restoreScroll && this._savedScrollTop != null) {
            this.container.scrollTop = this._savedScrollTop;
        }
        this._savedScrollTop = null;
    }

    // === Ranked channel search ===

    searchChannels(term) {
        this.ensureSearchIndex();
        const termNorm = this.normalizeSearchText(term);
        const isDigits = /^\d+$/.test(term);
        if (!termNorm) return { results: [], groups: [] };

        // Dedup identical channel names (same channel listed in several groups)
        const buckets = new Map(); // sourceId:normName -> { channel, score, groups }
        for (const ch of this.channels) {
            const rawId = ch.streamId || ch.id;
            if (this.isHidden('channel', ch.sourceId, rawId)) continue;
            if (this.hideBroken && this.shouldHideByPlayback(ch)) continue;

            let score = 0;
            if (isDigits && ch.num != null && String(ch.num) === term) score = 1200;
            else if (ch._norm === termNorm || ch._normStripped === termNorm) score = 1000;
            else if (ch._norm.startsWith(termNorm) || ch._normStripped.startsWith(termNorm)) score = 800;
            else if (ch._norm.includes(' ' + termNorm)) score = 600;
            else if (ch._norm.includes(termNorm)) score = 400;
            else continue;

            if (this.isFavorite(ch.sourceId, ch.id)) score += 50;
            if (this._recentKeys?.has(`${ch.sourceId}:${ch.id}`)) score += 100;

            const key = `${ch.sourceId}:${ch._norm}`;
            const existing = buckets.get(key);
            if (existing) {
                existing.groups.add(ch.groupTitle || 'Uncategorized');
                if (score > existing.score) {
                    existing.score = score;
                    existing.channel = ch;
                }
            } else {
                buckets.set(key, { channel: ch, score, groups: new Set([ch.groupTitle || 'Uncategorized']) });
            }
        }

        const results = [...buckets.values()].sort((a, b) => b.score - a.score).slice(0, 50);

        // Group-name matches become clickable chips instead of flooding the list
        const groupCounts = new Map();
        for (const ch of this.channels) {
            const rawId = ch.streamId || ch.id;
            if (this.isHidden('channel', ch.sourceId, rawId)) continue;
            if (this.hideBroken && this.shouldHideByPlayback(ch)) continue;
            if (ch._normGroup && ch._normGroup.includes(termNorm)) {
                const g = ch.groupTitle || 'Uncategorized';
                groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
            }
        }
        const groups = [...groupCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

        return { results, groups };
    }

    shouldUseRemoteSearch(term) {
        return term && term.trim().length >= 2 && window.API?.isCloudMode?.();
    }

    getRemoteSearchSources() {
        const value = this.sourceSelect?.value || '';
        if (value) {
            const [type, id] = value.split(':');
            const source = this.sources.find(s => String(s.id) === String(id) && s.type === type);
            return source ? [source] : [];
        }
        return this.sources.filter(source => source.enabled && (source.type === 'xtream' || source.type === 'm3u'));
    }

    scheduleRemoteSearch(term) {
        if (!this.shouldUseRemoteSearch(term)) return;
        const seq = ++this.remoteSearchSeq;
        clearTimeout(this.remoteSearchInFlight);
        this.remoteSearchInFlight = setTimeout(() => {
            this.loadRemoteSearchResults(term, seq).catch(err => {
                console.warn('[ChannelList] Remote live search failed:', err);
            });
        }, 220);
    }

    async loadRemoteSearchResults(term, seq) {
        if (seq !== this.remoteSearchSeq) return;
        const sources = this.getRemoteSearchSources();
        if (!sources.length) return;

        let added = 0;
        for (const source of sources) {
            const key = `${source.type}:${source.id}:${this.normalizeSearchText(term)}`;
            let streams = this.remoteSearchCache.get(key);
            if (!streams) {
                streams = await API.proxy.xtream.liveStreams(source.id, null, {
                    q: term,
                    limit: 80
                });
                this.remoteSearchCache.set(key, streams || []);
            }
            if (seq !== this.remoteSearchSeq || this.searchInput.value.trim() !== term) return;
            added += this.mergeRemoteSearchChannels(source, streams || []);
        }

        if (!added) return;
        this._indexedChannels = null;
        if (this.searchMode && this.searchInput.value.trim() === term) {
            this.renderSearchResults(term);
        }
        window.app?.liveGuideFusion?.render();
    }

    mergeRemoteSearchChannels(source, streams = []) {
        const existing = new Set(this.channels.map(channel =>
            `${channel.sourceId}:${channel.streamId || channel.stream_id || channel.id}`
        ));
        let added = 0;
        for (const stream of streams) {
            const streamId = stream.stream_id ?? stream.streamId;
            if (!streamId) continue;
            const sourceId = stream.sourceId || source.id;
            const uniqueKey = `${sourceId}:${streamId}`;
            if (existing.has(uniqueKey)) continue;

            const groupTitle = stream.category_name
                || stream.groupTitle
                || stream._displayGroupTitle
                || stream._sourceGroupTitle
                || 'Uncategorized';
            const channel = {
                ...stream,
                id: stream.id || `${source.type}_${sourceId}_${streamId}`,
                streamId,
                stream_id: streamId,
                name: stream.name || stream.title || `Channel ${streamId}`,
                num: stream.num ?? null,
                tvgId: stream.epg_channel_id || stream.tvgId,
                tvgLogo: stream.stream_icon || stream.tvgLogo,
                groupId: `${source.type}_${sourceId}_${stream.category_id || groupTitle}`,
                groupTitle,
                sourceId,
                sourceType: source.type,
                playbackStatus: stream.playback_status || stream.playbackStatus || 'unknown',
                playbackMode: stream.playback_mode || stream.playbackMode || 'unknown',
                playbackCheckedAt: stream.playback_checked_at || stream.playbackCheckedAt || null,
                playbackModeCheckedAt: stream.playback_mode_checked_at || stream.playbackModeCheckedAt || null,
                qualityGroup: stream.qualityGroup || null,
                currentVariant: stream.currentVariant || null,
                cloudLogicalId: stream.cloudLogicalId || null,
                cloudSourceId: stream.cloudSourceId || null,
                _logicalChannel: stream._logicalChannel || false,
                _logicalKind: stream._logicalKind || 'search',
                _variantCount: stream._variantCount || stream.qualityGroup?.variants?.length || 1,
                _sourceGroupTitle: stream._sourceGroupTitle || groupTitle,
                _displayGroupTitle: stream._displayGroupTitle || groupTitle
            };
            this.channels.push(channel);
            existing.add(uniqueKey);
            added += 1;
        }
        return added;
    }

    // === EPG "on now" index (rebuilt at most once a minute) ===

    buildEpgNowIndex() {
        const guide = window.app?.epgGuide;
        if (!guide?.programmes?.length) {
            this._epgNowList = null;
            return;
        }
        if (this._epgNowList && Date.now() - this._epgNowBuiltAt < 60000) return;

        const now = Date.now();

        // 1. One pass over all programmes: what's on right now per EPG channel
        const currentByEpgId = new Map();
        for (const p of guide.programmes) {
            if (currentByEpgId.has(p.channelId)) continue;
            const start = new Date(p.start).getTime();
            const stop = new Date(p.stop).getTime();
            if (now >= start && now < stop) currentByEpgId.set(p.channelId, p);
        }

        // 2. Map each EPG channel to one of our visible channels
        const epgToChannel = new Map();
        for (const ch of this.channels) {
            let epgCh = null;
            if (ch.tvgId && guide.channelMap?.has(ch.tvgId)) {
                epgCh = guide.channelMap.get(ch.tvgId);
            } else if (ch.name && guide.channelMap?.has(String(ch.name).toLowerCase())) {
                epgCh = guide.channelMap.get(String(ch.name).toLowerCase());
            }
            if (!epgCh || epgToChannel.has(epgCh.id)) continue;
            const rawId = ch.streamId || ch.id;
            if (this.isHidden('channel', ch.sourceId, rawId)) continue;
            if (this.hideBroken && this.shouldHideByPlayback(ch)) continue;
            epgToChannel.set(epgCh.id, ch);
        }

        const list = [];
        const byChannelKey = new Map(); // sourceId:id -> program title (for result subtitles)
        for (const [epgId, program] of currentByEpgId) {
            const channel = epgToChannel.get(epgId);
            if (!channel) continue;
            list.push({ channel, program, titleNorm: this.normalizeSearchText(program.title) });
            byChannelKey.set(`${channel.sourceId}:${channel.id}`, program.title);
        }
        this._epgNowList = list;
        this._epgNowByChannelKey = byChannelKey;
        this._epgNowBuiltAt = now;
    }

    searchOnNow(termNorm) {
        if (!this._epgNowList) return [];
        const matches = [];
        for (const entry of this._epgNowList) {
            if (entry.titleNorm.includes(termNorm)) {
                matches.push(entry);
                if (matches.length >= 5) break;
            }
        }
        return matches;
    }

    // === Results rendering ===

    highlightMatch(name, term) {
        if (!term) return this.escapeHtml(name);
        const strippedName = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const strippedTerm = String(term).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const idx = strippedName.indexOf(strippedTerm);
        if (idx === -1) return this.escapeHtml(name);
        const before = this.escapeHtml(name.slice(0, idx));
        const match = this.escapeHtml(name.slice(idx, idx + term.length));
        const after = this.escapeHtml(name.slice(idx + term.length));
        return `${before}<mark class="search-highlight">${match}</mark>${after}`;
    }

    buildSearchResultHtml(ch, renderId, { subtitle = '', term = '', plainTitle = false } = {}) {
        const isFavorite = this.isFavorite(ch.sourceId, ch.id);
        const isActive = this.currentChannel?.id === ch.id;
        const playbackClasses = this.getPlaybackClassNames(ch);
        const title = plainTitle ? this.escapeHtml(ch.name) : this.highlightMatch(ch.name, term);
        return `
          <div class="channel-item search-result ${isActive ? 'active' : ''} ${playbackClasses}"
               data-channel-id="${ch.id}"
               data-source-id="${ch.sourceId}"
               data-source-type="${ch.sourceType}"
               data-stream-id="${ch.streamId || ''}"
               data-url="${ch.url || ''}"
               data-render-id="${renderId}"
               data-render-group="Search">
            <img class="channel-logo" src="${this.getChannelLogoSrc(ch)}"
                 alt="" onerror="this.onerror=null;this.src='${this.getChannelLogoErrorSrc(ch)}'">
            <div class="channel-info">
              <div class="channel-name">${title}</div>
              <div class="channel-program search-subtitle">${subtitle}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>`;
    }

    renderSearchResults(term) {
        const termNorm = this.normalizeSearchText(term);
        this.buildEpgNowIndex();
        const { results, groups } = this.searchChannels(term);
        const onNow = termNorm.length >= 3 ? this.searchOnNow(termNorm) : [];

        // Flat navigation list — also drives ↑/↓ zapping and Enter
        this.renderedChannels = [];
        const pushNav = (ch) => {
            const renderedCh = {
                ...ch,
                _renderId: `rid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                _renderGroup: 'Search'
            };
            this.renderedChannels.push(renderedCh);
            return renderedCh._renderId;
        };

        let html = '';
        const headerParts = [`${results.length}${results.length >= 50 ? '+' : ''} channel${results.length === 1 ? '' : 's'}`];
        if (onNow.length) headerParts.push(`${onNow.length} on now`);
        html += `<div class="search-results-header">${headerParts.join(' · ')}</div>`;

        if (onNow.length) {
            html += '<div class="search-section-label">On now</div>';
            for (const entry of onNow) {
                const rid = pushNav(entry.channel);
                const subtitle = `${this.highlightMatch(entry.program.title, term)} <span class="search-epg-tag">EPG</span>`;
                html += this.buildSearchResultHtml(entry.channel, rid, { subtitle, plainTitle: true });
            }
        }

        if (results.length) {
            html += '<div class="search-section-label">Channels</div>';
            for (const result of results) {
                const ch = result.channel;
                const rid = pushNav(ch);
                const bits = [this.escapeHtml(ch.groupTitle || 'Uncategorized')];
                const extraGroups = result.groups.size - 1;
                if (extraGroups > 0) bits.push(`+${extraGroups} other group${extraGroups > 1 ? 's' : ''}`);
                const nowTitle = this._epgNowByChannelKey?.get(`${ch.sourceId}:${ch.id}`);
                if (nowTitle) bits.push(this.escapeHtml(nowTitle));
                html += this.buildSearchResultHtml(ch, rid, { subtitle: bits.join(' · '), term });
            }
        }

        if (!results.length && !onNow.length) {
            const firstWord = term.split(/\s+/)[0];
            html += `
              <div class="empty-state search-empty">
                <p>No results for &ldquo;${this.escapeHtml(term)}&rdquo;</p>
                ${term.includes(' ')
                    ? `<button class="btn btn-sm btn-ghost search-suggest" data-term="${this.escapeHtml(firstWord)}">Try &ldquo;${this.escapeHtml(firstWord)}&rdquo;</button>`
                    : '<p class="hint">Try a shorter term, without prefixes like FR| or 4K</p>'}
              </div>`;
        }

        if (groups.length) {
            html += '<div class="search-section-label">Matching groups</div><div class="search-group-chips">';
            for (const [name, count] of groups) {
                html += `<button class="search-group-chip" data-group="${this.escapeHtml(name)}">${this.escapeHtml(name)}<span>${count}</span></button>`;
            }
            html += '</div>';
        }

        html += '<div class="search-kbd-footer"><span>↑↓ navigate</span><span>↵ play</span><span>esc close</span></div>';

        this.container.innerHTML = `<div class="search-results">${html}</div>`;
        this.container.scrollTop = 0;
        this.selectedResultIndex = this.renderedChannels.length ? 0 : -1;
        this.updateSelectedResult(false);
        this.attachSearchResultListeners();
    }

    showZeroState() {
        if (!this.channels.length) return;
        this.ensureSearchIndex();

        const recents = this.getRecentChannels()
            .map(r => this.channels.find(c => c.id === r.id && c.sourceId === r.sourceId))
            .filter(Boolean)
            .filter(ch => !this.hideBroken || !this.shouldHideByPlayback(ch))
            .slice(0, 6);
        const favs = this.channels
            .filter(ch => this.isFavorite(ch.sourceId, ch.id))
            .filter(ch => !this.hideBroken || !this.shouldHideByPlayback(ch))
            .filter(ch => !recents.some(r => r.id === ch.id && r.sourceId === ch.sourceId))
            .slice(0, 6);

        if (!recents.length && !favs.length) return; // nothing useful — keep browse list

        if (!this.searchMode && !this.zeroState) {
            this._savedScrollTop = this.container.scrollTop;
        }
        this.searchMode = false;
        this.zeroState = true;

        this.renderedChannels = [];
        const pushNav = (ch) => {
            const renderedCh = {
                ...ch,
                _renderId: `rid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                _renderGroup: 'Search'
            };
            this.renderedChannels.push(renderedCh);
            return renderedCh._renderId;
        };

        let html = '';
        if (recents.length) {
            html += '<div class="search-section-label">Recently watched</div>';
            recents.forEach(ch => {
                html += this.buildSearchResultHtml(ch, pushNav(ch), {
                    subtitle: this.escapeHtml(ch.groupTitle || ''), plainTitle: true
                });
            });
        }
        if (favs.length) {
            html += '<div class="search-section-label">Favorites</div>';
            favs.forEach(ch => {
                html += this.buildSearchResultHtml(ch, pushNav(ch), {
                    subtitle: this.escapeHtml(ch.groupTitle || ''), plainTitle: true
                });
            });
        }
        html += '<div class="search-kbd-footer"><span>type to search</span><span>↑↓ navigate</span><span>↵ play</span></div>';

        this.container.innerHTML = `<div class="search-results">${html}</div>`;
        this.container.scrollTop = 0;
        this.selectedResultIndex = this.renderedChannels.length ? 0 : -1;
        this.updateSelectedResult(false);
        this.attachSearchResultListeners();
    }

    attachSearchResultListeners() {
        this.container.querySelectorAll('.channel-item.search-result').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            favBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
            });
        });

        this.container.querySelectorAll('.search-group-chip').forEach(chip => {
            chip.addEventListener('click', () => this.openGroupFromSearch(chip.dataset.group));
        });

        this.container.querySelector('.search-suggest')?.addEventListener('click', (e) => {
            this.searchInput.value = e.target.dataset.term || '';
            this.onSearchInput();
        });
    }

    /**
     * Group chip clicked: leave search and jump to that group, expanded
     */
    openGroupFromSearch(groupName) {
        this.searchInput.value = '';
        this.collapsedGroups.delete(groupName);
        this._userExpandedGroups.add(groupName);
        this.saveCollapsedState();
        this.exitSearchMode({ restoreScroll: false });

        // The group may live in a not-yet-rendered batch
        let header = this.listContainer?.querySelector(`.group-header[data-group="${CSS.escape(groupName)}"]`);
        let safety = 0;
        while (!header && this.currentBatch * this.batchSize < this.sortedGroups.length && safety < 50) {
            this.renderNextBatch();
            header = this.listContainer?.querySelector(`.group-header[data-group="${CSS.escape(groupName)}"]`);
            safety++;
        }
        if (header) {
            header.classList.remove('collapsed');
            const channelsContainer = header.closest('.channel-group')?.querySelector('.group-channels');
            if (channelsContainer && channelsContainer.children.length === 0) {
                this.renderGroupChannels(groupName, channelsContainer);
            }
            header.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // === Keyboard navigation ===

    handleSearchKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            this.searchInput.value = '';
            this.exitSearchMode();
            this.searchInput.blur();
            return;
        }

        if (e.key === 'ArrowDown' && !this.searchInput.value.trim()) {
            e.preventDefault();
            e.stopPropagation();
            this.exitSearchMode({ restoreScroll: true });
            this.focusFirstVisibleChannel();
            return;
        }

        if (!this.searchMode && !this.zeroState) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!this.renderedChannels.length) return;
            const dir = e.key === 'ArrowDown' ? 1 : -1;
            this.selectedResultIndex =
                (this.selectedResultIndex + dir + this.renderedChannels.length) % this.renderedChannels.length;
            this.updateSelectedResult(true);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const target = this.renderedChannels[Math.max(0, this.selectedResultIndex)] || this.renderedChannels[0];
            if (target) {
                this.selectChannel({
                    channelId: target.id,
                    sourceId: String(target.sourceId),
                    sourceType: target.sourceType,
                    streamId: target.streamId != null ? String(target.streamId) : '',
                    url: target.url || '',
                    renderId: target._renderId,
                    renderGroup: 'Search'
                });
            }
        }
    }

    updateSelectedResult(scroll) {
        this.container.querySelectorAll('.search-result.kb-selected').forEach(el => el.classList.remove('kb-selected'));
        if (this.selectedResultIndex < 0) return;
        const target = this.renderedChannels[this.selectedResultIndex];
        if (!target) return;
        const el = this.container.querySelector(`.search-result[data-render-id="${target._renderId}"]`);
        if (el) {
            el.classList.add('kb-selected');
            if (scroll) el.scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Load sources into dropdown
     */
    async loadSources() {
        try {
            this.sources = await API.sources.getAll();
            console.log('[ChannelList] loadSources: Got', this.sources?.length || 0, 'sources');
            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);

            if (xtreamSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'Xtream';
                xtreamSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `xtream:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }

            if (m3uSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'M3U';
                m3uSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `m3u:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * Load channels from selected source
     */
    async loadChannels() {
        if (this.isLoading) return;
        this.isLoading = true;
        const loadRunId = ++this.liveHydrationRunId;
        this.currentRenderId = null; // Reset render tracking

        const sourceValue = this.sourceSelect.value;
        const self = this;

        if (!sourceValue) {
            // Load from all sources
            await this.loadAllChannels();
            this.isLoading = false;
            return;
        }

        const [type, id] = sourceValue.split(':');

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            if (type === 'xtream') {
                await this.loadXtreamChannels(parseInt(id), false, loadRunId);
            } else if (type === 'm3u') {
                await this.loadM3uChannels(parseInt(id), false, loadRunId);
            }

            this.render();
            this.loadLiveDecorationsAndRefresh(loadRunId);
        } catch (err) {
            console.error('Error loading channels:', err);
            this.container.innerHTML = `<div class="empty-state"><p>Error loading channels</p><p class="hint">${err.message}</p></div>`;
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Load channels from all enabled sources
     */
    async loadAllChannels() {
        const loadRunId = ++this.liveHydrationRunId;
        this.channels = [];
        this.groups = [];

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);
            console.log('[ChannelList] loadAllChannels: xtream=', xtreamSources.length, 'm3u=', m3uSources.length);

            for (const source of xtreamSources) {
                await this.loadXtreamChannels(source.id, true, loadRunId);
            }

            for (const source of m3uSources) {
                await this.loadM3uChannels(source.id, true, loadRunId);
            }

            this.render();
            this.loadLiveDecorationsAndRefresh(loadRunId);
        } catch (err) {
            console.error('Error loading all channels:', err);
        }
    }

    loadLiveDecorationsAndRefresh(loadRunId) {
        Promise.all([
            this.loadHiddenItems(),
            this.loadFavorites(),
            this.loadPlaybackStatuses()
        ]).then(() => {
            if (loadRunId !== this.liveHydrationRunId) return;
            this.renderBrowsePreservingFocus();
            window.app?.liveGuideFusion?.render();
            this.resumeLivePlaybackIfPending();
        }).catch(err => {
            console.warn('[ChannelList] Live decorations refresh failed:', err);
        });
    }

    /**
     * Load Xtream channels
     */
    async loadFirstLivePage(sourceId) {
        const pageSize = 1000;
        return API.proxy.xtream.liveStreams(sourceId, null, { limit: pageSize, offset: 0 });
    }

    liveCacheKey(sourceId, sourceType) {
        return `norva-live:${sourceType}:${sourceId}:v4`;
    }

    openLiveCacheDb() {
        if (typeof indexedDB === 'undefined') return Promise.resolve(null);
        if (this.liveCacheDbPromise) return this.liveCacheDbPromise;
        this.liveCacheDbPromise = new Promise((resolve) => {
            const request = indexedDB.open('norva-live-cache', 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('catalogs')) {
                    db.createObjectStore('catalogs', { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        });
        return this.liveCacheDbPromise;
    }

    async readLiveCatalogCache(sourceId, sourceType) {
        if (!window.API?.isCloudMode?.()) return null;
        const db = await this.openLiveCacheDb();
        if (!db) return null;
        const key = this.liveCacheKey(sourceId, sourceType);
        return new Promise((resolve) => {
            const tx = db.transaction('catalogs', 'readonly');
            const request = tx.objectStore('catalogs').get(key);
            request.onsuccess = () => {
                const entry = request.result;
                const fresh = entry?.savedAt && Date.now() - Number(entry.savedAt) < LIVE_CATALOG_CACHE_TTL_MS;
                resolve(fresh && Array.isArray(entry.channels) ? entry : null);
            };
            request.onerror = () => resolve(null);
        });
    }

    async writeLiveCatalogCache(sourceId, sourceType) {
        if (!window.API?.isCloudMode?.()) return;
        const db = await this.openLiveCacheDb();
        if (!db) return;
        const sourceKey = String(sourceId);
        const entry = {
            key: this.liveCacheKey(sourceId, sourceType),
            savedAt: Date.now(),
            sourceId,
            sourceType,
            groups: this.groups.filter(group =>
                String(group.sourceId) === sourceKey && group.sourceType === sourceType
            ),
            channels: this.channels.filter(channel =>
                String(channel.sourceId) === sourceKey && channel.sourceType === sourceType
            )
        };
        if (!entry.channels.length) return;
        await new Promise((resolve) => {
            const tx = db.transaction('catalogs', 'readwrite');
            tx.objectStore('catalogs').put(entry);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    }

    async loadLiveCatalogFromCache(sourceId, sourceType) {
        const entry = await this.readLiveCatalogCache(sourceId, sourceType);
        if (!entry) return false;
        this.groups = this.groups.concat(entry.groups || []);
        this.channels = this.channels.concat(entry.channels || []);
        return true;
    }

    hydrateRemainingLivePages(sourceId, categories, sourceType, loadRunId) {
        if (!window.API?.isCloudMode?.()) return;
        const pageSize = 1000;

        (async () => {
            let addedSinceHydrationStart = 0;
            for (let offset = pageSize; offset < 80000; offset += pageSize) {
                if (loadRunId !== this.liveHydrationRunId) return;
                const streams = await API.proxy.xtream.liveStreams(sourceId, null, { limit: pageSize, offset });
                if (loadRunId !== this.liveHydrationRunId) return;
                if (!Array.isArray(streams) || !streams.length) break;

                const channelList = this.mapLiveStreamsToChannels(sourceId, categories, streams, sourceType);
                const added = this.addChannelsUnique(channelList);
                addedSinceHydrationStart += added;

                if (streams.length < pageSize) break;
            }

            if (addedSinceHydrationStart > 0 && loadRunId === this.liveHydrationRunId) {
                this._indexedChannels = null;
                if (!this.searchMode) this.renderBrowsePreservingFocus();
                window.app?.liveGuideFusion?.render();
                this.resumeLivePlaybackIfPending();
            }
            if (loadRunId === this.liveHydrationRunId) {
                await this.writeLiveCatalogCache(sourceId, sourceType);
            }
        })().catch(err => {
            console.warn('[ChannelList] Background live hydration failed:', err);
        });
    }

    addChannelsUnique(channelList = []) {
        const existing = new Set(this.channels.map(channel =>
            `${channel.sourceId}:${channel.streamId || channel.stream_id || channel.id}`
        ));
        let added = 0;
        for (const channel of channelList) {
            const streamId = channel.streamId || channel.stream_id || channel.id;
            const key = `${channel.sourceId}:${streamId}`;
            if (!streamId || existing.has(key)) continue;
            this.channels.push(channel);
            existing.add(key);
            added += 1;
        }
        return added;
    }

    getLastLiveChannelRecord() {
        try {
            return JSON.parse(localStorage.getItem(LAST_LIVE_CHANNEL_KEY) || 'null');
        } catch (_) {
            return null;
        }
    }

    rememberLastLiveChannel(channel) {
        if (!channel) return;
        try {
            localStorage.setItem(LAST_LIVE_CHANNEL_KEY, JSON.stringify({
                id: channel.id,
                sourceId: channel.sourceId,
                sourceType: channel.sourceType || '',
                streamId: channel.streamId || channel.stream_id || '',
                name: channel.name || '',
                savedAt: Date.now()
            }));
        } catch (_) { /* local storage can be unavailable in private modes */ }
    }

    findLastLiveChannel() {
        const record = this.getLastLiveChannelRecord();
        if (!record) return null;
        return this.channels.find(channel => {
            if (String(channel.sourceId) !== String(record.sourceId)) return false;
            if (String(channel.id) === String(record.id)) return true;
            const streamId = channel.streamId || channel.stream_id || '';
            return streamId && String(streamId) === String(record.streamId || '');
        }) || null;
    }

    getFirstPlayableChannel() {
        return this.channels.find(channel => {
            if (!channel) return false;
            const rawId = channel.streamId || channel.stream_id || channel.id;
            if (this.isHidden('channel', channel.sourceId, rawId)) return false;
            if (this.isHidden('group', channel.sourceId, channel.groupTitle)) return false;
            if (this.hideBroken && this.shouldHideByPlayback(channel)) return false;
            return true;
        }) || this.channels[0] || null;
    }

    getLiveResumeChannel() {
        return this.findLastLiveChannel()
            || this.currentChannel
            || this.getFirstPlayableChannel();
    }

    hasActiveLivePlayback(channel = this.currentChannel) {
        const player = window.app?.player;
        if (!player || !channel || !player.currentChannel) return false;
        const sameChannel = String(player.currentChannel.id) === String(channel.id)
            && String(player.currentChannel.sourceId) === String(channel.sourceId);
        return sameChannel && player.hasCurrentMedia?.();
    }

    // Mark a channel as transcode-only (its remuxed video failed to decode in the
    // browser — typically HEVC) and immediately re-select it so the gateway
    // re-encodes to H.264. The flag persists for the session so later plays of
    // this channel skip the doomed remux attempt.
    forceTranscodeChannel(channel) {
        if (!channel || channel.id == null) return Promise.resolve();
        this._forceTranscode = this._forceTranscode || new Set();
        const key = `${channel.sourceId}:${channel.id}`;
        this._forceTranscode.add(key);
        return this.selectChannel({
            channelId: channel.id,
            sourceId: String(channel.sourceId ?? ''),
            streamId: channel.streamId || channel.stream_id || '',
            sourceType: channel.sourceType
        });
    }

    resumeLivePlayback(options = {}) {
        const { force = false } = options;
        if (this.liveResumeInFlight) return this.liveResumeInFlight;

        const channel = this.getLiveResumeChannel();
        if (!channel) {
            this.pendingLiveResume = true;
            return Promise.resolve(false);
        }

        if (!force && this.hasActiveLivePlayback(channel)) {
            this.currentChannel = channel;
            this.pendingLiveResume = false;
            return Promise.resolve(true);
        }

        this.pendingLiveResume = false;
        this.liveResumeInFlight = this.selectChannel({
            channelId: channel.id,
            sourceId: channel.sourceId,
            sourceType: channel.sourceType,
            streamId: channel.streamId || channel.stream_id || '',
            url: channel.url || '',
            autoResume: 'true'
        }).then(() => true).catch(err => {
            console.warn('[ChannelList] Live resume failed:', err);
            this.pendingLiveResume = true;
            return false;
        }).finally(() => {
            this.liveResumeInFlight = null;
        });

        return this.liveResumeInFlight;
    }

    resumeLivePlaybackIfPending() {
        if (!this.pendingLiveResume) return;
        if (!document.getElementById('page-live')?.classList.contains('active')) return;
        this.resumeLivePlayback();
    }

    mapLiveStreamsToChannels(sourceId, categories, streams, sourceType = 'xtream') {
        const categoryById = new Map(categories.map(c => [String(c.category_id), c.category_name]));

        return (streams || []).map(stream => {
            const streamId = stream.stream_id ?? stream.streamId;
            const groupTitle = categoryById.get(String(stream.category_id))
                || stream.category_name
                || stream.groupTitle
                || 'Uncategorized';
            const channel = {
                ...stream,
                id: stream.id || `${sourceType}_${sourceId}_${streamId}`,
                streamId,
                stream_id: streamId,
                name: stream.name,
                num: stream.num ?? null,
                tvgId: stream.epg_channel_id || stream.tvgId,
                tvgLogo: stream.stream_icon || stream.tvgLogo,
                url: stream.stream_url || stream.url,
                groupId: `${sourceType}_${sourceId}_${stream.category_id || groupTitle}`,
                groupTitle,
                sourceId,
                sourceType,
                playbackStatus: stream.playback_status || stream.playbackStatus || 'unknown',
                playbackMode: stream.playback_mode || stream.playbackMode || 'unknown',
                playbackCheckedAt: stream.playback_checked_at || stream.playbackCheckedAt || null,
                playbackModeCheckedAt: stream.playback_mode_checked_at || stream.playbackModeCheckedAt || null,
                qualityGroup: stream.qualityGroup || null,
                currentVariant: stream.currentVariant || null,
                cloudLogicalId: stream.cloudLogicalId || null,
                cloudSourceId: stream.cloudSourceId || null,
                _logicalChannel: stream._logicalChannel || false,
                _logicalKind: stream._logicalKind || 'generic',
                _variantCount: stream._variantCount || stream.qualityGroup?.variants?.length || 1,
                _sourceGroupTitle: stream._sourceGroupTitle || groupTitle,
                _displayGroupTitle: stream._displayGroupTitle || groupTitle
            };
            if (channel.qualityGroup?.variants?.length) {
                channel.qualityGroup = {
                    ...channel.qualityGroup,
                    variants: channel.qualityGroup.variants.map(variant => ({
                        ...variant,
                        channel: variant.channel || {
                            ...channel,
                            id: `${sourceType}_${variant.sourceId || sourceId}_${variant.streamId}`,
                            streamId: variant.streamId,
                            stream_id: variant.streamId,
                            sourceId: variant.sourceId || sourceId,
                            source_id: variant.sourceId || sourceId,
                            name: variant.raw || channel.name,
                            currentVariant: variant,
                            qualityGroup: undefined
                        }
                    }))
                };
                channel.currentVariant = channel.currentVariant
                    || channel.qualityGroup.defaultVariant
                    || channel.qualityGroup.variants.find(v => String(v.streamId) === String(channel.streamId))
                    || channel.qualityGroup.variants[0];
            }
            return channel;
        });
    }

    /**
     * Load Xtream channels
     */
    async loadXtreamChannels(sourceId, append = false, loadRunId = this.liveHydrationRunId) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        if (await this.loadLiveCatalogFromCache(sourceId, 'xtream')) return;

        const categories = await API.proxy.xtream.liveCategories(sourceId);
        const streams = await this.loadFirstLivePage(sourceId);

        // Map categories to groups
        const categoryGroups = categories.map(cat => ({
            id: `xtream_${sourceId}_${cat.category_id}`,
            name: cat.category_name,
            sourceId,
            sourceType: 'xtream'
        }));

        this.groups = this.groups.concat(categoryGroups);

        const channelList = this.mapLiveStreamsToChannels(sourceId, categories, streams, 'xtream');
        this.channels = this.channels.concat(channelList);
        this.hydrateRemainingLivePages(sourceId, categories, 'xtream', loadRunId);
        if ((streams || []).length < 1000) await this.writeLiveCatalogCache(sourceId, 'xtream');
    }

    /**
     * Load M3U channels
     * Now uses unified Xtream-style API endpoints (backend supports both source types)
     */
    async loadM3uChannels(sourceId, append = false, loadRunId = this.liveHydrationRunId) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        // Use Xtream API endpoints - backend now supports M3U sources too
        if (await this.loadLiveCatalogFromCache(sourceId, 'm3u')) return;

        const categories = await API.proxy.xtream.liveCategories(sourceId);
        const streams = await this.loadFirstLivePage(sourceId);

        // Map categories to groups (keeping m3u sourceType for downstream compatibility)
        const m3uGroups = categories.map(cat => ({
            id: `m3u_${sourceId}_${cat.category_id}`,
            name: cat.category_name,
            sourceId,
            sourceType: 'm3u'
        }));

        this.groups = this.groups.concat(m3uGroups);

        const channelList = this.mapLiveStreamsToChannels(sourceId, categories, streams, 'm3u');
        this.channels = this.channels.concat(channelList);
        this.hydrateRemainingLivePages(sourceId, categories, 'm3u', loadRunId);
        if ((streams || []).length < 1000) await this.writeLiveCatalogCache(sourceId, 'm3u');
    }

    /**
     * Load hidden items
     */
    async loadHiddenItems() {
        try {
            const items = await API.channels.getHidden();
            this.hiddenItems = new Set(items.map(i => `${i.item_type}:${i.source_id}:${i.item_id}`));
        } catch (err) {
            console.error('Error loading hidden items:', err);
        }
    }

    /**
     * Check if item is hidden
     */
    isHidden(type, sourceId, itemId) {
        return this.hiddenItems.has(`${type}:${sourceId}:${itemId}`);
    }

    async loadPlaybackStatuses() {
        if (!window.PlaybackHealth) return;
        const sourceValue = this.sourceSelect?.value || '';
        const [, sourceId] = sourceValue.includes(':') ? sourceValue.split(':') : [];
        const entries = await PlaybackHealth.load({ sourceId, itemType: 'channel', includeModes: true });
        this.applyPlaybackEntries(entries);
    }

    isBrokenChannel(channel) {
        if (!channel) return false;
        const rawChannelId = channel.streamId || channel.id;
        return channel.playbackStatus === 'broken' ||
            window.PlaybackHealth?.isBroken(channel.sourceId, 'channel', rawChannelId);
    }

    getPlaybackMode(channel) {
        if (!channel) return 'unknown';
        const rawChannelId = channel.streamId || channel.id;
        if (channel.playbackMode && channel.playbackMode !== 'unknown') {
            return channel.playbackMode;
        }
        return window.PlaybackHealth?.getMode(channel.sourceId, 'channel', rawChannelId) || 'unknown';
    }

    isDirectHlsChannel(channel) {
        return this.getPlaybackMode(channel) === 'direct_hls';
    }

    isHealthyChannel(channel) {
        if (!channel) return false;
        if (this.isBrokenChannel(channel) || this.isDirectHlsChannel(channel)) return false;
        const rawChannelId = channel.streamId || channel.id;
        const playbackHealth = window.PlaybackHealth || null;
        const cacheKey = playbackHealth ? playbackHealth.key(channel.sourceId, 'channel', rawChannelId) : null;
        const statusEntry = cacheKey ? playbackHealth.statuses.get(cacheKey) : null;
        const status = channel.playbackStatus || statusEntry?.status || 'unknown';
        const mode = this.getPlaybackMode(channel);
        return status === 'ok' || mode === 'transcoding_audio' || mode === 'direct_play';
    }

    getPlaybackClassNames(channel) {
        if (!channel) return '';
        const classes = [];
        if (this.isBrokenChannel(channel)) classes.push('playback-broken');
        if (this.isDirectHlsChannel(channel)) classes.push('playback-direct-hls');
        if (this.isHealthyChannel(channel)) classes.push('playback-ok');
        return classes.join(' ');
    }

    /**
     * Update the playback-status CSS classes on the rendered DOM items for a
     * single channel, without rebuilding the whole list. Keeps channel
     * selection/switching fluid (a full render() on every play caused lag).
     */
    refreshChannelPlaybackClasses(sourceId, streamId) {
        const items = this.container?.querySelectorAll('.channel-item');
        if (!items || !items.length) return;
        items.forEach(el => {
            if (String(el.dataset.sourceId) !== String(sourceId)) return;
            if (String(el.dataset.streamId) !== String(streamId) &&
                String(el.dataset.channelId) !== String(streamId)) return;
            const ch = this.channels.find(c =>
                String(c.sourceId) === String(sourceId) &&
                (String(c.streamId || c.id) === String(streamId) ||
                    String(c.id) === String(el.dataset.channelId)));
            if (!ch) return;
            el.classList.toggle('playback-broken', this.isBrokenChannel(ch));
            el.classList.toggle('playback-direct-hls', this.isDirectHlsChannel(ch));
            el.classList.toggle('playback-ok', this.isHealthyChannel(ch));
        });
    }

    shouldHideByPlayback(channel) {
        return this.isBrokenChannel(channel) || this.isDirectHlsChannel(channel);
    }

    applyPlaybackEntries(entries = []) {
        if (!Array.isArray(entries) || entries.length === 0) return;
        const byKey = new Map(entries.map(entry => [
            `${entry.source_id ?? entry.sourceId}:${entry.item_id ?? entry.itemId}`,
            entry
        ]));

        this.channels.forEach(channel => {
            const rawChannelId = channel.streamId || channel.id;
            const entry = byKey.get(`${channel.sourceId}:${rawChannelId}`);
            if (!entry) return;
            channel.playbackStatus = entry.status || channel.playbackStatus || 'unknown';
            channel.playbackMode = entry.mode || entry.playback_mode || channel.playbackMode || 'unknown';
            channel.playbackCheckedAt = entry.updated_at || entry.updatedAt || channel.playbackCheckedAt || null;
            channel.playbackModeCheckedAt = entry.mode_checked_at || entry.modeCheckedAt || channel.playbackModeCheckedAt || null;
        });
    }

    async runPlaybackScan(scanScope, options = {}) {
        if (!window.API?.playbackStatus?.scanLiveModes || !scanScope?.payload) return null;
        const { statusPrefix = 'Scanning', statusFailed = 'Scan failed', allowReplace = false } = options;
        if (this._isScanningPlayback && !allowReplace) return null;

        const runId = ++this._playbackScanRunId;
        this._isScanningPlayback = true;
        this.scanPlaybackBtn?.classList.add('scanning');
        if (this.scanPlaybackBtn) this.scanPlaybackBtn.disabled = true;
        if (this.scanStatusEl) {
            this.scanStatusEl.textContent = `${statusPrefix} ${scanScope.label}...`;
        }

        try {
            const result = await API.playbackStatus.scanLiveModes(scanScope.payload);
            await this.followLivePlaybackScan(result, scanScope, runId);
            return result;
        } catch (err) {
            console.error('Live playback scan failed:', err);
            if (this.scanStatusEl && runId === this._playbackScanRunId) this.scanStatusEl.textContent = statusFailed;
        } finally {
            if (runId === this._playbackScanRunId) {
                this._isScanningPlayback = false;
                this.scanPlaybackBtn?.classList.remove('scanning');
                if (this.scanPlaybackBtn) this.scanPlaybackBtn.disabled = false;
            }
        }
        return null;
    }

    async scanLivePlaybackModes() {
        const scanScope = this.getLivePlaybackScanScope();
        return this.runPlaybackScan(scanScope, { allowReplace: true });
    }

    getLivePlaybackScanScope() {
        const sourceValue = this.sourceSelect?.value || '';
        const [, sourceId] = sourceValue.includes(':') ? sourceValue.split(':') : [];
        const activeGroup = window.app?.liveGuideFusion?.activeGroup || '';
        const isFavorites = activeGroup === 'Favorites';
        const isCategory = Boolean(activeGroup && !isFavorites);

        let scopeChannels = this.channels.filter(channel => {
            const rawId = channel.streamId || channel.id;
            if (this.isHidden('channel', channel.sourceId, rawId)) return false;
            if (sourceId && String(channel.sourceId) !== String(sourceId)) return false;
            if (isFavorites) return this.isFavorite(channel.sourceId, channel.id);
            if (isCategory) return (channel.groupTitle || 'Uncategorized') === activeGroup;
            return true;
        });

        const payload = {
            sourceId: sourceId || null,
            scopeLabel: isFavorites
                ? 'Favorites'
                : isCategory
                    ? activeGroup
                    : 'All channels'
        };

        if (isFavorites || isCategory) {
            payload.categoryName = isCategory ? activeGroup : '';
            payload.items = scopeChannels.map(channel => ({
                sourceId: channel.sourceId,
                itemId: channel.streamId || channel.id
            }));
        }

        return {
            label: payload.scopeLabel,
            count: scopeChannels.length,
            payload
        };
    }

    async refreshPlaybackForChannels(channels = [], options = {}) {
        const unique = [];
        const seen = new Set();

        for (const channel of channels) {
            if (!channel) continue;
            const itemId = channel.streamId || channel.id;
            const key = `${channel.sourceId}:${itemId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(channel);
        }

        if (!unique.length) return null;

        const scopeKey = options.scopeKey || unique.map(channel => `${channel.sourceId}:${channel.streamId || channel.id}`).join('|');
        const cooldownMs = options.cooldownMs ?? 30000;
        const lastRefreshAt = this._lastPlaybackRefreshAt.get(scopeKey) || 0;
        if (!options.force && Date.now() - lastRefreshAt < cooldownMs) {
            return null;
        }

        this._lastPlaybackRefreshAt.set(scopeKey, Date.now());

        const label = options.label || `${unique.length} channel${unique.length > 1 ? 's' : ''}`;
        return this.runPlaybackScan({
            label,
            count: unique.length,
            payload: {
                scopeLabel: label,
                categoryName: options.categoryName || '',
                items: unique.map(channel => ({
                    sourceId: channel.sourceId,
                    itemId: channel.streamId || channel.id
                }))
            }
        }, {
            statusPrefix: options.statusPrefix || 'Refreshing',
            statusFailed: options.statusFailed || 'Refresh failed',
            allowReplace: options.allowReplace !== false
        });
    }

    updateScanScopeHint() {
        if (!this.scanPlaybackBtn) return;
        const scope = this.getLivePlaybackScanScope();
        this.scanPlaybackBtn.title = `Scan ${scope.label} (${scope.count} channels)`;
        if (this.scanStatusEl && !this._isScanningPlayback && !this.scanStatusEl.textContent) {
            this.scanStatusEl.textContent = `Scope: ${scope.label} (${scope.count})`;
        }
    }

    async followLivePlaybackScan(initialResult, requestedScope = null, runId = this._playbackScanRunId) {
        let progress = initialResult;
        let cursor = 0;
        let lastRenderAt = 0;

        while (progress && runId === this._playbackScanRunId) {
            if (requestedScope?.label && progress.scopeLabel && progress.scopeLabel !== requestedScope.label) {
                if (this.scanStatusEl) {
                    this.scanStatusEl.textContent = `Scan replaced: ${progress.scopeLabel}`;
                }
                break;
            }

            const entries = progress.entries || [];
            entries.forEach(entry => window.PlaybackHealth?.setStatus(entry));
            this.applyPlaybackEntries(entries);
            cursor = progress.nextCursor ?? cursor + entries.length;

            const now = Date.now();
            if (now - lastRenderAt > 1200 || progress.status !== 'running') {
                this.render();
                window.app?.liveGuideFusion?.render();
                lastRenderAt = now;
            }

            if (this.scanStatusEl && runId === this._playbackScanRunId) {
                const label = progress.scopeLabel ? `${progress.scopeLabel}: ` : '';
                this.scanStatusEl.textContent =
                    `${label}${progress.scanned || 0}/${progress.total || 0} scanned - ${progress.directHls || 0} Direct HLS / ${progress.transcodingAudio || 0} Transcoding / ${progress.broken || 0} HS`;
            }

            if (!progress.jobId || progress.status === 'complete' || progress.status === 'error') break;
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (runId !== this._playbackScanRunId) break;
            progress = await API.playbackStatus.getLiveModeScan(progress.jobId, cursor);
        }

        if (this.scanStatusEl && progress && runId === this._playbackScanRunId) {
            const label = progress.scopeLabel ? `${progress.scopeLabel}: ` : '';
            this.scanStatusEl.textContent = progress.status === 'complete'
                ? `${label}${progress.directHls || 0} Direct HLS / ${progress.transcodingAudio || 0} Transcoding OK / ${progress.broken || 0} HS`
                : 'Scan stopped';
        }
        if (runId === this._playbackScanRunId) {
            window.dispatchEvent(new CustomEvent('playbackModeScanComplete', { detail: progress }));
        }
    }

    /**
     * Load favorites
     */
    async loadFavorites() {
        try {
            // Get all favorites (filtered for channels or legacy items without type)
            const allFavs = await API.favorites.getAll();
            const channelFavs = allFavs.filter(f => !f.item_type || f.item_type === 'channel');

            this.visibleFavorites = new Set(
                channelFavs.map(f => `${f.source_id}:${f.item_id || f.channel_id}`)
            );
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    /**
     * Check if channel is favorite
     */
    isFavorite(sourceId, channelId) {
        return this.visibleFavorites.has(`${sourceId}:${channelId}`);
    }

    /**
     * Toggle favorite status
     */
    async toggleFavorite(sourceId, channelId) {
        const key = `${sourceId}:${channelId}`;
        const wasFavorite = this.visibleFavorites.has(key);

        // A consolidated row can represent one default variant while the
        // favorite target points to another variant from the same source.
        const btns = document.querySelectorAll(
            `.channel-item[data-source-id="${sourceId}"][data-channel-id="${channelId}"] .favorite-btn,` +
            `.channel-item[data-source-id="${sourceId}"][data-favorite-id="${channelId}"] .favorite-btn`
        );

        try {
            // Optimistic update
            if (wasFavorite) {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                    btn.title = 'Add to Favorites';
                });
            } else {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                    btn.title = 'Remove from Favorites';
                });
            }

            // Updates Favorites Group DOM
            const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
            if (channel) {
                this.updateFavoritesGroup(channel, !wasFavorite);
            }
            // Do NOT call this.render() - it causes lag

            // Perform API call
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // Sync to EPG Guide
            if (window.app?.epgGuide) {
                window.app.epgGuide.syncFavorite(sourceId, channelId, !wasFavorite);
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (wasFavorite) {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, true);
            } else {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, false);
            }
        }
    }

    /**
     * Update Favorites group in DOM and data
     */
    updateFavoritesGroup(channel, isAdded) {
        const groupName = CONSOLIDATED_LIVE_GROUPS.FAVORITES;
        const favoriteChannels = this.channels
            .filter(ch => this.isFavorite(ch.sourceId, ch.id))
            .filter(ch => this.isChannelVisibleInBrowse(ch, this.showHidden, { favoritesGroup: true }));
        const favArray = this.consolidateRawChannels(favoriteChannels, groupName);
        this.groupedChannels[groupName] = favArray;

        const groupHeader = this.listContainer?.querySelector(`.group-header[data-group="${groupName}"]`);
        if (!groupHeader) {
            if (isAdded && favArray.length > 0) this.render();
            return;
        }

        const groupEl = groupHeader.closest('.channel-group');
        const groupChannels = groupHeader.nextElementSibling; // .group-channels
        const countSpan = groupHeader.querySelector('.group-count');
        if (countSpan) countSpan.textContent = favArray.length;

        if (favArray.length === 0) {
            groupEl?.remove();
            return;
        }

        groupHeader.classList.remove('hidden');
        groupHeader.style.display = '';
        if (groupChannels && !this.collapsedGroups.has(groupName)) {
            this.renderGroupChannels(groupName, groupChannels);
        }
    }

    createChannelElement(channel) {
        const div = document.createElement('div');
        const isActive = this.currentChannel?.id === channel.id;
        // In Favorites group, it IS a favorite
        const isFavorite = true;
        const playbackClasses = this.getPlaybackClassNames(channel);

        div.className = `channel-item ${isActive ? 'active' : ''} ${playbackClasses}`;
        div.dataset.channelId = channel.id;
        div.dataset.sourceId = channel.sourceId;
        div.dataset.sourceType = channel.sourceType;
        div.dataset.streamId = channel.streamId || '';
        div.dataset.url = channel.url || '';

        div.innerHTML = `
            <img class="channel-logo" src="${this.getChannelLogoSrc(channel)}"
                 alt="" onerror="this.onerror=null;this.src='${this.getChannelLogoErrorSrc(channel)}'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.getProgramInfo(channel) || ''}</div>
            </div>
            <button class="favorite-btn active" title="Remove from Favorites">
              ❤️
            </button>
        `;

        // Attach listeners
        div.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;
            // Pass the render ID from the dataset
            this.selectChannel({ ...div.dataset, renderId: div.dataset.renderId });
        });
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', div.dataset));

        const favBtn = div.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(parseInt(div.dataset.sourceId), div.dataset.channelId);
            });
        }

        return div;
    }

    /**
     * Select and play a channel
     */
    async selectChannel(dataset) {
        const channel = this.channels.find(c =>
            c.id === dataset.channelId &&
            (!dataset.sourceId || String(c.sourceId) === String(dataset.sourceId))
        );
        if (!channel) return;
        const selectSeq = ++this._selectRequestSeq;

        // Stamp the zap start (user click) so the player can measure the full
        // perceived switch latency (click -> first frame) in telemetry.
        try { if (window.app?.player) window.app.player._liveZapStartedAt = Date.now(); } catch (_) {}

        this.currentChannel = channel;
        this.currentRenderId = dataset.renderId; // Track which visual instance is active
        this.currentRenderGroup = dataset.renderGroup; // Track which group the selection came from

        this.rememberLastLiveChannel(channel);
        this.rememberRecentChannel(channel);
        window.app?.liveGuideFusion?.setActiveChannel?.(channel);

        // Flat search/zero-state results: refresh the highlight only —
        // the group expansion / focus-mode logic below doesn't apply
        if (this.searchMode || this.zeroState) {
            this.container.querySelectorAll('.channel-item.active').forEach(el => el.classList.remove('active'));
            this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`)?.classList.add('active');
        } else {

        // Update active state in DOM
        this.container.querySelectorAll('.channel-item.active').forEach(el => {
            el.classList.remove('active');
            el.classList.remove('nav-active');
        });

        // Try to find specific render instance first
        let activeItem;
        activeItem = this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`);

        // If not found in DOM, it might be in a future batch not yet rendered
        // Render batches until we find it or run out
        if (!activeItem && this.renderedChannels.length > 0) {
            let safety = 0;
            while (!activeItem && this.currentBatch * this.batchSize < this.sortedGroups.length && safety < 20) {
                this.renderNextBatch();
                if (this.currentRenderId) {
                    activeItem = this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`);
                }
                safety++;
            }
        }

        // Fallback checks if still not found
        if (!activeItem) {
            activeItem = this.container.querySelector(`[data-channel-id="${channel.id}"]`);
            // If we fell back to channel ID, update currentRenderId to match what we found
            if (activeItem && activeItem.dataset.renderId) {
                this.currentRenderId = activeItem.dataset.renderId;
            }
        }

        if (activeItem) {
            activeItem.classList.add('active');
            activeItem.classList.add('nav-active'); // Add specific class for navigation tracking

            // Handle Group Expansion & Scrolling (Focus Mode)
            const groupHeader = activeItem.closest('.channel-group')?.querySelector('.group-header');
            if (groupHeader) {
                const groupName = groupHeader.dataset.group;

                // 1. Expand current group if needed
                if (this.collapsedGroups.has(groupName)) {
                    this.collapsedGroups.delete(groupName);
                    // Update DOM directly for immediate feedback
                    groupHeader.classList.remove('collapsed');
                    this.saveCollapsedState();
                }

                // 2. Collapse ALL other groups (Focus Mode)
                document.querySelectorAll('.group-header').forEach(header => {
                    if (header !== groupHeader && !header.classList.contains('collapsed')) {
                        const otherGroup = header.dataset.group;
                        this.collapsedGroups.add(otherGroup);
                        header.classList.add('collapsed');
                    }
                });
                this.saveCollapsedState();

                // 3. Scroll Group to Top
                // Use a small timeout to allow layout updates (e.g. collapse animations) to start
                setTimeout(() => {
                    groupHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Ensure active item is visible within the group
                    setTimeout(() => {
                        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 50);
                }, 50);
            } else {
                // Fallback for non-grouped items or flat list
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        } // end browse-mode DOM handling

        const resolveTask = (this._streamResolveQueue || Promise.resolve()).catch(() => { }).then(async () => {
            if (selectSeq !== this._selectRequestSeq) return;

            // Anti-hammer debounce: pause briefly before creating the provider
            // session. If you keep zapping, this selection is superseded and bails
            // HERE — so a rapid sweep through channels only opens ONE provider
            // connection (the channel you settle on), not one per channel surfed
            // past. Critical for single-slot providers that 403-block under a
            // connection storm. Superseded selections above already returned, so
            // only the latest pays the delay.
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (selectSeq !== this._selectRequestSeq) return;

            // Get stream URL
            let streamUrl;
            let staleSessionId = null;
            if (channel.sourceType === 'xtream') {
                // Get stream format from player settings (server-side) or fallback
                const providerContainer =
                    channel.container_extension ||
                    channel.containerExtension ||
                    channel.container ||
                    'ts';
                // Live H.264 → lightweight remux (copy video, transcode audio only);
                // H.265/HEVC → full transcode (browsers can't decode copied HEVC).
                // H.265/HEVC → full transcode; H.264 → remux. Live channels carry
                // no codec info up front, so an HEVC channel whose name doesn't say
                // "hevc" defaults to remux and fails to decode — once that happens
                // the player flags it here so it's transcoded on every later play.
                const transcodeKey = `${channel.sourceId}:${channel.id}`;
                // Default live path = provider HLS via the Cloudflare relay (no
                // Railway). Only channels the browser can't decode (flagged after a
                // failure) take the gateway transcode — liveForceTranscode skips the
                // relay-HLS attempt in api.getStreamUrl.
                const forceLiveTranscode = Boolean(this._forceTranscode && this._forceTranscode.has(transcodeKey));
                const gatewayMode = forceLiveTranscode
                    ? 'transcode'
                    : ((typeof MediaUtils !== 'undefined' && MediaUtils.liveGatewayMode)
                        ? MediaUtils.liveGatewayMode(channel)
                        : 'transcode');
                // Channel SWITCH: tear down the currently-playing channel BEFORE
                // creating the new gateway session. The provider grants one slot,
                // so creating the new session closes the old one; if the old
                // hls.js is still running it 404s on the just-deleted playlist and
                // triggers self-heal churn (a cascade of sessions that each kill
                // the previous — the broken-switch symptom). Stopping first makes a
                // switch behave like the fresh page-load case, which works.
                const switchPlayer = window.app?.player;
                if (switchPlayer && (switchPlayer.hls || switchPlayer.currentUrl) && typeof switchPlayer.prepareLiveSwitch === 'function') {
                    try { await switchPlayer.prepareLiveSwitch(); } catch (_) { /* best-effort */ }
                    if (selectSeq !== this._selectRequestSeq) return;
                }
                const result = await API.proxy.xtream.getStreamUrl(channel.sourceId, channel.streamId, 'live', providerContainer, {
                    gatewayMode,
                    ...(forceLiveTranscode ? { liveForceTranscode: '1' } : {})
                });
                streamUrl = result.url;
                channel.cloudPlaybackSessionId = result.sessionId || null;
                // Cloud source UUID resolved during session creation — used for
                // live telemetry (the player must send the UUID, not the local id).
                if (result.cloudSourceId) channel.cloudSourceId = result.cloudSourceId;
                staleSessionId = channel.cloudPlaybackSessionId;
            } else {
                streamUrl = channel.url;
                channel.cloudPlaybackSessionId = null;
            }

            if (selectSeq !== this._selectRequestSeq) {
                await this.expireStaleCloudPlaybackSession(staleSessionId);
                return;
            }

            // Attach the channel's quality variants so the player can build its
            // quality menu (all HD/FHD/4K/H265 feeds of the same logical channel).
            try {
                if (window.ChannelGrouping && this.channels && this.channels.length) {
                    const country = window.app?.player?.getCountry?.() || 'FR';
                    const grp = window.ChannelGrouping.variantsForChannel(channel, this.channels, country);
                    if (grp && grp.variants && grp.variants.length > 1) channel.qualityGroup = grp;
                }
            } catch (e) { /* grouping is best-effort */ }

            // Play channel
            if (window.app?.player) {
                await window.app.player.play(channel, streamUrl);
            }
        });
        this._streamResolveQueue = resolveTask.catch((err) => {
            console.error('[ChannelList] Failed to resolve live stream:', err);
            // Never leave an endless spinner: prepareLiveSwitch already tore down the
            // previous channel, so surface a clear message on ANY resolve failure.
            if (window.app?.player?.showError) {
                const msg = (err && err.liveProviderBackoff)
                    ? 'The provider is momentarily saturated (one connection at a time).<br>Try again in a few seconds.'
                    : "This channel isn't responding — the provider refused or timed out the connection (dead or unavailable channel).<br>Try another channel.";
                try { window.app.player.showError(msg); } catch (_) { /* best-effort */ }
            }
        });
        return this._streamResolveQueue;
    }

    async expireStaleCloudPlaybackSession(sessionId) {
        const id = sessionId ? String(sessionId).trim() : '';
        if (!id) return;
        try {
            await window.NorvaCloud?.playback?.expireSession?.(id);
        } catch (err) {
            console.warn('[ChannelList] Failed to expire stale playback session:', err?.message || err);
        }
    }

    /**
     * Show context menu
     */
    showContextMenu(e, type, data) {
        e.preventDefault();
        this.contextMenu.dataset.type = type;
        this.contextMenu.dataset.sourceId = data.sourceId;
        this.contextMenu.dataset.itemId = type === 'group' ? data.group : data.channelId;
        this.contextMenu.dataset.streamId = data.streamId || '';

        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
        this.contextMenu.classList.add('active');
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.contextMenu.classList.remove('active');
    }

    /**
     * Handle context menu action
     */
    async handleContextAction(e) {
        const action = e.target.dataset.action;
        const { type, sourceId, itemId, streamId } = this.contextMenu.dataset;

        switch (action) {
            case 'play':
                if (type === 'channel') {
                    const channel = this.channels.find(c => c.id === itemId);
                    if (channel) {
                        await this.selectChannel({ channelId: channel.id });
                    }
                }
                break;
            case 'hide':
                // Use streamId for hiding Xtream channels (raw ID, not composite)
                // Server expects 'channel' type, not 'live'
                const hideId = streamId || itemId;
                await API.channels.hide(parseInt(sourceId), 'channel', hideId);
                this.hiddenItems.add(`channel:${sourceId}:${hideId}`);
                this.render();
                break;
            case 'epg':
                // Show EPG info modal
                this.showEpgInfo(sourceId, itemId, streamId);
                break;
        }

        this.hideContextMenu();
    }

    /**
     * Show EPG info for a channel
     */
    showEpgInfo(sourceId, channelId, streamId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) {
            alert('Channel not found');
            return;
        }

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');

        if (!modal || !modalTitle || !modalBody) return;

        modalTitle.textContent = `📋 ${channel.name} - EPG Info`;

        // Get current and upcoming programs
        let programsHtml = '<p class="no-programs">No EPG data available for this channel.</p>';

        if (window.app?.epgGuide) {
            const tvgKey = channel.tvgId || channel.name;
            const currentProgram = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const programs = window.app.epgGuide.getChannelPrograms?.(tvgKey) || [];

            if (currentProgram || programs.length > 0) {
                programsHtml = '<div class="epg-program-list">';

                // Show current program
                if (currentProgram) {
                    const startTime = new Date(currentProgram.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                    const endTime = new Date(currentProgram.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                    programsHtml += `
                        <div class="epg-program current">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">▶ ${this.escapeHtml(currentProgram.title)}</div>
                            ${currentProgram.description ? `<div class="epg-program-desc">${this.escapeHtml(currentProgram.description)}</div>` : ''}
                        </div>
                    `;
                }

                // Show upcoming programs (next 5)
                const now = Date.now();
                const upcoming = programs
                    .filter(p => new Date(p.start).getTime() > now)
                    .slice(0, 5);

                upcoming.forEach(prog => {
                    const startTime = new Date(prog.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                    const endTime = new Date(prog.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                    programsHtml += `
                        <div class="epg-program">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">${this.escapeHtml(prog.title)}</div>
                        </div>
                    `;
                });

                programsHtml += '</div>';
            }
        }

        modalBody.innerHTML = `
            <div class="epg-info-modal">
                <div class="channel-details">
                    <img class="channel-logo" src="${this.getChannelLogoSrc(channel)}"
                         onerror="this.onerror=null;this.src='${this.getChannelLogoErrorSrc(channel)}'" />
                    <div class="channel-meta">
                        <p><strong>Group:</strong> ${this.escapeHtml(channel.groupTitle || 'Uncategorized')}</p>
                        <p><strong>Source:</strong> ${channel.sourceType}</p>
                        ${channel.tvgId ? `<p><strong>TVG ID:</strong> ${this.escapeHtml(channel.tvgId)}</p>` : ''}
                    </div>
                </div>
                <h4>Program Schedule</h4>
                ${programsHtml}
            </div>
        `;

        modal.classList.add('active');
    }

    /**
     * Sync favorite status from external source (e.g. EPG) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        const key = `${sourceId}:${channelId}`;
        const currentlyFav = this.visibleFavorites.has(key);

        if (currentlyFav === isFavorite) return; // No change needed

        // Update State
        if (isFavorite) {
            this.visibleFavorites.add(key);
        } else {
            this.visibleFavorites.delete(key);
        }

        // Update DOM (All instances)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        btns.forEach(btn => {
            if (isFavorite) {
                btn.classList.add('active');
                btn.innerHTML = '❤️';
                btn.title = 'Remove from Favorites';
            } else {
                btn.classList.remove('active');
                btn.innerHTML = '♡';
                btn.title = 'Add to Favorites';
            }
        });

        // Update Favorites Group
        const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
        if (channel) {
            this.updateFavoritesGroup(channel, isFavorite);
        }
    }

    /**
     * Select next channel in the current list
     */
    selectNextChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        // Try to find by render ID first (strict visual order)
        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + 1) % this.renderedChannels.length;
        const nextChannel = this.renderedChannels[nextIndex];

        this.selectChannel({
            channelId: nextChannel.id,
            sourceId: nextChannel.sourceId,
            sourceType: nextChannel.sourceType,
            streamId: nextChannel.streamId,
            url: nextChannel.url,
            renderId: nextChannel._renderId, // Pass the unique render ID
            renderGroup: nextChannel._renderGroup
        });
    }

    /**
     * Select previous channel in the current list
     */
    selectPrevChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const prevIndex = (currentIndex - 1 + this.renderedChannels.length) % this.renderedChannels.length;
        const prevChannel = this.renderedChannels[prevIndex];

        this.selectChannel({
            channelId: prevChannel.id,
            sourceId: prevChannel.sourceId,
            sourceType: prevChannel.sourceType,
            streamId: prevChannel.streamId,
            url: prevChannel.url,
            renderId: prevChannel._renderId,
            renderGroup: prevChannel._renderGroup
        });
    }

    /**
     * Show EPG info for channel
     */
    async showEpgInfo(channelId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) return;

        // This would show a modal with EPG info
        console.log('Show EPG for:', channel);
    }

    /**
     * Get list of visible (non-hidden) channels in display order
     */
    getVisibleChannels() {
        const showHidden = this.showHiddenCheckbox?.checked ?? false;
        return this.channels.filter(ch => {
            if (showHidden) return true;
            const channelHidden = this.isHidden('channel', ch.sourceId, ch.id);
            const groupHidden = this.isHidden('group', ch.sourceId, ch.groupTitle);
            return !channelHidden && !groupHidden;
        });
    }
}

// Export
window.ChannelList = ChannelList;
