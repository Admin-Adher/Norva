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
            label: 'Not connected',
            title: 'Connect your TV service',
            message: 'Add a provider account or playlist link to start watching.',
            action: 'Connect TV service'
        },
        syncing: {
            severity: 1,
            label: 'Checking',
            title: 'Preparing your TV service',
            message: 'Norva is importing channels, movies and series. This can take a few minutes.',
            action: 'View service'
        },
        ready: {
            severity: 0,
            label: 'Ready',
            title: 'TV service ready',
            message: 'Your catalog is ready to watch.',
            action: 'Manage service'
        },
        degraded: {
            severity: 3,
            label: 'Needs attention',
            title: 'TV service needs attention',
            message: 'Some content may be unavailable. Try syncing again or check the provider details.',
            action: 'Repair service'
        },
        auth_failed: {
            severity: 4,
            label: 'Update login',
            title: 'Update TV service login',
            message: 'The provider refused the saved login. Update the username or password to restore access.',
            action: 'Update login'
        },
        expired: {
            severity: 4,
            label: 'Expired',
            title: 'TV service may be expired',
            message: 'The provider reports an inactive or expired account. Renew it, then update the login if needed.',
            action: 'Update service'
        },
        unreachable: {
            severity: 3,
            label: 'Unavailable',
            title: 'TV service unavailable',
            message: 'Norva cannot reach the provider right now. It may be a temporary outage.',
            action: 'Check service'
        }
    };

    function string(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    function lower(value) {
        return string(value).toLowerCase();
    }

    function sourceId(source = {}) {
        return string(source.id || source.source_id || source.sourceId || source.cloudId || source.cloud_id);
    }

    function sourceType(source = {}) {
        return string(source.type || source.source_type || source.sourceType || 'xtream') || 'xtream';
    }

    function statusFor(source, statuses = []) {
        const id = sourceId(source);
        return (statuses || []).find(status => {
            const candidate = sourceId(status);
            return candidate && id && candidate === id;
        }) || {};
    }

    function classifyError(errorText, rawStatus = '') {
        const error = lower(`${rawStatus} ${errorText}`);
        if (!error) return 'degraded';

        if (/\b(401|403|unauthorized|forbidden|auth|credential|credentials|login|password|username|invalid user|invalid pass)\b/.test(error)) {
            return 'auth_failed';
        }
        if (/\b(expired|expire|inactive|disabled|banned|subscription|renew|unpaid|paid|trial ended)\b/.test(error)) {
            return 'expired';
        }
        if (/\b(timeout|timed out|econn|enotfound|dns|network|unreachable|refused|503|502|500|service unavailable|temporarily unavailable)\b/.test(error)) {
            return 'unreachable';
        }
        return 'degraded';
    }

    function classifySource(source = {}, statuses = []) {
        const status = statusFor(source, statuses);
        const rawStatus = lower(source.sync_status || source.syncStatus || status.status || status.sync_status || 'idle');
        const error = string(source.sync_error || source.syncError || status.error || status.sync_error || '');
        const lastSync = source.last_sync || source.lastSync || source.last_synced_at || status.last_sync || status.lastSyncedAt;
        const enabled = source.enabled !== false && source.revoked !== true;

        let state = 'degraded';
        if (!enabled) {
            state = 'degraded';
        } else if (rawStatus === 'syncing' || rawStatus === 'pending') {
            state = 'syncing';
        } else if (error) {
            state = classifyError(error, rawStatus);
        } else if (['ready', 'success', 'synced', 'complete', 'completed'].includes(rawStatus) || lastSync) {
            state = 'ready';
        } else if (rawStatus === 'idle' || rawStatus === 'new') {
            state = 'syncing';
        }

        const meta = STATE_META[state] || STATE_META.degraded;
        return {
            state,
            source,
            type: sourceType(source),
            label: meta.label,
            title: meta.title,
            message: error && state !== 'ready' ? safeShortError(error) : meta.message,
            action: meta.action,
            severity: meta.severity,
            needsAttention: meta.severity >= 3,
            isBlocking: meta.severity >= 4,
            lastSync
        };
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
            const title = ready.length ? 'One TV service needs attention' : meta.title;
            const message = ready.length
                ? 'Norva can still play available content, but one service needs repair.'
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
            ...STATE_META.ready
        };
    }

    async function loadSummary() {
        const [sourcesResult, statusResult] = await Promise.allSettled([
            window.API?.sources?.getAll?.() || [],
            window.API?.sources?.getStatus?.() || []
        ]);
        const sources = sourcesResult.status === 'fulfilled' && Array.isArray(sourcesResult.value)
            ? sourcesResult.value
            : [];
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
        const issueCount = summary.issues?.length || 0;
        const sourceCount = summary.sources?.length || 0;
        const detail = sourceCount
            ? `${sourceCount} service${sourceCount > 1 ? 's' : ''}${issueCount ? `, ${issueCount} need attention` : ''}`
            : 'No service connected';

        return `
            <div class="service-health-card service-health-${escapeHtml(state)} ${hidden ? 'hidden' : ''}">
                <div class="service-health-copy">
                    <span class="service-health-label">${escapeHtml(summary.label || STATE_META[state]?.label || 'Status')}</span>
                    <h3>${escapeHtml(summary.title || STATE_META[state]?.title || 'TV service')}</h3>
                    <p>${escapeHtml(summary.message || STATE_META[state]?.message || '')}</p>
                    <small>${escapeHtml(detail)}</small>
                </div>
                <div class="service-health-actions">
                    <button class="btn btn-primary" data-source-health-action="open-sources">${escapeHtml(summary.action || 'Manage service')}</button>
                </div>
            </div>
        `;
    }

    window.NorvaSourceHealth = {
        STATE_META,
        classifySource,
        summarize: summaryFrom,
        loadSummary,
        cardHtml
    };
})();
