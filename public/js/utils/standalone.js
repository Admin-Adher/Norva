/**
 * Standalone-mode glue for the Android TV client.
 *
 * Active only when the page runs inside the standalone APK (the native
 * side injects window.NodeCastNative). In this mode:
 *  - auth is implicit (the embedded local server has a single admin user),
 *  - playback is handed to the native Android player, whose hardware
 *    decoders handle MKV/AC3/EAC3/HEVC that the WebView cannot play.
 *
 * Loaded before app.js so the implicit token exists before checkAuth().
 */

(() => {
    if (!window.NodeCastNative) return;

    // Implicit session: the embedded server accepts any token
    if (!localStorage.getItem('authToken')) {
        localStorage.setItem('authToken', 'standalone');
    }

    // Route all playback to the native player once the page classes exist
    document.addEventListener('DOMContentLoaded', () => {
        const nativePlay = (streamUrl, title, meta) => {
            if (window.NodeCastNative.playVideoWithMeta && meta) {
                window.NodeCastNative.playVideoWithMeta(
                    streamUrl,
                    title,
                    String(meta.sourceId || ''),
                    meta.itemType || '',
                    String(meta.itemId || '')
                );
            } else {
                window.NodeCastNative.playVideo(streamUrl, title);
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
            WatchPage.prototype.play = function (content, streamUrl) {
                try {
                    // Keep lightweight history so Continue Watching still works
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
                nativePlay(streamUrl, nativeTitle(content), contentMeta(content));
            };
        }

        if (window.VideoPlayer) {
            VideoPlayer.prototype.play = function (channel, streamUrl) {
                this.currentChannel = channel;
                nativePlay(streamUrl, channel?.name || 'Live TV', channelMeta(channel));
            };
        }

        // Logout makes no sense without accounts: hide the button when it appears
        const hideLogout = () => document.getElementById('logout-btn')?.remove();
        setTimeout(hideLogout, 1500);
        setTimeout(hideLogout, 4000);
    });

    console.log('[Standalone] Native playback bridge active');
})();
