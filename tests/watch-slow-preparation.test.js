'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const later = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
function fixture(type='movie') {
 const ids=new Map(), jobs=new Map(), events=[]; let tick=0;
 const document={activeElement:null,getElementById:id=>ids.get(id),querySelector:()=>null};
 const element=()=>{const classes=new Set();return {classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},setAttribute(){},contains(x){return x===this;},focus(){document.activeElement=this;}};};
 for(const id of ['watch-slow-preparation','watch-slow-continue','watch-slow-versions'])ids.set(id,element());
 ids.get('watch-slow-preparation').classList.add('hidden');
 const context={window:{},document,console,setTimeout:(fn,ms)=>{jobs.set(++tick,{fn,ms});return tick;},clearTimeout:id=>jobs.delete(id)};
 vm.runInNewContext(fs.readFileSync('public/js/pages/WatchPage.js','utf8'),context);
 const page=Object.create(context.window.WatchPage.prototype);
 const app={currentUser:{id:'owner'},currentPage:'watch',pages:{}};
 Object.assign(page,{app,content:{type,sourceId:'source',id:'file',...(type==='series'?{seriesId:'show',currentEpisode:2}: {})},_playbackAttemptId:1,backBtn:element(),loadingSpinner:element(),getResumeSnapshotPosition:()=>42,
 async releasePlaybackPipelineForRetry(options){events.push(['close',options.strict]);},async waitForProviderSlotRelease(){events.push('drained');},showStoppedPreparationRecovery(){events.push('recovery-error');}});
 app.pages.movies=app.pages.series={async openPlaybackRecovery(item,options){events.push(['catalogue',JSON.parse(JSON.stringify(item)),options.position]);return true;}};
 page.loadingSpinner.classList.add('show');
 return {page,app,ids,jobs,events,document,fire(){const job=[...jobs.values()][0];jobs.clear();job.fn();}};
}
test('45s notice never requests media or changes playback; keep preparing only dismisses',()=>{
 const f=fixture();f.page.armSlowPreparation();f.page.armSlowPreparation();
 assert.equal(f.jobs.size,1);assert.equal([...f.jobs.values()][0].ms,45000);
 assert.equal(f.ids.get('watch-slow-preparation').classList.contains('hidden'),true);
 f.fire();assert.equal(f.ids.get('watch-slow-preparation').classList.contains('hidden'),false);
 f.ids.get('watch-slow-continue').onclick();assert.equal(f.ids.get('watch-slow-preparation').classList.contains('hidden'),true);
 assert.equal(f.page.showSlowPreparation(f.page._slowPreparation),false);assert.deepEqual(f.events,[]);
 assert.equal(f.document.activeElement,f.page.backBtn);
});
test('ready, navigation, account, identity and playback attempt invalidate pending UI/actions',async()=>{
 for(const change of [f=>f.page.clearSlowPreparation(),f=>f.app.currentPage='home',f=>f.app.currentUser={id:'owner'},f=>f.app.currentUser.id='other',f=>f.app._signOutInFlight=true,f=>f.page.content.id='new',f=>f.page.content.sourceId='new',f=>f.page._playbackAttemptId++]){
  const f=fixture();f.page.armSlowPreparation();const state=f.page._slowPreparation;
  change(f);assert.equal(f.page.showSlowPreparation(state),false);assert.deepEqual(f.events,[]);
 }
 const f=fixture();f.page.armSlowPreparation();f.fire();const click=f.ids.get('watch-slow-versions').onclick;
 f.page.clearSlowPreparation();click();assert.deepEqual(f.events,[]);assert.equal(f.jobs.size,0);assert.equal(f.ids.get('watch-slow-versions').onclick,null);
});
test('live or unidentified series never arms a VOD recovery',()=>{
 for(const type of ['live','channel','series']){const f=fixture(type);delete f.page.content.seriesId;f.page.armSlowPreparation();assert.equal(f.jobs.size,0);}
});
test('explicit alternatives cancel old resolve, strictly drain then open exact movie/series without playback',async()=>{
 for(const type of ['movie','series']){
  const f=fixture(type);f.page.armSlowPreparation();f.fire();const old=f.page._playbackAttemptId;
  assert.equal(await f.page.openRefusedVersionDetails(true,{slowPreparation:true}),true);
  assert.equal(f.page._playbackAttemptId,old+1);assert.equal(f.page._slowPreparation,null);
  assert.deepEqual(f.events,[['close',true],'drained',['catalogue',type==='movie'?{sourceId:'source',stream_id:'file'}:{sourceId:'source',series_id:'show'},42]]);
 }
});
test('failed exact drain does not query alternatives or automatically retry media',async()=>{
 const f=fixture();f.page.armSlowPreparation();f.page.releasePlaybackPipelineForRetry=async()=>{throw Error('not drained');};
 assert.equal(await f.page.openRefusedVersionDetails(true,{slowPreparation:true}),false);
 assert.deepEqual(f.events,['recovery-error']);
});
test('double clicks and changes while draining cannot open a stale catalogue',async()=>{
 for(const change of [f=>f.app.currentPage='home',f=>f.app._signOutInFlight=true,f=>f.app.currentUser={id:'other'},f=>f.page.beginPlaybackAttempt()]){
  const f=fixture(),gate=later();f.page.armSlowPreparation();f.page.releasePlaybackPipelineForRetry=()=>gate.promise;
  const work=f.page.openRefusedVersionDetails(true,{slowPreparation:true});
  assert.equal(await f.page.openRefusedVersionDetails(true,{slowPreparation:true}),false);
  change(f);gate.resolve();assert.equal(await work,false);assert.deepEqual(f.events,[]);
 }
});
function seriesFixture(){
 const events=[],owner={id:'owner'},scope={};
 const app={currentUser:owner,currentPage:'watch',navigateTo(p){events.push('navigate');this.currentPage=p;page.beginFicheIntent();}};
 const exact={sourceId:'s',series_id:'original'},other={sourceId:'t',series_id:'other'};
 const api={media:{async page(query){events.push(['query',JSON.parse(JSON.stringify(query))]);return {items:[exact,other]};}}};
 const media={groupItems:items=>[{items,representative:items[0]}]};
 const ctx={window:{NorvaPlaybackRefusals:{capture:()=>scope}},MediaUtils:media,API:api,console};
 vm.runInNewContext(fs.readFileSync('public/js/pages/SeriesPage.js','utf8'),ctx);
 const page=Object.create(ctx.window.SeriesPage.prototype);page.app=app;
 page.showSeriesDetailsV2=async(item,group,opts)=>events.push(['details',item.series_id,opts.focusVersions,opts.manualPick,group.items.length]);
 return {page,app,api,events,exact};
}
test('series recovery uses owned identity and explicit version/episode choice; no episode copied',async()=>{
 const f=seriesFixture();assert.equal(await f.page.openPlaybackRecovery(f.exact,{position:999}),true);
 assert.deepEqual(f.events,[['query',{type:'series',sourceId:'s',externalId:'original',limit:1}],'navigate',['details','original',true,true,2]]);
});
test('series API failure or missing original cannot synthesize an owned recovery fiche',async()=>{
 for(const response of [null,{items:[{sourceId:'t',series_id:'other'}]}]){
  const f=seriesFixture();f.api.media.page=async()=>{if(!response)throw Error('offline');return response;};
  assert.equal(await f.page.openPlaybackRecovery(f.exact),false);assert.deepEqual(f.events,[]);
 }
});
test('owner change or later fiche request cancels a series lookup before navigation',async()=>{
 for(const change of [f=>f.app.currentUser={id:'other'},f=>f.app._signOutInFlight=true,f=>f.page.beginFicheIntent()]){
  const f=seriesFixture(),gate=later();f.api.media.page=()=>gate.promise;
  const work=f.page.openPlaybackRecovery(f.exact);change(f);gate.resolve({items:[f.exact]});
  assert.equal(await work,false);assert.deepEqual(f.events,[]);
 }
});
