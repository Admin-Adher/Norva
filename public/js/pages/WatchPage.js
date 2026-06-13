/**
 * Watch Page Controller
 * Handles VOD (Movies/Series) playback with streaming service-style UI
 */

class WatchPage {
    constructor(app) {
        this.app = app;

        // Video elements
        this.video = document.getElementById('watch-video');
        this.overlay = document.getElementById('watch-overlay');

        // iOS: ensure inline playback (not fullscreen by default)
        if (this.video) {
            this.video.setAttribute('playsinline', '');
            this.video.setAttribute('webkit-playsinline', '');
        }

        // Top bar
        this.backBtn = document.getElementById('watch-back-btn');
        this.titleEl = document.getElementById('watch-title');
        this.subtitleEl = document.getElementById('watch-subtitle');

        // Controls
        this.centerPlayBtn = document.getElementById('watch-center-play');
        this.playPauseBtn = document.getElementById('watch-play-pause');
        this.skipBackBtn = document.getElementById('watch-skip-back');
        this.skipFwdBtn = document.getElementById('watch-skip-fwd');
        this.muteBtn = document.getElementById('watch-mute');
        this.volumeSlider = document.getElementById('watch-volume');
        this.fullscreenBtn = document.getElementById('watch-fullscreen');
        this.progressSlider = document.getElementById('watch-progress');
        this.progressContainer = document.querySelector('.watch-progress-container');
        this.timeCurrent = document.getElementById('watch-time-current');
        this.timeTotal = document.getElementById('watch-time-total');
        this.scrollHint = document.getElementById('watch-scroll-hint');
        this.loadingSpinner = document.getElementById('watch-loading');

        // Next episode
        this.nextEpisodePanel = document.getElementById('watch-next-episode');
        this.nextEpisodeTitle = document.getElementById('next-episode-title');
        this.nextCountdown = document.getElementById('next-countdown');
        this.nextPlayNowBtn = document.getElementById('next-play-now');
        this.nextCancelBtn = document.getElementById('next-cancel');

        // Details section
        this.posterEl = document.getElementById('watch-poster');
        this.contentTitleEl = document.getElementById('watch-content-title');
        this.yearEl = document.getElementById('watch-year');
        this.ratingEl = document.getElementById('watch-rating');
        this.durationEl = document.getElementById('watch-duration');
        this.descriptionEl = document.getElementById('watch-description');
        this.playBtn = document.getElementById('watch-play-btn');
        this.playBtnText = document.getElementById('watch-play-btn-text');
        this.favoriteBtn = document.getElementById('watch-favorite-btn');

        // Recommended / Episodes
        this.recommendedSection = document.getElementById('watch-recommended');
        this.recommendedGrid = document.getElementById('watch-recommended-grid');
        this.episodesSection = document.getElementById('watch-episodes');
        this.seasonsContainer = document.getElementById('watch-seasons');

        // Captions
        this.audioBtn = document.getElementById('watch-audio-btn');
        this.audioMenu = document.getElementById('watch-audio-menu');
        this.audioList = document.getElementById('watch-audio-list');
        this.captionsBtn = document.getElementById('watch-captions-btn');
        this.captionsMenu = document.getElementById('watch-captions-menu');
        this.captionsList = document.getElementById('watch-captions-list');

        // Transcode Status
        this.transcodeStatusEx = document.getElementById('watch-transcode-status');
        this.qualityBadgeEl = document.getElementById('watch-quality-badge');

        // State
        this.hls = null;
        this.content = null;
        this.contentType = null; // 'movie' or 'series'
        this.seriesInfo = null;
        this.currentSeason = null;
        this.currentEpisode = null;
        this.isFavorite = false;
        this.returnPage = null;
        this.audioMenuOpen = false;
        this.captionsMenuOpen = false;
        this.baseStreamUrl = null;
        this.currentPlaybackMode = null;
        this.currentProcessingOptions = {};
        this.probeDuration = null;
        this.streamStartOffset = 0;
        this.audioTracks = [];
        this.subtitleTracks = [];
        this.subtitleSourceUrl = null;
        this.subtitleStartOffset = 0;
        this.selectedSubtitleStreamIndex = null;
        this.selectedAudioStreamIndex = null;
        this.selectedAudioTrackUserChoice = false;
        this._videoEncodeFallbackTried = false;
        this._playbackAttemptId = 0;
        this._playbackStatusOkReported = false;
        this._seekDebounceTimer = null;
        this._pendingSeekTarget = null;
        this.currentSessionId = null;
        this.activeSessionIds = new Set();
        this.currentCloudPlaybackSessionId = null;
        this.activeCloudPlaybackSessionIds = new Set();

        // Overlay timer
        this.overlayTimeout = null;
        this.overlayVisible = true;

        // Next episode
        this.nextEpisodeTimeout = null;
        this.nextEpisodeCountdown = 10;
        this.nextEpisodeInterval = null;
        this.nextEpisodeShowing = false;
        this.nextEpisodeDismissed = false;

        // Watch history
        this.historyInterval = null;

        this.init();
    }

    init() {
        // iOS Safari: detect and compensate for floating bottom toolbar
        const updateIosUiBottom = () => {
            let uiBottom = 0;
            if (window.visualViewport) {
                const vv = window.visualViewport;
                uiBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
            }
            document.documentElement.style.setProperty('--ios-ui-bottom', uiBottom + 'px');
        };

        updateIosUiBottom();

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateIosUiBottom);
            window.visualViewport.addEventListener('scroll', updateIosUiBottom);
        } else {
            window.addEventListener('resize', updateIosUiBottom);
        }

        // iOS: use custom --vh unit to avoid 100vh issues with dynamic toolbar
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
        const watchVideoSection = document.querySelector('.watch-video-section');
        if (isIOS && watchVideoSection) {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
            watchVideoSection.style.height = 'calc(var(--vh) * 100)';
        }

        // Apply safe area + iOS toolbar padding to overlay
        if (this.overlay) {
            this.overlay.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + var(--ios-ui-bottom, 0px) + 12px)';
        }

        // Back button
        this.backBtn?.addEventListener('click', () => this.goBack());

        // Play/Pause
        this.centerPlayBtn?.addEventListener('click', () => this.togglePlay());
        this.playPauseBtn?.addEventListener('click', () => this.togglePlay());
        this.video?.addEventListener('click', () => this.togglePlay());

        // Skip buttons
        this.skipBackBtn?.addEventListener('click', () => this.skip(-10));
        this.skipFwdBtn?.addEventListener('click', () => this.skip(10));

        // Volume
        this.muteBtn?.addEventListener('click', () => this.toggleMute());
        this.volumeSlider?.addEventListener('input', (e) => this.setVolume(e.target.value));

        // Fullscreen
        this.fullscreenBtn?.addEventListener('click', () => this.toggleFullscreen());

        // Picture-in-Picture
        const pipBtn = document.getElementById('watch-pip');
        pipBtn?.addEventListener('click', () => this.togglePictureInPicture());

        // Overflow Menu
        const overflowBtn = document.getElementById('watch-overflow');
        const overflowMenu = document.getElementById('watch-overflow-menu');

        overflowBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const copyUrlBtn = document.getElementById('watch-copy-url');
        copyUrlBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== overflowBtn) {
                overflowMenu.classList.add('hidden');
            }
        });

        // Progress bar
        this.progressSlider?.addEventListener('input', (e) => this.seek(e.target.value));

        // Video events
        this.video?.addEventListener('timeupdate', () => {
            this.updateProgress();
            this.markPlaybackUsable();
        });
        this.video?.addEventListener('loadedmetadata', () => {
            this.onMetadataLoaded();
            this.markPlaybackUsable();
        });
        this.video?.addEventListener('loadeddata', () => this.markPlaybackUsable());
        this.video?.addEventListener('durationchange', () => this.updateDurationState());
        this.video?.addEventListener('play', () => this.onPlay());
        this.video?.addEventListener('playing', () => this.markPlaybackUsable());
        this.video?.addEventListener('pause', () => this.onPause());
        this.video?.addEventListener('ended', () => this.onEnded());
        this.video?.addEventListener('error', (e) => this.onError(e));
        this.video?.addEventListener('waiting', () => this.showLoading());
        this.video?.addEventListener('canplay', () => this.markPlaybackUsable());

        // Overlay auto-hide + click to toggle play
        const watchSection = document.querySelector('.watch-video-section');
        watchSection?.addEventListener('mousemove', () => this.showOverlay());
        watchSection?.addEventListener('touchstart', () => this.showOverlay());
        watchSection?.addEventListener('click', (e) => {
            this.showOverlay();
            // Only toggle play if clicking on video area (not controls)
            if (e.target === this.video || e.target === watchSection ||
                e.target.classList.contains('watch-overlay') || e.target === this.overlay) {
                this.togglePlay();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Details section buttons
        this.playBtn?.addEventListener('click', () => this.scrollToVideo());
        this.favoriteBtn?.addEventListener('click', () => this.toggleFavorite());

        // Next episode buttons
        this.nextPlayNowBtn?.addEventListener('click', () => this.playNextEpisode());
        this.nextCancelBtn?.addEventListener('click', () => this.cancelNextEpisode());

        // Audio track toggle
        this.audioBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleAudioMenu();
        });

        // Captions toggle
        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        // Close track menus when clicking outside
        document.addEventListener('click', (e) => {
            if (this.audioMenuOpen && !this.audioMenu?.contains(e.target) && e.target !== this.audioBtn) {
                this.closeAudioMenu();
            }
            if (this.captionsMenuOpen && !this.captionsMenu?.contains(e.target) && e.target !== this.captionsBtn) {
                this.closeCaptionsMenu();
            }
        });

        // Hide scroll hint after scrolling
        const watchPage = document.getElementById('page-watch');
        watchPage?.addEventListener('scroll', () => {
            if (watchPage.scrollTop > 50) {
                this.scrollHint?.classList.add('hidden');
            } else {
                this.scrollHint?.classList.remove('hidden');
            }
        });

        this.updateDurationState();
    }

    /**
     * Main entry point - play content
     * @param {Object} content - Movie or episode info
     * @param {string} streamUrl - Stream URL
     * @param {Object} playback - Cloud playback metadata
     */
    async play(content, streamUrl, playback = {}) {
        const playbackAttemptId = this.beginPlaybackAttempt();
        const cloudPlaybackSessionId = playback.sessionId
            || playback.cloudPlaybackSessionId
            || content.cloudPlaybackSessionId
            || content.playbackSessionId
            || null;
        if (cloudPlaybackSessionId) {
            content.cloudPlaybackSessionId = cloudPlaybackSessionId;
        }

        this.content = content;
        this.contentType = content.type;
        this.seriesInfo = content.seriesInfo || null;
        this.currentSeason = content.currentSeason || null;
        this.currentEpisode = content.currentEpisode || null;
        this.resumeTime = content.resumeTime || 0;
        this.containerExtension = content.containerExtension || 'mp4';
        this.returnPage = content.type === 'movie' ? 'movies' : 'series';
        // Known total duration (TMDB runtime / episode duration) used as a
        // timeline fallback when ffprobe can't determine the duration
        this.durationHint = this.normalizeDuration(content.durationHint);
        this.resetTrackSelectionState();

        // Alternate versions of the same title (duplicate group) for failover
        this.versions = Array.isArray(content.versions) && content.versions.length > 1 ? content.versions : null;
        this.versionIndex = content.versionIndex || 0;
        this._failoverInProgress = false;
        this._playbackStatusOkReported = false;
        this._lastFailureMsg = null;

        // Stop any Live TV playback before starting movie/series
        this.app?.player?.stop?.();

        // Reset state
        this.cancelNextEpisode();
        this.nextEpisodeDismissed = false;

        // Navigate to watch page
        this.app.navigateTo('watch', true);

        // Scroll to top
        document.getElementById('page-watch')?.scrollTo(0, 0);

        // Update title bar
        this.titleEl.textContent = content.title || '';
        this.subtitleEl.textContent = content.subtitle || '';

        // Load video
        await this.loadVideo(streamUrl, { cloudPlaybackSessionId, playbackAttemptId });
        if (this.isStalePlaybackAttempt(playbackAttemptId)) return;

        // Show Now Playing indicator in navbar
        this.showNowPlaying(content.title);

        // Populate details section
        this.renderDetails();

        // Load recommended (movies) or episodes (series)
        if (content.type === 'movie') {
            this.episodesSection?.classList.add('hidden');
            this.recommendedSection?.classList.remove('hidden');
            await this.loadRecommended(content.sourceId, content.categoryId);
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
        } else {
            this.recommendedSection?.classList.add('hidden');
            this.episodesSection?.classList.remove('hidden');
            this.renderEpisodes();
        }

        // Check favorite status
        await this.checkFavorite();
        if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
        // Show overlay initially
        this.showOverlay();

        // Start watch history tracking
        this.startHistoryTracking();
    }

    /**
     * Show Now Playing indicator in navbar
     */
    showNowPlaying(title) {
        const indicator = document.getElementById('now-playing-indicator');
        const textEl = document.getElementById('now-playing-text');
        if (indicator && textEl) {
            textEl.textContent = title || 'Now Playing';
            indicator.classList.remove('hidden');
        }
    }

    /**
     * Hide Now Playing indicator in navbar
     */
    hideNowPlaying() {
        const indicator = document.getElementById('now-playing-indicator');
        if (indicator) {
            indicator.classList.add('hidden');
        }
    }

    beginPlaybackAttempt() {
        this._playbackAttemptId += 1;
        return this._playbackAttemptId;
    }

    isStalePlaybackAttempt(attemptId) {
        return Number.isFinite(attemptId) && attemptId !== this._playbackAttemptId;
    }

    async cleanupStaleCloudPlaybackSession(sessionId) {
        const id = sessionId ? String(sessionId).trim() : '';
        if (!id) return;
        try {
            await window.NorvaCloud?.playback?.expireSession?.(id);
        } catch (error) {
            console.warn('[WatchPage] Could not expire stale cloud playback session:', error?.message || error);
        }
    }

    resetTrackSelectionState() {
        this.audioTracks = [];
        this.subtitleTracks = [];
        this.subtitleSourceUrl = null;
        this.subtitleStartOffset = 0;
        this.selectedSubtitleStreamIndex = null;
        this.selectedAudioStreamIndex = null;
        this.selectedAudioTrackUserChoice = false;
        this.closeAudioMenu();
        this.closeCaptionsMenu();
        this.updateAudioTracks();
        this.updateCaptionsTracks();
    }

    /**
     * Start a HLS transcode session
     */
    async startTranscodeSession(url, options = {}) {
        try {
            console.log('[WatchPage] Starting HLS transcode session...', options);
            const subtitleTracks = this.getSubtitleExtractionTracks()
                .map(t => ({ index: t.index, codec: t.codec }));
            const res = await fetch('/api/transcode/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    seekOffset: options.seekOffset ?? this.resumeTime, // Pass resume point to backend
                    ...options,
                    // Text subtitle tracks extracted in-process alongside the video
                    // (no extra provider connection)
                    subtitleTracks
                })
            });
            if (!res.ok) {
                let payload = {};
                try {
                    payload = await res.json();
                } catch (e) { /* non-JSON error body */ }
                const detail = payload.error || payload.details || 'Failed to start session';
                const error = new Error(detail);
                error.details = payload.details;
                error.code = payload.code;
                error.upstreamStatus = payload.upstreamStatus;
                error.terminal = Boolean(payload.terminal);
                error.payload = payload;
                error.fromSessionResponse = true;
                error.httpStatus = res.status;
                throw error;
            }
            const session = await res.json();
            this.currentSessionId = session.sessionId;
            this.activeSessionIds.add(session.sessionId);

            // Subtitles were attached before the session existed (or belong to a
            // previous session after a seek-restart): re-bind the selected track
            // to this session's in-process .vtt files
            if (this.selectedSubtitleStreamIndex !== null && this.selectedSubtitleStreamIndex !== undefined) {
                setTimeout(() => this.attachSelectedProbeSubtitleTrack(), 0);
            }
            return session.playlistUrl;
        } catch (err) {
            const errorText = this.getErrorText(err);
            console.error('[WatchPage] Session start failed:', errorText);
            // Upstream refused the stream (dead link, expired account, IP ban):
            // a direct-transcode fallback would hit the same wall — fail over
            // to another version / show an error instead.
            if (err?.terminal || err?.fromSessionResponse || this.isTerminalPlaybackError(errorText)) {
                this._lastFailureMsg = this.sanitizePlaybackMessage(errorText);
                return null;
            }
            // Other failures (session infra): fallback to direct transcode
            const startOffset = options.seekOffset ?? this.resumeTime ?? 0;
            this.currentPlaybackMode = 'transcode';
            this.streamStartOffset = startOffset;
            return this.getTranscodeUrl(url, startOffset, options);
        }
    }

    isCloudPlaybackMode() {
        try {
            return Boolean(window.API?.isCloudMode?.());
        } catch (_) {
            return false;
        }
    }

    isGatewayPlaybackUrl(url) {
        const value = String(url || '');
        return /\/sessions\/[^/?#]+\/playlist\.m3u8/i.test(value);
    }

    isLikelyPlaybackUrl(url) {
        const value = String(url || '').trim();
        if (!value || value === 'undefined' || value === 'null') return false;
        if (/^(blob:|data:|\/api\/|\/sessions\/)/i.test(value)) return true;
        if (!/^https?:\/\//i.test(value)) return false;

        try {
            const parsed = new URL(value, window.location.href);
            if (parsed.origin === window.location.origin) {
                const path = parsed.pathname.replace(/\/+$/, '') || '/';
                if (path === '/' || path === '/index.html' || path === '/account.html' || path === '/cloud.html') {
                    return false;
                }
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    getCloudSafeSettings(settings = {}) {
        if (!this.isCloudPlaybackMode()) return settings || {};

        // The hosted Cloud app has no local FFmpeg API. Playback decisions are
        // already made by Norva Cloud when it returns direct/relay/gateway URLs.
        return {
            ...(settings || {}),
            autoTranscode: false,
            forceTranscode: false,
            forceVideoTranscode: false,
            forceRemux: false,
            upscaleEnabled: false
        };
    }

    /**
     * Stop and cleanup current transcode session
     */
    async stopTranscodeSession() {
        const sessionIds = new Set(this.activeSessionIds);
        if (this.currentSessionId) {
            sessionIds.add(this.currentSessionId);
        }

        if (!sessionIds.size) return;

        this.currentSessionId = null;
        this.activeSessionIds.clear();

        await Promise.allSettled(Array.from(sessionIds).map(async (sessionId) => {
            console.log('[WatchPage] Stopping transcode session:', sessionId);
            const res = await fetch(`/api/transcode/${sessionId}`, { method: 'DELETE' });
            if (!res.ok && res.status !== 404) {
                throw new Error(`Failed to stop session ${sessionId}: ${res.status}`);
            }
        })).then(results => {
            results.forEach(result => {
                if (result.status === 'rejected') {
                    console.error(result.reason?.message || 'Failed to stop transcode session');
                }
            });
        });
    }

    registerCloudPlaybackSession(sessionId) {
        const id = sessionId ? String(sessionId).trim() : '';
        if (!id) return;
        this.currentCloudPlaybackSessionId = id;
        this.activeCloudPlaybackSessionIds.add(id);
    }

    async stopCloudPlaybackSessions() {
        const sessionIds = new Set(this.activeCloudPlaybackSessionIds);
        if (this.currentCloudPlaybackSessionId) {
            sessionIds.add(this.currentCloudPlaybackSessionId);
        }

        if (!sessionIds.size) return;

        this.currentCloudPlaybackSessionId = null;
        this.activeCloudPlaybackSessionIds.clear();

        const expireSession = window.NorvaCloud?.playback?.expireSession;
        if (typeof expireSession !== 'function') return;

        await Promise.allSettled(Array.from(sessionIds).map(async (sessionId) => {
            console.log('[WatchPage] Expiring cloud playback session:', sessionId);
            await expireSession(sessionId);
        })).then(results => {
            results.forEach(result => {
                if (result.status === 'rejected') {
                    console.error(result.reason?.message || 'Failed to expire cloud playback session');
                }
            });
        });
    }

    buildProcessingUrl(route, url, start = 0, options = {}) {
        const params = new URLSearchParams({ url });
        const startOffset = this.normalizeDuration(start);
        if (startOffset) {
            params.set('start', String(startOffset));
        }
        const audioStreamIndex = Number.parseInt(options.audioStreamIndex, 10);
        if (Number.isInteger(audioStreamIndex) && audioStreamIndex >= 0) {
            params.set('audioStreamIndex', String(audioStreamIndex));
        }
        return `${route}?${params.toString()}`;
    }

    getTranscodeUrl(url, start = 0, options = this.currentProcessingOptions) {
        return this.buildProcessingUrl('/api/transcode', url, start, options);
    }

    getRemuxUrl(url, start = 0) {
        return this.buildProcessingUrl('/api/remux', url, start);
    }

    canUseLocalProxy(url) {
        if (!url || url.startsWith('/')) return false;

        try {
            const parsed = new URL(url, window.location.href);
            if (parsed.pathname.startsWith('/api/')) return false;
            if (parsed.pathname.startsWith('/relay/')) return false;
            if (parsed.hostname.includes('workers.dev') && parsed.pathname.includes('/relay/')) return false;
            if (parsed.hostname.includes('norva-relay')) return false;

            const isSecurePage = window.location.protocol === 'https:';
            if (isSecurePage && parsed.protocol === 'https:') return false;
        } catch {
            return false;
        }

        return true;
    }

    getProxiedUrl(url) {
        if (!this.canUseLocalProxy(url)) return url;
        return `/api/proxy/stream?url=${encodeURIComponent(url)}`;
    }

    async updateTranscodeStatus(mode, text) {
        if (!this.transcodeStatusEx) return;

        this.transcodeStatusEx.className = 'transcode-status'; // Reset classes

        if (mode === 'hidden') {
            this.transcodeStatusEx.classList.add('hidden');
            return;
        }

        this.transcodeStatusEx.textContent = text || mode;
        this.transcodeStatusEx.classList.add(mode);

        // Ensure it's visible
        this.transcodeStatusEx.classList.remove('hidden');
    }

    /**
     * Get quality label from video height
     */
    getQualityLabel(height) {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '1440p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height > 0) return `${height}p`;
        return null;
    }

    /**
     * Update quality badge display
     */
    updateQualityBadge() {
        if (!this.qualityBadgeEl) return;

        if (this.currentStreamInfo?.height > 0) {
            this.qualityBadgeEl.textContent = this.getQualityLabel(this.currentStreamInfo.height);
            this.qualityBadgeEl.classList.remove('hidden');
        } else {
            this.qualityBadgeEl.classList.add('hidden');
        }
    }

    normalizeDuration(value) {
        const duration = parseFloat(value);
        return Number.isFinite(duration) && duration > 0 ? duration : null;
    }

    getErrorText(error) {
        if (!error) return '';
        if (typeof error === 'string') return error;

        const payload = error.payload || {};
        return [
            error.code,
            error.upstreamStatus,
            error.message,
            error.details,
            payload.error,
            payload.details
        ].filter(Boolean).join(' ');
    }

    sanitizePlaybackMessage(message) {
        return String(message || '')
            .replace(/https?:\/\/[^\s'"<>]+/gi, '[stream URL]')
            .replace(/([?&](?:username|password|pass)=)[^&\s]+/gi, '$1[redacted]')
            .replace(/\/(live|movie|series)\/[^/\s]+\/[^/\s]+\//gi, '/$1/[user]/[password]/')
            .trim();
    }

    isTerminalPlaybackError(message) {
        return /UPSTREAM_(UNAUTHORIZED|RATE_LIMIT|FORBIDDEN|NOT_FOUND|REFUSED|UNAVAILABLE|RANGE_REJECTED)|401|403|404|416|429|5\d\d|Unauthorized|Forbidden|Too Many Requests|Many Requests|rate limit|provider refused|Service Unavailable|server error|Requested Range Not Satisfiable|4XX Client Error|Error opening input|Invalid data/i.test(message || '');
    }

    // Returns true for errors that reflect a temporary connection/account state,
    // NOT a structurally broken title. These must never trigger "hide broken"
    // because the title itself is fine — only the provider slot was busy.
    isConnectionLimitError(message) {
        return /UPSTREAM_(UNAUTHORIZED|RATE_LIMIT|FORBIDDEN)|401|403|429|Unauthorized|Forbidden|Too Many Requests|rate limit/i.test(message || '');
    }

    getProbeFailureText(info) {
        if (!info) return '';
        return [
            info.upstreamCode,
            info.upstreamStatus,
            info.friendlyError,
            info.error
        ].filter(Boolean).join(' ');
    }

    getFriendlyPlaybackError(message) {
        const text = this.sanitizePlaybackMessage(message);

        if (/429|Too Many Requests|Many Requests|rate limit/i.test(text)) {
            return 'The provider is rate limiting this stream (429 Too Many Requests). Close other players, wait a bit, then try again.';
        }
        if (/401|Unauthorized/i.test(text)) {
            return 'The provider refused the stream (401 Unauthorized). Your IPTV account may be blocked, expired, or limited to one connection.';
        }
        if (/403|Forbidden/i.test(text)) {
            return 'Access denied by the provider (403).';
        }
        if (/404|not found/i.test(text)) {
            return 'Stream not found on the provider (404). This title may have been removed.';
        }
        if (/416|Requested Range Not Satisfiable|range not satisfiable/i.test(text)) {
            return 'The provider refused the requested resume/seek position. Restart from the beginning or try another version.';
        }
        if (/5\d\d|Service Unavailable|server error/i.test(text)) {
            return 'The provider is temporarily unavailable for this stream. Try another version or retry in a moment.';
        }
        if (/provider (closed|refused)|4XX Client Error|Error opening input|Invalid data|Stream ends prematurely|I\/O error/i.test(text)) {
            return 'The provider closed or refused this stream. Try another version or wait before retrying.';
        }

        return 'Playback failed.';
    }

    escapePlaybackDetail(message) {
        const text = this.sanitizePlaybackMessage(message).slice(0, 240);
        if (typeof MediaUtils !== 'undefined' && MediaUtils.escapeHtml) {
            return MediaUtils.escapeHtml(text);
        }
        return text.replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    escapeHtml(text) {
        if (typeof MediaUtils !== 'undefined' && MediaUtils.escapeHtml) {
            return MediaUtils.escapeHtml(text || '');
        }
        return String(text || '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    getTrackLabel(track, fallback, type = 'track') {
        if (!track) return fallback;

        const parts = [];
        const title = track.title && !/^soundhandler$/i.test(track.title) ? track.title : null;
        const language = track.language && track.language !== 'und' ? track.language.toUpperCase() : null;
        const codec = track.codec ? String(track.codec).toUpperCase() : null;
        const channels = track.channels ? `${track.channels}ch` : null;

        if (title) parts.push(title);
        if (language && !parts.some(part => part.toUpperCase() === language)) parts.push(language);
        if (codec && type === 'audio') parts.push(codec);
        if (channels && type === 'audio') parts.push(channels);

        return parts.length ? parts.join(' - ') : fallback;
    }

    ensureSelectedAudioTrack() {
        if (!this.audioTracks.length) {
            this.selectedAudioStreamIndex = null;
            this.selectedAudioTrackUserChoice = false;
            return null;
        }

        const fallback = this.audioTracks.find(track => track.default) || this.audioTracks[0];
        if (!this.selectedAudioTrackUserChoice) {
            this.selectedAudioStreamIndex = fallback?.index ?? null;
            return fallback;
        }

        const current = this.audioTracks.find(track => Number(track.index) === Number(this.selectedAudioStreamIndex));
        if (current) return current;

        this.selectedAudioStreamIndex = fallback?.index ?? null;
        this.selectedAudioTrackUserChoice = false;
        return fallback;
    }

    getSelectedAudioTrack(info = this.currentStreamInfo) {
        const tracks = Array.isArray(info?.audioTracks) ? info.audioTracks : this.audioTracks;
        if (!tracks.length) return null;

        return tracks.find(track => Number(track.index) === Number(this.selectedAudioStreamIndex))
            || tracks.find(track => track.default)
            || tracks[0];
    }

    getAudioProcessingOptions(info = this.currentStreamInfo) {
        const selectedTrack = this.getSelectedAudioTrack(info);
        if (!selectedTrack) {
            return {
                audioCodec: info?.audio,
                audioChannels: info?.audioChannels
            };
        }

        return {
            audioStreamIndex: selectedTrack.index,
            audioCodec: selectedTrack.codec || info?.audio,
            audioChannels: selectedTrack.channels || info?.audioChannels
        };
    }

    getFreshProcessingOptions(overrides = {}, info = this.currentStreamInfo) {
        const hasKnownAudioTracks = (Array.isArray(info?.audioTracks) && info.audioTracks.length > 0)
            || this.audioTracks.length > 0;
        const audioOptions = hasKnownAudioTracks ? this.getAudioProcessingOptions(info) : {};

        return {
            ...this.currentProcessingOptions,
            ...audioOptions,
            ...overrides
        };
    }

    getTranscodeVideoMode(info = this.currentStreamInfo, settings = {}) {
        if (settings.upscaleEnabled || settings.forceVideoTranscode) return 'encode';

        const codec = String(info?.video || '').toLowerCase();

        if (info?.videoCopySafe === true) return 'copy';
        if (info?.videoCopySafe === false || info?.videoBrowserSafe === false) return 'encode';

        // Backward-compatible fallback for cached/older probe payloads.
        return (codec.includes('h264') || codec.includes('avc')) ? 'copy' : 'encode';
    }

    getTranscodeStatusText(videoMode, settings = {}) {
        if (settings.upscaleEnabled) return 'Upscaling';
        return videoMode === 'copy' ? 'Transcoding (Audio)' : 'Transcoding (Video)';
    }

    applyProbeInfo(info) {
        if (!info) return;

        this.currentStreamInfo = info;
        this.probeDuration = this.normalizeDuration(info.duration);
        this.audioTracks = Array.isArray(info.audioTracks) ? info.audioTracks : [];
        this.subtitleTracks = Array.isArray(info.subtitles) ? info.subtitles : [];
        this.ensureSelectedAudioTrack();
        this.updateQualityBadge();
        this.updateAudioTracks();
        this.updateDurationState();
    }

    async probeStreamInfo(url, settings = {}) {
        const ua = settings.userAgentPreset === 'custom' ? settings.userAgentCustom : settings.userAgentPreset;
        const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}&timeout=7000`);
        if (!probeRes.ok) {
            throw new Error(`Probe failed with status ${probeRes.status}`);
        }
        return probeRes.json();
    }

    async loadVideo(url, options = {}) {
        const playbackAttemptId = options.playbackAttemptId ?? this._playbackAttemptId;
        if (this.isStalePlaybackAttempt(playbackAttemptId)) {
            await this.cleanupStaleCloudPlaybackSession(options.cloudPlaybackSessionId);
            return;
        }
        if (!this.isLikelyPlaybackUrl(url)) {
            await this.cleanupStaleCloudPlaybackSession(options.cloudPlaybackSessionId);
            await this.handlePlaybackFailure('Playback session did not return a media URL.');
            return;
        }

        // Store the URL for copy functionality
        this.currentUrl = url;
        this._playbackStatusOkReported = false;

        // Clear any previous playback error banner
        this.hidePlaybackError();

        // Stop any existing playback and WAIT for the previous transcode
        // session to release its provider connection before we probe/transcode
        // the new title — otherwise the old + new connections overlap and a
        // single-connection IPTV account rejects the new one with 401.
        await this.stop();
        if (this.isStalePlaybackAttempt(playbackAttemptId)) {
            await this.cleanupStaleCloudPlaybackSession(options.cloudPlaybackSessionId);
            return;
        }
        this.registerCloudPlaybackSession(options.cloudPlaybackSessionId);
        if (this.video) {
            this.video.dataset.playbackAttemptId = String(playbackAttemptId);
        }
        this.baseStreamUrl = url;
        this.currentPlaybackMode = null;
        this.currentProcessingOptions = {};
        this.probeDuration = null;
        this.streamStartOffset = 0;
        this._videoEncodeFallbackTried = false;
        this.audioTracks = [];
        this.subtitleTracks = [];
        this.subtitleSourceUrl = null;
        this.subtitleStartOffset = 0;
        this.selectedSubtitleStreamIndex = null;
        this.selectedAudioStreamIndex = null;
        this.selectedAudioTrackUserChoice = false;
        this.clearExternalSubtitleTracks();
        this.updateAudioTracks();
        this.updateCaptionsTracks();
        this.updateDurationState();

        // Show loading spinner
        this.showLoading();

        // Get settings for proxy/transcode
        let settings = {};
        try {
            settings = await API.settings.get();
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
        } catch (e) {
            console.warn('Could not load settings');
        }
        settings = this.getCloudSafeSettings(settings);

        // Detect stream type
        const looksLikeHls = url.includes('.m3u8') || url.includes('m3u8');
        const isRawTs = url.includes('.ts') && !url.includes('.m3u8');
        const isDirectVideo = url.includes('.mp4') || url.includes('.mkv') || url.includes('.avi');
        let probeInfo = null;

        try {
            console.log('[WatchPage] Probing stream...');
            probeInfo = await this.probeStreamInfo(url, settings);
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            console.log(`[WatchPage] Probe result: video=${probeInfo.video}, audio=${probeInfo.audio}, ` +
                `${probeInfo.width}x${probeInfo.height}, duration=${probeInfo.duration || 'unknown'}, ` +
                `profile=${probeInfo.videoProfile || 'unknown'}, pix_fmt=${probeInfo.videoPixelFormat || 'unknown'}, ` +
                `copySafe=${probeInfo.videoCopySafe}, compatible=${probeInfo.compatible}`);
            this.applyProbeInfo(probeInfo);
            const probeFailureText = this.getProbeFailureText(probeInfo);
            if (probeInfo.upstreamFailure || this.isTerminalPlaybackError(probeFailureText)) {
                if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
                await this.handlePlaybackFailure(probeInfo.friendlyError || probeInfo.error || probeFailureText || 'The provider refused this stream.');
                return;
            }
        } catch (err) {
            console.warn('[WatchPage] Probe failed, continuing without duration fallback:', err.message);
        }

        // Priority 0: Auto Transcode (Smart) - probe first, then decide
        if (settings.autoTranscode) {
            if (probeInfo) {
                const info = probeInfo;
                if (info.needsTranscode || settings.upscaleEnabled) {
                    console.log(`[WatchPage] Auto: Using HLS transcode session (${settings.upscaleEnabled ? 'Upscaling' : 'Incompatible audio/video'})`);

                    const videoMode = this.getTranscodeVideoMode(info, settings);
                    const statusText = this.getTranscodeStatusText(videoMode, settings);
                    const statusMode = settings.upscaleEnabled ? 'upscaling' : 'transcoding';

                    this.updateTranscodeStatus(statusMode, statusText);
                    const startOffset = this.resumeTime || 0;
                    const processingOptions = {
                        videoMode,
                        seekOffset: startOffset,
                        videoCodec: info.video,
                        ...this.getAudioProcessingOptions(info)
                    };
                    this.currentPlaybackMode = 'transcode-session';
                    this.currentProcessingOptions = processingOptions;
                    this.streamStartOffset = startOffset;
                    this.attachProbeSubtitles(url, info.subtitles, startOffset);
                    const playlistUrl = await this.startTranscodeSession(url, processingOptions);
                    if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
                    this.playHlsOrDirect(playlistUrl, { playbackAttemptId });
                    this.setVolumeFromStorage();
                    return;
                } else if (info.needsRemux) {
                    const startOffset = this.resumeTime || 0;
                    this.streamStartOffset = startOffset;
                    this.attachProbeSubtitles(url, info.subtitles, startOffset);

                    const isMpegTs = String(info.container || '').toLowerCase().includes('mpegts') || isRawTs;
                    const finalUrl = isMpegTs
                        ? this.getTranscodeUrl(url, startOffset, this.getAudioProcessingOptions(info))
                        : this.getRemuxUrl(url, startOffset);
                    this.currentPlaybackMode = isMpegTs ? 'transcode' : 'remux';
                    this.currentProcessingOptions = isMpegTs ? this.getAudioProcessingOptions(info) : {};
                    this.updateTranscodeStatus(
                        isMpegTs ? 'transcoding' : 'remuxing',
                        isMpegTs ? 'Transcoding (Audio)' : 'Remux (Auto)'
                    );
                    console.log(`[WatchPage] Auto: Using ${isMpegTs ? 'audio transcode' : 'remux'} for incompatible container`);
                    if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
                    this.video.src = finalUrl;
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
                    });
                    this.setVolumeFromStorage();
                    return;
                }
                // Compatible - fall through to normal playback
                console.log('[WatchPage] Auto: Using normal playback (compatible)');
            } else {
                console.warn('[WatchPage] Auto Transcode enabled but probe failed, using normal playback');
            }
        }

        // Priority 1: Force Video Transcode (Full) or Upscaling
        if (settings.forceVideoTranscode || settings.upscaleEnabled) {
            const statusText = settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)';
            const statusMode = settings.upscaleEnabled ? 'upscaling' : 'transcoding';
            console.log(`[WatchPage] ${statusText} enabled. Starting session (encode)...`);
            this.updateTranscodeStatus(statusMode, statusText);
            const startOffset = this.resumeTime || 0;
            const processingOptions = {
                videoMode: 'encode',
                seekOffset: startOffset,
                videoCodec: probeInfo?.video,
                ...this.getAudioProcessingOptions(probeInfo)
            };
            this.currentPlaybackMode = 'transcode-session';
            this.currentProcessingOptions = processingOptions;
            this.streamStartOffset = startOffset;
            this.attachProbeSubtitles(url, probeInfo?.subtitles, startOffset);
            const playlistUrl = await this.startTranscodeSession(url, processingOptions);
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.playHlsOrDirect(playlistUrl, { playbackAttemptId });
            this.setVolumeFromStorage();
            return;
        }

        if (settings.forceTranscode) {
            console.log('[WatchPage] Force Audio Transcode enabled. Starting session...');

            // Probe to get video codec for HEVC tag handling
            let videoCodec = probeInfo?.video || 'unknown';
            if (!probeInfo) {
                try {
                    const info = await this.probeStreamInfo(url, settings);
                    if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
                    this.applyProbeInfo(info);
                    probeInfo = info;
                    videoCodec = info.video;
                } catch (e) { console.warn('Probe failed for force audio, assuming h264'); }
            }

            const startOffset = this.resumeTime || 0;
            const videoMode = this.getTranscodeVideoMode(probeInfo || this.currentStreamInfo, settings);
            this.updateTranscodeStatus('transcoding', this.getTranscodeStatusText(videoMode, settings));
            const processingOptions = {
                videoMode,
                videoCodec,
                seekOffset: startOffset,
                ...this.getAudioProcessingOptions(probeInfo)
            };
            this.currentPlaybackMode = 'transcode-session';
            this.currentProcessingOptions = processingOptions;
            this.streamStartOffset = startOffset;
            this.attachProbeSubtitles(url, (probeInfo || this.currentStreamInfo)?.subtitles, startOffset);
            const playlistUrl = await this.startTranscodeSession(url, processingOptions);
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.playHlsOrDirect(playlistUrl, { playbackAttemptId });
            this.setVolumeFromStorage();
            return;
        }

        // Priority 2: Force Remux for raw TS streams
        if (settings.forceRemux && isRawTs) {
            console.log('[WatchPage] Force Remux enabled');
            this.updateTranscodeStatus('remuxing', 'Remux (Force)');
            const startOffset = this.resumeTime || 0;
            this.currentPlaybackMode = 'remux';
            this.currentProcessingOptions = {};
            this.streamStartOffset = startOffset;
            this.attachProbeSubtitles(url, probeInfo?.subtitles, startOffset);
            const finalUrl = this.getRemuxUrl(url, startOffset);
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
            this.setVolumeFromStorage();
            return;
        }

        // Determine if proxy is needed
        const proxyRequiredDomains = ['pluto.tv'];
        const needsProxy = settings.forceProxy || proxyRequiredDomains.some(domain => url.includes(domain));
        const finalUrl = needsProxy ? this.getProxiedUrl(url) : url;

        console.log('[WatchPage] Playing:', { url, needsProxy, looksLikeHls });

        // Use HLS.js for HLS streams
        if (looksLikeHls && Hls.isSupported()) {
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.updateTranscodeStatus('direct', 'Direct HLS');
            this.currentPlaybackMode = 'direct-hls';
            this.currentProcessingOptions = {};
            this.streamStartOffset = 0;
            this.attachProbeSubtitles(url, probeInfo?.subtitles, 0);
            this.playHls(finalUrl, { playbackAttemptId });
        } else {
            // Direct playback for mp4/mkv/avi
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.updateTranscodeStatus('direct', 'Direct Play');
            this.currentPlaybackMode = 'direct';
            this.currentProcessingOptions = {};
            this.streamStartOffset = 0;
            this.attachProbeSubtitles(url, probeInfo?.subtitles, 0);
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
        }

        this.setVolumeFromStorage();
    }

    /**
     * Play HLS stream using Hls.js
     */
    playHls(url, options = {}) {
        const { autoplay = true } = options;
        const playbackAttemptId = options.playbackAttemptId ?? this._playbackAttemptId;

        if (this.hls) {
            this.hls.destroy();
        }

        // Local transcode sessions are VOD: always start from the beginning of
        // the playlist (never the live edge), even before EXT-X-ENDLIST exists.
        const isTranscodeSession = url.startsWith('/api/transcode/');
        const isGatewaySession = this.isGatewayPlaybackUrl(url);

        // Fresh recovery budget for each new stream
        this._mediaRecoveries = 0;
        this._networkRecoveries = 0;
        this._stallPos = -1;
        this._stallSince = Date.now();

        this.hls = new Hls({
            // Local transcode sessions: buffer aggressively ahead — segments are
            // already on disk, so a large forward buffer absorbs slow/erratic
            // upstream downloads on the encoder side
            maxBufferLength: (isTranscodeSession || isGatewaySession) ? 120 : 30,
            maxMaxBufferLength: (isTranscodeSession || isGatewaySession) ? 600 : 60,
            startLevel: -1,
            enableWorker: true,
            // External probe subtitles are attached lazily as native <track>
            // elements. Keep hls.js from owning textTracks so it cannot reset
            // the selected external track back to "hidden" during HLS events.
            renderTextTracksNatively: false,
            ...(isTranscodeSession ? { startPosition: 0 } : {})
        });

        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
            console.log('[WatchPage] Audio tracks updated:', data.audioTracks);
            this.updateAudioTracks();
        });

        this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
            console.log('[WatchPage] Audio track switched:', data);
            this.updateAudioTracks();
        });

        // Listen for subtitle track updates
        this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
            console.log('[WatchPage] Subtitle tracks updated:', data.subtitleTracks);
            // Wait a moment for native text tracks to populate
            setTimeout(() => this.updateCaptionsTracks(), 100);
        });

        this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
            console.log('[WatchPage] Subtitle track switched:', data);
        });

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            if (!autoplay) return;

            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            // Non-fatal errors (incl. most bufferStalledError occurrences) are
            // recovered automatically by hls.js — never surface them
            if (!data.fatal) return;

            console.error('[WatchPage] HLS fatal error:', data.type, data.details);

            // Buffer starvation (encoder/provider slower than playback) is NOT a
            // terminal error: show the buffering spinner and keep recovering,
            // exactly like streaming platforms do. Only give up after 45s with
            // zero playback progress.
            const SOFT_MEDIA_DETAILS = ['bufferStalledError', 'bufferNudgeOnStall', 'bufferSeekOverHole', 'fragParsingError'];
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && SOFT_MEDIA_DETAILS.includes(data.details)) {
                const pos = this.video?.currentTime || 0;
                if (pos !== this._stallPos) {
                    this._stallPos = pos;
                    this._stallSince = Date.now();
                }
                if (Date.now() - this._stallSince < 45000) {
                    this.showLoading();
                    try {
                        this.hls.recoverMediaError();
                        // recoverMediaError re-attaches the media element and
                        // leaves it paused — resume playback explicitly
                        setTimeout(() => this.video?.play().catch(() => { }), 500);
                    } catch (e) { /* destroyed */ }
                    return;
                }
                // 45s without progress: fall through to terminal handling
            }

            // Fatal MEDIA_ERROR (bufferAppendError, decode errors...) is
            // recoverable: try a bounded number of recoveries before giving up.
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                this._mediaRecoveries = (this._mediaRecoveries || 0) + 1;
                if (this._mediaRecoveries <= 3) {
                    console.warn(`[WatchPage] Recovering media error (attempt ${this._mediaRecoveries}/3)`);
                    if (this._mediaRecoveries === 2) this.hls.swapAudioCodec();
                    this.hls.recoverMediaError();
                    setTimeout(() => this.video?.play().catch(() => { }), 500);
                    return;
                }
            } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                // Try proxy on CORS error (only if not already proxied/transcoded)
                if (this.canUseLocalProxy(this.currentUrl)) {
                    console.log('[WatchPage] Retrying via proxy...');
                    this.playHls(this.getProxiedUrl(this.currentUrl), { ...options, playbackAttemptId });
                    return;
                }
                // Local transcode session: playlist/segments can lag behind the
                // encoder — restart loading instead of failing
                this._networkRecoveries = (this._networkRecoveries || 0) + 1;
                const maxNetworkRecoveries = (isTranscodeSession || isGatewaySession) ? 20 : 3;
                const retryDelay = isGatewaySession ? Math.min(5000, 1000 + (this._networkRecoveries * 500)) : 1000;
                if (this._networkRecoveries <= maxNetworkRecoveries) {
                    console.warn(`[WatchPage] Restarting HLS load (attempt ${this._networkRecoveries}/${maxNetworkRecoveries})`);
                    this.showLoading();
                    setTimeout(() => {
                        if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
                        try { this.hls?.startLoad(); } catch (e) { /* destroyed */ }
                    }, retryDelay);
                    return;
                }
            }

            // Recovery exhausted: last resort, try another version of the title
            this.hls.destroy();
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.handlePlaybackFailure(data.details || data.reason || 'Playback failed.');
        });
    }

    playHlsOrDirect(url, options = {}) {
        const { autoplay = true } = options;

        // Session creation failed terminally (upstream 401/404...): try another
        // version of the title or surface a clear error instead of spinning
        if (!url) {
            if (this.isStalePlaybackAttempt(options.playbackAttemptId)) return;
            this.handlePlaybackFailure(this._lastFailureMsg || 'Playback failed');
            return;
        }

        if (url.startsWith('/api/transcode?')) {
            this.video.src = url;
            if (autoplay) {
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.error('[WatchPage] Direct transcode play error:', e);
                });
            }
            return;
        }

        this.playHls(url, options);
    }

    setVolumeFromStorage() {
        const savedVolume = localStorage.getItem('norva-volume') || '80';
        this.video.volume = parseInt(savedVolume) / 100;
        if (this.volumeSlider) this.volumeSlider.value = savedVolume;
    }

    stop() {
        clearTimeout(this._seekDebounceTimer);
        this._seekDebounceTimer = null;
        this._pendingSeekTarget = null;

        // Stop subtitle cue polling/window timers
        this.stopSubtitleEngine();

        // Stop history tracking and save final progress
        this.stopHistoryTracking();
        this.saveProgress();

        // Cleanup transcode session if exists. Keep the promise so callers
        // (loadVideo) can await full teardown before opening a new stream —
        // single-connection IPTV accounts 401 if the old FFmpeg is still
        // connected when the next one starts.
        const sessionTeardown = Promise.allSettled([
            this.stopTranscodeSession(),
            this.stopCloudPlaybackSessions()
        ]);
        this.updateTranscodeStatus('hidden');

        // Hide quality badge
        this.currentStreamInfo = null;
        if (this.qualityBadgeEl) {
            this.qualityBadgeEl.classList.add('hidden');
        }

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.clearExternalSubtitleTracks();
        if (this.video) {
            this.video.pause();
            this.video.src = '';
            this.video.load();
        }
        this.baseStreamUrl = null;
        this.currentPlaybackMode = null;
        this.currentProcessingOptions = {};
        this.probeDuration = null;
        this.streamStartOffset = 0;
        this._videoEncodeFallbackTried = false;
        this.subtitleSourceUrl = null;
        this.subtitleStartOffset = 0;
        this.selectedSubtitleStreamIndex = null;
        this.updateDurationState();

        this.hideNowPlaying();

        // Resolves once the previous transcode session has fully torn down.
        return sessionTeardown;
    }

    // === Playback Controls ===

    togglePlay() {
        if (this.video.paused) {
            this.video.play().catch(console.error);
        } else {
            this.video.pause();
        }
    }

    skip(seconds) {
        const duration = this.getDisplayDuration();
        if (!duration) return;

        const base = Number.isFinite(this._pendingSeekTarget)
            ? this._pendingSeekTarget
            : this.getPlaybackPosition();
        this.seekToTime(base + seconds);
    }

    seek(percent) {
        const duration = this.getDisplayDuration();
        if (!duration) return;

        const nextPercent = Math.max(0, Math.min(100, parseFloat(percent)));
        if (!Number.isFinite(nextPercent)) return;

        const target = (nextPercent / 100) * duration;
        this.setProgressValue(nextPercent);
        this.seekToTime(target);
    }

    scheduleProcessedSeek(target, duration, delay = 900) {
        this._pendingSeekTarget = target;
        this.setProgressValue((target / duration) * 100);
        if (this.timeCurrent) {
            this.timeCurrent.textContent = this.formatTime(target);
        }
        this.updateDurationState();

        clearTimeout(this._seekDebounceTimer);
        this._seekDebounceTimer = setTimeout(() => {
            const nextTarget = this._pendingSeekTarget;
            this._pendingSeekTarget = null;
            this._seekDebounceTimer = null;
            this.seekToTime(nextTarget, { immediate: true });
        }, delay);
    }

    async seekToTime(targetTime, options = {}) {
        if (!this.video) return;

        const duration = this.getDisplayDuration();
        if (!duration) return;

        const target = Math.max(0, Math.min(targetTime, duration));
        const nativeDuration = this.getValidDuration();

        if (this.canRestartForSeek() && !options.immediate) {
            this.scheduleProcessedSeek(target, duration);
            return;
        }

        if (this.canRestartForSeek()) {
            await this.restartProcessedStreamAt(target);
            return;
        }

        if (nativeDuration) {
            const localTarget = Math.max(0, target - this.streamStartOffset);
            this.video.currentTime = Math.min(localTarget, nativeDuration);
            this.updateDurationState();
            return;
        }
    }

    async restartProcessedStreamAt(targetTime) {
        const sourceUrl = this.baseStreamUrl || this.currentUrl;
        if (!sourceUrl) return;

        const mode = this.currentPlaybackMode;
        const autoplay = !this.video?.paused;
        this.showLoading();

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        await this.stopTranscodeSession();

        this.streamStartOffset = targetTime;
        this.updateDurationState();

        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }

        this.attachProbeSubtitles(sourceUrl, this.subtitleTracks, targetTime);

        if (mode === 'remux') {
            this.video.src = this.getRemuxUrl(sourceUrl, targetTime);
            if (autoplay) {
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.error('[WatchPage] Remux seek play error:', e);
                });
            }
        } else if (mode === 'transcode') {
            const processingOptions = this.getFreshProcessingOptions();
            this.currentProcessingOptions = processingOptions;
            this.video.src = this.getTranscodeUrl(sourceUrl, targetTime, processingOptions);
            if (autoplay) {
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.error('[WatchPage] Transcode seek play error:', e);
                });
            }
        } else if (mode === 'transcode-session') {
            const processingOptions = this.getFreshProcessingOptions({ seekOffset: targetTime });
            this.currentProcessingOptions = processingOptions;
            const playlistUrl = await this.startTranscodeSession(sourceUrl, processingOptions);
            this.playHlsOrDirect(playlistUrl, { autoplay });
        }

        this.setVolumeFromStorage();
    }

    toggleMute() {
        if (this.video) {
            this.video.muted = !this.video.muted;
            this.updateVolumeUI();
        }
    }

    setVolume(value) {
        if (this.video) {
            this.video.volume = value / 100;
            this.video.muted = false;
            localStorage.setItem('norva-volume', value);
            this.updateVolumeUI();
        }
    }

    toggleFullscreen() {
        const container = document.querySelector('.watch-video-section');
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

        if (isFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else {
            if (container?.requestFullscreen) {
                container.requestFullscreen();
            } else if (container?.webkitRequestFullscreen) {
                container.webkitRequestFullscreen();
            } else if (this.video?.webkitEnterFullscreen) {
                // iOS Safari: use native video fullscreen
                this.video.webkitEnterFullscreen();
            }
        }
    }

    async togglePictureInPicture() {
        try {
            // Standard PiP API (Chrome, Edge, Firefox)
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
            // Safari fallback using webkitPresentationMode
            else if (typeof this.video.webkitSetPresentationMode === 'function') {
                const mode = this.video.webkitPresentationMode;
                this.video.webkitSetPresentationMode(mode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            }
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                console.error('Picture-in-Picture error:', err);
            }
        }
    }

    /**
     * Copy current stream URL to clipboard
     */
    copyStreamUrl() {
        if (!this.currentUrl) {
            console.warn('[WatchPage] No stream URL to copy');
            return;
        }

        let streamUrl = this.currentUrl;

        // If it's a relative URL, make it absolute
        if (streamUrl.startsWith('/')) {
            streamUrl = window.location.origin + streamUrl;
        }

        const showPromptFallback = () => {
            prompt('Copy this URL:', streamUrl);
        };

        // navigator.clipboard is only available in secure contexts (HTTPS/localhost)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(streamUrl).then(() => {
                // Show brief feedback
                const btn = document.getElementById('watch-copy-url');
                if (btn) {
                    btn.textContent = '✓ Copied!';
                    setTimeout(() => {
                        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                    }, 1500);
                }
                console.log('[WatchPage] Stream URL copied:', streamUrl);
            }).catch(() => {
                showPromptFallback();
            });
        } else {
            // Fallback for insecure contexts (HTTP)
            showPromptFallback();
        }
    }

    // === UI Updates ===

    getValidDuration(video = this.video) {
        const duration = video?.duration;
        return Number.isFinite(duration) && duration > 0 ? duration : null;
    }

    getProbeDuration() {
        return this.normalizeDuration(this.probeDuration) || this.normalizeDuration(this.durationHint);
    }

    getDisplayDuration() {
        const probeDuration = this.getProbeDuration();

        if (probeDuration && ['remux', 'transcode', 'transcode-session'].includes(this.currentPlaybackMode)) {
            return probeDuration;
        }

        return this.getValidDuration() || probeDuration;
    }

    getCurrentTime() {
        const currentTime = this.video?.currentTime;
        return Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
    }

    getPlaybackPosition() {
        const displayDuration = this.getDisplayDuration();
        const position = this.streamStartOffset + this.getCurrentTime();
        return displayDuration ? Math.min(position, displayDuration) : position;
    }

    canRestartForSeek() {
        return Boolean(
            this.baseStreamUrl &&
            this.getProbeDuration() &&
            ['remux', 'transcode', 'transcode-session'].includes(this.currentPlaybackMode)
        );
    }

    canSeekTimeline() {
        return Boolean(this.getValidDuration() || this.canRestartForSeek());
    }

    setProgressValue(percent) {
        if (!this.progressSlider) return;

        const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
        this.progressSlider.value = value;
        this.progressSlider.style.setProperty('--progress', `${value}%`);
    }

    setProgressState(hasDuration, isSeekable) {
        this.progressContainer?.classList.toggle('duration-unknown', !hasDuration);
        this.progressContainer?.classList.toggle('duration-readonly', hasDuration && !isSeekable);

        if (this.progressSlider) {
            this.progressSlider.disabled = !isSeekable;
            this.progressSlider.tabIndex = isSeekable ? 0 : -1;
            this.progressSlider.setAttribute('aria-disabled', String(!isSeekable));
        }
    }

    updateDurationState() {
        const duration = this.getDisplayDuration();
        const currentTime = this.getPlaybackPosition();

        if (this.timeCurrent) {
            this.timeCurrent.textContent = this.formatTime(currentTime);
        }

        if (!duration) {
            if (this.timeTotal) this.timeTotal.textContent = '';
            this.setProgressState(false, false);
            this.setProgressValue(0);
            return null;
        }

        if (this.timeTotal) {
            this.timeTotal.textContent = this.formatTime(duration);
        }

        this.setProgressState(true, this.canSeekTimeline());
        this.setProgressValue((currentTime / duration) * 100);
        return duration;
    }

    updateProgress() {
        if (!this.video) return;

        const duration = this.updateDurationState();
        if (!duration) return;

        // Show "Up Next" panel early for series (like streaming services do during credits)
        // Only show if auto-play next episode is enabled
        const autoPlayEnabled = this.app?.player?.settings?.autoPlayNextEpisode;
        if (autoPlayEnabled && this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing && !this.nextEpisodeDismissed) {
            const currentTime = this.getCurrentTime();

            // Only proceed if we have reliable duration data
            if (duration >= 180 && currentTime >= 120) {
                const timeRemaining = duration - currentTime;
                const creditsThreshold = 10; // seconds before end to show "Up Next"

                if (timeRemaining <= creditsThreshold && timeRemaining > 0) {
                    const nextEp = this.getNextEpisode();
                    if (nextEp) {
                        this.nextEpisodeShowing = true;
                        this.showNextEpisodePanel(nextEp);
                    }
                }
            }
        }
    }

    onMetadataLoaded() {
        this.updateDurationState();

        // Detect resolution
        if (this.video && this.video.videoHeight > 0) {
            this.currentStreamInfo = {
                width: this.video.videoWidth,
                height: this.video.videoHeight
            };
            this.updateQualityBadge();
        }

        // Handle resumption
        if (this.resumeTime > 0 && this.video && this.streamStartOffset === 0) {
            const duration = this.getValidDuration();
            // Only resume if not near the end (95%)
            if (!duration || this.resumeTime < duration * 0.95) {
                console.log(`[WatchPage] Resuming at ${this.resumeTime}s`);
                try {
                    this.video.currentTime = this.resumeTime;
                } catch (err) {
                    console.warn('[WatchPage] Resume seek failed:', err.message);
                }
            }
            this.resumeTime = 0; // Reset after use
        } else if (this.streamStartOffset > 0) {
            this.resumeTime = 0;
        }
    }

    onPlay() {
        // Update play/pause button icons
        this.playPauseBtn?.querySelector('.icon-play')?.classList.add('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.remove('hidden');
        this.centerPlayBtn?.classList.remove('show');

        // Start overlay auto-hide
        this.startOverlayTimer();
    }

    onPause() {
        this.playPauseBtn?.querySelector('.icon-play')?.classList.remove('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.add('hidden');
        this.centerPlayBtn?.classList.add('show');

        // Keep overlay visible when paused
        this.showOverlay();
        clearTimeout(this.overlayTimeout);
    }

    onEnded() {
        // For series, show next episode panel if not already showing and auto-play is enabled
        const autoPlayEnabled = this.app?.player?.settings?.autoPlayNextEpisode;
        if (autoPlayEnabled && this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing) {
            const nextEp = this.getNextEpisode();
            if (nextEp) {
                this.nextEpisodeShowing = true;
                this.showNextEpisodePanel(nextEp);
            }
        }
    }

    onError(e) {
        const videoAttemptId = Number.parseInt(this.video?.dataset?.playbackAttemptId || '', 10);
        if (Number.isFinite(videoAttemptId) && this.isStalePlaybackAttempt(videoAttemptId)) return;

        // Only log actual fatal errors, not benign stream recovery events
        const error = this.video?.error;
        if (error && error.code) {
            if (this.hasCurrentMedia()) {
                this.hidePlaybackError();
                return;
            }
            // Benign: fired when the src is cleared during stop()/teardown
            if (/Empty src/i.test(error.message || '')) return;
            console.error('[WatchPage] Video error:', error.code, error.message);
            // MEDIA_ERR_NETWORK / MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED:
            // fail over to another version of the same title if available
            if ([2, 3, 4].includes(error.code)) {
                this.handlePlaybackFailure(error.message || 'Media error');
            }
        }
    }

    /**
     * Terminal playback failure: try the next version of the title,
     * otherwise stop the spinner and show a clear error message.
     */
    async handlePlaybackFailure(message) {
        if (this.hasCurrentMedia()) {
            console.warn('[WatchPage] Ignoring stale playback failure because media is active:', message);
            this.hidePlaybackError();
            this.hideLoading();
            return;
        }

        this._lastFailureMsg = message;
        const retriedWithEncode = await this.retryWithFullVideoTranscode(message);
        if (retriedWithEncode) return;

        // 401/403/429 = connection-limit or account throttle, not a dead title.
        // Never mark as broken — doing so would hide a perfectly valid stream.
        if (!this.isConnectionLimitError(message)) {
            await this.reportPlaybackStatus('broken', message);
        }
        const attempted = await this.tryNextVersion();
        if (!attempted) {
            this.showPlaybackError(message);
        }
    }

    isFormatPlaybackError(message) {
        return /MEDIA_ELEMENT_ERROR|MEDIA_ERR_DECODE|Format error|decode|bufferAppendError|fragParsingError|sourceBuffer|appendBuffer/i.test(message || '');
    }

    async retryWithFullVideoTranscode(message) {
        if (this._videoEncodeFallbackTried) return false;
        if (!this.isFormatPlaybackError(message)) return false;

        const sourceUrl = this.baseStreamUrl || this.currentUrl;
        if (!sourceUrl) return false;

        if (this.currentPlaybackMode === 'transcode-session' && this.currentProcessingOptions?.videoMode === 'encode') {
            return false;
        }

        this._videoEncodeFallbackTried = true;
        const position = Math.max(0, Math.floor(this.getPlaybackPosition()) - 2);
        const autoplay = true;
        const info = this.currentStreamInfo || {};
        const processingOptions = {
            ...this.currentProcessingOptions,
            ...this.getAudioProcessingOptions(info),
            videoMode: 'encode',
            videoCodec: info.video || this.currentProcessingOptions.videoCodec || 'unknown',
            seekOffset: position
        };

        console.warn('[WatchPage] Browser rejected copied/direct video. Retrying with full video transcode.');
        this.hidePlaybackError();
        this.showLoading();
        this.updateTranscodeStatus('transcoding', 'Transcoding (Video)');

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        await this.stopTranscodeSession();

        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }

        this.currentPlaybackMode = 'transcode-session';
        this.currentProcessingOptions = processingOptions;
        this.streamStartOffset = position;
        this.attachProbeSubtitles(sourceUrl, this.subtitleTracks, position);
        this.updateDurationState();

        const playlistUrl = await this.startTranscodeSession(sourceUrl, processingOptions);
        this.playHlsOrDirect(playlistUrl, { autoplay });
        this.setVolumeFromStorage();
        return true;
    }

    showPlaybackError(message) {
        if (this.hasCurrentMedia()) {
            console.warn('[WatchPage] Suppressing stale playback error because media is already playing:', message);
            this.hidePlaybackError();
            return;
        }

        this.hideLoading();
        this.updateTranscodeStatus('hidden');

        let errorEl = document.getElementById('watch-error');
        if (!errorEl) {
            errorEl = document.createElement('div');
            errorEl.id = 'watch-error';
            errorEl.className = 'watch-error';
            document.querySelector('.watch-video-section')?.appendChild(errorEl);
        }

        const safeMessage = this.sanitizePlaybackMessage(message);
        const friendly = this.getFriendlyPlaybackError(safeMessage);
        const detail = this.escapePlaybackDetail(safeMessage);

        errorEl.innerHTML = `
            <div class="watch-error-box">
                <p class="watch-error-title">⚠ Unable to play this title</p>
                <p class="watch-error-msg">${friendly}</p>
                ${detail ? `<p class="watch-error-detail">${detail}</p>` : ''}
            </div>`;
        errorEl.classList.remove('hidden');

        // HLS/transcode sessions can recover just after an error callback fired.
        // Re-check shortly so a stale fatal banner never stays over active video.
        [500, 1500, 4000].forEach(delay => {
            setTimeout(() => this.markPlaybackUsable(), delay);
        });
    }

    hidePlaybackError() {
        document.getElementById('watch-error')?.classList.add('hidden');
    }

    isCurrentPlaybackUsable() {
        return this.hasCurrentMedia() && !this.video.paused && !this.video.ended;
    }

    hasCurrentMedia() {
        const video = this.video;
        if (!video) return false;
        if (video.error) return false;
        const hasMetadata = video.readyState >= 1
            && Number.isFinite(video.duration)
            && video.duration > 0;
        const hasMedia = video.readyState >= 2 || video.currentTime > 0 || (hasMetadata && !video.paused);
        return hasMedia && !video.ended && Boolean(video.currentSrc || video.src);
    }

    markPlaybackUsable() {
        if (!this.hasCurrentMedia()) return;
        this.hideLoading();
        this.hidePlaybackError();
        if (!this._playbackStatusOkReported) {
            this._playbackStatusOkReported = true;
            this.reportPlaybackStatus('ok').catch(() => { });
        }
    }

    getPlaybackHealthTarget() {
        if (!this.content?.sourceId || !this.content?.id) return null;
        if (this.content.type === 'movie') {
            return {
                sourceId: this.content.sourceId,
                itemType: 'movie',
                itemId: this.content.id
            };
        }
        return {
            sourceId: this.content.sourceId,
            itemType: 'series',
            itemId: this.content.seriesId || this.content.id
        };
    }

    async reportPlaybackStatus(status, reason = '') {
        const target = this.getPlaybackHealthTarget();
        if (!target || !window.PlaybackHealth?.report) return;
        await PlaybackHealth.report({ ...target, status, reason });
    }

    /**
     * Failover: when a stream fails to play and the content was opened from
     * a duplicate group, automatically switch to the next available version.
     */
    async tryNextVersion() {
        // No version left: report failure even if a (failed) switch just happened
        if (!this.versions || this.versionIndex >= this.versions.length - 1) return false;
        if (this._failoverInProgress) return false;

        this._failoverInProgress = true;
        this.versionIndex++;
        const next = this.versions[this.versionIndex];
        console.warn(`[WatchPage] Playback failed, switching to version ${this.versionIndex + 1}/${this.versions.length}: ${next.label}`);
        let handedOff = false;

        try {
            // Resume close to where the previous version failed
            const position = Math.max(0, Math.floor(this.getPlaybackPosition()) - 5);
            const result = await API.proxy.xtream.getStreamUrl(next.sourceId, next.streamId, next.type || 'movie', next.container || 'mp4');
            if (result?.url) {
                this.updateTranscodeStatus('transcoding', `Switched: ${next.label}`);
                if (this.subtitleEl) {
                    this.subtitleEl.textContent = next.label || '';
                }
                this.resumeTime = position;
                this.content.id = next.streamId;
                this.content.sourceId = next.sourceId;
                this.content.cloudPlaybackSessionId = result.sessionId || null;
                this.containerExtension = next.container || 'mp4';
                this._failoverInProgress = false;
                handedOff = true;
                await this.loadVideo(result.url, { cloudPlaybackSessionId: result.sessionId });
            }
        } catch (err) {
            console.error('[WatchPage] Failover failed:', err);
        } finally {
            this._failoverInProgress = false;
        }
        return handedOff;
    }

    updateVolumeUI() {
        const isMuted = this.video?.muted || this.video?.volume === 0;
        this.muteBtn?.querySelector('.icon-vol')?.classList.toggle('hidden', isMuted);
        this.muteBtn?.querySelector('.icon-muted')?.classList.toggle('hidden', !isMuted);
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // === Loading Spinner ===

    showLoading() {
        this.loadingSpinner?.classList.add('show');
        this.centerPlayBtn?.classList.remove('show');
    }

    hideLoading() {
        this.loadingSpinner?.classList.remove('show');
    }

    // === Audio & Captions ===

    toggleAudioMenu() {
        if (this.audioMenuOpen) {
            this.closeAudioMenu();
        } else {
            this.updateAudioTracks();
            this.audioMenu?.classList.remove('hidden');
            this.audioMenuOpen = true;
            this.closeCaptionsMenu();
        }
    }

    closeAudioMenu() {
        this.audioMenu?.classList.add('hidden');
        this.audioMenuOpen = false;
    }

    getNativeAudioTracks() {
        const tracks = this.video?.audioTracks;
        if (!tracks || !Number.isFinite(tracks.length) || tracks.length <= 0) return [];

        const items = [];
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            items.push({
                source: 'native',
                index: i,
                label: track.label || track.language || `Audio ${i + 1}`,
                active: Boolean(track.enabled)
            });
        }
        return items;
    }

    getHlsAudioTracks() {
        const tracks = this.hls?.audioTracks;
        if (!Array.isArray(tracks) || tracks.length <= 0) return [];

        return tracks.map((track, index) => ({
            source: 'hls',
            index,
            label: track.name || track.lang || `Audio ${index + 1}`,
            active: this.hls.audioTrack === index
        }));
    }

    getProbeAudioTracks() {
        if (!Array.isArray(this.audioTracks) || !this.audioTracks.length) return [];
        const selected = this.getSelectedAudioTrack();

        return this.audioTracks.map((track, index) => ({
            source: 'probe',
            index,
            streamIndex: track.index,
            label: this.getTrackLabel(track, `Audio ${index + 1}`, 'audio'),
            active: Number(track.index) === Number(selected?.index)
        }));
    }

    getVisibleAudioTracks() {
        const hlsTracks = this.getHlsAudioTracks();
        if (hlsTracks.length > 1) return hlsTracks;

        const nativeTracks = this.getNativeAudioTracks();
        if (nativeTracks.length > 1) return nativeTracks;

        const probeTracks = this.getProbeAudioTracks();
        if (probeTracks.length) return probeTracks;

        return [{ source: 'none', index: -1, label: 'Default', active: true }];
    }

    updateAudioTracks() {
        if (!this.audioList) return;

        const tracks = this.getVisibleAudioTracks();
        this.audioList.innerHTML = tracks.map(track => {
            const streamAttr = track.streamIndex !== undefined ? ` data-stream-index="${track.streamIndex}"` : '';
            return `<button class="audio-option ${track.active ? 'active' : ''}" data-source="${track.source}" data-index="${track.index}"${streamAttr}>${this.escapeHtml(track.label)}</button>`;
        }).join('');

        this.audioList.querySelectorAll('.audio-option').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectAudioTrack(
                    btn.dataset.source,
                    parseInt(btn.dataset.index, 10),
                    btn.dataset.streamIndex !== undefined ? parseInt(btn.dataset.streamIndex, 10) : null
                );
            });
        });
    }

    async selectAudioTrack(source, index, streamIndex = null) {
        if (!this.video || source === 'none') {
            this.closeAudioMenu();
            return;
        }

        if (source === 'hls' && this.hls && index >= 0) {
            this.hls.audioTrack = index;
            this.updateAudioTracks();
            this.closeAudioMenu();
            return;
        }

        if (source === 'native') {
            const tracks = this.video.audioTracks;
            if (tracks && index >= 0 && index < tracks.length) {
                for (let i = 0; i < tracks.length; i++) {
                    tracks[i].enabled = i === index;
                }
            }
            this.updateAudioTracks();
            this.closeAudioMenu();
            return;
        }

        if (source !== 'probe' || !Number.isInteger(streamIndex)) {
            this.closeAudioMenu();
            return;
        }

        const previous = Number(this.selectedAudioStreamIndex);
        this.selectedAudioStreamIndex = streamIndex;
        this.selectedAudioTrackUserChoice = true;
        this.updateAudioTracks();
        this.closeAudioMenu();

        if (previous === streamIndex && this.currentPlaybackMode === 'transcode-session') {
            return;
        }

        await this.restartWithSelectedAudioTrack();
    }

    async restartWithSelectedAudioTrack() {
        const sourceUrl = this.baseStreamUrl || this.currentUrl;
        const selected = this.getSelectedAudioTrack();
        if (!sourceUrl || !selected) return;

        const position = Math.max(0, this.getPlaybackPosition());
        const autoplay = !this.video?.paused;
        const info = this.currentStreamInfo || {};
        const videoCodec = info.video || this.currentProcessingOptions.videoCodec || 'unknown';
        const videoMode = this.currentProcessingOptions.videoMode
            || this.getTranscodeVideoMode(info);

        const processingOptions = {
            ...this.currentProcessingOptions,
            ...this.getAudioProcessingOptions(info),
            videoMode,
            videoCodec,
            seekOffset: position
        };

        const audioLabel = this.getTrackLabel(selected, 'Selected audio', 'audio');
        console.log(`[WatchPage] Restarting transcode with audio track ${selected.index}: ${audioLabel}`);
        this.hidePlaybackError();
        this.showLoading();
        this.updateTranscodeStatus('transcoding', `Audio: ${audioLabel}`);

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        await this.stopTranscodeSession();

        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }

        this.currentPlaybackMode = 'transcode-session';
        this.currentProcessingOptions = processingOptions;
        this.streamStartOffset = position;
        this.attachProbeSubtitles(sourceUrl, this.subtitleTracks, position);
        this.updateDurationState();

        const playlistUrl = await this.startTranscodeSession(sourceUrl, processingOptions);
        this.playHlsOrDirect(playlistUrl, { autoplay });
        this.setVolumeFromStorage();
    }

    clearExternalSubtitleTracks() {
        this.stopSubtitleEngine();
        this.video?.querySelectorAll('track[data-norva-probe-subtitle="true"]').forEach(track => {
            if (track.track) {
                track.track.mode = 'disabled';
            }
            track.remove();
        });
    }

    isSubtitleExtractable(track) {
        return track && track.extractable === true && String(track.subtitleType || 'text').toLowerCase() === 'text';
    }

    normalizeTrackLanguage(language) {
        const normalized = String(language || '').toLowerCase();
        const aliases = {
            fre: 'fr',
            fra: 'fr',
            eng: 'en',
            ger: 'de',
            deu: 'de',
            spa: 'es',
            ita: 'it',
            por: 'pt',
            dut: 'nl',
            nld: 'nl'
        };
        return aliases[normalized] || normalized || 'und';
    }

    getExtractableSubtitleTracks(subtitles = this.subtitleTracks) {
        return (Array.isArray(subtitles) ? subtitles : []).filter(track => this.isSubtitleExtractable(track));
    }

    getSubtitleExtractionTracks() {
        const tracks = this.getExtractableSubtitleTracks();
        const selected = this.getSelectedSubtitleTrack();
        if (!selected) return tracks;

        return [
            selected,
            ...tracks.filter(track => Number(track.index) !== Number(selected.index))
        ];
    }

    getSelectedSubtitleTrack() {
        if (this.selectedSubtitleStreamIndex === null || this.selectedSubtitleStreamIndex === undefined) return null;
        return this.getExtractableSubtitleTracks()
            .find(track => Number(track.index) === Number(this.selectedSubtitleStreamIndex)) || null;
    }

    // ============================================================
    // Subtitle engine
    //
    // Two delivery modes, both feeding cues into a src-less <track>
    // via TextTrack.addCue() (no reload, no flicker):
    //
    // 1. transcode-session: FFmpeg extracts every text track to growing
    //    sub_<index>.vtt files IN the transcoding process — zero extra
    //    provider connections (critical for single-connection accounts).
    //    We poll the local file and append new cues as they are written.
    //
    // 2. direct/remux: windowed extraction via /api/subtitle (a separate
    //    provider connection, unavoidable here) with auto-sliding windows
    //    so subtitles keep working past the first window.
    // ============================================================

    /**
     * Minimal WebVTT parser — returns [{ start, end, text }]
     */
    parseVttCues(vttText) {
        const cues = [];
        const timeRe = /(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})/;
        const blocks = String(vttText || '').split(/\r?\n\r?\n/);
        for (const block of blocks) {
            const lines = block.split(/\r?\n/);
            const timingIdx = lines.findIndex(l => l.includes('-->'));
            if (timingIdx === -1) continue;
            const m = lines[timingIdx].match(timeRe);
            if (!m) continue;
            const start = (parseInt(m[1] || 0) * 3600) + (parseInt(m[2]) * 60) + parseInt(m[3]) + parseInt(m[4]) / 1000;
            const end = (parseInt(m[5] || 0) * 3600) + (parseInt(m[6]) * 60) + parseInt(m[7]) + parseInt(m[8]) / 1000;
            const text = lines.slice(timingIdx + 1).join('\n').trim();
            if (!text || !(end > start)) continue;
            cues.push({ start, end, text });
        }
        return cues;
    }

    stopSubtitleEngine() {
        clearInterval(this._subEngineTimer);
        this._subEngineTimer = null;
        this._subEngine = null;
    }

    /**
     * Fetch a VTT payload and append unseen cues to the engine's TextTrack.
     * timeOffset rebases cue timestamps onto the local playback timeline.
     */
    async fetchSubtitleCues(engine, url, timeOffset = 0, { headers } = {}) {
        let text;
        try {
            const res = await fetch(url, headers ? { headers } : undefined);
            // 304 Not Modified: the growing .vtt hasn't changed since last tick
            if (res.status === 304) {
                engine.failures = 0;
                return 0;
            }
            if (!res.ok) {
                let detail = `HTTP ${res.status}`;
                try { detail = (await res.json()).error || detail; } catch (e) { /* not json */ }
                throw new Error(detail);
            }
            const etag = res.headers.get('etag');
            if (etag) engine.lastEtag = etag;
            text = await res.text();
        } catch (err) {
            console.warn('[WatchPage] Subtitle fetch failed:', err.message);
            engine.failures = (engine.failures || 0) + 1;
            return -1;
        }

        if (engine !== this._subEngine || !engine.trackEl?.track) return -1;
        engine.failures = 0;

        const textTrack = engine.trackEl.track;
        let added = 0;
        for (const cue of this.parseVttCues(text)) {
            const start = cue.start + timeOffset;
            const end = cue.end + timeOffset;
            const key = `${start.toFixed(3)}|${end.toFixed(3)}|${cue.text}`;
            if (engine.seenCues.has(key)) continue;
            engine.seenCues.add(key);
            try {
                textTrack.addCue(new VTTCue(start, end, cue.text));
                added++;
            } catch (e) { /* malformed cue, skip */ }
        }
        return added;
    }

    /**
     * Session mode: poll the growing in-process .vtt for new cues.
     */
    async subtitleSessionTick(engine) {
        if (engine !== this._subEngine) return;
        if (engine.done || engine.busy) return;
        engine.busy = true;

        // If-None-Match + size-based ETag: ticks are sub-second so a freshly
        // demuxed cue lands before its startTime, but unchanged files cost a
        // cheap local 304 instead of a full re-download + re-parse.
        const url = `/api/transcode/${engine.sessionId}/sub_${engine.streamIndex}.vtt`;
        const headers = engine.lastEtag ? { 'If-None-Match': engine.lastEtag } : undefined;
        const added = await this.fetchSubtitleCues(engine, url, 0, { headers });
        engine.busy = false;
        if (engine !== this._subEngine) return;

        if (added > 0) {
            engine.idleRounds = 0;
            this.updateCaptionsTracks();
        } else if (added === 0) {
            engine.idleRounds = (engine.idleRounds || 0) + 1;
            // Whole file covered (last cue reaches the known duration) and the
            // file stopped growing for ~30s: extraction is complete, stop polling
            const duration = this.getDisplayDuration();
            const track = engine.trackEl?.track;
            const lastCue = track?.cues?.length ? track.cues[track.cues.length - 1] : null;
            if (engine.idleRounds >= 60 && duration && lastCue && lastCue.endTime >= duration - 120) {
                engine.done = true;
            }
        }
        // Session gone (cleaned up server-side after a seek/restart): stop
        if ((engine.failures || 0) >= 3) engine.done = true;
    }

    /**
     * Windowed mode (direct/remux): load the window around the playhead and
     * slide forward automatically before the current window runs out.
     */
    async subtitleWindowTick(engine, force = false) {
        if (engine !== this._subEngine || engine.busy) return;

        const localPos = this.getCurrentTime();
        // User sought back before the covered range: reload a window there
        const seekedBack = engine.coveredStartLocal !== undefined &&
            localPos < engine.coveredStartLocal - 5;
        const needsNext = force || seekedBack ||
            engine.windowEndLocal === undefined ||
            localPos >= engine.windowEndLocal - 120;
        if (!needsNext) return;
        if ((engine.failures || 0) >= 3) return; // provider keeps refusing, stop hammering

        engine.busy = true;
        const WINDOW = 900; // 15 min, server-side maximum
        // Absolute position in the source file = local time + session seek offset
        const windowStartLocal = (force || seekedBack) ? Math.max(0, localPos - 5) : (engine.windowEndLocal ?? 0);
        engine.coveredStartLocal = engine.coveredStartLocal === undefined
            ? windowStartLocal
            : Math.min(engine.coveredStartLocal, windowStartLocal);
        const absStart = (this.normalizeDuration(this.subtitleStartOffset) || 0) + windowStartLocal;

        const params = new URLSearchParams({
            url: engine.sourceUrl,
            index: String(engine.streamIndex),
            codec: String(engine.codec || ''),
            duration: String(WINDOW)
        });
        if (absStart > 0) params.set('start', String(absStart));

        const added = await this.fetchSubtitleCues(engine, `/api/subtitle?${params.toString()}`, windowStartLocal ? windowStartLocal : 0);
        if (engine === this._subEngine && added >= 0) {
            engine.windowEndLocal = windowStartLocal + WINDOW;
            this.updateCaptionsTracks();
        }
        engine.busy = false;
    }

    attachSelectedProbeSubtitleTrack() {
        if (!this.video) return false;

        const selected = this.getSelectedSubtitleTrack();
        this.clearExternalSubtitleTracks();
        if (!selected) {
            this.selectedSubtitleStreamIndex = null;
            this.updateCaptionsTracks();
            return false;
        }

        // Src-less <track>: we own its TextTrack and feed cues via addCue(),
        // so updates never reload/flicker the displayed subtitle
        const trackEl = document.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = this.getTrackLabel(selected, 'Subtitle', 'subtitle');
        trackEl.srclang = this.normalizeTrackLanguage(selected.language);
        trackEl.dataset.norvaProbeSubtitle = 'true';
        trackEl.dataset.streamIndex = String(selected.index);
        this.video.appendChild(trackEl);
        if (trackEl.track) trackEl.track.mode = 'showing';

        const isSessionMode = this.currentPlaybackMode === 'transcode-session';
        const engine = {
            trackEl,
            streamIndex: selected.index,
            codec: selected.codec,
            seenCues: new Set(),
            mode: isSessionMode ? 'session' : 'window',
            sessionId: this.currentSessionId,
            sourceUrl: this.subtitleSourceUrl || this.baseStreamUrl || this.currentUrl,
            failures: 0
        };
        this._subEngine = engine;

        if (isSessionMode && this.currentSessionId) {
            this.subtitleSessionTick(engine);
            // Session subtitles are local files written by the same FFmpeg
            // process as the video. Poll them often so a newly written cue is
            // added before its startTime; otherwise it appears late but still
            // ends on time.
            this._subEngineTimer = setInterval(() => this.subtitleSessionTick(engine), 500);
        } else if (isSessionMode) {
            // Session not created yet (subtitles attach before session start):
            // do nothing — startTranscodeSession re-attaches once the id exists.
            // Crucially, no /api/subtitle fallback here: that would open a
            // second provider connection while the session is starting.
        } else {
            this.subtitleWindowTick(engine, true);
            this._subEngineTimer = setInterval(() => this.subtitleWindowTick(engine), 10000);
        }

        setTimeout(() => {
            if (trackEl.track) trackEl.track.mode = 'showing';
            this.updateCaptionsTracks();
        }, 0);
        return true;
    }

    attachProbeSubtitles(url, subtitles = this.subtitleTracks, startOffset = this.streamStartOffset) {
        if (!this.video || !url) return;

        this.subtitleSourceUrl = url;
        this.subtitleStartOffset = this.normalizeDuration(startOffset) || 0;
        this.subtitleTracks = Array.isArray(subtitles) ? subtitles : [];
        this.clearExternalSubtitleTracks();

        if (this.selectedSubtitleStreamIndex !== null && this.selectedSubtitleStreamIndex !== undefined) {
            this.attachSelectedProbeSubtitleTrack();
            return;
        }

        setTimeout(() => this.updateCaptionsTracks(), 0);
    }

    toggleCaptionsMenu() {
        if (this.captionsMenuOpen) {
            this.closeCaptionsMenu();
        } else {
            this.updateCaptionsTracks();
            this.captionsMenu?.classList.remove('hidden');
            this.captionsMenuOpen = true;
            this.closeAudioMenu();
        }
    }

    closeCaptionsMenu() {
        this.captionsMenu?.classList.add('hidden');
        this.captionsMenuOpen = false;
    }

    updateCaptionsTracks() {
        if (!this.captionsList || !this.video) return;

        const tracks = this.video.textTracks;
        const hlsSubtitleTracks = Array.isArray(this.hls?.subtitleTracks) ? this.hls.subtitleTracks : [];
        const probeSubtitleTracks = this.getExtractableSubtitleTracks();
        let options = [];
        let anyActive = false;

        if (probeSubtitleTracks.length) {
            options = probeSubtitleTracks.map((track, index) => {
                const active = Number(track.index) === Number(this.selectedSubtitleStreamIndex);
                anyActive = anyActive || active;
                return {
                    source: 'probe',
                    index,
                    streamIndex: track.index,
                    label: this.getTrackLabel(track, `Subtitle ${index + 1}`, 'subtitle'),
                    active
                };
            });
        } else {
            for (let i = 0; i < tracks.length; i++) {
                const track = tracks[i];
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    const label = track.label || track.language || `Subtitle ${i + 1}`;
                    const active = track.mode === 'showing';
                    anyActive = anyActive || active;
                    options.push({
                        source: 'native',
                        index: i,
                        label,
                        active
                    });
                }
            }
        }

        if (!options.length && hlsSubtitleTracks.length) {
            options = hlsSubtitleTracks.map((track, index) => {
                const active = this.hls.subtitleTrack === index;
                anyActive = anyActive || active;
                return {
                    source: 'hls',
                    index,
                    label: track.name || track.lang || `Subtitle ${index + 1}`,
                    active
                };
            });
        }

        const offActive = !anyActive;
        const optionHtml = options.map(track => {
            const streamAttr = track.streamIndex !== undefined ? ` data-stream-index="${track.streamIndex}"` : '';
            return `<button class="captions-option ${track.active ? 'active' : ''}" data-source="${track.source}" data-index="${track.index}"${streamAttr}>${this.escapeHtml(track.label)}</button>`;
        }).join('');

        this.captionsList.innerHTML = `<button class="captions-option ${offActive ? 'active' : ''}" data-source="off" data-index="-1">Off</button>${optionHtml}`;

        this.captionsList.querySelectorAll('.captions-option').forEach(btn => {
            btn.addEventListener('click', () => this.selectCaptionTrack(
                btn.dataset.source,
                parseInt(btn.dataset.index, 10),
                btn.dataset.streamIndex !== undefined ? parseInt(btn.dataset.streamIndex, 10) : null
            ));
        });
    }

    async selectCaptionTrack(source, index, streamIndex = null) {
        if (!this.video) return;

        const tracks = this.video.textTracks;
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].mode = 'hidden';
        }

        if (this.hls) {
            this.hls.subtitleDisplay = false;
            this.hls.subtitleTrack = -1;
        }

        if (source === 'off') {
            this.selectedSubtitleStreamIndex = null;
            this.clearExternalSubtitleTracks();
        } else if (source === 'probe' && Number.isInteger(streamIndex)) {
            this.selectedSubtitleStreamIndex = streamIndex;
            this.attachSelectedProbeSubtitleTrack();
        } else if (source === 'native' && index >= 0 && index < tracks.length) {
            this.selectedSubtitleStreamIndex = null;
            tracks[index].mode = 'showing';
        } else if (source === 'hls' && this.hls && index >= 0) {
            this.selectedSubtitleStreamIndex = null;
            this.hls.subtitleDisplay = true;
            this.hls.subtitleTrack = index;
        }

        this.updateCaptionsTracks();
        this.closeCaptionsMenu();
    }

    // === Overlay Auto-Hide ===

    showOverlay() {
        this.overlay?.classList.remove('hidden');
        this.overlayVisible = true;
        this.startOverlayTimer();
    }

    hideOverlay() {
        if (!this.video?.paused) {
            this.overlay?.classList.add('hidden');
            this.overlayVisible = false;
        }
    }

    startOverlayTimer() {
        clearTimeout(this.overlayTimeout);
        this.overlayTimeout = setTimeout(() => this.hideOverlay(), 3000);
    }

    // === Keyboard Shortcuts ===

    handleKeyboard(e) {
        // Only handle when watch page is active
        const watchPage = document.getElementById('page-watch');
        if (!watchPage?.classList.contains('active')) return;

        // Don't handle if typing in input
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.skip(-10);
                this.showOverlay();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.skip(10);
                this.showOverlay();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.setVolume(Math.min(100, parseInt(this.volumeSlider.value) + 10));
                this.volumeSlider.value = Math.min(100, parseInt(this.volumeSlider.value) + 10);
                this.showOverlay();
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.setVolume(Math.max(0, parseInt(this.volumeSlider.value) - 10));
                this.volumeSlider.value = Math.max(0, parseInt(this.volumeSlider.value) - 10);
                this.showOverlay();
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.toggleMute();
                this.showOverlay();
                break;
            case 'Escape':
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    this.goBack();
                }
                break;
        }
    }

    // === Details Section ===

    renderDetails() {
        if (!this.content) return;

        const isChannel = this.content.type === 'channel' || !this.content.type; // Default to channel if unknown
        const fallback = isChannel ? '/img/placeholder.png' : '/img/poster-placeholder.jpg';

        this.posterEl.onerror = () => {
            this.posterEl.onerror = null;
            this.posterEl.src = fallback;
        };
        this.posterEl.src = this.content.poster || fallback;
        this.posterEl.alt = this.content.title || '';
        this.contentTitleEl.textContent = this.content.title || '';
        this.yearEl.textContent = this.content.year || '';
        this.ratingEl.textContent = this.content.rating ? `★ ${this.content.rating}` : '';
        this.descriptionEl.textContent = this.content.description || '';

        // Update play button text
        if (this.playBtnText) {
            this.playBtnText.textContent = 'Play';
        }
    }

    async checkFavorite() {
        if (!this.content) return;

        try {
            const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
            const itemType = this.contentType === 'movie' ? 'movie' : 'series';
            const result = await API.favorites.check(this.content.sourceId, itemId, itemType);
            this.isFavorite = result?.isFavorite || false;
            this.updateFavoriteUI();
        } catch (e) {
            console.warn('Could not check favorite status');
        }
    }

    async toggleFavorite() {
        if (!this.content) return;

        const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
        const itemType = this.contentType === 'movie' ? 'movie' : 'series';

        try {
            if (this.isFavorite) {
                await API.favorites.remove(this.content.sourceId, itemId, itemType);
                this.isFavorite = false;
            } else {
                await API.favorites.add(this.content.sourceId, itemId, itemType);
                this.isFavorite = true;
            }
            this.updateFavoriteUI();
        } catch (e) {
            console.error('Error toggling favorite:', e);
        }
    }

    updateFavoriteUI() {
        const outlineIcon = this.favoriteBtn?.querySelector('.icon-fav-outline');
        const filledIcon = this.favoriteBtn?.querySelector('.icon-fav-filled');

        outlineIcon?.classList.toggle('hidden', this.isFavorite);
        filledIcon?.classList.toggle('hidden', !this.isFavorite);
    }

    scrollToVideo() {
        document.getElementById('page-watch')?.scrollTo({ top: 0, behavior: 'smooth' });
        if (this.video?.paused) {
            this.video.play().catch(console.error);
        }
    }

    // === Recommended Movies ===

    async loadRecommended(sourceId, categoryId) {
        if (!sourceId || !categoryId) {
            this.recommendedSection?.classList.add('hidden');
            return;
        }

        try {
            const movies = await API.proxy.xtream.vodStreams(sourceId, categoryId);
            if (!movies || movies.length === 0) {
                this.recommendedSection?.classList.add('hidden');
                return;
            }

            // Filter out current movie, take first 12
            const filtered = movies
                .filter(m => m.stream_id !== this.content?.id)
                .slice(0, 12);

            this.renderRecommendedGrid(filtered, sourceId);
        } catch (e) {
            console.error('Error loading recommended:', e);
            this.recommendedSection?.classList.add('hidden');
        }
    }

    renderRecommendedGrid(movies, sourceId) {
        if (!this.recommendedGrid) return;

        this.recommendedGrid.innerHTML = movies.map(movie => `
            <div class="watch-recommended-card" data-id="${movie.stream_id}" data-source="${sourceId}">
                <img src="${movie.stream_icon || movie.cover || '/img/placeholder.png'}" 
                     alt="${movie.name}" 
                     onerror="this.onerror=null;this.src='/img/placeholder.png'" loading="lazy">
                <p>${movie.name}</p>
            </div>
        `).join('');

        // Click handlers
        this.recommendedGrid.querySelectorAll('.watch-recommended-card').forEach(card => {
            card.addEventListener('click', () => this.playRecommendedMovie(card.dataset.id, parseInt(card.dataset.source)));
        });
    }

    async playRecommendedMovie(streamId, sourceId) {
        try {
            // Fetch movie details
            const movies = await API.proxy.xtream.vodStreams(sourceId);
            const movie = movies?.find(m => m.stream_id == streamId);

            if (!movie) return;

            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(sourceId, streamId, 'movie', container);

            if (result?.url) {
                this.play({
                    type: 'movie',
                    id: movie.stream_id,
                    title: movie.name,
                    poster: movie.stream_icon || movie.cover,
                    description: movie.plot || '',
                    year: movie.year,
                    rating: movie.rating,
                    sourceId: sourceId,
                    categoryId: movie.category_id,
                    cloudPlaybackSessionId: result.sessionId
                }, result.url, { sessionId: result.sessionId });
            }
        } catch (e) {
            console.error('Error playing recommended movie:', e);
        }
    }

    // === Series Episodes ===

    renderEpisodes() {
        if (!this.seriesInfo?.episodes || !this.seasonsContainer) return;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));

        this.seasonsContainer.innerHTML = seasons.map(seasonNum => {
            const episodes = this.seriesInfo.episodes[seasonNum];
            const isCurrentSeason = parseInt(seasonNum) === parseInt(this.currentSeason);

            return `
                <div class="watch-season-group">
                    <div class="watch-season-header ${isCurrentSeason ? '' : 'collapsed'}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                        </svg>
                        <span class="watch-season-name">Season ${seasonNum}</span>
                        <span class="watch-season-count">${episodes.length} episodes</span>
                    </div>
                    <div class="watch-episode-list">
                        ${episodes.map(ep => {
                const isActive = parseInt(seasonNum) === parseInt(this.currentSeason) &&
                    parseInt(ep.episode_num) === parseInt(this.currentEpisode);
                return `
                                <div class="watch-episode-item ${isActive ? 'active' : ''}" 
                                     data-episode-id="${ep.id}" 
                                     data-season="${seasonNum}"
                                     data-episode="${ep.episode_num}"
                                     data-container="${ep.container_extension || 'mp4'}">
                                    <span class="watch-episode-num">E${ep.episode_num}</span>
                                    <span class="watch-episode-title">${ep.title || `Episode ${ep.episode_num}`}</span>
                                    <span class="watch-episode-duration">${ep.duration || ''}</span>
                                </div>
                            `;
            }).join('')}
                    </div>
                </div>
            `;
        }).join('');

        // Season header toggle
        this.seasonsContainer.querySelectorAll('.watch-season-header').forEach(header => {
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
            });
        });

        // Episode click handlers
        this.seasonsContainer.querySelectorAll('.watch-episode-item').forEach(ep => {
            ep.addEventListener('click', () => this.playEpisodeFromList(ep));
        });
    }

    async playEpisodeFromList(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const seasonNum = episodeEl.dataset.season;
        const episodeNum = episodeEl.dataset.episode;
        const container = episodeEl.dataset.container || 'mp4';

        try {
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, episodeId, 'series', container);

            if (result?.url) {
                const episodeTitle = episodeEl.querySelector('.watch-episode-title')?.textContent || `Episode ${episodeNum}`;

                this.play({
                    type: 'series',
                    id: episodeId,
                    title: this.content.title,
                    subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: seasonNum,
                    currentEpisode: episodeNum,
                    cloudPlaybackSessionId: result.sessionId
                }, result.url, { sessionId: result.sessionId });
            }
        } catch (e) {
            console.error('Error playing episode:', e);
        }
    }

    // === Next Episode ===

    getNextEpisode() {
        if (!this.seriesInfo?.episodes || !this.currentSeason || !this.currentEpisode) return null;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));
        const currentSeasonEpisodes = this.seriesInfo.episodes[this.currentSeason] || [];

        // Find next episode in current season
        const currentEpIndex = currentSeasonEpisodes.findIndex(ep =>
            parseInt(ep.episode_num) === parseInt(this.currentEpisode)
        );

        if (currentEpIndex >= 0 && currentEpIndex < currentSeasonEpisodes.length - 1) {
            return {
                ...currentSeasonEpisodes[currentEpIndex + 1],
                seasonNum: this.currentSeason
            };
        }

        // Try next season
        const currentSeasonIndex = seasons.indexOf(String(this.currentSeason));
        if (currentSeasonIndex >= 0 && currentSeasonIndex < seasons.length - 1) {
            const nextSeason = seasons[currentSeasonIndex + 1];
            const nextSeasonEpisodes = this.seriesInfo.episodes[nextSeason];
            if (nextSeasonEpisodes?.length > 0) {
                return {
                    ...nextSeasonEpisodes[0],
                    seasonNum: nextSeason
                };
            }
        }

        return null;
    }

    showNextEpisodePanel(nextEp) {
        if (!this.nextEpisodePanel) return;

        this.nextEpisodeTitle.textContent = `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`;
        this.nextEpisodePanel.classList.remove('hidden');
        this.nextEpisodePanel.nextEpisodeData = nextEp;

        // Start countdown
        this.nextEpisodeCountdown = 10;
        this.nextCountdown.textContent = this.nextEpisodeCountdown;

        this.nextEpisodeInterval = setInterval(() => {
            this.nextEpisodeCountdown--;
            this.nextCountdown.textContent = this.nextEpisodeCountdown;

            if (this.nextEpisodeCountdown <= 0) {
                this.playNextEpisode();
            }
        }, 1000);
    }

    async playNextEpisode() {
        // Save next episode data BEFORE canceling (cancel clears the data)
        const nextEp = this.nextEpisodePanel?.nextEpisodeData;

        this.cancelNextEpisode();

        if (!nextEp) return;

        try {
            const container = nextEp.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, nextEp.id, 'series', container);

            if (result?.url) {
                this.play({
                    type: 'series',
                    id: nextEp.id,
                    title: this.content.title,
                    subtitle: `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: nextEp.seasonNum,
                    currentEpisode: nextEp.episode_num,
                    cloudPlaybackSessionId: result.sessionId
                }, result.url, { sessionId: result.sessionId });
            }
        } catch (e) {
            console.error('Error playing next episode:', e);
        }
    }

    cancelNextEpisode() {
        clearInterval(this.nextEpisodeInterval);
        this.nextEpisodePanel?.classList.add('hidden');
        this.nextEpisodeShowing = false;
        this.nextEpisodeDismissed = true; // Prevent re-triggering
        if (this.nextEpisodePanel) {
            this.nextEpisodePanel.nextEpisodeData = null;
        }
    }

    // === Navigation ===

    goBack() {
        this.stop();
        this.cancelNextEpisode();

        // Navigate to the page we came from (stored in returnPage)
        // We don't use history.back() because we used replaceHistory when navigating here
        this.app.navigateTo(this.returnPage || 'movies');
    }

    show() {
        // Called when page becomes visible
    }

    hide() {
        // Called when page becomes hidden
        // Don't stop playback here - allow background playback
        this.cancelNextEpisode();
    }
    // ============================================================
    // Watch History Tracking
    // ============================================================

    startHistoryTracking() {
        this.stopHistoryTracking(); // Clear existing if any
        this.historyInterval = setInterval(() => this.saveProgress(), 10000); // 10s
    }

    stopHistoryTracking() {
        if (this.historyInterval) {
            clearInterval(this.historyInterval);
            this.historyInterval = null;
        }
    }

    async saveProgress() {
        if (!this.content || !this.video || this.video.paused) return;

        const progress = Math.floor(this.getPlaybackPosition());
        const validDuration = this.getDisplayDuration();
        const duration = validDuration ? Math.floor(validDuration) : 0;

        if (isNaN(progress) || isNaN(duration) || duration <= 0) return;

        try {
            const data = {
                title: this.content.title || 'Unknown Title',
                subtitle: this.content.subtitle || (this.content.type === 'movie' ? 'Movie' : 'Series'),
                poster: this.content.poster,
                sourceId: this.content.sourceId,
                containerExtension: this.containerExtension,
                // Series-specific fields for next episode functionality
                seriesId: this.content.seriesId || null,
                currentSeason: this.currentSeason || null,
                currentEpisode: this.currentEpisode || null
            };

            await window.API.request('POST', '/history', {
                id: this.content.id,
                type: this.content.type === 'movie' ? 'movie' : 'episode',
                sourceId: this.content.sourceId,
                progress,
                duration,
                data
            });
        } catch (err) {
            console.warn('[History] Failed to save progress:', err);
        }
    }
}

window.WatchPage = WatchPage;
