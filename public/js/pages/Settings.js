/**
 * Settings Page Controller
 */

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.tabs = document.querySelectorAll('.tabs .tab');
        this.tabContents = document.querySelectorAll('.tab-content');

        this.init();
    }

    init() {
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Account and TV service overview
        this.initAccountSettings();

        // Player settings
        this.initPlayerSettings();

        // Content & discovery settings (dedup grouping, TMDB)
        this.initContentSettings();

        // Transcoding settings
        this.initTranscodingSettings();

        // User management (admin only)
        this.initUserManagement();
    }

    initAccountSettings() {
        document.getElementById('settings-manage-service-btn')?.addEventListener('click', () => {
            this.switchTab('sources');
        });

        document.getElementById('settings-open-account')?.addEventListener('click', () => {
            const returnTo = window.location.pathname + window.location.search + '#settings';
            window.location.href = '/account.html?returnTo=' + encodeURIComponent(returnTo);
        });

        document.getElementById('settings-open-cloud-dashboard')?.addEventListener('click', () => {
            window.location.href = '/cloud.html';
        });

        document.getElementById('settings-signout-btn')?.addEventListener('click', () => this.signOut());

        document.getElementById('settings-manage-plan-btn')?.addEventListener('click', () => {
            const returnTo = window.location.pathname + window.location.search + '#settings';
            window.location.href = '/paywall.html?returnTo=' + encodeURIComponent(returnTo);
        });

        document.getElementById('settings-service-health')?.addEventListener('click', (event) => {
            const actionButton = event.target.closest('[data-source-health-action]');
            if (!actionButton) return;

            const action = actionButton.dataset.sourceHealthAction;
            if (action === 'view-progress' && this.lastSourceHealthSummary && window.NorvaSourceHealth?.openProgress) {
                window.NorvaSourceHealth.openProgress(this.lastSourceHealthSummary, this.app);
                return;
            }

            if (action === 'open-sources') {
                if (this.lastSourceHealthSummary && window.NorvaSourceHealth?.openAction) {
                    window.NorvaSourceHealth.openAction(this.lastSourceHealthSummary, this.app);
                } else {
                    this.switchTab('sources');
                }
            }
        });
    }

    async signOut() {
        const token = localStorage.getItem('authToken');

        if (this.app.currentUser?.cloud && window.NorvaAuth) {
            await window.NorvaAuth.signOut();
            window.location.replace('/account.html');
            return;
        }

        if (token) {
            try {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            } catch (_) { }
        }

        localStorage.removeItem('authToken');
        window.location.replace('/login.html');
    }

    async refreshAccountSettings() {
        const user = this.app.currentUser || {};
        const email = document.getElementById('settings-account-email');
        const mode = document.getElementById('settings-account-mode');

        if (email) email.textContent = user.email || user.username || 'Paired Norva screen';
        if (mode) {
            mode.textContent = user.cloud
                ? (user.device ? 'Paired cloud screen' : 'Norva Cloud account')
                : (user.role ? `Local ${user.role}` : 'Local account');
        }

        const accountOnly = document.getElementById('settings-open-account');
        const cloudDashboard = document.getElementById('settings-open-cloud-dashboard');
        if (accountOnly) accountOnly.style.display = user.cloud ? '' : 'none';
        if (cloudDashboard) cloudDashboard.style.display = user.cloud ? '' : 'none';

        await this.refreshAccessCard();
        await this.refreshSourceHealthCard();
    }

    async refreshAccessCard() {
        const plan = document.getElementById('settings-access-plan');
        const hint = document.getElementById('settings-access-hint');
        const button = document.getElementById('settings-manage-plan-btn');
        if (!plan || !hint) return;

        if (!this.app.currentUser?.cloud || !window.NorvaCloud?.entitlements) {
            plan.textContent = 'Local access';
            hint.textContent = 'This device is using the local hub. Norva Cloud billing is not active here.';
            if (button) button.style.display = 'none';
            return;
        }

        if (button) button.style.display = '';

        try {
            const decision = this.app.currentUser.device
                ? await window.NorvaCloud.entitlements.device()
                : await window.NorvaCloud.entitlements.get();
            this.app.entitlement = decision;
            window.NorvaEntitlement = decision;

            const label = this.accessLabel(decision);
            plan.textContent = label;
            hint.textContent = decision.message || 'Norva access is active.';
            if (decision.enforced === false || decision.mode === 'observe') {
                hint.textContent = decision.message || 'Gate 0 access is open. Billing is being observed but not enforced.';
            }
            if (decision.failOpen && decision.enforced !== false && decision.mode !== 'observe') {
                hint.textContent = `${hint.textContent} Last known access is being honored while billing is checked.`;
            }
        } catch (err) {
            console.warn('[Settings] Unable to load Norva access:', err);
            plan.textContent = 'Access temporarily unavailable';
            hint.textContent = 'Norva will keep access open briefly while billing status is checked.';
        }
    }

    accessLabel(decision = {}) {
        if (decision.enforced === false || decision.mode === 'observe') {
            return 'Gate 0 access';
        }
        const plan = String(decision.planCode || decision.plan_code || 'trial');
        const status = String(decision.status || 'unknown').replace(/_/g, ' ');
        const planLabel = plan === 'trial'
            ? 'Trial'
            : plan.charAt(0).toUpperCase() + plan.slice(1);
        return `${planLabel} - ${status}`;
    }

    async refreshSourceHealthCard() {
        const container = document.getElementById('settings-service-health');
        if (!container || !window.NorvaSourceHealth) return;

        try {
            const summary = await window.NorvaSourceHealth.loadSummary();
            this.lastSourceHealthSummary = summary;
            container.innerHTML = window.NorvaSourceHealth.cardHtml(summary, { hideWhenReady: false });
        } catch (err) {
            console.warn('[Settings] Unable to load TV service health:', err);
            container.innerHTML = '';
        }
    }

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');
        const overlayDurationInput = document.getElementById('setting-overlay-duration');
        const defaultVolumeSlider = document.getElementById('setting-default-volume');
        const volumeValueDisplay = document.getElementById('volume-value');
        const rememberVolumeToggle = document.getElementById('setting-remember-volume');
        const autoPlayNextToggle = document.getElementById('setting-autoplay-next');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            overlayDurationInput.value = this.app.player.settings.overlayDuration;
            defaultVolumeSlider.value = this.app.player.settings.defaultVolume;
            volumeValueDisplay.textContent = this.app.player.settings.defaultVolume + '%';
            rememberVolumeToggle.checked = this.app.player.settings.rememberVolume;
            autoPlayNextToggle.checked = this.app.player.settings.autoPlayNextEpisode;
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.app.player.saveSettings();
        });

        // Overlay duration
        overlayDurationInput.addEventListener('change', () => {
            this.app.player.settings.overlayDuration = parseInt(overlayDurationInput.value) || 5;
            this.app.player.saveSettings();
        });

        // Default volume slider
        defaultVolumeSlider.addEventListener('input', () => {
            const value = defaultVolumeSlider.value;
            volumeValueDisplay.textContent = value + '%';
            this.app.player.settings.defaultVolume = parseInt(value);
            this.app.player.saveSettings();
        });

        // Remember volume toggle
        rememberVolumeToggle.addEventListener('change', () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.app.player.saveSettings();
        });

        // Auto-play next episode toggle
        autoPlayNextToggle.addEventListener('change', () => {
            this.app.player.settings.autoPlayNextEpisode = autoPlayNextToggle.checked;
            this.app.player.saveSettings();
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change - server will restart its sync timer via PUT /api/settings
            epgRefreshSelect.addEventListener('change', () => {
                this.app.player.settings.epgRefreshInterval = epgRefreshSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Update last refreshed display
        this.updateEpgLastRefreshed();
    }

    async initContentSettings() {
        const groupToggle = document.getElementById('setting-group-duplicates');
        const audioLangSelect = document.getElementById('setting-preferred-audio-language');
        const subtitleLangSelect = document.getElementById('setting-preferred-subtitle-language');
        const strictLangToggle = document.getElementById('setting-strict-language');
        const preferredGenresSelect = document.getElementById('setting-preferred-genres');
        const qualitySelect = document.getElementById('setting-preferred-quality');
        const tmdbKeyInput = document.getElementById('setting-tmdb-key');
        const enrichBtn = document.getElementById('tmdb-enrich-btn');
        const statusHint = document.getElementById('tmdb-status-hint');
        const resetBrokenBtn = document.getElementById('reset-broken-btn');
        const resetBrokenHint = document.getElementById('reset-broken-hint');

        let s = {};
        try {
            s = await API.settings.get();
        } catch (err) {
            console.warn('Could not load settings for content section');
        }

        if (groupToggle) groupToggle.checked = s.groupDuplicates !== false;
        const languagePrefs = window.MediaUtils?.normalizeContentPreferences
            ? window.MediaUtils.normalizeContentPreferences(s)
            : {
                preferredAudioLanguage: s.preferredAudioLanguage || '',
                preferredSubtitleLanguage: s.preferredSubtitleLanguage || '',
                strictLanguageMatching: Boolean(s.strictLanguageMatching)
            };
        if (audioLangSelect) audioLangSelect.value = languagePrefs.preferredAudioLanguage || '';
        if (subtitleLangSelect) subtitleLangSelect.value = languagePrefs.preferredSubtitleLanguage || '';
        if (strictLangToggle) strictLangToggle.checked = Boolean(languagePrefs.strictLanguageMatching);
        if (preferredGenresSelect) {
            const selectedGenres = Array.isArray(s.preferredGenres)
                ? s.preferredGenres
                : String(s.preferredGenres || '').split(',').map(value => value.trim()).filter(Boolean);
            [...preferredGenresSelect.options].forEach(option => {
                option.selected = selectedGenres.includes(option.value);
            });
        }
        if (qualitySelect) qualitySelect.value = s.preferredQuality || 'highest';
        if (tmdbKeyInput) tmdbKeyInput.value = s.tmdbApiKey || '';

        if (s.preferredLanguage && !s.preferredAudioLanguage && !s.preferredSubtitleLanguage) {
            API.settings.update({
                preferredAudioLanguage: languagePrefs.preferredAudioLanguage || '',
                preferredSubtitleLanguage: languagePrefs.preferredSubtitleLanguage || '',
                preferredLanguage: ''
            }).catch(console.error);
        }

        groupToggle?.addEventListener('change', () => {
            API.settings.update({ groupDuplicates: groupToggle.checked }).catch(console.error);
        });
        audioLangSelect?.addEventListener('change', () => {
            API.settings.update({
                preferredAudioLanguage: audioLangSelect.value,
                preferredLanguage: ''
            }).catch(console.error);
        });
        subtitleLangSelect?.addEventListener('change', () => {
            API.settings.update({
                preferredSubtitleLanguage: subtitleLangSelect.value,
                preferredLanguage: ''
            }).catch(console.error);
        });
        strictLangToggle?.addEventListener('change', () => {
            API.settings.update({ strictLanguageMatching: strictLangToggle.checked }).catch(console.error);
        });
        preferredGenresSelect?.addEventListener('change', () => {
            API.settings.update({
                preferredGenres: [...preferredGenresSelect.selectedOptions].map(option => option.value)
            }).catch(console.error);
        });
        qualitySelect?.addEventListener('change', () => {
            API.settings.update({ preferredQuality: qualitySelect.value }).catch(console.error);
        });
        tmdbKeyInput?.addEventListener('change', () => {
            API.settings.update({ tmdbApiKey: tmdbKeyInput.value.trim() }).catch(console.error);
        });

        // Catalog region: confirmed user preference. Locale/IP suggestions never write it.
        const countrySelect = document.getElementById('setting-country');
        if (countrySelect) {
            const regionApi = window.NorvaCloud?.regions;
            const hint = countrySelect.parentElement?.querySelector('.setting-hint');
            const baseHint = hint?.textContent || 'Catalog region changes only the presentation order, not access.';
            const applyResolution = () => {
                const resolution = regionApi?.resolve?.() || { region: 'FR', status: 'inferred', source: 'fallback' };
                const value = String(resolution.region || 'FR').toUpperCase();
                if (![...countrySelect.options].some(o => o.value === value)) {
                    countrySelect.add(new Option(regionApi?.label?.(value) || value, value));
                }
                countrySelect.value = value;
                if (hint) {
                    const englishState = resolution.status === 'confirmed'
                        ? `Confirmed preference (${regionApi?.label?.(value) || value}).`
                        : `Suggested region (${regionApi?.label?.(value) || value}) until you confirm a choice.`;
                    hint.textContent = `${baseHint} ${englishState}`;
                }
            };
            applyResolution();

            countrySelect.addEventListener('change', async () => {
                const value = countrySelect.value;
                countrySelect.disabled = true;
                const originalHint = hint?.textContent;
                if (hint) hint.textContent = `Syncing catalog for ${regionApi?.label?.(value) || value}...`;
                try {
                    if (regionApi?.setPreferred) {
                        await regionApi.setPreferred(value);
                    } else {
                        localStorage.setItem('norva-preferred-content-region', value);
                        localStorage.setItem('norva-country', value);
                        localStorage.removeItem('norva-content-region-prompt-dismissed');
                        localStorage.setItem('norva-content-region-state', JSON.stringify({
                            region: value,
                            status: 'confirmed',
                            source: 'settings-fallback',
                            suggestedRegion: '',
                            updatedAt: new Date().toISOString()
                        }));
                    }
                    const sources = await API.sources.getAll();
                    for (const src of (sources || [])) {
                        try { await API.sources.sync(src.id); } catch (e) { console.warn('[country] resync failed for', src.id, e); }
                    }
                    try { await window.app?.channelList?.loadChannels?.(); } catch (e) { }
                } finally {
                    countrySelect.disabled = false;
                    if (hint && originalHint) hint.textContent = originalHint;
                    applyResolution();
                }
            });
        }

        const formatStatus = (st) => {
            if (st.running) {
                return `Enriching… ${st.processed}/${st.total} titles (${st.matched} matched)`;
            }
            if (st.finishedAt) {
                const errors = st.failed ? `, ${st.failed} errors` : '';
                return `Last run: ${st.matched}/${st.total || 0} matched${errors}.`;
            }
            return 'Runs automatically after each sync when a TMDB key is set.';
        };

        let pollTimer = null;
        const pollStatus = () => {
            clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
                try {
                    const st = await API.tmdb.status();
                    if (statusHint) statusHint.textContent = formatStatus(st);
                    if (enrichBtn) enrichBtn.textContent = st.running ? 'Running…' : 'Enrich Now';
                    if (!st.running) clearInterval(pollTimer);
                } catch (e) {
                    clearInterval(pollTimer);
                }
            }, 2000);
        };

        // Show current status on load
        API.tmdb.status().then(st => {
            if (statusHint) statusHint.textContent = formatStatus(st);
            if (st.running) {
                if (enrichBtn) enrichBtn.textContent = 'Running…';
                pollStatus();
            }
        }).catch(() => { });

        resetBrokenBtn?.addEventListener('click', async () => {
            try {
                resetBrokenBtn.disabled = true;
                resetBrokenBtn.textContent = 'Restoring…';
                const res = await fetch('/api/playback-status/reset-connection-errors', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    const n = data.reset;
                    if (resetBrokenHint) resetBrokenHint.textContent = n > 0
                        ? `${n} title${n > 1 ? 's' : ''} restored. Reload Movies/Series to see them again.`
                        : 'No incorrectly hidden titles found — nothing to restore.';
                    resetBrokenBtn.textContent = 'Done';
                } else {
                    if (resetBrokenHint) resetBrokenHint.textContent = 'Error: ' + (data.error || 'unknown');
                    resetBrokenBtn.textContent = 'Restore titles';
                    resetBrokenBtn.disabled = false;
                }
            } catch (err) {
                if (resetBrokenHint) resetBrokenHint.textContent = 'Error: ' + err.message;
                resetBrokenBtn.textContent = 'Restore titles';
                resetBrokenBtn.disabled = false;
            }
        });

        enrichBtn?.addEventListener('click', async () => {
            try {
                // Make sure the latest key is saved before starting
                if (tmdbKeyInput) {
                    await API.settings.update({ tmdbApiKey: tmdbKeyInput.value.trim() });
                }
                const result = await API.tmdb.enrich();
                if (result.started) {
                    enrichBtn.textContent = 'Running…';
                    if (statusHint) statusHint.textContent = 'Starting enrichment…';
                    pollStatus();
                } else if (result.reason === 'no-api-key') {
                    if (statusHint) statusHint.textContent = 'Add a TMDB API key first.';
                } else if (result.reason === 'already-running') {
                    pollStatus();
                }
            } catch (err) {
                if (statusHint) statusHint.textContent = `Error: ${err.message}`;
            }
        });
    }

    async initTranscodingSettings() {
        // Encoder settings
        const hwEncoderSelect = document.getElementById('setting-hw-encoder');
        const maxResolutionSelect = document.getElementById('setting-max-resolution');
        const qualitySelect = document.getElementById('setting-quality');

        // Stream processing (use -tc suffix IDs from Transcoding tab)
        const forceProxyToggle = document.getElementById('setting-force-proxy-tc');
        const autoTranscodeToggle = document.getElementById('setting-auto-transcode-tc');
        const forceTranscodeToggle = document.getElementById('setting-force-transcode-tc');
        const forceVideoTranscodeToggle = document.getElementById('setting-force-video-transcode-tc');
        const forceRemuxToggle = document.getElementById('setting-force-remux-tc');
        const streamFormatSelect = document.getElementById('setting-stream-format-tc');

        // User-Agent (Transcoding tab versions)
        const userAgentSelect = document.getElementById('setting-user-agent-tc');
        const userAgentCustomInput = document.getElementById('setting-user-agent-custom-tc');
        const customUaContainer = document.getElementById('custom-user-agent-container-tc');

        // Fetch settings directly from API to avoid race condition with VideoPlayer
        let s;
        try {
            s = await API.settings.get();
        } catch (err) {
            console.warn('[Settings] Failed to load settings from API, using player defaults:', err);
            s = this.app.player?.settings || {};
        }

        if (hwEncoderSelect) hwEncoderSelect.value = s.hwEncoder || 'auto';
        if (maxResolutionSelect) maxResolutionSelect.value = s.maxResolution || '1080p';
        if (qualitySelect) qualitySelect.value = s.quality || 'medium';
        if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy === true;
        if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode !== false;
        if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode === true;
        if (forceVideoTranscodeToggle) forceVideoTranscodeToggle.checked = s.forceVideoTranscode === true;
        if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
        if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';
        if (userAgentSelect) userAgentSelect.value = s.userAgentPreset || 'chrome';
        if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        if (customUaContainer) {
            customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
        }

        // Event listeners for encoder settings
        hwEncoderSelect?.addEventListener('change', () => {
            this.app.player.settings.hwEncoder = hwEncoderSelect.value;
            this.app.player.saveSettings();
        });

        maxResolutionSelect?.addEventListener('change', () => {
            this.app.player.settings.maxResolution = maxResolutionSelect.value;
            this.app.player.saveSettings();
        });

        qualitySelect?.addEventListener('change', () => {
            this.app.player.settings.quality = qualitySelect.value;
            this.app.player.saveSettings();
        });

        // Audio Mix Preset
        const audioMixSelect = document.getElementById('setting-audio-mix');
        if (audioMixSelect) {
            audioMixSelect.value = s.audioMixPreset || 'auto';
            audioMixSelect.addEventListener('change', () => {
                this.app.player.settings.audioMixPreset = audioMixSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Upscaling Settings
        const upscaleEnabledToggle = document.getElementById('setting-upscale-enabled');
        const upscaleMethodSelect = document.getElementById('setting-upscale-method');
        const upscaleTargetSelect = document.getElementById('setting-upscale-target');
        const upscaleMethodContainer = document.getElementById('upscale-method-container');
        const upscaleTargetContainer = document.getElementById('upscale-target-container');

        // Helper to toggle upscale options visibility
        const toggleUpscaleOptions = (enabled) => {
            if (upscaleMethodContainer) upscaleMethodContainer.style.display = enabled ? 'flex' : 'none';
            if (upscaleTargetContainer) upscaleTargetContainer.style.display = enabled ? 'flex' : 'none';
        };

        // Load upscaling settings
        if (upscaleEnabledToggle) {
            upscaleEnabledToggle.checked = s.upscaleEnabled || false;
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        }
        if (upscaleMethodSelect) upscaleMethodSelect.value = s.upscaleMethod || 'hardware';
        if (upscaleTargetSelect) upscaleTargetSelect.value = s.upscaleTarget || '1080p';

        // Upscaling event handlers
        upscaleEnabledToggle?.addEventListener('change', () => {
            this.app.player.settings.upscaleEnabled = upscaleEnabledToggle.checked;
            this.app.player.saveSettings();
            toggleUpscaleOptions(upscaleEnabledToggle.checked);
        });

        upscaleMethodSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleMethod = upscaleMethodSelect.value;
            this.app.player.saveSettings();
        });

        upscaleTargetSelect?.addEventListener('change', () => {
            this.app.player.settings.upscaleTarget = upscaleTargetSelect.value;
            this.app.player.saveSettings();
        });

        // Stream processing toggles
        forceProxyToggle?.addEventListener('change', () => {
            this.app.player.settings.forceProxy = forceProxyToggle.checked;
            this.app.player.saveSettings();
        });

        autoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.autoTranscode = autoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceTranscode = forceTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceVideoTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceVideoTranscode = forceVideoTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        forceRemuxToggle?.addEventListener('change', () => {
            this.app.player.settings.forceRemux = forceRemuxToggle.checked;
            this.app.player.saveSettings();
        });

        streamFormatSelect?.addEventListener('change', () => {
            this.app.player.settings.streamFormat = streamFormatSelect.value;
            this.app.player.saveSettings();
        });

        // User-Agent handlers
        const toggleCustomInput = () => {
            if (customUaContainer) {
                customUaContainer.style.display = userAgentSelect?.value === 'custom' ? 'flex' : 'none';
            }
        };

        userAgentSelect?.addEventListener('change', () => {
            this.app.player.settings.userAgentPreset = userAgentSelect.value;
            this.app.player.saveSettings();
            toggleCustomInput();
        });

        userAgentCustomInput?.addEventListener('change', () => {
            this.app.player.settings.userAgentCustom = userAgentCustomInput.value;
            this.app.player.saveSettings();
        });
    }

    /**
     * Load and display hardware info in Transcoding tab
     */
    async loadHardwareInfo() {
        const container = document.getElementById('hw-info-container');
        if (!container) return;

        try {
            const response = await fetch('/api/settings/hw-info');
            if (!response.ok) throw new Error('Failed to fetch hardware info');
            const hwInfo = await response.json();

            const detected = [];

            // Only show detected hardware
            if (hwInfo.nvidia?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ NVIDIA</span>
                    <span class="hw-name">${hwInfo.nvidia.name}</span>
                </div>`);
            }

            if (hwInfo.amf?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ AMD</span>
                    <span class="hw-name">${hwInfo.amf.name || 'Available'}</span>
                </div>`);
            }

            if (hwInfo.qsv?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ Intel QSV</span>
                    <span class="hw-name">Available</span>
                </div>`);
            }

            if (hwInfo.vaapi?.available) {
                detected.push(`<div class="hw-info-item hw-available">
                    <span class="hw-badge">✓ VAAPI</span>
                    <span class="hw-name">${hwInfo.vaapi.device || 'Available'}</span>
                </div>`);
            }

            let html;
            if (detected.length > 0) {
                html = `<div class="hw-info-grid">${detected.join('')}</div>`;
                html += `<p class="hint" style="margin-top: var(--space-sm);">Recommended encoder: <strong>${hwInfo.recommended}</strong></p>`;
            } else {
                html = `<p class="hint">No GPU acceleration detected. Using software encoding.</p>`;
            }

            container.innerHTML = html;
        } catch (err) {
            console.error('Error loading hardware info:', err);
            container.innerHTML = '<p class="hint error">Failed to load hardware info</p>';
        }
    }

    initUserManagement() {
        // User tab visibility is handled in show() method
        // when currentUser is available

        // Handle add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();

                const username = document.getElementById('new-username').value;
                const password = document.getElementById('new-password').value;
                const role = document.getElementById('new-role').value;

                try {
                    await API.users.create({ username, password, role });
                    alert('User created successfully!');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    alert('Error creating user: ' + err.message);
                }
            });
        }
    }

    async loadUsers() {
        const userList = document.getElementById('user-list');
        if (!userList) return;

        try {
            const users = await API.users.getAll();
            // Store users in memory for easy access during edit
            this.users = users;

            if (users.length === 0) {
                userList.innerHTML = '<tr><td colspan="5" class="hint">No users found</td></tr>';
                return;
            }

            userList.innerHTML = users.map(user => {
                const isSSO = !!user.oidcId;
                const typeBadge = isSSO
                    ? '<span class="user-badge user-badge-sso">SSO</span>'
                    : '<span class="user-badge user-badge-local">Local</span>';

                const roleBadge = user.role === 'admin'
                    ? '<span class="user-badge user-badge-admin">Admin</span>'
                    : '<span class="user-badge user-badge-viewer">Viewer</span>';

                return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <strong>${user.username}</strong>
                            ${typeBadge}
                        </div>
                    </td>
                    <td>${user.email || '<span class="hint">-</span>'}</td>
                    <td>${roleBadge}</td>
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="window.app.pages.settings.openEditUserModal(${user.id})">Edit</button>
                        <button class="btn btn-sm btn-error" onclick="window.app.pages.settings.deleteUser(${user.id}, '${user.username}')">Delete</button>
                    </td>
                </tr>
            `}).join('');
        } catch (err) {
            console.error('Error loading users:', err);
            userList.innerHTML = '<tr><td colspan="5" class="hint">Error loading users</td></tr>';
        }
    }

    openEditUserModal(userId) {
        console.log('openEditUserModal called with ID:', userId, 'Type:', typeof userId);
        console.log('Current users list:', this.users);

        const user = this.users.find(u => u.id === userId);
        if (!user) {
            console.error('User not found in this.users cache!');
            console.log('Available IDs:', this.users.map(u => u.id));
            return;
        }
        console.log('User found:', user);

        const modal = document.getElementById('edit-user-modal');
        console.log('Modal element:', modal);
        if (!modal) {
            console.error('CRITICAL: Modal element #edit-user-modal not found in DOM!');
            alert('Error: Modal not found. Please refresh the page.');
            return;
        }

        const isSSO = !!user.oidcId;
        console.log('Is SSO user:', isSSO);

        // Populate form with null checks
        try {
            const editId = document.getElementById('edit-user-id');
            const editUsername = document.getElementById('edit-username');
            const editEmail = document.getElementById('edit-email');
            const editRole = document.getElementById('edit-role');
            const editPassword = document.getElementById('edit-password');

            console.log('Form elements found:', { editId, editUsername, editEmail, editRole, editPassword });

            if (editId) editId.value = user.id;
            if (editUsername) editUsername.value = user.username;
            if (editEmail) editEmail.value = user.email || '';
            if (editRole) editRole.value = user.role;
            if (editPassword) editPassword.value = '';

            // Handle SSO specific UI
            const passwordHint = document.getElementById('edit-password-hint');
            const oidcGroup = document.getElementById('oidc-info-group');
            const oidcIdDisplay = document.getElementById('edit-oidc-id');

            if (isSSO) {
                if (editPassword) {
                    editPassword.disabled = true;
                    editPassword.placeholder = "Managed by SSO Provider";
                }
                if (passwordHint) passwordHint.textContent = "Password cannot be changed for SSO users.";
                if (oidcGroup) oidcGroup.classList.remove('hidden');
                if (oidcIdDisplay) oidcIdDisplay.textContent = user.oidcId;
            } else {
                if (editPassword) {
                    editPassword.disabled = false;
                    editPassword.placeholder = "Leave blank to keep current";
                }
                if (passwordHint) passwordHint.textContent = "Optional. Leave blank to keep unchanged.";
                if (oidcGroup) oidcGroup.classList.add('hidden');
            }

            // Show modal
            console.log('Adding active class to modal...');
            modal.classList.add('active');
            console.log('Modal classes after add:', modal.classList.toString());

            // Setup Close/Cancel handlers (once)
            this.setupModalHandlers(modal);
            console.log('Modal should now be visible!');
        } catch (err) {
            console.error('Error populating modal:', err);
            alert('Error opening edit modal: ' + err.message);
        }
    }

    setupModalHandlers(modal) {
        if (this.modalHandlersSetup) return;

        const closeBtn = document.getElementById('edit-user-close');
        const cancelBtn = document.getElementById('edit-user-cancel');
        const saveBtn = document.getElementById('edit-user-save');

        const closeModal = () => modal.classList.remove('active');

        closeBtn.onclick = closeModal;
        cancelBtn.onclick = closeModal;

        // Click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };

        // Save Handler
        saveBtn.onclick = async () => {
            const userId = document.getElementById('edit-user-id').value;
            const updates = {
                username: document.getElementById('edit-username').value,
                role: document.getElementById('edit-role').value
            };

            const newPassword = document.getElementById('edit-password').value;
            if (newPassword && !document.getElementById('edit-password').disabled) {
                updates.password = newPassword;
            }

            try {
                await API.users.update(userId, updates);
                // alert('User updated successfully!'); // Optional: Replace with toast?
                closeModal();
                this.loadUsers();
            } catch (err) {
                alert('Error updating user: ' + err.message);
            }
        };

        this.modalHandlersSetup = true;
    }


    async deleteUser(userId, username) {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }

        try {
            await API.users.delete(userId);
            this.loadUsers();
        } catch (err) {
            alert('Error deleting user: ' + err.message);
        }
    }

    switchTab(tabName) {
        this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        this.tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));

        // Load content browser when switching to that tab
        if (tabName === 'content') {
            this.app.sourceManager.loadContentSources();
        }

        if (tabName === 'account') {
            this.refreshAccountSettings();
        }

        // Load users when switching to users tab
        if (tabName === 'users') {
            this.loadUsers();
        }

        // Load hardware info when switching to transcode tab
        if (tabName === 'transcode') {
            this.loadHardwareInfo();
        }
    }

    async show() {
        // Local hub user management stays available to local admins only.
        const usersTab = document.getElementById('users-tab');
        const canManageLocalUsers = this.app.currentUser?.role === 'admin' && !this.app.currentUser?.cloud;
        if (usersTab) {
            usersTab.style.display = canManageLocalUsers ? 'block' : 'none';
            if (!canManageLocalUsers && usersTab.classList.contains('active')) {
                this.switchTab('account');
            }
        }

        // Load sources when page is shown
        await this.app.sourceManager.loadSources();
        await this.refreshAccountSettings();

        // Refresh ALL player settings from server
        if (this.app.player?.settings) {
            const s = this.app.player.settings;

            // Player settings
            const arrowKeysToggle = document.getElementById('setting-arrow-keys');
            const overlayDurationInput = document.getElementById('setting-overlay-duration');
            const defaultVolumeSlider = document.getElementById('setting-default-volume');
            const volumeValueDisplay = document.getElementById('volume-value');
            const rememberVolumeToggle = document.getElementById('setting-remember-volume');
            const autoPlayNextToggle = document.getElementById('setting-autoplay-next');
            const forceProxyToggle = document.getElementById('setting-force-proxy');
            const forceTranscodeToggle = document.getElementById('setting-force-transcode');
            const forceRemuxToggle = document.getElementById('setting-force-remux');
            const autoTranscodeToggle = document.getElementById('setting-auto-transcode');
            const epgRefreshSelect = document.getElementById('epg-refresh-interval');
            const streamFormatSelect = document.getElementById('setting-stream-format');

            if (arrowKeysToggle) arrowKeysToggle.checked = s.arrowKeysChangeChannel;
            if (overlayDurationInput) overlayDurationInput.value = s.overlayDuration;
            if (defaultVolumeSlider) defaultVolumeSlider.value = s.defaultVolume;
            if (volumeValueDisplay) volumeValueDisplay.textContent = s.defaultVolume + '%';
            if (rememberVolumeToggle) rememberVolumeToggle.checked = s.rememberVolume;
            if (autoPlayNextToggle) autoPlayNextToggle.checked = s.autoPlayNextEpisode;
            if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy || false;
            if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode || false;
            if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
            if (autoTranscodeToggle) autoTranscodeToggle.checked = s.autoTranscode || false;
            if (epgRefreshSelect) epgRefreshSelect.value = s.epgRefreshInterval || '24';
            if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';

            // User-Agent settings
            const userAgentSelect = document.getElementById('setting-user-agent');
            const userAgentCustomInput = document.getElementById('setting-user-agent-custom');
            const customUaContainer = document.getElementById('custom-user-agent-container');
            if (userAgentSelect) {
                userAgentSelect.value = s.userAgentPreset || 'chrome';
                if (customUaContainer) {
                    customUaContainer.style.display = userAgentSelect.value === 'custom' ? 'flex' : 'none';
                }
            }
            if (userAgentCustomInput) userAgentCustomInput.value = s.userAgentCustom || '';
        }

        // Update EPG last refreshed display
        this.updateEpgLastRefreshed();
    }

    /**
     * Update the EPG last refreshed display
     */
    async updateEpgLastRefreshed() {
        const display = document.getElementById('epg-last-refreshed');
        if (!display) return;

        try {
            const data = await API.settings.getSyncStatus();

            if (data.lastSyncTime) {
                const lastRefreshTime = new Date(data.lastSyncTime);

                // Format as relative time or absolute
                const now = new Date();
                const diffMs = now - lastRefreshTime;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMins / 60);

                let text;
                if (diffMins < 1) {
                    text = 'Just now';
                } else if (diffMins < 60) {
                    text = `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
                } else if (diffHours < 24) {
                    text = `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
                } else {
                    // Use absolute time for older refreshes
                    text = lastRefreshTime.toLocaleString();
                }

                display.textContent = text;
                display.title = lastRefreshTime.toLocaleString(); // Full timestamp on hover
            } else {
                display.textContent = 'Never';
                display.title = 'Sync has not run yet since server started';
            }
        } catch (err) {
            console.debug('Sync status unavailable:', err);
            display.textContent = 'Unknown';
            display.title = 'Could not fetch sync status';
        }
    }

    hide() {
        // Page is hidden
    }
}

window.SettingsPage = SettingsPage;
