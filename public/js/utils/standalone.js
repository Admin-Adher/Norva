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
    const nativeProgressMeta = new Map();
    const nativeProgressKey = (sourceId, itemType, itemId) =>
        [String(sourceId || ''), String(itemType || ''), String(itemId || '')].join('|');

    // The native player reports its final position here when it closes. Persist
    // it to the cloud history so other devices resume from it. Defined on window
    // up-front: MainActivity calls it via evaluateJavascript after the player
    // activity returns, which can happen before/after DOMContentLoaded.
    window.__norvaNative = window.__norvaNative || {};
    window.__norvaNative.onProgress = (sourceId, itemType, itemId, positionSeconds, durationSeconds) => {
        try {
            const progress = Math.max(0, Math.floor(Number(positionSeconds) || 0));
            const meta = nativeProgressMeta.get(nativeProgressKey(sourceId, itemType, itemId)) || {};
            const reportedDuration = Math.max(0, Math.floor(Number(durationSeconds) || 0));
            const fallbackDuration = Math.max(0, Math.floor(Number(meta.duration) || 0));
            const duration = reportedDuration || fallbackDuration;
            if (!sourceId || !itemId || progress <= 0) return;
            const payload = {
                id: String(itemId),
                type: itemType || 'movie',
                sourceId: String(sourceId),
                progress,
                duration
            };
            if (meta.data) {
                payload.data = {
                    ...meta.data,
                    sourceId: String(sourceId),
                    durationHint: duration || meta.data.durationHint || 0
                };
            } else {
                payload.data = { sourceId: String(sourceId), durationHint: duration || 0 };
            }
            window.API?.history?.save?.(payload)?.catch?.(() => { });
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

    // The native player's "À suivre" overlay picked the next episode (button or
    // countdown) → same flow as onEnded but skipping the web-side 8s prompt.
    window.__norvaNative.onPlayNext = (sourceId, itemType, itemId) => {
        try {
            window.dispatchEvent(new CustomEvent('norva-native-ended', {
                detail: {
                    sourceId: String(sourceId || ''), itemType: itemType || '',
                    itemId: String(itemId || ''), immediate: true
                }
            }));
        } catch (_) { /* best-effort */ }
    };

    // Deep-link entry (Android TV Watch Next card, share links): resume the item
    // from the cloud history. Returns synchronously; the lookup runs async.
    window.__norvaNative.openItem = (sourceId, itemType, itemId) => {
        (async () => {
            try {
                const home = window.app?.pages?.home;
                const items = await window.API?.history?.getAll?.(200);
                const match = (items || []).find((it) =>
                    String(it.item_id ?? it.itemId ?? it.id) === String(itemId) &&
                    String(it.source_id ?? it.sourceId ?? '') === String(sourceId));
                if (match && home?.openRailItem) {
                    home.openRailItem(match, true);
                    return;
                }
                // Not in history (e.g. cleared): land on the right catalog page.
                window.app?.navigateTo?.(itemType === 'series' || itemType === 'episode' ? 'series' : 'movies');
            } catch (_) { /* best-effort */ }
        })();
        return true;
    };

    // Voice/remote search hand-off from the native shell: open the global search
    // overlay pre-filled with the spoken query.
    window.__norvaNative.openSearch = (query) => {
        try {
            window.app?.openSearch?.();
            const input = document.getElementById('gsearch-input');
            if (input) {
                input.value = String(query || '');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return true;
        } catch (_) {
            return false;
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
        // A legitimate re-launch that must NOT be swallowed by the double-tap guard —
        // notably a variant switch, which relaunches right after the player hands control
        // back. Clears the guard so the very next nativePlay always fires.
        window.__norvaResetPlayThrottle = () => { lastNativePlayAt = 0; };
        const nativePlay = (streamUrl, title, meta, resumeSeconds, fallbackUrl, extras) => {
            const nowTs = Date.now();
            if (nowTs - lastNativePlayAt < 1500) return;
            lastNativePlayAt = nowTs;
            const resume = Math.max(0, Math.floor(Number(resumeSeconds) || 0));
            const fb = fallbackUrl || '';
            if (meta && typeof bridge.playVideoJson === 'function') {
                // Newest APK: one JSON payload. Extras feed the launcher's Play Next
                // card (poster) and the native "À suivre" overlay (nextTitle).
                let poster = '';
                try {
                    if (extras?.poster) poster = new URL(extras.poster, location.origin).href;
                } catch (_) { /* art is optional */ }
                bridge.playVideoJson(JSON.stringify({
                    url: streamUrl,
                    fallbackUrl: fb,
                    title: title || 'Norva',
                    sourceId: String(meta.sourceId || ''),
                    itemType: meta.itemType || '',
                    itemId: String(meta.itemId || ''),
                    resumeSeconds: resume,
                    poster,
                    nextTitle: extras?.nextTitle || '',
                    // Live quality variants (label + streamId + sourceId) for the native
                    // player's quality menu. Metadata only, never pre-resolved URLs: a live
                    // gateway grants ONE slot, so resolving each variant up front would close
                    // the playing session. The native player reports the pick back and the web
                    // re-resolves + relaunches it (see __norvaPlayVariant).
                    variants: Array.isArray(extras?.variants) ? extras.variants : [],
                    activeStreamId: extras?.activeStreamId ? String(extras.activeStreamId) : ''
                }));
                return;
            }
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

        // Live variant list for the native player's quality menu. Metadata only (label +
        // streamId + sourceId); see the playVideoJson payload note for why URLs aren't
        // pre-resolved. Returns [] for single-variant channels (no menu).
        const buildNativeVariants = (channel) => {
            const cl = window.app?.channelList;
            if (!channel || !cl) return [];
            // Use the SAME family grouping the guide list shows ("M6 · N variants" = same
            // source + family key), so the player's "Version" menu matches the list exactly.
            // NOT channel.qualityGroup (a separate lineup/quality grouping that, for some
            // families, lumped in unrelated channels and dropped real variants).
            let members = [];
            try {
                if (typeof cl.getChannelFamilyMembers === 'function') {
                    members = cl.getChannelFamilyMembers(channel, { includeCurrent: true, includeHidden: false }) || [];
                }
            } catch (_) { members = []; }
            if (members.length < 2) {
                // Fallback to the old quality-group list only when family grouping is unavailable.
                const list = channel?.qualityGroup?.variants;
                if (!Array.isArray(list) || list.length < 2) return [];
                return list.map(v => ({
                    label: String(v.label || v.raw || 'Variant'),
                    streamId: String(v.streamId != null ? v.streamId : (v.stream_id != null ? v.stream_id : '')),
                    sourceId: String(v.sourceId != null ? v.sourceId : (channel.sourceId || ''))
                })).filter(v => v.streamId);
            }
            const CG = window.ChannelGrouping;
            const qLabel = (m) => {
                try { const p = CG && CG.parseName && CG.parseName(m.name || ''); const q = p && CG.qualityLabel && CG.qualityLabel(p); if (q) return q; } catch (_) { /* fall through */ }
                return m.name || 'Variant';
            };
            const rank = (l) => l.startsWith('4K') ? 0 : (l.startsWith('FHD') || l.startsWith('Super HD')) ? 1 : l.startsWith('HD') ? 2 : l.startsWith('SD') ? 3 : 2;
            const seen = Object.create(null);
            return members
                .map(m => ({ m, label: qLabel(m) }))
                .sort((a, b) => rank(a.label) - rank(b.label))
                .map(({ m, label }) => {
                    // Disambiguate identical quality labels (e.g. two HD feeds) so each entry is distinct.
                    let lbl = label;
                    if (seen[lbl]) { seen[lbl] += 1; lbl = `${lbl} (${seen[lbl]})`; } else { seen[lbl] = 1; }
                    return {
                        label: String(lbl),
                        streamId: String(m.streamId != null ? m.streamId : (m.stream_id != null ? m.stream_id : '')),
                        sourceId: String(m.sourceId != null ? m.sourceId : (channel.sourceId || ''))
                    };
                })
                .filter(v => v.streamId);
        };

        // Called by the native shell (MainActivity.onActivityResult) after the viewer picks a
        // variant in the native player: find that variant's channel in the catalog and re-select
        // it, which resolves a fresh stream (new gateway session) and relaunches native playback.
        if (typeof window !== 'undefined') {
            window.__norvaPlayVariant = function (streamId, sourceId) {
                try {
                    const cl = window.app?.channelList;
                    if (!cl || streamId == null) { console.warn('[Native] variant: no channelList'); return; }
                    const sid = String(streamId);
                    const src = sourceId != null ? String(sourceId) : '';
                    const ch = (cl.channels || []).find(c =>
                        String(c.streamId != null ? c.streamId : c.stream_id) === sid &&
                        (!src || String(c.sourceId) === src));
                    if (!ch) { console.warn('[Native] variant channel not found', sid, src); return; }
                    // The native player closed to hand control back here; clear the double-tap
                    // guard so the relaunch isn't swallowed, then drive the SAME path a normal
                    // guide tap uses (resolves a fresh stream + relaunches native playback).
                    // A tick lets the WebView finish resuming before we re-launch an Activity.
                    if (window.__norvaResetPlayThrottle) window.__norvaResetPlayThrottle();
                    setTimeout(() => {
                        try {
                            if (window.__norvaResetPlayThrottle) window.__norvaResetPlayThrottle();
                            const lg = window.app?.liveGuideFusion;
                            if (lg && typeof lg.playChannel === 'function') lg.playChannel(ch);
                            else cl.selectChannel({ channelId: ch.id, sourceId: String(ch.sourceId), streamId: sid });
                        } catch (e) { console.warn('[Native] variant re-select failed:', e && e.message); }
                    }, 150);
                } catch (e) { console.warn('[Native] play variant failed:', e && e.message); }
            };
        }

        const nativeTitle = (content) => {
            const parts = [content?.title, content?.subtitle].filter(Boolean);
            return parts.join(' — ') || 'Norva';
        };

        if (window.WatchPage) {
            WatchPage.prototype.play = async function (content, streamUrl, playback) {
                // Cross-device resume backfill for the native player. It only receives
                // content.resumeTime, which comes from the loaded Continue-Watching
                // window; when that is 0 (deep link, title outside the window, or a
                // second device) recover the saved position from the server so native
                // TV/phone resume like the web player. Best-effort, only when needed.
                let effectiveResume = Math.max(0, Math.floor(Number(content.resumeTime) || 0));
                if (effectiveResume <= 0 && typeof this._fetchServerResumePosition === 'function') {
                    try {
                        const serverPos = await this._fetchServerResumePosition(content);
                        if (Number(serverPos) > 0) effectiveResume = Math.floor(Number(serverPos));
                    } catch (_) { /* best-effort */ }
                }
                try {
                    const meta = contentMeta(content);
                    if (meta) {
                        nativeProgressMeta.set(nativeProgressKey(meta.sourceId, meta.itemType, meta.itemId), {
                            duration: content.durationHint || 0,
                            data: {
                                title: content.title,
                                subtitle: content.subtitle || '',
                                poster: content.poster,
                                sourceId: content.sourceId,
                                seriesId: content.seriesId || null,
                                currentSeason: content.currentSeason || null,
                                currentEpisode: content.currentEpisode || null,
                                containerExtension: content.containerExtension || 'mp4',
                                durationHint: content.durationHint || 0
                            }
                        });
                    }
                    // Seed history so Continue Watching shows the title even if
                    // the viewer quits before the native player reports back.
                    window.API?.history?.save?.({
                        id: content.id,
                        type: historyType(content),
                        sourceId: content.sourceId,
                        progress: effectiveResume,
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
                nativePlay(resolved.url, nativeTitle(content), contentMeta(content), effectiveResume, fallbackUrl, {
                    poster: content.poster || '',
                    nextTitle: content.nextEpisodeLabel || ''
                });
            };
        }

        if (window.VideoPlayer) {
            VideoPlayer.prototype.play = async function (channel, streamUrl, playback) {
                this.currentChannel = channel;
                const resolved = await resolveStreamPayload(streamUrl);
                if (!resolved.url) return;
                // Live resolves to a bare URL string (ChannelList passes result.url), so
                // resolveStreamPayload yields fallbackUrl=null. Recover the gateway
                // byte-pipe fallback from the resolver payload (3rd arg) so a native live
                // channel gets the same direct→gateway recovery as VOD.
                const fallbackUrl = resolved.fallbackUrl || (playback && playback.fallbackUrl) || null;
                nativePlay(resolved.url, channel?.name || 'Live TV', channelMeta(channel), 0, fallbackUrl, {
                    variants: buildNativeVariants(channel),
                    activeStreamId: channel?.streamId != null ? String(channel.streamId) : ''
                });
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
