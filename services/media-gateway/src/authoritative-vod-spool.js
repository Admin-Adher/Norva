'use strict';

const crypto = require('node:crypto');
const { createWeakValidatorAttestationSpool } = require('./weakValidatorAttestationSpool');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fail = (code) => Object.assign(new Error(code), { code });
const identityDigest = (identity) => {
    const fields = ['tenant', 'provider', 'item', 'variant', 'sourceRevision', 'profile'];
    if (!identity || fields.some(k => typeof identity[k] !== 'string' || !identity[k])) throw fail('SPOOL_IDENTITY_REQUIRED');
    return hash(JSON.stringify(fields.map(k => identity[k])));
};

function verifySpoolAttestation(envelope, key, identity, initialUrl, now = Date.now()) {
    try {
        if (!key || Buffer.byteLength(key) < 32) return false;
        const p = envelope.payload;
        const signature = crypto.createHmac('sha256', key).update(JSON.stringify(p)).digest();
        const supplied = Buffer.from(envelope.signature, 'hex');
        return supplied.length === signature.length && crypto.timingSafeEqual(signature, supplied)
            && p.protocol === 1 && p.identityKind === 'content-sha256'
            && p.identityDigest === identityDigest(identity) && p.initialUrlSha256 === hash(initialUrl)
            && /^[a-f0-9]{64}$/.test(p.contentSha256) && /^[a-f0-9]{64}$/.test(p.effectiveUrlSha256)
            && Number.isSafeInteger(p.bytes) && p.bytes > 0
            && p.issuedAtMs <= now && p.expiresAtMs > now;
    } catch (_) { return false; }
}

// Tee an existing playback response; this helper cannot open a provider URL.
// The caller must observe exact EOF on that single response before finalize.
async function createAuthoritativePlaybackSpool(options) {
    const binding = identityDigest(options.identity);
    if (!options.signingKey || Buffer.byteLength(options.signingKey) < 32) throw fail('SPOOL_SIGNING_KEY_REQUIRED');
    if (!/^https?:/.test(options.effectiveUrl || '')) throw fail('SPOOL_EFFECTIVE_URL_REQUIRED');
    const spool = await createWeakValidatorAttestationSpool(options);
    return {
        append: chunk => spool.append(chunk),
        cleanup: () => spool.cleanup(),
        async finalize() {
            const result = await spool.finalize();
            const issuedAtMs = Date.now();
            const payload = { protocol: 1, identityKind: 'content-sha256', identityDigest: binding,
                initialUrlSha256: hash(options.sourceUrl), effectiveUrlSha256: hash(options.effectiveUrl),
                bytes: result.bytes, contentSha256: result.contentSha256,
                issuedAtMs, expiresAtMs: issuedAtMs + (options.ttlMs || 3_600_000) };
            return { ...result, spool, downloadMs: result.durationMs,
                attestation: { payload, signature: crypto.createHmac('sha256', options.signingKey)
                    .update(JSON.stringify(payload)).digest('hex') } };
        },
    };
}

// Exactly one response, starting at zero. Neither reconnect nor range resume
// can establish object continuity without a strong provider validator.
async function acquireAuthoritativeVodSpool(options) {
    const { identity, sourceUrl, signingKey, openProviderGet } = options;
    const binding = identityDigest(identity);
    if (!signingKey || Buffer.byteLength(signingKey) < 32) throw fail('SPOOL_SIGNING_KEY_REQUIRED');
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, options.maxMs || 30 * 60_000);
    timer.unref?.();
    let spool, reader;
    try {
        const response = await openProviderGet({ url: sourceUrl, signal: controller.signal,
            headers: { 'Accept-Encoding': 'identity', Range: 'bytes=0-' } });
        reader = response.body?.getReader();
        if (!reader) throw fail('SPOOL_BODY_REQUIRED');
        if (![200, 206].includes(response.status)) throw fail('SPOOL_HTTP_ERROR');
        if (!/^https?:/.test(response.url || '')) throw fail('SPOOL_EFFECTIVE_URL_REQUIRED');
        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity') throw fail('SPOOL_ENCODED_BODY');
        const lengthHeader = response.headers.get('content-length');
        let size = lengthHeader === null ? null : Number(lengthHeader);
        if (size !== null && (!Number.isSafeInteger(size) || size <= 0)) throw fail('SPOOL_INVALID_LENGTH');
        if (response.status === 206) {
            const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
            if (!range || Number(range[1]) + 1 !== Number(range[2]) || size !== Number(range[2])) throw fail('SPOOL_INCOMPLETE_RANGE');
        }
        spool = await createWeakValidatorAttestationSpool({ ...options, expectedBytes: size });
        options.onSpool?.(spool);
        const started = Date.now();
        while (true) {
            if (controller.signal.aborted) throw fail('SPOOL_ABORTED');
            let idle;
            const next = await Promise.race([reader.read(), new Promise((_, reject) => {
                idle = setTimeout(() => { abort(); reject(fail('SPOOL_IDLE_TIMEOUT')); }, options.idleMs || 30_000);
            })]).finally(() => clearTimeout(idle));
            if (controller.signal.aborted) throw fail('SPOOL_ABORTED');
            if (next.done) break;
            await spool.append(next.value);
        }
        const result = await spool.finalize();
        const issuedAtMs = Date.now();
        const payload = { protocol: 1, identityKind: 'content-sha256', identityDigest: binding,
            initialUrlSha256: hash(sourceUrl), effectiveUrlSha256: hash(response.url),
            bytes: result.bytes, contentSha256: result.contentSha256,
            issuedAtMs, expiresAtMs: issuedAtMs + (options.ttlMs || 3_600_000) };
        const attestation = { payload, signature: crypto.createHmac('sha256', signingKey).update(JSON.stringify(payload)).digest('hex') };
        return { ...result, attestation, spool, downloadMs: issuedAtMs - started };
    } catch (error) {
        await spool?.cleanup();
        throw error;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        controller.abort();
        await reader?.cancel().catch(() => {});
    }
}

module.exports = { acquireAuthoritativeVodSpool, createAuthoritativePlaybackSpool, verifySpoolAttestation };
