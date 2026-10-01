const {test}=require('node:test');
const assert=require('node:assert/strict');

test('hydration batches preserve all files within both count and UTF-8 limits',async()=>{
  const {selectionHydrationBatches}=await import('../supabase/functions/_shared/selection-hydration-batches.mjs');
  const files=Array.from({length:620},(_,i)=>({externalId:String(i),label:'é'.repeat(i<270?1000:4)}));
  const batches=[...selectionHydrationBatches(files)];
  assert.deepEqual(batches.flat(),files);
  assert.ok(batches.every(b=>b.length<=250&&Buffer.byteLength(JSON.stringify(b))<=240000));
  assert.equal([...selectionHydrationBatches([])].length,0);
  const oversized={label:'x'.repeat(263000)};
  assert.deepEqual([...selectionHydrationBatches([oversized,{label:'ok'}])],[[oversized],[{label:'ok'}]],
    'oversized evidence reaches the existing rejecting SQL guard; it is never dropped');
});

test('prepared import pause accelerates only a healthy sole finalizer and retains idle time',async()=>{
  const {preparedSelectionThrottle:pause}=await import('../supabase/functions/_shared/selection-initial-import.mjs');
  const input={isSelection:true,prepared:true,activeFinalizers:1,elapsedMs:3200,ordinaryMs:2500};
  assert.equal(pause(input),800);
  assert.equal(pause({...input,elapsedMs:20}),500);
  assert.equal(pause({...input,ordinaryMs:150}),150);
  for(const change of [{isSelection:false},{prepared:false},{activeFinalizers:2},
    {activeFinalizers:null},{elapsedMs:5001},{elapsedMs:NaN}]) assert.equal(pause({...input,...change}),2500);
});
