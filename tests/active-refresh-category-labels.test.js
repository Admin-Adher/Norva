const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const source=fs.readFileSync('supabase/functions/norva-provider-access/index.ts','utf8');
const start=source.indexOf('function applyActiveMediaCategoryLabels(');
const end=source.indexOf('\nfunction activeTitlePayload(',start);
const apply=Function('arrayRecordField',source.slice(start,end)+';return applyActiveMediaCategoryLabels;')((v,k)=>v[k]||[]);
test('resolved categories reach projections only for the matching media type, ID and category',()=>{
 const rows=[{item_type:'live',external_id:'1',parent_external_id:'fr',metadata:{},subtitle:null},
 {item_type:'movie',external_id:'1',parent_external_id:'fr',metadata:{},subtitle:null},
 {item_type:'live',external_id:'2',parent_external_id:'uk',metadata:{},subtitle:null},
 {item_type:'live',external_id:'3',parent_external_id:'fr',metadata:{categoryName:'Explicit'},subtitle:'Explicit'}];
 apply(rows,{items:[{itemType:'live',externalId:'1',categoryId:'fr',categoryName:'France'},
 {itemType:'live',externalId:'2',categoryId:'fr',categoryName:'Wrong category'},
 {itemType:'live',externalId:'3',categoryId:'fr',categoryName:'France'}]});
 assert.equal(rows[0].metadata.categoryName,'France');assert.equal(rows[0].subtitle,'France');
 assert.equal(rows[1].metadata.categoryName,undefined);assert.equal(rows[2].metadata.categoryName,undefined);
 assert.equal(rows[3].metadata.categoryName,'Explicit');
});
