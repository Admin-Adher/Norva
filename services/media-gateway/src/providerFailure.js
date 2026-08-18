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

function failureChainText(error) {
    const values = [];
    const visited = new Set();
    let current = error;
    for (let depth = 0; current && depth < 6 && !visited.has(current); depth += 1) {
        if (typeof current === 'string') {
            values.push(current);
            break;
        }
        visited.add(current);
        for (const value of [
            current.code,
            current.name,
            current.message,
            current.status,
            current.statusCode,
            current.lastError,
            current.logTail,
        ]) {
            if (value !== undefined && value !== null) values.push(String(value));
        }
        current = current.cause;
    }
    // Keep fields separate: the bounded proxy-auth regexes below must not assemble
    // a signature from unrelated fields (for example "proxy timeout" + "auth failed").
    return values.join('\n').toLowerCase();
}

function isProxyAuthenticationFailure(error) {
    const text = failureChainText(error);
    return text.includes('proxy_auth_failed')
        || /proxy[^\n]{0,120}(?:authentication required|auth(?:entication)? failed|response[^\n]{0,40}\b407\b)/i.test(text)
        || /\b407\b[^\n]{0,120}proxy/i.test(text);
}

function classifyProviderFetchFailure(error) {
    if (isProxyAuthenticationFailure(error)) {
        return { code: 'PROXY_AUTH_FAILED', category: 'proxy_auth' };
    }
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

function classifyProviderResponseFailure(status, payload, options = {}) {
    const value = Number(status);
    const text = JSON.stringify(payload || {}).toLowerCase();
    if (value === 407 && options.proxyConfigured === true) {
        return {
            status: 502,
            code: 'PROXY_AUTH_FAILED',
            publicMessage: 'The media service is temporarily unavailable.',
        };
    }
    if (value === 458 || /max(?:imum)? connections?|active connections?|connection limit/.test(text)) {
        return {
            status: 458,
            code: 'PROVIDER_BUSY',
            publicMessage: 'This TV service is busy. Wait a few seconds, then try again.',
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
    isProxyAuthenticationFailure,
    shouldRetryProviderStatus,
};
