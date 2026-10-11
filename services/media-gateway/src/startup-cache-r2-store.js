'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const canonical=x=>Array.isArray(x)?`[${x.map(canonical).join(',')}]`
    :x && typeof x==='object'?`{${Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')}}`
    :JSON.stringify(x);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const hex=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);

class StartupCacheR2Store {
    constructor({disk,baseUrl,serviceToken,manifestHmacKey,fetchImpl=fetch,timeoutMs=30_000}={}) {
        const url=new URL(baseUrl || '');
        if(!disk || !disk.retentionMs || url.username || url.password || url.search || url.hash
            || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)))
            || typeof serviceToken!=='string' || serviceToken.length<32 || /[\r\n]/.test(serviceToken)
            || !hex(manifestHmacKey) || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>30_000)
            throw Error('STARTUP_R2_CONFIG_INVALID');
        url.pathname='/internal/prefix/';
        Object.assign(this,{disk,baseUrl:url,serviceToken,manifestHmacKey,fetchImpl,timeoutMs});
        this.index=new Map();this.failures=0;this.blockedUntil=0;
    }
    async initialize(){
        await this.disk.initialize();
        // One bounded page per minute; deletion acknowledgments alone release
        // shared quota. Never sweep millions of objects in a foreground request.
        if(!this.maintenanceTimer) {
            this.cleanupCursor='';this.maintenanceActive=false;
            this.maintenanceTimer=setInterval(()=>this.maintain().catch(()=>{this.failures++;}),60_000);
            this.maintenanceTimer.unref();
        }
    }
    close(){clearInterval(this.maintenanceTimer);this.maintenanceTimer=null;}
    async maintain(){
        if(this.maintenanceActive || this.blockedUntil===Number.MAX_SAFE_INTEGER)return;
        this.maintenanceActive=true;
        try{const page=await this.request('cleanup',{cursor:this.cleanupCursor || ''},{timeoutMs:3000});
            this.cleanupCursor=page.more && /^record:[a-f0-9]{64}$/.test(page.cursor)?page.cursor:'';}
        finally{this.maintenanceActive=false;}
    }
    key(binding){return hash(canonical(binding));}
    sign(body){return crypto.createHmac('sha256',Buffer.from(this.manifestHmacKey,'hex'))
        .update('norva-startup-prefix-v1\0'+canonical(body)).digest('hex');}
    verify(record,binding=null,owner=null) {
        const envelope=record?.envelope,{signature,...body}=envelope || {};
        if(!hex(record?.id) || record.id!==hash(canonical(envelope)) || !hex(signature)
            || !crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(this.sign(body),'hex'))
            || !hex(body.payloadDigest) || !this.disk.validManifest(body.manifest)
            || body.payloadBytes!==(body.manifest.storage?.bytes ?? body.manifest.bytes)
            || (binding && this.key(binding)!==this.key(body.manifest.binding))
            || (owner && body.manifest.binding.ownerKey!==owner))throw Error('STARTUP_R2_RECORD_INVALID');
        return record;
    }
    async read(response,maximum,timeoutMs) {
        const declared=response.headers.get('content-length');
        if(declared!==null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared)>maximum))throw Error('STARTUP_R2_BODY_INVALID');
        if(!response.body)return Buffer.alloc(0);
        const reader=response.body.getReader(), chunks=[], output=declared===null?null:Buffer.alloc(Number(declared));let size=0,timer;
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('STARTUP_R2_TIMEOUT')),timeoutMs);});
        try {
            while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;
                if(size+value.length>maximum || (output && size+value.length>output.length))throw Error('STARTUP_R2_BODY_INVALID');
                if(output)output.set(value,size);else chunks.push(Buffer.from(value));size+=value.length;}
            if(output && size!==output.length)throw Error('STARTUP_R2_BODY_INVALID');
            return output || Buffer.concat(chunks,size);
        }catch(error){await reader.cancel().catch(()=>{});throw error;}
        finally{clearTimeout(timer);reader.releaseLock();}
    }
    async request(path,body=null,options={}) {
        const timeoutMs=options.timeoutMs || this.timeoutMs;
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
        const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
        if(options.signal?.aborted)controller.abort();
        try {
            const result=await this.fetchImpl(new URL(path,this.baseUrl),{
                method:options.method || (body===null?'GET':'POST'),redirect:'error',signal:controller.signal,
                headers:{authorization:'Bearer '+this.serviceToken,'accept-encoding':'identity',
                    'content-type':'application/json',...options.headers},
                ...(options.stream?{body:options.stream,duplex:'half'}:body===null?{}:{body:JSON.stringify(body)})});
            if(!result.ok){await result.body?.cancel().catch(()=>{});throw Error('STARTUP_R2_REFUSED');}
            const buffer=await this.read(result,options.binary?this.disk.perFileBytes:256*1024,timeoutMs);
            if(options.binary)return buffer;
            const json=JSON.parse(buffer.toString());if(json.ok!==true)throw Error('STARTUP_R2_REFUSED');return json;
        }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
    }
    remember(record) {
        const key=this.key(record.envelope.manifest.binding);
        if(!this.index.has(key) && this.index.size>=this.disk.maxEntries)this.index.delete(this.index.keys().next().value);
        this.index.set(key,record);
    }
    metadata(binding) {
        const record=this.index.get(this.key(binding));
        return record && this.disk.validManifest(record.envelope.manifest)?record.envelope.manifest:null;
    }
    bindingForPreparation(key) {
        return [...this.index.values()].find(r=>r.envelope.manifest.preparationKey===key
            && this.disk.validManifest(r.envelope.manifest))?.envelope.manifest.binding || null;
    }
    async lookupPreparation(preparationKey,owner,signal) {
        if(this.blockedUntil>this.disk.now())return null;
        try {
            const {record}=await this.request('lookup',{preparationKey,owner},{timeoutMs:3000,signal});
            if(!record)return null;
            this.verify(record,null,owner);
            if(record.envelope.manifest.preparationKey!==preparationKey)throw Error('STARTUP_R2_SCOPE_INVALID');
            this.remember(record);return record.envelope.manifest.binding;
        }catch(_){this.failures++;return null;}
    }
    async get(binding,signal) {
        if(this.blockedUntil===Number.MAX_SAFE_INTEGER)return null;
        try {
            const {record}=await this.request('lookup',{binding,owner:binding.ownerKey,purpose:this.disk.purpose},{timeoutMs:3000,signal});
            if(!record)return null;
            this.verify(record,binding);this.remember(record);
            const m=record.envelope.manifest;
            if(m.recentProof && m.expiresAt<=this.disk.now())return null;
            const bytes=await this.request(record.id+'/payload',null,{binary:true,timeoutMs:3000,signal});
            if(bytes.length!==record.envelope.payloadBytes || hash(bytes)!==record.envelope.payloadDigest)throw Error('STARTUP_R2_CORRUPT');
            // A concurrent owner revocation during the download fences hydration.
            const current=(await this.request(record.id+'/receipt',null,{timeoutMs:1000,signal})).record;
            this.verify(current,binding);if(current.phase!=='ready' || current.fence!==record.fence)return null;
            return await this.disk.decode(binding,m,bytes);
        }catch(_){this.failures++;return null;}
    }
    async current(binding,createdAt,signal) {
        if(this.blockedUntil===Number.MAX_SAFE_INTEGER)return false;
        try {
            const {record}=await this.request('lookup',{binding,owner:binding.ownerKey,purpose:this.disk.purpose},{timeoutMs:3000,signal});
            if(!record)return false;
            this.verify(record,binding);this.remember(record);
            return record.phase==='ready' && record.envelope.manifest.createdAt===createdAt;
        }catch(_){this.failures++;return false;}
    }
    async put(entry,preparationKey,isCurrent=()=>true,signal) {
        if(this.blockedUntil>this.disk.now() || !await this.disk.put(entry,preparationKey,isCurrent))return false;
        try {
            const snapshot=await this.disk.export(entry.binding);if(!snapshot || !entry.live || !isCurrent())return false;
            const body={manifest:snapshot.manifest,payloadDigest:snapshot.digest,payloadBytes:snapshot.bytes};
            const envelope={...body,signature:this.sign(body)};
            const {record}=await this.request('reserve',envelope,{signal});this.verify(record,entry.binding);
            const stream=fs.createReadStream(snapshot.file,{flags:fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW || 0)});
            try {await this.request(record.id+'/payload',null,{method:'PUT',stream,signal,
                headers:{'content-length':String(snapshot.bytes),'content-type':'application/octet-stream','x-norva-content-sha256':snapshot.digest}});}
            finally{stream.destroy();}
            if(!entry.live || !isCurrent()) {await this.request('discard',{id:record.id},{signal});return false;}
            const published=(await this.request(record.id+'/commit',{},{signal})).record;
            this.verify(published,entry.binding);
            if(published.phase!=='ready' || !entry.live || !isCurrent()) {
                await this.request('discard',{id:record.id},{timeoutMs:1000});return false;
            }
            this.remember(published);
            // Staging is bounded separately; a completed R2 entry need not keep
            // its media on the limited Gateway disk.
            await this.disk.discard(entry.binding);return true;
        }catch(_){this.failures++;this.blockedUntil=this.disk.now()+180_000;return false;}
    }
    async discard(binding) {
        const record=this.index.get(this.key(binding));this.index.delete(this.key(binding));
        await this.disk.discard(binding);
        if(record)await this.request('discard',{id:record.id});
    }
    async retire(binding,beforeOrAt) {
        if(this.disk.purpose!=='resume')throw Error('STARTUP_R2_RETIREMENT_INVALID');
        for(const [key,record] of this.index) {
            const b=record.envelope.manifest.binding;
            if(['ownerKey','sourceUrlHash','fileSizeBytes'].every(k=>b[k]===binding[k]))this.index.delete(key);
        }
        await this.disk.discard(binding);
        await this.request('retire',{binding,purpose:'resume',beforeOrAt},{timeoutMs:3000});
    }
    async revokeOwner(owner) {
        for(const [key,r]of this.index)if(r.envelope.manifest.binding.ownerKey===owner)this.index.delete(key);
        await this.disk.revokeOwner(owner);
        try{await this.request('revoke',{owner});}
        catch(error){this.blockedUntil=Number.MAX_SAFE_INTEGER;throw error;}
    }
    async cleanup(cursor=''){return await this.request('cleanup',{cursor});}
    status(){return {protocol:1,persistent:true,backend:'private-r2',entries:this.index.size,
        failures:this.failures,preparationBlocked:this.blockedUntil>this.disk.now(),local:this.disk.status()};}
}
module.exports={StartupCacheR2Store};
