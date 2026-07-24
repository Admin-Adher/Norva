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
    const bootNativeBridge = () => {
        if (window.__norvaStandaloneBooted) return true;
        const bridge = window.NodeCastNative || window.NorvaTVCloud;
        if (!bridge) return false;
        window.__norvaStandaloneBooted = true;

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

    // The native player reports its position here — at close (final position), on the
    // in-playback heartbeat relay (~45 s, so other devices see the TV advance DURING the film,
    // not hours later), and from the crash-recovery flush. Persist to the cloud history so other
    // devices resume from it. Defined on window up-front: MainActivity calls it via
    // evaluateJavascript, which can happen before/after DOMContentLoaded.
    //
    // savedAtMs (optional): epoch ms when the native side CAPTURED the position — a recovery
    // flush can run hours later, and the server's temporal guard must judge the capture time,
    // not the delivery time. token (optional): when present, a SUCCESSFUL save is confirmed
    // back through bridge.onProgressSaved(token) — the native side keeps its SharedPreferences
    // safety net until that confirmation lands (fire-and-forget used to lose the position on a
    // network error at exactly the wrong moment). Older APKs pass neither arg and behave as
    // before.
    window.__norvaNative = window.__norvaNative || {};
    window.__norvaNative.onProgress = (sourceId, itemType, itemId, positionSeconds, durationSeconds, savedAtMs, token) => {
        try {
            const progress = Math.max(0, Math.floor(Number(positionSeconds) || 0));
            const meta = nativeProgressMeta.get(nativeProgressKey(sourceId, itemType, itemId)) || {};
            const reportedDuration = Math.max(0, Math.floor(Number(durationSeconds) || 0));
            const fallbackDuration = Math.max(0, Math.floor(Number(meta.duration) || 0));
            const duration = reportedDuration || fallbackDuration;
            if (!sourceId || !itemId || progress <= 0) return;
            const capturedAt = Number(savedAtMs) > 0 ? Number(savedAtMs) : Date.now();
            const payload = {
                id: String(itemId),
                type: itemType || 'movie',
                sourceId: String(sourceId),
                progress,
                duration,
                watchedAt: new Date(capturedAt).toISOString()
            };
            // durationHint only when we actually KNOW one: ExoPlayer sometimes reports 0 and the
            // in-memory meta dies with a WebView reload — sending durationHint:0 would clobber
            // the good hint an earlier save persisted (the server merges data shallowly).
            if (meta.data) {
                payload.data = { ...meta.data, sourceId: String(sourceId) };
                const hint = duration || Math.max(0, Math.floor(Number(meta.data.durationHint) || 0));
                if (hint > 0) payload.data.durationHint = hint; else delete payload.data.durationHint;
            } else {
                payload.data = { sourceId: String(sourceId) };
                if (duration > 0) payload.data.durationHint = duration;
            }
            const save = window.API?.history?.save?.(payload);
            if (token != null && save && typeof save.then === 'function') {
                save.then(
                    () => { try { bridge.onProgressSaved?.(String(token)); } catch (_) { /* older APK */ } },
                    () => { /* not confirmed → the native side keeps its net and retries */ }
                );
            } else if (save && typeof save.catch === 'function') {
                save.catch(() => { });
            }
        } catch (err) {
            console.warn('[Native] onProgress save failed:', err?.message || err);
        }
    };

    // Native track changes are merged into the same history data blob used by
    // the web player. MainActivity invokes this before onProgress, so the next
    // cloud write carries the exact preference to every device.
    window.__norvaNative.onTrackPreferences = (sourceId, itemType, itemId, rawPreferences) => {
        try {
            const parsed = typeof rawPreferences === 'string'
                ? JSON.parse(rawPreferences)
                : rawPreferences;
            if (!parsed || typeof parsed !== 'object') return false;
            const clean = {};
            const normalize = (value) => {
                if (!value || typeof value !== 'object') return null;
                const result = {};
                const stableId = String(value.stableId || value.stable_id || '').slice(0, 160);
                const language = String(value.language || value.lang || '').toLowerCase().slice(0, 16);
                const role = String(value.role || '').toLowerCase().slice(0, 32);
                if (stableId) result.stableId = stableId;
                if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) result.language = language;
                if (/^(main|original|dub|audio_description|commentary|full|forced|sdh)$/.test(role)) {
                    result.role = role;
                }
                if (value.disabled === true) result.disabled = true;
                return Object.keys(result).length ? result : null;
            };
            const audio = normalize(parsed.audio);
            const subtitle = normalize(parsed.subtitle);
            if (audio) clean.audio = audio;
            if (subtitle) clean.subtitle = subtitle;
            if (!clean.audio && !clean.subtitle) return false;
            const key = nativeProgressKey(sourceId, itemType, itemId);
            const meta = nativeProgressMeta.get(key) || {};
            meta.data = {
                ...(meta.data || {}),
                sourceId: String(sourceId || ''),
                playbackPreferences: clean
            };
            nativeProgressMeta.set(key, meta);
            return true;
        } catch (error) {
            console.warn('[Native] track preference merge failed:', error?.message || error);
            return false;
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
    const installNativeOverrides = () => {
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
        // A native activity can exhaust both its direct URL and its signed Gateway
        // fallback after the WebView has been in the background for a long time.
        // Keep a bounded, item-scoped launcher here so the activity can return the
        // exact item + timestamp, mint fresh URLs, and relaunch without navigating
        // away from the current Live/detail route.
        const nativeRecoveryLaunchers = new Map();
        const nativeRecoveryAttempts = new Map();
        const NATIVE_RECOVERY_WINDOW_MS = 5 * 60 * 1000;
        const NATIVE_RECOVERY_MAX = 3;
        const NATIVE_RECOVERY_DELAYS_MS = [1200, 3500, 7000];
        // Older TV APKs still hand an exhausted live socket back to the WebView.
        // A live channel is open-ended, so three provider-side socket rotations
        // must not permanently eject the viewer. Keep the VOD cap, but let live
        // reconnect with a bounded delay until the viewer changes route.
        const NATIVE_LIVE_RECOVERY_DELAYS_MS = [250, 1000, 2500, 5000, 8000, 12000, 15000];
        let nativeIntentGeneration = 0;
        let activeNativeIntentKey = '';
        let activeNativeIntentRoute = '';
        let activeNativeIntentClaim = '';
        let activeNativeIntentClaimConsumed = true;
        let lastNativeIntentAt = 0;
        const currentNativeRoute = () => {
            try {
                return String(window.location?.hash || `#${window.app?.currentPage || ''}`);
            } catch (_) {
                return '';
            }
        };
        const beginNativePlaybackIntent = (sourceId, itemType, itemId) => {
            const key = nativeProgressKey(sourceId, itemType, itemId);
            const now = Date.now();
            const route = currentNativeRoute();
            if (key === activeNativeIntentKey
                && route === activeNativeIntentRoute
                && now - lastNativeIntentAt < 1500) return false;
            activeNativeIntentKey = key;
            activeNativeIntentRoute = route;
            lastNativeIntentAt = now;
            nativeIntentGeneration += 1;
            activeNativeIntentClaim = `${nativeIntentGeneration}:${now}:${key}`;
            activeNativeIntentClaimConsumed = false;
            // This is a new viewer action, not an automatic recovery attempt.
            nativeRecoveryAttempts.delete(key);
            return activeNativeIntentClaim;
        };
        const consumeNativePlaybackIntent = (sourceId, itemType, itemId, claim) => {
            const key = nativeProgressKey(sourceId, itemType, itemId);
            if (!claim
                || claim !== activeNativeIntentClaim
                || activeNativeIntentClaimConsumed
                || key !== activeNativeIntentKey) return false;
            activeNativeIntentClaimConsumed = true;
            return true;
        };
        window.__norvaNative.beginPlaybackIntent = beginNativePlaybackIntent;
        window.__norvaNative.consumePlaybackIntent = consumeNativePlaybackIntent;
        // Leaving the current route while a delayed retry is pending must never
        // resurrect the previous channel/title over the page the viewer chose.
        // Only invalidate when the route actually differs from the launch route:
        // some Android WebViews emit a redundant navigation signal while restoring
        // the backgrounded page, and that must not cancel a legitimate recovery.
        const invalidateNativeRecoveryForRouteChange = () => {
            if (!activeNativeIntentKey || currentNativeRoute() === activeNativeIntentRoute) return;
            activeNativeIntentKey = '';
            activeNativeIntentClaim = '';
            activeNativeIntentClaimConsumed = true;
            nativeIntentGeneration += 1;
        };
        window.addEventListener('hashchange', invalidateNativeRecoveryForRouteChange);
        window.addEventListener('popstate', invalidateNativeRecoveryForRouteChange);
        const registerNativeRecovery = (meta, launcher) => {
            if (!meta || typeof launcher !== 'function') return;
            const key = nativeProgressKey(meta.sourceId, meta.itemType, meta.itemId);
            nativeRecoveryLaunchers.set(key, { launcher, registeredAt: Date.now() });
            // Avoid retaining a launcher for every title viewed during a long-lived
            // TV WebView session.
            const cutoff = Date.now() - 6 * 60 * 60 * 1000;
            for (const [oldKey, entry] of nativeRecoveryLaunchers.entries()) {
                if ((entry?.registeredAt || 0) < cutoff) {
                    nativeRecoveryLaunchers.delete(oldKey);
                    nativeRecoveryAttempts.delete(oldKey);
                }
            }
        };
        const surfaceNativeRecoveryFailure = (reason) => {
            console.warn('[Native] Fresh playback recovery exhausted:', reason || 'unknown');
            try {
                window.app?.player?.showError?.(
                    'Playback was interrupted by the provider.<br>Please press Play to try again.'
                );
            } catch (_) { /* the VOD route has no live player error surface */ }
            try {
                window.app?.showToast?.('Playback interrupted. Press Play to try again.', {
                    type: 'error',
                    duration: 8000
                });
            } catch (_) { /* best-effort */ }
        };
        window.__norvaNative.retryPlayback = (sourceId, itemType, itemId, positionSeconds, reason) => {
            const key = nativeProgressKey(sourceId, itemType, itemId);
            const entry = nativeRecoveryLaunchers.get(key);
            if (!entry) {
                surfaceNativeRecoveryFailure('launcher_missing');
                return 'missing';
            }
            const now = Date.now();
            let state = nativeRecoveryAttempts.get(key);
            if (!state || now - state.lastAttemptAt > NATIVE_RECOVERY_WINDOW_MS) {
                state = { count: 0, lastAttemptAt: 0 };
            }
            const isLiveRecovery = itemType === 'channel' || itemType === 'live';
            if (!isLiveRecovery && state.count >= NATIVE_RECOVERY_MAX) {
                surfaceNativeRecoveryFailure(reason || 'retry_limit');
                return 'exhausted';
            }
            const attempt = state.count;
            const scheduledGeneration = nativeIntentGeneration;
            state.count += 1;
            state.lastAttemptAt = now;
            nativeRecoveryAttempts.set(key, state);
            const resume = Math.max(0, Math.floor(Number(positionSeconds) || 0));
            setTimeout(async () => {
                if (scheduledGeneration !== nativeIntentGeneration
                    || activeNativeIntentKey !== key
                    || currentNativeRoute() !== activeNativeIntentRoute
                    || nativeRecoveryLaunchers.get(key) !== entry) {
                    console.info('[Native] Cancelled stale playback recovery for', key);
                    return;
                }
                try {
                    window.__norvaResetPlayThrottle?.();
                    await entry.launcher(resume);
                } catch (error) {
                    console.warn(`[Native] Fresh playback retry ${attempt + 1} failed:`, error?.message || error);
                    window.__norvaNative.retryPlayback(sourceId, itemType, itemId, resume, reason || 'resolve_failed');
                }
            }, isLiveRecovery
                ? (NATIVE_LIVE_RECOVERY_DELAYS_MS[attempt]
                    || NATIVE_LIVE_RECOVERY_DELAYS_MS[NATIVE_LIVE_RECOVERY_DELAYS_MS.length - 1])
                : (NATIVE_RECOVERY_DELAYS_MS[attempt]
                    || NATIVE_RECOVERY_DELAYS_MS[NATIVE_RECOVERY_DELAYS_MS.length - 1]));
            return 'scheduled';
        };

        // Native track labels are fail-closed: only exact-file catalogue
        // evidence crosses the bridge. Provider/category prose (Netflix,
        // Nordic, "Audio 2", Unknown, ...) is never copied into this payload.
        const NATIVE_ACCEPTED_AUDIO_EVIDENCE = new Set([
            'verified', 'verified_union', 'probed', 'probed_union'
        ]);
        const safeNativeTrackLanguage = (value) => {
            const raw = String(value || '').trim().toLowerCase().replace(/_/g, '-');
            const base = raw.split('-')[0];
            return /^[a-z]{2,3}$/.test(base) && !['und', 'unk', 'mul', 'mis'].includes(base)
                ? base
                : '';
        };
        const normalizeNativeTrack = (track) => {
            if (!track || typeof track !== 'object') return null;
            const normalized = {};
            const index = Number(track.index ?? track.streamIndex ?? track.stream_index);
            if (Number.isInteger(index) && index >= 0) normalized.index = index;
            const id = String(track.id || track.trackId || track.track_id || '').trim();
            if (/^[a-z0-9._:+/-]{1,120}$/i.test(id)) normalized.id = id;
            const language = safeNativeTrackLanguage(
                track.lang || track.language || track.iso_639_1 || track.iso639 || track.code
            );
            if (language) normalized.lang = language;
            const codec = String(track.codec || '').trim().toLowerCase();
            if (/^[a-z0-9._+-]{1,16}$/.test(codec)) normalized.codec = codec;
            const channels = Number(track.channels ?? track.channelCount ?? track.channel_count);
            if (Number.isInteger(channels) && channels > 0 && channels <= 32) {
                normalized.channels = channels;
            }
            if (track.forced === true || track.isForced === true || track.is_forced === true) {
                normalized.forced = true;
            }
            if (track.sdh === true || track.hearingImpaired === true || track.hearing_impaired === true) {
                normalized.sdh = true;
            }
            const role = String(track.role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            if (['main', 'original', 'dub', 'audio_description', 'commentary',
                'full', 'forced', 'sdh'].includes(role)) {
                normalized.role = role;
            }
            if (track.default === true || track.isDefault === true || track.is_default === true) {
                normalized.default = true;
            }
            return normalized;
        };
        const buildNativeTrackMetadata = (content) => {
            if (!content || typeof content !== 'object') return null;
            const audioStatus = String(
                content.audioLanguageValidationStatus ||
                content.audio_language_validation_status ||
                ''
            ).toLowerCase();
            const audioScope = String(
                content.audioTracksScope || content.audio_tracks_scope || ''
            ).toLowerCase();
            const subtitleScope = String(
                content.subtitleTracksScope || content.subtitle_tracks_scope || ''
            ).toLowerCase();
            const rawAudioTracks = Array.isArray(content.audioTracks)
                ? content.audioTracks
                : (Array.isArray(content.audio_tracks) ? content.audio_tracks : []);
            const rawSubtitleTracks = Array.isArray(content.subtitleTracks)
                ? content.subtitleTracks
                : (Array.isArray(content.subtitle_tracks) ? content.subtitle_tracks : []);
            const audioTracks = audioScope === 'file' && NATIVE_ACCEPTED_AUDIO_EVIDENCE.has(audioStatus)
                ? rawAudioTracks.slice(0, 64).map(normalizeNativeTrack).filter(Boolean)
                : [];
            const subtitleTracks = subtitleScope === 'file'
                ? rawSubtitleTracks.slice(0, 64).map(normalizeNativeTrack).filter(Boolean)
                : [];
            let burnedSubtitle = null;
            // The catalogue can explicitly prove that the current file has no
            // selectable subtitle stream while its title/category carries one
            // of Norva's established burned-in markers (AR-SUBS, Persian SUB,
            // and similar). Reuse the same conservative detector as the web
            // player so native never presents an impossible "Off" action.
            if (subtitleScope === 'file' && rawSubtitleTracks.length === 0) {
                try {
                    const subtitle = window.MediaUtils?.deriveTrackIntel?.({
                        title: content.title || content.name || '',
                        category: content.category || content.categoryName || content.group || '',
                        hasSubtitleStream: false,
                        originalLanguage: content.originalLanguage || content.original_language || ''
                    })?.subtitle;
                    if (subtitle?.type === 'burned-in') {
                        const language = safeNativeTrackLanguage(subtitle.code);
                        burnedSubtitle = language ? { lang: language } : {};
                    }
                } catch (_) {
                    burnedSubtitle = null;
                }
            }
            if (!audioTracks.length && !subtitleTracks.length && !burnedSubtitle) return null;
            return {
                audioValidationStatus: audioTracks.length ? audioStatus : '',
                audioTracksScope: audioTracks.length ? 'file' : '',
                audioTracks,
                subtitleTracksScope: subtitleTracks.length ? 'file' : '',
                subtitleTracks,
                ...(burnedSubtitle ? { burnedSubtitle } : {})
            };
        };
        const nativePlay = (streamUrl, title, meta, resumeSeconds, fallbackUrl, extras) => {
            const nowTs = Date.now();
            if (nowTs - lastNativePlayAt < 1500) return false;
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
                    trackMetadata: extras?.trackMetadata || null,
                    preferenceScope: extras?.preferenceScope || null,
                    playbackPreferences: extras?.playbackPreferences || null,
                    // Live quality variants (label + streamId + sourceId) for the native
                    // player's quality menu. Metadata only, never pre-resolved URLs: a live
                    // gateway grants ONE slot, so resolving each variant up front would close
                    // the playing session. The native player reports the pick back and the web
                    // re-resolves + relaunches it (see __norvaPlayVariant).
                    variants: Array.isArray(extras?.variants) ? extras.variants : [],
                    activeStreamId: extras?.activeStreamId ? String(extras.activeStreamId) : ''
                }));
                return true;
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
                return true;
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
                return true;
            }
            if (meta && typeof bridge.playVideoWithMeta === 'function') {
                bridge.playVideoWithMeta(
                    streamUrl,
                    title,
                    String(meta.sourceId || ''),
                    meta.itemType || '',
                    String(meta.itemId || '')
                );
                return true;
            }
            bridge.playVideo(streamUrl, title);
            return true;
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

        const nativePreferenceScope = (content) => {
            let accountId = '';
            let profileId = '';
            try {
                const session = JSON.parse(localStorage.getItem('norva-cloud-session') || 'null');
                accountId = String(session?.user?.id || localStorage.getItem('norva-cloud-device-id') || '');
                profileId = String(
                    window.NorvaCloud?.profiles?.getActiveId?.()
                    || localStorage.getItem('norva-active-profile-id')
                    || ''
                );
            } catch (_) { /* scoped local fallback below */ }
            const rawVersionKey = content?.versionKey
                || content?.version_key
                || content?.streamId
                || content?.stream_id
                || content?.id
                || '';
            return {
                accountId: accountId.slice(0, 160),
                profileId: profileId.slice(0, 160),
                seriesId: String(content?.seriesId || content?.series_id || '').slice(0, 160),
                versionKey: String(rawVersionKey).slice(0, 200)
            };
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

        // Structured next episode for the history blob, computed from the LAUNCH payload
        // (content.seriesInfo travels with the fiche's play call) — the web player computes the
        // same thing from instance state, but the native override never sets that state. Without
        // this, a binge on the TV never advanced the "up next" card of the other devices.
        const computeNextEpisode = (content) => {
            try {
                const info = content?.seriesInfo;
                if (content?.type !== 'series' || !info?.episodes || !content.currentSeason || !content.currentEpisode) return null;
                const seasons = Object.keys(info.episodes).sort((a, b) => parseInt(a) - parseInt(b));
                const cur = info.episodes[content.currentSeason] || [];
                const i = cur.findIndex(ep => parseInt(ep.episode_num) === parseInt(content.currentEpisode));
                let nextEp = null;
                if (i >= 0 && i < cur.length - 1) {
                    nextEp = { ...cur[i + 1], seasonNum: content.currentSeason };
                } else {
                    const si = seasons.indexOf(String(content.currentSeason));
                    const nx = (si >= 0 && si < seasons.length - 1) ? info.episodes[seasons[si + 1]] : null;
                    if (nx && nx.length) nextEp = { ...nx[0], seasonNum: seasons[si + 1] };
                }
                if (!nextEp) return null;
                return {
                    id: nextEp.id || null,
                    season: nextEp.seasonNum || null,
                    episode: nextEp.episode_num || null,
                    title: nextEp.title || null,
                    containerExtension: nextEp.container_extension || 'mp4',
                    duration: nextEp.duration || null
                };
            } catch (_) { return null; }
        };

        if (window.WatchPage) {
            WatchPage.prototype.play = async function (content, streamUrl, playback) {
                const initialMeta = contentMeta(content);
                if (initialMeta && !beginNativePlaybackIntent(
                    initialMeta.sourceId,
                    initialMeta.itemType,
                    initialMeta.itemId
                )) return;
                // Cross-device resume for the native player. content.resumeTime comes from the
                // launcher card, which can be up to ~80 s stale (or days, via the SWR paint) —
                // ALWAYS ask the server and prefer its answer when it responds (audit 2026-07-17
                // P1: the stale card used to short-circuit a fresher position written by another
                // device). An ANSWERED 0 restarts honestly (finished/removed elsewhere); no
                // answer (offline, older backend) keeps the transmitted offset.
                let effectiveResume = Math.max(0, Math.floor(Number(content.resumeTime) || 0));
                try {
                    if (typeof this._fetchServerResumeInfo === 'function') {
                        const server = await this._fetchServerResumeInfo(content);
                        if (server && server.answered) effectiveResume = Math.max(0, Math.floor(Number(server.position) || 0));
                    } else if (effectiveResume <= 0 && typeof this._fetchServerResumePosition === 'function') {
                        const serverPos = await this._fetchServerResumePosition(content);
                        if (Number(serverPos) > 0) effectiveResume = Math.floor(Number(serverPos));
                    }
                } catch (_) { /* best-effort */ }
                try {
                    const meta = contentMeta(content);
                    // Data parity with the web player's history blob (audit 2026-07-17 P2): the
                    // native path also carries playbackPreferences + nextEpisode, so audio/subtitle
                    // choices and the "up next" card follow the user off the TV.
                    const nextEpisode = computeNextEpisode(content);
                    const dataBlob = {
                        title: content.title,
                        subtitle: content.subtitle || '',
                        poster: content.poster,
                        sourceId: content.sourceId,
                        seriesId: content.seriesId || null,
                        currentSeason: content.currentSeason || null,
                        currentEpisode: content.currentEpisode || null,
                        containerExtension: content.containerExtension || 'mp4',
                        ...(Number(content.durationHint) > 0 ? { durationHint: Math.floor(Number(content.durationHint)) } : {}),
                        ...(content.playbackPreferences ? { playbackPreferences: content.playbackPreferences } : {}),
                        ...(nextEpisode ? { nextEpisode } : {})
                    };
                    if (meta) {
                        nativeProgressMeta.set(nativeProgressKey(meta.sourceId, meta.itemType, meta.itemId), {
                            duration: content.durationHint || 0,
                            data: { ...dataBlob, durationHint: content.durationHint || 0 }
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
                        watchedAt: new Date().toISOString(),
                        data: dataBlob
                    })?.catch?.(() => { });
                } catch (e) { /* history is best-effort */ }
                const meta = initialMeta;
                const launchResolved = async (resumeAt, fresh = false) => {
                    let resolved;
                    if (fresh && meta && window.API?.proxy?.xtream?.getStreamUrl) {
                        const container = content.containerExtension || 'mp4';
                        const streamType = content.type === 'movie' ? 'movie' : 'series';
                        const catalogPage = streamType === 'movie'
                            ? window.app?.pages?.movies
                            : window.app?.pages?.series;
                        await catalogPage?.prepareForPlaybackSession?.();
                        const hint = (typeof MediaUtils !== 'undefined' && MediaUtils.playbackHintFromItem)
                            ? MediaUtils.playbackHintFromItem(content, { container, streamType })
                            : { container, streamType };
                        resolved = await window.API.proxy.xtream.getStreamUrl(
                            content.sourceId,
                            content.id,
                            streamType,
                            container,
                            hint
                        );
                    } else {
                        resolved = await resolveStreamPayload(streamUrl);
                    }
                    if (!resolved.url) throw new Error('No fresh stream URL returned');
                    // fallbackUrl: the resolver payload carries it for the movie/series
                    // path; the restore-after-refresh path passes it as the 3rd arg.
                    const fallbackUrl = resolved.fallbackUrl || (playback && playback.fallbackUrl) || null;
                    if (!nativePlay(resolved.url, nativeTitle(content), meta, resumeAt, fallbackUrl, {
                        poster: content.poster || '',
                        nextTitle: content.nextEpisodeLabel || '',
                        trackMetadata: buildNativeTrackMetadata(content),
                        preferenceScope: nativePreferenceScope(content),
                        playbackPreferences: content.playbackPreferences
                            || content.playback_preferences
                            || null
                    })) {
                        throw new Error('Native relaunch throttled');
                    }
                };
                registerNativeRecovery(meta, (resumeAt) => launchResolved(resumeAt, true));
                await launchResolved(effectiveResume);
            };
        }

        if (window.VideoPlayer) {
            VideoPlayer.prototype.play = async function (channel, streamUrl, playback) {
                const meta = channelMeta(channel);
                const forwardedIntentClaim = channel?.__norvaNativeIntentClaim || '';
                if (forwardedIntentClaim) {
                    try { delete channel.__norvaNativeIntentClaim; } catch (_) {
                        channel.__norvaNativeIntentClaim = null;
                    }
                }
                const consumedIntentClaim = meta && forwardedIntentClaim
                    ? consumeNativePlaybackIntent(
                        meta.sourceId,
                        meta.itemType,
                        meta.itemId,
                        forwardedIntentClaim
                    )
                    : false;
                if (meta && !consumedIntentClaim
                    && !beginNativePlaybackIntent(meta.sourceId, meta.itemType, meta.itemId)) return;
                this.currentChannel = channel;
                const initialLiveSessionId = channel?.cloudPlaybackSessionId
                    || channel?.playbackSessionId
                    || playback?.sessionId
                    || playback?.cloudPlaybackSessionId
                    || null;
                if (initialLiveSessionId && typeof this.registerCloudPlaybackSession === 'function') {
                    this.registerCloudPlaybackSession(initialLiveSessionId);
                }
                const releasePreviousLiveSession = async () => {
                    const staleSessionId = channel?.cloudPlaybackSessionId
                        || channel?.playbackSessionId
                        || this.currentCloudPlaybackSessionId
                        || null;
                    if (staleSessionId && typeof this.registerCloudPlaybackSession === 'function') {
                        this.registerCloudPlaybackSession(staleSessionId);
                    }
                    if (typeof this.prepareLiveSwitch === 'function') {
                        // prepareLiveSwitch waits for stopCloudPlaybackSessions, so the
                        // old provider lane is fully released before getStreamUrl creates
                        // the replacement. This strict ordering protects one-slot accounts.
                        await this.prepareLiveSwitch();
                    } else if (staleSessionId) {
                        const cloud = window.NorvaCloud;
                        const playbackApi = cloud?.token
                            ? cloud?.playback
                            : (cloud?.device?.playback || cloud?.playback);
                        await playbackApi?.expireSession?.(String(staleSessionId));
                    }
                    channel.cloudPlaybackSessionId = null;
                    if (channel.playbackSessionId != null) channel.playbackSessionId = null;
                };
                const relaunchLive = async () => {
                    let fresh;
                    const liveStreamId = channel?.streamId ?? channel?.stream_id ?? channel?.id;
                    const canResolveXtream = channel?.sourceType === 'xtream'
                        || (!channel?.url && channel?.sourceId && liveStreamId != null);
                    if (canResolveXtream && window.API?.proxy?.xtream?.getStreamUrl) {
                        const providerContainer =
                            channel.container_extension ||
                            channel.containerExtension ||
                            channel.container ||
                            'ts';
                        const cl = window.app?.channelList;
                        const transcodeKey = `${channel.sourceId}:${channel.id}`;
                        const forceLiveTranscode = Boolean(cl?._forceTranscode?.has?.(transcodeKey));
                        const gatewayMode = forceLiveTranscode
                            ? 'transcode'
                            : ((typeof MediaUtils !== 'undefined' && MediaUtils.liveGatewayMode)
                                ? MediaUtils.liveGatewayMode(channel)
                                : 'transcode');
                        await releasePreviousLiveSession();
                        fresh = await window.API.proxy.xtream.getStreamUrl(
                            channel.sourceId,
                            liveStreamId,
                            'live',
                            providerContainer,
                            {
                                gatewayMode,
                                ...(forceLiveTranscode ? { liveForceTranscode: '1' } : {})
                            }
                        );
                        channel.cloudPlaybackSessionId = fresh?.sessionId || null;
                        if (channel.cloudPlaybackSessionId
                            && typeof this.registerCloudPlaybackSession === 'function') {
                            this.registerCloudPlaybackSession(channel.cloudPlaybackSessionId);
                        }
                        if (fresh?.cloudSourceId) channel.cloudSourceId = fresh.cloudSourceId;
                    } else {
                        fresh = { url: channel?.url || null, fallbackUrl: null };
                    }
                    if (!fresh?.url) throw new Error('No fresh live stream URL returned');
                    if (!nativePlay(fresh.url, channel?.name || 'Live TV', meta, 0, fresh.fallbackUrl || null, {
                        variants: buildNativeVariants(channel),
                        activeStreamId: channel?.streamId != null ? String(channel.streamId) : ''
                    })) {
                        throw new Error('Native live relaunch throttled');
                    }
                };
                registerNativeRecovery(meta, relaunchLive);
                const resolved = await resolveStreamPayload(streamUrl);
                if (!resolved.url) return;
                // Live resolves to a bare URL string (ChannelList passes result.url), so
                // resolveStreamPayload yields fallbackUrl=null. Recover the gateway
                // byte-pipe fallback from the resolver payload (3rd arg) so a native live
                // channel gets the same direct→gateway recovery as VOD.
                const fallbackUrl = resolved.fallbackUrl || (playback && playback.fallbackUrl) || null;
                nativePlay(resolved.url, channel?.name || 'Live TV', meta, 0, fallbackUrl, {
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
    };
    // Deferred scripts run while readyState is "interactive", before the later
    // deferred WatchPage/VideoPlayer scripts have defined their classes. Wait
    // for DOMContentLoaded in both loading and interactive states so the native
    // prototypes are installed only after every deferred dependency is ready.
    if (document.readyState !== 'complete') {
        document.addEventListener('DOMContentLoaded', installNativeOverrides, { once: true });
    } else {
        installNativeOverrides();
    }

    console.log(`[Native] Playback bridge active (${isStandalone ? 'standalone' : 'cloud'})`);
        return true;
    };

    if (bootNativeBridge()) return;
    // Some WebView builds expose an addJavascriptInterface object a few ticks
    // after deferred scripts begin executing. The previous one-shot check then
    // left WatchPage on the embedded browser player for the whole session. Retry
    // only in a native-looking shell and install immediately even if DOMContentLoaded
    // has already fired.
    const nativeShellExpected = /NorvaTV-/i.test(navigator.userAgent || '')
        || /[?&]mobile=1\b/.test(window.location.search || '');
    if (!nativeShellExpected) return;
    let bridgeAttempts = 0;
    const bridgeTimer = window.setInterval(() => {
        bridgeAttempts += 1;
        if (bootNativeBridge() || bridgeAttempts >= 100) {
            window.clearInterval(bridgeTimer);
        }
    }, 100);
})();
