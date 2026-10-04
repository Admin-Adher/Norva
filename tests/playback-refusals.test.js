'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function harness() {
  let now = 1_800_000_000_000;
  const session = { user: { id: 'owner-a' }, expires_at: now / 1000 + 3600 };
  const listeners = {};
  const source = { id: 900001, cloudId: 'source-a', config_revision: 1,
    active_generation_id: 'generation-a', enabled: true };
  const window = {
    app: { currentUser: { id: 'owner-a', cloud: true }, pages: { movies: { sources: [source] } } },
    NorvaAuth: { getSession: () => session },
    NorvaCloud: { catalogVisibility: { epoch: () => 'v2.1.1' } },
    addEventListener: (name, callback) => { listeners[name] = callback; }
  };
  const sandbox = vm.createContext({ window, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(read('public/js/utils/mediaUtils.js'), sandbox);
  vm.runInContext(read('public/js/utils/playbackRefusals.js'), sandbox);
  return { api: window.NorvaPlaybackRefusals, window, session, source, listeners,
    tick: ms => { now += ms; }, app: window.app };
}
const movie = (id = 'one', sourceId = 900001) => ({ sourceId, stream_id: id, name: 'A movie' });
const ids = items => Array.from(items, item => item.stream_id);

test('refusal is exact-file, source and type scoped; Watch and catalog aliases match', () => {
  const { api, app } = harness();
  assert.equal(api.markRefused({ cloudSourceId: 'source-a', type: 'movie', id: 'one' }, app), true);
  assert.equal(api.has(movie(), app), true);
  assert.equal(api.has(movie('two'), app), false);
  assert.equal(api.has(movie('one', 'another-source'), app), false);
  assert.equal(api.has({ ...movie(), type: 'episode' }, app), false);
  assert.equal(api.has({ ...movie('two'), titleId: 'one', tmdbId: 'one' }, app), false);
});

test('ten minute expiry and backward clock movement stop the advisory', () => {
  const { api, tick } = harness();
  api.markRefused(movie());
  tick(599999);
  assert.equal(api.has(movie()), true);
  tick(1);
  assert.equal(api.has(movie()), false);
  api.markRefused(movie());
  tick(-1);
  assert.equal(api.has(movie()), false);
});

test('bounded cache retains at most the latest 64 exact-file hints', () => {
  const { api } = harness();
  for (let i = 0; i < 65; i++) api.markRefused(movie(String(i)));
  assert.equal(api.has(movie('0')), false);
  assert.equal(api.has(movie('1')), true);
  assert.equal(api.has(movie('64')), true);
});

test('success clears only the current exact file, leaving siblings eligible for their own hints', () => {
  const { api } = harness();
  api.markRefused(movie());
  api.markRefused(movie('two'));
  assert.equal(api.clear(movie()), true);
  assert.equal(api.has(movie()), false);
  assert.equal(api.has(movie('two')), true);
});

test('mutable currentUser cannot share hints with another authenticated owner', () => {
  const { api, app, session } = harness();
  const before = api.capture(app);
  api.markRefused(movie(), app, before);
  session.user.id = app.currentUser.id = 'owner-b';
  assert.equal(api.has(movie(), app), false);
  assert.equal(api.markRefused(movie(), app, before), false);
  session.user.id = app.currentUser.id = 'owner-a';
  assert.equal(api.has(movie(), app), false);
});

test('same-owner sign-out, session change and explicit reset invalidate delayed callbacks', () => {
  const { api, app, session } = harness();
  const before = api.capture(app);
  api.markRefused(movie(), app, before);
  app._signOutInFlight = true;
  assert.equal(api.has(movie()), false);
  app._signOutInFlight = false;
  assert.equal(api.markRefused(movie(), app, before), false);
  api.markRefused(movie());
  session.expires_at += 1;
  assert.equal(api.has(movie()), false);
  const next = api.capture();
  api.reset();
  assert.equal(api.markRefused(movie(), app, next), false);
});

test('visibility, source configuration and generation changes invalidate the exact hint', () => {
  const { api, window, source } = harness();
  api.markRefused(movie());
  window.NorvaCloud.catalogVisibility.epoch = () => 'v2.1.2';
  assert.equal(api.has(movie()), false);
  api.markRefused(movie());
  source.config_revision++;
  assert.equal(api.has(movie()), false);
  api.markRefused(movie());
  source.active_generation_id = 'generation-b';
  assert.equal(api.has(movie()), false);
});

test('unknown owner, missing authority, expired auth and paired-device fallback never memoize', () => {
  const cases = [
    h => { h.session.user = null; },
    h => { h.app.currentUser.id = 'different-owner'; },
    h => { h.window.NorvaCloud.catalogVisibility.epoch = () => null; },
    h => { h.session.expires_at = 1; },
    h => { h.app.currentUser.device = true; },
    h => { h.window.NorvaAuth.getSession = () => { throw new Error('unavailable'); }; }
  ];
  for (const change of cases) {
    const h = harness(); change(h);
    assert.equal(h.api.markRefused(movie()), false);
    assert.equal(h.api.has(movie()), false);
  }
});

test('URLs, unsupported types, absent file/source and revoked sources do not enter the memo', () => {
  const { api, source } = harness();
  for (const bad of [{ id: 'one' }, { sourceId: 'source-a', titleId: 'one' },
    movie('https://private.invalid/file'), movie('one', 'https://private.invalid'),
    { ...movie(), type: 'live' }]) assert.equal(api.markRefused(bad), false);
  source.enabled = false;
  assert.equal(api.markRefused(movie()), false);
});

test('storage sign-out clears cached hints without accessing persistent storage', () => {
  const { api, listeners } = harness();
  api.markRefused(movie());
  listeners.storage({ key: 'norva-cloud-session' });
  assert.equal(api.has(movie()), false);
  api.markRefused(movie());
  listeners.storage({ key: null });
  assert.equal(api.has(movie()), false);
});

test('only language-equivalent copies are demoted, with stable order and no mutation', () => {
  const { api, window } = harness();
  const preferences = { preferredAudioLanguage: 'fr', preferredSubtitleLanguage: 'en' };
  const variant = (id, audio, sub) => ({ ...movie(id), audioLanguages: [audio], subtitleLanguages: [sub] });
  const french = variant('fr-refused', 'fr', 'en');
  const frenchAlternative = variant('fr-other', 'fr', 'en');
  const differentSubtitle = variant('fr-other-subtitle', 'fr', 'es');
  const english = variant('en', 'en', 'en');
  const ordered = window.MediaUtils.orderVersionsByPreference(
    [french, frenchAlternative, differentSubtitle, english], preferences);
  const originalIds = ids(ordered);
  api.markRefused(french);
  const result = api.order(ordered, preferences);
  assert.deepEqual(ids(result).slice(0, 2), ['fr-other', 'fr-refused']);
  assert.deepEqual(ids(ordered), originalIds);
  assert.equal(result[1], french);
  // Both French/English-subtitle copies refused: a different language choice
  // cannot become the recommended/default copy merely to avoid the hint.
  api.markRefused(frenchAlternative);
  assert.deepEqual(ids(api.order(ordered, preferences)), originalIds);
});

test('no preference classifier means no speculative reordering, and nothing is filtered', () => {
  const { api, window } = harness();
  const list = [movie(), movie('two')];
  api.markRefused(list[0]);
  window.MediaUtils = null;
  assert.deepEqual(ids(api.order(list)), ['one', 'two']);
  assert.equal(api.order(list).length, list.length);
});

test('a fresh runtime forgets every advisory; no persistent or provider API is required', () => {
  const first = harness();
  first.api.markRefused(movie());
  const second = harness();
  assert.equal(second.api.has(movie()), false);
  const source = read('public/js/utils/playbackRefusals.js');
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|sessionStorage|getAccessToken|access_token|refresh_token|XMLHttpRequest)\b/);
});
