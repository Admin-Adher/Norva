'use strict';
const { Readable } = require('node:stream');
const { createProviderMetadataTransport, finishProviderMetadataTransport } = require('./provider-metadata-transport');

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
        || (body.channelNames !== undefined && !keys(body.channelNames))) {
        throw Object.assign(new Error('Invalid guide request'), { status: 400 });
    }
    const url = new URL(`${String(body.serverUrl).replace(/\/+$/, '')}/xmltv.php`);
    url.searchParams.set('username', body.username);
    url.searchParams.set('password', body.password);
    const controller = new AbortController();
    const transport = createProviderMetadataTransport(controller);
    const accountKey = hooks.accountKey(body.serverUrl, body.username);
    hooks.assertAdmission(accountKey);
    const registration = hooks.register(accountKey, transport);
    const connections = [];
    let drained = true;
    try {
        const { fetchProviderXmltv } = await import('./provider-epg-shared/provider-epg.mjs');
        const result = await fetchProviderXmltv(url.href, {
            timeoutMs: 45000, windowStartMs: start, windowEndMs: end, maxProgrammes: 80000,
            ...(body.channelIds !== undefined ? { channelIds: body.channelIds } : {}),
            ...(body.channelNames !== undefined ? { channelNames: body.channelNames } : {}),
            headers: { 'User-Agent': hooks.userAgent, 'Accept': 'application/xml,text/xml,*/*' },
            fetch: async (endpoint, options) => {
                const upstream = await hooks.open(endpoint, {
                    headers: options.headers, signal: AbortSignal.any([options.signal, controller.signal]),
                });
                connections.push(upstream);
                const response = new Response(upstream.body ? Readable.toWeb(upstream.body) : null, {
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
    }
}

module.exports = { fetchGatewayXmltv };
