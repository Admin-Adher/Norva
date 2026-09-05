'use strict';
const fs=require('node:fs'),path=require('node:path');
const {read,normalize,ignored,xml,format}=require('./native-resources.cjs');
const root=path.resolve(__dirname,'../..'),check=process.argv.includes('--check');
const locales=require('../../i18n/locales.json'),catalog=require('../../i18n/native.json');
function write(file,text){const full=path.join(root,file);if(check){if(!fs.existsSync(full)||fs.readFileSync(full,'utf8').replace(/\r\n/g,'\n')!==text.replace(/\r\n/g,'\n'))throw Error('Stale native translation: '+file);return;}fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,text);}
let count=0;
for(const platform of ['phone','tv']) {const base=`clients/android-${platform}/app/src/main/res`;const sourcePath=path.join(root,base,'values/strings.xml');const rows=read(sourcePath).filter(r=>!ignored.has(r.name));
 for(const locale of locales.filter(l=>l.code!=='en')){const body=[];for(const row of rows){const values={};const quantities=row.type==='plurals'?new Intl.PluralRules(locale.code).resolvedOptions().pluralCategories.sort():['other'];for(const quantity of quantities){const original=row.values[quantity]||row.values[quantity==='one'?'one':'other']||row.values.other;const entry=catalog[normalize(original)];if(!entry?.[locale.code])throw Error(`Missing ${platform}:${row.name}:${quantity}:${locale.code}`);const translated=entry[locale.code];if(format(original)!==format(translated))throw Error(`Invalid format ${platform}:${row.name}:${quantity}:${locale.code}`);values[quantity]=translated;}
 if(row.type==='string')body.push(`    <string name="${row.name}">${xml(values.other)}</string>`);else body.push(`    <plurals name="${row.name}">\n`+Object.entries(values).map(([q,v])=>`        <item quantity="${q}">${xml(v)}</item>`).join('\n')+'\n    </plurals>');count++;}
 write(`${base}/${locale.android}/strings.xml`,'<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from i18n/native.json. Do not edit. -->\n<resources>\n'+body.join('\n')+'\n</resources>\n');}
 // Real UI is translatable, including the previously excluded download plurals.
 let defaultXml=fs.readFileSync(sourcePath,'utf8');defaultXml=defaultXml.replace(/<(string|plurals)\b([^>]+)>/g,(all,tag,attributes)=>{const name=attributes.match(/name="([^"]+)"/)?.[1];return ignored.has(name)?(name==='app_name'&&!attributes.includes('translatable=')?`<${tag}${attributes} translatable="false">`:all):`<${tag}${attributes.replace(/\s+translatable="false"/,'')}>`;});if(!check)fs.writeFileSync(sourcePath,defaultXml);else if(defaultXml!==fs.readFileSync(sourcePath,'utf8'))throw Error('UI resources wrongly marked non-translatable');
}
console.log(`Validated ${count} native resource entries including plural categories.`);
