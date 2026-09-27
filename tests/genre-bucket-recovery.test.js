const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function element(){return {children:[],style:{},classList:{toggle(){}},isConnected:true,attrs:{},setAttribute(k,v){this.attrs[k]=v;},replaceChildren(){this.children=[];},appendChild(v){this.children.push(v);},addEventListener(k,fn){this[k]=fn;}};}
for(const name of ['MoviesPage','SeriesPage']) {
 function fixture(request){
  const source=fs.readFileSync(`public/js/pages/${name}.js`,'utf8');
  const start=source.indexOf('    async loadBucketPage()');
  const end=source.indexOf('    closeBucket()',start);
  const cards=[];
  const context={API:{media:{genreItems:request}},window:{GenreRails:{appendCards:(_,items)=>cards.push(...items)}},document:{createElement:element},console:{warn(){}}};
  const Page=vm.runInNewContext(`class Page {${source.slice(start,end)}};Page`,context);
  const page=new Page(),loader=element();
  Object.assign(page,{container:{querySelector:()=>loader},bucketGridEl:{isConnected:true},bucketRequestId:1,bucketOffset:0,bucketHasMore:true,bucketSeen:new Set(),activeBucket:'action',currentLanguageParams:()=>({}),_isTvMode:()=>false});
  return {page,loader,cards};
 }
 test(`${name}: failed page has explicit retry and keeps prior cards/offset`,async()=>{
  let fail=true;
  const {page,loader,cards}=fixture(async()=>{if(fail)throw Error('secret provider response');return {items:[{id:'next'}],hasMore:false,count:37};});
  page.bucketOffset=36; cards.push({id:'prior'});
  await page.loadBucketPage();
  assert.equal(loader.attrs.role,'alert');assert.equal(page.bucketOffset,36);assert.equal(cards.length,1);
  assert.equal(loader.children.length,2);assert.doesNotMatch(loader.children[0].textContent,/secret/);
  fail=false; loader.children[1].click();
  await new Promise(setImmediate);
  assert.equal(cards.length,2);assert.equal(page.bucketOffset,37);assert.equal(loader.children.length,0);
 });
 test(`${name}: stale request failure cannot stop the newly selected bucket`,async()=>{
  let reject;
  const {page,loader}=fixture(()=>new Promise((_,r)=>reject=r));
  const pending=page.loadBucketPage();page.bucketRequestId=2;page.bucketLoading=true;
  reject(Error('old request'));await pending;
  assert.equal(page.bucketLoading,true);assert.equal(page.bucketHasMore,true);assert.equal(loader.attrs.role,'status');
 });
 test(`${name}: empty result is a visible terminal state`,async()=>{
  const {page,loader}=fixture(async()=>({items:[],count:0,hasMore:false}));
  await page.loadBucketPage();assert.equal(page.bucketHasMore,false);assert.equal(loader.children.length,1);assert.doesNotMatch(loader.children[0].textContent,/Loading/);
 });
}
