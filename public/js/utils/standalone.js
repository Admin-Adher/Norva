/**
 * Native-player glue for the Android TV client.
 *
 * Active whenever the page runs inside a native shell that injects a bridge:
 *  - window.NodeCastNative  → standalone APK (embedded local server), or
 *  - window.NorvaTVCloud    → cloud-paired TV loading https://norva.tv/app.html.
 *
 * In both modes playback is handed to the native Android player (ExoPlayer),
 * whose hardware decoders handle MKV/AC3/EAC3/HEVC the WebView cannot play, and
 * which pulls the stream from the user's HOME network (residential IP) — so the
 * provider does not 401-block it the way it blocks the cloud datacenter gateway.
 * api.js resolves a DIRECT provider URL when a native bridge is present.
 *
 * Cross-device resume: the native player is started at the saved offset
 * (content.resumeTime) and, on exit, reports its final position back through
 * window.__norvaNative.onProgress(), which persists it to the cloud history —
 * so a title stopped on the TV resumes where you left off on phone/web, and
 * vice-versa. This uses a feature-detected bridge method (playVideoResumable),
 * so older APKs that lack it keep working (playback without resume).
 *
 * Loaded before app.js so the implicit token (standalone only) exists before
 * checkAuth(). In a normal browser no bridge exists and this is a no-op.
 */

(() => {
    const bridge = window.NodeCastNative || window.NorvaTVCloud;
    if (!bridge) return;

    // Implicit session only in standalone (the embedded server has a single
    // admin user). In cloud mode the TV uses its real Norva account session —
    // never clobber it.
    const isStandalone = Boolean(window.NodeCastNative);
    if (isStandalone && !localStorage.getItem('authToken')) {
        localStorage.setItem('authToken', 'standalone');
    }

    // History identity used by the cloud resume logic: movies key on the movie
    // id, episodes on the episode id (mirrors WatchPage.saveProgress) so the
    // position the TV reports is read back by every other device.
    const historyType = (content) => (content?.type === 'movie' ? 'movie' : 'episode');
    const historyId = (content) => (content?.id != null ? String(content.id) : '');

    // The native player reports its final position here when it closes. Persist
    // it to the cloud history so other devices resume from it. Defined on window
    // up-front: MainActivity calls it via evaluateJavascript after the player
    // activity returns, which can happen before/after DOMContentLoaded.
    window.__norvaNative = window.__norvaNative || {};
    window.__norvaNative.onProgress = (sourceId, itemType, itemId, positionSeconds, durationSeconds) => {
        try {
            const progress = Math.max(0, Math.floor(Number(positionSeconds) || 0));
            const duration = Math.max(0, Math.floor(Number(durationSeconds) || 0));
            if (!sourceId || !itemId || progress <= 0) return;
            window.API?.history?.save?.({
                id: String(itemId),
                type: itemType || 'movie',
                sourceId: String(sourceId),
                progress,
                duration,
                data: { sourceId: String(sourceId) }
            })?.catch?.(() => { });
        } catch (err) {
            console.warn('[Native] onProgress save failed:', err?.message || err);
        }
    };

    // Natural end of a native VOD playback → let the open Series fiche autoplay the
    // next episode. MainActivity fires this only when the player reached the end
    // (not on a user-close), so it's harmlessly inert in older APKs that never call it.
    window.__norvaNative.onEnded = (sourceId, itemType, itemId) => {
        try {
            window.dispatchEvent(new CustomEvent('norva-native-ended', {
                detail: { sourceId: String(sourceId || ''), itemType: itemType || '', itemId: String(itemId || '') }
            }));
        } catch (_) { /* best-effort */ }
    };

    // Hardware Back button bridge for the native phone shell. Returns 'handled'
    // when Back was consumed inside the page (an open overlay closed, or we
    // stepped back to Home) so the native layer leaves history/exit alone, else
    // 'exit'. Mirrors the TV client's __norvaTV.handleBack, but available on the
    // phone where the TV-only D-pad module that defines it stays disabled.
    window.__norvaHandleBack = function () {
        try {
            // Region suggestion popup.
            const region = document.getElementById('norva-region-prompt');
            if (region) { region.remove(); return 'handled'; }

            // Profile switcher (full-screen takeover; it carries no .active /
            // .modal-overlay class, so the generic modal check below misses it).
            // Consume Back even in forced-pick mode, where there's no close button
            // to dismiss it, so Back never navigates out from under the picker.
            const npOverlay = document.querySelector('.np-overlay');
            if (npOverlay) {
                npOverlay.querySelector('.np-close')?.click();
                return 'handled';
            }

            // An open modal (settings, add source, dialogs).
            const modal = document.querySelector('#modal.active, .modal-overlay.active');
            if (modal) {
                const closeBtn = modal.querySelector('.modal-close, #modal-cancel');
                if (closeBtn && typeof closeBtn.onclick === 'function') {
                    try { closeBtn.onclick(); } catch (_) { /* fall through */ }
                }
                modal.classList.remove('active');
                return 'handled';
            }

            // An open player menu (captions / audio / quality / overflow).
            const menu = document.querySelector(
                '.watch-captions-menu:not(.hidden), .watch-audio-menu:not(.hidden), '
                + '.player-quality-menu:not(.hidden), .player-overflow-menu:not(.hidden)');
            if (menu) { menu.classList.add('hidden'); return 'handled'; }

            // The mobile navigation menu.
            const navMenu = document.getElementById('navbar-menu');
            if (navMenu && navMenu.classList.contains('active')) {
                navMenu.classList.remove('active');
                document.getElementById('mobile-menu-toggle')?.classList.remove('active');
                return 'handled';
            }

            // The Live TV channel drawer (sidebar + its dimmed backdrop overlay).
            const sidebar = document.getElementById('channel-sidebar');
            if (sidebar && sidebar.classList.contains('active')) {
                sidebar.classList.remove('active');
                document.getElementById('channel-sidebar-overlay')?.classList.remove('active');
                document.getElementById('channel-toggle-btn')?.classList.remove('active');
                return 'handled';
            }

            // Series details (seasons/episodes) panel → back to the grid.
            const details = document.getElementById('series-details');
            if (details && !details.classList.contains('hidden')) {
                const back = document.querySelector('.series-back-btn');
                if (back) { back.click(); return 'handled'; }
            }

            // Movie details panel → back to the grid. Mirrors series-details: the
            // panel toggles in-page (no history entry of its own), so Back must
            // close it explicitly rather than fall through to tab navigation.
            const movieDetails = document.getElementById('movie-details');
            if (movieDetails && !movieDetails.classList.contains('hidden')) {
                const back = document.querySelector('.movie-back-btn');
                if (back) { back.click(); return 'handled'; }
            }

            // Mobile catalogue filter sheet (Movies/Series). Click the open sheet's
            // own close button so its cleanup (classes + body flag) runs.
            if (document.body.classList.contains('catalog-filter-open')) {
                document.querySelector('.mobile-open .mobile-filter-close')?.click();
                return 'handled';
            }

            // No overlay open: step back through the in-app TAB history instead of
            // always jumping Home. Each navigateTo() stamps a monotonic idx on its
            // history entry, so idx > 0 means there's a previous tab to pop (Back
            // lands on it, not Home), and idx 0 is the root entry → let the native
            // layer exit the app. history.back() fires popstate, which restores the
            // previous tab without re-pushing.
            const idx = (window.history.state && typeof window.history.state.idx === 'number')
                ? window.history.state.idx
                : 0;
            if (idx > 0) { window.history.back(); return 'handled'; }
        } catch (_) { /* fall through to native exit handling */ }
        return 'exit';
    };

    // Route all playback to the native player once the page classes exist
    document.addEventListener('DOMContentLoaded', () => {
        // Double-tap guard. Launching the native player starts a new fullscreen
        // Android activity and backgrounds the WebView; a rapid double-tap fires
        // two launches before the activity covers the screen, stacking two
        // players. Ignore a second launch inside a short window — a legitimate
        // re-launch only happens after the viewer returns from the player (well
        // beyond this window), so real playback is never blocked. This is the one
        // choke point for ALL native playback (channels, movies, episodes).
        let lastNativePlayAt = 0;
        const nativePlay = (streamUrl, title, meta, resumeSeconds, fallbackUrl) => {
            const nowTs = Date.now();
            if (nowTs - lastNativePlayAt < 1500) return;
            lastNativePlayAt = nowTs;
            const resume = Math.max(0, Math.floor(Number(resumeSeconds) || 0));
            const fb = fallbackUrl || '';
            if (meta && fb && typeof bridge.playVideoResumableFallback === 'function') {
                // Newest APK: hand the player a direct URL + a gateway fallback URL it
                // switches to if the provider refuses the direct (residential-IP) request.
                bridge.playVideoResumableFallback(
                    streamUrl,
                    fb,
                    title,
                    String(meta.sourceId || ''),
                    meta.itemType || '',
                    String(meta.itemId || ''),
                    resume
                );
                return;
            }
            if (meta && resume > 0 && typeof bridge.playVideoResumable === 'function') {
                // New APK: start at the saved offset and report position on exit.
                bridge.playVideoResumable(
                    streamUrl,
                    title,
                    String(meta.sourceId || ''),
                    meta.itemType || '',
                    String(meta.itemId || ''),
                    resume
                );
                return;
            }
            if (meta && typeof bridge.playVideoWithMeta === 'function') {
                bridge.playVideoWithMeta(
                    streamUrl,
                    title,
                    String(meta.sourceId || ''),
                    meta.itemType || '',
                    String(meta.itemId || '')
                );
                return;
            }
            bridge.playVideo(streamUrl, title);
        };

        // play() may receive a ready URL or an async resolver returning
        // { url, ... } — the cloud movie/series path opens the player shell
        // first, then resolves the stream. Support both so native playback
        // works in cloud mode (not just standalone).
        const resolveStreamPayload = async (streamUrl) => {
            try {
                if (typeof streamUrl !== 'function') return { url: streamUrl || null, fallbackUrl: null };
                const resolved = await streamUrl();
                if (typeof resolved === 'string') return { url: resolved || null, fallbackUrl: null };
                return {
                    url: resolved && resolved.url ? resolved.url : null,
                    fallbackUrl: resolved && resolved.fallbackUrl ? resolved.fallbackUrl : null
                };
            } catch (err) {
                console.warn('[Native] Could not resolve stream URL:', err?.message || err);
                return { url: null, fallbackUrl: null };
            }
        };

        // History metadata used by the native resume callback (movies/episodes).
        const contentMeta = (content) => {
            if (!content?.sourceId || content?.id == null) return null;
            return { sourceId: content.sourceId, itemType: historyType(content), itemId: historyId(content) };
        };

        const channelMeta = (channel) => {
            const itemId = channel?.streamId || channel?.id;
            if (!channel?.sourceId || itemId == null) return null;
            return { sourceId: channel.sourceId, itemType: 'channel', itemId };
        };

        const nativeTitle = (content) => {
            const parts = [content?.title, content?.subtitle].filter(Boolean);
            return parts.join(' — ') || 'Norva';
        };

        if (window.WatchPage) {
            WatchPage.prototype.play = async function (content, streamUrl, playback) {
                try {
                    // Seed history so Continue Watching shows the title even if
                    // the viewer quits before the native player reports back.
                    window.API?.history?.save?.({
                        id: content.id,
                        type: historyType(content),
                        sourceId: content.sourceId,
                        progress: Math.max(0, Math.floor(Number(content.resumeTime) || 0)),
                        duration: Math.max(0, Math.floor(Number(content.durationHint) || 0)),
                        data: {
                            title: content.title,
                            subtitle: content.subtitle || '',
                            poster: content.poster,
                            sourceId: content.sourceId,
                            seriesId: content.seriesId || null,
                            currentSeason: content.currentSeason || null,
                            currentEpisode: content.currentEpisode || null,
                            containerExtension: content.containerExtension || 'mp4'
                        }
                    })?.catch?.(() => { });
                } catch (e) { /* history is best-effort */ }
                const resolved = await resolveStreamPayload(streamUrl);
                if (!resolved.url) return;
                // fallbackUrl: the resolver payload carries it for the movie/series
                // path; the restore-after-refresh path passes it as the 3rd arg.
                const fallbackUrl = resolved.fallbackUrl || (playback && playback.fallbackUrl) || null;
                nativePlay(resolved.url, nativeTitle(content), contentMeta(content), content.resumeTime, fallbackUrl);
            };
        }

        if (window.VideoPlayer) {
            VideoPlayer.prototype.play = async function (channel, streamUrl) {
                this.currentChannel = channel;
                const resolved = await resolveStreamPayload(streamUrl);
                if (!resolved.url) return;
                nativePlay(resolved.url, channel?.name || 'Live TV', channelMeta(channel), 0, resolved.fallbackUrl);
            };
        }

        // Logout makes no sense without accounts in standalone: hide the button.
        if (isStandalone) {
            const hideLogout = () => document.getElementById('logout-btn')?.remove();
            setTimeout(hideLogout, 1500);
            setTimeout(hideLogout, 4000);
        }
    });

    console.log(`[Native] Playback bridge active (${isStandalone ? 'standalone' : 'cloud'})`);
})();
