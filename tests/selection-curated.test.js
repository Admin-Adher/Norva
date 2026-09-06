const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('current import is the reviewed allowlist only, regardless of requested aggregate feeds', async () => {
  const { DISCOVERY_PLAYLIST_URL, discoveryPlaylist, discoverySourceId, retiredDiscoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { SELECTION_CURATED_CHANNELS } = await import('../supabase/functions/_shared/selection-curated-channels.mjs');
  const { fetchDiscoverySelection, discoveryCatalogFields } = await import('../supabase/functions/_shared/discovery-sources.mjs');
  let fetches = 0;
  const result = await fetchDiscoverySelection({ feeds: [{ id:'unreviewed',kind:'movie',url:'https://example.test/all.m3u' }], fetchPlaylist: async () => { fetches++; } });
  const rows = result.items.map(item => discoveryCatalogFields(DISCOVERY_PLAYLIST_URL,item));
  assert.equal(fetches,0);
  assert.equal(rows.length,14);
  assert.equal(new Set(rows.map(row => row.external_id)).size,14);
  assert.ok(rows.every(row => row.item_type === 'live'));
  assert.deepEqual(rows.map(row => row.playback_hint.targetUrl),SELECTION_CURATED_CHANNELS.map(c => c.url));
  assert.equal(discoveryPlaylist().split('#EXTINF:').length-1,14);
  assert.notEqual(await discoverySourceId('owner'),await retiredDiscoverySourceId('owner'));
  assert.equal(fs.readFileSync('public/catalog/discovery.m3u','utf8').replace(/\r\n/g,'\n'),discoveryPlaylist());
  const registry = JSON.parse(fs.readFileSync('public/catalog/sources.json','utf8'));
  assert.equal(registry.sources.reduce((sum,s)=>sum+s.channels,0),14);
  assert.ok(registry.sources.every(s => s.kind === 'live' && !s.url));
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
  const rows=(await fetchDiscoverySelection()).items.map(item=>discoveryCatalogFields(DISCOVERY_PLAYLIST_URL,item));
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
  for (const item of (await fetchDiscoverySelection()).items) {
    const row=discoveryCatalogFields(DISCOVERY_PLAYLIST_URL,item);
    const input={userId,sourceId:await discoverySourceId(userId),itemType:'live',itemId:row.external_id,ownedItem:row,targetUrl:row.playback_hint.targetUrl};
    const delivery=await resolveSelectionLiveDelivery(input);
    assert.equal(delivery?.transport,'public-hls-direct');
    const decision={delivery,targetUrl:input.targetUrl,itemType:'live',clientMode:'transcode',body:{gatewayAutoMode:true,publicHlsDirectSessionGuard:true},clientMetadata:{clientSurface:'web',appMode:'cloud'}};
    assert.equal(shouldUseSelectionLiveDirect(decision),true);
    assert.equal(shouldUseSelectionLiveDirect({...decision,delivery:{...delivery}}),false);
    assert.equal(shouldUseSelectionLiveDirect({...decision,body:{...decision.body,forceVideoTranscode:true}}),false);
    for (const changes of [{sourceId:'personal'},{userId:'other'},{itemId:'spoof'},{ownedItem:null},{targetUrl:input.targetUrl+'?x=1'}]) assert.equal(await resolveSelectionLiveDelivery({...input,...changes}),null);
  }
});
