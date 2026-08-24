// Sequential mono-compte MKV / IPTV handoff — source-extract contract.
//
// Locks the client-side session release that must run before the next title
// or account mutation claims the provider slot. Complements the already-landed
// gateway slot-release delay and edge 458 handoff grace. No live IPTV account.
//
// Run: node --test tests/mkv-sequential-handoff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const watchSrc = read('public/js/pages/WatchPage.js');
const sourceManagerSrc = read('public/js/components/SourceManager.js');
const gatewaySrc = read('services/media-gateway/src/index.js');
const edgeSrc = read('supabase/functions/norva-playback/index.ts');
const policySrc = read('supabase/functions/_shared/provider-playback-circuit-policy.mjs');

test('gateway /raw waits PROVIDER_SLOT_RELEASE_DELAY_MS after aborting holders and has one 458 handoff retry', () => {
  const route = section(gatewaySrc, "app.get('/raw/:token'", '// Tee the leading bytes');
  assert.match(route, /abortedForHandoff/);
  assert.match(route, /if \(abortedForHandoff > 0 && PROVIDER_SLOT_RELEASE_DELAY_MS > 0\)/);
  assert.match(route, /waitForRawBackoff\(PROVIDER_SLOT_RELEASE_DELAY_MS/);
  assert.match(route, /let rawHandoffRetryUsed = false/);
  assert.equal(
    (route.match(/rawHandoffRetryUsed = true/g) || []).length,
    1,
    'a 458 after abort has exactly one handoff retry',
  );
  assert.ok(
    /upstream\.status === 458[\s\S]{0,180}rawHandoffRetryUsed = true/.test(route)
      || /!rawHandoffRetryUsed[\s\S]{0,180}abortedForHandoff > 0[\s\S]{0,180}458/.test(route),
    '458 handoff retry must be gated on aborted holders',
  );
});

test('shouldOpenCircuitForProviderBusy exists with 8000ms grace', () => {
  assert.match(policySrc, /export const PROVIDER_HANDOFF_CIRCUIT_GRACE_MS = 8_000;/);
  assert.match(policySrc, /export function shouldOpenCircuitForProviderBusy\(/);
  assert.match(policySrc, /graceMs = PROVIDER_HANDOFF_CIRCUIT_GRACE_MS/);
  assert.match(policySrc, /return \(safeNow - releasedAt\) >= safeGrace;/);
});

test('edge reportProviderPlaybackFailure and createGatewaySession consult the helper before openProviderPlaybackCircuit', () => {
  const report = section(edgeSrc, 'async function reportProviderPlaybackFailure(', 'async function createPlaybackSession(');
  const gateway = section(edgeSrc, 'async function createGatewaySession(', 'async function requestGatewaySession(');

  const reportHelper = report.indexOf('shouldOpenCircuitForProviderBusy');
  const reportOpen = report.indexOf('openProviderPlaybackCircuit');
  assert.ok(reportHelper >= 0, 'reportProviderPlaybackFailure must consult shouldOpenCircuitForProviderBusy');
  assert.ok(reportOpen > reportHelper, 'reportProviderPlaybackFailure must consult the helper before opening the circuit');

  const createHelper = gateway.indexOf('shouldOpenCircuitForProviderBusy');
  const createOpen = gateway.indexOf('openProviderPlaybackCircuit');
  assert.ok(createHelper >= 0, 'createGatewaySession must consult shouldOpenCircuitForProviderBusy');
  assert.ok(createOpen > createHelper, 'createGatewaySession must consult the helper before opening the circuit');
});

test('WatchPage play() awaits stop then waitForProviderSlotRelease(2500) when replacingActiveWatch', () => {
  const play = section(watchSrc, 'async play(content, streamUrl, playback = {}) {', '\n    async ');
  const attempt = play.indexOf('const playbackAttemptId = this.beginPlaybackAttempt()');
  const replacing = play.indexOf('const replacingActiveWatch');
  const stopCall = play.indexOf('await this.stop()');
  const slotWait = play.indexOf('await this.waitForProviderSlotRelease(2500)');
  const assignContent = play.indexOf('this.content = content');
  const resolver = play.indexOf('resolved = await streamUrlResolver()');
  const staleAfterWait = play.indexOf('if (this.isStalePlaybackAttempt(playbackAttemptId)) return;', slotWait);

  assert.ok(attempt >= 0 && attempt < replacing,
    'the playback intention must be reserved before teardown can yield');
  assert.ok(replacing >= 0, 'replacingActiveWatch missing');
  assert.ok(play.includes('Boolean(streamUrlResolver)'),
    'relaunching the same identity with a new resolver must still replace its old session');
  assert.ok(play.includes("String(this.content.sourceId ?? '') !== String(content?.sourceId ?? '')"),
    'sourceId change must count as a replacement (IPTV account switch)');
  assert.ok(play.includes("String(this.content.id ?? '') !== String(content?.id ?? '')"),
    'title id change must count as a replacement');
  assert.ok(stopCall > replacing, 'replacement must await stop()');
  assert.ok(slotWait > stopCall, 'replacement must wait for the provider slot after stop()');
  assert.ok(assignContent > slotWait, 'incoming identity is assigned only after the previous slot is released');
  assert.ok(staleAfterWait > slotWait && staleAfterWait < assignContent,
    'a newer click or Back must cancel the old handoff after its cooldown');
  assert.ok(resolver > slotWait, 'the next session resolver must run after the slot-release wait');

  const firstPlayWait = play.indexOf('waitForProviderSlotRelease(2500)');
  const secondPlayWait = play.indexOf('waitForProviderSlotRelease(2500)', firstPlayWait + 1);
  assert.equal(secondPlayWait, -1, 'the 2500ms wait is only on replacement, not on every play() path');
});

test('WatchPage stop() is reentrant via _stopPromise', () => {
  const stopFn = section(watchSrc, 'stop({ enqueueStoryboard = true } = {}) {', '\n    // === Playback Controls ===');
  assert.match(stopFn, /if \(this\._stopPromise\) return this\._stopPromise;/);
  assert.match(stopFn, /this\._stopPromise = p;/);
  assert.match(stopFn, /if \(this\._stopPromise === p\) this\._stopPromise = null;/);
  assert.match(stopFn, /return this\._stopPromise;/);
  assert.match(stopFn, /enqueueStoryboard && this\._firstFrameReported/);
  assert.match(stopFn, /this\.stopCloudPlaybackSessions\(\)/);
  assert.ok(
    stopFn.indexOf('if (this._stopPromise) return this._stopPromise;')
      < stopFn.indexOf('this.stopCloudPlaybackSessions()'),
    'a second stop() must return the in-flight promise before starting another expire',
  );
});

test('SourceManager update/delete/toggle release playback before the API mutation', () => {
  const helper = section(sourceManagerSrc, 'async releasePlaybackForSourceChange() {', 'async updateSource(id, type) {');
  assert.match(helper, /window\.app\?\.pages\?\.watch/);
  assert.match(helper, /await watch\.stop\(\)/);
  assert.match(helper, /window\.app\?\.pages\?\.live/);
  assert.match(helper, /await live\.stop\(\)/);

  const update = section(sourceManagerSrc, 'async updateSource(id, type) {', 'notifySourceHealthChanged() {');
  const deleteSrc = section(sourceManagerSrc, 'async deleteSource(id) {', 'async toggleSource(id) {');
  const toggle = section(sourceManagerSrc, 'async toggleSource(id) {', 'async testSource(id) {');

  assert.ok(update.indexOf('await this.releasePlaybackForSourceChange()') < update.indexOf('await API.sources.update'),
    'updateSource must release playback before API.sources.update');
  assert.match(update, /const data = \{ displayName: name \}/);
  assert.match(update, /type !== 'xtream' && form\.credentialsProvided[\s\S]*data\.url = url/);
  assert.match(update, /type === 'xtream' && form\.credentialsProvided[\s\S]*API\.providerAccess\.createCandidate/);
  assert.doesNotMatch(update, /data\.username\s*=|data\.password\s*=/,
    'Xtream credentials must never return to the legacy source PATCH');
  assert.ok(deleteSrc.includes('if (!ok) return;'));
  assert.ok(
    deleteSrc.indexOf('if (!ok) return;') < deleteSrc.indexOf('await this.releasePlaybackForSourceChange()')
      && deleteSrc.indexOf('await this.releasePlaybackForSourceChange()') < deleteSrc.indexOf('await API.sources.delete'),
    'deleteSource must release playback after confirm and before API.sources.delete',
  );
  assert.ok(toggle.indexOf('await this.releasePlaybackForSourceChange()') < toggle.indexOf('await API.sources.toggle'),
    'toggleSource must release playback before API.sources.toggle');
});

test('sequential 10-title contract: replacement always expires the previous session before creating the next', () => {
  // Sequential 10-title mono-compte MKV contract (source-extract, not a live network test):
  // title 1..10 clicked while Watch is active always takes replacingActiveWatch, awaits
  // stop() then expireSession / stopCloudPlaybackSessions, waits for the provider slot, then
  // lets streamUrlResolver / claim_cloud_playback_session mint the next session. Never
  // overlap two provider slots on the same mono-compte account.
  const play = section(watchSrc, 'async play(content, streamUrl, playback = {}) {', '\n    async ');
  const stopFn = section(watchSrc, 'stop({ enqueueStoryboard = true } = {}) {', '\n    // === Playback Controls ===');
  const expire = section(watchSrc, 'async stopCloudPlaybackSessions(options = {}) {', 'async releasePlaybackPipelineForRetry() {');
  const create = section(edgeSrc, 'async function createPlaybackSession(', 'async function getPlaybackSession(');
  const loadVideo = section(watchSrc, 'async loadVideo(url, options = {}) {', '\n    setVolumeFromStorage() {');

  assert.match(play, /const replacingActiveWatch/);
  assert.ok(play.indexOf('await this.stop()') < play.indexOf('await this.waitForProviderSlotRelease(2500)'));
  assert.ok(play.indexOf('await this.waitForProviderSlotRelease(2500)') < play.indexOf('resolved = await streamUrlResolver()'));
  assert.match(stopFn, /this\.stopCloudPlaybackSessions\(\)/);
  assert.match(expire, /expireSession\(sessionId, options\)/);
  assert.match(create, /claim_cloud_playback_session/);
  assert.doesNotMatch(loadVideo, /waitForProviderSlotRelease\(2500\)/);
  assert.doesNotMatch(
    section(watchSrc, 'goBack() {', 'show() {'),
    /await this\.stop\(/,
  );
  assert.doesNotMatch(
    section(watchSrc, 'hide() {', 'startHistoryTracking() {'),
    /await this\.stop\(/,
  );
});
