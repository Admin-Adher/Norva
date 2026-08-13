'use strict';

const NETWORK_FAILURES = new Map([
    ['UND_ERR_CONNECT_TIMEOUT', { code: 'PROVIDER_CONNECT_TIMEOUT', category: 'timeout' }],
    ['ETIMEDOUT', { code: 'PROVIDER_CONNECT_TIMEOUT', category: 'timeout' }],
    ['ECONNRESET', { code: 'PROVIDER_CONNECTION_RESET', category: 'connection_reset' }],
    ['UND_ERR_SOCKET', { code: 'PROVIDER_CONNECTION_RESET', category: 'connection_reset' }],
    ['EPIPE', { code: 'PROVIDER_CONNECTION_RESET', category: 'connection_reset' }],
    ['ENOTFOUND', { code: 'PROVIDER_DNS_FAILURE', category: 'dns' }],
    ['EAI_AGAIN', { code: 'PROVIDER_DNS_FAILURE', category: 'dns' }],
    ['ENETUNREACH', { code: 'PROVIDER_NETWORK_UNREACHABLE', category: 'network_unreachable' }],
    ['EHOSTUNREACH', { code: 'PROVIDER_NETWORK_UNREACHABLE', category: 'network_unreachable' }],
    ['ECONNREFUSED', { code: 'PROVIDER_NETWORK_UNREACHABLE', category: 'network_unreachable' }],
]);

function normalizedFailureCode(error) {
    const candidates = [
        error && error.cause && error.cause.code,
        error && error.code,
        error && error.cause && error.cause.name,
        error && error.name,
    ];
    return candidates
        .map((value) => String(value || '').trim().toUpperCase())
        .find(Boolean) || '';
}

function classifyProviderFetchFailure(error) {
    const failureCode = normalizedFailureCode(error);
    const known = NETWORK_FAILURES.get(failureCode);
    if (known) return { ...known };

    if (/CERT|TLS|SSL/.test(failureCode)) {
        return { code: 'PROVIDER_TLS_FAILURE', category: 'tls' };
    }
    if (failureCode === 'ABORTERROR' || failureCode === 'UND_ERR_HEADERS_TIMEOUT') {
        return { code: 'PROVIDER_RESPONSE_TIMEOUT', category: 'timeout' };
    }
    return { code: 'PROVIDER_FETCH_FAILED', category: 'network' };
}

function shouldRetryProviderStatus(status) {
    const value = Number(status);
    if (!Number.isInteger(value)) return false;
    if (value >= 400 && value < 500) return false;
    return value === 502 || value === 503 || value === 504;
}

function classifyProviderResponseFailure(status, payload) {
    const value = Number(status);
    const text = JSON.stringify(payload || {}).toLowerCase();
    if (value === 458 || /max(?:imum)? connections?|active connections?|connection limit/.test(text)) {
        return {
            status: 458,
            code: 'PROVIDER_BUSY',
            publicMessage: 'This TV service is already being used on another device.',
        };
    }
    if (/user[_\s-]*multi[_\s-]*ip|multi[_\s-]*ip|same account.*ip|account sharing/.test(text)) {
        return {
            status: 429,
            code: 'PROVIDER_MULTI_IP',
            publicMessage: 'IPTV provider refused the account because it already sees one active connection. Stop all other playback attempts, wait 1–2 minutes, then retry from one device.',
        };
    }
    if (value === 429 || /too many requests|rate limit|ratelimit/.test(text)) {
        return {
            status: 429,
            code: 'PROVIDER_RATE_LIMIT',
            publicMessage: 'IPTV provider is rate limiting this account. Wait a moment, then retry.',
        };
    }
    return {
        status: value,
        code: 'PROVIDER_REQUEST_FAILED',
        publicMessage: 'IPTV provider request failed',
    };
}

module.exports = {
    classifyProviderFetchFailure,
    classifyProviderResponseFailure,
    shouldRetryProviderStatus,
};
