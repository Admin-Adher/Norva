'use strict';
const fs=require('node:fs');
const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/\\'/g,"'").replace(/\\"/g,'"').replace(/\\n/g,'\n');
function read(file){const s=fs.readFileSync(file,'utf8'),rows=[];for(const m of s.matchAll(/<(string|plurals)\b([^>]*)>([\s\S]*?)<\/\1>/g)){const name=m[2].match(/name="([^"]+)"/)?.[1];if(name)rows.push({type:m[1],name,attributes:m[2],values:m[1]==='string'?{other:decode(m[3])}:Object.fromEntries([...m[3].matchAll(/<item quantity="([^"]+)">([\s\S]*?)<\/item>/g)].map(x=>[x[1],decode(x[2])]))});}return rows;}
const normalize=s=>s.replace(/\s+/g,' ').trim();
const ignored=new Set(['app_name','norva_google_web_client_id','downloads_close_glyph','downloads_play_glyph','downloads_expand_glyph','downloads_collapse_glyph','downloads_metric_pending']);
const xml=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/^@/,'\\@').replace(/^\?/,'\\?');
const format=s=>[...s.matchAll(/%(?:\d+\$)?[dsf]|%%/g)].map(x=>x[0]).sort().join(',');
module.exports={read,normalize,ignored,xml,format};
