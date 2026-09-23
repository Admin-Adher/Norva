const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = import('../supabase/functions/_shared/xtream-progressive-vod.mjs');
const cursor = () => ({ v:2, order:'cinema_first', cats:{movie:['1','2'],series:['3'],live:['4']}, walkIdx:3, runVersion:10, startedAt:'run-1' });

test('publication waits for stable cinema inventory, independently of unfinished TV', async () => {
  const {cinemaInventoryIsStable: stable} = await helpers;
  assert.equal(stable(cursor()), true);
  assert.equal(stable({...cursor(),walkIdx:2}), false);
  assert.equal(stable({...cursor(),v:1}), false);
  assert.equal(stable({...cursor(),runVersion:null}), false);
  assert.equal(stable({...cursor(),cats:{movie:[],series:[]},walkIdx:1}), false);
  assert.equal(stable({...cursor(),cats:{movie:[],series:[]},walkIdx:2}), true);
});

test('publication cursor is bound to generation and the exact discovery run', async () => {
  const {cinemaPublicationState: state} = await helpers;
  const c=cursor(), saved={...state(c,'g1'),afterId:'b',movies:2,complete:true};
  c.cinemaPublication=saved;
  assert.deepEqual(state(c,'g1'),saved);
  for(const next of [state(c,'g2'),state({...c,runVersion:11},'g1'),state({...c,startedAt:'run-2'},'g1')]){
    assert.equal(next.afterId,''); assert.equal(next.complete,false);
  }
});

test('pages publish before their checkpoint; full pages require an EOF probe', async () => {
  const {cinemaPublicationState,publishCinemaPages} = await helpers;
  const events=[], pages=[[{id:'a',item_type:'movie'},{id:'b',item_type:'series'}],[]];
  const result=await publishCinemaPages({state:cinemaPublicationState(cursor(),'g'),limit:2,deadline:10,now:()=>0,
    load:async(after)=>{events.push(['load',after]);return pages.shift()},
    project:async rows=>events.push(['project',rows.length]),
    checkpoint:async s=>events.push(['checkpoint',s.complete])});
  assert.deepEqual(events,[['load',''],['project',2],['checkpoint',false],['load','b'],['checkpoint',true]]);
  assert.equal(result.movies,1);assert.equal(result.series,1);assert.equal(result.complete,true);
});

test('failed projection does not advance the durable cursor and is replayable', async () => {
  const {cinemaPublicationState,publishCinemaPages} = await helpers;
  const state=cinemaPublicationState(cursor(),'g'); let checkpoints=0;
  await assert.rejects(publishCinemaPages({state,limit:2,deadline:10,now:()=>0,
    load:async()=>[{id:'a',item_type:'movie'}],project:async()=>{throw Error('transient DB')},
    checkpoint:async()=>checkpoints++}),/transient DB/);
  assert.equal(state.afterId,'');assert.equal(checkpoints,0);
});

test('time budget resumes from the last committed page without losing titles', async () => {
  const {cinemaPublicationState,publishCinemaPages} = await helpers;
  let clock=0, saved; const seen=[];
  const run = state=>publishCinemaPages({state,limit:1,deadline:1,now:()=>clock,
    load:async after=>after ? [] : [{id:'a',item_type:'movie'}],
    project:async rows=>seen.push(...rows.map(r=>r.id)),checkpoint:async s=>{saved=s;clock=2}});
  const first=await run(cinemaPublicationState(cursor(),'g'));
  assert.equal(first.complete,false);assert.equal(saved.afterId,'a');
  clock=0;const last=await run(first);assert.equal(last.complete,true);assert.deepEqual(seen,['a']);
});

test('superseding a run stops the worker after its guarded checkpoint', async () => {
  const {cinemaPublicationState,publishCinemaPages} = await helpers;let loads=0;
  const result=await publishCinemaPages({state:cinemaPublicationState(cursor(),'g'),limit:1,deadline:10,now:()=>0,
    load:async()=>{loads++;return [{id:'a',item_type:'movie'}]},project:async()=>{},checkpoint:async()=>false});
  assert.equal(result.superseded,true);assert.equal(loads,1);
});
