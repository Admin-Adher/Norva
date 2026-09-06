const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

test('live-only Home shortcut requires exactly the tenant-visible curated source and fails closed on database errors', async () => {
  const { discoverySourceId, retiredDiscoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const code=fs.readFileSync('supabase/functions/norva-catalog/index.ts','utf8');
  const start=code.indexOf('async function isCuratedLiveOnlyHome('),end=code.indexOf('async function listHomeRails(',start);
  const context=vm.createContext({DISCOVERY_SELECTION_ENABLED:true,discoverySourceId,catalogTitleReadUnavailable:()=>Error('unavailable')});
  vm.runInContext(stripTypeScriptTypes(code.slice(start,end),{mode:'strip'}),context);
  let rows=[],error=null,titles=[],titlesError=null;
  const db={from(table){assert.ok(['cloud_catalog_visible_sources','cloud_catalog_visible_titles'].includes(table));return {
    select(s){assert.equal(s,'id');return this;},eq(k,v){assert.equal(k,'user_id');assert.equal(v,'owner');return this;},
    in(k,v){assert.equal(k,'item_type');assert.deepEqual(Array.from(v),['movie','series']);return this;},
    limit:async n=>{assert.equal(n,table==='cloud_catalog_visible_sources'?2:1);return table==='cloud_catalog_visible_sources'?{data:rows,error}:{data:titles,error:titlesError};}}}};
  for (const ids of [[],['personal'],[await retiredDiscoverySourceId('owner')],[await discoverySourceId('other')],[await discoverySourceId('owner'),'personal']]) {
    rows=ids.map(id=>({id}));assert.equal(await context.isCuratedLiveOnlyHome('owner',db),false);
  }
  rows=[{id:await discoverySourceId('owner')}];assert.equal(await context.isCuratedLiveOnlyHome('owner',db),true);
  titles=[{id:'selection-film'}];assert.equal(await context.isCuratedLiveOnlyHome('owner',db),false);
  titles=[];titlesError={code:'unavailable'};await assert.rejects(context.isCuratedLiveOnlyHome('owner',db),/unavailable/);titlesError=null;
  error={code:'database-unavailable'};await assert.rejects(context.isCuratedLiveOnlyHome('owner',db),/unavailable/);
  const {sanitizeCatalogMediaPayload}=await import('../supabase/functions/_shared/catalog-public-view.mjs');
  assert.equal(sanitizeCatalogMediaPayload({contract:'norva.home.rails.v1',rails:[],liveOnly:true}).liveOnly,true);
});

test('current import is the reviewed allowlist only, regardless of requested aggregate feeds', async () => {
  const { DISCOVERY_PLAYLIST_URL, discoveryPlaylist, discoverySourceId, retiredDiscoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { SELECTION_CURATED_CHANNELS } = await import('../supabase/functions/_shared/selection-curated-channels.mjs');
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  let fetches = 0;
  const result = await fetchDiscoverySelection({ includeVod: false, feeds: [{ id:'unreviewed',kind:'movie',url:'https://example.test/all.m3u' }], fetchPlaylist: async () => { fetches++; } });
  const rows = result.items.map(item => discoveryCatalogFields(DISCOVERY_PLAYLIST_URL,item));
  assert.equal(fetches,0);
  assert.equal(rows.length,24);
  assert.equal(new Set(rows.map(row => row.external_id)).size,24);
  assert.ok(rows.every(row => row.item_type === 'live'));
  assert.deepEqual(rows.map(row => row.playback_hint.targetUrl),SELECTION_CURATED_CHANNELS.map(c => c.url));
  assert.equal(discoveryPlaylist().split('#EXTINF:').length-1,24);
  assert.notEqual(await discoverySourceId('owner'),await retiredDiscoverySourceId('owner'));
  assert.equal(fs.readFileSync('public/catalog/discovery.m3u','utf8').replace(/\r\n/g,'\n'),discoveryPlaylist());
  const registry = JSON.parse(fs.readFileSync('public/catalog/sources.json','utf8'));
  assert.equal(registry.sources.filter(s=>s.kind==='live').reduce((sum,s)=>sum+s.channels,0),24);
  assert.equal(registry.sources.filter(s=>s.kind==='movie').length,2);
  assert.ok(registry.sources.every(s => !s.url));
  assert.equal(fs.readFileSync('public/catalog/xumo-live.m3u','utf8').trim(),'#EXTM3U');
  for (const channel of SELECTION_CURATED_CHANNELS.filter(c=>c.feedId==='fls-reviewed')) {
    for (const [key,value] of new URL(channel.url).searchParams) if (/^(ads\.)?(did|device_id)$/.test(key)) assert.equal(value,'');
    assert.ok(channel.url.includes('gdpr=1'));
  }
});

test('retired playback remains closed and current playback rejects unreviewed or modified targets', async () => {
  const { discoverySourceId, retiredDiscoverySourceId, DISCOVERY_PLAYLIST_URL } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { resolveDiscoveryTarget, fetchDiscoverySelection, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const userId='owner';
  const sourceId=await discoverySourceId(userId);
  const rows=(await fetchDiscoverySelection({ includeVod: false })).items.map(item=>discoveryCatalogFields(DISCOVERY_PLAYLIST_URL,item));
  for (const row of rows) {
    const input={userId,sourceId,metadata:row.metadata,targetUrl:row.playback_hint.targetUrl};
    assert.equal(await resolveDiscoveryTarget(input),input.targetUrl);
    await assert.rejects(resolveDiscoveryTarget({...input,sourceId:await retiredDiscoverySourceId(userId)}),/temporarily unavailable/);
    await assert.rejects(resolveDiscoveryTarget({...input,targetUrl:input.targetUrl+'?changed=1'}),/temporarily unavailable/);
    await assert.rejects(resolveDiscoveryTarget({...input,metadata:{...input.metadata,selectionRevision:'old'}}),/temporarily unavailable/);
  }
  for (const metadata of [{},{discoveryId:'sintel'},{discoveryFeed:'plex'},{discoveryFeed:'iptv-org-movies'}]) {
    const input={userId,sourceId,metadata,targetUrl:'https://example.test/movie.mp4'};
    await assert.rejects(resolveDiscoveryTarget(input),/temporarily unavailable/);
    assert.equal(await resolveDiscoveryTarget({...input,sourceId:'personal'}),input.targetUrl);
  }
});

test('reviewed direct HLS requires the complete owned identity and never grants explicit conversion or copied descriptors', async () => {
  const { discoverySourceId, DISCOVERY_PLAYLIST_URL } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveDirect } = await import('../supabase/functions/_shared/selection-live-delivery.mjs');
  const userId='owner';
  for (const item of (await fetchDiscoverySelection({ includeVod: false })).items) {
    const row=discoveryCatalogFields(DISCOVERY_PLAYLIST_URL,item);
    const input={userId,sourceId:await discoverySourceId(userId),itemType:'live',itemId:row.external_id,ownedItem:row,targetUrl:row.playback_hint.targetUrl};
    const delivery=await resolveSelectionLiveDelivery(input);
    const { SELECTION_CURATED_CHANNELS } = await import('../supabase/functions/_shared/selection-curated-channels.mjs');
    const expectedTransport=SELECTION_CURATED_CHANNELS.find(c=>c.id===row.metadata.selectionChannelId).transport || 'public-hls-direct';
    assert.equal(delivery?.transport,expectedTransport);
    const decision={delivery,targetUrl:input.targetUrl,itemType:'live',clientMode:'transcode',body:{gatewayAutoMode:true,publicHlsDirectSessionGuard:true},clientMetadata:{clientSurface:'web',appMode:'cloud'}};
    assert.equal(shouldUseSelectionLiveDirect(decision),expectedTransport==='public-hls-direct');
    assert.equal(shouldUseSelectionLiveDirect({...decision,delivery:{...delivery}}),false);
    assert.equal(shouldUseSelectionLiveDirect({...decision,body:{...decision.body,forceVideoTranscode:true}}),false);
    for (const changes of [{sourceId:'personal'},{userId:'other'},{itemId:'spoof'},{ownedItem:null},{targetUrl:input.targetUrl+'?x=1'}]) assert.equal(await resolveSelectionLiveDelivery({...input,...changes}),null);
  }
});

test('HTTP and CORS-limited reviewed channels use the revocable relay only through owned server descriptors', async () => {
  const { discoverySourceId, DISCOVERY_PLAYLIST_URL } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  const { resolveSelectionLiveDelivery, shouldUseSelectionLiveRelay } = await import('../supabase/functions/_shared/selection-live-delivery.mjs');
  const relayIds=new Set(['canal-uol-br','tv-vicosa-br','tf1-hd-fr']);
  for (const item of (await fetchDiscoverySelection({includeVod:false})).items) {
    const row=discoveryCatalogFields(DISCOVERY_PLAYLIST_URL,item);
    const input={userId:'owner',sourceId:await discoverySourceId('owner'),itemType:'live',itemId:row.external_id,ownedItem:row,targetUrl:row.playback_hint.targetUrl};
    const delivery=await resolveSelectionLiveDelivery(input);
    const decision={delivery,targetUrl:input.targetUrl,itemType:'live',clientMode:'transcode',body:{gatewayAutoMode:true}};
    const allowed=relayIds.has(row.metadata.selectionChannelId);
    assert.equal(shouldUseSelectionLiveRelay(decision),allowed);
    for (const mode of ['relay','direct']) assert.equal(shouldUseSelectionLiveRelay({...decision,clientMode:mode}),allowed);
    assert.equal(shouldUseSelectionLiveRelay({...decision,delivery:{...delivery}}),false);
    assert.equal(shouldUseSelectionLiveRelay({...decision,targetUrl:input.targetUrl+'?changed=1'}),false);
    assert.equal(shouldUseSelectionLiveRelay({...decision,itemType:'movie'}),false);
    assert.equal(shouldUseSelectionLiveRelay({...decision,body:{gatewayAutoMode:false}}),false);
    for (const force of [{forceVideoTranscode:true},{engine_pipe:1},{live_force_transcode:'true'},{audioStreamIndex:1},{gatewayMode:'transcode'}]) {
      assert.equal(shouldUseSelectionLiveRelay({...decision,body:{gatewayAutoMode:true,...force}}),false);
      assert.equal(shouldUseSelectionLiveRelay({...decision,playbackHint:force}),false);
    }
    for (const changes of [{sourceId:'personal'},{userId:'other'},{ownedItem:null},{itemId:'spoof'}]) {
      assert.equal(shouldUseSelectionLiveRelay({...decision,delivery:await resolveSelectionLiveDelivery({...input,...changes})}),false);
    }
  }
});
