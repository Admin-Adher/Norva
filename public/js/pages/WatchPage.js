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

        // Restart / episode navigation / speed / in-player episodes selector
        this.restartBtn = document.getElementById('watch-restart');
        this.prevEpBtn = document.getElementById('watch-prev-ep');
        this.nextEpBtn = document.getElementById('watch-next-ep');
        this.episodesNavWrapper = document.getElementById('watch-episodes-wrapper');
        this.episodesNavBtn = document.getElementById('watch-episodes-btn');
        this.episodesNavMenu = document.getElementById('watch-episodes-menu');
        this.episodesNavList = document.getElementById('watch-episodes-menu-list');
        this.speedBtn = document.getElementById('watch-speed-btn');
        this.speedMenu = document.getElementById('watch-speed-menu');
        this.speedList = document.getElementById('watch-speed-list');
        this._playbackRate = 1;
        this.speedMenuOpen = false;
        this.episodesMenuOpen = false;

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
        this.subtitleOffsetSeconds = 0;
        this.selectedSubtitleTrackUserChoice = false;
        this.selectedAudioStreamIndex = null;
        this.selectedAudioTrackUserChoice = false;
        this.pendingPlaybackPreferences = null;
        this._pendingAudioPreferenceApplied = false;
        this._pendingSubtitlePreferenceApplied = false;
        this._videoEncodeFallbackTried = false;
        this._playbackAttemptId = 0;
        this._playbackStatusOkReported = false;
        this._seekDebounceTimer = null;
        this._pendingSeekTarget = null;
        this._pendingLocalSeekTarget = null;
        this._pendingLocalSeekAttempts = 0;
        this._pendingLocalSeekTimer = null;
        this._gatewaySeekRetry = null;
        this._gatewaySeekRequestId = 0;
        this._suppressMediaErrorsUntil = 0;
        this._pendingPlaybackErrorTimer = null;
        this._pendingPlaybackErrorMessage = null;
        this._timelineScrubbing = false;
        this._lastCommittedSeekPercent = null;
        this._lastCommittedSeekAt = 0;
        this._audioSwitchPromise = null;
        this._audioSwitchRequestId = 0;
        this.currentSessionId = null;
        this.activeSessionIds = new Set();
        this.currentCloudPlaybackSessionId = null;
        this.activeCloudPlaybackSessionIds = new Set();
        this.playbackTelemetry = null;
        this._playRequestedAt = 0;
        this._firstFrameReported = false;
        this._playStartedReported = false;
        this._playbackEnded = false;
        this._lastPauseTelemetryAt = 0;
        this._handlingPlaybackFailure = false;
        this.resumeSnapshotKey = 'norva-watch-resume-v1';
        this.resumeSnapshotTtlMs = 6 * 60 * 60 * 1000;
        this.resumeSnapshotSaveIntervalMs = 2000;
        // Persistent per-title resume positions (localStorage): survives quit and
        // tab close, independent of the catalog/server, used as a resume fallback.
        this.resumePositionsKey = 'norva-resume-pos-v1';
        this.resumePositionsTtlMs = 7 * 24 * 60 * 60 * 1000;
        this._lastResumeSnapshotSaveAt = 0;
        this._resumeRestorePromise = null;
        this._resumePlaybackMetadata = null;
        this._suspendResumeSnapshotSave = false;
        this._lastKnownPlaybackPosition = 0;
        this._lastKnownPlaybackDuration = 0;
        this.playbackErrorRefreshKey = 'norva-watch-error-refresh-v1';
        this.playbackErrorRefreshDelayMs = 2000;
        this.playbackErrorRefreshGuardMs = 60000;
        this._playbackErrorRefreshTimer = null;

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

        // Progress bar: update the UI while dragging, commit one real seek on release.
        this.progressSlider?.addEventListener('pointerdown', () => {
            this._timelineScrubbing = true;
        });
        this.progressSlider?.addEventListener('input', (e) => this.previewSeek(e.target.value));
        this.progressSlider?.addEventListener('change', (e) => this.commitSeek(e.target.value));
        this.progressSlider?.addEventListener('pointerup', (e) => this.commitSeek(e.target.value));

        // Video events
        this.video?.addEventListener('timeupdate', () => {
            this.updateProgress();
            this.markPlaybackUsable();
            this.trackPlaybackPosition();
            this.saveResumeSnapshotThrottled();
        });
        this.video?.addEventListener('loadedmetadata', () => {
            this.onMetadataLoaded();
            this.restorePendingAudioPreference();
            this.restorePendingSubtitlePreference();
            this.applyPendingLocalSeek();
            this.markPlaybackUsable();
            this.trackPlaybackPosition({ force: true });
            this.saveResumeSnapshotThrottled(true);
        });
        this.video?.addEventListener('seeking', () => this.trackPlaybackPosition({ force: true }));
        this.video?.addEventListener('seeked', () => {
            this.trackPlaybackPosition({ force: true });
            this.saveResumeSnapshotThrottled(true);
        });
        this.video?.addEventListener('loadeddata', () => {
            this.applyPendingLocalSeek();
            this.markPlaybackUsable();
        });
        this.video?.addEventListener('durationchange', () => this.updateDurationState());
        this.video?.addEventListener('play', () => this.onPlay());
        this.video?.addEventListener('playing', () => this.markPlaybackUsable());
        this.video?.addEventListener('pause', () => this.onPause());
        this.video?.addEventListener('ended', () => this.onEnded());
        this.video?.addEventListener('error', (e) => this.onError(e));
        this.video?.addEventListener('waiting', () => this.showLoading());
        this.video?.addEventListener('canplay', () => {
            this.applyPendingLocalSeek();
            this.markPlaybackUsable();
        });

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

        // Restart from the beginning (movies + series)
        this.restartBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.restartFromStart(); });
        // Episode navigation (series)
        this.prevEpBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.playPreviousEpisode(); });
        this.nextEpBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.playNextEpisode(); });
        // In-player episodes selector (series)
        this.episodesNavBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleEpisodesMenu(); });
        // Playback speed
        this.speedBtn?.addEventListener('click', (e) => { e.stopPropagation(); this.toggleSpeedMenu(); });
        this.speedList?.addEventListener('click', (e) => {
            const opt = e.target.closest('.speed-option');
            if (opt) this.setPlaybackRate(parseFloat(opt.dataset.rate));
        });

        // Close track menus when clicking outside
        document.addEventListener('click', (e) => {
            if (this.audioMenuOpen && !this.audioMenu?.contains(e.target) && e.target !== this.audioBtn) {
                this.closeAudioMenu();
            }
            if (this.captionsMenuOpen && !this.captionsMenu?.contains(e.target) && e.target !== this.captionsBtn) {
                this.closeCaptionsMenu();
            }
            if (this.speedMenuOpen && !this.speedMenu?.contains(e.target) && e.target !== this.speedBtn) {
                this.closeSpeedMenu();
            }
            if (this.episodesMenuOpen && !this.episodesNavMenu?.contains(e.target) && e.target !== this.episodesNavBtn) {
                this.closeEpisodesMenu();
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

        window.addEventListener('pagehide', () => this.persistPlaybackStateForExit());
        window.addEventListener('beforeunload', () => this.persistPlaybackStateForExit());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.persistPlaybackStateForExit();
            }
        });
    }

    cloneForResumeStorage(value) {
        if (value === undefined || value === null) return null;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_) {
            return null;
        }
    }

    sanitizeResumeContent(content = {}) {
        if (!content || typeof content !== 'object') return null;

        const copy = {};
        [
            'type', 'id', 'title', 'subtitle', 'poster', 'description', 'year', 'rating',
            'sourceId', 'cloudSourceId', 'seriesId', 'categoryId', 'currentSeason',
            'currentEpisode', 'containerExtension', 'durationHint', 'titleId',
            'variantCount', '_variantCount', 'providerTmdbId'
        ].forEach(key => {
            if (content[key] !== undefined && content[key] !== null) copy[key] = content[key];
        });

        if (Array.isArray(content.versions)) {
            copy.versions = content.versions.map(version => ({
                sourceId: version.sourceId,
                streamId: version.streamId,
                container: version.container,
                type: version.type,
                label: version.label
            })).filter(version => version.sourceId && version.streamId);
        }
        if (Number.isFinite(Number(content.versionIndex))) {
            copy.versionIndex = Number(content.versionIndex);
        }
        const defaultVariant = this.cloneForResumeStorage(content.defaultVariant || content.default_variant);
        if (defaultVariant) copy.defaultVariant = defaultVariant;
        const seriesInfo = this.cloneForResumeStorage(content.seriesInfo);
        if (seriesInfo) copy.seriesInfo = seriesInfo;

        return copy;
    }

    sanitizeResumePlayback(playback = {}) {
        const metadata = this.playbackMetadataFromResult(playback || {});
        const codecProfile = this.cloneForResumeStorage(metadata.codecProfile || metadata.codec_profile);
        const playbackPreferences = this.cloneForResumeStorage(
            metadata.playbackPreferences
            || metadata.playback_preferences
            || metadata.preferences
            || this.getPlaybackPreferences()
        );
        const result = {};
        if (codecProfile) result.codecProfile = codecProfile;
        if (metadata.audioMode || metadata.audio_mode) result.audioMode = metadata.audioMode || metadata.audio_mode;
        if (metadata.gatewayMode || metadata.gateway_mode) result.gatewayMode = metadata.gatewayMode || metadata.gateway_mode;
        if (playbackPreferences) result.playbackPreferences = playbackPreferences;
        return result;
    }

    normalizePlaybackPreferences(value = null) {
        if (!value || typeof value !== 'object') return null;
        const audio = value.audio || value.selectedAudio || value.audioTrack || null;
        const subtitle = value.subtitle || value.subtitles || value.selectedSubtitle || value.caption || null;
        const result = {};
        if (audio && typeof audio === 'object') result.audio = { ...audio };
        if (subtitle && typeof subtitle === 'object') result.subtitle = { ...subtitle };
        return result.audio || result.subtitle ? result : null;
    }

    getPlaybackPreferences() {
        const result = {};
        const audio = this.getCurrentAudioPreference();
        const subtitle = this.getCurrentSubtitlePreference();
        if (audio) result.audio = audio;
        if (subtitle) result.subtitle = subtitle;
        return result.audio || result.subtitle ? result : null;
    }

    getMergedPlaybackPreferences(overrides = {}) {
        const current = this.getPlaybackPreferences() || {};
        const existing = this.normalizePlaybackPreferences(
            this.content?.playbackPreferences || this.content?.playback_preferences || {}
        ) || {};
        const merged = {
            ...existing,
            ...current,
            ...overrides
        };
        if (!merged.audio) delete merged.audio;
        if (!merged.subtitle) delete merged.subtitle;
        return merged.audio || merged.subtitle ? merged : null;
    }

    savePlaybackPreferences(preferences) {
        const normalized = this.normalizePlaybackPreferences(preferences);
        if (!this.content || !normalized) return null;
        this.content.playbackPreferences = normalized;
        this.setPendingPlaybackPreferences(normalized);
        return normalized;
    }

    getCurrentAudioPreference() {
        const selectedProbe = this.getSelectedAudioTrack();
        if (this.selectedAudioTrackUserChoice && selectedProbe) {
            return this.audioPreferenceFromProbeTrack(selectedProbe);
        }

        if (this.hls && Number.isInteger(this.hls.audioTrack) && this.hls.audioTrack >= 0) {
            const track = this.hls.audioTracks?.[this.hls.audioTrack];
            if (track) {
                return {
                    source: 'hls',
                    index: this.hls.audioTrack,
                    label: track.name || track.lang || `Audio ${this.hls.audioTrack + 1}`,
                    language: track.lang || null
                };
            }
        }

        const nativeTracks = this.video?.audioTracks;
        if (nativeTracks && Number.isFinite(nativeTracks.length)) {
            for (let i = 0; i < nativeTracks.length; i++) {
                const track = nativeTracks[i];
                if (track?.enabled) {
                    return {
                        source: 'native',
                        index: i,
                        label: track.label || track.language || `Audio ${i + 1}`,
                        language: track.language || null
                    };
                }
            }
        }

        return null;
    }

    audioPreferenceFromProbeTrack(track) {
        if (!track) return null;
        return {
            source: 'probe',
            streamIndex: track.index,
            label: this.getTrackLabel(track, 'Audio', 'audio'),
            language: track.language || null,
            codec: track.codec || null,
            channels: track.channels || null
        };
    }

    getCurrentSubtitlePreference() {
        const selectedProbe = this.getSelectedSubtitleTrack();
        if (selectedProbe) {
            const subtitleTracks = this.getExtractableSubtitleTracks();
            const trackIndex = subtitleTracks.indexOf(selectedProbe);
            return {
                source: 'probe',
                streamIndex: selectedProbe.index,
                label: this.getSubtitleMenuLabel(selectedProbe, subtitleTracks, trackIndex, 'Subtitles'),
                language: selectedProbe.inferredLanguage || selectedProbe.language || null,
                offsetSeconds: this.normalizeSubtitleOffset(this.subtitleOffsetSeconds)
            };
        }

        if (this.hls && Number.isInteger(this.hls.subtitleTrack) && this.hls.subtitleTrack >= 0) {
            const track = this.hls.subtitleTracks?.[this.hls.subtitleTrack];
            if (track) {
                return {
                    source: 'hls',
                    index: this.hls.subtitleTrack,
                    label: track.name || track.lang || `Subtitle ${this.hls.subtitleTrack + 1}`,
                    language: track.lang || null
                };
            }
        }

        const textTracks = this.video?.textTracks;
        if (textTracks && Number.isFinite(textTracks.length)) {
            for (let i = 0; i < textTracks.length; i++) {
                const track = textTracks[i];
                if (track?.mode === 'showing') {
                    return {
                        source: 'native',
                        index: i,
                        label: track.label || track.language || `Subtitle ${i + 1}`,
                        language: track.language || null
                    };
                }
            }
        }

        if (this.selectedSubtitleTrackUserChoice && this.selectedSubtitleStreamIndex === null) {
            return { source: 'off', mode: 'off' };
        }

        return null;
    }

    setPendingPlaybackPreferences(value) {
        this.pendingPlaybackPreferences = this.normalizePlaybackPreferences(value);
        this._pendingAudioPreferenceApplied = false;
        this._pendingSubtitlePreferenceApplied = false;
    }

    clearPendingPreference(kind) {
        if (kind === 'audio') this._pendingAudioPreferenceApplied = true;
        if (kind === 'subtitle') this._pendingSubtitlePreferenceApplied = true;
    }

    findTrackByPreference(tracks, preference, fallbackIndex = null, type = 'track') {
        if (!Array.isArray(tracks) || !preference) return null;
        const streamIndex = Number(preference.streamIndex ?? preference.stream_index);
        if (Number.isInteger(streamIndex)) {
            const byStream = tracks.find(track => Number(track?.index) === streamIndex);
            if (byStream) return byStream;
        }

        const index = Number(preference.index);
        if (Number.isInteger(index) && tracks[index]) return tracks[index];

        const language = this.normalizeTrackLanguage(preference.language || preference.lang);
        if (language && language !== 'und') {
            const byLanguage = tracks.find(track => this.normalizeTrackLanguage(track?.language || track?.lang) === language);
            if (byLanguage) return byLanguage;
        }

        const label = String(preference.label || '').trim().toLowerCase();
        if (label) {
            const byLabel = tracks.find(track => {
                const trackIndex = tracks.indexOf(track);
                const candidate = type === 'subtitle'
                    ? this.getSubtitleTrackLabel(track, '').toLowerCase()
                    : this.getTrackLabel(track, '', type).toLowerCase();
                const menuCandidate = type === 'subtitle'
                    ? this.getSubtitleMenuLabel(track, tracks, trackIndex, '').toLowerCase()
                    : '';
                return candidate && (candidate === label || menuCandidate === label);
            });
            if (byLabel) return byLabel;
        }

        if (Number.isInteger(fallbackIndex) && tracks[fallbackIndex]) return tracks[fallbackIndex];
        return null;
    }

    restorePendingAudioPreference(info = this.currentStreamInfo) {
        if (this._pendingAudioPreferenceApplied) return false;
        const preference = this.pendingPlaybackPreferences?.audio;
        if (!preference) return false;

        const probeTracks = Array.isArray(info?.audioTracks) && info.audioTracks.length
            ? info.audioTracks
            : this.audioTracks;
        if (probeTracks?.length && (preference.source === 'probe' || preference.streamIndex !== undefined || preference.stream_index !== undefined)) {
            const track = this.findTrackByPreference(probeTracks, preference, null, 'audio');
            if (track) {
                this.selectedAudioStreamIndex = track.index;
                this.selectedAudioTrackUserChoice = true;
                this._pendingAudioPreferenceApplied = true;
                return true;
            }
        }

        if (preference.source === 'hls' && this.hls?.audioTracks?.length) {
            const track = this.findTrackByPreference(this.hls.audioTracks, preference, Number(preference.index), 'audio');
            const index = this.hls.audioTracks.indexOf(track);
            if (index >= 0) {
                this.hls.audioTrack = index;
                this._pendingAudioPreferenceApplied = true;
                return true;
            }
        }

        const nativeTracks = this.video?.audioTracks;
        if (preference.source === 'native' && nativeTracks && Number.isFinite(nativeTracks.length)) {
            const index = Number(preference.index);
            if (Number.isInteger(index) && index >= 0 && index < nativeTracks.length) {
                for (let i = 0; i < nativeTracks.length; i++) nativeTracks[i].enabled = i === index;
                this._pendingAudioPreferenceApplied = true;
                return true;
            }
        }

        return false;
    }

    restorePendingSubtitlePreference() {
        if (this._pendingSubtitlePreferenceApplied) return false;
        const preference = this.pendingPlaybackPreferences?.subtitle;
        if (!preference) return false;

        if (preference.source === 'off' || preference.mode === 'off') {
            this.selectedSubtitleStreamIndex = null;
            this.subtitleOffsetSeconds = 0;
            this.selectedSubtitleTrackUserChoice = true;
            this._pendingSubtitlePreferenceApplied = true;
            if (this.hls) {
                this.hls.subtitleDisplay = false;
                this.hls.subtitleTrack = -1;
            }
            const textTracks = this.video?.textTracks;
            if (textTracks && Number.isFinite(textTracks.length)) {
                for (let i = 0; i < textTracks.length; i++) textTracks[i].mode = 'hidden';
            }
            this.clearExternalSubtitleTracks();
            return true;
        }

        const probeTracks = this.getExtractableSubtitleTracks();
        if (probeTracks.length && (preference.source === 'probe' || preference.streamIndex !== undefined || preference.stream_index !== undefined)) {
            const track = this.findTrackByPreference(probeTracks, preference, null, 'subtitle');
            if (track) {
                this.selectedSubtitleStreamIndex = track.index;
                this.subtitleOffsetSeconds = this.normalizeSubtitleOffset(
                    preference.offsetSeconds ?? preference.offset_seconds ?? this.loadSubtitleOffset(track.index)
                );
                this.selectedSubtitleTrackUserChoice = true;
                this._pendingSubtitlePreferenceApplied = true;
                return true;
            }
        }

        if (preference.source === 'hls' && this.hls?.subtitleTracks?.length) {
            const track = this.findTrackByPreference(this.hls.subtitleTracks, preference, Number(preference.index), 'subtitle');
            const index = this.hls.subtitleTracks.indexOf(track);
            if (index >= 0) {
                this.hls.subtitleDisplay = true;
                this.hls.subtitleTrack = index;
                this.selectedSubtitleTrackUserChoice = true;
                this._pendingSubtitlePreferenceApplied = true;
                return true;
            }
        }

        const textTracks = this.video?.textTracks;
        if (preference.source === 'native' && textTracks && Number.isFinite(textTracks.length)) {
            const index = Number(preference.index);
            if (Number.isInteger(index) && index >= 0 && index < textTracks.length) {
                for (let i = 0; i < textTracks.length; i++) textTracks[i].mode = i === index ? 'showing' : 'hidden';
                this.selectedSubtitleTrackUserChoice = true;
                this._pendingSubtitlePreferenceApplied = true;
                return true;
            }
        }

        return false;
    }

    getResumeSnapshotPosition() {
        this.trackPlaybackPosition();
        const position = Math.max(
            this._lastKnownPlaybackPosition || 0,
            this.getPlaybackPosition?.() || 0,
            this.video?.currentTime || 0,
            this.resumeTime || 0
        );
        return Math.max(0, Math.floor(Number.isFinite(position) ? position : 0));
    }

    trackPlaybackPosition(options = {}) {
        const rawDuration = this.getDisplayDuration?.() || this.durationHint || this._lastKnownPlaybackDuration || 0;
        const duration = Number(rawDuration);
        if (Number.isFinite(duration) && duration > 0) {
            this._lastKnownPlaybackDuration = Math.floor(duration);
        }

        const rawPosition = Number.isFinite(Number(options.position))
            ? Number(options.position)
            : (this.getPlaybackPosition?.() || this.video?.currentTime || this.resumeTime || 0);
        if (!Number.isFinite(rawPosition) || rawPosition < 0) return this._lastKnownPlaybackPosition || 0;

        const position = Math.floor(rawPosition);
        if (options.force || position >= (this._lastKnownPlaybackPosition || 0) || position <= 2) {
            this._lastKnownPlaybackPosition = position;
        }
        return this._lastKnownPlaybackPosition || 0;
    }

    persistPlaybackStateForExit() {
        this.trackPlaybackPosition({ force: true });
        this.saveResumeSnapshotThrottled(true);
        this.saveProgress({ force: true });
    }

    getResumeRestorePosition(position, duration = 0) {
        const rawPosition = Math.max(0, Math.floor(Number(position) || 0));
        const rawDuration = Math.max(0, Math.floor(Number(duration) || 0));
        if (rawPosition < 12) return 0;
        if (rawDuration > 0 && rawPosition >= rawDuration * 0.95) return 0;
        return Math.max(0, rawPosition - 3);
    }

    saveResumeSnapshotThrottled(force = false) {
        if (this._suspendResumeSnapshotSave) return;
        const now = Date.now();
        if (!force && now - this._lastResumeSnapshotSaveAt < this.resumeSnapshotSaveIntervalMs) return;
        this._lastResumeSnapshotSaveAt = now;
        this.saveResumeSnapshot();
    }

    saveResumeSnapshot(overrides = {}) {
        if (this._suspendResumeSnapshotSave) return;
        if (!this.content?.id || !this.content?.sourceId) return;
        if (this.content.type !== 'movie' && this.content.type !== 'series') return;

        const content = this.sanitizeResumeContent({
            ...this.content,
            containerExtension: this.containerExtension,
            currentSeason: this.currentSeason,
            currentEpisode: this.currentEpisode,
            seriesInfo: this.seriesInfo,
            durationHint: this.durationHint
        });
        if (!content?.id || !content?.sourceId) return;

        const position = Number.isFinite(Number(overrides.position))
            ? Math.max(0, Math.floor(Number(overrides.position)))
            : this.getResumeSnapshotPosition();
        const duration = this.getDisplayDuration?.() || this.durationHint || 0;

        const snapshot = {
            version: 1,
            savedAt: Date.now(),
            content,
            contentType: this.contentType || content.type,
            containerExtension: this.containerExtension || content.containerExtension || 'mp4',
            currentSeason: this.currentSeason || content.currentSeason || null,
            currentEpisode: this.currentEpisode || content.currentEpisode || null,
            returnPage: this.returnPage || (content.type === 'movie' ? 'movies' : 'series'),
            position,
            duration: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0,
            playback: this.sanitizeResumePlayback(overrides.playback || this._resumePlaybackMetadata || {})
        };

        try {
            sessionStorage.setItem(this.resumeSnapshotKey, JSON.stringify(snapshot));
        } catch (error) {
            console.warn('[WatchPage] Could not persist playback resume snapshot:', error?.message || error);
        }
        // Also persist a durable per-title position (survives quit + tab close).
        this._persistResumePosition();
    }

    readResumeSnapshot() {
        let snapshot = null;
        try {
            snapshot = JSON.parse(sessionStorage.getItem(this.resumeSnapshotKey) || 'null');
        } catch (_) {
            snapshot = null;
        }

        const isValid = snapshot?.version === 1
            && snapshot?.content?.id
            && snapshot?.content?.sourceId
            && (snapshot.content.type === 'movie' || snapshot.content.type === 'series');

        if (!isValid || Date.now() - Number(snapshot.savedAt || 0) > this.resumeSnapshotTtlMs) {
            this.clearResumeSnapshot();
            return null;
        }
        return snapshot;
    }

    clearResumeSnapshot() {
        try {
            sessionStorage.removeItem(this.resumeSnapshotKey);
        } catch (_) {
            // Ignore storage cleanup failures.
        }
    }

    _resumePositionId(content) {
        const c = content || this.content || {};
        if (!c.id || !c.sourceId) return null;
        return `${c.sourceId}:${c.id}:${c.currentSeason || ''}:${c.currentEpisode || ''}`;
    }

    // Persist the current playback position per title (localStorage). Survives
    // quit + tab close, unlike the sessionStorage snapshot which goBack() clears.
    _persistResumePosition() {
        try {
            const id = this._resumePositionId();
            if (!id) return;
            const pos = Math.floor(this.getResumeSnapshotPosition?.() || 0);
            const dur = Math.floor(this.getDisplayDuration?.() || this.durationHint || 0);
            if (pos < 12) return;                         // too early to matter
            if (dur > 0 && pos >= dur * 0.95) return;     // near the end → no resume
            let map = {};
            try { map = JSON.parse(localStorage.getItem(this.resumePositionsKey) || '{}') || {}; } catch (_) { map = {}; }
            map[id] = { position: pos, duration: dur, savedAt: Date.now() };
            const entries = Object.entries(map);
            if (entries.length > 60) { // cap + drop oldest
                entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
                map = Object.fromEntries(entries.slice(0, 60));
            }
            localStorage.setItem(this.resumePositionsKey, JSON.stringify(map));
        } catch (_) { /* best-effort */ }
    }

    _loadResumePosition(content) {
        try {
            const id = this._resumePositionId(content);
            if (!id) return 0;
            const map = JSON.parse(localStorage.getItem(this.resumePositionsKey) || '{}') || {};
            const e = map[id];
            if (!e || Date.now() - (e.savedAt || 0) > this.resumePositionsTtlMs) return 0;
            return this.getResumeRestorePosition(e.position, e.duration);
        } catch (_) { return 0; }
    }

    _clearResumePosition() {
        try {
            const id = this._resumePositionId();
            if (!id) return;
            const map = JSON.parse(localStorage.getItem(this.resumePositionsKey) || '{}') || {};
            if (map[id]) { delete map[id]; localStorage.setItem(this.resumePositionsKey, JSON.stringify(map)); }
        } catch (_) { /* best-effort */ }
    }

    // Authoritative cross-device resume: fetch this title's saved position from the
    // server's continue-watching (cloud_watch_history) via the targeted /history
    // lookup. Returns 0 on any failure or if the backend lookup isn't available
    // (older backend returns {history:[...]} with no .item → treated as 0).
    async _fetchServerResumePosition(content) {
        try {
            if (!window.API?.request || !content?.id) return 0;
            const itemType = content.type === 'movie' ? 'movie' : 'episode';
            const params = new URLSearchParams({ itemId: String(content.id), itemType });
            if (content.sourceId) params.set('sourceId', String(content.sourceId));
            const res = await window.API.request('GET', `/history?${params.toString()}`);
            const item = res && res.item;
            if (!item || item.completed) return 0;
            const progress = Number(item.progress_seconds ?? item.progress ?? 0);
            const duration = Number(item.duration_seconds ?? item.duration ?? 0);
            return this.getResumeRestorePosition(progress, duration);
        } catch (err) {
            console.warn('[WatchPage] Server resume fetch failed:', err?.message || err);
            return 0;
        }
    }

    getHistoryResumePosition(item = {}) {
        const data = item.data || {};
        const progress = item.progress || item.progress_seconds || data.progress || 0;
        const duration = item.duration || item.duration_seconds || data.duration || data.durationHint || 0;
        return this.getResumeRestorePosition(progress, duration);
    }

    pickCloudResumeHistoryItem(items = []) {
        return (items || [])
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => {
                const data = item.data || {};
                const type = item.item_type || item.itemType || item.type;
                const sourceId = item.source_id || item.sourceId || data.sourceId;
                const streamId = item.item_id || item.itemId || item.stream_id || item.streamId || item.series_id;
                const isPlayable = type === 'movie' || type === 'episode' || type === 'series';
                return isPlayable && sourceId && streamId && this.getHistoryResumePosition(item) > 0;
            })
            .sort((a, b) => {
                const aTime = Date.parse(a.item.updated_at || a.item.watched_at || a.item.updatedAt || a.item.watchedAt || '') || 0;
                const bTime = Date.parse(b.item.updated_at || b.item.watched_at || b.item.updatedAt || b.item.watchedAt || '') || 0;
                return (bTime - aTime) || (a.index - b.index);
            })[0]?.item || null;
    }

    async restoreFromCloudHistory() {
        if (this.content || this._resumeRestorePromise) return this._resumeRestorePromise;
        const homePage = this.app?.pages?.home;
        if (!homePage?.playItem) return null;

        this._resumeRestorePromise = (async () => {
            const history = window.API?.history?.getAll
                ? await window.API.history.getAll(20)
                : await window.API.request('GET', '/history?limit=20');
            const item = this.pickCloudResumeHistoryItem(Array.isArray(history) ? history : []);
            if (!item) return null;

            const data = item.data || {};
            const title = data.title || item.title || item.name || item.item_name || '';
            const subtitle = data.subtitle || '';
            this.titleEl.textContent = title;
            this.subtitleEl.textContent = subtitle;
            this.showLoading();
            console.info('[WatchPage] Restoring playback from cloud history after refresh.', {
                itemId: item.item_id || item.itemId || item.id,
                resumeOffset: this.getHistoryResumePosition(item)
            });

            await homePage.playItem(item, true);
            return true;
        })()
            .catch(error => {
                console.warn('[WatchPage] Could not restore cloud playback history after refresh:', error?.message || error);
                this.showPlaybackError('Playback failed after refresh. Try opening the title again.');
                return false;
            })
            .finally(() => {
                this._resumeRestorePromise = null;
            });

        return this._resumeRestorePromise;
    }

    findResumeSnapshotEpisode(snapshot) {
        const episodeId = snapshot?.content?.id;
        const episodesBySeason = snapshot?.content?.seriesInfo?.episodes;
        if (!episodeId || !episodesBySeason || typeof episodesBySeason !== 'object') return null;

        for (const episodes of Object.values(episodesBySeason)) {
            if (!Array.isArray(episodes)) continue;
            const found = episodes.find(episode => String(episode?.id) === String(episodeId));
            if (found) return found;
        }
        return null;
    }

    buildResumePlaybackHint(snapshot) {
        const content = snapshot?.content || {};
        const streamType = content.type === 'series' ? 'series' : 'movie';
        const container = snapshot.containerExtension || content.containerExtension || 'mp4';
        const resumeEpisode = streamType === 'series' ? this.findResumeSnapshotEpisode(snapshot) : null;
        const item = {
            ...(resumeEpisode || {}),
            ...content,
            type: resumeEpisode ? 'episode' : content.type,
            streamType,
            itemType: streamType,
            container_extension: resumeEpisode?.container_extension || content.containerExtension || container,
            codecProfile: snapshot.playback?.codecProfile || content.codecProfile || content.defaultVariant?.codecProfile
                || resumeEpisode?.codecProfile || resumeEpisode?.codec_profile
        };
        const base = { container, streamType };
        const hint = MediaUtils.playbackHintFromItem
            ? MediaUtils.playbackHintFromItem(item, base)
            : base;
        // Series id so the server can map this episode to its catalog row (reuse/persist
        // the probed audio map). The played stream id is the episode, not the series.
        const seriesIdForAudio = content.seriesId || content.series_id;
        if (streamType === 'series' && seriesIdForAudio) hint.audioSeriesId = seriesIdForAudio;
        const audioPreference = snapshot?.playback?.playbackPreferences?.audio
            || snapshot?.playbackPreferences?.audio
            || snapshot?.content?.playbackPreferences?.audio
            || null;
        const audioStreamIndex = Number(audioPreference?.streamIndex ?? audioPreference?.stream_index);
        if (Number.isInteger(audioStreamIndex)) {
            hint.audioStreamIndex = audioStreamIndex;
        }
        return hint;
    }

    async restoreFromResumeSnapshot() {
        if (this.content || this._resumeRestorePromise) return this._resumeRestorePromise;
        const snapshot = this.readResumeSnapshot();
        if (!snapshot) return this.restoreFromCloudHistory();
        const snapshotResumePosition = this.getResumeRestorePosition(snapshot.position, snapshot.duration);
        if (snapshotResumePosition <= 0) {
            console.info('[WatchPage] Local resume snapshot has no usable position; checking cloud history.');
            const cloudRestored = await this.restoreFromCloudHistory();
            if (cloudRestored) return cloudRestored;
        }

        this._resumeRestorePromise = (async () => {
            const content = {
                ...snapshot.content,
                type: snapshot.content.type,
                resumeTime: snapshotResumePosition,
                playbackPreferences: snapshot.playback?.playbackPreferences || snapshot.playbackPreferences || snapshot.content.playbackPreferences || null,
                durationHint: this.normalizeDuration(snapshot.content.durationHint) || this.normalizeDuration(snapshot.duration),
                currentSeason: snapshot.currentSeason || snapshot.content.currentSeason || null,
                currentEpisode: snapshot.currentEpisode || snapshot.content.currentEpisode || null,
                containerExtension: snapshot.containerExtension || snapshot.content.containerExtension || 'mp4'
            };

            this.titleEl.textContent = content.title || '';
            this.subtitleEl.textContent = content.subtitle || '';
            this.showLoading();

            if (content.type === 'series' && !content.seriesInfo && content.seriesId && content.sourceId) {
                try {
                    content.seriesInfo = await API.proxy.xtream.seriesInfo(content.sourceId, content.seriesId);
                } catch (error) {
                    console.warn('[WatchPage] Could not reload series info for restored playback:', error?.message || error);
                }
            }

            await this.releasePlaybackPipelineForRetry();
            const resumePlan = this.getGatewaySeekPlan(snapshotResumePosition);
            const playbackHint = {
                ...this.buildResumePlaybackHint(snapshot),
                seekOffset: resumePlan.sessionStart,
                startOffset: resumePlan.sessionStart,
                resumeTime: resumePlan.sessionStart
            };
            const result = await API.proxy.xtream.getStreamUrl(
                content.sourceId,
                content.id,
                content.type === 'series' ? 'series' : 'movie',
                content.containerExtension || 'mp4',
                playbackHint
            );

            if (!result?.url) {
                throw new Error('Restored playback did not return a media URL');
            }

            result.seekOffset = resumePlan.sessionStart;
            result.startOffset = resumePlan.sessionStart;
            result.resumeTarget = resumePlan.target;
            content.cloudPlaybackSessionId = result.sessionId || null;
            await this.play(content, result.url, result);
            return true;
        })()
            .catch(error => {
                console.warn('[WatchPage] Could not restore playback after refresh:', error?.message || error);
                this.showPlaybackError('Playback failed after refresh. Try opening the title again.');
                return false;
            })
            .finally(() => {
                this._resumeRestorePromise = null;
            });

        return this._resumeRestorePromise;
    }

    /**
     * Normalize Cloud playback/session responses so every caller can pass either
     * the full API result or the already-flattened playback object.
     */
    playbackMetadataFromResult(playback = {}, extra = {}) {
        const root = playback && typeof playback === 'object' ? playback : {};
        const nestedPlayback = root.playback && typeof root.playback === 'object' ? root.playback : {};
        const session = root.session && typeof root.session === 'object' ? root.session : {};
        const nestedSession = nestedPlayback.session && typeof nestedPlayback.session === 'object' ? nestedPlayback.session : {};
        const gatewaySession = nestedPlayback.gatewaySession || nestedPlayback.gateway_session || root.gatewaySession || root.gateway_session || null;
        const seekOffset = Number(
            extra.seekOffset ??
            extra.seek_offset ??
            extra.startOffset ??
            extra.resumeTime ??
            root.seekOffset ??
            root.seek_offset ??
            root.startOffset ??
            root.resumeTime ??
            nestedPlayback.seekOffset ??
            nestedPlayback.seek_offset ??
            nestedPlayback.startOffset ??
            nestedPlayback.resumeTime ??
            0
        );
        const sessionId = extra.sessionId
            || extra.cloudPlaybackSessionId
            || root.sessionId
            || root.cloudPlaybackSessionId
            || nestedPlayback.sessionId
            || nestedPlayback.cloudPlaybackSessionId
            || session.id
            || nestedSession.id
            || null;

        return {
            ...nestedPlayback,
            ...root,
            ...extra,
            sessionId,
            cloudPlaybackSessionId: extra.cloudPlaybackSessionId
                || root.cloudPlaybackSessionId
                || nestedPlayback.cloudPlaybackSessionId
                || sessionId,
            gatewaySession,
            codecProfile: extra.codecProfile
                || extra.codec_profile
                || root.codecProfile
                || root.codec_profile
                || nestedPlayback.codecProfile
                || nestedPlayback.codec_profile
                || null,
            audioMode: extra.audioMode
                || extra.audio_mode
                || root.audioMode
                || root.audio_mode
                || nestedPlayback.audioMode
                || nestedPlayback.audio_mode
                || null,
            seekOffset: Number.isFinite(seekOffset) && seekOffset > 0 ? Math.floor(seekOffset) : 0,
            startOffset: Number.isFinite(seekOffset) && seekOffset > 0 ? Math.floor(seekOffset) : 0
        };
    }

    durationFromCodecProfile(profile) {
        if (!profile || typeof profile !== 'object') return null;
        return this.normalizeDuration(
            profile.durationSeconds ??
            profile.duration_seconds ??
            profile.duration ??
            profile.formatDuration ??
            profile.format_duration
        );
    }

    /**
     * Main entry point - play content
     * @param {Object} content - Movie or episode info
     * @param {string} streamUrl - Stream URL
     * @param {Object} playback - Cloud playback metadata
     */
    async play(content, streamUrl, playback = {}) {
        const playbackAttemptId = this.beginPlaybackAttempt();
        // `streamUrl` may be an async resolver: we render the player shell +
        // loading animation first, then await it. Resolve it later (after the
        // shell is on screen) so the metadata below uses what we have upfront.
        const streamUrlResolver = typeof streamUrl === 'function' ? streamUrl : null;
        let playbackMetadata = this.playbackMetadataFromResult(playback);
        this._resumePlaybackMetadata = playbackMetadata;
        let cloudPlaybackSessionId = playbackMetadata.sessionId
            || playbackMetadata.cloudPlaybackSessionId
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
        let requestedResumeTime = Number(
            content.resumeTime ??
            playbackMetadata.resumeTarget ??
            playbackMetadata.resume_target ??
            playbackMetadata.seekOffset ??
            playbackMetadata.startOffset ??
            0
        );
        // The catalog item often opens without a resume position (stale progress).
        // Recover it with a two-tier fallback so reopening resumes at the saved spot:
        //   1) authoritative server position (continue-watching) — works cross-device
        //   2) durable per-title store on this device — offline / server unavailable
        if (!(requestedResumeTime > 0) && content?.id && content?.sourceId) {
            const serverPos = await this._fetchServerResumePosition(content);
            if (serverPos > 0) {
                requestedResumeTime = serverPos;
                console.log(`[WatchPage] Resume from server: ${serverPos}s`);
            }
        }
        if (!(requestedResumeTime > 0) && content?.id && content?.sourceId) {
            const stored = this._loadResumePosition(content);
            if (stored > 0) {
                requestedResumeTime = stored;
                console.log(`[WatchPage] Resume from stored position: ${stored}s`);
            }
        }
        this.resumeTime = Number.isFinite(requestedResumeTime) && requestedResumeTime > 0 ? Math.floor(requestedResumeTime) : 0;
        const sessionStartOffset = Number(
            playbackMetadata.seekOffset ??
            playbackMetadata.seek_offset ??
            playbackMetadata.startOffset ??
            playbackMetadata.start_offset ??
            playbackMetadata.resumeTime ??
            0
        );
        const loadSeekOffset = Number.isFinite(sessionStartOffset) && sessionStartOffset > 0
            ? Math.floor(sessionStartOffset)
            : (this.resumeTime || 0);
        this.containerExtension = content.containerExtension || 'mp4';
        this.returnPage = content.type === 'movie' ? 'movies' : 'series';
        // Known total duration (TMDB runtime / episode duration) used as a
        // timeline fallback when ffprobe can't determine the duration
        const codecProfileDuration = this.durationFromCodecProfile(playbackMetadata.codecProfile || playbackMetadata.codec_profile);
        this.durationHint = this.normalizeDuration(content.durationHint) || codecProfileDuration;
        this._lastKnownPlaybackPosition = this.resumeTime || 0;
        this._lastKnownPlaybackDuration = this.durationHint || 0;
        this.resetTrackSelectionState();
        this.setPendingPlaybackPreferences(
            content.playbackPreferences
            || content.playback_preferences
            || playbackMetadata.playbackPreferences
            || playbackMetadata.playback_preferences
            || playbackMetadata.preferences
            || null
        );

        // Alternate versions of the same title (duplicate group) for failover
        this.versions = Array.isArray(content.versions) && content.versions.length > 1 ? content.versions : null;
        this.versionIndex = content.versionIndex || 0;
        this._failoverInProgress = false;
        this._playbackStatusOkReported = false;
        this._lastFailureMsg = null;
        this._cloudRelayFallbackTried = false;
        this._cloudGatewayTranscodeFallbackTried = false;
        this._firstFrameReported = false;
        this._playStartedReported = false;
        this._playbackEnded = false;
        this._lastPauseTelemetryAt = 0;
        this._handlingPlaybackFailure = false;

        // Reset state
        this.cancelNextEpisode();
        this.nextEpisodeDismissed = false;

        // Paint the player shell (poster + title + loading animation) FIRST so the
        // player appears instantly on click — before stopping the previous stream
        // or waiting on the gateway session. The stream loads into this shell.
        this.app.navigateTo('watch', true);
        document.getElementById('page-watch')?.scrollTo(0, 0);
        this.titleEl.textContent = content.title || '';
        this.subtitleEl.textContent = content.subtitle || '';
        this.saveResumeSnapshot({ playback: playbackMetadata, position: this.resumeTime || 0 });
        this.renderDetails();
        this.showLoading();

        // Now stop any previous (Live TV) playback, so the provider's single
        // connection slot is free before we request this title. Kept before the
        // stream resolver so the old slot is released first, but no longer blocks
        // the shell from showing.
        await this.app?.player?.stop?.();

        if (streamUrlResolver) {
            let resolved;
            try {
                resolved = await streamUrlResolver();
            } catch (err) {
                if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
                this.showPlaybackError(err?.message || 'This title could not be started. Please try again.', { immediate: true });
                return;
            }
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            if (!resolved || !resolved.url) {
                this.showPlaybackError('This title could not be started. Please try again.', { immediate: true });
                return;
            }
            streamUrl = resolved.url;
            playbackMetadata = this.playbackMetadataFromResult({ ...playback, ...resolved });
            this._resumePlaybackMetadata = playbackMetadata;
            const resolvedSessionId = playbackMetadata.sessionId || playbackMetadata.cloudPlaybackSessionId;
            if (resolvedSessionId) {
                cloudPlaybackSessionId = resolvedSessionId;
                content.cloudPlaybackSessionId = resolvedSessionId;
            }
            // The resolver may have enriched content (e.g. episode seriesInfo
            // for next-episode handoff, or a fuller subtitle) while the shell
            // was already on screen — refresh the bits that were shown early.
            if (content.seriesInfo) this.seriesInfo = content.seriesInfo;
            if (content.currentSeason) this.currentSeason = content.currentSeason;
            if (content.currentEpisode) this.currentEpisode = content.currentEpisode;
            this.titleEl.textContent = content.title || '';
            this.subtitleEl.textContent = content.subtitle || '';
            this.renderDetails();
        }

        // Load video
        await this.loadVideo(streamUrl, {
            cloudPlaybackSessionId,
            playbackAttemptId,
            mode: playbackMetadata.mode || null,
            startTime: this.resumeTime || 0,
            codecProfile: playbackMetadata.codecProfile || playbackMetadata.codec_profile || null,
            seekOffset: loadSeekOffset,
            // Per-track audio languages the SERVER probed for this engine session
            // (the engine can't read them itself). Must be forwarded explicitly —
            // loadVideo gets a fresh options object, not the full playback metadata.
            audioTracks: playbackMetadata.audioTracks || playbackMetadata.audio_tracks || null,
            // Subtitle tracks the SERVER probed (same relay header-parse as audio).
            // Known at load → the CC menu lists them AND the saved subtitle pref can
            // be restored, without a client-side gateway probe during streaming.
            subtitleTracks: playbackMetadata.subtitleTracks || playbackMetadata.subtitle_tracks || null
        });
        if (this.isStalePlaybackAttempt(playbackAttemptId)) return;

        const localResumeTarget = Math.max(0, (this.resumeTime || 0) - (loadSeekOffset || 0));
        if (localResumeTarget > 0.25 && this.isGatewayPlaybackUrl(streamUrl)) {
            this.queuePendingLocalSeek(localResumeTarget);
        }

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

        // Reflect the new content in the player controls (series-only prev/next +
        // episodes selector, and re-apply the chosen playback speed).
        this.updateEpisodeNavUI();

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

    beginPlaybackTelemetry(sessionId, playbackAttemptId) {
        this.playbackTelemetry = {
            playbackAttemptId,
            sessionId: sessionId || null,
            requestedAt: Date.now(),
            firstFrameReported: false,
            playStartedReported: false,
            ended: false,
            abandoned: false
        };
        this._playRequestedAt = this.playbackTelemetry.requestedAt;
        this._firstFrameReported = false;
        this._playStartedReported = false;
        this._playbackEnded = false;
        this.sendPlaybackEvent('play_requested');
    }

    getTelemetrySourceId() {
        const sourceId = this.content?.cloudSourceId
            || this.content?.data?.cloudSourceId
            || this.content?.source_id
            || this.content?.sourceId
            || '';
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sourceId))
            ? String(sourceId)
            : null;
    }

    getTelemetryItemId() {
        const itemId = this.content?.itemId
            || this.content?.item_id
            || this.content?.streamId
            || this.content?.stream_id
            || this.content?.seriesId
            || this.content?.series_id
            || this.content?.id
            || '';
        return String(itemId || '');
    }

    getTelemetryClientMetadata() {
        const ua = navigator.userAgent || '';
        const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone;
        const width = Math.max(0, Number(window.innerWidth) || 0);
        let clientSurface = 'web';
        if (window.NorvaAndroidTV || /android tv|afts|aftt|aftm|bravia|smart-tv|smarttv|tizen|webos/i.test(ua)) {
            clientSurface = 'android-tv';
        } else if (standalone) {
            clientSurface = 'pwa';
        } else if (/mobi|android|iphone|ipad|ipod/i.test(ua)) {
            clientSurface = 'mobile-web';
        }
        return {
            clientSurface,
            viewportClass: width && width < 600 ? 'phone' : width && width < 1024 ? 'tablet' : 'desktop',
            appMode: this.isCloudPlaybackMode() ? 'cloud' : 'local',
            playbackEntry: 'watch'
        };
    }

    buildPlaybackEventPayload(eventType, extra = {}) {
        const duration = this.getDisplayDuration?.() || this.getValidDuration?.() || 0;
        return {
            eventType,
            playbackSessionId: this.currentCloudPlaybackSessionId || this.playbackTelemetry?.sessionId || null,
            sourceId: this.getTelemetrySourceId(),
            itemType: this.contentType || this.content?.type || '',
            itemId: this.getTelemetryItemId(),
            positionSeconds: Math.max(0, Math.floor(this.getPlaybackPosition?.() || 0)),
            durationSeconds: Math.max(0, Math.floor(Number.isFinite(duration) ? duration : 0)),
            playbackMode: extra.playbackMode || this.currentPlaybackMode || null,
            timeToFirstFrameMs: extra.timeToFirstFrameMs,
            errorCode: extra.errorCode,
            errorMessage: extra.errorMessage,
            metadata: {
                ...this.getTelemetryClientMetadata(),
                title: this.content?.title || this.content?.name || null,
                attemptId: this._playbackAttemptId,
                variantCount: this.content?.variantCount || this.content?._variantCount || null,
                providerTmdbId: this.content?.providerTmdbId || this.content?.data?.providerTmdbId || null,
                titleId: this.content?.titleId || this.content?.title_id || this.content?.data?.titleId || null,
                readyState: this.video?.readyState ?? null,
                currentSrcType: this.video?.currentSrc ? (this.isGatewayPlaybackUrl(this.video.currentSrc) ? 'gateway' : 'direct') : null,
                ...extra.metadata
            }
        };
    }

    sendPlaybackEvent(eventType, extra = {}) {
        if (!this.content || !this.getTelemetryItemId()) return;
        const cloud = window.NorvaCloud;
        const api = cloud?.token ? cloud.playback : (cloud?.deviceToken ? cloud.device?.playback : cloud?.playback);
        const send = api?.event || cloud?.playback?.event;
        if (typeof send !== 'function') return;

        const payload = this.buildPlaybackEventPayload(eventType, extra);
        if (!payload.itemType || !payload.itemId) return;
        Promise.resolve(send(payload)).catch((error) => {
            console.warn('[WatchPage] Playback telemetry failed:', error?.message || error);
        });
    }

    reportAbandonedPlayback() {
        if (!this.playbackTelemetry || this.playbackTelemetry.abandoned || this.playbackTelemetry.ended) return;
        const position = Math.floor(this.getPlaybackPosition?.() || 0);
        if (!this._firstFrameReported && position < 2) return;
        this.playbackTelemetry.abandoned = true;
        this.sendPlaybackEvent('abandoned');
    }

    resetTrackSelectionState() {
        this.audioTracks = [];
        this.subtitleTracks = [];
        this.subtitleSourceUrl = null;
        this.subtitleStartOffset = 0;
        this.selectedSubtitleStreamIndex = null;
        this.selectedSubtitleTrackUserChoice = false;
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
            console.log('[WatchPage] Starting HLS transcode session...', this.describeProcessingOptions(options));
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
            const host = window.location.hostname;
            const isHosted = Boolean(host && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1');
            return isHosted || Boolean(window.API?.isCloudMode?.());
        } catch (_) {
            return false;
        }
    }

    isGatewayPlaybackUrl(url) {
        const value = String(url || '');
        return /\/sessions\/[^/?#]+\/playlist\.m3u8/i.test(value);
    }

    describePlaybackUrl(url) {
        const value = String(url || '').trim();
        if (!value) return 'empty';
        if (this.isGatewayPlaybackUrl(value)) return 'gateway-session';
        if (value.startsWith('blob:')) return 'blob';
        if (value.startsWith('data:')) return 'data';
        if (/^\/api\/transcode/i.test(value)) return 'local-transcode';
        if (/^\/api\/remux/i.test(value)) return 'local-remux';
        if (/^\/api\/proxy\/stream/i.test(value)) return 'local-proxy';
        if (/^\/api\//i.test(value)) return 'local-api';
        if (/^\/relay\//i.test(value)) return 'relay';
        if (/^https?:\/\//i.test(value)) {
            return /\.m3u8(?:[?#]|$)/i.test(value) ? 'external-hls' : 'external-media';
        }
        return value.startsWith('/') ? 'local-media' : 'unknown';
    }

    describeProcessingOptions(options = {}) {
        const { url, sourceUrl, streamUrl, ...safeOptions } = options || {};
        return safeOptions;
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

    async releasePlaybackPipelineForRetry() {
        try {
            clearTimeout(this._pendingLocalSeekTimer);
            this._pendingLocalSeekTimer = null;
            this._pendingLocalSeekTarget = null;
            this._pendingLocalSeekAttempts = 0;

            if (this.hls) {
                try { this.hls.destroy(); } catch (error) {
                    console.warn('[WatchPage] Could not destroy HLS before retry:', error?.message || error);
                }
                this.hls = null;
            }

            if (this.video) {
                try {
                    this._suppressMediaErrorsUntil = Date.now() + 2500;
                    this.video.pause();
                    this.video.removeAttribute('src');
                    this.video.load();
                } catch (error) {
                    console.warn('[WatchPage] Could not clear video before retry:', error?.message || error);
                }
            }

            await Promise.allSettled([
                this.stopTranscodeSession(),
                this.stopCloudPlaybackSessions()
            ]);
        } catch (error) {
            console.warn('[WatchPage] Playback retry cleanup failed:', error?.message || error);
        }
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

    isRangeSeekFailure(message) {
        return /416|Requested Range Not Satisfiable|range not satisfiable|RANGE_REJECTED|invalid as first byte of an EBML number|File ended prematurely|exceeds containing master element/i.test(message || '');
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
        const cloud = this.isCloudPlaybackMode();

        if (/429|Too Many Requests|Many Requests|rate limit/i.test(text)) {
            return cloud
                ? "The provider is limiting connections (429). The cloud server's IP is likely throttled: close other playbacks, or watch this title from the Norva TV/mobile app (or a local hub) on your network, then try again."
                : 'The provider is rate limiting this stream (429 Too Many Requests). Close other players, wait a bit, then try again.';
        }
        if (/401|Unauthorized|403|Forbidden/i.test(text)) {
            return cloud
                ? "Your provider is blocking cloud playback (a browser can't play this format without a datacenter). Watch this title in the Norva app — TV, mobile or tablet: your progress is synced, you resume exactly where you left off."
                : 'The provider refused the stream (401/403). Check your IPTV subscription, connection limit, or that this device is allowed.';
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

    isGenericTrackTitle(title, type = 'track') {
        const value = String(title || '').trim();
        if (!value) return true;

        if (/^soundhandler$/i.test(value)) return true;
        if (type === 'subtitle') {
            return /^(subtitle|subtitles?|sous[-\s]?titres?|captions?|track)\s*\d*$/i.test(value);
        }
        if (type === 'audio') {
            return /^(audio|track)\s*\d*$/i.test(value);
        }
        return false;
    }

    getLanguageDisplayName(language) {
        const normalized = this.normalizeTrackLanguage(language);
        if (!normalized || normalized === 'und') return null;

        try {
            // Norva's UI is English everywhere — render language names in English
            // regardless of the browser locale (otherwise an "eng" track shows as
            // "Anglais" on a French browser).
            const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
            const label = displayNames.of(normalized);
            if (label) return label.charAt(0).toUpperCase() + label.slice(1);
        } catch (_) {
            // Fall back to compact English labels below.
        }

        const fallbacks = {
            fr: 'French',
            en: 'English',
            es: 'Spanish',
            de: 'German',
            it: 'Italian',
            pt: 'Portuguese',
            ar: 'Arabic',
            nl: 'Dutch'
        };
        return fallbacks[normalized] || normalized.toUpperCase();
    }

    getSubtitleTrackLabel(track, fallback = 'Subtitles') {
        if (!track) return fallback;

        const title = !this.isGenericTrackTitle(track.title, 'subtitle') ? String(track.title).trim() : '';
        const languageLabel = this.getLanguageDisplayName(track.inferredLanguage || track.language);
        const roleLabels = this.getSubtitleRoleLabels(track);
        const parts = [];

        if (languageLabel) parts.push(languageLabel);
        if (title && (!languageLabel || title.toLowerCase() !== languageLabel.toLowerCase())) {
            parts.push(title);
        }
        roleLabels.forEach(label => {
            if (!parts.some(part => part.toLowerCase() === label.toLowerCase())) {
                parts.push(label);
            }
        });

        if (parts.length) return parts.join(' - ');
        return fallback;
    }

    hasTrackDisposition(track, keys = []) {
        if (!track || !Array.isArray(keys)) return false;
        const disposition = track.disposition && typeof track.disposition === 'object'
            ? track.disposition
            : {};
        return keys.some(key => {
            const value = track[key] ?? disposition[key];
            return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
        });
    }

    getSubtitleRoleLabels(track) {
        const labels = [];
        const title = String(track?.title || track?.label || track?.name || '').toLowerCase();

        if (this.hasTrackDisposition(track, ['forced']) || /\b(forced|force)\b/i.test(title)) {
            labels.push('Forced');
        }

        if (this.hasTrackDisposition(track, ['hearingImpaired', 'hearing_impaired', 'sdh'])
            || /\b(sdh|hearing|malentendant|malentendants|cc)\b/i.test(title)) {
            labels.push('SDH');
        }

        return labels;
    }

    getSubtitleMenuLabel(track, allTracks = [], index = -1, fallback = 'Subtitles') {
        const base = this.getSubtitleTrackLabel(track, fallback);
        const tracks = Array.isArray(allTracks) ? allTracks : [];
        const normalizedBase = base.toLowerCase();
        const bases = tracks.map(candidate => this.getSubtitleTrackLabel(candidate, fallback).toLowerCase());
        const duplicateCount = bases.filter(label => label === normalizedBase).length;

        if (duplicateCount > 1) {
            const safeIndex = Number.isInteger(index) && index >= 0 ? index : tracks.indexOf(track);
            const occurrence = bases
                .slice(0, safeIndex + 1)
                .filter(label => label === normalizedBase)
                .length || (safeIndex + 1);
            return `${base} - Piste ${occurrence}`;
        }

        return base;
    }

    getTrackLabel(track, fallback, type = 'track') {
        if (!track) return fallback;
        if (type === 'subtitle') return this.getSubtitleTrackLabel(track, fallback);

        const parts = [];
        const title = !this.isGenericTrackTitle(track.title, type) ? track.title : null;
        // Full language name ("French", "Japanese") rather than the bare code ("FR"),
        // matching the card badge + the native mobile player.
        const language = this.getLanguageDisplayName(track.language);
        const codec = track.codec ? String(track.codec).toUpperCase() : null;
        const channels = track.channels ? `${track.channels}ch` : null;

        if (title) parts.push(title);
        if (language && !parts.some(part => part.toLowerCase() === language.toLowerCase())) parts.push(language);
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
        this.restorePendingAudioPreference(info);
        this.restorePendingSubtitlePreference();
        this.ensureSelectedAudioTrack();
        this.updateQualityBadge();
        this.updateAudioTracks();
        this.updateCaptionsTracks();
        this.updateDurationState();
    }

    normalizePlaybackCodecProfile(profile) {
        if (!profile || typeof profile !== 'object') return null;

        const subtitles = Array.isArray(profile.subtitles)
            ? profile.subtitles
            : (Array.isArray(profile.subtitleTracks) ? profile.subtitleTracks : []);
        const audioTracks = Array.isArray(profile.audioTracks)
            ? profile.audioTracks
            : (Array.isArray(profile.audio_tracks) ? profile.audio_tracks : []);
        const info = {
            video: profile.video || profile.videoCodec || profile.video_codec || 'unknown',
            audio: profile.audio || profile.audioCodec || profile.audio_codec || 'unknown',
            videoProfile: profile.videoProfile || profile.video_profile || '',
            videoPixelFormat: profile.videoPixelFormat || profile.video_pixel_format || profile.pix_fmt || '',
            width: Number(profile.width || profile.videoWidth || profile.video_width || 0) || 0,
            height: Number(profile.height || profile.videoHeight || profile.video_height || 0) || 0,
            duration: Number(profile.duration || profile.durationSeconds || profile.duration_seconds || 0) || null,
            audioChannels: Number(profile.audioChannels || profile.audio_channels || profile.channels || 0) || 0,
            audioTracks,
            subtitles,
            container: profile.container || 'unknown',
            compatible: false,
            needsRemux: false,
            needsTranscode: false
        };

        const hasUsefulInfo = info.width > 0
            || info.height > 0
            || subtitles.length > 0
            || audioTracks.length > 0
            || info.video !== 'unknown'
            || info.audio !== 'unknown';
        return hasUsefulInfo ? info : null;
    }

    async probeStreamInfo(url, settings = {}) {
        const ua = settings.userAgentPreset === 'custom' ? settings.userAgentCustom : settings.userAgentPreset;
        const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(url)}&ua=${encodeURIComponent(ua || '')}&timeout=7000`);
        if (!probeRes.ok) {
            throw new Error(`Probe failed with status ${probeRes.status}`);
        }
        return probeRes.json();
    }

    // ---- in-browser engine (NorvaEngine) ----------------------------------
    // Plays mkv/HEVC/AC-3/DTS/… entirely client-side: reads the raw file by
    // byte-range, remuxes the container and transcodes non-browser audio to AAC,
    // feeding a MediaSource. No transcode server, no Railway. User policy is
    // "engine only": on failure we surface a clear message + telemetry rather
    // than falling back to the gateway.
    async playWithEngine(url, { startTime = 0, playbackAttemptId, audioStreamIndex = null } = {}) {
        this.destroyEngine();
        this.currentPlaybackMode = 'engine';
        this.streamStartOffset = 0;
        try { this.updateTranscodeStatus('direct', 'Navigateur'); } catch (_) {}
        const engine = this.norvaEngine = new window.NorvaEngine(this.video, {
            report: (info) => this.reportEngineFailure(info),
            log: (m) => console.log('[NorvaEngine] ' + m),
            onReady: (timings) => { console.log('[NorvaEngine] ready', timings); },
            onSeek: (timings) => {
                console.log('[NorvaEngine] seek', timings);
                // Dedicated seek telemetry (backend accepts the 'seek' event type).
                try { this.sendPlaybackEvent('seek', { metadata: { seekTimings: timings } }); } catch (_) {}
            }
        });
        try {
            await engine.load(url, { startTime, audioStreamIndex });
            if (this.isStalePlaybackAttempt(playbackAttemptId)) { this.destroyEngine(); return; }
            try { this.syncEngineAudioTracks(); } catch (_) {}
            // In-band subtitles: start capturing text-subtitle packets from the very start
            // (the demuxer runs ahead of playback) so a later selection shows cues with no
            // gap and no provider connection. Flag-gated; cheap (text payloads are tiny).
            try {
                if (this._inbandSubsEnabled() && engine.hasInbandSubtitles?.()) engine.enableSubtitleCapture();
            } catch (_) { /* best-effort */ }
            try { this.hideLoading(); } catch (_) {}
            this.video.play().catch((e) => this.handleAutoplayError(e));
            this.setVolumeFromStorage();
        } catch (e) {
            if (this.isStalePlaybackAttempt(playbackAttemptId)) { this.destroyEngine(); return; }
            this.reportEngineFailure({ stage: 'load', message: String(e && (e.message || e)) });
            this.destroyEngine();
            this.handleEngineUnplayable(e);
        }
    }

    destroyEngine() {
        if (this.norvaEngine) {
            try { this.norvaEngine.destroy(); } catch (_) {}
            this.norvaEngine = null;
        }
    }

    // The engine demuxes every stream but this libav build can't read per-stream
    // language, so we list the audio streams by index and borrow language labels
    // from the relay probe (this.audioTracks) when present. Marks the playing stream
    // active so the menu shows the real, switchable tracks (not a single "Multi").
    syncEngineAudioTracks() {
        const engine = this.norvaEngine;
        if (!engine || typeof engine.audioStreamIndices !== 'function') return;
        const idxs = engine.audioStreamIndices();
        const current = typeof engine.currentAudioIndex === 'function' ? engine.currentAudioIndex() : (idxs[0] ?? null);
        this.directAudioStreamIndex = current;
        if (!this.selectedAudioTrackUserChoice) this.selectedAudioStreamIndex = current;
        if (!idxs.length) return;
        // Borrow languages from the relay probe (ordered, audio-relative). Try the
        // absolute stream index first; fall back to audio-relative POSITION so a
        // libav-vs-container index mismatch still resolves the right language.
        const relay = Array.isArray(this._relayAudioTracks) ? this._relayAudioTracks : [];
        const langByIdx = new Map(relay
            .filter((t) => Number.isInteger(t.index) && t.lang && t.lang !== 'und')
            .map((t) => [t.index, t.lang]));
        const posLang = (k) => (relay[k] && relay[k].lang && relay[k].lang !== 'und' ? relay[k].lang : null);
        let tracks = idxs.map((i, k) => ({
            index: i,
            language: langByIdx.get(i) || posLang(k),
            default: i === current,
        }));
        // Single audio stream (e.g. a VOSTFR file's lone Japanese track): show its
        // language as one informational entry when known, instead of a bare "Default".
        // Unknown language -> leave the default fallback untouched.
        if (idxs.length < 2) {
            if (tracks[0] && tracks[0].language) { this.audioTracks = tracks; this.updateAudioTracks(); }
            return;
        }
        // Hide untagged "Audio N" tracks once we have ≥2 real, named languages: a
        // multi-audio file's filler streams (an untagged default + a trailing
        // cover-art-derived track) would otherwise clutter the menu. Keep every
        // track when fewer than 2 are named so the menu is never left blank.
        const named = tracks.filter((t) => t.language);
        if (named.length >= 2) tracks = named;
        // If the engine opened on a now-hidden untagged stream (so no visible
        // track is flagged default) and the user hasn't chosen, snap the
        // selection onto the first real track so the menu shows an active row.
        if (tracks.length && !tracks.some((t) => t.default) && !this.selectedAudioTrackUserChoice) {
            tracks[0].default = true;
            this.selectedAudioStreamIndex = tracks[0].index;
        }
        this.audioTracks = tracks;
        this.updateAudioTracks();
    }

    // Browser/OS locale as a 2-letter code (fr-FR -> fr) — a zero-cost signal for
    // "the user's language" used to pick a sensible default audio track. Returns
    // '' when it can't be resolved to a clean ISO-639-1 code.
    preferredAudioLanguageCode() {
        try {
            const nav = (navigator.language || (navigator.languages && navigator.languages[0]) || '').toLowerCase();
            const code = this.normalizeTrackLanguage(nav.split('-')[0]);
            return /^[a-z]{2}$/.test(code) ? code : '';
        } catch (_) {
            return '';
        }
    }

    // Stream index the engine should open on, or null to keep the engine's own
    // (file-order) default. Priority:
    //  1. An explicit/saved audio choice (resume, or a prior in-session pick) —
    //     open straight on it so the playing audio matches the menu's tick. Without
    //     this the engine opened on its untagged default while the menu restored
    //     "French", so the tick and the actual audio disagreed.
    //  2. Otherwise auto-default a multi-audio file whose own default (lowest-index
    //     audio stream) is UNTAGGED onto the user's language (browser locale → en →
    //     first named), so it never opens on a hidden "Audio N" track.
    preferredEngineAudioIndex() {
        if (this.selectedAudioTrackUserChoice && Number.isInteger(this.selectedAudioStreamIndex)) {
            return this.selectedAudioStreamIndex;
        }
        const saved = this.pendingPlaybackPreferences?.audio;
        if (saved && !this._pendingAudioPreferenceApplied) {
            const savedIdx = Number(saved.streamIndex ?? saved.stream_index);
            if (Number.isInteger(savedIdx)) return savedIdx;
        }
        const relay = (Array.isArray(this._relayAudioTracks) ? this._relayAudioTracks : [])
            .filter((t) => Number.isInteger(t.index));
        const named = relay.filter((t) => t.lang && t.lang !== 'und');
        if (named.length < 2) return null;
        const naturalDefault = relay.slice().sort((a, b) => a.index - b.index)[0];
        if (naturalDefault && naturalDefault.lang && naturalDefault.lang !== 'und') return null;
        const want = this.preferredAudioLanguageCode();
        const pick = (want && named.find((t) => t.lang === want))
            || named.find((t) => t.lang === 'en')
            || named[0];
        return Number.isInteger(pick?.index) ? pick.index : null;
    }

    // Switch audio in the in-browser engine: re-load on the chosen stream at the
    // current position. Fully client-side (zero-egress) — no gateway transcode.
    async restartEngineWithSelectedAudioTrack(requestId = this._audioSwitchRequestId) {
        if (this.isStaleAudioSwitch(requestId)) return false;
        const url = this.baseStreamUrl || this.currentUrl;
        const selected = this.getSelectedAudioTrack();
        if (!url || !selected) return false;
        const position = Math.max(0, Math.floor(this.getPlaybackPosition()));
        try { this.setSelectedAudioPreference(selected); } catch (_) {}
        this.hidePlaybackError();
        this.showLoading();
        try { this.updateTranscodeStatus('direct', `Audio: ${this.getTrackLabel(selected, 'Audio', 'audio')}`); } catch (_) {}
        await this.playWithEngine(url, {
            startTime: position,
            playbackAttemptId: this._playbackAttemptId,
            audioStreamIndex: selected.index,
        });
        return true;
    }

    reportEngineFailure(info = {}) {
        console.warn('[NorvaEngine] failed', info);
        try {
            // Use the server-accepted 'playback_error' event type and pack the
            // engine context into errorMessage so it persists even if the event
            // store drops unknown metadata fields.
            const v = this.norvaEngine?.vName || this.currentStreamInfo?.video || '?';
            const a = this.norvaEngine?.aName || '?';
            const c = this.containerExtension || '?';
            this.sendPlaybackEvent('playback_error', {
                errorCode: 'ENGINE_' + (info.stage || 'unknown'),
                errorMessage: `engine ${info.stage || 'unknown'} container=${c} video=${v} audio=${a} :: ${String(info.message || '').slice(0, 300)}`,
                metadata: {
                    engineStage: info.stage || null,
                    engineVideoCodec: v,
                    engineAudioCodec: a,
                    engineContainer: c
                }
            });
        } catch (_) {}
    }

    handleEngineUnplayable(e) {
        const detail = String((e && (e.message || e)) || '');
        const msg = detail.includes('NO_SUPPORTED_MIME')
            ? "This format can't be played in this browser. Open the title in the Norva app (TV / mobile / tablet) to play it."
            : "Browser playback failed. Open the title in the Norva app (TV / mobile / tablet).";
        this.showPlaybackError(msg, { immediate: true });
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
        this._suspendResumeSnapshotSave = true;
        try {
            await this.stop();
        } finally {
            this._suspendResumeSnapshotSave = false;
        }
        if (this.isStalePlaybackAttempt(playbackAttemptId)) {
            await this.cleanupStaleCloudPlaybackSession(options.cloudPlaybackSessionId);
            return;
        }
        this.registerCloudPlaybackSession(options.cloudPlaybackSessionId);
        if (this.video) {
            this.video.dataset.playbackAttemptId = String(playbackAttemptId);
        }
        this.beginPlaybackTelemetry(options.cloudPlaybackSessionId, playbackAttemptId);
        this.baseStreamUrl = url;
        this.currentPlaybackMode = null;
        this.currentProcessingOptions = {};
        this.probeDuration = null;
        this.streamStartOffset = 0;
        this._videoEncodeFallbackTried = false;
        this.cloudAudioInfo = null;
        this.audioTracks = [];
        this.directAudioStreamIndex = null;
        this._relayAudioTracks = null;
        this._engineSubsEnriched = false;
        this._engineSubsEnriching = false;
        this.subtitleTracks = [];
        this.subtitleSourceUrl = null;
        this.subtitleStartOffset = 0;
        this.selectedSubtitleStreamIndex = null;
        this.selectedSubtitleTrackUserChoice = false;
        this.selectedAudioStreamIndex = null;
        this.selectedAudioTrackUserChoice = false;
        this.clearExternalSubtitleTracks();
        this.updateAudioTracks();
        this.updateCaptionsTracks();
        this.updateDurationState();
        const codecProfileInfo = this.normalizePlaybackCodecProfile(options.codecProfile);
        if (codecProfileInfo) {
            this.applyProbeInfo(codecProfileInfo);
        }

        // Enrich the audio menu with the provider's track metadata (language,
        // codec, channels, bitrate) for cloud relay playback — the same source the
        // mobile player uses. Best-effort, display-only; never touches playback.
        // The engine path AWAITS this below (before opening the stream) so the header
        // probe doesn't fight the engine for the provider's single connection.
        if (options.mode !== 'engine') this.enrichCloudPlaybackTracks(url);

        // Show loading spinner
        this.showLoading();

        // In-browser engine path (mkv/HEVC/AC-3/DTS/…): NorvaEngine owns the
        // MediaSource — it reads the raw file by byte-range, remuxes the
        // container and transcodes non-browser audio to AAC client-side. No
        // gateway/transcode server. Resume seeks straight to the saved offset.
        if (options.mode === 'engine' && typeof window !== 'undefined' && window.NorvaEngine) {
            // Name the per-track languages BEFORE the engine opens (the engine can't
            // read stream-language tags itself). Two sources, in order:
            //  1. audioTracks returned with the cloud session — the SERVER probed the
            //     actual file via the relay. This is the only source for engine titles
            //     with no precomputed map (the engine streams via the media gateway, so
            //     the browser can't probe them). Most accurate for series (the exact
            //     episode that's playing).
            //  2. Otherwise the precomputed/relay map on content (crawled titles).
            const sessionAudioTracks = Array.isArray(options.audioTracks) ? options.audioTracks : null;
            if (sessionAudioTracks && sessionAudioTracks.length) {
                try { this.applyCloudMultiAudioTracks({ audioTracks: sessionAudioTracks }); } catch (_) { /* best-effort */ }
            } else {
                try { await this.enrichCloudPlaybackTracks(url); } catch (_) { /* best-effort */ }
            }
            // Multi-audio files often default (file order) to an UNTAGGED track —
            // opening on it lands the user on a hidden "Audio N" entry. When the
            // relay probe shows ≥2 real languages and that default is untagged,
            // open straight on the user's language (fr → en → first named) so the
            // menu opens on a labelled track. null = keep the engine's own default.
            const preferredAudioIndex = this.preferredEngineAudioIndex();
            await this.playWithEngine(url, {
                startTime: Number(options.startTime ?? options.seekOffset ?? this.resumeTime ?? 0) || 0,
                playbackAttemptId,
                audioStreamIndex: preferredAudioIndex
            });
            // Subtitles: the SERVER probed them (same relay header-parse as audio) and
            // returned them in the payload — known at LOAD, so the CC menu lists them and
            // the saved subtitle preference is restored, with NO client-side gateway probe
            // during streaming. Enumeration is safe now (it's just payload data); the
            // restore-ATTACH (which extracts via the gateway = a 2nd provider connection)
            // is deferred past initial buffering inside applyEngineSubtitleTracks.
            // Fallback: if the payload carries no subtitles (un-probed file), the lazy
            // enrich on menu-open still applies (toggleAudioMenu/toggleCaptionsMenu).
            const sessionSubtitleTracks = Array.isArray(options.subtitleTracks) ? options.subtitleTracks : null;
            if (sessionSubtitleTracks && sessionSubtitleTracks.length) {
                try { this.applyEngineSubtitleTracks(sessionSubtitleTracks, playbackAttemptId); } catch (_) { /* best-effort */ }
            }
            return;
        }

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
        const isGatewaySessionUrl = this.isGatewayPlaybackUrl(url);
        const isRawTs = url.includes('.ts') && !url.includes('.m3u8');
        const isDirectVideo = url.includes('.mp4') || url.includes('.mkv') || url.includes('.avi');
        let probeInfo = null;

        try {
            console.log('[WatchPage] Probing stream...');
            probeInfo = isGatewaySessionUrl ? null : await this.probeStreamInfo(url, settings);
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            if (probeInfo) {
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
                    this.video.play().catch(e => this.handleAutoplayError(e));
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
            this.video.play().catch(e => this.handleAutoplayError(e));
            this.setVolumeFromStorage();
            return;
        }

        // Determine if proxy is needed
        const proxyRequiredDomains = ['pluto.tv'];
        const needsProxy = settings.forceProxy || proxyRequiredDomains.some(domain => url.includes(domain));
        const finalUrl = needsProxy ? this.getProxiedUrl(url) : url;

        console.log('[WatchPage] Playing:', {
            source: this.describePlaybackUrl(url),
            final: this.describePlaybackUrl(finalUrl),
            needsProxy,
            looksLikeHls
        });

        // Use HLS.js for HLS streams
        if (looksLikeHls && Hls.isSupported()) {
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.updateTranscodeStatus(isGatewaySessionUrl ? 'transcoding' : 'direct', isGatewaySessionUrl ? 'Norva Gateway' : 'Direct HLS');
            this.currentPlaybackMode = isGatewaySessionUrl ? 'gateway-session' : 'direct-hls';
            this.currentProcessingOptions = {};
            const startOffset = isGatewaySessionUrl
                ? Math.max(0, Math.floor(Number(options.seekOffset ?? this.resumeTime ?? 0) || 0))
                : 0;
            this.streamStartOffset = startOffset;
            this.trackPlaybackPosition({ position: startOffset, force: true });
            this.attachProbeSubtitles(url, (probeInfo || this.currentStreamInfo)?.subtitles, startOffset);
            this.playHls(finalUrl, { playbackAttemptId });
        } else {
            // Direct playback for mp4/mkv/avi
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.updateTranscodeStatus('direct', 'Direct Play');
            this.currentPlaybackMode = 'direct';
            this.currentProcessingOptions = {};
            this.streamStartOffset = 0;
            this.trackPlaybackPosition({ position: 0, force: true });
            this.attachProbeSubtitles(url, (probeInfo || this.currentStreamInfo)?.subtitles, 0);
            this.video.src = finalUrl;
            this.video.play().catch(e => this.handleAutoplayError(e));
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
            // Cloud gateway sessions are real-time VOD transcodes too: start at
            // the beginning, never the live edge (otherwise hls.js chases the
            // edge on the growing EVENT playlist and never loads a fragment).
            ...((isTranscodeSession || isGatewaySession) ? { startPosition: 0 } : {})
        });

        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
            console.log('[WatchPage] Audio tracks updated:', data.audioTracks);
            this.restorePendingAudioPreference();
            this.updateAudioTracks();
        });

        this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
            console.log('[WatchPage] Audio track switched:', data);
            this.updateAudioTracks();
        });

        // Listen for subtitle track updates
        this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
            console.log('[WatchPage] Subtitle tracks updated:', data.subtitleTracks);
            this.restorePendingSubtitlePreference();
            // Wait a moment for native text tracks to populate
            setTimeout(() => this.updateCaptionsTracks(), 100);
        });

        this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
            console.log('[WatchPage] Subtitle track switched:', data);
        });

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            if (!autoplay) return;

            this.video.play().catch(e => this.handleAutoplayError(e));
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
                const maxMediaRecoveries = isGatewaySession ? 8 : 3;
                if (this._mediaRecoveries <= maxMediaRecoveries) {
                    console.warn(`[WatchPage] Recovering media error (attempt ${this._mediaRecoveries}/${maxMediaRecoveries})`);
                    if (this._mediaRecoveries === 2) this.hls.swapAudioCodec();
                    this.hls.recoverMediaError();
                    setTimeout(() => this.video?.play().catch(() => { }), 500);
                    return;
                }
            } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                if (isGatewaySession && this.isGatewaySessionGoneError(data)) {
                    const message = this.gatewaySessionGoneMessage(data);
                    console.warn('[WatchPage] Gateway session disappeared; refreshing playback session.');
                    try {
                        this.hls?.destroy();
                    } catch (_) { /* destroyed */ }
                    this.hls = null;
                    this.sendPlaybackEvent('gateway_error', {
                        errorCode: data.details || data.type || 'gateway_session_gone',
                        errorMessage: message
                    });
                    this.handlePlaybackFailure(message)
                        .catch(error => console.warn('[WatchPage] Gateway session refresh failed:', error?.message || error));
                    return;
                }
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

            const retriedGatewaySeek = this.retryGatewaySeekAfterFatalPlayback(
                data.reason || data.details || data.type || 'HLS playback failed.',
                playbackAttemptId
            );
            if (retriedGatewaySeek) return;

            // Recovery exhausted: last resort, try another version of the title
            this.hls.destroy();
            if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
            this.sendPlaybackEvent(isGatewaySession ? 'gateway_error' : 'playback_error', {
                errorCode: data.details || data.type || 'hls_fatal',
                errorMessage: data.reason || data.details || 'HLS playback failed.'
            });
            this.handlePlaybackFailure(data.details || data.reason || 'Playback failed.')
                .catch(error => console.warn('[WatchPage] Playback failure handler failed:', error?.message || error));
        });
    }

    playHlsOrDirect(url, options = {}) {
        const { autoplay = true } = options;

        // Session creation failed terminally (upstream 401/404...): try another
        // version of the title or surface a clear error instead of spinning
        if (!url) {
            if (this.isStalePlaybackAttempt(options.playbackAttemptId)) return;
            this.handlePlaybackFailure(this._lastFailureMsg || 'Playback failed')
                .catch(error => console.warn('[WatchPage] Playback failure handler failed:', error?.message || error));
            return;
        }

        if (url.startsWith('/api/transcode?')) {
            this.video.src = url;
            if (autoplay) {
                this.video.play().catch(e => this.handleAutoplayError(e, 'Direct transcode play error'));
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
        this.destroyEngine();
        this._gatewaySeekRequestId += 1;
        clearTimeout(this._seekDebounceTimer);
        this._seekDebounceTimer = null;
        this._pendingSeekTarget = null;
        clearTimeout(this._pendingLocalSeekTimer);
        this._pendingLocalSeekTimer = null;
        this._pendingLocalSeekTarget = null;
        this._pendingLocalSeekAttempts = 0;
        this._gatewaySeekRetry = null;

        // Stop subtitle cue polling/window timers
        this.stopSubtitleEngine();

        // Stop history tracking and save final progress
        this.stopHistoryTracking();
        if (!this._suspendResumeSnapshotSave) {
            this.trackPlaybackPosition({ force: true });
            this.saveResumeSnapshotThrottled(true);
            this.saveProgress({ force: true });
            this.reportAbandonedPlayback();
        }

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
        // Teardown sessions after destroying HLS so stale playlists are not
        // requested while the old Gateway session is being expired.
        const sessionTeardown = Promise.allSettled([
            this.stopTranscodeSession(),
            this.stopCloudPlaybackSessions()
        ]);
        this.baseStreamUrl = null;
        this.currentPlaybackMode = null;
        this.currentProcessingOptions = {};
        this.probeDuration = null;
        this.streamStartOffset = 0;
        this._videoEncodeFallbackTried = false;
        this.subtitleSourceUrl = null;
        this.subtitleStartOffset = 0;
        this.selectedSubtitleStreamIndex = null;
        this.selectedSubtitleTrackUserChoice = false;
        this.updateDurationState();

        this.hideNowPlaying();

        // Resolves once the previous transcode session has fully torn down.
        return sessionTeardown;
    }

    // === Playback Controls ===

    handleAutoplayError(error, label = 'Autoplay error') {
        if (error?.name === 'AbortError') return;
        console.error(`[WatchPage] ${label}:`, error);

        if (error?.name === 'NotAllowedError') {
            this.hideLoading();
            this.centerPlayBtn?.classList.add('show');
            this.showOverlay();
            clearTimeout(this.overlayTimeout);
        }
    }

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
        Promise.resolve(this.seekToTime(base + seconds, { immediate: true }))
            .catch(error => {
                console.error('[WatchPage] Skip seek failed:', error);
                this.handlePlaybackFailure('Failed to seek in this title.').catch(() => { });
            });
    }

    commitSeek(percent) {
        this._timelineScrubbing = false;
        const value = Math.max(0, Math.min(100, parseFloat(percent)));
        if (!Number.isFinite(value)) return;

        const now = Date.now();
        if (this._lastCommittedSeekPercent !== null
            && Math.abs(this._lastCommittedSeekPercent - value) < 0.05
            && now - this._lastCommittedSeekAt < 450) {
            return;
        }

        this._lastCommittedSeekPercent = value;
        this._lastCommittedSeekAt = now;
        this.seek(value);
    }

    seek(percent) {
        const duration = this.getDisplayDuration();
        if (!duration) return;

        const nextPercent = Math.max(0, Math.min(100, parseFloat(percent)));
        if (!Number.isFinite(nextPercent)) return;

        const target = (nextPercent / 100) * duration;
        this.setProgressValue(nextPercent);
        this.trackPlaybackPosition({ position: target, force: true });
        this.saveResumeSnapshotThrottled(true);
        this._pendingSeekTarget = target;
        const debounceGatewaySeek = this.currentPlaybackMode === 'gateway-session'
            && this.canRestartForSeek(target);
        Promise.resolve(this.seekToTime(target, { immediate: !debounceGatewaySeek }))
            .catch(error => {
                console.error('[WatchPage] Seek failed:', error);
                this.handlePlaybackFailure('Failed to seek in this title.').catch(() => { });
            })
            .finally(() => {
                if (!debounceGatewaySeek && !this._timelineScrubbing && this._pendingSeekTarget === target) {
                    this._pendingSeekTarget = null;
                }
            });
    }

    previewSeek(percent) {
        const duration = this.getDisplayDuration();
        if (!duration) return;

        const nextPercent = Math.max(0, Math.min(100, parseFloat(percent)));
        if (!Number.isFinite(nextPercent)) return;

        const target = (nextPercent / 100) * duration;
        this._pendingSeekTarget = target;
        this.setProgressValue(nextPercent);
        if (this.timeCurrent) {
            this.timeCurrent.textContent = this.formatTime(target);
        }
        // Warm the byte cache at the scrub target so the seek on release is instant.
        this._scheduleEnginePrefetch(target);
    }

    // Debounced: while scrubbing, ask the browser engine to prefetch the bytes for
    // the hovered position. Only the browser-engine path supports this; no-op else.
    _scheduleEnginePrefetch(target) {
        if (this.currentPlaybackMode !== 'engine' || !this.norvaEngine || typeof this.norvaEngine.prefetchAt !== 'function') return;
        clearTimeout(this._enginePrefetchTimer);
        this._enginePrefetchTimer = setTimeout(() => {
            try { this.norvaEngine?.prefetchAt(target); } catch (_) {}
        }, 180);
    }

    scheduleProcessedSeek(target, duration, delay = 900) {
        this._pendingSeekTarget = target;
        this.setProgressValue((target / duration) * 100);
        this.trackPlaybackPosition({ position: target, force: true });
        this.saveResumeSnapshotThrottled(true);
        if (this.timeCurrent) {
            this.timeCurrent.textContent = this.formatTime(target);
        }
        this.updateDurationState();

        clearTimeout(this._seekDebounceTimer);
        if (this.currentPlaybackMode === 'gateway-session') {
            this._gatewaySeekRequestId += 1;
            this._gatewaySeekRetry = null;
        }
        this._seekDebounceTimer = setTimeout(() => {
            const nextTarget = this._pendingSeekTarget;
            this._pendingSeekTarget = null;
            this._seekDebounceTimer = null;
            Promise.resolve(this.seekToTime(nextTarget, { immediate: true }))
                .catch(error => {
                    console.error('[WatchPage] Scheduled seek failed:', error);
                    this.handlePlaybackFailure('Failed to seek in this title.').catch(() => { });
                });
        }, delay);
    }

    async seekToTime(targetTime, options = {}) {
        if (!this.video) return;

        const duration = this.getDisplayDuration();
        if (!duration) return;

        const target = Math.max(0, Math.min(targetTime, duration));
        const nativeDuration = this.getValidDuration();

        if (this.canRestartForSeek(target) && !options.immediate) {
            this.scheduleProcessedSeek(target, duration);
            return;
        }

        if (this.canRestartForSeek(target)) {
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

    queuePendingLocalSeek(localTarget) {
        const target = Number(localTarget);
        if (!Number.isFinite(target) || target <= 0.25) {
            this._pendingLocalSeekTarget = null;
            this._pendingLocalSeekAttempts = 0;
            clearTimeout(this._pendingLocalSeekTimer);
            this._pendingLocalSeekTimer = null;
            return;
        }

        this._pendingLocalSeekTarget = target;
        this._pendingLocalSeekAttempts = 0;
        clearTimeout(this._pendingLocalSeekTimer);
        this._pendingLocalSeekTimer = setTimeout(() => this.applyPendingLocalSeek(), 350);
    }

    applyPendingLocalSeek() {
        if (!this.video || !Number.isFinite(this._pendingLocalSeekTarget)) return false;

        const target = Math.max(0, this._pendingLocalSeekTarget);
        const duration = this.getValidDuration();
        const seekable = this.video.seekable;
        const hasSeekableRange = seekable && seekable.length > 0;
        const requiresSeekableRange = this.currentPlaybackMode === 'gateway-session';
        let isAvailable = false;

        if (!requiresSeekableRange && duration && target <= duration + 0.75) {
            isAvailable = true;
        } else if (hasSeekableRange) {
            for (let i = 0; i < seekable.length; i += 1) {
                if (target >= seekable.start(i) - 0.5 && target <= seekable.end(i) + 0.75) {
                    isAvailable = true;
                    break;
                }
            }
        }

        if (!isAvailable && this._pendingLocalSeekAttempts < 40) {
            this._pendingLocalSeekAttempts += 1;
            clearTimeout(this._pendingLocalSeekTimer);
            this._pendingLocalSeekTimer = setTimeout(() => this.applyPendingLocalSeek(), 500);
            return false;
        }

        try {
            this.video.currentTime = target;
            this._pendingLocalSeekTarget = null;
            this._pendingLocalSeekAttempts = 0;
            clearTimeout(this._pendingLocalSeekTimer);
            this._pendingLocalSeekTimer = null;
            this.updateDurationState();
            return true;
        } catch (error) {
            console.warn('[WatchPage] Deferred local seek failed:', error?.message || error);
            return false;
        }
    }

    async restartProcessedStreamAt(targetTime) {
        if (this.currentPlaybackMode === 'gateway-session') {
            await this.restartCloudGatewayStreamAt(targetTime);
            return;
        }

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
        this.trackPlaybackPosition({ position: targetTime, force: true });
        this.saveResumeSnapshotThrottled(true);
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
                this.video.play().catch(e => this.handleAutoplayError(e, 'Remux seek play error'));
            }
        } else if (mode === 'transcode') {
            const processingOptions = this.getFreshProcessingOptions();
            this.currentProcessingOptions = processingOptions;
            this.video.src = this.getTranscodeUrl(sourceUrl, targetTime, processingOptions);
            if (autoplay) {
                this.video.play().catch(e => this.handleAutoplayError(e, 'Transcode seek play error'));
            }
        } else if (mode === 'transcode-session') {
            const processingOptions = this.getFreshProcessingOptions({ seekOffset: targetTime });
            this.currentProcessingOptions = processingOptions;
            const playlistUrl = await this.startTranscodeSession(sourceUrl, processingOptions);
            this.playHlsOrDirect(playlistUrl, { autoplay });
        }

        this.setVolumeFromStorage();
    }

    getGatewaySeekPreRoll(target, requestedPreRoll = 0) {
        const safeTarget = Math.max(0, Math.floor(Number(target) || 0));
        if (safeTarget <= 5) return 0;
        const requested = Math.max(0, Math.floor(Number(requestedPreRoll) || 0));
        // The gateway now emits clean frames at the exact requested offset
        // (accurate two-stage seek), so the default pre-roll is 0: no seek-ahead
        // that stalls the player while the transcoder grinds up to the target
        // (the old 90s pre-roll was the main cause of the slow/"buffering"
        // Resume). A non-zero value is only passed as a fallback when a provider
        // range-seek failure is actually detected.
        return Math.min(safeTarget, requested);
    }

    getGatewaySeekPlan(targetTime, requestedPreRoll = 0) {
        const target = Math.max(0, Math.floor(Number(targetTime) || 0));
        const preRoll = this.getGatewaySeekPreRoll(target, requestedPreRoll);
        const sessionStart = Math.max(0, target - preRoll);
        return {
            target,
            preRoll,
            sessionStart,
            localSeekTarget: Math.max(0, target - sessionStart)
        };
    }

    async restartCloudGatewayStreamAt(targetTime, options = {}) {
        if (!this.content?.sourceId || !this.content?.id) return;

        const requestId = Number.isInteger(options.requestId)
            ? options.requestId
            : ++this._gatewaySeekRequestId;
        const seekPlan = this.getGatewaySeekPlan(targetTime, options.preRollSeconds ?? 0);
        const { target, preRoll, sessionStart, localSeekTarget } = seekPlan;
        const autoplay = !this.video?.paused;
        const itemType = this.content.type === 'series' ? 'series' : 'movie';
        const container = this.containerExtension || this.content.containerExtension || 'mp4';
        const playbackPreferences = this.savePlaybackPreferences(this.getMergedPlaybackPreferences());

        this.showLoading();
        this.hidePlaybackError();
        this.streamStartOffset = sessionStart;
        this.trackPlaybackPosition({ position: target, force: true });
        this.saveResumeSnapshotThrottled(true);
        this.updateDurationState();

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        await this.releasePlaybackPipelineForRetry();
        await this.waitForProviderSlotRelease(900);
        if (requestId !== this._gatewaySeekRequestId) return;

        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }

        const playbackHint = {
            ...(MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(this.content, { container, streamType: itemType })
                : { container, streamType: itemType }),
            ...this.getSelectedAudioPlaybackOptions(),
            seekOffset: sessionStart,
            startOffset: sessionStart,
            resumeTime: sessionStart
        };

        let result = null;
        try {
            result = await API.proxy.xtream.getStreamUrl(
                this.content.sourceId,
                this.content.id,
                itemType,
                container,
                playbackHint
            );
        } catch (error) {
            console.error('[WatchPage] Gateway seek session failed:', error);
            if (!options.retryLevel && this.isRangeSeekFailure(error?.message || error?.details || '')) {
                await this.restartCloudGatewayStreamAt(target, {
                    preRollSeconds: 75,
                    retryLevel: 1,
                    requestId
                });
                return;
            }
            if (requestId !== this._gatewaySeekRequestId) return;
            await this.handlePlaybackFailure(error?.message || 'Failed to start seek session.');
            return;
        }

        if (requestId !== this._gatewaySeekRequestId) {
            await this.cleanupStaleCloudPlaybackSession(result?.sessionId);
            return;
        }

        if (!result?.url) {
            await this.handlePlaybackFailure('Failed to start seek session.');
            return;
        }

        this.content.cloudPlaybackSessionId = result.sessionId || null;
        this.resumeTime = target;
        await this.loadVideo(result.url, this.playbackMetadataFromResult(result, {
            seekOffset: sessionStart,
            startOffset: sessionStart,
            playbackAttemptId: this._playbackAttemptId,
            cloudPlaybackSessionId: result.sessionId || null,
            playbackPreferences
        }));
        this._gatewaySeekRetry = {
            target,
            preRoll,
            retryLevel: Number(options.retryLevel) || 0,
            playbackAttemptId: this._playbackAttemptId,
            requestId
        };
        this.queuePendingLocalSeek(localSeekTarget);

        if (autoplay) {
            this.video?.play?.().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Gateway seek play error:', e);
            });
        } else {
            this.video?.pause?.();
        }

        if (this._pendingSeekTarget === target) {
            this._pendingSeekTarget = null;
        }
    }

    retryGatewaySeekAfterFatalPlayback(reason = '', playbackAttemptId = this._playbackAttemptId) {
        const retry = this._gatewaySeekRetry;
        if (!retry || retry.retryLevel >= 1) return false;
        if (this.currentPlaybackMode !== 'gateway-session') return false;
        if (Number.isInteger(playbackAttemptId) && this.isStalePlaybackAttempt(playbackAttemptId)) return false;
        if (!this.isRangeSeekFailure(reason) && !this.isFormatPlaybackError(reason)) return false;

        const target = Math.max(0, Math.floor(Number(retry.target) || this.getResumeSnapshotPosition() || 0));
        if (!target) return false;

        console.warn('[WatchPage] Gateway seek playback failed, retrying with wider pre-roll:', reason);
        this.restartCloudGatewayStreamAt(target, {
            preRollSeconds: Math.max(75, (Number(retry.preRoll) || 20) * 3),
            retryLevel: retry.retryLevel + 1
        }).catch(error => {
            console.error('[WatchPage] Gateway seek retry failed:', error);
            this.handlePlaybackFailure(error?.message || 'Failed to seek in this title.').catch(() => { });
        });
        return true;
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
                console.log('[WatchPage] Stream URL copied:', this.describePlaybackUrl(streamUrl));
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

    isVodContent() {
        const type = this.contentType || this.content?.type || '';
        return type === 'movie' || type === 'series';
    }

    getDisplayDuration() {
        const probeDuration = this.getProbeDuration();
        const hintedDuration = this.normalizeDuration(this.durationHint);

        if (this.isVodContent() && probeDuration) {
            return probeDuration;
        }

        if (this.streamStartOffset > 0 && hintedDuration && (this.contentType === 'movie' || this.contentType === 'series')) {
            return hintedDuration;
        }

        if (probeDuration && ['remux', 'transcode', 'transcode-session'].includes(this.currentPlaybackMode)) {
            return probeDuration;
        }

        if (this.isVodContent() && ['gateway-session', 'direct-hls'].includes(this.currentPlaybackMode) && !probeDuration) {
            return null;
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

    isLocalSeekTargetAvailable(target) {
        if (!this.video || !Number.isFinite(target)) return false;

        const localTarget = target - (this.streamStartOffset || 0);
        if (localTarget < -0.5) return false;

        const nativeDuration = this.getValidDuration();
        if (nativeDuration && localTarget > nativeDuration + 0.75) return false;

        const seekable = this.video.seekable;
        if (!seekable || seekable.length === 0) {
            if (this.currentPlaybackMode === 'gateway-session') return false;
            return Boolean(nativeDuration && localTarget >= 0 && localTarget <= nativeDuration);
        }

        for (let i = 0; i < seekable.length; i++) {
            if (localTarget >= seekable.start(i) - 0.5 && localTarget <= seekable.end(i) + 0.5) {
                return true;
            }
        }
        return false;
    }

    canRestartForSeek(target = null) {
        if (this.currentPlaybackMode === 'gateway-session') {
            const canCloudSeek = Boolean(this.isVodContent() && this.content?.sourceId && this.content?.id && this.getDisplayDuration());
            if (!canCloudSeek) return false;
            if (!Number.isFinite(target)) return true;
            return !this.isLocalSeekTargetAvailable(target);
        }

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
        const previewPosition = this._timelineScrubbing && Number.isFinite(this._pendingSeekTarget)
            ? Math.max(0, Math.min(this._pendingSeekTarget, duration || this._pendingSeekTarget))
            : null;

        if (this.timeCurrent) {
            this.timeCurrent.textContent = this.formatTime(previewPosition ?? currentTime);
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
        if (!this._timelineScrubbing) {
            this.setProgressValue((currentTime / duration) * 100);
        }
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
            const canResume = !duration || this.resumeTime < duration * 0.95; // not near the end
            if (this.currentPlaybackMode === 'engine') {
                // The engine resumes itself in load() (it sets currentTime before this
                // fires). Only rescue if that didn't stick — i.e. it's still at the
                // start — so we restore the resume without a redundant re-seek.
                if (canResume && this.video.currentTime < 1 && this.resumeTime > 1) {
                    console.log(`[WatchPage] Resume rescue at ${this.resumeTime}s`);
                    try { this.video.currentTime = this.resumeTime; } catch (_) {}
                }
            } else if (canResume) {
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

        if (!this._playStartedReported) {
            this._playStartedReported = true;
            if (this.playbackTelemetry) this.playbackTelemetry.playStartedReported = true;
            this.sendPlaybackEvent('play_started');
        } else if (this._lastPauseTelemetryAt) {
            this._lastPauseTelemetryAt = 0;
            this.sendPlaybackEvent('resume');
        }

        // Start overlay auto-hide
        this.startOverlayTimer();
    }

    onPause() {
        this.playPauseBtn?.querySelector('.icon-play')?.classList.remove('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.add('hidden');
        this.centerPlayBtn?.classList.add('show');
        this.trackPlaybackPosition({ force: true });
        this.saveResumeSnapshotThrottled(true);
        this.saveProgress({ force: true });

        // Keep overlay visible when paused
        this.showOverlay();
        clearTimeout(this.overlayTimeout);

        if (!this.video?.ended && this._playStartedReported) {
            const now = Date.now();
            if (now - this._lastPauseTelemetryAt > 1000) {
                this._lastPauseTelemetryAt = now;
                this.sendPlaybackEvent('pause');
            }
        }
    }

    onEnded() {
        if (!this._playbackEnded) {
            this._playbackEnded = true;
            if (this.playbackTelemetry) this.playbackTelemetry.ended = true;
            this.sendPlaybackEvent('ended');
            const duration = this.getDisplayDuration?.() || this._lastKnownPlaybackDuration || 0;
            if (duration > 0) {
                this.trackPlaybackPosition({ position: duration, force: true });
            }
            this.saveProgress({ force: true });
            this.clearResumeSnapshot();
            this._clearResumePosition(); // finished → don't resume next time
            if (this.playBtnText) this.playBtnText.textContent = 'Restart';
        }

        // For series, propose the next episode. Autoplay controls whether the
        // countdown starts, but the next episode affordance is useful either way.
        const autoPlayEnabled = this.app?.player?.settings?.autoPlayNextEpisode;
        if (autoPlayEnabled && this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing) {
            const nextEp = this.getNextEpisode();
            if (nextEp) {
                this.nextEpisodeShowing = true;
                this.showNextEpisodePanel(nextEp, { autoCountdown: true });
            }
        } else if (this.contentType === 'series' && this.seriesInfo && !this.nextEpisodeShowing) {
            const nextEp = this.getNextEpisode();
            if (nextEp) {
                this.nextEpisodeShowing = true;
                this.showNextEpisodePanel(nextEp, { autoCountdown: false });
            }
        }
    }

    onError(e) {
        const videoAttemptId = Number.parseInt(this.video?.dataset?.playbackAttemptId || '', 10);
        if (Number.isFinite(videoAttemptId) && this.isStalePlaybackAttempt(videoAttemptId)) return;

        // Engine mode is "engine only": a MediaError means the in-browser engine
        // can't play this title. Report it (telemetry) and show the native-app
        // message — do NOT run the gateway/version retry chain (no Railway).
        if (this.currentPlaybackMode === 'engine') {
            const err = this.video?.error;
            // Benign: fired while the previous src is cleared during stop()/setup,
            // before the engine has attached its MediaSource. Not a real failure.
            if (!err || !err.code || /Empty src/i.test(err.message || '')) return;
            this.reportEngineFailure({ stage: 'mediaerror', message: 'code=' + err.code + ' ' + (err.message || '') });
            this.destroyEngine();
            this.handleEngineUnplayable(new Error('MEDIA_ERR_' + err.code));
            return;
        }

        // Only log actual fatal errors, not benign stream recovery events
        const error = this.video?.error;
        if (error && error.code) {
            if (this.hasCurrentMedia()) {
                this.hidePlaybackError();
                return;
            }
            const currentSrc = this.video?.currentSrc || this.video?.src || '';
            if (!currentSrc && Date.now() < this._suppressMediaErrorsUntil) return;
            // Benign: fired when the src is cleared during stop()/teardown
            if (/Empty src/i.test(error.message || '')) return;
            console.error('[WatchPage] Video error:', error.code, error.message);
            // MEDIA_ERR_NETWORK / MEDIA_ERR_DECODE / MEDIA_ERR_SRC_NOT_SUPPORTED:
            // fail over to another version of the same title if available
            if ([2, 3, 4].includes(error.code)) {
                const message = error.message || 'Media error';
                this.logRelayUpstreamDiagnostic(currentSrc);
                if (this.retryGatewaySeekAfterFatalPlayback(message, videoAttemptId)) return;
                this.sendPlaybackEvent('playback_error', {
                    errorCode: String(error.code),
                    errorMessage: message
                });
                this.handlePlaybackFailure(message)
                    .catch(error => console.warn('[WatchPage] Playback failure handler failed:', error?.message || error));
            }
        }
    }

    /**
     * Diagnostic only (no effect on playback or fallback): the <video> element
     * never exposes the HTTP status behind a fatal error, so a provider 401/403/
     * 404 is indistinguishable from a codec failure ("Video error: 4"). When a
     * relay/direct URL fails, re-request it once with a tiny range to read the
     * relay's X-Norva-Upstream-* headers and log the real provider status+reason,
     * so the cause (connection limit vs wrong container vs dead link) is visible.
     */
    async logRelayUpstreamDiagnostic(src) {
        try {
            if (!src || typeof fetch !== 'function') return;
            if (/^(blob:|data:|mediasource:)/i.test(src)) return; // engine/MSE: not a provider URL
            const res = await fetch(src, {
                method: 'GET',
                headers: { Range: 'bytes=0-1' },
                cache: 'no-store',
            });
            const upstreamStatus = res.headers.get('x-norva-upstream-status');
            const upstreamReason = res.headers.get('x-norva-upstream-reason');
            const upstreamFinal = res.headers.get('x-norva-upstream-final');
            if (res.ok && !upstreamStatus) {
                console.warn('[WatchPage] Relay upstream diagnostic: stream reachable (http=' +
                    res.status + ') — failure was likely client-side decode/codec, not the provider.');
                return;
            }
            console.warn('[WatchPage] Relay upstream diagnostic:',
                'http=' + res.status,
                'upstream=' + (upstreamStatus || 'n/a'),
                'reason="' + (upstreamReason || '') + '"',
                upstreamFinal ? 'final=' + upstreamFinal : '');
        } catch (e) {
            console.warn('[WatchPage] Relay upstream diagnostic failed:', e?.message || e);
        }
    }

    /**
     * Terminal playback failure: try the next version of the title,
     * otherwise stop the spinner and show a clear error message.
     */
    async handlePlaybackFailure(message) {
        if (this._handlingPlaybackFailure) {
            console.warn('[WatchPage] Ignoring duplicate playback failure while retry is already running:', message);
            return;
        }

        if (this.hasCurrentMedia()) {
            console.warn('[WatchPage] Ignoring stale playback failure because media is active:', message);
            this.hidePlaybackError();
            this.hideLoading();
            return;
        }

        this._handlingPlaybackFailure = true;
        try {
            this._lastFailureMsg = message;
            this.sendPlaybackEvent('playback_error', { errorMessage: message || 'Playback failed.' });
            const retriedWithGatewayTranscode = await this.retryWithCloudGatewayTranscode(message);
            if (retriedWithGatewayTranscode) return;

            const retriedWithRelay = await this.retryWithCloudRelay(message);
            if (retriedWithRelay) return;

            const retriedWithEncode = await this.retryWithFullVideoTranscode(message);
            if (retriedWithEncode) return;

            // 401/403/429 = connection-limit or account throttle, not a dead title.
            // Never mark as broken: it would hide a perfectly valid stream.
            if (!this.isConnectionLimitError(message)) {
                await this.reportPlaybackStatus('broken', message);
            }
            await this.releasePlaybackPipelineForRetry();
            const attempted = await this.tryNextVersion();
            if (!attempted) {
                this.showPlaybackError(message);
            }
        } finally {
            this._handlingPlaybackFailure = false;
        }
    }

    isFormatPlaybackError(message) {
        return /MEDIA_ELEMENT_ERROR|MEDIA_ERR_DECODE|Format error|decode|bufferAppendError|fragParsingError|sourceBuffer|appendBuffer|manifestLoadError|levelLoadError|Gateway session/i.test(message || '');
    }

    isGatewaySessionGoneError(data = {}) {
        const response = data.response || {};
        const networkDetails = data.networkDetails || {};
        const code = Number(response.code ?? response.status ?? response.statusCode ?? networkDetails.status);
        const detail = String(data.details || '');
        const text = [
            response.text,
            response.statusText,
            networkDetails.responseText,
            networkDetails.statusText,
            data.reason,
            data.error?.message,
            data.details
        ].filter(Boolean).join(' ');
        const isPlaylistLoad = /manifestLoadError|levelLoadError|fragLoadError/i.test(detail);
        return isPlaylistLoad && (
            code === 404 ||
            code === 410 ||
            /session not found|session expired|session gone/i.test(text)
        );
    }

    gatewaySessionGoneMessage(data = {}) {
        const response = data.response || {};
        const networkDetails = data.networkDetails || {};
        const code = Number(response.code ?? response.status ?? response.statusCode ?? networkDetails.status);
        if (code === 410) return 'Gateway session expired.';
        return 'Gateway session not found.';
    }

    isGatewayOnlyContainer() {
        const container = String(this.containerExtension || this.content?.containerExtension || '')
            .split('?')[0].split('#')[0].toLowerCase();
        // Mirrors api.js requiresGatewayForContainer: the browser can't play
        // these directly, so relay/direct fallbacks never work — only the
        // gateway transcode can. Skipping them avoids the "Media error" storm.
        return ['mkv', 'avi', 'wmv', 'flv', 'mov', 'webm', 'ts', 'mpeg', 'mpg', 'vob'].includes(container);
    }

    async retryWithCloudRelay(message) {
        if (!this.isCloudPlaybackMode()) return false;
        if (this._cloudRelayFallbackTried) return false;
        if (!this.isFormatPlaybackError(message)) return false;
        if (!this.content?.sourceId || !this.content?.id) return false;
        // Relay yields a direct provider stream the browser can't decode for
        // gateway-only containers (MKV/AVI/…) — don't even try; let the gateway
        // transcode retry (already attempted first) own the recovery.
        if (this.isGatewayOnlyContainer()) return false;
        const gatewaySessionGone = /Gateway session (not found|expired)/i.test(message || '');
        if (!gatewaySessionGone && (this.currentPlaybackMode === 'gateway-session'
            || this.isGatewayPlaybackUrl(this.currentUrl)
            || this.isGatewayPlaybackUrl(this.baseStreamUrl))) {
            return false;
        }

        this._cloudRelayFallbackTried = true;
        console.warn('[WatchPage] Gateway media append failed. Retrying through Relay.');
        this.hidePlaybackError();
        this.showLoading();
        this.updateTranscodeStatus('remuxing', 'Norva Relay');

        try {
            await this.releasePlaybackPipelineForRetry();
            const result = await API.proxy.xtream.getStreamUrl(
                this.content.sourceId,
                this.content.id,
                this.content.type === 'series' ? 'series' : 'movie',
                this.containerExtension || 'mp4',
                { mode: 'relay' }
            );

            if (!result?.url) return false;
            this.content.cloudPlaybackSessionId = result.sessionId || null;
            await this.loadVideo(result.url, this.playbackMetadataFromResult(result, {
                playbackAttemptId: this._playbackAttemptId
            }));
            return true;
        } catch (error) {
            console.warn('[WatchPage] Relay fallback failed:', error?.message || error);
            return false;
        }
    }

    async retryWithCloudGatewayTranscode(message) {
        if (!this.isCloudPlaybackMode()) return false;
        if (this._cloudGatewayTranscodeFallbackTried) return false;
        if (!this.isFormatPlaybackError(message)) return false;
        if (!this.content?.sourceId || !this.content?.id) return false;
        if (this.content.type !== 'movie' && this.content.type !== 'series') return false;

        this._cloudGatewayTranscodeFallbackTried = true;
        console.warn('[WatchPage] Gateway remux failed. Retrying with full Gateway transcode.');
        this.hidePlaybackError();
        this.showLoading();
        this.updateTranscodeStatus('transcoding', 'Norva Gateway');

        try {
            await this.releasePlaybackPipelineForRetry();
            const position = Math.max(0, Math.floor(this.getResumeSnapshotPosition()) - 3);
            const itemType = this.content.type === 'series' ? 'series' : 'movie';
            const container = this.containerExtension || 'mp4';
            const playbackHint = {
                gatewayMode: 'transcode',
                audioMode: 'transcode',
                ...this.getSelectedAudioPlaybackOptions(),
                seekOffset: position,
                startOffset: position,
                resumeTime: position
            };

            let result = null;
            let lastError = null;
            await this.waitForProviderSlotRelease(1400);
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    result = await API.proxy.xtream.getStreamUrl(
                        this.content.sourceId,
                        this.content.id,
                        itemType,
                        container,
                        playbackHint
                    );
                    break;
                } catch (error) {
                    lastError = error;
                    if (attempt === 0) {
                        const retryDelay = this.getAudioSwitchRetryDelay(error);
                        console.warn(`[WatchPage] Gateway transcode session failed, retrying after ${retryDelay}ms provider cooldown:`, error?.message || error);
                        await this.waitForProviderSlotRelease(retryDelay);
                    }
                }
            }
            if (!result && lastError) throw lastError;

            if (!result?.url) return false;
            this.content.cloudPlaybackSessionId = result.sessionId || null;
            await this.loadVideo(result.url, this.playbackMetadataFromResult(result, {
                playbackAttemptId: this._playbackAttemptId,
                seekOffset: position,
                startOffset: position
            }));
            return true;
        } catch (error) {
            console.warn('[WatchPage] Gateway transcode fallback failed:', error?.message || error);
            return false;
        }
    }

    async retryWithFullVideoTranscode(message) {
        if (this.isCloudPlaybackMode()) return false;
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

    showPlaybackError(message, options = {}) {
        if (this.hasCurrentMedia()) {
            console.warn('[WatchPage] Suppressing stale playback error because media is already playing:', message);
            this.hidePlaybackError();
            return;
        }

        const safeMessage = this.sanitizePlaybackMessage(message);
        if (!options.immediate && this.shouldDeferPlaybackError(safeMessage)) {
            this.deferPlaybackError(safeMessage);
            return;
        }

        this.clearDeferredPlaybackError();
        this.hideLoading();
        this.updateTranscodeStatus('hidden');

        let errorEl = document.getElementById('watch-error');
        if (!errorEl) {
            errorEl = document.createElement('div');
            errorEl.id = 'watch-error';
            errorEl.className = 'watch-error';
            document.querySelector('.watch-video-section')?.appendChild(errorEl);
        }

        const friendly = this.getFriendlyPlaybackError(safeMessage);
        const detail = this.escapePlaybackDetail(safeMessage);
        // A provider auth / rate-limit block (401/403/429) does not clear on a
        // reload — auto-refreshing just spins on the same blocked path. Skip it
        // and point the user to a residential path (native app / local hub).
        const providerBlocked = this.isConnectionLimitError(safeMessage);
        const refreshScheduled = providerBlocked ? false : this.schedulePlaybackErrorRefresh();
        const refreshHint = providerBlocked
            ? "No need to refresh: this block comes from the provider. Watch this title from the TV/mobile app or a local hub (your network), or try again later."
            : refreshScheduled
                ? 'The page will refresh automatically in 2 seconds. If the problem persists, refresh the page manually.'
                : 'If the problem persists, refresh the page manually.';
        const refreshBtnLabel = providerBlocked ? 'Retry' : 'Refresh now';

        errorEl.innerHTML = `
            <div class="watch-error-box">
                <p class="watch-error-title">⚠ Unable to play this title</p>
                <p class="watch-error-msg">${friendly}</p>
                <p class="watch-error-refresh">${refreshHint}</p>
                <button type="button" class="watch-error-refresh-btn" id="watch-error-refresh-btn">${refreshBtnLabel}</button>
                ${detail ? `<p class="watch-error-detail">${detail}</p>` : ''}
            </div>`;
        errorEl.classList.remove('hidden');
        document.getElementById('watch-error-refresh-btn')?.addEventListener('click', () => {
            this.clearPlaybackErrorRefreshTimer();
            window.location.reload();
        });

        // HLS/transcode sessions can recover just after an error callback fired.
        // Re-check shortly so a stale fatal banner never stays over active video.
        [500, 1500, 4000].forEach(delay => {
            setTimeout(() => this.markPlaybackUsable(), delay);
        });
    }

    hidePlaybackError() {
        this.clearDeferredPlaybackError();
        this.clearPlaybackErrorRefreshTimer();
        document.getElementById('watch-error')?.classList.add('hidden');
    }

    getPlaybackErrorRefreshGuardKey() {
        const contentKey = [
            this.content?.sourceId,
            this.content?.type,
            this.content?.id
        ].filter(Boolean).join(':');
        return contentKey || window.location.href;
    }

    schedulePlaybackErrorRefresh() {
        this.clearPlaybackErrorRefreshTimer();

        const key = this.getPlaybackErrorRefreshGuardKey();
        const now = Date.now();
        try {
            const previous = JSON.parse(sessionStorage.getItem(this.playbackErrorRefreshKey) || 'null');
            if (previous?.key === key && now - Number(previous.at || 0) < this.playbackErrorRefreshGuardMs) {
                return false;
            }
            sessionStorage.setItem(this.playbackErrorRefreshKey, JSON.stringify({ key, at: now }));
        } catch (error) {
            console.warn('[WatchPage] Auto-refresh guard unavailable:', error?.message || error);
            return false;
        }

        this._playbackErrorRefreshTimer = setTimeout(() => {
            this._playbackErrorRefreshTimer = null;
            const errorEl = document.getElementById('watch-error');
            const errorVisible = errorEl && !errorEl.classList.contains('hidden');
            if (!errorVisible || this.hasCurrentMedia()) return;
            try {
                this.trackPlaybackPosition({ force: true });
                this.saveResumeSnapshotThrottled(true);
            } catch (_) {
                // Continue with the refresh even if local persistence fails.
            }
            window.location.reload();
        }, this.playbackErrorRefreshDelayMs);

        return true;
    }

    clearPlaybackErrorRefreshTimer() {
        if (this._playbackErrorRefreshTimer) {
            clearTimeout(this._playbackErrorRefreshTimer);
            this._playbackErrorRefreshTimer = null;
        }
    }

    shouldDeferPlaybackError(message) {
        if (this._pendingPlaybackErrorTimer) return false;
        if (!this.isCloudPlaybackMode()) return false;
        if (!this.content?.id) return false;
        if (this.hasCurrentMedia()) return false;
        return this.isFormatPlaybackError(message)
            || this.isConnectionLimitError(message)
            || /Media error|Playback failed|network|timeout|refused/i.test(message || '');
    }

    deferPlaybackError(message, delayMs = 7000) {
        this.clearDeferredPlaybackError();
        this._pendingPlaybackErrorMessage = message;
        this.showLoading();
        this._pendingPlaybackErrorTimer = setTimeout(() => {
            this._pendingPlaybackErrorTimer = null;
            const deferredMessage = this._pendingPlaybackErrorMessage;
            this._pendingPlaybackErrorMessage = null;
            if (this.hasCurrentMedia()) {
                this.hidePlaybackError();
                return;
            }
            if (this._handlingPlaybackFailure) {
                this.deferPlaybackError(deferredMessage || message, 3000);
                return;
            }
            this.showPlaybackError(deferredMessage || message, { immediate: true });
        }, delayMs);
    }

    clearDeferredPlaybackError() {
        if (this._pendingPlaybackErrorTimer) {
            clearTimeout(this._pendingPlaybackErrorTimer);
            this._pendingPlaybackErrorTimer = null;
        }
        this._pendingPlaybackErrorMessage = null;
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
        if (!this._firstFrameReported) {
            this._firstFrameReported = true;
            if (this.playbackTelemetry) this.playbackTelemetry.firstFrameReported = true;
            const requestedAt = this.playbackTelemetry?.requestedAt || this._playRequestedAt || Date.now();
            // Attach the in-browser engine's per-stage startup timings so we can
            // see exactly where launch time goes (wasm vs probe vs demux vs ...).
            const engineTimings = this.norvaEngine?.timings;
            this.sendPlaybackEvent('first_frame', {
                timeToFirstFrameMs: Math.max(1, Date.now() - requestedAt),
                ...(engineTimings ? { metadata: { engineTimings } } : {})
            });
        }
        if (!this._playbackStatusOkReported) {
            this._playbackStatusOkReported = true;
            this.reportPlaybackStatus('ok').catch(() => { });
        }
        this.reportObservedAudioLanguages();
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
            const result = await API.proxy.xtream.getStreamUrl(next.sourceId, next.streamId, next.type || 'movie', next.container || 'mp4', {
                seekOffset: position,
                startOffset: position,
                resumeTime: position
            });
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
                await this.loadVideo(result.url, this.playbackMetadataFromResult(result, {
                    seekOffset: position,
                    startOffset: position
                }));
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
            // Engine path: enumerate audio/subtitle languages now (buffer built →
            // the gateway's second provider connection is survivable). Populates the
            // gateway-ffprobe audio fallback (e.g. a lone Japanese track the relay
            // parser missed) and the subtitle list. Best-effort, runs once.
            if (this.currentPlaybackMode === 'engine') this.enrichEngineSubtitleTracks();
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

    // Provider track metadata (get_vod_info via the relay) for cloud playback.
    // Display-only: it enriches the single audio entry's label to match what
    // native players show ("English · AAC · Stereo · 128 kbps"); it never makes the
    // entry a switchable 'probe' track, so it can't restart or break playback.
    // Ordered per-track audio map precomputed by the crawl and served on content
    // (audioTracks = [{index, lang|null}, ...] in absolute-stream order). Present → the
    // player labels every track with ZERO playback-time probe.
    getContentAudioTracks() {
        const raw = this.content?.audioTracks || this.content?.audio_tracks;
        if (!Array.isArray(raw)) return [];
        return raw
            .map((t) => ({ index: Number(t?.index), lang: (t?.lang == null ? null : String(t.lang).toLowerCase()) }))
            .filter((t) => Number.isInteger(t.index));
    }

    async enrichCloudPlaybackTracks(playbackUrl) {
        try {
            // Robust path: a precomputed ordered map on content means real language names
            // with NO provider hit at playback (no probe to contend with the stream, no
            // latency). Reuse applyCloudMultiAudioTracks so the engine/direct wiring is
            // identical to the live-probe path — only the source of the data differs.
            const pre = this.getContentAudioTracks();
            if (pre.length) {
                this.applyCloudMultiAudioTracks({ audioTracks: pre });
                this.updateAudioTracks();
                return;
            }
            if (!playbackUrl || typeof fetch !== 'function') return;
            const m = /^(https?:\/\/[^/]+)\/relay\/(.+)$/.exec(String(playbackUrl));
            if (!m) return;
            const host = m[1], token = m[2];
            // No precomputed map (we early-returned above if we had one), so probe the file's
            // real audio tracks at play time — UNGATED. The old contentLooksMultiAudio() gate
            // meant a single-/unknown-language file was NEVER probed and fell to a bare
            // "Default" menu; since the precompute crawl only reaches a few % of the catalogue,
            // that was nearly every title. Probing here gives the real language (e.g. Persian)
            // for whatever the user actually watches, 24h-cached relay-side, and the result is
            // reported back to populate the shared cache for next time / other users.
            const infoP = fetch(`${host}/vod-info/${token}`, { cache: 'no-store' })
                .then(r => (r.ok ? r.json() : null)).catch(() => null);
            const probeP = fetch(`${host}/probe-audio/${token}`, { cache: 'no-store' })
                .then(r => (r.ok ? r.json() : null)).catch(() => null);
            const [data, probe] = await Promise.all([infoP, probeP]);
            if (data) {
                this.cloudAudioInfo = (Array.isArray(data.audioTracks) && data.audioTracks[0]) || null;
                if (data.duration && !this.probeDuration) {
                    this.probeDuration = this.normalizeDuration(data.duration);
                    this.updateDurationState();
                }
            }
            this.applyCloudMultiAudioTracks(probe);
            // Seed the single-label path: applyCloudMultiAudioTracks builds a switchable list
            // only for >=2 languages and bails for one. So for a mono-/single-language file we
            // feed the probe's detected language(s) into content.audio_languages, which is the
            // ground truth contentAudioLanguageLabel() reads — the menu then shows the REAL
            // language ("Persian") instead of "Default". Untagged streams stay "und" -> dropped.
            if (probe && Array.isArray(probe.audioLanguages) && probe.audioLanguages.length && this.content) {
                const langs = probe.audioLanguages
                    .map((l) => this.normalizeTrackLanguage(l))
                    .filter((l) => l && l !== 'und');
                if (langs.length) {
                    const existing = Array.isArray(this.content.audio_languages) ? this.content.audio_languages : [];
                    const merged = Array.from(new Set([...existing, ...langs]));
                    this.content.audio_languages = merged;
                    this.content.audioLanguages = merged;
                }
            }
            this.updateAudioTracks();
            this.reportObservedAudioLanguages();
        } catch (_) { /* best-effort enrichment */ }
    }

    // True when the title is known to carry multiple audio languages (so the extra
    // container probe to enumerate switchable per-track entries is worthwhile).
    contentLooksMultiAudio() {
        const a = this.content?.audioLanguages || this.content?.audio_languages;
        if (Array.isArray(a) && a.length >= 2) return true;
        const v = this.content?.versionLanguages || this.content?.version_languages;
        return Array.isArray(v) && v.some(t => /^multi$/i.test(String(t)));
    }

    // Populate this.audioTracks from the relay's ordered per-track probe so a
    // direct-play MULTI file shows real, switchable language tracks (not just "Multi").
    // Each track carries the ABSOLUTE ffmpeg stream index, so selecting a non-default
    // language restarts via the gateway with the correct -map. The default track keeps
    // playing zero-egress until the user picks another. No-op unless >=2 known languages.
    applyCloudMultiAudioTracks(probe) {
        const raw = Array.isArray(probe?.audioTracks) ? probe.audioTracks : [];
        // Raw ORDERED tracks (audio-relative) kept for the engine path, which maps
        // them to its demuxed streams by index (and falls back to position).
        this._relayAudioTracks = raw.map((t) => ({ index: Number(t?.index), lang: this.normalizeTrackLanguage(t?.lang) }));
        // index -> language from the relay probe (first wins, kept in track order).
        const langByIdx = new Map();
        for (const t of raw) {
            const idx = Number(t?.index);
            const lang = this.normalizeTrackLanguage(t?.lang);
            if (Number.isInteger(idx) && lang && lang !== 'und' && !langByIdx.has(idx)) langByIdx.set(idx, lang);
        }
        // Engine mode owns the track LIST (every demuxed stream); the relay only
        // supplies the language labels, merged in by absolute stream index.
        if (this.currentPlaybackMode === 'engine' && Array.isArray(this.audioTracks) && this.audioTracks.length >= 2) {
            this.audioTracks = this.audioTracks.map(t => ({ ...t, language: t.language || langByIdx.get(t.index) || null }));
            this.updateAudioTracks();
            return;
        }
        // Direct play: build the switchable list from the relay probe (dedupe by lang).
        const seen = new Set();
        const usable = [];
        for (const [idx, lang] of langByIdx) {
            if (seen.has(lang)) continue;
            seen.add(lang);
            usable.push({ index: idx, language: lang });
        }
        if (usable.length < 2) return; // single/unknown -> keep the single-label path
        const defLang = this.normalizeTrackLanguage(probe?.audioDefaultLanguage);
        let defPos = usable.findIndex(t => t.language === defLang);
        if (defPos < 0) defPos = 0;
        this.audioTracks = usable.map((t, i) => ({ index: t.index, language: t.language, default: i === defPos }));
        if (!Number.isInteger(this.directAudioStreamIndex)) this.directAudioStreamIndex = usable[defPos].index;
        if (!this.selectedAudioTrackUserChoice && !Number.isInteger(this.selectedAudioStreamIndex)) {
            this.selectedAudioStreamIndex = usable[defPos].index;
        }
    }

    formatChannelLayout(layout, channels) {
        const map = { mono: 'Mono', stereo: 'Stereo', '5.1': '5.1', '5.1(side)': '5.1', '7.1': '7.1' };
        if (layout && map[layout]) return map[layout];
        if (layout) return layout;
        if (channels === 1) return 'Mono';
        if (channels === 2) return 'Stereo';
        return channels ? `${channels}ch` : '';
    }

    // Reliable language label from the title's server-detected audio_languages
    // (the same ground truth behind the "Audio FR confirmed" card badge), formatted
    // exactly like the card via MediaUtils.audioLanguageBadge: 1 lang -> "French",
    // 2-3 -> "Multi: FR/EN/JA", >3 -> "Multi". Returns null when nothing is detected,
    // so callers keep "Default"/"Audio" rather than fabricating a language.
    contentAudioLanguageLabel() {
        const audio = this.content?.audioLanguages || this.content?.audio_languages || null;
        const version = this.content?.versionLanguages || this.content?.version_languages || null;
        const hasAudio = Array.isArray(audio) && audio.length;
        const hasVersion = Array.isArray(version) && version.length;
        if (!hasAudio && !hasVersion) return null;
        try {
            const label = window.MediaUtils?.audioLanguageBadge?.(audio || [], version || []);
            return label || null;
        } catch (_) {
            return null;
        }
    }

    // Title of the episode currently playing — carries the per-episode version tag
    // (e.g. "...VOSTFR"), which the series title itself usually doesn't.
    currentEpisodeRawTitle() {
        try {
            if (!this.seriesInfo?.episodes || !this.currentSeason || !this.currentEpisode) return null;
            const eps = this.seriesInfo.episodes[this.currentSeason] || [];
            const ep = eps.find((e) => parseInt(e.episode_num) === parseInt(this.currentEpisode));
            return ep ? (ep.title || ep.name || null) : null;
        } catch (_) {
            return null;
        }
    }

    // Player-menu fallback when no real per-track language is known: infer the audio VERSION
    // from the provider's episode/title name (e.g. a "VOSTFR"/"VO" tag => the ORIGINAL audio,
    // a "VF" tag => French) so the menu reads something meaningful instead of "Default".
    // CRITICAL: "original" is NOT a language — VOSTFR can be any source language. It resolves to
    // the title's real TMDB original_language ("Japanese", "English", "Korean"…) when known, and
    // otherwise to a plain "VO". We never assume a specific language from the VOSTFR tag.
    playingAudioVersionLabel() {
        try {
            const name = this.currentEpisodeRawTitle() || this.content?.title || '';
            const info = window.MediaUtils?.parseVersionInfo?.(name);
            const audioSig = (info?.audioSignals || [])[0];
            if (!audioSig) return null;
            if (audioSig.language === 'original') {
                const orig = this.normalizeTrackLanguage(
                    this.content?.originalLanguage || this.content?.original_language,
                );
                if (orig && orig !== 'und') {
                    const display = this.getLanguageDisplayName(orig);
                    if (display) return display; // real original language, e.g. "Japanese" / "English"
                }
                return 'VO'; // original audio, language unknown — honest, never guessed
            }
            return this.getLanguageDisplayName(audioSig.language) || null; // a concrete dub tag (VF…)
        } catch (_) {
            return null;
        }
    }

    getCloudAudioLabel(a) {
        if (!a) return this.contentAudioLanguageLabel() || this.playingAudioVersionLabel() || 'Default';
        const parts = [];
        // PRIMARY: the real per-track language from get_vod_info. When the provider
        // omits it (language:""), fall back to the title's detected language so a
        // real-language file still reads "French · AAC · 5.1" instead of codec-only.
        const lang = this.getLanguageDisplayName(a.language) || this.contentAudioLanguageLabel() || this.playingAudioVersionLabel();
        if (lang) parts.push(lang);
        if (a.codec) parts.push(String(a.codec).toUpperCase());
        const ch = this.formatChannelLayout(a.channelLayout, a.channels);
        if (ch) parts.push(ch);
        if (a.bitRate) parts.push(`${Math.round(a.bitRate / 1000)} kbps`);
        return parts.length ? parts.join(' · ') : 'Default';
    }

    getVisibleAudioTracks() {
        const hlsTracks = this.getHlsAudioTracks();
        if (hlsTracks.length > 1) return hlsTracks;

        const nativeTracks = this.getNativeAudioTracks();
        if (nativeTracks.length > 1) return nativeTracks;

        const probeTracks = this.getProbeAudioTracks();
        if (probeTracks.length) return probeTracks;

        if (this.cloudAudioInfo) {
            return [{ source: 'none', index: -1, label: this.getCloudAudioLabel(this.cloudAudioInfo), active: true }];
        }

        // Browser can't demux video.audioTracks for direct-MP4 play, so there's no
        // switchable track list. Show the title's detected language (matches the card
        // badge + the native mobile player) instead of a meaningless "Default".
        const contentLabel = this.contentAudioLanguageLabel() || this.playingAudioVersionLabel();
        return [{ source: 'none', index: -1, label: contentLabel || 'Default', active: true }];
    }

    // Best-effort capture of the real audio-track languages observed at playback
    // (default track from get_vod_info + the demuxed track list) so the catalogue
    // learns which languages a "Multi" file actually carries. Title-scoped + deduped
    // by the code set; never disrupts playback.
    reportObservedAudioLanguages() {
        try {
            if (!window.API?.isCloudMode?.()) return;
            const titleId = this.content?.titleId || this.content?.title_id;
            if (!titleId) return;
            const codes = new Set();
            const add = (lang) => {
                const code = this.normalizeTrackLanguage(lang);
                if (code && code !== 'und' && /^[a-z]{2,3}$/.test(code)) codes.add(code);
            };
            if (this.cloudAudioInfo) add(this.cloudAudioInfo.language);
            for (const t of (Array.isArray(this.audioTracks) ? this.audioTracks : [])) add(t.language || t.lang);
            const native = this.video?.audioTracks;
            if (native && Number.isFinite(native.length)) {
                for (let i = 0; i < native.length; i++) add(native[i]?.language);
            }
            for (const t of (Array.isArray(this.hls?.audioTracks) ? this.hls.audioTracks : [])) add(t.lang || t.language);
            // Ordered per-track map from a live container probe — let the server persist the
            // ORDER so future playbacks of this title need zero probe (self-heal). The server
            // only stores it when the title has none yet, so re-sending is a harmless no-op.
            const orderedTracks = (Array.isArray(this._relayAudioTracks) ? this._relayAudioTracks : [])
                .filter((t) => Number.isInteger(t.index))
                .map((t) => ({ index: t.index, lang: (t.lang && t.lang !== 'und') ? t.lang : null }));
            if (!codes.size && !orderedTracks.length) return;
            const key = `${titleId}:${[...codes].sort().join(',')}:${orderedTracks.length}`;
            if (this._observedLangsSent === key) return;
            this._observedLangsSent = key;
            window.API?.media?.reportObservedLanguages?.({ titleId, audio: [...codes], audioTracks: orderedTracks }).catch(() => { });
        } catch (_) { /* best-effort capture; never disrupt playback */ }
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
                ).catch(error => {
                    console.error('[WatchPage] Audio selection failed:', error);
                    this.handlePlaybackFailure('Failed to switch audio track.').catch(() => { });
                });
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
            this.clearPendingPreference('audio');
            this.updateAudioTracks();
            this.closeAudioMenu();
            this.saveResumeSnapshotThrottled(true);
            this.saveProgress({ force: true });
            return;
        }

        if (source === 'native') {
            const tracks = this.video.audioTracks;
            if (tracks && index >= 0 && index < tracks.length) {
                for (let i = 0; i < tracks.length; i++) {
                    tracks[i].enabled = i === index;
                }
            }
            this.clearPendingPreference('audio');
            this.updateAudioTracks();
            this.closeAudioMenu();
            this.saveResumeSnapshotThrottled(true);
            this.saveProgress({ force: true });
            return;
        }

        if (source !== 'probe' || !Number.isInteger(streamIndex)) {
            this.closeAudioMenu();
            return;
        }

        // Already playing this track via a zero-egress path (direct play or the
        // in-browser engine) — picking it again must NOT spin up a needless reload.
        if ((this.currentPlaybackMode === 'direct' || this.currentPlaybackMode === 'engine')
            && Number(streamIndex) === Number(this.directAudioStreamIndex)) {
            this.selectedAudioStreamIndex = streamIndex;
            this.selectedAudioTrackUserChoice = false;
            this.updateAudioTracks();
            this.closeAudioMenu();
            return;
        }

        const previous = Number(this.selectedAudioStreamIndex);
        this.selectedAudioStreamIndex = streamIndex;
        this.selectedAudioTrackUserChoice = true;
        this.clearPendingPreference('audio');
        this.updateAudioTracks();
        this.closeAudioMenu();
        this.saveResumeSnapshotThrottled(true);
        this.saveProgress({ force: true });

        if (previous === streamIndex && ['gateway-session', 'transcode-session'].includes(this.currentPlaybackMode)) {
            return;
        }

        await this.queueSelectedAudioTrackRestart();
    }

    queueSelectedAudioTrackRestart() {
        const requestId = ++this._audioSwitchRequestId;
        const run = (this._audioSwitchPromise || Promise.resolve())
            .catch(() => { })
            .then(() => {
                if (requestId !== this._audioSwitchRequestId) return false;
                return this.restartWithSelectedAudioTrack(requestId);
            });

        this._audioSwitchPromise = run.finally(() => {
            if (requestId === this._audioSwitchRequestId) {
                this._audioSwitchPromise = null;
            }
        });
        return this._audioSwitchPromise;
    }

    isStaleAudioSwitch(requestId) {
        return Number.isInteger(requestId) && requestId !== this._audioSwitchRequestId;
    }

    setSelectedAudioPreference(track) {
        const audio = this.audioPreferenceFromProbeTrack(track);
        if (!audio || !this.content) return null;

        return this.savePlaybackPreferences(this.getMergedPlaybackPreferences({ audio }));
    }

    getSelectedAudioPlaybackOptions() {
        if (!this.selectedAudioTrackUserChoice) return {};
        const selected = this.getSelectedAudioTrack();
        if (!selected) return {};
        return this.getAudioProcessingOptions({
            ...(this.currentStreamInfo || {}),
            audioTracks: this.audioTracks
        });
    }

    async restartWithSelectedAudioTrack(requestId = this._audioSwitchRequestId) {
        if (this.isStaleAudioSwitch(requestId)) return false;

        // In-browser engine: switch audio client-side (zero-egress), no gateway.
        if (this.currentPlaybackMode === 'engine') {
            return this.restartEngineWithSelectedAudioTrack(requestId);
        }

        if (this.isCloudPlaybackMode() && this.content?.sourceId && this.content?.id) {
            return this.restartCloudGatewayWithSelectedAudioTrack(requestId);
        }

        const sourceUrl = this.baseStreamUrl || this.currentUrl;
        const selected = this.getSelectedAudioTrack();
        if (!sourceUrl || !selected) return;

        const position = Math.max(0, this.getPlaybackPosition());
        const autoplay = !this.video?.paused;
        const info = this.currentStreamInfo || {};
        const playbackPreferences = this.setSelectedAudioPreference(selected);
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
        if (this.isStaleAudioSwitch(requestId)) return false;

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
        if (this.isStaleAudioSwitch(requestId)) {
            await this.stopTranscodeSession();
            return false;
        }
        this.playHlsOrDirect(playlistUrl, { autoplay });
        if (playbackPreferences) this.saveResumeSnapshotThrottled(true);
        this.setVolumeFromStorage();
        return true;
    }

    async restartCloudGatewayWithSelectedAudioTrack(requestId = this._audioSwitchRequestId) {
        const selected = this.getSelectedAudioTrack();
        if (!selected || !this.content?.sourceId || !this.content?.id) return false;

        const targetPosition = Math.max(0, Math.floor(this.getPlaybackPosition()) - 3);
        const preRoll = this.getGatewaySeekPreRoll(targetPosition, 0);
        const sessionStart = Math.max(0, targetPosition - preRoll);
        const localSeekTarget = Math.max(0, targetPosition - sessionStart);
        const autoplay = !this.video?.paused;
        const itemType = this.content.type === 'series' ? 'series' : 'movie';
        const container = this.containerExtension || this.content.containerExtension || 'mp4';
        const audioOptions = this.getAudioProcessingOptions({
            ...(this.currentStreamInfo || {}),
            audioTracks: this.audioTracks
        });
        const playbackPreferences = this.setSelectedAudioPreference(selected);
        const audioLabel = this.getTrackLabel(selected, 'Selected audio', 'audio');

        console.log(`[WatchPage] Restarting Gateway with audio track ${selected.index}: ${audioLabel}`);
        this.hidePlaybackError();
        this.showLoading();
        this.updateTranscodeStatus('transcoding', `Audio: ${audioLabel}`);
        this.trackPlaybackPosition({ position: targetPosition, force: true });
        this.saveResumeSnapshotThrottled(true);

        await this.releasePlaybackPipelineForRetry();
        if (this.isStaleAudioSwitch(requestId)) return false;
        await this.waitForProviderSlotRelease(300);
        if (this.isStaleAudioSwitch(requestId)) return false;

        const playbackHint = {
            ...(MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(this.content, { container, streamType: itemType })
                : { container, streamType: itemType }),
            ...audioOptions,
            seekOffset: sessionStart,
            startOffset: sessionStart,
            resumeTime: sessionStart
        };

        let result = null;
        let retryLevel = 0;
        try {
            result = await this.requestAudioSwitchGatewayUrl(itemType, container, playbackHint, requestId);
        } catch (error) {
            console.error('[WatchPage] Gateway audio switch failed:', error);
            if (this.isRangeSeekFailure(error?.message || error?.details || '')) {
                retryLevel = 1;
                const widerPreRoll = this.getGatewaySeekPreRoll(targetPosition, 75);
                const widerSessionStart = Math.max(0, targetPosition - widerPreRoll);
                playbackHint.seekOffset = widerSessionStart;
                playbackHint.startOffset = widerSessionStart;
                playbackHint.resumeTime = widerSessionStart;
                try {
                    result = await this.requestAudioSwitchGatewayUrl(itemType, container, playbackHint, requestId);
                } catch (retryError) {
                    console.error('[WatchPage] Gateway audio switch seek retry failed:', retryError);
                    await this.handlePlaybackFailure(retryError?.message || 'Failed to switch audio track.');
                    return false;
                }
            } else {
                await this.handlePlaybackFailure(error?.message || 'Failed to switch audio track.');
                return false;
            }
        }

        if (this.isStaleAudioSwitch(requestId)) {
            await this.cleanupStaleCloudPlaybackSession(result?.sessionId);
            return false;
        }

        if (!result?.url) {
            await this.handlePlaybackFailure('Failed to switch audio track.');
            return false;
        }

        this.content.cloudPlaybackSessionId = result.sessionId || null;
        this.resumeTime = targetPosition;
        const effectiveSessionStart = Number(playbackHint.seekOffset) || sessionStart;
        const effectiveLocalSeekTarget = Math.max(0, targetPosition - effectiveSessionStart);
        await this.loadVideo(result.url, this.playbackMetadataFromResult(result, {
            seekOffset: effectiveSessionStart,
            startOffset: effectiveSessionStart,
            playbackAttemptId: this._playbackAttemptId,
            cloudPlaybackSessionId: result.sessionId || null,
            playbackPreferences
        }));
        this._gatewaySeekRetry = {
            target: targetPosition,
            preRoll: Math.max(0, targetPosition - effectiveSessionStart),
            retryLevel,
            playbackAttemptId: this._playbackAttemptId,
            audioSwitchRequestId: requestId
        };
        this.queuePendingLocalSeek(effectiveLocalSeekTarget);

        if (autoplay) {
            this.video?.play?.().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Gateway audio switch play error:', e);
            });
        } else {
            this.video?.pause?.();
        }
        this.setVolumeFromStorage();
        return true;
    }

    async waitForProviderSlotRelease(delay = 1400) {
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    getAudioSwitchRetryDelay(error) {
        const message = [
            error?.message,
            error?.details,
            error?.status,
            error?.code
        ].filter(Boolean).join(' ');

        if (this.isConnectionLimitError(message)) return 2200;
        if (/502|503|504|UPSTREAM_UNAVAILABLE|ECONNRESET|ETIMEDOUT|timeout|NetworkError|Failed to fetch/i.test(message)) {
            return 1400;
        }
        return 900;
    }

    async requestAudioSwitchGatewayUrl(itemType, container, playbackHint, requestId) {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (this.isStaleAudioSwitch(requestId)) return null;
            try {
                return await API.proxy.xtream.getStreamUrl(
                    this.content.sourceId,
                    this.content.id,
                    itemType,
                    container,
                    playbackHint
                );
            } catch (error) {
                lastError = error;
                if (attempt === 0) {
                    const retryDelay = this.getAudioSwitchRetryDelay(error);
                    console.warn(`[WatchPage] Audio switch session failed, retrying after ${retryDelay}ms provider cooldown:`, error?.message || error);
                    await this.waitForProviderSlotRelease(retryDelay);
                    continue;
                }
            }
        }
        throw lastError || new Error('Failed to switch audio track.');
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
            nld: 'nl',
            ara: 'ar',
            rus: 'ru',
            tur: 'tr',
            pol: 'pl',
            hin: 'hi',
            jpn: 'ja',
            kor: 'ko',
            zho: 'zh',
            chi: 'zh'
        };
        return aliases[normalized] || normalized || 'und';
    }

    inferSubtitleLanguageFromText(text) {
        const sample = String(text || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[{}][^}]*[}]/g, ' ')
            .toLowerCase();
        if (sample.length < 40) return null;

        if (/[\u0600-\u06ff]/.test(sample)) return 'ar';

        const scores = {
            fr: 0,
            en: 0,
            es: 0
        };

        const countMatches = (patterns) => patterns.reduce((score, pattern) => score + (sample.match(pattern) || []).length, 0);
        scores.fr += countMatches([
            /\b(le|la|les|des|une|un|que|qui|vous|nous|dans|pour|pas|est|avec|sur|mais|alors|cette|comme)\b/g,
            /\b(c'est|j'ai|d'accord|qu'il|qu'elle|n'est|voil[aà])\b/g,
            /[àâçéèêëîïôûùüÿœ]/g
        ]);
        scores.en += countMatches([
            /\b(the|and|you|that|this|with|for|not|are|have|what|will|from|they|your|about)\b/g,
            /\b(don't|can't|it's|i'm|you're|we're|that's)\b/g
        ]);
        scores.es += countMatches([
            /\b(el|la|los|las|una|uno|que|con|para|por|pero|como|esta|este|usted|nosotros)\b/g,
            /[áéíñóúü]/g
        ]);

        const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
        return winner && winner[1] >= 3 ? winner[0] : null;
    }

    maybeInferSubtitleLanguage(engine, text) {
        if (!engine?.trackMeta) return false;

        const currentLanguage = this.normalizeTrackLanguage(engine.trackMeta.inferredLanguage || engine.trackMeta.language);
        if (currentLanguage && currentLanguage !== 'und') return false;

        engine.languageSample = `${engine.languageSample || ''}\n${text || ''}`.slice(-5000);
        const inferred = this.inferSubtitleLanguageFromText(engine.languageSample);
        if (!inferred) return false;

        engine.trackMeta.inferredLanguage = inferred;
        if (engine.trackEl) {
            const subtitleTracks = this.getExtractableSubtitleTracks();
            engine.trackEl.label = this.getSubtitleMenuLabel(engine.trackMeta, subtitleTracks, subtitleTracks.indexOf(engine.trackMeta), 'Subtitles');
            engine.trackEl.srclang = inferred;
        }
        return true;
    }

    getSubtitleOffsetStorageKey(streamIndex = this.selectedSubtitleStreamIndex) {
        const sourceId = this.getTelemetrySourceId?.() || this.content?.sourceId || this.content?.source_id || 'local';
        const itemId = this.getTelemetryItemId?.() || this.content?.id || this.content?.stream_id || 'unknown';
        const trackId = streamIndex === null || streamIndex === undefined ? 'default' : String(streamIndex);
        return `norva-subtitle-offset:${sourceId}:${itemId}:${trackId}`;
    }

    normalizeSubtitleOffset(value) {
        const seconds = Number(value);
        if (!Number.isFinite(seconds)) return 0;
        return Math.max(-15, Math.min(15, Math.round(seconds * 10) / 10));
    }

    loadSubtitleOffset(streamIndex) {
        try {
            return this.normalizeSubtitleOffset(localStorage.getItem(this.getSubtitleOffsetStorageKey(streamIndex)));
        } catch (_) {
            return 0;
        }
    }

    saveSubtitleOffset(streamIndex, value) {
        try {
            const key = this.getSubtitleOffsetStorageKey(streamIndex);
            const normalized = this.normalizeSubtitleOffset(value);
            if (normalized === 0) localStorage.removeItem(key);
            else localStorage.setItem(key, String(normalized));
        } catch (_) {
            // Offset persistence is a convenience only.
        }
    }

    formatSubtitleOffset(seconds = this.subtitleOffsetSeconds) {
        const value = this.normalizeSubtitleOffset(seconds);
        if (value === 0) return '0.0s';
        return `${value > 0 ? '+' : ''}${value.toFixed(1)}s`;
    }

    applySubtitleOffsetDelta(delta) {
        if (this.selectedSubtitleStreamIndex === null || this.selectedSubtitleStreamIndex === undefined) return;

        const next = this.normalizeSubtitleOffset(this.subtitleOffsetSeconds + delta);
        this.subtitleOffsetSeconds = next;
        this.saveSubtitleOffset(this.selectedSubtitleStreamIndex, next);
        this.attachSelectedProbeSubtitleTrack();
        this.updateCaptionsTracks();
        this.saveResumeSnapshotThrottled(true);
        this.saveProgress({ force: true });
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
        let inferredLanguage = false;
        const subtitleOffset = this.normalizeSubtitleOffset(engine.subtitleOffsetSeconds || 0);
        for (const cue of this.parseVttCues(text)) {
            const start = Math.max(0, cue.start + timeOffset + subtitleOffset);
            const end = Math.max(start + 0.05, cue.end + timeOffset + subtitleOffset);
            const key = `${start.toFixed(3)}|${end.toFixed(3)}|${cue.text}`;
            if (engine.seenCues.has(key)) continue;
            engine.seenCues.add(key);
            try {
                textTrack.addCue(new VTTCue(start, end, cue.text));
                inferredLanguage = this.maybeInferSubtitleLanguage(engine, cue.text) || inferredLanguage;
                added++;
            } catch (e) { /* malformed cue, skip */ }
        }
        if (inferredLanguage) this.updateCaptionsTracks();
        return added;
    }

    // Gateway subtitle endpoint base for the engine (byte-pipe) path: the playback URL
    // is https://host/raw/<token>, and the same token authorizes https://host/subtitle/<token>.
    engineSubtitleBaseUrl() {
        const url = this.baseStreamUrl || this.currentUrl;
        const m = /^(https?:\/\/[^/]+)\/raw\/(.+)$/.exec(String(url || ''));
        return m ? `${m[1]}/subtitle/${m[2]}` : '';
    }

    // Feature flag for engine in-band subtitles (ships dark). Enable in the browser with
    // localStorage.setItem('norvaInbandSubs','1'). Lets text subtitles render on single-slot
    // sources where the gateway extraction (a 2nd provider connection) is refused (458).
    _inbandSubsEnabled() {
        try { return localStorage.getItem('norvaInbandSubs') === '1'; } catch (_) { return false; }
    }

    // In-band engine subtitles: pull the cues the engine built from its demuxed packets
    // (already in player-local time) and append the unseen ones to the TextTrack. No network,
    // no provider connection. Polled while the track is selected.
    subtitleEngineInbandTick(engine) {
        if (engine !== this._subEngine || !engine.trackEl?.track) return;
        const cues = this.norvaEngine?.getSubtitleCues?.(engine.streamIndex) || [];
        if (!cues.length) return;
        const textTrack = engine.trackEl.track;
        const off = this.normalizeSubtitleOffset(engine.subtitleOffsetSeconds || 0);
        let added = 0;
        let inferredLanguage = false;
        for (const c of cues) {
            if (!c || !c.text) continue;
            const start = Math.max(0, c.start + off);
            const end = Math.max(start + 0.05, c.end + off);
            const key = `${start.toFixed(3)}|${end.toFixed(3)}|${c.text}`;
            if (engine.seenCues.has(key)) continue;
            engine.seenCues.add(key);
            try {
                textTrack.addCue(new VTTCue(start, end, c.text));
                inferredLanguage = this.maybeInferSubtitleLanguage(engine, c.text) || inferredLanguage;
                added++;
            } catch (_) { /* malformed cue, skip */ }
        }
        if (added || inferredLanguage) this.updateCaptionsTracks();
    }

    // Engine path: apply the subtitle tracks the SERVER probed (relay header-parse,
    // returned in the playback payload). Known at LOAD, so the CC menu lists them and
    // the saved subtitle preference is restored — the bug where the chosen track came
    // back as OFF (because the lazy client enum populated the list too late to restore).
    // Enumeration is provider-free (payload data). The restore-ATTACH extracts via the
    // gateway (a 2nd provider connection), so it's DEFERRED past initial buffering to
    // avoid the single-connection contention crash. Returns true when tracks applied.
    applyEngineSubtitleTracks(tracks, playbackAttemptId) {
        if (!Array.isArray(tracks) || !tracks.length) return false;
        const mapped = tracks
            .filter((s) => Number.isInteger(Number(s.index)))
            .map((s) => ({
                index: Number(s.index),
                language: s.language || s.lang || null,
                title: s.title || null,
                codec: s.codec || null,
                subtitleType: s.subtitleType || (s.extractable ? 'text' : 'image'),
                extractable: s.extractable === true,
                forced: s.forced === true,
                default: s.default === true,
            }));
        if (!mapped.length) return false;
        this.subtitleTracks = mapped;
        this.subtitleSourceUrl = this.baseStreamUrl || this.currentUrl;
        this.subtitleStartOffset = 0;
        this._engineSubsEnriched = true; // server-provided → skip the client gateway probe
        this.updateCaptionsTracks();
        // Restore the saved choice now that the list is known. Mark the selection
        // immediately (menu shows it), but defer the extraction-attach until the stream
        // is stable (buffer built) so the gateway extraction doesn't fight initial buffering.
        let restored = false;
        try { restored = this.restorePendingSubtitlePreference(); } catch (_) { /* best-effort */ }
        if (restored && this.selectedSubtitleStreamIndex !== null) {
            this.updateCaptionsTracks();
            const targetIndex = this.selectedSubtitleStreamIndex;
            setTimeout(() => {
                if (this.isStalePlaybackAttempt(playbackAttemptId)) return;
                if (this.selectedSubtitleStreamIndex !== targetIndex) return; // user changed it meanwhile
                try { this.attachSelectedProbeSubtitleTrack(); } catch (_) { /* best-effort */ }
            }, 5000);
        }
        return true;
    }

    // Engine path: the engine demuxes subtitle streams but can't render them. Ask the
    // gateway (it has ffmpeg/ffprobe) to enumerate the container's subtitle tracks
    // (index, language, codec) so the CC menu lists them. Extraction is on selection.
    // Best-effort + non-blocking; no-op when the file has no subtitle streams.
    async enrichEngineSubtitleTracks() {
        // Run at most once per playback (and never two in flight). A transient gateway
        // failure leaves _engineSubsEnriched false so the next menu-open retries.
        if (this._engineSubsEnriched || this._engineSubsEnriching) return;
        try {
            const engine = this.norvaEngine;
            if (!engine || typeof engine.subtitleStreams !== 'function') return;
            // The gateway ffprobe returns BOTH the subtitle tracks AND robust audio-track
            // languages. A multi-audio file with NO embedded subtitles still needs that
            // audio fallback — otherwise its menu is stuck on "Audio 1/2/3" every time the
            // relay probe was refused (e.g. a single-slot provider that 458s the second
            // connection). So don't bail on "no subtitles" alone: also run when there are
            // ≥2 audio streams whose languages we don't yet know. One success persists via
            // reportObservedAudioLanguages, so the next play of this title needs zero probe.
            const subCount = engine.subtitleStreams().length;
            const audioCount = typeof engine.audioStreamIndices === 'function' ? engine.audioStreamIndices().length : 0;
            const audioLangKnown = Array.isArray(this._relayAudioTracks)
                && this._relayAudioTracks.some((t) => t.lang && t.lang !== 'und');
            if (!subCount && !(audioCount >= 2 && !audioLangKnown)) { this._engineSubsEnriched = true; return; } // nothing to enrich → don't retry
            const base = this.engineSubtitleBaseUrl();
            if (!base) return;
            this._engineSubsEnriching = true;
            const attempt = this._playbackAttemptId;
            const data = await fetch(base, { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null)).catch(() => null);
            this._engineSubsEnriching = false;
            if (!data || this.isStalePlaybackAttempt(attempt)) return; // failure → allow retry on next open
            this._engineSubsEnriched = true;
            // Audio fallback: the gateway's ffprobe reads audio languages robustly. When
            // the relay/server probe couldn't name the audio (some MKV files leave it
            // untagged-by-our-parser), use the gateway's languages and re-sync the audio
            // menu — e.g. a VOSTFR file's lone Japanese track now shows "Japanese".
            const gwAudio = (Array.isArray(data.audioTracks) ? data.audioTracks : [])
                .filter((a) => Number.isInteger(Number(a.index)) && a.language)
                .map((a) => ({ index: Number(a.index), lang: this.normalizeTrackLanguage(a.language) }))
                .filter((a) => a.lang && a.lang !== 'und');
            const relayHasLang = Array.isArray(this._relayAudioTracks)
                && this._relayAudioTracks.some((t) => t.lang && t.lang !== 'und');
            if (gwAudio.length && !relayHasLang) {
                this._relayAudioTracks = gwAudio;
                try { this.syncEngineAudioTracks(); } catch (_) { /* best-effort */ }
                // Self-heal: persist the gateway-discovered languages now so the next play
                // of this title is served the map and needs no probe at all (deterministic).
                try { this.reportObservedAudioLanguages(); } catch (_) { /* best-effort capture */ }
            }
            const tracks = (Array.isArray(data.subtitles) ? data.subtitles : [])
                .filter((s) => Number.isInteger(Number(s.index)))
                .map((s) => ({
                    index: Number(s.index),
                    language: s.language || null,
                    title: s.title || null,
                    codec: s.codec || null,
                    subtitleType: s.subtitleType || (s.extractable ? 'text' : 'image'),
                    extractable: s.extractable === true,
                    forced: s.forced === true,
                    default: s.default === true,
                }));
            if (!tracks.length) return;
            this.subtitleTracks = tracks;
            // Windowed extraction reads from the engine /raw URL → gateway /subtitle.
            this.subtitleSourceUrl = this.baseStreamUrl || this.currentUrl;
            this.subtitleStartOffset = 0;
            this.updateCaptionsTracks();
        } catch (_) {
            this._engineSubsEnriching = false; // best-effort; allow a later retry
        }
    }

    /**
     * Session mode: poll the growing in-process .vtt for new cues.
     */
    gatewaySubtitleUrlForTrack(streamIndex) {
        const sourceUrl = this.subtitleSourceUrl || this.baseStreamUrl || this.currentUrl;
        if (!sourceUrl) return '';

        try {
            const url = new URL(sourceUrl, window.location.href);
            if (!this.isGatewayPlaybackUrl(url.href)) return '';
            url.pathname = url.pathname.replace(/\/playlist\.m3u8$/i, `/sub_${streamIndex}.vtt`);
            return url.toString();
        } catch (_) {
            return '';
        }
    }

    async subtitleSessionTick(engine) {
        if (engine !== this._subEngine) return;
        if (engine.done || engine.busy) return;
        engine.busy = true;

        // If-None-Match + size-based ETag: ticks are sub-second so a freshly
        // demuxed cue lands before its startTime, but unchanged files cost a
        // cheap local 304 instead of a full re-download + re-parse.
        const url = engine.mode === 'gateway-session'
            ? engine.gatewaySubtitleUrl
            : `/api/transcode/${engine.sessionId}/sub_${engine.streamIndex}.vtt`;
        if (!url) {
            engine.done = true;
            engine.busy = false;
            return;
        }
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
        if ((engine.failures || 0) >= 30) engine.done = true;
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
        // Engine (byte-pipe) path: the player re-bases its clock to start at currentTime 0
        // by subtracting the file's first-frame PTS, but this extractor reads the SOURCE by
        // absolute time. Re-derive the source offset from the engine on every tick (it is
        // the first-frame PTS on a fresh play and converges to 0 after a seek) so cues line
        // up with the picture from 00:00 on files whose stream doesn't start at 0. No-op
        // (offset 0) for files that already start at 0, so existing-good playback is unchanged.
        if (this.currentPlaybackMode === 'engine' && typeof this.norvaEngine?.subtitleSourceOffset === 'function') {
            this.subtitleStartOffset = this.norvaEngine.subtitleSourceOffset();
        }
        const absStart = (this.normalizeDuration(this.subtitleStartOffset) || 0) + windowStartLocal;

        // Engine path → the gateway /subtitle endpoint (same token as /raw); other
        // paths → the local /api/subtitle extractor. Both take index/start and window
        // duration and return rebased WebVTT, so the cue handling below is identical.
        let extractUrl;
        if (engine.gatewayWindowBase) {
            const gp = new URLSearchParams({ index: String(engine.streamIndex), dur: String(WINDOW) });
            if (absStart > 0) gp.set('start', String(absStart));
            extractUrl = `${engine.gatewayWindowBase}?${gp.toString()}`;
        } else {
            const params = new URLSearchParams({
                url: engine.sourceUrl,
                index: String(engine.streamIndex),
                codec: String(engine.codec || ''),
                duration: String(WINDOW)
            });
            if (absStart > 0) params.set('start', String(absStart));
            extractUrl = `/api/subtitle?${params.toString()}`;
        }

        const added = await this.fetchSubtitleCues(engine, extractUrl, windowStartLocal ? windowStartLocal : 0);
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
        const subtitleTracks = this.getExtractableSubtitleTracks();
        trackEl.label = this.getSubtitleMenuLabel(selected, subtitleTracks, subtitleTracks.indexOf(selected), 'Subtitles');
        trackEl.srclang = this.normalizeTrackLanguage(selected.language);
        trackEl.dataset.norvaProbeSubtitle = 'true';
        trackEl.dataset.streamIndex = String(selected.index);
        this.video.appendChild(trackEl);
        if (trackEl.track) trackEl.track.mode = 'showing';

        const isLocalSessionMode = this.currentPlaybackMode === 'transcode-session';
        const gatewaySubtitleUrl = this.currentPlaybackMode === 'gateway-session'
            ? this.gatewaySubtitleUrlForTrack(selected.index)
            : '';
        // Engine (byte-pipe) path: windowed extraction, but from the gateway /subtitle
        // endpoint instead of the local /api/subtitle (which doesn't exist on the cloud).
        const gatewayWindowBase = this.currentPlaybackMode === 'engine' ? this.engineSubtitleBaseUrl() : '';
        // In-band engine subtitles (no provider connection): when the byte-pipe engine can
        // turn its own demuxed text-subtitle packets into cues, prefer that over the gateway
        // extraction — a 2nd provider connection that 458s on a single-slot source, so the
        // chosen track silently shows nothing. Flag-gated (localStorage.norvaInbandSubs='1').
        const useInbandSubs = this.currentPlaybackMode === 'engine'
            && this._inbandSubsEnabled()
            && typeof this.norvaEngine?.hasInbandSubtitles === 'function'
            && this.norvaEngine.hasInbandSubtitles()
            && this.isSubtitleExtractable(selected);
        const isSessionMode = isLocalSessionMode || Boolean(gatewaySubtitleUrl);
        const engine = {
            trackEl,
            trackMeta: selected,
            streamIndex: selected.index,
            codec: selected.codec,
            seenCues: new Set(),
            subtitleOffsetSeconds: this.subtitleOffsetSeconds,
            mode: isLocalSessionMode ? 'session' : (gatewaySubtitleUrl ? 'gateway-session' : 'window'),
            sessionId: this.currentSessionId,
            gatewaySubtitleUrl,
            gatewayWindowBase,
            sourceUrl: this.subtitleSourceUrl || this.baseStreamUrl || this.currentUrl,
            failures: 0
        };
        this._subEngine = engine;

        if (useInbandSubs) {
            // No network: the engine decodes cues from packets it already demuxed.
            engine.mode = 'engine-inband';
            try { this.norvaEngine.enableSubtitleCapture(); } catch (_) { /* best-effort */ }
            this.subtitleEngineInbandTick(engine);
            this._subEngineTimer = setInterval(() => this.subtitleEngineInbandTick(engine), 1000);
        } else if (isSessionMode && (this.currentSessionId || gatewaySubtitleUrl)) {
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
        this.restorePendingSubtitlePreference();

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
            // Engine path: enumerate subtitle tracks lazily (see toggleAudioMenu) so
            // the gateway probe never races the engine's initial buffering. Runs once.
            if (this.currentPlaybackMode === 'engine') this.enrichEngineSubtitleTracks();
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

    // Local heuristic (no network): IPTV titles tag burned-in subtitles in the
    // name — "SUBT AR" / "VOST FR" / "مترجم" … There is no extractable subtitle
    // TRACK (the text is rendered into the picture), but we can at least tell the
    // user it's there and in which language, instead of a blank "no track".
    // Returns a language code, 'und' (burned but unknown language), or undefined
    // (no burned-subtitle marker found).
    contentCategoryName() {
        const c = this.content || {};
        return String(c.category_name || c.categoryName || c.metadata?.categoryName || c.metadata?.category_name || '');
    }

    // Burned-in subtitle intel from the cheap label+category intelligence
    // (MediaUtils.deriveTrackIntel). The container has NO subtitle TRACK (the text is
    // baked into the picture) so we pass hasSubtitleStream:false; a subtitle language
    // signalled by the label/category then resolves to type 'burned-in'.
    // Returns { code, name } | null.
    burnedSubtitleIntel() {
        try {
            const r = window.MediaUtils?.deriveTrackIntel?.({
                title: this.content?.title || '',
                category: this.contentCategoryName(),
                originalLanguage: this.content?.originalLanguage || this.content?.original_language,
                hasSubtitleStream: false,
            });
            const s = r && r.subtitle;
            if (s && s.type === 'burned-in') return { code: s.code || 'und', name: s.name || null };
            return null;
        } catch (_) {
            return null;
        }
    }

    // Back-compat: language code, 'und' (burned but unknown), or undefined (none).
    detectBurnedSubtitleLanguage() {
        const intel = this.burnedSubtitleIntel();
        if (!intel) return undefined;
        return intel.code || 'und';
    }

    getBurnedSubtitleMessage() {
        const lang = this.detectBurnedSubtitleLanguage();
        if (lang === undefined) return 'No subtitle track in this stream.';
        if (lang === 'und') return 'Burned-in subtitles — always on, can’t be turned off.';
        const name = this.getLanguageDisplayName(lang) || lang.toUpperCase();
        return `Burned-in subtitles (${name}) — always on, can’t be turned off.`;
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
                    label: this.getSubtitleMenuLabel(track, probeSubtitleTracks, index, probeSubtitleTracks.length > 1 ? `Subtitles ${index + 1}` : 'Subtitles'),
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

        // No selectable subtitle TRACK, but the label/category says the picture carries
        // burned-in subtitles → show them as a locked, always-on entry instead of "Off".
        const burned = !options.length ? this.burnedSubtitleIntel() : null;
        const offActive = !anyActive && !burned;
        const optionHtml = options.map(track => {
            const streamAttr = track.streamIndex !== undefined ? ` data-stream-index="${track.streamIndex}"` : '';
            return `<button class="captions-option ${track.active ? 'active' : ''}" data-source="${track.source}" data-index="${track.index}"${streamAttr}>${this.escapeHtml(track.label)}</button>`;
        }).join('');
        // Burned-in: the off-row becomes a locked entry (can't be turned off); otherwise
        // the usual "Off" + "no track / burned message" applies.
        const headerHtml = burned
            ? `<button class="captions-option active locked" data-source="burned" data-index="-1" disabled aria-disabled="true" title="Burned into the picture — always on">🔒 ${this.escapeHtml(burned.name ? `${burned.name} — burned-in` : 'Burned-in subtitles')}</button>`
            : `<button class="captions-option ${offActive ? 'active' : ''}" data-source="off" data-index="-1">Off</button>`;
        const emptyHtml = burned
            ? `<div class="captions-empty">${this.escapeHtml('Always on — subtitles are part of the picture, they can’t be turned off.')}</div>`
            : (!options.length
                ? `<div class="captions-empty">${this.escapeHtml(this.getBurnedSubtitleMessage())}</div>`
                : '');
        const offsetHtml = this.selectedSubtitleStreamIndex !== null && this.selectedSubtitleStreamIndex !== undefined && probeSubtitleTracks.length
            ? `<div class="captions-offset" aria-label="Subtitle sync">
                <div class="captions-offset-label">Sync ${this.escapeHtml(this.formatSubtitleOffset())}</div>
                <div class="captions-offset-controls">
                  <button type="button" class="captions-offset-btn" data-offset-delta="-0.5">-0.5s</button>
                  <button type="button" class="captions-offset-btn" data-offset-delta="0.5">+0.5s</button>
                </div>
              </div>`
            : '';

        this.captionsList.innerHTML = `${headerHtml}${optionHtml}${emptyHtml}${offsetHtml}`;

        this.captionsList.querySelectorAll('.captions-option').forEach(btn => {
            btn.addEventListener('click', () => this.selectCaptionTrack(
                btn.dataset.source,
                parseInt(btn.dataset.index, 10),
                btn.dataset.streamIndex !== undefined ? parseInt(btn.dataset.streamIndex, 10) : null
            ));
        });

        this.captionsList.querySelectorAll('.captions-offset-btn').forEach(btn => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.applySubtitleOffsetDelta(Number(btn.dataset.offsetDelta) || 0);
            });
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
            this.subtitleOffsetSeconds = 0;
            this.selectedSubtitleTrackUserChoice = true;
            this.clearExternalSubtitleTracks();
        } else if (source === 'probe' && Number.isInteger(streamIndex)) {
            this.selectedSubtitleStreamIndex = streamIndex;
            this.subtitleOffsetSeconds = this.loadSubtitleOffset(streamIndex);
            this.selectedSubtitleTrackUserChoice = true;
            this.attachSelectedProbeSubtitleTrack();
        } else if (source === 'native' && index >= 0 && index < tracks.length) {
            this.selectedSubtitleStreamIndex = null;
            this.subtitleOffsetSeconds = 0;
            this.selectedSubtitleTrackUserChoice = true;
            tracks[index].mode = 'showing';
        } else if (source === 'hls' && this.hls && index >= 0) {
            this.selectedSubtitleStreamIndex = null;
            this.subtitleOffsetSeconds = 0;
            this.selectedSubtitleTrackUserChoice = true;
            this.hls.subtitleDisplay = true;
            this.hls.subtitleTrack = index;
        }

        this.clearPendingPreference('subtitle');
        this.savePlaybackPreferences(this.getMergedPlaybackPreferences());
        this.updateCaptionsTracks();
        this.closeCaptionsMenu();
        this.saveResumeSnapshotThrottled(true);
        this.saveProgress({ force: true });
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
        const fallback = isChannel ? '/img/placeholder.png' : '/img/norva-media-placeholder.png';

        this.posterEl.onerror = () => {
            this.posterEl.onerror = null;
            this.posterEl.src = fallback;
        };
        this.posterEl.src = MediaUtils.safeImageUrl(this.content.poster, fallback);
        this.posterEl.alt = this.content.title || '';
        this.contentTitleEl.textContent = this.content.title || '';
        this.yearEl.textContent = this.content.year || '';
        this.ratingEl.textContent = this.content.rating ? `★ ${this.content.rating}` : '';
        this.descriptionEl.textContent = this.content.description || '';

        // Update play button text
        if (this.playBtnText) {
            this.playBtnText.textContent = this.resumeTime > 0 ? 'Resume' : 'Play';
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
                <img src="${MediaUtils.escapeHtml(MediaUtils.safeImageUrl(movie.stream_icon || movie.cover, '/img/norva-media-placeholder.png'))}"
                     alt="${MediaUtils.escapeHtml(movie.name)}"
                     onerror="this.onerror=null;this.src='/img/norva-media-placeholder.png'" loading="lazy">
                <p>${MediaUtils.escapeHtml(movie.name)}</p>
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
            const result = await API.proxy.xtream.getStreamUrl(
                sourceId,
                streamId,
                'movie',
                container,
                MediaUtils.playbackHintFromItem ? MediaUtils.playbackHintFromItem(movie, { container, streamType: 'movie' }) : { container, streamType: 'movie' }
            );

            if (result?.url) {
                this.play({
                    type: 'movie',
                    id: movie.stream_id,
                    title: movie.name,
                    poster: MediaUtils.safeImageUrl(movie.stream_icon || movie.cover),
                    description: movie.plot || '',
                    year: movie.year,
                    rating: movie.rating,
                    sourceId: sourceId,
                    categoryId: movie.category_id,
                    cloudPlaybackSessionId: result.sessionId
                }, result.url, result);
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

    findEpisodeById(episodeId) {
        if (!this.seriesInfo?.episodes) return null;
        for (const episodes of Object.values(this.seriesInfo.episodes)) {
            const found = Array.isArray(episodes)
                ? episodes.find(ep => String(ep.id) === String(episodeId))
                : null;
            if (found) return found;
        }
        return null;
    }

    async playEpisodeFromList(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const seasonNum = episodeEl.dataset.season;
        const episodeNum = episodeEl.dataset.episode;
        const container = episodeEl.dataset.container || 'mp4';
        const episode = this.findEpisodeById(episodeId) || {
            id: episodeId,
            container_extension: container,
            type: 'episode',
            streamType: 'series'
        };

        try {
            await this.releasePlaybackPipelineForRetry();
            const playbackPreferences = this.getPlaybackPreferences();
            const playbackHint = MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(episode, { container, streamType: 'series' })
                : { container, streamType: 'series' };
            const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
            if (Number.isInteger(audioStreamIndex)) {
                playbackHint.audioStreamIndex = audioStreamIndex;
            }
            const result = await API.proxy.xtream.getStreamUrl(
                this.content.sourceId,
                episodeId,
                'series',
                container,
                playbackHint
            );

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
                    containerExtension: container,
                    playbackPreferences,
                    cloudPlaybackSessionId: result.sessionId
                }, result.url, result);
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

    getPreviousEpisode() {
        if (!this.seriesInfo?.episodes || !this.currentSeason || !this.currentEpisode) return null;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));
        const currentSeasonEpisodes = this.seriesInfo.episodes[this.currentSeason] || [];

        const currentEpIndex = currentSeasonEpisodes.findIndex(ep =>
            parseInt(ep.episode_num) === parseInt(this.currentEpisode)
        );

        // Previous episode in the current season.
        if (currentEpIndex > 0) {
            return {
                ...currentSeasonEpisodes[currentEpIndex - 1],
                seasonNum: this.currentSeason
            };
        }

        // Else the last episode of the previous season.
        const currentSeasonIndex = seasons.indexOf(String(this.currentSeason));
        if (currentSeasonIndex > 0) {
            const prevSeason = seasons[currentSeasonIndex - 1];
            const prevSeasonEpisodes = this.seriesInfo.episodes[prevSeason];
            if (prevSeasonEpisodes?.length > 0) {
                return {
                    ...prevSeasonEpisodes[prevSeasonEpisodes.length - 1],
                    seasonNum: prevSeason
                };
            }
        }

        return null;
    }

    sanitizeNextEpisodeForHistory(nextEp) {
        if (!nextEp) return null;
        return {
            id: nextEp.id || null,
            season: nextEp.seasonNum || null,
            episode: nextEp.episode_num || null,
            title: nextEp.title || null,
            containerExtension: nextEp.container_extension || 'mp4',
            duration: nextEp.duration || null
        };
    }

    showNextEpisodePanel(nextEp, options = {}) {
        if (!this.nextEpisodePanel) return;

        const autoCountdown = options.autoCountdown !== false;
        this.nextEpisodeTitle.textContent = `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`;
        this.nextEpisodePanel.classList.remove('hidden');
        this.nextEpisodePanel.nextEpisodeData = nextEp;

        this.nextEpisodeCountdown = 10;
        if (this.nextCountdown) {
            this.nextCountdown.textContent = autoCountdown ? this.nextEpisodeCountdown : '';
        }
        if (!autoCountdown) return;

        this.nextEpisodeInterval = setInterval(() => {
            this.nextEpisodeCountdown--;
            this.nextCountdown.textContent = this.nextEpisodeCountdown;

            if (this.nextEpisodeCountdown <= 0) {
                this.playNextEpisode();
            }
        }, 1000);
    }

    async playNextEpisode() {
        // From the end-of-episode panel if present, else resolve live (the
        // persistent "next" button). cancel clears the panel data, so read first.
        const nextEp = this.nextEpisodePanel?.nextEpisodeData || this.getNextEpisode();
        this.cancelNextEpisode();
        this.closeEpisodesMenu();
        await this.playEpisode(nextEp);
    }

    async playPreviousEpisode() {
        this.closeEpisodesMenu();
        await this.playEpisode(this.getPreviousEpisode());
    }

    // Shared episode launcher — resolve the stream for an episode object and play
    // it. Used by the autoplay panel, the prev/next buttons and the selector.
    async playEpisode(ep) {
        if (!ep) return;
        try {
            const container = ep.container_extension || 'mp4';
            const playbackPreferences = this.getPlaybackPreferences();
            const playbackHint = MediaUtils.playbackHintFromItem
                ? MediaUtils.playbackHintFromItem(ep, { container, streamType: 'series' })
                : { container, streamType: 'series' };
            const audioStreamIndex = Number(playbackPreferences?.audio?.streamIndex ?? playbackPreferences?.audio?.stream_index);
            if (Number.isInteger(audioStreamIndex)) {
                playbackHint.audioStreamIndex = audioStreamIndex;
            }
            const result = await API.proxy.xtream.getStreamUrl(
                this.content.sourceId,
                ep.id,
                'series',
                container,
                playbackHint
            );

            if (result?.url) {
                this.play({
                    type: 'series',
                    id: ep.id,
                    title: this.content.title,
                    subtitle: `S${ep.seasonNum} E${ep.episode_num} - ${ep.title || `Episode ${ep.episode_num}`}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: ep.seasonNum,
                    currentEpisode: ep.episode_num,
                    containerExtension: container,
                    playbackPreferences,
                    cloudPlaybackSessionId: result.sessionId
                }, result.url, result);
            } else {
                this.showPlaybackError('This episode could not be started. Please try again.', { immediate: true });
            }
        } catch (e) {
            console.error('Error playing episode:', e);
            this.showPlaybackError('This episode could not be started. Please try again.', { immediate: true });
        }
    }

    // Restart the current movie/episode from 0 (works for all VOD).
    restartFromStart() {
        try { Promise.resolve(this.seekToTime(0, { immediate: true })).catch(() => {}); } catch (_) {}
        try { this.video?.play?.().catch(() => {}); } catch (_) {}
        this.showOverlay();
    }

    // ---- Playback speed ---------------------------------------------------
    setPlaybackRate(rate) {
        const r = Number(rate) || 1;
        this._playbackRate = r;
        if (this.video) { try { this.video.playbackRate = r; } catch (_) {} }
        this.speedList?.querySelectorAll('.speed-option').forEach((o) =>
            o.classList.toggle('active', Math.abs(parseFloat(o.dataset.rate) - r) < 0.001));
        this.closeSpeedMenu();
    }

    toggleSpeedMenu() { this.speedMenuOpen ? this.closeSpeedMenu() : this.openSpeedMenu(); }
    openSpeedMenu() {
        this.closeOtherMenus('speed');
        this.speedMenu?.classList.remove('hidden');
        this.speedMenuOpen = true;
    }
    closeSpeedMenu() { this.speedMenu?.classList.add('hidden'); this.speedMenuOpen = false; }

    // ---- In-player episodes selector --------------------------------------
    toggleEpisodesMenu() { this.episodesMenuOpen ? this.closeEpisodesMenu() : this.openEpisodesMenu(); }
    openEpisodesMenu() {
        this.renderEpisodesMenu();
        this.closeOtherMenus('episodes');
        this.episodesNavMenu?.classList.remove('hidden');
        this.episodesMenuOpen = true;
    }
    closeEpisodesMenu() { this.episodesNavMenu?.classList.add('hidden'); this.episodesMenuOpen = false; }

    renderEpisodesMenu() {
        if (!this.episodesNavList) return;
        const eps = this.seriesInfo?.episodes;
        if (!eps) { this.episodesNavList.innerHTML = '<div class="captions-menu-empty">No episodes</div>'; return; }
        const seasons = Object.keys(eps).sort((a, b) => parseInt(a) - parseInt(b));
        const esc = (s) => MediaUtils.escapeHtml ? MediaUtils.escapeHtml(String(s ?? '')) : String(s ?? '');
        let html = '';
        for (const season of seasons) {
            const list = eps[season] || [];
            if (!list.length) continue;
            if (seasons.length > 1) html += `<div class="watch-ep-season">Season ${esc(season)}</div>`;
            for (const ep of list) {
                const isCurrent = String(season) === String(this.currentSeason)
                    && parseInt(ep.episode_num) === parseInt(this.currentEpisode);
                html += `<button class="watch-ep-option${isCurrent ? ' active' : ''}" data-season="${esc(season)}" data-ep="${esc(ep.episode_num)}">
                    <span class="watch-ep-num">${esc(ep.episode_num)}</span>
                    <span class="watch-ep-title">${esc(ep.title || `Episode ${ep.episode_num}`)}</span>
                </button>`;
            }
        }
        this.episodesNavList.innerHTML = html || '<div class="captions-menu-empty">No episodes</div>';
        this.episodesNavList.querySelectorAll('.watch-ep-option').forEach((btn) => {
            btn.addEventListener('click', () => {
                const season = btn.dataset.season;
                const epNum = parseInt(btn.dataset.ep);
                const ep = (this.seriesInfo.episodes[season] || []).find(e => parseInt(e.episode_num) === epNum);
                this.closeEpisodesMenu();
                if (ep) this.playEpisode({ ...ep, seasonNum: season });
            });
        });
        // Keep the current episode in view.
        this.episodesNavList.querySelector('.watch-ep-option.active')?.scrollIntoView({ block: 'center' });
    }

    closeOtherMenus(except) {
        if (except !== 'audio') this.closeAudioMenu?.();
        if (except !== 'captions') this.closeCaptionsMenu?.();
        if (except !== 'speed') this.closeSpeedMenu?.();
        if (except !== 'episodes') this.closeEpisodesMenu?.();
    }

    // Show/hide the series-only controls and reflect prev/next availability +
    // the current speed on the (possibly newly created) video element.
    updateEpisodeNavUI() {
        const isSeries = this.contentType === 'series' && !!this.seriesInfo?.episodes;
        [this.prevEpBtn, this.nextEpBtn, this.episodesNavWrapper].forEach((el) => { if (el) el.hidden = !isSeries; });
        if (isSeries) {
            if (this.prevEpBtn) this.prevEpBtn.disabled = !this.getPreviousEpisode();
            if (this.nextEpBtn) this.nextEpBtn.disabled = !this.getNextEpisode();
        }
        // Loading new media resets the browser's playbackRate to 1× — reflect that
        // in state + the speed menu so the highlight never lies.
        this._playbackRate = 1;
        this.speedList?.querySelectorAll('.speed-option').forEach((o) =>
            o.classList.toggle('active', parseFloat(o.dataset.rate) === 1));
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

    async goBack() {
        this.trackPlaybackPosition({ force: true });
        this.saveResumeSnapshotThrottled(true);
        await this.saveProgress({ force: true });

        this._suspendResumeSnapshotSave = true;
        this.stop();
        this._suspendResumeSnapshotSave = false;
        this.clearResumeSnapshot();
        this.cancelNextEpisode();

        // Navigate to the page we came from (stored in returnPage)
        // We don't use history.back() because we used replaceHistory when navigating here
        this.app.navigateTo(this.returnPage || 'movies');
    }

    show() {
        this.restoreFromResumeSnapshot();
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

    async saveProgress(options = {}) {
        if (!this.content || !this.video) return;
        if (this.video.paused && !options.force) return;

        const validDuration = this.getDisplayDuration() || this._lastKnownPlaybackDuration;
        const duration = validDuration ? Math.floor(validDuration) : 0;
        const progress = duration > 0
            ? Math.min(Math.floor(this.getResumeSnapshotPosition()), duration)
            : Math.floor(this.getResumeSnapshotPosition());

        if (isNaN(progress) || isNaN(duration) || duration <= 0) return;
        this.saveResumeSnapshot({ position: progress });

        try {
            const data = {
                title: this.content.title || 'Unknown Title',
                subtitle: this.content.subtitle || (this.content.type === 'movie' ? 'Movie' : 'Series'),
                poster: this.content.poster,
                sourceId: this.content.sourceId,
                containerExtension: this.containerExtension,
                durationHint: duration,
                playbackPreferences: this.getPlaybackPreferences(),
                // Series-specific fields for next episode functionality
                seriesId: this.content.seriesId || null,
                currentSeason: this.currentSeason || null,
                currentEpisode: this.currentEpisode || null,
                nextEpisode: this.content.type === 'series' ? this.sanitizeNextEpisodeForHistory(this.getNextEpisode()) : null
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
