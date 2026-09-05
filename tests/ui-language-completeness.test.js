'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validate}=require('../scripts/i18n/catalog.cjs');
const locales=require('../i18n/locales.json');
test('release validation rejects missing languages and lost or duplicated parameters',()=>{
 const item={source:'Count: {{p0}}',...Object.fromEntries(locales.map(l=>[l.code,'Count: {{p0}}']))};
 assert.doesNotThrow(()=>validate({ui_example:item}));
 assert.throws(()=>validate({ui_example:{...item,fil:''}}),/missing fil/);
 assert.throws(()=>validate({ui_example:{...item,ar:'Count'}}),/invalid parameters ar/);
 assert.throws(()=>validate({ui_example:{...item,tr:'{{p0}} {{p0}}'}}),/invalid parameters tr/);
});
test('every migrated UI asset matches its recorded content hash',()=>{
 const manifest=require('../i18n/asset-manifest.json');assert.ok(Object.keys(manifest).length>30);
 for(const [file,expected]of Object.entries(manifest)){
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8').replace(/\r\n/g,'\n');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex').slice(0,10),expected,file);
 }
});
test('native plural formats retain every supplied argument across all locales',()=>{
 const {read,normalize,ignored,format}=require('../scripts/i18n/native-resources.cjs');const catalog=require('../i18n/native.json');
 for(const platform of ['phone','tv'])for(const row of read(path.join(__dirname,`../clients/android-${platform}/app/src/main/res/values/strings.xml`)).filter(r=>!ignored.has(r.name)))for(const source of Object.values(row.values))for(const locale of locales){
  const translated=catalog[normalize(source)]?.[locale.code];assert.equal(typeof translated,'string',`${platform}/${row.name}/${locale.code}`);assert.equal(format(translated),format(source),`${row.name}/${locale.code}`);
 }
});
