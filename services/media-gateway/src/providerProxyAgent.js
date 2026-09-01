'use strict';

const SOCKS5_PROTOCOLS = new Set(['socks:', 'socks5:']);

function invalidProxyCredentials() {
    const error = new Error('Provider proxy credentials are invalid');
    error.code = 'PROXY_CREDENTIALS_INVALID';
    return error;
}

function decodeProxyCredential(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (_) {
        throw invalidProxyCredentials();
    }
}

function assertRfc1929CredentialPair(username, password) {
    const hasUsername = username.length > 0;
    const hasPassword = password.length > 0;
    if (hasUsername !== hasPassword) throw invalidProxyCredentials();
    if (!hasUsername) return;

    const usernameBytes = Buffer.byteLength(username, 'utf8');
    const passwordBytes = Buffer.byteLength(password, 'utf8');
    if (usernameBytes < 1 || usernameBytes > 255 || passwordBytes < 1 || passwordBytes > 255) {
        throw invalidProxyCredentials();
    }
}

function socks5ProxyDescriptor(proxyUrl) {
    let parsed;
    try {
        parsed = new URL(proxyUrl);
    } catch (_) {
        throw new Error('Provider proxy URL is invalid');
    }
    if (!SOCKS5_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) {
        throw new Error('Provider proxy URL is not SOCKS5');
    }

    // URL.username/password remain percent-encoded. Undici ProxyAgent forwards those
    // fields as explicit options to Socks5ProxyAgent, which consequently skips its
    // own decodeURIComponent fallback. Decode once here, then strip credentials from
    // the URL so no later layer can decode or expose them a second time.
    const username = decodeProxyCredential(parsed.username);
    const password = decodeProxyCredential(parsed.password);
    assertRfc1929CredentialPair(username, password);
    parsed.username = '';
    parsed.password = '';

    return {
        proxyUrl: parsed.href,
        username: username || null,
        password: password || null,
    };
}

function createProviderProxyAgent(proxyUrl, options = {}, implementation = null) {
    let parsed;
    try {
        parsed = new URL(proxyUrl);
    } catch (_) {
        throw new Error('Provider proxy URL is invalid');
    }

    const { ProxyAgent, Socks5ProxyAgent } = implementation || require('undici');
    if (SOCKS5_PROTOCOLS.has(parsed.protocol)) {
        const descriptor = socks5ProxyDescriptor(parsed.href);
        return new Socks5ProxyAgent(descriptor.proxyUrl, {
            ...options,
            username: descriptor.username,
            password: descriptor.password,
        });
    }

    return new ProxyAgent({
        ...options,
        uri: parsed.href,
    });
}

module.exports = {
    createProviderProxyAgent,
    socks5ProxyDescriptor,
};
