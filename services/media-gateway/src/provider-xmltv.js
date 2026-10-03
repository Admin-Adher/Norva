'use strict';
const { Readable } = require('node:stream');
const { createProviderMetadataTransport, finishProviderMetadataTransport } = require('./provider-metadata-transport');
const { guideSnapshotKey, createGuideSnapshotCache } = require('./provider-guide-snapshots');
const snapshots = createGuideSnapshotCache();

// XMLTV uses the same pinned provider egress and cancellation ledger as short
// EPG. The provider connection is closed before returning a successful guide.
async function fetchGatewayXmltv(body, hooks) {
    const start = Number(body.windowStartMs), end = Number(body.windowEndMs);
    const keys = value => Array.isArray(value) && value.length <= 64
        && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 256);
    if (!body.serverUrl || !body.username || !body.password || !Number.isFinite(start)
        || !Number.isFinite(end) || end <= start || end - start > 72 * 3600000
        || Math.abs(start - Date.now()) > 25 * 3600000
        || (body.channelIds !== undefined && !keys(body.channelIds))
        || (body.channelNames !== undefined && !keys(body.channelNames))
        || (body.cacheScope !== undefined && !/^[a-f0-9]{64}$/.test(String(body.cacheScope)))) {
        throw Object.assign(new Error('Invalid guide request'), { status: 400 });
    }
    const url = new URL(`${String(body.serverUrl).replace(/\/+$/, '')}/xmltv.php`);
    url.searchParams.set('username', body.username);
    url.searchParams.set('password', body.password);
    const { fetchProviderXmltv } = await import('./provider-epg-shared/provider-epg.mjs');
    const parseOptions = { timeoutMs: 45000, windowStartMs: start, windowEndMs: end, maxProgrammes: 80000,
        ...(body.channelIds !== undefined ? { channelIds: body.channelIds } : {}),
        ...(body.channelNames !== undefined ? { channelNames: body.channelNames } : {}) };
    const cache = hooks.snapshots || snapshots, cacheKey = guideSnapshotKey(body);
    const cached = cache.get(cacheKey);
    const readSnapshot = async () => {
        let offset = 0;
        // Yield between bounded slices so parsing a large retained feed cannot
        // monopolize the video gateway's event loop.
        const stream = new ReadableStream({ async pull(ctl) {
            if (offset >= cached.raw.length) { ctl.close(); return; }
            await new Promise(resolve => setImmediate(resolve));
            ctl.enqueue(cached.raw.subarray(offset, offset + 65536)); offset += 65536;
        } });
        return (await fetchProviderXmltv(url.href, {
            ...parseOptions, fetch: async () => new Response(stream),
        })).value;
    };
    if (cached?.fresh) return await readSnapshot();
    const accountKey = hooks.accountKey(body.serverUrl, body.username);
    try { hooks.assertAdmission(accountKey); }
    catch (error) {
        // A retained feed can answer a new channel/time selection without any
        // provider connection. The parser still drops expired programmes.
        if (cached && [409, 429].includes(error.status)) return await readSnapshot();
        throw error;
    }
    const controller = new AbortController();
    const transport = createProviderMetadataTransport(controller);
    const registration = hooks.register(accountKey, transport);
    const connections = [];
    let snapshotParts = [], snapshotBytes = 0, completeSnapshot = false;
    let drained = true;
    try {
        const result = await fetchProviderXmltv(url.href, {
            ...parseOptions,
            headers: { 'User-Agent': hooks.userAgent, 'Accept': 'application/xml,text/xml,*/*' },
            fetch: async (endpoint, options) => {
                const upstream = await hooks.open(endpoint, {
                    headers: options.headers, signal: AbortSignal.any([options.signal, controller.signal]),
                });
                connections.push(upstream);
                let stream = upstream.body ? Readable.toWeb(upstream.body) : null;
                if (stream && upstream.status === 200 && cacheKey) {
                    snapshotParts = []; snapshotBytes = 0;
                    stream = stream.pipeThrough(new TransformStream({ transform(chunk, ctl) {
                        snapshotBytes += chunk.byteLength;
                        if (snapshotBytes > 128 * 1024 * 1024) throw new Error('Guide snapshot exceeds limit');
                        snapshotParts.push(Buffer.from(chunk)); ctl.enqueue(chunk);
                    } }));
                }
                const response = new Response(stream, {
                    status: upstream.status, headers: upstream.headers,
                });
                // Redirects must release their dispatcher before the next hop.
                if ([301, 302, 303, 307, 308].includes(upstream.status)) {
                    await response.body?.cancel();
                    await upstream.close();
                    connections.pop();
                }
                return response;
            },
        });
        if (!result.response.ok) throw Object.assign(new Error('Provider guide unavailable'), { status: 502 });
        if (registration?.preempted) throw Object.assign(new Error('Guide deferred for playback'), { status: 409, code: 'viewer_preempted' });
        completeSnapshot = true;
        return result.value;
    } catch (error) {
        if (registration?.preempted) throw Object.assign(new Error('Guide deferred for playback'), { status: 409, code: 'viewer_preempted' });
        if (error?.providerDrainFailed) transport.providerDrainFailed = true;
        throw error;
    } finally {
        for (const connection of connections) {
            try { connection.body?.destroy?.(); await connection.close(); } catch (_) { drained = false; }
        }
        if (!drained) transport.providerDrainFailed = true;
        await finishProviderMetadataTransport(transport, null, registration);
        if (completeSnapshot && transport.providerDrained && !registration?.preempted && snapshotBytes)
            cache.set(cacheKey, Buffer.concat(snapshotParts, snapshotBytes));
    }
}

module.exports = { fetchGatewayXmltv };
