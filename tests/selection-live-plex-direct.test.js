'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const parts = {
  '6430aa45fc3be5947780904e-66be944f8711311880995280': 'norva-discovery:live:0bbf9a23d453660d92469cba6d1c75b8b4e68736537efd826869a5a9e067120b',
  '6430aa45fc3be5947780904e-68a799722895f21006e758e4': 'norva-discovery:live:52064226a3cb515cff83bf663c3bd24bc2086ddb44df00a93949dd9f91c03082',
};
async function setup(part = Object.keys(parts)[0]) {
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const policy = await import('../supabase/functions/_shared/selection-live-delivery.mjs');
  const userId = 'synthetic-plex-trial-owner';
  const key = `https://epg.provider.plex.tv/library/parts/${part}/`;
  const input = { userId, sourceId: await discoverySourceId(userId), itemType: 'live', itemId: parts[part],
    ownedItem: { metadata: { tvgId: part, discoveryFeed: 'plex', discoverySource: 'https://github.com/insa-ship-it/app-m3u-generator', discoveryMediaKey: key },
      playback_hint: { sourceType: 'm3u', container: 'm3u8', targetUrl: key + '?X-Plex-Token=old-SYNTHETIC' } },
    targetUrl: key + '?X-Plex-Token=refreshed-SYNTHETIC' };
  return { ...policy, input, resolver: policy.createSelectionLiveDeliveryResolver({ plexTrialOwnerSha256: sha(userId) }) };
}
function decision(input, delivery) {
  return { delivery, targetUrl: input.targetUrl, itemType: 'live', clientMode: 'transcode',
    body: { gatewayAutoMode: true, publicHlsDirectSessionGuard: true, playbackHint: { gatewayMode: 'remux' } },
    clientMetadata: { clientSurface: 'web', appMode: 'cloud' } };
}
test('both reviewed Plex parts keep the complete refreshed target and stable account scope', async () => {
  for (const part of Object.keys(parts)) {
    const { input, resolver, shouldUseSelectionLiveDirect } = await setup(part);
    const before = JSON.stringify(input);
    const delivery = await resolver(input);
    assert.ok(Object.isFrozen(delivery));
    assert.equal(delivery.targetUrl, input.targetUrl);
    assert.equal(shouldUseSelectionLiveDirect(decision(input, delivery)), true);
    assert.equal((await resolver({ ...input, targetUrl: input.targetUrl.replace('refreshed', 'next') })).providerAccountScopeSuffix, delivery.providerAccountScopeSuffix);
    assert.equal(JSON.stringify(input), before);
  }
});
test('ownership, Selection identity, persisted part, feed and attribution must all agree', async () => {
  const { input, resolver, resolveSelectionLiveDelivery } = await setup();
  assert.equal(await resolveSelectionLiveDelivery(input), null, 'production owner pin is active');
  const changes = [
    x => { x.userId = 'another-owner'; }, x => { x.sourceId = 'personal-source'; },
    x => { x.ownedItem = null; }, x => { x.itemType = 'movie'; }, x => { x.itemType = 'series'; },
    x => { x.itemId = parts[Object.keys(parts)[1]]; },
    x => { x.ownedItem.metadata.discoveryFeed = 'iptv-org'; },
    x => { x.ownedItem.metadata.discoverySource = 'https://attacker.example'; },
    x => { x.ownedItem.metadata.discoveryMediaKey += '?X-Plex-Token=old'; },
    x => { x.ownedItem.metadata.tvgId = '__proto__'; },
    x => { x.ownedItem.metadata.tvgId = Object.keys(parts)[1]; },
    x => { x.ownedItem.playback_hint.sourceType = 'xtream'; },
    x => { x.ownedItem.playback_hint.container = 'mp4'; },
    x => { x.ownedItem.playback_hint.quality = '720p'; },
  ];
  for (const change of changes) { const value = structuredClone(input); change(value); assert.equal(await resolver(value), null); }
});
test('only a single anonymous token may rotate; both stored and refreshed URLs are checked', async () => {
  const { input, resolver } = await setup();
  const transforms = [
    u => u.replace('https:', 'http:'), u => u.replace('plex.tv', 'plex.tv.attacker.example'),
    u => u.replace('plex.tv', 'plex.tv:8443'), u => u.replace('https://', 'https://user:secret@'),
    u => u + '#fragment', u => u + '&url=https://attacker.example', u => u + '&X-Plex-Token=second',
    u => u.replace('X-Plex-Token', 'x-plex-token'), u => u.split('?')[0], u => u.replace(/Token=.*/, 'Token='),
    u => u.replace('Token=', 'Token=%0a'), u => u.replace('/library/parts/', '/library/other/'),
    u => u.replace(Object.keys(parts)[0], Object.keys(parts)[1]), u => ' ' + u,
  ];
  for (const transform of transforms) for (const which of ['persisted', 'refreshed']) {
    const value = structuredClone(input);
    if (which === 'persisted') value.ownedItem.playback_hint.targetUrl = transform(value.ownedItem.playback_hint.targetUrl);
    else value.targetUrl = transform(value.targetUrl);
    assert.equal(await resolver(value), null, which);
  }
});
test('Plex trials preserve native routes, explicit conversion and track selection; hints cannot forge authority', async () => {
  const { input, resolver, shouldUseSelectionLiveDirect } = await setup();
  const delivery = await resolver(input), base = decision(input, delivery);
  for (const patch of [
    { delivery: { ...delivery } }, { delivery: null }, { targetUrl: input.targetUrl + 'changed' },
    { clientMetadata: { clientSurface: 'android-tv', appMode: 'cloud' } },
    { clientMetadata: { clientSurface: 'android-phone', appMode: 'cloud' } },
    { body: { ...base.body, gatewayAutoMode: false } },
    { body: { ...base.body, publicHlsDirectSessionGuard: false } },
    ...[{ gatewayMode: 'transcode' }, { liveForceTranscode: true }, { requiresRelay: true }, { quality: '720p' }, { audioStreamIndex: 0 }]
      .map(hint => ({ body: { ...base.body, playbackHint: hint } })),
  ]) assert.equal(shouldUseSelectionLiveDirect({ ...base, ...patch }), false);
});
