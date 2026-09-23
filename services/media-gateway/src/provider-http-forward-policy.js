'use strict';

const crypto = require('node:crypto');

// Service-owned transport policy. Global HTTP-media routing retains the same
// sticky account/slot; a provider name or a client hint never selects a route.
function parseHttpForwardAccounts(value = '') {
    const raw = String(value).trim();
    if (!raw) return new Set();
    const entries = raw.split(/[\s,]+/);
    if (raw.length > 8192 || entries.length > 64
        || entries.some((entry) => !/^[a-f0-9]{64}$/.test(entry))) {
        throw new Error('PROVIDER_HTTP_FORWARD_ACCOUNT_HASHES is invalid');
    }
    return new Set(entries);
}

function useProviderHttpForward(accountKey, sourceUrl, accounts, { allCompatibleHttpMedia = false } = {}) {
    if (!accountKey || (!accounts?.size && allCompatibleHttpMedia !== true)) return false;
    try {
        const url = new URL(sourceUrl);
        // Global mode also covers plaintext live TS. MKV, manifests, metadata,
        // and HTTPS keep their current route. HTTPS redirects still use CONNECT
        // with normal TLS verification inside Undici.
        if (url.protocol !== 'http:' || !/\.(mp4|ts)$/i.test(url.pathname)) return false;
        return allCompatibleHttpMedia === true
            || accounts.has(crypto.createHash('sha256').update(String(accountKey)).digest('hex'));
    } catch (_) {
        return false;
    }
}

module.exports = { parseHttpForwardAccounts, useProviderHttpForward };
