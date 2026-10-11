const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const utf8 = new TextEncoder();
const canonical = x => Array.isArray(x) ? `[${x.map(canonical).join(',')}]`
    : x && typeof x === 'object' ? `{${Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')}}`
    : JSON.stringify(x);
const bytesHex = bytes => [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
const digest = async bytes => bytesHex(await crypto.subtle.digest('SHA-256', bytes));
const resumeScope = b => digest(utf8.encode(canonical(['resume-file-v1',b.ownerKey,b.sourceUrlHash,b.fileSizeBytes])));
const response = (body, status=200) => Response.json(body, {status,headers:{'cache-control':'no-store'}});
const enabled = env => env.STARTUP_PREFIX_R2_ENABLED === 'true'
    && env.STARTUP_PREFIX_R2_ACTIVATION_APPROVED === 'true';
const authorized = (req,env) => typeof env.STARTUP_PREFIX_SERVICE_TOKEN === 'string'
    && env.STARTUP_PREFIX_SERVICE_TOKEN.length >= 32
    && req.headers.get('authorization') === 'Bearer '+env.STARTUP_PREFIX_SERVICE_TOKEN;
function bound(value, maximum) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0 || n > maximum) throw Error('invalid-bound');
    return n;
}
async function jsonBounded(req, maximum=1024**2) {
    if (!req.body) throw Error('body-required');
    const reader = req.body.getReader(), chunks=[];let total=0;
    try {
        while(true) {
            const {done,value}=await reader.read();if(done)break;
            total+=value.length;if(total>maximum)throw Error('body-too-large');chunks.push(value);
        }
    } catch(error) {await reader.cancel().catch(()=>{});throw error;}
    finally {reader.releaseLock();}
    const out=new Uint8Array(total);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}
    return JSON.parse(new TextDecoder().decode(out));
}
async function verifyEnvelope(envelope, env) {
    if (!envelope || Object.keys(envelope).sort().join(',') !== 'manifest,payloadBytes,payloadDigest,signature'
        || !hex(envelope.signature) || !hex(envelope.payloadDigest) || !hex(env.STARTUP_PREFIX_MANIFEST_HMAC_KEY))
        throw Error('invalid-envelope');
    if(utf8.encode(canonical(envelope)).length>96*1024)throw Error('envelope-too-large');
    const {signature,...body}=envelope, m=body.manifest, b=m?.binding;
    if (!b || Object.keys(b).length!==4 || !hex(b.ownerKey) || !hex(b.sourceUrlHash) || !hex(b.profileHash)
        || !Number.isSafeInteger(b.fileSizeBytes) || b.fileSizeBytes<1 || !hex(m.preparationKey)
        || m.protocol!==1 || !['startup','resume'].includes(m.purpose || 'startup')
        || !Number.isFinite(m.start) || m.start<0 || !Number.isFinite(m.end) || m.ended!==false
        || ((m.purpose || 'startup')==='startup' ? m.start!==0 || !(m.end>=60 && m.end<=90)
            : !(m.end>m.start && m.end-m.start<=150))
        || !Number.isSafeInteger(m.createdAt) || m.createdAt>Date.now()+30_000
        || !Number.isSafeInteger(m.retainedUntil ?? m.expiresAt)
        || (m.retainedUntil ?? m.expiresAt)<=Date.now()
        || (m.retainedUntil ?? m.expiresAt)>m.createdAt+7*86400_000
        || bound(body.payloadBytes,64*1024**2)!==(m.storage?.bytes ?? m.bytes)
        || bound(m.bytes,64*1024**2)<body.payloadBytes) throw Error('invalid-manifest');
    const key=await crypto.subtle.importKey('raw',Uint8Array.from(env.STARTUP_PREFIX_MANIFEST_HMAC_KEY.match(/../g),x=>parseInt(x,16)),
        {name:'HMAC',hash:'SHA-256'},false,['verify']);
    const valid=await crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)),
        utf8.encode('norva-startup-prefix-v1\0'+canonical(body)));
    if(!valid)throw Error('invalid-signature');
    return envelope;
}

// One namespace ID is shared by both Gateways. Quota, revocation and publication
// are transactional; uncertain writes keep their bytes charged until drained.
export class StartupPrefixLedger {
    constructor(state, env) {this.storage=state.storage;this.env=env;}
    async fetch(req) {
        if (!enabled(this.env) || !authorized(req,this.env)) return response({ok:false},403);
        try {
            const body=await jsonBounded(req), action=new URL(req.url).pathname.slice(1);
            if(action==='candidates') {
                if(typeof body.cursor!=='string' || (body.cursor && !/^record:[a-f0-9]{64}$/.test(body.cursor)))throw Error('cursor');
                const rows=await this.storage.list({prefix:'record:',limit:20,...(body.cursor?{startAfter:body.cursor}:{})});
                return response({ok:true,candidates:[...rows].map(([key,value])=>({key,id:value.id}))});
            }
            const result=await this.storage.transaction(async tx=>{
                const now=Date.now(), owner=body.owner;
                if(action==='retirement-cleanup') {
                    const cursor=(await tx.get('retirement-cleanup-cursor')) || '';
                    const rows=await tx.list({prefix:'retired-at:',limit:20,...(cursor?{startAfter:cursor}:{})});
                    // No accepted envelope can outlive seven days. Keeping the
                    // extra clock allowance prevents deleting a live barrier.
                    for(const [key,at] of rows)if(at<now-7*86400_000-30_000)await tx.delete(key);
                    await tx.put('retirement-cleanup-cursor',rows.size===20?[...rows.keys()].at(-1):'');
                    return {cleaned:true};
                }
                if(action==='reserve') {
                    const envelope=await verifyEnvelope(body.envelope,this.env), m=envelope.manifest;
                    if(m.createdAt<=((await tx.get('revoked-at:'+m.binding.ownerKey)) ?? -1))throw Error('owner-revoked');
                    const id=await digest(utf8.encode(canonical(envelope)));
                    const existing=await tx.get('record:'+id);if(existing)return {record:existing};
                    const bytes=envelope.payloadBytes+utf8.encode(canonical(envelope)).length;
                    const total=(await tx.get('total')) || {bytes:0,objects:0};
                    const used=(await tx.get('owner:'+m.binding.ownerKey)) || 0;
                    if(total.bytes+bytes>bound(this.env.STARTUP_PREFIX_MAX_BYTES,Number.MAX_SAFE_INTEGER)
                        || used+bytes>bound(this.env.STARTUP_PREFIX_OWNER_MAX_BYTES,Number.MAX_SAFE_INTEGER)
                        || total.objects+2>bound(this.env.STARTUP_PREFIX_MAX_OBJECTS,8_000_000))throw Error('quota');
                    const fence=(await tx.get('fence:'+m.binding.ownerKey)) || 0;
                    const bindingKey=await digest(utf8.encode(canonical([m.purpose || 'startup',m.binding])));
                    const scopeKey=m.purpose==='resume'?await resumeScope(m.binding):bindingKey;
                    if(m.createdAt<=((await tx.get('retired-at:'+scopeKey)) ?? -1))throw Error('window-retired');
                    const record={id,envelope,owner:m.binding.ownerKey,bytes,fence,phase:'reserved',io:null,
                        deadline:now+300_000,bindingKey,scopeKey,
                        mediaKey:`startup-private/v1/${m.binding.ownerKey}/${id}/payload.bin`,
                        manifestKey:`startup-private/v1/${m.binding.ownerKey}/${id}/manifest.json`};
                    await tx.put('total',{bytes:total.bytes+bytes,objects:total.objects+2});
                    await tx.put('owner:'+record.owner,used+bytes);await tx.put('record:'+id,record);
                    return {record};
                }
                if(action==='revoke') {
                    if(!hex(owner))throw Error('owner');
                    await tx.put('fence:'+owner,((await tx.get('fence:'+owner)) || 0)+1);
                    await tx.put('revoked-at:'+owner,now);
                    return {revoked:true};
                }
                if(action==='lookup') {
                    if(!hex(owner))throw Error('owner');
                    if(body.binding && !['startup','resume'].includes(body.purpose || 'startup'))throw Error('purpose');
                    const selector=body.binding ? 'binding:'+await digest(utf8.encode(canonical([body.purpose || 'startup',body.binding])))
                        : 'preparation:'+String(body.preparationKey);
                    const id=await tx.get(selector), record=id && await tx.get('record:'+id);
                    if(!record || record.phase!=='ready' || record.owner!==owner
                        || record.fence!==((await tx.get('fence:'+owner)) || 0)
                        || (record.envelope.manifest.retainedUntil ?? record.envelope.manifest.expiresAt)<=now)
                        return {record:null};
                    return {record};
                }
                if(action==='retire') {
                    const b=body.binding, at=body.beforeOrAt;
                    if(body.purpose!=='resume' || !b || Object.keys(b).length!==4 || !hex(b.ownerKey)
                        || !hex(b.sourceUrlHash) || !hex(b.profileHash) || !Number.isSafeInteger(b.fileSizeBytes) || b.fileSizeBytes<1
                        || !Number.isSafeInteger(at) || at<0 || at>now+30_000)throw Error('retirement');
                    const key=await resumeScope(b);
                    const cutoff=Math.max(at,(await tx.get('retired-at:'+key)) ?? -1);
                    await tx.put('retired-at:'+key,cutoff);
                    const id=await tx.get('resume-file:'+key), prior=id && await tx.get('record:'+id);
                    if(prior && prior.envelope.manifest.createdAt<=cutoff) {
                        prior.phase='discarded';await tx.put('record:'+id,prior);
                        await tx.delete('binding:'+prior.bindingKey);await tx.delete('resume-file:'+key);
                        return {retired:true,previousId:id};
                    }
                    return {retired:true};
                }
                if(!hex(body.id))throw Error('id');
                const record=await tx.get('record:'+body.id);if(!record)return {record:null};
                const current=record.fence===((await tx.get('fence:'+record.owner)) || 0);
                if(action==='info')return {record:current && record.phase!=='deleting'
                    && record.envelope.manifest.createdAt>((await tx.get('retired-at:'+(record.scopeKey || record.bindingKey))) ?? -1)
                    && (record.envelope.manifest.retainedUntil ?? record.envelope.manifest.expiresAt)>now?record:null};
                if(action==='discard') {
                    record.phase='discarded';await tx.put('record:'+record.id,record);return {discarded:true};
                }
                if(action==='begin') {
                    if(!current || record.io || record.phase!=='reserved' || record.deadline<=now)throw Error('write-refused');
                    record.io=crypto.randomUUID();await tx.put('record:'+record.id,record);return {record};
                }
                if(action==='finish' || action==='publish') {
                    if(!record.io || record.io!==body.io)throw Error('write-fence');
                    record.io=null;
                    const retired=record.envelope.manifest.createdAt<=((await tx.get('retired-at:'+(record.scopeKey || record.bindingKey))) ?? -1);
                    let previousId=null;
                    if(!current || retired || record.phase!=='reserved')record.phase='discarded';
                    else if(action==='publish') {
                        const pointer=record.envelope.manifest.purpose==='resume'?'resume-file:'+record.scopeKey:'binding:'+record.bindingKey;
                        const priorId=await tx.get(pointer), prior=priorId && await tx.get('record:'+priorId);
                        if(prior && prior.id!==record.id && prior.envelope.manifest.createdAt>=record.envelope.manifest.createdAt) {
                            record.phase='discarded';await tx.put('record:'+record.id,record);return {record};
                        }
                        if(prior && prior.id!==record.id) {
                            prior.phase='discarded';await tx.put('record:'+prior.id,prior);previousId=prior.id;
                            if(await tx.get('binding:'+prior.bindingKey)===prior.id)await tx.delete('binding:'+prior.bindingKey);
                        }
                        record.phase='ready';
                        await tx.put('binding:'+record.bindingKey,record.id);
                        if(record.envelope.manifest.purpose==='resume')await tx.put('resume-file:'+record.scopeKey,record.id);
                        await tx.put('preparation:'+record.envelope.manifest.preparationKey,record.id);
                    }
                    await tx.put('record:'+record.id,record);return {record,...(previousId?{previousId}:{})};
                }
                if(action==='delete-start') {
                    const expired=(record.envelope.manifest.retainedUntil ?? record.envelope.manifest.expiresAt)<=now;
                    if(record.io || !(expired || !current || record.phase==='discarded'
                        || record.phase==='deleting' || (record.phase==='reserved' && record.deadline<=now)))return {record:null};
                    record.phase='deleting';await tx.put('record:'+record.id,record);return {record};
                }
                if(action==='delete-finish') {
                    if(record.phase!=='deleting' || record.io)throw Error('delete-fence');
                    const total=await tx.get('total'), used=await tx.get('owner:'+record.owner);
                    await tx.put('total',{bytes:total.bytes-record.bytes,objects:total.objects-2});
                    await tx.put('owner:'+record.owner,used-record.bytes);
                    for(const key of ['binding:'+record.bindingKey,'preparation:'+record.envelope.manifest.preparationKey,
                        ...(record.envelope.manifest.purpose==='resume'?['resume-file:'+record.scopeKey]:[])])
                        if(await tx.get(key)===record.id)await tx.delete(key);
                    await tx.delete('record:'+record.id);return {deleted:true};
                }
                throw Error('action');
            });
            return response({ok:true,...result});
        } catch(_) {return response({ok:false,reason:'ledger-refused'},409);}
    }
}

async function ledger(env, action, body) {
    const stub=env.STARTUP_PREFIX_LEDGER.get(env.STARTUP_PREFIX_LEDGER.idFromName('private-startup-quota-v1'));
    const r=await stub.fetch(new Request('https://ledger/'+action,{method:'POST',
        headers:{authorization:'Bearer '+env.STARTUP_PREFIX_SERVICE_TOKEN,'content-type':'application/json'},body:JSON.stringify(body)}));
    const result=await r.json();if(!r.ok || result.ok!==true)throw Error('ledger-refused');return result;
}
async function deleteRetired(env,id) {
    const {record}=await ledger(env,'delete-start',{id});
    if(!record)return false;
    await env.STARTUP_PREFIX_BUCKET.delete([record.mediaKey,record.manifestKey]);
    await ledger(env,'delete-finish',{id});return true;
}
function checkedObject(object, record, manifest=false) {
    const expected=manifest ? null : record.envelope.payloadDigest;
    if(!object || (!manifest && object.size!==record.envelope.payloadBytes)
        || !object.checksums?.sha256 || (expected && bytesHex(object.checksums.sha256)!==expected))throw Error('object-unverified');
}
export default {
    async fetch(req,env) {
        if(!authorized(req,env))return response({ok:false},401);
        // Even service-authenticated requests perform no DO or R2 I/O until
        // the operator has explicitly configured both activation gates.
        if(!enabled(env))return response({ok:false,reason:'storage-disabled'},503);
        try {
            if(!env.STARTUP_PREFIX_BUCKET || !env.STARTUP_PREFIX_LEDGER)throw Error('unconfigured');
            const parts=new URL(req.url).pathname.split('/').filter(Boolean);
            if(parts[0]!=='internal' || parts[1]!=='prefix')return response({ok:false},404);
            const op=parts[2];
            if(req.method==='POST' && op==='reserve') {
                const envelope=await verifyEnvelope(await jsonBounded(req),env);
                return response(await ledger(env,'reserve',{envelope}));
            }
            if(req.method==='POST' && (op==='lookup' || op==='revoke'))
                return response(await ledger(env,op,await jsonBounded(req,4096)));
            if(req.method==='POST' && op==='discard')return response(await ledger(env,'discard',await jsonBounded(req,4096)));
            if(req.method==='POST' && op==='retire') {
                const retired=await ledger(env,'retire',await jsonBounded(req,4096));
                if(retired.previousId)await deleteRetired(env,retired.previousId);
                return response({ok:true,retired:true});
            }
            if(op==='cleanup' && req.method==='POST') {
                const {cursor=''}=await jsonBounded(req,4096);
                if(typeof cursor!=='string' || (cursor && !/^record:[a-f0-9]{64}$/.test(cursor)))throw Error('cursor');
                const {candidates}=await ledger(env,'candidates',{cursor});let deleted=0;
                for(const row of candidates) {
                    const {record}=await ledger(env,'delete-start',{id:row.id});if(!record)continue;
                    // Release quota only after positive deletion, never on timeout.
                    await env.STARTUP_PREFIX_BUCKET.delete([record.mediaKey,record.manifestKey]);
                    await ledger(env,'delete-finish',{id:row.id});deleted++;
                }
                await ledger(env,'retirement-cleanup',{});
                return response({ok:true,deleted,cursor:candidates.at(-1)?.key || '',more:candidates.length===20});
            }
            if(!hex(op))throw Error('id');
            const {record}=await ledger(env,'info',{id:op});if(!record)return response({ok:false},404);
            if(parts[3]==='receipt' && req.method==='GET')return response({ok:true,record});
            if(parts[3]==='payload' && req.method==='PUT') {
                if(Number(req.headers.get('content-length'))!==record.envelope.payloadBytes
                    || req.headers.get('x-norva-content-sha256')!==record.envelope.payloadDigest || !req.body)throw Error('body-bound');
                if(record.phase==='ready')return response({ok:true,alreadyPresent:true});
                const started=(await ledger(env,'begin',{id:op})).record;
                const result=await env.STARTUP_PREFIX_BUCKET.put(record.mediaKey,req.body,{onlyIf:new Headers({'if-none-match':'*'}),
                    sha256:record.envelope.payloadDigest,httpMetadata:{contentType:'application/octet-stream',cacheControl:'no-store'}});
                checkedObject(result || await env.STARTUP_PREFIX_BUCKET.head(record.mediaKey),record);
                await ledger(env,'finish',{id:op,io:started.io});return response({ok:true});
            }
            if(parts[3]==='commit' && req.method==='POST') {
                if(record.phase==='ready')return response({ok:true,record});
                checkedObject(await env.STARTUP_PREFIX_BUCKET.head(record.mediaKey),record);
                const started=(await ledger(env,'begin',{id:op})).record;
                const bytes=utf8.encode(canonical(record.envelope)), sha=await digest(bytes);
                const result=await env.STARTUP_PREFIX_BUCKET.put(record.manifestKey,bytes,{sha256:sha,
                    onlyIf:new Headers({'if-none-match':'*'}),httpMetadata:{contentType:'application/json',cacheControl:'no-store'}});
                const stored=result || await env.STARTUP_PREFIX_BUCKET.head(record.manifestKey);
                if(!stored || stored.size!==bytes.length || !stored.checksums?.sha256 || bytesHex(stored.checksums.sha256)!==sha)throw Error('manifest-unverified');
                const published=await ledger(env,'publish',{id:op,io:started.io});
                if(published.record?.phase!=='ready')throw Error('publication-revoked');
                if(published.previousId)await deleteRetired(env,published.previousId);
                return response(published);
            }
            if(parts[3]==='payload' && req.method==='GET' && record.phase==='ready') {
                const object=await env.STARTUP_PREFIX_BUCKET.get(record.mediaKey);checkedObject(object,record);
                return new Response(object.body,{headers:{'content-length':String(record.envelope.payloadBytes),
                    'content-type':'application/octet-stream','cache-control':'no-store','x-norva-content-sha256':record.envelope.payloadDigest}});
            }
            return response({ok:false},404);
        } catch(_) {return response({ok:false,reason:'storage-unconfirmed'},503);}
    },
};
