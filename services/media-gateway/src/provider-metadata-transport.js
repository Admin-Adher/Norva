'use strict';
const { EventEmitter } = require('node:events');

function isUndrainedProviderMetadata(entry) {
    return entry?.child?.providerMetadataTransport === true && entry.child.providerDrained !== true;
}

// Close the cross-gateway gap between the Edge's DB ownership check and a
// delayed HTTP request reaching this process after its drain was acknowledged.
function createProviderMetadataPriorityFence({ ttlMs = 120000, maxEntries = 4096, now = Date.now } = {}) {
    const ttl = Math.max(1, Math.min(120000, Math.floor(Number(ttlMs) || 120000)));
    const maximum = Math.max(1, Math.min(4096, Math.floor(Number(maxEntries) || 4096)));
    const reservations = new Map();
    let overflowUntil = 0;
    return {
        reserve(affinities) {
            const instant = now();
            for (const [key, until] of reservations) if (until <= instant) reservations.delete(key);
            for (const key of affinities) {
                if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) continue;
                if (reservations.has(key) || reservations.size < maximum) reservations.set(key, instant + ttl);
                // Never evict a still-protected account to admit another one.
                else overflowUntil = Math.max(overflowUntil, instant + ttl);
            }
        },
        has(key) {
            const instant = now();
            if (overflowUntil > instant) return true;
            const until = reservations.get(key) || 0;
            if (until <= instant) { reservations.delete(key); return false; }
            return true;
        },
        get size() { return reservations.size; },
    };
}

// A metadata HTTP operation is not a subprocess. Its owner acknowledges the
// provider dispatcher close from finally; abort alone never proves drainage.
function createProviderMetadataTransport(controller) {
    const transport = new EventEmitter();
    let settle;
    const completed = new Promise(resolve => { settle = resolve; });
    Object.assign(transport, { providerMetadataTransport: true, providerDrained: false,
        exitCode: null, signalCode: null, providerDrainFailed: false });
    transport.kill = () => { controller.abort(); return true; };
    transport.finish = drained => {
        if (transport.exitCode !== null) return;
        transport.providerDrained = drained === true;
        transport.exitCode = drained === true ? 0 : 1;
        settle(transport.providerDrained);
        transport.emit('exit', transport.exitCode, null);
    };
    transport.stopAndDrain = async (timeoutMs = 5000) => {
        controller.abort();
        let timer;
        return await Promise.race([completed,
            new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
        ]).finally(() => clearTimeout(timer));
    };
    return transport;
}

async function finishProviderMetadataTransport(transport, response, registration) {
    let drained = transport.providerDrainFailed !== true;
    try { await response?.close?.(); } catch (_) { drained = false; }
    transport.finish(drained);
    // Retain an uncertain transport in the admission ledger. Another caller
    // must not declare it gone solely because cancellation was requested.
    if (drained) registration?.release?.();
}

module.exports = { createProviderMetadataTransport, finishProviderMetadataTransport,
    createProviderMetadataPriorityFence, isUndrainedProviderMetadata };
