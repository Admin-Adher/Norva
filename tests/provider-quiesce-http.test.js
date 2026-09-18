'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerProviderQuiesce } = require('../services/media-gateway/src/provider-quiesce');

test('quiesce closes metadata admission while existing work drains and local/viewer routes remain open', async t => {
    const app = express();
    app.use(express.json());
    const authenticate = (req, res, next) => req.get('authorization') === 'Bearer fixture'
        ? next() : res.sendStatus(401);
    const q = registerProviderQuiesce({ app, authenticate });
    let opened = 0, finishExisting, admitted;
    const admission = new Promise(resolve => { admitted = resolve; });
    app.post('/probe-audio', authenticate, (req, res) => {
        opened++;
        if (req.body.hold) { finishExisting = () => res.json({ ok: true }); admitted(); }
        else res.json({ ok: true });
    });
    app.use((req, res) => { opened++; res.json({ ok: true }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, body = {}, method = 'POST') => fetch(base + path, {
        method, headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    const running = request('/probe-audio', { hold: true });
    await admission;
    const begin = await (await request('/provider-quiesce/begin')).json();
    assert.equal(begin.activeMetadataRequests, 1, 'begin must not claim existing work drained');
    const before = opened;
    for (const [method, path] of [
        ['POST', '/probe-audio'], ['POST', '/probe-audio/'], ['POST', '/detect-language'],
        ['GET', '/detect-language/signed-fixture'], ['POST', '/detect-language/capture/capture'],
        ['POST', '/extract-language-wav'], ['POST', '/benchmark-language/signed-fixture'],
        ['POST', '/provider-route/benchmark'], ['POST', '/xtream/epg'],
        ['POST', '/xtream/series-info'], ['POST', '/xtream/metadata-page'], ['POST', '/xtream/metadata'],
    ]) {
        const response = await request(path, {}, method);
        assert.equal(response.status, 429, path);
        assert.equal(response.headers.get('retry-after'), '30');
        assert.deepEqual(await response.json(), { code: 'LANGUAGE_ENRICHMENT_CAPACITY_BUSY',
            retryable: true, providerDrained: true, providerDrainProtocol: 1 });
    }
    assert.equal(opened, before, 'no blocked handler can open a provider');
    finishExisting();
    assert.equal((await running).status, 200, 'existing work is not interrupted');
    assert.equal(q.status().activeMetadataRequests, 0, 'finish/close cannot double-decrement');
    for (const path of ['/detect-language/finalize', '/detect-language/capture/ack',
        '/detect-language/capture/infer', '/detect-language/capture/status', '/sessions', '/native-sessions',
        '/sessions/stop-provider-affinities', '/transcribe-async/fixture', '/storyboard-async/fixture']) {
        assert.equal((await request(path)).status, 200, path);
    }
    const unauthorized = await fetch(base + '/provider-quiesce/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: begin.token }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(q.status().held, true);
    await request('/provider-quiesce/cancel', { token: begin.token });
    assert.equal((await request('/probe-audio')).status, 200, 'cancel restores admission');
    q.begin();
    q.state.deadline = 0;
    assert.equal((await request('/detect-language')).status, 200, 'expiry restores HTTP admission too');
});
