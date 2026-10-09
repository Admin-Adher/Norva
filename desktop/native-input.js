'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

// Raw byte transport on the viewer's PC, without remuxing or transcoding.
// LibVLC may ask for the beginning and the index concurrently. Bounded reads
// release the source before another lane runs; no full-response deadlock and
// never two provider requests. Bytes live only within this exact session.
async function createNativeInput(sourceUrl, { windowBytes = 2 * 1024 * 1024, timeoutMs = 15000 } = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    let stopped = false, total = null, pending = Promise.resolve(), activeRequest = null;
    let validator = null, cache = null;
    const agents = { 'http:':new http.Agent({keepAlive:true,maxSockets:1}), 'https:':new https.Agent({keepAlive:true,maxSockets:1}) };
    const counters = { sourceRequests:0, maximumConcurrentSourceRequests:0, activeSourceRequests:0, completedBytes:0, ranges:[] };
    const drains = new Set();
    async function requestRange(address, start, end, redirects = 0) {
        if (stopped) throw Error('NATIVE_INPUT_CLOSED');
        const url = new URL(address);
        if (!agents[url.protocol] || redirects > 4) throw Error('NATIVE_INPUT_REDIRECT');
        // Settle only after ClientRequest close, including rejects and redirects.
        // That barrier precedes the next bounded provider GET.
        const result = await new Promise((resolve,reject) => {
            const transport = url.protocol === 'https:' ? https : http;
            let outcome = null, failure = null, responseBody, status = null;
            const began = Date.now();
            const request = transport.get(url, {agent:agents[url.protocol],headers:{Range:`bytes=${start}-${end}`,'Accept-Encoding':'identity','User-Agent':'VLC/3.0.24 LibVLC/3.0.24'}}, response => {
                responseBody=response;
                status=response.statusCode;
                const fail = code => { failure ||= Error(code); response.destroy(); request.destroy(); };
                response.once('error', () => fail('NATIVE_INPUT_NETWORK'));
                response.once('aborted', () => fail('NATIVE_INPUT_INCOMPLETE'));
                if ([301,302,303,307,308].includes(response.statusCode)) {
                    let next;
                    try { if (!response.headers.location) throw Error(); next=new URL(response.headers.location,url); }
                    catch { fail('NATIVE_INPUT_REDIRECT'); return; }
                    response.once('end',()=>{outcome={redirect:next.href};});response.resume();return;
                }
                const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range'] || ''));
                const size=Number(range?.[3]), actualEnd=Number(range?.[2]);
                if (response.statusCode !== 206 || !range || Number(range[1]) !== start
                    || !Number.isSafeInteger(size) || size <= start || actualEnd !== Math.min(end,size-1)
                    || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
                    fail('NATIVE_INPUT_RANGE_UNAVAILABLE');return;
                }
                const identity=String(response.headers.etag || response.headers['last-modified'] || '');
                if ((total !== null && size !== total) || (validator !== null && identity !== validator)) {fail('NATIVE_INPUT_CHANGED');return;}
                const expected=actualEnd-start+1, chunks=[];let length=0;
                response.on('data',chunk=>{
                    length+=chunk.length;
                    if(length>expected || length>windowBytes){fail('NATIVE_INPUT_OVERSIZE');return;}
                    chunks.push(chunk);
                });
                response.once('end',()=>{
                    if(length!==expected){failure ||= Error('NATIVE_INPUT_INCOMPLETE');return;}
                    if(!failure)outcome={start,payload:Buffer.concat(chunks),total:size,identity};
                });
            });
            activeRequest=request;counters.sourceRequests++;counters.activeSourceRequests++;
            counters.maximumConcurrentSourceRequests=Math.max(counters.maximumConcurrentSourceRequests,counters.activeSourceRequests);
            const deadline=setTimeout(()=>{failure ||= Error('NATIVE_INPUT_TIMEOUT');responseBody?.destroy();request.destroy();},timeoutMs);
            const drain=new Promise(done=>request.once('close',()=>{
                clearTimeout(deadline);counters.activeSourceRequests--;if(activeRequest===request)activeRequest=null;
                if(stopped)failure ||= Error('NATIVE_INPUT_CLOSED');
                counters.completedBytes += outcome?.payload?.length || 0;
                counters.ranges.push({start,end,status,elapsedMs:Date.now()-began,bytes:outcome?.payload?.length||0,error:failure?.message||null});
                if(counters.ranges.length>64)counters.ranges.shift();
                if(failure || !outcome)reject(failure || Error('NATIVE_INPUT_INCOMPLETE'));else resolve(outcome);
                done();
            }));
            drains.add(drain);void drain.then(()=>drains.delete(drain));
            request.once('error',()=>{failure ||= Error('NATIVE_INPUT_NETWORK');});
        });
        if(result.redirect)return requestRange(result.redirect,start,end,redirects+1);
        total=result.total;validator=result.identity;return result;
    }
    function read(start, isClosed) {
        const operation = pending.catch(()=>{}).then(async()=>{
            if(stopped || isClosed()) throw Error('NATIVE_INPUT_CLOSED');
            if(cache && start>=cache.start && start<cache.start+cache.payload.length)return cache;
            const base=Math.floor(start/windowBytes)*windowBytes;
            const chunk=await requestRange(sourceUrl,base,total===null?base+windowBytes-1:Math.min(total-1,base+windowBytes-1));
            if(stopped)throw Error('NATIVE_INPUT_CLOSED');
            cache=chunk;return chunk;
        });
        pending=operation.then(()=>{},()=>{});return operation;
    }
    const sockets=new Set();
    const server=http.createServer(async(req,res)=>{
        if(req.url!=='/'+token || !['GET','HEAD'].includes(req.method)){res.writeHead(404).end();return;}
        let closed=false;res.once('close',()=>{closed=true;});res.on('error',()=>{closed=true;});
        const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
        if(req.headers.range && !match){res.writeHead(416).end();return;}
        let at=match?Number(match[1]):0;const last=match?.[2]?Number(match[2]):null;
        if(!Number.isSafeInteger(at)||at<0||(last!==null&&(!Number.isSafeInteger(last)||last<at))){res.writeHead(416).end();return;}
        try {
            let chunk=await read(total===null?0:at,()=>closed);
            if(at>=total){res.writeHead(416,{'Content-Range':`bytes */${total}`}).end();return;}
            const end=last===null?total-1:Math.min(last,total-1);
            res.writeHead(match?206:200,{'Content-Length':end-at+1,'Accept-Ranges':'bytes','Content-Type':'application/octet-stream','Cache-Control':'no-store',...(match?{'Content-Range':`bytes ${at}-${end}/${total}`}:{})});
            if(req.method==='HEAD'){res.end();return;}
            while(at<=end&&!closed&&!stopped){
                chunk=await read(at,()=>closed);
                const count=Math.min(chunk.start+chunk.payload.length- at,end-at+1);
                const payload=chunk.payload.subarray(at-chunk.start,at-chunk.start+count);at+=count;
                if(!res.write(payload))await new Promise(resolve=>{
                    const done=()=>{res.off('drain',done);res.off('close',done);res.off('error',done);resolve();};
                    res.once('drain',done);res.once('close',done);res.once('error',done);
                });
            }
            res.end();
        }catch{if(!res.headersSent)res.writeHead(502).end();else res.destroy();}
    });
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    let stopping;
    return {url:`http://127.0.0.1:${server.address().port}/${token}`,counters,
        stop(){return stopping ||= (async()=>{stopped=true;activeRequest?.destroy();for(const agent of Object.values(agents))agent.destroy();
            for(const socket of sockets)socket.destroy();await pending;await Promise.allSettled([...drains]);await new Promise(resolve=>server.close(resolve));cache=null;})();}
    };
}
module.exports={createNativeInput};
