'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fixtureAssetPath } = require('./fixture-registry');

const FIXED_LAST_MODIFIED = 'Mon, 17 Aug 2026 00:00:00 GMT';
const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    for await (const chunk of input) hash.update(chunk);
    return hash.digest('hex');
}

function parseSingleRange(header, totalBytes) {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!match || (!match[1] && !match[2])) return false;
    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
        start = Math.max(0, totalBytes - suffixLength);
        end = totalBytes - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : totalBytes - 1;
        if (
            !Number.isSafeInteger(start)
            || !Number.isSafeInteger(end)
            || start < 0
            || end < start
            || start >= totalBytes
        ) return false;
        end = Math.min(end, totalBytes - 1);
    }
    return Object.freeze({ start, end });
}

function ifRangeAllowsRange(ifRange, record) {
    if (!ifRange) return true;
    const value = String(ifRange).trim();
    if (value === FIXED_LAST_MODIFIED) return true;
    return record.etagMode === 'strong' && value === record.etag;
}

function wait(delayMs, signal) {
    if (!delayMs) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const done = () => {
            signal.removeEventListener('abort', abort);
            resolve();
        };
        const timer = setTimeout(done, delayMs);
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(Object.assign(new Error('request aborted'), { code: 'ABORT_ERR' }));
        };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
    });
}

class ProviderSimulator {
    #fixtureRoot;
    #runs = new Map();

    constructor({ fixtureRoot }) {
        if (!fixtureRoot) throw new Error('MEDIA_LAB_FIXTURE_ROOT_REQUIRED');
        this.#fixtureRoot = path.resolve(fixtureRoot);
    }

    async fixtureAvailable(fixture) {
        if (!fixture.provider.assetRequired) return true;
        const assetPath = fixtureAssetPath(this.#fixtureRoot, fixture);
        try {
            const stat = await fsp.stat(assetPath);
            return stat.isFile() && stat.size > 0;
        } catch (_) {
            return false;
        }
    }

    async openFixture(fixture, providerBaseUrl) {
        const origin = new URL(providerBaseUrl);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
            throw new Error('MEDIA_LAB_PROVIDER_ORIGIN_INVALID');
        }
        origin.pathname = '/';
        origin.search = '';
        origin.hash = '';

        let assetPath = null;
        let totalBytes = 0;
        let digest = crypto.createHash('sha256').update(`response-only:${fixture.id}`).digest('hex');
        if (fixture.provider.assetRequired) {
            assetPath = fixtureAssetPath(this.#fixtureRoot, fixture);
            const stat = await fsp.stat(assetPath);
            if (!stat.isFile() || stat.size <= 0) throw new Error('MEDIA_LAB_FIXTURE_UNAVAILABLE');
            totalBytes = stat.size;
            digest = await sha256File(assetPath);
        }

        const capability = crypto.randomBytes(32).toString('hex');
        const etag = fixture.provider.etag === 'weak'
            ? `W/\"${digest}\"`
            : `\"${digest}\"`;
        const counters = {
            providerGets: 0,
            providerHeads: 0,
            rangeGets: 0,
            http458: 0,
            activeGets: 0,
            maximumConcurrentProviderGets: 0,
            bytesServed: 0,
            mediaRequests: 0,
        };
        const record = {
            fixture,
            assetPath,
            totalBytes,
            etag,
            etagMode: fixture.provider.etag,
            counters,
            closed: false,
        };
        this.#runs.set(capability, record);

        const mediaUrl = new URL(`/internal/provider/${capability}/media.mkv`, origin).toString();
        let closed = false;
        return Object.freeze({
            mediaUrl,
            snapshot: () => Object.freeze({ ...counters }),
            resetCounters: () => {
                if (closed || record.closed || this.#runs.get(capability) !== record || counters.activeGets !== 0) {
                    return false;
                }
                for (const key of Object.keys(counters)) counters[key] = 0;
                return true;
            },
            close: () => {
                if (closed) return false;
                closed = true;
                record.closed = true;
                return this.#runs.delete(capability);
            },
            capabilityActive: () => this.#runs.get(capability) === record,
        });
    }

    async handle(request, response) {
        const requestUrl = new URL(request.url || '/', 'http://media-lab.invalid');
        const match = /^\/internal\/provider\/([a-f0-9]{64})\/media\.mkv$/.exec(requestUrl.pathname);
        if (!match || !CAPABILITY_PATTERN.test(match[1])) return false;

        const record = this.#runs.get(match[1]);
        setPrivateHeaders(response);
        if (!record || record.closed) {
            response.statusCode = 404;
            response.end(JSON.stringify({ error: 'Not found' }));
            return true;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.statusCode = 405;
            response.setHeader('Allow', 'GET, HEAD');
            response.end(JSON.stringify({ error: 'Method not allowed' }));
            return true;
        }

        const isGet = request.method === 'GET';
        record.counters.mediaRequests += 1;
        const requestOrdinal = record.counters.mediaRequests;
        if (isGet) {
            record.counters.providerGets += 1;
            record.counters.activeGets += 1;
            record.counters.maximumConcurrentProviderGets = Math.max(
                record.counters.maximumConcurrentProviderGets,
                record.counters.activeGets,
            );
        } else {
            record.counters.providerHeads += 1;
        }

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (isGet) record.counters.activeGets = Math.max(0, record.counters.activeGets - 1);
        };
        response.once('finish', finish);
        response.once('close', finish);

        const abortController = new AbortController();
        request.once('aborted', () => abortController.abort());
        response.once('close', () => abortController.abort());

        try {
            await wait(record.fixture.provider.delayMs, abortController.signal);
            if (record.fixture.provider.first458 && requestOrdinal === 1) {
                record.counters.http458 += 1;
                response.statusCode = 458;
                response.setHeader('Retry-After', '120');
                response.end(JSON.stringify({ error: 'Provider busy' }));
                return true;
            }
            if (!record.assetPath) {
                response.statusCode = 503;
                response.end(JSON.stringify({ error: 'Fixture unavailable' }));
                return true;
            }

            response.setHeader('Accept-Ranges', 'bytes');
            response.setHeader('Content-Type', 'video/x-matroska');
            response.setHeader('Last-Modified', FIXED_LAST_MODIFIED);
            response.setHeader('ETag', record.etag);
            let range = parseSingleRange(request.headers.range, record.totalBytes);
            if (range && !ifRangeAllowsRange(request.headers['if-range'], record)) range = null;
            if (range === false) {
                response.statusCode = 416;
                response.setHeader('Content-Range', `bytes */${record.totalBytes}`);
                response.end();
                return true;
            }

            const start = range ? range.start : 0;
            const end = range ? range.end : record.totalBytes - 1;
            const length = end - start + 1;
            if (range) {
                if (isGet) record.counters.rangeGets += 1;
                response.statusCode = 206;
                response.setHeader('Content-Range', `bytes ${start}-${end}/${record.totalBytes}`);
            } else {
                response.statusCode = 200;
            }
            response.setHeader('Content-Length', String(length));
            if (!isGet) {
                response.end();
                return true;
            }

            const byteCounter = new Transform({
                transform(chunk, _encoding, callback) {
                    record.counters.bytesServed += chunk.length;
                    callback(null, chunk);
                },
            });
            await pipeline(fs.createReadStream(record.assetPath, { start, end }), byteCounter, response);
            return true;
        } catch (error) {
            if (error?.code !== 'ABORT_ERR' && !response.headersSent) {
                response.statusCode = 500;
                response.end(JSON.stringify({ error: 'Provider simulator failed' }));
            }
            return true;
        } finally {
            finish();
        }
    }
}

function setPrivateHeaders(response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
}

module.exports = Object.freeze({
    ProviderSimulator,
    FIXED_LAST_MODIFIED,
    parseSingleRange,
});
