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

            // The Live TV channel drawer.
            const sidebar = document.getElementById('channel-sidebar');
            if (sidebar && sidebar.classList.contains('active')) {
                sidebar.classList.remove('active');
                document.querySelectorAll('.channel-overlay.active').forEach((o) => o.classList.remove('active'));
                return 'handled';
            }

            // Series details (seasons/episodes) panel → back to the grid.
            const details = document.getElementById('series-details');
            if (details && !details.classList.contains('hidden')) {
                const back = document.querySelector('.series-back-btn');
                if (back) { back.click(); return 'handled'; }
            }

            // Not on Home → go Home instead of exiting.
            const active = document.querySelector('.page.active');
            if (active && active.id && active.id !== 'page-home') {
                const homeLink = document.querySelector('.nav-link[data-page="home"]');
                if (homeLink) { homeLink.click(); return 'handled'; }
            }
        } catch (_) { /* fall through to native exit handling */ }
        return 'exit';
    };

    // Route all playback to the native player once the page classes exist
    document.addEventListener('DOMContentLoaded', () => {
        const nativePlay = (streamUrl, title, meta, resumeSeconds) => {
            const resume = Math.max(0, Math.floor(Number(resumeSeconds) || 0));
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
        const resolveStreamUrl = async (streamUrl) => {
            try {
                if (typeof streamUrl !== 'function') return streamUrl || null;
                const resolved = await streamUrl();
                if (typeof resolved === 'string') return resolved || null;
                return resolved && resolved.url ? resolved.url : null;
            } catch (err) {
                console.warn('[Native] Could not resolve stream URL:', err?.message || err);
                return null;
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
            WatchPage.prototype.play = async function (content, streamUrl) {
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
                const url = await resolveStreamUrl(streamUrl);
                if (!url) return;
                nativePlay(url, nativeTitle(content), contentMeta(content), content.resumeTime);
            };
        }

        if (window.VideoPlayer) {
            VideoPlayer.prototype.play = async function (channel, streamUrl) {
                this.currentChannel = channel;
                const url = await resolveStreamUrl(streamUrl);
                if (!url) return;
                nativePlay(url, channel?.name || 'Live TV', channelMeta(channel), 0);
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
