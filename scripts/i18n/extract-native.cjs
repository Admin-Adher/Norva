'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const normalize=s=>s.replace(/\s+/g,' ').trim();
const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/\\'/g,"'").replace(/\\"/g,'"').replace(/\\n/g,'\n');
function read(file){const s=fs.readFileSync(path.join(root,file),'utf8');const rows=[];for(const m of s.matchAll(/<(string|plurals)\b([^>]*)>([\s\S]*?)<\/\1>/g)){const name=m[2].match(/name="([^"]+)"/)?.[1];if(!name)continue;rows.push({type:m[1],name,attributes:m[2],values:m[1]==='string'?{other:decode(m[3])}:Object.fromEntries([...m[3].matchAll(/<item quantity="([^"]+)">([\s\S]*?)<\/item>/g)].map(x=>[x[1],decode(x[2])]))});}return rows;}
const ignore=new Set(['app_name','norva_google_web_client_id','downloads_close_glyph','downloads_play_glyph','downloads_expand_glyph','downloads_collapse_glyph','downloads_metric_pending']);
const catalogPath=path.join(root,'i18n/native.json');const catalog=fs.existsSync(catalogPath)?JSON.parse(fs.readFileSync(catalogPath)):{};
const sources={};
for(const p of ['phone','tv']){const base=`clients/android-${p}/app/src/main/res`;const rows=read(`${base}/values/strings.xml`);const french=Object.fromEntries(read(`${base}/values-fr/strings.xml`).map(x=>[x.name,x]));sources[p]=[];for(const row of rows){if(ignore.has(row.name))continue;sources[p].push(row);for(const [quantity,text]of Object.entries(row.values)){const key=normalize(text);if(!catalog[key])catalog[key]={en:text};if(french[row.name]?.values[quantity])catalog[key].fr=french[row.name].values[quantity];}}
}
fs.writeFileSync(catalogPath,JSON.stringify(catalog,null,2)+'\n');fs.mkdirSync(path.join(root,'output/i18n'),{recursive:true});fs.writeFileSync(path.join(root,'output/i18n/native-sources.json'),JSON.stringify(sources,null,2));console.log(`${Object.keys(catalog).length} unique native UI messages`);
module.exports={read,normalize,decode,ignore};
