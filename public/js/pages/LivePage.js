/**
 * Home Page Controller
 */

class LivePage {
    constructor(app) {
        this.app = app;
        this.handleKeydown = this.handleKeydown.bind(this);
    }

    async init() {
        // Load sources and channels on initial page load
        await this.app.channelList.loadSources();
        await this.app.channelList.loadChannels();
        this.app.liveGuideFusion?.render();
        // Phone/tablet APK AND Android TV: don't auto-launch playback on open. On the
        // TV WebView, playing the <video> pops the NATIVE fullscreen player, so opening
        // Live would jump straight to fullscreen — and backing out leaves the inline
        // player unable to re-acquire the stream (it just spins). Land on the browse
        // view instead and let the viewer press OK to watch (web still auto-resumes).
        const autoResumeOk = document.getElementById('page-live')?.classList.contains('active')
            && !document.body.classList.contains('norva-phone-apk')
            && !document.documentElement.classList.contains('tv-mode');
        if (autoResumeOk) {
            this.app.channelList.resumeLivePlayback();
        }

        // Fetch EPG in the background — never block the channel list or page init
        // on it. The guide fills in (and program info updates) once it arrives.
        this.app.epgGuide.fetchEpgData()
            .then(() => {
                // Clear cache so we don't keep stale "null" results from first render
                this.app.channelList.clearProgramInfoCache();
                // Update program info in existing DOM elements without re-rendering
                this.updateProgramInfo();
                this.app.liveGuideFusion?.render();
            })
            .catch((err) => console.warn('Background EPG fetch failed:', err));
    }

    /**
     * Update "Now Playing" info in existing channel elements without blocking UI
     */
    updateProgramInfo() {
        const channelItems = Array.from(document.querySelectorAll('.channel-item'));
        if (channelItems.length === 0) return;

        // Build a map for O(1) channel lookups
        const channelMap = new Map();
        this.app.channelList.channels.forEach(c => channelMap.set(c.id, c));

        // Process in small batches to avoid blocking UI
        const BATCH_SIZE = 50;
        let index = 0;

        const processBatch = () => {
            const end = Math.min(index + BATCH_SIZE, channelItems.length);

            for (let i = index; i < end; i++) {
                const item = channelItems[i];
                const channelId = item.dataset.channelId;
                const channel = channelMap.get(channelId);

                if (channel) {
                    const programDiv = item.querySelector('.channel-program');
                    if (programDiv) {
                        const programTitle = this.app.channelList.getProgramInfo(channel);
                        programDiv.textContent = programTitle || '';
                    }
                }
            }

            index = end;
            if (index < channelItems.length) {
                // Yield to browser before next batch
                requestAnimationFrame(processBatch);
            }
        };

        // Start processing
        requestAnimationFrame(processBatch);
    }

    handleKeydown(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'ArrowUp':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectPrevChannel();
                break;
            case 'ArrowDown':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectNextChannel();
                break;
        }
    }

    async show() {
        document.addEventListener('keydown', this.handleKeydown);

        // Returning to Live TV: pull the player back out of the floating mini
        // (if it was docked there) before re-rendering, so the inline surface is whole.
        this.app.exitLiveMini?.({ restore: true });

        // Only reload if channels aren't already loaded
        if (this.app.channelList.channels.length === 0) {
            await this.app.channelList.loadSources();
            await this.app.channelList.loadChannels();
        }
        this.app.liveGuideFusion?.render();
        // Phone/tablet APK + Android TV: no auto-launch on open (see init()).
        if (!document.body.classList.contains('norva-phone-apk')
            && !document.documentElement.classList.contains('tv-mode')) {
            this.app.channelList.resumeLivePlayback();
        }
    }

    hide() {
        document.removeEventListener('keydown', this.handleKeydown);
        // Leaving Live TV while a channel plays: dock the inline player into a
        // floating mini-player (YouTube-style) so it keeps playing while the
        // viewer browses, instead of a hidden ghost stream. No-op if nothing is
        // playing, on the APK, or when the browser's own PiP is active.
        this.app.enterLiveMini?.();
    }
}

window.LivePage = LivePage;
