'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const { registerMaintenance } = require('../services/media-gateway/src/maintenance-http');
test('real HTTP admission, authenticated maintenance, viewer priority and final listener closure', async t => {
    const app = express(); app.use(express.json());
    let server, active = 0;
    const fence = registerMaintenance({ app, enabled: true,
        authenticate: (req, res, next) => req.headers.authorization === 'Bearer test-only' ? next() : res.sendStatus(401),
        snapshot: () => ({ activeOperations: active, viewerSessions: 0, jobs: [] }), persisted: async () => [],
        closeAdmissions: () => server.close(), wake() {}, viewerRequest: req => req.path === '/sessions',
    });
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.post('/sessions', (_req, res) => res.json({ started: true }));
    app.post('/job', (_req, res) => res.json({ queued: true }));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body = {}, auth = true) => fetch(url + route, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer test-only' } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/maintenance/prepare', {}, false)).status, 401);
    assert.equal(fence.state, null);
    const first = await (await post('/maintenance/prepare')).json(); assert.equal(first.ready, true);
    assert.equal((await post('/job')).status, 503);
    assert.equal((await fetch(url + '/health')).status, 200);
    assert.equal((await post('/sessions')).status, 200, 'viewer cancels uncommitted maintenance');
    assert.equal((await post('/maintenance/commit', { token: first.token })).status, 409);
    active = 1;
    const busy = await post('/maintenance/prepare'); assert.equal(busy.status, 202);
    const { token } = await busy.json();
    assert.equal((await post('/maintenance/commit', { token })).status, 409);
    active = 0;
    assert.equal((await post('/maintenance/commit', { token })).status, 200);
    assert.equal(server.listening, false);
    assert.equal(fence.state.phase, 'committed');
});
