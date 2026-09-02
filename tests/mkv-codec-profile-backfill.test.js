const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} section missing`);
  return source.slice(from, to);
};

test('MKV codec backfill is service-gated, exact-owner scoped and bounded to ten UUIDs', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const route = between(edge, 'async function runCodecProfileBackfill(', '\nasync function runLidBenchmarkEndpoint');

  assert.match(edge, /segments\[0\] === "codec-profile-backfill"/);
  assert.match(edge, /version:\s*78[\s\S]*exactFileCodecProfileProtocol:\s*1/);
  assert.match(route, /NORVA_BACKFILL_TOKEN/);
  assert.match(route, /uniqueVariantIds\.slice\(0, 10\)/);
  assert.match(route, /PLAYBACK_SESSION_UUID_PATTERN\.test/);
  assert.match(route, /uniqueVariantIds\.length > 10/);
  assert.match(route, /\.from\("cloud_catalog_visible_title_variants"\)[\s\S]*\.eq\("user_id", userId\)[\s\S]*\.eq\("item_type", "movie"\)[\s\S]*\.in\("id", variantIds\)/);
  assert.match(route, /variants\.length !== variantIds\.length/);
  assert.match(route, /resolvePlaybackTarget\(sourceId, "movie", externalId, userId, db\)/);
  assert.doesNotMatch(route, /targetUrl\s*[:=]\s*body|body\.url|ignoreLiveSession/);
});

test('MKV codec backfill is sequential and fails closed around viewers, circuits and leases', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const route = between(edge, 'async function runCodecProfileBackfill(', '\nasync function runLidBenchmarkEndpoint');

  assert.match(route, /for \(const variantId of variantIds\)/);
  assert.doesNotMatch(route, /Promise\.all|mapLimit|concurrency/);
  assert.match(route, /episodeBackgroundBlockReason\(db, userId, targetUrl\)/);
  assert.match(route, /claimProviderFileProbeStrict\(db, identityKey, leaseOwner, 180\)/);
  assert.match(route, /episodeBackgroundBlockReason\(db, userId, targetUrl\)[\s\S]*-race/);
  assert.ok((route.match(/assertProviderCircuitClosed\(providerAccountHash, db\)/g) || []).length >= 2);
  assert.ok((route.match(/assertProviderProbeCircuitClosedStrict\(db, identityKey\)/g) || []).length >= 2);
  assert.match(route, /finally \{[\s\S]*releaseProviderFileProbe\(db, identityKey, leaseOwner\)/);
  const gatewayFetch = route.indexOf('fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`');
  const drainGate = route.indexOf('providerProbeResponseAllowsLeaseRelease(', gatewayFetch);
  const terminalGate = route.indexOf('providerProbeTerminalCode(', gatewayFetch);
  assert.ok(gatewayFetch >= 0 && drainGate > gatewayFetch && drainGate < terminalGate,
    'codec-profile terminal/non-2xx responses must pass the lease drain gate first');
  assert.match(route, /catch \(error\) \{[\s\S]*if \(providerTransportMayBeActive\) releaseLeaseOnExit = false;[\s\S]*throw error/);
  assert.equal((route.match(/\/probe-audio/g) || []).length, 1);
  assert.doesNotMatch(route, /\/sessions|\/raw\/|relayBaseUrl|Promise\.race/);
});

test('MKV codec backfill defers unresolved provider identities before target resolution or provider I/O', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const route = between(edge, 'async function runCodecProfileBackfill(', '\nasync function runLidBenchmarkEndpoint');

  const identityResolution = route.indexOf('const sourceIdentity = await resolveSourceIdentity(sourceId, userId, db);');
  const unresolvedGuard = route.indexOf('identityKey.startsWith("source:")');
  const targetResolution = route.indexOf('resolvePlaybackTarget(sourceId, "movie", externalId, userId, db)');
  const leaseClaim = route.indexOf('claimProviderFileProbeStrict(db, identityKey, leaseOwner, 180)');
  const gatewayFetch = route.indexOf('fetch(`${runtimeConfig.mediaGatewayUrl}/probe-audio`');

  assert.ok(identityResolution >= 0, 'provider identity must be resolved explicitly');
  assert.ok(unresolvedGuard > identityResolution, 'source-scoped fallback must be rejected');
  assert.ok(targetResolution > unresolvedGuard, 'identity rejection must precede target resolution');
  assert.ok(leaseClaim > targetResolution, 'identity rejection must precede lease claims');
  assert.ok(gatewayFetch > leaseClaim, 'identity rejection must precede Gateway fetches');

  const failClosedBranch = route.slice(unresolvedGuard, targetResolution);
  assert.match(failClosedBranch, /stopped\s*=\s*"provider-identity-pending"/);
  assert.match(failClosedBranch, /status:\s*"deferred"/);
  assert.match(failClosedBranch, /break;/);
  assert.doesNotMatch(failClosedBranch, /resolvePlaybackTarget|claimProviderFileProbeStrict|fetch\s*\(/);
});

test('MKV codec backfill persists only complete exact-file profiles and terminally separates 458 from 407', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const route = between(edge, 'async function runCodecProfileBackfill(', '\nasync function runLidBenchmarkEndpoint');
  const gateway = read('services/media-gateway/src/index.js');

  assert.match(gateway, /res\.json\(\{[\s\S]*audioLanguages,[\s\S]*audioTracks,[\s\S]*audioDefaultLanguage,[\s\S]*subtitles,[\s\S]*codecProfile: publicMkvCodecProfile\(profile\),?[\s\S]*\}\)/);
  assert.match(route, /hasReliableVodCodecProfile\(observedProfile\)/);
  assert.match(route, /persistObservedCodecProfile\(db, \{[\s\S]*userId,[\s\S]*sourceId,[\s\S]*itemType: "movie",[\s\S]*itemId: externalId/);
  assert.match(route, /variantId,[\s\S]*strict: true/);
  assert.match(route, /hasAudioMap[\s\S]*hasSubtitleMap[\s\S]*shareFileTracks\([\s\S]*identityKey,[\s\S]*"movie",[\s\S]*externalId,[\s\S]*hasAudioMap,[\s\S]*hasSubtitleMap/);
  assert.match(route, /providerProbeTerminalCode\([\s\S]*terminalCode === "proxy_auth_failed"[\s\S]*break/);
  assert.match(route, /terminalCode === "provider_busy"[\s\S]*openProviderPlaybackCircuit/);
  assert.doesNotMatch(route, /hasUsefulCodecProfile\(existingProfile\)[\s\S]*already_cached/);
  assert.doesNotMatch(route, /already_complete|alreadyComplete/);
});

test('low-footprint movie audio probes persist only reliable Gateway codec profiles for the exact variant', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const crawler = between(edge, 'async function runOneDimension(', '\nasync function runCatalogMirrorVerify');

  assert.match(crawler, /const observedProfile = recordOrEmpty\(gatewayInfo\.codecProfile \?\? gatewayInfo\.codec_profile\)/);
  assert.match(crawler, /hasReliableVodCodecProfile\(observedProfile\)/);
  assert.match(crawler, /persistObservedCodecProfile\(db, \{[\s\S]*variantId:[\s\S]*strict: true/);
  assert.doesNotMatch(crawler, /firstUsefulCodecProfile\(info\?\.codecProfile[\s\S]*persistObservedCodecProfile/);
});

test('audio crawler stops each provider account after the first 458 and keeps proxy auth separate', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const crawler = between(edge, 'async function runOneDimension(', '\nasync function runCatalogMirrorVerify');

  assert.match(crawler, /providerProbeTickGuard\s*=\s*createProviderProbeTickGuard\(\)/);
  assert.match(crawler, /providerProbeTickGuard\.terminalCode\(providerAccountKey\)[\s\S]*return/);
  assert.match(crawler, /providerProbeTickGuard\.tryEnter\(providerAccountKey\)[\s\S]*return/);
  assert.ok(
    (crawler.match(/recordTerminalProbeFailure\(/g) || []).length >= 2,
    'Gateway and Relay must both use the same terminal handler',
  );
  assert.match(crawler, /terminalCode === "provider_busy"[\s\S]*openProviderPlaybackCircuit/);
  assert.match(crawler, /terminalCode === "proxy_auth_failed"[\s\S]*diag\.proxyAuthFailed/);
  assert.match(crawler, /providerProbeTickGuard\.terminalCodes\(\)[\s\S]*terminalCodes\.length > 0[\s\S]*hasMore: true/);
});
