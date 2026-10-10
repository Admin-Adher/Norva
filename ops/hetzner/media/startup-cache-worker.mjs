import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function startupTargets(value) {
    if (!Array.isArray(value) || !value.length || value.length > 8) throw Error('Invalid startup target list');
    return value.map(row => {
        if (!row || Object.keys(row).some(k => !['userId', 'sourceId', 'itemType', 'itemId'].includes(k))
            || !uuid.test(row.userId) || !uuid.test(row.sourceId)
            || !['movie', 'episode', 'series'].includes(row.itemType)
            || typeof row.itemId !== 'string' || !row.itemId || row.itemId.length > 200)
            throw Error('Invalid startup target');
        return { userId: row.userId, sourceId: row.sourceId, itemType: row.itemType, itemId: row.itemId };
    });
}

// The server verifies current ownership/profile/generation, presence and account
// leases on every attempt. This list is a bounded pilot queue, never a source
// URL or a user-supplied codec map. Foreground activity is a deferral.
export async function runStartupCycle({ targets, endpoint, token, fetchImpl = fetch, eligible = () => true, onResult = () => {} }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.endsWith('/startup-cache/prepare')
        || url.username || url.password || url.search || !token) throw Error('Invalid startup worker configuration');
    for (const [index, target] of startupTargets(targets).entries()) {
        if (!eligible(index)) continue;
        let result;
        try {
            const response = await fetchImpl(url, { method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(target), signal: AbortSignal.timeout(145_000) });
            const body = await response.json();
            result = { ok: response.ok && body.protocol === 1, prepared: response.ok && body.prepared === true,
                refreshAfterSeconds: Number.isInteger(body.refreshAfterSeconds) ? Math.max(30, Math.min(300, body.refreshAfterSeconds)) : 60,
                // Avoid repeating private identifiers or upstream error text.
                reason: response.ok && body.prepared === true ? 'prefix-ready' : response.ok ? 'deferred' : 'request-rejected' };
        } catch (_) { result = { ok: false, prepared: false, reason: 'transport-unconfirmed' }; }
        onResult(index, result);
        // A rejected service request or uncertain transport must not cascade
        // into another provider acquisition during this cycle.
        if (!result.ok) return false;
    }
    return true;
}

async function main() {
    const manifest = process.env.NORVA_STARTUP_CACHE_TARGETS_FILE;
    if (!manifest) throw Error('Startup target manifest is required');
    const next = new Map();
    let stopping = false;
    const pause = new AbortController();
    const stop = () => { stopping = true; pause.abort(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    do {
        const targets = startupTargets(JSON.parse(await fs.readFile(manifest, 'utf8')));
        const ok = await runStartupCycle({ targets, endpoint: process.env.NORVA_STARTUP_CACHE_ENDPOINT,
            token: process.env.NORVA_BACKFILL_TOKEN, eligible: index => !stopping && (next.get(JSON.stringify(targets[index])) || 0) <= Date.now(),
            onResult(index, result) {
                const key = JSON.stringify(targets[index]);
                next.set(key, Date.now() + (result.prepared ? result.refreshAfterSeconds * 1000 : 60_000));
                process.stdout.write(JSON.stringify({ protocol: 1, targetOrdinal: index, ...result }) + '\n');
            } });
        if (process.argv.includes('--once') || stopping) break;
        // Graceful stop waits for the dispatched server attempt's drain result;
        // it cancels only the idle pause, never abandons an in-flight acquisition.
        await sleep(ok ? 60_000 : 180_000, null, { signal: pause.signal }).catch(error => {
            if (!stopping) throw error;
        });
    } while (!stopping);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(() => { process.stderr.write('Startup cache worker stopped; configuration or service unavailable.\n'); process.exitCode = 1; });
