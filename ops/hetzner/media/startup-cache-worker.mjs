import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deferredReasons = new Set(['pilot-disabled', 'exact-file-evidence-unavailable',
    'native-mp4-prefix-unavailable', 'account-unidentified', 'activity-unavailable',
    'account-presence', 'viewer-active', 'background-job-active', 'account-reserved',
    'provider-reserved', 'activity-changed', 'not-admitted', 'cancelled', 'not-prepared',
    'profile-refreshed', 'profile-refresh-deferred']);
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
                providerDrained: response.ok && body.protocol === 1 && body.providerDrained === true,
                refreshAfterSeconds: Number.isInteger(body.refreshAfterSeconds) ? Math.max(30, Math.min(300, body.refreshAfterSeconds)) : 60,
                // Avoid repeating private identifiers or upstream error text.
                reason: response.ok && body.prepared === true ? 'prefix-ready' : response.ok
                    ? deferredReasons.has(body.reason) ? body.reason : 'deferred' : 'request-rejected' };
        } catch (_) { result = { ok: false, prepared: false, reason: 'transport-unconfirmed' }; }
        onResult(index, result);
        // A rejected service request or uncertain transport must not cascade
        // into another provider acquisition during this cycle.
        if (!result.ok) return false;
    }
    return true;
}

export async function runGlobalStartupCycle({ endpoint, token, fetchImpl=fetch, stopping=()=>false, onResult=()=>{} }) {
    const url=new URL(endpoint);
    if(!['http:','https:'].includes(url.protocol) || !url.pathname.endsWith('/startup-cache/prepare')
        || url.username || url.password || url.search || url.hash || !token)throw Error('Invalid startup worker configuration');
    const queue=new URL(url);queue.pathname=queue.pathname.replace(/prepare$/,'queue');
    const call=async body=>{
        const r=await fetchImpl(queue,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
            body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
        const out=await r.json();if(!r.ok || out.protocol!==1)throw Error('Queue unconfirmed');return out;
    };
    if(stopping())return true;
    try {
        const claimed=await call({action:'claim'});
        if(claimed.enabled!==true || !claimed.job)return true;
        const job=claimed.job;
        if(!uuid.test(job.leaseId))throw Error('Invalid queue lease');
        const targets=startupTargets([job.target]);let result;
        // A claim performs no supplier I/O. If shutting down, let it expire.
        if(stopping())return true;
        const ok=await runStartupCycle({targets,endpoint,token,fetchImpl,onResult:(_i,r)=>{result=r;onResult(0,r);}});
        if(!ok || result.providerDrained!==true)return false;
        const ack=await call({action:'ack',leaseId:job.leaseId,prepared:result.prepared,
            providerDrained:true,retrySeconds:result.refreshAfterSeconds || 60});
        return ack.acknowledged===true;
    }catch(_){onResult(0,{ok:false,prepared:false,providerDrained:false,reason:'transport-unconfirmed'});return false;}
}

async function main() {
    const manifest = process.env.NORVA_STARTUP_CACHE_TARGETS_FILE;
    const globalQueue=process.env.NORVA_STARTUP_CACHE_GLOBAL_QUEUE_ENABLED==='true';
    if (!manifest && !globalQueue) throw Error('Startup target manifest is required');
    const next = new Map();
    let stopping = false;
    const pause = new AbortController();
    const stop = () => { stopping = true; pause.abort(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    do {
        const targets = globalQueue?null:startupTargets(JSON.parse(await fs.readFile(manifest, 'utf8')));
        const common={endpoint:process.env.NORVA_STARTUP_CACHE_ENDPOINT,token:process.env.NORVA_BACKFILL_TOKEN};
        let attempted=false;
        const ok = globalQueue?await runGlobalStartupCycle({...common,stopping:()=>stopping,
            onResult(index,result){attempted=true;process.stdout.write(JSON.stringify({protocol:1,targetOrdinal:index,...result})+'\n');}})
            :await runStartupCycle({ targets, endpoint: process.env.NORVA_STARTUP_CACHE_ENDPOINT,
            token: process.env.NORVA_BACKFILL_TOKEN, eligible: index => !stopping && (next.get(JSON.stringify(targets[index])) || 0) <= Date.now(),
            onResult(index, result) {
                const key = JSON.stringify(targets[index]);
                next.set(key, Date.now() + (result.prepared ? result.refreshAfterSeconds * 1000 : 60_000));
                process.stdout.write(JSON.stringify({ protocol: 1, targetOrdinal: index, ...result }) + '\n');
            } });
        if (process.argv.includes('--once') || stopping) break;
        // Graceful stop waits for the dispatched server attempt's drain result;
        // it cancels only the idle pause, never abandons an in-flight acquisition.
        await sleep(ok ? globalQueue && attempted ? 1000 : 60_000 : 180_000, null, { signal: pause.signal }).catch(error => {
            if (!stopping) throw error;
        });
    } while (!stopping);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(() => { process.stderr.write('Startup cache worker stopped; configuration or service unavailable.\n'); process.exitCode = 1; });
