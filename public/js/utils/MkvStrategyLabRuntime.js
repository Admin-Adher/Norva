/**
 * Browser adapter for the admin-only MKV Strategy Lab.
 *
 * It sends only a fixed fixture enum to the Supabase admin boundary. Provider
 * URLs, Gateway tokens, media session identifiers and runner handles never
 * exist in this browser contract.
 */
(function registerMkvStrategyLabRuntime(global) {
    'use strict';

    const PROTOCOL = 1;
    const MAX_RESPONSE_BYTES = 64 * 1024;
    const POLL_INTERVAL_MS = 500;
    const FIXTURE_IDS = new Set([
        'h264-closed-aac', 'h264-closed-ac3', 'h264-open-gop', 'h264-multi-audio',
        'hevc-eac3-cold', 'h264-level52', 'h264-bad-timestamps', 'h264-pgs',
        'h264-no-etag', 'hevc-full-cache', 'provider-458'
    ]);

    function exactRequest(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const keys = Object.keys(value).sort();
        if (keys.length !== 2 || keys[0] !== 'fixtureId' || keys[1] !== 'protocol') return null;
        if (value.protocol !== PROTOCOL || !FIXTURE_IDS.has(value.fixtureId)) return null;
        return Object.freeze({ protocol: PROTOCOL, fixtureId: value.fixtureId });
    }

    function abortError() {
        const error = new Error('RUNTIME_ABORTED');
        error.name = 'AbortError';
        return error;
    }

    function abortableDelay(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(abortError()); return; }
            const timer = setTimeout(done, ms);
            function done() {
                signal?.removeEventListener?.('abort', aborted);
                resolve();
            }
            function aborted() {
                clearTimeout(timer);
                signal?.removeEventListener?.('abort', aborted);
                reject(abortError());
            }
            signal?.addEventListener?.('abort', aborted, { once: true });
        });
    }

    async function boundedJson(response) {
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('RUNTIME_RESPONSE_TOO_LARGE');
        const text = await response.text();
        if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error('RUNTIME_RESPONSE_TOO_LARGE');
        try { return JSON.parse(text); } catch (_) { throw new Error('RUNTIME_RESPONSE_INVALID'); }
    }

    class MkvStrategyLabRuntime {
        constructor(options) {
            const input = options && typeof options === 'object' ? options : {};
            let parsed;
            try { parsed = new URL(String(input.baseUrl || '')); } catch (_) { parsed = null; }
            if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('RUNTIME_BASE_URL_INVALID');
            this.baseUrl = parsed.toString().replace(/\/+$/, '');
            this.apiKey = String(input.apiKey || '');
            this.getToken = typeof input.getToken === 'function' ? input.getToken : () => '';
            this.fetchImpl = typeof input.fetchImpl === 'function' ? input.fetchImpl : global.fetch.bind(global);
            this.protocol = PROTOCOL;
            this.active = false;
        }

        async request(method, route, body, signal) {
            const token = String(this.getToken() || '');
            if (!token || !this.apiKey) throw new Error('RUNTIME_AUTH_UNAVAILABLE');
            const response = await this.fetchImpl(
                `${this.baseUrl}/functions/v1/norva-admin-media-lab/${route}`,
                {
                    method,
                    headers: {
                        apikey: this.apiKey,
                        Authorization: `Bearer ${token}`,
                        ...(body ? { 'Content-Type': 'application/json' } : {})
                    },
                    body: body ? JSON.stringify(body) : undefined,
                    signal,
                    cache: 'no-store',
                    credentials: 'omit'
                }
            );
            if (method === 'DELETE' && response.status === 204) return null;
            const payload = await boundedJson(response);
            if (!response.ok) {
                const reason = typeof payload?.error === 'string' ? payload.error : 'runtime-request-refused';
                throw new Error(`RUNTIME_${reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
            }
            if (!payload || payload.protocol !== PROTOCOL) throw new Error('RUNTIME_PROTOCOL_INVALID');
            return payload;
        }

        async cancel() {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5_000);
            try { await this.request('DELETE', 'current', null, controller.signal); } catch (_) { /* cleanup is best effort here; server TTL remains authoritative */ }
            finally { clearTimeout(timer); }
        }

        async runCase(value, options) {
            const request = exactRequest(value);
            if (!request) throw new Error('INVALID_RUNTIME_REQUEST');
            if (this.active) throw new Error('RUNTIME_BUSY');
            const signal = options?.signal;
            if (signal?.aborted) throw abortError();
            this.active = true;
            try {
                const started = await this.request('POST', 'run', request, signal);
                if (started.state === 'complete' && started.fixtureId === request.fixtureId && started.result) {
                    return started.result;
                }
                if (started.state !== 'running' || started.fixtureId !== request.fixtureId) {
                    throw new Error('RUNTIME_START_INVALID');
                }
                while (true) {
                    await abortableDelay(POLL_INTERVAL_MS, signal);
                    const current = await this.request('GET', 'current', null, signal);
                    if (current.state === 'running') {
                        if (current.fixtureId !== request.fixtureId) throw new Error('RUNTIME_FIXTURE_DRIFT');
                        continue;
                    }
                    if (current.state !== 'complete' || current.fixtureId !== request.fixtureId || !current.result) {
                        throw new Error('RUNTIME_STATE_INVALID');
                    }
                    return current.result;
                }
            } catch (error) {
                if (signal?.aborted || error?.name === 'AbortError') await this.cancel();
                throw error;
            } finally {
                this.active = false;
            }
        }
    }

    Object.defineProperty(global, 'MkvStrategyLabRuntime', {
        value: MkvStrategyLabRuntime,
        configurable: false,
        enumerable: false,
        writable: false
    });
})(window);
