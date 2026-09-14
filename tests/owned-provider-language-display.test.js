const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture(language='fr') {
  const context={window:{},Intl,console,document:{documentElement:{lang:language}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/js/utils/mediaUtils.js'),'utf8'),context);
  return context.window.MediaUtils;
}
const item=codes=>({item_type:'movie',provider_audio_language_status:'provider_declared',provider_audio_languages:codes});
test('canonical owned languages reach card, detail, accessible label and facet in every UI locale',()=>{
  for (const locale of ['fr','en','de','ar','fil']) {
    const M=fixture(locale);
    for(const code of ['fa','ur','tl','gu','or','yue','sq','bs','hr','sr','sl','mk','sw']) {
      const record=item([code]);
      assert.equal(M.providerAudioBadge(record),M.languageDisplayFull(code),`${locale}/${code}`);
      const descriptor=M.versionDescriptor(record,{providerLanguageHints:true});
      assert.equal(descriptor.headline,M.languageDisplayFull(code));
      assert.equal(descriptor.accessibleHeadline,descriptor.headline);
      assert.equal(M.catalogLanguageInfo(record).text,M.languageFacetName('catalog-'+code));
      assert.doesNotMatch(M.languageBadgeHtml(M.catalogLanguageInfo(record)),/vérifier|verify|unverified|provider_declared|internal/i);
      assert.equal(record.audio_tracks,undefined);
    }
  }
});
test('explicit provider status, bounds and input validation remain mandatory',()=>{
  const M=fixture();
  assert.equal(M.providerAudioBadge({provider_audio_languages:['fa']}),'');
  assert.equal(M.providerAudioBadge(item(['https://private.invalid','<img src=x>','und','unknown','xx','zz','un',{},null,5])),'');
  assert.equal(M.providerAudioBadge(item(new Array(32).fill('fa').concat('ur'))),M.languageDisplayFull('fa'));
});
test('exact audio still outranks declarations without changing track indices',()=>{
  const M=fixture();
  const record={...item(['fa']),audio_language_validation_status:'probed',audio_languages_scope:'file',
    audio_languages_observed:true,audio_languages:['en'],audio_tracks_scope:'file',audio_tracks:[{index:4,lang:'en'}],audio_probed_at:'2026-09-14T10:00:00Z'};
  const before=JSON.stringify(record);
  assert.equal(M.providerAudioBadge(record),'');
  assert.equal(M.versionDescriptor(record,{providerLanguageHints:true}).headline,M.languageDisplayFull('en'));
  assert.equal(JSON.stringify(record),before);
});
