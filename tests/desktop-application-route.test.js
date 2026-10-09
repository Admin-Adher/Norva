const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const express=require('express');
test('bundled server resolves account return /app to the catalogue, preserving the landing page',async()=>{
 let app,listen;const next=(_q,_r,n)=>n();
 const factory=Object.assign(()=>{app=express();listen=app.listen.bind(app);app.listen=()=>{};return app;},express);
 const directory=path.resolve(__dirname,'../server');
 const resolve=(name)=>{
  if(name==='express')return factory;
  if(name==='dotenv')return {config(){}};
  if(name==='passport')return {initialize:()=>next,session:()=>next};
  if(name==='express-session')return ()=>next;
  if(name==='child_process')return {execSync(){throw Error('No media process in route test');}};
  if(name==='fs')return {readdirSync:()=>[],existsSync:()=>false};
  if(name.startsWith('./routes/')||name.startsWith('./middleware/'))return next;
  if(name==='./db'||name.startsWith('./services/'))return {};
  if(name==='../package.json')return require('../package.json');
  return require(name);
 };
 vm.runInNewContext(fs.readFileSync(path.join(directory,'index.js'),'utf8'),{require:resolve,__dirname:directory,process:{env:{},on(){}},console:{log(){},warn(){},error(){}}});
 const server=listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try {
  const origin=`http://127.0.0.1:${server.address().port}`;
  for(const route of ['/app','/app?returnTo=home','/app.html']){
   const response=await fetch(origin+route);assert.equal(response.status,200);
   assert.equal(await response.text(),fs.readFileSync(path.resolve(directory,'../public/app.html'),'utf8'));
  }
  assert.equal(await (await fetch(origin+'/')).text(),fs.readFileSync(path.resolve(directory,'../public/index.html'),'utf8'));
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
