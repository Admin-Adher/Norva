'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');const root=path.resolve(__dirname,'../..');
const cp=require('child_process');
const git='C:/Program Files/Git/cmd/git.exe';
const changed=new Set(cp.execFileSync(git,['diff','--name-only','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\r?\n/));
function hash(file){return crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'public',file),'utf8').replace(/\r\n/g,'\n')).digest('hex').slice(0,10);}
for(const [file,dependency]of [['js/pages/AdminPage.js','js/pages/MkvStrategyLabPage.js'],['js/app.js','js/pages/AdminPage.js']]){const p=path.join(root,'public',file);let s=fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');const escaped=dependency.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');s=s.replace(new RegExp('/'+escaped+'\\?v=[^\'"\\s]+','g'),'/'+dependency+'?v='+hash(dependency));fs.writeFileSync(p,s);}
function htmlFiles(dir=''){return fs.readdirSync(path.join(root,'public',dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?htmlFiles(dir?dir+'/'+e.name:e.name):e.name.endsWith('.html')?[dir?dir+'/'+e.name:e.name]:[]);}
for(const file of htmlFiles()){const p=path.join(root,'public',file);let s=fs.readFileSync(p,'utf8');let before='';try{before=cp.execFileSync(git,['show','HEAD:public/'+file],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']});}catch{};const original=new Map([...before.matchAll(/(\/(?:js|css)\/[^"'?]+)\?v=[^"']+/g)].map(m=>[m[1],m[0]]));s=s.replace(/(\/(?:js|css)\/[^"'?]+)\?v=[^"']+/g,(match,asset)=>changed.has('public'+asset)&&fs.existsSync(path.join(root,'public',asset))?asset+'?v='+hash(asset):(original.get(asset)||match));fs.writeFileSync(p,s);}

const manifest=Object.fromEntries([...changed].filter(p=>/^public\/(?:js|css)\//.test(p)&&/\.(?:js|css)$/.test(p)&&fs.existsSync(path.join(root,p))).sort().map(p=>[p,hash(p.slice(7))]));fs.writeFileSync(path.join(root,'i18n/asset-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
