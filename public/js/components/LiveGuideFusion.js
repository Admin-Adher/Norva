/**
 * TiviMate-style Live TV guide embedded in the Live page.
 */
class LiveGuideFusion {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('live-guide-fusion');
        this.activeGroup = localStorage.getItem('norva_live_guide_group') || '';
        this.currentChannel = null;
        this._lastChannelsKey = '';
        this._pendingFamilySelection = null;
        this.init();
    }

    init() {
        if (!this.container) return;

        this.container.addEventListener('click', (event) => {
            const groupBtn = event.target.closest('.live-guide-group');
            if (groupBtn) {
                this.activeGroup = groupBtn.dataset.group || '';
                localStorage.setItem('norva_live_guide_group', this.activeGroup);
                this.render();
                this.refreshBrokenChannelsInActiveGroup();
                return;
            }

            const row = event.target.closest('.live-guide-row');
            if (row) {
                this.selectFamilyRow(row);
            }
        });

        window.addEventListener('channelChanged', (event) => {
            this.currentChannel = event.detail || null;
            this.render();
        });
        window.addEventListener('playbackModeScanComplete', (event) => {
            this.selectPendingFamilyIfReady(event.detail);
            this.render();
        });
        window.addEventListener('playbackStatusChanged', () => this.render());
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

    selectFamilyRow(row) {
        const members = this.getFamilyMembersFromRow(row);
        if (!members.length) return;

        const bestChannel = this.getBestFamilyChannel(members);
        const hasHealthyVariant = members.some(channel => this.app.channelList.isHealthyChannel(channel));
        const allKnownBad = members.every(channel => this.isProblematicChannel(channel));

        if (!hasHealthyVariant && allKnownBad) {
            this._pendingFamilySelection = {
                sourceId: String(bestChannel.sourceId),
                familyKey: this.app.channelList.getChannelFamilyKey(bestChannel),
                label: this.app.channelList.getChannelFamilyLabel(bestChannel) || bestChannel.name
            };
            this.render();
            this.refreshFamilyIfNeeded(bestChannel, members, { force: true });
            return;
        }

        this.refreshFamilyIfNeeded(bestChannel, members);
        this.playChannel(bestChannel);
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
            groups.push({ id: 'Favorites', name: 'Favoris' });
        }
        groups.push({ id: '', name: 'Toutes les Chaines' });

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

    getVariantQualityScore(channel) {
        const list = this.app.channelList;
        const name = String(channel?.name || '').toLowerCase();
        const mode = list.getPlaybackMode(channel);
        let score = 0;

        if (list.isHealthyChannel(channel)) score += 10000;
        if (mode === 'transcoding_audio') score += 6000;
        if (mode === 'direct_play') score += 3000;
        if (this.isProblematicChannel(channel)) score -= 10000;

        if (/\bfhd\b|full\s*hd|superhd/.test(name)) score += 500;
        else if (/\bhd\b/.test(name)) score += 400;
        else if (/\b4k\b|\buhd\b/.test(name)) score += 300;
        else if (/\bsd\b/.test(name)) score += 100;

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
                title: `${healthyCount} variante${healthyCount > 1 ? 's' : ''} fonctionnelle${healthyCount > 1 ? 's' : ''}`
            };
        }

        if (problematicCount === total) {
            return {
                label: total > 1 ? `${total} HS` : 'HS',
                className: 'problem',
                title: `${total} variante${total > 1 ? 's' : ''} testee${total > 1 ? 's' : ''} HS`
            };
        }

        return {
            label: `${total - problematicCount}/${total}`,
            className: 'pending',
            title: 'Variantes partiellement testees'
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
            ? 'Favoris'
            : (this.activeGroup || 'Toutes les chaines');

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
        if (channel.tvgId && guide.channelMap?.has(channel.tvgId)) {
            return guide.channelMap.get(channel.tvgId);
        }
        if (channel.name && guide.channelMap?.has(String(channel.name).toLowerCase())) {
            return guide.channelMap.get(String(channel.name).toLowerCase());
        }
        return guide.channels.find(epg => epg.id === channel.tvgId || epg.name === channel.name) || null;
    }

    getProgramAt(channel, date) {
        const guide = this.app.epgGuide;
        const epgChannel = this.getEpgChannel(channel);
        if (!epgChannel || !guide?.programmes?.length) return null;
        const time = date.getTime();
        return guide.programmes.find(program => {
            if (program.channelId !== epgChannel.id) return false;
            const start = new Date(program.start).getTime();
            const stop = new Date(program.stop).getTime();
            return time >= start && time < stop;
        }) || null;
    }

    formatTime(value) {
        if (!value) return '';
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    getProgress(program) {
        if (!program?.start || !program?.stop) return 0;
        const start = new Date(program.start).getTime();
        const stop = new Date(program.stop).getTime();
        const now = Date.now();
        if (stop <= start) return 0;
        return Math.max(0, Math.min(100, ((now - start) / (stop - start)) * 100));
    }

    buildSlots() {
        const now = new Date();
        now.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
        return [0, 30, 60].map(offset => {
            const slot = new Date(now);
            slot.setMinutes(slot.getMinutes() + offset);
            return slot;
        });
    }

    renderPreview(channel) {
        const program = channel ? this.getProgramAt(channel, new Date()) : null;
        const progress = this.getProgress(program);
        const title = program?.title || 'Pas d information';
        const start = program?.start ? this.formatTime(program.start) : '--:--';
        const stop = program?.stop ? this.formatTime(program.stop) : '--:--';
        const logo = channel ? this.getProxiedImageUrl(channel.tvgLogo) : '/img/placeholder.png';
        const group = channel?.groupTitle || this.activeGroup || '';

        return `
            <div class="live-guide-preview">
                <div class="live-guide-preview-art">
                    <img src="${logo}" alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
                </div>
                <div class="live-guide-preview-copy">
                    <div class="live-guide-preview-title">${this.escapeHtml(title)}</div>
                    <div class="live-guide-preview-meta">
                        <span>${this.escapeHtml(start)} - ${this.escapeHtml(stop)}</span>
                        <span class="live-guide-progress"><span style="width:${progress}%"></span></span>
                    </div>
                    <div class="live-guide-preview-channel">
                        ${this.escapeHtml(channel?.name || 'Aucune chaine')}
                        ${group ? `<span>${this.escapeHtml(group)}</span>` : ''}
                    </div>
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

    renderRows(channels, slots) {
        const families = this.buildFamilyRows(channels);
        if (!families.length) {
            return '<div class="live-guide-empty">Aucune chaine visible dans ce groupe</div>';
        }

        return `
            <div class="live-guide-table">
                <div class="live-guide-time-head">
                    <span></span>
                    ${slots.map(slot => `<span>${slot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`).join('')}
                </div>
                <div class="live-guide-rows">
                    ${families.slice(0, 120).map((family, index) => this.renderRow(family, index, slots)).join('')}
                </div>
            </div>
        `;
    }

    renderRow(family, index, slots) {
        const channel = family.display || family.best || family.members[0];
        const isPending = this.isPendingFamily(family);
        const isActive = this.isFamilyActive(family) || isPending;
        const badge = isPending
            ? { label: 'SCAN', className: 'pending', title: 'Verification des variantes' }
            : family.badge;
        const variantLabel = family.members.length > 1 ? `${family.members.length} variantes` : (channel.name || '');
        return `
            <button class="live-guide-row ${isActive ? 'active' : ''} ${isPending ? 'pending-refresh' : ''}" data-channel-id="${channel.id}" data-source-id="${channel.sourceId}" data-family-key="${this.escapeHtml(family.familyKey)}">
                <span class="live-guide-channel-cell">
                    <span class="live-guide-num">${channel.num || index + 1}</span>
                    <img src="${this.getProxiedImageUrl(channel.tvgLogo)}" alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
                    <span class="live-guide-channel-name">${this.escapeHtml(family.label)}</span>
                    <span class="live-guide-variant-count">${this.escapeHtml(variantLabel)}</span>
                    ${badge ? `<span class="live-guide-mode ${badge.className}" title="${this.escapeHtml(badge.title)}">${badge.label}</span>` : ''}
                </span>
                ${slots.map(slot => {
                    const program = this.getProgramAt(channel, slot);
                    return `<span class="live-guide-program ${program ? 'has-program' : ''}">${this.escapeHtml(program?.title || 'Pas d information')}</span>`;
                }).join('')}
            </button>
        `;
    }

    render() {
        if (!this.container) return;
        const channels = this.getPlayableChannels();
        const groups = this.getGroups(channels);
        this.ensureActiveGroup(groups);
        const groupChannels = this.filterGroup(channels);
        const selectedChannel = this.currentChannel || this.app.channelList.currentChannel || groupChannels[0] || channels[0] || null;
        const slots = this.buildSlots();
        const channelsKey = `${channels.length}:${this.activeGroup}:${selectedChannel?.id || ''}`;
        this._lastChannelsKey = channelsKey;

        this.container.innerHTML = `
            <div class="live-guide-shell">
                ${this.renderGroups(groups)}
                <div class="live-guide-main">
                    ${this.renderPreview(selectedChannel)}
                    ${this.renderRows(groupChannels, slots)}
                </div>
            </div>
        `;
        this.app.channelList.updateScanScopeHint?.();
    }
}

window.LiveGuideFusion = LiveGuideFusion;
