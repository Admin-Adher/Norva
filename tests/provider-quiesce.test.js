'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ProviderQuiesce } = require('../services/media-gateway/src/provider-quiesce');

function clock(start = 1_000_000) {
    const c = { t: start };
    c.now = () => c.t;
    c.advance = (ms) => { c.t += ms; };
    return c;
}

test('a held lease blocks background admission and an unheld one does not', () => {
    const c = clock();
    const q = new ProviderQuiesce({ now: c.now });
    assert.equal(q.blocked(), false, 'open by default');
    const token = q.begin('diagnostic');
    assert.equal(q.blocked(), true);
    q.cancel(token);
    assert.equal(q.blocked(), false, 'cancel reopens immediately');
});

test('the lease expires on its own without any operator action', () => {
    const c = clock();
    const q = new ProviderQuiesce({ now: c.now, ttlMs: 30_000 });
    q.begin();
    assert.equal(q.blocked(), true);
    c.advance(29_999);
    assert.equal(q.blocked(), true, 'still held just before the deadline');
    c.advance(2);
    assert.equal(q.blocked(), false, 'reopened by expiry alone');
    assert.equal(q.status().expiries, 1);
});

test('renewal extends the window but never past the absolute ceiling', () => {
    const c = clock();
    const q = new ProviderQuiesce({ now: c.now, ttlMs: 30_000, maxWindowMs: 120_000 });
    const token = q.begin();
    for (let i = 0; i < 3; i += 1) { c.advance(20_000); q.renew(token); }
    assert.equal(q.blocked(), true, 'held across renewals');
    // 60s consumed; the ceiling is 120s from the start.
    c.advance(20_000);                       // t = 80s
    const remaining = q.renew(token);
    assert.ok(remaining <= 40_000, 'renewal clamped to the ceiling');
    assert.equal(q.status().windowRemainingMs, 40_000);
    // Even a diligent client renewing on time cannot hold the gate past the
    // ceiling: the clamped deadline lands exactly on it and then expires.
    c.advance(25_000);                       // t = 105s, before the 110s deadline
    q.renew(token);
    assert.equal(q.status().remainingMs, 15_000, 'clamped to the 120s ceiling');
    c.advance(14_000);                       // t = 119s, still inside
    assert.equal(q.blocked(), true);
    q.renew(token);
    assert.equal(q.status().remainingMs, 1_000, 'renewal cannot reach beyond the ceiling');
    c.advance(2_000);                        // t = 121s, past the ceiling
    assert.equal(q.blocked(), false, 'ceiling reopens admission on its own');
    assert.throws(() => q.renew(token), /QUIESCE_LEASE_LOST/);
});

test('a lost or forged token can neither renew nor cancel', () => {
    const c = clock();
    const q = new ProviderQuiesce({ now: c.now });
    const token = q.begin();
    for (const bad of ['', 'x'.repeat(64), null, undefined, token + 'a']) {
        assert.throws(() => q.renew(bad), /QUIESCE_LEASE_LOST/);
        assert.throws(() => q.cancel(bad), /QUIESCE_LEASE_LOST/);
    }
    assert.equal(q.blocked(), true, 'still held by the legitimate owner');
    assert.equal(q.renew(token) > 0, true);
});

test('only one window exists at a time', () => {
    const c = clock();
    const q = new ProviderQuiesce({ now: c.now });
    q.begin();
    assert.throws(() => q.begin(), /QUIESCE_ALREADY_HELD/);
});

test('viewer playback releases the lease unconditionally', () => {
    const c = clock();
    const q = new ProviderQuiesce({ now: c.now });
    const token = q.begin();
    assert.equal(q.releaseForViewer(), true);
    assert.equal(q.blocked(), false, 'a viewer never waits behind a diagnostic window');
    assert.throws(() => q.renew(token), /QUIESCE_LEASE_LOST/);
    assert.equal(q.status().viewerReleases, 1);
});

test('configuration is validated and fails closed', () => {
    for (const bad of [0, 999, 60_001, 1.5, NaN, '30000']) {
        assert.throws(() => new ProviderQuiesce({ ttlMs: bad }), /INVALID_QUIESCE_TTL/);
    }
    for (const bad of [999, 60 * 60_000 + 1, 1.5, NaN, '1000']) {
        assert.throws(() => new ProviderQuiesce({ ttlMs: 30_000, maxWindowMs: bad }), /INVALID_QUIESCE_WINDOW/);
    }
});

test('status reports remaining time without exposing the token', () => {
    const c = clock();
    const q = new ProviderQuiesce({ now: c.now, ttlMs: 30_000, maxWindowMs: 600_000 });
    const token = q.begin('trace run');
    const s = q.status();
    assert.equal(s.held, true);
    assert.equal(s.reason, 'trace run');
    assert.equal(s.remainingMs, 30_000);
    assert.equal(s.windowRemainingMs, 600_000);
    assert.equal(JSON.stringify(s).includes(token), false, 'status must not leak the lease token');
});
