const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const context = { window: {}, console, Intl, URL, setTimeout, clearTimeout,
    document: { documentElement: { lang: 'fr' } } };
  for (const file of ['utils/mediaUtils', 'pages/WatchPage', 'pages/MoviesPage']) {
    vm.runInNewContext(fs.readFileSync(`public/js/${file}.js`, 'utf8'), context);
    context.MediaUtils = context.window.MediaUtils;
  }
  const page = Object.create(context.window.WatchPage.prototype);
  page.audioTracks = [];
  page.audioLanguageValidationStatus = 'pending';
  page.content = { type: 'movie', id: 'file', title: 'A film',
    providerAudioLanguages: ['te'], providerAudioLanguageStatus: 'provider_declared' };
  return { page, context };
}

test('a declared single language labels the actual menu without inventing a track or preference', () => {
  const { page } = fixture();
  const row = page.getVisibleAudioTracks()[0];
  assert.equal(row.label.toLowerCase(), 'télougou');
  assert.equal(row.source, 'none');
  assert.equal(row.index, -1);
  assert.equal(row.language, undefined);
  assert.equal(page.getCurrentAudioPreference(), null);
  assert.equal(page.audioLanguageValidationStatus, 'pending');
  assert.equal(page.content.audioLanguages, undefined);
  assert.equal(page.content.audioTracks, undefined);
});

test('Selection season and part files use their own language by id on resume and episode change', () => {
  const { page } = fixture();
  const a = { id: 'file-a', title: 'Show Season 1 Part 1', episode_num: null,
    providerAudioLanguages: ['hi'], providerAudioLanguageStatus: 'provider_declared' };
  const b = { ...a, id: 'file-b', title: 'Show Season 1 Part 2', providerAudioLanguages: ['ta'] };
  page.content = { ...page.content, type: 'series', id: 'file-a' };
  page.seriesInfo = { episodes: { 1: [a, b] } };
  page.currentSeason = '1'; page.currentEpisode = null;
  assert.equal(page.getVisibleAudioTracks()[0].label.toLowerCase(), 'hindi');
  assert.equal(page.currentEpisodeRawTitle(), a.title);
  page.content = page.sanitizeResumeContent(page.content);
  assert.equal(page.getVisibleAudioTracks()[0].label.toLowerCase(), 'hindi');
  page.content.id = 'file-b';
  assert.equal(page.getVisibleAudioTracks()[0].label.toLowerCase(), 'tamoul');
  assert.equal(page.currentEpisodeRawTitle(), b.title);
  delete b.providerAudioLanguages;
  assert.equal(page.getVisibleAudioTracks()[0].label, 'Audio track');
});

test('embedded language wins; ambiguous declarations and multiple unlabelled tracks stay unmapped', () => {
  const { page } = fixture();
  page.audioLanguageValidationStatus = 'probed';
  page.audioTracks = [{ index: 2, language: 'en', codec: 'aac' }];
  assert.match(page.getVisibleAudioTracks()[0].label, /anglais/i);
  assert.doesNotMatch(page.getVisibleAudioTracks()[0].label, /télougou/i);
  page.audioLanguageValidationStatus = 'pending';
  page.audioTracks = [{ index: 2 }, { index: 3 }];
  assert.ok(page.getVisibleAudioTracks().every(row => !/télougou/i.test(row.label)));
  page.audioTracks = [];
  page.content.providerAudioLanguages = ['te', 'hi'];
  assert.equal(page.getVisibleAudioTracks()[0].label, 'Audio track');
  page.content.providerAudioLanguages = ['xx'];
  assert.equal(page.getVisibleAudioTracks()[0].label, 'Audio track');
});

test('movie launch and resume keep each version declaration separate from verified audio', async () => {
  const { page, context } = fixture();
  const movies = Object.create(context.window.MoviesPage.prototype);
  let content;
  movies.app = { pages: { watch: { play: async value => { content = value; } } } };
  movies.getSourceName = () => 'Selection';
  movies.getMovieDisplayTitle = item => item.name;
  movies.getItemYear = () => 2024;
  const a = { stream_id: 'a', sourceId: 9, name: 'Film', providerAudioLanguages: ['te'], providerAudioLanguageStatus: 'provider_declared' };
  const b = { ...a, stream_id: 'b', providerAudioLanguages: ['hi'] };
  await movies.playMovie(a, { versions: [a, b] });
  assert.deepEqual(content.providerAudioLanguages, ['te']);
  assert.deepEqual(content.versions[1].providerAudioLanguages, ['hi']);
  assert.equal(content.audioLanguages, null);
  const saved = page.sanitizeResumeContent(content);
  assert.deepEqual(Array.from(saved.providerAudioLanguages), ['te']);
  assert.deepEqual(Array.from(saved.versions[1].providerAudioLanguages), ['hi']);
  page.content = saved;
  assert.equal(page.getVisibleAudioTracks()[0].label.toLowerCase(), 'télougou');
});

test('history preserves only allowlisted display declarations, never audio evidence or arbitrary metadata', async () => {
  const { sanitizeHistoryData } = await import('../supabase/functions/_shared/cloud-public-view.mjs');
  const result = sanitizeHistoryData({ title: 'Film', providerAudioLanguages: ['hi', 'hi', 'bad-value'],
    providerAudioLanguageStatus: 'provider_declared', audioLanguages: ['hi'], audioTracks: [{ index: 2, lang: 'hi' }],
    secret: 'must-not-survive' });
  assert.deepEqual(result.providerAudioLanguages, ['hi']);
  assert.equal(result.providerAudioLanguageStatus, 'provider_declared');
  assert.equal(result.audioLanguages, undefined);
  assert.equal(result.audioTracks, undefined);
  assert.equal(result.secret, undefined);
  assert.equal(sanitizeHistoryData({ providerAudioLanguages: ['hi'] }).providerAudioLanguages, undefined);
});
