'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LEASE_TOKEN = '11111111-1111-4111-8111-111111111111';

class InMemoryMediaCacheAuthority {
    #state = 'idle';
    #objectKey = null;
    #leaseExpiresAt = null;
    #claims = 0;
    #followers = 0;
    #maximumFollowers = 0;

    constructor({ leaseTtlMs = 60_000 } = {}) {
        this.leaseTtlMs = Math.max(5_000, Math.min(300_000, Number(leaseTtlMs) || 60_000));
    }

    async claim() {
        this.#claims += 1;
        if (this.#state === 'ready') {
            return { claim_role: 'ready', object_key: this.#objectKey };
        }
        if (this.#state === 'idle' || Date.parse(String(this.#leaseExpiresAt || '')) <= Date.now()) {
            this.#state = 'producing';
            this.#leaseExpiresAt = new Date(Date.now() + this.leaseTtlMs).toISOString();
            return {
                claim_role: 'leader',
                lease_token: LEASE_TOKEN,
                lease_expires_at: this.#leaseExpiresAt,
            };
        }
        this.#followers += 1;
        this.#maximumFollowers = Math.max(this.#maximumFollowers, this.#followers);
        return { claim_role: 'follower', lease_expires_at: this.#leaseExpiresAt };
    }

    async resolve() {
        if (this.#state === 'ready') return { work_state: 'ready', object_key: this.#objectKey };
        if (this.#state !== 'producing') return null;
        return {
            work_state: 'producing',
            producer_stage: 'producing',
            lease_expires_at: this.#leaseExpiresAt,
        };
    }

    async leave() {
        if (this.#followers <= 0) return false;
        this.#followers -= 1;
        return true;
    }

    complete(objectKey) {
        const normalized = String(objectKey || '').toLowerCase();
        if (this.#state !== 'producing' || !/^[a-f0-9]{64}$/.test(normalized)) {
            throw new Error('MEDIA_LAB_SINGLEFLIGHT_COMPLETION_INVALID');
        }
        this.#objectKey = normalized;
        this.#leaseExpiresAt = null;
        this.#state = 'ready';
        return normalized;
    }

    snapshot() {
        return Object.freeze({
            state: this.#state,
            claims: this.#claims,
            followers: this.#followers,
            maximumFollowers: this.#maximumFollowers,
            objectKey: this.#objectKey,
        });
    }
}

async function defaultSingleflightRuntime() {
    const modulePath = path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        'supabase',
        'functions',
        '_shared',
        'media-cache-singleflight.mjs',
    );
    return import(pathToFileURL(modulePath).href);
}

async function runSharedCacheSingleflightCase(options = {}) {
    const clientCount = Math.max(2, Math.min(100, Number(options.clientCount) || 10));
    if (typeof options.produce !== 'function' || typeof options.consume !== 'function') {
        throw new TypeError('MEDIA_LAB_SINGLEFLIGHT_CALLBACKS_REQUIRED');
    }
    const runtime = options.runtime || await defaultSingleflightRuntime();
    if (typeof runtime.awaitMediaCacheSingleflight !== 'function') {
        throw new TypeError('MEDIA_LAB_SINGLEFLIGHT_RUNTIME_INVALID');
    }
    const authority = options.authority || new InMemoryMediaCacheAuthority();
    const startedAt = Date.now();
    let producerRuns = 0;
    let producerPromise = null;

    const clients = Array.from({ length: clientCount }, (_, clientIndex) => (async () => {
        const outcome = await runtime.awaitMediaCacheSingleflight({
            claim: () => authority.claim(),
            resolve: () => authority.resolve(),
            leave: () => authority.leave(),
            timeoutMs: Math.max(1_000, Math.min(60_000, Number(options.timeoutMs) || 30_000)),
            pollMs: Math.max(25, Math.min(1_000, Number(options.pollMs) || 50)),
        });
        let objectKey = outcome.objectKey;
        if (outcome.role === 'leader') {
            if (producerPromise) throw new Error('MEDIA_LAB_SINGLEFLIGHT_DUPLICATE_LEADER');
            producerRuns += 1;
            producerPromise = Promise.resolve()
                .then(() => options.produce())
                .then((producedObjectKey) => authority.complete(producedObjectKey));
            objectKey = await producerPromise;
        } else if (outcome.role !== 'ready') {
            throw new Error('MEDIA_LAB_SINGLEFLIGHT_FOLLOWER_TIMEOUT');
        }
        const consumed = await options.consume({ clientIndex, objectKey, role: outcome.role });
        return Object.freeze({ clientIndex, role: outcome.role, objectKey, consumed });
    })());

    const results = await Promise.all(clients);
    const authoritySnapshot = authority.snapshot();
    if (producerRuns !== 1 || authoritySnapshot.followers !== 0) {
        throw new Error('MEDIA_LAB_SINGLEFLIGHT_RESOURCE_LEAK');
    }
    return Object.freeze({
        protocol: 1,
        clientCount,
        producerRuns,
        leaderCount: results.filter((result) => result.role === 'leader').length,
        readyFollowerCount: results.filter((result) => result.role === 'ready').length,
        elapsedMs: Date.now() - startedAt,
        authority: authoritySnapshot,
        results: Object.freeze(results),
    });
}

module.exports = Object.freeze({
    InMemoryMediaCacheAuthority,
    runSharedCacheSingleflightCase,
});
