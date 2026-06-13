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
        if (!url || url.length === 0) return '/img/placeholder.png';
        // Only proxy if we're on HTTPS and the image is HTTP
        if (window.location.protocol === 'https:' && url.startsWith('http://')) {
            return `/api/proxy/image?url=${encodeURIComponent(url)}`;
        }
        return url;
    }

    /**
     * Load collapsed state from localStorage
     */
    loadCollapsedState() {
        try {
            const saved = localStorage.getItem('norva_tv_collapsed_groups');
            if (saved) {
                this.collapsedGroups = new Set(JSON.parse(saved));
                this._hasCollapsedState = true;
            } else {
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
            if (!this.searchInput.value.trim()) this.showZeroState();
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
            if (event.detail?.item_type !== 'channel') return;
            const rawId = event.detail.item_id ?? event.detail.itemId;
            this.channels.forEach(channel => {
                if (String(channel.sourceId) === String(event.detail.source_id ?? event.detail.sourceId) &&
                    String(channel.streamId || channel.id) === String(rawId)) {
                    channel.playbackStatus = event.detail.status || channel.playbackStatus || 'unknown';
                    channel.playbackMode = event.detail.mode || channel.playbackMode || 'unknown';
                    channel.playbackCheckedAt = event.detail.updated_at || event.detail.updatedAt || channel.playbackCheckedAt || null;
                    channel.playbackModeCheckedAt = event.detail.mode_checked_at || event.detail.modeCheckedAt || channel.playbackModeCheckedAt || null;
                }
            });
            this.render();
            window.app?.liveGuideFusion?.render();
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

            // Find the channel data
            const channel = this.channels.find(c =>
                String(c.id) === String(channelId) &&
                String(c.sourceId) === String(sourceId)
            );

            if (channel) {
                const programInfo = this.getProgramInfo(channel);
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

        // Group channels
        const groupedChannels = {};

        this.filteredChannels = this.channels.filter(ch => !this.hideBroken || !this.shouldHideByPlayback(ch));
        let filteredChannels = this.filteredChannels;

        // 2. Group
        filteredChannels.forEach(ch => {
            const groupKey = ch.groupTitle || 'Uncategorized';
            if (!groupedChannels[groupKey]) {
                groupedChannels[groupKey] = [];
            }
            groupedChannels[groupKey].push(ch);
        });

        // 3. Add Favorites
        const favoritedChannels = this.channels.filter(ch =>
            this.isFavorite(ch.sourceId, ch.id) && (!this.hideBroken || !this.shouldHideByPlayback(ch)));
        if (favoritedChannels.length > 0) {
            favoritedChannels.sort((a, b) => a.name.localeCompare(b.name));
            groupedChannels['Favorites'] = favoritedChannels;
        }

        // 4. Sort Groups and filter to only those with visible channels
        const allGroups = Object.keys(groupedChannels).sort((a, b) => {
            if (a === 'Favorites') return -1;
            if (b === 'Favorites') return 1;
            return a.localeCompare(b);
        });

        // Pre-filter to only include groups with visible channels (so hidden groups don't consume batch slots)
        this.sortedGroups = allGroups.filter(groupName => {
            if (groupName === 'Favorites') return true;
            const channels = groupedChannels[groupName];
            // Check if any channel in this group is visible
            return channels.some(channel => {
                const rawChannelId = channel.streamId || channel.id;
                const isHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                const shouldHideByPlayback = this.shouldHideByPlayback(channel);
                return (!isHidden || showHidden) && (!this.hideBroken || !shouldHideByPlayback);
            });
        });

        this.groupedChannels = groupedChannels;
        this.showHidden = showHidden;

        // Collapse all groups by default on first load (for large playlists)
        // This prevents rendering 100K+ channel items on initial load
        if (!this._hasCollapsedState && this.sortedGroups.length > 0) {
            this.sortedGroups.forEach(groupName => {
                if (groupName !== 'Favorites') {
                    this.collapsedGroups.add(groupName);
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
                if (isFavoritesGroup) return true;
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return (!channelHidden || this.showHidden) && (!this.hideBroken || !this.shouldHideByPlayback(channel));
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
          <p class="hint">Add a source in Settings to get started</p>
        </div>
      `;
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

        let renderIndex = start; // Keep track of global index for mapping to renderedChannels

        for (const groupName of groupsToRender) {
            const channels = this.groupedChannels[groupName];
            if (channels.length === 0) continue;

            const isFavoritesGroup = groupName === 'Favorites';

            // Pre-filter visible channels for this group
            const visibleChannels = channels.filter(channel => {
                if (isFavoritesGroup) return true;
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return (!channelHidden || this.showHidden) && (!this.hideBroken || !this.shouldHideByPlayback(channel));
            });

            // Skip group if no visible channels (derived visibility)
            if (visibleChannels.length === 0) continue;

            // Default new groups to collapsed (except Favorites)
            // This handles groups loaded via scroll that weren't in the initial collapse
            if (!isFavoritesGroup && !this.collapsedGroups.has(groupName) && !this._userExpandedGroups?.has(groupName)) {
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
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);

                const isActive = this.currentChannel?.id === channel.id;
                // Check if this specific instance is the "active" one for navigation purposes
                const isRenderActive = this.currentRenderId && this.renderedChannels[renderIndex]?._renderId === this.currentRenderId;

                const isFavorite = this.isFavorite(channel.sourceId, channel.id);
                const playbackClasses = this.getPlaybackClassNames(channel);
                const renderId = this.renderedChannels[renderIndex]?._renderId || '';
                const renderGroup = this.renderedChannels[renderIndex]?._renderGroup || groupName;
                renderIndex++;

                html += `
          <div class="channel-item ${isActive ? 'active' : ''} ${isRenderActive ? 'nav-active' : ''} ${channelHidden ? 'hidden' : ''} ${playbackClasses}" 
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}"
               data-render-id="${renderId}"
               data-render-group="${renderGroup}">
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
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
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
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
            if (isFavoritesGroup) return true;
            const rawChannelId = channel.streamId || channel.id;
            const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
            return (!channelHidden || this.showHidden) && (!this.hideBroken || !this.shouldHideByPlayback(channel));
        });

        let html = '';
        for (const channel of visibleChannels) {
            const rawChannelId = channel.streamId || channel.id;
            const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);
            const isActive = this.currentChannel?.id === channel.id;
            const isFavorite = this.isFavorite(channel.sourceId, channel.id);
            const playbackClasses = this.getPlaybackClassNames(channel);

            // Find the matching rendered channel to get its unique IDs
            const renderedChannel = this.renderedChannels.find(rc =>
                rc.id === channel.id && rc.sourceId === channel.sourceId && rc._renderGroup === groupName
            );
            const renderId = renderedChannel?._renderId || '';
            const renderGroup = renderedChannel?._renderGroup || groupName;

            html += `
          <div class="channel-item ${isActive ? 'active' : ''} ${channelHidden ? 'hidden' : ''} ${playbackClasses}" 
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}"
               data-render-id="${renderId}"
               data-render-group="${renderGroup}">
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
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
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
                });
            }
        });
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
        } else if (document.activeElement === this.searchInput) {
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
            <img class="channel-logo" src="${this.getProxiedImageUrl(ch.tvgLogo)}"
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
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
                await this.loadXtreamChannels(parseInt(id));
            } else if (type === 'm3u') {
                await this.loadM3uChannels(parseInt(id));
            }

            // Load hidden items and favorites
            await Promise.all([
                this.loadHiddenItems(),
                this.loadFavorites(),
                this.loadPlaybackStatuses()
            ]);

            this.render();
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
        this.channels = [];
        this.groups = [];

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);
            console.log('[ChannelList] loadAllChannels: xtream=', xtreamSources.length, 'm3u=', m3uSources.length);

            for (const source of xtreamSources) {
                await this.loadXtreamChannels(source.id, true);
            }

            for (const source of m3uSources) {
                await this.loadM3uChannels(source.id, true);
            }

            await Promise.all([
                this.loadHiddenItems(),
                this.loadFavorites(),
                this.loadPlaybackStatuses()
            ]);
            this.render();
        } catch (err) {
            console.error('Error loading all channels:', err);
        }
    }

    /**
     * Load Xtream channels
     */
    async loadXtreamChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        const categories = await API.proxy.xtream.liveCategories(sourceId);
        const streams = await API.proxy.xtream.liveStreams(sourceId);

        // Map categories to groups
        const categoryGroups = categories.map(cat => ({
            id: `xtream_${sourceId}_${cat.category_id}`,
            name: cat.category_name,
            sourceId,
            sourceType: 'xtream'
        }));

        this.groups = this.groups.concat(categoryGroups);

        // Map streams to channels
        const channelList = streams.map(stream => ({
            id: `xtream_${sourceId}_${stream.stream_id}`,
            streamId: stream.stream_id,
            name: stream.name,
            num: stream.num ?? null, // channel number (for digit zapping in search)
            tvgId: stream.epg_channel_id,
            tvgLogo: stream.stream_icon,
            groupId: `xtream_${sourceId}_${stream.category_id}`,
            // Use string comparison to handle type mismatches (number vs string category_id)
            groupTitle: categories.find(c => String(c.category_id) === String(stream.category_id))?.category_name || 'Uncategorized',
            sourceId,
            sourceType: 'xtream',
            playbackStatus: stream.playback_status || 'unknown',
            playbackMode: stream.playback_mode || 'unknown',
            playbackCheckedAt: stream.playback_checked_at || null,
            playbackModeCheckedAt: stream.playback_mode_checked_at || null
        }));

        this.channels = this.channels.concat(channelList);
    }

    /**
     * Load M3U channels
     * Now uses unified Xtream-style API endpoints (backend supports both source types)
     */
    async loadM3uChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        // Use Xtream API endpoints - backend now supports M3U sources too
        const categories = await API.proxy.xtream.liveCategories(sourceId);
        const streams = await API.proxy.xtream.liveStreams(sourceId);

        // Map categories to groups (keeping m3u sourceType for downstream compatibility)
        const m3uGroups = categories.map(cat => ({
            id: `m3u_${sourceId}_${cat.category_id}`,
            name: cat.category_name,
            sourceId,
            sourceType: 'm3u'
        }));

        this.groups = this.groups.concat(m3uGroups);

        // Map streams to channels
        const channelList = streams.map(stream => ({
            id: `m3u_${sourceId}_${stream.stream_id}`,
            streamId: stream.stream_id,
            name: stream.name,
            tvgId: stream.epg_channel_id,
            tvgLogo: stream.stream_icon,
            url: stream.stream_url, // M3U has direct URLs
            groupId: `m3u_${sourceId}_${stream.category_id}`,
            groupTitle: categories.find(c => String(c.category_id) === String(stream.category_id))?.category_name || 'Uncategorized',
            sourceId,
            sourceType: 'm3u',
            playbackStatus: stream.playback_status || 'unknown',
            playbackMode: stream.playback_mode || 'unknown',
            playbackCheckedAt: stream.playback_checked_at || null,
            playbackModeCheckedAt: stream.playback_mode_checked_at || null
        }));

        this.channels = this.channels.concat(channelList);
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
                ? 'Favoris'
                : isCategory
                    ? activeGroup
                    : 'Toutes les chaines'
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

        const label = options.label || `${unique.length} chaine${unique.length > 1 ? 's' : ''}`;
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

        // Find all buttons for this channel in the DOM (it may appear in multiple groups)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

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
        // 1. Update Data
        if (!this.groupedChannels['Favorites']) {
            this.groupedChannels['Favorites'] = [];
        }

        const favArray = this.groupedChannels['Favorites'];
        const existingIdx = favArray.findIndex(c => c.id === channel.id && c.sourceId === channel.sourceId);

        if (isAdded) {
            if (existingIdx === -1) favArray.push(channel);
        } else {
            if (existingIdx !== -1) favArray.splice(existingIdx, 1);
        }

        // 2. Update DOM
        const groupHeader = this.listContainer.querySelector('.group-header[data-group="Favorites"]');

        if (!groupHeader) {
            // If group doesn't exist and we're adding, we ideally should create it
            // For now, simpler to just return. User will see it on next refresh.
            // Or we could force a re-render if it's the first favorite? 
            if (isAdded && favArray.length === 1) {
                this.render(); // This is the one case where full render is worth it
            }
            return;
        }

        const groupChannels = groupHeader.nextElementSibling; // .group-channels
        const countSpan = groupHeader.querySelector('.group-count');

        if (isAdded) {
            // Check if already in DOM (to avoid dupes)
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (!existingEl) {
                const newEl = this.createChannelElement(channel);
                groupChannels.appendChild(newEl);
            }
        } else {
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (existingEl) {
                existingEl.remove();
            }
        }

        // Update count
        if (countSpan) countSpan.textContent = favArray.length;

        // Hide/Show group if empty?
        if (favArray.length === 0) {
            groupHeader.classList.add('hidden'); // Or remove
            groupHeader.style.display = 'none';
        } else {
            groupHeader.classList.remove('hidden');
            groupHeader.style.display = '';
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
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
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
        const channel = this.channels.find(c => c.id === dataset.channelId);
        if (!channel) return;

        this.currentChannel = channel;
        this.currentRenderId = dataset.renderId; // Track which visual instance is active
        this.currentRenderGroup = dataset.renderGroup; // Track which group the selection came from

        this.rememberRecentChannel(channel);

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

        // Get stream URL
        let streamUrl;
        if (channel.sourceType === 'xtream') {
            // Get stream format from player settings (server-side) or fallback
            const streamFormat = window.app?.player?.settings?.streamFormat || 'm3u8';
            const result = await API.proxy.xtream.getStreamUrl(channel.sourceId, channel.streamId, 'live', streamFormat);
            streamUrl = result.url;
        } else {
            streamUrl = channel.url;
        }

        // Play channel
        if (window.app?.player) {
            window.app.player.play(channel, streamUrl);
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
                    const startTime = new Date(currentProgram.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(currentProgram.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
                    const startTime = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(prog.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
                    <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" />
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
            renderId: nextChannel._renderId // Pass the unique render ID
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
            renderId: prevChannel._renderId
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
