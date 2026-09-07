const test = require('node:test');
const assert = require('node:assert/strict');
test('Selection container tags preserve ordered multiple tracks and leave absent languages unknown', async () => {
  const { selectionContainerTags, selectionContainerLanguage } = await import('../scripts/selection-container-tags.mjs');
  const result = selectionContainerTags({ streams:[
    {index:0,codec_type:'video',codec_name:'h264',width:1280,height:534,tags:{language:'spa'}},
    {index:1,codec_type:'audio',codec_name:'aac',channels:2,tags:{language:'por'}},
    {index:2,codec_type:'audio',codec_name:'aac',tags:{language:'eng'}},
    {index:3,codec_type:'audio',codec_name:'aac',tags:{language:'und'}},
    {index:4,codec_type:'subtitle',codec_name:'subrip',tags:{language:'spa'}},
  ],format:{duration:'6000.5'} });
  assert.deepEqual(result.audioLanguages, ['pt','en']);
  assert.deepEqual(result.subtitleLanguages, ['es']);
  assert.deepEqual(result.codecProfile.audioTracks.map(t=>[t.index,t.language]), [[1,'pt'],[2,'en'],[3,null]]);
  assert.equal(result.quality, 'HD');
  assert.equal(result.duration, 6000.5);
  for (const raw of ['und','unk','','MULTI','Dual',undefined]) assert.equal(selectionContainerLanguage(raw), null);
  assert.equal(selectionContainerTags({streams:[]}), null);
});
test('A language tag under review cannot become a badge or change another track', async () => {
  const { selectionContainerTags } = await import('../scripts/selection-container-tags.mjs');
  const result=selectionContainerTags({streams:[
    {index:0,codec_type:'video',width:720,height:404},
    {index:1,codec_type:'audio',tags:{language:'lat'}},
    {index:2,codec_type:'audio',tags:{language:'spa'}},
  ]},{heldLanguageCodes:['lat']});
  assert.deepEqual(result.audioLanguages,['es']);
  assert.equal(result.codecProfile.audioTracks[0].language,null);
  assert.equal(result.quality,'SD');
  assert.deepEqual(result.subtitleLanguages,[]);
});
