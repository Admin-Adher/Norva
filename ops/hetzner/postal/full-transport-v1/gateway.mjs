// Private bridge only: no published port, no credentials, encrypted mail envelopes.
import http from 'node:http';
const server=http.createServer((req,res)=>{
 if(!((req.method==='GET'&&req.url==='/health')||(req.method==='POST'&&req.url==='/v1/mail'))){res.writeHead(404);res.end('{}');return;}
 let bytes=0,done=false;
 const upstream=http.request({socketPath:'/bridge/mail.sock',path:req.url,method:req.method,
  headers:{'content-type':'application/json','connection':'close'},timeout:4500},response=>{
   res.writeHead(response.statusCode,{'content-type':'application/json','cache-control':'no-store'});response.pipe(res);
  });
 const fail=()=>{if(done)return;done=true;upstream.destroy();if(!res.headersSent)res.writeHead(503);res.end('{}');};
 upstream.on('error',fail);upstream.on('timeout',fail);req.on('error',fail);
 req.on('data',chunk=>{bytes+=chunk.length;if(bytes>1100000)fail();else if(!done)upstream.write(chunk);});
 req.on('end',()=>{if(!done)upstream.end();});res.on('close',()=>upstream.destroy());
});
server.headersTimeout=5000;server.requestTimeout=6000;server.maxConnections=12;server.keepAliveTimeout=1000;
server.listen(18185,'0.0.0.0');process.on('SIGTERM',()=>server.close());
