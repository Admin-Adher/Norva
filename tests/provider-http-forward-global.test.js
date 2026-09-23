'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { useProviderHttpForward, parseHttpForwardAccounts } = require('../services/media-gateway/src/provider-http-forward-policy');

test('generic HTTP media routing admits unknown accounts without changing TLS or other resources', () => {
    const accounts = parseHttpForwardAccounts('');
    const global = { allCompatibleHttpMedia: true };
    for (let n = 0; n < 100; n++) {
        assert.equal(useProviderHttpForward(`new-account-${n}`, `http://provider-${n}.example/movie/a/b/file.mp4`, accounts, global), true);
        assert.equal(useProviderHttpForward(`new-account-${n}`, `http://provider-${n}.example/movie/a/b/file.ts`, accounts, global), true);
    }
    for (const url of ['https://provider.example/file.mp4', 'http://provider.example/live.m3u8',
        'http://provider.example/file.mkv', 'http://provider.example/player_api.php', 'file:///movie.mp4', 'invalid']) {
        assert.equal(useProviderHttpForward('new-account', url, accounts, global), false);
    }
    assert.equal(useProviderHttpForward('', 'http://provider.example/file.mp4', accounts, global), false);
});

test('global transport requires an explicit boolean and preserves invalid-config rejection', () => {
    const empty = parseHttpForwardAccounts('');
    for (const value of [undefined, false, 'true', 1]) {
        assert.equal(useProviderHttpForward('new-account', 'http://provider.example/movie.mp4', empty,
            { allCompatibleHttpMedia: value }), false);
    }
    assert.throws(() => parseHttpForwardAccounts('*'));
});
