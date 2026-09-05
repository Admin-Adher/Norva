/**
 * TiviMate-style Live TV guide embedded in the Live page.
 */
class LiveGuideFusion {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('live-guide-fusion');
        this.activeGroup = localStorage.getItem('norva_live_guide_group') || '';
        this.currentChannel = null;       // the channel SELECTED/previewed in the guide
        this._lastChannelsKey = '';
        this._renderScheduled = false;    // coalesce bursty re-renders (EPG arrivals)
        this._pendingFamilySelection = null;
        this.searchQuery = '';            // inline channel filter (phone/tablet APK)
        this._searchTimer = null;
        this._remoteSearchTimer = null;   // debounce for the mobile all-sources server search
        this._remoteSearchSeq = 0;        // sequence guard to drop stale remote-search responses
        this.BASE_ROW_LIMIT = 48;         // phone/web rows rendered up-front; "Show more" grows it
        this.TV_ROW_LIMIT = 60;           // preserve the proven 10-foot D-pad first chunk
        this._rowLimit = this.BASE_ROW_LIMIT;
        this._cinema = false;             // cinema mode: player enlarged, guide compacted
        this.shortEpgCache = new Map();
        this.shortEpgLoadedAt = new Map();
        this.shortEpgInflight = new Set();
        this.shortEpgSourceCooldown = new Map();
        this.shortEpgSourceFailures = new Map();
        this.init();
    }

    init() {
        if (!this.container) return;

        this.container.addEventListener('click', (event) => {
            const groupBtn = event.target.closest('.live-guide-group');
            if (groupBtn) {
                this.activeGroup = groupBtn.dataset.group || '';
                localStorage.setItem('norva_live_guide_group', this.activeGroup);
                this._rowLimit = this.BASE_ROW_LIMIT;   // new group starts at the base cap
                this.render();
                this.refreshBrokenChannelsInActiveGroup();
                return;
            }

            // Inline toolbar (phone/tablet APK): Hide-broken toggle + search clear.
            if (event.target.closest('.live-guide-hidebroken')) { this.toggleHideBroken(); return; }
            if (event.target.closest('.live-guide-search-clear')) { this.clearSearch(); return; }

            // Preview-bar actions (operate on the currently selected channel).
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'watch') { this.playCurrent(); return; }
            if (action === 'fullscreen') { this.app.player?.toggleFullscreen?.(); return; }
            if (action === 'favorite') { this.toggleSelectedFavorite(); return; }
            if (action === 'cinema') { this.toggleCinema(); return; }
            if (action === 'epg') {
                // TV "TV Guide" button → jump into the channel/EPG list below the card.
                const firstRow = this.container.querySelector('.live-guide-rows .live-guide-row');
                if (firstRow) { firstRow.scrollIntoView({ block: 'center', behavior: 'smooth' }); firstRow.focus?.(); }
                return;
            }
            if (action === 'show-more') { this.showMoreRows(); return; }
            if (action === 'open-source-sheet') {
                this.openSourceSheet(event.target.closest('[data-action="open-source-sheet"]'));
                return;
            }
            if (action === 'reload-live') {
                const btn = event.target.closest('[data-action="reload-live"]');
                if (btn) { btn.disabled = true; btn.textContent = (globalThis.NorvaI18n?.t("ui_web_ba3bbbe10d8b", { defaultValue: "Loading…" }) ?? 'Loading…'); }
                this.app.channelList?.reloadLive?.();
                return;
            }

            // The ▶ button plays immediately; tapping the row body only previews.
            const playBtn = event.target.closest('.live-guide-play');
            if (playBtn) {
                const playRow = playBtn.closest('.live-guide-row');
                if (playRow) this.playFamilyRow(playRow);
                return;
            }
            const row = event.target.closest('.live-guide-row');
            if (row) this.previewFamilyRow(row);
        });

        // Keyboard/remote OK on a row:
        //  • Android TV — OK plays immediately (the 10-foot intent is to watch; focus
        //    already previews as you navigate, see focusin below).
        //  • Web/desktop — Enter previews (matches a mouse tap; the ▶ button watches).
        // The ▶ button is a real <button> and handles its own activation.
        this.container.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.target.closest('.live-guide-play, .live-guide-group, [data-action]')) return;
            const row = event.target.closest('.live-guide-row');
            if (row) {
                event.preventDefault();
                if (this._isTvMode()) this.playFamilyRow(row);
                else this.previewFamilyRow(row);
            }
        });

        // Android TV: moving D-pad focus across rows updates the preview panel (no
        // stream) so the viewer sees what's on before pressing OK. Scoped to TV — on
        // web, focusing a row via Tab should not hijack the preview.
        this.container.addEventListener('focusin', (event) => {
            if (!this._isTvMode()) return;
            const row = event.target.closest('.live-guide-row');
            if (!row) {
                // Focus moved OFF the channel rows (e.g. D-pad up onto the Watch /
                // Favorite buttons in the preview). Kill any armed row-preview timer
                // so it can't fire ~140ms later and replace the preview — which would
                // destroy the button that just took focus, drop D-pad focus to <body>,
                // and make navigation "block" until you press again. (refreshPreview /
                // render also restore preview-button focus as a backstop.)
                clearTimeout(this._previewDebounce);
                this._previewDebounce = null;
                this._pendingPreviewRow = null;
                return;
            }
            // DEBOUNCE: previewing runs renderPreview (an EPG scan) synchronously, so
            // doing it on every focus made D-pad navigation lag 1-10s (each move, and
            // moves stack). Only preview the row the viewer actually lands on: reset a
            // short timer on each focus so flying through rows costs nothing.
            this._pendingPreviewRow = row;
            clearTimeout(this._previewDebounce);
            this._previewDebounce = setTimeout(() => {
                const target = this._pendingPreviewRow;
                if (target && target.isConnected) this.previewFamilyRow(target);
            }, 140);
        });

        // Inline channel filter (phone/tablet APK): filter rows as you type without
        // a full guide re-render — keeps input focus and beats the 150-row cap by
        // re-rendering only the rows from the full filtered set.
        this.container.addEventListener('input', (event) => {
            if (!event.target.classList.contains('live-guide-search')) return;
            this.searchQuery = event.target.value || '';
            this._rowLimit = this.BASE_ROW_LIMIT;   // a new query starts at the base cap
            clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => this.refreshRows(), 100);
            // Parity with the desktop sidebar: also fan out an all-sources server query so the
            // guide isn't limited to the lazily-hydrated in-memory set (the "1/1"-badge symptom).
            this.scheduleRemoteSearch(this.searchQuery);
        });

        window.addEventListener('channelChanged', (event) => {
            this.setActiveChannel(event.detail || null);
        });
        window.addEventListener('playbackModeScanComplete', (event) => {
            this.selectPendingFamilyIfReady(event.detail);
            this.render();
        });
        window.addEventListener('playbackStatusChanged', (event) => this.refreshPlaybackStatus(event.detail));
    }

    _isTvMode() {
        return document.documentElement.classList.contains('tv-mode')
            || document.body.classList.contains('tv-mode');
    }

    shouldShowGroupRail() {
        const layout = document.querySelector('.home-layout');
        if (!layout) return true;
        return !layout.classList.contains('sidebar-open');
    }

    syncNavigationState() {
        if (!this.container) return;
        const hideGroups = !this.shouldShowGroupRail();
        this.container.classList.toggle('live-guide-groups-hidden', hideGroups);
        this.container.querySelector('.live-guide-shell')?.classList.toggle('groups-hidden', hideGroups);
    }

    escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    getProxiedImageUrl(url) {
        return this.app.channelList.getProxiedImageUrl(url);
    }

    getChannelLogoSrc(channel) {
        return this.app.channelList.getChannelLogoSrc
            ? this.app.channelList.getChannelLogoSrc(channel)
            : this.getProxiedImageUrl(channel?.tvgLogo);
    }

    getChannelLogoErrorSrc(channel) {
        return this.app.channelList.getChannelLogoErrorSrc
            ? this.app.channelList.getChannelLogoErrorSrc(channel || 'TV')
            : '/img/placeholder.png';
    }

    decodeBase64(value) {
        if (!value) return '';
        try {
            const decoded = atob(String(value));
            return decodeURIComponent(escape(decoded));
        } catch (_) {
            try {
                return atob(String(value));
            } catch (__) {
                return String(value);
            }
        }
    }

    findChannel(channelId, sourceId) {
        return (this.app.channelList.channels || []).find(channel =>
            String(channel.id) === String(channelId) &&
            String(channel.sourceId) === String(sourceId)
        );
    }

    getFamilyMembersFromRow(row) {
        const channel = this.findChannel(row.dataset.channelId, row.dataset.sourceId);
        if (!channel) return [];
        return this.app.channelList.getChannelFamilyMembers(channel, {
            includeHidden: false,
            includeCurrent: true,
            sameSourceOnly: true
        });
    }

    /** Tap on the row body: select + preview the family, but DON'T start a stream. */
    previewFamilyRow(row) {
        const members = this.getFamilyMembersFromRow(row);
        if (!members.length) return;
        const best = this.getBestFamilyChannel(members);
        this.currentChannel = best;
        this.refreshPreview(best);
        this.updateHighlights();
    }

    /** Tap on a row's ▶ button: select + play (the old one-tap behaviour). */
    playFamilyRow(row) {
        const members = this.getFamilyMembersFromRow(row);
        if (!members.length) return;
        this.playSelection(members);
    }

    /** The preview bar's "Watch" button: play the currently selected family. */
    playCurrent() {
        const channel = this.currentChannel;
        if (!channel) return;
        const members = this.app.channelList.getChannelFamilyMembers(channel, {
            includeHidden: false,
            includeCurrent: true,
            sameSourceOnly: true
        });
        this.playSelection(members.length ? members : [channel]);
    }

    /** Shared play path: pick the best variant, kick a scan if all known bad. */
    playSelection(members) {
        const bestChannel = this.getBestFamilyChannel(members);
        const hasHealthyVariant = members.some(channel => this.app.channelList.isHealthyChannel(channel));
        const allKnownBad = members.every(channel => this.isProblematicChannel(channel));

        this.currentChannel = bestChannel;
        this.refreshPreview(bestChannel);
        this.updateHighlights();

        if (!hasHealthyVariant && allKnownBad) {
            this._pendingFamilySelection = {
                sourceId: String(bestChannel.sourceId),
                familyKey: this.app.channelList.getChannelFamilyKey(bestChannel),
                label: this.app.channelList.getChannelFamilyLabel(bestChannel) || bestChannel.name
            };
            this.scheduleRender();
            this.refreshFamilyIfNeeded(bestChannel, members, { force: true });
            return;
        }

        this.refreshFamilyIfNeeded(bestChannel, members);
        this.playChannel(bestChannel);
    }

    /** Toggle the selected channel as a favourite (from the preview bar). */
    toggleSelectedFavorite() {
        const channel = this.currentChannel;
        if (!channel) return;
        Promise.resolve(this.app.channelList.toggleFavorite(channel.sourceId, channel.id))
            .then(() => { this.refreshPreview(this.currentChannel); this.updateHighlights(); })
            .catch(err => console.warn('Favorite toggle failed:', err));
    }

    playChannel(channel) {
        this.app.channelList.selectChannel({
            channelId: channel.id,
            sourceId: String(channel.sourceId),
            sourceType: channel.sourceType,
            streamId: channel.streamId || '',
            url: channel.url || '',
            renderGroup: this.activeGroup || channel.groupTitle || 'Guide'
        });
    }

    selectPendingFamilyIfReady(scanProgress = null) {
        const pending = this._pendingFamilySelection;
        if (!pending) return;

        const members = (this.app.channelList.channels || []).filter(channel =>
            String(channel.sourceId) === pending.sourceId &&
            this.app.channelList.getChannelFamilyKey(channel) === pending.familyKey
        );
        const healthyMembers = members.filter(channel => this.app.channelList.isHealthyChannel(channel));
        if (!healthyMembers.length) {
            if (scanProgress?.status === 'complete' || scanProgress?.status === 'error') {
                this._pendingFamilySelection = null;
            }
            return;
        }

        this._pendingFamilySelection = null;
        this.playChannel(this.getBestFamilyChannel(healthyMembers));
    }

    getPlayableChannels() {
        const list = this.app.channelList;
        return (list.channels || []).filter(channel => {
            const rawId = channel.streamId || channel.id;
            if (list.isHidden('channel', channel.sourceId, rawId)) return false;
            if (list.hideBroken && list.shouldHideByPlayback(channel)) return false;
            return true;
        });
    }

    getGroups(channels) {
        const groups = [];
        const seen = new Set();
        const hasFavorites = channels.some(channel => this.app.channelList.isFavorite(channel.sourceId, channel.id));

        if (hasFavorites) {
            groups.push({ id: 'Favorites', name: (globalThis.NorvaI18n?.t('ui_web_7a1f2a83aca9', { defaultValue: "Favorites" }) ?? 'Favorites') });
        }
        groups.push({ id: '', name: (globalThis.NorvaI18n?.t('ui_web_4b33d5e03e53', { defaultValue: "All channels" }) ?? 'All channels') });

        for (const channel of channels) {
            const group = channel.groupTitle || 'Uncategorized';
            if (!seen.has(group)) {
                seen.add(group);
                groups.push({ id: group, name: group });
            }
        }
        return groups;
    }

    ensureActiveGroup(groups) {
        const ids = new Set(groups.map(group => group.id));
        if (ids.has(this.activeGroup)) return;
        if (ids.has('FRANCE HD')) {
            this.activeGroup = 'FRANCE HD';
        } else if (ids.has('Favorites')) {
            this.activeGroup = 'Favorites';
        } else {
            this.activeGroup = '';
        }
        localStorage.setItem('norva_live_guide_group', this.activeGroup);
    }

    filterGroup(channels) {
        if (this.activeGroup === 'Favorites') {
            return channels.filter(channel => this.app.channelList.isFavorite(channel.sourceId, channel.id));
        }
        if (!this.activeGroup) return channels;
        return channels.filter(channel => (channel.groupTitle || 'Uncategorized') === this.activeGroup);
    }

    isProblematicChannel(channel) {
        if (!channel) return false;
        const list = this.app.channelList;
        return list.isBrokenChannel(channel) || list.isDirectHlsChannel(channel);
    }

    isFamilyActive(family) {
        const current = this.app.channelList.currentChannel;
        if (!current || !family?.members?.length) return false;
        return family.members.some(channel =>
            channel.id === current.id && String(channel.sourceId) === String(current.sourceId)
        );
    }

    isPendingFamily(family) {
        const pending = this._pendingFamilySelection;
        if (!pending || !family) return false;
        return String(family.sourceId) === pending.sourceId && family.familyKey === pending.familyKey;
    }

    getAutoStartQualityRank(channel) {
        const name = String(channel?.name || '').toLowerCase();
        if (/\b4k\b|\buhd\b/.test(name)) return 4;
        if (/\bfhd\b|full\s*hd|super\s*hd|superhd/.test(name)) return 1;
        if (/\bhd\b/.test(name)) return 0;
        if (/\bsd\b/.test(name)) return 2;
        return 1;
    }

    refreshPreview(channel) {
        if (!this.container) return;
        const preview = this.container.querySelector('.live-guide-preview');
        if (!preview) return;
        // TV: if a preview action button (Watch / Favorite) currently holds D-pad
        // focus, replacing the preview's outerHTML destroys it and focus falls to
        // <body>, which blocks the D-pad until you press again. Remember which action
        // was focused and put focus back on the equivalent new button after the swap.
        const focusedAction = (this._isTvMode() && preview.contains(document.activeElement))
            ? document.activeElement.closest('[data-action]')?.getAttribute('data-action')
            : null;
        preview.outerHTML = this.renderPreview(channel);
        if (focusedAction) {
            const fresh = this.container.querySelector(`.live-guide-preview [data-action="${focusedAction}"]`);
            if (fresh) fresh.focus({ preventScroll: true });
        }
        if (this._isTvMode()) this._updateTvLiveArt(channel);
    }

    /**
     * Android TV: paint the focused channel's logo + name into the 16:9 preview box
     * as STATIC art. The WebView pops native fullscreen when the inline <video> plays,
     * so an inline preview just spins — instead we show the channel art and OK plays
     * fullscreen. No-op off TV (the overlay stays display:none there).
     */
    _updateTvLiveArt(channel) {
        const art = document.getElementById('tv-live-art');
        if (!art) return;
        if (!channel) { art.classList.add('hidden'); return; }
        const img = document.getElementById('tv-live-art-logo');
        const name = document.getElementById('tv-live-art-name');
        if (img) {
            const fallback = this.getChannelLogoErrorSrc(channel);
            const logo = this.getChannelLogoSrc(channel);
            img.onerror = () => {
                img.onerror = null;
                if (fallback) { img.src = fallback; } else { img.style.display = 'none'; }
            };
            if (logo) { img.style.display = ''; img.src = logo; }
            else { img.style.display = 'none'; }
        }
        if (name) name.textContent = channel.name || channel.title || '';
        art.classList.remove('hidden');
    }

    /** Playback changed (channelChanged event): follow it in the preview + highlights. */
    setActiveChannel(channel) {
        if (!this.container) return;
        if (channel) {
            this.currentChannel = channel;
            this.refreshPreview(channel);
        }
        this.updateHighlights();
    }

    /** Reflect both the previewed selection (.selected) and what's actually playing (.playing). */
    updateHighlights() {
        if (!this.container) return;
        const list = this.app.channelList;
        const keyOf = (channel) => channel
            ? `${channel.sourceId}|${list.getChannelFamilyKey(channel) || `${channel.sourceId}:${channel.id}`}`
            : null;
        const selectedKey = keyOf(this.currentChannel);
        const playingKey = keyOf(list.currentChannel);
        this.container.querySelectorAll('.live-guide-row').forEach(row => {
            const key = `${row.dataset.sourceId}|${row.dataset.familyKey}`;
            row.classList.toggle('selected', selectedKey != null && key === selectedKey);
            row.classList.toggle('playing', playingKey != null && key === playingKey);
        });
    }

    isFamilySelected(family) {
        const current = this.currentChannel;
        if (!current || !family?.members?.length) return false;
        return family.members.some(channel =>
            channel.id === current.id && String(channel.sourceId) === String(current.sourceId)
        );
    }

    /** Coalesce bursty re-renders (e.g. many short-EPG fetches landing at once). */
    scheduleRender() {
        if (this._renderScheduled) return;
        this._renderScheduled = true;
        setTimeout(() => {
            this._renderScheduled = false;
            this.render();
        }, 120);
    }

    updateRowBadge(row, badge) {
        let el = row.querySelector('.live-guide-mode');
        if (!badge) {
            el?.remove();
            return;
        }
        if (!el) {
            el = document.createElement('span');
            row.querySelector('.live-guide-name-row')?.appendChild(el);
        }
        el.className = `live-guide-mode ${badge.className || ''}`.trim();
        el.title = badge.title || '';
        el.textContent = badge.label || '';
    }

    refreshPlaybackStatus(detail = {}) {
        if (!this.container) return;
        const itemType = detail?.item_type || detail?.itemType;
        if (itemType && itemType !== 'channel' && itemType !== 'live') return;

        const rawId = detail.item_id ?? detail.itemId;
        const sourceId = detail.source_id ?? detail.sourceId;
        if (rawId == null || sourceId == null) return;

        const list = this.app.channelList;
        const affected = (list.channels || []).find(channel =>
            String(channel.sourceId) === String(sourceId) &&
            (String(channel.streamId || channel.id) === String(rawId) || String(channel.id) === String(rawId))
        );
        if (!affected) return;

        const familyKey = list.getChannelFamilyKey(affected) || `${affected.sourceId}:${affected.id}`;
        const members = (list.channels || []).filter(channel =>
            String(channel.sourceId) === String(sourceId) &&
            (list.getChannelFamilyKey(channel) || `${channel.sourceId}:${channel.id}`) === familyKey
        );
        const family = {
            sourceId: affected.sourceId,
            familyKey,
            members
        };
        const isPending = this.isPendingFamily(family);
        const badge = isPending
            ? { label: (globalThis.NorvaI18n?.t("ui_web_7a1580c49e45", { defaultValue: "SCAN" }) ?? 'SCAN'), className: 'pending', title: (globalThis.NorvaI18n?.t("ui_web_215306a5a33d", { defaultValue: "Checking variants" }) ?? 'Checking variants') }
            : this.getFamilyBadge(family);

        this.container.querySelectorAll('.live-guide-row').forEach(row => {
            if (String(row.dataset.sourceId) !== String(sourceId)) return;
            if (String(row.dataset.familyKey) !== String(familyKey)) return;
            row.classList.toggle('pending-refresh', isPending);
            row.classList.toggle('playing', this.isFamilyActive(family) || isPending);
            this.updateRowBadge(row, badge);
        });
    }

    getVariantQualityScore(channel) {
        const list = this.app.channelList;
        const name = String(channel?.name || '').toLowerCase();
        const mode = list.getPlaybackMode(channel);
        let score = 0;

        if (list.isHealthyChannel(channel)) score += 10000;
        if (mode === 'transcoding_audio') score += 6000;
        if (mode === 'direct_play') score += 3000;
        if (this.isProblematicChannel(channel)) score -= 10000;

        score += Math.max(0, 500 - (this.getAutoStartQualityRank(channel) * 100));

        if (/\bh265\b|hevc/.test(name)) score -= 50;
        if (channel.num != null) score += Math.max(0, 100 - Number(channel.num));
        return score;
    }

    getBestFamilyChannel(members = []) {
        return [...members].sort((a, b) => this.getVariantQualityScore(b) - this.getVariantQualityScore(a))[0];
    }

    getFamilyBadge(family) {
        if (!family?.members?.length) return null;
        const list = this.app.channelList;
        const healthyCount = family.members.filter(channel => list.isHealthyChannel(channel)).length;
        const problematicCount = family.members.filter(channel => this.isProblematicChannel(channel)).length;
        const total = family.members.length;

        if (healthyCount > 0) {
            return {
                label: total > 1 ? `OK ${healthyCount}/${total}` : 'OK',
                className: 'ok',
                title: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_a95498185484", {defaultValue: "{{p0}} working variant{{p1}}", p0:(healthyCount),p1:(healthyCount > 1 ? 's' : '')}) : `${healthyCount} working variant${healthyCount > 1 ? 's' : ''}`)
            };
        }

        if (problematicCount === total) {
            return {
                label: total > 1 ? `${total} DOWN` : 'DOWN',
                className: 'problem',
                title: (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_72ffff0fcda2", {defaultValue: "{{p0}} variant{{p1}} tested, none working", p0:(total),p1:(total > 1 ? 's' : '')}) : `${total} variant${total > 1 ? 's' : ''} tested, none working`)
            };
        }

        return {
            label: `${total - problematicCount}/${total}`,
            className: 'pending',
            title: (globalThis.NorvaI18n?.t("ui_web_8452ee024b05", { defaultValue: "Variants partially tested" }) ?? 'Variants partially tested')
        };
    }

    buildFamilyRows(channels) {
        const families = [];
        const byKey = new Map();
        const list = this.app.channelList;

        channels.forEach((channel, index) => {
            const familyKey = list.getChannelFamilyKey(channel) || `${channel.sourceId}:${channel.id}`;
            const key = `${channel.sourceId}:${familyKey}`;
            let family = byKey.get(key);
            if (!family) {
                family = {
                    key,
                    familyKey,
                    label: list.getChannelFamilyLabel(channel) || channel.name,
                    sourceId: channel.sourceId,
                    firstIndex: index,
                    members: []
                };
                byKey.set(key, family);
                families.push(family);
            }
            family.members.push(channel);
        });

        families.forEach(family => {
            family.best = this.getBestFamilyChannel(family.members);
            family.display = family.members.find(channel => channel.num != null) || family.best || family.members[0];
            family.badge = this.getFamilyBadge(family);
        });

        return families;
    }

    refreshBrokenChannelsInActiveGroup() {
        const channels = this.filterGroup(this.getPlayableChannels());
        const problematic = channels.filter(channel => this.isProblematicChannel(channel));
        if (!problematic.length) return;

        const scopeLabel = this.activeGroup === 'Favorites'
            ? (globalThis.NorvaI18n?.t("ui_web_7a1f2a83aca9", { defaultValue: "Favorites" }) ?? 'Favorites')
            : (this.activeGroup || (globalThis.NorvaI18n?.t("ui_web_4b33d5e03e53", { defaultValue: "All channels" }) ?? 'All channels'));

        this.app.channelList.refreshPlaybackForChannels(problematic, {
            label: scopeLabel,
            scopeKey: `live-group:${scopeLabel}`,
            categoryName: this.activeGroup && this.activeGroup !== 'Favorites' ? this.activeGroup : '',
            cooldownMs: 15000
        }).catch(err => console.warn('Active group refresh failed:', err));
    }

    refreshFamilyIfNeeded(channel, members, options = {}) {
        const channelsToRefresh = members?.length ? members : [channel];
        if (!channelsToRefresh.some(member => this.isProblematicChannel(member))) return;

        const familyLabel = this.app.channelList.getChannelFamilyLabel(channel) || channel.name;
        this.app.channelList.refreshPlaybackForChannels(channelsToRefresh, {
            label: channelsToRefresh.length > 1 ? `${familyLabel} variants` : channel.name,
            scopeKey: `live-family:${channel.sourceId}:${familyLabel.toLowerCase()}`,
            cooldownMs: options.force ? 0 : 5000,
            force: Boolean(options.force)
        }).catch(err => console.warn('Channel refresh failed:', err));
    }

    getEpgChannel(channel) {
        const guide = this.app.epgGuide;
        if (!guide?.channels?.length) return null;
        if (guide.getEpgChannel) return guide.getEpgChannel(channel.tvgId || channel.epg_id, channel.name);
        if (channel.tvgId && guide.channelMap?.has(channel.tvgId)) {
            return guide.channelMap.get(channel.tvgId);
        }
        if (channel.name && guide.channelMap?.has(String(channel.name).toLowerCase())) {
            return guide.channelMap.get(String(channel.name).toLowerCase());
        }
        return guide.channels.find(epg => epg.id === channel.tvgId || epg.name === channel.name) || null;
    }

    shortEpgKey(channel) {
        const streamId = channel?.streamId || channel?.id || '';
        const sourceType = channel?.sourceType
            || channel?.source_type
            || channel?.playback_hint?.sourceType
            || channel?.playbackHint?.sourceType
            || (channel?._logicalChannel ? 'xtream' : '');
        return sourceType === 'xtream' && channel?.sourceId && streamId
            ? `${channel.sourceId}:${streamId}`
            : '';
    }

    normalizeShortEpgListing(listing) {
        const start = Number.parseInt(listing?.start_timestamp, 10);
        const stop = Number.parseInt(listing?.stop_timestamp, 10);
        if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return null;
        return {
            title: this.decodeBase64(listing.title) || 'Programme',
            description: this.decodeBase64(listing.description),
            start: new Date(start * 1000),
            stop: new Date(stop * 1000)
        };
    }

    getShortProgramAt(channel, date) {
        const key = this.shortEpgKey(channel);
        if (!key) return null;
        const programmes = this.shortEpgCache.get(key) || [];
        const time = date.getTime();
        return programmes.find(program => {
            const start = new Date(program.start).getTime();
            const stop = new Date(program.stop).getTime();
            return time >= start && time < stop;
        }) || null;
    }

    // Queue missing short-EPG and drain it ONE request at a time, deferred and
    // spaced out. Firing ~10 in parallel on render() burst-tripped the provider's
    // rate limit (429) AND stole its request budget from live playback — which
    // opens its provider connection right after render() — so the stream itself
    // got 429'd and ffmpeg died. Serialised + deferred, EPG yields to playback and
    // just trickles in; a 429 cools the whole source down and drops its queue.
    ensureShortEpgForChannels(channels = []) {
        const now = Date.now();
        const candidates = channels
            .filter(Boolean)
            .filter(channel => !this.getProgramAt(channel, new Date(now)))
            .filter(channel => this.shortEpgKey(channel))
            .slice(0, 8);

        this._shortEpgQueue = this._shortEpgQueue || [];
        this._shortEpgQueuedKeys = this._shortEpgQueuedKeys || new Set();
        for (const channel of candidates) {
            const key = this.shortEpgKey(channel);
            if (this._shortEpgQueuedKeys.has(key) || this.shortEpgInflight.has(key)) continue;
            const loadedAt = this.shortEpgLoadedAt.get(key) || 0;
            if (now - loadedAt < 10 * 60 * 1000) continue; // still fresh
            this._shortEpgQueuedKeys.add(key);
            this._shortEpgQueue.push(channel);
        }
        this._drainShortEpg();
    }

    async _drainShortEpg() {
        if (this._shortEpgDraining) return;
        this._shortEpgDraining = true;
        try {
            // Let live playback grab the provider connection first (resumeLivePlayback
            // fires right after the render that queued us).
            await new Promise(resolve => setTimeout(resolve, 1200));
            while (this._shortEpgQueue && this._shortEpgQueue.length) {
                const channel = this._shortEpgQueue.shift();
                const key = this.shortEpgKey(channel);
                this._shortEpgQueuedKeys.delete(key);
                const sourceKey = String(channel.sourceId || '');
                const now = Date.now();
                if ((this.shortEpgSourceCooldown.get(sourceKey) || 0) > now) continue;
                const loadedAt = this.shortEpgLoadedAt.get(key) || 0;
                if (this.shortEpgInflight.has(key) || now - loadedAt < 10 * 60 * 1000) continue;

                this.shortEpgInflight.add(key);
                try {
                    const data = await API.proxy.xtream.shortEpg(channel.sourceId, channel.streamId || channel.id, 8);
                    const listings = Array.isArray(data?.epg_listings) ? data.epg_listings : [];
                    const programmes = listings.map(l => this.normalizeShortEpgListing(l)).filter(Boolean);
                    this.shortEpgCache.set(key, programmes);
                    this.shortEpgLoadedAt.set(key, Date.now());
                    if (programmes.length) this.shortEpgSourceFailures.set(sourceKey, 0);
                } catch (err) {
                    const failures = (this.shortEpgSourceFailures.get(sourceKey) || 0) + 1;
                    this.shortEpgSourceFailures.set(sourceKey, failures);
                    if (err?.status === 429 || failures >= 3) {
                        // Rate-limited: cool the source down and drop its remaining
                        // queue — hammering a 429'd provider only makes it worse.
                        this.shortEpgSourceCooldown.set(sourceKey, Date.now() + 10 * 60 * 1000);
                        this._shortEpgQueue = this._shortEpgQueue.filter(c => String(c.sourceId || '') !== sourceKey);
                    }
                    if (err?.status !== 429) console.debug('[LiveGuide] Short EPG unavailable for', channel.name, err);
                    this.shortEpgCache.set(key, []);
                    this.shortEpgLoadedAt.set(key, Date.now());
                } finally {
                    this.shortEpgInflight.delete(key);
                    this.scheduleRender();
                }
                // Space requests out so we never burst the provider's rate limit.
                await new Promise(resolve => setTimeout(resolve, 400));
            }
        } finally {
            this._shortEpgDraining = false;
        }
    }

    getProgramAt(channel, date) {
        const guide = this.app.epgGuide;
        const epgChannel = this.getEpgChannel(channel);
        if (epgChannel && guide?.programmes?.length) {
            const time = date.getTime();
            if (guide.programmesByChannel && typeof guide.getChannelProgrammes === 'function') {
                // Fast path: read the pre-built per-channel index with cached
                // numeric timestamps instead of scanning the whole flat list.
                const fullGuideProgram = guide.getChannelProgrammes(epgChannel.id).find(program =>
                    time >= program._startMs && time < program._stopMs
                ) || null;
                if (fullGuideProgram) return fullGuideProgram;
            } else {
                // Fallback: index not built yet — keep the old full scan.
                const fullGuideProgram = guide.programmes.find(program => {
                    if (program.channelId !== epgChannel.id) return false;
                    const start = new Date(program.start).getTime();
                    const stop = new Date(program.stop).getTime();
                    return time >= start && time < stop;
                }) || null;
                if (fullGuideProgram) return fullGuideProgram;
            }
        }
        return this.getShortProgramAt(channel, date);
    }

    /** The next {n} programmes starting at or after now (full guide, else short EPG). */
    getUpcoming(channel, n = 3) {
        const now = Date.now();
        const collected = [];
        const guide = this.app.epgGuide;
        const epgChannel = this.getEpgChannel(channel);
        if (epgChannel && guide?.programmes?.length) {
            if (guide.programmesByChannel && typeof guide.getChannelProgrammes === 'function') {
                // Fast path: iterate only this channel's programmes via the
                // index, using the cached _startMs instead of re-parsing.
                for (const program of guide.getChannelProgrammes(epgChannel.id)) {
                    if (program._startMs >= now) {
                        collected.push({ title: program.title, start: program.start, stop: program.stop });
                    }
                }
            } else {
                // Fallback: index not built yet — keep the old full scan.
                for (const program of guide.programmes) {
                    if (program.channelId !== epgChannel.id) continue;
                    if (new Date(program.start).getTime() >= now) {
                        collected.push({ title: program.title, start: program.start, stop: program.stop });
                    }
                }
            }
        }
        if (!collected.length) {
            const key = this.shortEpgKey(channel);
            for (const program of (this.shortEpgCache.get(key) || [])) {
                if (new Date(program.start).getTime() >= now) {
                    collected.push({ title: program.title, start: program.start, stop: program.stop });
                }
            }
        }
        collected.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
        const seen = new Set();
        const unique = [];
        for (const program of collected) {
            const startKey = new Date(program.start).getTime();
            if (seen.has(startKey)) continue;
            seen.add(startKey);
            unique.push(program);
        }
        return unique.slice(0, n);
    }

    formatTime(value) {
        if (!value) return '';
        return new Date(value).toLocaleTimeString((globalThis.NorvaI18n?.language || 'en-US'), { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    getProgress(program) {
        if (!program?.start || !program?.stop) return 0;
        const start = new Date(program.start).getTime();
        const stop = new Date(program.stop).getTime();
        const now = Date.now();
        if (stop <= start) return 0;
        return Math.max(0, Math.min(100, ((now - start) / (stop - start)) * 100));
    }

    isPhoneApk() {
        return document.body.classList.contains('norva-phone-apk');
    }

    /** Filter a channel list by the inline search query (family label / name). */
    filterBySearch(channels) {
        const q = (this.searchQuery || '').trim().toLowerCase();
        if (!q) return channels;
        const list = this.app.channelList;
        return channels.filter(channel => {
            // Match the FULL name as well as the stripped family label — the label is only the
            // last pipe segment with quality/noise words removed, so e.g. "M6 HD | FRANCE TNT"
            // (label "France Tnt") would otherwise be dropped on a "m6" query even when in memory.
            const name = channel.name || '';
            const label = list.getChannelFamilyLabel(channel) || '';
            return name.toLowerCase().includes(q) || label.toLowerCase().includes(q);
        });
    }

    /** Rows source: a search spans ALL channels; otherwise the active group. */
    getRowsChannels() {
        const channels = this.getPlayableChannels();
        if ((this.searchQuery || '').trim()) return this.filterBySearch(channels);
        return this.filterGroup(channels);
    }

    /** Inline header (phone/tablet APK only): search + source + Hide-broken. */
    renderToolbar() {
        const hideBroken = Boolean(this.app.channelList.hideBroken);
        const q = this.escapeHtml(this.searchQuery || '');
        return `
            <div class="live-guide-toolbar">
                <span class="live-guide-search-wrap">
                    <input type="text" class="live-guide-search" placeholder="Search channels…"
                           value="${q}" autocomplete="off" autocapitalize="none" spellcheck="false"
                           aria-label="Search channels" data-i18n-placeholder="ui_web_951a34ca584e" data-i18n-aria-label="ui_web_7fbc58c98558">
                    ${q ? '<button type="button" class="live-guide-search-clear" title="Clear" aria-label="Clear search" data-i18n-title="ui_web_83b12c2216ef" data-i18n-aria-label="ui_web_3b7ea51793e9">&times;</button>' : ''}
                </span>
                ${this.renderSourcePicker()}
                <button type="button" class="live-guide-hidebroken ${hideBroken ? 'is-active' : ''}"
                        aria-pressed="${hideBroken ? 'true' : 'false'}"
                        title="Hide channels that failed the health scan (unreachable / broken streams)" data-i18n-title="ui_web_ffaf9c11717c" data-i18n="ui_web_d65b28a523c0">Hide unavailable</button>
            </div>
        `;
    }

    /** Source dropdown — shown only with >1 source; mirrors the hidden #source-select. */
    renderSourcePicker() {
        const sel = document.getElementById('source-select');
        if (!sel) return '';
        const sourceOptions = Array.from(sel.querySelectorAll('option')).filter(option => option.value);
        if (sourceOptions.length <= 1) return '';
        const selected = Array.from(sel.querySelectorAll('option'))
            .find(option => option.value === sel.value)
            || sel.querySelector('option');
        const label = selected?.textContent?.trim() || (globalThis.NorvaI18n?.t("ui_web_b877e9212b41", { defaultValue: "All Sources" }) ?? 'All Sources');
        return `
            <button type="button" class="live-guide-source-trigger"
                    data-action="open-source-sheet"
                    aria-haspopup="dialog" aria-expanded="false"
                    aria-label="Source, ${this.escapeHtml(label)}" data-i18n-aria-label="ui_web_2fe09b039bc7" data-i18n-aria-label-args="${(globalThis.NorvaI18n?.args?.({"p0":(label)}) || "{}")}">
                <span data-i18n="ui_web_0e570ca6fabe">Source</span>
                <strong>${this.escapeHtml(label)}</strong>
                <span class="live-guide-source-icon" aria-hidden="true">${Icons.chevronDown}</span>
            </button>
            <span class="sr-only live-guide-source-announcement" aria-live="polite"></span>
        `;
    }

    closeSourceSheet({ restoreFocus = true } = {}) {
        if (typeof this._sourceSheetClose === 'function') {
            this._sourceSheetClose({ restoreFocus });
        }
    }

    openSourceSheet(trigger) {
        const sel = document.getElementById('source-select');
        if (!sel || !trigger) return;
        const options = Array.from(sel.querySelectorAll('option'));
        if (options.length <= 1) return;

        this.closeSourceSheet({ restoreFocus: false });

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active live-source-overlay';
        overlay.setAttribute('aria-hidden', 'false');

        const sheet = document.createElement('section');
        sheet.className = 'live-source-sheet';
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-labelledby', 'live-source-sheet-title');

        const header = document.createElement('header');
        header.className = 'live-source-sheet-header';
        const headingWrap = document.createElement('div');
        const kicker = document.createElement('span');
        kicker.className = 'live-source-sheet-kicker';
        kicker.textContent = (globalThis.NorvaI18n?.t("ui_web_d451ef69d283", { defaultValue: "Live TV" }) ?? 'Live TV');
        const heading = document.createElement('h2');
        heading.id = 'live-source-sheet-title';
        heading.textContent = (globalThis.NorvaI18n?.t("ui_web_de8133e1a512", { defaultValue: "Choose a source" }) ?? 'Choose a source');
        headingWrap.append(kicker, heading);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'modal-close live-source-close';
        closeButton.setAttribute('aria-label', (globalThis.NorvaI18n?.t("ui_web_5e5acf18d917", { defaultValue: "Close source chooser" }) ?? 'Close source chooser'));
        closeButton.textContent = (globalThis.NorvaI18n?.t("ui_web_11a6767d5674", { defaultValue: "Done" }) ?? 'Done');
        header.append(headingWrap, closeButton);

        const helper = document.createElement('p');
        helper.className = 'live-source-sheet-help';
        helper.textContent = (globalThis.NorvaI18n?.t("ui_web_bfe25ae72384", { defaultValue: "Show every connected service, or focus the guide on one source." }) ?? 'Show every connected service, or focus the guide on one source.');

        const list = document.createElement('div');
        list.className = 'live-source-options';
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', (globalThis.NorvaI18n?.t("ui_web_550f31dcda96", { defaultValue: "Live TV source" }) ?? 'Live TV source'));

        options.forEach(option => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'live-source-option';
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', option.value === sel.value ? 'true' : 'false');
            item.dataset.sourceValue = option.value;

            const copy = document.createElement('span');
            copy.className = 'live-source-option-copy';
            const title = document.createElement('strong');
            title.textContent = option.textContent?.trim() || (globalThis.NorvaI18n?.t("ui_web_b877e9212b41", { defaultValue: "All Sources" }) ?? 'All Sources');
            copy.appendChild(title);
            const group = option.closest('optgroup')?.label;
            if (group) {
                const meta = document.createElement('small');
                meta.textContent = group;
                copy.appendChild(meta);
            }
            const check = document.createElement('span');
            check.className = 'live-source-option-check';
            check.setAttribute('aria-hidden', 'true');
            check.innerHTML = Icons.check;
            item.append(copy, check);
            list.appendChild(item);
        });

        sheet.append(header, helper, list);
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);

        const background = [
            document.querySelector('.navbar'),
            document.querySelector('.main-content'),
            document.querySelector('.bottom-nav')
        ].filter(Boolean);
        const inertSnapshot = background.map(element => ({ element, inert: Boolean(element.inert) }));
        inertSnapshot.forEach(({ element }) => { element.inert = true; });
        trigger.setAttribute('aria-expanded', 'true');

        let closed = false;
        const focusable = () => Array.from(
            sheet.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
        ).filter(element => element.offsetParent !== null);
        const close = ({ restoreFocus = true } = {}) => {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey, true);
            inertSnapshot.forEach(({ element, inert }) => { element.inert = inert; });
            overlay.classList.remove('active');
            overlay.remove();
            this._sourceSheetClose = null;
            const currentTrigger = trigger.isConnected
                ? trigger
                : this.container?.querySelector('.live-guide-source-trigger');
            currentTrigger?.setAttribute('aria-expanded', 'false');
            if (restoreFocus && currentTrigger) {
                requestAnimationFrame(() => currentTrigger.focus({ preventScroll: true }));
            }
        };
        const optionButtons = () => Array.from(list.querySelectorAll('.live-source-option'));
        const onKey = event => {
            if (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack') {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp'
                || event.key === 'Home' || event.key === 'End') {
                const items = optionButtons();
                const current = items.indexOf(document.activeElement);
                if (!items.length || current < 0) return;
                event.preventDefault();
                let next = current;
                if (event.key === 'ArrowDown') next = (current + 1) % items.length;
                if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
                if (event.key === 'Home') next = 0;
                if (event.key === 'End') next = items.length - 1;
                items[next].focus({ preventScroll: true });
                return;
            }
            if (event.key !== 'Tab') return;
            const items = focusable();
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            }
        };

        this._sourceSheetClose = close;
        // Native phone Back looks for .modal-overlay.active and invokes this
        // button's onclick before removing the class.
        closeButton.onclick = () => close();
        overlay.addEventListener('click', event => {
            if (event.target === overlay) close();
        });
        list.addEventListener('click', event => {
            const item = event.target.closest('.live-source-option');
            if (!item) return;
            const value = item.dataset.sourceValue || '';
            const title = item.querySelector('strong')?.textContent || (globalThis.NorvaI18n?.t("ui_web_b877e9212b41", { defaultValue: "All Sources" }) ?? 'All Sources');
            close({ restoreFocus: false });
            sel.value = value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            setTimeout(() => {
                const currentTrigger = this.container?.querySelector('.live-guide-source-trigger');
                currentTrigger?.focus({ preventScroll: true });
                const announcement = this.container?.querySelector('.live-guide-source-announcement');
                if (announcement) announcement.textContent = (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_38174a4950f6", {defaultValue: "{{p0}} selected", p0:(title)}) : `${title} selected`);
            }, 0);
        });
        document.addEventListener('keydown', onKey, true);

        requestAnimationFrame(() => {
            const selected = list.querySelector('[aria-selected="true"]');
            (selected || optionButtons()[0] || closeButton).focus({ preventScroll: true });
        });
    }

    /** Re-render only the rows (search keystroke) — leaves the toolbar focused. */
    refreshRows() {
        if (!this.container) return;
        const rowsEl = this.container.querySelector('.live-guide-rows');
        if (!rowsEl) return;
        rowsEl.outerHTML = this.renderRows(this.getRowsChannels());
        this.updateHighlights();
    }

    /** Toolbar Hide-broken toggle — mirrors the drawer button + re-renders the guide. */
    toggleHideBroken() {
        const list = this.app.channelList;
        list.hideBroken = !list.hideBroken;
        list.hideBrokenBtn?.classList.toggle('active', list.hideBroken);
        this.render();
    }

    clearSearch() {
        this.searchQuery = '';
        this._rowLimit = this.BASE_ROW_LIMIT;
        clearTimeout(this._searchTimer);
        // Cancel any pending/in-flight remote search and invalidate late responses (via the seq
        // bump), so a dismissed query can't merge channels into — and re-render — the browse view.
        clearTimeout(this._remoteSearchTimer);
        this._remoteSearchSeq++;
        this.render();
        this.container?.querySelector('.live-guide-search')?.focus();
    }

    /**
     * Mobile inline-search parity with the desktop sidebar.
     *
     * The desktop search augments the local catalog with an all-sources server query on every
     * keystroke (ChannelList.scheduleRemoteSearch → loadRemoteSearchResults). The phone guide
     * historically filtered ONLY the lazily-hydrated in-memory set, so a search returned whatever
     * few channels had loaded — the "1/1 badge on every row" symptom where the same account finds
     * 10 channels on desktop but ~3 on mobile. Mirror the desktop fan-out here.
     *
     * Deliberately ISOLATED from the desktop path: guards on THIS component's searchQuery + its own
     * sequence counter (never on ChannelList.searchInput, which the phone never populates), so it
     * neither reads nor mutates desktop search state. It only REUSES ChannelList's public helpers
     * (shouldUseRemoteSearch / getRemoteSearchSources / remoteSearchCache / mergeRemoteSearchChannels)
     * and the shared `channels` array, so no desktop code changes. Cloud-mode + min-length gating is
     * inherited from shouldUseRemoteSearch, so on a non-cloud/local source it stays local-only as before.
     */
    scheduleRemoteSearch(term) {
        const list = this.app?.channelList;
        const q = (term || '').trim();
        clearTimeout(this._remoteSearchTimer);
        if (!list?.shouldUseRemoteSearch?.(q)) return;   // too short / not cloud mode → local filter only
        const seq = ++this._remoteSearchSeq;
        this._remoteSearchTimer = setTimeout(() => {
            this.loadRemoteSearchResults(q, seq).catch(err =>
                console.warn('[LiveGuideFusion] remote live search failed:', err));
        }, 220);
    }

    async loadRemoteSearchResults(term, seq) {
        const list = this.app?.channelList;
        if (!list || seq !== this._remoteSearchSeq) return;
        const sources = list.getRemoteSearchSources?.() || [];
        if (!sources.length) return;

        let added = 0;
        for (const source of sources) {
            const key = `${source.type}:${source.id}:${list.normalizeSearchText(term)}`;
            let streams = list.remoteSearchCache.get(key);
            if (!streams) {
                streams = await window.API.proxy.xtream.liveStreams(source.id, null, { q: term, limit: 80 });
                list.remoteSearchCache.set(key, streams || []);
            }
            // Drop stale responses: bail if the query changed/cleared while this request was in flight.
            if (seq !== this._remoteSearchSeq || (this.searchQuery || '').trim() !== term) return;
            added += list.mergeRemoteSearchChannels(source, streams || []);
        }

        if (!added) return;
        list._indexedChannels = null;                    // keep the desktop search index consistent
        if ((this.searchQuery || '').trim() === term) this.refreshRows();
    }

    /** "Show more" — grow the render window by one chunk, keeping scroll position. */
    showMoreRows() {
        const rows = this.container?.querySelector('.live-guide-rows');
        const prev = rows ? rows.scrollTop : 0;
        this._rowLimit = (this._rowLimit || this.BASE_ROW_LIMIT) + this.BASE_ROW_LIMIT;
        this.refreshRows();
        const grown = this.container?.querySelector('.live-guide-rows');
        if (grown) grown.scrollTop = prev;
        // TV: refreshRows() swapped .live-guide-rows via outerHTML, destroying the
        // focused "Show more" button — focus falls to <body> and the next D-pad press is
        // wasted re-anchoring. Put focus on the new button (more rows remain) or the last
        // row (all shown) so navigation continues cleanly.
        if (this._isTvMode()) {
            const moreBtn = this.container?.querySelector('.live-guide-more');
            if (moreBtn) {
                moreBtn.focus({ preventScroll: true });
            } else {
                const allRows = this.container?.querySelectorAll('.live-guide-row');
                if (allRows && allRows.length) allRows[allRows.length - 1].focus({ preventScroll: true });
            }
        }
    }

    /** Cinema mode — enlarge the player, compact the guide to a zapping strip. */
    toggleCinema() {
        this._cinema = !this._cinema;
        this._applyCinema();
    }

    _applyCinema() {
        const section = this.container?.closest('.player-section')
            || document.querySelector('.player-section');
        if (section) section.classList.toggle('guide-collapsed', !!this._cinema);
        const btn = this.container?.querySelector('.live-guide-preview [data-action="cinema"]');
        if (btn) {
            btn.classList.toggle('is-active', !!this._cinema);
            btn.setAttribute('aria-pressed', this._cinema ? 'true' : 'false');
            btn.textContent = this._cinema ? (globalThis.NorvaI18n?.t("ui_web_014c182ee0a9", { defaultValue: "Exit cinema" }) ?? 'Exit cinema') : (globalThis.NorvaI18n?.t("ui_web_89ec0bb81771", { defaultValue: "Cinema" }) ?? 'Cinema');
            btn.title = this._cinema
                ? (globalThis.NorvaI18n?.t("ui_web_387cb11365d5", { defaultValue: "Restore the split view" }) ?? 'Restore the split view')
                : (globalThis.NorvaI18n?.t("ui_web_8492d6554b0b", { defaultValue: "Cinema mode — enlarge the player, compact the guide" }) ?? 'Cinema mode — enlarge the player, compact the guide');
        }
    }

    renderPreview(channel) {
        if (!channel) {
            return `
            <div class="live-guide-preview is-empty">
                <div class="live-guide-preview-copy">
                    <div class="live-guide-preview-title" data-i18n="ui_web_d1d465bf6593">No channel selected</div>
                    <div class="live-guide-preview-channel" data-i18n="ui_web_0c7e3b9ad48f">Tap a channel to preview</div>
                </div>
            </div>`;
        }

        const program = this.getProgramAt(channel, new Date());
        const progress = this.getProgress(program);
        const title = program?.title || (globalThis.NorvaI18n?.t("ui_web_a19388453c5e", { defaultValue: "No guide info" }) ?? 'No guide info');
        const start = program?.start ? this.formatTime(program.start) : '--:--';
        const stop = program?.stop ? this.formatTime(program.stop) : '--:--';
        const logo = this.getChannelLogoSrc(channel);
        const fallbackLogo = this.getChannelLogoErrorSrc(channel);
        const group = channel.groupTitle || this.activeGroup || '';
        const list = this.app.channelList;
        const isFav = list.isFavorite(channel.sourceId, channel.id);
        const playing = list.currentChannel;
        const isPlaying = playing
            && String(playing.id) === String(channel.id)
            && String(playing.sourceId) === String(channel.sourceId);
        const pending = list._pendingPlaybackSelection?.requestedChannel || list._pendingPlaybackSelection?.channel;
        const isPending = pending
            && String(pending.id) === String(channel.id)
            && String(pending.sourceId) === String(channel.sourceId);
        const upNext = this.getUpcoming(channel, 2);
        const tv = this._isTvMode();
        // Quality pills (8K/UHD/4K/FHD/HD) parsed from the channel name, + the group,
        // and "N min remaining" from the current programme's end — mockup card meta.
        const qualityTags = tv
            ? [...new Set((channel.name || '').toUpperCase().match(/\b(8K|UHD|4K|FHD|HD)\b/g) || [])].slice(0, 2)
            : [];
        let minsLeft = null;
        if (tv && program?.stop) {
            const ms = new Date(program.stop).getTime() - Date.now();
            if (ms > 0) minsLeft = Math.round(ms / 60000);
        }

        return `
            <div class="live-guide-preview">
                <div class="live-guide-preview-art">
                    ${tv && qualityTags[0] ? `<span class="lg-art-badge">${qualityTags[0]}</span>` : ''}
                    <img src="${logo}" alt="" onerror="this.onerror=null;this.src='${fallbackLogo}'">
                </div>
                <div class="live-guide-preview-copy">
                    <div class="live-guide-preview-channel">
                        ${this.escapeHtml(channel.name || (globalThis.NorvaI18n?.t("ui_web_cbce2b0e7b41", { defaultValue: "No channel" }) ?? 'No channel'))}
                        ${!tv && group ? `<span>${this.escapeHtml(group)}</span>` : ''}
                    </div>
                    ${tv ? `<div class="live-guide-preview-badges">
                        ${qualityTags.map(t => `<span class="lg-badge">${t}</span>`).join('')}
                        ${group ? `<span class="lg-badge lg-badge-group">· ${this.escapeHtml(group)}</span>` : ''}
                    </div>` : ''}
                    ${tv ? `<div class="live-guide-preview-onair" data-i18n="ui_web_f8c6e8cce2d9" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(start),"p1":(stop)}) || "{}")}">On air · ${this.escapeHtml(start)} - ${this.escapeHtml(stop)}</div>` : ''}
                    <div class="live-guide-preview-title">${this.escapeHtml(title)}</div>
                    <div class="live-guide-preview-meta">
                        ${tv ? '' : `<span>${this.escapeHtml(start)} - ${this.escapeHtml(stop)}</span>`}
                        <span class="live-guide-progress"><span style="width:${progress}%"></span></span>
                        ${tv && minsLeft != null ? `<span class="lg-remaining" data-i18n="ui_web_1187e8825b43" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(minsLeft)}) || "{}")}">${minsLeft} min remaining</span>` : ''}
                    </div>
                    ${upNext.length ? `<ul class="live-guide-upnext">
                        ${upNext.map(p => `<li><span class="t">${this.escapeHtml(this.formatTime(p.start))}</span> ${this.escapeHtml(p.title || (globalThis.NorvaI18n?.t("ui_web_30556a7a38a5", { defaultValue: "Programme" }) ?? 'Programme'))}</li>`).join('')}
                    </ul>` : ''}
                </div>
                <div class="live-guide-preview-actions">
                    <button type="button" class="lg-btn lg-btn-primary ${isPlaying && !isPending ? 'is-playing' : ''}" data-action="watch" aria-busy="${isPending ? 'true' : 'false'}">
                        ${isPending ? '<span class="lg-btn-loading" aria-hidden="true"></span>' : '<svg class="lg-btn-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'}
                        <span>${isPending ? (globalThis.NorvaI18n?.t("ui_web_ba3bbbe10d8b", { defaultValue: "Loading…" }) ?? 'Loading…') : isPlaying ? (globalThis.NorvaI18n?.t("ui_web_deaf6f9d23bc", { defaultValue: "Playing" }) ?? 'Playing') : (globalThis.NorvaI18n?.t("ui_web_a71e75732446", { defaultValue: "Watch" }) ?? 'Watch')}</span>
                    </button>
                    ${(tv || document.body.classList.contains('norva-phone-apk')) ? '' : `<button type="button" class="lg-btn lg-btn-cinema ${this._cinema ? 'is-active' : ''}" data-action="cinema" aria-pressed="${this._cinema ? 'true' : 'false'}" title="${this._cinema ? (globalThis.NorvaI18n?.t("ui_web_387cb11365d5", { defaultValue: "Restore the split view" }) ?? 'Restore the split view') : (globalThis.NorvaI18n?.t("ui_web_8492d6554b0b", { defaultValue: "Cinema mode — enlarge the player, compact the guide" }) ?? 'Cinema mode — enlarge the player, compact the guide')}">${this._cinema ? (globalThis.NorvaI18n?.t("ui_web_014c182ee0a9", { defaultValue: "Exit cinema" }) ?? 'Exit cinema') : (globalThis.NorvaI18n?.t("ui_web_89ec0bb81771", { defaultValue: "Cinema" }) ?? 'Cinema')}</button>
                           <button type="button" class="lg-btn" data-action="fullscreen" title="Fullscreen" aria-label="Fullscreen" data-i18n-title="ui_web_c461dbb2bab7" data-i18n-aria-label="ui_web_c461dbb2bab7" data-i18n="ui_web_c461dbb2bab7">Fullscreen</button>`}
                    <button type="button" class="lg-btn ${this._isTvMode() ? 'lg-btn-fav' : 'lg-btn-icon'} ${isFav ? 'is-fav' : ''}" data-action="favorite" title="Favorite" aria-label="${isFav ? (globalThis.NorvaI18n?.t("ui_web_e34f671f3517", { defaultValue: "In favorites" }) ?? 'In favorites') : (globalThis.NorvaI18n?.t("ui_web_7f3c0782afd7", { defaultValue: "Add to favorites" }) ?? 'Add to favorites')}" data-i18n-title="ui_web_ea713ecd8537">
                        <span class="lg-btn-heart" aria-hidden="true">${isFav ? '♥' : '♡'}</span>${this._isTvMode() ? `<span>${isFav ? (globalThis.NorvaI18n?.t("ui_web_e34f671f3517", { defaultValue: "In favorites" }) ?? 'In favorites') : (globalThis.NorvaI18n?.t("ui_web_7f3c0782afd7", { defaultValue: "Add to favorites" }) ?? 'Add to favorites')}</span>` : ''}
                    </button>
                </div>
            </div>
        `;
    }

    renderGroups(groups) {
        return `
            <div class="live-guide-groups">
                ${groups.map(group => `
                    <button class="live-guide-group ${group.id === this.activeGroup ? 'active' : ''}" data-group="${this.escapeHtml(group.id)}">
                        ${this.escapeHtml(group.name)}
                    </button>
                `).join('')}
            </div>
        `;
    }

    renderRows(channels) {
        const families = this.buildFamilyRows(channels);
        if (!families.length) {
            const msg = (this.searchQuery || '').trim()
                ? (globalThis.NorvaI18n?.t("ui_web_4da30c70494a", { defaultValue: "No channels match your search" }) ?? 'No channels match your search')
                : (globalThis.NorvaI18n?.t("ui_web_be8adbb92500", { defaultValue: "No channels in this group" }) ?? 'No channels in this group');
            return `<div class="live-guide-rows"><div class="live-guide-empty">${msg}</div></div>`;
        }
        // Render up to _rowLimit rows and let the viewer pull in the rest in chunks.
        // Keeps the DOM bounded on huge lineups (thousands of channels) without ever
        // silently hiding channels the way the old hard 150 cap did.
        // Phone/web used to render 150 rows and eagerly request every logo. That
        // made the first Live paint transfer-heavy even though only a handful of
        // rows fit in the viewport. Keep both DOM and image work bounded; "Show
        // more" still exposes every channel. TV retains its proven 60-row D-pad
        // chunk (each row also contributes a play-button focus target).
        const baseLimit = this._rowLimit || this.BASE_ROW_LIMIT;
        const limit = this._isTvMode() ? Math.max(baseLimit, this.TV_ROW_LIMIT) : baseLimit;
        const shown = families.slice(0, limit);
        const remaining = families.length - shown.length;
        const nextChunk = Math.min(this.BASE_ROW_LIMIT, remaining);
        const overflow = remaining > 0
            ? `<button type="button" class="live-guide-more" data-action="show-more"><norva-i18n data-i18n="ui_web_666a71800bb1" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p0":(nextChunk)}) || "{}")}">Show ${nextChunk} more </norva-i18n><span data-i18n="ui_web_0224dc46280d" data-i18n-args="${(globalThis.NorvaI18n?.args?.({"p1":(remaining),"p2":(families.length)}) || "{}")}">· ${remaining} of ${families.length} left</span></button>`
            : '';
        return `
            <div class="live-guide-rows">
                ${shown.map((family, index) => this.renderRow(family, index)).join('')}
                ${overflow}
            </div>
        `;
    }

    renderRow(family, index) {
        const channel = family.display || family.best || family.members[0];
        const isPending = this.isPendingFamily(family);
        const isPlaying = this.isFamilyActive(family) || isPending;
        const isSelected = this.isFamilySelected(family);
        const badge = isPending
            ? { label: (globalThis.NorvaI18n?.t("ui_web_7a1580c49e45", { defaultValue: "SCAN" }) ?? 'SCAN'), className: 'pending', title: (globalThis.NorvaI18n?.t("ui_web_215306a5a33d", { defaultValue: "Checking variants" }) ?? 'Checking variants') }
            : family.badge;
        const variantLabel = family.members.length > 1 ? `${family.members.length} variants` : '';
        const now = this.getProgramAt(channel, new Date());
        const next = this.getUpcoming(channel, 1)[0] || null;
        const progress = this.getProgress(now);
        // TV (10-foot list, mockup): show the current programme's time range on the
        // right, like an EPG grid row. Off TV the compact now/next layout is kept.
        const timeRange = this._isTvMode() && now?.start
            ? `<span class="live-guide-time">${this.escapeHtml(this.formatTime(now.start))} - ${this.escapeHtml(now.stop ? this.formatTime(now.stop) : '')}</span>`
            : '';
        return `
            <div class="live-guide-row ${isPlaying ? 'playing' : ''} ${isSelected ? 'selected' : ''} ${isPending ? 'pending-refresh' : ''}"
                 role="button" tabindex="0"
                 data-channel-id="${channel.id}" data-source-id="${channel.sourceId}" data-family-key="${this.escapeHtml(family.familyKey)}">
                <span class="live-guide-num">${channel.num || index + 1}</span>
                <img class="live-guide-logo" src="${this.getChannelLogoSrc(channel)}" alt="" loading="lazy" decoding="async" fetchpriority="low" onerror="this.onerror=null;this.src='${this.getChannelLogoErrorSrc(channel)}'">
                <span class="live-guide-info">
                    <span class="live-guide-name-row">
                        <span class="live-guide-channel-name">${this.escapeHtml(family.label)}</span>
                        ${variantLabel ? `<span class="live-guide-variant-count">${this.escapeHtml(variantLabel)}</span>` : ''}
                        ${badge ? `<span class="live-guide-mode ${badge.className}" title="${this.escapeHtml(badge.title)}">${badge.label}</span>` : ''}
                        ${isPlaying ? '<span class="live-guide-live-tag" data-i18n="ui_web_35e0d0360a0a">LIVE</span>' : ''}
                    </span>
                    <span class="live-guide-now">
                        <span class="live-guide-now-title">${this.escapeHtml(now?.title || (globalThis.NorvaI18n?.t("ui_web_a19388453c5e", { defaultValue: "No guide info" }) ?? 'No guide info'))}</span>
                        ${now ? `<span class="live-guide-progress"><span style="width:${progress}%"></span></span>` : ''}
                    </span>
                    ${next ? `<span class="live-guide-next"><span class="live-guide-next-time">${this.escapeHtml(this.formatTime(next.start))}</span> ${this.escapeHtml(next.title || (globalThis.NorvaI18n?.t("ui_web_30556a7a38a5", { defaultValue: "Programme" }) ?? 'Programme'))}</span>` : ''}
                </span>
                ${timeRange}
                <button type="button" class="live-guide-play" title="Watch" aria-label="Watch" data-i18n-title="ui_web_a71e75732446" data-i18n-aria-label="ui_web_a71e75732446">
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
                </button>
            </div>
        `;
    }

    /**
     * Full-panel state shown when no channels are loaded — a load failure gets a
     * "Try again" (the common case: a busy provider connection / transient network),
     * a still-running first load gets a spinner, and a clean-but-empty catalogue gets
     * "No channels yet". Replaces the old behaviour where every one of these rendered
     * an empty split guide that read as "the app is broken".
     */
    renderStatusPanel() {
        const cl = this.app.channelList || {};
        if (cl.isLoading) {
            return `<div class="live-guide-status is-loading" role="status" aria-live="polite">
                <img class="live-guide-status-mark" src="/img/norva-app-icon.png" alt="">
                <div class="live-guide-status-copy">
                    <span class="live-guide-status-kicker" data-i18n="ui_web_d451ef69d283">Live TV</span>
                    <div class="live-guide-status-title" data-i18n="ui_web_d46419997e05">Preparing your channel guide</div>
                    <div class="live-guide-status-msg" data-i18n="ui_web_964e19c3c88f">Loading channels from your connected sources. You can keep using the menu.</div>
                </div>
                <div class="live-guide-status-rows" aria-hidden="true">${'<i></i>'.repeat(5)}</div>
            </div>`;
        }
        if (cl.loadError) {
            const sourceFailure = Boolean(cl.sourceDiscoveryError);
            return `<div class="live-guide-status is-error" role="alert">
                <span class="live-guide-status-kicker" data-i18n="ui_web_d451ef69d283">Live TV</span>
                <div class="live-guide-status-title">${sourceFailure ? (globalThis.NorvaI18n?.t("ui_web_d9c44d71420e", { defaultValue: "Couldn't reach your sources" }) ?? "Couldn't reach your sources") : (globalThis.NorvaI18n?.t("ui_web_56ed85ba9fe4", { defaultValue: "Couldn't load your channels" }) ?? "Couldn't load your channels")}</div>
                <div class="live-guide-status-msg">${sourceFailure
                    ? (globalThis.NorvaI18n?.t("ui_web_6e755e1c02dc", { defaultValue: "Norva couldn't check your connected services. Nothing was changed, so try again when the connection returns." }) ?? "Norva couldn't check your connected services. Nothing was changed, so try again when the connection returns.")
                    : (globalThis.NorvaI18n?.t("ui_web_c21ce6e4dec4", { defaultValue: "Your sources are still connected. The channel list did not respond this time, so try the request again." }) ?? 'Your sources are still connected. The channel list did not respond this time, so try the request again.')}</div>
                <button type="button" class="lg-btn lg-btn-primary" data-action="reload-live" data-i18n="ui_web_d8b8392e2c54">Try again</button>
            </div>`;
        }
        return `<div class="live-guide-status is-empty">
            <span class="live-guide-status-kicker" data-i18n="ui_web_d451ef69d283">Live TV</span>
            <div class="live-guide-status-title" data-i18n="ui_web_ed9be7c72eb6">No channels yet</div>
            <div class="live-guide-status-msg" data-i18n="ui_web_83f9ef124106">No live channels are available in the current sources. A newly connected catalogue may still be preparing.</div>
            <button type="button" class="lg-btn" data-action="reload-live" data-i18n="ui_web_0e9161011702">Refresh</button>
        </div>`;
    }

    render() {
        if (!this.container) return;
        const cl = this.app.channelList;
        // Nothing loaded at all → dedicated loading / error+retry / empty panel, so a
        // failed load is recoverable and a bare empty guide never looks broken. Based
        // on the raw loaded list (not the group/broken-filtered view) so an all-hidden
        // group still falls through to the normal shell's "No channels in this group".
        if (!cl || !cl.channels || cl.channels.length === 0) {
            this.container.innerHTML = `
                ${this.isPhoneApk() ? this.renderToolbar() : ''}
                ${this.renderStatusPanel()}
            `;
            const srcProxy = this.container.querySelector('.live-guide-source');
            const realSel = document.getElementById('source-select');
            if (srcProxy && realSel) srcProxy.value = realSel.value;
            this.syncNavigationState();
            return;
        }
        const channels = this.getPlayableChannels();
        const groups = this.getGroups(channels);
        this.ensureActiveGroup(groups);
        const groupChannels = this.filterGroup(channels);
        // Preload the last-watched channel into the preview when nothing is
        // selected yet — the phone/tablet APK no longer auto-plays on open, so this
        // makes resuming the last channel a single tap on "Watch".
        const selectedChannel = this.currentChannel
            || this.app.channelList.currentChannel
            || this.app.channelList.findLastLiveChannel?.()
            || groupChannels[0] || channels[0] || null;
        this.currentChannel = selectedChannel;
        this._lastChannelsKey = `${channels.length}:${this.activeGroup}:${selectedChannel?.id || ''}`;
        const shortEpgCandidates = selectedChannel
            ? [selectedChannel, ...groupChannels.slice(0, 60)]
            : groupChannels.slice(0, 60);
        this.ensureShortEpgForChannels(shortEpgCandidates);

        // Preserve the channel list's scroll position across re-renders (EPG
        // arrivals re-render the guide; without this the list jumps to the top).
        const prevScroll = this.container.querySelector('.live-guide-rows')?.scrollTop || 0;
        // Preserve search focus + caret if a background re-render lands mid-typing.
        const searchEl = this.container.querySelector('.live-guide-search');
        const searchHadFocus = !!searchEl && document.activeElement === searchEl;
        const searchCaret = searchEl ? searchEl.selectionStart : null;

        const tv = this._isTvMode();
        // Android TV: a full re-render (EPG arrivals via scheduleRender, scan-complete)
        // wipes innerHTML and destroys the focused .live-guide-row, so the global
        // tvNavigation re-anchors to a DIFFERENT row and the list appears to "skip"
        // channels. Capture the focused row's identity now and restore focus to the
        // same channel after the new DOM lands (below). Only when a row actually has
        // focus — never steal it from the search box, card actions, or the sidebar.
        let tvFocusedRowKey = null;
        let tvFocusedAction = null;
        if (tv) {
            const active = document.activeElement;
            if (active && this.container.contains(active)) {
                if (active.classList?.contains('live-guide-row')) {
                    tvFocusedRowKey = {
                        channelId: active.getAttribute('data-channel-id'),
                        sourceId: active.getAttribute('data-source-id')
                    };
                } else {
                    // Focus on a preview action button (Watch / Favorite): a full
                    // re-render wipes it too, so remember it and restore below.
                    const actionBtn = active.closest?.('[data-action]');
                    if (actionBtn && actionBtn.closest('.live-guide-preview')) {
                        tvFocusedAction = actionBtn.getAttribute('data-action');
                    }
                }
            }
        }
        const rowsChannels = this.getRowsChannels();
        this.container.innerHTML = `
            ${this.isPhoneApk() ? this.renderToolbar() : ''}
            <div class="live-guide-shell ${this.shouldShowGroupRail() ? '' : 'groups-hidden'} ${tv ? 'lg-tv-shell' : ''}">
                ${tv ? '' : this.renderGroups(groups)}
                <div class="live-guide-main">
                    ${this.renderPreview(selectedChannel)}
                    ${tv ? `<div class="lg-tv-listhead"><span class="lg-tv-listtitle" data-i18n="ui_web_4b33d5e03e53">All channels</span><span class="lg-tv-count">${rowsChannels.length}</span></div>` : ''}
                    ${this.renderRows(rowsChannels)}
                </div>
            </div>
        `;

        const rows = this.container.querySelector('.live-guide-rows');
        if (rows && prevScroll) { this._lastProgrammaticGuideScrollAt = Date.now(); rows.scrollTop = prevScroll; }
        // Keep the source proxy in sync with the real (hidden) #source-select.
        const srcProxy = this.container.querySelector('.live-guide-source');
        const realSel = document.getElementById('source-select');
        if (srcProxy && realSel) srcProxy.value = realSel.value;
        if (searchHadFocus) {
            const el = this.container.querySelector('.live-guide-search');
            if (el) {
                el.focus();
                if (searchCaret != null) {
                    try { el.setSelectionRange(searchCaret, searchCaret); } catch (_) { /* noop */ }
                }
            }
        }
        // Android TV: put D-pad focus back on the same channel row we captured before
        // the re-render, so navigation stays put instead of jumping to another channel.
        // Only when a row had focus before; guard the lookup + existence so an unusual
        // id can never throw and break render (falls back to the old lose-focus path).
        if (tvFocusedRowKey && tvFocusedRowKey.channelId != null) {
            let restoreRow = null;
            try {
                restoreRow = this.container.querySelector(
                    `.live-guide-row[data-channel-id="${tvFocusedRowKey.channelId}"][data-source-id="${tvFocusedRowKey.sourceId}"]`
                );
            } catch (_) { restoreRow = null; }
            if (restoreRow) restoreRow.focus({ preventScroll: true });
        } else if (tvFocusedAction) {
            const btn = this.container.querySelector(`.live-guide-preview [data-action="${tvFocusedAction}"]`);
            if (btn) btn.focus({ preventScroll: true });
        }
        this.updateHighlights();

        // Keep the playing row (or the previewed last-watched one) centered in the rows on
        // load AND through the EPG-driven re-renders that land a beat later — those add
        // now/next lines that grow the rows above and would otherwise drift the centered
        // row off-screen. Re-center on every render UNTIL the user scrolls the guide
        // themselves, after which their position is preserved (prevScroll, above).
        if (rows && !this._userScrolledGuide) {
            const targetRow = rows.querySelector('.live-guide-row.playing')
                || rows.querySelector('.live-guide-row.selected');
            if (targetRow) {
                requestAnimationFrame(() => {
                    try {
                        const r = rows.getBoundingClientRect();
                        const pr = targetRow.getBoundingClientRect();
                        this._lastProgrammaticGuideScrollAt = Date.now();
                        rows.scrollTop += (pr.top - r.top) - (rows.clientHeight - targetRow.offsetHeight) / 2;
                    } catch (_) { /* best-effort */ }
                });
            }
        }
        // First manual scroll of the guide hands control to the user — stop auto-centering.
        // Our own programmatic scrolls (above + the prevScroll restore) are ignored via a
        // short time guard so they don't count as a manual scroll.
        if (rows) {
            rows.addEventListener('scroll', () => {
                if (Date.now() - (this._lastProgrammaticGuideScrollAt || 0) > 250) {
                    this._userScrolledGuide = true;
                }
            }, { passive: true });
        }
        this.syncNavigationState();
        this._applyCinema();   // keep the player/guide split in sync with cinema state
        // Android TV: seed the 16:9 preview box with the selected channel's art so the
        // browse view is never a blank/spinning box before the first D-pad move.
        if (this._isTvMode()) this._updateTvLiveArt(selectedChannel);
    }
}

window.LiveGuideFusion = LiveGuideFusion;
