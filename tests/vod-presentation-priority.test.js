'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { window: {}, console, Intl, document: { documentElement: { lang: 'fr' } } };
vm.createContext(context);
for (const file of ['utils/mediaUtils','pages/MoviesPage','pages/SeriesPage','pages/HomePage','utils/GenreRails']) {
 vm.runInContext(fs.readFileSync(`public/js/${file}.js`, 'utf8'),context);
 if (file === 'utils/mediaUtils') context.MediaUtils = context.window.MediaUtils;
}
const M = context.window.MediaUtils;
const complete = {id:'complete',name:'Zulu',poster_url:'/poster.jpg',description:'A real synopsis.',audioLanguages:['en'],audioLanguageValidationStatus:'probed'};
test('all three fields outrank an incomplete card without losing any cards or mutating input',()=>{
 const input=[{id:'empty'}, {...complete,id:'no-audio',audioLanguages:[]},complete,{...complete,id:'tie'}];
 assert.deepEqual(Array.from(M.rankByPresentation(input),x=>x.id),['complete','tie','no-audio','empty']);
 assert.equal(input[0].id,'empty');
});
for(const [name, patch, expected] of [
 ['title prefixes are not audio', {audioLanguageValidationStatus:'not_analyzed',name:'EN | Title'},2],
 ['original language is not audio', {audioLanguageValidationStatus:'pending',original_language:'en'},2],
 ['subtitles are not audio', {audioLanguageValidationStatus:'pending',subtitleLanguages:['en']},2],
 ['pending tags are not audio', {audioLanguageValidationStatus:'pending',audio_tracks:[{lang:'en'}]},2],
 ['unknown tags are not audio', {audioLanguages:['und','unknown']},2],
 ['placeholder is not a poster', {poster_url:'/img/norva-media-placeholder.png'},2],
 ['empty synopsis is not complete', {description:'   '},2],
 ['placeholder synopsis is not complete', {description:'No overview available.'},2],
 ['human confirmation counts separately', {audioLanguageValidationStatus:'pending',humanAudioLanguages:['es'],humanAudioLanguageStatus:'human_confirmed',humanAudioLanguageScope:'file'},3],
 ['explicit provider declaration counts', {audioLanguageValidationStatus:'pending',providerAudioLanguages:['fr'],providerAudioLanguageStatus:'provider_declared'},3],
 ['invalid language shape fails closed', {audioLanguages:'en'},2]
]) test(name,()=>assert.equal(M.presentationCompleteness({...complete,...patch}),expected));
for(const name of ['MoviesPage','SeriesPage']) test(name+' default priority and explicit sorting',()=>{
 const page=Object.create(context.window[name].prototype);
 page.sortSelect={value:'default'};
 const cards=[{representative:{id:'first',name:'Alpha'},preferenceScore:999},{representative:complete,preferenceScore:0}];
 page.sortCards(cards);assert.equal(cards[0].representative.id,'complete');
 page.sortSelect.value='name';page.sortCards(cards);assert.equal(cards[0].representative.id,'first');
 page.sortSelect.value='default';page.searchInput={value:'Alpha'};page.sortCards(cards);assert.equal(cards[0].representative.id,'first');
});
test('home suggestions prioritize complete cards before preference within tiers',()=>{
 const home=Object.create(context.window.HomePage.prototype);home.contentPreferences={};
 assert.equal(home.rankRailItemsByLanguagePreference([{id:'empty'},complete])[0].id,'complete');
});
test('genre rendering uses ranked data and retains incomplete fallback',()=>{
 let html='';const container={classList:{add(){},remove(){}},querySelectorAll:()=>[],set innerHTML(v){html=v;}};
 context.window.GenreRails.render(container,[{items:[{title:'Missing'}, {...complete,title:'Complete'}]}]);
 assert.ok(html.indexOf('alt="Complete"')<html.indexOf('alt="Missing"'));
});
test('home billboard finds complete candidates beyond the first six while keeping resume first',()=>{
 const hero={dataset:{heroHoverBound:'1'},classList:{add(){},remove(){}},querySelector:()=>null,querySelectorAll:()=>[]};
 context.document.getElementById=()=>hero;context.clearInterval=()=>{};
 const home=Object.create(context.window.HomePage.prototype);
 Object.assign(home,{posterFromItem:x=>x.poster_url,hasUsefulDisplayTitle:()=>true,backdropFromItem:()=>'/backdrop.jpg',
 getResumeOffset:()=>10,showHeroSlide(){},_startHeroRotation(){},escapeAttr:x=>x});
 const partial=Array.from({length:8},(_,i)=>({id:'partial'+i,poster_url:'/p.jpg'}));
 const resume={id:'resume',poster_url:'/p.jpg',progress:10,duration:100};
 home.renderHero([resume],[{id:'popular-movies',items:partial},{id:'genre',items:[complete]}]);
 assert.equal(home._heroSlides[0].item.id,'resume');
 assert.equal(home._heroSlides[1].item.id,'complete');
 assert.equal(home._heroSlides.length,7);
});
