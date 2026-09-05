/**
 * Shared TV service health classifier.
 *
 * The classifier stays conservative on purpose: if an IPTV provider returns a
 * vague network error, Norva asks the user to wait/retry instead of forcing a
 * credential repair that may be wrong.
 */
(function () {
    const STATE_META = {
        not_configured: {
            severity: 5,
            label: (globalThis.NorvaI18n?.t("ui_web_0303e1824670", { defaultValue: "Not connected" }) ?? 'Not connected'),
            title: (globalThis.NorvaI18n?.t("ui_web_9fa1c18bb4b5", { defaultValue: "Connect your TV service" }) ?? 'Connect your TV service'),
            message: (globalThis.NorvaI18n?.t("ui_web_b5bd4db2a30d", { defaultValue: "Add a provider account or playlist link to start watching." }) ?? 'Add a provider account or playlist link to start watching.'),
            action: (globalThis.NorvaI18n?.t("ui_web_ecf6dd26c319", { defaultValue: "Connect TV service" }) ?? 'Connect TV service')
        },
        syncing: {
            severity: 1,
            label: (globalThis.NorvaI18n?.t("ui_web_0dfe1d63c9d8", { defaultValue: "Checking" }) ?? 'Checking'),
            title: (globalThis.NorvaI18n?.t("ui_web_15349f77f124", { defaultValue: "Preparing your TV service" }) ?? 'Preparing your TV service'),
            message: (globalThis.NorvaI18n?.t("ui_web_a6f1ccb9f803", { defaultValue: "Norva is importing your channels, movies and series. A large library can take a while — you can start watching as titles appear." }) ?? 'Norva is importing your channels, movies and series. A large library can take a while — you can start watching as titles appear.'),
            action: (globalThis.NorvaI18n?.t("ui_web_dc2a62fb3391", { defaultValue: "View service" }) ?? 'View service')
        },
        ready: {
            severity: 0,
            label: (globalThis.NorvaI18n?.t("ui_web_5fa7aac5375c", { defaultValue: "Ready" }) ?? 'Ready'),
            title: (globalThis.NorvaI18n?.t("ui_web_766bd5403459", { defaultValue: "TV service ready" }) ?? 'TV service ready'),
            message: (globalThis.NorvaI18n?.t("ui_web_13e44bdca227", { defaultValue: "Your catalog is ready to watch." }) ?? 'Your catalog is ready to watch.'),
            action: (globalThis.NorvaI18n?.t("ui_web_a23b096cabd0", { defaultValue: "Manage service" }) ?? 'Manage service')
        },
        disabled: {
            severity: 0,
            label: (globalThis.NorvaI18n?.t("ui_web_75081b593d15", { defaultValue: "Disabled" }) ?? 'Disabled'),
            title: (globalThis.NorvaI18n?.t("ui_web_0139f3c27706", { defaultValue: "TV service paused" }) ?? 'TV service paused'),
            message: (globalThis.NorvaI18n?.t("ui_web_3d439b51ff45", { defaultValue: "This service is paused. Its saved catalog will return when you enable it." }) ?? 'This service is paused. Its saved catalog will return when you enable it.'),
            action: (globalThis.NorvaI18n?.t("ui_web_a23b096cabd0", { defaultValue: "Manage service" }) ?? 'Manage service')
        },
        degraded: {
            severity: 3,
            label: (globalThis.NorvaI18n?.t("ui_web_c1ebc7817870", { defaultValue: "Needs attention" }) ?? 'Needs attention'),
            title: (globalThis.NorvaI18n?.t("ui_web_82155b6ef5b5", { defaultValue: "TV service needs attention" }) ?? 'TV service needs attention'),
            message: (globalThis.NorvaI18n?.t("ui_web_82eec2e53ba3", { defaultValue: "Some content may be unavailable. Try syncing again or check the provider details." }) ?? 'Some content may be unavailable. Try syncing again or check the provider details.'),
            action: (globalThis.NorvaI18n?.t("ui_web_92d7d3033ab0", { defaultValue: "Repair service" }) ?? 'Repair service')
        },
        auth_failed: {
            severity: 4,
            label: (globalThis.NorvaI18n?.t("ui_web_5483db957f58", { defaultValue: "Update login" }) ?? 'Update login'),
            title: (globalThis.NorvaI18n?.t("ui_web_2b58f12c3b02", { defaultValue: "Update TV service login" }) ?? 'Update TV service login'),
            message: (globalThis.NorvaI18n?.t("ui_web_289baf2fea08", { defaultValue: "The provider refused the saved login. Update the username or password to restore access." }) ?? 'The provider refused the saved login. Update the username or password to restore access.'),
            action: (globalThis.NorvaI18n?.t("ui_web_5483db957f58", { defaultValue: "Update login" }) ?? 'Update login')
        },
        expired: {
            severity: 4,
            label: (globalThis.NorvaI18n?.t("ui_web_424a2551d356", { defaultValue: "Expired" }) ?? 'Expired'),
            title: (globalThis.NorvaI18n?.t("ui_web_a0ac8434fff6", { defaultValue: "TV service may be expired" }) ?? 'TV service may be expired'),
            message: (globalThis.NorvaI18n?.t("ui_web_0466029814e9", { defaultValue: "The provider reports an inactive or expired account. Renew it, then update the login if needed." }) ?? 'The provider reports an inactive or expired account. Renew it, then update the login if needed.'),
            action: (globalThis.NorvaI18n?.t("ui_web_6a61c5f85fef", { defaultValue: "Update service" }) ?? 'Update service')
        },
        provider_changed: {
            severity: 4,
            label: (globalThis.NorvaI18n?.t("ui_web_f3bfa948a110", { defaultValue: "Review service" }) ?? 'Review service'),
            title: (globalThis.NorvaI18n?.t("ui_web_6667254de8e3", { defaultValue: "Review your TV service" }) ?? 'Review your TV service'),
            message: (globalThis.NorvaI18n?.t("ui_web_ff5da28287c3", { defaultValue: "The provider address or account endpoint is no longer available. Review the access dates and login before syncing again." }) ?? 'The provider address or account endpoint is no longer available. Review the access dates and login before syncing again.'),
            action: (globalThis.NorvaI18n?.t("ui_web_5ddb6f051115", { defaultValue: "Review access" }) ?? 'Review access')
        },
        unreachable: {
            severity: 3,
            label: (globalThis.NorvaI18n?.t("ui_web_ca1844969742", { defaultValue: "Unavailable" }) ?? 'Unavailable'),
            title: (globalThis.NorvaI18n?.t("ui_web_9897f6dd7734", { defaultValue: "TV service unavailable" }) ?? 'TV service unavailable'),
            message: (globalThis.NorvaI18n?.t("ui_web_7994d081a45b", { defaultValue: "Norva cannot reach the provider right now. It may be a temporary outage." }) ?? 'Norva cannot reach the provider right now. It may be a temporary outage.'),
            action: (globalThis.NorvaI18n?.t("ui_web_54c4d87263b2", { defaultValue: "Check service" }) ?? 'Check service')
        }
    };

    function string(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function lower(value) {
        return string(value).toLowerCase();
    }

    const SYNCING_STATES = new Set([
        'syncing',
        'pending',
        'checking',
        'connecting',
        'discovering',
        'discovered',
        'importing',
        'materializing',
        'building_titles',
        'building_live_channels',
        'building_live_variants',
        'finalizing'
    ]);
    const READY_STATES = new Set(['ready', 'success', 'synced', 'complete', 'completed']);
    const FAILURE_STATES = new Set(['error', 'failed', 'auth_failed', 'expired', 'unreachable', 'revoked', 'disabled']);
    const EXPLICIT_ATTENTION_STATES = new Set(['auth_failed', 'expired', 'unreachable']);
    const CATALOG_CATEGORIES = ['live', 'movies', 'series'];

    function sourceId(source = {}) {
        source = source || {};
        return string(source.id || source.source_id || source.sourceId || source.cloudId || source.cloud_id);
    }

    function sourceType(source = {}) {
        source = source || {};
        return string(source.type || source.source_type || source.sourceType || 'xtream') || 'xtream';
    }

    // `enabled` on a normalized source is the effective catalogue visibility
    // (`managementEnabled && catalogVisible`). It must not be used on its own to
    // decide whether the user intentionally paused the provider. Prefer the
    // explicit management fields and keep the legacy fallback for raw sources.
    function sourceManagementEnabled(source = {}) {
        if (typeof source.managementEnabled === 'boolean') return source.managementEnabled;
        if (typeof source.sourceEnabled === 'boolean') return source.sourceEnabled;
        return source.enabled !== false;
    }

    function statusFor(source, statuses = []) {
        const id = sourceId(source);
        return (statuses || []).find(status => {
            const candidate = sourceId(status);
            return candidate && id && candidate === id;
        }) || {};
    }

    function progressFor(source = {}, status = {}) {
        const config = source.configHint || source.config_hint || {};
        const progress = source.syncProgress ||
            source.sync_progress ||
            config.syncProgress ||
            config.sync_progress ||
            status.syncProgress ||
            status.sync_progress ||
            {};
        return progress && typeof progress === 'object' && !Array.isArray(progress) ? progress : {};
    }

    // True when the source has already finished at least one full sync: its
    // catalog is materialized and stays usable while a later refresh runs. This
    // tells an *initial* import (which must gate the app behind "Preparing your
    // catalog") apart from a routine background *re-sync* (which must NOT throw
    // an already-onboarded user back to the import screen). The signal of record
    // is config_hint.lastSync — the summary of the last *completed* sync, which
    // is distinct from the in-flight syncProgress and only stamped on success.
    function hasCompletedCatalog(source = {}, status = {}) {
        const config = source.configHint || source.config_hint || {};
        const last = config.lastSync || config.last_sync ||
            source.lastSync || source.last_sync_result || status.lastSync || {};
        if (last && typeof last === 'object' && !Array.isArray(last)) {
            if (last.syncedAt || last.synced_at) return true;
            const total = Number(
                last.total ?? last.items ?? last.movies ?? last.series ?? last.live ?? 0
            );
            if (Number.isFinite(total) && total > 0) return true;
        }
        // catalog_version defaults to 1 at source creation — BEFORE any sync completes —
        // so `> 0` wrongly marks a fresh initial import as "already built", which downgrades
        // its classification from `syncing` to `ready` and hides the onboarding progress gate
        // behind an empty Home. A genuinely completed catalogue is signalled by
        // config.lastSync.syncedAt (set by finalize) checked above; require `> 1` here so this
        // fallback only fires if catalog_version is ever actually bumped on completion.
        const catalogVersion = Number(source.catalog_version ?? source.catalogVersion ?? 0);
        return Number.isFinite(catalogVersion) && catalogVersion > 1;
    }

    // `cloud_sources.last_synced_at` is the timestamp of the last *attempt* and
    // is intentionally updated on failure to bound retry pressure. It must not
    // be presented as "Catalogue updated". The completed summary stored in
    // config_hint.lastSync is the success authority; scalar fallbacks are only
    // accepted when the current source/status has no failure signal.
    function completedSyncAt(source = {}, status = {}) {
        const config = source.configHint || source.config_hint || {};
        const summaries = [
            config.lastSync,
            config.last_sync,
            source.last_sync_result,
            status.last_sync_result
        ];
        for (const summary of summaries) {
            if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
            const timestamp = summary.syncedAt || summary.synced_at || summary.completedAt || summary.completed_at;
            if (timestamp) return timestamp;
        }

        const rawStatus = lower(
            source.sync_status || source.syncStatus || status.status || status.sync_status || ''
        );
        const error = string(source.sync_error || source.syncError || status.error || status.sync_error || '');
        if (error || FAILURE_STATES.has(rawStatus)) return null;

        const direct = source.lastSync || source.last_sync || status.lastSync || status.last_sync;
        if (direct && typeof direct !== 'object') return direct;
        if (READY_STATES.has(rawStatus)) {
            return source.last_synced_at || source.lastSyncedAt || status.last_synced_at || status.lastSyncedAt || null;
        }
        return null;
    }

    // Canonical classification — MIRROR of
    // supabase/functions/_shared/source-sync-error.mjs (authoritative; the
    // browser cannot import from supabase/functions). Behaviour parity is locked
    // by tests/source-error-kind-parity.test.js. Change one, change both.
    //
    // Order is busy > expired > auth > infra. This file used to check auth
    // BEFORE expired while the ops alert checked expired first, so a panel
    // saying "401 subscription expired" got one verdict in the app and a
    // different one in the alert. The expiry is the CAUSE and the 401 only its
    // symptom, so "renew your subscription" outranks "check your credentials".
    //
    // Patterns are the UNION of what the two copies used to match. Two
    // deliberate exceptions, both documented in the authoritative copy: bare
    // `username`/`password`/`login` are gone (redaction rewrites Xtream URLs to
    // `username=***`, which would have made a 502 outage read as auth), and
    // `paid` is kept because this file already matched it in production.
    const BUSY_PATTERN = /\b(458|user_multi_ip|account[_\s-]*shar|account[_\s-]*busy|already in use|max(?:imum)?[_\s-]*conn|slot[_\s-]*busy)\b/;
    const EXPIRED_PATTERN = /\b(expired|expire|inactive|disabled|banned|subscription|renew|unpaid|paid|trial ended)\b/;
    const NOT_FOUND_PATTERN = /(?:^|\D)404(?:\D|$)|\b(not found|endpoint missing|unknown account)\b/;
    const AUTH_PATTERN = /\b(401|403|unauthorized|forbidden|auth|auth[_\s-]*fail|authentication|credential|credentials|invalid user|invalid pass|invalid password|invalid login|bad password|wrong password)\b/;
    const INFRA_PATTERN = /\b(media gateway|gateway refused|refused|500|502|503|504|timeout|timed out|econn|enotfound|dns|network|unreachable|service unavailable|temporarily unavailable)\b/;

    const ERROR_KIND_LABELS = {
        busy: (globalThis.NorvaI18n?.t("ui_web_6a447edfb5f4", { defaultValue: "Slot occupé" }) ?? 'Slot occupé'),
        expired: (globalThis.NorvaI18n?.t("ui_web_49615a499cd3", { defaultValue: "Abonnement terminé" }) ?? 'Abonnement terminé'),
        not_found: (globalThis.NorvaI18n?.t("ui_web_c8b7e0593303", { defaultValue: "Service introuvable" }) ?? 'Service introuvable'),
        auth: (globalThis.NorvaI18n?.t("ui_web_7ed82935140a", { defaultValue: "Identifiants rejetés" }) ?? 'Identifiants rejetés'),
        infra: (globalThis.NorvaI18n?.t("ui_web_001e2d993184", { defaultValue: "Panne passerelle" }) ?? 'Panne passerelle'),
        unknown: (globalThis.NorvaI18n?.t("ui_web_93f82b62c4f6", { defaultValue: "Erreur non classée" }) ?? 'Erreur non classée')
    };

    function classifyErrorKind(text) {
        const error = lower(String(text || ''));
        if (BUSY_PATTERN.test(error)) return 'busy';
        if (EXPIRED_PATTERN.test(error)) return 'expired';
        if (NOT_FOUND_PATTERN.test(error)) return 'not_found';
        if (AUTH_PATTERN.test(error)) return 'auth';
        if (INFRA_PATTERN.test(error)) return 'infra';
        return 'unknown';
    }

    // Kind -> the state vocabulary the rest of this file and its callers already
    // switch on. `busy` maps to degraded ON PURPOSE: a busy slot clears itself
    // when the other device stops, and degraded keeps an already-built catalog
    // usable. That is also exactly what happened before, since no pattern here
    // matched 458 at all — so unifying adds a name, not a behaviour change.
    const KIND_TO_STATE = {
        busy: 'degraded',
        expired: 'expired',
        not_found: 'provider_changed',
        auth: 'auth_failed',
        infra: 'unreachable',
        unknown: 'degraded'
    };

    function classifyError(errorText, rawStatus = '') {
        const error = lower(`${rawStatus} ${errorText}`);
        if (!error.trim()) return 'degraded';
        return KIND_TO_STATE[classifyErrorKind(error)] || 'degraded';
    }

    function providerAccessActionState(source = {}) {
        const status = lower(
            source.provider_access_status || source.providerAccessStatus || ''
        );
        if (status === 'expired_confirmed') return 'expired';
        if (status === 'access_unavailable_confirmed') return 'provider_changed';
        return '';
    }

    function autoRefreshActionState(source = {}) {
        const state = source.auto_refresh_state || source.autoRefreshState || {};
        if (!state || typeof state !== 'object' || Array.isArray(state) || state.actionRequired !== true) return '';
        const status = Number(state.terminalHttpStatus ?? state.lastHttpStatus);
        if (status === 404) return 'provider_changed';
        if (status === 401 || status === 403) {
            return lower(state.terminalErrorKind || state.lastErrorKind) === 'expired' ? 'expired' : 'auth_failed';
        }
        return '';
    }

    function classifySource(source = {}, statuses = []) {
        const status = statusFor(source, statuses);
        const progress = progressFor(source, status);
        const rawStatus = lower(
            source.sync_status ||
            source.syncStatus ||
            status.status ||
            status.sync_status ||
            progress.status ||
            progress.stage ||
            'idle'
        );
        const progressStatus = lower(progress.status || progress.stage || '');
        const progressStage = lower(progress.stage || '');
        const error = string(source.sync_error || source.syncError || status.error || status.sync_error || '');
        const lastSync = completedSyncAt(source, status);
        const managementEnabled = sourceManagementEnabled(source);
        const revoked = source.revoked === true;
        const providerAccessAction = providerAccessActionState(source);
        const autoRefreshAction = autoRefreshActionState(source);
        const autoRefreshState = source.auto_refresh_state || source.autoRefreshState || {};
        const terminalFailureCount = Number(autoRefreshState.terminalFailureCount ?? 0);
        const autoRefreshActionConfirmed = autoRefreshAction && (
            autoRefreshState.suspended === true ||
            (Number.isFinite(terminalFailureCount) && terminalFailureCount >= 2)
        );

        let state = 'degraded';
        let refreshing = false;
        let retrying = false;
        if (!managementEnabled) {
            state = 'disabled';
        } else if (revoked) {
            state = 'degraded';
        } else if (providerAccessAction) {
            // Provider Access is the account-level authority. Only its
            // confirmed terminal states block a catalogue that was previously
            // ready; a first scheduler observation is deliberately retried by
            // the database before Norva asks the user to repair anything.
            state = providerAccessAction;
        } else if (autoRefreshAction && (
            autoRefreshActionConfirmed || !hasCompletedCatalog(source, status)
        )) {
            state = autoRefreshAction;
        } else if (autoRefreshAction) {
            // The fair-refresh contract confirms the same terminal response a
            // second time after its cooldown before suspending the source. Keep
            // the already-built catalogue usable and show the quiet retry state
            // until that confirmation exists. This prevents one stale 404/401
            // response from turning a healthy provider into "Review service".
            state = 'ready';
            retrying = true;
        } else if (EXPLICIT_ATTENTION_STATES.has(rawStatus) || EXPLICIT_ATTENTION_STATES.has(progressStatus)) {
            const explicitState = EXPLICIT_ATTENTION_STATES.has(progressStatus) ? progressStatus : rawStatus;
            if (explicitState === 'unreachable' && hasCompletedCatalog(source, status)) {
                state = 'ready';
                retrying = true;
            } else {
                state = explicitState;
            }
        } else if (FAILURE_STATES.has(rawStatus) || FAILURE_STATES.has(progressStatus) || error) {
            const errorState = classifyError(error, `${rawStatus} ${progressStatus}`);
            // A background re-sync that hits a TRANSIENT provider error (timeout,
            // unreachable, vague degraded) must not downgrade an already-built
            // catalog: the last import is still fully browsable. Keep it
            // ready+retrying and let the watchdog retry silently. `refreshing`
            // is deliberately reserved for work that is actually running so
            // Home never claims that titles are being added after a failed
            // attempt. Only a hard
            // auth/expiry verdict (the user must act) still surfaces. Initial
            // imports (no completed catalog yet) surface every error as before.
            if (hasCompletedCatalog(source, status)
                && errorState !== 'auth_failed'
                && errorState !== 'expired'
                && errorState !== 'provider_changed') {
                state = 'ready';
                retrying = true;
            } else {
                state = errorState;
            }
        } else if (SYNCING_STATES.has(rawStatus) || SYNCING_STATES.has(progressStatus)) {
            // A background re-sync of an already-built catalog keeps the catalog
            // usable, so classify it ready (flagged `refreshing`) instead of
            // syncing — otherwise the routine auto-refresh re-triggers the
            // full-screen onboarding gate for an onboarded user. Only a genuine
            // *initial* import (no completed catalog yet) stays `syncing`.
            //
            // `progress.usable` is the same idea for a FIRST import: the server flips it
            // once the initial cinema slices are usable. Category-specific readiness
            // still controls Movies, Series and Live independently while the remaining
            // catalogue continues in the background.
            if (hasCompletedCatalog(source, status) || progress.usable === true) {
                state = 'ready';
                if (progressStage === 'waiting_for_provider') {
                    retrying = true;
                } else {
                    refreshing = true;
                }
            } else {
                state = 'syncing';
            }
        } else if (READY_STATES.has(rawStatus) || READY_STATES.has(progressStatus) || lastSync) {
            state = 'ready';
        } else if (rawStatus === 'idle' || rawStatus === 'new') {
            state = 'syncing';
        }

        const meta = STATE_META[state] || STATE_META.degraded;
        return {
            state,
            refreshing,
            retrying,
            source,
            type: sourceType(source),
            label: meta.label,
            title: meta.title,
            message: error && state !== 'ready'
                && !['auth_failed', 'expired', 'provider_changed', 'disabled'].includes(state)
                ? safeShortError(error)
                : meta.message,
            action: meta.action,
            severity: meta.severity,
            needsAttention: meta.severity >= 3,
            isBlocking: meta.severity >= 4,
            lastSync,
            progress
        };
    }

    function sourceFromItem(item = {}) {
        return (item && item.source) || item || {};
    }

    function catalogUnlocks(progress = {}, classification = {}) {
        const source = classification.source || {};
        if (classification.state === 'disabled') {
            return { live: false, movies: false, series: false, browsable: false };
        }
        const providerAccessStatus = lower(
            source.provider_access_status || source.providerAccessStatus || ''
        );
        const blocked = ['expired_confirmed', 'access_unavailable_confirmed'].includes(providerAccessStatus);
        if (blocked) {
            return { live: false, movies: false, series: false, browsable: false };
        }
        const fullyReady = hasCompletedCatalog(source) || Boolean(classification.lastSync);
        const hasSpecificCinemaReadiness = Object.prototype.hasOwnProperty.call(progress, 'moviesReady')
            || Object.prototype.hasOwnProperty.call(progress, 'seriesReady');
        // Legacy progress exposed one browseReady bit for both cinema sections.
        // It also used `usable` only after Live and cinema were both available.
        // New progress uses independent flags so one first page cannot falsely
        // claim that the other section (or Live TV) is already queryable.
        const legacyCinemaReady = !hasSpecificCinemaReadiness && progress.browseReady === true;
        const legacyFullyUsable = !hasSpecificCinemaReadiness && progress.usable === true;
        const moviesReady = fullyReady || progress.moviesReady === true || legacyCinemaReady || legacyFullyUsable;
        const seriesReady = fullyReady || progress.seriesReady === true || legacyCinemaReady || legacyFullyUsable;
        const liveReady = fullyReady || progress.liveReady === true || legacyFullyUsable;
        return {
            live: liveReady,
            movies: moviesReady,
            series: seriesReady,
            browsable: liveReady || moviesReady || seriesReady
        };
    }

    /**
     * One conservative policy for every onboarding consumer.
     * Discovery counts are deliberately ignored: the server can publish them
     * before rows are materialized, so they are not proof that a category is
     * browsable. Movies and Series unlock independently on their first projected
     * slice; Live unlocks only after its final-phase materialization. The legacy
     * `browseReady` flag remains a compatibility fallback for old imports.
     */
    function catalogSourcePolicy(source = {}, statuses = []) {
        const status = statusFor(source, statuses);
        const progress = progressFor(source, status);
        const classification = classifySource(source, statuses);
        const rawStatus = lower(source.sync_status || source.syncStatus || status.status || status.sync_status || '');
        const progressStatus = lower(progress.status || progress.stage || '');
        const running = SYNCING_STATES.has(rawStatus) || SYNCING_STATES.has(progressStatus);
        const unlocks = catalogUnlocks(progress, classification);
        const phase = classification.state === 'ready'
            ? 'ready'
            : classification.state === 'syncing'
                ? 'syncing'
                : 'error';

        return {
            phase,
            state: classification.state,
            browsable: unlocks.browsable,
            categories: {
                live: unlocks.live,
                movies: unlocks.movies,
                series: unlocks.series
            },
            backgrounding: unlocks.browsable && classification.retrying !== true &&
                (running || classification.refreshing === true),
            classification,
            progress
        };
    }

    function catalogAvailability(summary = {}) {
        const state = summary?.state || 'not_configured';
        if (state === 'unknown' || summary?.error) {
            return {
                state,
                gate: false,
                catalogReady: false,
                browsable: false,
                backgrounding: false,
                categories: Object.fromEntries(CATALOG_CATEGORIES.map(category => [category, false]))
            };
        }

        const candidates = [...(summary?.sources || []), ...(summary?.issues || [])];
        const seen = new Set();
        const policies = [];
        candidates.forEach(item => {
            const source = sourceFromItem(item);
            const key = sourceId(source) || source;
            if (seen.has(key)) return;
            seen.add(key);
            const policy = catalogSourcePolicy(source);
            if (item?.source && item?.state) {
                const itemProgress = item.progress && typeof item.progress === 'object' ? item.progress : policy.progress;
                const unlocks = catalogUnlocks(itemProgress, item);
                policy.state = item.state;
                policy.phase = item.state === 'ready' ? 'ready' : item.state === 'syncing' ? 'syncing' : 'error';
                policy.browsable = unlocks.browsable;
                policy.categories = {
                    live: unlocks.live,
                    movies: unlocks.movies,
                    series: unlocks.series
                };
                policy.backgrounding = policy.browsable && item.retrying !== true &&
                    (item.refreshing === true || item.state === 'syncing');
                policy.progress = itemProgress;
            }
            policies.push(policy);
        });

        const catalogReady = candidates.some(item => {
            const source = sourceFromItem(item);
            const classification = item?.source && item?.state ? item : classifySource(source);
            const providerAccessStatus = lower(
                source.provider_access_status || source.providerAccessStatus || ''
            );
            if (classification.state === 'disabled' ||
                ['expired_confirmed', 'access_unavailable_confirmed'].includes(providerAccessStatus)) {
                return false;
            }
            return hasCompletedCatalog(source, item?.source ? item : {});
        });
        const categories = Object.fromEntries(CATALOG_CATEGORIES.map((category) => [
            category,
            catalogReady || policies.some((policy) => policy.categories?.[category] === true)
        ]));
        const browsable = catalogReady || CATALOG_CATEGORIES.some((category) => categories[category]);
        return {
            state,
            gate: !browsable,
            catalogReady,
            browsable,
            backgrounding: policies.some(policy => policy.backgrounding),
            categories
        };
    }

    function isCatalogCategoryAvailable(summary = {}, category = '') {
        if (!CATALOG_CATEGORIES.includes(category)) return false;
        return catalogAvailability(summary).categories[category] === true;
    }

    function safeShortError(error) {
        const value = string(error).replace(/\s+/g, ' ').trim();
        if (!value) return '';
        return value.length > 140 ? value.slice(0, 137) + '...' : value;
    }

    function summaryFrom(sources = [], statuses = []) {
        if (!sources.length) {
            return {
                state: 'not_configured',
                sources: [],
                issues: [],
                ready: [],
                ...STATE_META.not_configured
            };
        }

        const classified = sources.map(source => classifySource(source, statuses));
        const issues = classified.filter(item => item.needsAttention);
        const ready = classified.filter(item => item.state === 'ready');
        const syncing = classified.filter(item => item.state === 'syncing');
        const disabled = classified.filter(item => item.state === 'disabled');

        if (disabled.length === classified.length) {
            return {
                state: 'disabled',
                sources: classified,
                issues: [],
                ready,
                disabled,
                ...STATE_META.disabled
            };
        }

        if (!ready.length && syncing.length && !issues.length) {
            return {
                state: 'syncing',
                sources: classified,
                issues: syncing,
                ready,
                ...STATE_META.syncing
            };
        }

        if (issues.length) {
            const primary = [...issues].sort((a, b) => b.severity - a.severity)[0];
            const meta = STATE_META[primary.state] || STATE_META.degraded;
            const title = ready.length ? (globalThis.NorvaI18n?.t("ui_web_cdc63b72fa49", { defaultValue: "One TV service needs attention" }) ?? 'One TV service needs attention') : meta.title;
            const message = ready.length
                ? (globalThis.NorvaI18n?.t("ui_web_fec22ea53469", { defaultValue: "Norva can still play available content, but one service needs repair." }) ?? 'Norva can still play available content, but one service needs repair.')
                : meta.message;
            return {
                state: primary.state,
                sources: classified,
                issues,
                ready,
                ...meta,
                title,
                message
            };
        }

        return {
            state: 'ready',
            sources: classified,
            issues: [],
            ready,
            refreshing: ready.some(item => item.refreshing),
            retrying: ready.some(item => item.retrying),
            ...STATE_META.ready
        };
    }

    async function loadSummary() {
        const [sourcesResult, statusResult] = await Promise.allSettled([
            window.API?.sources?.getAll?.() || [],
            window.API?.sources?.getStatus?.() || []
        ]);
        // An API outage must never be mistaken for "no sources": a rejected /sources fetch
        // used to classify as not_configured and threw a fully configured user back onto the
        // first-run onboarding gate (home audit 2026-07-04, P0). Surface a distinct state the
        // callers treat as non-gating (keep cached rails + show a "can't reach" banner).
        if (sourcesResult.status === 'rejected') {
            return {
                state: 'unknown',
                error: true,
                sources: [],
                issues: [],
                ready: [],
                title: (globalThis.NorvaI18n?.t("ui_web_8671b15a00d7", { defaultValue: "We can't reach Norva right now" }) ?? "We can't reach Norva right now"),
                message: (globalThis.NorvaI18n?.t("ui_web_082b2e404b5e", { defaultValue: "Your services are unaffected — this is a temporary connection problem. Retrying…" }) ?? 'Your services are unaffected — this is a temporary connection problem. Retrying…')
            };
        }
        const sources = Array.isArray(sourcesResult.value) ? sourcesResult.value : [];
        const statuses = statusResult.status === 'fulfilled' && Array.isArray(statusResult.value)
            ? statusResult.value
            : [];
        return summaryFrom(sources, statuses);
    }

    function escapeHtml(value) {
        return string(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function cardHtml(summary = {}, options = {}) {
        const state = summary.state || 'degraded';
        const hidden = options.hideWhenReady !== false && state === 'ready';
        const prominent = options.prominent === true;
        const tvHandoff = options.tvHandoff === true;
        const accountSummary = options.accountSummary === true;
        const publicState = tvHandoff
            ? (state === 'ready' ? 'ready' : state === 'syncing' ? 'syncing' : state === 'disabled' ? 'disabled' : 'degraded')
            : state;
        const issueCount = summary.issues?.length || 0;
        const sourceCount = summary.sources?.length || 0;
        const primaryIssue = [...(summary.issues || [])].sort((a, b) => b.severity - a.severity)[0] || null;
        const primarySource = primaryIssue?.source || null;
        const latestSync = [...(summary.sources || []), ...(summary.ready || [])]
            .map((item) => completedSyncAt(item?.source || item, item))
            .filter(Boolean)
            .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
        const detail = options.detail || (latestSync
            ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_f25e77bb5313", {defaultValue: "Catalogue updated {{p0}}", p0:(relativeTime(latestSync))}) : `Catalogue updated ${relativeTime(latestSync)}`)
            : sourceCount
                ? `${sourceCount} service${sourceCount > 1 ? 's' : ''}${state === 'syncing' ? (globalThis.NorvaI18n?.t("ui_web_4dec46ac9bac", { defaultValue: ", preparing catalogue" }) ?? ', preparing catalogue') : issueCount ? (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_0245f7ab350a", {defaultValue: ", {{p0}} need attention", p0:(issueCount)}) : `, ${issueCount} need attention`) : ''}`
                : (globalThis.NorvaI18n?.t("ui_web_9f7086ea4e7d", { defaultValue: "No service connected" }) ?? 'No service connected'));
        const publicTvState = state === 'ready'
            ? {
                title: (globalThis.NorvaI18n?.t("ui_web_563c77237903", { defaultValue: "TV service is ready" }) ?? 'TV service is ready'),
                message: latestSync ? `Catalogue updated ${relativeTime(latestSync)}` : (globalThis.NorvaI18n?.t("ui_web_ee5d2b22fe0d", { defaultValue: "Your catalogue is ready to watch." }) ?? 'Your catalogue is ready to watch.'),
                action: (globalThis.NorvaI18n?.t("ui_web_dc2a62fb3391", { defaultValue: "View service" }) ?? 'View service')
            }
            : state === 'syncing'
                ? {
                    title: (globalThis.NorvaI18n?.t("ui_web_15349f77f124", { defaultValue: "Preparing your TV service" }) ?? 'Preparing your TV service'),
                    message: (globalThis.NorvaI18n?.t("ui_web_3ad0174d1572", { defaultValue: "Available titles appear as your catalogue is prepared." }) ?? 'Available titles appear as your catalogue is prepared.'),
                    action: (globalThis.NorvaI18n?.t("ui_web_4a0e4d79a5d8", { defaultValue: "Show instructions" }) ?? 'Show instructions')
                }
                : state === 'disabled'
                    ? {
                        title: (globalThis.NorvaI18n?.t("ui_web_a80f1ba0e158", { defaultValue: "TV service is paused" }) ?? 'TV service is paused'),
                        message: (globalThis.NorvaI18n?.t("ui_web_12157a0af31f", { defaultValue: "Enable it from TV Service settings to make its saved catalogue available again." }) ?? 'Enable it from TV Service settings to make its saved catalogue available again.'),
                        action: (globalThis.NorvaI18n?.t("ui_web_4a0e4d79a5d8", { defaultValue: "Show instructions" }) ?? 'Show instructions')
                    }
                : {
                    title: (globalThis.NorvaI18n?.t("ui_web_82155b6ef5b5", { defaultValue: "TV service needs attention" }) ?? 'TV service needs attention'),
                    message: (globalThis.NorvaI18n?.t("ui_web_062cb37ce522", { defaultValue: "Some content may be unavailable. Available titles still play." }) ?? 'Some content may be unavailable. Available titles still play.'),
                    action: (globalThis.NorvaI18n?.t("ui_web_4a0e4d79a5d8", { defaultValue: "Show instructions" }) ?? 'Show instructions')
                };
        const accountState = accountSummary && state === 'ready'
            ? publicTvState
            : null;
        const title = tvHandoff ? publicTvState.title : (accountState?.title || summary.title || STATE_META[state]?.title || (globalThis.NorvaI18n?.t("ui_web_bf88149dcb1d", { defaultValue: "TV service" }) ?? 'TV service'));
        const message = tvHandoff ? publicTvState.message : (accountState?.message || summary.message || STATE_META[state]?.message || '');
        const actionLabel = tvHandoff ? publicTvState.action : (accountState?.action || summary.action || (globalThis.NorvaI18n?.t("ui_web_a23b096cabd0", { defaultValue: "Manage service" }) ?? 'Manage service'));
        const actionName = tvHandoff && state !== 'ready' ? 'show-instructions' : 'open-sources';
        const progressAction = state === 'syncing' && !tvHandoff
            ? '<button class="btn btn-secondary" data-source-health-action="view-progress" data-i18n="ui_web_c2e39c2cee78">View progress</button>'
            : '';
        const diagnosticAttributes = tvHandoff
            ? ''
            : ` data-source-health-source-id="${escapeHtml(sourceId(primarySource))}"
                 data-source-health-source-type="${escapeHtml(sourceType(primarySource))}"`;

        return `
            <div class="service-health-card service-health-${escapeHtml(publicState)} ${prominent ? 'service-health-prominent' : ''} ${accountSummary ? 'service-health-account' : ''} ${hidden ? 'hidden' : ''}"
                 data-source-health-state="${escapeHtml(publicState)}"${diagnosticAttributes}>
                <div class="service-health-copy">
                    <img class="service-health-status-icon" src="/img/icons/norva-live-tv.svg" alt="" aria-hidden="true">
                    <span class="service-health-label">${escapeHtml(tvHandoff ? STATE_META[publicState]?.label : (summary.label || STATE_META[state]?.label || (globalThis.NorvaI18n?.t("ui_web_920e413c7d41", { defaultValue: "Status" }) ?? 'Status')))}</span>
                    <h3>${escapeHtml(title)}</h3>
                    <p>${escapeHtml(message)}</p>
                    <small>${escapeHtml(detail)}</small>
                </div>
                <div class="service-health-actions">
                    <button class="btn ${tvHandoff || accountSummary ? 'btn-secondary' : 'btn-primary'}" data-source-health-action="${escapeHtml(actionName)}">${escapeHtml(actionLabel)}</button>
                    ${progressAction}
                </div>
            </div>
        `;
    }

    function relativeTime(value) {
        const then = new Date(value).getTime();
        if (!Number.isFinite(then)) return (globalThis.NorvaI18n?.t("ui_web_59f7a3dd09de", { defaultValue: "recently" }) ?? 'recently');
        const diff = Date.now() - then;
        if (diff <= 0) return (globalThis.NorvaI18n?.t("ui_web_7ddb44d8a533", { defaultValue: "just now" }) ?? 'just now');
        const minutes = Math.floor(diff / 60000);
        if (minutes < 1) return (globalThis.NorvaI18n?.t("ui_web_7ddb44d8a533", { defaultValue: "just now" }) ?? 'just now');
        if (minutes < 60) return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_23c5964926a1", {defaultValue: "{{p0}} min ago", p0:(minutes)}) : `${minutes} min ago`);
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_f1f497484232", {defaultValue: "{{p0}} h ago", p0:(hours)}) : `${hours} h ago`);
        const days = Math.floor(hours / 24);
        if (days < 7) return (globalThis.NorvaI18n ? globalThis.NorvaI18n.t("ui_web_d8562d2341f6", {defaultValue: "{{p0}} d ago", p0:(days)}) : `${days} d ago`);
        return new Date(value).toLocaleDateString((globalThis.NorvaI18n?.language || 'en-US'));
    }

    function progressSourceFrom(summary = {}) {
        const candidates = [
            ...(summary.issues || []),
            ...(summary.sources || [])
        ];
        const match = candidates.find(item => item?.state === 'syncing') || candidates[0];
        return match?.source || null;
    }

    function openProgress(summary = {}, app = window.app) {
        const manager = app?.sourceManager || window.app?.sourceManager;
        const source = progressSourceFrom(summary);
        if (source && manager?.showCatalogPreparation) {
            manager.showCatalogPreparation(source, sourceType(source));
            return true;
        }
        return openAction(summary, app);
    }

    function openAction(summary = {}, app = window.app) {
        const manager = app?.sourceManager || window.app?.sourceManager;
        const settings = app?.pages?.settings || window.app?.pages?.settings;
        const issues = [...(summary.issues || [])].sort((a, b) => b.severity - a.severity);
        const primaryIssue = issues[0] || null;
        const primarySource = primaryIssue?.source || null;
        const state = summary.state || 'degraded';

        if (state === 'not_configured') {
            if (manager?.showAddModal) {
                manager.showAddModal('xtream');
                return true;
            }
        }

        // A syncing source is a healthy import in progress, not an error to repair.
        // Route the prominent CTA to the catalog-preparation modal (progress) rather
        // than the credential-repair form — the showEditModal path below stays
        // reserved for genuine error states (degraded / auth_failed / expired / …).
        if (state === 'syncing') {
            const source = progressSourceFrom(summary);
            if (source && manager?.showCatalogPreparation) {
                manager.showCatalogPreparation(source, sourceType(source));
                return true;
            }
            if (app?.navigateTo) app.navigateTo('settings');
            setTimeout(() => settings?.switchTab?.('sources'), 0);
            return true;
        }

        if (primarySource && manager?.showEditModal) {
            const id = sourceId(primarySource);
            const type = sourceType(primarySource);
            if (id) {
                manager.showEditModal(id, type);
                return true;
            }
        }

        if (app?.navigateTo) app.navigateTo('settings');
        setTimeout(() => settings?.switchTab?.('sources'), 0);
        return true;
    }

    window.NorvaSourceHealth = {
        STATE_META,
        // Exposed so the admin dashboard can badge a source with WHY it failed
        // instead of printing a raw provider string and an HTTP code.
        classifyErrorKind,
        ERROR_KIND_LABELS,
        classifySource,
        catalogSourcePolicy,
        catalogAvailability,
        isCatalogCategoryAvailable,
        summarize: summaryFrom,
        loadSummary,
        cardHtml,
        openProgress,
        openAction
    };
})();
