'use strict';

const crypto = require('crypto');

const STATIC_PROXY_SLOT_COUNT = 5;
const MAX_PROXY_SLOT_OVERRIDES = 64;

function decodedProviderUsername(value) {
    const raw = String(value || '');
    if (!raw.trim()) return '';
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
    if (queryUsername !== null && String(queryUsername).trim()) return String(queryUsername);

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
    const exactUsername = String(username || '');
    return host + (exactUsername.trim() ? `/${exactUsername}` : '');
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

function providerAccountOverrideHash(accountKey) {
    return crypto.createHash('sha256').update(String(accountKey || '')).digest('hex');
}

function parseProviderProxySlotOverrides(value, slotCount) {
    const raw = String(value || '').trim();
    if (!raw) return new Map();
    if (Number(slotCount) !== STATIC_PROXY_SLOT_COUNT) {
        throw new Error('PROVIDER_PROXY_SLOT_OVERRIDES requires the complete five-slot proxy pool');
    }
    if (raw.length > 16_384) {
        throw new Error('PROVIDER_PROXY_SLOT_OVERRIDES is invalid');
    }

    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
        throw new Error('PROVIDER_PROXY_SLOT_OVERRIDES is invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('PROVIDER_PROXY_SLOT_OVERRIDES is invalid');
    }

    const entries = Object.entries(parsed);
    if (entries.length > MAX_PROXY_SLOT_OVERRIDES) {
        throw new Error('PROVIDER_PROXY_SLOT_OVERRIDES is invalid');
    }
    const overrides = new Map();
    for (const [rawHash, rawSlot] of entries) {
        const accountHash = String(rawHash || '').toLowerCase();
        const slotNumber = rawSlot;
        if (!/^[0-9a-f]{64}$/.test(accountHash)
            || typeof slotNumber !== 'number'
            || !Number.isInteger(slotNumber)
            || slotNumber < 1
            || slotNumber > STATIC_PROXY_SLOT_COUNT
            || overrides.has(accountHash)) {
            throw new Error('PROVIDER_PROXY_SLOT_OVERRIDES is invalid');
        }
        overrides.set(accountHash, slotNumber - 1);
    }
    return overrides;
}

function proxySlotIndexForAccount(accountKey, slotCount, overrides = new Map()) {
    const accountHash = providerAccountOverrideHash(accountKey);
    if (overrides && overrides.has(accountHash)) {
        const overriddenSlot = overrides.get(accountHash);
        if (!Number.isInteger(overriddenSlot) || overriddenSlot < 0 || overriddenSlot >= Number(slotCount)) {
            throw new Error('PROVIDER_PROXY_SLOT_OVERRIDES is invalid');
        }
        return overriddenSlot;
    }
    return stableProxySlotIndex(accountKey, slotCount);
}

function normalizeProxyUrl(candidate, variableName = 'PROVIDER_PROXY_URLS') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
        let parsed;
        try { parsed = new URL(candidate); } catch (_) {
            throw new Error(`${variableName} contains an invalid proxy URL`);
        }
        if (!['http:', 'https:', 'socks:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname) {
            throw new Error(`${variableName} supports only http(s) or socks5 proxy URLs`);
        }
        return parsed.href;
    }

    // Backward compatibility for the singular Evomi export format used by the
    // existing Railway variable: host:port:user:pass. URL setters perform the
    // required percent-encoding without ever logging the raw credentials.
    const legacy = candidate.match(/^(\[[^\]]+\]|[^:\s/]+):(\d{1,5}):([^:\s]+):(.+)$/);
    if (!legacy) {
        throw new Error(`${variableName} contains an invalid proxy URL`);
    }
    let parsed;
    try { parsed = new URL(`http://${legacy[1]}:${legacy[2]}`); } catch (_) {
        throw new Error(`${variableName} contains an invalid legacy proxy endpoint`);
    }
    parsed.username = legacy[3];
    parsed.password = legacy[4];
    return parsed.href;
}

function parseProviderProxyUrls(value, variableName = 'PROVIDER_PROXY_URLS') {
    // Legacy host:port:user:pass entries cannot contain commas or whitespace because those
    // delimit the pool. Use a percent-encoded URL whenever credentials contain delimiters.
    const candidates = String(value || '')
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (!candidates.length) return [];

    const urls = candidates.map((candidate) => normalizeProxyUrl(candidate, variableName));

    if (new Set(urls).size !== urls.length) {
        throw new Error(`${variableName} contains duplicate static proxy slots`);
    }
    if (urls.length !== 1 && urls.length !== STATIC_PROXY_SLOT_COUNT) {
        throw new Error(`${variableName} must contain one backward-compatible proxy or exactly ${STATIC_PROXY_SLOT_COUNT} static proxy slots`);
    }
    return urls;
}

module.exports = {
    MAX_PROXY_SLOT_OVERRIDES,
    STATIC_PROXY_SLOT_COUNT,
    parseProviderProxyUrls,
    parseProviderProxySlotOverrides,
    providerAccountAffinityKey,
    providerAccountAffinityKeyFromCredentials,
    providerAccountOverrideHash,
    proxySlotIndexForAccount,
    stableProxySlotIndex,
};
