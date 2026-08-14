'use strict';

const STATIC_PROXY_SLOT_COUNT = 5;

function decodedProviderUsername(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

function providerHost(value) {
    try {
        return new URL(value).host.toLowerCase();
    } catch (_) {
        return '';
    }
}

function providerUsernameFromUrl(parsed) {
    const queryUsername = parsed.searchParams.get('username');
    // URLSearchParams has already percent-decoded the query value. Decoding it
    // again would turn a literal provider username such as "%20alice" into a
    // different identity than the same username embedded in an Xtream path.
    if (queryUsername) return String(queryUsername).trim();

    const segments = parsed.pathname.split('/').filter(Boolean);
    const streamTypeIndex = segments.findIndex((segment) =>
        ['movie', 'series', 'live'].includes(String(segment || '').toLowerCase()));
    if (streamTypeIndex >= 0 && segments[streamTypeIndex + 1]) {
        return decodedProviderUsername(segments[streamTypeIndex + 1]);
    }
    return '';
}

function providerAccountAffinityKey(value) {
    try {
        const parsed = new URL(value);
        const host = parsed.host.toLowerCase();
        const username = providerUsernameFromUrl(parsed);
        return host + (username ? `/${username}` : '');
    } catch (_) {
        return String(value || '');
    }
}

function providerAccountAffinityKeyFromCredentials(serverUrl, username) {
    const host = providerHost(serverUrl);
    if (!host) return '';
    // Credentials supplied by the source model are already logical values, not
    // URL components. Preserve literal percent sequences so every lane hashes
    // exactly the same provider-account identity.
    const normalizedUsername = String(username || '').trim();
    return host + (normalizedUsername ? `/${normalizedUsername}` : '');
}

function stableProxySlotIndex(accountKey, slotCount) {
    const count = Number(slotCount);
    if (!Number.isInteger(count) || count <= 0) {
        throw new TypeError('slotCount must be a positive integer');
    }
    if (count === 1) return 0;

    const value = String(accountKey || '');
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % count;
}

function normalizeProxyUrl(candidate) {
    if (/^https?:\/\//i.test(candidate)) {
        let parsed;
        try { parsed = new URL(candidate); } catch (_) {
            throw new Error('PROVIDER_PROXY_URLS contains an invalid proxy URL');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
            throw new Error('PROVIDER_PROXY_URLS supports only http(s) proxy URLs');
        }
        return parsed.href;
    }

    // Backward compatibility for the singular Evomi export format used by the
    // existing Railway variable: host:port:user:pass. URL setters perform the
    // required percent-encoding without ever logging the raw credentials.
    const legacy = candidate.match(/^(\[[^\]]+\]|[^:\s/]+):(\d{1,5}):([^:\s]+):(.+)$/);
    if (!legacy) {
        throw new Error('PROVIDER_PROXY_URLS contains an invalid proxy URL');
    }
    let parsed;
    try { parsed = new URL(`http://${legacy[1]}:${legacy[2]}`); } catch (_) {
        throw new Error('PROVIDER_PROXY_URLS contains an invalid legacy proxy endpoint');
    }
    parsed.username = legacy[3];
    parsed.password = legacy[4];
    return parsed.href;
}

function parseProviderProxyUrls(value) {
    // Legacy host:port:user:pass entries cannot contain commas or whitespace because those
    // delimit the pool. Use a percent-encoded URL whenever credentials contain delimiters.
    const candidates = String(value || '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (!candidates.length) return [];

    const urls = candidates.map(normalizeProxyUrl);

    if (new Set(urls).size !== urls.length) {
        throw new Error('PROVIDER_PROXY_URLS contains duplicate static proxy slots');
    }
    if (urls.length !== 1 && urls.length !== STATIC_PROXY_SLOT_COUNT) {
        throw new Error(`PROVIDER_PROXY_URLS must contain one backward-compatible proxy or exactly ${STATIC_PROXY_SLOT_COUNT} static proxy slots`);
    }
    return urls;
}

module.exports = {
    STATIC_PROXY_SLOT_COUNT,
    parseProviderProxyUrls,
    providerAccountAffinityKey,
    providerAccountAffinityKeyFromCredentials,
    stableProxySlotIndex,
};
