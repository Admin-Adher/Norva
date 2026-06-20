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

    // Route all playback to the native player once the page classes exist
    document.addEventListener('DOMContentLoaded', () => {
        const nativePlay = (streamUrl, title, meta) => {
            if (bridge.playVideoWithMeta && meta) {
                bridge.playVideoWithMeta(
                    streamUrl,
                    title,
                    String(meta.sourceId || ''),
                    meta.itemType || '',
                    String(meta.itemId || '')
                );
            } else {
                bridge.playVideo(streamUrl, title);
            }
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

        const contentMeta = (content) => {
            if (!content?.sourceId || !content?.id) return null;
            if (content.type === 'movie') {
                return { sourceId: content.sourceId, itemType: 'movie', itemId: content.id };
            }
            return { sourceId: content.sourceId, itemType: 'series', itemId: content.seriesId || content.id };
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
                    // Keep lightweight history so Continue Watching still works.
                    // (Live position sync from the native player is a separate
                    // native-side change — see docs/ARCHITECTURE-RELIABILITY.md.)
                    window.API?.history?.save?.({
                        id: content.id,
                        type: content.type === 'movie' ? 'movie' : 'episode',
                        sourceId: content.sourceId,
                        progress: 0,
                        duration: 0,
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
                    }).catch(() => { });
                } catch (e) { /* history is best-effort */ }
                const url = await resolveStreamUrl(streamUrl);
                if (!url) return;
                nativePlay(url, nativeTitle(content), contentMeta(content));
            };
        }

        if (window.VideoPlayer) {
            VideoPlayer.prototype.play = async function (channel, streamUrl) {
                this.currentChannel = channel;
                const url = await resolveStreamUrl(streamUrl);
                if (!url) return;
                nativePlay(url, channel?.name || 'Live TV', channelMeta(channel));
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
