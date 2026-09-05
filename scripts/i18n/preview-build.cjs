'use strict';
// Local-only runtime verification while some translation drafts are still pending.
// Never writes the deployable public bundle or passes the release completeness gate.
const fs=require('fs'),path=require('path'),{buildSync}=require('esbuild');
const {load}=require('./catalog.cjs'),locales=require('../../i18n/locales.json');
const catalog=load();const values=Object.fromEntries(Object.entries(catalog).map(([k,e])=>[k,Object.fromEntries(locales.map(l=>[l.code,e[l.code]||e.en||e.source]))]));
const source=fs.readFileSync(path.join(__dirname,'../../i18n/runtime.js'),'utf8').replace(/import webBase[\s\S]*?const webMessages = [^;]+;/,'const webMessages = '+JSON.stringify(values)+';');
const bundle=buildSync({stdin:{contents:source,resolveDir:path.join(__dirname,'../../i18n'),sourcefile:'runtime.js'},bundle:true,write:false,format:'iife',minify:true,target:'chrome80'}).outputFiles[0].text;
fs.mkdirSync('output/i18n',{recursive:true});fs.writeFileSync('output/i18n/preview-runtime.js',bundle);console.log('Draft runtime for local verification only:',Buffer.byteLength(bundle),'bytes');
