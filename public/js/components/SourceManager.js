/**
 * Source Manager Component
 * Handles adding, editing, and deleting sources (Xtream, M3U, EPG)
 */

class SourceManager {
    constructor() {
        this.xtreamList = document.getElementById('xtream-list');
        this.m3uList = document.getElementById('m3u-list');
        this.epgList = document.getElementById('epg-list');

        // Content browser state
        this.contentType = 'channels'; // 'channels' or 'movies'
        this.treeData = null; // { type, sourceId, groups: [{ id, name, categoryId, items: [] }] }
        this.hiddenSet = new Set(); // Set of hidden item keys (current state)
        this.originalHiddenSet = new Set(); // Set of hidden item keys (state when loaded)
        this.expandedGroups = new Set(); // Set of expanded group IDs
        this.searchQuery = ''; // Search filter for content browser

        this.init();
    }

    init() {
        // Add source buttons
        document.getElementById('add-xtream').addEventListener('click', () => this.showAddModal('xtream'));
        document.getElementById('add-m3u').addEventListener('click', () => this.showAddModal('m3u'));
        document.getElementById('add-epg').addEventListener('click', () => this.showAddModal('epg'));

        // Initialize content browser
        this.initContentBrowser();

        // Start polling sync status
        this.pollSyncStatus();
    }

    isInvalidDeviceTokenError(err) {
        const text = `${err?.message || ''} ${err?.payload?.error || ''} ${err?.payload?.message || ''}`;
        return Boolean(err?.deviceTokenInvalid) || /invalid\s+(bearer\s+)?(device\s+)?token|device\s+token|expired\s+(device\s+)?token/i.test(text);
    }

    isMissingCloudTokenError(err) {
        const text = `${err?.message || ''} ${err?.payload?.error || ''} ${err?.payload?.message || ''}`;
        return /missing\s+(bearer\s+)?token|not\s+signed\s+in|auth\s+session\s+missing/i.test(text);
    }

    /**
     * Show a styled warning modal with Cancel/Proceed buttons
     * @param {Object} options - { title, message, details, proceedText, cancelText }
     * @returns {Promise<boolean>} - Resolves true if user clicks Proceed, false if Cancel
     */
    showWarningModal({ title, message, details = '', proceedText = 'Proceed', cancelText = 'Cancel' }) {
        return new Promise((resolve) => {
            const modal = document.getElementById('modal');
            const modalTitle = document.getElementById('modal-title');
            const modalBody = document.getElementById('modal-body');
            const modalFooter = document.getElementById('modal-footer');

            modalTitle.textContent = title;

            modalBody.innerHTML = `
                <div class="warning-modal-content">
                    <div class="warning-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width: 48px; height: 48px; color: var(--color-warning, #f59e0b);">
                            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                        </svg>
                    </div>
                    <p class="warning-message" style="font-size: 1rem; margin: var(--space-md) 0; color: var(--color-text-primary);">${message}</p>
                    ${details ? `<p class="warning-details" style="font-size: 0.875rem; color: var(--color-text-muted); background: var(--color-bg-tertiary); padding: var(--space-md); border-radius: var(--radius-md); text-align: left;">${details}</p>` : ''}
                </div>
            `;

            modalFooter.innerHTML = `
                <button class="btn btn-secondary" id="warning-cancel">${cancelText}</button>
                <button class="btn btn-primary" id="warning-proceed" style="background: var(--color-warning, #f59e0b); border-color: var(--color-warning, #f59e0b);">${proceedText}</button>
            `;

            modal.classList.add('active');

            const cleanup = () => {
                modal.classList.remove('active');
                modal.querySelector('.modal-close').onclick = null;
            };

            document.getElementById('warning-cancel').onclick = () => {
                cleanup();
                resolve(false);
            };

            document.getElementById('warning-proceed').onclick = () => {
                cleanup();
                resolve(true);
            };

            modal.querySelector('.modal-close').onclick = () => {
                cleanup();
                resolve(false);
            };
        });
    }

    /**
     * Poll sync status from the backend
     */
    pollSyncStatus() {
        // Implement polling logic here
        console.log('Polling sync status...');
        // Example: setInterval(() => this.updateSyncStatus(), 5000);
    }

    /**
     * Update sync status display
     */
    updateSyncStatus() {
        // Implement logic to update UI based on sync status
        console.log('Updating sync status display...');
    }

    /**
     * Load and display all sources
     */
    async loadSources() {
        try {
            const [sources, statuses] = await Promise.all([
                API.sources.getAll(),
                API.sources.getStatus().catch(() => [])
            ]);
            this.sourceStatuses = statuses || [];

            this.renderSourceList(this.xtreamList, sources.filter(s => s.type === 'xtream'), 'xtream');
            this.renderSourceList(this.m3uList, sources.filter(s => s.type === 'm3u'), 'm3u');
            this.renderSourceList(this.epgList, sources.filter(s => s.type === 'epg'), 'epg');
            window.app?.pages?.settings?.refreshSourceHealthCard?.();
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * Render source list
     */
    sourceStatusFor(source = {}) {
        const sourceIds = [
            source.id,
            source.source_id,
            source.sourceId,
            source.cloudId,
            source.cloud_id
        ].filter(Boolean).map(value => String(value));
        if (!sourceIds.length) return {};
        const sourceIdSet = new Set(sourceIds);
        return (this.sourceStatuses || []).find(status => {
            const candidates = [
                status.source_id,
                status.sourceId,
                status.id,
                status.cloudId,
                status.cloud_id
            ].filter(Boolean).map(value => String(value));
            return candidates.some(candidate => sourceIdSet.has(candidate));
        }) || {};
    }

    sourceWithStatus(source = {}) {
        const status = this.sourceStatusFor(source);
        return {
            ...source,
            sync_status: source.sync_status || source.syncStatus || status.status || status.sync_status || '',
            sync_error: source.sync_error || source.syncError || status.error || status.sync_error || '',
            syncProgress: source.syncProgress || source.sync_progress || status.syncProgress || status.sync_progress || null,
            sync_progress: source.sync_progress || source.syncProgress || status.sync_progress || status.syncProgress || null,
            last_sync: source.last_sync || source.lastSync || status.last_sync || status.lastSyncedAt || null
        };
    }

    renderSourceList(container, sources, type) {
        const labels = {
            xtream: 'provider accounts',
            m3u: 'playlist links',
            epg: 'TV guide feeds'
        };
        if (sources.length === 0) {
            container.innerHTML = `<p class="hint">No ${labels[type] || 'providers'} configured</p>`;
            return;
        }

        const icons = { xtream: Icons.live, m3u: Icons.guide, epg: Icons.series };

        container.innerHTML = sources.map(source => {
            const sourceView = this.sourceWithStatus(source);
            const health = window.NorvaSourceHealth?.classifySource(sourceView, this.sourceStatuses || []) || {
                state: source.enabled === false ? 'degraded' : 'ready',
                label: source.enabled === false ? 'Disabled' : 'Ready',
                message: ''
            };
            const progressButton = health.state === 'syncing'
                ? `<button class="btn btn-sm btn-secondary source-progress-btn" data-action="progress" title="View catalog import progress">Progress</button>`
                : '';
            return `
      <div class="source-item ${source.enabled ? '' : 'disabled'} ${health.needsAttention ? 'needs-attention' : ''}" data-id="${this.escapeHtml(source.id)}">
        <span class="source-icon">${icons[type]}</span>
        <div class="source-info">
          <div class="source-name-row">
            <span class="source-name">${this.escapeHtml(source.name)}</span>
            <span class="source-health-badge source-health-${this.escapeHtml(health.state)}">${this.escapeHtml(health.label)}</span>
          </div>
          <div class="source-url">${this.escapeHtml(source.url || 'Managed by Norva Cloud')}</div>
          ${health.message && health.state !== 'ready' ? `<div class="source-health-message">${this.escapeHtml(health.message)}</div>` : ''}
        </div>
        <div class="source-actions">
          ${progressButton}
          <button class="btn btn-sm btn-secondary" data-action="refresh" title="Sync TV service">${Icons.refresh}</button>
          <button class="btn btn-sm btn-secondary btn-warning-outline" data-action="hard-refresh" title="Rebuild catalog from this service">${Icons.refresh}</button>
          <button class="btn btn-sm btn-secondary" data-action="test" title="Check service">${Icons.link}</button>
          <button class="btn btn-sm btn-secondary" data-action="toggle" title="${source.enabled ? 'Disable' : 'Enable'}">
            ${source.enabled ? Icons.check : Icons.circle}
          </button>
          <button class="btn btn-sm btn-secondary ${health.needsAttention ? 'btn-repair' : ''}" data-action="edit" title="${health.needsAttention ? 'Repair service' : 'Edit service'}">${Icons.settings}</button>
          <button class="btn btn-sm btn-danger" data-action="delete" title="Delete">${Icons.close}</button>
        </div>
      </div>
    `;
        }).join('');

        // Attach event listeners
        container.querySelectorAll('.source-item').forEach(item => {
            const id = item.dataset.id;

            item.querySelector('[data-action="progress"]')?.addEventListener('click', () => this.showCatalogPreparationById(id, type));
            item.querySelector('[data-action="refresh"]').addEventListener('click', () => this.refreshSource(id, type));
            item.querySelector('[data-action="hard-refresh"]').addEventListener('click', () => this.refreshSource(id, type, { hard: true }));
            item.querySelector('[data-action="test"]').addEventListener('click', () => this.testSource(id));
            item.querySelector('[data-action="toggle"]').addEventListener('click', () => this.toggleSource(id));
            item.querySelector('[data-action="edit"]').addEventListener('click', () => this.showEditModal(id, type));
            item.querySelector('[data-action="delete"]').addEventListener('click', () => this.deleteSource(id));
        });
    }

    /**
     * Show add source modal
     */
    showAddModal(type) {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');

        const titles = { xtream: 'Add TV provider', m3u: 'Add playlist link', epg: 'Add TV guide' };
        title.textContent = titles[type];

        body.innerHTML = this.getSourceForm(type);

        footer.innerHTML = `
      <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Add</button>
    `;

        modal.classList.add('active');

        // Event listeners
        modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
        document.getElementById('modal-cancel').onclick = () => modal.classList.remove('active');
        document.getElementById('modal-save').onclick = () => this.saveNewSource(type);
        this.bindSourceForm(type);
    }

    /**
     * Show edit source modal
     */
    async showEditModal(id, type) {
        try {
            const source = await API.sources.getById(id);

            const modal = document.getElementById('modal');
            const title = document.getElementById('modal-title');
            const body = document.getElementById('modal-body');
            const footer = document.getElementById('modal-footer');

            const titles = { xtream: 'Edit TV provider', m3u: 'Edit playlist link', epg: 'Edit TV guide' };
            title.textContent = titles[type] || 'Edit provider';
            body.innerHTML = this.getSourceForm(type, source);

            footer.innerHTML = `
        <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save Changes</button>
      `;

            modal.classList.add('active');

            modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
            document.getElementById('modal-cancel').onclick = () => modal.classList.remove('active');
            document.getElementById('modal-save').onclick = () => this.updateSource(id, type);
            this.bindSourceForm(type);
        } catch (err) {
            console.error('Error loading source:', err);
        }
    }

    /**
     * Get source form HTML
     */
    sourceHost(source = {}) {
        const config = source.configHint || source.config_hint || {};
        const candidates = [
            source.serverHost,
            source.providerHost,
            config.serverHost,
            config.playlistHost,
            source.url
        ].filter(Boolean);

        for (const candidate of candidates) {
            const host = this.hostFromUrl(candidate) || String(candidate || '').trim();
            if (host) return host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
        }
        return '';
    }

    editableSourceUrl(type, source = {}) {
        const raw = String(source.url || source.serverUrl || source.server_url || '').trim();
        if (/^https?:\/\//i.test(raw)) return raw;
        const host = this.sourceHost(source);
        if (type === 'xtream' && host) return `https://${host}`;
        return raw;
    }

    hasSavedPassword(source = {}) {
        const config = source.configHint || source.config_hint || {};
        return Boolean(source.hasPassword || config.hasPassword || (source.cloud && source.username));
    }

    getSavedConnectionCard(type, source = {}) {
        const isExisting = Boolean(source.id || source.cloudId || source.cloud_id);
        if (!isExisting) return '';

        const host = this.sourceHost(source);
        const username = source.username || (source.configHint || source.config_hint || {}).username || '';
        const hasPassword = type === 'xtream' && this.hasSavedPassword(source);

        return `
      <div class="source-saved-connection">
        <div class="source-saved-title">Saved connection</div>
        <div class="source-saved-grid">
          <span>Server</span>
          <strong>${this.escapeHtml(host || 'Saved privately')}</strong>
          ${type === 'xtream' ? `
          <span>Username</span>
          <strong>${this.escapeHtml(username || 'Saved privately')}</strong>
          <span>Password</span>
          <strong><span class="source-secret-mask">${hasPassword ? '&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;' : 'Not saved'}</span></strong>
          ` : ''}
        </div>
      </div>
    `;
    }

    getSourceForm(type, source = {}) {
        const intros = {
            xtream: 'Paste the complete link from your TV service, or enter the server URL, username and password separately.',
            m3u: 'Use this when your TV service gives you a playlist link ending in .m3u or .m3u8.',
            epg: 'Use this when your TV service gives you a separate TV guide link.'
        };
        const isExisting = Boolean(source.id || source.cloudId || source.cloud_id);
        const urlValue = this.editableSourceUrl(type, source);
        const savedConnectionCard = this.getSavedConnectionCard(type, source);
        const introField = `
      <p class="source-form-intro">${this.escapeHtml(intros[type] || 'Connect a TV service to Norva.')}</p>
    `;
        const nameField = `
      <div class="form-group">
        <label for="source-name">Service name <span class="label-optional">(optional)</span></label>
        <input type="text" id="source-name" class="form-input" placeholder="Family TV" value="${this.escapeHtml(source.name || '')}">
      </div>
    `;

        const urlField = `
      <div class="form-group">
        <label for="source-url">${type === 'xtream' ? 'Provider URL or complete Xtream link' : type === 'epg' ? 'TV guide URL' : 'Playlist URL'}</label>
        <input type="text" id="source-url" class="form-input" 
               placeholder="${type === 'xtream' ? 'https://provider.com/get.php?username=...&password=...' : 'https://example.com/playlist.m3u'}"
               value="${this.escapeHtml(urlValue)}">
        ${type === 'xtream' ? '<p class="hint" id="source-url-parse-hint">If you paste a full Xtream link, Norva will fill the login fields automatically.</p>' : ''}
        ${source.cloud ? '<p class="hint">Norva keeps the original full link private. The saved server is shown here. Paste a complete link only when replacing or repairing the login.</p>' : ''}
      </div>
    `;

        if (type === 'xtream') {
            const advancedOpen = source.id ? ' open' : '';
            return `
        ${introField}
        ${savedConnectionCard}
        ${urlField}
        ${nameField}
        <details class="source-advanced-login" id="source-advanced-login"${advancedOpen}>
          <summary>Enter server login manually</summary>
          <div class="form-group">
          <label for="source-username">Username</label>
          <input type="text" id="source-username" class="form-input" value="${this.escapeHtml(source.username || '')}">
          </div>
          <div class="form-group">
          <label for="source-password">Password</label>
          <input type="password" id="source-password" class="form-input"
                 placeholder="${isExisting ? 'Password saved - leave blank to keep it' : ''}"
                 value="${source.password && !source.password.includes('•') ? this.escapeHtml(source.password) : ''}">
            ${isExisting ? '<p class="hint">Leave this empty to keep the saved password. Type a new password only when repairing or replacing the login.</p>' : ''}
          </div>
        </details>
      `;
        }

        return introField + savedConnectionCard + urlField + nameField;
    }

    bindSourceForm(type) {
        if (type !== 'xtream') return;
        const urlInput = document.getElementById('source-url');
        const nameInput = document.getElementById('source-name');
        const usernameInput = document.getElementById('source-username');
        const passwordInput = document.getElementById('source-password');
        const advancedLogin = document.getElementById('source-advanced-login');
        const hint = document.getElementById('source-url-parse-hint');
        if (!urlInput || !usernameInput || !passwordInput) return;

        const applyParsedLink = (force = false) => {
            const parsed = this.parseXtreamLink(urlInput.value);
            if (!parsed) {
                if (hint) hint.textContent = 'If you paste a full Xtream link, Norva will fill the login fields automatically.';
                return;
            }

            if (parsed.serverUrl) {
                urlInput.value = parsed.serverUrl;
            }
            if (parsed.username && (force || !usernameInput.value.trim())) {
                usernameInput.value = parsed.username;
            }
            if (parsed.password && (force || !passwordInput.value.trim())) {
                passwordInput.value = parsed.password;
            }
            if ((!parsed.username || !parsed.password) && advancedLogin) {
                advancedLogin.open = true;
            }
            if (nameInput && !nameInput.value.trim() && parsed.host) {
                nameInput.value = parsed.host.replace(/^www\./i, '');
            }
            if (hint) {
                hint.textContent = parsed.username && parsed.password
                    ? 'Login detected from the link. You can review it before saving.'
                    : 'Server detected. Add the username and password if they were provided separately.';
            }
        };

        urlInput.addEventListener('paste', () => setTimeout(() => applyParsedLink(true), 0));
        urlInput.addEventListener('blur', () => applyParsedLink(false));
        urlInput.addEventListener('change', () => applyParsedLink(false));
    }

    openAdvancedSourceLogin() {
        const advancedLogin = document.getElementById('source-advanced-login');
        if (advancedLogin) advancedLogin.open = true;
    }

    async showCatalogPreparationById(id, type = 'xtream') {
        try {
            const source = await API.sources.getById(id);
            this.showCatalogPreparation(this.sourceWithStatus(source || { id }), type);
        } catch (err) {
            console.warn('[SourceManager] Unable to reopen catalog preparation:', err);
            this.showCatalogPreparation(this.sourceWithStatus({ id, name: 'TV service' }), type);
        }
    }

    parseXtreamLink(raw) {
        const value = String(raw || '').trim();
        if (!value) return null;
        let url;
        try {
            const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
            url = new URL(withScheme);
        } catch (_) {
            return null;
        }

        const knownEndpoints = new Set(['get.php', 'player_api.php', 'xmltv.php', 'panel_api.php']);
        const pathParts = url.pathname.split('/').filter(Boolean);
        const lowerParts = pathParts.map(part => part.toLowerCase());
        const endpointIndex = lowerParts.findIndex(part => knownEndpoints.has(part));
        const streamIndex = lowerParts.findIndex(part => ['live', 'movie', 'series'].includes(part));
        let username = url.searchParams.get('username') || url.searchParams.get('user') || '';
        let password = url.searchParams.get('password') || url.searchParams.get('pass') || '';
        let baseParts = pathParts;

        if (endpointIndex >= 0) {
            baseParts = pathParts.slice(0, endpointIndex);
        } else if (streamIndex >= 0 && pathParts.length >= streamIndex + 3) {
            username = username || decodeURIComponent(pathParts[streamIndex + 1] || '');
            password = password || decodeURIComponent(pathParts[streamIndex + 2] || '');
            baseParts = pathParts.slice(0, streamIndex);
        } else if (username || password) {
            baseParts = [];
        }

        const basePath = baseParts.length ? `/${baseParts.join('/')}` : '';
        const serverUrl = `${url.protocol}//${url.host}${basePath}`.replace(/\/+$/, '');
        if (!serverUrl || serverUrl === `${url.protocol}//`) return null;

        return {
            serverUrl,
            username,
            password,
            host: url.hostname
        };
    }

    readSourceForm(type, { existing = false } = {}) {
        let name = document.getElementById('source-name')?.value.trim() || '';
        let url = document.getElementById('source-url')?.value.trim() || '';
        let username = document.getElementById('source-username')?.value.trim() || null;
        let password = document.getElementById('source-password')?.value.trim() || null;

        if (type === 'xtream') {
            const parsed = this.parseXtreamLink(url);
            if (parsed) {
                url = parsed.serverUrl || url;
                username = username || parsed.username || null;
                password = password || parsed.password || null;
            }
        }

        if (!url && !(existing && type === 'xtream' && !password)) {
            throw new Error('Provider URL is required.');
        }

        if (!name) {
            const parsed = type === 'xtream' ? this.parseXtreamLink(url) : null;
            const hostName = parsed?.host || this.hostFromUrl(url);
            const fallbackName = type === 'm3u' ? 'Playlist' : type === 'epg' ? 'TV guide' : 'TV service';
            name = hostName ? hostName.replace(/^www\./i, '') : fallbackName;
        }

        if (type === 'xtream' && (!username || (!password && !existing))) {
            throw new Error(existing
                ? 'Username is required. Enter the password too only when repairing the login.'
                : 'Provider URL, username and password are required.');
        }

        return { name, url, username, password };
    }

    hostFromUrl(raw) {
        try {
            const value = String(raw || '').trim();
            if (!value) return '';
            const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
            return url.hostname || '';
        } catch (_) {
            return '';
        }
    }

    catalogCountsFromSource(source = {}) {
        const config = source.configHint || source.config_hint || {};
        const progress = this.syncProgressFromSource(source);
        const progressCounts = progress.counts || {};
        const progressCategories = progress.categories || {};
        const lastSync = source.lastSync || config.lastSync || source.last_sync_result || {};
        const live = Number(progressCounts.live ?? lastSync.live ?? lastSync.channels ?? lastSync.liveChannels ?? lastSync.liveCatalog?.channels ?? 0) || 0;
        const movies = Number(progressCounts.movies ?? lastSync.movies ?? lastSync.vod ?? lastSync.vodMovies ?? 0) || 0;
        const series = Number(progressCounts.series ?? lastSync.series ?? lastSync.tvSeries ?? 0) || 0;
        const lastSyncCategories =
            (Number(lastSync.liveCategories) || 0) +
            (Number(lastSync.movieCategories) || 0) +
            (Number(lastSync.seriesCategories) || 0);
        const categories = Number(progressCategories.total ?? lastSyncCategories) || 0;
        return {
            live,
            movies,
            series,
            categories,
            total: Number(progressCounts.total ?? lastSync.total ?? (live + movies + series)) || 0,
            syncedAt: lastSync.syncedAt || progress.updatedAt || source.last_sync || source.last_synced_at || null
        };
    }

    syncProgressFromSource(source = {}) {
        const config = source.configHint || source.config_hint || {};
        const progress = source.syncProgress || source.sync_progress || config.syncProgress || config.sync_progress || {};
        if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return {};
        return this.monotonicSyncProgress(source, progress);
    }

    boundedProgressPercent(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return 0;
        return Math.max(0, Math.min(100, numeric));
    }

    syncProgressCacheKey(source = {}, progress = {}) {
        const sourceId = source.id || source.source_id || source.external_id || source.name || 'unknown';
        const startedAt = progress.startedAt || progress.started_at || source.sync_started_at || source.created_at || '';
        return `norva-sync-progress:${sourceId}:${startedAt}`;
    }

    monotonicSyncProgress(source = {}, progress = {}) {
        const nextProgress = { ...progress };
        const status = String(progress.status || progress.stage || source.sync_status || source.syncStatus || '').toLowerCase();
        const terminal = new Set(['ready', 'success', 'complete', 'completed']);
        const cacheKey = this.syncProgressCacheKey(source, progress);
        const rawPercent = terminal.has(status) ? 100 : this.boundedProgressPercent(progress.percent);
        let previousPercent = 0;
        try {
            previousPercent = this.boundedProgressPercent(window.localStorage?.getItem(cacheKey));
        } catch (error) {
            previousPercent = 0;
        }
        const visiblePercent = Math.max(previousPercent, rawPercent);
        nextProgress.percent = visiblePercent;
        try {
            if (terminal.has(status)) {
                window.localStorage?.removeItem(cacheKey);
            } else {
                window.localStorage?.setItem(cacheKey, String(visiblePercent));
            }
        } catch (error) {
            // Progress rendering should never fail because local storage is unavailable.
        }
        return nextProgress;
    }

    sourceSyncState(source = {}) {
        const status = String(source.sync_status || source.syncStatus || '').toLowerCase();
        const progress = this.syncProgressFromSource(source);
        const progressStatus = String(progress.status || progress.stage || '').toLowerCase();
        const counts = this.catalogCountsFromSource(source);
        const failedStates = new Set(['error', 'failed', 'auth_failed', 'expired', 'unreachable', 'revoked']);
        const readyStates = new Set(['ready', 'success', 'complete', 'completed']);
        const syncingStates = new Set(['syncing', 'checking', 'pending', 'connecting', 'discovering', 'discovered', 'importing', 'materializing', 'building_titles', 'building_live_channels', 'building_live_variants', 'finalizing']);

        if (failedStates.has(status) || failedStates.has(progressStatus)) return { phase: 'error', counts, progress };
        if (readyStates.has(status) || readyStates.has(progressStatus)) return { phase: 'ready', counts, progress };
        if (syncingStates.has(status) || syncingStates.has(progressStatus)) return { phase: 'syncing', counts, progress };
        if (counts.total > 0) return { phase: 'ready', counts, progress };
        return { phase: 'syncing', counts, progress };
    }

    shouldRecoverCatalogFinalization(source = {}, options = {}) {
        const { requireStale = true } = options || {};
        const progress = this.syncProgressFromSource(source);
        const stage = String(progress.stage || '').toLowerCase();
        const status = String(progress.status || source.sync_status || source.syncStatus || '').toLowerCase();
        const finalizingStages = new Set(['materializing', 'building_titles', 'building_live_channels', 'building_live_variants', 'finalizing']);
        const importStep = progress.steps && typeof progress.steps === 'object' ? progress.steps.import : null;
        const finalizeStep = progress.steps && typeof progress.steps === 'object' ? progress.steps.finalize : null;
        const importDone = importStep && typeof importStep === 'object'
            ? String(importStep.status || '').toLowerCase() === 'done'
            : false;
        const finalizeStatus = finalizeStep && typeof finalizeStep === 'object'
            ? String(finalizeStep.status || '').toLowerCase()
            : '';
        const finalizing = finalizingStages.has(stage) || ['running', 'in_progress', 'pending'].includes(finalizeStatus);
        const total = Number((progress.counts && progress.counts.total) || this.catalogCountsFromSource(source).total || 0) || 0;
        const updatedAt = Date.parse(progress.updatedAt || source.updated_at || source.updatedAt || '');
        const staleForMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;

        return status === 'syncing' &&
            finalizing &&
            importDone &&
            total > 0 &&
            (!requireStale || staleForMs > 60_000);
    }

    formatCatalogCount(value, fallback = 'Scanning') {
        return value > 0 ? value.toLocaleString() : fallback;
    }

    catalogMilestones(progress = {}, counts = {}) {
        const steps = progress.steps && typeof progress.steps === 'object' ? progress.steps : {};
        const step = (key, label, count, detail) => {
            const entry = steps[key] && typeof steps[key] === 'object' ? steps[key] : {};
            return {
                key,
                label,
                status: String(entry.status || 'pending').toLowerCase(),
                count: Number(entry.count ?? count ?? 0) || 0,
                detail
            };
        };
        return [
            step('connect', 'Connecting to TV service', 0, 'Secure login check'),
            step('channels', 'Channels found', counts.live, 'Live TV catalog'),
            step('movies', 'Movies found', counts.movies, 'Films catalog'),
            step('series', 'Series found', counts.series, 'Series catalog'),
            step('categories', 'Categories', counts.categories, 'Navigation groups'),
            step('import', 'Import catalog', counts.total, 'Saving items to Norva Cloud'),
            step('finalize', 'Finalize Norva', 0, 'Preparing Home, Live TV and details')
        ];
    }

    renderCatalogMilestone(step) {
        const safeStatus = ['pending', 'running', 'done', 'error', 'skipped'].includes(step.status) ? step.status : 'pending';
        const count = step.count > 0 ? `<strong>${this.escapeHtml(step.count.toLocaleString())}</strong>` : '';
        const statusLabel = {
            pending: 'Waiting',
            running: 'In progress',
            done: 'Done',
            error: 'Needs attention',
            skipped: 'Skipped'
        }[safeStatus] || 'Waiting';
        return `
          <li class="source-sync-milestone source-sync-milestone-${this.escapeHtml(safeStatus)}">
            <span class="source-sync-dot" aria-hidden="true"></span>
            <span class="source-sync-copy">
              <span class="source-sync-line">
                <span>${this.escapeHtml(step.label)}</span>
                ${count}
              </span>
              <small>${this.escapeHtml(step.detail)} - ${this.escapeHtml(statusLabel)}</small>
            </span>
          </li>
        `;
    }

    renderCatalogPreparation(source = {}, type = 'xtream') {
        const { phase, counts, progress } = this.sourceSyncState(source);
        const sourceName = source.name || 'TV service';
        const percent = Math.max(0, Math.min(100, Number(progress.percent ?? (phase === 'ready' ? 100 : 0)) || 0));
        const determinate = percent > 0 || phase === 'ready';
        const statusText = {
            syncing: 'Norva is connecting, counting your catalog and preparing it for Home, Live TV, Movies and Series.',
            ready: 'Your catalog is ready.',
            error: source.sync_error || source.syncError || 'Norva could not finish importing this service.'
        };
        const phaseLabel = phase === 'ready' ? 'Ready' : phase === 'error' ? 'Needs attention' : 'Importing';
        const milestones = this.catalogMilestones(progress, counts).map(step => this.renderCatalogMilestone(step)).join('');

        return `
      <div class="source-sync-step source-sync-${this.escapeHtml(phase)}">
        <div class="source-sync-hero">
          <span class="source-sync-pill">${this.escapeHtml(phaseLabel)}</span>
          <h3>${this.escapeHtml(sourceName)}</h3>
          <p>${this.escapeHtml(statusText[phase] || statusText.syncing)}</p>
        </div>
        <div class="source-sync-grid">
          <div class="source-sync-card">
            <span>Live TV</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.live))}</strong>
            <small>channels found</small>
          </div>
          <div class="source-sync-card">
            <span>Movies</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.movies))}</strong>
            <small>films found</small>
          </div>
          <div class="source-sync-card">
            <span>Series</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.series))}</strong>
            <small>series found</small>
          </div>
          <div class="source-sync-card">
            <span>Categories</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.categories))}</strong>
            <small>groups found</small>
          </div>
        </div>
        <div class="source-sync-progress-wrap">
          <div class="source-sync-progress ${determinate ? 'is-determinate' : ''}" style="--source-sync-percent: ${this.escapeHtml(String(percent))}%;" aria-label="Catalog import progress">
            <span></span>
          </div>
          ${determinate ? `<small>${this.escapeHtml(String(Math.round(percent)))}%</small>` : ''}
        </div>
        <ol class="source-sync-timeline">
          ${milestones}
        </ol>
        ${phase === 'syncing' ? `
          <p class="hint">You can let this continue in the background. Norva will keep this service visible in Settings while it prepares the catalog.</p>
        ` : ''}
        ${phase === 'error' ? `
          <div class="source-sync-error">${this.escapeHtml(statusText.error)}</div>
        ` : ''}
        ${counts.syncedAt && phase === 'ready' ? `
          <p class="hint">Last import: ${this.escapeHtml(new Date(counts.syncedAt).toLocaleString())}</p>
        ` : ''}
      </div>
    `;
    }

    async recoverCatalogFinalization(sourceId, token, render) {
        if (!API.sources.finalize) return;
        const initialBatchLimit = 500;
        const minBatchLimit = 100;
        const refreshAndRender = async () => {
            if (this.catalogPreparationToken !== token) return null;
            const latest = await API.sources.getById(sourceId).catch(() => null);
            if (latest && this.catalogPreparationToken === token) render(this.sourceWithStatus(latest));
            return latest;
        };
        const finalize = async (params) => {
            let limit = Number(params.limit || initialBatchLimit) || initialBatchLimit;
            for (;;) {
                try {
                    return await API.sources.finalize(sourceId, { ...params, limit });
                } catch (error) {
                    if (!this.isRecoverableFinalizeResourceError(error) || limit <= minBatchLimit) throw error;
                    limit = Math.max(minBatchLimit, Math.floor(limit / 2));
                }
            }
        };

        let response = await finalize({ phase: 'live', limit: initialBatchLimit });
        await refreshAndRender();

        let phase = response?.nextPhase || 'titles';
        let offset = Number(response?.nextOffset ?? 0) || 0;
        let safety = 0;
        while (this.catalogPreparationToken === token && phase && phase !== 'complete' && safety < 160) {
            safety += 1;
            response = await finalize({
                phase,
                offset,
                limit: initialBatchLimit
            });
            await refreshAndRender();
            const nextPhase = response?.nextPhase || 'complete';
            const nextOffset = Number(response?.nextOffset ?? 0) || 0;
            if (nextPhase === phase && nextOffset <= offset && !response?.done) break;
            phase = nextPhase;
            offset = nextOffset;
        }

        if (this.catalogPreparationToken !== token) return;
        await API.sources.finalize(sourceId, { phase: 'complete' });
        await refreshAndRender();
    }

    isRecoverableFinalizeResourceError(error) {
        const message = String(error?.message || error || '').toLowerCase();
        return message.includes('compute resources') ||
            message.includes('resource') ||
            message.includes('timeout') ||
            message.includes('worker') ||
            message.includes('memory');
    }

    async showCatalogPreparation(initialSource = {}, type = 'xtream') {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');
        const sourceId = initialSource.id || initialSource.cloudId || initialSource.cloud_id;
        const token = Symbol('catalog-preparation');
        this.catalogPreparationToken = token;

        const closeToSettings = async () => {
            if (this.catalogPreparationToken === token) this.catalogPreparationToken = null;
            modal.classList.remove('active');
            await this.loadSources();
            this.notifySourceHealthChanged();
        };

        const startWatching = async () => {
            await closeToSettings();
            window.location.hash = '#home';
        };

        const render = (source) => {
            const { phase } = this.sourceSyncState(source);
            title.textContent = phase === 'ready' ? 'Catalog ready' : phase === 'error' ? 'TV service needs attention' : 'Preparing your catalog';
            body.innerHTML = this.renderCatalogPreparation(source, type);

            if (phase === 'ready') {
                footer.innerHTML = `
          <button class="btn btn-secondary" id="catalog-stay">Stay in Settings</button>
          <button class="btn btn-primary" id="catalog-start">Start Watching</button>
        `;
                document.getElementById('catalog-stay').onclick = closeToSettings;
                document.getElementById('catalog-start').onclick = startWatching;
            } else if (phase === 'error') {
                footer.innerHTML = `
          <button class="btn btn-secondary" id="catalog-background">Close</button>
          <button class="btn btn-primary" id="catalog-edit">Repair Login</button>
        `;
                document.getElementById('catalog-background').onclick = closeToSettings;
                document.getElementById('catalog-edit').onclick = () => this.showEditModal(sourceId, type);
            } else {
                footer.innerHTML = `
          <button class="btn btn-secondary" id="catalog-background">Run in Background</button>
        `;
                document.getElementById('catalog-background').onclick = closeToSettings;
            }
        };

        modal.querySelector('.modal-close').onclick = closeToSettings;
        modal.classList.add('active');
        render(initialSource);

        if (!sourceId) return;

        let current = initialSource;
        let recoveryStarted = false;
        for (let attempt = 0; attempt < 90; attempt += 1) {
            if (this.catalogPreparationToken !== token) return;
            const { phase } = this.sourceSyncState(current);
            if (phase === 'ready' || phase === 'error') return;

            if (!recoveryStarted && this.shouldRecoverCatalogFinalization(current, { requireStale: false }) && API.sources.finalize) {
                recoveryStarted = true;
                this.recoverCatalogFinalization(sourceId, token, (source) => {
                    current = source || current;
                    render(current);
                })
                    .catch(err => console.warn('[SourceManager] Catalog finalization recovery failed:', err));
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
            if (this.catalogPreparationToken !== token) return;

            try {
                current = await API.sources.getById(sourceId) || current;
                render(current);
            } catch (err) {
                console.warn('[SourceManager] Catalog preparation poll failed:', err);
            }
        }
    }

    /**
     * Save new source
     */
    async saveNewSource(type) {
        let form;
        try {
            form = this.readSourceForm(type);
        } catch (err) {
            if (type === 'xtream') this.openAdvancedSourceLogin();
            alert(err.message);
            return;
        }
        const { name, url, username, password } = form;

        try {
            // Check M3U size before creating (large playlist warning)
            if (type === 'm3u') {
                try {
                    const estimate = await API.sources.estimateByUrl(url, type);
                    if (estimate.needsWarning) {
                        const proceed = await this.showWarningModal({
                            title: '⚠️ Large Playlist Warning',
                            message: `This playlist contains <strong>${estimate.count.toLocaleString()}</strong> channels.`,
                            details: `Syncing may take several minutes and app performance may be impacted with large playlists.<br><br>Consider using a filtered M3U from your provider to include only channels you actually watch.`,
                            proceedText: 'Proceed Anyway',
                            cancelText: 'Cancel'
                        });
                        if (!proceed) {
                            return; // Don't create the source
                        }
                    }
                } catch (err) {
                    console.warn('[SourceManager] Could not estimate M3U size:', err.message);
                    // Continue with creation anyway
                }
            }

            const createdSource = await API.sources.create({ type, name, url, username, password });
            await this.loadSources();
            this.notifySourceHealthChanged();
            this.showCatalogPreparation(createdSource, type);

            // Refresh the watch surfaces in the background. The onboarding progress
            // step must appear immediately, even when a provider catalog is large.
            if (window.app?.channelList) {
                window.app.channelList.loadSources()
                    .then(() => window.app.channelList.loadChannels())
                    .catch(err => console.warn('[SourceManager] Background channel refresh failed:', err));
            }
        } catch (err) {
            alert('Error adding source: ' + err.message);
        }
    }

    /**
     * Update existing source
     */
    async updateSource(id, type) {
        let form;
        try {
            form = this.readSourceForm(type, { existing: true });
        } catch (err) {
            if (type === 'xtream') this.openAdvancedSourceLogin();
            alert(err.message);
            return;
        }
        const { name, url, username, password } = form;

        try {
            const data = { type, name, url };
            if (type === 'xtream') {
                data.username = username;
                if (password) data.password = password;
            }

            await API.sources.update(id, data);
            document.getElementById('modal').classList.remove('active');
            await this.loadSources();
            this.notifySourceHealthChanged();
        } catch (err) {
            alert('Error updating source: ' + err.message);
        }
    }

    notifySourceHealthChanged() {
        document.dispatchEvent(new CustomEvent('norva:source-health-changed'));
    }

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Delete source
     */
    async deleteSource(id) {
        if (!confirm('Are you sure you want to delete this source?')) return;

        try {
            await API.sources.delete(id);
            await this.loadSources();
            this.notifySourceHealthChanged();

            if (window.app?.channelList) {
                await window.app.channelList.loadSources();
                await window.app.channelList.loadChannels();
            }
        } catch (err) {
            alert('Error deleting source: ' + err.message);
        }
    }

    /**
     * Toggle source enabled/disabled
     */
    async toggleSource(id) {
        try {
            await API.sources.toggle(id);
            await this.loadSources();
            this.notifySourceHealthChanged();
        } catch (err) {
            alert('Error toggling source: ' + err.message);
        }
    }

    /**
     * Test source connection
     */
    async testSource(id) {
        try {
            const result = await API.sources.test(id);
            if (result.success) {
                alert('Connection successful!');
            } else {
                alert('Connection failed: ' + (result.error || result.message));
            }
        } catch (err) {
            alert('Connection failed: ' + err.message);
        }
    }

    /**
     * Refresh source data
     */
    async refreshSource(id, type, options = {}) {
        const isHardRefresh = Boolean(options.hard);
        const sourceItem = document.querySelector(`.source-item[data-id="${id}"]`);
        const btn = sourceItem?.querySelector(`[data-action="${isHardRefresh ? 'hard-refresh' : 'refresh'}"]`);
        const refreshButtons = sourceItem?.querySelectorAll('[data-action="refresh"], [data-action="hard-refresh"]') || [];

        try {
            if (isHardRefresh) {
                const proceed = await this.showWarningModal({
                    title: 'Hard Refresh Source',
                    message: 'This will delete the current local catalogue for this source, then rebuild it from the playlist/provider.',
                    details: 'Removed locally: categories, channels, movies, series, EPG data, sync status, and source cache.<br><br>Preserved: source settings, favorites, users, and watch history.',
                    proceedText: 'Hard Refresh',
                    cancelText: 'Cancel'
                });
                if (!proceed) return;
            }

            refreshButtons.forEach(button => {
                button.disabled = true;
            });

            if (btn) {
                const icon = btn.querySelector('.icon');
                if (icon) icon.classList.add('spin');
            }

            // Check M3U size before syncing (large playlist warning)
            if (type === 'm3u') {
                try {
                    const estimate = await API.sources.estimate(id);
                    if (estimate.needsWarning) {
                        const proceed = await this.showWarningModal({
                            title: '⚠️ Large Playlist Warning',
                            message: `This playlist contains <strong>${estimate.count.toLocaleString()}</strong> channels.`,
                            details: `Syncing may take several minutes and app performance may be impacted with large playlists.<br><br>Consider using a filtered M3U from your provider to include only channels you actually watch.`,
                            proceedText: 'Proceed Anyway',
                            cancelText: 'Cancel'
                        });
                        if (!proceed) {
                            refreshButtons.forEach(button => { button.disabled = false; });
                            if (btn) btn.querySelector('.icon')?.classList.remove('spin');
                            return;
                        }
                    }
                } catch (err) {
                    console.warn('[SourceManager] Could not estimate M3U size:', err.message);
                    // Continue with sync anyway
                }
            }

            // 1. Trigger Backend Sync
            console.log(`[SourceManager] Triggering ${isHardRefresh ? 'hard refresh' : 'sync'} for source ${id}`);
            const syncResult = isHardRefresh ? await API.sources.hardSync(id) : await API.sources.sync(id);

            // 2. Poll for completion
            let retries = 0;
            let statusPollErrors = 0;
            const maxRetries = 60; // 60 seconds timeout

            while (retries < maxRetries) {
                await new Promise(r => setTimeout(r, 1000)); // Wait 1s
                let statuses;
                try {
                    statuses = await API.sources.getStatus();
                    statusPollErrors = 0;
                } catch (err) {
                    if (this.isInvalidDeviceTokenError(err)) {
                        throw new Error('This device session expired. Sign in again or pair the device again.');
                    }
                    statusPollErrors++;
                    console.warn('[SourceManager] Sync status poll failed:', err);
                    if (statusPollErrors < 5) {
                        retries++;
                        continue;
                    }
                    throw new Error(`Failed to get sync status after ${statusPollErrors} retries: ${err.message}`);
                }

                const status = statuses.find(s => s.source_id === id && s.type === 'all');

                if (status && status.status === 'success') {
                    console.log('[SourceManager] Sync completed successfully');
                    break;
                } else if (status && status.status === 'error') {
                    throw new Error(`Sync failed: ${status.error}`);
                }

                // If no status found yet, or still syncing, continue
                retries++;
            }

            if (retries >= maxRetries) {
                throw new Error('Sync timed out');
            }

            // 3. Refresh UI / Cache
            // Clear cache for this source first
            await API.proxy.cache.clear(id);

            if (type === 'epg') {
                // Force refresh EPG data
                if (window.app?.epgGuide) {
                    await window.app.epgGuide.loadEpg(true);
                }
                alert(isHardRefresh ? 'EPG data hard refreshed!' : 'EPG data synced & refreshed!');
            } else if (type === 'xtream') {
                // Re-fetch xtream data by reloading channels
                if (window.app?.channelList) {
                    await window.app.channelList.loadChannels();
                }
                alert(isHardRefresh ? 'Xtream data hard refreshed!' : 'Xtream data synced & refreshed!');
            } else if (type === 'm3u') {
                // Re-fetch M3U data by reloading channels
                if (window.app?.channelList) {
                    await window.app.channelList.loadChannels();
                }
                alert(isHardRefresh ? 'M3U playlist hard refreshed!' : 'M3U playlist synced & refreshed!');
            }

            if (this.contentSourceSelect?.value === String(id)) {
                this.reloadContentTree();
            }

            if (isHardRefresh && syncResult?.cleared) {
                console.log('[SourceManager] Hard refresh cleared:', syncResult.cleared);
            }
            this.notifySourceHealthChanged();
        } catch (err) {
            console.error('Error refreshing source:', err);
            alert(`${isHardRefresh ? 'Hard refresh' : 'Refresh'} failed: ${err.message}`);
        } finally {
            refreshButtons.forEach(button => { button.disabled = false; });
            if (btn) btn.querySelector('.icon')?.classList.remove('spin');
        }
    }

    /**
     * Initialize content browser
     */
    initContentBrowser() {
        this.contentSourceSelect = document.getElementById('content-source-select');
        this.contentTree = document.getElementById('content-tree');
        this.channelsBtn = document.getElementById('content-type-channels');
        this.moviesBtn = document.getElementById('content-type-movies');
        this.seriesBtn = document.getElementById('content-type-series');

        // Content type toggle
        this.channelsBtn?.addEventListener('click', () => this.selectContentType('channels'));
        this.moviesBtn?.addEventListener('click', () => this.selectContentType('movies'));
        this.seriesBtn?.addEventListener('click', () => this.selectContentType('series'));

        // Source selection — flush pending edits before swapping the data out.
        this.contentSourceSelect?.addEventListener('change', () => this.flushThenReload());

        // Show All / Hide All buttons
        document.getElementById('content-show-all')?.addEventListener('click', () => this.setAllVisibility(true));
        document.getElementById('content-hide-all')?.addEventListener('click', () => this.setAllVisibility(false));

        // Save Changes button
        document.getElementById('content-save')?.addEventListener('click', () => this.saveContentChanges());

        // Search input
        const searchInput = document.getElementById('content-search');
        const searchClear = searchInput?.parentElement?.querySelector('.search-clear');

        searchInput?.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase().trim();
            this.renderTree();
        });

        searchClear?.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                this.searchQuery = '';
                this.renderTree();
            }
        });
    }

    /**
     * Switch content type (Channels / Movies / Series), saving any pending edits
     * first so the user never silently loses ticks by changing view.
     */
    selectContentType(type) {
        if (this.contentType === type) return;
        this.contentType = type;
        this.channelsBtn?.classList.toggle('active', type === 'channels');
        this.moviesBtn?.classList.toggle('active', type === 'movies');
        this.seriesBtn?.classList.toggle('active', type === 'series');
        this.setContentSearchPlaceholder(type);
        this.flushThenReload();
    }

    setContentSearchPlaceholder(type) {
        const input = document.getElementById('content-search');
        if (!input) return;
        input.placeholder = type === 'movies' ? 'Search movies…'
            : type === 'series' ? 'Search shows…' : 'Search channels…';
    }

    /**
     * True when local visibility ticks differ from what was last loaded/saved.
     */
    hasUnsavedContentChanges() {
        if (!this.treeData || !this.hiddenSet || !this.originalHiddenSet) return false;
        if (this.hiddenSet.size !== this.originalHiddenSet.size) return true;
        for (const key of this.hiddenSet) {
            if (!this.originalHiddenSet.has(key)) return true;
        }
        return false;
    }

    /**
     * Persist any pending edits, then reload the tree. Switching content type or
     * provider replaces the in-memory data, so we save first to avoid silent loss.
     */
    async flushThenReload() {
        if (this.hasUnsavedContentChanges()) {
            await this.saveContentChanges();
        }
        this.reloadContentTree();
    }

    /**
     * Reload content tree based on current type and source
     */
    reloadContentTree() {
        const sourceId = this.contentSourceSelect?.value;
        if (!sourceId) {
            this.contentTree.innerHTML = '<p class="hint">Choose a provider above to manage its content.</p>';
            return;
        }

        if (this.contentType === 'movies') {
            this.loadMovieCategoriesTree(parseInt(sourceId));
        } else if (this.contentType === 'series') {
            this.loadSeriesCategoriesTree(parseInt(sourceId));
        } else {
            this.loadContentTree(parseInt(sourceId));
        }
    }

    /**
     * Load sources into content browser dropdown
     */
    async loadContentSources() {
        try {
            const sources = await API.sources.getAll();
            const select = document.getElementById('content-source-select');
            if (!select) return;

            const providers = sources.filter(s => s.type === 'xtream' || s.type === 'm3u');

            // Plain provider names only — the underlying protocol (xtream/m3u) is
            // jargon a mass-market user neither knows nor needs to see here.
            const current = select.value;
            select.innerHTML = '<option value="">Choose a provider…</option>'
                + providers.map(source =>
                    `<option value="${source.id}">${this.escapeHtml(source.name)}</option>`).join('');
            // Preserve the current selection across reloads when still present.
            if (current && providers.some(p => String(p.id) === String(current))) {
                select.value = current;
            }

            // Grand-public dead-end guard: with no provider added yet, point the
            // user to where they can add one instead of showing an inert tree.
            this.updateContentEmptyState(providers.length);
        } catch (err) {
            console.error('Error loading content sources:', err);
        }
    }

    /**
     * Show a helpful empty state (with a path to add a provider) when the
     * account has no Xtream/M3U provider, instead of an inert "select a source"
     * prompt that leads nowhere.
     */
    updateContentEmptyState(providerCount) {
        const tree = document.getElementById('content-tree');
        const header = document.querySelector('#tab-content .content-browser-header');
        const legend = document.getElementById('content-legend');
        const noProviders = !providerCount;

        if (header) header.style.display = noProviders ? 'none' : '';
        if (legend) legend.style.display = noProviders ? 'none' : '';
        if (!tree) return;

        if (noProviders) {
            tree.innerHTML = `
                <div style="text-align:center;padding:44px 20px;max-width:440px;margin:0 auto">
                    <div style="font-size:36px;margin-bottom:10px">📺</div>
                    <p style="font-weight:700;color:#f1f5fb;margin:0 0 6px;font-size:16px">No provider added yet</p>
                    <p class="hint" style="margin:0 0 18px">Add your TV provider to choose which channels, movies and shows appear in Norva.</p>
                    <button class="btn btn-primary" id="content-add-provider" type="button">Add a provider</button>
                </div>`;
            document.getElementById('content-add-provider')?.addEventListener('click', () => {
                document.querySelector('.tabs .tab[data-tab="sources"]')?.click();
            });
        } else if (tree.querySelector('#content-add-provider')) {
            // A provider was just added — clear the empty state back to the prompt.
            tree.innerHTML = '<p class="hint">Choose a provider above to manage its content.</p>';
        }
    }

    /**
     * Load content tree for a source
     * Checked = Visible, Unchecked = Hidden
     */


    /**
     * Load content tree for a source
     */
    async loadContentTree(sourceId) {
        this.contentTree.innerHTML = '<p class="hint">Loading...</p>';
        this.treeData = { type: 'channels', sourceId, groups: [] };
        this.expandedGroups.clear();

        try {
            const source = await API.sources.getById(sourceId);
            let channels = [];

            let categoryMap = {};

            if (source.type === 'xtream' || source.type === 'm3u') {
                // Use unified Xtream API endpoints - backend supports both source types
                // Use includeHidden to show ALL items in the content manager
                const categories = await API.proxy.xtream.liveCategories(sourceId, { includeHidden: true });
                const streams = await API.proxy.xtream.liveStreams(sourceId, null, { includeHidden: true });

                channels = streams;
                categories.forEach(cat => {
                    categoryMap[cat.category_id] = cat.category_name;
                });
            }

            // Get currently hidden items
            const hiddenItems = await API.channels.getHidden(sourceId);
            this.hiddenSet = new Set(hiddenItems.map(h => `${h.item_type}:${h.item_id}`));
            this.originalHiddenSet = new Set(this.hiddenSet); // Track original state for diffing

            // Group channels by category
            const groupMap = {}; // key: categoryId, value: { name, categoryId, items }
            channels.forEach(ch => {
                let groupName = 'Uncategorized';
                let categoryId = ch.category_id;

                // Look up category name from map (works for both Xtream and M3U now)
                if (categoryId && categoryMap[categoryId]) {
                    groupName = categoryMap[categoryId];
                } else if (categoryId) {
                    // M3U uses category_id as the name itself
                    groupName = categoryId;
                }

                const groupKey = categoryId || groupName;
                if (!groupMap[groupKey]) {
                    groupMap[groupKey] = {
                        categoryId: categoryId,
                        name: groupName,
                        items: []
                    };
                }

                // Normalize channel object
                const channelId = ch.stream_id || ch.id || ch.url;
                const channelName = ch.name || ch.tvgName || 'Unknown';

                groupMap[groupKey].items.push({
                    id: String(channelId),
                    name: channelName,
                    original: ch,
                    type: 'channel'
                });
            });

            // Convert to array, sorted by name
            this.treeData.groups = Object.entries(groupMap)
                .sort((a, b) => a[1].name.localeCompare(b[1].name))
                .map(([key, group]) => ({
                    id: key, // Use categoryId as the group ID
                    name: group.name,
                    categoryId: group.categoryId, // Store actual category_id for API calls
                    type: 'group',
                    items: group.items
                }));

            this.renderTree();

        } catch (err) {
            console.error('Error loading content tree:', err);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading content</p>';
        }
    }

    /**
     * Get groups filtered by search query
     */
    getFilteredGroups() {
        if (!this.treeData?.groups) return [];
        if (!this.searchQuery) return this.treeData.groups;

        return this.treeData.groups
            .map(group => {
                // Check if group name matches
                const groupMatches = group.name.toLowerCase().includes(this.searchQuery);

                // Filter items that match
                const matchingItems = group.items.filter(item =>
                    item.name.toLowerCase().includes(this.searchQuery)
                );

                // Include group if name matches OR has matching items
                if (groupMatches || matchingItems.length > 0) {
                    return { ...group, items: groupMatches ? group.items : matchingItems };
                }
                return null;
            })
            .filter(Boolean);
    }

    /**
     * Render the full tree based on current state
     */
    renderTree() {
        const groups = this.getFilteredGroups();

        if (!groups.length) {
            const msg = this.searchQuery ? 'No matches found' : 'No content found';
            this.contentTree.innerHTML = `<p class="hint">${msg}</p>`;
            return;
        }

        const html = groups.map(group => this.getGroupHtml(group)).join('');
        this.contentTree.innerHTML = html;

        // Attach event listeners
        this.attachTreeListeners(this.contentTree);
    }

    /**
     * Get HTML for a group (and its items if expanded)
     */
    getGroupHtml(group) {
        const isExpanded = this.expandedGroups.has(group.id);

        // Group checkbox is checked if ANY child is visible (derived state)
        const hasVisibleChild = group.items.some(item => !this.hiddenSet.has(`${item.type}:${item.id}`));
        const checked = hasVisibleChild;

        let itemsHtml = '';
        if (isExpanded) {
            itemsHtml = `<div class="content-channels">
                ${group.items.map(item => {
                const itemHidden = this.hiddenSet.has(`${item.type}:${item.id}`);
                return `
                    <label class="checkbox-label channel-item" title="${this.escapeHtml(item.name)}">
                        <input type="checkbox" class="channel-checkbox" 
                               data-type="${item.type}" 
                               data-id="${item.id}" 
                               data-source-id="${this.treeData.sourceId}" 
                               ${!itemHidden ? 'checked' : ''}>
                        <span class="channel-name">${this.escapeHtml(item.name)}</span>
                    </label>`;
            }).join('')}
            </div>`;
        }

        return `
            <div class="content-group ${isExpanded ? '' : 'collapsed'}" data-group-id="${this.escapeHtml(group.id)}">
                <div class="content-group-header">
                    <span class="group-expander">${Icons.chevronDown}</span>
                    <label class="checkbox-label" onclick="event.stopPropagation()">
                        <input type="checkbox" class="group-checkbox" 
                               data-type="group" 
                               data-id="${this.escapeHtml(group.name)}" 
                               data-source-id="${this.treeData.sourceId}" 
                               ${checked ? 'checked' : ''}>
                        <span class="group-name">${this.escapeHtml(group.name)} (${group.items.length})</span>
                    </label>
                </div>
                ${itemsHtml}
            </div>
        `;
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    attachTreeListeners(container) {
        // Toggle group collapse
        container.querySelectorAll('.content-group-header').forEach(header => {
            header.addEventListener('click', (e) => {
                // Prevent triggering if clicking the checkbox/label directly (handled by its own listener/bubbling)
                if (e.target.closest('input') || e.target.closest('label')) return;

                const groupEl = header.closest('.content-group');
                const groupId = groupEl.dataset.groupId;
                this.toggleGroupExpand(groupId);
            });
        });

        // Toggle visibility
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                if (cb.classList.contains('group-checkbox')) {
                    this.toggleGroupChildren(cb);
                } else {
                    this.toggleVisibility(cb);
                }
            });
        });
    }

    toggleGroupExpand(groupId) {
        if (this.expandedGroups.has(groupId)) {
            this.expandedGroups.delete(groupId);
        } else {
            this.expandedGroups.add(groupId);
        }

        // Re-render only this group - use filtered groups to respect search
        const groupEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(groupId)}"]`);
        if (groupEl) {
            const filteredGroups = this.getFilteredGroups();
            const group = filteredGroups.find(g => g.id === groupId);
            if (group) {
                const newHtml = this.getGroupHtml(group);
                groupEl.outerHTML = newHtml;

                // Re-attach listeners to the new element
                const newEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(groupId)}"]`);
                if (newEl) this.attachTreeListeners(newEl);
            }
        }
    }

    /**
     * Load movie categories tree for a source
     */
    async loadMovieCategoriesTree(sourceId) {
        this.contentTree.innerHTML = '<p class="hint">Loading movie categories...</p>';
        this.treeData = { type: 'movies', sourceId, groups: [] };

        try {
            const source = await API.sources.getById(sourceId);

            if (source.type !== 'xtream') {
                this.contentTree.innerHTML = '<p class="hint">Movie categories are only available for Xtream sources</p>';
                return;
            }

            const categories = await API.proxy.xtream.vodCategories(sourceId, { includeHidden: true });

            if (!categories || categories.length === 0) {
                this.contentTree.innerHTML = '<p class="hint">No movie categories found</p>';
                return;
            }

            const hiddenItems = await API.channels.getHidden(sourceId);
            this.hiddenSet = new Set(hiddenItems.map(h => `${h.item_type}:${h.item_id}`));
            this.originalHiddenSet = new Set(this.hiddenSet); // Track original state

            // Create a single "Movies" group or flatten?
            // The original UI rendered a flat list of categories. 
            // Better to stick to "Group -> Items" structure, or just wrap them in a pseudo-group?
            // Original: rendered checkboxes directly.
            // Let's adopt the treeData structure but with a single root group or flat items?
            // To support generic renderTree, we can put them in a "Categories" group or just render them as items.
            // Let's update renderTree to support flat list if groups is empty? 
            // Or just put them in one "All Categories" group that is auto-expanded.

            this.treeData.groups = [{
                id: 'all_categories',
                name: 'Categories',
                type: 'group',
                items: categories.sort((a, b) => a.category_name.localeCompare(b.category_name)).map(cat => ({
                    id: String(cat.category_id),
                    name: cat.category_name,
                    type: 'vod_category',
                    original: cat
                }))
            }];

            // Auto expand
            this.expandedGroups.add('all_categories');
            this.renderTree();

        } catch (err) {
            console.error('Error loading movie categories:', err);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading movie categories</p>';
        }
    }

    /**
     * Load series categories tree for a source
     */
    async loadSeriesCategoriesTree(sourceId) {
        this.contentTree.innerHTML = '<p class="hint">Loading series categories...</p>';
        this.treeData = { type: 'series', sourceId, groups: [] };

        try {
            const source = await API.sources.getById(sourceId);

            if (source.type !== 'xtream') {
                this.contentTree.innerHTML = '<p class="hint">Series categories are only available for Xtream sources</p>';
                return;
            }

            const categories = await API.proxy.xtream.seriesCategories(sourceId, { includeHidden: true });

            if (!categories || categories.length === 0) {
                this.contentTree.innerHTML = '<p class="hint">No series categories found</p>';
                return;
            }

            const hiddenItems = await API.channels.getHidden(sourceId);
            this.hiddenSet = new Set(hiddenItems.map(h => `${h.item_type}:${h.item_id}`));
            this.originalHiddenSet = new Set(this.hiddenSet); // Track original state

            this.treeData.groups = [{
                id: 'all_series_categories',
                name: 'Categories',
                type: 'group',
                items: categories.sort((a, b) => a.category_name.localeCompare(b.category_name)).map(cat => ({
                    id: String(cat.category_id),
                    name: cat.category_name,
                    type: 'series_category',
                    original: cat
                }))
            }];

            this.expandedGroups.add('all_series_categories');
            this.renderTree();

        } catch (err) {
            console.error('Error loading series categories:', err);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading series categories</p>';
        }
    }

    /**
     * Toggle visibility of a single item (LOCAL STATE ONLY - use Save to persist)
     * Checked = show (remove from hidden), Unchecked = hide (add to hidden)
     */
    toggleVisibility(checkbox) {
        const itemType = checkbox.dataset.type;
        const itemId = checkbox.dataset.id;
        const isVisible = checkbox.checked;

        // Update local state only (will be persisted when Save is clicked)
        const key = `${itemType}:${itemId}`;
        if (isVisible) {
            this.hiddenSet.delete(key);
        } else {
            this.hiddenSet.add(key);
        }

        // Update parent group checkbox to reflect derived state
        const groupEl = checkbox.closest('.content-group');
        if (groupEl) {
            const groupCheckbox = groupEl.querySelector('.group-checkbox');
            if (groupCheckbox) {
                const groupId = groupEl.dataset.groupId;
                const group = this.treeData.groups.find(g => g.id === groupId);
                if (group) {
                    const hasVisibleChild = group.items.some(item => !this.hiddenSet.has(`${item.type}:${item.id}`));
                    groupCheckbox.checked = hasVisibleChild;
                }
            }
        }
    }

    /**
     * Toggle all children of a group (LOCAL STATE ONLY - use Save to persist)
     */
    toggleGroupChildren(groupCb) {
        const groupName = groupCb.dataset.id;
        const group = this.treeData.groups.find(g => g.name === groupName);
        if (!group) return;

        const isChecked = groupCb.checked;

        // Determine the correct item type for the group based on content type
        let groupItemType = 'group'; // default for live channels
        if (this.treeData.type === 'movies') {
            groupItemType = 'vod_category';
        } else if (this.treeData.type === 'series') {
            groupItemType = 'series_category';
        }

        // Update state for the GROUP itself (if it has a categoryId)
        if (group.categoryId) {
            const groupKey = `${groupItemType}:${group.categoryId}`;
            if (isChecked) {
                this.hiddenSet.delete(groupKey);
            } else {
                this.hiddenSet.add(groupKey);
            }
        }

        // Update state for all children
        group.items.forEach(item => {
            const key = `${item.type}:${item.id}`;
            if (isChecked) {
                this.hiddenSet.delete(key);
            } else {
                this.hiddenSet.add(key);
            }
        });

        // Re-render group to update all checkboxes
        const groupEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(group.id)}"]`);
        if (groupEl) {
            groupEl.outerHTML = this.getGroupHtml(group);
            const newEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(group.id)}"]`);
            if (newEl) this.attachTreeListeners(newEl);
        }
    }

    /**
     * Set visibility for all items and IMMEDIATELY persist to server
     * Uses fast bulk API endpoint (single SQL statement) instead of item-by-item
     */
    // Small transient confirmation toast (the app has no global toast helper).
    toast(message, isError) {
        try {
            const t = document.createElement('div');
            t.className = 'norva-toast';
            t.textContent = message;
            t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:10001;padding:11px 18px;border-radius:999px;background:' + (isError ? '#3a1d22' : '#11241b') + ';border:1px solid ' + (isError ? '#7a3340' : '#2f6b4b') + ';color:' + (isError ? '#fecdd3' : '#bff3d6') + ';font:600 14px/1 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45);opacity:0;transition:opacity .2s ease';
            document.body.appendChild(t);
            requestAnimationFrame(() => { t.style.opacity = '1'; });
            setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 2200);
        } catch (_) { /* never break over a toast */ }
    }

    async setAllVisibility(visible) {
        if (!this.treeData || !this.treeData.groups) return;

        // With an active search, only affect the items currently shown — not the
        // whole source — so "Show/Hide All" never silently touches filtered-out
        // items. Persist just the resulting diff via the normal save path.
        if (this.searchQuery) {
            this.getFilteredGroups().forEach(group => {
                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    if (visible) this.hiddenSet.delete(key);
                    else this.hiddenSet.add(key);
                });
            });
            this.renderTree();
            await this.saveContentChanges();
            return;
        }

        const saveBtn = document.getElementById('content-save');
        const showAllBtn = document.querySelector('.content-actions button:first-child');
        const hideAllBtn = document.querySelector('.content-actions button:nth-child(2)');

        // Disable buttons during operation
        if (showAllBtn) showAllBtn.disabled = true;
        if (hideAllBtn) hideAllBtn.disabled = true;
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = visible ? '⏳ Showing all...' : '⏳ Hiding all...';
        }

        try {
            const sourceId = this.treeData.sourceId;
            const contentType = this.treeData.type; // 'channels', 'movies', or 'series'

            // Use fast API endpoint (single SQL UPDATE statement)
            if (visible) {
                await API.channels.showAll(sourceId, contentType);
            } else {
                await API.channels.hideAll(sourceId, contentType);
            }

            // Update local state to match
            this.treeData.groups.forEach(group => {
                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    if (visible) {
                        this.hiddenSet.delete(key);
                    } else {
                        this.hiddenSet.add(key);
                    }
                });
            });

            // Update originalHiddenSet to match current state
            this.originalHiddenSet = new Set(this.hiddenSet);

            // Sync Channel List
            try {
                if (window.app?.channelList?.loadHiddenItems) {
                    await window.app.channelList.loadHiddenItems();
                    window.app.channelList.render();
                }
            } catch (e) {
                console.warn('[SourceManager] Channel list sync failed:', e);
            }

            // Re-render to reflect changes
            this.renderTree();
            this.toast(visible ? 'All items shown' : 'All items hidden');

            if (saveBtn) {
                saveBtn.textContent = '✓ Done!';
                setTimeout(() => {
                    saveBtn.textContent = '💾 Save changes';
                    saveBtn.disabled = false;
                }, 1500);
            }

        } catch (err) {
            console.error('Error setting all visibility:', err);
            alert('Failed: ' + err.message);
            if (saveBtn) {
                saveBtn.textContent = '💾 Save changes';
                saveBtn.disabled = false;
            }
        } finally {
            if (showAllBtn) showAllBtn.disabled = false;
            if (hideAllBtn) hideAllBtn.disabled = false;
        }
    }

    /**
     * Save all content visibility changes to the server
     */
    async saveContentChanges() {
        if (!this.treeData) {
            alert('No content loaded to save');
            return;
        }

        const saveBtn = document.getElementById('content-save');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving...';
        }

        try {
            const sourceId = this.treeData.sourceId;
            const itemsToShow = [];
            const itemsToHide = [];

            // Only collect items that have CHANGED from their original state
            // Track group changes for redundancy check
            const changedGroups = new Map(); // categoryId -> isHidden

            // First pass: Identify all changed groups
            this.treeData.groups.forEach(group => {
                let groupItemType = 'group';
                if (this.treeData.type === 'movies') groupItemType = 'vod_category';
                else if (this.treeData.type === 'series') groupItemType = 'series_category';

                if (group.categoryId) {
                    const groupKey = `${groupItemType}:${group.categoryId}`;
                    const isGroupNowHidden = this.hiddenSet.has(groupKey);
                    const wasGroupHidden = this.originalHiddenSet.has(groupKey);

                    if (isGroupNowHidden !== wasGroupHidden) {
                        changedGroups.set(group.categoryId, isGroupNowHidden);
                        if (isGroupNowHidden) {
                            itemsToHide.push({ sourceId, itemType: groupItemType, itemId: String(group.categoryId) });
                        } else {
                            itemsToShow.push({ sourceId, itemType: groupItemType, itemId: String(group.categoryId) });
                        }
                    }
                }
            });

            // Second pass: Process items, skipping if redundant with group change
            this.treeData.groups.forEach(group => {
                const groupIsChanging = changedGroups.has(group.categoryId);
                const groupNewState = changedGroups.get(group.categoryId); // true = hiding, false = showing

                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    const isNowHidden = this.hiddenSet.has(key);
                    const wasHidden = this.originalHiddenSet.has(key);

                    // Only send if state changed
                    if (isNowHidden !== wasHidden) {
                        // Check for redundancy:
                        // If group is changing to the SAME state as the item, skip the item
                        // The backend cascade will handle it.
                        if (groupIsChanging && groupNewState === isNowHidden) {
                            return;
                        }

                        if (isNowHidden) {
                            itemsToHide.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                        } else {
                            itemsToShow.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                        }
                    }
                });
            });

            // Check if there are any changes
            if (itemsToShow.length === 0 && itemsToHide.length === 0) {
                if (saveBtn) {
                    saveBtn.textContent = 'No changes';
                    setTimeout(() => {
                        saveBtn.textContent = '💾 Save changes';
                        saveBtn.disabled = false;
                    }, 1500);
                }
                return;
            }

            console.log(`[SourceManager] Saving changes: ${itemsToShow.length} to show, ${itemsToHide.length} to hide`);

            if (itemsToHide.length > 0) {
                console.log('[SourceManager] Items to hide:', itemsToHide.map(i => `${i.itemType}:${i.itemId}`));
                // Check if any groups are being hidden
                const hiddenGroups = itemsToHide.filter(i => i.itemType === 'group' || i.itemType.includes('category'));
                if (hiddenGroups.length > 0) {
                    console.warn('[SourceManager] WARNING: Hiding groups:', hiddenGroups);
                }
            }

            // Batch large operations to avoid timeouts (5000 items per batch)
            const BATCH_SIZE = 5000;

            const processBatches = async (items, apiFn, label) => {
                for (let i = 0; i < items.length; i += BATCH_SIZE) {
                    const batch = items.slice(i, i + BATCH_SIZE);
                    console.log(`[SourceManager] ${label}: batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)`);
                    await apiFn(batch);

                    // Update button with progress
                    if (saveBtn) {
                        const progress = Math.round(((i + batch.length) / items.length) * 100);
                        saveBtn.textContent = `⏳ ${progress}%`;
                    }
                }
            };

            // Process show and hide operations sequentially to avoid overwhelming the server
            if (itemsToShow.length > 0) {
                await processBatches(itemsToShow, API.channels.bulkShow, 'Showing');
            }
            if (itemsToHide.length > 0) {
                await processBatches(itemsToHide, API.channels.bulkHide, 'Hiding');
            }

            console.log('[SourceManager] Bulk operations completed');

            // Update originalHiddenSet to reflect saved state
            this.originalHiddenSet = new Set(this.hiddenSet);

            // Sync Channel List (don't block on this)
            try {
                if (window.app?.channelList) {
                    // Start with hidden items sync which is fast
                    if (window.app.channelList.loadHiddenItems) {
                        await window.app.channelList.loadHiddenItems();
                    }

                    // If we modified the currently active source, reload it fully to get fresh categories
                    if (window.app.channelList.currentSourceId &&
                        String(window.app.channelList.currentSourceId) === String(this.contentSourceSelect.value)) {
                        console.log('[SourceManager] Reloading active source in ChannelList...');
                        await window.app.channelList.loadSource(window.app.channelList.currentSourceId);
                    } else {
                        // Otherwise just render to reflect hidden item changes
                        window.app.channelList.render();
                    }
                }
            } catch (e) {
                console.warn('[SourceManager] Channel list sync failed:', e);
            }

            this.toast('Changes saved');
            if (saveBtn) {
                saveBtn.textContent = '✓ Saved!';
                setTimeout(() => {
                    saveBtn.textContent = '💾 Save changes';
                    saveBtn.disabled = false;
                }, 1500);
            }

        } catch (err) {
            console.error('Error saving content changes:', err);
            alert('Failed to save changes: ' + err.message);
            if (saveBtn) {
                saveBtn.textContent = '💾 Save changes';
                saveBtn.disabled = false;
            }
        }
    }

    /**
     * Poll sync status periodically
     */
    async pollSyncStatus() {
        const poll = async () => {
            try {
                const statuses = await API.sources.getStatus();
                this.updateSyncStatus(statuses);
            } catch (err) {
                if (this.isInvalidDeviceTokenError(err)) {
                    console.info('[SourceManager] Cloud device session expired; sync polling paused.');
                    this.syncPollTimeout = null;
                    return;
                }
                if (this.isMissingCloudTokenError(err)) {
                    console.info('[SourceManager] Cloud session unavailable; sync polling paused.');
                    this.syncPollTimeout = null;
                    return;
                }
                console.warn('Error polling sync status:', err);
            }
            // Poll every 3 seconds
            this.syncPollTimeout = setTimeout(poll, 3000);
        };
        poll();
    }

    /**
     * Update UI with sync status
     */
    updateSyncStatus(statuses) {
        if (!statuses || !Array.isArray(statuses)) return;

        // Reset all to normal state if not in status list (handled implicitly by iterating sources or statuses?)
        // Better: iterate visible source items and check against statuses

        document.querySelectorAll('.source-item').forEach(item => {
            const id = parseInt(item.dataset.id);
            const status = statuses.find(s => s.source_id === id); // We might have multiple statuses (live, vod, epg) for one source

            // Just check if ANY sync is active/failed for this source
            const sourceStatuses = statuses.filter(s => s.source_id === id);
            const isSyncing = sourceStatuses.some(s => s.status === 'syncing');
            const hasError = sourceStatuses.some(s => s.status === 'error');
            const lastSync = sourceStatuses.map(s => s.last_sync).sort().pop();

            const btn = item.querySelector('[data-action="refresh"]');
            const hardBtn = item.querySelector('[data-action="hard-refresh"]');
            if (btn) {
                const icon = btn.querySelector('.icon') || btn; // icon inside button or button content
                // If syncing, spin the refresh icon
                if (isSyncing) {
                    btn.disabled = true;
                    btn.classList.add('syncing'); // Custom style?
                    // Ensure spin class is added (font awesome or similar)
                    // The icon is usually SVH in `Icons.refresh`.
                    // We can add a class to the SVG parent or button
                    btn.innerHTML = `<span class="spin">${Icons.refresh}</span>`;
                    btn.title = "Syncing...";
                } else if (hasError) {
                    btn.disabled = false;
                    btn.innerHTML = Icons.refresh;
                    btn.classList.remove('syncing');
                    btn.title = "Sync Failed - Retry";
                    // Maybe show error indicator?
                } else {
                    btn.disabled = false;
                    btn.innerHTML = Icons.refresh;
                    btn.classList.remove('syncing');
                    btn.title = lastSync ? `Last Sync: ${new Date(lastSync).toLocaleString()}` : "Refresh Data";
                }
            }

            if (hardBtn) {
                hardBtn.disabled = isSyncing;
                hardBtn.title = isSyncing
                    ? 'Syncing...'
                    : 'Hard Refresh: clear local data and sync';
            }

            // Optional: Update status text/badge in .source-info
        });
    }
}

// Export
window.SourceManager = SourceManager;
