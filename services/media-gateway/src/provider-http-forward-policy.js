'use strict';

const crypto = require('node:crypto');

// Service-only, account-exact rollout. Never infer a route from a provider name,
// a client hint, or the redirected URL (which may no longer carry the account).
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

function useProviderHttpForward(accountKey, sourceUrl, accounts) {
    if (!accountKey || !accounts?.size) return false;
    try {
        const url = new URL(sourceUrl);
        // Preserve every existing MKV/live/metadata/HTTPS route. HTTPS redirects
        // still use CONNECT with normal TLS verification inside Undici.
        if (url.protocol !== 'http:' || !/\.(mp4|ts)$/i.test(url.pathname)) return false;
        return accounts.has(crypto.createHash('sha256').update(String(accountKey)).digest('hex'));
    } catch (_) {
        return false;
    }
}

module.exports = { parseHttpForwardAccounts, useProviderHttpForward };
