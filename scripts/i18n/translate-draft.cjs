'use strict';
// Development-only initial translation. Runtime and release builds never call this service.
// Input must be reviewed product UI copy, never source dumps or user/provider values.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const file=path.resolve(root,process.argv[2]||'i18n/native.json');
const catalog=JSON.parse(fs.readFileSync(file));
const locales=require('../../i18n/locales.json');
const shared=require('../../i18n/messages.json');
const glossary=require('../../i18n/glossary.json');
const normalize=s=>s.replace(/\s+/g,' ').trim();
const sharedByEnglish=Object.fromEntries(Object.values(shared).map(v=>[normalize(v[0]),v]));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const failures=[];
const knownBySource={};
for(const name of ['web','web-extra','web-dynamic','web-tail'])for(const e of Object.values(require('../../i18n/'+name+'.json')))knownBySource[e.source]={...knownBySource[e.source],...e};
const manualReview=require('../../i18n/reviewed.json');
const codeValues=new Set(require('../../i18n/code-values.json'));
const save=()=>fs.writeFileSync(file,JSON.stringify(catalog,null,2)+'\n');
const placeholders=/%(?:\d+\$)?[dsf]|%%|\{\{[^}]+\}\}|\n|\b(?:Norva|Revolut|Didit|Chromecast|Xtream|TMDB|Google(?: Play)?|Authenticator|YouTube|Microsoft|Cloudflare|Supabase|Android|Play Store)\b/g;
function protect(source){const args=[];return {text:source.replace(placeholders,p=>{args.push(p);return `ZXQARG${args.length-1}ZXQ`;}),args};}
function restore(text,args){for(const [i,value]of args.entries()){const marker=`ZXQARG${i}ZXQ`;if(!text.includes(marker))throw Error('Translation lost placeholder '+marker);text=text.replaceAll(marker,value);}return text.trim();}
async function request(text,locale){const url=new URL('https://translate.googleapis.com/translate_a/single');for(const [k,v]of Object.entries({client:'gtx',sl:'auto',tl:locale==='fil'?'tl':locale,dt:'t',q:text}))url.searchParams.set(k,v);const r=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!r.ok){const retryAfter=r.headers.get('retry-after');throw Error(`Translation service ${r.status}; Retry-After: ${retryAfter||'not supplied'}. Stopped without accepting incomplete output.`);}const data=await r.json();return data[0].map(x=>x[0]||'').join('');}
(async()=>{for(const [index,locale]of locales.entries()){let pending=[];for(const [key,entry]of Object.entries(catalog)){const reviewed=glossary[entry.source||entry.en];if(reviewed){entry[locale.code]=reviewed[index];continue;}if(manualReview[key]?.[locale.code]){entry[locale.code]=manualReview[key][locale.code];continue;}if(codeValues.has(entry.source)){entry[locale.code]=entry.source;continue;}if(entry[locale.code])continue;const known=knownBySource[entry.source]?.[locale.code];if(known){entry[locale.code]=known;continue;}const shared=sharedByEnglish[normalize(entry.source||entry.en)];if(shared){entry[locale.code]=shared[index];continue;}pending.push([key,entry]);}save();let done=0;while(pending.length){const batch=[];let size=0;while(pending.length&&batch.length<20&&size+(pending[0][1].source||pending[0][1].en).length<2500){const row=pending.shift();size+=(row[1].source||row[1].en).length;batch.push(row);}if(!batch.length)batch.push(pending.shift());const protectedRows=batch.map(([,e])=>protect(e.translationInput||e.source||e.en));const input=protectedRows.map((p,i)=>`ZXQROW${i}ZXQ\n${p.text}`).join('\n');const output=await request(input,locale.code);const parts=[...output.matchAll(/ZXQROW\s*(\d+)\s*ZXQ\s*([\s\S]*?)(?=ZXQROW\s*\d+\s*ZXQ|$)/g)];if(parts.length!==batch.length)throw Error(`Unexpected batch structure for ${locale.code}: ${parts.length}/${batch.length}`);for(let i=0;i<parts.length;i++){if(Number(parts[i][1])!==i)throw Error('Reordered translation');try { batch[i][1][locale.code]=restore(parts[i][2],protectedRows[i].args); }
 catch (error) { const single=await request(protectedRows[i].text.replace(/(ZXQARG\d+ZXQ)(?=ZXQARG)/g,'$1 '),locale.code); try {batch[i][1][locale.code]=restore(single,protectedRows[i].args);} catch (_) {failures.push({locale:locale.code,source:batch[i][1].source||batch[i][1].en,output:single,error:error.message});console.log('Needs contextual review: '+locale.code+' '+(batch[i][1].source||batch[i][1].en));} }}done+=batch.length;save();console.log(`${locale.code}: ${done} translated, ${pending.length} remaining`);await pause(1500);}}
fs.writeFileSync(file+'.review.json',JSON.stringify(failures,null,2)+'\n');console.log('Draft pass finished; unresolved translations: '+failures.length);if(failures.length)process.exitCode=1;})().catch(e=>{save();console.error(e.message);process.exitCode=1;});
