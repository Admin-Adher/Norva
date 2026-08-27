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
        this.warningModalFlight = null; // one shared confirmation per open modal
        this.providerAccessOperations = new Map(); // stable retry identities per source/action

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
        // A fast double press (touch, Enter or TV OK) must join the confirmation
        // already on screen. Rebuilding the shared #modal would replace its
        // handlers and leave the first caller's Promise unresolved.
        if (this.warningModalFlight) return this.warningModalFlight;

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');
        const modalFooter = document.getElementById('modal-footer');
        const modalClose = modal?.querySelector('.modal-close');
        if (!modal || !modalTitle || !modalBody || !modalFooter || !modalClose) {
            return Promise.resolve(false);
        }

        let resolveFlight;
        const flight = new Promise((resolve) => { resolveFlight = resolve; });
        this.warningModalFlight = flight;
        try {
            modalTitle.textContent = title;

            modalBody.innerHTML = `
                <div class="warning-modal-content">
                    <div class="warning-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width: 48px; height: 48px; color: var(--color-warning, #f59e0b);">
                            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                        </svg>
                    </div>
                    <p class="warning-message" style="font-size: 1rem; margin: var(--space-md) 0; color: var(--color-text-primary);">${message}</p>
                    ${details ? `<p class="warning-details" style="font-size: 0.875rem; color: var(--color-text-secondary); background: var(--color-bg-tertiary); padding: var(--space-md); border-radius: var(--radius-md); text-align: left;">${details}</p>` : ''}
                </div>
            `;

            modalFooter.innerHTML = `
                <button class="btn btn-secondary" id="warning-cancel">${cancelText}</button>
                <button class="btn btn-primary" id="warning-proceed" style="background: var(--color-warning, #f59e0b); border-color: var(--color-warning, #f59e0b);">${proceedText}</button>
            `;

            const cancelButton = document.getElementById('warning-cancel');
            const proceedButton = document.getElementById('warning-proceed');
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                modal.classList.remove('active');
                modalClose.onclick = null;
                cancelButton.onclick = null;
                proceedButton.onclick = null;
                if (this.warningModalFlight === flight) this.warningModalFlight = null;
                resolveFlight(value);
            };

            cancelButton.onclick = () => {
                finish(false);
            };

            proceedButton.onclick = () => {
                finish(true);
            };

            modalClose.onclick = () => {
                finish(false);
            };
            modal.classList.add('active');
            if (window.NorvaModal?.installHygiene) {
                NorvaModal.installHygiene(modal, {
                    onClose: () => finish(false),
                    initialFocus: document.getElementById('warning-cancel')
                });
            } else {
                cancelButton.focus();
            }
        } catch (_) {
            modal.classList.remove('active');
            modalClose.onclick = null;
            if (this.warningModalFlight === flight) this.warningModalFlight = null;
            resolveFlight(false);
        }
        return flight;
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
            const managementEnabled = this.isSourceManagementEnabled(sourceView);
            const health = window.NorvaSourceHealth?.classifySource(sourceView, this.sourceStatuses || []) || {
                state: managementEnabled ? 'ready' : 'disabled',
                label: managementEnabled ? 'Ready' : 'Disabled',
                message: managementEnabled ? '' : 'This service is paused. Its saved catalog will return when you enable it.',
                needsAttention: false
            };
            const retryPending = health.state === 'ready' && health.retrying === true;
            const healthLabel = retryPending ? 'Ready · retry pending' : health.label;
            const healthMessage = retryPending
                ? 'Your existing catalogue is available. Norva will retry the update automatically.'
                : (health.state !== 'ready' ? health.message : '');
            const progressButton = health.state === 'syncing'
                ? `<button class="btn btn-sm btn-secondary source-progress-btn" data-action="progress" title="View catalog import progress">Progress</button>`
                : '';
            // Usable-but-still-topping-up: onboarding is "done" (catalogue navigable) yet the
            // remaining VOD long-tail is still materialising in the background. Surface it as
            // a quiet line here in Settings only — never as a blocking onboarding bar.
            const backgrounding = managementEnabled && this.sourceSyncState(sourceView).backgrounding === true;
            const providerAccessEnabled = type === 'xtream' && this.providerAccessUiEnabled();
            const accessSummary = providerAccessEnabled && managementEnabled
                ? this.providerAccessSummary(sourceView)
                : null;
            // One clear primary action (Repair when the service needs attention, else
            // Sync); everything else lives in a labelled ⋯ menu instead of a row of
            // tooltip-only icons that are illegible on touch and TV.
            const needsRepair = !!health.needsAttention;
            const needsAccessReview = providerAccessEnabled
                && ['auth_failed', 'expired', 'provider_changed'].includes(health.state);
            let primary = { action: 'refresh', label: 'Sync', cls: '' };
            if (!managementEnabled) {
                primary = { action: 'toggle', label: 'Enable service', cls: '' };
            } else if (needsAccessReview) {
                primary = {
                    action: 'provider-access',
                    label: accessSummary?.detail ? 'Review access' : 'Add access dates',
                    cls: 'btn-repair'
                };
            } else if (needsRepair && type === 'xtream' && !providerAccessEnabled) {
                primary = { action: 'test', label: 'Check service', cls: 'btn-repair' };
            } else if (needsRepair) {
                primary = { action: 'edit', label: 'Repair', cls: 'btn-repair' };
            }
            const legacyEditLabel = type === 'm3u'
                ? 'Edit playlist link'
                : (type === 'epg' ? 'Edit TV guide' : 'Edit service');
            return `
      <div class="source-item ${managementEnabled ? '' : 'disabled'} ${health.needsAttention ? 'needs-attention' : ''}" data-id="${this.escapeHtml(source.id)}">
        <span class="source-icon">${icons[type]}</span>
        <div class="source-info">
          <div class="source-name-row">
            <span class="source-name">${this.escapeHtml(source.name)}</span>
            <span class="source-health-badge source-health-${this.escapeHtml(health.state)} ${retryPending ? 'source-health-retrying' : ''}">${this.escapeHtml(healthLabel)}</span>
          </div>
          <div class="source-url">${this.escapeHtml(source.url || 'Managed by Norva Cloud')}</div>
          ${healthMessage ? `<div class="source-health-message">${this.escapeHtml(healthMessage)}</div>` : ''}
          ${accessSummary ? `<div class="provider-access-inline provider-access-${this.escapeHtml(accessSummary.tone)}"><span>${this.escapeHtml(accessSummary.label)}</span>${accessSummary.detail ? `<span>${this.escapeHtml(accessSummary.detail)}</span>` : ''}</div>` : ''}
          ${backgrounding ? `<div class="source-backgrounding"><span class="source-backgrounding-dot" aria-hidden="true"></span>Adding the rest of your library in the background…</div>` : ''}
        </div>
        <div class="source-actions">
          ${progressButton}
          <button class="btn btn-sm btn-secondary source-primary-action ${primary.cls}" data-action="${primary.action}" type="button"${retryPending ? ' title="Retry catalog update" aria-label="Retry catalog update"' : ''}>${primary.label}</button>
          <button class="btn btn-sm btn-secondary source-menu-btn" data-action="menu" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="More actions" title="More actions">⋯</button>
          <div class="source-menu" role="menu" aria-label="${this.escapeHtml(source.name || 'TV service')} actions" hidden>
            ${providerAccessEnabled ? `
              <div class="source-menu-section" role="group" aria-label="Provider access">
                <span class="source-menu-heading" aria-hidden="true">Provider access</span>
                <button class="source-menu-item source-menu-item-featured" data-action="provider-access" role="menuitem" type="button">
                  <span class="source-menu-item-label">Manage provider access</span>
                  <span class="source-menu-item-detail">Dates, duration, reminders, login or catalogue changes</span>
                </button>
              </div>
            ` : ''}
            <div class="source-menu-section" role="group" aria-label="Catalog actions">
              <span class="source-menu-heading" aria-hidden="true">Catalog actions</span>
              <button class="source-menu-item" data-action="test" role="menuitem" type="button"${managementEnabled ? '' : ' disabled aria-disabled="true" title="Enable the service first"'}><span class="source-menu-item-label">Check service</span></button>
              <button class="source-menu-item" data-action="refresh" role="menuitem" type="button"${managementEnabled ? '' : ' disabled aria-disabled="true" title="Enable the service first"'}><span class="source-menu-item-label">Sync now</span></button>
              <button class="source-menu-item" data-action="hard-refresh" role="menuitem" type="button"${managementEnabled ? '' : ' disabled aria-disabled="true" title="Enable the service first"'}><span class="source-menu-item-label">Rebuild catalog</span></button>
            </div>
            <div class="source-menu-section" role="group" aria-label="Service">
              <span class="source-menu-heading" aria-hidden="true">Service</span>
              ${type !== 'xtream' ? `<button class="source-menu-item" data-action="edit" role="menuitem" type="button"><span class="source-menu-item-label">${legacyEditLabel}</span></button>` : ''}
              <button class="source-menu-item" data-action="toggle" role="menuitem" type="button"><span class="source-menu-item-label">${managementEnabled ? 'Disable service' : 'Enable service'}</span></button>
            </div>
            <div class="source-menu-section source-menu-section-danger" role="group" aria-label="Danger zone">
              <span class="source-menu-heading" aria-hidden="true">Danger zone</span>
              <button class="source-menu-item source-menu-danger" data-action="delete" role="menuitem" type="button"><span class="source-menu-item-label">Remove</span></button>
            </div>
          </div>
        </div>
      </div>
    `;
        }).join('');

        // Delegated action handling — one listener per card copes with the primary
        // button and the menu sharing data-action values (querySelector would only
        // wire the first). Choosing a menu item runs the action and closes the menu.
        container.querySelectorAll('.source-item').forEach(item => {
            const id = item.dataset.id;
            item.addEventListener('click', (e) => {
                const actionEl = e.target.closest('[data-action]');
                if (!actionEl || !item.contains(actionEl)) return;
                const action = actionEl.dataset.action;
                if (action === 'menu') { this.toggleSourceMenu(item); return; }
                this.closeAllSourceMenus({ restoreFocus: true });
                switch (action) {
                    case 'progress': this.showCatalogPreparationById(id, type); break;
                    case 'refresh': this.refreshSource(id, type); break;
                    case 'hard-refresh': this.refreshSource(id, type, { hard: true }); break;
                    case 'test': this.testSource(id); break;
                    case 'toggle': this.toggleSource(id); break;
                    case 'edit': this.showEditModal(id, type); break;
                    case 'provider-access': this.showProviderAccess(id); break;
                    case 'delete': this.deleteSource(id); break;
                }
            });
        });
    }

    /** Open/close a source card's ⋯ menu (only one open at a time). */
    toggleSourceMenu(item) {
        const menu = item.querySelector('.source-menu');
        if (!menu) return;
        const trigger = item.querySelector('.source-menu-btn');
        const willOpen = menu.hasAttribute('hidden');
        this.closeAllSourceMenus();
        if (!willOpen) return;
        menu.removeAttribute('hidden');
        trigger?.setAttribute('aria-expanded', 'true');
        // Close on outside click / Escape. Deferred so the opening click doesn't
        // immediately re-close it.
        this._srcMenuOutside = (e) => { if (!item.contains(e.target)) this.closeAllSourceMenus(); };
        this._srcMenuKey = (e) => {
            const controls = [...menu.querySelectorAll('[role="menuitem"]')].filter(control => !control.disabled);
            const activeIndex = controls.indexOf(document.activeElement);
            if (e.key === 'Escape' || e.key === 'GoBack') {
                e.preventDefault();
                this.closeAllSourceMenus({ restoreFocus: true });
                return;
            }
            let nextIndex = null;
            if (e.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % controls.length;
            if (e.key === 'ArrowUp') nextIndex = activeIndex < 0 ? controls.length - 1 : (activeIndex - 1 + controls.length) % controls.length;
            if (e.key === 'Home') nextIndex = 0;
            if (e.key === 'End') nextIndex = controls.length - 1;
            if (nextIndex !== null && controls[nextIndex]) {
                e.preventDefault();
                controls[nextIndex].focus();
            }
        };
        setTimeout(() => {
            document.addEventListener('click', this._srcMenuOutside, true);
            document.addEventListener('keydown', this._srcMenuKey, true);
            menu.querySelector('[role="menuitem"]')?.focus();
        }, 0);
    }

    closeAllSourceMenus({ restoreFocus = false } = {}) {
        let restoreTarget = null;
        document.querySelectorAll('.source-menu:not([hidden])').forEach((m) => {
            m.setAttribute('hidden', '');
            const trigger = m.closest('.source-item')?.querySelector('.source-menu-btn');
            trigger?.setAttribute('aria-expanded', 'false');
            if (restoreFocus && !restoreTarget) restoreTarget = trigger;
        });
        if (this._srcMenuOutside) { document.removeEventListener('click', this._srcMenuOutside, true); this._srcMenuOutside = null; }
        if (this._srcMenuKey) { document.removeEventListener('keydown', this._srcMenuKey, true); this._srcMenuKey = null; }
        restoreTarget?.focus();
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
        modal.classList.remove('provider-access-wizard-modal');
        footer.hidden = false;

        body.innerHTML = this.getSourceForm(type);

        footer.innerHTML = `
      <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Add</button>
    `;

        modal.classList.add('active');
        if (window.NorvaModal?.installHygiene) NorvaModal.installHygiene(modal);

        // Event listeners
        modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
        document.getElementById('modal-cancel').onclick = () => modal.classList.remove('active');
        document.getElementById('modal-save').onclick = (e) => {
            const btn = e.currentTarget;
            if (btn.disabled) return;               // guard against a double-press creating duplicate sources
            btn.disabled = true;
            Promise.resolve(this.saveNewSource(type)).finally(() => { btn.disabled = false; });
        };
        const accessWizard = this.bindSourceForm(type);
        if (accessWizard?.fieldset) {
            document.getElementById('modal-save').hidden = true;
            accessWizard.fieldset.addEventListener('norva:provider-access-cancel', () => modal.classList.remove('active'));
            accessWizard.fieldset.addEventListener('norva:provider-access-complete', () => {
                document.getElementById('modal-save')?.click();
            });
        }
    }

    /**
     * Show edit source modal
     */
    async showEditModal(id, type) {
        try {
            const source = await API.sources.getById(id);
            // getById returns null (not a throw) when the source is gone/stale; the form
            // builders deref source.* and would throw into a silent console.error, leaving
            // the button looking dead. Surface it and refresh the list instead.
            if (!source) {
                NorvaModal.toast('Could not load this source — it may have been removed.', 'error');
                try { await this.loadSources(); } catch (_) { /* noop */ }
                return;
            }

            const modal = document.getElementById('modal');
            const title = document.getElementById('modal-title');
            const body = document.getElementById('modal-body');
            const footer = document.getElementById('modal-footer');

            const titles = { xtream: 'Edit TV provider', m3u: 'Edit playlist link', epg: 'Edit TV guide' };
            title.textContent = titles[type] || 'Edit provider';
            modal.classList.remove('provider-access-wizard-modal');
            footer.hidden = false;
            body.innerHTML = this.getSourceForm(type, source);

            footer.innerHTML = `
        <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save Changes</button>
      `;

            modal.classList.add('active');
            if (window.NorvaModal?.installHygiene) NorvaModal.installHygiene(modal);

            modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
            document.getElementById('modal-cancel').onclick = () => modal.classList.remove('active');
            document.getElementById('modal-save').onclick = (e) => {
                const btn = e.currentTarget;
                if (btn.disabled) return;           // guard against a double-press duplicating the PUT
                btn.disabled = true;
                Promise.resolve(this.updateSource(id, type)).finally(() => { btn.disabled = false; });
            };
            this.bindSourceForm(type);
        } catch (err) {
            console.error('Error loading source:', err);
            NorvaModal.toast('Could not open this source. Try again.', 'error');
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

    isSourceManagementEnabled(source = {}) {
        if (typeof source.managementEnabled === 'boolean') return source.managementEnabled;
        if (typeof source.sourceEnabled === 'boolean') return source.sourceEnabled;
        return source.enabled !== false;
    }

    providerAccessUiEnabled() {
        return window.NORVA_PROVIDER_ACCESS_UI_V1 === true
            && window.API?.providerAccess?.available?.() === true;
    }

    providerAccessSummary(source = {}) {
        const status = String(source.provider_access_status || source.providerAccessStatus || 'unknown').toLowerCase();
        const expiresOn = source.provider_access_expires_on || source.providerAccessExpiresOn || null;
        const labels = {
            active: ['Access active', 'positive'],
            expiring: ['Access ending soon', 'warning'],
            expected_expired: ['Renewal date passed', 'warning'],
            expired_confirmed: ['Provider access expired', 'danger'],
            access_unavailable_confirmed: ['Provider access unavailable', 'danger'],
            check_failed_temporary: ['Access check delayed', 'neutral'],
            restoring: ['Restoring provider access', 'warning'],
            unknown: ['Access dates not added', 'neutral']
        };
        const [label, tone] = labels[status] || labels.unknown;
        return {
            status,
            label,
            tone,
            detail: expiresOn ? `Until ${this.formatAccessDate(expiresOn)}` : ''
        };
    }

    formatAccessDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return '';
        try {
            return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
                .format(new Date(`${value}T00:00:00Z`));
        } catch (_) {
            return String(value);
        }
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

    providerAccessTodayKey() {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    providerAccessDateFromKey(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
        if (!match) return null;
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        return date.getUTCFullYear() === Number(match[1])
            && date.getUTCMonth() === Number(match[2]) - 1
            && date.getUTCDate() === Number(match[3])
            ? date
            : null;
    }

    providerAccessDateKey(date) {
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    }

    providerAccessAddTerm(startKey, value, unit) {
        const start = this.providerAccessDateFromKey(startKey);
        const amount = Number(value);
        if (!start || !Number.isInteger(amount) || amount < 1) return null;
        const normalizedUnit = String(unit || '').toUpperCase();
        if (normalizedUnit === 'DAY' || normalizedUnit === 'WEEK') {
            const result = new Date(start.getTime());
            result.setUTCDate(result.getUTCDate() + amount * (normalizedUnit === 'WEEK' ? 7 : 1));
            return result;
        }
        if (normalizedUnit !== 'MONTH' && normalizedUnit !== 'YEAR') return null;
        const monthDelta = amount * (normalizedUnit === 'YEAR' ? 12 : 1);
        const targetMonthIndex = start.getUTCMonth() + monthDelta;
        const targetYear = start.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
        const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
        const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
        return new Date(Date.UTC(targetYear, targetMonth, Math.min(start.getUTCDate(), lastDay)));
    }

    renderProviderAccessCalendar(fieldset, { resetMonth = false } = {}) {
        const calendar = fieldset?.querySelector?.('[data-access-calendar]');
        if (!calendar) return;
        const activationInput = fieldset.querySelector('[data-access-activation-on]');
        const termInput = fieldset.querySelector('[data-access-term-value]');
        const unitInput = fieldset.querySelector('[data-access-term-unit]');
        const startKey = activationInput?.value || this.providerAccessTodayKey();
        const termValue = Number(termInput?.value);
        const termUnit = String(unitInput?.value || '').toUpperCase();
        const start = this.providerAccessDateFromKey(startKey);
        const end = this.providerAccessAddTerm(startKey, termValue, termUnit);
        const summary = calendar.querySelector('[data-access-calendar-summary]');
        const badge = calendar.querySelector('[data-access-calendar-badge]');
        const grid = calendar.querySelector('[data-access-calendar-grid]');
        const title = calendar.querySelector('[data-access-calendar-title]');
        if (!start || !end || !grid || !title) {
            if (summary) summary.textContent = 'Enter a valid duration to preview its end date.';
            if (badge) badge.textContent = 'End date unavailable';
            if (grid) grid.innerHTML = '';
            return;
        }

        const formatLong = (date) => new Intl.DateTimeFormat('en', {
            year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'
        }).format(date);
        const unitLabel = `${termUnit.charAt(0)}${termUnit.slice(1).toLowerCase()}${termValue === 1 ? '' : 's'}`;
        if (summary) summary.textContent = `${termValue} ${unitLabel.toLowerCase()} from ${formatLong(start)} · ends ${formatLong(end)}`;
        if (badge) badge.textContent = `Ends ${formatLong(end)}`;

        const endMonthKey = this.providerAccessDateKey(end).slice(0, 7);
        if (resetMonth || !/^\d{4}-\d{2}$/.test(calendar.dataset.displayMonth || '')) {
            calendar.dataset.displayMonth = endMonthKey;
        }
        const [displayYear, displayMonthNumber] = calendar.dataset.displayMonth.split('-').map(Number);
        const displayMonth = displayMonthNumber - 1;
        const first = new Date(Date.UTC(displayYear, displayMonth, 1));
        title.textContent = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(first);
        const mondayOffset = (first.getUTCDay() + 6) % 7;
        const gridStart = new Date(Date.UTC(displayYear, displayMonth, 1 - mondayOffset));
        const maxEnd = new Date(start.getTime());
        maxEnd.setUTCDate(maxEnd.getUTCDate() + 10000);
        const cells = [];
        for (let index = 0; index < 42; index += 1) {
            const day = new Date(gridStart.getTime());
            day.setUTCDate(day.getUTCDate() + index);
            const key = this.providerAccessDateKey(day);
            const outside = day.getUTCMonth() !== displayMonth;
            const selectable = !outside && day > start && day <= maxEnd;
            const classes = [
                'provider-access-calendar-day',
                outside ? 'is-outside' : '',
                day >= start && day <= end ? 'is-in-period' : '',
                key === startKey ? 'is-start' : '',
                key === this.providerAccessDateKey(end) ? 'is-end' : ''
            ].filter(Boolean).join(' ');
            const label = `${formatLong(day)}${key === this.providerAccessDateKey(end) ? ', current end date' : ''}`;
            cells.push(selectable
                ? `<button type="button" class="${classes}" data-access-calendar-day="${key}" aria-label="${this.escapeHtml(label)}"${key === this.providerAccessDateKey(end) ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${day.getUTCDate()}</button>`
                : `<span class="${classes}" aria-hidden="true">${day.getUTCDate()}</span>`);
        }
        grid.innerHTML = cells.join('');
    }

    getSavedConnectionCard(type, source = {}) {
        const isExisting = Boolean(source.id || source.cloudId || source.cloud_id);
        if (!isExisting) return '';

        const host = this.sourceHost(source);
        const hasPassword = type === 'xtream' && this.hasSavedPassword(source);

        return `
      <div class="source-saved-connection">
        <div class="source-saved-title">Saved connection</div>
        <div class="source-saved-grid">
          <span>Server</span>
          <strong>${this.escapeHtml(host || 'Saved privately')}</strong>
          ${type === 'xtream' ? `
          <span>Login</span>
          <strong>Saved privately</strong>
          <span>Password</span>
          <strong><span class="source-secret-mask">${hasPassword ? '&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;' : 'Not saved'}</span></strong>
          ` : ''}
        </div>
      </div>
    `;
    }

    providerAccessWizardSteps(mode = 'duration') {
        if (mode === 'dates') return ['choice', 'dates', 'review'];
        if (mode === 'skip') return ['choice', 'review'];
        return ['choice', 'activation', 'duration', 'review'];
    }

    getProviderAccessTermsFields({ prefix = 'source-access', access = null, onboarding = false, deferred = false } = {}) {
        if (!this.providerAccessUiEnabled()) return '';
        const cycle = access?.activeCycle || null;
        const initialMode = cycle?.termValue ? 'duration' : (access?.expiresOn ? 'dates' : 'duration');
        const startedOn = access?.startedOn || '';
        const activationOn = startedOn || this.providerAccessTodayKey();
        const expiresOn = access?.expiresOn || '';
        const termValue = cycle?.termValue || 1;
        const termUnit = String(cycle?.termUnit || 'MONTH').toUpperCase();
        const reminders = access?.remindersEnabled === true;
        const initialSteps = this.providerAccessWizardSteps(initialMode);
        const choices = [
            ['duration', 'Duration bought', 'For example, 2 months from the activation date', '2 mo', 'Recommended'],
            ['dates', 'Start and end dates', 'Use the exact dates from your receipt', '01–31', ''],
            ['skip', 'Add this later', 'Continue without recording an access period', 'Later', '']
        ];
        return `
          <fieldset class="provider-access-terms provider-access-wizard${onboarding ? ' is-onboarding' : ''}" data-provider-access-terms="${this.escapeHtml(prefix)}" data-access-onboarding="${onboarding}" data-access-has-cycle="${Boolean(cycle)}"${deferred ? ' hidden' : ''}>
            <legend class="provider-access-sr-only">${onboarding ? 'Provider access period' : 'Access dates and reminders'}</legend>
            <div class="provider-access-wizard-progress">
              <div class="provider-access-wizard-progress-copy">
                <span data-access-step-label>Step 1 of ${initialSteps.length}</span>
                <strong data-access-step-name>Choose period</strong>
              </div>
              <span class="provider-access-wizard-track" role="progressbar" aria-label="Provider access setup" aria-valuemin="1" aria-valuemax="${initialSteps.length}" aria-valuenow="1" data-access-progress>
                <i data-access-progress-fill></i>
              </span>
            </div>

            <section class="provider-access-wizard-stage" data-access-wizard-stage="choice" aria-labelledby="${this.escapeHtml(prefix)}-choice-title">
              <div class="provider-access-wizard-copy">
                <span class="provider-access-wizard-eyebrow">Access period</span>
                <h3 id="${this.escapeHtml(prefix)}-choice-title" tabindex="-1">What do you know?</h3>
                <p>Choose the quickest way to describe the provider access you bought.</p>
              </div>
              <select id="${this.escapeHtml(prefix)}-mode" data-access-mode tabindex="-1" aria-hidden="true" hidden>
                <option value="duration"${initialMode === 'duration' ? ' selected' : ''}>Duration bought</option>
                <option value="dates"${initialMode === 'dates' ? ' selected' : ''}>Start and end dates</option>
                <option value="skip"${initialMode === 'skip' ? ' selected' : ''}>Add this later</option>
              </select>
              <div class="provider-access-choice-list" role="radiogroup" aria-label="What do you know?">
                ${choices.map(([value, label, hint, glyph, badge]) => `
                  <button type="button" class="provider-access-choice${initialMode === value ? ' is-selected' : ''}" data-access-mode-choice="${value}" role="radio" aria-checked="${initialMode === value}">
                    <span class="provider-access-choice-glyph" aria-hidden="true">${glyph}</span>
                    <span class="provider-access-choice-copy"><strong>${label}</strong><small>${hint}</small></span>
                    ${badge ? `<span class="provider-access-choice-badge">${badge}</span>` : ''}
                    <span class="provider-access-choice-check" aria-hidden="true"></span>
                  </button>
                `).join('')}
              </div>
              <p class="provider-access-explainer">Your provider access is separate from your Norva plan. Norva records the period; it never sells or renews it.</p>
            </section>

            <section class="provider-access-wizard-stage" data-access-wizard-stage="activation" aria-labelledby="${this.escapeHtml(prefix)}-activation-title" hidden>
              <div class="provider-access-wizard-copy">
                <span class="provider-access-wizard-eyebrow">Activation</span>
                <h3 id="${this.escapeHtml(prefix)}-activation-title" tabindex="-1">When does access begin?</h3>
                <p>Use the purchase date if access started immediately.</p>
              </div>
              <div class="form-group provider-access-activation-field">
                <label for="${this.escapeHtml(prefix)}-activation-on">Activation or purchase date</label>
                <input id="${this.escapeHtml(prefix)}-activation-on" class="form-input" type="date" value="${this.escapeHtml(activationOn)}" data-access-activation-on>
              </div>
              <div class="provider-access-date-shortcuts" aria-label="Activation date shortcuts">
                <button type="button" data-access-date-shortcut="today">Today</button>
                <button type="button" data-access-date-shortcut="yesterday">Yesterday</button>
              </div>
              <div class="provider-access-context-note"><span aria-hidden="true"></span><p>The end date will be calculated from this day and the duration you enter next.</p></div>
            </section>

            <section class="provider-access-wizard-stage" data-access-wizard-stage="duration" aria-labelledby="${this.escapeHtml(prefix)}-duration-title" hidden>
              <div class="provider-access-wizard-copy">
                <span class="provider-access-wizard-eyebrow">Duration</span>
                <h3 id="${this.escapeHtml(prefix)}-duration-title" tabindex="-1">How long is access active?</h3>
                <p>Duration and unit stay together. The calendar gives you a precise visual end date.</p>
              </div>
              <div class="provider-access-field-row provider-access-duration-row">
                <div class="form-group">
                  <label for="${this.escapeHtml(prefix)}-term-value">Duration</label>
                  <input id="${this.escapeHtml(prefix)}-term-value" class="form-input" type="number" inputmode="numeric" min="1" max="10000" value="${this.escapeHtml(termValue)}" data-access-term-value>
                </div>
                <div class="form-group">
                  <label for="${this.escapeHtml(prefix)}-term-unit">Unit</label>
                  <span class="provider-access-select-shell">
                    <select id="${this.escapeHtml(prefix)}-term-unit" class="form-input provider-access-native-select" data-access-term-unit>
                      ${['DAY', 'WEEK', 'MONTH', 'YEAR'].map((unit) => `<option value="${unit}"${termUnit === unit ? ' selected' : ''}>${unit.charAt(0) + unit.slice(1).toLowerCase()}${termValue === 1 ? '' : 's'}</option>`).join('')}
                    </select>
                    <button type="button" class="form-input provider-access-select-trigger" data-provider-access-select-trigger aria-label="Unit: ${termUnit.charAt(0) + termUnit.slice(1).toLowerCase()}${termValue === 1 ? '' : 's'}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${this.escapeHtml(prefix)}-term-unit-listbox" hidden>
                      <span data-provider-access-select-value>${termUnit.charAt(0) + termUnit.slice(1).toLowerCase()}${termValue === 1 ? '' : 's'}</span>
                      <svg class="provider-access-select-chevron" aria-hidden="true" viewBox="0 0 20 20" fill="none">
                        <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </button>
                    <span id="${this.escapeHtml(prefix)}-term-unit-listbox" class="provider-access-select-menu is-unit" data-provider-access-select-menu role="listbox" aria-label="Unit" hidden>
                      ${['DAY', 'WEEK', 'MONTH', 'YEAR'].map((unit) => `<button type="button" class="provider-access-select-option" role="option" data-provider-access-select-option="${unit}" data-provider-access-unit-label="${unit.charAt(0) + unit.slice(1).toLowerCase()}" aria-selected="${termUnit === unit}">${unit.charAt(0) + unit.slice(1).toLowerCase()}${termValue === 1 ? '' : 's'}</button>`).join('')}
                    </span>
                  </span>
                </div>
              </div>
              <section class="provider-access-calendar" data-access-calendar aria-label="Provider access end-date preview">
                <div class="provider-access-calendar-summary">
                  <div class="provider-access-calendar-copy">
                    <span class="provider-access-calendar-kicker">Access preview</span>
                    <strong data-access-calendar-summary aria-live="polite"></strong>
                  </div>
                  <span class="provider-access-calendar-badge" data-access-calendar-badge></span>
                </div>
                <div class="provider-access-calendar-timeline" aria-hidden="true">
                  <span class="provider-access-calendar-timeline-point is-start"></span>
                  <span class="provider-access-calendar-timeline-track"></span>
                  <span class="provider-access-calendar-timeline-point is-end"></span>
                </div>
                <div class="provider-access-calendar-header">
                  <button type="button" class="provider-access-calendar-nav" data-access-calendar-prev aria-label="Previous month">&#8249;</button>
                  <strong data-access-calendar-title></strong>
                  <button type="button" class="provider-access-calendar-nav" data-access-calendar-next aria-label="Next month">&#8250;</button>
                </div>
                <div class="provider-access-calendar-weekdays" aria-hidden="true">
                  ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => `<span>${day}</span>`).join('')}
                </div>
                <div class="provider-access-calendar-grid" data-access-calendar-grid></div>
                <p class="provider-access-calendar-caption">Choose another end date to update the duration above. Norva will switch it to an exact number of days.</p>
              </section>
            </section>

            <section class="provider-access-wizard-stage" data-access-wizard-stage="dates" aria-labelledby="${this.escapeHtml(prefix)}-dates-title" hidden>
              <div class="provider-access-wizard-copy">
                <span class="provider-access-wizard-eyebrow">Exact dates</span>
                <h3 id="${this.escapeHtml(prefix)}-dates-title" tabindex="-1">Enter the start and end dates</h3>
                <p>Use the exact dates shown by your provider or on your receipt.</p>
              </div>
              <div class="provider-access-field-row">
                <div class="form-group">
                  <label for="${this.escapeHtml(prefix)}-started-on">Start date</label>
                  <input id="${this.escapeHtml(prefix)}-started-on" class="form-input" type="date" value="${this.escapeHtml(startedOn)}" data-access-started-on>
                </div>
                <div class="form-group">
                  <label for="${this.escapeHtml(prefix)}-expires-on">End date</label>
                  <input id="${this.escapeHtml(prefix)}-expires-on" class="form-input" type="date" value="${this.escapeHtml(expiresOn)}" data-access-expires-on>
                </div>
              </div>
              <div class="provider-access-context-note"><span aria-hidden="true"></span><p data-access-dates-summary>Norva will use these dates to keep the catalogue status accurate.</p></div>
            </section>

            <section class="provider-access-wizard-stage" data-access-wizard-stage="review" aria-labelledby="${this.escapeHtml(prefix)}-review-title" hidden>
              <div class="provider-access-wizard-copy">
                <span class="provider-access-wizard-eyebrow">Review</span>
                <h3 id="${this.escapeHtml(prefix)}-review-title" tabindex="-1">Everything look right?</h3>
                <p data-access-review-intro>Review the period before saving it.</p>
              </div>
              <div class="provider-access-review" data-access-review>
                <div class="provider-access-review-hero">
                  <span><small>Provider access</small><strong data-access-review-title></strong></span>
                  <span class="provider-access-review-duration"><b data-access-review-value></b><small data-access-review-unit></small></span>
                </div>
                <dl class="provider-access-review-rows" data-access-review-rows>
                  <div><dt>Starts</dt><dd data-access-review-start></dd></div>
                  <div><dt>Ends</dt><dd data-access-review-end></dd></div>
                </dl>
              </div>
              <label class="provider-access-reminder" data-access-reminder-row${initialMode === 'skip' ? ' hidden' : ''}>
                <span class="provider-access-reminder-icon" aria-hidden="true"></span>
                <span><strong>Remind me before it ends</strong><small>Explicit opt-in. You can change this at any time.</small></span>
                <input type="checkbox" data-access-reminders${reminders ? ' checked' : ''}>
              </label>
              ${cycle ? '<button class="provider-access-remove-period" type="button" data-access-end>Remove recorded period</button>' : ''}
            </section>

            <p class="form-error provider-access-form-error" data-access-error role="alert" hidden></p>
            <div class="provider-access-wizard-actions">
              <button class="btn btn-secondary" type="button" data-access-wizard-back>${onboarding ? 'Back' : 'Cancel'}</button>
              <button class="btn btn-primary" type="button" data-access-wizard-next>Continue <span aria-hidden="true">→</span></button>
            </div>
            <span class="provider-access-sr-only" aria-live="polite" aria-atomic="true" data-access-wizard-live></span>
          </fieldset>
        `;
    }

    bindProviderAccessTerms(root = document) {
        const controllers = [];
        root.querySelectorAll?.('[data-provider-access-terms]').forEach((fieldset) => {
            const mode = fieldset.querySelector('[data-access-mode]');
            const activation = fieldset.querySelector('[data-access-activation-on]');
            const termValue = fieldset.querySelector('[data-access-term-value]');
            const termUnit = fieldset.querySelector('[data-access-term-unit]');
            const calendar = fieldset.querySelector('[data-access-calendar]');
            const selectShells = [...fieldset.querySelectorAll('.provider-access-select-shell')];
            const closeSelect = (shell, { restoreFocus = false } = {}) => {
                const trigger = shell?.querySelector('[data-provider-access-select-trigger]');
                const menu = shell?.querySelector('[data-provider-access-select-menu]');
                if (!trigger || !menu) return;
                menu.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
                shell.classList.remove('is-open');
                if (restoreFocus) trigger.focus({ preventScroll: true });
            };
            const closeOtherSelects = (currentShell) => {
                selectShells.forEach((shell) => {
                    if (shell !== currentShell) closeSelect(shell);
                });
            };
            const syncSelect = (select) => {
                const shell = select?.closest?.('.provider-access-select-shell');
                const trigger = shell?.querySelector('[data-provider-access-select-trigger]');
                const triggerValue = shell?.querySelector('[data-provider-access-select-value]');
                const options = [...(shell?.querySelectorAll?.('[data-provider-access-select-option]') || [])];
                if (!shell || !trigger || !triggerValue) return;
                const isUnit = select.matches('[data-access-term-unit]');
                const plural = Number(termValue?.value) === 1 ? '' : 's';
                options.forEach((option) => {
                    const selected = option.dataset.providerAccessSelectOption === select.value;
                    const unitLabel = option.dataset.providerAccessUnitLabel;
                    if (isUnit && unitLabel) option.textContent = `${unitLabel}${plural}`;
                    option.setAttribute('aria-selected', String(selected));
                    if (selected) triggerValue.textContent = option.textContent;
                });
                const fieldLabel = select.labels?.[0]?.textContent?.trim() || 'Select value';
                trigger.setAttribute('aria-label', `${fieldLabel}: ${triggerValue.textContent}`);
            };
            const openSelect = (select, { focusEdge = 'selected' } = {}) => {
                const shell = select?.closest?.('.provider-access-select-shell');
                const trigger = shell?.querySelector('[data-provider-access-select-trigger]');
                const menu = shell?.querySelector('[data-provider-access-select-menu]');
                const options = [...(menu?.querySelectorAll?.('[data-provider-access-select-option]') || [])];
                if (!shell || !trigger || !menu || options.length === 0) return;
                closeOtherSelects(shell);
                syncSelect(select);
                menu.hidden = false;
                trigger.setAttribute('aria-expanded', 'true');
                shell.classList.add('is-open');
                if (focusEdge === 'none') return;
                const target = focusEdge === 'first'
                    ? options[0]
                    : (focusEdge === 'last' ? options[options.length - 1] : options.find((option) => option.getAttribute('aria-selected') === 'true'));
                (target || options[0]).focus({ preventScroll: true });
            };
            selectShells.forEach((shell) => {
                const select = shell.querySelector('select');
                const trigger = shell.querySelector('[data-provider-access-select-trigger]');
                const menu = shell.querySelector('[data-provider-access-select-menu]');
                const options = [...(menu?.querySelectorAll?.('[data-provider-access-select-option]') || [])];
                if (!select || !trigger || !menu || options.length === 0) return;
                select.hidden = true;
                trigger.hidden = false;
                syncSelect(select);
                select.labels?.[0]?.addEventListener('click', (event) => {
                    event.preventDefault();
                    trigger.focus({ preventScroll: true });
                });
                trigger.addEventListener('click', () => {
                    if (trigger.getAttribute('aria-expanded') === 'true') closeSelect(shell);
                    else openSelect(select, { focusEdge: 'none' });
                });
                trigger.addEventListener('keydown', (event) => {
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    openSelect(select, { focusEdge: ['ArrowUp', 'End'].includes(event.key) ? 'last' : 'first' });
                });
                const choose = (option) => {
                    select.value = option.dataset.providerAccessSelectOption || '';
                    syncSelect(select);
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    closeSelect(shell, { restoreFocus: true });
                };
                options.forEach((option, index) => {
                    option.addEventListener('click', () => choose(option));
                    option.addEventListener('keydown', (event) => {
                        if (['Enter', ' '].includes(event.key)) {
                            event.preventDefault();
                            choose(option);
                            return;
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            closeSelect(shell, { restoreFocus: true });
                            return;
                        }
                        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                        event.preventDefault();
                        const nextIndex = event.key === 'Home' ? 0
                            : (event.key === 'End' ? options.length - 1
                                : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
                        options[nextIndex].focus({ preventScroll: true });
                    });
                });
            });
            fieldset.addEventListener('pointerdown', (event) => {
                selectShells.forEach((shell) => {
                    if (!shell.contains(event.target)) closeSelect(shell);
                });
            });
            fieldset.addEventListener('focusout', () => {
                requestAnimationFrame(() => {
                    selectShells.forEach((shell) => {
                        if (!shell.contains(document.activeElement)) closeSelect(shell);
                    });
                });
            });
            const error = fieldset.querySelector('[data-access-error]');
            const clearError = () => {
                if (error) {
                    error.textContent = '';
                    error.hidden = true;
                }
                fieldset.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute('aria-invalid'));
            };
            const updateReview = () => {
                const selected = mode?.value || 'skip';
                const reminders = fieldset.querySelector('[data-access-reminder-row]');
                if (reminders) reminders.hidden = selected === 'skip';
                fieldset.querySelectorAll('[data-access-mode-choice]').forEach((choice) => {
                    const checked = choice.dataset.accessModeChoice === selected;
                    choice.classList.toggle('is-selected', checked);
                    choice.setAttribute('aria-checked', String(checked));
                });
                const title = fieldset.querySelector('[data-access-review-title]');
                const value = fieldset.querySelector('[data-access-review-value]');
                const unit = fieldset.querySelector('[data-access-review-unit]');
                const startNode = fieldset.querySelector('[data-access-review-start]');
                const endNode = fieldset.querySelector('[data-access-review-end]');
                const rows = fieldset.querySelector('[data-access-review-rows]');
                const intro = fieldset.querySelector('[data-access-review-intro]');
                if (selected === 'skip') {
                    if (title) title.textContent = fieldset.dataset.accessHasCycle === 'true' ? 'Keep current period' : 'Add later';
                    if (value) value.textContent = '—';
                    if (unit) unit.textContent = 'No new dates';
                    if (rows) rows.hidden = true;
                    if (intro) intro.textContent = fieldset.dataset.accessHasCycle === 'true'
                        ? 'Your currently recorded period will stay unchanged.'
                        : 'You can finish now and add an access period later in Settings.';
                    return;
                }
                if (rows) rows.hidden = false;
                if (intro) intro.textContent = 'Review the period before saving it.';
                let startKey = '';
                let endKey = '';
                if (selected === 'duration') {
                    startKey = String(activation?.value || '');
                    const amount = Number(termValue?.value);
                    const selectedUnit = String(termUnit?.value || '');
                    const end = this.providerAccessAddTerm(startKey, amount, selectedUnit);
                    endKey = end ? this.providerAccessDateKey(end) : '';
                    if (title) title.textContent = `${Number.isFinite(amount) ? amount : '—'} ${selectedUnit ? selectedUnit.toLowerCase() : ''}${amount === 1 ? '' : 's'}`;
                    if (value) value.textContent = Number.isFinite(amount) ? String(amount) : '—';
                    if (unit) unit.textContent = selectedUnit ? `${selectedUnit.toLowerCase()}${amount === 1 ? '' : 's'}` : '';
                } else {
                    startKey = String(fieldset.querySelector('[data-access-started-on]')?.value || '');
                    endKey = String(fieldset.querySelector('[data-access-expires-on]')?.value || '');
                    const startDate = this.providerAccessDateFromKey(startKey);
                    const endDate = this.providerAccessDateFromKey(endKey);
                    const exactDays = startDate && endDate ? Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 86400000)) : 0;
                    if (title) title.textContent = exactDays ? `${exactDays} days` : 'Exact dates';
                    if (value) value.textContent = exactDays ? String(exactDays) : '—';
                    if (unit) unit.textContent = exactDays === 1 ? 'day' : 'days';
                    const datesSummary = fieldset.querySelector('[data-access-dates-summary]');
                    if (datesSummary) datesSummary.textContent = exactDays
                        ? `${exactDays} days of provider access are selected.`
                        : 'Norva will use these dates to keep the catalogue status accurate.';
                }
                if (startNode) startNode.textContent = this.formatAccessDate(startKey) || 'Not set';
                if (endNode) endNode.textContent = this.formatAccessDate(endKey) || 'Not set';
            };
            const updateCalendar = () => {
                syncSelect(termUnit);
                this.renderProviderAccessCalendar(fieldset, { resetMonth: true });
                updateReview();
            };
            const stepNames = {
                choice: 'Choose period', activation: 'Activation date', duration: 'Duration and calendar', dates: 'Exact dates', review: 'Review'
            };
            let stepIndex = 0;
            const showStep = (nextIndex, { focus = true } = {}) => {
                const steps = this.providerAccessWizardSteps(mode?.value || 'skip');
                stepIndex = Math.max(0, Math.min(nextIndex, steps.length - 1));
                const activeStep = steps[stepIndex];
                fieldset.dataset.accessWizardStep = activeStep;
                fieldset.querySelectorAll('[data-access-wizard-stage]').forEach((stage) => {
                    stage.hidden = stage.dataset.accessWizardStage !== activeStep;
                });
                const label = fieldset.querySelector('[data-access-step-label]');
                const name = fieldset.querySelector('[data-access-step-name]');
                const progress = fieldset.querySelector('[data-access-progress]');
                const fill = fieldset.querySelector('[data-access-progress-fill]');
                const back = fieldset.querySelector('[data-access-wizard-back]');
                const next = fieldset.querySelector('[data-access-wizard-next]');
                const finalStep = stepIndex === steps.length - 1;
                if (label) label.textContent = `Step ${stepIndex + 1} of ${steps.length}`;
                if (name) name.textContent = stepNames[activeStep] || 'Provider access';
                if (progress) {
                    progress.setAttribute('aria-valuemax', String(steps.length));
                    progress.setAttribute('aria-valuenow', String(stepIndex + 1));
                }
                if (fill) fill.style.width = `${((stepIndex + 1) / steps.length) * 100}%`;
                if (back) back.textContent = stepIndex === 0 ? (fieldset.dataset.accessOnboarding === 'true' ? 'Back' : 'Cancel') : 'Back';
                if (next) {
                    const hasCycle = fieldset.dataset.accessHasCycle === 'true';
                    next.innerHTML = finalStep
                        ? `${mode?.value === 'skip' ? (hasCycle ? 'Keep current period' : 'Finish without dates') : (hasCycle ? 'Save period' : (fieldset.dataset.accessOnboarding === 'true' ? 'Connect and prepare catalogue' : 'Add period'))} <span aria-hidden="true">→</span>`
                        : 'Continue <span aria-hidden="true">→</span>';
                }
                updateReview();
                if (activeStep === 'duration') this.renderProviderAccessCalendar(fieldset, { resetMonth: true });
                const live = fieldset.querySelector('[data-access-wizard-live]');
                if (live) live.textContent = `${stepNames[activeStep] || 'Provider access'}, step ${stepIndex + 1} of ${steps.length}.`;
                const modalBody = fieldset.closest('.modal-body');
                if (modalBody?.closest('.provider-access-wizard-modal')) modalBody.scrollTop = 0;
                if (focus && !fieldset.hidden) {
                    requestAnimationFrame(() => fieldset.querySelector(`[data-access-wizard-stage="${activeStep}"] h3`)?.focus({ preventScroll: true }));
                }
            };
            const failStep = (message, control) => {
                if (error) {
                    error.textContent = message;
                    error.hidden = false;
                }
                control?.setAttribute('aria-invalid', 'true');
                control?.focus({ preventScroll: true });
                return false;
            };
            const validateStep = (step) => {
                clearError();
                if (step === 'activation') {
                    const value = String(activation?.value || '');
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !this.providerAccessDateFromKey(value)) {
                        return failStep('Enter a valid provider access activation date.', activation);
                    }
                }
                if (step === 'duration') {
                    const amount = Number(termValue?.value);
                    if (!Number.isInteger(amount) || amount < 1 || amount > 10000 || !['DAY', 'WEEK', 'MONTH', 'YEAR'].includes(String(termUnit?.value || ''))) {
                        return failStep('Enter a valid provider access duration.', termValue);
                    }
                }
                if (step === 'dates') {
                    const started = fieldset.querySelector('[data-access-started-on]');
                    const expires = fieldset.querySelector('[data-access-expires-on]');
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(started?.value || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(expires?.value || '')) || expires.value < started.value) {
                        return failStep('Enter a valid provider access start and end date.', !started?.value ? started : expires);
                    }
                }
                return true;
            };
            const chooseMode = (choice, { focus = false } = {}) => {
                if (!mode) return;
                mode.value = choice.dataset.accessModeChoice || 'skip';
                mode.dispatchEvent(new Event('change', { bubbles: true }));
                if (focus) choice.focus({ preventScroll: true });
            };
            const modeChoices = [...fieldset.querySelectorAll('[data-access-mode-choice]')];
            modeChoices.forEach((choice, index) => {
                choice.addEventListener('click', () => chooseMode(choice));
                choice.addEventListener('keydown', (event) => {
                    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const nextIndex = event.key === 'Home' ? 0
                        : (event.key === 'End' ? modeChoices.length - 1
                            : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + modeChoices.length) % modeChoices.length);
                    chooseMode(modeChoices[nextIndex], { focus: true });
                });
            });
            mode?.addEventListener('change', () => {
                clearError();
                closeOtherSelects(null);
                updateReview();
                if (fieldset.dataset.accessWizardStep === 'choice') showStep(0, { focus: false });
            });
            activation?.addEventListener('change', updateCalendar);
            termValue?.addEventListener('input', updateCalendar);
            termUnit?.addEventListener('change', updateCalendar);
            fieldset.querySelectorAll('[data-access-started-on], [data-access-expires-on], [data-access-reminders]').forEach((control) => {
                control.addEventListener('change', () => {
                    clearError();
                    updateReview();
                });
            });
            fieldset.querySelectorAll('[data-access-date-shortcut]').forEach((button) => {
                button.addEventListener('click', () => {
                    let dateKey = this.providerAccessTodayKey();
                    if (button.dataset.accessDateShortcut === 'yesterday') {
                        const date = this.providerAccessDateFromKey(dateKey);
                        date.setUTCDate(date.getUTCDate() - 1);
                        dateKey = this.providerAccessDateKey(date);
                    }
                    if (activation) activation.value = dateKey;
                    updateCalendar();
                });
            });
            calendar?.querySelector('[data-access-calendar-prev]')?.addEventListener('click', () => {
                const [year, month] = String(calendar.dataset.displayMonth || '').split('-').map(Number);
                const previous = new Date(Date.UTC(year, month - 2, 1));
                calendar.dataset.displayMonth = this.providerAccessDateKey(previous).slice(0, 7);
                this.renderProviderAccessCalendar(fieldset);
            });
            calendar?.querySelector('[data-access-calendar-next]')?.addEventListener('click', () => {
                const [year, month] = String(calendar.dataset.displayMonth || '').split('-').map(Number);
                const next = new Date(Date.UTC(year, month, 1));
                calendar.dataset.displayMonth = this.providerAccessDateKey(next).slice(0, 7);
                this.renderProviderAccessCalendar(fieldset);
            });
            calendar?.querySelector('[data-access-calendar-grid]')?.addEventListener('click', (event) => {
                const dayButton = event.target.closest?.('[data-access-calendar-day]');
                if (!dayButton) return;
                const start = this.providerAccessDateFromKey(activation?.value);
                const end = this.providerAccessDateFromKey(dayButton.dataset.accessCalendarDay);
                if (!start || !end) return;
                const exactDays = Math.round((end.getTime() - start.getTime()) / 86400000);
                if (exactDays < 1 || exactDays > 10000) return;
                termValue.value = String(exactDays);
                termUnit.value = 'DAY';
                syncSelect(termUnit);
                calendar.classList.remove('is-adjusted');
                this.renderProviderAccessCalendar(fieldset);
                requestAnimationFrame(() => calendar.classList.add('is-adjusted'));
                termValue.focus({ preventScroll: true });
            });
            fieldset.querySelector('[data-access-wizard-next]')?.addEventListener('click', () => {
                const steps = this.providerAccessWizardSteps(mode?.value || 'skip');
                const activeStep = steps[stepIndex];
                if (!validateStep(activeStep)) return;
                if (stepIndex === steps.length - 1) {
                    fieldset.dispatchEvent(new CustomEvent('norva:provider-access-complete', { bubbles: true, detail: { mode: mode?.value || 'skip' } }));
                    return;
                }
                showStep(stepIndex + 1);
            });
            fieldset.querySelector('[data-access-wizard-back]')?.addEventListener('click', () => {
                if (stepIndex === 0) {
                    fieldset.dispatchEvent(new CustomEvent('norva:provider-access-cancel', { bubbles: true }));
                    return;
                }
                showStep(stepIndex - 1);
            });
            updateReview();
            showStep(0, { focus: false });
            controllers.push({ fieldset, showStep, updateReview, get stepIndex() { return stepIndex; } });
        });
        return controllers.length === 1 ? controllers[0] : controllers;
    }

    readProviderAccessTerms(root = document) {
        const fieldset = root.querySelector?.('[data-provider-access-terms]');
        if (!fieldset) return null;
        const mode = fieldset.querySelector('[data-access-mode]')?.value || 'skip';
        if (mode === 'skip') return null;
        const remindersEnabled = fieldset.querySelector('[data-access-reminders]')?.checked === true;
        if (mode === 'duration') {
            const startedOn = String(fieldset.querySelector('[data-access-activation-on]')?.value || '');
            const termValue = Number(fieldset.querySelector('[data-access-term-value]')?.value);
            const termUnit = String(fieldset.querySelector('[data-access-term-unit]')?.value || '');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startedOn) || !this.providerAccessDateFromKey(startedOn)
                || !Number.isInteger(termValue) || termValue < 1 || termValue > 10000 || !['DAY', 'WEEK', 'MONTH', 'YEAR'].includes(termUnit)) {
                throw new Error('Enter a valid provider access duration.');
            }
            return { startedOn, expiresOn: null, termValue, termUnit, remindersEnabled };
        }
        const startedOn = String(fieldset.querySelector('[data-access-started-on]')?.value || '');
        const expiresOn = String(fieldset.querySelector('[data-access-expires-on]')?.value || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startedOn) || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || expiresOn < startedOn) {
            throw new Error('Enter a valid provider access start and end date.');
        }
        return { startedOn, expiresOn, termValue: null, termUnit: null, remindersEnabled };
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
        const accessFields = type === 'xtream' && !isExisting
            ? this.getProviderAccessTermsFields({ prefix: 'source-access-onboarding', onboarding: true })
            : '';
        const introField = `
      <p class="source-form-intro">${this.escapeHtml(intros[type] || 'Connect a TV service to Norva.')}</p>
    `;
        const nameField = `
      <div class="form-group">
        <label for="source-name">Service name <span class="label-optional">(optional)</span></label>
        <input type="text" id="source-name" name="provider-display-name" class="form-input" placeholder="Family TV" value="${this.escapeHtml(source.name || '')}" autocomplete="off" autocapitalize="words" spellcheck="false" data-1p-ignore="true" data-lpignore="true" data-form-type="other">
      </div>
    `;

        const urlField = `
      <div class="form-group">
        <label for="source-url">${type === 'xtream' ? 'Provider URL or complete Xtream link' : type === 'epg' ? 'TV guide URL' : 'Playlist URL'}</label>
        <input type="text" id="source-url" name="provider-server-url" class="form-input"
               placeholder="${type === 'xtream' ? 'https://provider.com/get.php?username=...&password=...' : 'https://example.com/playlist.m3u'}"
               value="${this.escapeHtml(urlValue)}" autocomplete="off" autocapitalize="none" spellcheck="false">
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
        ${accessFields}
        <details class="source-advanced-login" id="source-advanced-login"${advancedOpen}>
          <summary>Enter server login manually</summary>
          <div class="form-group">
          <label for="source-username">Username</label>
          <input type="text" id="source-username" name="provider-login" class="form-input" value="${this.escapeHtml(source.username || '')}" autocomplete="off" autocapitalize="none" spellcheck="false" data-1p-ignore="true" data-lpignore="true" data-form-type="other">
          </div>
          <div class="form-group">
          <label for="source-password">Password</label>
          <input type="password" id="source-password" name="provider-secret" class="form-input"
                 placeholder="${isExisting ? 'Password saved - leave blank to keep it' : ''}"
                 value="${source.password && !source.password.includes('•') ? this.escapeHtml(source.password) : ''}" autocomplete="new-password" data-1p-ignore="true" data-lpignore="true" data-form-type="other">
            ${isExisting ? '<p class="hint">Leave this empty to keep the saved password. Type a new password only when repairing or replacing the login.</p>' : ''}
          </div>
        </details>
      `;
        }

        return introField + savedConnectionCard + urlField + nameField;
    }

    bindSourceForm(type) {
        const accessWizard = this.bindProviderAccessTerms(document.getElementById('modal') || document);
        if (type !== 'xtream') return accessWizard;
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
        return accessWizard;
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

        const queryUsername = url.searchParams.get('username') || url.searchParams.get('user') || '';
        const queryPassword = url.searchParams.get('password') || url.searchParams.get('pass') || '';
        if (this.looksLikePlaylistLink(value) && !queryUsername && !queryPassword) {
            return null;
        }

        const knownEndpoints = new Set(['get.php', 'player_api.php', 'xmltv.php', 'panel_api.php']);
        const pathParts = url.pathname.split('/').filter(Boolean);
        const lowerParts = pathParts.map(part => part.toLowerCase());
        const endpointIndex = lowerParts.findIndex(part => knownEndpoints.has(part));
        const streamIndex = lowerParts.findIndex(part => ['live', 'movie', 'series'].includes(part));
        let username = queryUsername;
        let password = queryPassword;
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

    looksLikePlaylistLink(raw) {
        const value = String(raw || '').trim();
        if (!value) return false;
        return /\.m3u8?(?:[?#]|$)/i.test(value) ||
            /[?&](?:type|output|format)=m3u(?:_plus)?(?:&|$)/i.test(value);
    }

    buildSourceConnection(input = {}) {
        const existing = input.existing === true;
        const requestedType = String(input.type || 'xtream').toLowerCase();
        const rawUrl = String(input.url || '').trim();
        let name = String(input.name || '').trim();
        let url = rawUrl;
        let username = String(input.username || '').trim() || null;
        let password = String(input.password || '').trim() || null;
        const parsed = ['auto', 'xtream'].includes(requestedType) ? this.parseXtreamLink(rawUrl) : null;

        if (parsed) {
            url = parsed.serverUrl || rawUrl;
            username = username || parsed.username || null;
            password = password || parsed.password || null;
        }

        const type = requestedType === 'auto'
            ? (this.looksLikePlaylistLink(rawUrl) && !username && !password ? 'm3u' : 'xtream')
            : requestedType;

        if (!url && !existing) {
            throw new Error('Provider URL is required.');
        }

        if (!name) {
            const hostName = parsed?.host || this.hostFromUrl(rawUrl || url);
            const fallbackName = type === 'm3u' ? 'Playlist' : type === 'epg' ? 'TV guide' : 'TV service';
            name = hostName ? hostName.replace(/^www\./i, '') : fallbackName;
        }

        let credentialsProvided = !existing;
        if (type === 'xtream') {
            if (!existing && (!url || !username || !password)) {
                throw new Error('Provider URL, username and password are required.');
            }
            if (existing) {
                const credentialUpdateRequested = Boolean(username || password);
                if (credentialUpdateRequested && (!url || !username || !password)) {
                    throw new Error('Enter the complete server URL, username and password to replace the saved login.');
                }
                credentialsProvided = Boolean(credentialUpdateRequested && url && username && password);
            }
        } else if (existing) {
            // Stored M3U/EPG URLs stay private. The edit form receives only a
            // host hint, so a metadata-only save must not overwrite the secret
            // resource URL. A new absolute URL is an explicit replacement.
            credentialsProvided = /^https?:\/\//i.test(rawUrl);
        }

        return {
            type,
            name,
            url: type === 'm3u' ? rawUrl : url,
            username,
            password,
            credentialsProvided
        };
    }

    async confirmLargePlaylistIfNeeded(connection = {}) {
        if (connection.type !== 'm3u') return true;
        try {
            const estimate = await API.sources.estimateByUrl(connection.url, connection.type);
            if (!estimate?.needsWarning) return true;
            return this.showWarningModal({
                title: 'Large playlist',
                message: `This playlist contains <strong>${Number(estimate.count || 0).toLocaleString()}</strong> channels.`,
                details: 'Syncing may take several minutes and app performance may be impacted with large playlists.<br><br>Consider using a filtered M3U from your provider to include only channels you actually watch.',
                proceedText: 'Proceed anyway',
                cancelText: 'Cancel'
            });
        } catch (_) {
            console.warn('[SourceManager] Playlist size could not be checked.');
            return true;
        }
    }

    readSourceForm(type, { existing = false } = {}) {
        return this.buildSourceConnection({
            type,
            existing,
            name: document.getElementById('source-name')?.value || '',
            url: document.getElementById('source-url')?.value || '',
            username: document.getElementById('source-username')?.value || '',
            password: document.getElementById('source-password')?.value || ''
        });
    }

    sourceFormErrorMessage(error) {
        const message = String(error?.message || '');
        const allowed = new Set([
            'Provider URL is required.',
            'Enter the complete server URL, username and password to replace the saved login.',
            'Provider URL, username and password are required.'
        ]);
        return allowed.has(message)
            ? message
            : 'Check the service address and credentials, then try again.';
    }

    sourceConnectionTestMessage(value) {
        const payload = value?.payload || value || {};
        const code = String(payload.code || value?.code || '').trim().toUpperCase();
        const status = Number(payload.status ?? payload.upstreamStatus ?? value?.status ?? value?.upstreamStatus);
        if (code === 'PROVIDER_BUSY' || code === 'PROVIDER_ACCOUNT_BUSY' || status === 458) {
            return 'This TV service is busy. Wait a few seconds, then try again.';
        }
        if (code === 'PROVIDER_CONNECT_TIMEOUT' || code === 'PROVIDER_RESPONSE_TIMEOUT' || status === 504) {
            return 'The provider did not respond before the connection timed out.';
        }
        if (code === 'PROVIDER_DNS_FAILURE') return 'Norva cannot resolve the provider address.';
        if (code === 'PROVIDER_TLS_FAILURE') return 'Norva could not establish a secure connection to the provider.';
        if (code === 'PROVIDER_CONNECTION_RESET') return 'The connection to the provider was interrupted.';
        if (code === 'PROVIDER_NETWORK_UNREACHABLE') return 'The network route to the provider is unavailable.';
        if (status === 401 || status === 403) return 'The provider refused the saved username or password.';
        return 'Norva cannot reach the provider right now.';
    }

    sourceSyncErrorMessage(value, { hard = false } = {}) {
        if (this.isInvalidDeviceTokenError(value)) {
            return 'This device session expired. Sign in or pair this device again.';
        }

        const payload = value?.payload || value || {};
        const code = String(
            payload.error_code || payload.errorCode || payload.code || value?.code || ''
        ).trim().toUpperCase();
        if (code === 'PROVIDER_CREDENTIALS_REJECTED') {
            return this.providerAccessUiEnabled()
                ? 'The provider refused the saved username or password. Open Manage provider access to update it.'
                : 'The provider refused the saved username or password. Secure login repair is not available for this account yet.';
        }
        if (code === 'PROVIDER_ENDPOINT_NOT_FOUND') {
            return this.providerAccessUiEnabled()
                ? 'The provider address or account endpoint is no longer available. Open Manage provider access to review it.'
                : 'The provider address or account endpoint is no longer available. Secure login repair is not available for this account yet.';
        }
        if (code === 'PROVIDER_ACCESS_EXPIRED') {
            return 'The provider reports that this access is inactive. Review the access dates before syncing again.';
        }
        if (code === 'PROVIDER_BUSY') {
            return 'This TV service is busy. Wait a few seconds, then try again.';
        }
        if (code === 'PROVIDER_TEMPORARILY_UNAVAILABLE') {
            return 'This TV service is temporarily unavailable. Your existing catalog remains available; try again later.';
        }
        return `${hard ? 'Catalog rebuild' : 'Sync'} could not finish. Try again.`;
    }

    rebuildConfirmationCopy() {
        if (window.API?.isCloudMode?.() === true) {
            return {
                title: 'Rebuild catalog?',
                message: 'Norva will rescan the complete provider catalog. Your current catalog stays available while the rebuild runs.',
                details: 'Norva clears only saved sync progress, then rediscovers and updates channels, movies, series and TV guide data in place.<br><br>Preserved: source settings, current catalog, favorites, profiles and watch history.',
                proceedText: 'Rebuild catalog',
                cancelText: 'Cancel'
            };
        }
        return {
            title: 'Rebuild local catalog?',
            message: 'This will delete the current local catalog for this source, then rebuild it from the playlist or provider.',
            details: 'Removed locally: categories, channels, movies, series, TV guide data, sync status and source cache.<br><br>Preserved: source settings, favorites, profiles and watch history.',
            proceedText: 'Rebuild catalog',
            cancelText: 'Cancel'
        };
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
        // Clamp monotonically to hide small backward jitter from re-walks that
        // re-project already-built rows. BUT a large drop while still importing is a
        // genuine finalize regression/restart (a fresh isolate resuming from a lower
        // cursor) — let the bar correct downward then, instead of freezing at a stale
        // "almost done" that never completes.
        const regressed = !terminal.has(status) && (previousPercent - rawPercent) > 15;
        const visiblePercent = regressed ? rawPercent : Math.max(previousPercent, rawPercent);
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
        const sharedPolicy = window.NorvaSourceHealth?.catalogSourcePolicy?.(source);
        if (sharedPolicy) {
            return {
                phase: sharedPolicy.phase,
                counts,
                progress,
                backgrounding: sharedPolicy.backgrounding === true,
                attentionState: sharedPolicy.state
            };
        }

        const failedStates = new Set(['error', 'failed', 'auth_failed', 'expired', 'unreachable', 'revoked']);
        const readyStates = new Set(['ready', 'success', 'complete', 'completed']);
        const syncingStates = new Set(['syncing', 'checking', 'pending', 'connecting', 'discovering', 'discovered', 'importing', 'materializing', 'building_titles', 'building_live_channels', 'building_live_variants', 'finalizing']);

        if (failedStates.has(status) || failedStates.has(progressStatus)) {
            const explicit = ['auth_failed', 'expired', 'unreachable', 'revoked'];
            const attentionState = explicit.includes(progressStatus)
                ? progressStatus
                : explicit.includes(status)
                    ? status
                    : 'degraded';
            return { phase: 'error', counts, progress, attentionState };
        }
        if (readyStates.has(status) || readyStates.has(progressStatus)) return { phase: 'ready', counts, progress, attentionState: 'ready' };
        // Usable threshold reached (Live + first block of movies/series): the catalogue is
        // navigable now and the rest is a background top-up. Treat as ready for the modal /
        // onboarding gate, but flag `backgrounding` so Settings can show a quiet
        // "still adding the rest of your library" note while the long-tail finishes.
        if (progress.usable === true && !readyStates.has(status)) return { phase: 'ready', counts, progress, backgrounding: true, attentionState: 'ready' };
        if (syncingStates.has(status) || syncingStates.has(progressStatus)) return { phase: 'syncing', counts, progress, attentionState: 'syncing' };
        return { phase: 'syncing', counts, progress, attentionState: 'syncing' };
    }

    catalogErrorDetails(source = {}, attentionState = '') {
        const state = source.revoked === true
            ? 'revoked'
            : String(attentionState || this.sourceSyncState(source).attentionState || 'degraded').toLowerCase();
        const details = {
            auth_failed: {
                phaseLabel: 'Login required',
                title: 'Update your provider login',
                message: 'The provider refused the saved username or password. Update the login, then Norva can resume the import.',
                actionLabel: 'Update login',
                action: 'edit'
            },
            expired: {
                phaseLabel: 'Provider access expired',
                title: 'Review your provider access',
                message: 'The provider reports an inactive or expired account. Renew it with the provider, then check the service again.',
                actionLabel: 'Review service',
                action: 'edit'
            },
            unreachable: {
                phaseLabel: 'Provider unavailable',
                title: 'Your provider is temporarily unavailable',
                message: 'Norva cannot reach the provider right now. Your details were not changed; wait a moment and check again.',
                actionLabel: 'Check again',
                action: 'retry'
            },
            revoked: {
                phaseLabel: 'Service disconnected',
                title: 'This TV service is disconnected',
                message: 'Open TV Service settings to review or reconnect this source.',
                actionLabel: 'Open settings',
                action: 'settings'
            },
            degraded: {
                phaseLabel: 'Needs attention',
                title: 'TV service needs attention',
                message: 'Norva could not finish this import. Check the service again; if it still fails, review its settings.',
                actionLabel: 'Check again',
                action: 'retry'
            }
        };
        return details[state] || details.degraded;
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

    catalogMilestones(progress = {}, counts = {}, options = {}) {
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
        const milestones = [
            step('connect', 'Connecting to TV service', 0, 'Secure login check'),
            step('channels', 'Channels found', counts.live, 'Live TV catalog'),
            step('movies', 'Movies found', counts.movies, 'Films catalog'),
            step('series', 'Series found', counts.series, 'Series catalog'),
            step('categories', 'Categories', counts.categories, 'Navigation groups'),
            step('import', 'Import catalog', counts.total, 'Saving items to Norva Cloud'),
            step('finalize', 'Finalize Norva', 0, 'Preparing Home, Live TV and details')
        ];
        if (options.phase === 'error' && !milestones.some(item => item.status === 'error')) {
            const running = milestones.find(item => ['running', 'in_progress'].includes(item.status));
            const connectionFailure = ['auth_failed', 'expired', 'unreachable', 'revoked'].includes(options.attentionState);
            const failed = running || milestones.find(item => item.key === (connectionFailure ? 'connect' : 'import'));
            if (failed) failed.status = 'error';
        }
        return milestones;
    }

    renderCatalogMilestone(step) {
        const safeStatus = ['pending', 'running', 'done', 'error', 'skipped'].includes(step.status) ? step.status : 'pending';
        const count = step.count > 0 ? `<strong>${this.escapeHtml(step.count.toLocaleString())}</strong>` : '';
        // Discovery steps (channels/movies/series/categories) report "done" the
        // moment the provider COUNT is known — long before those items are
        // materialised and browsable. Render their done-state as "Found" so the
        // timeline never implies the content is ready to watch yet; only the
        // import/finalize steps carry a true "Done".
        const isDiscovery = ['channels', 'movies', 'series', 'categories'].includes(step.key);
        const statusLabel = (isDiscovery && safeStatus === 'done')
            ? 'Found'
            : ({
                pending: 'Waiting',
                running: 'In progress',
                done: 'Done',
                error: 'Needs attention',
                skipped: 'Skipped'
            }[safeStatus] || 'Waiting');
        return `
          <li class="source-sync-milestone source-sync-milestone-${this.escapeHtml(safeStatus)}">
            <span class="source-sync-dot" aria-hidden="true"></span>
            <span class="source-sync-copy">
              <span class="source-sync-line">
                <span>${this.escapeHtml(step.label)}</span>
                ${count}
              </span>
              <small>${this.escapeHtml(step.detail)} — ${this.escapeHtml(statusLabel)}</small>
            </span>
          </li>
        `;
    }

    // Copy du héros, partagée entre le rendu complet et le patch en place. À 99 %
    // la phase "finalizing" (heal des variantes + bascule ready) peut durer — sans
    // copy dédiée, le chiffre figé à 99 se lit comme un plantage.
    catalogSyncingCopy(progress = {}, percent = 0, phase = 'syncing', source = {}) {
        if (phase === 'ready') return 'Your catalog is ready.';
        if (phase === 'error') return this.catalogErrorDetails(source).message;
        const stage = String(progress.stage || '').toLowerCase();
        if (stage === 'finalizing' || percent >= 99) {
            return 'Finishing touches — Norva is unlocking your catalog now.';
        }
        return 'Norva is connecting, counting your catalog and preparing it for Home, Live TV, Movies and Series.';
    }

    renderCatalogPreparation(source = {}, type = 'xtream') {
        const { phase, counts, progress, attentionState } = this.sourceSyncState(source);
        const sourceName = source.name || 'TV service';
        const percent = Math.max(0, Math.min(100, Number(progress.percent ?? (phase === 'ready' ? 100 : 0)) || 0));
        const determinate = percent > 0 || phase === 'ready';
        const errorDetails = this.catalogErrorDetails(source, attentionState);
        const statusText = {
            syncing: this.catalogSyncingCopy(progress, percent, 'syncing', source),
            ready: 'Your catalog is ready.',
            error: errorDetails.message
        };
        const phaseLabel = phase === 'ready' ? 'Ready' : phase === 'error' ? errorDetails.phaseLabel : 'Importing';
        const progressBucket = phase === 'syncing' && determinate ? Math.floor(percent / 10) : -1;
        const progressAnnouncement = `${sourceName}. ${phaseLabel}. ${statusText[phase] || statusText.syncing}${phase === 'syncing' && determinate ? ` ${Math.round(percent)}% complete.` : ''}`;
        const milestones = this.catalogMilestones(progress, counts, { phase, attentionState }).map(step => this.renderCatalogMilestone(step)).join('');
        const countFallback = phase === 'error' ? '—' : phase === 'ready' ? '0' : 'Scanning';
        const noteIcon = window.Icons?.info || '';

        return `
      <div class="source-sync-step source-sync-${this.escapeHtml(phase)}" data-phase="${this.escapeHtml(phase)}" data-attention-state="${this.escapeHtml(attentionState || '')}">
        <p class="source-sync-announcement" role="${phase === 'error' ? 'alert' : 'status'}" aria-live="${phase === 'error' ? 'assertive' : 'polite'}" aria-atomic="true" data-progress-bucket="${progressBucket}">${this.escapeHtml(progressAnnouncement)}</p>
        <div class="source-sync-hero">
          <span class="source-sync-pill">${this.escapeHtml(phaseLabel)}</span>
          <h3>${this.escapeHtml(sourceName)}</h3>
          <p>${this.escapeHtml(statusText[phase] || statusText.syncing)}</p>
        </div>
        <div class="source-sync-grid">
          <div class="source-sync-card">
            <span>Live TV</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.live, countFallback))}</strong>
            <small>channels found</small>
          </div>
          <div class="source-sync-card">
            <span>Movies</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.movies, countFallback))}</strong>
            <small>films found</small>
          </div>
          <div class="source-sync-card">
            <span>Series</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.series, countFallback))}</strong>
            <small>series found</small>
          </div>
          <div class="source-sync-card">
            <span>Categories</span>
            <strong>${this.escapeHtml(this.formatCatalogCount(counts.categories, countFallback))}</strong>
            <small>groups found</small>
          </div>
        </div>
        ${phase === 'syncing' ? `
          <p class="hint source-sync-found-note">These are titles detected from your provider. They become watchable as Norva finishes preparing them — you can keep browsing while this runs.</p>
        ` : ''}
        <div class="source-sync-progress-wrap">
          <div class="source-sync-progress ${determinate ? 'is-determinate' : ''}" style="--source-sync-percent: ${this.escapeHtml(String(percent))}%;" role="progressbar" aria-label="Catalog import progress" aria-valuemin="0" aria-valuemax="100"${determinate ? ` aria-valuenow="${Math.round(percent)}"` : ''}>
            <span></span>
          </div>
          ${determinate ? `<small>${this.escapeHtml(String(Math.round(percent)))}%</small>` : ''}
        </div>
        <ol class="source-sync-timeline">
          ${milestones}
        </ol>
        ${phase === 'syncing' ? `
          <p class="hint source-sync-notify-note"><span class="source-sync-note-icon" aria-hidden="true">${noteIcon}</span><span><strong>You can close the app</strong> — we'll email you the moment your catalog is ready, on every device. The mobile app will notify you too. Norva keeps preparing it in the background.</span></p>
        ` : ''}
        ${phase === 'error' ? `
          <div class="source-sync-error-message"><strong>${this.escapeHtml(errorDetails.title)}</strong><span>${this.escapeHtml(statusText.error)}</span></div>
        ` : ''}
        ${counts.syncedAt && phase === 'ready' ? `
          <p class="hint">Last import: ${this.escapeHtml(new Date(counts.syncedAt).toLocaleString())}</p>
        ` : ''}
      </div>
    `;
    }

    // Fluidité (audit 18/07) : sur un tick de poll de MÊME phase, patcher le DOM en
    // place au lieu de reconstruire innerHTML. C'est ce qui permet à la transition
    // CSS de la barre de jouer — un élément recréé naît directement à sa nouvelle
    // largeur, sans animation, et chaque palier serveur devenait une téléportation.
    // Retourne false quand un rebuild complet est requis (premier rendu, changement
    // de phase syncing→ready/error).
    patchCatalogPreparation(root, source = {}, type = 'xtream') {
        const step = root && root.querySelector ? root.querySelector('.source-sync-step') : null;
        if (!step) return false;
        const { phase, counts, progress, attentionState } = this.sourceSyncState(source);
        if ((step.dataset.phase || '') !== phase) return false;
        if ((step.dataset.attentionState || '') !== String(attentionState || '')) return false;

        const percent = Math.max(0, Math.min(100, Number(progress.percent ?? (phase === 'ready' ? 100 : 0)) || 0));
        this.animateCatalogBar(step, percent, phase === 'ready');

        // Compteurs — ordre fixe du markup : Live, Movies, Series, Categories.
        const cards = step.querySelectorAll('.source-sync-card strong');
        const values = [counts.live, counts.movies, counts.series, counts.categories];
        cards.forEach((el, i) => {
            const next = this.formatCatalogCount(values[i]);
            if (el.textContent !== next) el.textContent = next;
        });

        // Timeline des milestones (non animée — remplacement direct suffisant).
        const timeline = step.querySelector('.source-sync-timeline');
        if (timeline) {
            timeline.innerHTML = this.catalogMilestones(progress, counts, { phase, attentionState }).map(s => this.renderCatalogMilestone(s)).join('');
        }

        // Copy du héros (bascule « Finishing touches » quand finalizing/99 %).
        const hero = step.querySelector('.source-sync-hero p');
        let copyChanged = false;
        let copy = this.catalogSyncingCopy(progress, percent, phase, source);
        if (hero) {
            copyChanged = hero.textContent !== copy;
            if (copyChanged) hero.textContent = copy;
        }

        // Announce meaningful server progress (at most once per 10-point bucket),
        // copy changes such as "Finishing touches", and phase rebuilds. The visual
        // progress bar remains smooth without flooding TalkBack on every animation tick.
        const announcement = step.querySelector('.source-sync-announcement');
        if (announcement) {
            const determinate = percent > 0 || phase === 'ready';
            const progressBucket = phase === 'syncing' && determinate ? Math.floor(percent / 10) : -1;
            if (copyChanged || Number(announcement.dataset.progressBucket) !== progressBucket) {
                const sourceName = source.name || 'TV service';
                const phaseLabel = phase === 'ready' ? 'Ready' : phase === 'error' ? this.catalogErrorDetails(source, attentionState).phaseLabel : 'Importing';
                announcement.dataset.progressBucket = String(progressBucket);
                announcement.textContent = `${sourceName}. ${phaseLabel}. ${copy}${phase === 'syncing' && determinate ? ` ${Math.round(percent)}% complete.` : ''}`;
            }
        }
        return true;
    }

    // Public preparation facade shared by Home and the Settings modal. It keeps
    // source/status normalization, progress classification, rendering and the
    // patch-first update rule local to SourceManager without introducing another
    // state machine. Consumers receive one immutable snapshot for a source tick.
    catalogPreparationView(source = {}, type = 'xtream') {
        const sourceView = this.sourceWithStatus(source || {});
        const { phase, counts, progress } = this.sourceSyncState(sourceView);
        const rawSourceId = sourceView.id || sourceView.cloudId || sourceView.cloud_id || sourceView.source_id || null;
        return {
            source: sourceView,
            sourceId: rawSourceId === null || rawSourceId === undefined ? null : String(rawSourceId),
            type,
            phase,
            counts,
            progress,
            render: () => this.renderCatalogPreparation(sourceView, type),
            patch: (root) => this.patchCatalogPreparation(root, sourceView, type),
            formatCount: (value, fallback) => this.formatCatalogCount(value, fallback)
        };
    }

    // Start a bounded recovery session without leaking catalogPreparationToken to
    // Home. The existing recovery implementation remains the single owner of the
    // finalize loop; this facade only owns cancellation and token lifetime.
    startCatalogPreparationRecovery(source = {}, { onProgress = () => {} } = {}) {
        const api = window.API || (typeof API !== 'undefined' ? API : null);
        const sourceView = this.sourceWithStatus(source || {});
        const rawSourceId = sourceView.id || sourceView.cloudId || sourceView.cloud_id || sourceView.source_id || null;
        if (rawSourceId === null || rawSourceId === undefined || !api?.sources?.finalize || !api?.sources?.getById) {
            return null;
        }
        if (!this.shouldRecoverCatalogFinalization(sourceView)) return null;

        const sourceId = String(rawSourceId);
        const token = Symbol('catalog-preparation-recovery');
        let active = true;
        this.catalogPreparationToken = token;

        const session = {
            sourceId,
            isActive: () => active && this.catalogPreparationToken === token,
            cancel: () => {
                if (!active) return;
                active = false;
                if (this.catalogPreparationToken === token) this.catalogPreparationToken = null;
            },
            promise: null
        };
        const render = (latestSource) => {
            if (!session.isActive()) return;
            onProgress(this.sourceWithStatus(latestSource || sourceView));
        };
        session.promise = Promise.resolve()
            .then(() => this.recoverCatalogFinalization(sourceId, token, render))
            .finally(() => session.cancel());
        return session;
    }

    // Largeur : la transition CSS anime le remplissage vers la cible. Label % :
    // compté en douceur vers la cible sur la même durée — le chiffre avance
    // pourcent par pourcent au lieu de sauter de palier en palier.
    animateCatalogBar(step, targetPercent, ready = false) {
        const bar = step.querySelector('.source-sync-progress');
        const wrap = step.querySelector('.source-sync-progress-wrap');
        if (!bar) return;
        const target = Math.max(0, Math.min(100, Number(targetPercent) || 0));
        const determinate = target > 0 || ready;
        bar.classList.toggle('is-determinate', determinate);
        bar.style.setProperty('--source-sync-percent', `${target}%`);
        if (determinate) bar.setAttribute('aria-valuenow', String(Math.round(target)));
        else bar.removeAttribute('aria-valuenow');

        let label = wrap ? wrap.querySelector('small') : null;
        if (determinate && !label && wrap) {
            label = document.createElement('small');
            wrap.appendChild(label);
        }
        if (!label) return;

        if (this._catalogBarTimer) { clearInterval(this._catalogBarTimer); this._catalogBarTimer = null; }
        const shown = Number(String(label.textContent || '').replace('%', ''));
        const start = Number.isFinite(shown) ? Math.max(0, Math.min(100, shown)) : target;
        const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced || Math.abs(target - start) < 1) {
            label.textContent = `${Math.round(target)}%`;
            return;
        }
        const durationMs = 2400; // même durée que la transition CSS de la largeur
        const startedAt = Date.now();
        this._catalogBarTimer = setInterval(() => {
            const t = Math.min(1, (Date.now() - startedAt) / durationMs);
            const eased = 1 - Math.pow(1 - t, 3);
            label.textContent = `${Math.round(start + (target - start) * eased)}%`;
            if (t >= 1 || !label.isConnected) {
                clearInterval(this._catalogBarTimer);
                this._catalogBarTimer = null;
            }
        }, 120);
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

        // Resume from the server's persisted finalize cursor so we cooperate with the
        // hands-off background driver (and its keyset titles walk) instead of restarting
        // the whole finalize at phase=live/offset=0 — which would re-materialise the live
        // catalogue and stamp the progress bar back down to its early-phase percent while
        // the background chain is already deep into building titles.
        const initial = await refreshAndRender();
        const cursor = (initial?.configHint || initial?.config_hint || {}).finalizeCursor || {};
        let phase = typeof cursor.phase === 'string' && cursor.phase ? cursor.phase : 'live';
        let offset = Number(cursor.offset ?? 0) || 0;
        let afterId = typeof cursor.afterId === 'string' ? cursor.afterId : '';
        let safety = 0;
        while (this.catalogPreparationToken === token && phase && phase !== 'complete' && safety < 320) {
            safety += 1;
            const response = await finalize({
                phase,
                offset,
                afterId,
                limit: initialBatchLimit
            });
            await refreshAndRender();
            const nextPhase = response?.nextPhase || 'complete';
            const nextOffset = Number(response?.nextOffset ?? 0) || 0;
            const nextAfterId = typeof response?.nextAfterId === 'string' ? response.nextAfterId : afterId;
            // Stall guard: stop only if nothing advanced this batch (same phase, offset not
            // past, keyset cursor unmoved, not flagged done) — otherwise keep walking.
            if (nextPhase === phase && nextOffset <= offset && nextAfterId === afterId && !response?.done) break;
            phase = nextPhase;
            offset = nextOffset;
            afterId = nextAfterId;
        }

        if (this.catalogPreparationToken !== token) return;
        if (phase === 'complete') {
            // The titles walk reported done (nextPhase became 'complete'), so run
            // the complete phase: it heals variants and marks the source ready.
            // This is the ONLY path that declares the catalog finished.
            await API.sources.finalize(sourceId, { phase: 'complete' });
            await refreshAndRender();
        } else {
            // We exited on a stall (cursor unmoved) or the safety cap, with the
            // walk NOT done. Do NOT force phase:'complete' — that would stamp a
            // partial catalog as ready/100%. Hand back to the background finalize
            // driver + the 1-min watchdog, which own the persisted cursor and
            // resume from exactly where we stopped. Just reflect the real state.
            await refreshAndRender();
        }
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
        let closing = false;
        let current = initialSource;
        const modalHygieneAvailable = Boolean(window.NorvaModal?.installHygiene);
        const previouslyFocused = document.activeElement;

        const closeToSettings = async () => {
            if (closing) return;
            closing = true;
            if (this.catalogPreparationToken === token) this.catalogPreparationToken = null;
            modal.classList.remove('active');
            if (!modalHygieneAvailable) {
                try { previouslyFocused?.focus?.({ preventScroll: true }); } catch (_) { /* noop */ }
            }
            try {
                await this.loadSources();
            } catch (_) {
                console.warn('[SourceManager] Sources could not be refreshed after closing catalog progress.');
            } finally {
                this.notifySourceHealthChanged();
            }
        };

        const startWatching = async () => {
            await closeToSettings();
            window.location.hash = '#home';
        };

        const openSourceSettings = async () => {
            await closeToSettings();
            window.app?.navigateTo?.('settings');
            setTimeout(() => window.app?.pages?.settings?.switchTab?.('sources'), 0);
        };

        const openSourceEditor = async () => {
            await closeToSettings();
            setTimeout(() => this.showEditModal(sourceId, type), 0);
        };

        const retrySource = async () => {
            if (!sourceId || !API.sources?.getById) {
                await openSourceSettings();
                return;
            }
            const retry = document.getElementById('catalog-error-action');
            if (retry) {
                retry.disabled = true;
                retry.setAttribute('aria-busy', 'true');
                retry.textContent = 'Checking…';
            }
            try {
                const latest = await API.sources.getById(sourceId) || current;
                await closeToSettings();
                setTimeout(() => this.showCatalogPreparation(latest, type), 0);
            } catch (_) {
                const retryMessage = 'Norva still cannot reach this service. Wait a moment or review it in TV Service settings.';
                const message = body.querySelector('.source-sync-error-message span');
                if (message) message.textContent = retryMessage;
                const announcement = body.querySelector('.source-sync-announcement');
                if (announcement) announcement.textContent = retryMessage;
                if (retry) {
                    retry.disabled = false;
                    retry.removeAttribute('aria-busy');
                    retry.textContent = 'Check again';
                    retry.focus({ preventScroll: true });
                }
            }
        };

        let lastFooterKind = null;
        const render = (source) => {
            current = source || current;
            const { phase, attentionState } = this.sourceSyncState(current);
            const errorDetails = this.catalogErrorDetails(current, attentionState);
            title.textContent = phase === 'ready' ? 'Catalog ready' : phase === 'error' ? errorDetails.title : 'Preparing your catalog';
            // Patch en place sur un tick de même phase (la barre garde son élément →
            // la transition CSS anime) ; rebuild complet uniquement sur transition.
            if (!this.patchCatalogPreparation(body, current, type)) {
                body.innerHTML = this.renderCatalogPreparation(current, type);
            }

            // Only rebuild the footer (and its focusable buttons) when the actionable
            // state actually changes. During a long import the phase stays "preparing"
            // for many poll ticks; rebuilding the footer every tick destroys the button
            // the TV remote is focused on, stranding D-pad focus mid-dialog. Same-kind
            // polls now leave the footer — and its focus — untouched, updating only the
            // progress bar above. On a real transition we rebuild and, if focus was in
            // the footer, hand it to the new primary button so the remote isn't stranded.
            const footerKind = phase === 'ready' ? 'ready' : phase === 'error' ? `error:${errorDetails.action}` : 'progress';
            if (footerKind === lastFooterKind) return;
            const restoreFocus = footer.contains(document.activeElement);
            lastFooterKind = footerKind;
            const focusIfNeeded = (id) => {
                if (!restoreFocus) return;
                try { document.getElementById(id)?.focus({ preventScroll: true }); } catch (_) { /* noop */ }
            };

            if (phase === 'ready') {
                footer.innerHTML = `
          <button class="btn btn-secondary" id="catalog-stay">Stay in Settings</button>
          <button class="btn btn-primary" id="catalog-start">Start Watching</button>
        `;
                document.getElementById('catalog-stay').onclick = closeToSettings;
                document.getElementById('catalog-start').onclick = startWatching;
                focusIfNeeded('catalog-start');
            } else if (phase === 'error') {
                footer.innerHTML = `
          <button class="btn btn-secondary" id="catalog-background">Close</button>
          <button class="btn btn-primary" id="catalog-error-action">${this.escapeHtml(errorDetails.actionLabel)}</button>
        `;
                document.getElementById('catalog-background').onclick = closeToSettings;
                const action = document.getElementById('catalog-error-action');
                action.onclick = errorDetails.action === 'edit'
                    ? openSourceEditor
                    : errorDetails.action === 'settings'
                        ? openSourceSettings
                        : retrySource;
                focusIfNeeded('catalog-error-action');
            } else {
                footer.innerHTML = `
          <button class="btn btn-secondary" id="catalog-background">Run in Background</button>
        `;
                document.getElementById('catalog-background').onclick = closeToSettings;
                focusIfNeeded('catalog-background');
            }
        };

        const closeButton = modal.querySelector('.modal-close');
        closeButton.onclick = closeToSettings;
        modal.classList.add('active');
        render(initialSource);
        if (modalHygieneAvailable) {
            NorvaModal.installHygiene(modal, {
                onClose: closeToSettings,
                initialFocus: closeButton
            });
        } else {
            try { (closeButton || modal).focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }

        if (!sourceId) return;

        let recoveryStarted = false;
        let attempt = 0;
        // Poll until a terminal state OR the modal is closed/backgrounded (the token
        // guard clears on close). Fast (2s) for the first ~3 min while the user is
        // likely watching, then slow to 15s so a long import (an 8K catalogue takes
        // hours) keeps a LIVE, updating bar instead of silently freezing at e.g. 92%
        // — a frozen bar reads as a crash. The slow endpoint is client-cached, so
        // long-lived polling is cheap, and the token guard stops it cleanly.
        while (this.catalogPreparationToken === token) {
            const { phase } = this.sourceSyncState(current);
            if (phase === 'ready' || phase === 'error') return;

            // Only co-pilot finalize when the background driver looks genuinely stalled
            // (>60s without a progress write). Co-piloting eagerly makes the client and
            // the server driver drive the SAME finalize batches at once, doubling the
            // heavy keep-best/mirror trigger load that the 300-row batch + throttle were
            // sized to avoid — a contributor to finalize saturating Postgres.
            if (!recoveryStarted && this.shouldRecoverCatalogFinalization(current, { requireStale: true }) && API.sources.finalize) {
                recoveryStarted = true;
                this.recoverCatalogFinalization(sourceId, token, (source) => {
                    current = source || current;
                    render(current);
                })
                    .catch(err => console.warn('[SourceManager] Catalog finalization recovery failed:', err));
            }

            attempt += 1;
            await new Promise(resolve => setTimeout(resolve, attempt <= 90 ? 2000 : 15000));
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
        let accessTerms = null;
        try {
            form = this.readSourceForm(type);
            if (type === 'xtream' && this.providerAccessUiEnabled()) {
                accessTerms = this.readProviderAccessTerms(document.getElementById('modal'));
            }
        } catch (err) {
            if (type === 'xtream') this.openAdvancedSourceLogin();
            const safeMessage = /^Enter a valid provider access/.test(String(err?.message || ''))
                ? err.message
                : this.sourceFormErrorMessage(err);
            NorvaModal.toast(safeMessage, 'error');
            return;
        }
        const { name, url, username, password } = form;

        try {
            if (!await this.confirmLargePlaylistIfNeeded(form)) return;

            const createdSource = await API.sources.create({ type, name, url, username, password });
            let accessSaveFailed = false;
            if (accessTerms) {
                const sourceId = createdSource.cloudId || createdSource.cloud_id || createdSource.id;
                const operationKey = this.providerAccessIdempotency(sourceId, 'onboarding-cycle');
                try {
                    await API.providerAccess.createCycle(sourceId, accessTerms, { idempotencyKey: operationKey });
                    this.clearProviderAccessIdempotency(sourceId, 'onboarding-cycle');
                } catch (error) {
                    accessSaveFailed = true;
                    console.warn('[SourceManager] Source created but Provider Access terms remain retryable:', error?.code || 'request_failed');
                }
            }
            await this.loadSources();
            this.notifySourceHealthChanged();
            try { window.app?.startImportWatcher?.(); } catch (_) { /* noop */ } // toast when this import finishes
            this.showCatalogPreparation(createdSource, type);
            if (accessSaveFailed) {
                NorvaModal.toast('The service was added, but its access period was not saved. Add it from Provider access in Settings.', 'error');
            }

            // Refresh the watch surfaces in the background. The onboarding progress
            // step must appear immediately, even when a provider catalog is large.
            if (window.app?.channelList) {
                window.app.channelList.loadSources()
                    .then(() => window.app.channelList.loadChannels())
                    .catch(err => console.warn('[SourceManager] Background channel refresh failed:', err));
            }
        } catch (err) {
            console.warn('[SourceManager] Source creation failed:', err);
            NorvaModal.toast('Could not add this source. Check the details and try again.', 'error');
        }
    }

    providerAccessIdempotency(sourceId, action) {
        const operation = `${sourceId}:${action}`;
        if (!this.providerAccessOperations.has(operation)) {
            const random = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            this.providerAccessOperations.set(operation, `ui-${action}-${random}`.slice(0, 180));
        }
        return this.providerAccessOperations.get(operation);
    }

    clearProviderAccessIdempotency(sourceId, action) {
        this.providerAccessOperations.delete(`${sourceId}:${action}`);
    }

    async releasePlaybackForSourceChange() {
        try {
            const watch = window.app?.pages?.watch || window.app?.watchPage;
            if (watch && typeof watch.stop === 'function') {
                await watch.stop();
            }
        } catch (_) {}
        try {
            const live = window.app?.pages?.live;
            if (live && typeof live.stop === 'function') {
                await live.stop();
            }
        } catch (_) {}
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
            NorvaModal.toast(this.sourceFormErrorMessage(err), 'error');
            return;
        }
        const { name, url, username, password } = form;

        try {
            if (type === 'xtream' && form.credentialsProvided && !this.providerAccessUiEnabled()) {
                NorvaModal.toast('Secure login replacement is not available yet. Your saved login was not changed.', 'error');
                return;
            }

            // Any accepted source mutation must first release the provider
            // playback lane. Candidate creation is preceded by the display-name
            // mutation below, so it follows the same mono-account handoff rule.
            await this.releasePlaybackForSourceChange();

            if (type === 'xtream' && form.credentialsProvided && this.providerAccessUiEnabled()) {
                const source = await API.sources.getById(id);
                const sourceRevision = Number(source?.config_revision ?? source?.configRevision);
                if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
                    throw new Error('SOURCE_REVISION_UNAVAILABLE');
                }
                // Display-name edits remain the only legacy source PATCH. The
                // credentials enter the immutable candidate machine instead.
                await API.sources.update(id, { displayName: name });
                const operationKey = this.providerAccessIdempotency(id, 'credential-candidate');
                const candidate = await API.providerAccess.createCandidate(id, {
                    serverUrl: url,
                    username,
                    password
                }, {
                    idempotencyKey: operationKey,
                    ifMatch: `"source-rev-${sourceRevision}"`
                });
                this.clearProviderAccessIdempotency(id, 'credential-candidate');
                document.getElementById('modal').classList.remove('active');
                await this.loadSources();
                this.notifySourceHealthChanged();
                this.showCredentialCandidate(id, candidate);
                return;
            }
            // Renaming or changing other Settings metadata never resubmits the
            // provider secret. Credential replacement is opt-in and requires a
            // complete set captured in this form submission.
            const data = { displayName: name };
            if (type !== 'xtream' && form.credentialsProvided) {
                data.type = type;
                data.url = url;
            }

            await API.sources.update(id, data);
            document.getElementById('modal').classList.remove('active');
            await this.loadSources();
            this.notifySourceHealthChanged();
        } catch (err) {
            console.warn('[SourceManager] Source update failed:', err);
            NorvaModal.toast('Could not update this source. Try again.', 'error');
        }
    }

    openProviderAccessModal(titleText, bodyHtml) {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');
        if (!modal || !title || !body || !footer) return null;
        this.providerAccessViewToken = (this.providerAccessViewToken || 0) + 1;
        const token = this.providerAccessViewToken;
        title.textContent = titleText;
        body.innerHTML = bodyHtml;
        modal.classList.remove('provider-access-wizard-modal');
        footer.hidden = false;
        footer.innerHTML = '<button class="btn btn-secondary" type="button" data-provider-close>Close</button>';
        const close = () => {
            if (this.providerAccessViewToken === token) this.providerAccessViewToken += 1;
            modal.classList.remove('active');
            modal.classList.remove('provider-access-wizard-modal');
            footer.hidden = false;
        };
        modal.querySelector('.modal-close').onclick = close;
        footer.querySelector('[data-provider-close]').onclick = close;
        modal.classList.add('active');
        if (window.NorvaModal?.installHygiene) {
            NorvaModal.installHygiene(modal, { onClose: close, initialFocus: body.querySelector('button,select,input') || footer.querySelector('button') });
        }
        return { modal, body, footer, token, close };
    }

    providerAccessErrorMessage(error) {
        const code = String(error?.code || error?.payload?.code || '').toUpperCase();
        const messages = {
            FEATURE_DISABLED: 'Provider access management is not available yet.',
            REVISION_MISMATCH: 'These details changed on another device. Reload and try again.',
            SOURCE_REVISION_MISMATCH: 'The service changed on another device. Reload and try again.',
            TRANSITION_REVISION_MISMATCH: 'This operation already moved forward. Reload its status.',
            PROVIDER_CHECK_TEMPORARY_FAILURE: 'The provider could not be checked right now. Your current catalog was not changed.',
            CANDIDATE_CREDENTIALS_REJECTED: 'The provider rejected these login details.',
            DIFFERENT_CATALOG_REQUIRES_REPLACEMENT: 'These details belong to a different catalog. Use the replacement path.',
            INVALID_TRANSITION_STATE: 'This operation is no longer available in its current state.'
        };
        return messages[code] || 'Norva could not complete this provider access operation safely. Try again.';
    }

    showProviderAccessSavedReceipt(access = {}) {
        const expiresOn = String(access.expiresOn || access.provider_access_expires_on || '');
        const formattedEnd = this.formatAccessDate(expiresOn);
        const message = formattedEnd
            ? `Provider access saved until ${formattedEnd}.`
            : 'Provider access period saved.';
        NorvaModal.toast(message, 'provider-access-success', { duration: 4200 });
    }

    async showProviderAccess(id) {
        const view = this.openProviderAccessModal('Provider access', `
          <div class="provider-access-loading" role="status" aria-live="polite">
            <span class="provider-access-skeleton"></span>
            <span class="provider-access-skeleton provider-access-skeleton-short"></span>
            <span class="provider-access-skeleton"></span>
            <span class="sr-only">Loading provider access</span>
          </div>
        `);
        if (!view) return;
        try {
            const access = await API.providerAccess.get(id);
            if (this.providerAccessViewToken !== view.token) return;
            this.renderProviderAccessDetails(id, access, view);
        } catch (error) {
            if (this.providerAccessViewToken !== view.token) return;
            view.body.innerHTML = `<div class="provider-access-terminal" role="alert"><strong>Provider access unavailable</strong><p>${this.escapeHtml(this.providerAccessErrorMessage(error))}</p><button class="btn btn-secondary" type="button" data-access-retry>Try again</button></div>`;
            view.body.querySelector('[data-access-retry]')?.addEventListener('click', () => this.showProviderAccess(id));
        }
    }

    renderProviderAccessDetails(id, access, view) {
        const summary = this.providerAccessSummary({
            provider_access_status: access.status,
            provider_access_expires_on: access.expiresOn
        });
        const confirmedHidden = ['EXPIRED_CONFIRMED', 'ACCESS_UNAVAILABLE_CONFIRMED'].includes(access.status);
        view.body.innerHTML = `
          <div class="provider-access-panel" data-access-status="${this.escapeHtml(String(access.status).toLowerCase())}">
            <div class="provider-access-overview provider-access-${this.escapeHtml(summary.tone)}">
              <div><span class="provider-access-eyebrow">Current status</span><strong>${this.escapeHtml(summary.label)}</strong></div>
              <p>${access.expiresOn ? `Recorded until ${this.escapeHtml(this.formatAccessDate(access.expiresOn))}.` : 'No provider access end date is recorded.'}</p>
              ${confirmedHidden ? '<p class="provider-access-policy-note">Your catalogue is retained but hidden. A future date starts restoration; only a successful provider check makes it visible again.</p>' : ''}
            </div>
            ${this.getProviderAccessTermsFields({ prefix: 'provider-access-settings', access })}
            <details class="provider-access-more-actions">
              <summary>Login or catalogue changed?</summary>
              <div class="provider-access-paths">
                <button class="provider-access-path" type="button" data-access-path="renew">
                  <strong>Provider renewed the same login</strong><span>Update the period without rebuilding the catalogue.</span>
                </button>
                <button class="provider-access-path" type="button" data-access-path="credentials">
                  <strong>I received new login details</strong><span>Validate them safely before changing the active service.</span>
                </button>
                <button class="provider-access-path" type="button" data-access-path="provider">
                  <strong>I changed provider or catalogue</strong><span>Prepare a different catalogue separately before any switch.</span>
                </button>
              </div>
            </details>
            <p class="provider-access-feedback" data-access-feedback role="status" aria-live="polite"></p>
          </div>
        `;
        view.modal.classList.add('provider-access-wizard-modal');
        view.footer.hidden = true;
        const wizard = this.bindProviderAccessTerms(view.body);
        const fieldset = view.body.querySelector('[data-provider-access-terms]');
        const feedback = view.body.querySelector('[data-access-feedback]');
        const setBusy = (busy, message = '') => {
            view.body.querySelectorAll('button,select,input').forEach((control) => { control.disabled = busy; });
            view.body.closest('.modal-content')?.setAttribute('aria-busy', busy ? 'true' : 'false');
            if (feedback) feedback.textContent = message;
        };
        fieldset?.addEventListener('norva:provider-access-cancel', () => view.close());
        fieldset?.addEventListener('norva:provider-access-complete', async () => {
            let terms;
            try {
                terms = this.readProviderAccessTerms(view.body);
            } catch (error) {
                const accessError = fieldset.querySelector('[data-access-error]');
                if (accessError) {
                    accessError.textContent = error.message;
                    accessError.hidden = false;
                }
                return;
            }
            if (!terms) {
                view.close();
                NorvaModal.toast(access.activeCycle ? 'Your current provider access period was kept.' : 'You can add the provider access period later from Settings.', 'info');
                return;
            }
            const action = access.activeCycle ? `cycle-update-${access.revision}` : 'cycle-create';
            setBusy(true, 'Saving provider access…');
            try {
                const options = { idempotencyKey: this.providerAccessIdempotency(id, action) };
                const next = access.activeCycle
                    ? await API.providerAccess.updateCycle(id, access.activeCycle.cycleId, terms, { ...options, ifMatch: `"provider-access-rev-${access.revision}"` })
                    : await API.providerAccess.createCycle(id, terms, options);
                this.clearProviderAccessIdempotency(id, action);
                await this.loadSources();
                if (this.providerAccessViewToken === view.token) {
                    this.renderProviderAccessDetails(id, next, view);
                    this.showProviderAccessSavedReceipt(next);
                }
            } catch (error) {
                setBusy(false, this.providerAccessErrorMessage(error));
            }
        });
        view.body.querySelector('[data-access-end]')?.addEventListener('click', async () => {
            const action = `cycle-end-${access.revision}`;
            setBusy(true, 'Removing the recorded period…');
            try {
                const next = await API.providerAccess.endCycle(id, access.activeCycle.cycleId, {
                    idempotencyKey: this.providerAccessIdempotency(id, action),
                    ifMatch: `"provider-access-rev-${access.revision}"`
                });
                this.clearProviderAccessIdempotency(id, action);
                await this.loadSources();
                if (this.providerAccessViewToken === view.token) this.renderProviderAccessDetails(id, next, view);
            } catch (error) {
                setBusy(false, this.providerAccessErrorMessage(error));
            }
        });
        view.body.querySelector('[data-access-path="renew"]')?.addEventListener('click', () => {
            view.body.querySelector('.provider-access-more-actions')?.removeAttribute('open');
            wizard?.showStep?.(0);
        });
        for (const path of ['credentials', 'provider']) {
            view.body.querySelector(`[data-access-path="${path}"]`)?.addEventListener('click', () => {
                view.close();
                this.showEditModal(id, 'xtream');
            });
        }
    }

    showCredentialCandidate(id, candidate) {
        const view = this.openProviderAccessModal('Checking new login', '<div class="provider-transition" data-provider-transition></div>');
        if (!view) return;
        this.renderCredentialCandidate(id, candidate, view);
        this.pollCredentialCandidate(id, candidate.candidateId, view);
    }

    credentialCandidateCopy(candidate) {
        if (candidate.state === 'COMPLETED') return ['Login changed', 'The new login is active and the catalogue check completed.'];
        if (candidate.state === 'FAILED') return ['Login not changed', 'Norva stopped safely. The previous login and catalogue remain authoritative.'];
        if (candidate.state === 'CANCELLED') return ['Check cancelled', 'The candidate was discarded without changing the active service.'];
        if (candidate.comparison === 'AMBIGUOUS') return ['Confirmation needed', 'Norva could not safely tell whether these details belong to the current catalogue.'];
        if (candidate.comparison === 'DIFFERENT_CATALOG') return ['Different catalogue detected', 'The new catalogue must be prepared separately before a switch.'];
        if (candidate.actions?.canApply) return ['Same catalogue confirmed', 'The new login can be activated with a rollback-safe refresh.'];
        return ['Checking safely', 'Norva is validating the login and comparing a staged catalogue. The active catalogue is unchanged.'];
    }

    renderCredentialCandidate(id, candidate, view) {
        if (this.providerAccessViewToken !== view.token) return;
        const root = view.body.querySelector('[data-provider-transition]');
        if (!root) return;
        const [title, copy] = this.credentialCandidateCopy(candidate);
        const working = ['VALIDATING', 'STAGING', 'IMPORTING', 'COMMITTING'].includes(candidate.state)
            && !candidate.actions?.canDecide;
        root.innerHTML = `
          <div class="provider-transition-status" role="status" aria-live="polite">
            <span class="provider-transition-step">${this.escapeHtml(candidate.state.replaceAll('_', ' '))}</span>
            <h3>${this.escapeHtml(title)}</h3><p>${this.escapeHtml(copy)}</p>
          </div>
          ${working ? '<div class="provider-access-progress" aria-hidden="true"><span></span></div>' : ''}
          <div class="provider-transition-actions">
            ${candidate.actions?.canDecide ? '<button class="btn btn-primary" type="button" data-candidate-decision="KEEP_AS_SAME_CATALOG">These details are for the same catalogue</button><button class="btn btn-secondary" type="button" data-candidate-decision="REPLACE_WITH_NEW_CATALOG">This is a different provider or catalogue</button>' : ''}
            ${candidate.actions?.canApply ? '<button class="btn btn-primary" type="button" data-candidate-apply>Activate new login</button>' : ''}
            ${candidate.actions?.requiresReplacement ? '<button class="btn btn-primary" type="button" data-candidate-replacement>Prepare replacement catalogue</button>' : ''}
            ${candidate.actions?.canCancel ? '<button class="btn btn-secondary" type="button" data-candidate-cancel>Cancel safely</button>' : ''}
          </div>
          <p class="provider-access-feedback" data-transition-feedback role="status" aria-live="polite"></p>
        `;
        const feedback = root.querySelector('[data-transition-feedback]');
        const mutate = async (action, callback) => {
            root.querySelectorAll('button').forEach((button) => { button.disabled = true; });
            if (feedback) feedback.textContent = 'Saving this decision…';
            try {
                const next = await callback(this.providerAccessIdempotency(id, action));
                this.clearProviderAccessIdempotency(id, action);
                this.renderCredentialCandidate(id, next, view);
            } catch (error) {
                root.querySelectorAll('button').forEach((button) => { button.disabled = false; });
                if (feedback) feedback.textContent = this.providerAccessErrorMessage(error);
            }
        };
        root.querySelectorAll('[data-candidate-decision]').forEach((button) => button.addEventListener('click', () => {
            const decision = button.dataset.candidateDecision;
            mutate(`candidate-decision-${candidate.revision}-${decision}`, (key) => API.providerAccess.decideCandidate(id, candidate.candidateId, decision, {
                idempotencyKey: key, ifMatch: `"transition-rev-${candidate.revision}"`
            }));
        }));
        root.querySelector('[data-candidate-apply]')?.addEventListener('click', () => mutate(
            `candidate-apply-${candidate.revision}`,
            (key) => API.providerAccess.applyCandidate(id, candidate.candidateId, candidate.revision, {
                idempotencyKey: key, ifMatch: `"source-rev-${candidate.sourceRevision}"`
            })
        ));
        root.querySelector('[data-candidate-cancel]')?.addEventListener('click', () => mutate(
            `candidate-cancel-${candidate.revision}`,
            (key) => API.providerAccess.cancelCandidate(id, candidate.candidateId, {
                idempotencyKey: key, ifMatch: `"transition-rev-${candidate.revision}"`
            })
        ));
        root.querySelector('[data-candidate-replacement]')?.addEventListener('click', () => mutate(
            `replacement-create-${candidate.revision}`,
            async (key) => {
                const replacement = await API.providerAccess.createReplacement(id, {
                    credentialCandidateId: candidate.candidateId,
                    displayName: 'Replacement TV service'
                }, { idempotencyKey: key, ifMatch: `"source-rev-${candidate.sourceRevision}"` });
                this.showSourceReplacement(id, replacement);
                return candidate;
            }
        ));
    }

    async pollCredentialCandidate(id, candidateId, view) {
        for (let attempt = 0; attempt < 300 && this.providerAccessViewToken === view.token; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, attempt < 30 ? 2000 : 10000));
            if (this.providerAccessViewToken !== view.token) return;
            try {
                const candidate = await API.providerAccess.getCandidate(id, candidateId);
                this.renderCredentialCandidate(id, candidate, view);
                if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(candidate.state) || candidate.actions?.canDecide || candidate.actions?.canApply || candidate.actions?.requiresReplacement) return;
            } catch (_) { /* keep the durable operation pollable */ }
        }
    }

    showSourceReplacement(id, replacement) {
        const view = this.openProviderAccessModal('Preparing replacement catalogue', '<div class="provider-transition" data-replacement-transition></div>');
        if (!view) return;
        this.renderSourceReplacement(id, replacement, view);
        this.pollSourceReplacement(id, replacement.replacementId, view);
    }

    renderSourceReplacement(id, replacement, view) {
        if (this.providerAccessViewToken !== view.token) return;
        const root = view.body.querySelector('[data-replacement-transition]');
        if (!root) return;
        const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(replacement.state);
        root.innerHTML = `
          <div class="provider-transition-status" role="status" aria-live="polite">
            <span class="provider-transition-step">${this.escapeHtml(replacement.state.replaceAll('_', ' '))}</span>
            <h3>${replacement.state === 'READY_TO_SWITCH' ? 'Replacement ready' : replacement.state === 'COMPLETED' ? 'Catalogue switched' : terminal ? 'Replacement stopped' : 'Preparing in the background'}</h3>
            <p>${replacement.state === 'READY_TO_SWITCH' ? 'The staged catalogue passed its checks. The final switch is atomic.' : replacement.state === 'COMPLETED' ? 'The new catalogue is active. Your previous catalogue remains recoverable during the rollback window.' : terminal ? 'The active catalogue was not mixed with the candidate.' : 'Your current catalogue stays active while Norva imports and checks the candidate.'}</p>
          </div>
          ${!terminal && replacement.state !== 'READY_TO_SWITCH' ? '<div class="provider-access-progress" aria-hidden="true"><span></span></div>' : ''}
          <div class="provider-transition-actions">
            ${replacement.actions?.canPromote ? '<button class="btn btn-primary" type="button" data-replacement-promote>Switch catalogues</button>' : ''}
            ${replacement.actions?.canCancel ? '<button class="btn btn-secondary" type="button" data-replacement-cancel>Cancel safely</button>' : ''}
            ${replacement.actions?.canRollback ? '<button class="btn btn-secondary" type="button" data-replacement-rollback>Restore previous catalogue</button>' : ''}
          </div>
          <p class="provider-access-feedback" data-transition-feedback role="status" aria-live="polite"></p>
        `;
        const run = async (action, callback) => {
            root.querySelectorAll('button').forEach((button) => { button.disabled = true; });
            const feedback = root.querySelector('[data-transition-feedback]');
            if (feedback) feedback.textContent = 'Committing the durable transition…';
            try {
                const next = await callback(this.providerAccessIdempotency(id, action));
                this.clearProviderAccessIdempotency(id, action);
                this.renderSourceReplacement(id, next, view);
                await this.loadSources();
            } catch (error) {
                root.querySelectorAll('button').forEach((button) => { button.disabled = false; });
                if (feedback) feedback.textContent = this.providerAccessErrorMessage(error);
            }
        };
        root.querySelector('[data-replacement-promote]')?.addEventListener('click', () => run(
            `replacement-promote-${replacement.revision}`,
            (key) => API.providerAccess.promoteReplacement(id, replacement.replacementId, replacement.revision, {
                idempotencyKey: key, ifMatch: `"source-rev-${replacement.sourceRevision}"`
            })
        ));
        root.querySelector('[data-replacement-cancel]')?.addEventListener('click', () => run(
            `replacement-cancel-${replacement.revision}`,
            (key) => API.providerAccess.cancelReplacement(id, replacement.replacementId, {
                idempotencyKey: key, ifMatch: `"transition-rev-${replacement.revision}"`
            })
        ));
        root.querySelector('[data-replacement-rollback]')?.addEventListener('click', () => run(
            `replacement-rollback-${replacement.revision}`,
            (key) => API.providerAccess.rollbackReplacement(id, replacement.replacementId, {
                idempotencyKey: key, ifMatch: `"transition-rev-${replacement.revision}"`
            })
        ));
    }

    async pollSourceReplacement(id, replacementId, view) {
        for (let attempt = 0; attempt < 600 && this.providerAccessViewToken === view.token; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, attempt < 30 ? 2000 : 10000));
            if (this.providerAccessViewToken !== view.token) return;
            try {
                const replacement = await API.providerAccess.getReplacement(id, replacementId);
                this.renderSourceReplacement(id, replacement, view);
                if (['COMPLETED', 'FAILED', 'CANCELLED', 'READY_TO_SWITCH'].includes(replacement.state)) return;
            } catch (_) { /* durable operation remains resumable */ }
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
        const ok = await NorvaModal.confirm(
            'This source and the channels, movies and series it added will be removed from Norva. You can add it again later.',
            { title: 'Remove source?', confirmLabel: 'Remove', danger: true }
        );
        if (!ok) return;

        try {
            await this.releasePlaybackForSourceChange();
            await API.sources.delete(id);
        } catch (err) {
            console.warn('[SourceManager] Source removal failed before commit:', err);
            NorvaModal.toast('Could not remove this source. Try again.', 'error');
            return;
        }

        // The delete is already committed. UI refresh failures must never invite
        // the user to repeat an irreversible operation or imply that it failed.
        NorvaModal.toast('Source removed from Norva.', 'success');
        try {
            await this.loadSources();
            this.notifySourceHealthChanged();

            if (window.app?.channelList) {
                await window.app.channelList.loadSources();
                await window.app.channelList.loadChannels();
            }
        } catch (err) {
            console.warn('[SourceManager] Source removed; view refresh failed:', err);
            this.notifySourceHealthChanged();
        }
    }

    /**
     * Toggle source enabled/disabled
     */
    async toggleSource(id) {
        const sourceItem = document.querySelector(`.source-item[data-id="${id}"]`);
        const currentlyEnabled = !sourceItem?.classList?.contains('disabled');
        const sourceName = sourceItem?.querySelector('.source-name')?.textContent?.trim() || 'this service';
        if (currentlyEnabled) {
            const confirmed = await NorvaModal.confirm(
                `Disable ${sourceName}? Its catalog will be hidden without being deleted, and you can enable it again later.`,
                { title: 'Disable service?', confirmLabel: 'Disable' }
            );
            if (!confirmed) return;
        }

        try {
            await this.releasePlaybackForSourceChange();
            await API.sources.toggle(id);
        } catch (err) {
            console.warn('[SourceManager] Source toggle failed before commit:', err);
            NorvaModal.toast('Could not change this source right now. Try again.', 'error');
            return;
        }

        // A successful toggle is authoritative even if the subsequent card
        // refresh is interrupted. Do not tell the user to retry a committed CAS.
        NorvaModal.toast(
            currentlyEnabled ? 'Service disabled. Its catalog is still saved.' : 'Service enabled.',
            'success'
        );
        try {
            await this.loadSources();
            this.notifySourceHealthChanged();
        } catch (err) {
            console.warn('[SourceManager] Source toggled; view refresh failed:', err);
            this.notifySourceHealthChanged();
        }
    }

    /**
     * Test source connection
     */
    async testSource(id) {
        const button = document.querySelector(`.source-item[data-id="${id}"] [data-action="test"]`);
        const previousText = button?.textContent || 'Check service';
        try {
            if (button) {
                button.disabled = true;
                button.textContent = 'Checking…';
            }
            const result = await API.sources.test(id);
            if (result.success) {
                NorvaModal.toast('Connection successful!', 'success');
            } else {
                NorvaModal.toast(this.sourceConnectionTestMessage(result), 'error');
            }
        } catch (err) {
            console.warn('[SourceManager] Connection test failed:', err);
            NorvaModal.toast(this.sourceConnectionTestMessage(err), 'error');
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = previousText;
            }
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
                const proceed = await this.showWarningModal(this.rebuildConfirmationCopy());
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
                            title: 'Large playlist',
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
            let syncResult = null;
            try {
                syncResult = isHardRefresh ? await API.sources.hardSync(id) : await API.sources.sync(id);
            } catch (err) {
                if (String(err?.code || '').toUpperCase() !== 'STALE_CATALOG_VISIBILITY_EPOCH') {
                    throw err;
                }

                // The write may already be durable even though another response
                // advanced this browser's visibility epoch before the POST reply
                // arrived. Never retry the mutation: discard cached source views
                // and reconcile exclusively from the durable status endpoint.
                console.warn('[SourceManager] Sync response used an older visibility epoch; reconciling durable status without retrying the mutation.');
                window.NorvaCloud?.catalogVisibility?.invalidate?.();
            }

            // 2. Poll for completion
            let retries = 0;
            let statusPollErrors = 0;
            const maxRetries = 180; // up to 3 min — catalog imports routinely exceed 60s

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

                // Match the status robustly across the id field names the API uses
                // (source_id / sourceId / id / cloud_id) — same as sourceStatusFor().
                // The old `s.type === 'all'` filter matched a field that /sources/status
                // never returns, so `status` was ALWAYS undefined and every sync fell
                // through to the "timed out" throw below even on success.
                const status = (statuses || []).find(s =>
                    [s.source_id, s.sourceId, s.id, s.cloudId, s.cloud_id]
                        .filter(Boolean).map(String).includes(String(id)));
                const st = status && String(status.status);

                if (status && (st === 'success' || st === 'ready' || st === 'complete' || st === 'done')) {
                    console.log('[SourceManager] Sync completed successfully');
                    break;
                } else if (status && st === 'error') {
                    const syncError = new Error(status.error || 'Sync failed');
                    syncError.code = status.error_code || status.errorCode || status.code || '';
                    syncError.payload = status;
                    throw syncError;
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
                NorvaModal.toast(isHardRefresh ? 'EPG data hard refreshed!' : 'EPG data synced & refreshed!', 'success');
            } else if (type === 'xtream') {
                // Re-fetch xtream data by reloading channels
                if (window.app?.channelList) {
                    await window.app.channelList.loadChannels();
                }
                NorvaModal.toast(isHardRefresh ? 'Xtream data hard refreshed!' : 'Xtream data synced & refreshed!', 'success');
            } else if (type === 'm3u') {
                // Re-fetch M3U data by reloading channels
                if (window.app?.channelList) {
                    await window.app.channelList.loadChannels();
                }
                NorvaModal.toast(isHardRefresh ? 'M3U playlist hard refreshed!' : 'M3U playlist synced & refreshed!', 'success');
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
            NorvaModal.toast(this.sourceSyncErrorMessage(err, { hard: isHardRefresh }), 'error');
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

        // Warn before losing unsaved Manage Content edits by closing/refreshing the tab.
        // (Switching source already auto-saves via flushThenReload; this covers full unload.)
        if (!this._contentUnloadBound) {
            this._contentUnloadBound = true;
            window.addEventListener('beforeunload', (e) => {
                if (this.hasUnsavedContentChanges()) { e.preventDefault(); e.returnValue = ''; }
            });
        }

        // Search input
        const searchInput = document.getElementById('content-search');
        const searchClear = searchInput?.parentElement?.querySelector('.search-clear');

        searchInput?.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase().trim();
            // Debounce the full-tree rebuild: renderTree() re-renders + re-wires the whole
            // content tree, and on TV the D-pad/IME emits rapid input events that would run
            // it per keystroke. 250ms coalesces a burst into one render.
            clearTimeout(this._contentSearchTimer);
            this._contentSearchTimer = setTimeout(() => this.renderTree(), 250);
        });

        searchClear?.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                this.searchQuery = '';
                clearTimeout(this._contentSearchTimer);
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
        // Movies / Series → catalogue-based "by genre" view (no provider needed):
        // the genres come from the actual titles, and hide/show is per-genre and
        // persisted on the profile (works across screens, unlike the old per-
        // provider-category hide which never persisted on the cloud).
        if (this.contentType === 'movies') { this.updateContentChrome('genre'); return this.loadGenreView('movie'); }
        if (this.contentType === 'series') { this.updateContentChrome('genre'); return this.loadGenreView('series'); }

        // Channels → per-provider category tree, defaulting to "All providers"
        // (like Movies/Series). Picking a provider narrows the tree to it.
        this.updateContentChrome('provider');
        const sourceId = this.contentSourceSelect?.value;
        if (sourceId) return this.loadChannels([sourceId]);
        return this.loadAllProvidersChannels();
    }

    // The provider selector is available in every view so the user can choose
    // which provider they're managing — in the genre view it scopes which
    // provider's catalogue the genres are counted from ("All providers" by
    // default). Search + Save are channel-tree concepts, so they stay limited
    // to the channels view; the genre view saves instantly on each toggle.
    updateContentChrome(mode) {
        const providerMode = mode === 'provider';
        const header = document.querySelector('#tab-content .content-browser-header');
        const legend = document.getElementById('content-legend');
        if (header) header.style.display = '';
        if (legend) legend.style.display = '';
        const setShown = (el, show) => { if (el) el.style.display = show ? '' : 'none'; };
        setShown(document.getElementById('content-source-select'), true);
        setShown(document.querySelector('#tab-content .search-wrapper'), providerMode);
        setShown(document.getElementById('content-save'), providerMode);
        this.setProviderModeLabel(mode);
    }

    // The blank (value="") provider option means different things per view: in
    // The blank (value="") option is the valid "All providers" default in every
    // view now (Channels included), so picking a provider is always optional.
    setProviderModeLabel(mode) {
        const select = document.getElementById('content-source-select');
        const first = select && select.options && select.options[0];
        if (first && first.value === '') first.textContent = 'All providers';
    }

    // --- Catalogue genre view (movies / series) ---
    async loadGenreView(itemType) {
        // Scope to the chosen provider (blank = every provider).
        const sourceId = (this.contentSourceSelect && this.contentSourceSelect.value) || '';
        this.treeData = { type: itemType + '-genres', itemType, genreView: true, sourceId };
        this.contentTree.innerHTML = '<div class="genre-loading">'
            + '<span class="genre-spinner" aria-hidden="true"></span>Loading genres…</div>';
        try {
            const payload = await API.media.genreSummary({ type: itemType, source: sourceId });
            const genres = (payload && payload.genres) || [];
            this.genreHidden = new Set(payload && payload.hidden ? payload.hidden : []);
            this.genreList = genres;
            if (!genres.length) {
                this.contentTree.innerHTML = '<div class="screens-empty">No genres detected in your catalogue yet.<br>Add a TV provider and let Norva sync your movies & shows.</div>';
                return;
            }
            this.renderGenreView(genres);
        } catch (e) {
            // Keep one concise breadcrumb so a future failure is never silent.
            console.error('[ManageContent] loadGenreView failed:', e?.message || e, e);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Unable to load genres</p>';
        }
    }

    renderGenreView(genres) {
        const unit = this.treeData?.itemType === 'series' ? 'shows' : 'movies';
        const cards = genres.map((g) => {
            const on = !this.genreHidden.has(g.bucket);
            const count = Number(g.count) || 0;
            return `<button type="button" class="genre-card ${on ? 'is-on' : 'is-off'}" data-bucket="${this.escapeHtml(g.bucket)}" role="switch" aria-checked="${on ? 'true' : 'false'}" title="${this.escapeHtml(g.label)}">
                <span class="genre-card-text">
                    <span class="genre-card-name">${this.escapeHtml(g.label)}</span>
                    <span class="genre-card-count">${count.toLocaleString()} ${unit}</span>
                </span>
                <span class="genre-switch" aria-hidden="true"><span class="genre-switch-knob"></span></span>
            </button>`;
        }).join('');
        this.contentTree.innerHTML = `<div class="genre-view">
            <div class="genre-view-summary">${this.genreSummaryText(genres)}</div>
            <div class="genre-grid">${cards}</div>
        </div>`;
        this.contentTree.querySelectorAll('.genre-card').forEach((card) => {
            card.addEventListener('click', () => this.onGenreToggle(card));
        });
    }

    genreSummaryText(genres) {
        const list = genres || this.genreList || [];
        const shown = list.filter((g) => !this.genreHidden?.has(g.bucket)).length;
        return `<strong>${shown}</strong> of ${list.length} genres shown in Norva`;
    }

    onGenreToggle(card) {
        const bucket = card.dataset.bucket;
        if (!this.genreHidden) this.genreHidden = new Set();
        const turningOn = card.classList.contains('is-off');
        if (turningOn) this.genreHidden.delete(bucket);
        else this.genreHidden.add(bucket);
        // Flip the card in place for a snappy, no-flicker toggle.
        card.classList.toggle('is-on', turningOn);
        card.classList.toggle('is-off', !turningOn);
        card.setAttribute('aria-checked', turningOn ? 'true' : 'false');
        const summary = this.contentTree?.querySelector('.genre-view-summary');
        if (summary) summary.innerHTML = this.genreSummaryText();
        this.saveGenreHidden();
    }

    async getEditProfileId() {
        try {
            const active = window.NorvaCloud?.profiles?.getActiveId?.();
            if (active) return active;
            const res = await window.NorvaCloud.profiles.list();
            const list = (res && (res.profiles || res)) || [];
            const def = list.find((p) => p.is_default) || list[0];
            return def ? def.id : null;
        } catch (_) { return null; }
    }

    async saveGenreHidden() {
        const status = document.getElementById('content-legend');
        try {
            const id = await this.getEditProfileId();
            if (!id) { this.toast('No profile to save to', true); return; }
            await window.NorvaCloud.profiles.update(id, { hiddenGenres: [...this.genreHidden] });
            try { API.media.clearRailCache?.(); } catch (_) { /* noop */ }
            this.toast('Saved');
        } catch (e) {
            console.warn('[SourceManager] Profile genre preferences could not be saved:', e);
            this.toast('Could not save these preferences. Try again.', true);
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
            // Blank option = "All providers" (the default in every view now).
            select.innerHTML = '<option value="">All providers</option>'
                + providers.map(source =>
                    `<option value="${source.id}">${this.escapeHtml(source.name)}</option>`).join('');
            // Preserve the current selection across reloads when still present.
            if (current && providers.some(p => String(p.id) === String(current))) {
                select.value = current;
            }

            // Grand-public dead-end guard: with no provider added yet, point the
            // user to where they can add one instead of showing an inert tree.
            this.updateContentEmptyState(providers.length);

            // Auto-load the current view on first open (channels default to All
            // providers) — no more "pick a provider first" dead-end. Re-opening
            // the tab keeps the existing tree (and any unsaved ticks) intact.
            if (providers.length && !this.treeData) this.reloadContentTree();
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
    // Visibility key — source-aware so channels/categories from different
    // providers (which can share stream/category ids) never collide.
    vkey(type, sourceId, id) { return `${type}:${sourceId}:${id}`; }

    // "All providers" entry point: gather every Xtream/M3U provider and merge
    // their channels into one tree.
    async loadAllProvidersChannels() {
        let providers = [];
        try {
            const sources = await API.sources.getAll();
            providers = (sources || []).filter(s => s.type === 'xtream' || s.type === 'm3u');
        } catch (_) { /* fall through to empty state */ }
        if (!providers.length) {
            this.contentTree.innerHTML = '<p class="hint">No providers yet. Add a TV provider to manage its channels.</p>';
            return;
        }
        return this.loadChannels(providers.map(p => String(p.id)));
    }

    // Build the channels tree from one or more providers. Each group/item is
    // tagged with its sourceId so toggles and saves route back to the right
    // provider; the visibility set is keyed via vkey() to stay collision-safe.
    async loadChannels(sourceIds) {
        const ids = (sourceIds || []).filter(Boolean).map(String);
        this.contentTree.innerHTML = '<div class="genre-loading"><span class="genre-spinner" aria-hidden="true"></span>Loading channels…</div>';
        this.treeData = { type: 'channels', sourceId: ids.length === 1 ? ids[0] : '', multi: ids.length !== 1, sourceIds: ids, groups: [] };
        this.expandedGroups.clear();
        this.hiddenSet = new Set();

        try {
            const allGroups = [];
            for (const sid of ids) {
                let source;
                try { source = await API.sources.getById(sid); } catch (_) { continue; }
                if (!source || !(source.type === 'xtream' || source.type === 'm3u')) continue;

                const [categories, streams, hiddenItems] = await Promise.all([
                    API.proxy.xtream.liveCategories(sid, { includeHidden: true }).catch(() => []),
                    API.proxy.xtream.liveStreams(sid, null, { includeHidden: true }).catch(() => []),
                    API.channels.getHidden(sid).catch(() => [])
                ]);

                (hiddenItems || []).forEach(h => this.hiddenSet.add(this.vkey(h.item_type, sid, h.item_id)));

                const categoryMap = {};
                (categories || []).forEach(cat => { categoryMap[cat.category_id] = cat.category_name; });

                const groupMap = {};
                (streams || []).forEach(ch => {
                    const categoryId = ch.category_id;
                    let groupName = 'Uncategorized';
                    if (categoryId && categoryMap[categoryId]) groupName = categoryMap[categoryId];
                    else if (categoryId) groupName = categoryId; // M3U uses the name as id
                    const groupKey = categoryId || groupName;
                    if (!groupMap[groupKey]) groupMap[groupKey] = { categoryId, name: groupName, items: [] };
                    const channelId = ch.stream_id || ch.id || ch.url;
                    groupMap[groupKey].items.push({
                        id: String(channelId),
                        name: ch.name || ch.tvgName || 'Unknown',
                        sourceId: sid,
                        type: 'channel',
                        original: ch
                    });
                });

                Object.entries(groupMap).forEach(([key, group]) => {
                    allGroups.push({
                        id: `${sid}::${key}`,           // unique across providers
                        sourceId: sid,
                        sourceName: source.name || '',
                        categoryId: group.categoryId,    // raw id for the API
                        name: group.name,
                        type: 'group',
                        items: group.items
                    });
                });
            }

            allGroups.sort((a, b) => a.name.localeCompare(b.name)
                || String(a.sourceName).localeCompare(String(b.sourceName)));
            this.treeData.groups = allGroups;
            this.originalHiddenSet = new Set(this.hiddenSet);

            if (!allGroups.length) {
                this.contentTree.innerHTML = '<div class="screens-empty">No channels found for this selection.</div>';
                return;
            }
            this.renderTree();
        } catch (err) {
            console.error('Error loading channels:', err);
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
    /**
     * Reflect whether Manage Content has edits not yet written to the server:
     * a visible "Unsaved changes" pill + an emphasised Save button. hasUnsaved-
     * ContentChanges() already diffs hiddenSet vs the last-saved originalHiddenSet.
     */
    updateContentDirtyState() {
        const dirty = this.hasUnsavedContentChanges();
        document.getElementById('content-unsaved')?.classList.toggle('hidden', !dirty);
        const saveBtn = document.getElementById('content-save');
        if (saveBtn && !saveBtn.disabled) saveBtn.classList.toggle('is-dirty', dirty);
    }

    renderTree() {
        const groups = this.getFilteredGroups();

        if (!groups.length) {
            const msg = this.searchQuery ? 'No matches found' : 'No content found';
            this.contentTree.innerHTML = `<p class="hint">${msg}</p>`;
            this.updateContentDirtyState();
            return;
        }

        // Insert a theme section header whenever the theme changes (Manage
        // Content genre view). Groups without a theme (e.g. channels) render flat.
        let html = '';
        let lastTheme = null;
        groups.forEach((group) => {
            if (group.theme && group.theme !== lastTheme) {
                html += `<div class="content-theme-header" style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#6f7d96;margin:18px 4px 8px;padding-bottom:6px;border-bottom:1px solid #1c2433">${this.escapeHtml(group.theme)}</div>`;
                lastTheme = group.theme;
            }
            html += this.getGroupHtml(group);
        });
        this.contentTree.innerHTML = html;

        // Attach event listeners
        this.attachTreeListeners(this.contentTree);
        this.updateContentDirtyState();
    }

    /**
     * Get HTML for a group (and its items if expanded)
     */
    getGroupHtml(group) {
        const isExpanded = this.expandedGroups.has(group.id);

        // Group checkbox is checked if ANY child is visible (derived state)
        const hasVisibleChild = group.items.some(item => !this.hiddenSet.has(this.vkey(item.type, item.sourceId, item.id)));
        const checked = hasVisibleChild;

        let itemsHtml = '';
        if (isExpanded) {
            itemsHtml = `<div class="content-channels">
                ${group.items.map(item => {
                const itemHidden = this.hiddenSet.has(this.vkey(item.type, item.sourceId, item.id));
                return `
                    <label class="checkbox-label channel-item" title="${this.escapeHtml(item.name)}">
                        <span class="channel-name">${this.escapeHtml(item.name)}</span>
                        <input type="checkbox" class="channel-checkbox"
                               data-type="${item.type}"
                               data-id="${this.escapeHtml(item.id)}"
                               data-source-id="${this.escapeHtml(item.sourceId)}"
                               ${!itemHidden ? 'checked' : ''}>
                    </label>`;
            }).join('')}
            </div>`;
        }

        // When several providers are merged, show which one a category belongs to
        // (categories with the same name can exist across providers).
        const providerTag = (this.treeData?.multi && group.sourceName)
            ? `<span class="group-provider">${this.escapeHtml(group.sourceName)}</span>` : '';

        return `
            <div class="content-group ${isExpanded ? '' : 'collapsed'}" data-group-id="${this.escapeHtml(group.id)}">
                <div class="content-group-header">
                    <span class="group-expander">${Icons.chevronDown}</span>
                    <span class="group-name">${this.escapeHtml(group.name)}</span>
                    ${providerTag}
                    <span class="group-count">${group.items.length}</span>
                    <label class="cg-switch" onclick="event.stopPropagation()">
                        <input type="checkbox" class="group-checkbox"
                               data-type="group"
                               data-id="${this.escapeHtml(group.id)}"
                               data-source-id="${this.escapeHtml(group.sourceId)}"
                               data-category-id="${this.escapeHtml(group.categoryId == null ? '' : group.categoryId)}"
                               ${checked ? 'checked' : ''}>
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
    // Group raw provider categories under curated genre headers (Action,
    // Comédie, K-Drama, …) for a mass-market Manage Content view. Persistence is
    // unchanged: items keep their provider category_id and item_type, and the
    // genre group has NO categoryId, so a group toggle only ever cascades to the
    // real provider categories underneath it. Unclassified categories land in
    // "Autres" so nothing disappears. Falls back to one flat list if the
    // taxonomy module isn't available.
    buildCategoryBucketGroups(categories, itemType) {
        const sorted = (categories || []).slice().sort((a, b) =>
            String(a.category_name || '').localeCompare(String(b.category_name || '')));
        const mkItem = (cat) => ({ id: String(cat.category_id), name: cat.category_name, type: itemType, original: cat });

        const T = window.GenreTaxonomy;
        if (!T || !T.classifyCategoryNode) {
            return [{ id: `all_${itemType}`, name: 'Categories', type: 'group', items: sorted.map(mkItem) }];
        }

        // Group provider categories under (theme → sub-category) nodes. The
        // sub-category is the checkbox group (cascades to the provider
        // categories underneath); the theme becomes a section header rendered by
        // renderTree(). Leaves stay provider categories, so hide/show is unchanged.
        const bySub = new Map();
        for (const cat of sorted) {
            const n = T.classifyCategoryNode(cat.category_name);
            if (!bySub.has(n.subId)) bySub.set(n.subId, { node: n, cats: [] });
            bySub.get(n.subId).cats.push(cat);
        }
        const subs = [...bySub.values()].sort((a, b) =>
            a.node.themeOrder - b.node.themeOrder ||
            a.node.subOrder - b.node.subOrder ||
            a.node.subLabel.localeCompare(b.node.subLabel));

        return subs.map(({ node, cats }) => ({
            id: `node_${itemType}_${node.subId}`,
            name: node.subLabel,
            theme: node.themeLabel,
            type: 'group',
            items: cats.map(mkItem)
        }));
    }

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

            this.treeData.groups = this.buildCategoryBucketGroups(categories, 'vod_category');

            // Expand every genre group so the categories are visible (and search
            // works), like the previous single auto-expanded list.
            this.treeData.groups.forEach(g => this.expandedGroups.add(g.id));
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

            this.treeData.groups = this.buildCategoryBucketGroups(categories, 'series_category');

            this.treeData.groups.forEach(g => this.expandedGroups.add(g.id));
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
        const sourceId = checkbox.dataset.sourceId;
        const isVisible = checkbox.checked;

        // Update local state only (will be persisted when Save is clicked)
        const key = this.vkey(itemType, sourceId, itemId);
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
                    const hasVisibleChild = group.items.some(item => !this.hiddenSet.has(this.vkey(item.type, item.sourceId, item.id)));
                    groupCheckbox.checked = hasVisibleChild;
                }
            }
        }
        this.updateContentDirtyState();
    }

    /**
     * Toggle all children of a group (LOCAL STATE ONLY - use Save to persist)
     */
    toggleGroupChildren(groupCb) {
        const groupId = groupCb.dataset.id;
        const group = this.treeData.groups.find(g => g.id === groupId);
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
        if (group.categoryId != null && group.categoryId !== '') {
            const groupKey = this.vkey(groupItemType, group.sourceId, group.categoryId);
            if (isChecked) {
                this.hiddenSet.delete(groupKey);
            } else {
                this.hiddenSet.add(groupKey);
            }
        }

        // Update state for all children
        group.items.forEach(item => {
            const key = this.vkey(item.type, item.sourceId, item.id);
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
        this.updateContentDirtyState();
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
        // Genre view: Show all = no hidden genres, Hide all = every genre hidden.
        if (this.treeData?.genreView) {
            this.genreHidden = visible ? new Set() : new Set((this.genreList || []).map((g) => g.bucket));
            this.renderGenreView(this.genreList || []);
            await this.saveGenreHidden();
            return;
        }
        if (!this.treeData || !this.treeData.groups) return;

        // With an active search, only affect the items currently shown — not the
        // whole source — so "Show/Hide All" never silently touches filtered-out
        // items. Persist just the resulting diff via the normal save path.
        if (this.searchQuery) {
            this.getFilteredGroups().forEach(group => {
                group.items.forEach(item => {
                    const key = this.vkey(item.type, item.sourceId, item.id);
                    if (visible) this.hiddenSet.delete(key);
                    else this.hiddenSet.add(key);
                });
            });
            this.renderTree();
            await this.saveContentChanges();
            return;
        }

        const saveBtn = document.getElementById('content-save');
        const showAllBtn = document.getElementById('content-show-all');
        const hideAllBtn = document.getElementById('content-hide-all');

        // Disable buttons during operation
        if (showAllBtn) showAllBtn.disabled = true;
        if (hideAllBtn) hideAllBtn.disabled = true;
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = visible ? '⏳ Showing all...' : '⏳ Hiding all...';
        }

        try {
            const contentType = this.treeData.type; // 'channels', 'movies', or 'series'
            // Across every provider in the current view ("All providers" merges
            // several) — fast bulk endpoint, one call per source.
            const sourceIds = (this.treeData.sourceIds && this.treeData.sourceIds.length)
                ? this.treeData.sourceIds
                : [this.treeData.sourceId].filter(Boolean);

            for (const sid of sourceIds) {
                if (visible) await API.channels.showAll(sid, contentType);
                else await API.channels.hideAll(sid, contentType);
            }

            // Update local state to match
            this.treeData.groups.forEach(group => {
                group.items.forEach(item => {
                    const key = this.vkey(item.type, item.sourceId, item.id);
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
            NorvaModal.toast('Could not update visibility. Try again.', 'error');
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
        if (this.treeData?.genreView) return; // genre view auto-saves on toggle
        if (!this.treeData) {
            NorvaModal.toast('No content loaded to save', 'info');
            return;
        }

        const saveBtn = document.getElementById('content-save');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving...';
        }

        try {
            const itemsToShow = [];
            const itemsToHide = [];

            // Only collect items that have CHANGED from their original state.
            // Each group/item carries its own sourceId so a merged "All providers"
            // save routes every change back to the right provider. Track changed
            // groups by their unique id for the per-item redundancy check.
            const changedGroups = new Map(); // group.id -> isHidden

            // First pass: Identify all changed groups
            this.treeData.groups.forEach(group => {
                let groupItemType = 'group';
                if (this.treeData.type === 'movies') groupItemType = 'vod_category';
                else if (this.treeData.type === 'series') groupItemType = 'series_category';

                if (group.categoryId != null && group.categoryId !== '') {
                    const groupKey = this.vkey(groupItemType, group.sourceId, group.categoryId);
                    const isGroupNowHidden = this.hiddenSet.has(groupKey);
                    const wasGroupHidden = this.originalHiddenSet.has(groupKey);

                    if (isGroupNowHidden !== wasGroupHidden) {
                        changedGroups.set(group.id, isGroupNowHidden);
                        const payload = { sourceId: group.sourceId, itemType: groupItemType, itemId: String(group.categoryId) };
                        if (isGroupNowHidden) itemsToHide.push(payload); else itemsToShow.push(payload);
                    }
                }
            });

            // Second pass: Process items, skipping if redundant with group change
            this.treeData.groups.forEach(group => {
                const groupIsChanging = changedGroups.has(group.id);
                const groupNewState = changedGroups.get(group.id); // true = hiding, false = showing

                group.items.forEach(item => {
                    const key = this.vkey(item.type, item.sourceId, item.id);
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

                        const payload = { sourceId: item.sourceId, itemType: item.type, itemId: String(item.id) };
                        if (isNowHidden) itemsToHide.push(payload); else itemsToShow.push(payload);
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
            this.updateContentDirtyState();

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
            NorvaModal.toast('Could not save these changes. Try again.', 'error');
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
            const managementEnabled = !item.classList.contains('disabled');
            const status = statuses.find(s => s.source_id === id); // We might have multiple statuses (live, vod, epg) for one source

            // Just check if ANY sync is active/failed for this source
            const sourceStatuses = statuses.filter(s => s.source_id === id);
            const isSyncing = sourceStatuses.some(s => s.status === 'syncing');
            const hasError = sourceStatuses.some(s => s.status === 'error');
            const lastSync = sourceStatuses.map(s => s.last_sync).sort().pop();

            // Only update the visible primary action. The menu contains its own
            // refresh actions; the legacy selector used to replace the first
            // matching menu label with an icon whenever Repair was primary.
            const btn = item.querySelector('.source-primary-action[data-action="refresh"]');
            const hardBtn = item.querySelector('.source-menu-item[data-action="hard-refresh"]');
            if (btn) {
                if (isSyncing) {
                    btn.disabled = true;
                    btn.classList.add('syncing');
                    btn.textContent = 'Syncing…';
                    btn.title = 'Catalog update in progress';
                    btn.setAttribute('aria-label', 'Catalog update in progress');
                } else {
                    btn.disabled = false;
                    btn.classList.remove('syncing');
                    btn.textContent = 'Sync';
                    // A transient background failure does not invalidate the
                    // completed catalogue. Keep the action truthful and neutral;
                    // the durable retry/backoff owns recovery.
                    btn.title = hasError
                        ? 'Retry catalog update'
                        : (lastSync ? `Last update attempt: ${new Date(lastSync).toLocaleString()}` : 'Sync catalog now');
                    btn.setAttribute('aria-label', btn.title);
                }
            }

            if (hardBtn) {
                const hardRefreshDisabled = !managementEnabled || isSyncing;
                hardBtn.disabled = hardRefreshDisabled;
                if (hardRefreshDisabled) {
                    hardBtn.setAttribute('aria-disabled', 'true');
                } else {
                    hardBtn.removeAttribute('aria-disabled');
                }
                hardBtn.title = !managementEnabled
                    ? 'Enable the service first'
                    : isSyncing
                    ? 'Syncing...'
                    : (window.API?.isCloudMode?.() === true
                        ? 'Rescan and update the complete provider catalog'
                        : 'Clear and rebuild the local catalog');
            }

            // Optional: Update status text/badge in .source-info
        });
    }
}

// Export
window.SourceManager = SourceManager;
