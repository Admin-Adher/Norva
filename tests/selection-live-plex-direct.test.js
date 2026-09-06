'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const parts = {
  '6430aa45fc3be5947780904e-66be944f8711311880995280': 'norva-discovery:live:0bbf9a23d453660d92469cba6d1c75b8b4e68736537efd826869a5a9e067120b',
  '6430aa45fc3be5947780904e-68a799722895f21006e758e4': 'norva-discovery:live:52064226a3cb515cff83bf663c3bd24bc2086ddb44df00a93949dd9f91c03082',
  '5e20b730f2f8d5003d739db7-6245f06793b402a3d1097787': 'norva-discovery:live:1e0c7c690ed9b7627765ff3f593c0eb52fc423b25fe48042b28dcd883b6eadee',
};
async function setup(part = Object.keys(parts)[0]) {
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const policy = await import('../supabase/functions/_shared/selection-live-delivery.mjs');
  const userId = 'synthetic-plex-trial-owner';
  const key = `https://epg.provider.plex.tv/library/parts/${part}/`;
  const input = { userId, sourceId: await discoverySourceId(userId), itemType: 'live', itemId: parts[part] || `norva-discovery:live:${sha(`live:${key}`)}`,
    ownedItem: { metadata: { tvgId: part, discoveryFeed: 'plex', discoverySource: 'https://github.com/insa-ship-it/app-m3u-generator', discoveryMediaKey: key },
      playback_hint: { sourceType: 'm3u', container: 'm3u8', targetUrl: key + '?X-Plex-Token=old-SYNTHETIC' } },
    targetUrl: key + '?X-Plex-Token=refreshed-SYNTHETIC' };
  return { ...policy, input, resolver: policy.createSelectionLiveDeliveryResolver() };
}
function decision(input, delivery) {
  return { delivery, targetUrl: input.targetUrl, itemType: 'live', clientMode: 'transcode',
    body: { gatewayAutoMode: true, publicHlsDirectSessionGuard: true, playbackHint: { gatewayMode: 'remux' } },
    clientMetadata: { clientSurface: 'web', appMode: 'cloud' } };
}
test('reviewed Plex parts keep the complete refreshed target and stable account scope', async () => {
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
test('a reviewed channel may use another owned regional part without changing region during token refresh', async () => {
  const { input, resolver } = await setup();
  const part = '697140a85d851f5e69414688-66be944f8711311880995280';
  const key = `https://epg.provider.plex.tv/library/parts/${part}/`;
  input.ownedItem.metadata.tvgId = part;
  input.ownedItem.metadata.discoveryMediaKey = key;
  input.itemId = `norva-discovery:live:${sha(`live:${key}`)}`;
  input.ownedItem.playback_hint.targetUrl = key + '?X-Plex-Token=old';
  input.targetUrl = key + '?X-Plex-Token=new';
  assert.ok(await resolver(input));
  input.targetUrl = input.targetUrl.replace('697140a85d851f5e69414688', '6430aa45fc3be5947780904e');
  assert.equal(await resolver(input), null, 'a refreshed reference cannot switch its regional part');
  const other = structuredClone(input);
  const unreviewedPart = '697140a85d851f5e69414688-ffffffffffffffffffffffff';
  const otherKey = `https://epg.provider.plex.tv/library/parts/${unreviewedPart}/`;
  other.ownedItem.metadata.tvgId = unreviewedPart;
  other.ownedItem.metadata.discoveryMediaKey = otherKey;
  other.itemId = `norva-discovery:live:${sha(`live:${otherKey}`)}`;
  other.ownedItem.playback_hint.targetUrl = other.targetUrl = otherKey + '?X-Plex-Token=token';
  assert.ok(await resolver(other), 'the transport applies to every canonical owned Plex programme');
});
test('ownership, Selection identity, persisted part, feed and attribution must all agree', async () => {
  const { input, resolver, resolveSelectionLiveDelivery } = await setup();
  assert.ok(await resolveSelectionLiveDelivery(input), 'reviewed programmes are available to their authenticated Selection owner');
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

test('canonical programmes use the reviewed protocol for independent owners without widening source or session authority', async () => {
  const { input, resolver, shouldUseSelectionLiveDirect } = await setup('697140a85d851f5e69414688-ffffffffffffffffffffffff');
  const delivery = await resolver(input);
  assert.ok(delivery);
  assert.equal(shouldUseSelectionLiveDirect(decision(input, delivery)), true);
  const another = structuredClone(input);
  another.userId = 'independent-owner';
  assert.equal(await resolver(another), null, 'another owner cannot reuse the first source');
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  another.sourceId = await discoverySourceId(another.userId);
  assert.ok(await resolver(another), 'another owner may play the same programme from their own Selection');
  const forged = structuredClone(input);
  forged.ownedItem.metadata.discoveryFeed = 'personal';
  assert.equal(await resolver(forged), null, 'protocol delivery does not waive provenance');
  const request = decision(input, delivery);
  request.body.publicHlsDirectSessionGuard = false;
  assert.equal(shouldUseSelectionLiveDirect(request), false);
});

test('reviewed Plex programmes work for independent owners without accepting another owner source', async () => {
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  for (const part of Object.keys(parts)) {
    const { input, resolver } = await setup(part);
    const first = await resolver(input);
    const second = structuredClone(input);
    second.userId = 'another-authenticated-owner';
    assert.equal(await resolver(second), null, 'the first owner source cannot be reused');
    second.sourceId = await discoverySourceId(second.userId);
    const delivery = await resolver(second);
    assert.ok(delivery);
    assert.equal(delivery.targetUrl, second.targetUrl);
    assert.equal(delivery.providerAccountScopeSuffix, first.providerAccountScopeSuffix,
      'the media suffix stays stable; the playback resolver separately prefixes the authenticated owner and source');
  }
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
test('Plex direct delivery preserves native routes, explicit conversion and track selection; hints cannot forge authority', async () => {
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
