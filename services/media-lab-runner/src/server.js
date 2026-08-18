'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const {
    PROTOCOL,
    RequestValidationError,
    parseRunRequest,
} = require('./fixture-registry');
const { ProviderSimulator } = require('./provider-simulator');
const { MediaLabRunner } = require('./runner');
const { blockedResult } = require('./result-projection');
const { HttpPhysicalAdapter } = require('./http-physical-adapter');
const { GatewayChromiumPhysicalAdapter } = require('./gateway-chromium-adapter');

const MAX_BODY_BYTES = 1_024;
const MAX_ACTOR_STATES = 256;
const COMPLETED_STATE_TTL_MS = 15 * 60 * 1_000;
const ACTOR_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function timingSafeTokenEqual(supplied, expected) {
    const left = Buffer.from(String(supplied || ''), 'utf8');
    const right = Buffer.from(String(expected || ''), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearerToken(request) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(String(request.headers.authorization || '').trim());
    return match?.[1] || '';
}

function actorToken(request) {
    const value = String(request.headers['x-norva-lab-actor'] || '').trim();
    return ACTOR_PATTERN.test(value) ? value : '';
}

function publicActorState(record, runnerBusy) {
    if (!record) return Object.freeze({ protocol: PROTOCOL, state: runnerBusy ? 'busy' : 'idle' });
    if (record.state === 'running') {
        return Object.freeze({ protocol: PROTOCOL, state: 'running', fixtureId: record.fixture.id });
    }
    return Object.freeze({
        protocol: PROTOCOL,
        state: 'complete',
        fixtureId: record.fixture.id,
        result: record.result,
    });
}

function setJsonHeaders(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(response, statusCode, body) {
    if (response.destroyed || response.writableEnded) return;
    setJsonHeaders(response);
    response.statusCode = statusCode;
    response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { statusCode: 413 });
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
            throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { statusCode: 413 });
        }
        chunks.push(chunk);
    }
    if (bytes === 0) throw Object.assign(new Error('INVALID_JSON'), { statusCode: 400 });
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
        throw Object.assign(new Error('INVALID_JSON'), { statusCode: 400 });
    }
}

function normalizedOrigin(address, host, explicitOrigin) {
    if (explicitOrigin) {
        const value = new URL(explicitOrigin);
        if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) {
            throw new Error('MEDIA_LAB_PROVIDER_ORIGIN_INVALID');
        }
        value.pathname = '/';
        value.search = '';
        value.hash = '';
        return value.toString();
    }
    if (!address || typeof address === 'string') throw new Error('MEDIA_LAB_LISTENER_ADDRESS_INVALID');
    const originHost = host === '::1' ? '[::1]' : (host === '0.0.0.0' ? '127.0.0.1' : host);
    return `http://${originHost}:${address.port}/`;
}

function physicalAdapterFromEnvironment(env = process.env) {
    const url = String(env.MEDIA_LAB_PHYSICAL_ADAPTER_URL || '').trim();
    const token = String(env.MEDIA_LAB_PHYSICAL_ADAPTER_TOKEN || '');
    const gatewayUrl = String(env.MEDIA_LAB_GATEWAY_URL || '').trim();
    const gatewayToken = String(env.MEDIA_LAB_GATEWAY_TOKEN || '');
    const hasRemote = Boolean(url || token);
    const hasInline = Boolean(gatewayUrl || gatewayToken);
    if (hasRemote && hasInline) throw new Error('MEDIA_LAB_PHYSICAL_ADAPTER_CONFLICT');
    if (hasRemote) return new HttpPhysicalAdapter({ url, token });
    if (!hasInline) return null;
    return new GatewayChromiumPhysicalAdapter({
        gatewayUrl,
        gatewayToken,
        hlsJsPath: env.MEDIA_LAB_HLS_JS_PATH,
        chromiumExecutablePath: env.MEDIA_LAB_CHROMIUM_EXECUTABLE_PATH || null,
        sessionTimeoutMs: Number(env.MEDIA_LAB_GATEWAY_SESSION_TIMEOUT_MS) || undefined,
        browserTimeoutMs: Number(env.MEDIA_LAB_BROWSER_TIMEOUT_MS) || undefined,
    });
}

function createMediaLabService({
    token,
    fixtureRoot,
    adapter = null,
    host = '127.0.0.1',
    providerOrigin = null,
    runTimeoutMs = 600_000,
} = {}) {
    const expectedToken = String(token || '');
    if (expectedToken.length < 32 || /\s/.test(expectedToken)) {
        throw new Error('MEDIA_LAB_RUNNER_TOKEN must contain at least 32 non-whitespace characters');
    }
    if (!fixtureRoot) throw new Error('MEDIA_LAB_FIXTURE_ROOT_REQUIRED');
    if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) {
        throw new Error('MEDIA_LAB_BIND_HOST_INVALID');
    }

    const providerSimulator = new ProviderSimulator({ fixtureRoot });
    let activeOrigin = providerOrigin;
    const runner = new MediaLabRunner({
        providerSimulator,
        getProviderBaseUrl: () => {
            if (!activeOrigin) throw new Error('MEDIA_LAB_PROVIDER_ORIGIN_UNAVAILABLE');
            return activeOrigin;
        },
        adapter,
        runTimeoutMs,
    });
    const actorStates = new Map();

    const pruneActorStates = () => {
        const now = Date.now();
        for (const [actor, record] of actorStates) {
            if (record.state === 'complete' && now - record.updatedAtMs > COMPLETED_STATE_TTL_MS) {
                actorStates.delete(actor);
            }
        }
        if (actorStates.size <= MAX_ACTOR_STATES) return;
        const completed = [...actorStates.entries()]
            .filter(([, record]) => record.state === 'complete')
            .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
        while (actorStates.size > MAX_ACTOR_STATES && completed.length) {
            actorStates.delete(completed.shift()[0]);
        }
    };

    const startActorRun = (actor, body) => {
        pruneActorStates();
        const fixture = parseRunRequest(body);
        const current = actorStates.get(actor);
        if (current?.state === 'running' || runner.busy || (!current && actorStates.size >= MAX_ACTOR_STATES)) {
            return Object.freeze({ fixture, blocked: blockedResult(fixture, 'runner-busy') });
        }
        const controller = new AbortController();
        const record = {
            fixture,
            state: 'running',
            result: null,
            controller,
            updatedAtMs: Date.now(),
            promise: null,
        };
        actorStates.set(actor, record);
        record.promise = runner.runCase(body, { signal: controller.signal }).then(
            (result) => {
                if (actorStates.get(actor) !== record) return result;
                record.state = 'complete';
                record.result = result;
                record.updatedAtMs = Date.now();
                return result;
            },
            () => {
                const result = blockedResult(fixture, 'runner-internal-failed');
                if (actorStates.get(actor) === record) {
                    record.state = 'complete';
                    record.result = result;
                    record.updatedAtMs = Date.now();
                }
                return result;
            },
        );
        return Object.freeze({ fixture, record });
    };

    const server = http.createServer(async (request, response) => {
        try {
            if (await providerSimulator.handle(request, response)) return;

            const requestUrl = new URL(request.url || '/', 'http://media-lab.invalid');
            if (!timingSafeTokenEqual(bearerToken(request), expectedToken)) {
                sendJson(response, 401, { error: 'Unauthorized' });
                return;
            }

            if (requestUrl.pathname === '/health' && requestUrl.search === '') {
                if (request.method !== 'GET') {
                    response.setHeader('Allow', 'GET');
                    sendJson(response, 405, { error: 'Method not allowed' });
                    return;
                }
                sendJson(response, 200, {
                    ok: true,
                    protocol: PROTOCOL,
                    busy: runner.busy,
                    physicalAdapterReady: adapter !== null,
                });
                return;
            }

            if (requestUrl.pathname === '/v1/current' && requestUrl.search === '') {
                const actor = actorToken(request);
                if (!actor) {
                    sendJson(response, 403, { error: 'Actor required' });
                    return;
                }
                pruneActorStates();
                if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
                    response.setHeader('Allow', 'GET, POST, DELETE');
                    sendJson(response, 405, { error: 'Method not allowed' });
                    return;
                }
                if (request.method === 'GET') {
                    sendJson(response, 200, publicActorState(actorStates.get(actor), runner.busy));
                    return;
                }
                if (request.method === 'DELETE') {
                    const current = actorStates.get(actor);
                    if (current?.state === 'running') current.controller.abort(new Error('actor-cancelled'));
                    actorStates.delete(actor);
                    response.statusCode = 204;
                    response.setHeader('Cache-Control', 'no-store');
                    response.end();
                    return;
                }
                if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
                    sendJson(response, 415, { error: 'Unsupported media type' });
                    return;
                }
                const body = await readJsonBody(request);
                const started = startActorRun(actor, body);
                if (started.blocked) {
                    sendJson(response, 200, {
                        protocol: PROTOCOL,
                        state: 'complete',
                        fixtureId: started.fixture.id,
                        result: started.blocked,
                    });
                    return;
                }
                sendJson(response, 202, publicActorState(started.record, true));
                return;
            }

            sendJson(response, 404, { error: 'Not found' });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                sendJson(response, 400, { error: error.code });
                return;
            }
            const statusCode = [400, 413].includes(error?.statusCode) ? error.statusCode : 500;
            sendJson(response, statusCode, {
                error: statusCode === 413
                    ? 'Payload too large'
                    : (statusCode === 400 ? 'Invalid JSON' : 'Media Lab request failed'),
            });
        }
    });
    server.requestTimeout = Math.max(5_000, Math.min(610_000, Number(runTimeoutMs) + 10_000));
    server.headersTimeout = 15_000;

    return Object.freeze({
        server,
        runner,
        providerSimulator,
        actorStates,
        async listen(port = 0) {
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    server.off('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, host);
            });
            activeOrigin = normalizedOrigin(server.address(), host, providerOrigin);
            return Object.freeze({ origin: activeOrigin });
        },
        async close() {
            const running = [];
            for (const record of actorStates.values()) {
                if (record.state !== 'running') continue;
                record.controller.abort(new Error('service-closing'));
                if (record.promise) running.push(record.promise);
            }
            actorStates.clear();
            if (running.length) {
                await Promise.race([
                    Promise.allSettled(running),
                    new Promise((resolve) => setTimeout(resolve, 2_000)),
                ]);
            }
            if (!server.listening) return;
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    });
}

function boundedPort(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 65_535 ? number : fallback;
}

if (require.main === module) {
    const host = String(process.env.MEDIA_LAB_BIND_HOST || '127.0.0.1');
    if (host === '0.0.0.0' && process.env.MEDIA_LAB_ALLOW_REMOTE_BIND !== 'true') {
        throw new Error('MEDIA_LAB_ALLOW_REMOTE_BIND=true is required for 0.0.0.0');
    }
    const service = createMediaLabService({
        token: process.env.MEDIA_LAB_RUNNER_TOKEN,
        fixtureRoot: process.env.MEDIA_LAB_FIXTURE_ROOT
            || path.join(__dirname, '..', 'fixtures', 'generated'),
        host,
        providerOrigin: process.env.MEDIA_LAB_PROVIDER_ORIGIN || null,
        runTimeoutMs: Number(process.env.MEDIA_LAB_RUN_TIMEOUT_MS) || 600_000,
        adapter: physicalAdapterFromEnvironment(),
    });
    service.listen(boundedPort(process.env.PORT, 8093)).then(({ origin }) => {
        const printable = new URL(origin);
        console.log(`Norva Media Lab runner listening on ${printable.hostname}:${printable.port}`);
    });
}

module.exports = Object.freeze({
    createMediaLabService,
    timingSafeTokenEqual,
    readJsonBody,
    physicalAdapterFromEnvironment,
});
