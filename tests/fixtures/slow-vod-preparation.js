/* Offline fixture: real WatchPage + markup + CSS, controlled session boundaries. */
window.SlowPreparationQA = (() => {
 let page, events, markup;
 const check=(ok,message)=>{if(!ok)throw Error(message);};
 async function mount({kind='movie',rebuffer=false,advance=true}={}) {
  page?.hideLoading({restoreFocus:false});
  if(!markup)markup=new DOMParser().parseFromString(await(await fetch('/app.html')).text(),'text/html').getElementById('page-watch').outerHTML;
  // Reuse the same DOM as the SPA; repeated decoding of detached animated
  // artwork is unrelated to the recovery assertions.
  if(!document.getElementById('page-watch'))document.getElementById('qa-host').innerHTML=markup;
  document.getElementById('page-watch').classList.add('active');
  events=[];
  const app={currentPage:'watch',currentUser:{id:'qa-owner'},pages:{}};
  page=Object.create(WatchPage.prototype);
  Object.assign(page,{app,content:{type:kind,sourceId:'qa-source',id:'qa-file',...(kind==='series'?{seriesId:'qa-series'}:{})},_playbackAttemptId:1,
   loadingSpinner:document.getElementById('watch-loading'),video:document.getElementById('watch-video'),overlay:document.getElementById('watch-overlay'),backBtn:document.querySelector('.watch-back-btn'),centerPlayBtn:document.getElementById('watch-center-play'),
   _firstFrameReported:rebuffer,getResumeSnapshotPosition:()=>42,
   async releasePlaybackPipelineForRetry({strict}){check(strict,'strict drain');events.push('close');await new Promise(r=>setTimeout(r,50));events.push('closed');},
   async waitForProviderSlotRelease(){events.push('released');},showOverlay(){},clearPlaybackErrorRefreshTimer(){}});
  for(const route of ['movies','series'])app.pages[route]={async openPlaybackRecovery(item){events.push('open-'+route);check(events.includes('closed'),'opened before drain');check(item[route==='movies'?'stream_id':'series_id']===(route==='movies'?'qa-file':'qa-series'),'wrong identity');return true;}};
  page.backBtn.onclick=()=>{page.beginPlaybackAttempt();page.hideLoading({restoreFocus:false});app.currentPage='movies';events.push('back');};
  for(const el of document.querySelectorAll('[data-i18n]'))el.textContent=NorvaI18n.t(el.dataset.i18n,{defaultValue:el.textContent});
  page.showLoading();
  if(advance){clearTimeout(page._slowPreparationTimer);page.showSlowPreparation(page._slowPreparation);}
  // Inspect a rendered state, including Android WebView's next paint.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  return page;
 }
 function layout(){
  const panel=document.getElementById('watch-slow-preparation');
  check(!panel.classList.contains('hidden'),'notice hidden');
  check(document.documentElement.scrollWidth<=innerWidth+1,'horizontal overflow');
  check(panel.querySelector('[role=status][aria-live=polite]'),'missing announcement');
  for(const id of ['watch-slow-continue','watch-slow-versions']){
   const el=document.getElementById(id);el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();
   check(r.width>=44&&r.height>=44,'small touch target');check(r.left>=0&&r.right<=innerWidth+1,'clipped horizontally');
   check(r.top>=0&&r.bottom<=innerHeight+1,'action not scrollable into view');
   check(el.scrollWidth<=el.clientWidth+1,'clipped text');
   const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);check(el===top||el.contains(top),'covered action');
   el.focus();check(document.activeElement===el,'focus failed');
  }
 }
 async function verify(){
  console.info('SLOW_VOD_QA start');
  for(const kind of ['movie','series'])for(const rebuffer of [false,true]){
   await mount({kind,rebuffer});console.info('SLOW_VOD_QA '+kind+' rebuffer='+rebuffer);layout();console.info('SLOW_VOD_QA layout');
   document.getElementById('watch-slow-continue').click();check(events.length===0,'continue changed pipeline');
   check(document.getElementById('watch-slow-preparation').classList.contains('hidden'),'continue not dismissed');
   check(page.loadingSpinner.classList.contains('show'),'continue stopped preparation');
   await mount({kind,rebuffer});layout();console.info('SLOW_VOD_QA handoff');
   const original=page._playbackAttemptId;document.getElementById('watch-slow-versions').click();
   check(page._playbackAttemptId===original+1,'late ready not cancelled');
   await new Promise(r=>setTimeout(r,100));check(events.join(',')===`close,closed,released,open-${kind==='movie'?'movies':'series'}`,'bad handoff '+events.join(','));
   page.hideLoading({restoreFocus:false});console.info('SLOW_VOD_QA hidden');
  }
  console.info('SLOW_VOD_QA Back');
  await mount();page.backBtn.click();check(page._slowPreparation===null,'Back left notice active');
  await mount();page.hideLoading({restoreFocus:false});check(document.getElementById('watch-slow-versions').onclick===null,'ready leaves action');
  await mount();page.app.currentUser={id:'other'};document.getElementById('watch-slow-versions').click();check(events.length===0,'stale owner action');page.hideLoading({restoreFocus:false});
  console.info('SLOW_VOD_QA done');
  return 'ok';
 }
 return {mount,layout,verify,ready(){page.hideLoading({restoreFocus:false});},events:()=>events};
})();
